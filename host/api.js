/**
 * 2.0 HTTP API：meta / 书架 / 导入 / 分章 / 封面 / 回收站，
 * 以及 Part、讲纲、系列生成、作业与后验缝。路由前缀仍是 /dsh-book-slides。
 */
import fs from 'node:fs';
import path from 'node:path';

import { PdfError, PDF_ERROR, extractPages, guessTitle, totalChars } from '../lib/pdfread.js';
import { coverSvg, hueOf } from '../lib/cover.js';
import { suggestTocRange, tocTextOf } from '../lib/tocparse.js';
import { ROOT, ensureRoot, getMeta, packageVersion, PRODUCT_VERSION, readJson, writeJson } from './root.js';
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
  writeBookmark,
  writeCover,
} from './books.js';
import { BookmarkError, ChapterError, buildBookChapters, refreshBookmarkTree, saveBookChapters } from './chapters.js';
import {
  PartError,
  chapterTexts,
  deletePart,
  listParts,
  partChapterTexts,
  savePart,
  updatePart,
} from './parts.js';
import {
  SeriesError,
  createSeries,
  deleteSeries,
  findSeries,
  listSeries,
  patchSeriesLecture,
  persistSeries,
  savePlan,
  seriesDir,
} from './series.js';
import { buildPlan } from './plan.js';
import { readBriefs } from './briefs.js';
import { readMustKeepAliasConfig, readMustKeepAliases, resetMustKeepAliases, writeMustKeepAliases } from './aliases.js';
import { applyQualityReview, QualityReviewError, qualityDigest, reviewLectureQuality } from './quality-review.js';
import { resolveModel } from './llm.js';
import {
  billingForLlm,
  clearUsageJobs,
  listUsageJobs,
  readJob as readUsageJob,
  readPrices,
  readUsageConfig,
  runUsageJob,
  usageSummary,
  writePrices,
} from './usage.js';
import { estimateUsage } from './usage-estimate.js';
import {
  auditSections,
  cancelSeriesJob,
  getSeriesJob,
  isSeriesJobActive,
  resumeSeriesJob,
  startLectureJob,
  startSeriesJob,
} from './generate.js';
import { buildStitchReport, repairStitch, writeStitchReport } from './stitch.js';
import { loadLecture, seriesChapterTexts, writeLectureOutputs } from './lectures.js';
import { readPreference, writePreference } from './prefs.js';
import { progressSummary, readProgress, saveProgress } from './progress.js';
import { readView, saveView } from './view.js';
import {
  activeRevoiceJob,
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
import {
  addRefVoice,
  probeComfyTts,
  saveRefTable,
  saveWorkflow as saveTtsWorkflow,
  refTablePayload,
  workflowPayload,
  TTS_REF_AUDIO_MAX_BYTES,
} from './comfy-clone.js';
import {
  cancelPracticeJob,
  cancelPracticeJobsForBook,
  cancelPracticeJobsForSeries,
  explainQuestion,
  finishSessionById,
  flagQuestion,
  getPracticeJob,
  getRunningSession,
  practiceSummary,
  reviewSession,
  startPracticeBankJob,
  startSession,
  submitAnswer,
} from './practice.js';
import {
  cancelImageJobsForBook,
  cancelImageJobsForSeries,
  getImageStatus,
  imageFile,
  imagePayload,
  probeImage,
  saveImageConfig,
  saveImageWorkflow,
  startImageJob,
  testImage,
} from './images.js';
import { buildPptx, buildPptxBatch, contentDisposition, planPptx, PptxError } from './pptx.js';
import {
  activeImportJob,
  cancelImportJob,
  exportSize,
  getImportJob,
  isImportJobActive,
  normalizePolicy,
  packageFileName,
  planExport,
  startImportPackageJob,
  writeExportStream,
} from './package.js';
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
    product_version: PRODUCT_VERSION,
    schema: 2,
    legacy: false,
    notice: meta.upgraded_from ? '旧数据已备份到 ' + (meta.upgraded_to || meta.upgraded_from) : '',
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
  const range =
    body.range && typeof body.range === 'object'
      ? { from: Number(body.range.from) || 0, to: Number(body.range.to) || 0 }
      : null;
  const outlineDepthValue = Number(body.outlineDepth);
  const outlineDepth =
    Number.isInteger(outlineDepthValue) && outlineDepthValue >= 0 ? outlineDepthValue : null;
  try {
    const usage = await runUsageJob(
      {
        kind: 'other',
        phase: 'toc',
        billing: usageBillingFor(ctx || null),
        book: usageBook(String(body.bookId)),
        scope: { mode: String(body.mode || 'auto') },
      },
      () =>
        buildBookChapters(String(body.bookId), String(body.mode || 'auto'), {
          force: body.force === true,
          ctx: ctx || null,
          range,
          outlineDepth,
        }),
    );
    sendJson(res, 200, { ok: true, ...usage.result, usageJobId: usage.recorded ? usage.usageJobId : null });
  } catch (err) {
    if (err instanceof ChapterError) sendError(res, err.code, err.message, err.hint);
    else sendError(res, 'E_CHAPTER_FAILED', '分章失败', String((err && err.message) || err).slice(0, 200));
  }
}

