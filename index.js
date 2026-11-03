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
  TRASH_DIR,
  bookDir,
  dirSize,
  ensureDirs,
  existingBookDir,
  listBooks,
  loadBook,
  markOpened,
  moduleIds,
  newId,
  readJson,
  renameBook,
  sha256Of,
  trashBook,
  writeJson,
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
import { runBookCheck } from './check.js';

const require = createRequire(import.meta.url);
const PKG = require('./package.json');
export const PLUGIN_VERSION = String((PKG && PKG.version) || '0.1.0');

export const ROUTE_PREFIX = '/dsh-book-slides';
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
  const modules = moduleIds(bookId);
  sendJson(res, 200, {
    ok: true,
    book: loaded.book,
    chapters: loaded.chapters,
    modules: modules,
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
  if (!trashBook(bookId)) {
    sendError(res, 'E_NOT_FOUND', '找不到这本书', '');
    return;
  }
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
let promptCache = null;

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

/** 提示词文件读一次就记住；开头那段「版本说明」对模型没用，切掉。 */
function loadPrompt() {
  if (promptCache !== null) return promptCache;
  try {
    const raw = fs.readFileSync(path.join(PROMPT_DIR, 'toc-extract-v1.md'), 'utf8');
    const cut = raw.indexOf('## 角色');
    promptCache = cut >= 0 ? raw.slice(cut) : raw;
  } catch {
    promptCache = '';
  }
  return promptCache;
}

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

/** 调一次模型，把增量拼成整段文本；顺带记下结束原因，供「为什么没 JSON」用。 */
async function callModel(ctx, system, user, maxTokens) {
  const llm = ctx.get ? ctx.get('llm') : null;
  if (!llm || typeof llm.prepareCall !== 'function') throw new Error('这个 DSH 里没有可用的模型服务');
  const target = resolveModel(ctx);
  const budget = Number(maxTokens) > 0 ? Number(maxTokens) : TOC_MAX_TOKENS;
  const signal = AbortSignal.timeout(TOC_CALL_TIMEOUT_MS);
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

  const prompt = loadPrompt();
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
  let trashCount = 0;
  try {
    trashCount = fs.readdirSync(TRASH_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  } catch {
    trashCount = 0;
  }
  sendJson(res, 200, {
    ok: true,
    dataRoot: ROOT,
    bytes: dirSize(ROOT),
    trashCount: trashCount,
    pluginVersion: PLUGIN_VERSION,
  });
}

/* ------------------------------ 注册 ------------------------------ */

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

export function apply(ctx) {
  ensureDirs();
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
        if (!root) return { kind: 'error', text: '用法：/chapter-check @数据目录（目录里放 PDF + 【书签】txt + 【目录页码】txt；末尾加 mech 测机械切分）' };
        try {
          const result = await runBookCheck(root, { mode: mech ? 'mech' : 'toc', signal: signal });
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

    route(ROUTE_BOOKS, (req, res) => {
      if (!methodIs(req, 'GET')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      handleBooks(req, res);
    });

    route(ROUTE_BOOK, (req, res) => {
      if (!methodIs(req, 'GET')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      handleBook(req, res);
    });

    route(ROUTE_IMPORT, (req, res, headers) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleImport(req, res, headers);
    });

    route(ROUTE_RENAME, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleRename(req, res);
    });

    route(ROUTE_DELETE, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleDelete(req, res);
    });

    route(ROUTE_FILE, (req, res) => {
      handleFile(req, res);
    });

    route(ROUTE_COVER, (req, res) => {
      handleCover(req, res);
    });

    route(ROUTE_REPARSE, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleReparse(req, res);
    });

    route(ROUTE_CHAPTERS, (req, res) => {
      if (!methodIs(req, 'POST')) {
        res.statusCode = 405;
        res.end();
        return;
      }
      return handleChapters(req, res);
    });

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
