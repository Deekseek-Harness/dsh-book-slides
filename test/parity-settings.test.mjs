/**
 * 2.0 M4 设置与偏好对等（FR-21.5 / FR-21.7 / AC-118 / AC-122 / AC-127）
 * + 2.5 设置页顶栏标签（AC-172 ~ AC-174）。
 *
 * 覆盖：设置首屏、存储/回收站、升级备份列出与删除、诊断字段与错误环、
 * 偏好夹紧与持久化、系列进度（含「上次位置」）、作业文案与设置面板渲染、
 * 标签栏渲染/会话记忆/键盘导航/减少动效降级。
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

/** 客户端源码：2.5 标签栏的 CSS/键盘/会话记忆按源码契约断言。 */
const source = fs.readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToString } = require('react-dom/server');

const { createBook, writeChapters, loadBook } = await import('../host/books.js');
const { savePart } = await import('../host/parts.js');
const { createSeries, findSeries, patchSeriesLecture, persistSeries } = await import('../host/series.js');
const { writeLectureOutputs } = await import('../host/lectures.js');
const { writePreference, readPreference } = await import('../host/prefs.js');
const { normalizeOffsetMs } = await import('../host/progress.js');
const { routeM1 } = await import('../host/api.js');

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
  assert.equal(out.productVersion, '2.5');
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
  assert.equal(out.productVersion, '2.5');
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

