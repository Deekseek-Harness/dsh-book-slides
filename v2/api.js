/**
 * 2.0 HTTP API：meta / 书架 / 导入 / 分章 / 封面 / 回收站，
 * 以及 Part、讲纲、系列生成、作业与后验缝。路由前缀仍是 /dsh-book-slides。
 */
import fs from 'node:fs';
import path from 'node:path';

import { PdfError, PDF_ERROR, extractPages, guessTitle, totalChars } from '../pdfread.js';
import { coverSvg } from '../cover.js';
import { ROOT, ensureRoot, getMeta, packageVersion, readJson } from './root.js';
import {
  clearTrash,
  createBook,
  existingBookDir,
  findBySha,
  isValidId,
  listBooks,
  listTrash,
  loadBook,
  markOpened,
  readCover,
  renameBook,
  restoreBook,
  storageStats,
  trashBook,
  writeCover,
} from './books.js';
import { ChapterError, buildBookChapters, saveBookChapters } from './chapters.js';
import { PartError, deletePart, listParts, partChapterTexts, savePart, updatePart } from './parts.js';
import {
  SeriesError,
  createSeries,
  deleteSeries,
  findSeries,
  listSeries,
  persistSeries,
  savePlan,
} from './series.js';
import { buildPlan } from './plan.js';
import {
  cancelSeriesJob,
  getSeriesJob,
  isSeriesJobActive,
  resumeSeriesJob,
  startLectureJob,
  startSeriesJob,
} from './generate.js';
import { buildStitchReport, repairStitch, writeStitchReport } from './stitch.js';
import { loadLecture } from './lectures.js';
import { readPreference, writePreference } from './prefs.js';
import { progressSummary, readProgress, saveProgress } from './progress.js';
import {
  cancelRevoiceJob,
  cancelRevoiceJobsForSeries,
  findAudioFile,
  getRevoiceJob,
  isRevoiceJobActive,
  probeVoiceConfig,
  saveVoice,
  startRevoiceJob,
  voicePayload,
} from './voice.js';
import { deleteBackup, diagnosticsPayload, listBackups, openBackup, settingsPayload } from './settings.js';
import { recordError } from './errors.js';

export const PREFIX = '/dsh-book-slides';
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function sendError(res, code, message, hint) {
  sendJson(res, 200, { ok: false, code, message, hint: hint || '' });
}

function query(url) {
  return url.searchParams;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('文件太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const buffer = await readBody(req, limit);
  if (!buffer.length) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return {};
  }
}

function cleanTitle(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[「『“"']+|[」』”"']+$/g, '')
    .trim()
    .slice(0, 120);
}

function requireId(url, key = 'bookId') {
  const id = String(query(url).get(key) || '').trim();
  if (!isValidId(id)) throw Object.assign(new Error('书 ID 非法'), { code: 'E_BAD_ID' });
  return id;
}

function rangeResponse(req, res, file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    sendError(res, 'E_NOT_FOUND', '找不到文件', '');
    return;
  }
  const range = String(req.headers.range || '');
  if (!range) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-length', stat.size);
    fs.createReadStream(file).pipe(res);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) {
    res.statusCode = 416;
    res.end();
    return;
  }
  let start = match[1] === '' ? stat.size - Number(match[2]) : Number(match[1]);
  let end = match[2] === '' || match[1] === '' ? stat.size - 1 : Number(match[2]);
  start = Math.max(0, start);
  end = Math.min(stat.size - 1, end);
  if (start > end || start >= stat.size) {
    res.statusCode = 416;
    res.setHeader('content-range', 'bytes */' + stat.size);
    res.end();
    return;
  }
  res.statusCode = 206;
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + stat.size);
  res.setHeader('content-length', end - start + 1);
  fs.createReadStream(file, { start, end }).pipe(res);
}

function handleMeta(req, res) {
  ensureRoot();
  const meta = getMeta();
  sendJson(res, 200, {
    ok: true,
    version: packageVersion(),
    product_version: '2.0',
    schema: 2,
    legacy: false,
    notice: meta.upgraded_from ? '旧数据已备份到 ' + meta.upgraded_from : '',
  });
}

function handleBooks(req, res) {
  ensureRoot();
  sendJson(res, 200, { ok: true, books: listBooks(), dataRoot: ROOT });
}

function handleBook(req, res, url) {
  ensureRoot();
  const bookId = requireId(url);
  const loaded = loadBook(bookId);
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '书架里可能已经删掉了。');
    return;
  }
  markOpened(bookId);
  sendJson(res, 200, {
    ok: true,
    book: loaded.book,
    chapters: loaded.chapters,
    cover: loaded.cover,
    chaptersBuilt: loaded.chaptersBuilt,
  });
}

