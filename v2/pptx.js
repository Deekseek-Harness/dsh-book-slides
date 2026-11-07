/**
 * 2.0 导出 PPT（FR-19.2 / P1）：按讲、整套合并、批量 ZIP。
 *
 * 只读：不调 LLM/TTS/ComfyUI，不写 slides.json / series.json，不落临时 PPT。
 * OOXML 实现复用 1.x pptx.js（原生文本框/形状、音频、备注、配图）。
 *
 * 页数严格等于 slides.length；整套合并时在讲之间插入过渡页（讲标题 + 接缝句），
 * 因此「删除过渡页后与按讲导出的页数一致」（AC-111）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { buildPptxBuffer } from '../pptx.js';
import { ZipWriter } from '../pkgzip.js';
import { loadBook } from './books.js';
import { findSeries } from './series.js';
import { loadLecture } from './lectures.js';
import { recordError } from './errors.js';

const AUDIO_RE = /^audio\/(\d{3})\.(wav|mp3)$/;
const IMAGE_RE = /^images\/(\d{3})\.png$/;
const READY = ['ready', 'ready_degraded'];
const ACTIVE = ['queued', 'structuring', 'validate', 'anchor', 'drafting', 'stitching', 'cancelling'];
const MAX_BYTES = 150 * 1024 * 1024;
export const PPT_MAX_BYTES = MAX_BYTES;

export class PptxError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'PptxError';
    this.code = code;
    this.hint = hint || '';
  }
}

function inside(root, rel) {
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return '';
  return abs;
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isRiffWav(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(12);
    const read = fs.readSync(fd, head, 0, 12, 0);
    if (read < 12) return false;
    return head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 忽略 */
      }
    }
  }
}

function wavDurationMs(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4096);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    if (read < 44) return 0;
    const size = fs.fstatSync(fd).size;
    let offset = 12;
    let byteRate = 0;
    let dataSize = 0;
    let dataOffset = 0;
    while (offset + 8 <= read) {
      const id = head.toString('ascii', offset, offset + 4);
      const chunk = head.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === 'fmt ' && body + 16 <= read) byteRate = head.readUInt32LE(body + 8);
      if (id === 'data') {
        dataSize = chunk;
        dataOffset = body;
        break;
      }
      offset = body + chunk + (chunk % 2);
    }
    if (!byteRate) return 0;
    const available = dataOffset > 0 ? Math.max(0, size - dataOffset) : Math.max(0, size - 44);
    const bytes = dataSize > 0 ? Math.min(dataSize, available) : available;
    return Math.round((bytes / byteRate) * 1000);
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 忽略 */
      }
    }
  }
}

export function pngSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(24);
    const read = fs.readSync(fd, head, 0, 24, 0);
    if (read < 24) return null;
    if (head.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
    if (head.toString('ascii', 12, 16) !== 'IHDR') return null;
    const width = head.readUInt32BE(16);
    const height = head.readUInt32BE(20);
    if (!(width > 0 && height > 0)) return null;
    return { width, height };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 忽略 */
      }
    }
  }
}

function resolveAudio(lectureDirPath, slide) {
  const index = Math.round(Number(slide && slide.slide_index) || 0);
  if (!(index > 0)) return null;
  const declared = String((slide && slide.audio_file) || '');
  const base = 'audio/' + String(index).padStart(3, '0');
  const candidates = [];
  if (AUDIO_RE.test(declared)) candidates.push(declared);
  candidates.push(base + '.wav', base + '.mp3');
  const seen = new Set();
  for (const rel of candidates) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = inside(lectureDirPath, rel);
    if (!abs || !isFile(abs)) continue;
    const size = fs.statSync(abs).size;
    if (size <= 0) continue;
    const ext = rel.endsWith('.wav') ? 'wav' : 'mp3';
    if (ext === 'wav' && (size < 44 || !isRiffWav(abs))) continue;
    return {
      path: abs,
      ext,
      bytes: size,
      file: rel,
      durationMs: ext === 'wav' ? wavDurationMs(abs) || Math.round(Number(slide.audio_ms) || 0) : Math.round(Number(slide.audio_ms) || 0),
    };
  }
  return null;
}

