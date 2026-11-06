/**
 * 2.0 数据根：同根、schema=2、旧 schema 自动备份。
 *
 * 规则见 doc/requirements/规范需求2.0.md FR-20 / §6.1：
 * - 根目录固定 ~/.dsh/book-slides/，可用 DSH_BOOK_SLIDES_ROOT 覆盖；
 * - meta.json.schema=2 是唯一标记；
 * - 根非空且 schema≠2 时，整根原子重命名到同父目录 book-slides.backup-<时间>/，
 *   再在原路径重建 2.0 数据；备份失败则中止，原根保持不动。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export class UpgradeError extends Error {
  constructor(code, message, hint, cause) {
    super(message);
    this.name = 'UpgradeError';
    this.code = code;
    this.hint = hint || '';
    this.cause = cause;
  }
}

export function resolveRoot() {
  const explicit = String(process.env.DSH_BOOK_SLIDES_ROOT || '').trim();
  if (explicit !== '') return path.resolve(explicit);
  const home = String(process.env.DSH_HOME || '').trim();
  return path.join(home !== '' ? home : path.join(os.homedir(), '.dsh'), 'book-slides');
}

export const ROOT = resolveRoot();
export const BOOKS_DIR = () => path.join(ROOT, 'books');
export const TRASH_DIR = () => path.join(ROOT, 'trash');
export const META_FILE = () => path.join(ROOT, 'meta.json');

export function packageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return String(pkg.version || '');
  } catch {
    return '';
  }
}

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

function dirHasEntries(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function dirFileStats(dir) {
  let files = 0;
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
      else if (entry.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

function backupTarget(root) {
  const parent = path.dirname(root);
  const base = path.basename(root) + '.backup-' + stamp();
  let candidate = path.join(parent, base);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, base + '-' + n);
    n += 1;
  }
  return candidate;
}

function ensureLayout() {
  fs.mkdirSync(BOOKS_DIR(), { recursive: true });
  fs.mkdirSync(TRASH_DIR(), { recursive: true });
}

function writeMeta(extra) {
  writeJson(META_FILE(), {
    schema: 2,
    product_version: '2.0',
    app_version: packageVersion(),
    created_at: new Date().toISOString(),
    ...(extra || {}),
  });
}

/**
 * 确保根存在且为 schema=2。
 * @returns {{root:string, meta:object, backup:string|null, upgraded:boolean}}
 */
export function ensureRoot() {
  const root = ROOT;
  const meta = readJson(META_FILE(), null);

  if (meta && meta.schema === 2) {
    ensureLayout();
    return { root, meta, backup: null, upgraded: false };
  }

  const existed = fs.existsSync(root);
  const nonEmpty = existed && dirHasEntries(root);

  if (!nonEmpty) {
    fs.mkdirSync(root, { recursive: true });
    ensureLayout();
    writeMeta();
    return { root, meta: readJson(META_FILE(), {}), backup: null, upgraded: false };
  }

  const target = backupTarget(root);
  try {
    fs.renameSync(root, target);
  } catch (err) {
    throw new UpgradeError(
      'E_UPGRADE_BACKUP_FAILED',
      '旧数据备份失败，升级已中止',
      '请检查数据目录权限与磁盘空间后重试。',
      err,
    );
  }

  const copied = dirFileStats(target);
  if (copied.files === 0 || copied.bytes === 0) {
    // 备份不可信：恢复原根，绝不覆盖
    try {
      if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
      fs.renameSync(target, root);
    } catch {
      /* 恢复失败时保留 backup 路径，至少数据还在 */
    }
    throw new UpgradeError(
      'E_UPGRADE_BACKUP_FAILED',
      '旧数据备份校验失败，升级已中止',
      '备份文件为空或不可读；原数据未迁移。',
    );
  }

  fs.mkdirSync(root, { recursive: true });
  ensureLayout();
  writeMeta({ upgraded_from: path.basename(target), backup_at: new Date().toISOString() });
  return { root, meta: readJson(META_FILE(), {}), backup: target, upgraded: true };
}

export function getMeta() {
  return readJson(META_FILE(), null) || {};
}
