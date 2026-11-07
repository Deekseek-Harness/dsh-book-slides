#!/usr/bin/env node
/**
 * FR-17 机检：打印一个系列（或一本书的全部系列）的缝合报告——六指标 + 失败项 + 告警。
 *
 *   npm run verify:stitch -- --series <seriesId>
 *   npm run verify:stitch -- --book <bookId>
 *   npm run verify:stitch -- --series <seriesId> --json
 *
 * 退出码：0 = 全部 stitched / verified；1 = 有 unstitched 或找不到。
 * 只读：不修复、不写 stitch.json。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function parseArgs(argv) {
  const out = { series: '', book: '', root: '', json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--series' || arg === '-s') out.series = String(argv[++i] || '');
    else if (arg === '--book' || arg === '-b') out.book = String(argv[++i] || '');
    else if (arg === '--root' || arg === '-r') out.root = String(argv[++i] || '');
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
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

function usage() {
  console.log('用法: node scripts/verify-stitch.mjs --series <seriesId> [--root <数据根>] [--json]');
  console.log('      node scripts/verify-stitch.mjs --book <bookId> [--json]');
}

function fmtValue(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}
if (!args.series && !args.book) {
  usage();
  process.exit(1);
}

const root = resolveRoot(args.root);
process.env.DSH_BOOK_SLIDES_ROOT = root;
const { findSeries, listSeries } = await import('../v2/series.js');
const { buildStitchReport } = await import('../v2/stitch.js');

function snapshot(found) {
  const report = buildStitchReport(found);
  return {
    series: found.series.id,
    title: found.series.title || '',
    state: report.state,
    metrics: report.metrics,
    failures: report.failures,
    warnings: report.warnings,
  };
}

function printSnapshot(item) {
  console.log('系列 ' + item.series + (item.title ? ' · ' + item.title : '') + ' · 状态 ' + item.state);
  for (const metric of item.metrics) {
    const flag = metric.ok ? 'ok' : 'FAIL';
    const mark = metric.blocking === false ? '（告警项）' : '';
    console.log('  ' + metric.id.padEnd(10) + metric.label.padEnd(12) + flag.padEnd(6) + fmtValue(metric.value) + mark);
  }
  if (item.failures.length) {
    console.log('  失败项：');
    for (const failure of item.failures) {
      const where = failure.lecture ? '第 ' + failure.lecture + ' 讲' + (failure.page ? ' 第 ' + failure.page + ' 页' : '') : '系列级';
      console.log('    - ' + where + ' ' + failure.type + '：' + failure.message + (failure.action ? ' → ' + failure.action : ''));
    }
  }
  if (item.warnings.length) console.log('  告警：' + item.warnings.join('；'));
}

let founds = [];
if (args.series) {
  const found = findSeries(args.series);
  if (!found) {
    console.error('找不到系列：' + args.series);
    process.exit(1);
  }
  founds = [found];
} else {
  const seriesList = listSeries(args.book);
  if (!seriesList.length) {
    console.error('这本书没有系列：' + args.book);
    process.exit(1);
  }
  founds = seriesList.map((item) => findSeries(item.id)).filter(Boolean);
}

const items = founds.map(snapshot);
const ok = items.every((item) => item.state === 'stitched' || item.state === 'verified');

if (args.json) {
  console.log(JSON.stringify({ ok, root, reports: items }, null, 2));
} else {
  console.log('数据根：' + root + '\n');
  for (const item of items) printSnapshot(item);
  console.log('\n结论：' + (ok ? 'PASS' : 'FAIL（存在 unstitched）'));
}

process.exit(ok ? 0 : 1);