async function handleImport(req, res) {
  ensureRoot();
  let fileName = '';
  try {
    fileName = decodeURIComponent(String(req.headers['x-file-name'] || ''));
  } catch {
    fileName = String(req.headers['x-file-name'] || '');
  }
  fileName = fileName.trim() || 'upload.pdf';
  if (path.extname(fileName).toLowerCase() !== '.pdf') {
    sendError(res, 'E_PDF_CORRUPT', '只支持 .pdf 文件', '请选择一份 PDF。');
    return;
  }

  let buffer;
  try {
    buffer = await readBody(req, MAX_UPLOAD_BYTES);
  } catch (err) {
    const tooLarge = /太大/.test(String((err && err.message) || ''));
    sendError(
      res,
      tooLarge ? PDF_ERROR.TOO_LARGE : 'E_IMPORT_ABORTED',
      tooLarge ? '文件超过 200 MB' : '文件没传完',
      tooLarge ? '请先压缩或拆分这份 PDF。' : '检查网络或重试。',
    );
    return;
  }
  if (!buffer.length) {
    sendError(res, 'E_IMPORT_ABORTED', '没收到文件内容', '');
    return;
  }

  let extracted;
  try {
    extracted = await extractPages(buffer);
  } catch (err) {
    if (err instanceof PdfError) sendError(res, err.code, err.message, err.hint);
    else sendError(res, PDF_ERROR.CORRUPT, '这份 PDF 打不开', String((err && err.message) || err).slice(0, 200));
    return;
  }

  const rawPages = extracted.pages;
  if (totalChars(rawPages) < 50) {
    sendError(
      res,
      PDF_ERROR.NO_TEXT,
      '这份 PDF 没有可提取的文字层',
      '可能是扫描件。请先用 OCR 工具处理成带文字层的 PDF 再导入。',
    );
    return;
  }

  const title = cleanTitle(guessTitle(fileName, rawPages, extracted.title)) || '未命名';
  try {
    const book = createBook({
      buffer,
      fileName,
      title,
      author: extracted.author,
      pages: rawPages.length,
      rawPages,
    });
    sendJson(res, 200, { ok: true, bookId: book.id, book });
  } catch (err) {
    if (err.code === 'E_DUP_BOOK') {
      sendJson(res, 200, { ok: false, code: err.code, error: err.message, bookId: err.bookId, title: err.title });
      return;
    }
    sendError(res, err.code || 'E_IMPORT_FAILED', err.message || '写入失败', err.hint || '');
  }
}

async function handleBuildChapters(req, res, ctx) {
  ensureRoot();
  const body = await readJsonBody(req);
  if (!isValidId(String(body.bookId || ''))) {
    sendError(res, 'E_BAD_ID', '书 ID 非法', '');
    return;
  }
  try {
    const result = await buildBookChapters(String(body.bookId), String(body.mode || 'auto'), {
      force: body.force === true,
      ctx: ctx || null,
      from: Number(body.from) || 0,
      to: Number(body.to) || 0,
    });
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    if (err instanceof ChapterError) sendError(res, err.code, err.message, err.hint);
    else sendError(res, 'E_CHAPTER_FAILED', '分章失败', String((err && err.message) || err).slice(0, 200));
  }
}

function handleChaptersGet(req, res, url) {
  ensureRoot();
  const bookId = requireId(url);
  const loaded = loadBook(bookId);
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  sendJson(res, 200, { ok: true, chapters: loaded.chapters, built: loaded.chaptersBuilt });
}

async function handleChaptersPost(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 8 * 1024 * 1024);
  if (!isValidId(String(body.bookId || ''))) {
    sendError(res, 'E_BAD_ID', '书 ID 非法', '');
    return;
  }
  try {
    const chapters = saveBookChapters(String(body.bookId), body.chapters);
    sendJson(res, 200, { ok: true, chapters });
  } catch (err) {
    if (err instanceof ChapterError) sendError(res, err.code, err.message, err.hint);
    else sendError(res, 'E_CHAPTER_FAILED', '保存失败', String((err && err.message) || err).slice(0, 200));
  }
}

