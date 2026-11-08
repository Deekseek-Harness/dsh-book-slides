#!/usr/bin/env node
/**
 * AC-155 韵律度量：同一讲逐页配音的中位 F0 与字/秒极差。
 *
 *   node scripts/verify-prosody.mjs --dir <lectureDir>
 *   node scripts/verify-prosody.mjs --series <seriesId> [--root <数据根>]
 *
 * 读 slides.json 的 audio_script 与 audio/NNN.wav（PCM），自相关估计每页中位 F0；
 * 输出各页 F0 / 字每秒 / 极差与离群页，退出码 0/1。阈值：F0 极差 ≤2 个半音、字/秒极差 ≤15%。
 * 非 WAV 页跳过并在输出里标注（flac/mp3/ogg 需先转 WAV；人工盲听仍按 AC 的“非 CI 阻塞”处理）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const MIN_F0 = 60;
const MAX_F0 = 400;
const F0_SPREAD_ST = 2;
const SPEED_SPREAD_PCT = 15;

/** 读 PCM16 WAV（单/双声道会混为单声道）。 */
export function readWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bits: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(buffer.length, body + size));
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16 || !fmt.channels) return null;
  const frame = fmt.channels * 2;
  const frames = Math.floor(data.length / frame);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c += 1) sum += data.readInt16LE(i * frame + c * 2) / 32768;
    samples[i] = sum / fmt.channels;
  }
  return { sampleRate: fmt.sampleRate, samples, durationMs: Math.round((frames / fmt.sampleRate) * 1000) };
}

/** 自相关估计一帧的 F0（Hz）；静音/无周期返回 0。 */
function frameF0(samples, start, length, sampleRate) {
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_F0));
  const maxLag = Math.min(length - 1, Math.ceil(sampleRate / MIN_F0));
  let energy = 0;
  for (let i = 0; i < length; i += 1) energy += samples[start + i] ** 2;
  if (energy / length < 1e-5) return 0;
  let bestLag = 0;
  let best = 0;
  const scores = [];
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i + lag < length; i += 1) sum += samples[start + i] * samples[start + i + lag];
    const score = sum / (length - lag);
    scores.push(score);
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  if (!best) return 0;
  // 取“第一个局部峰”对应的周期，避免倍周期/半周期误判。
  for (let i = 1; i < scores.length - 1; i += 1) {
    if (scores[i] >= scores[i - 1] && scores[i] >= scores[i + 1] && scores[i] > best * 0.6) {
      return sampleRate / (minLag + i);
    }
  }
  return bestLag ? sampleRate / bestLag : 0;
}

/** 一页音频的中位 F0。 */
export function medianF0(samples, sampleRate) {
  const frame = Math.max(256, Math.round(sampleRate * 0.04));
  const hop = Math.max(128, Math.round(sampleRate * 0.02));
  const values = [];
  for (let start = 0; start + frame <= samples.length; start += hop) {
    const f0 = frameF0(samples, start, frame, sampleRate);
    if (f0 > 0) values.push(f0);
  }
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
}

