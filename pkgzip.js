/**
 * 精讲台 · ZIP 读写
 *
 * 只做两件事：把文件写进一个 ZIP 流；把一个受限的 ZIP 解开。
 * 所有安全判定（路径穿越、符号链接、炸弹、条目数）都在这里，上层 package.js 不再重复。
 *
 * 为什么不用 `addReadStream`：yazl 的 `addFile` 自己 stat + createReadStream，
 * 一次只开一个文件句柄，正好对上「≤ 4 GiB 包也不爆内存」的要求。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import yauzl from 'yauzl';

export const ZIP_LIMITS = {
  maxEntries: 10000,
  maxNameBytes: 200,
  maxEntryBytes: 4 * 1024 ** 3,
  maxUncompressedBytes: 8 * 1024 ** 3,
  maxCompressionRatio: 100,
  ratioCheckFloorBytes: 1024 * 1024,
};

/** 已经压缩过的格式：原样存（store），别再烧 CPU。 */
export function isStoredName(name) {
  return /\.(pdf|wav|mp3|zip)$/i.test(String(name || ''));
}

export class ZipError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
    this.hint = hint || '';
  }
}

function corrupt(detail) {
  return new ZipError('E_PKG_CORRUPT', '书档已损坏，可能在传输中被截断', String(detail || '').slice(0, 200));
}

function unsafe(detail) {
  return new ZipError('E_PKG_UNSAFE', '书档内含不安全的路径，已拒绝', String(detail || '').slice(0, 200));
}

/** yauzl 自己也会拦 `../`（invalid relative path），别把它算成「包坏了」。 */
function zipFailure(err) {
  const message = String((err && err.message) || err);
  if (/invalid relative path|absolute path|invalid characters|invalid file name/i.test(message)) {
    return unsafe(message);
  }
  return corrupt(message);
}

/**
 * CRC32 增量计算。yauzl 明确「不做 CRC 校验」，所以音频这种没被 sha256 覆盖的
 * 数据只能靠这里兜底；Node 22+ 有原生 zlib.crc32，老版本退回查表。
 */
const HAS_NATIVE_CRC = typeof zlib.crc32 === 'function';
let CRC_TABLE = null;
function jsCrc32(buffer, previous) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = ((Number(previous) || 0) ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function crc32(buffer, previous) {
  return HAS_NATIVE_CRC ? zlib.crc32(buffer, Number(previous) || 0) >>> 0 : jsCrc32(buffer, previous);
}

class Crc32Check extends Transform {
  constructor(expected) {
    super();
    this.value = 0;
    this.expected = Number(expected) >>> 0;
  }

  _transform(chunk, encoding, callback) {
    this.value = crc32(chunk, this.value);
    callback(null, chunk);
  }

  _flush(callback) {
    if (this.value !== this.expected) {
      callback(new ZipError('E_PKG_CORRUPT', '书档内有文件校验失败（CRC32 不一致）', '可能在传输中被截断'));
      return;
    }
    callback();
  }
}

/**
 * 条目名校验：只接受「/ 分隔的相对路径」。
 * 挡掉 `..`、盘符、UNC、反斜杠、空段、符号链接。
 */
export function inspectEntryName(rawName) {
  const raw = String(rawName || '');
  if (!raw) throw unsafe('空文件名');
  if (/\\/.test(raw)) throw unsafe(raw);
  if (/^\/|^[A-Za-z]:/.test(raw)) throw unsafe(raw);
  if (Buffer.byteLength(raw, 'utf8') > ZIP_LIMITS.maxNameBytes) throw unsafe('文件名过长');
  const isDir = raw.endsWith('/');
  const name = isDir ? raw.slice(0, -1) : raw;
  if (!name) throw unsafe(raw);
  const parts = name.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') throw unsafe(raw);
  }
  return { name, isDir };
}

function inspectEntry(entry) {
  const { name, isDir } = inspectEntryName(entry.fileName);
  const mode = (Number(entry.externalFileAttributes) >>> 16) & 0o170000;
  if (mode === 0o120000) throw unsafe('符号链接：' + name);
  const size = Number(entry.uncompressedSize) || 0;
  const compressed = Number(entry.compressedSize) || 0;
  if (size > ZIP_LIMITS.maxEntryBytes) {
    throw new ZipError('E_PKG_TOO_LARGE', '书档里有单个文件超过 4 GiB', name);
  }
  if (
    size > ZIP_LIMITS.ratioCheckFloorBytes &&
    compressed > 0 &&
    size / compressed > ZIP_LIMITS.maxCompressionRatio
  ) {
    throw new ZipError('E_PKG_TOO_LARGE', '书档压缩比异常，疑似压缩炸弹', name);
  }
  return { name, isDir, size, compressed };
}

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true },
      (err, zipfile) => {
        if (err) {
          reject(new ZipError('E_PKG_NOT_ZIP', '这个文件不是 ZIP 书档', String((err && err.message) || err).slice(0, 200)));
          return;
        }
        resolve(zipfile);
      },
    );
  });
}

/**
 * 只读中央目录：返回全部条目元信息与解压后总字节数。
 * 这一步就要把路径、条目数、体积、压缩比全部判掉，后面才允许解压。
 */