function unsupportedAudioFormat(lectureDirPath, slide) {
  const rel = String((slide && slide.audio_file) || '');
  if (!/^audio\/\d{3}\.(flac|ogg)$/.test(rel)) return '';
  const abs = inside(lectureDirPath, rel);
  if (!abs || !isFile(abs)) return '';
  const ext = rel.endsWith('.flac') ? 'flac' : 'ogg';
  return ext;
}

function resolveImage(lectureDirPath, slide) {
  // 失败重绘会保留旧图：只要 image_file 还在，导出就继续用老图
  const rel = String((slide && slide.image_file) || '');
  if (!IMAGE_RE.test(rel)) return null;
  const abs = inside(lectureDirPath, rel);
  if (!abs || !isFile(abs)) return null;
  const size = pngSize(abs);
  if (!size) return null;
  return { path: abs, bytes: fs.statSync(abs).size, width: size.width, height: size.height, file: rel };
}

function sanitize(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120);
}

/** 去掉「第 N 讲 · 」前缀；没有前缀原样返回。 */
export function stripLecturePrefix(title) {
  const text = String(title || '').trim();
  const stripped = text.replace(/^第\s*\d+\s*讲\s*(?:[·:：\-–—]\s*)?/, '').trim();
  return stripped || text;
}

export function buildFileName(bookTitle, title) {
  const book = String(bookTitle || '未命名').trim();
  const rest = stripLecturePrefix(title);
  const raw = rest ? book + '-精讲-' + rest : book + '-精讲';
  return (sanitize(raw) || '精讲') + '.pptx';
}

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function assertEligible(lecture) {
  const status = String((lecture && lecture.status) || '');
  if (ACTIVE.includes(status)) {
    throw new PptxError('E_PPT_BUSY', '正在生成，完成后再导出', '等这一讲生成结束。');
  }
  if (!READY.includes(status)) {
    throw new PptxError('E_PPT_NOT_READY', '这一讲还没生成完，完成后才能导出', '先把它生成出来。');
  }
}

function lectureMeta(found, n) {
  return (found.series.lectures || []).find((item) => Number(item.n) === Number(n)) || null;
}

function buildDeckForLecture(found, n, options) {
  const includeAudio = options.includeAudio !== false;
  const includeImages = options.includeImages !== false;
  const includeNotes = options.includeNotes !== false;
  const meta = lectureMeta(found, n);
  if (!meta) throw new PptxError('E_PPT_NOT_READY', '第 ' + n + ' 讲不存在', '');
  assertEligible(meta);
  const doc = loadLecture(found.dir, n);
  if (!doc.exists || !doc.slidesDoc || !Array.isArray(doc.slidesDoc.slides) || !doc.slidesDoc.slides.length) {
    throw new PptxError('E_PPT_EMPTY', '这一讲没有页面，无法导出', '');
  }
  const book = loadBook(found.series.book_id);
  const bookTitle = String((book && book.book.title) || '未命名');
  const title = String(meta.title || doc.slidesDoc.title || '第 ' + n + ' 讲');
  const list = doc.slidesDoc.slides;

  const missingAudio = [];
  const unsupportedAudio = [];
  const missingImage = [];
  const lostImages = [];
  let audioBytes = 0;
  let imageBytes = 0;
  let notesBytes = 0;
  let audioPages = 0;
  let imagePages = 0;

  const slides = list.map((source, index0) => {
    const index = index0 + 1;
    const audio = resolveAudio(doc.dir, source);
    const unsupportedExt = audio ? '' : unsupportedAudioFormat(doc.dir, source);
    const image = includeImages ? resolveImage(doc.dir, source) : null;
    if (!audio) {
      if (unsupportedExt) unsupportedAudio.push({ index, ext: unsupportedExt });
      else missingAudio.push(index);
    } else {
      audioPages += 1;
      if (includeAudio) audioBytes += audio.bytes;
    }
    if (!image) {
      missingImage.push(index);
      if (String(source.image_status || '') === 'ready') lostImages.push(index);
    } else {
      imagePages += 1;
      imageBytes += image.bytes;
    }
    const notes = includeNotes ? String(source.audio_script == null ? '' : source.audio_script) : '';
    notesBytes += Buffer.byteLength(notes, 'utf8');
    return {
      layout: ['cover', 'content_text', 'quote'].includes(String(source.layout || '')) ? String(source.layout) : 'content_text',
      title: cleanText(source.title),
      subtitle: cleanText(source.subtitle),
      bullets: (Array.isArray(source.bullet_points) ? source.bullet_points : []).map(cleanText).filter(Boolean).slice(0, 5),
      quoteText: cleanText(source.quote_text),
      quoteSource: cleanText(source.quote_source),
      notes,
      bookTitle,
      audio: includeAudio ? audio : null,
      image,
    };
  });

  const warnings = [];
  if (!audioPages && !unsupportedAudio.length) warnings.push('第 ' + n + ' 讲没有可用音频，PPT 将不含声音');
  else if (missingAudio.length) warnings.push('第 ' + n + ' 讲 ' + missingAudio.length + '/' + slides.length + ' 页没有音频，将跳过');
  if (unsupportedAudio.length) {
    warnings.push(
      '第 ' + n + ' 讲 ' + unsupportedAudio.length + ' 页音频为 ' +
        Array.from(new Set(unsupportedAudio.map((item) => item.ext))).join('/') +
        '，PPT 不支持嵌入，将跳过；建议把 ComfyUI 工作流输出改成 SaveAudio（audio_format=wav）',
    );
  }
  if (!includeAudio && audioPages) warnings.push('本次不含音频（第 ' + n + ' 讲 ' + audioPages + ' 页可含音频）');
  if (!includeImages && imagePages) warnings.push('本次不含配图（第 ' + n + ' 讲 ' + imagePages + ' 页有图）');
  if (lostImages.length) warnings.push('第 ' + n + ' 讲第 ' + lostImages.slice(0, 5).join('、') + ' 页配图文件缺失，将留白');
  else if (imagePages > 0 && imagePages < slides.length) warnings.push('第 ' + n + ' 讲部分页没有配图，将留白');

  const bytes = 48 * 1024 + slides.length * 6 * 1024 + notesBytes + audioBytes + imageBytes;
  return {
    lecture: { n: Number(n), title, slides: slides.length, audioPages, imagePages, bytes, fileName: buildFileName(bookTitle, title), warnings, missingAudio, missingImage },
    deck: { title, bookTitle, slides },
  };
}

