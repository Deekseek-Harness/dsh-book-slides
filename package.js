/**
 * 精讲台 · 书档（导入/导出）
 *
 * 规范：doc/requirements/规范需求.md FR-9 + 附录 M。
 *
 * 这里的三个不变量，改代码前先读一遍：
 *   1. 书的身份是 `book.json.sha256`，不是 bookId；模块的身份是 contentKey，不是 moduleId。
 *   2. 导出只读：不动 books/ 下任何文件，也不落临时 ZIP。
 *   3. 导入零生成：不调 LLM、不请求 TTS、不重抽 PDF；缺什么按 D30 归一。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  BOOKS_DIR,
  ensureDirs,
  existingBookDir,
  isValidId,
  newId,
  readJson,
  writeJson,
} from './store.js';
import { bookHasActiveJob, moduleCacheKey } from './generate.js';
import { ZipError, ZipWriter, extractEntries, inspectZip, readEntryBuffer } from './pkgzip.js';

const require = createRequire(import.meta.url);
const PKG = require('./package.json');

export const PLUGIN_VERSION = String((PKG && PKG.version) || '0.0.0');
export const PACKAGE_FORMAT = 'dsh-book-slides/package';
export const FORMAT_VERSION = 1;
export const CONTENT_KEY_VERSION = 1;
export const MAX_PACKAGE_BYTES = 4 * 1024 ** 3;
export const MAX_BATCH_BOOKS = 10;
export const POLICIES = ['merge', 'skip', 'copy'];
export const DEFAULT_POLICY = 'merge';

const ACTIVE_STATUS = ['queued', 'structuring', 'validate', 'anchor', 'voicing'];
const READY_STATUS = ['ready', 'ready_degraded'];
const AUDIO_RE = /^audio\/[A-Za-z0-9._-]+$/;
const IMAGE_RE = /^images\/[A-Za-z0-9._-]+$/;

export const README_TEXT = [
  'DSH 精讲 · 书档包',
  '',
  '这是「精讲」面板导出的书档，用来在另一台机器或另一个数据目录里还原这本书：',
  '原文 PDF、章节、精讲模块、配音与配图都在包里，导入后不需要重新生成。',
  '',
  '导入方式：打开精讲面板 → 点「导入书档」→ 选择本文件（.zip）。',
  '请不要手动改动包内文件；改了 manifest.json 里的哈希会导致导入被拒绝。',
].join('\n');

export class PackageError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'PackageError';
    this.code = code;
    this.hint = hint || '';
  }
}

/* ------------------------------ 小工具 ------------------------------ */

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function sha256OfBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
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

function iso(ms) {
  return new Date(ms).toISOString();
}

/** 规范里的 canonicalJson：字段顺序固定，去掉跨模块会变的东西。 */
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

/**
 * 跨机模块身份。刻意去掉 module_id / book_id / generated_at / audio_* / voice.*：
 * 同一套幻灯片换台机器、换个音色，仍然是同一个模块。
 */
export function contentKeyOf(record, slidesDoc) {
  const slides = slidesDoc && Array.isArray(slidesDoc.slides) ? slidesDoc.slides : [];
  const body = {
    v: CONTENT_KEY_VERSION,
    chapters: (Array.isArray(record && record.chapters) ? record.chapters : []).map((n) => Number(n) || 0),
    promptVersion: String((record && record.promptVersion) || (slidesDoc && slidesDoc.prompt_version) || ''),
    slides: slides.map(canonicalSlide),
  };
  return sha256OfBuffer(Buffer.from(JSON.stringify(body), 'utf8'));
}

export function normalizePolicy(raw) {
  const value = String(raw || '').trim();
  return POLICIES.includes(value) ? value : DEFAULT_POLICY;
}