async function handleCover(req, res, url) {
  ensureRoot();
  if (req.method === 'GET') {
    const bookId = requireId(url);
    const data = readCover(bookId);
    if (!data) {
      sendError(res, 'E_NOT_FOUND', '还没有封面', '可以先生成封面。');
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(data);
    return;
  }
  const body = await readJsonBody(req);
  const bookId = String(body.bookId || '');
  if (!isValidId(bookId)) {
    sendError(res, 'E_BAD_ID', '书 ID 非法', '');
    return;
  }
  const loaded = loadBook(bookId);
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  const svg = coverSvg({
    title: loaded.book.title,
    author: loaded.book.author,
    chapters: loaded.chapters.length,
    chars: loaded.book.chars,
    id: bookId,
  });
  writeCover(bookId, svg);
  sendJson(res, 200, { ok: true, cover: true });
}

async function handleRename(req, res, url) {
  ensureRoot();
  const body = await readJsonBody(req);
  const bookId = String(body.bookId || (url && url.searchParams.get('bookId')) || '');
  if (!isValidId(bookId)) {
    sendError(res, 'E_BAD_ID', '书 ID 非法', '');
    return;
  }
  const book = renameBook(bookId, body.title);
  if (!book) {
    sendError(res, 'E_BAD_NAME', '书名不能为空', '');
    return;
  }
  sendJson(res, 200, { ok: true, book });
}

async function handleDelete(req, res, url) {
  ensureRoot();
  const bookId = requireId(url);
  // 删除书先取消该书所有作业（§6.11）；等它们收口，避免目录被移走后又被作业写回来
  const seriesList = listSeries(bookId);
  let cancelledJob = false;
  for (const series of seriesList) {
    if (cancelSeriesJob(series.id)) cancelledJob = true;
    if (cancelRevoiceJobsForSeries(series.id) > 0) cancelledJob = true;
  }
  for (const series of seriesList) {
    await waitJobIdle(series.id, 1500);
    await waitRevoiceIdle(series.id, 1500);
  }
  if (!trashBook(bookId)) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  sendJson(res, 200, { ok: true, trashed: true, cancelledJob });
}

function handleTrash(req, res) {
  ensureRoot();
  sendJson(res, 200, { ok: true, books: listTrash() });
}

async function handleRestore(req, res) {
  ensureRoot();
  const body = await readJsonBody(req);
  const bookId = String(body.bookId || '');
  if (!isValidId(bookId)) {
    sendError(res, 'E_BAD_ID', '书 ID 非法', '');
    return;
  }
  try {
    const book = restoreBook(bookId);
    sendJson(res, 200, { ok: true, book });
  } catch (err) {
    if (err.code === 'E_BOOK_EXISTS') {
      sendJson(res, 200, { ok: false, code: err.code, message: err.message, bookId: err.bookId || '', title: err.title || '' });
      return;
    }
    sendError(res, err.code || 'E_RESTORE_FAILED', err.message || '恢复失败', '');
  }
}

function handleTrashClear(req, res) {
  ensureRoot();
  const removed = clearTrash();
  sendJson(res, 200, { ok: true, ...removed });
}

function handleStorage(req, res) {
  ensureRoot();
  sendJson(res, 200, { ok: true, ...storageStats() });
}

/* ------------------------------ M2: Part / plan / series ------------------------------ */

function chapterTextsForNumbers(bookId, numbers) {
  const loaded = loadBook(bookId);
  if (!loaded) return null;
  const pages = readJson(path.join(loaded.dir, 'pages.json'), []);
  const wanted = new Set((numbers || []).map(Number));
  const chapters = loaded.chapters.filter((c) => wanted.has(Number(c.n))).map((c) => {
    const text = (Array.isArray(pages) ? pages : [])
      .filter((p) => Number(p.page) >= Number(c.from) && Number(p.page) <= Number(c.to))
      .map((p) => String(p.text || ''))
      .join('\n');
    return { n: Number(c.n), title: String(c.title || ''), from: Number(c.from), to: Number(c.to), chars: Number(c.chars) || text.length, text };
  });
  return { loaded, chapters };
}

function handleParts(req, res, url) {
  ensureRoot();
  const bookId = requireId(url);
  sendJson(res, 200, { ok: true, parts: listParts(bookId) });
}

async function handlePartPost(req, res) {
  ensureRoot();
  const body = await readJsonBody(req);
  try {
    const part = savePart({
      bookId: String(body.bookId || ''),
      chapters: body.chapters,
      title: body.title,
      partId: String(body.partId || ''),
      source: String(body.source || 'manual'),
    });
    sendJson(res, 200, { ok: true, part });
  } catch (err) {
    if (err instanceof PartError) {
      sendJson(res, 200, { ok: false, code: err.code, message: err.message, hint: err.hint, conflicts: err.conflicts || [] });
      return;
    }
    throw err;
  }
}

async function handlePartUpdate(req, res) {
  ensureRoot();
  const body = await readJsonBody(req);
  try {
    const part = updatePart({
      bookId: String(body.bookId || ''),
      partId: String(body.partId || ''),
      title: body.title,
      addChapters: Array.isArray(body.addChapters) ? body.addChapters : [],
      removeChapters: Array.isArray(body.removeChapters) ? body.removeChapters : [],
    });
    sendJson(res, 200, { ok: true, part });
  } catch (err) {
    if (err instanceof PartError) {
      sendJson(res, 200, { ok: false, code: err.code, message: err.message, hint: err.hint, conflicts: err.conflicts || [] });
      return;
    }
    throw err;
  }
}

function handlePartDelete(req, res, url) {
  ensureRoot();
  const bookId = String(url.searchParams.get('bookId') || '');
  const partId = String(url.searchParams.get('partId') || '');
  try {
    deletePart(bookId, partId);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    if (err instanceof PartError) {
      sendError(res, err.code, err.message, err.hint);
      return;
    }
    throw err;
  }
}

async function handlePlanPreview(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req, 8 * 1024 * 1024);
  const bookId = String(body.bookId || '');
  if (!isValidId(bookId)) {
    sendError(res, 'E_BAD_ID', '书 ID 非法', '');
    return;
  }
  let ctxData = null;
  if (body.partId) {
    ctxData = partChapterTexts(bookId, String(body.partId));
    if (!ctxData) {
      sendError(res, 'E_PART_NOT_FOUND', '找不到这个 Part', '');
      return;
    }
  } else {
    ctxData = chapterTextsForNumbers(bookId, Array.isArray(body.chapters) ? body.chapters : []);
  }
  if (!ctxData || !ctxData.chapters.length) {
    sendError(res, 'E_PART_EMPTY', '至少选 1 章', '');
    return;
  }
  const part = ctxData.part || { title: String(body.title || '草稿'), chapters: ctxData.chapters.map((c) => c.n) };
  try {
    const out = await buildPlan({ ctx: options.ctx || null, book: ctxData.loaded.book, dir: ctxData.loaded.dir, part, chapters: ctxData.chapters });
    sendJson(res, 200, {
      ok: true,
      plan: out.plan,
      warnings: out.warnings || [],
      briefsSource: out.briefs ? (out.briefs.fallback ? 'rule' : 'model') : 'none',
      partId: body.partId || null,
    });
  } catch (err) {
    sendError(res, err.code || 'E_PLAN_FAILED', err.message || '讲纲生成失败', err.hint || '');
  }
}

