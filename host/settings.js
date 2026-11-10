/**
 * 2.0 设置与运维（FR-21.5）：设置首屏、存储概况、升级备份、诊断。
 *
 * 隐私边界：诊断只取错误码与长度，不含正文；语音 Key 永远不出现在这里。
 * 备份目录在数据根的**同父目录**（book-slides.backup-<时间>/），只允许列出与删除这一族目录，
 * 不碰父目录里的其它东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { META_FILE, ROOT, getMeta, packageVersion, PRODUCT_VERSION, readJson } from './root.js';
import { storageStats, dirSize } from './books.js';
import { recentErrors } from './errors.js';
import { resolveModel } from './llm.js';
import { readVoiceConfig } from '../lib/tts.js';
import { refTablePayload, workflowPayload } from './comfy-clone.js';

const require = createRequire(import.meta.url);
const PLUGIN_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function backupPrefix() {
  return path.basename(ROOT) + '.backup-';
}

function parseStamp(name) {
  const match = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?$/.exec(String(name));
  if (!match) return '';
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function countFiles(dir) {
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

function mtimeIso(target) {
  try {
    return fs.statSync(target).mtime.toISOString();
  } catch {
    return '';
  }
}

/** 同父目录下的升级备份；按时间倒序。 */
export function listBackups() {
  const parent = path.dirname(ROOT);
  const prefix = backupPrefix();
  let entries = [];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const full = path.join(parent, entry.name);
    const stats = countFiles(full);
    out.push({
      name: entry.name,
      path: full,
      bytes: stats.bytes,
      files: stats.files,
      createdAt: parseStamp(entry.name) || mtimeIso(full),
    });
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

/** 只认 `book-slides.backup-*` 这一族目录名，避免删到别的东西。 */
export function backupPath(name) {
  const wanted = String(name || '').trim();
  if (!wanted || wanted !== path.basename(wanted)) return null;
  if (!wanted.startsWith(backupPrefix())) return null;
  const full = path.join(path.dirname(ROOT), wanted);
  if (path.resolve(path.dirname(full)) !== path.resolve(path.dirname(ROOT))) return null;
  return full;
}

function requireBackup(name) {
  const full = backupPath(name);
  if (!full) {
    const err = new Error('备份目录名不合法');
    err.code = 'E_BAD_ID';
    throw err;
  }
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    const err = new Error('找不到这个备份');
    err.code = 'E_NOT_FOUND';
    throw err;
  }
  if (!stat.isDirectory()) {
    const err = new Error('备份目录不合法');
    err.code = 'E_BAD_ID';
    throw err;
  }
  return full;
}

export function deleteBackup(name) {
  const full = requireBackup(name);
  const bytes = dirSize(full);
  fs.rmSync(full, { recursive: true, force: true });
  return { removed: String(name), bytes };
}

/** 用系统文件管理器打开备份目录；失败不报错，返回 opened:false 让面板只显示路径。 */
export function openBackup(name) {
  const full = requireBackup(name);
  // 测试/无人值守环境不真的拉起文件管理器窗口
  if (String(process.env.DSH_BOOK_SLIDES_NO_OPEN || '') === '1') {
    return { path: full, opened: false };
  }
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  let opened = false;
  try {
    const child = spawn(command, [full], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {});
    child.unref();
    opened = true;
  } catch {
    opened = false;
  }
  return { path: full, opened };
}

function moduleVersion(name) {
  const candidates = [
    path.join(PLUGIN_DIR, 'node_modules', name, 'package.json'),
    path.join(process.cwd(), 'node_modules', name, 'package.json'),
  ];
  try {
    candidates.unshift(require.resolve(name + '/package.json'));
  } catch {
    /* 依赖被提升到别处时退回路径候选 */
  }
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (pkg && pkg.version) return String(pkg.version);
    } catch {
      /* 试下一个 */
    }
  }
  return '';
}

function dshVersion() {
  const explicit = String(process.env.DSH_VERSION || process.env.DSH_PACKAGE_VERSION || '').trim();
  if (explicit) return explicit;
  return moduleVersion('@deepseek-ai/dsh');
}

/** 设置首屏：数据根、占用、回收站、备份、只读模型、版本。 */
export function settingsPayload(ctx) {
  const storage = storageStats();
  let model = null;
  try {
    const resolved = resolveModel(ctx);
    model = { provider: resolved.provider, model: resolved.model, label: resolved.provider + ' / ' + resolved.model };
  } catch {
    model = null;
  }
  const meta = getMeta();
  return {
    root: storage.root,
    dataRoot: storage.root,
    bytes: storage.bytes,
    trashBytes: storage.trashBytes,
    trashCount: storage.trashCount,
    backups: listBackups(),
    model: model,
    modelNote: model ? '当前使用 DSH 默认模型（只读）' : 'DSH 还没有选好默认模型',
    version: packageVersion(),
    productVersion: PRODUCT_VERSION,
    schema: Number(meta.schema) || 2,
  };
}

/** 诊断：版本 + schema + pdfjs + 最近错误（不含正文）。 */
export function diagnosticsPayload() {
  const meta = getMeta();
  const voiceConfig = readVoiceConfig();
  let workflow = null;
  let voiceTable = null;
  try {
    const info = workflowPayload();
    workflow = { name: info.name, source: info.source, format: info.format, textNode: info.textNode, valid: info.valid };
  } catch {
    workflow = null;
  }
  try {
    const table = refTablePayload();
    voiceTable = { name: table.name, model: table.model, source: table.source, count: table.count };
  } catch {
    voiceTable = null;
  }
  return {
    version: packageVersion(),
    productVersion: PRODUCT_VERSION,
    schema: Number(meta.schema) || 2,
    dataRoot: ROOT,
    metaFile: META_FILE(),
    dshVersion: dshVersion() || '未知',
    pdfjsVersion: moduleVersion('pdfjs-dist') || '未知',
    errors: recentErrors(5),
    upgradedFrom: String(readJson(META_FILE(), {}).upgraded_to || readJson(META_FILE(), {}).upgraded_from || ''),
    voice: {
      provider: voiceConfig.provider,
      model: voiceConfig.model,
      comfyRefVoice: voiceConfig.comfyRefVoice,
      textNode: voiceConfig.textNode,
    },
    comfy: { workflow: workflow, voiceTable: voiceTable },
  };
}