function moduleDirsOf(bookDirPath) {
  let names = [];
  try {
    names = fs
      .readdirSync(path.join(bookDirPath, 'modules'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return names.filter((name) => isValidId(name));
}

export function findBySha256(hash) {
  if (!hash) return null;
  let names = [];
  try {
    names = fs
      .readdirSync(BOOKS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  for (const id of names) {
    if (!isValidId(id)) continue;
    const book = readJson(path.join(BOOKS_DIR, id, 'book.json'), null);
    if (book && String(book.sha256 || '') === String(hash)) return { id, dir: path.join(BOOKS_DIR, id) };
  }
  return null;
}

/* ------------------------------ 导出 ------------------------------ */

/**
 * 扫描要导出的书与模块，产出「文件清单 + manifest 素材」。
 * 只读，不改盘；任何缺失都在这里报错，避免流写到一半才炸。
 */
export async function planExport(bookIds, options) {
  const opts = options || {};
  const includeAudio = opts.includeAudio !== false;
  const ids = [];
  for (const raw of Array.isArray(bookIds) ? bookIds : []) {
    const id = String(raw || '').trim();
    if (!id) continue;
    if (!isValidId(id)) throw new PackageError('E_BAD_ID', '书号不合法', id.slice(0, 40));
    if (ids.includes(id)) continue;
    ids.push(id);
  }
  if (!ids.length) throw new PackageError('E_EXPORT_EMPTY', '先选至少一本书', '');
  if (ids.length > MAX_BATCH_BOOKS) {
    throw new PackageError('E_EXPORT_TOO_LARGE', '一次最多导出 ' + MAX_BATCH_BOOKS + ' 本', '共 ' + ids.length + ' 本');
  }
  ensureDirs();

  const createdAt = iso(Date.now());
  const books = [];
  const files = [];
  const warnings = [];
  let bytes = 0;
  let moduleCount = 0;

  for (const id of ids) {
    const dir = existingBookDir(id);
    if (!dir) throw new PackageError('E_NOT_FOUND', '找不到这本书', id);
    if (bookHasActiveJob(id)) {
      const title = String((readJson(path.join(dir, 'book.json'), {}) || {}).title || id);
      throw new PackageError('E_EXPORT_BUSY', '《' + title + '》正在生成，完成后再导出', id);
    }
    const book = readJson(path.join(dir, 'book.json'), null);
    if (!book || typeof book !== 'object') throw new PackageError('E_EXPORT_FAILED', '这本书的 book.json 读不出来', id);
    const title = String(book.title || '未命名');
    for (const name of ['source.pdf', 'pages.json', 'chapters.json']) {
      if (!isFile(path.join(dir, name))) {
        throw new PackageError('E_EXPORT_FAILED', '《' + title + '》缺少 ' + name, '缺原文或章节数据的书导不完整，先重新导入一次');
      }
    }
    if (!String(book.sha256 || '')) {
      throw new PackageError('E_EXPORT_FAILED', '《' + title + '》的 book.json 缺内容哈希', id);
    }

    const bookDirName = 'books/' + id;
    const entry = {
      bookId: id,
      dir: bookDirName,
      title,
      author: String(book.author || ''),
      pages: Number(book.pages) || 0,
      chars: Number(book.chars) || 0,
      sha256: String(book.sha256 || ''),
      schemaVersion: Number(book.schemaVersion) || 1,
      lastOpenedAt: String(book.lastOpenedAt || book.importedAt || ''),
      files: {},
      modules: [],
    };

    const addFile = async (key, fileName) => {
      const abs = path.join(dir, fileName);
      if (!isFile(abs)) return false;
      const name = bookDirName + '/' + fileName;
      const size = sizeOf(abs);
      const sha256 = key === 'source' ? String(book.sha256 || '') : await sha256File(abs);
      entry.files[key] = { path: name, sha256, bytes: size };
      files.push({ abs, name, size });
      bytes += size;
      return true;
    };

    await addFile('book', 'book.json');
    await addFile('source', 'source.pdf');
    await addFile('pages', 'pages.json');
    await addFile('chapters', 'chapters.json');
    await addFile('toc', 'toc.json');

    for (const moduleId of moduleDirsOf(dir)) {
      const moduleDir = path.join(dir, 'modules', moduleId);
      const record = readJson(path.join(moduleDir, 'module.json'), null);
      if (!record || typeof record !== 'object') {
        warnings.push('跳过损坏模块 ' + moduleId);
        continue;
      }
      const slidesDoc = readJson(path.join(moduleDir, 'slides.json'), null);
      const status = String(record.status || '');
      if (READY_STATUS.includes(status) && !slidesDoc) {
        warnings.push('《' + title + '》的模块 ' + moduleId + ' 没有 slides.json，已跳过');
        continue;
      }

      const moduleName = bookDirName + '/modules/' + moduleId;
      const moduleEntry = {
        moduleId,
        dir: moduleName,
        status,
        chapters: (Array.isArray(record.chapters) ? record.chapters : []).map((n) => Number(n) || 0),
        contentKey: slidesDoc ? contentKeyOf(record, slidesDoc) : null,
        slides: Array.isArray(slidesDoc && slidesDoc.slides) ? slidesDoc.slides.length : 0,
        audio: { count: 0, expected: 0, bytes: 0, pattern: 'audio/NNN.wav' },
        images: { count: 0, expected: 0, bytes: 0, pattern: 'images/NNN.png' },
        files: {},
      };

      const moduleFile = path.join(moduleDir, 'module.json');
      const moduleSize = sizeOf(moduleFile);
      moduleEntry.files.module = {
        path: moduleName + '/module.json',
        sha256: await sha256File(moduleFile),
        bytes: moduleSize,
      };
      files.push({ abs: moduleFile, name: moduleName + '/module.json', size: moduleSize });
      bytes += moduleSize;

      if (slidesDoc) {
        const slidesFile = path.join(moduleDir, 'slides.json');
        const slidesSize = sizeOf(slidesFile);
        moduleEntry.files.slides = {
          path: moduleName + '/slides.json',
          sha256: await sha256File(slidesFile),
          bytes: slidesSize,
        };
        files.push({ abs: slidesFile, name: moduleName + '/slides.json', size: slidesSize });
        bytes += slidesSize;
      }

      const seen = new Set();
      for (const slide of Array.isArray(slidesDoc && slidesDoc.slides) ? slidesDoc.slides : []) {
        const rel = String((slide && slide.audio_file) || '');
        if (!rel) continue;
        moduleEntry.audio.expected += 1;
        if (!AUDIO_RE.test(rel) || seen.has(rel)) continue;
        seen.add(rel);
        const abs = path.join(moduleDir, ...rel.split('/'));
        if (!isFile(abs)) {
          warnings.push('模块 ' + moduleId + ' 缺音频 ' + rel + '，导入后该页会显示「本页无配音」');
          continue;
        }
        if (!includeAudio) continue;
        const audioSize = sizeOf(abs);
        moduleEntry.audio.count += 1;
        moduleEntry.audio.bytes += audioSize;
        files.push({ abs, name: moduleName + '/' + rel, size: audioSize });
        bytes += audioSize;
      }

      // 配图（v1.4）：与音频同级入包；缺图不拦导出，导入端会归一为「待补」
      const seenImages = new Set();
      for (const slide of Array.isArray(slidesDoc && slidesDoc.slides) ? slidesDoc.slides : []) {
        const rel = String((slide && slide.image_file) || '');
        if (!rel) continue;
        moduleEntry.images.expected += 1;
        if (!IMAGE_RE.test(rel) || seenImages.has(rel)) continue;
        seenImages.add(rel);
        const abs = path.join(moduleDir, ...rel.split('/'));
        if (!isFile(abs)) {
          warnings.push('模块 ' + moduleId + ' 缺配图 ' + rel + '，导入后该页会回退提示词占位');
          continue;
        }
        const imageSize = sizeOf(abs);
        moduleEntry.images.count += 1;
        moduleEntry.images.bytes += imageSize;
        files.push({ abs, name: moduleName + '/' + rel, size: imageSize });
        bytes += imageSize;
      }

      moduleCount += 1;
      entry.modules.push(moduleEntry);
    }

    books.push(entry);
  }

  return {
    format: PACKAGE_FORMAT,
    formatVersion: FORMAT_VERSION,
    contentKeyVersion: CONTENT_KEY_VERSION,
    createdAt,
    generator: { plugin: 'dsh-book-slides', version: PLUGIN_VERSION, dsh: '' },
    scope: books.length > 1 ? 'library' : 'book',
    options: { includeSource: true, includeAudio, includeImages: true },
    books,
    files,
    stats: { books: books.length, modules: moduleCount, files: files.length + 2, bytes },
    warnings,
  };
}

/** manifest 是包内唯一的索引；`files` 里的哈希就是导入时的校验依据。 */
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
      schemaVersion: book.schemaVersion,
      lastOpenedAt: book.lastOpenedAt,
      files: book.files,
      modules: book.modules.map((module) => ({
        moduleId: module.moduleId,
        dir: module.dir,
        status: module.status,
        chapters: module.chapters,
        contentKey: module.contentKey,
        slides: module.slides,
        audio: module.audio,
        images: module.images,
        files: module.files,
      })),
    })),
  };
}