async function handleBookOutlineRefresh(req, res) {
  ensureRoot();
  if (String(req.method || 'GET').toUpperCase() !== 'POST') {
    sendError(res, 'E_METHOD', '不支持的方法', '用 POST 刷新书签。');
    return;
  }
  let body = {};
  let xml = '';
  const contentType = String((req.headers && req.headers['content-type']) || '');
  try {
    if (/^multipart\/form-data/i.test(contentType)) {
      const buffer = await readBody(req, 16 * 1024 * 1024);
      const form = await new Response(buffer, { headers: { 'content-type': contentType } }).formData();
      body.bookId = String(form.get('bookId') || '');
      body.source = String(form.get('source') || 'xml');
      body.outlineDepth = form.get('outlineDepth');
      const file = form.get('outline') || form.get('xml');
      if (file && typeof file !== 'string' && typeof file.arrayBuffer === 'function') {
        xml = Buffer.from(await file.arrayBuffer()).toString('utf8');
      } else if (file && typeof file === 'string') {
        xml = file;
      }
    } else {
      body = await readJsonBody(req, 16 * 1024 * 1024);
      xml = String(body.xml || '');
    }
  } catch (err) {
    sendError(res, 'E_BOOKMARK_PARSE', '读取书签失败', String((err && err.message) || err).slice(0, 160));
    return;
  }
  if (!isValidId(String(body.bookId || ''))) {
    sendError(res, 'E_BAD_ID', '书 ID 非法', '');
    return;
  }
  const loaded = loadBook(String(body.bookId || ''));
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  const pages = readJson(path.join(loaded.dir, 'pages.json'), []);
  if (!Array.isArray(pages) || !pages.length) {
    sendError(res, 'E_NO_PAGES', '这本书没有逐页文本', '重新导入后再试。');
    return;
  }
  const outlineDepthValue = Number(body.outlineDepth);
  const outlineDepth =
    Number.isInteger(outlineDepthValue) && outlineDepthValue >= 0 ? outlineDepthValue : null;
  const source = String(body.source || 'pdf').toLowerCase();
  try {
    const before = JSON.stringify({
      tree: loaded.book.bookmarkTree || null,
      rootDepth: loaded.book.bookmarkRootDepth == null ? null : loaded.book.bookmarkRootDepth,
    });
    const result = await refreshBookmarkTree(loaded, pages, { source, xml, outlineDepth });
    const after = JSON.stringify({ tree: result.tree, rootDepth: result.rootDepth });
    const changed = before !== after;
    const book = writeBookmark(loaded.book.id, result.tree, result.rootDepth, source);
    sendJson(res, 200, {
      ok: true,
      source: result.source,
      bookmarkTree: result.tree,
      bookmarkRootDepth: result.rootDepth,
      rootCount: result.rootCount,
      outline: result.outline,
      changed,
      warnings: [],
      book,
    });
  } catch (err) {
    if (err instanceof BookmarkError) sendError(res, err.code, err.message, err.hint);
    else sendError(res, 'E_BOOKMARK_IO', '书签刷新失败', String((err && err.message) || err).slice(0, 200));
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

/** 目录页码范围：重新进入详情页时恢复上次填写值。 */
function handleTocGet(req, res, url) {
  ensureRoot();
  const loaded = loadBook(String(url.searchParams.get('bookId') || ''));
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  const pages = readJson(path.join(loaded.dir, 'pages.json'), []);
  const toc = readJson(path.join(loaded.dir, 'toc.json'), null);
  sendJson(res, 200, {
    ok: true,
    total: Array.isArray(pages) ? pages.length : 0,
    suggested: suggestTocRange(Array.isArray(pages) ? pages : []),
    range: toc && toc.range ? toc.range : null,
    toc: toc || null,
  });
}

async function handleTocRange(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  const loaded = loadBook(String(body.bookId || ''));
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  const pages = readJson(path.join(loaded.dir, 'pages.json'), []);
  const total = Array.isArray(pages) ? pages.length : 0;
  const from = Math.round(Number(body.from) || 0);
  const to = Math.round(Number(body.to) || 0);
  if (!(from >= 1 && to >= from && to <= total && to - from <= 40)) {
    sendError(res, 'E_BAD_RANGE', '目录页码范围不合法', '范围要在 1–' + total + ' 之间，且不超过 40 页。');
    return;
  }
  const tocFile = path.join(loaded.dir, 'toc.json');
  const toc = readJson(tocFile, {}) || {};
  toc.range = { from, to };
  if (!toc.status) toc.status = 'draft';
  toc.rangeUpdatedAt = new Date().toISOString();
  writeJson(tocFile, toc);
  sendJson(res, 200, { ok: true, range: toc.range });
}

/** 目录页原文预览：让用户确认自己选对页了（1.x 的「看这几页」）。 */
async function handleTocPreview(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  const loaded = loadBook(String(body.bookId || ''));
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  const pages = readJson(path.join(loaded.dir, 'pages.json'), []);
  const total = Array.isArray(pages) ? pages.length : 0;
  const from = Math.round(Number(body.from) || 0);
  const to = Math.round(Number(body.to) || 0);
  if (!(from >= 1 && to >= from && to <= total && to - from <= 40)) {
    sendError(res, 'E_BAD_RANGE', '目录页码范围不合法', '范围要在 1–' + total + ' 之间，且不超过 40 页。');
    return;
  }
  const toc = tocTextOf(Array.isArray(pages) ? pages : [], from, to);
  sendJson(res, 200, {
    ok: true,
    chars: toc.chars,
    truncated: toc.truncated,
    preview: String(toc.text || '').slice(0, 800),
  });
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
  const title = String(loaded.book.title || '未命名');
  const svg = coverSvg({
    title: title,
    author: loaded.book.author,
    chapters: loaded.chapters.length,
    chars: loaded.book.chars,
    id: bookId,
  });
  writeCover(bookId, svg, {
    title: title,
    author: loaded.book.author,
    chapters: loaded.chapters.length,
    hue: hueOf(title),
  });
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
    if (cancelPracticeJobsForSeries(series.id) > 0) cancelledJob = true;
    if (cancelImageJobsForSeries(series.id)) cancelledJob = true;
  }
  if (cancelPracticeJobsForBook(bookId) > 0) cancelledJob = true;
  if (cancelImageJobsForBook(bookId) > 0) cancelledJob = true;
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
    const usage = await runUsageJob(
      {
        kind: 'lecture',
        phase: 'plan',
        billing: usageBillingFor(options.ctx || null),
        book: usageBook(bookId),
        series: { id: String(body.seriesId || ''), title: String(part.title || '') },
        scope: { chapters: ctxData.chapters.map((c) => c.n) },
      },
      () => buildPlan({ ctx: options.ctx || null, book: ctxData.loaded.book, dir: ctxData.loaded.dir, part, chapters: ctxData.chapters }),
    );
    const out = usage.result;
    sendJson(res, 200, {
      ok: true,
      plan: out.plan,
      warnings: out.warnings || [],
      briefsSource: out.briefs ? (out.briefs.fallback ? 'rule' : out.briefs.degraded ? 'mixed' : 'model') : 'none',
      partId: body.partId || null,
      usageJobId: usage.recorded ? usage.usageJobId : null,
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

function withQualitySummaries(series, dir) {
  const list = Array.isArray(series && series.lectures) ? series.lectures : [];
  const mapped = list.map((lecture) => {
      const summary = lecture && lecture.quality_summary ? lecture.quality_summary : null;
      if (summary) {
        const pages = Number(lecture.pages) || 0;
        const planned = Number(lecture.planned_pages) || Number(summary.planned_pages) || pages;
        const actual = Number(lecture.actual_pages) || Number(summary.actual_pages) || 0;
        const stale = pages > 0 && planned > 0 && actual > 0 && pages !== planned;
        return Object.assign({}, lecture, {
          planned_pages: planned,
          actual_pages: actual,
          plan_pages_stale: stale,
          quality_summary: Object.assign({}, summary, { planned_pages: planned, actual_pages: actual, plan_pages_stale: stale }),
        });
      }
      const doc = loadLecture(dir, lecture.n);
      const quality = (doc && doc.lecture && doc.lecture.quality)
        || (doc && doc.slidesDoc && doc.slidesDoc.quality)
        || null;
      if (!quality) return lecture;
      const pages = Number(lecture.pages) || 0;
      const planned = Number(quality.planned_pages) || pages;
      const actual = Number(quality.actual_pages) || pages;
      const stale = pages > 0 && planned > 0 && actual > 0 && pages !== planned;
      return Object.assign({}, lecture, {
        planned_pages: planned,
        actual_pages: actual,
        plan_pages_stale: stale,
        quality_summary: {
          content_ok: quality.content_ok === true,
          density_ok: quality.density_ok === true,
          over_budget: quality.over_budget === true,
          planned_pages: planned,
          actual_pages: actual,
          plan_pages_stale: stale,
        },
      });
  });
  const plannedTotal = mapped.reduce(
    (sum, lecture) => sum + (Number(lecture.planned_pages) || Number(lecture.pages) || 0),
    0,
  );
  const actualTotal = mapped.reduce(
    (sum, lecture) => sum + (Number(lecture.actual_pages) || Number(lecture.pages) || 0),
    0,
  );
  return Object.assign({}, series, {
    lectures: mapped,
    planned_total_pages: Number(series.planned_total_pages) || plannedTotal,
    // total_pages 以实际页数为准；旧系列可能停在计划值，不能用它压过 actual。
    total_pages: actualTotal || Number(series.total_pages) || 0,
  });
}

async function handleLectureQualityRecheck(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  const found = findSeries(String(body.seriesId || ''));
  if (!found) {
    sendError(res, 'E_NOT_FOUND', '找不到这个系列', '');
    return;
  }
  const n = Number(body.n);
  const planLecture = (found.series.lectures || []).find((item) => Number(item.n) === n);
  if (!planLecture) {
    sendError(res, 'E_NOT_FOUND', '找不到这一讲', '');
    return;
  }
  const doc = loadLecture(found.dir, n);
  if (!doc || !doc.slidesDoc || !Array.isArray(doc.slidesDoc.slides)) {
    sendError(res, 'E_LECTURE_EMPTY', '这一讲还没有生成内容', '先生成讲义再做质量核对。');
    return;
  }
  const loaded = loadBook(found.series.book_id);
  const chapters = (loaded && loaded.chapters ? loaded.chapters : []).filter((chapter) =>
    (found.series.chapters || []).includes(Number(chapter.n)),
  );
  const maxPage = chapters.length
    ? Math.max(...chapters.map((chapter) => Number(chapter.to) || 1))
    : doc.slidesDoc.slides.length;
  const previous = doc.slidesDoc.quality || doc.lecture.quality || {};
  const quality = auditSections(doc.slidesDoc.slides, planLecture, maxPage);
  quality.repair = previous.repair || {};
  if (previous.review) {
    const stale = previous.review.stale === true
      || !previous.review.audit_digest
      || previous.review.audit_digest !== qualityDigest(quality);
    quality.review = Object.assign({}, previous.review, {
      stale,
      stale_reason: stale ? '机检结果已刷新，AI 审阅基于旧快照；建议重新 AI 审阅。' : '',
    });
  }
  quality.rechecked_at = new Date().toISOString();
  doc.slidesDoc.quality = quality;
  doc.lecture.quality = quality;
  writeLectureOutputs(found.dir, n, doc.lecture, doc.slidesDoc);
  patchSeriesLecture(found.series, n, {
    quality_summary: {
      content_ok: quality.content_ok === true,
      density_ok: quality.density_ok === true,
      over_budget: quality.over_budget === true,
      planned_pages: Number(quality.planned_pages) || 0,
      actual_pages: Number(quality.actual_pages) || 0,
    },
  });
  persistSeries(found.series);
  sendJson(res, 200, { ok: true, quality, series: found.series });
}

async function handleLectureQualityAiReview(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  const found = findSeries(String(body.seriesId || ''));
  if (!found) {
    sendError(res, 'E_NOT_FOUND', '找不到这个系列', '');
    return;
  }
  const n = Number(body.n);
  const planLecture = (found.series.lectures || []).find((item) => Number(item.n) === n);
  if (!planLecture) {
    sendError(res, 'E_NOT_FOUND', '找不到这一讲', '');
    return;
  }
  const doc = loadLecture(found.dir, n);
  if (!doc || !doc.slidesDoc || !Array.isArray(doc.slidesDoc.slides)) {
    sendError(res, 'E_LECTURE_EMPTY', '这一讲还没有生成内容', '先生成讲义再做 AI 审阅。');
    return;
  }
  const texts = seriesChapterTexts(found.series.book_id, found.series);
  if (!texts) {
    sendError(res, 'E_REVIEW_FAILED', '读不到这本书的原文', '检查书是否已删除或数据是否完整。');
    return;
  }
  try {
    const review = await reviewLectureQuality({
      ctx: options.ctx || null,
      book: texts.loaded && texts.loaded.book,
      lecture: planLecture,
      slides: doc.slidesDoc.slides,
      quality: doc.slidesDoc.quality || doc.lecture.quality || {},
      pages: texts.pages,
      aliases: readMustKeepAliases(),
    });
    const applied = applyQualityReview(doc, review);
    writeLectureOutputs(found.dir, n, applied.lecture, applied.slidesDoc);
    sendJson(res, 200, { ok: true, review, quality: applied.slidesDoc.quality });
  } catch (err) {
    const code = err instanceof QualityReviewError ? err.code : 'E_REVIEW_FAILED';
    sendError(res, code, err.message || 'AI 审阅失败', err.hint || '');
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
    sendJson(res, 200, { ok: true, series: withQualitySummaries(found.series, found.dir) });
    return;
  }
  const bookId = String(url.searchParams.get('bookId') || '');
  if (!isValidId(bookId)) {
    sendError(res, 'E_BAD_ID', '书 ID 非法', '');
    return;
  }
  sendJson(res, 200, {
    ok: true,
    series: listSeries(bookId).map((series) => withQualitySummaries(series, seriesDir(bookId, series.id))),
  });
}

async function handleSeriesPlan(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req, 8 * 1024 * 1024);
  try {
    const found = findSeries(String(body.seriesId || ''));
    const usage = await runUsageJob(
      {
        kind: 'lecture',
        phase: 'plan',
        billing: usageBillingFor(options.ctx || null),
        book: usageBook(found ? found.series.book_id : ''),
        series: { id: String(body.seriesId || ''), title: String((found && found.series.title) || '') },
        scope: { chapters: (found && found.series.chapters) || [] },
      },
      () =>
        savePlan({
          seriesId: String(body.seriesId || ''),
          plan: body.plan || null,
          ctx: options.ctx || null,
          force: body.force === true,
        }),
    );
    const out = usage.result;
    sendJson(res, 200, {
      ok: true,
      series: out.series,
      plan: out.series,
      warnings: out.warnings || [],
      usageJobId: usage.recorded ? usage.usageJobId : null,
    });
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
  // 落盘文件可人工改，但展示前必须过 sections 原文校验；坏条目回退并给出 warnings。
  const checked = readBriefs(loaded.dir, chapterTexts(bookId) || []);
  sendJson(res, 200, { ok: true, briefs: checked.stored, warnings: checked.warnings, rejected: checked.rejected });
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

/** 用量账本：按 DSH 默认 provider 判本地/云端；取不到模型时按云端（宁可多算）。 */
function usageBillingFor(ctx) {
  try {
    return billingForLlm(resolveModel(ctx).provider);
  } catch {
    return 'cloud';
  }
}

function usageBook(bookId) {
  const loaded = loadBook(String(bookId || ''));
  return {
    id: String(bookId || ''),
    title: String((loaded && loaded.book && loaded.book.title) || ''),
  };
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

function handleMustKeepAliasesGet(req, res) {
  ensureRoot();
  sendJson(res, 200, { ok: true, ...readMustKeepAliasConfig() });
}

async function handleMustKeepAliasesPost(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 256 * 1024);
  try {
    const out = body && body.reset === true
      ? resetMustKeepAliases()
      : writeMustKeepAliases(body && body.aliases ? body.aliases : body);
    sendJson(res, 200, { ok: true, ...out });
  } catch (err) {
    sendError(res, 'E_ALIAS_INVALID', '别名表不合法', String((err && err.message) || err).slice(0, 200));
  }
}

function handleSeriesProgressGet(req, res, url) {
  ensureRoot();
  const found = findSeriesOr404(res, url.searchParams.get('seriesId'));
  if (!found) return;
  const progress = progressSummary(found.series, readProgress(found.dir, found.series));
  sendJson(res, 200, { ok: true, progress });
}

/** FR-18.2：该系列的播放布局；没有 view.json 时返回默认值且不落盘。 */
function handleSeriesViewGet(req, res, url) {
  ensureRoot();
  const found = findSeriesOr404(res, url.searchParams.get('seriesId'));
  if (!found) return;
  sendJson(res, 200, { ok: true, view: readView(found.dir, found.series) });
}

async function handleSeriesViewPost(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  const found = findSeriesOr404(res, body.seriesId);
  if (!found) return;
  try {
    const view = saveView({
      series: found.series,
      dir: found.dir,
      layout: body.layout,
      split: body.split,
    });
    sendJson(res, 200, { ok: true, view });
  } catch (err) {
    sendError(res, err.code || 'E_VIEW', err.message || '布局没存下来', err.hint || '');
  }
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
      offsetMs: body.offsetMs !== undefined ? body.offsetMs : body.offset_ms,
      audioFile: body.audioFile !== undefined ? body.audioFile : body.audio_file,
      audioMs: body.audioMs !== undefined ? body.audioMs : body.audio_ms,
      audioProvider: body.audioProvider !== undefined ? body.audioProvider : body.audio_provider,
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

async function handleVoiceProbe(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  const usage = await runUsageJob(
    { kind: 'other', phase: 'probe', billing: 'cloud', scope: {} },
    () =>
      probeVoiceConfig(body && body.text, {
        fetchImpl: options && options.voiceFetch,
        speaker: (body && (body.comfyRefVoice || body.comfyVoice || body.speaker)) || '',
        refVoice: (body && (body.comfyRefVoice || body.comfyVoice)) || '',
        voice: (body && body.voice) || '',
      }),
  );
  const result = usage.result;
  if (!result.ok) {
    sendError(res, result.code || 'E_TTS_UNCONFIGURED', result.error || '语音不可用', result.hint || '');
    return;
  }
  if (result.audio && Buffer.isBuffer(result.audio)) {
    res.statusCode = 200;
    res.setHeader('content-type', result.contentType || 'audio/wav');
    res.setHeader('content-length', String(result.audio.length));
    res.setHeader('cache-control', 'no-store');
    if (result.audio_ms) res.setHeader('x-tts-ms', String(Math.round(result.audio_ms)));
    if (result.voice) res.setHeader('x-tts-voice', String(result.voice));
    if (result.voiceLabel) res.setHeader('x-tts-voice-label', String(result.voiceLabel));
    if (result.model) res.setHeader('x-tts-model', String(result.model));
    res.end(result.audio);
    return;
  }
  sendJson(res, 200, Object.assign({ ok: true }, result));
}

async function handleVoiceWorkflow(req, res) {
  ensureRoot();
  if (req.method === 'GET') {
    try {
      sendJson(res, 200, { ok: true, workflow: workflowPayload() });
    } catch (err) {
      sendError(res, (err && err.code) || 'E_TTS_WORKFLOW', String((err && err.message) || err), (err && err.hint) || '');
    }
    return;
  }
  const body = await readJsonBody(req, 2 * 1024 * 1024);
  try {
    const workflow = saveTtsWorkflow(body);
    sendJson(res, 200, { ok: true, workflow: workflow });
  } catch (err) {
    sendJson(res, 200, {
      ok: false,
      code: (err && err.code) || 'E_TTS_WORKFLOW',
      error: String((err && err.message) || err),
      hint: (err && err.hint) || '',
      candidates: (err && err.candidates) || [],
    });
  }
}

async function handleVoiceRefVoices(req, res) {
  ensureRoot();
  if (req.method === 'GET') {
    try {
      sendJson(res, 200, { ok: true, table: refTablePayload() });
    } catch (err) {
      sendError(res, (err && err.code) || 'E_TTS_VOICE_REF', String((err && err.message) || err), (err && err.hint) || '');
    }
    return;
  }
  const body = await readJsonBody(req, 512 * 1024);
  try {
    const table = saveRefTable(body);
    sendJson(res, 200, { ok: true, table: table });
  } catch (err) {
    sendJson(res, 200, {
      ok: false,
      code: (err && err.code) || 'E_TTS_VOICE_REF',
      error: String((err && err.message) || err),
      hint: (err && err.hint) || '',
    });
  }
}

async function handleVoiceRefVoiceImport(req, res) {
  ensureRoot();
  if (String((req && req.method) || 'GET').toUpperCase() !== 'POST') {
    sendError(res, 'E_METHOD', '不支持的方法', '用 POST 上传参考音频和 .txt。');
    return;
  }
  const contentType = String((req.headers && req.headers['content-type']) || '');
  if (!/^multipart\/form-data/i.test(contentType)) {
    sendError(res, 'E_TTS_VOICE_REF', '导入参考 voice 需要同时上传参考音频和 .txt', '在设置页点「导入参考 voice」，一次选择参考音频和它的逐字转写。');
    return;
  }
  let form = null;
  try {
    const buffer = await readBody(req, TTS_REF_AUDIO_MAX_BYTES + 2 * 1024 * 1024);
    form = await new Response(buffer, { headers: { 'content-type': contentType } }).formData();
  } catch (err) {
    sendError(res, 'E_TTS_VOICE_REF', '读取参考音频失败：' + String((err && err.message) || err), '参考音频不超过 32MB，且需要同时选择 .txt。');
    return;
  }
  const audio = form.get('audio');
  if (!audio || typeof audio === 'string' || typeof audio.arrayBuffer !== 'function') {
    sendError(res, 'E_TTS_VOICE_REF', '没有收到参考音频', '一次选择参考音频和它的 .txt。');
    return;
  }
  try {
    const out = addRefVoice({
      audioBuffer: Buffer.from(await audio.arrayBuffer()),
      audioName: String(audio.name || ''),
      refText: String(form.get('ref_text') || ''),
      name: String(form.get('name') || ''),
    });
    sendJson(res, 200, { ok: true, table: out.table, entry: out.entry });
  } catch (err) {
    sendError(res, (err && err.code) || 'E_TTS_VOICE_REF', String((err && err.message) || err), (err && err.hint) || '');
  }
}

async function handleVoiceComfyProbe(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req, 4 * 1024);
  try {
    const out = await probeComfyTts({
      fetchImpl: options && options.voiceFetch,
      comfyRefVoice: String((body && body.comfyRefVoice) || ''),
    });
    sendJson(res, 200, Object.assign({ ok: true }, out));
  } catch (err) {
    sendError(res, (err && err.code) || 'E_TTS_CONNECT', String((err && err.message) || err), (err && err.hint) || '');
  }
}

async function handleRevoice(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  try {
    const out = startRevoiceJob({
      seriesId: String(body.seriesId || ''),
      lecture: body.lecture == null || body.lecture === 'all' ? null : Number(body.lecture),
      force: body.force === true,
      missingOnly: body.missingOnly === true,
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
  const jobId = url.searchParams.get('jobId');
  const seriesId = url.searchParams.get('seriesId');
  if (!jobId && seriesId) {
    const active = activeRevoiceJob(seriesId);
    if (!active) {
      sendJson(res, 200, { ok: true, jobId: null, seriesId: String(seriesId), status: 'none' });
      return;
    }
    sendJson(res, 200, getRevoiceJob(active.id));
    return;
  }
  const job = getRevoiceJob(jobId);
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

function handlePages(req, res, url) {
  ensureRoot();
  const bookId = requireId(url);
  const loaded = loadBook(bookId);
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  const pages = readJson(path.join(loaded.dir, 'pages.json'), []);
  sendJson(res, 200, { ok: true, pages: Array.isArray(pages) ? pages : [] });
}

function handleSettings(req, res, options) {
  ensureRoot();
  sendJson(res, 200, Object.assign({ ok: true }, settingsPayload(options.ctx || null)));
}

/* ------------------------------ FR-27 用量与费用 ------------------------------ */

function handleUsageSummary(req, res, url) {
  ensureRoot();
  const out = usageSummary({
    from: url.searchParams.get('from') || '',
    to: url.searchParams.get('to') || '',
    bookId: url.searchParams.get('bookId') || '',
    seriesId: url.searchParams.get('seriesId') || '',
  });
  sendJson(res, 200, Object.assign({ ok: true }, out));
}

function handleUsageJobs(req, res, url) {
  ensureRoot();
  const out = listUsageJobs({
    kind: url.searchParams.get('kind') || '',
    from: url.searchParams.get('from') || '',
    to: url.searchParams.get('to') || '',
    bookId: url.searchParams.get('bookId') || '',
    seriesId: url.searchParams.get('seriesId') || '',
    limit: url.searchParams.get('limit') || undefined,
    offset: url.searchParams.get('offset') || undefined,
  });
  sendJson(res, 200, Object.assign({ ok: true }, out));
}

function handleUsageJob(req, res, url) {
  ensureRoot();
  const job = readUsageJob(url.searchParams.get('jobId') || '');
  if (!job) {
    sendError(res, 'E_USAGE_NOT_FOUND', '找不到这条用量记录', '刷新历史后再试。');
    return;
  }
  sendJson(res, 200, { ok: true, job });
}

async function handleUsageEstimate(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  try {
    const estimate = estimateUsage(Object.assign({}, body && typeof body === 'object' ? body : {}, { ctx: options.ctx || null }));
    sendJson(res, 200, { ok: true, estimate });
  } catch (err) {
    sendError(res, err.code || 'E_USAGE_ESTIMATE', String((err && err.message) || err), err.hint || '');
  }
}

async function handleUsagePrices(req, res) {
  ensureRoot();
  if (req.method === 'GET') {
    const prices = readPrices();
    sendJson(res, 200, { ok: true, prices, localProviders: readUsageConfig().localProviders });
    return;
  }
  const body = await readJsonBody(req, 512 * 1024);
  try {
    const prices = writePrices(body && typeof body === 'object' ? body : {});
    sendJson(res, 200, { ok: true, prices, localProviders: readUsageConfig().localProviders });
  } catch (err) {
    sendError(res, err.code || 'E_USAGE_PRICE', String((err && err.message) || err), err.hint || '');
  }
}

function handleUsageClear(req, res) {
  ensureRoot();
  sendJson(res, 200, { ok: true, removed: clearUsageJobs() });
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

/* ------------------------------ M5: 练习 / 配图 / 导出 / 书档 ------------------------------ */

function practiceError(res, err) {
  if (err && err.code === 'E_BANK_CACHED') {
    sendJson(res, 200, { ok: true, cached: true, code: err.code, message: err.message, hint: err.hint || '' });
    return;
  }
  if (err && err.code && String(err.code).startsWith('E_')) {
    sendError(res, err.code, err.message || '练习操作失败', err.hint || '');
    return;
  }
  sendError(res, 'E_PRACTICE', '练习操作失败', String((err && err.message) || err).slice(0, 200));
}

async function handlePracticeBank(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req, 256 * 1024);
  try {
    const job = startPracticeBankJob({
      seriesId: String(body.seriesId || ''),
      chapters: Array.isArray(body.chapters) ? body.chapters : null,
      topup: body.topup === true,
      rounds: body.rounds,
      ctx: options.ctx || null,
    });
    sendJson(res, 200, job);
  } catch (err) {
    practiceError(res, err);
  }
}

function handlePracticeJob(req, res, url) {
  ensureRoot();
  const job = getPracticeJob(url.searchParams.get('jobId'));
  if (!job) {
    sendError(res, 'E_NOT_FOUND', '找不到这个题库作业', '作业可能已完成并过期。');
    return;
  }
  sendJson(res, 200, job);
}

async function handlePracticeCancel(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  sendJson(res, 200, { ok: true, cancelled: cancelPracticeJob(body.jobId) });
}

function handlePracticeSummary(req, res, url) {
  ensureRoot();
  try {
    sendJson(res, 200, Object.assign({ ok: true }, practiceSummary(url.searchParams.get('seriesId'))));
  } catch (err) {
    practiceError(res, err);
  }
}

function handlePracticeSessionGet(req, res, url) {
  ensureRoot();
  try {
    const out = getRunningSession(url.searchParams.get('seriesId'));
    if (!out) {
      sendJson(res, 200, { ok: false, code: 'E_NO_SESSION', message: '当前没有可继续的练习', hint: '开始一场新练习。' });
      return;
    }
    sendJson(res, 200, Object.assign({ ok: true }, out));
  } catch (err) {
    practiceError(res, err);
  }
}

async function handlePracticeSessionPost(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  try {
    const out = startSession({
      seriesId: String(body.seriesId || ''),
      mode: String(body.mode || 'mixed'),
      count: body.count,
      chapters: Array.isArray(body.chapters) ? body.chapters : null,
    });
    sendJson(res, 200, Object.assign({ ok: true }, out));
  } catch (err) {
    practiceError(res, err);
  }
}

async function handlePracticeAnswer(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  try {
    const out = submitAnswer({
      seriesId: String(body.seriesId || ''),
      sessionId: String(body.sessionId || ''),
      qid: String(body.qid || ''),
      picked: Array.isArray(body.picked) ? body.picked : [],
    });
    sendJson(res, 200, Object.assign({ ok: true }, out));
  } catch (err) {
    practiceError(res, err);
  }
}

async function handlePracticeExplain(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  try {
    const usage = await runUsageJob(
      {
        kind: 'other',
        phase: 'practice',
        billing: usageBillingFor(options.ctx || null),
        series: { id: String(body.seriesId || ''), title: '' },
        scope: { qid: String(body.qid || '') },
      },
      () =>
        explainQuestion({
          seriesId: String(body.seriesId || ''),
          qid: String(body.qid || ''),
          picked: Array.isArray(body.picked) ? body.picked : [],
          ctx: options.ctx || null,
          options: { timeoutMs: Number(body.timeoutMs) || undefined },
        }),
    );
    const out = usage.result;
    sendJson(res, 200, Object.assign({ ok: true, usageJobId: usage.recorded ? usage.usageJobId : null }, out));
  } catch (err) {
    practiceError(res, err);
  }
}

async function handlePracticeFinish(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  try {
    const summary = finishSessionById({ seriesId: String(body.seriesId || ''), sessionId: String(body.sessionId || '') });
    sendJson(res, 200, { ok: true, summary });
  } catch (err) {
    practiceError(res, err);
  }
}

async function handlePracticeFlag(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  try {
    sendJson(res, 200, Object.assign({ ok: true }, flagQuestion({
      seriesId: String(body.seriesId || ''),
      qid: String(body.qid || ''),
      flagged: body.flagged !== false,
    })));
  } catch (err) {
    practiceError(res, err);
  }
}

async function handlePracticeReview(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  try {
    sendJson(res, 200, Object.assign({ ok: true }, reviewSession({ seriesId: String(body.seriesId || '') })));
  } catch (err) {
    practiceError(res, err);
  }
}

/* 配图 ---------------------------------------------------------------- */

async function handleImageConfig(req, res) {
  ensureRoot();
  if (req.method === 'GET') {
    sendJson(res, 200, Object.assign({ ok: true }, imagePayload()));
    return;
  }
  const body = await readJsonBody(req, 256 * 1024);
  try {
    sendJson(res, 200, Object.assign({ ok: true }, saveImageConfig(body && body.image && typeof body.image === 'object' ? body.image : body)));
  } catch (err) {
    sendError(res, err.code || 'E_IMG_CONFIG', '配图配置没存下来', String((err && err.message) || err).slice(0, 200));
  }
}

async function handleImageWorkflow(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 2 * 1024 * 1024);
  try {
    sendJson(res, 200, Object.assign({ ok: true }, saveImageWorkflow(body)));
  } catch (err) {
    sendJson(res, 200, {
      ok: false,
      code: (err && err.code) || 'E_IMG_WORKFLOW',
      error: String((err && err.message) || err),
      hint: (err && err.hint) || '',
      candidates: (err && err.candidates) || [],
    });
  }
}

async function handleImageProbe(req, res, options) {
  ensureRoot();
  try {
    const out = await probeImage({ fetchImpl: options.imageFetch });
    sendJson(res, 200, Object.assign({ ok: true }, out));
  } catch (err) {
    sendError(res, (err && err.code) || 'E_IMG_CONNECT', String((err && err.message) || err), (err && err.hint) || '');
  }
}

async function handleImageTest(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req, 16 * 1024);
  try {
    const out = await testImage({ prompt: body && body.prompt, options: { fetchImpl: options.imageFetch } });
    res.statusCode = 200;
    res.setHeader('content-type', 'image/png');
    res.setHeader('content-length', String(out.buffer.length));
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-image-seed', String(out.seed));
    res.setHeader('x-image-node', String(out.promptNode));
    res.end(out.buffer);
  } catch (err) {
    sendError(res, (err && err.code) || 'E_IMG_FAIL', String((err && err.message) || err), (err && err.hint) || '');
  }
}

function handleImageStatus(req, res, url) {
  ensureRoot();
  try {
    sendJson(res, 200, getImageStatus(url.searchParams.get('seriesId')));
  } catch (err) {
    sendError(res, (err && err.code) || 'E_NOT_FOUND', String((err && err.message) || err), (err && err.hint) || '');
  }
}

async function handleImageRegen(req, res, options) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  try {
    const job = startImageJob({
      seriesId: String(body.seriesId || ''),
      lecture: body.lecture == null || body.lecture === 'all' ? null : Number(body.lecture),
      slide: body.slide == null ? null : Number(body.slide),
      force: body.force === true,
      reset: body.reset === true,
      options: { fetchImpl: options.imageFetch },
    });
    sendJson(res, 200, job);
  } catch (err) {
    sendError(res, (err && err.code) || 'E_IMG_FAIL', String((err && err.message) || err), (err && err.hint) || '');
  }
}

async function handleImageCancel(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  const cancelled = cancelImageJobsForSeries(String(body.seriesId || ''));
  sendJson(res, 200, { ok: true, cancelled, status: cancelled ? 'cancelling' : 'none' });
}

function handleImageFile(req, res, url) {
  ensureRoot();
  const found = findSeriesOr404(res, url.searchParams.get('seriesId'));
  if (!found) return;
  const lecture = Number(url.searchParams.get('lecture'));
  const index = Number(url.searchParams.get('i'));
  const file = imageFile(found.dir, lecture, index);
  if (!file) {
    sendError(res, 'E_NOT_FOUND', '这一页还没有配图', '到设置里切到 ComfyUI 并生成配图。');
    return;
  }
  const stat = fs.statSync(file);
  res.statusCode = 200;
  res.setHeader('content-type', 'image/png');
  res.setHeader('content-length', String(stat.size));
  res.setHeader('cache-control', 'no-store');
  fs.createReadStream(file).pipe(res);
}

/* PPT 导出 ------------------------------------------------------------ */

function flagOf(url, key) {
  const raw = url.searchParams.get(key);
  if (raw == null || raw === '') return true;
  return raw !== '0' && raw !== 'false';
}

function pptxOptions(url) {
  return {
    includeAudio: flagOf(url, 'audio'),
    includeImages: flagOf(url, 'images'),
    includeNotes: flagOf(url, 'notes'),
  };
}

function pptxError(res, err) {
  if (err instanceof PptxError) {
    sendError(res, err.code, err.message, err.hint);
    return;
  }
  sendError(res, (err && err.code) || 'E_PPT_FAIL', String((err && err.message) || err), (err && err.hint) || '');
}

function handlePptxPlan(req, res, url) {
  ensureRoot();
  const seriesId = String(url.searchParams.get('seriesId') || '');
  const lecture = url.searchParams.get('lecture') || 'all';
  try {
    const plan = planPptx(Object.assign({ seriesId, lecture: lecture === 'all' ? 'all' : Number(lecture) }, pptxOptions(url)));
    sendJson(res, 200, { ok: true, plan });
  } catch (err) {
    pptxError(res, err);
  }
}

async function handlePptxExport(req, res, url) {
  ensureRoot();
  const seriesId = String(url.searchParams.get('seriesId') || '');
  const lecture = url.searchParams.get('lecture') || 'all';
  try {
    const out = await buildPptx(Object.assign({ seriesId, lecture: lecture === 'all' ? 'all' : Number(lecture) }, pptxOptions(url)));
    res.statusCode = 200;
    res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('content-length', String(out.buffer.length));
    res.setHeader('content-disposition', contentDisposition(out.plan.fileName));
    res.setHeader('cache-control', 'no-store');
    res.end(out.buffer);
  } catch (err) {
    pptxError(res, err);
  }
}

async function handlePptxBatch(req, res, url) {
  ensureRoot();
  const seriesId = String(url.searchParams.get('seriesId') || '');
  const lectures = url.searchParams.get('lectures') || 'all';
  try {
    const out = await buildPptxBatch(Object.assign({ seriesId, lectures }, pptxOptions(url)));
    const found = findSeries(seriesId);
    const title = String((found && found.series.title) || '精讲').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
    res.statusCode = 200;
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-length', String(out.buffer.length));
    res.setHeader('content-disposition', contentDisposition(title + '-精讲-合集.zip'));
    res.setHeader('cache-control', 'no-store');
    res.end(out.buffer);
  } catch (err) {
    pptxError(res, err);
  }
}

/* 书档 ---------------------------------------------------------------- */

async function handlePackageExport(req, res, url) {
  ensureRoot();
  const q = url.searchParams;
  const bookIds = q.get('bookIds')
    ? q.get('bookIds').split(',')
    : q.get('bookId')
      ? [q.get('bookId')]
      : 'all';
  try {
    const plan = await planExport(bookIds, {
      includeAudio: flagOf(url, 'audio'),
      includeImages: flagOf(url, 'images'),
      includePractice: flagOf(url, 'practice'),
    });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', contentDisposition(packageFileName(plan)));
    res.setHeader('cache-control', 'no-store');
    writeExportStream(res, plan);
  } catch (err) {
    sendError(res, (err && err.code) || 'E_EXPORT_FAILED', String((err && err.message) || err), (err && err.hint) || '');
  }
}

function handlePackageSize(req, res, url) {
  ensureRoot();
  const q = url.searchParams;
  try {
    const out = exportSize({
      bookId: q.get('bookId') || null,
      all: q.get('all') === '1' || q.get('all') === 'true' || !q.get('bookId'),
    });
    sendJson(res, 200, Object.assign({ ok: true }, out));
  } catch (err) {
    sendError(res, (err && err.code) || 'E_EXPORT_FAILED', String((err && err.message) || err), '');
  }
}

/** 书档上传：流式落盘到 .import/，避免 4 GiB 包整份进内存。 */
function saveUpload(req, file, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const out = fs.createWriteStream(file);
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      try {
        out.destroy();
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* ignore */
      }
      reject(err);
    };
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error('书档超过 4 GiB'), { code: 'E_PKG_TOO_LARGE' }));
        req.destroy();
        return;
      }
      out.write(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      out.end(() => resolve({ size }));
    });
    req.on('error', (err) => fail(err));
    out.on('error', (err) => fail(err));
  });
}

