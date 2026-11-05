/**
 * 2.0 M5 配图（FR-24 / AC-120）。
 *
 * 假 ComfyUI（fetch 注入）：配置/工作流/探活/测试生图/逐页作业/单页重试/取消/失败兜底。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-images-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, writeChapters } = await import('../v2/books.js');
const { savePart } = await import('../v2/parts.js');
const { createSeries, findSeries, patchSeriesLecture, persistSeries } = await import('../v2/series.js');
const { writeLectureOutputs } = await import('../v2/lectures.js');
const { routeM1 } = await import('../v2/api.js');

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const ctl = { failSubmit: false, slowHistory: 0 };

function fakeFetch(url, init) {
  const parsed = new URL(String(url));
  const pathname = parsed.pathname;
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  if (pathname.endsWith('/system_stats')) return Promise.resolve(json({ system: { comfyui_version: '0.3.99' } }));
  if (pathname.startsWith('/object_info/')) return Promise.resolve(json({}));
  if (pathname === '/prompt') {
    if (ctl.failSubmit) return Promise.resolve(new Response(JSON.stringify({ error: 'model missing' }), { status: 500 }));
    return Promise.resolve(json({ prompt_id: 'p1' }));
  }
  if (pathname.startsWith('/history/')) {
    if (ctl.slowHistory) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(json({ p1: { status: { completed: true }, outputs: { '9': { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } } } })), ctl.slowHistory);
        const signal = init && init.signal;
        if (signal) {
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve(new Response('aborted', { status: 499 }));
            },
            { once: true },
          );
        }
      });
    }
    return Promise.resolve(json({ p1: { status: { completed: true }, outputs: { '9': { images: [{ filename: 'x.png', subfolder: '', type: 'output' }] } } } }));
  }
  if (pathname === '/view') return Promise.resolve(new Response(PNG_1PX, { status: 200, headers: { 'content-type': 'image/png' } }));
  return Promise.resolve(new Response('not found', { status: 404 }));
}

function makeSeriesFixture() {
  const pages = [{ page: 1, text: '第1章 甲\n' + '甲'.repeat(3000) }];
  const book = createBook({
    buffer: Buffer.from('v2-images-' + Date.now()),
    fileName: 'images.pdf',
    title: '配图测试书',
    author: '',
    pages: 1,
    rawPages: pages,
  });
  writeChapters(book.id, [{ n: 1, title: '第1章 甲', from: 1, to: 1, chars: 3000, front: false }], 'manual');
  const part = savePart({ bookId: book.id, chapters: [1], title: '图' });
  const series = createSeries({
    bookId: book.id,
    partId: part.id,
    title: '图',
    plan: {
      throughline: '图',
      lectures: [{ n: 1, chapters: [1], title: '第 1 讲 · 图', goal: '', pages: 4, chars: 3000 }],
      seams: [],
      terms: [],
      cut_notes: [],
      source: 'model',
      stitched: true,
      totalChars: 3000,
      totalPages: 4,
      estMinutes: 4,
    },
  });
  const found = findSeries(series.id);
  const slides = Array.from({ length: 4 }, (_, index) => ({
    slide_index: index + 1,
    layout: index === 0 ? 'cover' : 'content_text',
    title: '第 1 讲 第 ' + (index + 1) + ' 页',
    bullet_points: ['要点'],
    quote_text: '',
    quote_source: '',
    audio_script: '朗读稿' + index,
    source_quote: '原文'.repeat(20),
    source_pages: { from: 1, to: 1 },
    audio_file: null,
    audio_provider: 'none',
    audio_ms: 0,
    image_prompt: '一台机器在纸上画出曲线' + index,
    image_file: null,
    image_status: 'pending',
  }));
  writeLectureOutputs(
    found.dir,
    1,
    { schema: 1, series_id: series.id, n: 1, title: '第 1 讲 · 图', chapters: [1], pages: 4, chars: 3000, status: 'ready', voice_status: 'none' },
    { schema_version: 1, series_id: series.id, lecture: 1, slides },
  );
  patchSeriesLecture(found.series, 1, { status: 'ready', pages: 4, chars: 3000 });
  found.series.status = 'ready';
  persistSeries(found.series);
  return { book, series: found.series, dir: found.dir };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const handled = await routeM1(req, res, url, { ctx: null, imageFetch: fakeFetch });
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

async function waitImage(seriesId, predicate, timeout = 15000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await json('/dsh-book-slides/image/status?seriesId=' + seriesId);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等待配图作业超时：' + JSON.stringify(last));
}

const fixture = makeSeriesFixture();

test('AC-120：默认提示词占位不产生图；配置 ComfyUI 后可探活与测试生图', async () => {
  const config = await json('/dsh-book-slides/image/config');
  assert.equal(config.ok, true);
  assert.equal(config.image.provider, 'prompt');
  assert.equal(config.image.host, '127.0.0.1');
  assert.equal(config.image.port, 8188);

  const disabled = await post('/dsh-book-slides/image/regen', { seriesId: fixture.series.id });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.code, 'E_IMG_DISABLED');

  ctl.failSubmit = false;
  const saved = await post('/dsh-book-slides/image/config', { provider: 'comfyui', host: '127.0.0.1', port: 8188, styleSuffix: '水墨风' });
  assert.equal(saved.ok, true);
  assert.equal(saved.image.provider, 'comfyui');
  assert.equal(saved.image.styleSuffix, '水墨风');
  const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'image.json'), 'utf8'));
  assert.equal(onDisk.provider, 'comfyui');

  const probe = await post('/dsh-book-slides/image/probe', {});
  assert.equal(probe.ok, true);
  assert.deepEqual(probe.missing, []);
  assert.equal(probe.workflow.source, 'default');

  const testRes = await fetch(baseUrl + '/dsh-book-slides/image/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '测试一张图' }),
  });
  assert.equal(testRes.status, 200);
  assert.equal(testRes.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await testRes.arrayBuffer()).slice(1, 4).toString('ascii'), 'PNG');
});

test('AC-120：逐页生成、单页重试只替换该页、文本字段不变', async () => {
  ctl.failSubmit = false;
  ctl.slowHistory = 0;
  const before = JSON.parse(fs.readFileSync(path.join(fixture.dir, 'lectures', '1', 'slides.json'), 'utf8'));
  const started = await post('/dsh-book-slides/image/regen', { seriesId: fixture.series.id });
  assert.equal(started.ok, true);
  assert.equal(started.total, 3);
  const done = await waitImage(fixture.series.id, (job) => ['done', 'failed', 'cancelled'].includes(job.status));
  assert.equal(done.status, 'done', JSON.stringify(done));
  assert.equal(done.done, 3);
  assert.equal(done.failed, 0);

  const after = JSON.parse(fs.readFileSync(path.join(fixture.dir, 'lectures', '1', 'slides.json'), 'utf8'));
  for (let index = 1; index < after.slides.length; index += 1) {
    assert.equal(after.slides[index].image_status, 'ready');
    assert.equal(after.slides[index].image_file, 'images/' + String(index + 1).padStart(3, '0') + '.png');
    assert.equal(after.slides[index].title, before.slides[index].title);
    assert.equal(after.slides[index].audio_script, before.slides[index].audio_script);
  }
  assert.ok(fs.existsSync(path.join(fixture.dir, 'lectures', '1', 'images', '002.png')));

  const image = await fetch(baseUrl + '/dsh-book-slides/image?seriesId=' + fixture.series.id + '&lecture=1&i=2');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');

  const firstSeed = after.slides[1].image_seed;
  const regenOne = await post('/dsh-book-slides/image/regen', { seriesId: fixture.series.id, lecture: 1, slide: 3 });
  assert.equal(regenOne.ok, true);
  assert.equal(regenOne.total, 1);
  const doneOne = await waitImage(fixture.series.id, (job) => ['done', 'failed', 'cancelled'].includes(job.status));
  assert.equal(doneOne.done, 1);
  const onlyOne = JSON.parse(fs.readFileSync(path.join(fixture.dir, 'lectures', '1', 'slides.json'), 'utf8'));
  assert.equal(onlyOne.slides[1].image_seed, firstSeed, '单页重试不得改其它页');
  const nothing = await post('/dsh-book-slides/image/regen', { seriesId: fixture.series.id, lecture: 1 });
  assert.equal(nothing.ok, false);
  assert.equal(nothing.code, 'E_IMG_NOTHING');
});

test('AC-120：ComfyUI 不可用时该页留白并给 warning，失败页可单页重试', async () => {
  ctl.failSubmit = true;
  const failed = await post('/dsh-book-slides/image/regen', { seriesId: fixture.series.id, lecture: 1, slide: 3, force: true });
  assert.equal(failed.ok, true);
  const done = await waitImage(fixture.series.id, (job) => ['done', 'failed', 'cancelled'].includes(job.status));
  assert.equal(done.status, 'failed');
  const slides = JSON.parse(fs.readFileSync(path.join(fixture.dir, 'lectures', '1', 'slides.json'), 'utf8'));
  assert.equal(slides.slides[2].image_status, 'failed');
  assert.equal(slides.slides[2].image_file, null);
  assert.ok(String(slides.slides[2].image_prompt).length > 0, '失败页保留提示词占位');
  assert.equal(slides.slides[1].image_status, 'ready', '其它页不受影响');

  ctl.failSubmit = false;
  const retry = await post('/dsh-book-slides/image/regen', { seriesId: fixture.series.id, lecture: 1, slide: 3 });
  assert.equal(retry.ok, true);
  const fixed = await waitImage(fixture.series.id, (job) => ['done', 'failed', 'cancelled'].includes(job.status));
  assert.equal(fixed.status, 'done');
  const after = JSON.parse(fs.readFileSync(path.join(fixture.dir, 'lectures', '1', 'slides.json'), 'utf8'));
  assert.equal(after.slides[2].image_status, 'ready');
});

test('AC-120 / AC-135：配图作业可取消，状态 cancelled，已生成页保留', async () => {
  ctl.failSubmit = false;
  ctl.slowHistory = 2500;
  const started = await post('/dsh-book-slides/image/regen', { seriesId: fixture.series.id, force: true });
  assert.equal(started.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const cancelled = await post('/dsh-book-slides/image/cancel', { seriesId: fixture.series.id });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.cancelled, true);
  const done = await waitImage(fixture.series.id, (job) => ['done', 'failed', 'cancelled', 'interrupted'].includes(job.status));
  assert.equal(done.status, 'cancelled');
  ctl.slowHistory = 0;
});

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
