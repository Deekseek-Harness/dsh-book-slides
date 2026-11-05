/**
 * 2.0 M4 设置与偏好对等（FR-21.5 / FR-21.7 / AC-118 / AC-122 / AC-127）。
 *
 * 覆盖：设置首屏、存储/回收站、升级备份列出与删除、诊断字段与错误环、
 * 偏好夹紧与持久化、系列进度（含「上次位置」）、作业文案与设置面板渲染。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-settings-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
process.env.DSH_BOOK_SLIDES_NO_OPEN = '1';
delete process.env.DSH_HOME;

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToString } = require('react-dom/server');

const { createBook, writeChapters, loadBook } = await import('../v2/books.js');
const { savePart } = await import('../v2/parts.js');
const { createSeries, findSeries, patchSeriesLecture, persistSeries } = await import('../v2/series.js');
const { writeLectureOutputs } = await import('../v2/lectures.js');
const { writePreference, readPreference } = await import('../v2/prefs.js');
const { routeM1 } = await import('../v2/api.js');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const handled = await routeM1(req, res, url, { ctx: null });
  if (!handled) {
    res.statusCode = 404;
    res.end('no route');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port;

async function json(url, options) {
  const res = await fetch(baseUrl + url, options);
  return JSON.parse(await res.text());
}

function post(url, body) {
  return json(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

function makeBook(tag) {
  const book = createBook({
    buffer: Buffer.from('m4-settings-' + tag + '-' + Date.now()),
    fileName: tag + '.pdf',
    title: '设置 ' + tag,
    author: '某作者',
    pages: 2,
    rawPages: [
      { page: 1, text: '第1章 甲\n' + '甲'.repeat(4000) },
      { page: 2, text: '第2章 乙\n' + '乙'.repeat(4000) },
    ],
  });
  writeChapters(book.id, [
    { n: 1, title: '第1章 甲', from: 1, to: 1, chars: 4000, front: false },
    { n: 2, title: '第2章 乙', from: 2, to: 2, chars: 4000, front: false },
  ], 'manual');
  return book;
}

function makeSeries(book, tag) {
  const part = savePart({ bookId: book.id, chapters: [1, 2], title: '函数 ' + tag });
  const series = createSeries({
    bookId: book.id,
    partId: part.id,
    title: '函数 ' + tag,
    plan: {
      throughline: '把函数当机器。',
      lectures: [
        { n: 1, chapters: [1], title: '第 1 讲', goal: 'g1', pages: 6, chars: 4000 },
        { n: 2, chapters: [2], title: '第 2 讲', goal: 'g2', pages: 8, chars: 4000 },
      ],
      seams: [{ from: 1, to: 2, concept: '极限', sentence: '上一讲把函数当机器。' }],
      terms: [],
      cut_notes: [],
      source: 'model',
      stitched: true,
      totalChars: 8000,
      totalPages: 14,
      estMinutes: 14,
    },
  });
  const found = findSeries(series.id);
  for (const n of [1, 2]) {
    const pages = n === 1 ? 6 : 8;
    const slides = Array.from({ length: pages }, (_, index) => ({
      slide_index: index + 1,
      layout: index === 0 ? 'cover' : 'content_text',
      title: '第 ' + n + ' 讲 第 ' + (index + 1) + ' 页',
      bullet_points: ['要点'],
      audio_script: '朗读稿'.repeat(10),
      source_quote: '原文'.repeat(20),
      source_pages: { from: n, to: n },
      audio_file: null,
      audio_provider: 'none',
      audio_ms: 0,
    }));
    writeLectureOutputs(
      found.dir,
      n,
      {
        schema: 1,
        series_id: series.id,
        n,
        title: '第 ' + n + ' 讲',
        chapters: [n],
        pages,
        chars: 4000,
        status: 'ready',
        voice_status: 'none',
      },
      { schema_version: 1, series_id: series.id, lecture: n, slides },
    );
    patchSeriesLecture(found.series, n, { status: 'ready', pages, chars: 4000 });
  }
  found.series.status = 'ready';
  found.series.total_pages = 14;
  persistSeries(found.series);
  return found.series;
}

/* ------------------------------ 设置 / 存储 / 备份 / 诊断 ------------------------------ */

test('AC-118：设置首屏给出数据根、占用、回收站、备份与只读模型', async () => {
  const book = makeBook('settings');
  const out = await json('/dsh-book-slides/settings');
  assert.equal(out.ok, true);
  assert.equal(out.dataRoot, ROOT);
  assert.equal(out.root, ROOT);
  assert.ok(out.bytes > 0);
  assert.equal(out.trashCount, 0);
  assert.deepEqual(out.backups, []);
  assert.equal(out.productVersion, '2.0');
  assert.equal(out.schema, 2);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(out.version, pkg.version);
  assert.equal(out.model, null);
  assert.match(out.modelNote, /DSH/);
  // 有一本书就说明 settings 的占用来自真实数据目录
  assert.ok(loadBook(book.id));
});