async function handleImportPackage(req, res) {
  ensureRoot();
  if (isImportJobActive()) {
    sendError(res, 'E_PKG_BUSY', '已有书档导入正在运行', '等当前导入结束，或先取消。');
    return;
  }
  const staging = path.join(ROOT, '.import');
  fs.mkdirSync(staging, { recursive: true });
  const zipPath = path.join(staging, 'upload-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.zip');
  let fileName = 'package.zip';
  try {
    fileName = decodeURIComponent(String(req.headers['x-file-name'] || 'package.zip'));
  } catch {
    fileName = String(req.headers['x-file-name'] || 'package.zip');
  }
  try {
    await saveUpload(req, zipPath, 4 * 1024 ** 3);
    const policy = normalizePolicy(req.headers['x-package-policy'] || new URL(req.url || '/', 'http://localhost').searchParams.get('policy'));
    const job = startImportPackageJob({ zipPath, policy, fileName });
    sendJson(res, 200, { ok: true, jobId: job.jobId, policy: job.policy, status: job.status });
  } catch (err) {
    try {
      fs.rmSync(zipPath, { force: true });
    } catch {
      /* ignore */
    }
    sendError(res, (err && err.code) || 'E_PKG_FAILED', String((err && err.message) || err).slice(0, 300), '');
  }
}