function lectureDirOf(root, seriesId) {
  const books = path.join(root, 'books');
  let bookIds = [];
  try {
    bookIds = fs.readdirSync(books, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return null;
  }
  for (const bookId of bookIds) {
    const dir = path.join(books, bookId, 'series', seriesId);
    if (fs.existsSync(path.join(dir, 'series.json'))) return dir;
  }
  return null;
}

function audioFileOf(dir, index) {
  for (const ext of ['wav', 'flac', 'mp3', 'ogg']) {
    const file = path.join(dir, 'audio', String(index).padStart(3, '0') + '.' + ext);
    if (fs.existsSync(file)) return file;
  }
  return '';
}

/** 分析一讲目录；返回各页指标与极差。 */
export function analyzeLecture(dir) {
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'slides.json'), 'utf8'));
  const slides = Array.isArray(doc.slides) ? doc.slides : [];
  const pages = [];
  const skipped = [];
  for (let i = 0; i < slides.length; i += 1) {
    const file = audioFileOf(dir, i + 1);
    if (!file) {
      skipped.push({ page: i + 1, reason: '无音频' });
      continue;
    }
    if (!file.endsWith('.wav')) {
      skipped.push({ page: i + 1, reason: '需转 WAV' });
      continue;
    }
    const wav = readWav(fs.readFileSync(file));
    if (!wav || !wav.durationMs) {
      skipped.push({ page: i + 1, reason: '不是 PCM16 WAV' });
      continue;
    }
    const f0 = medianF0(wav.samples, wav.sampleRate);
    const chars = String(slides[i].audio_script || '').replace(/\s/g, '').length;
    pages.push({
      page: i + 1,
      f0: Math.round(f0 * 10) / 10,
      chars,
      seconds: wav.durationMs / 1000,
      charsPerSec: Math.round((chars / (wav.durationMs / 1000)) * 100) / 100,
    });
  }
  const f0s = pages.map((page) => page.f0).filter((value) => value > 0);
  const speeds = pages.map((page) => page.charsPerSec).filter((value) => value > 0);
  const f0SpreadSt = f0s.length >= 2 ? Math.round(12 * Math.log2(Math.max(...f0s) / Math.min(...f0s)) * 100) / 100 : 0;
  const medianSpeed = speeds.length ? speeds.slice().sort((a, b) => a - b)[Math.floor(speeds.length / 2)] : 0;
  const speedSpreadPct = speeds.length >= 2 && medianSpeed > 0
    ? Math.round(((Math.max(...speeds) - Math.min(...speeds)) / medianSpeed) * 1000) / 10
    : 0;
  const medianF0Value = f0s.length ? f0s.slice().sort((a, b) => a - b)[Math.floor(f0s.length / 2)] : 0;
  const outliers = medianF0Value
    ? pages.filter((page) => page.f0 > 0 && Math.abs(12 * Math.log2(page.f0 / medianF0Value)) > F0_SPREAD_ST).map((page) => page.page)
    : [];
  return {
    pages,
    skipped,
    f0SpreadSt,
    speedSpreadPct,
    outliers,
    ok: pages.length > 0 && f0SpreadSt <= F0_SPREAD_ST && speedSpreadPct <= SPEED_SPREAD_PCT,
  };
}

function parseArgs(argv) {
  const out = { dir: '', series: '', root: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') out.dir = String(argv[++i] || '');
    else if (arg === '--series') out.series = String(argv[++i] || '');
    else if (arg === '--root') out.root = String(argv[++i] || '');
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.dir && !args.series)) {
    console.log('用法: node scripts/verify-prosody.mjs --dir <lectureDir>');
    console.log('      node scripts/verify-prosody.mjs --series <seriesId> [--root <数据根>]');
    console.log('阈值: 中位 F0 极差 ≤' + F0_SPREAD_ST + ' 个半音，字/秒极差 ≤' + SPEED_SPREAD_PCT + '%；退出码 0/1。');
    return;
  }
  const root = path.resolve(args.root || process.env.DSH_BOOK_SLIDES_ROOT || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'book-slides'));
  const dir = args.dir ? path.resolve(args.dir) : lectureDirOf(root, args.series);
  if (!dir || !fs.existsSync(path.join(dir, 'slides.json'))) {
    console.log('FAIL 找不到讲目录或 slides.json：' + (dir || args.series));
    process.exit(1);
  }
  const result = analyzeLecture(dir);
  for (const page of result.pages) {
    console.log('  第 ' + page.page + ' 页  F0 ' + page.f0 + 'Hz  ' + page.charsPerSec + ' 字/秒  ' + page.seconds + 's');
  }
  for (const item of result.skipped) console.log('  跳过第 ' + item.page + ' 页：' + item.reason);
  console.log('F0 极差 ' + result.f0SpreadSt + ' 个半音（≤' + F0_SPREAD_ST + '）');
  console.log('字/秒极差 ' + result.speedSpreadPct + '%（≤' + SPEED_SPREAD_PCT + '%）');
  if (result.outliers.length) console.log('离群页：' + result.outliers.join('、'));
  console.log('结论：' + (result.ok ? 'PASS' : 'FAIL') + '（共 ' + result.pages.length + ' 页可测）');
  console.log('人工边界：盲听是否“换人格”；本脚本只度量 F0 与语速。');
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
