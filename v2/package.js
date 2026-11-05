/**
 * 2.0 书档导入/导出（FR-22 / P1）。
 *
 * 一个书档 = 一本或 N 本可再生的全部状态（书、章、原文、Part、系列、讲、音频、配图、练习），
 * 打成一个自包含 ZIP。导入后「书在、讲在、点开还能听」，不需要重新生成。
 *
 * 三条硬边界：
 *   1. 零生成：导入全程不调 LLM/TTS/ComfyUI、不重新解析 PDF；
 *   2. 只收白名单：voice.json（含 Key）、audio-cache/、trash/、batches/、
 *      preference.json、progress.json、*.tmp、explain-cache 一律不入包；
 *   3. 原子性：解压到数据根下的 .import/<jobId>/，整本校验通过后才 rename 进 books/；
 *      取消或失败清理 staging，不留半截数据。
 *
 * 2.0 包格式与 1.x 不兼容：formatVersion=2，导入明确拒绝 1.x 包。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { ZipWriter, extractEntries, inspectZip, readEntryBuffer } from '../pkgzip.js';
import { BOOKS_DIR, ROOT, packageVersion, readJson, writeJson } from './root.js';
import { findSeries, listSeries } from './series.js';
import { isSeriesJobActive } from './generate.js';
import { loadLecture } from './lectures.js';
import { loadBook, isValidId, sha256 } from './books.js';
import { isRevoiceJobActive } from './voice.js';
import { isImageJobActive } from './images.js';
import { isPracticeJobActive } from './practice.js';
import { recordError } from './errors.js';

export const PACKAGE_FORMAT = 'dsh-book-slides/package';
export const FORMAT_VERSION = 2;
export const CONTENT_KEY_VERSION = 2;
export const MAX_PACKAGE_BYTES = 4 * 1024 ** 3;
export const MAX_BATCH_BOOKS = 10;
export const POLICIES = ['merge', 'skip', 'copy'];
export const DEFAULT_POLICY = 'merge';
export const IMPORT_ROOT_NAME = '.import';
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;

const BOOK_TOP_FILES = ['book.json', 'source.pdf', 'pages.json', 'chapters.json', 'cover.svg', 'parts.json', 'briefs.json'];
const PRACTICE_FILES = ['questions.json', 'mastery.json'];
const LECTURE_ACTIVE = ['queued', 'structuring', 'validate', 'anchor', 'cancelling'];
const READY = ['ready', 'ready_degraded'];

export const README_TEXT = [
  'dsh-book-slides 2.0 书档',
  '',
  'manifest.json 是唯一索引，里面的 sha256 是导入校验依据。',
  '本包不含 voice.json（语音 Key）、audio-cache/、trash/、batches/、preference.json、progress.json、*.tmp。',
  '导入后不需要重新生成；缺音频的页会按「本页无配音」降级。',
].join('\n');

export class PackageError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'PackageError';
    this.code = code;
    this.hint = hint || '';
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** 流式 sha256，避免 200 MB 的 PDF 整份进内存。 */
export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function iso() {
  return new Date().toISOString();
}

export function normalizePolicy(raw) {
  const value = String(raw || '').trim();
  return POLICIES.includes(value) ? value : DEFAULT_POLICY;
}

/* ------------------------------ 身份（contentKey） ------------------------------ */

function canonicalSlide(slide) {
  const value = slide && typeof slide === 'object' ? slide : {};
  return {
    slide_index: Number(value.slide_index) || 0,
    layout: String(value.layout || ''),
    title: String(value.title || ''),
    subtitle: value.subtitle == null ? null : String(value.subtitle),
    bullet_points: Array.isArray(value.bullet_points) ? value.bullet_points.map(String) : [],
    quote_text: value.quote_text == null ? null : String(value.quote_text),
    quote_source: value.quote_source == null ? null : String(value.quote_source),
    image_prompt: value.image_prompt == null ? null : String(value.image_prompt),
    audio_script: value.audio_script == null ? null : String(value.audio_script),
    source_quote: value.source_quote == null ? null : String(value.source_quote),
    source_pages:
      value.source_pages && typeof value.source_pages === 'object'
        ? { from: Number(value.source_pages.from) || 0, to: Number(value.source_pages.to) || 0 }
        : null,
  };
}