async function handleSeriesCreate(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 8 * 1024 * 1024);
  try {
    const series = createSeries({
      bookId: String(body.bookId || ''),
      partId: String(body.partId || ''),
      title: body.title,
      plan: body.plan || null,
    });
    sendJson(res, 200, { ok: true, seriesId: series.id, status: series.status, series });
  } catch (err) {
    if (err instanceof SeriesError) {
      sendError(res, err.code, err.message, err.hint);
      return;
    }
    throw err;
  }
}

function handleSeriesGet(req, res, url) {
  ensureRoot();
  const seriesId = String(url.searchParams.get('seriesId') || '');
  if (seriesId) {
    const found = findSeries(seriesId);
    if (!found) {
      sendError(res, 'E_NOT_FOUND', '找不到这个系列', '');
      return;
    }
    sendJson(res, 200, { ok: true, series: found.series });
    return;
  }
  const bookId = String(url.searchParams.get('bookId') || '');
  if (!isValidId(bookId)) {
    sendError(res, 'E_BAD_ID', '书 ID 非法', '');
    return;
  }
  sendJson(res, 200, { ok: true, series: listSeries(bookId) });
}

async function handleSeriesPlan(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req, 8 * 1024 * 1024);
  try {
    const out = await savePlan({
      seriesId: String(body.seriesId || ''),
      plan: body.plan || null,
      ctx: options.ctx || null,
      force: body.force === true,
    });
    sendJson(res, 200, { ok: true, series: out.series, plan: out.series, warnings: out.warnings || [] });
  } catch (err) {
    if (err instanceof SeriesError) {
      sendError(res, err.code, err.message, err.hint);
      return;
    }
    sendError(res, err.code || 'E_PLAN_FAILED', err.message || '讲纲保存失败', err.hint || '');
  }
}

function handleBriefsGet(req, res, url) {
  ensureRoot();
  const bookId = requireId(url);
  const loaded = loadBook(bookId);
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  sendJson(res, 200, { ok: true, briefs: readJson(path.join(loaded.dir, 'briefs.json'), null) });
}

/* ------------------------------ M3: 生成 / 作业 / 后验缝 ------------------------------ */

function findSeriesOr404(res, seriesId) {
  const found = findSeries(String(seriesId || ''));
  if (!found) {
    sendError(res, 'E_NOT_FOUND', '找不到这个系列', '刷新列表后再试。');
    return null;
  }
  return found;
}

function requirePlanned(series) {
  if (!series.plan_version || !(series.lectures || []).length) {
    throw Object.assign(new Error('先生成/保存讲纲，再开始生成'), { code: 'E_SERIES_UNPLANNED' });
  }
}

async function handleSeriesStart(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req);
  const found = findSeriesOr404(res, body.seriesId);
  if (!found) return;
  try {
    requirePlanned(found.series);
    const explicit = body.lectures != null && body.lectures !== 'all';
    if (explicit && !Array.isArray(body.lectures)) {
      sendError(res, 'E_REPLAN_RANGE', 'lectures 必须是 all 或讲次数组', '');
      return;
    }
    const nums = explicit ? body.lectures : null;
    const force = explicit ? nums.map(Number) : [];
    const out = startSeriesJob({ found, nums, force, ctx: options.ctx || null });
    sendJson(res, 200, {
      ok: true,
      cached: !!out.cached,
      jobId: out.jobId,
      skipped: out.skipped || [],
      scope: out.scope || null,
    });
  } catch (err) {
    sendError(res, err.code || 'E_GENERATE', err.message || '启动失败', err.hint || '');
  }
}

