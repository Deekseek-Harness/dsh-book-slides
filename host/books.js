/**
 * 2.0 书库：books/<bookId>/ 的读写。
 * M1 只负责书、页、章、封面、回收站；Part/系列由后续里程碑写入。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { BOOKS_DIR, TRASH_DIR, ensureRoot, readJson, writeJson } from './root.js';
import { coverSvg, hueOf, normalizeHue } from '../lib/cover.js';

const ID_RE = /^[a-z0-9]{8,16}$/;

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

export function newId(len = 12) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function bookDir(bookId) {
  if (!isValidId(bookId)) return null;
  return path.join(BOOKS_DIR(), bookId);
}

export function existingBookDir(bookId) {
  const dir = bookDir(bookId);
  if (!dir) return null;
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
    if (!fs.statSync(path.join(dir, 'book.json')).isFile()) return null;
  } catch {
    return null;
  }
  return dir;
}

export function loadBook(bookId) {
  const dir = existingBookDir(bookId);
  if (!dir) return null;
  const book = readJson(path.join(dir, 'book.json'), null);
  if (!book || typeof book !== 'object') return null;
  const chapters = readJson(path.join(dir, 'chapters.json'), []);
  return {
    dir,
    book,
    chapters: Array.isArray(chapters) ? chapters : [],
    chaptersBuilt: fs.existsSync(path.join(dir, 'chapters.json')),
    cover: fs.existsSync(path.join(dir, 'cover.svg')),
  };
}

export function markOpened(bookId) {
  const loaded = loadBook(bookId);
  if (!loaded) return null;
  const book = loaded.book;
  book.lastOpenedAt = new Date().toISOString();
  writeJson(path.join(loaded.dir, 'book.json'), book);
  return book;
}

export function findBySha(hash, { includeTrash = false } = {}) {
  ensureRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(BOOKS_DIR(), { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidId(entry.name)) continue;
    const book = readJson(path.join(BOOKS_DIR(), entry.name, 'book.json'), null);
    if (book && book.sha256 === hash) return { id: entry.name, title: String(book.title || '') };
  }
  if (includeTrash) {
    for (const item of listTrash()) {
      if (item.sha256 === hash) return { id: item.bookId, title: item.title, trashed: true };
    }
  }
  return null;
}

export function createBook({ buffer, fileName, title, author, pages, rawPages }) {
  ensureRoot();
  const hash = sha256(buffer);
  const dup = findBySha(hash);
  if (dup) {
    const err = new Error('这本书已在书架');
    err.code = 'E_DUP_BOOK';
    err.bookId = dup.id;
    err.title = dup.title;
    err.hint = '直接从书架打开即可。';
    throw err;
  }

  const id = newId(12);
  const dir = bookDir(id);
  if (!dir) {
    const err = new Error('生成书 ID 失败');
    err.code = 'E_BAD_ID';
    throw err;
  }

  const chars = Array.isArray(rawPages)
    ? rawPages.reduce((sum, p) => sum + String((p && p.text) || '').length, 0)
    : 0;
  const now = new Date().toISOString();
  const book = {
    schema: 2,
    id,
    title: String(title || '未命名').slice(0, 120),
    author: String(author || '').slice(0, 80),
    sha256: hash,
    pages: Number(pages) || (Array.isArray(rawPages) ? rawPages.length : 0),
    chars,
    originalName: String(fileName || ''),
    importedAt: now,
    lastOpenedAt: now,
    chaptersBuilt: false,
    chapterSource: null,
    chapterConfidence: null,
    chapterWarnings: null,
    bookmarkTree: null,
    bookmarkRootDepth: null,
    cover: false,
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'source.pdf'), buffer);
    writeJson(path.join(dir, 'pages.json'), Array.isArray(rawPages) ? rawPages : []);
    // book.json 最后写：它存在 = 导入完成
    writeJson(path.join(dir, 'book.json'), book);
  } catch (err) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    const wrapped = new Error('写入失败');
    wrapped.code = 'E_IMPORT_FAILED';
    wrapped.hint = String((err && err.message) || err).slice(0, 200);
    throw wrapped;
  }

  return book;
}

/**
 * 系列概况：卡片要显示「K 个系列」与最近系列（FR-21.1）。
 * 这里直接读 series/<id>/series.json，不 import host/series.js —— 那边依赖 books.js，避免循环引用。
 */
function seriesSummary(bookDir) {
  const root = path.join(bookDir, 'series');
  let ids = [];
  try {
    ids = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return { count: 0, last: null };
  }
  const list = ids
    .map((id) => readJson(path.join(root, id, 'series.json'), null))
    .filter((item) => item && item.id);
  if (!list.length) return { count: 0, last: null };
  list.sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
  const last = list[0];
  return {
    count: list.length,
    last: {
      id: String(last.id),
      title: String(last.title || ''),
      status: String(last.status || ''),
      stitch: String(last.stitch || 'unstitched'),
      voiceStatus: String(last.voice_status || 'none'),
      lectures: (last.lectures || []).length,
      totalPages: Number(last.total_pages) || 0,
    },
  };
}

