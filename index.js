/**
 * 精讲台 · Host 半体
 *
 * 只做四件事：
 *   1. 收上传的 PDF，读文字层，切章，落盘
 *   2. 把书架/书籍详情喂给面板
 *   3. 改名、软删除
 *   4. 把原件和书封发回去
 *
 * 生成精讲（M3）与播放器（M4）不在这里，本文件的接口只到「一章一章列出来」为止。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  BOOKS_DIR,
  ROOT,
  bookDir,
  clearProgressForBook,
  clearProgressForModule,
  clearTrash,
  dirSize,
  ensureDirs,
  existingBookDir,
  isValidId,
  listBooks,
  loadBook,
  markOpened,
  newId,
  readJson,
  readPreference,
  readProgress,
  renameBook,
  sha256Of,
  trashBook,
  trashStats,
  writeJson,
  writePreference,
  writeProgress,
} from './store.js';
import { PdfError, PDF_ERROR, extractPages, guessTitle, totalChars } from './pdfread.js';
import { buildChapters, cleanPages, summarize } from './text.js';
import {
  TOC_PROMPT_VERSION,
  buildTocMessages,
  calibrate,
  replayToc,
  chaptersFromToc,
  describeEmptyReply,
  parseTocReply,
  suggestTocRange,
  tocTextOf,
  validateEntries,
  verifyChapters,
} from './tocparse.js';
import { coverSvg } from './cover.js';
import { routeM1 } from './v2/api.js';
import { ensureRoot } from './v2/root.js';
import { runBookCheck } from './check.js';
import {
  cancelJob,
  deleteModuleById,
  findModuleByKey,
  findRunningByKey,
  getJobState,
  listModules,
  loadModuleById,
  moduleCacheKey,
  reconcileAllModules,
  startGeneration,
  validateSelection,
} from './generate.js';
import {
  QWEN_MODELS,
  QWEN_VOICES,
  VOICE_PROVIDERS,
  probeVoice,
  publicVoiceConfig,
  readVoiceConfig,
  synthesizeVoicing,
  writeVoiceConfig,
} from './tts.js';
import {
  DEFAULT_POLICY,
  MAX_PACKAGE_BYTES,
  PackageError,
  README_TEXT,
  buildManifest,
  importPackage,
  normalizePolicy,
  packageFileName,
  planExport,
  writeExportStream,
} from './package.js';
import { SLIDES_PROMPT_VERSION, chapterTextOf } from './slides.js';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_TEST_PROMPT,
  IMAGE_PROVIDERS,
  IMAGE_TIMEOUT_MS,
  TEST_PROMPT_MAX,
  generateImage,
  probeComfy,
  publicImageConfig,
  readImageConfig,
  readWorkflowStore,
  resetWorkflow,
  saveWorkflow,
  seedFor,
  validateWorkflow,
  workflowHashOf,
  writeImageConfig,
} from './comfy.js';
import {
  bookHasImagingJob,
  cancelImaging,
  forgetModule,
  getImagingStatus,
  hasActiveImagingJob,
  imageAbsPath,
  reconcileImagingJobs,
  startImaging,
} from './imaging.js';
import { buildPptxPlan, planPptx } from './pptexport.js';
import { loadShellParts, writePptx } from './pptx.js';
import {
  MAX_Q_PER_BOOK,
  PRACTICE_PROMPT_VERSION,
  PracticeError,
  SESSION_DEFAULT_COUNT,
  SESSION_MAX_COUNT,
  SESSION_MODES,
  appendAnswer,
  applyExplanation,
  buildExplainMessages,
  chapterKey,
  clampCount,
  composeSession,
  createSession,
  explainCacheKey,
  findRunningPractice,
  finishSession,
  getPracticeJob,
  latestRunningSession,
  nextMastery,
  planTopUp,
  readBank,
  readExplainCache,
  readMastery,
  readSession,
  startPracticeGeneration,
  summarizeSession,
  writeBank,
  writeExplainCache,
  writeMastery,
  writeSession,
} from './practice.js';

const require = createRequire(import.meta.url);
const PKG = require('./package.json');
export const PLUGIN_VERSION = String((PKG && PKG.version) || '0.1.0');

/**
 * pdf.js 的浏览器产物目录：播放器左窗格要渲染 PDF 视觉版式，客户端动态 import
 * `build/pdf.min.mjs`，worker / cmaps / standard_fonts / wasm 由本插件同源提供。
 * 用 require.resolve 定位依赖，不把第三方文件复制进仓库。
 */
let pdfjsRootCache = null;
function pdfjsRoot() {
  if (pdfjsRootCache !== null) return pdfjsRootCache;
  try {
    pdfjsRootCache = path.dirname(require.resolve('pdfjs-dist/package.json'));
  } catch {
    pdfjsRootCache = '';
  }
  return pdfjsRootCache;
}

export const ROUTE_PREFIX = '/dsh-book-slides';
export const ROUTE_META = ROUTE_PREFIX + '/meta';
export const ROUTE_CHAPTERS_BUILD = ROUTE_PREFIX + '/chapters/build';
export const ROUTE_TRASH = ROUTE_PREFIX + '/trash';
export const ROUTE_TRASH_RESTORE = ROUTE_PREFIX + '/trash/restore';
export const ROUTE_STORAGE = ROUTE_PREFIX + '/storage';
export const ROUTE_BOOKS = ROUTE_PREFIX + '/books';
export const ROUTE_BOOK = ROUTE_PREFIX + '/book';
export const ROUTE_IMPORT = ROUTE_PREFIX + '/import';
export const ROUTE_RENAME = ROUTE_PREFIX + '/rename';
export const ROUTE_DELETE = ROUTE_PREFIX + '/delete';
export const ROUTE_FILE = ROUTE_PREFIX + '/file';
export const ROUTE_COVER = ROUTE_PREFIX + '/cover';
export const ROUTE_REPARSE = ROUTE_PREFIX + '/reparse';
export const ROUTE_CHAPTERS = ROUTE_PREFIX + '/chapters';
export const ROUTE_TOC = ROUTE_PREFIX + '/toc';
export const ROUTE_TOC_PREVIEW = ROUTE_PREFIX + '/toc/preview';
export const ROUTE_TOC_PARSE = ROUTE_PREFIX + '/toc/parse';
export const ROUTE_TOC_RANGE = ROUTE_PREFIX + '/toc/range';
export const ROUTE_GENERATE = ROUTE_PREFIX + '/generate';
export const ROUTE_JOB = ROUTE_PREFIX + '/job';
export const ROUTE_CANCEL = ROUTE_PREFIX + '/cancel';
export const ROUTE_MODULE = ROUTE_PREFIX + '/module';
export const ROUTE_AUDIO = ROUTE_PREFIX + '/audio';
export const ROUTE_VOICE = ROUTE_PREFIX + '/voice';
export const ROUTE_VOICE_PROBE = ROUTE_PREFIX + '/voice/probe';
export const ROUTE_PAGES = ROUTE_PREFIX + '/pages';
export const ROUTE_PROGRESS = ROUTE_PREFIX + '/progress';
export const ROUTE_PREFERENCE = ROUTE_PREFIX + '/preference';
export const ROUTE_TRASH_CLEAR = ROUTE_PREFIX + '/trash/clear';
export const ROUTE_PDFJS_VENDOR = ROUTE_PREFIX + '/vendor/pdfjs';
export const ROUTE_EXPORT = ROUTE_PREFIX + '/export';
export const ROUTE_EXPORT_SIZE = ROUTE_PREFIX + '/export/size';
export const ROUTE_EXPORT_PPTX = ROUTE_PREFIX + '/export/pptx';
export const ROUTE_EXPORT_PPTX_PLAN = ROUTE_PREFIX + '/export/pptx/plan';
export const ROUTE_IMPORT_PACKAGE = ROUTE_PREFIX + '/import/package';
export const ROUTE_REVOICE = ROUTE_PREFIX + '/revoice';
export const ROUTE_IMAGE = ROUTE_PREFIX + '/image';
export const ROUTE_IMAGE_CONFIG = ROUTE_PREFIX + '/image/config';
export const ROUTE_IMAGE_WORKFLOW = ROUTE_PREFIX + '/image/workflow';
export const ROUTE_IMAGE_PROBE = ROUTE_PREFIX + '/image/probe';
export const ROUTE_IMAGE_TEST = ROUTE_PREFIX + '/image/test';
export const ROUTE_IMAGE_STATUS = ROUTE_PREFIX + '/image/status';
export const ROUTE_IMAGE_REGEN = ROUTE_PREFIX + '/image/regen';
export const ROUTE_IMAGE_CANCEL = ROUTE_PREFIX + '/image/cancel';
export const ROUTE_PRACTICE_SUMMARY = ROUTE_PREFIX + '/practice/summary';
export const ROUTE_PRACTICE_GENERATE = ROUTE_PREFIX + '/practice/generate';
export const ROUTE_PRACTICE_JOB = ROUTE_PREFIX + '/practice/job';
export const ROUTE_PRACTICE_SESSION = ROUTE_PREFIX + '/practice/session';
export const ROUTE_PRACTICE_ANSWER = ROUTE_PREFIX + '/practice/answer';
export const ROUTE_PRACTICE_EXPLAIN = ROUTE_PREFIX + '/practice/explain';
export const ROUTE_PRACTICE_FINISH = ROUTE_PREFIX + '/practice/finish';
export const ROUTE_PRACTICE_FLAG = ROUTE_PREFIX + '/practice/flag';
export const ROUTE_PRACTICE_REVIEW = ROUTE_PREFIX + '/practice/review';

/** 一个精讲模块最多几章、多少字。前端 client.js 里有同一组数字。 */
export const MAX_MODULE_CHAPTERS = 5;
export const MAX_MODULE_CHARS = 60000;

/** 上传上限：和书库插件一致，200 MB。 */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/* ------------------------------ 小工具 ------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function sendError(res, code, message, hint) {
  sendJson(res, 200, { ok: false, code: code, error: message, hint: hint || '' });
}

function query(req) {
  try {
    return new URL(String((req && req.url) || '/'), 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function isCrossSite(headers) {
  return String((headers && headers['sec-fetch-site']) || '').toLowerCase() === 'cross-site';
}

/** 读请求体，超限直接断开；用于 JSON 接口。 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体太大'));
        try {
          req.destroy();
        } catch {
          /* 已经断开 */
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(new Error('请求没传完：' + ((err && err.message) || String(err)))));
  });
}