export function packageFileName(plan) {
  const books = plan.books || [];
  const sanitize = (value) =>
    String(value || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
  if (books.length === 1) {
    const title = sanitize(books[0].title) || 'book';
    return title + '-' + books[0].bookId.slice(0, 6) + '.zip';
  }
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return 'book-slides-' + stamp + '-' + books.length + '本.zip';
}

/** 把 plan 写成响应流。调用前 plan 已经把所有文件 stat 过一遍。 */
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

/* ------------------------------ 导入 ------------------------------ */

function safeManifestPath(value, expectedPrefix) {
  const text = String(value || '');
  if (!text || /\\/.test(text) || /^\/|^[A-Za-z]:/.test(text)) {
    throw new PackageError('E_PKG_MANIFEST', '书档清单里的路径不合法', text.slice(0, 80));
  }
  const parts = text.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') {
      throw new PackageError('E_PKG_MANIFEST', '书档清单里的路径不合法', text.slice(0, 80));
    }
  }
  if (expectedPrefix && !(text === expectedPrefix || text.startsWith(expectedPrefix + '/'))) {
    throw new PackageError('E_PKG_MANIFEST', '书档清单里的路径与书号对不上', text.slice(0, 120));
  }
  return text;
}

function buildAllowlist(manifest) {
  const exact = new Set();
  const audioPrefixes = [];
  const imagePrefixes = [];
  for (const book of manifest.books) {
    for (const key of ['book', 'pages', 'chapters', 'toc', 'source']) {
      const file = book.files && book.files[key];
      if (file && file.path) exact.add(String(file.path));
    }
    for (const module of Array.isArray(book.modules) ? book.modules : []) {
      for (const key of ['module', 'slides']) {
        const file = module.files && module.files[key];
        if (file && file.path) exact.add(String(file.path));
      }
      if (module.dir) {
        audioPrefixes.push(String(module.dir) + '/audio/');
        imagePrefixes.push(String(module.dir) + '/images/');
      }
    }
  }
  return (name) => {
    if (exact.has(name)) return true;
    for (const prefix of audioPrefixes) {
      if (name.startsWith(prefix) && !name.slice(prefix.length).includes('/')) return true;
    }
    for (const prefix of imagePrefixes) {
      if (name.startsWith(prefix) && !name.slice(prefix.length).includes('/')) return true;
    }
    return false;
  };
}

