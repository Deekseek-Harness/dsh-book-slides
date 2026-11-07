#!/usr/bin/env node
/**
 * 播放器降级态的注入 / 恢复（AC-109 的 failed 讲、AC-123 的 unanchored 页）。
 *
 *   npm run inject:player -- --list
 *   npm run inject:player -- --latest --fail 2
 *   npm run inject:player -- --series <seriesId> --unanchor 1:3
 *   npm run inject:player -- --latest --restore
 *
 * 只改数据文件（series.json / lectures/<n>/lecture.json / slides.json），不动代码；
 * 第一次注入时把原值写进 <系列目录>/inject-state-backup.json，--restore 原样写回并删除备份。
 * 注入后关闭重开播放器（或刷新面板）即可看到降级态。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKUP_FILE = 'inject-state-backup.json';

function parseArgs(argv) {
  const out = { root: '', series: '', latest: false, list: false, restore: false, fail: [], unanchor: [], help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' || arg === '-r') out.root = String(argv[++i] || '');
    else if (arg === '--series' || arg === '-s') out.series = String(argv[++i] || '');
    else if (arg === '--latest') out.latest = true;
    else if (arg === '--list') out.list = true;
    else if (arg === '--restore') out.restore = true;
    else if (arg === '--fail') out.fail.push(Number(argv[++i]));
    else if (arg === '--unanchor') {
      const [lecture, page] = String(argv[++i] || '').split(':').map(Number);
      out.unanchor.push({ lecture, page });
    } else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function resolveRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  const envRoot = String(process.env.DSH_BOOK_SLIDES_ROOT || '').trim();
  if (envRoot) return path.resolve(envRoot);
  const home = String(process.env.DSH_HOME || '').trim();
  return path.join(home || path.join(os.homedir(), '.dsh'), 'book-slides');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.inject-' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** 扫出数据根下全部系列：{bookId, seriesId, dir, series}。 */