function hashJson(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

/** 系列身份：讲纲 + 每讲 slides 去标识字段（不含 audio_* / voice / book_id / 时间）。 */
export function seriesContentKey(series, lectureDocs) {
  const body = {
    v: CONTENT_KEY_VERSION,
    chapters: (series.chapters || []).map(Number),
    throughline: String(series.throughline || ''),
    lectures: (series.lectures || []).map((lecture) => ({
      n: Number(lecture.n),
      chapters: (lecture.chapters || []).map(Number),
      title: String(lecture.title || ''),
      goal: String(lecture.goal || ''),
      in: String(lecture.in || ''),
      out: String(lecture.out || ''),
      slides: (lectureDocs.get(Number(lecture.n)) || []).map(canonicalSlide),
    })),
    seams: (series.seams || []).map((seam) => ({
      from: Number(seam.from),
      to: Number(seam.to),
      concept: String(seam.concept || ''),
      sentence: String(seam.sentence || ''),
    })),
    terms: (series.terms || []).map((term) => ({
      name: String(term.name || ''),
      forbid: (term.forbid || []).map(String),
    })),
  };
  return hashJson(body);
}

export function lectureContentKey(series, n, slidesDoc) {
  const lecture = (series.lectures || []).find((item) => Number(item.n) === Number(n)) || { n };
  return hashJson({
    v: CONTENT_KEY_VERSION,
    n: Number(n),
    chapters: (lecture.chapters || []).map(Number),
    slides: (slidesDoc && Array.isArray(slidesDoc.slides) ? slidesDoc.slides : []).map(canonicalSlide),
  });
}

/* ------------------------------ 导出 ------------------------------ */

function bookHasActiveJob(bookId) {
  for (const series of listSeries(bookId)) {
    if (isSeriesJobActive(series.id) || isRevoiceJobActive(series.id) || isImageJobActive(series.id)) return true;
    if (isPracticeJobActive(series.id)) return true;
  }
  return false;
}

async function addFile(files, abs, name) {
  if (!isFile(abs)) return null;
  const size = sizeOf(abs);
  const hash = await sha256File(abs);
  const entry = { abs, name, size, sha256: hash };
  files.push(entry);
  return { path: name, sha256: hash, bytes: size };
}

/**
 * 扫描要导出的书与系列，产出「文件清单 + manifest 素材」。只读，不改盘。
 * @param {string[]|'all'} bookIds
 * @param {{includeAudio?:boolean, includeImages?:boolean, includePractice?:boolean}} options
 */
export async function planExport(bookIds, options = {}) {
  const includeAudio = options.includeAudio !== false;
  const includeImages = options.includeImages !== false;
  const includePractice = options.includePractice !== false;
  let ids = [];
  if (bookIds === 'all' || bookIds == null) {
    let entries = [];
    try {
      entries = fs.readdirSync(BOOKS_DIR(), { withFileTypes: true });
    } catch {
      throw new PackageError('E_EXPORT_EMPTY', '书架还是空的', '先导入一本书。');
    }
    ids = entries.filter((entry) => entry.isDirectory() && isValidId(entry.name)).map((entry) => entry.name);
  } else {
    for (const raw of Array.isArray(bookIds) ? bookIds : [bookIds]) {
      const id = String(raw || '').trim();
      if (!id) continue;
      if (!isValidId(id)) throw new PackageError('E_BAD_ID', '书号不合法', id.slice(0, 40));
      if (!ids.includes(id)) ids.push(id);
    }
  }
  if (!ids.length) throw new PackageError('E_EXPORT_EMPTY', '先选至少一本书', '');
  if (ids.length > MAX_BATCH_BOOKS) {
    throw new PackageError('E_EXPORT_TOO_LARGE', '一次最多导出 ' + MAX_BATCH_BOOKS + ' 本', '共 ' + ids.length + ' 本');
  }

  const books = [];
  const files = [];
  const warnings = [];
  let bytes = 0;
  let seriesCount = 0;
  let lectureCount = 0;

  for (const bookId of ids) {
    const loaded = loadBook(bookId);
    if (!loaded) throw new PackageError('E_NOT_FOUND', '找不到这本书', bookId);
    if (bookHasActiveJob(bookId)) {
      throw new PackageError('E_EXPORT_BUSY', '《' + loaded.book.title + '》正在生成/配音/配图，完成后再导出', '');
    }
    for (const name of ['book.json', 'source.pdf', 'pages.json', 'chapters.json']) {
      if (!isFile(path.join(loaded.dir, name))) {
        throw new PackageError('E_EXPORT_FAILED', '《' + loaded.book.title + '》缺少 ' + name, '缺原文或章节数据的书导不完整，重新导入后再试。');
      }
    }
    if (!String(loaded.book.sha256 || '')) {
      throw new PackageError('E_EXPORT_FAILED', '《' + loaded.book.title + '》的 book.json 缺内容哈希', bookId);
    }

    const dirName = 'books/' + bookId;
    const bookFiles = [];
    const manifestFiles = [];
    for (const name of BOOK_TOP_FILES) {
      if (name === 'cover.svg' && !loaded.cover) continue;
      const meta = await addFile(files, path.join(loaded.dir, name), dirName + '/' + name);
      if (meta) manifestFiles.push(meta);
    }

    const manifestPractice = { questions: null, mastery: null, sessions: [] };
    if (includePractice && fs.existsSync(path.join(loaded.dir, 'practice'))) {
      for (const name of PRACTICE_FILES) {
        const meta = await addFile(files, path.join(loaded.dir, 'practice', name), dirName + '/practice/' + name);
        if (meta) manifestPractice[name.replace('.json', '')] = meta;
      }
      const sessionsPath = path.join(loaded.dir, 'practice', 'sessions');
      let names = [];
      try {
        names = fs.readdirSync(sessionsPath).filter((name) => /^[a-z0-9]{8,16}\.json$/.test(name));
      } catch {
        names = [];
      }
      for (const name of names) {
        const meta = await addFile(files, path.join(sessionsPath, name), dirName + '/practice/sessions/' + name);
        if (meta) manifestPractice.sessions.push(meta);
      }
    }

    const manifestSeries = [];
    for (const series of listSeries(bookId)) {
      const found = findSeries(series.id);
      if (!found) continue;
      const seriesDirName = dirName + '/series/' + series.id;
      const lectureDocs = new Map();
      const lectureEntries = [];
      for (const lecture of series.lectures || []) {
        const n = Number(lecture.n);
        const doc = loadLecture(found.dir, n);
        const slides = doc.slidesDoc && Array.isArray(doc.slidesDoc.slides) ? doc.slidesDoc.slides : [];
        lectureDocs.set(n, slides);
        const lectureDirName = seriesDirName + '/lectures/' + n;
        const lectureFiles = {};
        if (doc.exists) {
          const meta = await addFile(files, path.join(doc.dir, 'lecture.json'), lectureDirName + '/lecture.json');
          if (meta) lectureFiles.lecture = meta;
        }
        if (doc.slidesDoc) {
          const meta = await addFile(files, path.join(doc.dir, 'slides.json'), lectureDirName + '/slides.json');
          if (meta) lectureFiles.slides = meta;
        }
        let audioCount = 0;
        let imageCount = 0;
        if (includeAudio && slides.length) {
          const seen = new Set();
          for (const slide of slides) {
            const rel = String((slide && slide.audio_file) || '');
            if (!rel || seen.has(rel)) continue;
            seen.add(rel);
            if (!/^audio\/\d{3}\.(wav|mp3)$/.test(rel)) continue;
            const meta = await addFile(files, path.join(doc.dir, ...rel.split('/')), lectureDirName + '/' + rel);
            if (meta) {
              audioCount += 1;
              lectureFiles[rel] = meta;
            } else warnings.push('第 ' + n + ' 讲缺音频 ' + rel + '，导入后该页显示「本页无配音」');
          }
        }
        if (includeImages && slides.length) {
          const seen = new Set();
          for (const slide of slides) {
            const rel = String((slide && slide.image_file) || '');
            if (!rel || seen.has(rel)) continue;
            seen.add(rel);
            if (!/^images\/\d{3}\.png$/.test(rel)) continue;
            const meta = await addFile(files, path.join(doc.dir, ...rel.split('/')), lectureDirName + '/' + rel);
            if (meta) {
              imageCount += 1;
              lectureFiles[rel] = meta;
            } else if (String(slide.image_status || '') === 'ready') warnings.push('第 ' + n + ' 讲缺配图 ' + rel + '，导入后该页回退提示词占位');
          }
        }
        lectureEntries.push({
          n,
          dir: lectureDirName,
          status: String(lecture.status || ''),
          slides: slides.length,
          pages: Number(lecture.pages) || slides.length,
          lectureKey: lectureContentKey(series, n, doc.slidesDoc),
          files: lectureFiles,
          audio: { count: audioCount },
          images: { count: imageCount },
        });
        lectureCount += 1;
      }
      const seriesFiles = {};
      const seriesMeta = await addFile(files, path.join(found.dir, 'series.json'), seriesDirName + '/series.json');
      if (!seriesMeta) {
        warnings.push('第 ' + series.title + ' 系列的 series.json 缺失，已跳过');
        continue;
      }
      seriesFiles.series = seriesMeta;
      const entry = {
        seriesId: series.id,
        dir: seriesDirName,
        title: String(series.title || ''),
        status: String(series.status || ''),
        stitch: String(series.stitch || 'unstitched'),
        chapters: (series.chapters || []).map(Number),
        contentKey: seriesContentKey(series, lectureDocs),
        lectures: lectureEntries,
        files: seriesFiles,
      };
      manifestSeries.push(entry);
      seriesCount += 1;
    }

    const bookEntry = {
      bookId,
      dir: dirName,
      title: String(loaded.book.title || '未命名'),
      author: String(loaded.book.author || ''),
      pages: Number(loaded.book.pages) || 0,
      chars: Number(loaded.book.chars) || 0,
      sha256: String(loaded.book.sha256 || ''),
      schema: Number(loaded.book.schema) || 2,
      lastOpenedAt: String(loaded.book.lastOpenedAt || ''),
      practice: manifestPractice,
      series: manifestSeries,
      files: manifestFiles,
    };
    books.push(bookEntry);
  }

  for (const file of files) bytes += file.size;
  if (bytes > MAX_PACKAGE_BYTES) {
    throw new PackageError('E_EXPORT_TOO_LARGE', '书档超过 4 GiB', '减少书数量或按需导出。');
  }

  return {
    format: PACKAGE_FORMAT,
    formatVersion: FORMAT_VERSION,
    contentKeyVersion: CONTENT_KEY_VERSION,
    createdAt: iso(),
    generator: { plugin: 'dsh-book-slides', version: packageVersion(), dsh: '' },
    scope: books.length > 1 ? 'library' : 'book',
    options: { includeSource: true, includeAudio, includeImages, includePractice },
    books,
    files,
    stats: { books: books.length, series: seriesCount, lectures: lectureCount, files: files.length + 2, bytes },
    warnings,
    hints: [],
  };
}

/** manifest 是包内唯一索引；files 里的哈希就是导入时的校验依据。 */
export function buildManifest(plan) {
  return {
    format: plan.format,
    formatVersion: plan.formatVersion,
    contentKeyVersion: plan.contentKeyVersion,
    createdAt: plan.createdAt,
    generator: plan.generator,
    scope: plan.scope,
    options: plan.options,
    stats: plan.stats,
    books: plan.books.map((book) => ({
      bookId: book.bookId,
      dir: book.dir,
      title: book.title,
      author: book.author,
      pages: book.pages,
      chars: book.chars,
      sha256: book.sha256,
      schema: book.schema,
      lastOpenedAt: book.lastOpenedAt,
      practice: book.practice,
      series: book.series.map((series) => ({
        seriesId: series.seriesId,
        dir: series.dir,
        title: series.title,
        status: series.status,
        stitch: series.stitch,
        chapters: series.chapters,
        contentKey: series.contentKey,
        lectures: series.lectures.map((lecture) => ({
          n: lecture.n,
          dir: lecture.dir,
          status: lecture.status,
          slides: lecture.slides,
          pages: lecture.pages,
          lectureKey: lecture.lectureKey,
          audio: lecture.audio,
          images: lecture.images,
          files: lecture.files,
        })),
        files: series.files,
      })),
      files: book.files,
    })),
  };
}

export function packageFileName(plan) {
  const books = plan.books || [];
  const clean = (value) =>
    String(value || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
  if (books.length === 1) return (clean(books[0].title) || 'book') + '-' + books[0].bookId.slice(0, 6) + '.zip';
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return 'book-slides-' + stamp + '-' + books.length + '本.zip';
}

/** 把 plan 写成响应流。调用前所有文件都已 stat + sha256 过。 */
export function writeExportStream(res, plan) {
  const manifest = buildManifest(plan);
  const writer = new ZipWriter();
  writer.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'), 'manifest.json');
  writer.addBuffer(Buffer.from(README_TEXT + '\n', 'utf8'), 'README.txt');
  for (const file of plan.files) writer.addFile(file.abs, file.name);
  const stream = writer.end();
  res.on('close', () => {
    try {
      stream.destroy();
    } catch {
      /* 客户端已经断开 */
    }
  });
  stream.on('error', () => {
    try {
      res.destroy();
    } catch {
      /* 已经断了 */
    }
  });
  stream.pipe(res);
  return manifest;
}

export function exportSize({ bookId = null, all = false } = {}) {
  const ids = all || !bookId ? 'all' : [String(bookId)];
  let idsList = [];
  if (ids === 'all') {
    try {
      idsList = fs.readdirSync(BOOKS_DIR(), { withFileTypes: true }).filter((entry) => entry.isDirectory() && isValidId(entry.name)).map((entry) => entry.name);
    } catch {
      idsList = [];
    }
  } else {
    idsList = ids;
  }
  const books = [];
  const warnings = [];
  let bytes = 0;
  for (const id of idsList) {
    const loaded = loadBook(id);
    if (!loaded) continue;
    const size = dirSize(loaded.dir);
    books.push({ bookId: id, title: String(loaded.book.title || ''), bytes: size });
    bytes += size;
  }
  if (bytes > MAX_PACKAGE_BYTES) warnings.push('书档会超过 4 GiB，建议分批导出');
  return { bytes, books, warnings };
}

function dirSize(dir) {
  let bytes = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return bytes;
}

/* ------------------------------ 导入 ------------------------------ */

function importRoot() {
  return path.join(ROOT, IMPORT_ROOT_NAME);
}

function safeManifestPath(value, expectedPrefix) {
  const text = String(value || '');
  if (!text || /\\/.test(text) || /^\/|^[A-Za-z]:/.test(text)) {
    throw new PackageError('E_PKG_MANIFEST', '书档清单里的路径不合法', text.slice(0, 80));
  }
  for (const part of text.split('/')) {
    if (!part || part === '.' || part === '..') {
      throw new PackageError('E_PKG_MANIFEST', '书档清单里的路径不合法', text.slice(0, 80));
    }
  }
  if (expectedPrefix && !(text === expectedPrefix || text.startsWith(expectedPrefix + '/'))) {
    throw new PackageError('E_PKG_MANIFEST', '书档清单里的路径与书号对不上', text.slice(0, 120));
  }
  return text;
}

function manifestFilesOf(book) {
  const list = [];
  for (const file of Array.isArray(book.files) ? book.files : []) list.push(file);
  const practice = book.practice || {};
  for (const key of ['questions', 'mastery']) {
    if (practice[key]) list.push(practice[key]);
  }
  for (const file of Array.isArray(practice.sessions) ? practice.sessions : []) list.push(file);
  for (const series of Array.isArray(book.series) ? book.series : []) {
    for (const file of Object.values(series.files || {})) if (file) list.push(file);
    for (const lecture of Array.isArray(series.lectures) ? series.lectures : []) {
      for (const file of Object.values(lecture.files || {})) if (file) list.push(file);
    }
  }
  return list;
}

function validateManifestBook(book) {
  if (!book || typeof book !== 'object') throw new PackageError('E_PKG_MANIFEST', '书档里的书条目不合法', '');
  if (!isValidId(String(book.bookId || ''))) throw new PackageError('E_PKG_MANIFEST', '书档里的 bookId 不合法', String(book.bookId || ''));
  if (!String(book.sha256 || '')) throw new PackageError('E_PKG_MANIFEST', '书档里的书缺少 sha256', book.bookId);
  const files = manifestFilesOf(book);
  const names = new Set(files.map((file) => String(file.path || '')));
  for (const required of ['book.json', 'source.pdf', 'pages.json']) {
    if (!names.has('books/' + book.bookId + '/' + required)) {
      throw new PackageError('E_PKG_MANIFEST', '书档里缺少 ' + required, book.bookId);
    }
  }
  for (const file of files) {
    if (!file || !file.path) throw new PackageError('E_PKG_MANIFEST', '书档清单里有空的文件项', book.bookId);
    safeManifestPath(file.path, 'books/' + book.bookId);
  }
  return files;
}

function verifyStaged(staged, file) {
  const abs = path.join(staged, ...String(file.path).split('/'));
  if (!isFile(abs)) throw new PackageError('E_PKG_CHECKSUM', '书档里缺文件', file.path);
  if (Number(file.bytes) !== sizeOf(abs)) throw new PackageError('E_PKG_CHECKSUM', '文件大小与清单不一致', file.path);
  return abs;
}

async function verifySha(abs, file) {
  if (!file.sha256) return;
  const hash = await sha256File(abs);
  if (hash !== String(file.sha256)) throw new PackageError('E_PKG_CHECKSUM', '文件内容与清单不一致', file.path);
}

const importJobs = new Map();

function pruneJobs() {
  const finished = Array.from(importJobs.values()).filter((job) => !job.active);
  finished.sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')));
  for (const job of finished.slice(10)) importJobs.delete(job.jobId);
}

function jobState(job) {
  return {
    ok: true,
    jobId: job.jobId,
    fileName: job.fileName,
    policy: job.policy,
    status: job.status,
    stage: job.stage,
    current: job.current,
    total: job.total,
    items: (job.items || []).map((item) => Object.assign({}, item)),
    summary: job.summary || null,
    message: job.message || '',
    code: job.code || null,
    error: job.error || null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

export function getImportJob(jobId) {
  const job = importJobs.get(String(jobId || ''));
  return job ? jobState(job) : null;
}

export function cancelImportJob(jobId) {
  const job = importJobs.get(String(jobId || ''));
  if (!job || !job.active) return false;
  job.cancelled = true;
  job.status = 'cancelling';
  job.message = '正在取消…';
  try {
    job.controller.abort();
  } catch {
    /* 已经结束 */
  }
  return true;
}

export function isImportJobActive() {
  for (const job of importJobs.values()) if (job.active) return true;
  return false;
}

function assertActive(job) {
  if (job.cancelled) throw new PackageError('E_CANCELLED', '已取消', '');
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** 启动时清理 >24h 的 staging（导入中途进程退出的残留）。 */
export function cleanupStaleImports() {
  const root = importRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (Date.now() - stat.mtimeMs < STALE_STAGING_MS) continue;
    removeDir(full);
    removed += 1;
  }
  return removed;
}

/**
 * 启动书档导入作业（异步）：立即返回 jobId，HTTP 不等解压完成。
 * @param {{zipPath:string, policy?:string, fileName?:string}} input
 */
export function startImportPackageJob({ zipPath, policy = DEFAULT_POLICY, fileName = 'package.zip' }) {
  if (!zipPath || !isFile(zipPath)) throw new PackageError('E_PKG_NOT_ZIP', '没有收到书档', '');
  const jobId = 'i' + crypto.randomBytes(6).toString('hex');
  const job = {
    jobId,
    zipPath,
    fileName: String(fileName || 'package.zip'),
    policy: normalizePolicy(policy),
    status: 'queued',
    stage: 'queued',
    current: 0,
    total: 0,
    items: [],
    summary: null,
    message: '已排队',
    code: null,
    error: null,
    startedAt: iso(),
    finishedAt: null,
    cancelled: false,
    active: true,
    controller: new AbortController(),
    staging: path.join(importRoot(), jobId),
    promise: null,
  };
  fs.mkdirSync(job.staging, { recursive: true });
  importJobs.set(jobId, job);
  pruneJobs();

  job.promise = runImportJob(job)
    .catch((err) => {
      job.status = job.cancelled ? 'cancelled' : 'failed';
      job.stage = 'done';
      job.code = job.cancelled ? 'E_CANCELLED' : (err && err.code) || 'E_PKG_FAILED';
      job.error = job.cancelled ? '已取消' : String((err && err.message) || err);
      job.message = job.error;
      job.finishedAt = iso();
    })
    .finally(() => {
      job.active = false;
      try {
        if (path.dirname(job.zipPath) === path.resolve(importRoot())) fs.rmSync(job.zipPath, { force: true });
      } catch {
        /* 上传临时文件删不掉不影响结果 */
      }
      removeDir(job.staging);
      pruneJobs();
    });
  return jobState(job);
}

async function runImportJob(job) {
  const signal = job.controller.signal;
  const deadline = Date.parse(job.startedAt) + 30 * 60 * 1000;
  job.status = 'running';
  job.stage = 'extracting';
  job.message = '正在读取书档';

  const info = await inspectZip(job.zipPath);
  assertActive(job);
  if (Date.now() > deadline) throw new PackageError('E_PKG_TIMEOUT', '书档导入超时（30 分钟）', '可重试未完成的书。');
  const manifestBuffer = await readEntryBuffer(job.zipPath, 'manifest.json', 8 * 1024 * 1024);
  if (!manifestBuffer) throw new PackageError('E_PKG_MANIFEST', '书档缺少 manifest.json', '可能不是精讲导出的包');
  let manifest;
  try {
    manifest = JSON.parse(manifestBuffer.toString('utf8'));
  } catch {
    throw new PackageError('E_PKG_MANIFEST', 'manifest.json 不是合法 JSON', '');
  }
  if (!manifest || manifest.format !== PACKAGE_FORMAT) {
    throw new PackageError('E_PKG_MANIFEST', '这不是精讲书档包', '缺 format 标记');
  }
  const version = Number(manifest.formatVersion);
  if (!Number.isInteger(version) || version < 1) throw new PackageError('E_PKG_MANIFEST', 'manifest 缺少格式版本', '');
  if (version > FORMAT_VERSION) throw new PackageError('E_PKG_VERSION', '这个书档来自更新版本的插件', 'formatVersion=' + version);
  if (version < FORMAT_VERSION) {
    throw new PackageError('E_PKG_VERSION', '这个书档来自 1.x，2.0 不支持导入', '请用 2.0 重新导出；1.x 数据不迁移。');
  }
  const books = Array.isArray(manifest.books) ? manifest.books : [];
  if (!books.length) throw new PackageError('E_PKG_MANIFEST', '书档里没有书', '');
  if (books.length > MAX_BATCH_BOOKS) throw new PackageError('E_PKG_TOO_LARGE', '一个包最多 ' + MAX_BATCH_BOOKS + ' 本', String(books.length));

  // 单本坏包不影响同包其它本（AC-133）：只收集能读懂的条目路径，逐本校验放到 importOneBook
  const exact = new Set();
  for (const book of books) {
    try {
      for (const file of manifestFilesOf(book)) exact.add(String(file.path));
    } catch {
      /* 这一本的清单坏了，解压时跳过它的文件，导入时单独报错 */
    }
  }
  const staged = path.join(job.staging, 'extract');
  job.stage = 'extracting';
  job.message = '正在解压并校验';
  await extractEntries(job.zipPath, staged, (name) => exact.has(name));
  assertActive(job);

  job.stage = 'verifying';
  job.total = books.length;
  job.current = 0;
  const items = [];
  let okCount = 0;
  let skipCount = 0;
  let failCount = 0;
  const summary = { books: books.length, imported: 0, merged: 0, skipped: 0, failed: 0 };

  for (const book of books) {
    assertActive(job);
    job.current = items.length;
    job.stage = 'importing';
    job.message = '《' + String(book.title || book.bookId) + '》';
    let item;
    try {
      item = await importOneBook(job, book, staged, signal);
      if (item.status === 'ok') {
        okCount += 1;
        if (item.action === 'merge') summary.merged += 1;
        else summary.imported += 1;
      } else {
        skipCount += 1;
        summary.skipped += 1;
      }
    } catch (err) {
      if (job.cancelled || (err && err.code === 'E_CANCELLED')) throw err;
      failCount += 1;
      summary.failed += 1;
      item = {
        bookId: String(book.bookId || ''),
        title: String(book.title || ''),
        status: 'failed',
        code: (err && err.code) || 'E_PKG_FAILED',
        message: String((err && err.message) || err),
      };
      recordError(item.code, item.message);
    }
    items.push(item);
    job.items = items;
    job.current = items.length;
  }
  job.summary = summary;

  if (job.cancelled) throw new PackageError('E_CANCELLED', '已取消', '');
  job.status = failCount === books.length ? 'failed' : 'done';
  job.stage = 'done';
  job.message = '导入完成：成功 ' + (okCount + skipCount) + ' 本，失败 ' + failCount + ' 本';
  job.code = failCount === books.length ? items[0] && items[0].code : null;
  job.error = failCount === books.length ? (items[0] && items[0].message) : null;
  job.finishedAt = iso();
}

async function importOneBook(job, book, staged, signal) {
  const bookId = String(book.bookId);
  validateManifestBook(book);
  const sourceDir = path.join(staged, 'books', bookId);
  const files = manifestFilesOf(book);
  for (const file of files) {
    if (signal.aborted) throw new PackageError('E_CANCELLED', '已取消', '');
    const abs = verifyStaged(staged, file);
    await verifySha(abs, file);
  }
  const bookJson = readJson(path.join(sourceDir, 'book.json'), null);
  if (!bookJson || typeof bookJson !== 'object') throw new PackageError('E_PKG_MANIFEST', 'book.json 读不出来', bookId);
  if (String(bookJson.sha256 || '') !== String(book.sha256 || '')) {
    throw new PackageError('E_PKG_MANIFEST', 'book.json 的 sha256 与清单不一致', bookId);
  }
  if (!isFile(path.join(sourceDir, 'source.pdf'))) {
    throw new PackageError('E_PKG_MISSING_SOURCE', '书档里缺少 source.pdf', bookId);
  }

  const existing = loadBook(bookId);
  const sameSha = existing && String(existing.book.sha256 || '') === String(book.sha256 || '');
  if (existing && !sameSha) {
    throw new PackageError('E_PKG_ID_CONFLICT', '目标书号已被另一本书占用', bookId);
  }
  if (existing && sameSha && job.policy === 'skip') {
    return { bookId, title: String(book.title || ''), status: 'skipped', action: 'skip', message: '书架已有同一本书，已跳过' };
  }
  if (existing && sameSha && job.policy === 'copy') {
    return importAsNew(job, book, sourceDir, true);
  }
  if (existing && sameSha) {
    return mergeIntoBook(job, book, sourceDir, existing, signal);
  }
  return importAsNew(job, book, sourceDir, false);
}

async function importAsNew(job, book, sourceDir, copyMode) {
  const targetId = copyMode ? newBookId() : String(book.bookId);
  const target = path.join(BOOKS_DIR(), targetId);
  if (fs.existsSync(target)) throw new PackageError('E_PKG_ID_CONFLICT', '目标书号已被占用', targetId);
  const stagingBook = path.join(job.staging, 'book-' + targetId);
  removeDir(stagingBook);
  copyDir(sourceDir, stagingBook);
  const bookJson = readJson(path.join(stagingBook, 'book.json'), null) || {};
  bookJson.id = targetId;
  bookJson.schema = 2;
  bookJson.lastOpenedAt = iso();
  bookJson.importedAt = String(bookJson.importedAt || iso());
  writeJson(path.join(stagingBook, 'book.json'), bookJson);

  // 系列/讲：重写 id、book_id，归一非终态与缺音频
  normalizeBookTree(stagingBook, targetId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(stagingBook, target);
  return {
    bookId: targetId,
    title: String(bookJson.title || book.title || ''),
    status: 'ok',
    action: copyMode ? 'copy' : 'import',
    series: countTree(target),
    message: '已导入',
  };
}

async function mergeIntoBook(job, book, sourceDir, existing, signal) {
  const targetId = existing.book.id;
  const targetSeriesRoot = path.join(existing.dir, 'series');
  fs.mkdirSync(targetSeriesRoot, { recursive: true });
  const existingSeries = new Map();
  for (const series of listSeries(targetId)) {
    const found = findSeries(series.id);
    const key = found ? seriesContentKey(series, lectureDocMap(found)) : null;
    if (key) existingSeries.set(key, series.id);
  }
  let added = 0;
  let skipped = 0;
  let orphan = 0;
  for (const series of Array.isArray(book.series) ? book.series : []) {
    if (signal.aborted) throw new PackageError('E_CANCELLED', '已取消', '');
    if (existingSeries.has(series.contentKey)) {
      skipped += 1;
      continue;
    }
    const sourceSeriesDir = path.join(sourceDir, 'series', String(series.seriesId));
    if (!isFile(path.join(sourceSeriesDir, 'series.json'))) {
      orphan += 1;
      continue;
    }
    const seriesJson = readJson(path.join(sourceSeriesDir, 'series.json'), null);
    if (!seriesJson || !Array.isArray(seriesJson.lectures)) {
      orphan += 1;
      continue;
    }
    const newSeriesId = newSeriesId();
    const stagingSeries = path.join(job.staging, 'merge-' + newSeriesId);
    removeDir(stagingSeries);
    copyDir(sourceSeriesDir, stagingSeries);
    const now = iso();
    const next = Object.assign({}, seriesJson, {
      id: newSeriesId,
      book_id: targetId,
      updated_at: now,
    });
    normalizeLectureTree(stagingSeries, next);
    writeJson(path.join(stagingSeries, 'series.json'), next);
    fs.renameSync(stagingSeries, path.join(targetSeriesRoot, newSeriesId));
    added += 1;
  }
  if (job.policy !== 'skip') mergePractice(existing.dir, sourceDir);
  return {
    bookId: targetId,
    title: String(book.title || existing.book.title || ''),
    status: 'ok',
    action: 'merge',
    series: { added, skipped, orphan },
    message: '已并入：新增 ' + added + ' 个系列，跳过 ' + skipped + ' 个',
  };
}

function lectureDocMap(found) {
  const map = new Map();
  for (const lecture of found.series.lectures || []) {
    const doc = loadLecture(found.dir, lecture.n);
    map.set(Number(lecture.n), doc.slidesDoc && Array.isArray(doc.slidesDoc.slides) ? doc.slidesDoc.slides : []);
  }
  return map;
}

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  let entries = [];
  try {
    entries = fs.readdirSync(source, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function newBookId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = crypto.randomBytes(12);
    let out = '';
    for (let i = 0; i < 12; i += 1) out += alphabet[value[i] % alphabet.length];
    if (!fs.existsSync(path.join(BOOKS_DIR(), out))) return out;
  }
  throw new PackageError('E_PKG_FAILED', '生成书号失败', '');
}

function newSeriesId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const value = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i += 1) out += alphabet[value[i] % alphabet.length];
  return out;
}

function countTree(bookDirPath) {
  let series = 0;
  let lectures = 0;
  let ids = [];
  try {
    ids = fs.readdirSync(path.join(bookDirPath, 'series'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return { added: 0, lectures: 0 };
  }
  for (const id of ids) {
    series += 1;
    let lectureIds = [];
    try {
      lectureIds = fs.readdirSync(path.join(bookDirPath, 'series', id, 'lectures'), { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      lectureIds = [];
    }
    lectures += lectureIds.length;
  }
  return { added: series, lectures };
}

/** 归一：重写 book_id、系列 id；非终态讲 → interrupted；缺音频页 → ready_degraded。 */
function normalizeBookTree(bookDirPath, bookId) {
  let ids = [];
  try {
    ids = fs.readdirSync(path.join(bookDirPath, 'series'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return;
  }
  for (const id of ids) {
    const seriesFile = path.join(bookDirPath, 'series', id, 'series.json');
    const series = readJson(seriesFile, null);
    if (!series) continue;
    const newId = newSeriesId();
    const sourceDir = path.join(bookDirPath, 'series', id);
    const targetDir = path.join(bookDirPath, 'series', newId);
    normalizeLectureTree(sourceDir, series);
    series.id = newId;
    series.book_id = bookId;
    writeJson(path.join(sourceDir, 'series.json'), series);
    if (newId !== id) fs.renameSync(sourceDir, targetDir);
  }
  const parts = readJson(path.join(bookDirPath, 'parts.json'), null);
  if (parts && Array.isArray(parts.parts)) {
    // 书号换了，但 Part 是书内对象，无需改写
    writeJson(path.join(bookDirPath, 'parts.json'), parts);
  }
}

function normalizeLectureTree(seriesDirPath, series) {
  for (const lecture of series.lectures || []) {
    const n = Number(lecture.n);
    const dir = path.join(seriesDirPath, 'lectures', String(n));
    const metaFile = path.join(dir, 'lecture.json');
    const slidesFile = path.join(dir, 'slides.json');
    let meta = readJson(metaFile, null);
    let slidesDoc = readJson(slidesFile, null);
    let interrupted = false;
    if (LECTURE_ACTIVE.includes(String((meta && meta.status) || (lecture && lecture.status) || ''))) {
      interrupted = true;
      if (meta) {
        meta.status = 'interrupted';
        meta.code = 'E_INTERRUPTED';
        meta.error = '从书档导入时该讲还在生成中，可重试';
        meta.message = meta.error;
        meta.stage = 'done';
        meta.finished_at = iso();
        writeJson(metaFile, meta);
      }
    } else if (meta && READY.includes(String(meta.status)) && !slidesDoc) {
      meta.status = 'interrupted';
      meta.code = 'E_PKG_LECTURE_MISSING';
      meta.error = '书档里缺少 slides.json';
      writeJson(metaFile, meta);
      lecture.status = 'interrupted';
      continue;
    }
    if (slidesDoc && Array.isArray(slidesDoc.slides)) {
      let missing = 0;
      for (const slide of slidesDoc.slides) {
        const rel = String((slide && slide.audio_file) || '');
        if (!rel) continue;
        if (!/^audio\/\d{3}\.(wav|mp3)$/.test(rel) || !isFile(path.join(dir, ...rel.split('/')))) {
          slide.audio_file = null;
          slide.audio_provider = 'none';
          missing += 1;
        }
      }
      if (missing > 0) {
        writeJson(slidesFile, slidesDoc);
        if (!interrupted && meta && READY.includes(String(meta.status))) {
          meta.status = 'ready_degraded';
          meta.code = meta.code || 'E_TTS_FAIL';
          meta.error = meta.error || '有 ' + missing + ' 页缺音频，已按「本页无配音」导入';
          writeJson(metaFile, meta);
          lecture.status = 'ready_degraded';
        }
        if (series.voice_status === 'ready') series.voice_status = 'partial';
      }
    }
    if (interrupted) lecture.status = 'interrupted';
  }
  const statuses = (series.lectures || []).map((lecture) => String(lecture.status || ''));
  if (statuses.length) {
    if (statuses.every((status) => READY.includes(status))) series.status = 'ready';
    else if (statuses.some((status) => READY.includes(status))) series.status = 'partial';
    else if (statuses.every((status) => status === 'interrupted')) series.status = 'interrupted';
    else series.status = 'failed';
  }
}

/** 练习合并：题库按 qid、场次按 session_id 并集；掌握度按 qid 取已有项。 */
function mergePractice(targetDir, sourceDir) {
  const source = path.join(sourceDir, 'practice');
  if (!fs.existsSync(source)) return;
  const target = path.join(targetDir, 'practice');
  fs.mkdirSync(path.join(target, 'sessions'), { recursive: true });
  const sourceBank = readJson(path.join(source, 'questions.json'), null);
  if (sourceBank && Array.isArray(sourceBank.questions)) {
    const targetBank = readJson(path.join(target, 'questions.json'), null) || emptyPracticeBank();
    const known = new Set((targetBank.questions || []).map((question) => question.qid));
    for (const question of sourceBank.questions) {
      if (!question || !question.qid || known.has(question.qid)) continue;
      targetBank.questions.push(question);
      known.add(question.qid);
    }
    targetBank.chapters = Object.assign({}, sourceBank.chapters || {}, targetBank.chapters || {});
    writeJson(path.join(target, 'questions.json'), targetBank);
  }
  const sourceMastery = readJson(path.join(source, 'mastery.json'), null);
  if (sourceMastery && sourceMastery.items && typeof sourceMastery.items === 'object') {
    const targetMastery = readJson(path.join(target, 'mastery.json'), null) || { schema_version: 1, items: {} };
    targetMastery.items = Object.assign({}, sourceMastery.items, targetMastery.items || {});
    writeJson(path.join(target, 'mastery.json'), targetMastery);
  }
  let names = [];
  try {
    names = fs.readdirSync(path.join(source, 'sessions')).filter((name) => /^[a-z0-9]{8,16}\.json$/.test(name));
  } catch {
    names = [];
  }
  for (const name of names) {
    const from = path.join(source, 'sessions', name);
    const to = path.join(target, 'sessions', name);
    if (fs.existsSync(to)) continue;
    fs.copyFileSync(from, to);
  }
}

function emptyPracticeBank() {
  return {
    schema_version: 1,
    product_version: '2.0',
    prompt_version: 'quiz-v1',
    blueprint_version: 1,
    chapters: {},
    questions: [],
  };
}

/** 供测试/调用方读取包内书目（不解压整包）。 */
export async function readManifest(zipPath) {
  const buffer = await readEntryBuffer(zipPath, 'manifest.json', 8 * 1024 * 1024);
  if (!buffer) return null;
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
}

export { inspectZip };