test('页内位置归一化：负数/非数字/过小归 0，24h 封顶', () => {
  assert.equal(normalizeOffsetMs(-1), 0);
  assert.equal(normalizeOffsetMs('x'), 0);
  assert.equal(normalizeOffsetMs(499), 0);
  assert.equal(normalizeOffsetMs(500), 500);
  assert.equal(normalizeOffsetMs(30 * 24 * 60 * 60 * 1000), 24 * 60 * 60 * 1000);
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
  assert.equal(first.progress.offsetMs, 0);

  // 页内位置：显式 offsetMs 落盘；同页缺省保留；显式 0 清除；过小归 0。
  const paused = await post('/dsh-book-slides/series/progress', {
    seriesId: series.id,
    lecture: 2,
    slide: 3,
    offsetMs: 12345,
    audioFile: 'audio/003.wav',
    audioMs: 12000,
    audioProvider: 'qwen3-tts',
  });
  assert.equal(paused.progress.offsetMs, 12345);
  assert.equal(paused.progress.audioFile, 'audio/003.wav');
  assert.equal(paused.progress.audioMs, 12000);
  assert.equal(paused.progress.audioProvider, 'qwen3-tts');
  const savedOffset = await json('/dsh-book-slides/series/progress?seriesId=' + series.id);
  assert.equal(savedOffset.progress.offsetMs, 12345);
  assert.equal(savedOffset.progress.audioFile, 'audio/003.wav');
  const samePage = await post('/dsh-book-slides/series/progress', { seriesId: series.id, lecture: 2, slide: 3 });
  assert.equal(samePage.progress.offsetMs, 12345, '同页缺省 offset 不应清零');
  assert.equal(samePage.progress.audioFile, 'audio/003.wav', '同页缺省时音频身份也要保留');
  const tooSmall = await post('/dsh-book-slides/series/progress', { seriesId: series.id, lecture: 2, slide: 3, offsetMs: 300 });
  assert.equal(tooSmall.progress.offsetMs, 0, '小于 500ms 归 0');
  assert.equal(tooSmall.progress.audioFile, '', '清零时音频身份一并清掉');
  const cleared = await post('/dsh-book-slides/series/progress', { seriesId: series.id, lecture: 2, slide: 3, offsetMs: 0 });
  assert.equal(cleared.progress.offsetMs, 0);

  // 回看第 1 页不回退已听页数，且换页时缺省 offset 归 0。
  const back = await post('/dsh-book-slides/series/progress', { seriesId: series.id, lecture: 2, slide: 1 });
  assert.equal(back.progress.slide, 1);
  assert.equal(back.progress.heardPages, 3);
  assert.equal(back.progress.offsetMs, 0);

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

test('AC-118：设置面板渲染语音/模型/配图/用量/存储/诊断六组', () => {
  const html = renderToString(React.createElement(clientModule.__components.Settings, { onBack: () => {}, notify: () => {} }));
  for (const text of ['语音', '模型（只读）', '配图', '用量与费用', '存储与回收站', '诊断', '升级备份', '清空回收站']) {
    assert.ok(html.includes(text), '设置页应包含「' + text + '」');
  }
});

test('AC-172：设置页顶栏渲染六个标签，默认语音且只显示活动栏目', () => {
  const html = renderToString(React.createElement(clientModule.__components.Settings, { onBack: () => {}, notify: () => {} }));
  const labels = [...html.matchAll(/<button[^>]*role="tab"[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
  assert.deepEqual(labels, ['语音', '模型（只读）', '配图', '用量与费用', '存储与回收站', '诊断']);
  assert.equal((html.match(/role="tab"/g) || []).length, 6);
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
  assert.match(html, /id="blm-tab-voice"[^>]*aria-selected="true"/);
  for (const id of ['voice', 'model', 'image', 'usage', 'storage', 'diagnostics']) {
    assert.ok(html.includes('id="blm-panel-' + id + '"'), '应有面板 blm-panel-' + id);
    assert.ok(html.includes('aria-controls="blm-panel-' + id + '"'), '标签应控制面板 ' + id);
    assert.ok(html.includes('aria-labelledby="blm-tab-' + id + '"'), '面板应关联标签 ' + id);
  }
  const panels = [...html.matchAll(/<section[^>]*role="tabpanel"[^>]*>/g)].map((match) => match[0]);
  assert.equal(panels.length, 6);
  panels.forEach((tag, index) => {
    assert.equal(/\shidden(=""|>|\s)/.test(tag), index !== 0, '面板 ' + index + ' 的 hidden 状态不对');
  });
});

test('AC-173：标签栏有共享下划线指示条、会话记忆与减少动效降级（源码契约）', () => {
  assert.match(source, /SETTINGS_TAB_KEY = 'blm-settings-tab'/);
  assert.match(source, /saveSettingsTab\(activeTab\)/);
  assert.match(source, /\.blm-tab-ink\{[^}]*transition:[^}]*transform 200ms/);
  assert.match(
    source,
    /@media \(prefers-reduced-motion:reduce\)\{[\s\S]*?\.blm-tab,\.blm-tab-ink\{transition:none\}/,
  );
  // 离开语音标签时停止试听：不在后台继续出声。
  assert.match(source, /if \(activeTab === 'voice'\) return;\s*\n\s*if \(probe\.phase === 'playing'\) stopProbe\(\);/);
});

test('AC-172：栏目会话记忆只认白名单，非法值回语音（sessionStorage）', () => {
  const helpers = clientModule.__helpers;
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  try {
    assert.equal(helpers.readSettingsTab(), 'voice');
    helpers.saveSettingsTab('image');
    assert.equal(store.get('blm-settings-tab'), 'image');
    assert.equal(helpers.readSettingsTab(), 'image');
    store.set('blm-settings-tab', 'nope');
    assert.equal(helpers.readSettingsTab(), 'voice');
  } finally {
    delete globalThis.sessionStorage;
  }
});

test('AC-174：标签键盘导航左右循环、Home/End 首尾', () => {
  const helpers = clientModule.__helpers;
  assert.equal(helpers.settingsTabIndexForKey(0, 'ArrowRight'), 1);
  assert.equal(helpers.settingsTabIndexForKey(5, 'ArrowRight'), 0);
  assert.equal(helpers.settingsTabIndexForKey(0, 'ArrowLeft'), 5);
  assert.equal(helpers.settingsTabIndexForKey(4, 'ArrowLeft'), 3);
  assert.equal(helpers.settingsTabIndexForKey(3, 'Home'), 0);
  assert.equal(helpers.settingsTabIndexForKey(1, 'End'), 5);
  assert.equal(helpers.settingsTabIndexForKey(2, 'Enter'), -1);
});

test('AC-174：标签栏键盘导航与单行横向滚动契约', () => {
  assert.match(source, /role: 'tablist'/);
  assert.match(source, /ArrowRight/);
  assert.match(source, /ArrowLeft/);
  assert.match(source, /'Home'/);
  assert.match(source, /'End'/);
  assert.match(source, /\.blm-tabs\{[^}]*overflow-x:auto/);
  assert.match(source, /\.blm-tabs-wrap\{[^}]*position:sticky/);
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
await import('../client/index.js');

/* ------------------------------ FR-18.2 布局按系列（2.4） ------------------------------ */

test('AC-170：/series/view 默认 ppt-left + 原文 55%，无记录不落盘；两个系列互不影响', async () => {
  writePreference({ split: 0.55 });
  const bookA = makeBook('view-a');
  const seriesA = makeSeries(bookA, 'view-a');
  const dirA = findSeries(seriesA.id).dir;
  const viewPathA = path.join(dirA, 'view.json');
  fs.rmSync(viewPathA, { force: true });

  const initial = await json('/dsh-book-slides/series/view?seriesId=' + seriesA.id);
  assert.equal(initial.ok, true);
  assert.equal(initial.view.layout, 'ppt-left', '默认左幻灯片');
  assert.equal(initial.view.split, 0.55, '默认原文宽度取 preference.split');
  assert.equal(initial.view.series_id, seriesA.id);
  assert.equal(fs.existsSync(viewPathA), false, '只读默认值不应落盘');

  const swapped = await post('/dsh-book-slides/series/view', { seriesId: seriesA.id, layout: 'pdf-left', split: 0.3 });
  assert.equal(swapped.ok, true);
  assert.equal(swapped.view.layout, 'pdf-left');
  assert.equal(swapped.view.split, 0.3);
  assert.equal(fs.existsSync(viewPathA), true, '换位后要落盘');
  const onDisk = JSON.parse(fs.readFileSync(viewPathA, 'utf8'));
  assert.deepEqual(Object.keys(onDisk).sort(), ['layout', 'schema', 'series_id', 'split', 'updated_at']);
  assert.equal(onDisk.schema, 1);
  assert.equal(onDisk.series_id, seriesA.id);
  assert.ok(Date.parse(onDisk.updated_at) > 0);

  // 另一个系列（另一本书）保持默认，且不因 A 的写入而落盘
  const bookB = makeBook('view-b');
  const seriesB = makeSeries(bookB, 'view-b');
  const viewPathB = path.join(findSeries(seriesB.id).dir, 'view.json');
  const viewB = await json('/dsh-book-slides/series/view?seriesId=' + seriesB.id);
  assert.equal(viewB.view.layout, 'ppt-left');
  assert.equal(viewB.view.split, 0.55);
  assert.equal(fs.existsSync(viewPathB), false);

  // 回读 A：方向与比例都在
  const reread = await json('/dsh-book-slides/series/view?seriesId=' + seriesA.id);
  assert.equal(reread.view.layout, 'pdf-left');
  assert.equal(reread.view.split, 0.3);

  // 全局偏好的 split 仍是 0.55——按系列的宽度没有回写全局
  assert.equal(readPreference().split, 0.55);

  // 只改方向时保留比例
  const layoutOnly = await post('/dsh-book-slides/series/view', { seriesId: seriesA.id, layout: 'ppt-left' });
  assert.equal(layoutOnly.view.layout, 'ppt-left');
  assert.equal(layoutOnly.view.split, 0.3);

  // 删系列后目录与 view.json 一并消失
  const removed = await json('/dsh-book-slides/series', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seriesId: seriesA.id }),
  });
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(dirA), false);
  const gone = await json('/dsh-book-slides/series/view?seriesId=' + seriesA.id);
  assert.equal(gone.ok, false);
  assert.equal(gone.code, 'E_NOT_FOUND');
});

test('AC-171：非法 layout/split 回落夹紧；坏 view.json 按默认渲染；不写 preference.layout', async () => {
  const book = makeBook('view-bad');
  const series = makeSeries(book, 'view-bad');
  const dir = findSeries(series.id).dir;
  const file = path.join(dir, 'view.json');

  writePreference({ split: 0.5, rate: 1, muted: false });
  const badLayout = await post('/dsh-book-slides/series/view', { seriesId: series.id, layout: 'sideways' });
  assert.equal(badLayout.ok, true);
  assert.equal(badLayout.view.layout, 'ppt-left', '非法方向回默认');

  const high = await post('/dsh-book-slides/series/view', { seriesId: series.id, split: 0.98 });
  assert.equal(high.view.split, 0.75);
  const low = await post('/dsh-book-slides/series/view', { seriesId: series.id, split: 0.01 });
  assert.equal(low.view.split, 0.25);
  const junk = await post('/dsh-book-slides/series/view', { seriesId: series.id, split: 'x' });
  assert.equal(junk.view.split, 0.25, '非法数值保留上一次的合法值');

  // 缺字段不动另一字段
  const onlyLayout = await post('/dsh-book-slides/series/view', { seriesId: series.id, layout: 'pdf-left' });
  assert.equal(onlyLayout.view.layout, 'pdf-left');
  assert.equal(onlyLayout.view.split, 0.25);

  // 坏 JSON / 缺字段：按默认渲染，不崩、不覆盖
  fs.writeFileSync(file, '{bad json');
  const broken = await json('/dsh-book-slides/series/view?seriesId=' + series.id);
  assert.equal(broken.ok, true);
  assert.equal(broken.view.layout, 'ppt-left');
  assert.equal(broken.view.split, 0.5, '损坏时原文宽度回落到 preference.split');
  assert.equal(fs.readFileSync(file, 'utf8'), '{bad json', '只读请求不得覆盖坏文件');

  fs.writeFileSync(file, JSON.stringify({ schema: 1, layout: 'pdf-left' }));
  const partial = await json('/dsh-book-slides/series/view?seriesId=' + series.id);
  assert.equal(partial.view.layout, 'pdf-left');
  assert.equal(partial.view.split, 0.5);
  assert.equal(partial.view.series_id, series.id, 'series_id 以目录为准');

  // 未知字段丢弃
  const junkFields = await post('/dsh-book-slides/series/view', { seriesId: series.id, layout: 'pdf-left', extra: 1 });
  assert.equal(junkFields.ok, true);
  assert.deepEqual(Object.keys(junkFields.view).sort(), ['layout', 'schema', 'series_id', 'split', 'updated_at']);

  // 缺失/非法 seriesId 仍是 404 语义，不是 500
  const missing = await json('/dsh-book-slides/series/view?seriesId=');
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'E_NOT_FOUND');

  // 全局偏好不出现 layout
  const pref = JSON.parse(fs.readFileSync(path.join(ROOT, 'preference.json'), 'utf8'));
  assert.equal('layout' in pref, false);
  assert.equal(pref.split, 0.5);
});

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