async function verifyFile(staged, meta, expectedSha, code) {
  const failure = code || 'E_PKG_CHECKSUM';
  const abs = path.join(staged, ...meta.path.split('/'));
  if (!isFile(abs)) throw new PackageError(failure, '书档里缺文件', meta.path);
  if (Number(meta.bytes) !== sizeOf(abs)) {
    throw new PackageError(failure, '文件大小与清单不一致', meta.path);
  }
  const sha = await sha256File(abs);
  const wanted = expectedSha || meta.sha256;
  if (String(wanted || '') && sha !== String(wanted)) {
    throw new PackageError(failure, '文件内容与清单不一致', meta.path);
  }
  return abs;
}

function normalizeModuleDir(moduleDir, moduleId, bookId) {
  const recordFile = path.join(moduleDir, 'module.json');
  const record = readJson(recordFile, null);
  if (!record || typeof record !== 'object') {
    throw new PackageError('E_PKG_MANIFEST', '模块的 module.json 读不出来', moduleId);
  }
  const slidesFile = path.join(moduleDir, 'slides.json');
  const slidesDoc = readJson(slidesFile, null);
  const status = String(record.status || '');

  if (READY_STATUS.includes(status) && !slidesDoc) {
    throw new PackageError('E_PKG_MANIFEST', '模块缺少 slides.json', moduleId);
  }

  if (ACTIVE_STATUS.includes(status)) {
    record.status = 'interrupted';
    record.stage = 'done';
    record.code = 'E_INTERRUPTED';
    record.error = '从书档导入时该模块还在生成中，可重试';
    record.message = record.error;
  }

  if (slidesDoc && Array.isArray(slidesDoc.slides)) {
    let missing = 0;
    for (const slide of slidesDoc.slides) {
      const rel = String((slide && slide.audio_file) || '');
      if (!rel) continue;
      const abs = path.join(moduleDir, ...rel.split('/'));
      const inside = AUDIO_RE.test(rel);
      if (!inside || !isFile(abs)) {
        slide.audio_file = null;
        slide.audio_provider = 'none';
        missing += 1;
      }
    }
    if (missing > 0) {
      writeJson(slidesFile, slidesDoc);
      record.status = READY_STATUS.includes(record.status) ? 'ready_degraded' : record.status;
      record.code = record.code || 'E_TTS_FAIL';
      record.error = record.error || '有 ' + missing + ' 页缺音频，已按「本页无配音」导入';
      record.message = record.message || record.error;
      if (record.voice && typeof record.voice === 'object') record.voice.degraded = true;
    }
  }

  /* 配图（v1.4）：缺图只影响该页，模块仍是 ready；导入不重跑 GPU */
  if (slidesDoc && Array.isArray(slidesDoc.slides)) {
    const hadImages =
      !!record.images ||
      slidesDoc.slides.some((slide) => slide && (slide.image_file || (slide.image_status && slide.image_status !== 'none')));
    if (hadImages) {
      let imageTotal = 0;
      let imageDone = 0;
      let imageFailed = 0;
      let changed = false;
      for (const slide of slidesDoc.slides) {
        if (String((slide && slide.layout) || '') !== 'content_text') continue;
        imageTotal += 1;
        const rel = String((slide && slide.image_file) || '');
        if (rel) {
          const abs = path.join(moduleDir, ...rel.split('/'));
          if (!IMAGE_RE.test(rel) || !isFile(abs)) {
            slide.image_file = null;
            slide.image_status = 'failed';
            slide.image_error = 'E_PKG_IMAGE_MISSING：书档里缺这张配图';
            changed = true;
          }
        }
        if (slide.image_status === 'ready' && slide.image_file) imageDone += 1;
        else if (slide.image_status === 'failed') imageFailed += 1;
      }
      if (changed) writeJson(slidesFile, slidesDoc);
      const imageStatus = imageTotal && imageDone === imageTotal ? 'done' : imageDone > 0 ? 'partial' : imageFailed > 0 ? 'failed' : 'none';
      record.images = Object.assign({}, record.images && typeof record.images === 'object' ? record.images : {}, {
        provider: 'comfyui',
        status: imageStatus,
        total: imageTotal,
        done: imageDone,
        failed: imageFailed,
        code: imageFailed ? 'E_IMG_PARTIAL' : null,
        error: imageFailed ? '有 ' + imageFailed + ' 页缺配图，可到模块上点「补配图」' : null,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  record.id = moduleId;
  record.bookId = bookId;
  record.cacheKey = moduleCacheKey(
    bookId,
    (Array.isArray(record.chapters) ? record.chapters : []).map((n) => ({ n: Number(n) || 0 })),
    record.model || '',
    record.promptVersion || '',
  );
  writeJson(recordFile, record);
  return { record, slidesDoc };
}

function chapterBindingOk(record, localChapters) {
  const byN = new Map();
  for (const chapter of Array.isArray(localChapters) ? localChapters : []) {
    byN.set(Number(chapter.n) || 0, chapter);
  }
  const ns = (Array.isArray(record.chapters) ? record.chapters : []).map((n) => Number(n) || 0);
  for (const n of ns) {
    if (!byN.has(n)) return false;
  }
  const titles = Array.isArray(record.chapterTitles) ? record.chapterTitles : [];
  if (!titles.length) return true;
  return ns.every((n, index) => String((byN.get(n) || {}).title || '') === String(titles[index] || ''));
}

function localContentKeys(bookDirPath) {
  const keys = new Set();
  for (const moduleId of moduleDirsOf(bookDirPath)) {
    const moduleDir = path.join(bookDirPath, 'modules', moduleId);
    const record = readJson(path.join(moduleDir, 'module.json'), null);
    const slidesDoc = readJson(path.join(moduleDir, 'slides.json'), null);
    if (!record || !slidesDoc) continue;
    keys.add(contentKeyOf(record, slidesDoc));
  }
  return keys;
}

function rewriteBookForImport(book, targetId, index, now, meta) {
  const next = Object.assign({}, book, {
    id: targetId,
    lastOpenedAt: iso(now + index),
  });
  next.source = {
    kind: 'package',
    exportedAt: String((meta && meta.createdAt) || ''),
    generator: {
      plugin: 'dsh-book-slides',
      version: String((meta && meta.generator && meta.generator.version) || ''),
    },
    originalBookId: String(book.id || ''),
  };
  return next;
}

async function importOne(options) {
  const { entry, stagedRoot, policy, now, index, fileName, meta, dedupe } = options;
  const bookId = String(entry.bookId || '');
  if (!isValidId(bookId)) throw new PackageError('E_PKG_MANIFEST', '书档里的书号不合法', bookId.slice(0, 40));
  if (entry.dir !== 'books/' + bookId) {
    throw new PackageError('E_PKG_MANIFEST', '书档里的目录与书号不一致', bookId);
  }
  const stagedBook = path.join(stagedRoot, ...entry.dir.split('/'));
  if (!fs.existsSync(stagedBook)) throw new PackageError('E_PKG_MANIFEST', '书档里缺这本书的目录', bookId);

  if (!entry.files || !entry.files.book || !entry.files.pages || !entry.files.chapters || !entry.files.source) {
    throw new PackageError('E_PKG_MANIFEST', '书档清单缺必需文件', bookId);
  }
  safeManifestPath(entry.files.book.path, entry.dir);
  safeManifestPath(entry.files.pages.path, entry.dir);
  safeManifestPath(entry.files.chapters.path, entry.dir);
  safeManifestPath(entry.files.source.path, entry.dir);
  if (entry.files.toc) safeManifestPath(entry.files.toc.path, entry.dir);

  const bookFile = await verifyFile(stagedRoot, entry.files.book);
  const book = readJson(bookFile, null);
  if (!book || typeof book !== 'object') throw new PackageError('E_PKG_MANIFEST', 'book.json 读不出来', bookId);
  if (Number(book.schemaVersion || 1) > 1) {
    throw new PackageError('E_PKG_VERSION', '这本书的数据版本比插件新', 'schemaVersion=' + book.schemaVersion);
  }
  if (String(book.id) !== bookId) throw new PackageError('E_PKG_MANIFEST', 'book.json 里的书号与目录不一致', bookId);
  if (!String(book.sha256 || '')) throw new PackageError('E_PKG_CHECKSUM', 'book.json 缺内容哈希', bookId);

  const sourcePath = path.join(stagedRoot, ...entry.files.source.path.split('/'));
  if (!isFile(sourcePath)) {
    throw new PackageError('E_PKG_NO_PDF', '包里没有原文 PDF', entry.files.source.path);
  }
  const sourceFile = await verifyFile(stagedRoot, entry.files.source, String(book.sha256));
  await verifyFile(stagedRoot, entry.files.pages);
  await verifyFile(stagedRoot, entry.files.chapters);
  if (entry.files.toc) await verifyFile(stagedRoot, entry.files.toc);

  const pages = readJson(path.join(stagedBook, 'pages.json'), null);
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new PackageError('E_PKG_MANIFEST', 'pages.json 不是有效数组', bookId);
  }
  if (Number(book.pages) && Number(book.pages) !== pages.length) {
    throw new PackageError('E_PKG_MANIFEST', 'pages.json 页数与 book.json 不一致', bookId);
  }
  const chapters = readJson(path.join(stagedBook, 'chapters.json'), null);
  if (!Array.isArray(chapters)) throw new PackageError('E_PKG_MANIFEST', 'chapters.json 不是有效数组', bookId);
  for (const chapter of chapters) {
    const n = Number(chapter && chapter.n);
    const from = Number(chapter && chapter.from);
    const to = Number(chapter && chapter.to);
    if (!Number.isFinite(n) || !Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from) {
      throw new PackageError('E_PKG_MANIFEST', 'chapters.json 里有无效章节', bookId);
    }
  }

  const existing = findBySha256(book.sha256);
  const base = {
    file: fileName,
    bookId,
    title: String(book.title || entry.title || '未命名'),
  };

  if (existing && policy === 'skip') {
    return Object.assign({}, base, {
      status: 'skipped',
      code: 'E_PKG_BOOK_EXISTS',
      message: '这本书已在书架',
      modulesAdded: 0,
      moduleExists: 0,
      orphanModules: [],
    });
  }

  const merge = !!(existing && policy === 'merge');
  const targetId = existing ? (merge ? existing.id : newId(12)) : bookId;
  const targetDir = path.join(BOOKS_DIR, targetId);
  if (!existing && fs.existsSync(targetDir)) {
    throw new PackageError('E_PKG_ID_CONFLICT', '本机已有同书号但内容不同的书', targetId);
  }

  if (!merge) {
    for (const moduleEntry of entry.modules || []) {
      const moduleId = String(moduleEntry.moduleId || '');
      if (!isValidId(moduleId)) throw new PackageError('E_PKG_MANIFEST', '模块号不合法', moduleId);
      if (moduleEntry.dir !== entry.dir + '/modules/' + moduleId) {
        throw new PackageError('E_PKG_MANIFEST', '模块目录与模块号不一致', moduleId);
      }
      const moduleDir = path.join(stagedRoot, ...moduleEntry.dir.split('/'));
      if (!fs.existsSync(moduleDir)) {
        throw new PackageError('E_PKG_MANIFEST', '书档里缺模块目录', moduleId);
      }
      if (moduleEntry.files && moduleEntry.files.module) {
        safeManifestPath(moduleEntry.files.module.path, moduleEntry.dir);
        await verifyFile(stagedRoot, moduleEntry.files.module);
      }
      if (moduleEntry.files && moduleEntry.files.slides) {
        safeManifestPath(moduleEntry.files.slides.path, moduleEntry.dir);
        await verifyFile(stagedRoot, moduleEntry.files.slides);
      } else if (READY_STATUS.includes(String(moduleEntry.status || ''))) {
        throw new PackageError('E_PKG_MANIFEST', '模块缺少 slides.json', moduleId);
      }
      normalizeModuleDir(moduleDir, moduleId, targetId);
    }
    writeJson(path.join(stagedBook, 'book.json'), rewriteBookForImport(book, targetId, index, now, meta));
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.renameSync(stagedBook, targetDir);
    return Object.assign({}, base, {
      bookId: targetId,
      status: 'imported',
      modulesAdded: (entry.modules || []).length,
      moduleExists: 0,
      orphanModules: [],
    });
  }

  // merge：只补模块，绝不动目标书的 book/chapters/toc/pages/source
  const localChapters = readJson(path.join(targetDir, 'chapters.json'), []);
  const existingKeys = localContentKeys(targetDir);
  let modulesAdded = 0;
  let moduleExists = 0;
  const orphanModules = [];

  for (const moduleEntry of entry.modules || []) {
    const moduleId = String(moduleEntry.moduleId || '');
    if (!isValidId(moduleId)) throw new PackageError('E_PKG_MANIFEST', '模块号不合法', moduleId);
    const stagedModule = path.join(stagedRoot, ...String(moduleEntry.dir || '').split('/'));
    if (moduleEntry.dir !== entry.dir + '/modules/' + moduleId || !fs.existsSync(stagedModule)) {
      throw new PackageError('E_PKG_MANIFEST', '模块目录与模块号不一致', moduleId);
    }
    if (moduleEntry.files && moduleEntry.files.module) {
      safeManifestPath(moduleEntry.files.module.path, moduleEntry.dir);
      await verifyFile(stagedRoot, moduleEntry.files.module);
    }
    if (moduleEntry.files && moduleEntry.files.slides) {
      safeManifestPath(moduleEntry.files.slides.path, moduleEntry.dir);
      await verifyFile(stagedRoot, moduleEntry.files.slides);
    }

    const record = readJson(path.join(stagedModule, 'module.json'), null);
    const slidesDoc = readJson(path.join(stagedModule, 'slides.json'), null);
    const key = slidesDoc ? contentKeyOf(record, slidesDoc) : '';
    if (dedupe !== false && key && existingKeys.has(key)) {
      moduleExists += 1;
      continue;
    }
    if (!chapterBindingOk(record || {}, localChapters)) {
      orphanModules.push({ moduleId, title: String((record && record.title) || '') });
      continue;
    }

    let nextId = moduleId;
    if (fs.existsSync(path.join(targetDir, 'modules', nextId))) nextId = newId(10);
    const normalized = normalizeModuleDir(stagedModule, nextId, targetId);
    const targetModuleDir = path.join(targetDir, 'modules', nextId);
    fs.mkdirSync(path.dirname(targetModuleDir), { recursive: true });
    fs.renameSync(stagedModule, targetModuleDir);
    if (normalized.slidesDoc && dedupe !== false) existingKeys.add(contentKeyOf(normalized.record, normalized.slidesDoc));
    modulesAdded += 1;
  }

  return Object.assign({}, base, {
    bookId: targetId,
    status: 'merged',
    modulesAdded,
    moduleExists,
    orphanModules,
  });
}

/**
 * 导入一个包。stagingRoot 由调用方创建并负责清理。
 * 逐本判定：一本坏不拖累同包其它本，也不拖累同批其它包。
 */
export async function importPackage(options) {
  const { zipPath, policy = DEFAULT_POLICY, stagingRoot, fileName = 'package.zip' } = options || {};
  if (!zipPath) throw new PackageError('E_PKG_NOT_ZIP', '没有收到书档', '');
  const info = await inspectZip(zipPath);
  const manifestBuffer = await readEntryBuffer(zipPath, 'manifest.json', 8 * 1024 * 1024);
  if (!manifestBuffer) {
    throw new PackageError('E_PKG_MANIFEST', '书档缺少 manifest.json', '可能不是精讲导出的包');
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBuffer.toString('utf8'));
  } catch {
    throw new PackageError('E_PKG_MANIFEST', 'manifest.json 不是合法 JSON', '');
  }
  if (!manifest || manifest.format !== PACKAGE_FORMAT) {
    throw new PackageError('E_PKG_MANIFEST', '这不是精讲书档包', '缺 format 标记');
  }
  const formatVersion = Number(manifest.formatVersion);
  if (!Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new PackageError('E_PKG_MANIFEST', 'manifest 缺少格式版本', '');
  }
  if (formatVersion > FORMAT_VERSION) {
    throw new PackageError('E_PKG_VERSION', '这个包来自更新版本的插件', 'formatVersion=' + formatVersion);
  }
  if (!Array.isArray(manifest.books) || manifest.books.length === 0) {
    throw new PackageError('E_PKG_MANIFEST', '书档里没有书', '');
  }
  if (manifest.books.length > MAX_BATCH_BOOKS) {
    throw new PackageError('E_PKG_TOO_LARGE', '一个包最多 ' + MAX_BATCH_BOOKS + ' 本', String(manifest.books.length));
  }

  const accept = buildAllowlist(manifest);
  const stagedRoot = path.join(stagingRoot, 'extract');
  const extraction = await extractEntries(zipPath, stagedRoot, accept);
  const extractedSet = new Set(extraction.extracted);
  const skippedFiles = info.entries.filter(
    (item) => !item.isDir && item.name !== 'manifest.json' && !extractedSet.has(item.name),
  ).length;

  const items = [];
  const now = Date.now();
  const dedupe = Number(manifest.contentKeyVersion) === CONTENT_KEY_VERSION;
  const meta = { createdAt: manifest.createdAt, generator: manifest.generator };
  for (let index = 0; index < manifest.books.length; index += 1) {
    const entry = manifest.books[index];
    try {
      const item = await importOne({ entry, stagedRoot, policy, now, index, fileName, meta, dedupe });
      items.push(item);
    } catch (err) {
      const code = (err && err.code) || 'E_PKG_MANIFEST';
      items.push({
        file: fileName,
        bookId: String((entry && entry.bookId) || ''),
        title: String((entry && entry.title) || ''),
        status: 'failed',
        code,
        message: String((err && err.message) || err).slice(0, 300),
        hint: (err && err.hint) || '',
      });
    }
  }

  const summary = { imported: 0, merged: 0, skipped: 0, failed: 0, modulesAdded: 0, modulesExisting: 0 };
  for (const item of items) {
    if (item.status === 'imported') summary.imported += 1;
    else if (item.status === 'merged') summary.merged += 1;
    else if (item.status === 'skipped') summary.skipped += 1;
    else summary.failed += 1;
    summary.modulesAdded += Number(item.modulesAdded) || 0;
    summary.modulesExisting += Number(item.moduleExists) || 0;
  }
  return {
    ok: summary.failed === 0,
    items,
    summary,
    books: manifest.books.length,
    skippedFiles,
    totalBytes: info.totalBytes,
  };
}

export { ZipError, ZipWriter };