async function handleSeriesLectureGenerate(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req);
  const found = findSeriesOr404(res, body.seriesId);
  if (!found) return;
  const n = Number(body.n);
  if (!Number.isInteger(n) || n < 1) {
    sendError(res, 'E_REPLAN_RANGE', '讲次不合法', '');
    return;
  }
  if (!(found.series.lectures || []).some((item) => Number(item.n) === n)) {
    sendError(res, 'E_REPLAN_RANGE', '第 ' + n + ' 讲不存在', '');
    return;
  }
  try {
    requirePlanned(found.series);
    const out = startLectureJob({ found, n, force: true, ctx: options.ctx || null });
    sendJson(res, 200, { ok: true, cached: !!out.cached, jobId: out.jobId, skipped: out.skipped || [], scope: out.scope || null });
  } catch (err) {
    sendError(res, err.code || 'E_GENERATE', err.message || '启动失败', err.hint || '');
  }
}

async function handleSeriesResume(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req);
  const found = findSeriesOr404(res, body.seriesId);
  if (!found) return;
  try {
    requirePlanned(found.series);
    const out = resumeSeriesJob({ found, ctx: options.ctx || null });
    sendJson(res, 200, {
      ok: true,
      cached: !!out.cached,
      jobId: out.jobId,
      skipped: out.skipped || [],
      scope: out.scope || null,
    });
  } catch (err) {
    sendError(res, err.code || 'E_GENERATE', err.message || '续跑失败', err.hint || '');
  }
}

async function handleSeriesRetry(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req);
  const found = findSeriesOr404(res, body.seriesId);
  if (!found) return;
  const raw = body.lecture == null ? [] : Array.isArray(body.lecture) ? body.lecture : [body.lecture];
  const nums = raw.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (nums.length !== raw.length) {
    sendError(res, 'E_REPLAN_RANGE', '讲次不合法', '');
    return;
  }
  const all = (found.series.lectures || []).map((item) => Number(item.n));
  for (const n of nums) {
    if (!all.includes(n)) {
      sendError(res, 'E_REPLAN_RANGE', '第 ' + n + ' 讲不存在', '');
      return;
    }
  }
  try {
    requirePlanned(found.series);
    const out = startSeriesJob({ found, nums: nums.length ? nums : null, force: [], ctx: options.ctx || null });
    sendJson(res, 200, {
      ok: true,
      cached: !!out.cached,
      jobId: out.jobId,
      skipped: out.skipped || [],
      scope: out.scope || null,
    });
  } catch (err) {
    sendError(res, err.code || 'E_GENERATE', err.message || '重试失败', err.hint || '');
  }
}

function handleSeriesJob(req, res, url) {
  ensureRoot();
  const seriesId = String(url.searchParams.get('seriesId') || '');
  const found = findSeriesOr404(res, seriesId);
  if (!found) return;
  const state = getSeriesJob(seriesId);
  if (state) {
    sendJson(res, 200, state);
    return;
  }
  sendJson(res, 200, {
    ok: true,
    jobId: null,
    seriesId,
    stage: 'done',
    lecture: 0,
    lecturesTotal: (found.series.lectures || []).length,
    current: 0,
    total: 0,
    message: '',
    status: String(found.series.status || 'planned'),
    skipped: [],
    scope: [],
    error: found.series.code ? { code: found.series.code, message: found.series.error || '' } : null,
  });
}

async function handleSeriesCancel(req, res) {
  ensureRoot();
  const body = await readJsonBody(req);
  const found = findSeriesOr404(res, body.seriesId);
  if (!found) return;
  const cancelled = cancelSeriesJob(found.series.id);
  sendJson(res, 200, { ok: true, cancelled });
}

function handleLectureGet(req, res, url) {
  ensureRoot();
  const found = findSeriesOr404(res, url.searchParams.get('seriesId'));
  if (!found) return;
  const n = Number(url.searchParams.get('n'));
  if (!Number.isInteger(n) || n < 1) {
    sendError(res, 'E_REPLAN_RANGE', '讲次不合法', '');
    return;
  }
  const doc = loadLecture(found.dir, n);
  if (!doc.exists) {
    sendError(res, 'E_NOT_FOUND', '这一讲还没有生成内容', '');
    return;
  }
  sendJson(res, 200, { ok: true, lecture: doc.lecture, slides: doc.slidesDoc });
}

function handleSeriesStitchGet(req, res, url) {
  ensureRoot();
  const found = findSeriesOr404(res, url.searchParams.get('seriesId'));
  if (!found) return;
  const report = buildStitchReport(found);
  writeStitchReport(found, report, { persist: false });
  if (
    ['ready', 'partial', 'failed', 'cancelled', 'interrupted'].includes(String(found.series.status)) &&
    found.series.stitch !== report.state
  ) {
    found.series.stitch = report.state;
    persistSeries(found.series);
  }
  sendJson(res, 200, { ok: true, stitch: report });
}