function assertBytes(bytes) {
  if (bytes > MAX_BYTES) {
    throw new PptxError('E_EXPORT_SERIES_LIMIT', 'PPT 会超过 150 MB', '去掉音频或按讲导出。');
  }
}

function transitionSlide(bookTitle, series, fromN, toN) {
  const to = lectureMeta({ series }, toN);
  const seam = (series.seams || []).find((item) => Number(item.from) === Number(fromN) && Number(item.to) === Number(toN));
  const title = '第 ' + toN + ' 讲 · ' + stripLecturePrefix((to && to.title) || '');
  const notes = String((seam && seam.sentence) || '');
  return {
    layout: 'cover',
    title: cleanText(title),
    subtitle: cleanText(notes),
    bullets: [],
    quoteText: '',
    quoteSource: '',
    notes,
    bookTitle: String(bookTitle || '未命名'),
    audio: null,
    image: null,
  };
}

/**
 * 计算导出计划（不生成 PPT）。
 * @param {{seriesId:string, lecture?:'all'|number, includeAudio?:boolean,
 *   includeImages?:boolean, includeNotes?:boolean}} input
 */
export function planPptx({ seriesId, lecture = 'all', includeAudio = true, includeImages = true, includeNotes = true }) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new PptxError('E_NOT_FOUND', '找不到这个系列', '');
  if (ACTIVE.includes(String(found.series.status))) {
    throw new PptxError('E_PPT_BUSY', '正在生成，完成后再导出', '等系列生成结束。');
  }
  const scope = lecture === 'all' || lecture == null
    ? (found.series.lectures || []).filter((item) => READY.includes(String(item.status))).map((item) => Number(item.n))
    : [Number(lecture)];
  if (!scope.length) throw new PptxError('E_PPT_EMPTY', '这个系列没有可导出的讲', '先生成讲义。');
  for (const n of scope) assertEligible(lectureMeta(found, n));

  const options = { includeAudio, includeImages, includeNotes };
  const built = scope.map((n) => buildDeckForLecture(found, n, options));
  const book = loadBook(found.series.book_id);
  const bookTitle = String((book && book.book.title) || '未命名');
  const merged = scope.length > 1;
  const transitionPages = merged ? scope.length - 1 : 0;
  const slides = built.reduce((sum, item) => sum + item.lecture.slides, 0) + transitionPages;
  const bytes = built.reduce((sum, item) => sum + item.lecture.bytes, 0) + transitionPages * 8 * 1024;
  const warnings = built.flatMap((item) => item.lecture.warnings);
  if (merged) warnings.push('整套合并含 ' + transitionPages + ' 个过渡页（讲标题 + 接缝句）');
  assertBytes(bytes);

  return {
    seriesId: found.series.id,
    mode: lecture === 'all' || lecture == null ? 'series' : 'lecture',
    lecture: lecture === 'all' || lecture == null ? null : Number(lecture),
    lectures: built.map((item) => item.lecture),
    slides,
    transitionPages,
    audioPages: built.reduce((sum, item) => sum + item.lecture.audioPages, 0),
    imagePages: built.reduce((sum, item) => sum + item.lecture.imagePages, 0),
    bytes,
    fileName: buildFileName(bookTitle, merged ? found.series.title : built[0].lecture.title),
    includeAudio,
    includeImages,
    includeNotes,
    warnings,
  };
}