async function readJsonBody(req, limit) {
  const buffer = await readBody(req, limit);
  if (!buffer.length) return {};
  try {
    const value = JSON.parse(buffer.toString('utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/** 书名最多 80 字，去掉控制字符。 */
function cleanTitle(raw) {
  const text = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 80);
}

/* ------------------------------ 导入 ------------------------------ */

/** 同一份文件导过没有：比对 sha256，命中就返回已存在的 id。 */
function findBySha256(hash) {
  let entries = [];
  try {
    entries = fs.readdirSync(BOOKS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
  for (const id of entries) {
    const book = readJson(path.join(BOOKS_DIR, id, 'book.json'), null);
    if (book && book.sha256 === hash) return { id: id, title: String(book.title || '未命名') };
  }
  return null;
}

/**
 * POST /import —— 裸二进制 + x-file-name 头（URL 编码），和书库插件同一套约定。
 * 成功返回 {ok:true, bookId}；失败返回 {ok:false, code, error, hint}，HTTP 一律 200。
 */
async function handleImport(req, res, headers) {
  const rawName = String((headers && headers['x-file-name']) || '');
  let fileName = '';
  try {
    fileName = decodeURIComponent(rawName);
  } catch {
    fileName = rawName;
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

  const hash = sha256Of(buffer);
  const dup = findBySha256(hash);
  if (dup) {
    sendJson(res, 200, { ok: false, code: 'E_DUP_BOOK', error: '这本书已在书架', bookId: dup.id, title: dup.title });
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
  const chars = totalChars(rawPages);
  if (chars < 50) {
    sendError(
      res,
      PDF_ERROR.NO_TEXT,
      '这份 PDF 没有可提取的文字层',
      '可能是扫描件。请先用 OCR 工具处理成带文字层的 PDF 再导入。',
    );
    return;
  }

  // 切章用的是清洗后的文本；pages.json 存的是原始文本，供原文对照
  const cleaned = cleanPages(rawPages);
  const chapters = buildChapters(cleaned);
  const stats = summarize(rawPages, chapters);
  const title = cleanTitle(guessTitle(fileName, rawPages, extracted.title)) || '未命名';

  const id = newId(12);
  const dir = bookDir(id);
  if (!dir) {
    sendError(res, 'E_BAD_ID', '生成书 ID 失败', '');
    return;
  }

  try {
    fs.mkdirSync(path.join(dir, 'modules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'source.pdf'), buffer);
    writeJson(path.join(dir, 'pages.json'), rawPages);
    writeJson(path.join(dir, 'chapters.json'), chapters);
    // book.json 最后写：它存在 = 导入完成
    writeJson(path.join(dir, 'book.json'), {
      schemaVersion: 1,
      id: id,
      title: title,
      author: String(extracted.author || '').slice(0, 80),
      pages: stats.pages,
      chars: stats.chars,
      chapterCount: stats.chapters,
      sha256: hash,
      originalName: fileName,
      importedAt: new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
    });
  } catch (err) {
    // 写一半就失败：把半截目录清掉，别让它出现在书架里
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清不掉就留着，反正没有 book.json，书架看不见 */
    }
    sendError(res, 'E_IMPORT_FAILED', '写入失败', String((err && err.message) || err).slice(0, 200));
    return;
  }

  sendJson(res, 200, { ok: true, bookId: id, title: title, chapters: stats.chapters, pages: stats.pages });
}

/* ------------------------------ 查询 ------------------------------ */

function handleBooks(req, res) {
  ensureDirs();
  sendJson(res, 200, {
    ok: true,
    pluginVersion: PLUGIN_VERSION,
    dataRoot: ROOT,
    books: listBooks(),
  });
}

function handleBook(req, res) {
  const bookId = String(query(req).get('bookId') || '').trim();
  const loaded = loadBook(bookId);
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '书架里可能已经删掉了。');
    return;
  }
  markOpened(bookId);
  const modules = listModules(bookId);
  sendJson(res, 200, {
    ok: true,
    book: loaded.book,
    chapters: loaded.chapters,
    modules: modules,
    imageProvider: readImageConfig().provider,
  });
}

/* ------------------------------ 改与删 ------------------------------ */

/**
 * 重新切章：解析规则改了以后，已经导入的书不用重传 PDF。
 * 只读 pages.json 重算 chapters.json，不重新读 PDF（几秒钟的事）。
 */
async function handleReparse(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const bookId = String(body.bookId || '');
  const loaded = loadBook(bookId);
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  const rawPages = readJson(path.join(loaded.dir, 'pages.json'), []);
  if (!Array.isArray(rawPages) || rawPages.length === 0) {
    sendError(res, 'E_NO_PAGES', '这本书没有存下逐页文本', '删掉重新导入一次。');
    return;
  }
  // 手改过的章节不能被一次「重新解析」无声抹掉
  const manualCount = (Array.isArray(loaded.chapters) ? loaded.chapters : []).filter((c) => c && c.manual).length;
  if (manualCount > 0 && !body.force) {
    sendError(
      res,
      'E_MANUAL_EDITS',
      '这本书有 ' + manualCount + ' 处手动修改',
      '重新解析会覆盖它们；确认要覆盖就带上 force 再来一次。',
    );
    return;
  }
  // 目录切出来的结果比机械切章准，别让一次「重新解析」把它无声盖掉
  const parsedToc = readJson(path.join(loaded.dir, 'toc.json'), null);
  if (parsedToc && parsedToc.status === 'verified' && !body.force) {
    sendError(
      res,
      'E_TOC_EXISTS',
      '当前章节是按目录切出来的（标题命中率 ' + Math.round((Number(parsedToc.hitRate) || 0) * 100) + '%）',
      '按页眉重切会丢掉这个结果；确认要覆盖就带上 force 再来一次。',
    );
    return;
  }
  const chapters = buildChapters(cleanPages(rawPages));
  for (const chapter of chapters) chapter.source = 'mechanical';
  const stats = summarize(rawPages, chapters);
  writeJson(path.join(loaded.dir, 'chapters.json'), chapters);
  const book = loaded.book;
  book.chapterCount = stats.chapters;
  book.chars = stats.chars;
  book.reparsedAt = new Date().toISOString();
  writeJson(path.join(loaded.dir, 'book.json'), book);
  sendJson(res, 200, { ok: true, chapters: chapters, chapterCount: stats.chapters, chars: stats.chars });
}

async function handleRename(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const bookId = String(body.bookId || '');
  const title = cleanTitle(body.title);
  if (!title) {
    sendError(res, 'E_BAD_TITLE', '书名不能为空', '');
    return;
  }
  const book = renameBook(bookId, title);
  if (!book) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  sendJson(res, 200, { ok: true, title: book.title });
}

async function handleDelete(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const bookId = String(body.bookId || '');
  for (const module of listModules(bookId)) {
    forgetModule(module.id);
  }
  if (!trashBook(bookId)) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  // 继续听的位置不能指向已经进回收站的书
  clearProgressForBook(bookId);
  sendJson(res, 200, { ok: true });
}

/* ------------------------------ 章节手动修正 ------------------------------ */

/** 前文（n=0）不进编号；其余按出现顺序重排 1..k。 */
function normalizeChapters(chapters) {
  let k = 0;
  for (const chapter of chapters) {
    if (chapter.front) {
      chapter.n = 0;
      continue;
    }
    k += 1;
    chapter.n = k;
  }
  return chapters;
}

/** 字数按页区间重算，手改过也不许对不上原文。 */
function recomputeChapterChars(pages, chapters) {
  for (const chapter of chapters) {
    let sum = 0;
    for (const page of pages) {
      const no = Number((page && page.page) || 0);
      if (no >= chapter.from && no <= chapter.to) sum += String((page && page.text) || '').length;
    }
    chapter.chars = sum;
  }
  return chapters;
}

/**
 * 章节操作：rename / split / merge / exclude / include。
 * 每个动作都只动结构，不动原文；写完把字数和章数一起刷新。
 */
async function handleChapters(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const bookId = String(body.bookId || '');
  const loaded = loadBook(bookId);
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  const pages = readJson(path.join(loaded.dir, 'pages.json'), []);
  if (!Array.isArray(pages) || pages.length === 0) {
    sendError(res, 'E_NO_PAGES', '这本书没有存下逐页文本', '删掉重新导入一次。');
    return;
  }

  const chapters = (Array.isArray(loaded.chapters) ? loaded.chapters : []).map((c) => Object.assign({}, c));
  const op = String(body.op || '');
  const n = Math.round(Number(body.n) || 0);
  const idx = chapters.findIndex((c) => !c.front && Number(c.n) === n);
  if (idx < 0) {
    sendError(res, 'E_NO_CHAPTER', '没有第 ' + n + ' 章', '先刷新一下。');
    return;
  }
  const chapter = chapters[idx];
  const touched = [chapter];

  if (op === 'rename') {
    const title = cleanTitle(body.title);
    if (!title) {
      sendError(res, 'E_BAD_TITLE', '章节标题不能为空', '');
      return;
    }
    chapter.title = title;
  } else if (op === 'split') {
    const page = Math.round(Number(body.page) || 0);
    if (!(page > Number(chapter.from) && page <= Number(chapter.to))) {
      sendError(res, 'E_BAD_PAGE', '拆分页要落在第 ' + chapter.from + '–' + chapter.to + ' 页之间', '新的一章从这一页开始。');
      return;
    }
    const right = Object.assign({}, chapter, { from: page, to: chapter.to, manual: true });
    chapter.to = page - 1;
    chapters.splice(idx + 1, 0, right);
    touched.push(right);
  } else if (op === 'merge') {
    const next = chapters[idx + 1];
    if (!next || next.front) {
      sendError(res, 'E_NO_NEXT', '后面没有可以合并的章', '');
      return;
    }
    chapter.to = next.to;
    if (chapter.hidden && !next.hidden) chapter.hidden = false;
    chapters.splice(idx + 1, 1);
  } else if (op === 'exclude' || op === 'include') {
    chapter.hidden = op === 'exclude';
  } else {
    sendError(res, 'E_BAD_OP', '不认识的章节操作：' + op, '');
    return;
  }

  for (const c of touched) c.manual = true;
  normalizeChapters(chapters);
  recomputeChapterChars(pages, chapters);

  writeJson(path.join(loaded.dir, 'chapters.json'), chapters);
  const book = loaded.book;
  book.chapterCount = chapters.filter((c) => !c.front).length;
  book.chars = pages.reduce((sum, p) => sum + String((p && p.text) || '').length, 0);
  book.editedAt = new Date().toISOString();
  writeJson(path.join(loaded.dir, 'book.json'), book);

  sendJson(res, 200, { ok: true, chapters: chapters, chapterCount: book.chapterCount });
}

/* ------------------------------ 目录驱动切章 ------------------------------ */

const PROMPT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');
/** 提示词按文件名缓存；开头那段版本说明对模型没用，从「## 角色」切起。 */
const promptCache = new Map();

function loadPromptFile(name) {
  const file = String(name || '');
  if (!file) return '';
  if (promptCache.has(file)) return promptCache.get(file);
  let text = '';
  try {
    const raw = fs.readFileSync(path.join(PROMPT_DIR, file), 'utf8');
    const cut = raw.indexOf('## 角色');
    text = cut >= 0 ? raw.slice(cut) : raw;
  } catch {
    text = '';
  }
  promptCache.set(file, text);
  return text;
}

/**
 * 目录抽取的 token 预算。
 *
 * 思考模型的思考内容也计入 maxTokens。双栏 + OCR 错字的目录会让它反复推演
 * 栏位和页码：实测《导演创作完全手册》第 9 页（47 章）在 4000、8000 预算下
 * 都是「思考用满、正文为空、stop_reason=max_tokens」，前端只能看到
 * 「回复里没有 JSON 对象」。16000 才够读完并输出完整 JSON（约 11k token）。
 * 重试时再翻倍，给更乱的目录留余量；预算不是花费，用不完不会扣。
 */
const TOC_MAX_TOKENS = 16000;
const TOC_RETRY_MAX_TOKENS = 32000;
/** 思考模型的单次调用可能接近一分钟；120s 对 32k 的重试太紧。 */
const TOC_CALL_TIMEOUT_MS = 180000;
/** 生成一批（≤1.2 万字）最多等 180s；超时由作业层翻成 E_LLM_TIMEOUT。测试可用环境变量缩短。 */
const GENERATE_CALL_TIMEOUT_MS =
  Number(process.env.DSH_BOOK_SLIDES_LLM_TIMEOUT_MS) > 0 ? Number(process.env.DSH_BOOK_SLIDES_LLM_TIMEOUT_MS) : 180000;

/** 当前 DSH 默认模型。 */
function resolveModel(ctx) {
  let selection = null;
  try {
    selection = (ctx.get && ctx.get('agentDefaultModel') && ctx.get('agentDefaultModel').currentSelection
      ? ctx.get('agentDefaultModel').currentSelection()
      : null) || null;
  } catch {
    selection = null;
  }
  const provider = String((selection && selection.provider) || '').trim();
  const model = String((selection && selection.model) || '').trim();
  if (!provider || !model) throw new Error('DSH 还没选好模型，先去设置里挑一个再回来');
  return { provider: provider, model: model };
}

/**
 * 调一次模型，把增量拼成整段文本；顺带记下结束原因，供「为什么没 JSON」用。
 *
 * @param {{maxTokens?:number, timeoutMs?:number, signal?:AbortSignal}|number} options
 *   传数字时按 maxTokens 解释，兼容目录解析的老调用。
 */
async function callModel(ctx, system, user, options) {
  const opts = typeof options === 'number' ? { maxTokens: options } : options || {};
  const llm = ctx.get ? ctx.get('llm') : null;
  if (!llm || typeof llm.prepareCall !== 'function') throw new Error('这个 DSH 里没有可用的模型服务');
  const target = resolveModel(ctx);
  const budget = Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : TOC_MAX_TOKENS;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : TOC_CALL_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  // 作业取消与单次超时都要能中断 stream：有调用方信号时合成一个
  const signal =
    opts.signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([opts.signal, timeoutSignal]) : opts.signal || timeoutSignal;
  const prepared = await llm.prepareCall({ provider: target.provider, model: target.model, maxTokens: budget }, signal);
  const messages = [{ role: 'user', content: [{ type: 'text', text: user }] }];
  let text = '';
  let reasoningChars = 0;
  let stopReason = '';
  for await (const chunk of prepared.stream(Object.assign({}, prepared.config, { system: system, messages: messages, signal: signal }))) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
      continue;
    }
    // 思考内容不拼进正文，但要计数：正文为空时靠它区分「想了但没写」和「什么都没说」
    if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      reasoningChars += chunk.text.length;
      continue;
    }
    if (chunk && chunk.type === 'finish' && chunk.reason) {
      stopReason = String(chunk.reason.kind || '');
      if (chunk.reason.kind === 'error') {
        throw new Error('模型报错：' + ((chunk.reason.failure && chunk.reason.failure.message) || '未知原因'));
      }
    }
  }
  return { text: text, model: target.model, provider: target.provider, stopReason: stopReason, reasoningChars: reasoningChars, maxTokens: budget };
}

/** 把章节写回盘，并同步 book.json 的章数与字数。 */
function persistChapters(loaded, pages, chapters) {
  writeJson(path.join(loaded.dir, 'chapters.json'), chapters);
  const book = loaded.book;
  book.chapterCount = chapters.filter((c) => !c.front).length;
  book.chars = pages.reduce((sum, page) => sum + String((page && page.text) || '').length, 0);
  book.editedAt = new Date().toISOString();
  writeJson(path.join(loaded.dir, 'book.json'), book);
}

/** 回退：机械切章，并把失败原因记进 toc.json。 */
function fallbackToMechanical(loaded, pages, info) {
  const chapters = buildChapters(cleanPages(pages));
  for (const chapter of chapters) chapter.source = 'mechanical';
  persistChapters(loaded, pages, chapters);
  const toc = Object.assign({ status: 'failed', at: new Date().toISOString(), promptVersion: TOC_PROMPT_VERSION }, info || {});
  writeJson(path.join(loaded.dir, 'toc.json'), toc);
  return toc;
}

/** GET /toc：已保存的范围 + 已有结果 + 这次的建议范围。 */
function handleTocGet(req, res) {
  const bookId = String(query(req).get('bookId') || '').trim();
  const loaded = loadBook(bookId);
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  const pages = readJson(path.join(loaded.dir, 'pages.json'), []);
  const toc = readJson(path.join(loaded.dir, 'toc.json'), null);
  sendJson(res, 200, {
    ok: true,
    total: pages.length,
    suggested: suggestTocRange(pages),
    // 用户上次填的范围优先于建议值——否则重新进来又被打回猜测结果
    range: toc && toc.range ? toc.range : null,
    toc: toc,
  });
}

/**
 * POST /toc/range：把用户填的目录范围记下来。
 *
 * 之前范围只活在面板的状态里，一退出就退回猜测值；预览也要能凭这个范围重新生成，
 * 所以范围本身必须落盘。这里只写 range，不动已有结果。
 */
async function handleTocRange(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const loaded = loadBook(String(body.bookId || ''));
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  const pages = readJson(path.join(loaded.dir, 'pages.json'), []);
  const total = pages.length;
  const from = Math.round(Number(body.from) || 0);
  const to = Math.round(Number(body.to) || 0);
  if (!(from >= 1 && to >= from && to <= total && to - from <= 40)) {
    sendError(res, 'E_BAD_RANGE', '目录页码范围不合法', '范围要在 1–' + total + ' 之间，且不超过 40 页。');
    return;
  }
  const tocFile = path.join(loaded.dir, 'toc.json');
  const toc = readJson(tocFile, {}) || {};
  toc.range = { from: from, to: to };
  if (!toc.status) toc.status = 'draft';
  toc.rangeUpdatedAt = new Date().toISOString();
  writeJson(tocFile, toc);
  sendJson(res, 200, { ok: true, range: toc.range });
}

/** POST /toc/preview：取目录原文前 800 字，让用户确认自己选对页了。 */
async function handleTocPreview(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const loaded = loadBook(String(body.bookId || ''));
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  const pages = readJson(path.join(loaded.dir, 'pages.json'), []);
  const total = pages.length;
  const from = Math.round(Number(body.from) || 0);
  const to = Math.round(Number(body.to) || 0);
  if (!(from >= 1 && to >= from && to <= total)) {
    sendError(res, 'E_BAD_RANGE', '页码范围不合法', '这本书一共 ' + total + ' 页。');
    return;
  }
  const toc = tocTextOf(pages, from, to);
  sendJson(res, 200, { ok: true, chars: toc.chars, truncated: toc.truncated, preview: toc.text.slice(0, 800) });
}

/** POST /toc/parse：读目录 → 模型抽取 → 校准 → 落盘（失败回退机械切章）。 */
async function handleTocParse(req, res, ctx) {
  const body = await readJsonBody(req, 64 * 1024);
  const loaded = loadBook(String(body.bookId || ''));
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  const pages = readJson(path.join(loaded.dir, 'pages.json'), []);
  if (!Array.isArray(pages) || pages.length === 0) {
    sendError(res, 'E_NO_PAGES', '这本书没有存下逐页文本', '删掉重新导入一次。');
    return;
  }
  const total = pages.length;
  const from = Math.round(Number(body.from) || 0);
  const to = Math.round(Number(body.to) || 0);
  if (!(from >= 1 && to >= from && to <= total && to - from <= 40)) {
    sendError(res, 'E_BAD_RANGE', '目录页码范围不合法', '范围要在 1–' + total + ' 之间，且不超过 40 页。');
    return;
  }
  const manualCount = (Array.isArray(loaded.chapters) ? loaded.chapters : []).filter((c) => c && c.manual).length;
  if (manualCount > 0 && !body.force) {
    sendError(res, 'E_MANUAL_EDITS', '这本书有 ' + manualCount + ' 处手动修改', '按目录重切会覆盖它们；确认就带 force 再来一次。');
    return;
  }

  const tocFile = path.join(loaded.dir, 'toc.json');
  // 缓存键只认「书 + 范围 + 提示词版本」：读缓存不该要求现在还配着模型，
  // 也不该因为校准算法改了就重花一次模型调用——重放会按 printed 重新校准，
  // 存下来的 physical 只是缓存，不是权威。
  const cacheKey = sha256Of(Buffer.from([loaded.book.sha256 || '', from, to, TOC_PROMPT_VERSION].join('|'), 'utf8'));
  const cached = readJson(tocFile, null);
  if (!body.force && cached && cached.cacheKey === cacheKey && cached.status !== 'failed' && Array.isArray(cached.entries)) {
    // 关键 1：不读 chapters.json —— 它可能已经被「重新解析」换成机械结果了。
    // 关键 2：不直接用 entries 里的 physical —— 那是算法算出来的，算法一改就该重算，
    //         否则老结果会一直沿用（Go 那本书第 5 章停在 73，正确答案是 91）。
    const replay = replayToc(pages, cached);
    const again = replay ? replay.chapters : null;
    if (again) {
      const hit = verifyChapters(pages, again);
      persistChapters(loaded, pages, again);
      cached.entries = replay.calibrated.entries;
      cached.offset = replay.calibrated.offset;
      cached.offsetShare = replay.calibrated.offsetShare;
      cached.hitRate = hit;
      writeJson(tocFile, cached);
      sendJson(res, 200, {
        ok: true,
        cached: true,
        status: cached.status,
        offset: cached.offset,
        hitRate: hit,
        chapterCount: again.filter((c) => !c.front).length,
        chapters: again,
      });
      return;
    }
  }

  const prompt = loadPromptFile('toc-extract-v1.md');
  if (!prompt) {
    const toc = fallbackToMechanical(loaded, pages, { code: 'E_NO_PROMPT', stage: 'prompt', message: '提示词文件缺失', range: { from, to } });
    sendJson(res, 200, { ok: true, fallback: true, code: toc.code, message: toc.message, chapterCount: loaded.book.chapterCount });
    return;
  }

  const built = buildTocMessages({ promptFile: prompt, book: loaded.book, pages: pages, from: from, to: to });
  let entries = null;
  let lastError = '';
  let usedModel = '';
  let budget = TOC_MAX_TOKENS;
  for (let attempt = 0; attempt < 2 && !entries; attempt += 1) {
    const user =
      attempt === 0
        ? built.user
        : built.user + '\n\n【上一次的输出不合格】' + lastError + '\n这次不要分析目录、不要解释，直接输出 JSON 对象。';
    let reply;
    try {
      reply = await callModel(ctx, built.system, user, budget);
      usedModel = reply.model;
    } catch (err) {
      const toc = fallbackToMechanical(loaded, pages, { code: 'E_TOC_LLM', stage: 'llm', message: String((err && err.message) || err), range: { from, to } });
      sendJson(res, 200, { ok: true, fallback: true, code: toc.code, message: toc.message, chapterCount: loaded.book.chapterCount });
      return;
    }
    try {
      // 空正文不是「JSON 格式不好」，是预算被思考吃光了——重试要加钱，也要说清楚
      if (!reply.text.trim()) throw new Error(describeEmptyReply(reply));
      const parsed = parseTocReply(reply.text);
      const errors = validateEntries(parsed);
      if (errors.length) {
        lastError = errors.join('；');
        // 被截断的 JSON 有时还能解析，但条目已经少了；同样要加预算重试
        if (reply.stopReason === 'max-tokens') budget = Math.max(budget, TOC_RETRY_MAX_TOKENS);
        continue;
      }
      entries = parsed;
    } catch (err) {
      lastError = String((err && err.message) || err);
      if (reply.stopReason === 'max-tokens') {
        if (!/截断|思考/.test(lastError)) lastError += '（输出被 max_tokens 截断）';
        budget = Math.max(budget, TOC_RETRY_MAX_TOKENS);
      }
    }
  }

  if (!entries) {
    // 这几页里一条带页码的条目都没有：多半不是目录页，或目录本身不印页码
    const empty = /章节太少（0 条）|没有任何条目/.test(lastError);
    const message = empty ? '这几页没有可用的目录条目（可能不是目录页，或目录没印页码）' : lastError || '模型没给出可用的目录';
    const toc = fallbackToMechanical(loaded, pages, { code: 'E_TOC_LLM', stage: 'validate', message: message, range: { from, to } });
    sendJson(res, 200, { ok: true, fallback: true, code: toc.code, message: toc.message, chapterCount: loaded.book.chapterCount });
    return;
  }

  const calibrated = calibrate(pages, entries, { from: from, to: to });
  const chapters = chaptersFromToc(pages, calibrated);
  if (calibrated.status === 'failed' || !chapters) {
    const toc = fallbackToMechanical(loaded, pages, { code: 'E_TOC_ALIGN', stage: 'calibrate', message: '目录页码对不上 PDF 页', range: { from, to }, entries: calibrated.entries });
    sendJson(res, 200, { ok: true, fallback: true, code: toc.code, message: toc.message, chapterCount: loaded.book.chapterCount });
    return;
  }

  const hitRate = verifyChapters(pages, chapters);
  const status = calibrated.status === 'verified' && hitRate >= 0.8 ? 'verified' : 'unverified';
  persistChapters(loaded, pages, chapters);
  const toc = {
    status: status,
    range: { from: from, to: to },
    cacheKey: cacheKey,
    promptVersion: TOC_PROMPT_VERSION,
    model: usedModel,
    offset: calibrated.offset,
    offsetShare: calibrated.offsetShare,
    hitRate: hitRate,
    entries: calibrated.entries,
    at: new Date().toISOString(),
  };
  writeJson(tocFile, toc);
  sendJson(res, 200, {
    ok: true,
    status: status,
    offset: calibrated.offset,
    hitRate: hitRate,
    truncated: !!built.truncated,
    tocChars: built.chars,
    chapterCount: chapters.filter((c) => !c.front).length,
    chapters: chapters,
  });
}

/* ------------------------------ 生成流水线 ------------------------------ */

/**
 * POST /generate：立即返回 {moduleId, jobId}，真正生成走后台作业（D12）。
 * 幂等（D13）：同一缓存键已有成品 → 秒开；正在跑 → 返回当前作业；
 * 失败/取消/中断的旧模块 → 原地重跑，不堆一地残骸。
 */
async function handleGenerate(req, res, ctx) {
  const body = await readJsonBody(req, 256 * 1024);
  const bookId = String(body.bookId || '').trim();
  const loaded = loadBook(bookId);
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '书架里可能已经删掉了。');
    return;
  }
  const pages = readJson(path.join(loaded.dir, 'pages.json'), []);
  if (!Array.isArray(pages) || pages.length === 0) {
    sendError(res, 'E_NO_PAGES', '这本书没有存下逐页文本', '删掉重新导入一次。');
    return;
  }
  let selection;
  try {
    selection = validateSelection(loaded.chapters, body.chapters);
  } catch (err) {
    sendError(res, (err && err.code) || 'E_SELECTION_EMPTY', String((err && err.message) || err), (err && err.hint) || '');
    return;
  }

  let model;
  try {
    model = resolveModel(ctx);
  } catch (err) {
    sendError(res, 'E_LLM_UNAVAILABLE', '模型不可用', String((err && err.message) || err).slice(0, 200));
    return;
  }
  const voice = readVoiceConfig();
  const imageConfig = readImageConfig();
  const cacheKey = moduleCacheKey(bookId, selection.chapters, model.model);
  const running = findRunningByKey(cacheKey);
  if (running) {
    sendJson(res, 200, {
      ok: true,
      moduleId: running.moduleId,
      jobId: running.moduleId,
      status: running.status,
      running: true,
    });
    return;
  }

  const existing = findModuleByKey(loaded.dir, cacheKey);
  const force = !!body.force;
  if (existing && !force && (existing.record.status === 'ready' || existing.record.status === 'ready_degraded')) {
    sendJson(res, 200, {
      ok: true,
      moduleId: existing.id,
      jobId: existing.id,
      status: existing.record.status,
      cached: true,
    });
    return;
  }
  if (force && existing) {
    try {
      forgetModule(existing.id);
      deleteModuleById(bookId, existing.id);
    } catch {
      /* 删不掉就让新模块另起一个目录 */
    }
  }
  const reuse =
    existing && !force && ['failed', 'interrupted', 'cancelled'].includes(String(existing.record.status)) ? existing : null;

  const prompt = loadPromptFile('slides-b2p-v1.md');
  if (!prompt) {
    sendError(res, 'E_NO_PROMPT', '生成提示词缺失', '插件安装可能不完整，重新装一次。');
    return;
  }

  let job;
  try {
    if (reuse) forgetModule(reuse.id);
    job = startGeneration({
      book: loaded.book,
      selected: selection.chapters,
      pages: pages,
      cleanedPages: cleanPages(pages),
      voice: voice,
      cacheKey: cacheKey,
      model: model,
      prompt: prompt,
      existing: reuse,
      imageProvider: imageConfig.provider,
      onReady: (info) => {
        if (readImageConfig().provider !== 'comfyui') return;
        const started = startImaging({ moduleId: info.moduleId, reason: 'generate' });
        if (!started.ok) {
          console.warn('[book-slides] 配图没启动：' + (started.code || '') + ' ' + String(started.message || ''));
        }
      },
      callModel: (system, user, options) =>
        callModel(ctx, system, user, Object.assign({ maxTokens: 16000, timeoutMs: GENERATE_CALL_TIMEOUT_MS }, options || {})),
    });
  } catch (err) {
    sendError(res, (err && err.code) || 'E_GENERATE', String((err && err.message) || err), (err && err.hint) || '');
    return;
  }
  sendJson(res, 200, {
    ok: true,
    moduleId: job.moduleId,
    jobId: job.moduleId,
    status: job.status,
    model: model.model,
  });
}

/** GET /job：1s 轮询用。内存里有活作业就读内存，否则读 module.json 的终态。 */
function handleJob(req, res) {
  const moduleId = String(query(req).get('moduleId') || '').trim();
  if (!isValidId(moduleId)) {
    sendError(res, 'E_BAD_ID', '参数不合法', 'moduleId 只能是 8–16 位小写字母数字。');
    return;
  }
  const job = getJobState(moduleId);
  if (job) {
    sendJson(res, 200, Object.assign({ ok: true }, job));
    return;
  }
  const found = loadModuleById(moduleId);
  if (!found) {
    sendError(res, 'E_NOT_FOUND', '找不到这个模块', '');
    return;
  }
  const record = found.module;
  sendJson(res, 200, {
    ok: true,
    moduleId: moduleId,
    bookId: found.bookId,
    status: record.status,
    stage: record.stage || 'done',
    current: Number(record.total) || Number(record.slides) || 0,
    total: Number(record.total) || Number(record.slides) || 0,
    message: record.message || '',
    slides: Number(record.slides) || 0,
    error: record.code ? { code: record.code, message: record.error || '', hint: '' } : null,
    startedAt: record.updatedAt || '',
    finishedAt: record.finishedAt || '',
  });
}

/** POST /cancel：只能取消正在跑的作业；已结束返回当前状态而不是报错。 */
async function handleCancel(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const moduleId = String(body.moduleId || query(req).get('moduleId') || '').trim();
  if (!isValidId(moduleId)) {
    sendError(res, 'E_BAD_ID', '参数不合法', '');
    return;
  }
  if (cancelJob(moduleId)) {
    sendJson(res, 200, { ok: true, status: 'cancelling' });
    return;
  }
  const found = loadModuleById(moduleId);
  if (!found) {
    sendError(res, 'E_NOT_FOUND', '找不到这个模块', '');
    return;
  }
  sendJson(res, 200, { ok: true, status: found.module.status, message: '作业已经结束' });
}

/** GET /module：模块记录 + slides.json。M3 的面板「模块预览」与 M4 播放器共用。 */
function handleModuleGet(req, res) {
  const moduleId = String(query(req).get('moduleId') || '').trim();
  if (!isValidId(moduleId)) {
    sendError(res, 'E_BAD_ID', '参数不合法', '');
    return;
  }
  const found = loadModuleById(moduleId);
  if (!found) {
    sendError(res, 'E_NOT_FOUND', '找不到这个模块', '可能已经在书架里删掉了。');
    return;
  }
  sendJson(res, 200, {
    ok: true,
    module: found.module,
    slides: found.slides,
    book: found.book ? { id: found.bookId, title: String(found.book.title || '') } : { id: found.bookId, title: '' },
  });
}

/** DELETE /module：删模块目录（不含书）。 */
async function handleModuleDelete(req, res) {
  let body = {};
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch {
    body = {};
  }
  const moduleId = String(body.moduleId || query(req).get('moduleId') || '').trim();
  if (!isValidId(moduleId)) {
    sendError(res, 'E_BAD_ID', '参数不合法', '');
    return;
  }
  const found = loadModuleById(moduleId);
  if (!found) {
    sendError(res, 'E_NOT_FOUND', '找不到这个模块', '');
    return;
  }
  forgetModule(moduleId);
  if (!deleteModuleById(found.bookId, moduleId)) {
    sendError(res, 'E_NOT_FOUND', '找不到这个模块', '');
    return;
  }
  clearProgressForModule(moduleId);
  sendJson(res, 200, { ok: true });
}

/** GET /audio：目前浏览器朗读不落盘，这里为后续云端合成（M5）留好 Range 通道。 */
function handleAudio(req, res) {
  const params = query(req);
  const moduleId = String(params.get('moduleId') || '').trim();
  const index = Math.round(Number(params.get('i')) || 0);
  if (!isValidId(moduleId) || index < 1 || index > 999) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const found = loadModuleById(moduleId);
  if (!found) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const base = path.join(found.moduleDir, 'audio', String(index).padStart(3, '0'));
  const candidates = [
    { file: base + '.wav', type: 'audio/wav' },
    { file: base + '.mp3', type: 'audio/mpeg' },
  ];
  let file = '';
  let type = 'audio/wav';
  let stat = null;
  for (const candidate of candidates) {
    try {
      const info = fs.statSync(candidate.file);
      if (info.isFile()) {
        file = candidate.file;
        type = candidate.type;
        stat = info;
        break;
      }
    } catch {
      /* 试下一个扩展名 */
    }
  }
  if (!stat) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const total = stat.size;
  const range = String((req.headers && req.headers.range) || '');
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  res.setHeader('content-type', type);
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('cache-control', 'no-store');
  if (match) {
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
    fs.createReadStream(file, { start: start, end: end }).pipe(res);
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-length', String(total));
  fs.createReadStream(file).pipe(res);
}

/* ------------------------------ 语音设置 ------------------------------ */

function handleVoiceGet(req, res) {
  const config = readVoiceConfig();
  sendJson(res, 200, {
    ok: true,
    voice: publicVoiceConfig(config),
    providers: VOICE_PROVIDERS,
    models: QWEN_MODELS,
    qwenVoices: QWEN_VOICES,
    note: 'Qwen3-TTS 的 Key 只存本机 voice.json（0600）；浏览器朗读不需要 Key。',
  });
}

async function handleVoicePost(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  try {
    const next = writeVoiceConfig(body && body.voice && typeof body.voice === 'object' ? body.voice : body);
    sendJson(res, 200, {
      ok: true,
      voice: publicVoiceConfig(next),
      providers: VOICE_PROVIDERS,
      models: QWEN_MODELS,
      qwenVoices: QWEN_VOICES,
    });
  } catch (err) {
    sendError(res, 'E_VOICE_SAVE', '语音配置没存下来', String((err && err.message) || err).slice(0, 200));
  }
}

async function handleVoiceProbe(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const result = await probeVoice(readVoiceConfig(), body && body.text);
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

/* ------------------------------ 本地 ComfyUI 配图 ------------------------------ */

function imagePayload(extra) {
  const image = publicImageConfig();
  return Object.assign(
    { ok: true, image: image, providers: IMAGE_PROVIDERS, defaults: { host: DEFAULT_HOST, port: DEFAULT_PORT } },
    extra || {},
  );
}

/** GET/POST /image/config：策略、host、port、风格后缀、提示词节点。 */
async function handleImageConfig(req, res) {
  if (methodIs(req, 'GET')) {
    sendJson(res, 200, imagePayload());
    return;
  }
  const body = await readJsonBody(req, 64 * 1024);
  const patch = body.image && typeof body.image === 'object' ? body.image : body;
  writeImageConfig(patch);
  sendJson(res, 200, imagePayload());
}

/**
 * POST /image/workflow：导入 API 格式工作流。先校验、再落盘；坏文件不覆盖旧的。
 * 识别不出提示词节点时返回 E_IMG_WORKFLOW_NODE + candidates，面板让用户选一个再提交。
 */
async function handleImageWorkflow(req, res) {
  const body = await readJsonBody(req, 2 * 1024 * 1024);
  if (body && body.reset === true) {
    resetWorkflow();
    sendJson(res, 200, imagePayload());
    return;
  }
  const workflow = body && body.workflow && typeof body.workflow === 'object' ? body.workflow : body;
  try {
    const saved = saveWorkflow(workflow, { name: body && body.name, promptNode: body && body.promptNode });
    sendJson(res, 200, imagePayload({ candidates: saved.candidates }));
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

/** POST /image/probe：读 ComfyUI 版本 + 检查工作流要用的模型是否都在。 */
async function handleImageProbe(req, res) {
  try {
    const config = readImageConfig();
    const store = readWorkflowStore();
    const result = await probeComfy({ config: config, workflow: store.workflow });
    sendJson(res, 200, Object.assign({ ok: true, workflow: { source: store.source, name: store.name } }, result));
  } catch (err) {
    sendError(res, (err && err.code) || 'E_IMG_CONNECT', String((err && err.message) || err), (err && err.hint) || '');
  }
}

/**
 * POST /image/test：用当前配置跑一次「测试生图」，只验证链路。
 * 返回 image/png（不落盘、不进缓存、不写任何模块）；失败返回 JSON 错误。
 */
async function handleImageTest(req, res) {
  const body = await readJsonBody(req, 16 * 1024);
  const config = readImageConfig();
  if (config.provider !== 'comfyui') {
    sendError(res, 'E_IMG_DISABLED', '当前配图策略是「提示词占位」', '先到设置里切到「本地 ComfyUI」，再测试生图。');
    return;
  }
  if (hasActiveImagingJob()) {
    sendError(res, 'E_IMG_BUSY', '配图作业正在跑，先别抢 GPU', '等这次补图完成，或到模块列表取消后再试。');
    return;
  }

  let store;
  let check;
  try {
    store = readWorkflowStore();
    check = validateWorkflow(store.workflow);
  } catch (err) {
    sendError(res, (err && err.code) || 'E_IMG_WORKFLOW', String((err && err.message) || err), (err && err.hint) || '');
    return;
  }
  const promptNode =
    config.promptNode && check.candidates.some((item) => item.id === config.promptNode) ? config.promptNode : check.promptNode;
  if (!promptNode) {
    sendError(res, 'E_IMG_WORKFLOW_NODE', '工作流没认出提示词节点', '到「提示词节点」里选一个再试。');
    return;
  }

  const prompt = String(body.prompt == null ? '' : body.prompt).trim() || DEFAULT_TEST_PROMPT;
  if (prompt.length > TEST_PROMPT_MAX) {
    sendError(res, 'E_IMG_PROMPT', '测试提示词最多 ' + TEST_PROMPT_MAX + ' 字', '当前 ' + prompt.length + ' 字。');
    return;
  }

  const seed = seedFor(prompt, workflowHashOf(store.workflow), Date.now());
  const startedAt = Date.now();
  try {
    const result = await generateImage({
      config: config,
      workflow: store.workflow,
      prompt: prompt,
      seed: seed,
      promptNode: promptNode,
      timeoutMs: IMAGE_TIMEOUT_MS,
    });
    res.statusCode = 200;
    res.setHeader('content-type', 'image/png');
    res.setHeader('content-length', String(result.buffer.length));
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-image-ms', String(Date.now() - startedAt));
    res.setHeader('x-image-seed', String(seed));
    res.setHeader('x-image-node', String(promptNode));
    res.end(result.buffer);
  } catch (err) {
    sendError(res, (err && err.code) || 'E_IMG_FAIL', String((err && err.message) || err), (err && err.hint) || '');
  }
}

/** GET /image/status：后台配图作业的进度；重启后没有内存作业就归一为 interrupted。 */

function handleImageStatus(req, res) {
  const moduleId = String(query(req).get('moduleId') || '').trim();
  sendJson(res, 200, getImagingStatus(moduleId));
}

/** POST /image/regen：补配图 / 单页重出 / 全部重出（force）。 */
async function handleImageRegen(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const moduleId = String(body.moduleId || '').trim();
  const only = Array.isArray(body.slides) ? body.slides : Number(body.slide) ? [Number(body.slide)] : null;
  const result = startImaging({ moduleId: moduleId, only: only, force: body.force === true });
  sendJson(res, 200, Object.assign({ image: publicImageConfig() }, result));
}

async function handleImageCancel(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const moduleId = String(body.moduleId || query(req).get('moduleId') || '').trim();
  if (!isValidId(moduleId)) {
    sendError(res, 'E_BAD_ID', '参数不合法', '');
    return;
  }
  sendJson(res, 200, { ok: true, status: cancelImaging(moduleId) ? 'cancelling' : 'none' });
}

/** GET /image?moduleId=&i=：宿主落盘的 PNG；浏览器不直连 ComfyUI。 */
function handleImage(req, res) {
  const params = query(req);
  const moduleId = String(params.get('moduleId') || '').trim();
  const index = Math.round(Number(params.get('i')) || 0);
  if (!isValidId(moduleId) || index < 1 || index > 999) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const found = loadModuleById(moduleId);
  if (!found) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const abs = imageAbsPath(found.moduleDir, 'images/' + String(index).padStart(3, '0') + '.png');
  if (!abs) {
    res.statusCode = 404;
    res.end();
    return;
  }
  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'image/png');
  res.setHeader('content-length', String(stat.size));
  res.setHeader('cache-control', 'no-store');
  fs.createReadStream(abs).pipe(res);
}

/* ------------------------------ 播放器数据 ------------------------------ */

/** 单次最多取 200 页原文：播放器只按 source_pages 取几页，不该整本回传。 */
const MAX_PAGE_SPAN = 200;

/** GET /pages：原文窗格用未清洗的逐页文本（D7 要求显示原文）。 */
function handlePages(req, res) {
  const params = query(req);
  const bookId = String(params.get('bookId') || '').trim();
  const loaded = loadBook(bookId);
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
  const pages = readJson(path.join(loaded.dir, 'pages.json'), []);
  if (!Array.isArray(pages) || !pages.length) {
    sendError(res, 'E_NO_PAGES', '这本书没有存下逐页文本', '删掉重新导入一次。');
    return;
  }
  const total = pages.length;
  const from = Math.round(Number(params.get('from')) || 1);
  const to = Math.round(Number(params.get('to')) || total);
  if (!(from >= 1 && to >= from && to <= total)) {
    sendError(res, 'E_BAD_RANGE', '页码范围不合法', '这本书一共 ' + total + ' 页。');
    return;
  }
  if (to - from + 1 > MAX_PAGE_SPAN) {
    sendError(res, 'E_BAD_RANGE', '一次最多取 ' + MAX_PAGE_SPAN + ' 页', '按幻灯片的 source_pages 分批取。');
    return;
  }
  const slice = [];
  for (const page of pages) {
    const no = Number((page && page.page) || 0);
    if (no >= from && no <= to) slice.push({ page: no, text: String((page && page.text) || '') });
  }
  sendJson(res, 200, { ok: true, from: from, to: to, total: total, pages: slice });
}

/**
 * 同源代理 pdf.js 的浏览器产物（build / cmaps / standard_fonts / wasm / iccs /
 * image_decoders）。只读、只允许这些目录，路径先 resolve 再确认仍在依赖目录内。
 */
const PDFJS_ASSET_TYPES = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.icc': 'application/octet-stream',
};
const PDFJS_ALLOWED_DIRS = /^(build|cmaps|standard_fonts|wasm|iccs|image_decoders)\//;

function handlePdfjsAsset(req, res) {
  const root = pdfjsRoot();
  if (!root) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const prefix = ROUTE_PDFJS_VENDOR + '/';
  let rel = '';
  try {
    const pathname = new URL(String((req && req.url) || '/'), 'http://localhost').pathname;
    if (!pathname.startsWith(prefix)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    rel = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    res.statusCode = 404;
    res.end();
    return;
  }
  if (!rel || rel.includes('\0') || rel.includes('..') || path.isAbsolute(rel) || !PDFJS_ALLOWED_DIRS.test(rel)) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const resolvedRoot = path.resolve(root);
  const file = path.resolve(resolvedRoot, rel);
  const inside = path.relative(resolvedRoot, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    res.statusCode = 404;
    res.end();
    return;
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    res.statusCode = 404;
    res.end();
    return;
  }
  if (!stat.isFile()) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const type = PDFJS_ASSET_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.statusCode = 200;
  res.setHeader('content-type', type);
  res.setHeader('content-length', String(stat.size));
  res.setHeader('cache-control', 'public, max-age=3600');
  fs.createReadStream(file).pipe(res);
}

/** GET /progress：书架「继续听」位置；模块没就绪或已删就当作没有。 */
function handleProgressGet(req, res) {
  let progress = readProgress();
  if (progress.lastModuleId) {
    const found = loadModuleById(progress.lastModuleId);
    const ready = found && found.bookId === progress.lastBookId && ['ready', 'ready_degraded'].includes(String(found.module.status));
    if (!ready) progress = { lastBookId: '', lastModuleId: '', lastSlide: 1, updatedAt: progress.updatedAt };
  }
  sendJson(res, 200, { ok: true, progress: progress });
}

/** POST /progress：{bookId, moduleId, slide}，只认已存在模块，slide 会被夹到合法范围。 */
async function handleProgressPost(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const bookId = String(body.bookId || '').trim();
  const moduleId = String(body.moduleId || '').trim();
  const slide = Math.round(Number(body.slide) || 0);
  if (!isValidId(bookId) || !isValidId(moduleId) || slide < 1) {
    sendError(res, 'E_BAD_ID', '播放位置不合法', '');
    return;
  }
  const found = loadModuleById(moduleId);
  if (!found || found.bookId !== bookId) {
    sendError(res, 'E_NOT_FOUND', '找不到这个模块', '它可能已经被删掉了。');
    return;
  }
  if (!['ready', 'ready_degraded'].includes(String(found.module.status))) {
    sendError(res, 'E_NOT_READY', '这个模块还没就绪', '等生成完成后再记录播放位置。');
    return;
  }
  const total = Number(found.module.slides) || 0;
  const clamped = Math.min(slide, Math.max(1, total));
  const progress = writeProgress({ lastBookId: bookId, lastModuleId: moduleId, lastSlide: clamped });
  sendJson(res, 200, { ok: true, progress: progress });
}

/** GET /preference：分隔条比例、语速、静音。 */
function handlePreferenceGet(req, res) {
  sendJson(res, 200, { ok: true, preference: readPreference() });
}

/** POST /preference：只写传进来的字段，区间由 store 夹紧。 */
async function handlePreferencePost(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const patch = {};
  if (body && body.splitRatio != null) patch.splitRatio = Number(body.splitRatio);
  if (body && body.rate != null) patch.rate = Number(body.rate);
  if (body && body.muted != null) patch.muted = body.muted === true;
  if (body && body.fontSize != null) patch.fontSize = Number(body.fontSize);
  const preference = writePreference(patch);
  sendJson(res, 200, { ok: true, preference: preference });
}

/** POST /trash/clear：清空回收站（AC-24）。 */
async function handleTrashClear(req, res) {
  try {
    await readJsonBody(req, 64 * 1024);
  } catch {
    /* 没有 body 也照样清 */
  }
  const cleared = clearTrash();
  sendJson(res, 200, { ok: true, cleared: cleared.count, bytesFreed: cleared.bytes, trash: trashStats() });
}

/* ------------------------------ 文件 ------------------------------ */

/** 原始 PDF：支持 Range，浏览器内置阅读器才肯翻页。 */
function handleFile(req, res) {
  const bookId = String(query(req).get('bookId') || '').trim();
  const dir = existingBookDir(bookId);
  if (!dir) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const file = path.join(dir, 'source.pdf');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    res.statusCode = 404;
    res.end();
    return;
  }
  const total = stat.size;
  const range = String((req.headers && req.headers.range) || '');
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', 'inline; filename*=UTF-8\'\'' + encodeURIComponent(path.basename(file)));
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('cache-control', 'no-store');

  if (match) {
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
    fs.createReadStream(file, { start: start, end: end }).pipe(res);
    return;
  }

  res.statusCode = 200;
  res.setHeader('content-length', String(total));
  fs.createReadStream(file).pipe(res);
}

/** 书封：现算现给，不落盘。 */
function handleCover(req, res) {
  const bookId = String(query(req).get('bookId') || '').trim();
  const loaded = loadBook(bookId);
  if (!loaded) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const book = loaded.book;
  const svg = coverSvg({
    title: book.title,
    author: book.author,
    chapters: book.chapterCount,
    chars: book.chars,
    id: loaded.book.id,
  });
  res.statusCode = 200;
  res.setHeader('content-type', 'image/svg+xml; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=3600');
  res.end(svg);
}

/** 设置页要看的存储概况。 */
function handleStorage(req, res) {
  const trash = trashStats();
  sendJson(res, 200, {
    ok: true,
    dataRoot: ROOT,
    bytes: dirSize(ROOT),
    trashCount: trash.count,
    trashBytes: trash.bytes,
    pluginVersion: PLUGIN_VERSION,
  });
}

/* ------------------------------ 书档（v1.3） ------------------------------ */

function sendPackageError(res, err) {
  const code = (err && err.code) || 'E_PKG_MANIFEST';
  sendError(res, code, String((err && err.message) || err), (err && err.hint) || '');
}

function exportParams(req) {
  const params = query(req);
  const ids = String(params.get('books') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return { ids: ids, includeAudio: String(params.get('audio') || '1') !== '0' };
}

function contentDisposition(name) {
  const fallback = String(name || 'package.zip')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_');
  return (
    'attachment; filename="' + fallback + '"; filename*=UTF-8\'\'' + encodeURIComponent(String(name || 'package.zip'))
  );
}

async function handleExport(req, res) {
  const params = exportParams(req);
  let plan;
  try {
    const busy = params.ids.find((id) => bookHasImagingJob(id));
    if (busy) {
      throw new PackageError('E_EXPORT_BUSY', '这本书正在生成配图，完成后再导出', busy);
    }
    plan = await planExport(params.ids, { includeAudio: params.includeAudio });
  } catch (err) {
    sendPackageError(res, err);
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/zip');
  res.setHeader('content-disposition', contentDisposition(packageFileName(plan)));
  res.setHeader('cache-control', 'no-store');
  try {
    writeExportStream(res, plan);
  } catch {
    try {
      res.destroy();
    } catch {
      /* 客户端已经断开 */
    }
  }
}

async function handleExportSize(req, res) {
  const params = exportParams(req);
  try {
    const plan = await planExport(params.ids, { includeAudio: params.includeAudio });
    const manifestBytes = Buffer.byteLength(JSON.stringify(buildManifest(plan), null, 2), 'utf8');
    const totalBytes = plan.stats.bytes + manifestBytes + Buffer.byteLength(README_TEXT, 'utf8');
    const warnings = plan.warnings.slice();
    if (totalBytes > MAX_PACKAGE_BYTES) warnings.push('预计超过 4 GiB，请去掉「含音频」或分批导出');
    sendJson(res, 200, {
      ok: true,
      books: plan.stats.books,
      modules: plan.stats.modules,
      files: plan.stats.files,
      bytes: totalBytes,
      includeAudio: params.includeAudio,
      warnings: warnings,
    });
  } catch (err) {
    sendPackageError(res, err);
  }
}

/* ------------------------------ PPT 导出（v1.5） ------------------------------ */

function sendPptxError(res, err) {
  const code = (err && err.code) || 'E_PPT_FAIL';
  sendError(res, code, String((err && err.message) || err), (err && err.hint) || '');
}

function pptxParams(req) {
  const params = query(req);
  return {
    moduleId: String(params.get('moduleId') || '').trim(),
    includeAudio: String(params.get('audio') || '1') !== '0',
  };
}

function handlePptxPlan(req, res) {
  const params = pptxParams(req);
  if (!isValidId(params.moduleId)) {
    sendError(res, 'E_BAD_ID', '参数不合法', '');
    return;
  }
  try {
    const plan = planPptx(params.moduleId, { includeAudio: params.includeAudio });
    sendJson(res, 200, plan);
  } catch (err) {
    sendPptxError(res, err);
  }
}

async function handlePptxExport(req, res) {
  const params = pptxParams(req);
  if (!isValidId(params.moduleId)) {
    sendError(res, 'E_BAD_ID', '参数不合法', '');
    return;
  }
  let built;
  try {
    built = buildPptxPlan(params.moduleId, { includeAudio: params.includeAudio });
    // 模板缺失属于构建前置错误：必须在写流之前暴露成 JSON，不能让客户端拿到空 200。
    await loadShellParts();
  } catch (err) {
    sendPptxError(res, err);
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.setHeader('content-disposition', contentDisposition(built.plan.fileName));
  res.setHeader('cache-control', 'no-store');
  try {
    await writePptx(res, built.deck);
  } catch {
    try {
      res.destroy();
    } catch {
      /* 客户端已经断开 */
    }
  }
}

/** 上传直接落盘：书档是 GB 级，不能像 JSON 接口那样整包进内存。 */
function receiveToFile(req, file, limit) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try {
        out.destroy();
      } catch {
        /* 已经失败 */
      }
      try {
        req.destroy();
      } catch {
        /* 已经断开 */
      }
      reject(err);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new PackageError('E_PKG_TOO_LARGE', '书档超过 4 GiB', '去掉音频或分批导出'));
      }
    });
    req.on('error', () => fail(new PackageError('E_IMPORT_ABORTED', '文件没传完', '检查网络或重试')));
    req.on('aborted', () => fail(new PackageError('E_IMPORT_ABORTED', '上传被中断', '检查网络或重试')));
    out.on('error', () => fail(new PackageError('E_PKG_CORRUPT', '写入书档失败', '磁盘可能已满')));
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      if (!size) {
        reject(new PackageError('E_PKG_NOT_ZIP', '没收到文件内容', ''));
        return;
      }
      resolve(size);
    });
    req.pipe(out);
  });
}

