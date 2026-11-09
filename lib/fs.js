/**
 * 共享文件层（2.x）
 *
 * 数据根解析、原子写、JSON 读写、id 校验与书目录定位。
 * host/root.js 与共享模块（tts/comfy/practice）都从这里取，
 * 避免 1.x 的 store.js 与 2.0 root.js 各维护一份 resolveRoot/readJson/writeJson。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/** bookId / moduleId 的合法形状；拼路径前必须先过这一关，挡掉 `../`。 */
const ID_RE = /^[a-z0-9]{8,16}$/;

/** 数据根：显式环境变量 > DSH_HOME > ~/.dsh。 */
export function resolveRoot() {
  const explicit = String(process.env.DSH_BOOK_SLIDES_ROOT || '').trim();
  if (explicit !== '') return path.resolve(explicit);
  const home = String(process.env.DSH_HOME || '').trim();
  return path.join(home !== '' ? home : path.join(os.homedir(), '.dsh'), 'book-slides');
}

export const ROOT = resolveRoot();

export function isValidId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/** 12 位小写字母数字：够短、可读、不会撞上路径分隔符。 */
export function newId(len = 12) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
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
        /* ignore */
      }
    }
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function writeJson(file, value) {
  writeAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const text = raw.replace(/^\uFEFF/, '');
    if (!text.trim()) return fallback;
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function sha256Of(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** 书的目录（不校验存在性，导入中途要往不存在的目录里写）。 */
export function bookDir(bookId) {
  if (!isValidId(bookId)) return null;
  return path.join(ROOT, 'books', bookId);
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