/** 生成 PPT Buffer（单讲或整套合并）。 */
export async function buildPptx({ seriesId, lecture = 'all', includeAudio = true, includeImages = true, includeNotes = true }) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new PptxError('E_NOT_FOUND', '找不到这个系列', '');
  const plan = planPptx({ seriesId, lecture, includeAudio, includeImages, includeNotes });
  const options = { includeAudio, includeImages, includeNotes };
  const scope = lecture === 'all' || lecture == null
    ? (found.series.lectures || []).filter((item) => READY.includes(String(item.status))).map((item) => Number(item.n))
    : [Number(lecture)];
  const book = loadBook(found.series.book_id);
  const bookTitle = String((book && book.book.title) || '未命名');
  const slides = [];
  for (let index = 0; index < scope.length; index += 1) {
    const n = scope[index];
    if (index > 0) slides.push(transitionSlide(bookTitle, found.series, scope[index - 1], n));
    const built = buildDeckForLecture(found, n, options);
    slides.push(...built.deck.slides);
  }
  const title = plan.mode === 'series' ? found.series.title : plan.lectures[0].title;
  try {
    const buffer = await buildPptxBuffer({ title, bookTitle, slides });
    return { buffer, plan };
  } catch (err) {
    recordError('E_PPT_BUILD', String((err && err.message) || err));
    throw new PptxError('E_PPT_FAIL', 'PPT 生成失败', String((err && err.message) || err).slice(0, 200));
  }
}

/** 批量导出：每讲一个 .pptx + manifest.json。 */
export async function buildPptxBatch({ seriesId, lectures = 'all', includeAudio = true, includeImages = true, includeNotes = true }) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new PptxError('E_NOT_FOUND', '找不到这个系列', '');
  let scope;
  if (lectures === 'all' || lectures == null) {
    scope = (found.series.lectures || []).filter((item) => READY.includes(String(item.status))).map((item) => Number(item.n));
  } else {
    scope = (Array.isArray(lectures) ? lectures : String(lectures).split(','))
      .map((value) => Number(value))
      .filter((n) => Number.isInteger(n) && n > 0);
  }
  scope = Array.from(new Set(scope));
  if (!scope.length) throw new PptxError('E_PPT_EMPTY', '没有可导出的讲', '先生成讲义。');
  for (const n of scope) assertEligible(lectureMeta(found, n));

  const writer = new ZipWriter();
  const files = [];
  let bytes = 0;
  for (const n of scope) {
    const out = await buildPptx({ seriesId, lecture: n, includeAudio, includeImages, includeNotes });
    writer.addBuffer(out.buffer, out.plan.fileName);
    files.push({ file: out.plan.fileName, lecture: n, slides: out.plan.slides, bytes: out.buffer.length });
    bytes += out.buffer.length;
  }
  const manifest = {
    format: 'dsh-book-slides/pptx-batch',
    version: 1,
    product_version: '2.0',
    seriesId: found.series.id,
    title: found.series.title,
    createdAt: new Date().toISOString(),
    files,
    bytes,
  };
  writer.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'), 'manifest.json');
  const stream = writer.end();
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return { buffer: Buffer.concat(chunks), manifest, files };
}

/** content-disposition：同时给 ASCII fallback 与 filename*=UTF-8''。 */
export function contentDisposition(fileName) {
  const name = String(fileName || 'lecture.pptx');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name);
}