async function handleImportPackage(req, res, headers) {
  const rawName = String((headers && headers['x-file-name']) || '');
  let fileName = rawName;
  try {
    fileName = decodeURIComponent(rawName);
  } catch {
    fileName = rawName;
  }
  fileName = fileName.trim() || 'package.zip';
  if (!/\.zip$/i.test(fileName)) {
    sendError(res, 'E_PKG_NOT_ZIP', '只支持 .zip 书档', '在书架点「导出书档」得到的就是这种文件。');
    return;
  }
  const declared = Number((headers && headers['content-length']) || 0) || 0;
  if (declared > MAX_PACKAGE_BYTES) {
    sendError(res, 'E_PKG_TOO_LARGE', '书档超过 4 GiB', '去掉音频或分批导出。');
    return;
  }
  ensureDirs();
  const jobId = newId(12);
  const staging = path.join(ROOT, '.import', jobId);
  fs.mkdirSync(staging, { recursive: true });
  const zipPath = path.join(staging, 'package.zip');
  try {
    await receiveToFile(req, zipPath, MAX_PACKAGE_BYTES);
    const policy = normalizePolicy(query(req).get('policy') || DEFAULT_POLICY);
    const result = await importPackage({ zipPath, policy, stagingRoot: staging, fileName });
    sendJson(res, 200, result);
  } catch (err) {
    sendPackageError(res, err);
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      /* 清不掉就留给启动清理 */
    }
  }
}