async function handleSeriesStitchRepair(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req);
  const found = findSeriesOr404(res, body.seriesId);
  if (!found) return;
  const running = getSeriesJob(found.series.id);
  if (running && ['queued', 'drafting', 'stitching', 'structuring', 'validate', 'anchor', 'cancelling'].includes(String(running.status))) {
    sendError(res, 'E_SERIES_BUSY', '正在生成，请稍候', '等作业结束后再修后验缝。');
    return;
  }
  try {
    const targets = Array.isArray(body.targets) ? body.targets.map(String) : null;
    const out = await repairStitch({ found, ctx: options.ctx || null, targets });
    sendJson(res, 200, { ok: true, stitch: out.report, repaired: out.repaired, unresolved: out.unresolved });
  } catch (err) {
    sendError(res, err.code || 'E_STITCH', err.message || '修复失败', err.hint || '');
  }
}

/* ------------------------------ M4: 播放 / 偏好 / 设置 / 语音 ------------------------------ */

/** 通用文件流：带 Range（音频 seek 与断点续传都要）。 */
function streamFile(req, res, file, type) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    sendError(res, 'E_NOT_FOUND', '找不到文件', '');
    return;
  }
  const total = stat.size;
  res.setHeader('content-type', type);
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('cache-control', 'no-store');
  const range = String(req.headers.range || '');
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) {
    res.statusCode = 200;
    res.setHeader('content-length', String(total));
    fs.createReadStream(file).pipe(res);
    return;
  }
  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);
  if (start === null && end !== null) {
    start = Math.max(0, total - end);
    end = total - 1;
  }
  if (start === null) start = 0;
  if (end === null || end >= total) end = total - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    res.statusCode = 416;
    res.setHeader('content-range', 'bytes */' + total);
    res.end();
    return;
  }
  res.statusCode = 206;
  res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + total);
  res.setHeader('content-length', String(end - start + 1));
  fs.createReadStream(file, { start, end }).pipe(res);
}

function handlePreferenceGet(req, res) {
  ensureRoot();
  sendJson(res, 200, { ok: true, preference: readPreference() });
}

async function handlePreferencePost(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  const preference = writePreference(body && body.preference && typeof body.preference === 'object' ? body.preference : body);
  sendJson(res, 200, { ok: true, preference });
}

function handleSeriesProgressGet(req, res, url) {
  ensureRoot();
  const found = findSeriesOr404(res, url.searchParams.get('seriesId'));
  if (!found) return;
  const progress = progressSummary(found.series, readProgress(found.dir, found.series));
  sendJson(res, 200, { ok: true, progress });
}

async function handleSeriesProgressPost(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  const found = findSeriesOr404(res, body.seriesId);
  if (!found) return;
  try {
    const out = saveProgress({
      series: found.series,
      dir: found.dir,
      lecture: Number(body.lecture) || 1,
      slide: Number(body.slide) || 0,
    });
    sendJson(res, 200, { ok: true, progress: out.summary });
  } catch (err) {
    sendError(res, err.code || 'E_PROGRESS', err.message || '进度没存下来', err.hint || '');
  }
}

function handleVoiceGet(req, res) {
  ensureRoot();
  sendJson(res, 200, Object.assign({ ok: true }, voicePayload()));
}

async function handleVoicePost(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  try {
    saveVoice(body && body.voice && typeof body.voice === 'object' ? body.voice : body);
    sendJson(res, 200, Object.assign({ ok: true }, voicePayload()));
  } catch (err) {
    sendError(res, 'E_VOICE_SAVE', '语音配置没存下来', String((err && err.message) || err).slice(0, 200));
  }
}

async function handleVoiceProbe(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  const result = await probeVoiceConfig(body && body.text);
  if (!result.ok) {
    sendError(res, result.code || 'E_TTS_UNCONFIGURED', result.error || '语音不可用', result.hint || '');
    return;
  }
  if (result.audio && Buffer.isBuffer(result.audio)) {
    res.statusCode = 200;
    res.setHeader('content-type', result.contentType || 'audio/wav');
    res.setHeader('content-length', String(result.audio.length));
    res.setHeader('cache-control', 'no-store');
    res.end(result.audio);
    return;
  }
  sendJson(res, 200, Object.assign({ ok: true }, result));
}

async function handleRevoice(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  try {
    const out = startRevoiceJob({
      seriesId: String(body.seriesId || ''),
      lecture: body.lecture == null || body.lecture === 'all' ? null : Number(body.lecture),
      force: body.force === true,
      options: options || {},
    });
    sendJson(res, 200, { ok: true, jobId: out.jobId, scope: out.job.scope });
  } catch (err) {
    if (err && err.code) recordError(err.code, err.message);
    sendError(res, err.code || 'E_TTS_FAIL', err.message || '配音没启动', err.hint || '');
  }
}

