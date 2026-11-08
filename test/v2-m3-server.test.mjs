/**
 * 2.0 M3 路由：系列生成、作业进度/取消/续跑、单讲重跑、后验缝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-m3-route-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, writeChapters } = await import('../v2/books.js');
const { savePart } = await import('../v2/parts.js');
const { createSeries } = await import('../v2/series.js');
const { routeM1 } = await import('../v2/api.js');

const SEAM = '上一讲把函数当机器；这一讲只问靠近某点时输出去哪。';
const ctl = { delay: 0, slowLecture: 0, failLecture: 0, hangLecture: 0 };

function makeBook(tag) {
  const rawPages = [
    { page: 1, text: '第1章 甲\n' + '甲'.repeat(11000) },
    { page: 2, text: '第2章 乙\n' + '乙'.repeat(11000) },
  ];
  const chapters = [
    { n: 1, title: '第1章 甲', from: 1, to: 1, chars: 11000, front: false },
    { n: 2, title: '第2章 乙', from: 2, to: 2, chars: 11000, front: false },
  ];
  const book = createBook({ buffer: Buffer.from('m3-route-' + tag + '-' + Date.now()), fileName: tag + '.pdf', title: 'M3 路由 ' + tag, author: '', pages: 2, rawPages });
  writeChapters(book.id, chapters, 'manual');
  const part = savePart({ bookId: book.id, chapters: [1, 2], title: '函数' });
  const series = createSeries({
    bookId: book.id,
    partId: part.id,
    title: '函数',
    plan: {
      throughline: '把函数当机器，再看它靠近某点时输出去哪。',
      lectures: [
        { n: 1, chapters: [1], title: '第 1 讲 · 机器', goal: 'g1', in: '', out: '', pages: 6, chars: 11000 },
        { n: 2, chapters: [2], title: '第 2 讲 · 靠近', goal: 'g2', in: '机器', out: '', pages: 6, chars: 11000 },
      ],
      seams: [{ from: 1, to: 2, concept: '极限', sentence: SEAM }],
      terms: [{ name: '定义域', forbid: ['定义区间'] }],
      cut_notes: [],
      source: 'model',
      stitched: true,
      totalChars: 22000,
      totalPages: 12,
      estMinutes: 12,
    },
  });
  return { book, series };
}

function base(lec, i, ch) {
  const mark = ch === 1 ? '甲' : '乙';
  const common = {
    layout: i === 0 ? 'cover' : 'content_text',
    title: i === 0 ? '第 ' + lec + ' 讲' : mark + '讲要点 ' + i,
    subtitle: i === 0 ? '函数与极限' : '',
    bullet_points: i === 0 ? [] : [mark.repeat(20), mark.repeat(12) + '收束'],
    quote_text: null,
    quote_source: null,
    image_prompt: mark + '机器在纸上画出曲线',
    audio_script: mark.repeat(60),
    source_quote: mark.repeat(60),
    source_pages: { from: ch, to: ch },
  };
  return common;
}

const ctx = {
  get(name) {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
    if (name !== 'llm') return null;
    return {
      async prepareCall() {
        return {
          config: {},
          async *stream(config) {
            const user = config.messages[0].content[0].text;
            const line = user.split('\n').find((item) => item.includes('【必须】'));
            if (user.includes('【任务】只重写这一页的 audio_script')) {
              const sentence = line.split('：').slice(1).join('：').trim();
              const cover = line.includes('逐字开头');
              yield { type: 'text-delta', text: JSON.stringify({ audio_script: cover ? sentence + ' 这是修好之后的封面朗读稿。' : '这是修好之后的末页朗读稿。 ' + sentence }) };
              yield { type: 'finish', reason: { kind: 'stop' } };
              return;
            }
            const match = /【本讲】第 (\d+)\//.exec(user);
            const lectureNo = match ? Number(match[1]) : 1;
            if (ctl.failLecture === lectureNo) throw new Error('fake lecture failure');
            if (ctl.hangLecture === lectureNo) {
              const signal = config.signal;
              await new Promise((resolve, reject) => {
                const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
                if (!signal) return;
                if (signal.aborted) fail();
                else signal.addEventListener('abort', fail, { once: true });
              });
            }
            if (ctl.delay && ctl.slowLecture === lectureNo) await new Promise((resolve) => setTimeout(resolve, ctl.delay));
            yield {
              type: 'text-delta',
              text: JSON.stringify({
                module_title: '',
                slides: Array.from({ length: 6 }, (_, index) => base(lectureNo, index, lectureNo)),
              }),
            };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      },
    };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const handled = await routeM1(req, res, url, { ctx });
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

async function waitJob(seriesId, predicate, timeout = 6000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await json('/dsh-book-slides/series/job?seriesId=' + encodeURIComponent(seriesId));
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待作业超时，最后状态：' + JSON.stringify(last));
}

test('M3 路由：start → job → 讲义 → 后验缝 → 单讲重跑', async () => {
  ctl.delay = 0;
  ctl.slowLecture = 0;
  ctl.failLecture = 0;
  const { book, series } = makeBook('flow');
  const started = await post('/dsh-book-slides/series/start', { seriesId: series.id });
  assert.equal(started.ok, true);
  assert.ok(started.jobId);
  await waitJob(series.id, (job) => job.status === 'ready');

  const seriesOut = await json('/dsh-book-slides/series?seriesId=' + series.id);
  assert.equal(seriesOut.series.status, 'ready');
  assert.equal(seriesOut.series.stitch, 'stitched');

  const lectureOne = await json('/dsh-book-slides/lecture?seriesId=' + series.id + '&n=1');
  assert.equal(lectureOne.ok, true);
  assert.equal(lectureOne.slides.slides.length, 6);
  assert.ok(String(lectureOne.slides.slides[5].audio_script).endsWith(SEAM));
  const lectureTwo = await json('/dsh-book-slides/lecture?seriesId=' + series.id + '&n=2');
  assert.ok(String(lectureTwo.slides.slides[0].audio_script).startsWith(SEAM));

  const stitch = await json('/dsh-book-slides/series/stitch?seriesId=' + series.id);
  assert.equal(stitch.ok, true);
  assert.equal(stitch.stitch.state, 'stitched');
  assert.equal(stitch.stitch.metrics.find((m) => m.id === 'seam').value, '100%');

  const again = await post('/dsh-book-slides/series/start', { seriesId: series.id });
  assert.equal(again.cached, true);
  assert.equal(again.jobId, null);

  const lectureOneFile = path.join(ROOT, 'books', book.id, 'series', series.id, 'lectures', '1', 'slides.json');
  const lectureTwoFile = path.join(ROOT, 'books', book.id, 'series', series.id, 'lectures', '2', 'slides.json');
  const oneMtime = fs.statSync(lectureOneFile).mtimeMs;
  const twoMtime = fs.statSync(lectureTwoFile).mtimeMs;

  const single = await post('/dsh-book-slides/series/lecture/generate', { seriesId: series.id, n: 2 });
  assert.equal(single.ok, true);
  assert.ok(single.jobId);
  await waitJob(series.id, (job) => job.status === 'ready');
  assert.equal(fs.statSync(lectureOneFile).mtimeMs, oneMtime);
  assert.notEqual(fs.statSync(lectureTwoFile).mtimeMs, twoMtime);

  const twoMtimeAfter = fs.statSync(lectureTwoFile).mtimeMs;
  const explicit = await post('/dsh-book-slides/series/start', { seriesId: series.id, lectures: [1] });
  assert.equal(explicit.ok, true);
  assert.ok(explicit.jobId);
  await waitJob(series.id, (job) => job.status === 'ready');
  assert.equal(fs.statSync(lectureTwoFile).mtimeMs, twoMtimeAfter);

  const resume = await post('/dsh-book-slides/series/resume', { seriesId: series.id });
  assert.equal(resume.cached, true);
  assert.deepEqual(resume.skipped, [1, 2]);
});

test('M3 作业：第 2 讲失败为 partial，重试只重跑该讲，第 1 讲不变', async () => {
  ctl.delay = 0;
  ctl.failLecture = 2;
  const { book, series } = makeBook('retry');
  const started = await post('/dsh-book-slides/series/start', { seriesId: series.id });
  assert.equal(started.ok, true);
  const partial = await waitJob(series.id, (job) => job.status === 'partial');
  assert.equal(partial.status, 'partial');

  const lectureOneFile = path.join(ROOT, 'books', book.id, 'series', series.id, 'lectures', '1', 'slides.json');
  const oneMtime = fs.statSync(lectureOneFile).mtimeMs;
  const lectureTwo = await json('/dsh-book-slides/lecture?seriesId=' + series.id + '&n=2');
  assert.equal(lectureTwo.ok, true);
  assert.equal(lectureTwo.lecture.status, 'failed');

  const cachedRetry = await post('/dsh-book-slides/series/retry', { seriesId: series.id, lecture: 1 });
  assert.equal(cachedRetry.cached, true);

  ctl.failLecture = 0;
  const retry = await post('/dsh-book-slides/series/retry', { seriesId: series.id, lecture: 2 });
  assert.equal(retry.ok, true);
  assert.ok(retry.jobId);
  await waitJob(series.id, (job) => job.status === 'ready');
  assert.equal(fs.statSync(lectureOneFile).mtimeMs, oneMtime);
  const lectureTwoAfter = await json('/dsh-book-slides/lecture?seriesId=' + series.id + '&n=2');
  assert.equal(lectureTwoAfter.lecture.status, 'ready');
  assert.equal(lectureTwoAfter.slides.slides.length, 6);
});

test('M3 作业：取消后系列 cancelled，续跑跳过已 ready 的第 1 讲', async () => {
  ctl.failLecture = 0;
  ctl.delay = 400;
  ctl.slowLecture = 2;
  const { book, series } = makeBook('cancel');
  const started = await post('/dsh-book-slides/series/start', { seriesId: series.id });
  assert.equal(started.ok, true);
  const running = await waitJob(series.id, (job) => job.lecture === 2 && ['structuring', 'validate', 'anchor'].includes(job.stage));
  assert.equal(running.status, 'drafting');
  const cancelled = await post('/dsh-book-slides/series/cancel', { seriesId: series.id });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.cancelled, true);
  const afterCancel = await waitJob(series.id, (job) => job.status === 'cancelled');
  assert.equal(afterCancel.status, 'cancelled');
  const seriesCancelled = await json('/dsh-book-slides/series?seriesId=' + series.id);
  assert.equal(seriesCancelled.series.status, 'cancelled');

  const lectureOneFile = path.join(ROOT, 'books', book.id, 'series', series.id, 'lectures', '1', 'slides.json');
  const oneMtime = fs.statSync(lectureOneFile).mtimeMs;
  ctl.delay = 0;
  const resumed = await post('/dsh-book-slides/series/resume', { seriesId: series.id });
  assert.equal(resumed.ok, true);
  assert.ok(resumed.jobId);
  assert.deepEqual(resumed.skipped, [1]);
  await waitJob(series.id, (job) => job.status === 'ready');
  assert.equal(fs.statSync(lectureOneFile).mtimeMs, oneMtime);
});

test('M3 解耦：draft 系列不能 start', async () => {
  const rawPages = [{ page: 1, text: '第1章 草稿\n' + '丙'.repeat(11000) }];
  const book = createBook({
    buffer: Buffer.from('m3-draft-' + Date.now()),
    fileName: 'draft.pdf',
    title: '草稿书',
    author: '',
    pages: 1,
    rawPages,
  });
  writeChapters(book.id, [{ n: 1, title: '第1章 草稿', from: 1, to: 1, chars: 11000, front: false }], 'manual');
  const part = savePart({ bookId: book.id, chapters: [1], title: '草稿部分' });
  const draft = createSeries({ bookId: book.id, partId: part.id, title: '草稿系列' });
  const blocked = await post('/dsh-book-slides/series/start', { seriesId: draft.id });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'E_SERIES_UNPLANNED');
});

test('AC-135：生成超时 → E_LLM_TIMEOUT，不留半截讲', async () => {
  ctl.delay = 0;
  ctl.failLecture = 0;
  ctl.hangLecture = 1;
  process.env.DSH_BOOK_SLIDES_LLM_TIMEOUT_MS = '200';
  try {
    const { book, series } = makeBook('timeout');
    const started = await post('/dsh-book-slides/series/start', { seriesId: series.id });
    assert.equal(started.ok, true);
    const job = await waitJob(series.id, (j) => ['partial', 'failed', 'ready'].includes(j.status));
    assert.notEqual(job.status, 'ready');
    const failures = (job.error && job.error.failures) || [];
    assert.equal(failures[0] && failures[0].code, 'E_LLM_TIMEOUT');
    const slidesOne = path.join(ROOT, 'books', book.id, 'series', series.id, 'lectures', '1', 'slides.json');
    assert.equal(fs.existsSync(slidesOne), false, '超时不得留下半截 slides.json');
  } finally {
    ctl.hangLecture = 0;
    delete process.env.DSH_BOOK_SLIDES_LLM_TIMEOUT_MS;
  }
});

test('AC-114：N=1 系列只有 1 讲；删除后该讲不可访问', async () => {
  const rawPages = [{ page: 1, text: '第1章 独讲\n' + '丁'.repeat(11000) }];
  const book = createBook({
    buffer: Buffer.from('m3-solo-' + Date.now()),
    fileName: 'solo.pdf',
    title: '独讲书',
    author: '',
    pages: 1,
    rawPages,
  });
  writeChapters(book.id, [{ n: 1, title: '第1章 独讲', from: 1, to: 1, chars: 11000, front: false }], 'manual');
  const part = savePart({ bookId: book.id, chapters: [1], title: '独讲部分' });
  const series = createSeries({
    bookId: book.id,
    partId: part.id,
    title: '独讲系列',
    plan: {
      throughline: '只讲一章',
      lectures: [{ n: 1, chapters: [1], title: '第 1 讲', goal: '', in: '', out: '', pages: 6, chars: 11000 }],
      seams: [],
      terms: [],
      cut_notes: [],
      source: 'rule',
      stitched: true,
      totalChars: 11000,
      totalPages: 6,
      estMinutes: 6,
    },
  });
  const list = await json('/dsh-book-slides/series?bookId=' + book.id);
  assert.equal(list.ok, true);
  assert.equal(list.series.length, 1);
  assert.equal(list.series[0].lectures.length, 1);
  const del = await json('/dsh-book-slides/series?seriesId=' + series.id, { method: 'DELETE' });
  assert.equal(del.ok, true);
  const gone = await json('/dsh-book-slides/lecture?seriesId=' + series.id + '&n=1');
  assert.equal(gone.ok, false);
  assert.equal(gone.code, 'E_NOT_FOUND');
});

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