/** 只补配音：不动文案与锚点，只重跑 voicing。 */
async function handleRevoice(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const moduleId = String(body.moduleId || '').trim();
  if (!isValidId(moduleId)) {
    sendError(res, 'E_BAD_ID', '模块号不合法', '');
    return;
  }
  const found = loadModuleById(moduleId);
  if (!found) {
    sendError(res, 'E_NOT_FOUND', '找不到这个模块', '');
    return;
  }
  if (!found.slides || !Array.isArray(found.slides.slides) || !found.slides.slides.length) {
    sendError(res, 'E_NOT_FOUND', '这个模块还没有文案，不能单独补配音', '');
    return;
  }
  const config = readVoiceConfig();
  if (config.provider !== 'qwen3-tts' || !config.apiKey) {
    sendError(res, 'E_TTS_UNCONFIGURED', '未配置 Qwen 语音', '去设置里选择 Qwen3-TTS 并填 API Key。');
    return;
  }
  let result;
  try {
    result = await synthesizeVoicing(found.slides.slides, config, { moduleDir: found.moduleDir });
  } catch (err) {
    sendError(res, (err && err.code) || 'E_TTS_FAIL', String((err && err.message) || err), (err && err.hint) || '');
    return;
  }
  const at = new Date().toISOString();
  writeJson(
    path.join(found.moduleDir, 'slides.json'),
    Object.assign({}, found.slides, {
      slides: result.slides,
      voice: {
        provider: result.provider,
        mode: result.mode,
        model: result.model || config.model || '',
        rate: Number(config.rate) || 1,
        voice: config.voice || '',
      },
    }),
  );
  writeJson(
    path.join(found.moduleDir, 'module.json'),
    Object.assign({}, found.module, {
      status: result.degraded ? 'ready_degraded' : 'ready',
      code: result.degraded ? result.code : null,
      error: result.degraded ? result.message : null,
      message: result.degraded ? result.message : '配音已完成',
      voice: {
        provider: result.provider,
        model: result.model || config.model || '',
        voice: config.voice || '',
        rate: Number(config.rate) || 1,
        mode: result.mode,
        degraded: !!result.degraded,
      },
      updatedAt: at,
      finishedAt: at,
    }),
  );
  const voiced = result.slides.filter((slide) => slide && slide.audio_file).length;
  sendJson(res, 200, {
    ok: true,
    moduleId: moduleId,
    voiced: voiced,
    total: result.slides.length,
    degraded: !!result.degraded,
    code: result.degraded ? result.code : null,
    message: result.degraded ? result.message : '',
  });
}

