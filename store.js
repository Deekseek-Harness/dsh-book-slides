/**
 * 精讲台 · 存储层
 *
 * 所有数据都在本机，目录布局见《规范需求.md》5.1：
 *   <root>/books/<bookId>/book.json        ← 书名、页数、sha256（存在即导入完成）
 *   <root>/books/<bookId>/source.pdf       ← 原件副本
 *   <root>/books/<bookId>/pages.json       ← 逐页文本（未清洗）
 *   <root>/books/<bookId>/chapters.json    ← 章节切分结果
 *   <root>/books/<bookId>/modules/<id>/    ← 精讲模块（M3）
 *   <root>/trash/<bookId>/                 ← 软删除
 *
 * 这个文件只做「怎么放」，不碰 PDF 解析，也不认识 HTTP。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/** bookId / moduleId 的合法形状；拼路径前必须先过这一关，挡掉 `../`。 */
const ID_RE = /^[a-z0-9]{8,16}$/;

/** 数据根：显式环境变量 > DSH_HOME > ~/.dsh。测试用第一个。 */
export function resolveRoot() {
  const explicit = String(process.env.DSH_BOOK_SLIDES_ROOT || '').trim();
  if (explicit !== '') return path.resolve(explicit);
  const home = String(process.env.DSH_HOME || '').trim();
  return path.join(home !== '' ? home : path.join(os.homedir(), '.dsh'), 'book-slides');
}

export const ROOT = resolveRoot();
export const BOOKS_DIR = path.join(ROOT, 'books');
export const TRASH_DIR = path.join(ROOT, 'trash');
export const PREF_FILE = path.join(ROOT, 'preference.json');

/** 建目录：幂等，任何读之前都可以调。 */
export function ensureDirs() {
  fs.mkdirSync(BOOKS_DIR, { recursive: true });
  fs.mkdirSync(TRASH_DIR, { recursive: true });
}

/** 12 位小写字母数字：够短、可读、不会撞上路径分隔符。 */
export function newId(len = 12) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/**
 * 原子写：先写同目录临时文件并 fsync，再 rename 覆盖。
 * 中途断电只会留下一个 .tmp，不会留下半截 JSON。
 */
export function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.tmp';
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 关不掉也没别的办法 */
      }
    }
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 临时文件清不掉不影响结果 */
    }
    throw err;
  }
}

export function writeText(file, text) {
  writeAtomic(file, String(text == null ? '' : text));
}

export function writeJson(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 书的目录（不校验存在性，导入中途要往不存在的目录里写）。 */
export function bookDir(bookId) {
  if (!isValidId(bookId)) return null;
  return path.join(BOOKS_DIR, bookId);
}

/** 已导入的书目录；不存在或不合法一律 null。 */
export function existingBookDir(bookId) {
  const dir = bookDir(bookId);
  if (!dir) return null;
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  if (!fs.existsSync(path.join(dir, 'book.json'))) return null;
  return dir;
}

export function loadBook(bookId) {
  const dir = existingBookDir(bookId);
  if (!dir) return null;
  const book = readJson(path.join(dir, 'book.json'), null);
  if (!book || typeof book !== 'object') return null;
  const chapters = readJson(path.join(dir, 'chapters.json'), []);
  return { dir: dir, book: book, chapters: Array.isArray(chapters) ? chapters : [] };
}

/** 模块目录列表（M3 才写内容，M1 只数个数）。 */
export function moduleIds(bookId) {
  const dir = existingBookDir(bookId);
  if (!dir) return [];
  const modulesDir = path.join(dir, 'modules');
  let names = [];
  try {
    names = fs.readdirSync(modulesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return names.filter((n) => isValidId(n));
}

/** 书架：扫目录，读 book.json，按最近打开排序。 */
export function listBooks() {
  ensureDirs();
  let entries = [];
  try {
    entries = fs.readdirSync(BOOKS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const books = [];
  for (const id of entries) {
    if (!isValidId(id)) continue;
    const dir = path.join(BOOKS_DIR, id);
    const book = readJson(path.join(dir, 'book.json'), null);
    if (!book || typeof book !== 'object') continue;
    books.push({
      id: id,
      title: String(book.title || '未命名'),
      author: String(book.author || ''),
      pages: Number(book.pages) || 0,
      chapters: Number(book.chapterCount) || 0,
      modules: moduleIds(id).length,
      chars: Number(book.chars) || 0,
      importedAt: String(book.importedAt || ''),
      lastOpenedAt: String(book.lastOpenedAt || book.importedAt || ''),
    });
  }
  books.sort((a, b) => String(b.lastOpenedAt).localeCompare(String(a.lastOpenedAt)));
  return books;
}

/** 打开过的书排前面，靠这一个字段。 */
export function markOpened(bookId) {
  const dir = existingBookDir(bookId);
  if (!dir) return;
  const file = path.join(dir, 'book.json');
  const book = readJson(file, null);
  if (!book || typeof book !== 'object') return;
  book.lastOpenedAt = new Date().toISOString();
  writeJson(file, book);
}

export function renameBook(bookId, title) {
  const dir = existingBookDir(bookId);
  if (!dir) return null;
  const file = path.join(dir, 'book.json');
  const book = readJson(file, null);
  if (!book || typeof book !== 'object') return null;
  book.title = title;
  book.renamedAt = new Date().toISOString();
  writeJson(file, book);
  return book;
}

/**
 * 软删除：整本挪进 trash/，书库里立刻消失。
 * 目录名后面缀时间戳，同一本删两次也不会互相覆盖。
 */
export function trashBook(bookId) {
  const dir = existingBookDir(bookId);
  if (!dir) return false;
  ensureDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(TRASH_DIR, bookId + '-' + stamp);
  fs.renameSync(dir, target);
  return true;
}

/** 目录占用（递归求和），设置页要用。 */
export function dirSize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* 读不到就当 0 */
      }
    }
  }
  return total;
}

export function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