export function listBooks() {
  ensureRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(BOOKS_DIR(), { withFileTypes: true });
  } catch {
    return [];
  }
  const books = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidId(entry.name)) continue;
    const loaded = loadBook(entry.name);
    if (!loaded) continue;
    const book = loaded.book;
    const chapters = loaded.chapters;
    const series = seriesSummary(loaded.dir);
    books.push({
      id: book.id,
      title: String(book.title || '未命名'),
      author: String(book.author || ''),
      pages: Number(book.pages) || 0,
      chars: Number(book.chars) || 0,
      chapters: loaded.chaptersBuilt ? chapters.length : 0,
      chaptersBuilt: loaded.chaptersBuilt,
      cover: loaded.cover,
      coverUpdatedAt: String(book.coverUpdatedAt || ''),
      seriesCount: series.count,
      lastSeries: series.last,
      sha256: String(book.sha256 || ''),
      importedAt: String(book.importedAt || ''),
      lastOpenedAt: String(book.lastOpenedAt || book.importedAt || ''),
    });
  }
  books.sort((a, b) => String(b.lastOpenedAt).localeCompare(String(a.lastOpenedAt)));
  return books;
}

/**
 * 重命名。卡面下半的书名由 `book.json.title` 驱动，上半的封面标题写死在 cover.svg 里；
 * 这里同时只重排封面的书名，沿用生成时的色相，避免改名把整张封面换掉（FR-21.1）。
 */
export function renameBook(bookId, title) {
  const loaded = loadBook(bookId);
  if (!loaded) return null;
  const next = String(title || '').trim().slice(0, 120);
  if (!next) return null;
  const previousTitle = String(loaded.book.title || '');
  loaded.book.title = next;
  loaded.book.renamedAt = new Date().toISOString();
  if (loaded.cover && next !== previousTitle) {
    try {
      const meta = coverMetaFor(loaded, previousTitle);
      const out = coverMetaOut(loaded.book, { ...meta, title: next });
      fs.writeFileSync(path.join(loaded.dir, 'cover.svg'), coverSvg(out));
      loaded.book.coverMeta = out;
      touchCover(loaded.book);
    } catch {
      /* 封面标题刷新失败不阻断改名；下次「重生成封面」会补上 */
    }
  }
  writeJson(path.join(loaded.dir, 'book.json'), loaded.book);
  return loaded.book;
}

/**
 * 改名重排封面时要沿用的参数。
 * 新封面在 book.json.coverMeta 里留了色相/章数；老封面没有 meta 时，
 * 按生成时的规则（色相 = 旧书名哈希）回退，保证第一次改名也不换色。
 */
function coverMetaFor(loaded, previousTitle) {
  const book = loaded.book || {};
  const stored = book.coverMeta && typeof book.coverMeta === 'object' ? book.coverMeta : null;
  if (stored) {
    const hue = normalizeHue(stored.hue);
    if (hue !== null) {
      return {
        author: String(stored.author || ''),
        chapters: Math.max(0, Math.round(Number(stored.chapters) || 0)),
        hue: hue,
      };
    }
  }
  return {
    author: String(book.author || ''),
    chapters: Array.isArray(loaded.chapters) ? loaded.chapters.length : 0,
    hue: hueOf(previousTitle),
  };
}

/** 归一化后写入 book.json 的封面参数（只含重排书名需要的字段）。 */
function coverMetaOut(book, meta) {
  const source = meta && typeof meta === 'object' ? meta : {};
  const title = String(source.title || (book && book.title) || '');
  const hue = normalizeHue(source.hue);
  return {
    title: title,
    author: String(source.author || ''),
    chapters: Math.max(0, Math.round(Number(source.chapters) || 0)),
    hue: hue === null ? hueOf(title) : hue,
  };
}

export function writeChapters(bookId, chapters, source, confidence, warnings, bookmark) {
  const loaded = loadBook(bookId);
  if (!loaded) return null;
  writeJson(path.join(loaded.dir, 'chapters.json'), chapters);
  const book = loaded.book;
  book.chaptersBuilt = true;
  book.chapterSource = String(source || '');
  if (Number.isFinite(Number(confidence))) {
    book.chapterConfidence = Math.max(0, Math.min(1, Number(confidence)));
  }
  book.chapterWarnings = Array.isArray(warnings)
    ? warnings.filter(Boolean).map((item) => String(item)).slice(0, 20)
    : [];
  book.bookmarkTree = bookmark && Array.isArray(bookmark.tree) ? bookmark.tree : null;
  book.bookmarkRootDepth =
    bookmark && Number.isInteger(bookmark.rootDepth) ? bookmark.rootDepth : null;
  book.chapterCount = chapters.length;
  book.lastOpenedAt = new Date().toISOString();
  writeJson(path.join(loaded.dir, 'book.json'), book);
  return chapters;
}