/* ------------------------------ 注册 ------------------------------ */

/* ------------------------------ 练习与复习（v1.6 / FR-11） ------------------------------ */

function sendPracticeError(res, err) {
  const code = (err && err.code) || 'E_QZ_FAIL';
  const message = String((err && err.message) || err || '练习出错');
  const hint = (err && err.hint) || '';
  sendError(res, code, message, hint);
}

function practicePublicQuestion(question) {
  return {
    qid: question.qid,
    chapter: Number(question.chapter) || 0,
    moduleId: question.module_id ? String(question.module_id) : null,
    point: String(question.point || ''),
    type: String(question.type || 'single'),
    difficulty: Number(question.difficulty) || 2,
    stem: String(question.stem || ''),
    options: Array.isArray(question.options) ? question.options.map((option) => ({ key: option.key, text: option.text })) : [],
    source_pages: question.source_pages || null,
    anchor_status: String(question.anchor_status || 'unanchored'),
  };
}

function practiceQuestionOf(bank, qid) {
  return (bank.questions || []).find((question) => question.qid === qid) || null;
}

/** 练习范围：模块的章，或显式章号；只接受非前置、非空白章。出题限 5 章，复习场次可放宽。 */
function practiceChapters(loaded, body, maxChapters) {
  const limit = Number(maxChapters) > 0 ? Number(maxChapters) : MAX_MODULE_CHAPTERS;
  const all = (loaded.chapters || []).filter((chapter) => !chapter.front);
  let ns = [];
  if (body && body.moduleId) {
    const module = listModules(loaded.book.id).find((item) => item.id === String(body.moduleId));
    if (!module) throw new PracticeError('E_NOT_FOUND', '找不到这个精讲模块');
    ns = Array.isArray(module.chapters) ? module.chapters : [];
  } else {
    ns = Array.isArray(body && body.chapters) ? body.chapters : [];
  }
  ns = Array.from(new Set(ns.map((n) => Math.round(Number(n) || 0)).filter((n) => n > 0))).sort((a, b) => a - b);
  if (!ns.length) throw new PracticeError('E_SELECTION_EMPTY', '先选至少一章');
  if (ns.length > limit) throw new PracticeError('E_SELECTION_TOO_LARGE', '最多 ' + limit + ' 章');
  return ns.map((n) => {
    const chapter = all.find((item) => Number(item.n) === n);
    if (!chapter) throw new PracticeError('E_NO_CHAPTER', '没有第 ' + n + ' 章');
    if ((Number(chapter.chars) || 0) < 50) throw new PracticeError('E_CHAPTER_EMPTY', '第 ' + n + ' 章是空白页');
    return chapter;
  });
}