export function listSeriesDirs(root) {
  const books = path.join(root, 'books');
  let bookIds = [];
  try {
    bookIds = fs.readdirSync(books, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const bookId of bookIds) {
    const seriesRoot = path.join(books, bookId, 'series');
    let seriesIds = [];
    try {
      seriesIds = fs.readdirSync(seriesRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const seriesId of seriesIds) {
      const dir = path.join(seriesRoot, seriesId);
      const series = readJson(path.join(dir, 'series.json'), null);
      if (series && series.id) out.push({ bookId, seriesId, dir, series });
    }
  }
  return out;
}

function resolveTarget({ root, seriesId = '', latest = false }) {
  const all = listSeriesDirs(root);
  if (seriesId) {
    const hit = all.find((item) => item.seriesId === seriesId || item.series.id === seriesId);
    if (!hit) throw new Error('找不到系列：' + seriesId);
    return hit;
  }
  if (!latest) throw new Error('请用 --series <id> 或 --latest 指定系列');
  if (!all.length) throw new Error('数据根下没有系列：' + root);
  return all.sort((a, b) => String(b.series.updated_at || '').localeCompare(String(a.series.updated_at || '')))[0];
}

function lectureFile(dir, n, name) {
  return path.join(dir, 'lectures', String(n), name);
}

function setLectureStatus(series, dir, n, status) {
  const item = (series.lectures || []).find((entry) => Number(entry.n) === Number(n));
  if (!item) throw new Error('系列里没有第 ' + n + ' 讲');
  item.status = status;
  const file = lectureFile(dir, n, 'lecture.json');
  const lecture = readJson(file, null);
  if (lecture) {
    lecture.status = status;
    writeJson(file, lecture);
  }
}

/**
 * 注入或恢复降级态。
 * @returns {{target:object, changes:string[], backupFile:string}}
 */
export function inject({ root, seriesId = '', latest = false, fail = [], unanchor = [], restore = false }) {
  const target = resolveTarget({ root, seriesId, latest });
  const { dir, series } = target;
  const backupFile = path.join(dir, BACKUP_FILE);
  const backup = readJson(backupFile, null) || {
    schema: 1,
    created_at: new Date().toISOString(),
    lectures: {},
    anchors: {},
  };
  const changes = [];

  if (restore) {
    if (!readJson(backupFile, null)) throw new Error('没有可恢复的注入备份：' + backupFile);
    for (const [n, status] of Object.entries(backup.lectures || {})) {
      setLectureStatus(series, dir, Number(n), String(status));
      changes.push('第 ' + n + ' 讲状态恢复为 ' + status);
    }
    for (const [key, saved] of Object.entries(backup.anchors || {})) {
      const [n, page] = key.split(':').map(Number);
      const file = lectureFile(dir, n, 'slides.json');
      const doc = readJson(file, null);
      if (!doc || !Array.isArray(doc.slides) || !doc.slides[page - 1]) {
        changes.push('第 ' + n + ' 讲第 ' + page + ' 页已不存在，跳过');
        continue;
      }
      doc.slides[page - 1].source_anchor = saved.source_anchor;
      doc.slides[page - 1].anchor_status = saved.anchor_status;
      writeJson(file, doc);
      changes.push('第 ' + n + ' 讲第 ' + page + ' 页锚点已恢复');
    }
    series.updated_at = new Date().toISOString();
    writeJson(path.join(dir, 'series.json'), series);
    fs.rmSync(backupFile, { force: true });
    return { target, changes, backupFile };
  }

  for (const raw of fail) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error('--fail 需要讲号：' + raw);
    const item = (series.lectures || []).find((entry) => Number(entry.n) === n);
    if (!item) throw new Error('系列里没有第 ' + n + ' 讲');
    if (!(String(n) in backup.lectures)) backup.lectures[String(n)] = String(item.status || '');
    setLectureStatus(series, dir, n, 'failed');
    changes.push('第 ' + n + ' 讲置 failed（原 ' + (backup.lectures[String(n)] || '空') + '）');
  }

  for (const { lecture, page } of unanchor) {
    const n = Number(lecture);
    const p = Number(page);
    if (!Number.isInteger(n) || n < 1 || !Number.isInteger(p) || p < 1) {
      throw new Error('--unanchor 需要 讲:页，例如 1:3');
    }
    const file = lectureFile(dir, n, 'slides.json');
    const doc = readJson(file, null);
    if (!doc || !Array.isArray(doc.slides)) throw new Error('第 ' + n + ' 讲还没有 slides.json');
    const slide = doc.slides[p - 1];
    if (!slide) throw new Error('第 ' + n + ' 讲只有 ' + doc.slides.length + ' 页，没有第 ' + p + ' 页');
    const key = n + ':' + p;
    if (!(key in backup.anchors)) {
      backup.anchors[key] = {
        source_anchor: slide.source_anchor === undefined ? null : slide.source_anchor,
        anchor_status: slide.anchor_status === undefined ? null : slide.anchor_status,
      };
    }
    slide.source_anchor = null;
    slide.anchor_status = 'unanchored';
    writeJson(file, doc);
    changes.push('第 ' + n + ' 讲第 ' + p + ' 页置 unanchored');
  }

  series.updated_at = new Date().toISOString();
  writeJson(path.join(dir, 'series.json'), series);
  writeJson(backupFile, backup);
  return { target, changes, backupFile };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node scripts/inject-player-state.mjs [--root <数据根>] (--series <id> | --latest) [--fail <n>]… [--unanchor <讲>:<页>]… [--restore]');
    console.log('      node scripts/inject-player-state.mjs --list');
    return;
  }
  const root = resolveRoot(args.root);
  if (args.list) {
    const all = listSeriesDirs(root);
    if (!all.length) {
      console.log('数据根下没有系列：' + root);
      return;
    }
    for (const item of all) {
      console.log(
        '  ' + item.seriesId + '  ' + String(item.series.status || '').padEnd(12) + ' ' +
        String(item.series.title || '') + '  [' + item.bookId + ']  ' + String(item.series.updated_at || ''),
      );
    }
    return;
  }
  if (!args.fail.length && !args.unanchor.length && !args.restore) {
    console.log('没有可执行的动作：加 --fail <n> / --unanchor <讲>:<页> / --restore');
    return;
  }
  const out = inject({
    root,
    seriesId: args.series,
    latest: args.latest,
    fail: args.fail,
    unanchor: args.unanchor,
    restore: args.restore,
  });
  console.log('数据根：' + root);
  console.log('系列：' + out.target.seriesId + ' · ' + String(out.target.series.title || '') + '（' + out.target.bookId + '）');
  for (const line of out.changes) console.log('  - ' + line);
  if (out.changes.length) {
    console.log(
      args.restore
        ? '\n已恢复；关闭重开播放器确认回到正常态。'
        : '\n接下来：关闭重开播放器（或刷新面板）看降级态；恢复用 --restore。',
    );
  }
  console.log(args.restore ? '备份已删除：' + out.backupFile : '备份：' + out.backupFile);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
