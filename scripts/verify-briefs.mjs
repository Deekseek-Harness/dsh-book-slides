#!/usr/bin/env node
/**
 * AC-99 机检：briefs.json 的每条 sections 是否逐字出现在该章原文里。
 *
 *   npm run verify:briefs -- --book 9qjucl9sp7se
 *   npm run verify:briefs -- --dir "C:\Users\<you>\.dsh\book-slides\books\9qjucl9sp7se"
 *   npm run verify:briefs -- --book 9qjucl9sp7se --json
 *
 * 退出码：0 = 全部可检索；1 = 有缺失 / briefs.json 不可读。
 * 复用产品里的 validateBrief 与 chapterTextOf，避免“验收脚本”和“产品校验”各写一套。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readBriefs, validateBrief } from '../host/briefs.js';
import { chapterTextOf } from '../host/parts.js';

function parseArgs(argv) {
  const out = { book: '', dir: '', root: '', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--book' || arg === '-b') out.book = String(argv[++i] || '');
    else if (arg === '--dir' || arg === '-d') out.dir = String(argv[++i] || '');
    else if (arg === '--root' || arg === '-r') out.root = String(argv[++i] || '');
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (!out.book && !out.dir && !arg.startsWith('-')) out.book = arg;
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

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('用法: node scripts/verify-briefs.mjs --book <bookId> [--root <数据根>] [--json]');
  console.log('      node scripts/verify-briefs.mjs --dir <书目录> [--json]');
  process.exit(0);
}

const dir = args.dir ? path.resolve(args.dir) : path.join(resolveRoot(args.root), 'books', args.book);
if (!fs.existsSync(dir)) {
  console.error('找不到书目录：' + dir);
  process.exit(1);
}

const chaptersRaw = readJsonFile(path.join(dir, 'chapters.json'), null);
const pages = readJsonFile(path.join(dir, 'pages.json'), null);
const briefFile = readJsonFile(path.join(dir, 'briefs.json'), null);
const partsRaw = readJsonFile(path.join(dir, 'parts.json'), null);

if (!Array.isArray(chaptersRaw)) {
  console.error('chapters.json 不可读：' + path.join(dir, 'chapters.json'));
  process.exit(1);
}
if (!briefFile || !Array.isArray(briefFile.briefs)) {
  console.error('briefs.json 不可读：' + path.join(dir, 'briefs.json'));
  process.exit(1);
}

const chapters = chaptersRaw.map((c) => {
  const text = chapterTextOf(pages, c);
  return {
    n: Number(c.n),
    title: String(c.title || ''),
    from: Number(c.from),
    to: Number(c.to),
    chars: Number(c.chars) || text.length,
    text,
  };
});
const byN = new Map(chapters.map((c) => [c.n, c]));
const hashOf = (list) => list.map((c) => c.n + ':' + c.chars + ':' + c.title).join('|');

const rows = [];
const missing = [];
for (const brief of briefFile.briefs) {
  const chapter = byN.get(Number(brief && brief.n));
  if (!chapter) {
    missing.push({ n: Number(brief && brief.n), section: '(整条)', reason: '没有对应章' });
    continue;
  }
  const sections = Array.isArray(brief.sections) ? brief.sections : [];
  if (!validateBrief(brief, chapter)) {
    for (const section of sections) {
      if (chapter.text.includes(section)) continue;
      const loose = chapter.text.replace(/\s+/g, '').indexOf(String(section).replace(/\s+/g, ''));
      missing.push({ n: chapter.n, section, reason: loose >= 0 ? '仅空白差异' : '原文中没有' });
    }
  }
  for (const section of sections) {
    rows.push({ n: chapter.n, section, ok: chapter.text.includes(section), index: chapter.text.indexOf(section) });
  }
}

// briefs 是“按 Part”落盘的：hash 只覆盖该 Part 的章，不能拿全书的章去比
const parts = partsRaw && Array.isArray(partsRaw.parts) ? partsRaw.parts : [];
const candidates = parts
  .map((part) => {
    const list = (part.chapters || []).map((n) => byN.get(Number(n))).filter(Boolean);
    return { part, list, hash: hashOf(list) };
  })
  .filter((item) => item.list.length > 0);
const matched = candidates.find((item) => item.hash === String(briefFile.hash || '')) || null;
const stale = parts.length > 0 ? matched === null : hashOf(chapters) !== String(briefFile.hash || '');
const scope = matched ? matched.list : chapters.filter((c) => briefFile.briefs.some((b) => Number(b && b.n) === c.n));
const checked = readBriefs(dir, scope);

if (args.json) {
  console.log(JSON.stringify({
    dir,
    part: matched ? matched.part.id : null,
    sections: rows.length,
    missing: missing.length,
    ok: missing.length === 0,
    stale,
    warnings: checked.warnings,
    rows,
    detail: missing,
  }, null, 2));
} else {
  console.log('书目录：' + dir);
  if (matched) {
    console.log('Part：' + matched.part.title + '（' + matched.list.map((c) => c.n).join(',') + '）· briefs 覆盖 ' + briefFile.briefs.length + '/' + matched.list.length + ' 章');
  } else if (parts.length) {
    console.log('briefs 的 hash 与任何一个 Part 都对不上（可能过期或来自旧章纲）。');
  }
  console.log('章节：' + chapters.length + ' · sections：' + rows.length);
  for (const row of rows) {
    const mark = row.ok ? 'ok  ' : 'MISS';
    console.log('  ' + mark + ' 第 ' + row.n + ' 章  @' + String(row.index).padStart(6) + '  ' + JSON.stringify(row.section));
  }
  if (missing.length) {
    console.log('\n检索失败 ' + missing.length + ' 条：');
    for (const item of missing) console.log('  - 第 ' + item.n + ' 章 ' + JSON.stringify(item.section) + '（' + item.reason + '）');
  }
  if (stale) console.log('\n注意：briefs.json 的 hash 与当前章纲不一致（已过期，讲纲会重新生成 briefs）。');
  if (checked.warnings.length) console.log('\n校验告警：\n  ' + checked.warnings.join('\n  '));
  console.log('\n结论：' + (missing.length === 0 ? 'PASS（' + rows.length + '/' + rows.length + ' 可检索）' : 'FAIL（' + missing.length + ' 条不可检索）'));
}

process.exit(missing.length === 0 ? 0 : 1);