/**
 * 每章的出题输入：考点白名单来自覆盖该章的 ready 模块幻灯片，
 * 依据来自章原文。没有 ready 模块覆盖的章不能生成新题（FR-11 / P.1）。
 */
function practiceSources(bookId, chapters, pages) {
  const modules = listModules(bookId).filter((module) => ['ready', 'ready_degraded'].includes(String(module.status)));
  const map = new Map();
  for (const chapter of chapters) {
    map.set(Number(chapter.n), { slidePoints: [], text: chapterTextOf(pages, chapter), moduleId: null });
  }
  for (const module of modules) {
    let slides = [];
    try {
      const data = readJson(path.join(bookDir(bookId), 'modules', module.id, 'slides.json'), null);
      slides = data && Array.isArray(data.slides) ? data.slides : [];
    } catch {
      slides = [];
    }
    for (const n of Array.isArray(module.chapters) ? module.chapters : []) {
      const chapter = chapters.find((item) => Number(item.n) === Number(n));
      if (!chapter) continue;
      const entry = map.get(Number(n));
      if (entry && !entry.moduleId) entry.moduleId = module.id;
      for (const slide of slides) {
        const range = slide && slide.source_pages ? slide.source_pages : {};
        const from = Number(range.from) || 0;
        const to = Number(range.to) || from;
        if (!(from <= Number(chapter.to) && to >= Number(chapter.from))) continue;
        const label = [slide.title]
          .concat(Array.isArray(slide.bullet_points) ? slide.bullet_points : [])
          .filter(Boolean)
          .join('：');
        if (label && !entry.slidePoints.includes(label)) entry.slidePoints.push(label);
      }
    }
  }
  for (const chapter of chapters) {
    const covered = modules.some((module) => (module.chapters || []).map(Number).includes(Number(chapter.n)));
    if (!covered) {
      throw new PracticeError(
        'E_QZ_NO_SOURCE',
        '第 ' + chapter.n + ' 章还没有精讲',
        '先为这一章生成精讲，再回来练习。',
      );
    }
  }
  return map;
}

function handlePracticeSummary(req, res) {
  const q = query(req);
  const bookId = String(q.get('bookId') || '').trim();
  const loaded = loadBook(bookId);
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '书架里可能已经删掉了。');
    return;
  }
  const raw = String(q.get('chapters') || '').trim();
  const all = (loaded.chapters || []).filter((chapter) => !chapter.front);
  const ns = raw
    ? raw
        .split(',')
        .map((value) => Math.round(Number(value) || 0))
        .filter((n) => n > 0)
    : all.map((chapter) => Number(chapter.n));
  const bank = readBank(bookId);
  const mastery = readMastery(bookId);
  const questions = (bank.questions || []).filter((question) => !question.flagged && ns.includes(Number(question.chapter)));
  const now = Date.now();
  const stateOf = (qid) => mastery.items[qid] || null;
  let unseen = 0;
  let due = 0;
  let wrong = 0;
  const byChapter = {};
  for (const question of questions) {
    const state = stateOf(question.qid);
    byChapter[question.chapter] = (byChapter[question.chapter] || 0) + 1;
    if (!state || !Number(state.attempts)) unseen += 1;
    if (state && state.due_at && new Date(state.due_at).getTime() <= now) due += 1;
    if (state && (String(state.last) === 'wrong' || Number(state.box) === 0)) wrong += 1;
  }
  const modules = listModules(bookId)
    .filter((module) => ['ready', 'ready_degraded'].includes(String(module.status)))
    .map((module) => ({
      moduleId: module.id,
      title: module.title,
      chapters: module.chapters || [],
      ready: true,
    }));
  const mode = SESSION_MODES.includes(String(q.get('mode') || '')) ? String(q.get('mode')) : 'mixed';
  const count = clampCount(q.get('count'));
  const topup = planTopUp({
    mode: mode,
    count: count,
    unseen: unseen,
    chapters: ns.length,
    bankTotal: (bank.questions || []).length,
    oldAvailable: Math.max(0, questions.length - unseen),
  });
  if (mode === 'review') {
    const available = questions.filter((question) => {
      const state = stateOf(question.qid);
      return !!state && (String(state.last) === 'wrong' || Number(state.box) === 0 || (state.due_at && new Date(state.due_at).getTime() <= now));
    }).length;
    topup.feasibleN = Math.min(count, available);
    topup.blocked = available < 1;
    topup.reason = available < 1 ? '没有到期或做错的题' : '';
  }
  const running = findRunningPractice(bookId, ns);
  sendJson(res, 200, {
    ok: true,
    bank: { total: questions.length, unseen: unseen, due: due, wrong: wrong, byChapter: byChapter },
    defaults: { count: SESSION_DEFAULT_COUNT, mode: 'mixed', max: SESSION_MAX_COUNT },
    topup: topup,
    chapters: all.map((chapter) => ({ n: Number(chapter.n), title: chapter.title, from: chapter.from, to: chapter.to, chars: chapter.chars })),
    modules: modules,
    job: running ? getPracticeJob(running.jobId) : null,
    promptVersion: PRACTICE_PROMPT_VERSION,
  });
}