export async function inspectZip(zipPath) {
  const zipfile = await openZip(zipPath);
  return new Promise((resolve, reject) => {
    const entries = [];
    let total = 0;
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try {
        zipfile.close();
      } catch {
        /* 已经关了 */
      }
      if (err) reject(err);
      else resolve(value);
    };
    zipfile.on('error', (err) => finish(zipFailure(err)));
    zipfile.on('end', () => {
      if (settled) return;
      finish(null, { entries, totalBytes: total });
    });
    zipfile.on('entry', (entry) => {
      if (settled) return;
      let info;
      try {
        info = inspectEntry(entry);
      } catch (err) {
        finish(err);
        return;
      }
      entries.push(info);
      if (!info.isDir) total += info.size;
      if (entries.length > ZIP_LIMITS.maxEntries) {
        finish(new ZipError('E_PKG_TOO_LARGE', '书档条目太多', String(entries.length)));
        return;
      }
      if (total > ZIP_LIMITS.maxUncompressedBytes) {
        finish(new ZipError('E_PKG_TOO_LARGE', '书档解压后体积过大', String(total)));
        return;
      }
      zipfile.readEntry();
    });
    zipfile.readEntry();
  });
}

/** 读单个条目到内存（只给 manifest 这种小文件用）。找不到返回 null。 */
export async function readEntryBuffer(zipPath, wanted, maxBytes) {
  const zipfile = await openZip(zipPath);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      try {
        zipfile.close();
      } catch {
        /* 已经关了 */
      }
      if (err) reject(err);
      else resolve(value);
    };
    zipfile.on('error', (err) => finish(zipFailure(err)));
    zipfile.on('end', () => finish(null, null));
    zipfile.on('entry', (entry) => {
      if (settled) return;
      let info;
      try {
        info = inspectEntry(entry);
      } catch (err) {
        finish(err);
        return;
      }
      if (info.name !== wanted) {
        zipfile.readEntry();
        return;
      }
      const chunks = [];
      let size = 0;
      zipfile.openReadStream(entry, (err, stream) => {
        if (err) {
          finish(corrupt(err && err.message));
          return;
        }
        stream.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            stream.destroy();
            finish(new ZipError('E_PKG_TOO_LARGE', '书档清单过大', wanted));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('error', (streamErr) => finish(corrupt(streamErr && streamErr.message)));
        stream.on('end', () => finish(null, Buffer.concat(chunks)));
      });
    });
    zipfile.readEntry();
  });
}

/**
 * 解压白名单条目到 destRoot。目录条目只用来建目录，不写文件。
 * 串行解压（一次一个 stream），避免 GB 级条目同时占句柄与磁盘队列。
 */
export async function extractEntries(zipPath, destRoot, accept) {
  const zipfile = await openZip(zipPath);
  const root = path.resolve(destRoot);
  await fs.promises.mkdir(root, { recursive: true });
  const extracted = [];
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      try {
        zipfile.close();
      } catch {
        /* 已经关了 */
      }
      if (err) reject(err);
      else resolve({ extracted });
    };

    const handle = async (entry) => {
      let info;
      try {
        info = inspectEntry(entry);
      } catch (err) {
        finish(err);
        return;
      }
      if (info.isDir || (typeof accept === 'function' && !accept(info.name))) {
        zipfile.readEntry();
        return;
      }
      const target = path.resolve(root, ...info.name.split('/'));
      if (target !== root && !target.startsWith(root + path.sep)) {
        finish(unsafe(info.name));
        return;
      }
      try {
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const stream = await new Promise((res, rej) => {
          zipfile.openReadStream(entry, (err, opened) => (err ? rej(corrupt(err && err.message)) : res(opened)));
        });
        await pipeline(stream, new Crc32Check(entry.crc32), fs.createWriteStream(target));
        extracted.push(info.name);
        zipfile.readEntry();
      } catch (err) {
        finish(err instanceof ZipError ? err : corrupt(err && err.message));
      }
    };

    zipfile.on('error', (err) => finish(zipFailure(err)));
    zipfile.on('end', () => finish(null));
    zipfile.on('entry', (entry) => {
      if (settled) return;
      handle(entry);
    });
    zipfile.readEntry();
  });
}

/** 流式写包。addFile 缺文件会在流开始后炸，所以调用方必须先 stat 预检。 */
export class ZipWriter {
  constructor() {
    this.zip = new yazl.ZipFile();
    this.count = 0;
    this.closed = false;
  }

  addBuffer(buffer, name, options) {
    const opts = options || {};
    this.zip.addBuffer(buffer, name, {
      compress: opts.compress !== false,
      mtime: opts.mtime || new Date(),
    });
    this.count += 1;
  }

  addFile(realPath, name) {
    const stat = fs.statSync(realPath);
    this.zip.addFile(realPath, name, {
      compress: !isStoredName(name),
      mtime: stat.mtime,
    });
    this.count += 1;
  }

  end() {
    if (this.closed) throw new Error('ZIP 已经结束');
    this.closed = true;
    this.zip.end();
    return this.zip.outputStream;
  }
}