function handleRevoiceJob(req, res, url) {
  ensureRoot();
  const job = getRevoiceJob(url.searchParams.get('jobId'));
  if (!job) {
    sendError(res, 'E_NOT_FOUND', '找不到这个配音作业', '作业可能已完成并过期。');
    return;
  }
  sendJson(res, 200, job);
}

async function handleRevoiceCancel(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  const cancelled = cancelRevoiceJob(body.jobId);
  sendJson(res, 200, { ok: true, cancelled });
}

function handleAudio(req, res, url) {
  ensureRoot();
  const found = findSeriesOr404(res, url.searchParams.get('seriesId'));
  if (!found) return;
  const lecture = Number(url.searchParams.get('lecture'));
  const index = Number(url.searchParams.get('i'));
  const hit = findAudioFile(found.dir, lecture, index);
  if (!hit) {
    sendError(res, 'E_NOT_FOUND', '这一页还没有音频', '先生成语音，或在播放器里用浏览器朗读。');
    return;
  }
  streamFile(req, res, hit.file, hit.type);
}

function handleSettings(req, res, options) {
  ensureRoot();
  sendJson(res, 200, Object.assign({ ok: true }, settingsPayload(options.ctx || null)));
}

function handleDiagnostics(req, res) {
  ensureRoot();
  sendJson(res, 200, Object.assign({ ok: true }, diagnosticsPayload()));
}

function handleBackups(req, res) {
  ensureRoot();
  sendJson(res, 200, { ok: true, backups: listBackups(), parent: path.dirname(ROOT) });
}

async function handleBackupDelete(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  try {
    const out = deleteBackup(body.name);
    sendJson(res, 200, { ok: true, ...out, backups: listBackups() });
  } catch (err) {
    sendError(res, err.code || 'E_BACKUP', err.message || '删不掉这个备份', '');
  }
}

async function handleBackupOpen(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  try {
    const out = openBackup(body.name);
    sendJson(res, 200, { ok: true, ...out });
  } catch (err) {
    sendError(res, err.code || 'E_BACKUP', err.message || '打不开这个备份', '');
  }
}