test('AC-118：诊断显示插件版本/产品版本/schema/DSH/pdfjs 与最近错误（不含正文）', async () => {
  // 制造一条可读错误：非法 bookId
  const bad = await json('/dsh-book-slides/book?bookId=NOT-AN-ID');
  assert.equal(bad.ok, false);
  const out = await json('/dsh-book-slides/diagnostics');
  assert.equal(out.ok, true);
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(out.version, pkg.version);
  assert.equal(out.productVersion, '2.0');
  assert.equal(out.schema, 2);
  assert.equal(typeof out.dshVersion, 'string');
  assert.ok(out.dshVersion.length > 0);
  const pdfjs = JSON.parse(fs.readFileSync(new URL('../node_modules/pdfjs-dist/package.json', import.meta.url), 'utf8'));
  assert.equal(out.pdfjsVersion, pdfjs.version);
  assert.ok(Array.isArray(out.errors));
  assert.ok(out.errors.length <= 5);
  for (const item of out.errors) {
    assert.deepEqual(Object.keys(item).sort(), ['at', 'code', 'length']);
    assert.equal(typeof item.code, 'string');
    assert.equal(typeof item.length, 'number');
    assert.equal(JSON.stringify(item).includes('message'), false);
  }
});

test('AC-118：升级备份可列出、可打开（路径）、可删除；非法名字被拒', async () => {
  const parent = path.dirname(ROOT);
  const prefix = path.basename(ROOT) + '.backup-';
  const name = prefix + '20260101-010101';
  const dir = path.join(parent, name);
  fs.mkdirSync(path.join(dir, 'books'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), '{"schema":1}');
  fs.writeFileSync(path.join(dir, 'books', 'x.json'), '{"a":1}');

  const listed = await json('/dsh-book-slides/backups');
  assert.equal(listed.ok, true);
  const hit = listed.backups.find((item) => item.name === name);
  assert.ok(hit, '备份应该列出来');
  assert.equal(hit.path, dir);
  assert.equal(hit.files, 2);
  assert.ok(hit.bytes > 0);
  assert.equal(Date.parse(hit.createdAt), new Date(2026, 0, 1, 1, 1, 1).getTime());

  const opened = await post('/dsh-book-slides/backups/open', { name });
  assert.equal(opened.ok, true);
  assert.equal(opened.path, dir);

  const traversal = await post('/dsh-book-slides/backups/delete', { name: '../evil' });
  assert.equal(traversal.ok, false);
  assert.equal(traversal.code, 'E_BAD_ID');

  const removed = await post('/dsh-book-slides/backups/delete', { name });
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, name);
  assert.equal(fs.existsSync(dir), false);
  const again = await post('/dsh-book-slides/backups/delete', { name });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'E_NOT_FOUND');
});

test('AC-118：清空回收站后 trash/ 为空且占用下降；设置页数据不丢', async () => {
  const book = makeBook('trash');
  const before = await json('/dsh-book-slides/storage');
  const deleted = await json('/dsh-book-slides/book?bookId=' + book.id, { method: 'DELETE' });
  assert.equal(deleted.ok, true);
  const trashed = await json('/dsh-book-slides/storage');
  assert.equal(trashed.trashCount, 1);
  assert.ok(trashed.bytes > 0);
  const cleared = await post('/dsh-book-slides/trash/clear', {});
  assert.equal(cleared.ok, true);
  assert.equal(cleared.count, 1);
  assert.ok(cleared.bytes > 0);
  const after = await json('/dsh-book-slides/storage');
  assert.equal(after.trashCount, 0);
  assert.ok(after.bytes < trashed.bytes);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'trash')), []);
  assert.ok(after.bytes <= before.bytes + 1024 * 1024);
});

/* ------------------------------ 偏好（AC-127） ------------------------------ */

test('AC-127：偏好越界被夹紧，关闭重开保持（split 0.25–0.75、rate 0.8/1.0/1.2）', async () => {
  const high = await post('/dsh-book-slides/preference', { split: 0.98, rate: 3, muted: true });
  assert.equal(high.ok, true);
  assert.equal(high.preference.split, 0.75);
  assert.equal(high.preference.rate, 1.2);
  assert.equal(high.preference.muted, true);

  const low = await post('/dsh-book-slides/preference', { split: 0.01, rate: 0.2, muted: false });
  assert.equal(low.preference.split, 0.25);
  assert.equal(low.preference.rate, 0.8);
  assert.equal(low.preference.muted, false);

  const snapped = await post('/dsh-book-slides/preference', { split: 0.55, rate: 0.81 });
  assert.equal(snapped.preference.rate, 0.8);
  const mid = await post('/dsh-book-slides/preference', { rate: 1.05 });
  assert.equal(mid.preference.rate, 1);

  const reloaded = await json('/dsh-book-slides/preference');
  assert.equal(reloaded.preference.split, 0.55);
  assert.equal(reloaded.preference.rate, 1);
  assert.equal(reloaded.preference.muted, false);
  // 同根 preference.json 持久化
  assert.equal(readPreference().split, 0.55);
  const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'preference.json'), 'utf8'));
  assert.equal(onDisk.rate, 1);

  const bad = await post('/dsh-book-slides/preference', { split: 'x', rate: 'y', lastSlide: -3 });
  assert.equal(bad.preference.split, 0.55);
  assert.equal(bad.preference.rate, 1);
  assert.equal(bad.preference.lastSlide, 0);
});

