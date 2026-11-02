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
import { coverSvg } from './cover.js';

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
  const chapters = buildChapters(cleanPages(rawPages));
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

export function apply(ctx) {
  ensureDirs();
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