async function handlePracticeGenerate(req, res, ctx) {
  const body = await readJsonBody(req, 64 * 1024);
  const bookId = String(body.bookId || '').trim();
  const loaded = loadBook(bookId);
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '书架里可能已经删掉了。');
    return;
  }
  const pages = readJson(path.join(loaded.dir, 'pages.json'), []);
  let chapters;
  try {
    chapters = practiceChapters(loaded, body);
  } catch (err) {
    sendPracticeError(res, err);
    return;
  }
  let sources;
  try {
    sources = practiceSources(bookId, chapters, pages);
  } catch (err) {
    sendPracticeError(res, err);
    return;
  }
  const bank = readBank(bookId);
  const append = !!(body.append || body.force);
  if (append && bank.questions.length >= MAX_Q_PER_BOOK) {
    sendJson(res, 200, { ok: true, full: true, added: 0, chapters: chapters.map((chapter) => Number(chapter.n)) });
    return;
  }
  const keys = chapters.map((chapter) => chapterKey(bookId, chapter));
  const isReadyChapter = (chapter, index) => {
    const entry = bank.chapters[String(chapter.n)];
    return entry && entry.status === 'ready' && entry.key === keys[index];
  };
  if (!append && chapters.every(isReadyChapter)) {
    sendJson(res, 200, { ok: true, cached: true, chapters: chapters.map((chapter) => Number(chapter.n)) });
    return;
  }
  const pendingChapters = append ? chapters : chapters.filter((chapter, index) => !isReadyChapter(chapter, index));
  const running = findRunningPractice(
    bookId,
    pendingChapters.map((chapter) => Number(chapter.n)),
  );
  if (running) {
    sendJson(res, 200, { ok: true, jobId: running.jobId, running: true, status: running.status });
    return;
  }
  const prompt = loadPromptFile('practice-gen-v1.md');
  if (!prompt) {
    sendError(res, 'E_NO_PROMPT', '出题提示词缺失', '插件安装可能不完整，重新装一次。');
    return;
  }
  let job;
  try {
    job = startPracticeGeneration({
      bookId: bookId,
      book: loaded.book,
      chapters: pendingChapters,
      pages: pages,
      sources: sources,
      prompt: prompt,
      existing: bank.questions,
      append: append,
      callModel: (system, user, options) =>
        callModel(ctx, system, user, Object.assign({ maxTokens: 8000, timeoutMs: 120000 }, options || {})),
    });
  } catch (err) {
    sendPracticeError(res, err);
    return;
  }
  sendJson(res, 200, { ok: true, jobId: job.jobId, status: job.status });
}

function handlePracticeJob(req, res) {
  const q = query(req);
  const job = getPracticeJob(String(q.get('jobId') || ''));
  if (!job) {
    sendError(res, 'E_NOT_FOUND', '找不到这个出题作业');
    return;
  }
  sendJson(res, 200, Object.assign({ ok: true }, job));
}

async function handlePracticeSession(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const bookId = String(body.bookId || '').trim();
  const loaded = loadBook(bookId);
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书');
    return;
  }
  let chapters;
  try {
    chapters = practiceChapters(loaded, body, Number.MAX_SAFE_INTEGER);
  } catch (err) {
    sendPracticeError(res, err);
    return;
  }
  const bank = readBank(bookId);
  const mastery = readMastery(bookId);
  const mode = SESSION_MODES.includes(String(body.mode)) ? String(body.mode) : 'mixed';
  const count = clampCount(body.count);
  const plan = composeSession({
    bank: bank,
    mastery: mastery,
    chapterNs: chapters.map((chapter) => Number(chapter.n)),
    mode: mode,
    count: count,
    now: Date.now(),
  });
  if (!plan.length) {
    const empty =
      mode === 'new'
        ? { message: '新题已经练完了', hint: '切到「混合」练已答过的题，或点「再出一组」补 5 道新题。' }
        : mode === 'review'
          ? { message: '还没有到期或做错的题', hint: '先练一场新的，或者明天再来复习。' }
          : { message: '还没有可练的题', hint: '点「再出一组」生成一组。' };
    sendError(res, 'E_QZ_NOT_ENOUGH', empty.message, empty.hint);
    return;
  }
  const session = createSession({
    bookId: bookId,
    moduleId: body.moduleId ? String(body.moduleId) : null,
    chapterNs: chapters.map((chapter) => Number(chapter.n)),
    mode: mode,
    count: count,
    plan: plan,
  });
  session.plan = session.plan.filter((item) => !!practiceQuestionOf(bank, item.qid));
  if (!session.plan.length) {
    sendError(res, 'E_QZ_NOT_ENOUGH', '题库里的题不在了', '重新生成一组。');
    return;
  }
  writeSession(bookId, session);
  const questions = session.plan.map((item) => practicePublicQuestion(practiceQuestionOf(bank, item.qid))).filter(Boolean);
  sendJson(res, 200, { ok: true, sessionId: session.session_id, mode: mode, count: questions.length, questions: questions });
}

async function handlePracticeAnswer(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const bookId = String(body.bookId || '').trim();
  const sessionId = String(body.sessionId || '').trim();
  const qid = String(body.qid || '').trim();
  const session = readSession(bookId, sessionId);
  if (!session) {
    sendError(res, 'E_QZ_SESSION', '这一场练习不存在或已过期');
    return;
  }
  if (session.status !== 'running') {
    sendError(res, 'E_QZ_SESSION', '这一场练习已经结束');
    return;
  }
  const plan = (session.plan || []).find((item) => item.qid === qid);
  if (!plan) {
    sendError(res, 'E_QZ_SESSION', '这道题不在本场练习里');
    return;
  }
  const bank = readBank(bookId);
  const question = practiceQuestionOf(bank, qid);
  if (!question) {
    sendError(res, 'E_NOT_FOUND', '题目不存在');
    return;
  }
  const existing = (session.answers || []).find((answer) => answer.qid === qid);
  if (existing) {
    sendJson(res, 200, {
      ok: true,
      correct: existing.correct,
      answer: question.answer,
      explanation: question.explanation_status === 'ready' ? question.explanation : null,
      sourceQuote: question.source_quote,
      anchor: question.source_anchor,
      duplicate: true,
    });
    return;
  }
  appendAnswer(session, question, body.picked, body.elapsedMs);
  const answer = session.answers[session.answers.length - 1];
  const mastery = readMastery(bookId);
  mastery.items[qid] = nextMastery(mastery.items[qid], answer.correct, answer.at);
  writeMastery(bookId, mastery);
  writeSession(bookId, session);
  sendJson(res, 200, {
    ok: true,
    correct: answer.correct,
    answer: question.answer,
    explanation: question.explanation_status === 'ready' ? question.explanation : null,
    sourceQuote: question.source_quote,
    anchor: question.source_anchor,
    anchorStatus: question.anchor_status,
    mastery: mastery.items[qid],
  });
}

async function handlePracticeExplain(req, res, ctx) {
  const body = await readJsonBody(req, 64 * 1024);
  const bookId = String(body.bookId || '').trim();
  const sessionId = String(body.sessionId || '').trim();
  const qid = String(body.qid || '').trim();
  const mode = String(body.mode || 'normal') === 'deep' ? 'deep' : 'normal';
  const session = readSession(bookId, sessionId);
  if (!session) {
    sendError(res, 'E_QZ_SESSION', '这一场练习不存在或已过期');
    return;
  }
  const bank = readBank(bookId);
  const question = practiceQuestionOf(bank, qid);
  if (!question) {
    sendError(res, 'E_NOT_FOUND', '题目不存在');
    return;
  }
  const cacheKey = explainCacheKey(qid, body.picked, mode);
  if (mode === 'deep') {
    const cached = readExplainCache(bookId, cacheKey);
    if (cached) {
      sendJson(res, 200, { ok: true, explanation: cached.text, cached: true, model: cached.model || '' });
      return;
    }
  } else if (question.explanation_status === 'ready' && question.explanation) {
    sendJson(res, 200, { ok: true, explanation: question.explanation, cached: true, model: question.explanation_model || '' });
    return;
  }
  const pagesDir = existingBookDir(bookId);
  const pages = pagesDir ? readJson(path.join(pagesDir, 'pages.json'), []) : [];
  const page = Number(question.source_anchor && question.source_anchor.page) || 0;
  const pageText = page ? String((pages.find((item) => Number(item.page) === page) || {}).text || '') : '';
  const prompt = loadPromptFile('practice-explain-v1.md');
  if (!prompt) {
    sendError(res, 'E_NO_PROMPT', '讲解提示词缺失');
    return;
  }
  if (mode === 'normal') {
    question.explanation_status = 'pending';
    writeBank(bookId, bank);
  }
  let reply;
  try {
    const messages = buildExplainMessages({ prompt: prompt, question: question, picked: body.picked, pageText: pageText });
    reply = await callModel(ctx, messages.system, messages.user, { maxTokens: 2000, timeoutMs: 20000 });
  } catch (err) {
    if (mode === 'normal') {
      question.explanation_status = 'failed';
      writeBank(bookId, bank);
    }
    const timeout = /timeout|abort/i.test(String((err && err.message) || err));
    sendError(
      res,
      timeout ? 'E_QZ_EXPLAIN_TIMEOUT' : 'E_QZ_EXPLAIN_FAILED',
      timeout ? '讲解生成超时' : '讲解生成失败',
      '可以重试，判题结果与原文不受影响。',
    );
    return;
  }
  const text = String((reply && reply.text) || '').trim();
  if (!text) {
    if (mode === 'normal') {
      question.explanation_status = 'failed';
      writeBank(bookId, bank);
    }
    sendError(res, 'E_QZ_EXPLAIN_FAILED', '讲解生成失败', '模型没有返回内容，可以重试。');
    return;
  }
  if (mode === 'deep') {
    writeExplainCache(bookId, cacheKey, text, (reply && reply.model) || '');
  } else {
    applyExplanation(question, text, (reply && reply.model) || '');
    writeBank(bookId, bank);
  }
  sendJson(res, 200, { ok: true, explanation: text, cached: false, model: (reply && reply.model) || '' });
}

async function handlePracticeFinish(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const bookId = String(body.bookId || '').trim();
  const session = readSession(bookId, String(body.sessionId || ''));
  if (!session) {
    sendError(res, 'E_QZ_SESSION', '这一场练习不存在或已过期');
    return;
  }
  finishSession(session);
  writeSession(bookId, session);
  const bank = readBank(bookId);
  const details = (session.answers || []).map((answer) => {
    const question = practiceQuestionOf(bank, answer.qid);
    return {
      qid: answer.qid,
      picked: answer.picked,
      correct: answer.correct,
      stem: question ? question.stem : '',
      options: question ? question.options : [],
      answer: question ? question.answer : [],
      explanation: question && question.explanation_status === 'ready' ? question.explanation : null,
      sourceQuote: question ? question.source_quote : '',
      anchor: question ? question.source_anchor : null,
    };
  });
  sendJson(res, 200, { ok: true, summary: summarizeSession(session), details: details, status: session.status });
}

function handlePracticeSessionGet(req, res) {
  const q = query(req);
  const bookId = String(q.get('bookId') || '').trim();
  const sessionId = String(q.get('sessionId') || '').trim();
  const session = sessionId ? readSession(bookId, sessionId) : latestRunningSession(bookId);
  if (!session) {
    if (!sessionId) {
      sendJson(res, 200, { ok: true, session: null });
      return;
    }
    sendError(res, 'E_QZ_SESSION', '这一场练习不存在或已过期');
    return;
  }
  const bank = readBank(bookId);
  const answeredIds = new Set((session.answers || []).map((answer) => answer.qid));
  const nextIndex = (session.plan || []).findIndex((item) => !answeredIds.has(item.qid));
  const questions = (session.plan || [])
    .map((item) => practiceQuestionOf(bank, item.qid))
    .filter(Boolean)
    .map(practicePublicQuestion);
  sendJson(res, 200, {
    ok: true,
    session: {
      session_id: session.session_id,
      book_id: session.book_id,
      module_id: session.module_id,
      chapters: session.chapters,
      mode: session.mode,
      count: session.count,
      status: session.status,
      created_at: session.created_at,
      finished_at: session.finished_at,
    },
    nextIndex: nextIndex < 0 ? session.plan.length : nextIndex,
    answered: (session.answers || []).map((answer) => ({
      qid: answer.qid,
      picked: answer.picked,
      correct: answer.correct,
      at: answer.at,
    })),
    questions: questions,
  });
}