test('AC-108：系列进度 GET/POST 持久化，并同步「上次打开」偏好', async () => {
  const book = makeBook('progress');
  const series = makeSeries(book, 'progress');
  writePreference({ lastBookId: '', lastSeriesId: '', lastSlide: 0 });

  const empty = await json('/dsh-book-slides/series/progress?seriesId=' + series.id);
  assert.equal(empty.ok, true);
  assert.equal(empty.progress.lecture, 1);
  assert.equal(empty.progress.heardPages, 0);
  assert.equal(empty.progress.totalPages, 14);
  assert.equal(empty.progress.lecturePages, 6);

  const first = await post('/dsh-book-slides/series/progress', { seriesId: series.id, lecture: 2, slide: 3 });
  assert.equal(first.ok, true);
  assert.equal(first.progress.lecture, 2);
  assert.equal(first.progress.slide, 3);
  assert.equal(first.progress.lecturePages, 8);
  assert.equal(first.progress.heardPages, 3);

  // 回看第 1 页不回退已听页数
  const back = await post('/dsh-book-slides/series/progress', { seriesId: series.id, lecture: 2, slide: 1 });
  assert.equal(back.progress.slide, 1);
  assert.equal(back.progress.heardPages, 3);

  const reloaded = await json('/dsh-book-slides/series/progress?seriesId=' + series.id);
  assert.equal(reloaded.progress.lecture, 2);
  assert.equal(reloaded.progress.heardPages, 3);

  const pref = await json('/dsh-book-slides/preference');
  assert.equal(pref.preference.lastBookId, book.id);
  assert.equal(pref.preference.lastSeriesId, series.id);
  assert.equal(pref.preference.lastSlide, 1);

  // 书架卡需要的系列数与最近系列
  const shelf = await json('/dsh-book-slides/books');
  const card = shelf.books.find((item) => item.id === book.id);
  assert.ok(card);
  assert.equal(card.seriesCount, 1);
  assert.equal(card.lastSeries.id, series.id);
  assert.equal(card.lastSeries.status, 'ready');
  assert.equal(card.lastSeries.lectures, 2);

  // 页码夹到该讲页数内
  const clamped = await post('/dsh-book-slides/series/progress', { seriesId: series.id, lecture: 2, slide: 999 });
  assert.equal(clamped.progress.slide, 8);
  assert.equal(clamped.progress.heardPages, 8);
});

/* ------------------------------ 作业文案与设置面板 ------------------------------ */

test('AC-122：作业进度文案为「第 k/N 讲 · 第 p/P 页」', () => {
  const helpers = clientModule.__helpers;
  assert.equal(
    helpers.formatJobLine({ lecture: 2, lecturesTotal: 3, current: 5, total: 18 }),
    '第 2/3 讲 · 第 5/18 页',
  );
  assert.equal(helpers.formatJobLine(null), '');
  assert.equal(
    helpers.formatSeriesProgress({ lecture: 2, slide: 3, lecturePages: 18, heardPages: 24, totalPages: 42 }),
    '系列 24/42 页 · 第 2 讲 3/18 页',
  );
});

test('AC-118：设置面板渲染语音/模型/存储/诊断四组', () => {
  const html = renderToString(React.createElement(clientModule.__components.Settings, { onBack: () => {}, notify: () => {} }));
  for (const text of ['语音', '模型（只读）', '配图', '存储与回收站', '诊断', '升级备份', '清空回收站']) {
    assert.ok(html.includes(text), '设置页应包含「' + text + '」');
  }
});

/* ------------------------------ 加载 2.0 客户端 ------------------------------ */

let clientModule = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      const mod = definition.factory((name) => {
        if (name === 'react') return React;
        throw new Error('插件不该 require ' + name);
      });
      const slots = {
        inject(name, fn) {
          fn();
        },
        register() {
          return () => {};
        },
      };
      mod.apply({ slots, effect: (fn) => fn() });
      clientModule = mod;
    },
  },
};
await import('../v2/client.js');

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