export function writeCover(bookId, svg, meta) {
  const loaded = loadBook(bookId);
  if (!loaded) return null;
  fs.writeFileSync(path.join(loaded.dir, 'cover.svg'), String(svg || ''));
  const book = loaded.book;
  book.cover = true;
  touchCover(book);
  if (meta && typeof meta === 'object') book.coverMeta = coverMetaOut(book, meta);
  writeJson(path.join(loaded.dir, 'book.json'), book);
  return true;
}

/** 封面版本单调递增到毫秒：同一毫秒内连续改名/重生成也能换掉卡面的缓存 URL。 */
function touchCover(book) {
  const previous = Date.parse(book.coverUpdatedAt || '') || 0;
  book.coverUpdatedAt = new Date(Math.max(Date.now(), previous + 1)).toISOString();
}

export function readCover(bookId) {
  const loaded = loadBook(bookId);
  if (!loaded || !loaded.cover) return null;
  try {
    return fs.readFileSync(path.join(loaded.dir, 'cover.svg'));
  } catch {
    return null;
  }
}

/* ------------------------------ 回收站 ------------------------------ */

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function trashBook(bookId) {
  const loaded = loadBook(bookId);
  if (!loaded) return false;
  ensureRoot();
  const target = path.join(TRASH_DIR(), bookId + '-' + stamp());
  fs.renameSync(loaded.dir, target);
  return true;
}

export function listTrash() {
  ensureRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(TRASH_DIR(), { withFileTypes: true });
  } catch {
    return [];
  }
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(TRASH_DIR(), entry.name);
    const book = readJson(path.join(full, 'book.json'), null);
    if (!book) continue;
    items.push({
      trashId: entry.name,
      bookId: String(book.id || ''),
      title: String(book.title || '未命名'),
      author: String(book.author || ''),
      pages: Number(book.pages) || 0,
      sha256: String(book.sha256 || ''),
      trashedAt: String(book.trashedAt || entry.name.slice(-24)),
    });
  }
  items.sort((a, b) => String(b.trashedAt).localeCompare(String(a.trashedAt)));
  return items;
}

export function restoreBook(bookId) {
  ensureRoot();
  const candidates = listTrash().filter((item) => item.bookId === bookId);
  if (!candidates.length) {
    const err = new Error('回收站里找不到这本书');
    err.code = 'E_NOT_FOUND';
    throw err;
  }
  const item = candidates[0];
  const source = path.join(TRASH_DIR(), item.trashId);
  const existing = findBySha(item.sha256);
  if (existing) {
    const err = new Error('书架已有同一本书');
    err.code = 'E_BOOK_EXISTS';
    err.bookId = existing.id;
    err.title = existing.title;
    throw err;
  }
  const target = bookDir(bookId);
  if (!target) {
    const err = new Error('书 ID 非法');
    err.code = 'E_BAD_ID';
    throw err;
  }
  if (fs.existsSync(target)) {
    const err = new Error('目标书 ID 已被占用');
    err.code = 'E_BOOK_EXISTS';
    throw err;
  }
  fs.renameSync(source, target);
  const loaded = loadBook(bookId);
  if (loaded) {
    const book = loaded.book;
    book.lastOpenedAt = new Date().toISOString();
    delete book.trashedAt;
    writeJson(path.join(loaded.dir, 'book.json'), book);
    return book;
  }
  return null;
}

export function clearTrash() {
  ensureRoot();
  const stats = { count: 0, bytes: 0 };
  let entries = [];
  try {
    entries = fs.readdirSync(TRASH_DIR(), { withFileTypes: true });
  } catch {
    return stats;
  }
  for (const entry of entries) {
    const full = path.join(TRASH_DIR(), entry.name);
    if (!entry.isDirectory()) continue;
    stats.count += 1;
    stats.bytes += dirSize(full);
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  return stats;
}

export function dirSize(dir) {
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
      else {
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

export function storageStats() {
  ensureRoot();
  const trash = listTrash();
  return {
    root: BOOKS_DIR() ? path.dirname(BOOKS_DIR()) : '',
    bytes: dirSize(path.dirname(BOOKS_DIR())),
    trashBytes: trash.reduce((sum, item) => sum + dirSize(path.join(TRASH_DIR(), item.trashId)), 0),
    trashCount: trash.length,
  };
}