function handleImportJob(req, res, url) {
  ensureRoot();
  const job = getImportJob(url.searchParams.get('jobId'));
  if (!job) {
    sendError(res, 'E_NOT_FOUND', '找不到这个导入作业', '作业可能已完成并过期。');
    return;
  }
  sendJson(res, 200, job);
}

function handleImportActive(req, res) {
  ensureRoot();
  sendJson(res, 200, { ok: true, job: activeImportJob() });
}

async function handleImportCancel(req, res) {
  ensureRoot();
  const body = await readJsonBody(req, 64 * 1024);
  sendJson(res, 200, { ok: true, cancelled: cancelImportJob(body.jobId) });
}


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
  cancelPracticeJobsForSeries(found.series.id);
  cancelImageJobsForSeries(found.series.id);
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
  if (pathname === PREFIX + '/series/view') {
    if (req.method === 'GET') {
      handleSeriesViewGet(req, res, url);
      return true;
    }
    if (req.method === 'POST') {
      await handleSeriesViewPost(req, res);
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
  if (pathname === PREFIX + '/lecture/quality/recheck') {
    if (req.method === 'POST') {
      await handleLectureQualityRecheck(req, res);
      return true;
    }
    sendError(res, 'E_METHOD', '不支持的方法', '用 POST 重新审计。');
    return true;
  }
  if (pathname === PREFIX + '/lecture/quality/review') {
    if (req.method === 'POST') {
      await handleLectureQualityAiReview(req, res, options);
      return true;
    }
    sendError(res, 'E_METHOD', '不支持的方法', '用 POST 做 AI 审阅。');
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
  if (pathname === PREFIX + '/pages') {
    handlePages(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/settings/must-keep-aliases') {
    if (req.method === 'GET') {
      handleMustKeepAliasesGet(req, res);
      return true;
    }
    if (req.method === 'POST') {
      await handleMustKeepAliasesPost(req, res);
      return true;
    }
    sendError(res, 'E_METHOD', '不支持的方法', '用 GET 读取、POST 保存别名表。');
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
    await handleVoiceProbe(req, res, options);
    return true;
  }
  if (pathname === PREFIX + '/voice/workflow') {
    await handleVoiceWorkflow(req, res);
    return true;
  }
  if (pathname === PREFIX + '/voice/refvoices') {
    await handleVoiceRefVoices(req, res);
    return true;
  }
  if (pathname === PREFIX + '/voice/refvoices/import') {
    await handleVoiceRefVoiceImport(req, res);
    return true;
  }
  if (pathname === PREFIX + '/voice/comfy/probe') {
    await handleVoiceComfyProbe(req, res, options);
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
  /* ------------------------------ M5 路由 ------------------------------ */
  if (pathname === PREFIX + '/practice/bank') {
    await handlePracticeBank(req, res, options);
    return true;
  }  if (pathname === PREFIX + '/practice/job') {
    handlePracticeJob(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/practice/cancel') {
    await handlePracticeCancel(req, res);
    return true;
  }
  if (pathname === PREFIX + '/practice/summary') {
    handlePracticeSummary(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/practice/session') {
    if (req.method === 'GET') {
      handlePracticeSessionGet(req, res, url);
      return true;
    }
    if (req.method === 'POST') {
      await handlePracticeSessionPost(req, res);
      return true;
    }
    sendError(res, 'E_METHOD', '不支持的方法', '');
    return true;
  }
  if (pathname === PREFIX + '/practice/answer') {
    await handlePracticeAnswer(req, res);
    return true;
  }
  if (pathname === PREFIX + '/practice/explain') {
    await handlePracticeExplain(req, res, options);
    return true;
  }
  if (pathname === PREFIX + '/practice/finish') {
    await handlePracticeFinish(req, res);
    return true;
  }
  if (pathname === PREFIX + '/practice/flag') {
    await handlePracticeFlag(req, res);
    return true;
  }
  if (pathname === PREFIX + '/practice/review') {
    await handlePracticeReview(req, res);
    return true;
  }
  if (pathname === PREFIX + '/image') {
    if (req.method === 'GET') {
      handleImageFile(req, res, url);
      return true;
    }
    sendError(res, 'E_METHOD', '不支持的方法', '');
    return true;
  }
  if (pathname === PREFIX + '/image/config') {
    await handleImageConfig(req, res);
    return true;
  }
  if (pathname === PREFIX + '/image/workflow') {
    await handleImageWorkflow(req, res);
    return true;
  }
  if (pathname === PREFIX + '/image/probe') {
    await handleImageProbe(req, res, options);
    return true;
  }
  if (pathname === PREFIX + '/image/test') {
    await handleImageTest(req, res, options);
    return true;
  }
  if (pathname === PREFIX + '/image/status') {
    handleImageStatus(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/image/regen') {
    await handleImageRegen(req, res, options);
    return true;
  }
  if (pathname === PREFIX + '/image/cancel') {
    await handleImageCancel(req, res);
    return true;
  }
  if (pathname === PREFIX + '/export/pptx/plan') {
    handlePptxPlan(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/export/pptx/batch') {
    await handlePptxBatch(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/export/pptx') {
    await handlePptxExport(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/export/size') {
    handlePackageSize(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/export') {
    await handlePackageExport(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/import/package') {
    await handleImportPackage(req, res);
    return true;
  }
  if (pathname === PREFIX + '/import/package/active') {
    handleImportActive(req, res);
    return true;
  }
  if (pathname === PREFIX + '/import/package/job') {
    handleImportJob(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/import/package/cancel') {
    await handleImportCancel(req, res);
    return true;
  }
  if (pathname === PREFIX + '/settings') {
    handleSettings(req, res, options);
    return true;
  }
  if (pathname === PREFIX + '/usage/summary') {
    if (req.method !== 'GET') {
      sendError(res, 'E_METHOD', '不支持的方法', '');
      return true;
    }
    handleUsageSummary(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/usage/jobs') {
    if (req.method === 'DELETE') {
      handleUsageClear(req, res);
      return true;
    }
    if (req.method !== 'GET') {
      sendError(res, 'E_METHOD', '不支持的方法', '');
      return true;
    }
    handleUsageJobs(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/usage/job') {
    if (req.method !== 'GET') {
      sendError(res, 'E_METHOD', '不支持的方法', '');
      return true;
    }
    handleUsageJob(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/usage/estimate') {
    if (req.method !== 'POST') {
      sendError(res, 'E_METHOD', '不支持的方法', '');
      return true;
    }
    await handleUsageEstimate(req, res, options);
    return true;
  }
  if (pathname === PREFIX + '/usage/prices') {
    if (req.method !== 'GET' && req.method !== 'POST') {
      sendError(res, 'E_METHOD', '不支持的方法', '');
      return true;
    }
    await handleUsagePrices(req, res);
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
  if (pathname === PREFIX + '/book/outline/refresh') {
    await handleBookOutlineRefresh(req, res);
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
  if (pathname === PREFIX + '/toc') {
    if (req.method !== 'GET') {
      sendError(res, 'E_METHOD', '不支持的方法', '');
      return true;
    }
    handleTocGet(req, res, url);
    return true;
  }
  if (pathname === PREFIX + '/toc/range') {
    if (req.method !== 'POST') {
      sendError(res, 'E_METHOD', '不支持的方法', '');
      return true;
    }
    await handleTocRange(req, res);
    return true;
  }
  if (pathname === PREFIX + '/toc/preview') {
    if (req.method !== 'POST') {
      sendError(res, 'E_METHOD', '不支持的方法', '');
      return true;
    }
    await handleTocPreview(req, res);
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