async function handlePracticeFlag(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const bookId = String(body.bookId || '').trim();
  const qid = String(body.qid || '').trim();
  const bank = readBank(bookId);
  const question = practiceQuestionOf(bank, qid);
  if (!question) {
    sendError(res, 'E_NOT_FOUND', '题目不存在');
    return;
  }
  question.flagged = true;
  question.flag_reason = String(body.reason || '').slice(0, 120);
  question.flagged_at = new Date().toISOString();
  writeBank(bookId, bank);
  sendJson(res, 200, { ok: true, hidden: true });
}

function handlePracticeReview(req, res) {
  const q = query(req);
  const bookId = String(q.get('bookId') || '').trim();
  const loaded = loadBook(bookId);
  if (!loaded) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书');
    return;
  }
  const bank = readBank(bookId);
  const mastery = readMastery(bookId);
  const now = Date.now();
  const due = [];
  const wrong = [];
  for (const question of bank.questions || []) {
    if (question.flagged) continue;
    const state = mastery.items[question.qid];
    if (!state || !Number(state.attempts)) continue;
    const item = Object.assign(practicePublicQuestion(question), {
      box: Number(state.box) || 0,
      due_at: state.due_at || '',
      attempts: Number(state.attempts) || 0,
    });
    if (state.due_at && new Date(state.due_at).getTime() <= now) due.push(item);
    if (String(state.last) === 'wrong' || Number(state.box) === 0) wrong.push(item);
  }
  sendJson(res, 200, { ok: true, due: due, wrong: wrong });
}

function guard(handler) {
  return (req, res) => {
    const headers = (req && req.headers) || {};
    if (isCrossSite(headers)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    Promise.resolve()
      .then(() => handler(req, res, headers))
      .catch((err) => {
        try {
          if (!res.headersSent) sendError(res, 'E_INTERNAL', '服务端出错', String((err && err.message) || err).slice(0, 200));
          else res.end();
        } catch {
          /* 响应已经结束 */
        }
      });
  };
}

function methodIs(req, method) {
  return String((req && req.method) || 'GET').toUpperCase() === method;
}

/** 把 `/chapter-check @测试书籍` 里的参数解析成绝对目录。 */
function resolveCheckDir(ctx, agent, rawInput) {
  const arg = String(rawInput || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!arg) return '';
  if (path.isAbsolute(arg)) return arg;
  let base = '';
  try {
    const session = agent && agent.session;
    const service = ctx.get && ctx.get('workingDirectory');
    if (session && service && typeof service.get === 'function') base = String(service.get(session) || '');
  } catch {
    base = '';
  }
  return path.resolve(base || process.cwd(), arg);
}

/** 启动清理：超过 24 小时的导入暂存（进程被杀会留下半截解压）。 */
function cleanupImportStaging() {
  const dir = path.join(ROOT, '.import');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of names) {
    const target = path.join(dir, name);
    try {
      const stat = fs.statSync(target);
      if (stat.mtimeMs < cutoff) fs.rmSync(target, { recursive: true, force: true });
    } catch {
      /* 正在清理或被占用，下次再说 */
    }
  }
}

export function apply(ctx) {
  ensureRoot();
  try {
    cleanupImportStaging();
  } catch {
    /* 清理失败不挡插件启动 */
  }
  // 上次 DSH 退出时还在跑的作业，重新打开面板要能看到「已中断」而不是永远转圈
  try {
    reconcileAllModules();
  } catch {
    /* 坏模块不能挡插件启动 */
  }
  try {
    reconcileImagingJobs();
  } catch {
    /* 配图作业归一失败也不能挡启动 */
  }
  // 真书对照命令：跑「目录 → 校准」这条路，按严重程度分类报告
  ctx.inject(['commands'], (scoped) => {
    scoped.commands.register({
      name: 'chapter-check',
      description: '真书对照测试：逐章比对书签，按严重程度分类报告（默认按目录切章，末尾加 mech 改测机械切分）',
      input: { hint: '@数据目录 [mech]' },
      handler: async ({ agent, rawInput, signal }) => {
        const raw = String(rawInput || '').trim();
        const mech = /\s+mech\s*$/i.test(raw);
        const arg = mech ? raw.replace(/\s+mech\s*$/i, '') : raw;
        const root = resolveCheckDir(ctx, agent, arg);
        if (!root) {
          return {
            kind: 'error',
            text:
              '用法：/chapter-check @数据目录 [mech]\n' +
              '数据目录放 PDF；【书签】/【目录页码】txt 可以在同一目录，也可以把环境变量 BOOK_SLIDES_TRUTH_DIR 指到仓库的 test/truth（真值已收进仓库，推荐这样用）。',
          };
        }
        const truthDir = String(process.env.BOOK_SLIDES_TRUTH_DIR || '').trim();
        try {
          const result = await runBookCheck(root, { mode: mech ? 'mech' : 'toc', truthDir: truthDir, signal: signal });
          return { kind: result.summary.serious > 0 ? 'error' : 'success', text: result.text };
        } catch (err) {
          return { kind: 'error', text: '跑不起来：' + String((err && err.message) || err) };
        }
      },
    });
  });

  ctx.inject(['webServer'], (scoped) => {
    const offs = [];
    const route = (path, handler) => {
      offs.push(scoped.webServer.register({ kind: 'exact', path: path, handler: guard(handler) }));
    };

    const routeV2 = (req, res) => {
      routeM1(req, res, new URL(req.url || '/', 'http://localhost'), { ctx }).then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      });
    };

    route(ROUTE_BOOKS, routeV2);

    route(ROUTE_META, routeV2);
    route(ROUTE_CHAPTERS_BUILD, routeV2);
    route(ROUTE_TRASH, routeV2);
    route(ROUTE_TRASH_RESTORE, routeV2);
    route(ROUTE_STORAGE, routeV2);

    route(ROUTE_BOOK, routeV2);

    route(ROUTE_IMPORT, routeV2);

    route(ROUTE_RENAME, routeV2);

    route(ROUTE_DELETE, routeV2);

    route(ROUTE_FILE, routeV2);

    route(ROUTE_COVER, routeV2);

    route(ROUTE_REPARSE, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleReparse(req, res);
    });

    route(ROUTE_CHAPTERS, routeV2);

    route(ROUTE_TOC, (req, res) => {
      if (!methodIs(req, 'GET')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      handleTocGet(req, res);
    });

    route(ROUTE_TOC_PREVIEW, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleTocPreview(req, res);
    });

    route(ROUTE_TOC_PARSE, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleTocParse(req, res, ctx);
    });

    route(ROUTE_TOC_RANGE, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleTocRange(req, res);
    });

    route(ROUTE_GENERATE, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleGenerate(req, res, ctx);
    });

    route(ROUTE_JOB, (req, res) => {
      if (!methodIs(req, 'GET')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      handleJob(req, res);
    });

    route(ROUTE_CANCEL, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleCancel(req, res);
    });

    route(ROUTE_MODULE, (req, res) => {
      const method = String((req && req.method) || 'GET').toUpperCase();
      if (method === 'GET') {
        handleModuleGet(req, res);
        return;
      }
      if (method === 'DELETE' || method === 'POST') {
        return handleModuleDelete(req, res);
      }
      res.statusCode = 405;
      res.end();
    });

    route(ROUTE_AUDIO, (req, res) => {
      handleAudio(req, res);
    });

    route(ROUTE_VOICE, (req, res) => {
      if (methodIs(req, 'GET')) {
        handleVoiceGet(req, res);
        return;
      }
      if (methodIs(req, 'POST')) {
        return handleVoicePost(req, res);
      }
      res.statusCode = 405;
      res.end();
    });

    route(ROUTE_VOICE_PROBE, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleVoiceProbe(req, res);
    });

    route(ROUTE_IMAGE, (req, res) => {
      handleImage(req, res);
    });

    route(ROUTE_IMAGE_CONFIG, (req, res) => {
      const method = String((req && req.method) || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'POST') {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleImageConfig(req, res);
    });

    route(ROUTE_IMAGE_WORKFLOW, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleImageWorkflow(req, res);
    });

    route(ROUTE_IMAGE_PROBE, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleImageProbe(req, res);
    });

    route(ROUTE_IMAGE_TEST, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleImageTest(req, res);
    });

    route(ROUTE_IMAGE_STATUS, (req, res) => {
      if (!methodIs(req, 'GET')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      handleImageStatus(req, res);
    });

    route(ROUTE_IMAGE_REGEN, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleImageRegen(req, res);
    });

    route(ROUTE_IMAGE_CANCEL, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleImageCancel(req, res);
    });

    route(ROUTE_PRACTICE_SUMMARY, (req, res) => {
      if (!methodIs(req, 'GET')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      handlePracticeSummary(req, res);
    });

    route(ROUTE_PRACTICE_GENERATE, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handlePracticeGenerate(req, res, ctx);
    });

    route(ROUTE_PRACTICE_JOB, (req, res) => {
      if (!methodIs(req, 'GET')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      handlePracticeJob(req, res);
    });

    route(ROUTE_PRACTICE_SESSION, (req, res) => {
      if (methodIs(req, 'GET')) {
        handlePracticeSessionGet(req, res);
        return;
      }
      if (methodIs(req, 'POST')) {
        return handlePracticeSession(req, res);
      }
      res.statusCode = 405;
      res.end();
    });

    route(ROUTE_PRACTICE_ANSWER, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handlePracticeAnswer(req, res);
    });

    route(ROUTE_PRACTICE_EXPLAIN, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handlePracticeExplain(req, res, ctx);
    });

    route(ROUTE_PRACTICE_FINISH, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handlePracticeFinish(req, res);
    });

    route(ROUTE_PRACTICE_FLAG, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handlePracticeFlag(req, res);
    });

    route(ROUTE_PRACTICE_REVIEW, (req, res) => {
      if (!methodIs(req, 'GET')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      handlePracticeReview(req, res);
    });

    route(ROUTE_PAGES, (req, res) => {
      if (!methodIs(req, 'GET')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      handlePages(req, res);
    });

    route(ROUTE_PROGRESS, (req, res) => {
      if (methodIs(req, 'GET')) {
        handleProgressGet(req, res);
        return;
      }
      if (methodIs(req, 'POST')) {
        return handleProgressPost(req, res);
      }
      res.statusCode = 405;
      res.end();
    });

    route(ROUTE_PREFERENCE, (req, res) => {
      if (methodIs(req, 'GET')) {
        handlePreferenceGet(req, res);
        return;
      }
      if (methodIs(req, 'POST')) {
        return handlePreferencePost(req, res);
      }
      res.statusCode = 405;
      res.end();
    });

    route(ROUTE_TRASH_CLEAR, routeV2);

    route(ROUTE_EXPORT, (req, res) => {
      if (!methodIs(req, 'GET')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleExport(req, res);
    });

    route(ROUTE_EXPORT_SIZE, (req, res) => {
      if (!methodIs(req, 'GET')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleExportSize(req, res);
    });

    route(ROUTE_EXPORT_PPTX_PLAN, (req, res) => {
      if (!methodIs(req, 'GET')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      handlePptxPlan(req, res);
    });

    route(ROUTE_EXPORT_PPTX, (req, res) => {
      if (!methodIs(req, 'GET')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handlePptxExport(req, res);
    });

    route(ROUTE_IMPORT_PACKAGE, (req, res, headers) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleImportPackage(req, res, headers);
    });

    route(ROUTE_REVOICE, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleRevoice(req, res);
    });

    // pdf.js 浏览器产物：前缀路由（worker / cmaps / fonts / wasm 都在这个目录下）
    offs.push(
      scoped.webServer.register({
        kind: 'prefix',
        path: ROUTE_PDFJS_VENDOR,
        handler: guard(handlePdfjsAsset),
      }),
    );

    route(ROUTE_PREFIX + '/storage', (req, res) => {
      handleStorage(req, res);
    });

    ctx.on('dispose', () => {
      for (const off of offs) {
        try {
          off();
        } catch {
          /* 卸载时路由可能已随宿主消失 */
        }
      }
    });
  });
}