/** 等系列作业收口后再删目录（最多 3 秒），避免作业把删掉的目录又写回来。 */
async function waitJobIdle(seriesId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (isSeriesJobActive(seriesId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitRevoiceIdle(seriesId, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (isRevoiceJobActive(seriesId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function handleSeriesDelete(req, res, url) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  const seriesId = String(body.seriesId || (url && url.searchParams.get('seriesId')) || '');
  const found = findSeriesOr404(res, seriesId);
  if (!found) return;
  const cancelledJob = cancelSeriesJob(found.series.id);
  cancelRevoiceJobsForSeries(found.series.id);
  if (cancelledJob) await waitJobIdle(found.series.id);
  try {
    deleteSeries(found.series.id);
    sendJson(res, 200, { ok: true, seriesId: found.series.id, cancelledJob });
  } catch (err) {
    sendError(res, err.code || 'E_DELETE', err.message || '删不掉这个系列', '');
  }
}

export async function routeM1(req, res, url, options = {}) {
  try {
    return await routeM1Inner(req, res, url, options);
  } catch (err) {
    const code = err && err.code ? err.code : 'E_INTERNAL';
    recordError(code, (err && err.message) || '内部错误');
    if (!res.headersSent) {
      sendError(res, code, (err && err.message) || '内部错误', (err && err.hint) || '');
    } else {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    return true;
  }
}

async function routeM1Inner(req, res, url, options = {}) {
  const pathname = url.pathname;
  if (pathname === PREFIX + '/parts') {
    handleParts(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/part') {
    if (req.method === 'POST') {
      await handlePartPost(req, res);
      return true;
    }
    if (req.method === 'DELETE') {
      handlePartDelete(req, res, url);
      return true;
    }
    sendError(res, 'E_METHOD', '不支持的方法', '');
    return true;
  }
  if (pathname === PREFIX + '/part/update') {
    await handlePartUpdate(req, res);
    return true;
  }
  if (pathname === PREFIX + '/plan/preview') {
    await handlePlanPreview(req, res, options);
    return true;
  }
  if (pathname === PREFIX + '/series') {
    if (req.method === 'POST') {
      await handleSeriesCreate(req, res);
      return true;
    }
    if (req.method === 'GET') {
      handleSeriesGet(req, res, url);
      return true;
    }
    if (req.method === 'DELETE') {
      await handleSeriesDelete(req, res, url);
      return true;
    }
    sendError(res, 'E_METHOD', '不支持的方法', '');
    return true;
  }
  if (pathname === PREFIX + '/series/progress') {
    if (req.method === 'GET') {
      handleSeriesProgressGet(req, res, url);
      return true;
    }
    if (req.method === 'POST') {
      await handleSeriesProgressPost(req, res);
      return true;
    }
    sendError(res, 'E_METHOD', '不支持的方法', '');
    return true;
  }
  if (pathname === PREFIX + '/series/plan') {
    await handleSeriesPlan(req, res, options);
    return true;
  }
  if (pathname === PREFIX + '/series/start') {
    await handleSeriesStart(req, res, options);
    return true;
  }
  if (pathname === PREFIX + '/series/lecture/generate') {
    await handleSeriesLectureGenerate(req, res, options);
    return true;
  }
  if (pathname === PREFIX + '/series/resume') {
    await handleSeriesResume(req, res, options);
    return true;
  }
  if (pathname === PREFIX + '/series/retry') {
    await handleSeriesRetry(req, res, options);
    return true;
  }
  if (pathname === PREFIX + '/series/job') {
    handleSeriesJob(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/series/cancel') {
    await handleSeriesCancel(req, res);
    return true;
  }
  if (pathname === PREFIX + '/series/stitch') {
    handleSeriesStitchGet(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/series/stitch/repair') {
    await handleSeriesStitchRepair(req, res, options);
    return true;
  }
  if (pathname === PREFIX + '/lecture') {
    handleLectureGet(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/briefs') {
    handleBriefsGet(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/preference') {
    if (req.method === 'GET') {
      handlePreferenceGet(req, res);
      return true;
    }
    if (req.method === 'POST') {
      await handlePreferencePost(req, res);
      return true;
    }
    sendError(res, 'E_METHOD', '不支持的方法', '');
    return true;
  }
  if (pathname === PREFIX + '/voice') {
    if (req.method === 'GET') {
      handleVoiceGet(req, res);
      return true;
    }
    if (req.method === 'POST') {
      await handleVoicePost(req, res);
      return true;
    }
    sendError(res, 'E_METHOD', '不支持的方法', '');
    return true;
  }
  if (pathname === PREFIX + '/voice/probe') {
    await handleVoiceProbe(req, res);
    return true;
  }
  if (pathname === PREFIX + '/revoice') {
    await handleRevoice(req, res, options);
    return true;
  }
  if (pathname === PREFIX + '/revoice/job') {
    handleRevoiceJob(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/revoice/cancel') {
    await handleRevoiceCancel(req, res);
    return true;
  }
  if (pathname === PREFIX + '/audio') {
    handleAudio(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/settings') {
    handleSettings(req, res, options);
    return true;
  }
  if (pathname === PREFIX + '/diagnostics') {
    handleDiagnostics(req, res);
    return true;
  }
  if (pathname === PREFIX + '/backups') {
    handleBackups(req, res);
    return true;
  }
  if (pathname === PREFIX + '/backups/delete') {
    await handleBackupDelete(req, res);
    return true;
  }
  if (pathname === PREFIX + '/backups/open') {
    await handleBackupOpen(req, res);
    return true;
  }
  if (pathname === PREFIX + '/meta') {
    handleMeta(req, res);
    return true;
  }
  if (pathname === PREFIX + '/books') {
    handleBooks(req, res);
    return true;
  }
  if (pathname === PREFIX + '/book') {
    if (req.method === 'GET') {
      handleBook(req, res, url);
      return true;
    }
    if (req.method === 'DELETE') {
      await handleDelete(req, res, url);
      return true;
    }
    if (req.method === 'PATCH') {
      await handleRename(req, res, url);
      return true;
    }
    sendError(res, 'E_METHOD', '不支持的方法', '');
    return true;
  }
  if (pathname === PREFIX + '/import') {
    if (req.method !== 'POST') {
      sendError(res, 'E_METHOD', '不支持的方法', '');
      return true;
    }
    await handleImport(req, res);
    return true;
  }
  if (pathname === PREFIX + '/chapters/build') {
    await handleBuildChapters(req, res, options.ctx);
    return true;
  }
  if (pathname === PREFIX + '/chapters') {
    if (req.method === 'GET') {
      handleChaptersGet(req, res, url);
      return true;
    }
    if (req.method === 'POST') {
      await handleChaptersPost(req, res);
      return true;
    }
    sendError(res, 'E_METHOD', '不支持的方法', '');
    return true;
  }
  if (pathname === PREFIX + '/cover') {
    await handleCover(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/rename') {
    await handleRename(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/trash') {
    handleTrash(req, res);
    return true;
  }
  if (pathname === PREFIX + '/trash/restore') {
    await handleRestore(req, res);
    return true;
  }
  if (pathname === PREFIX + '/trash/clear') {
    handleTrashClear(req, res);
    return true;
  }
  if (pathname === PREFIX + '/storage') {
    handleStorage(req, res);
    return true;
  }
  if (pathname === PREFIX + '/file') {
    const bookId = String(url.searchParams.get('bookId') || '');
    if (!isValidId(bookId)) {
      sendError(res, 'E_BAD_ID', '书 ID 非法', '');
      return true;
    }
    const dir = existingBookDir(bookId);
    if (!dir) {
      sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
      return true;
    }
    rangeResponse(req, res, path.join(dir, 'source.pdf'));
    return true;
  }
  return false;
}
