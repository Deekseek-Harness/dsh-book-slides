/**
 * AC-109 / AC-123 的“人工可进入”通道：注入 failed 讲与 unanchored 页。
 *
 * 断言两层：
 * 1. 注入脚本改对数据文件（series.json / lecture.json / slides.json），且可 --restore；
 * 2. 注入后的状态能通过播放器实际读取的接口（/series、/lecture）看到。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-inject-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, loadBook, writeChapters } = await import('../host/books.js');
const { savePart } = await import('../host/parts.js');
const { createSeries, findSeries, persistSeries } = await import('../host/series.js');
const { writeLectureOutputs } = await import('../host/lectures.js');
const { inject, listSeriesDirs } = await import('../scripts/inject-player-state.mjs');
const { routeM1 } = await import('../host/api.js');

const T1 = '第1章 甲\n' + '甲'.repeat(5000);
const T2 = '第2章 乙\n' + '乙'.repeat(5000);
const book = createBook({
  buffer: Buffer.from('inject-state-' + Date.now()),
  fileName: 'inject.pdf',
  title: '注入测试书',
  author: '',
  pages: 2,
  rawPages: [
    { page: 1, text: T1 },
    { page: 2, text: T2 },
  ],
});
writeChapters(
  book.id,
  [
    { n: 1, title: '第1章 甲', from: 1, to: 1, chars: T1.length, toc: false, front: false },
    { n: 2, title: '第2章 乙', from: 2, to: 2, chars: T2.length, toc: false, front: false },
  ],
  'manual',
);
const part = savePart({ bookId: book.id, chapters: [1, 2], title: '注入 Part' });
const series = createSeries({
  bookId: book.id,
  partId: part.id,
  title: '注入系列',
  plan: {
    throughline: '甲之后是乙',
    lectures: [
      { n: 1, chapters: [1], title: '第 1 讲 · 甲', goal: 'g', in: 'i', out: 'o', pages: 6, chars: T1.length },
      { n: 2, chapters: [2], title: '第 2 讲 · 乙', goal: 'g', in: 'i', out: 'o', pages: 6, chars: T2.length },
    ],
    seams: [{ from: 1, to: 2, concept: '乙', sentence: '甲讲完，乙登场。' }],
    terms: [],
    cut_notes: [],
    source: 'model',
    stitched: true,
    totalChars: T1.length + T2.length,
    totalPages: 12,
    estMinutes: 12,
  },
});
const found = findSeries(series.id);

function makeSlide(n, index) {
  return {
    slide_index: index,
    layout: index === 0 ? 'cover' : 'content_text',
    title: '第 ' + n + ' 讲 第 ' + (index + 1) + ' 页',
    subtitle: '',
    bullet_points: ['要点'],
    quote_text: null,
    quote_source: null,
    image_prompt: '图',
    audio_script: '甲'.repeat(60),
    source_quote: '甲'.repeat(10),
    source_pages: { from: n, to: n },
    source_anchor: { page: n, para_index: 0 },
    anchor_status: 'anchored',
  };
}

for (const n of [1, 2]) {
  writeLectureOutputs(
    found.dir,
    n,
    { schema: 1, series_id: series.id, n, title: '第 ' + n + ' 讲', status: 'ready' },
    { schema_version: 1, series_id: series.id, lecture: n, slides: Array.from({ length: 6 }, (_, i) => makeSlide(n, i)) },
  );
}
// 模拟真实生成后的状态：series.json 的讲状态与 lecture.json 一致
found.series.lectures = found.series.lectures.map((item) => Object.assign({}, item, { status: 'ready' }));
persistSeries(found.series);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const handled = await routeM1(req, res, url);
  if (!handled) {
    res.statusCode = 404;
    res.end('no route');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

async function get(url) {
  const response = await fetch(base + url);
  return JSON.parse(await response.text());
}

test('AC-109：--fail 注入后 series/lecture 都是 failed，连播接口可见', async () => {
  const out = inject({ root: ROOT, seriesId: series.id, fail: [2] });
  assert.ok(out.changes.some((line) => /第 2 讲置 failed/.test(line)));
  assert.equal(fs.existsSync(out.backupFile), true, '注入要留下备份');
  assert.equal(JSON.parse(fs.readFileSync(path.join(found.dir, 'series.json'), 'utf8')).lectures[1].status, 'failed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(found.dir, 'lectures', '2', 'lecture.json'), 'utf8')).status, 'failed');

  const seriesOut = await get('/dsh-book-slides/series?seriesId=' + series.id);
  assert.equal(seriesOut.series.lectures.find((item) => item.n === 2).status, 'failed');
});

test('AC-123：--unanchor 注入后该页 source_anchor=null，/lecture 接口可见', async () => {
  const out = inject({ root: ROOT, seriesId: series.id, unanchor: [{ lecture: 1, page: 3 }] });
  assert.ok(out.changes.some((line) => /第 1 讲第 3 页置 unanchored/.test(line)));
  const slides = JSON.parse(fs.readFileSync(path.join(found.dir, 'lectures', '1', 'slides.json'), 'utf8')).slides;
  assert.equal(slides[2].source_anchor, null);
  assert.equal(slides[2].anchor_status, 'unanchored');

  const lectureOut = await get('/dsh-book-slides/lecture?seriesId=' + series.id + '&n=1');
  assert.equal(lectureOut.slides.slides[2].source_anchor, null);
  assert.equal(lectureOut.slides.slides[2].anchor_status, 'unanchored');
});

test('--restore 还原状态与锚点并删除备份', () => {
  const out = inject({ root: ROOT, seriesId: series.id, restore: true });
  assert.ok(out.changes.some((line) => /第 2 讲状态恢复为 ready/.test(line)));
  assert.ok(out.changes.some((line) => /锚点已恢复/.test(line)));
  const seriesAfter = JSON.parse(fs.readFileSync(path.join(found.dir, 'series.json'), 'utf8'));
  assert.equal(seriesAfter.lectures[1].status, 'ready');
  const lectureAfter = JSON.parse(fs.readFileSync(path.join(found.dir, 'lectures', '1', 'slides.json'), 'utf8'));
  assert.deepEqual(lectureAfter.slides[2].source_anchor, { page: 1, para_index: 0 });
  assert.equal(lectureAfter.slides[2].anchor_status, 'anchored');
  assert.equal(fs.existsSync(out.backupFile), false);
});

test('非法目标要报错，不写坏数据', () => {
  assert.throws(() => inject({ root: ROOT, seriesId: series.id, fail: [9] }), /没有第 9 讲/);
  assert.throws(() => inject({ root: ROOT, seriesId: series.id, unanchor: [{ lecture: 1, page: 99 }] }), /没有第 99 页/);
  assert.throws(() => inject({ root: ROOT, seriesId: 'nope', fail: [1] }), /找不到系列/);
});

test('listSeriesDirs 能列出数据根下的系列', () => {
  const all = listSeriesDirs(ROOT);
  assert.ok(all.some((item) => item.seriesId === series.id && item.bookId === book.id));
});

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
