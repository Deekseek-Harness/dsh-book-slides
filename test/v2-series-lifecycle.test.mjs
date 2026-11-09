/**
 * 2.0 M3/M4 系列生命周期：删除（AC-130）与断点续跑/单讲重试（AC-131）。
 *
 * 删除契约：运行中的作业先取消，再删系列目录；书与 Part 保留；不留下游离讲。
 * 续跑契约：已 ready 的讲跳过；单讲重试只动该讲；Part 不被修改。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-lifecycle-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, writeChapters } = await import('../host/books.js');
const { savePart, listParts } = await import('../host/parts.js');
const { createSeries, findSeries } = await import('../host/series.js');
const { routeM1 } = await import('../host/api.js');

const SEAM = '上一讲把函数当机器；这一讲只问靠近某点时输出去哪。';
const ctl = { delay: 0, slowLecture: 0, failLecture: 0 };

function makeBook(tag) {
  const book = createBook({
    buffer: Buffer.from('m4-lifecycle-' + tag + '-' + Date.now()),
    fileName: tag + '.pdf',
    title: '生命周期 ' + tag,
    author: '',
    pages: 2,
    rawPages: [
      { page: 1, text: '第1章 甲\n' + '甲'.repeat(11000) },
      { page: 2, text: '第2章 乙\n' + '乙'.repeat(11000) },
    ],
  });
  writeChapters(book.id, [
    { n: 1, title: '第1章 甲', from: 1, to: 1, chars: 11000, front: false },
    { n: 2, title: '第2章 乙', from: 2, to: 2, chars: 11000, front: false },
  ], 'manual');
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
  return { book, part, series, found: findSeries(series.id) };
}

function slide(lecture, i, chapter) {
  const mark = chapter === 1 ? '甲' : '乙';
  return {
    layout: i === 0 ? 'cover' : 'content_text',
    title: i === 0 ? '第 ' + lecture + ' 讲' : mark + '讲要点 ' + i,
    subtitle: i === 0 ? '函数与极限' : '',
    bullet_points: i === 0 ? [] : [mark.repeat(20), mark.repeat(12)],
    image_prompt: mark + '机器',
    audio_script: mark.repeat(60),
    source_quote: mark.repeat(60),
    source_pages: { from: chapter, to: chapter },
  };
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
            const match = /【本讲】第 (\d+)\//.exec(user);
            const lectureNo = match ? Number(match[1]) : 1;
            if (ctl.failLecture === lectureNo) throw new Error('fake lecture failure');
            if (ctl.delay && ctl.slowLecture === lectureNo) await new Promise((resolve) => setTimeout(resolve, ctl.delay));
            const chapter = lectureNo === 1 ? 1 : 2;
            yield {
              type: 'text-delta',
              text: JSON.stringify({
                module_title: '',
                slides: Array.from({ length: 6 }, (_, index) => slide(lectureNo, index, chapter)),
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

function del(url) {
  return json(url, { method: 'DELETE' });
}

async function waitJob(seriesId, predicate, timeout = 8000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await json('/dsh-book-slides/series/job?seriesId=' + encodeURIComponent(seriesId));
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待作业超时：' + JSON.stringify(last));
}

function seriesDirOf(found) {
  return path.join(ROOT, 'books', found.series.book_id, 'series', found.series.id);
}

test('AC-130：删除空闲系列只删系列目录，书与 Part 保留', async () => {
  ctl.delay = 0;
  const { book, part, series, found } = makeBook('idle');
  const before = await json('/dsh-book-slides/parts?bookId=' + book.id);
  const dir = seriesDirOf(found);
  assert.ok(fs.existsSync(dir));

  const out = await del('/dsh-book-slides/series?seriesId=' + series.id);
  assert.equal(out.ok, true);
  assert.equal(out.seriesId, series.id);
  assert.equal(out.cancelledJob, false);
  assert.equal(fs.existsSync(dir), false);

  const list = await json('/dsh-book-slides/series?bookId=' + book.id);
  assert.deepEqual(list.series, []);
  const lecture = await json('/dsh-book-slides/lecture?seriesId=' + series.id + '&n=1');
  assert.equal(lecture.ok, false);
  assert.equal(lecture.code, 'E_NOT_FOUND');

  const bookOut = await json('/dsh-book-slides/book?bookId=' + book.id);
  assert.equal(bookOut.ok, true);
  const after = await json('/dsh-book-slides/parts?bookId=' + book.id);
  assert.deepEqual(after.parts.map((item) => item.id), before.parts.map((item) => item.id));
  assert.deepEqual(after.parts[0].chapters, [1, 2]);
  assert.equal(after.parts[0].version, before.parts[0].version);
  assert.equal(listParts(book.id).length, 1);
  assert.equal(part.id, after.parts[0].id);
});

test('AC-130：删除运行中的系列先取消作业，目录不复活', async () => {
  ctl.failLecture = 0;
  ctl.delay = 600;
  ctl.slowLecture = 2;
  const { book, series, found } = makeBook('running');
  const started = await post('/dsh-book-slides/series/start', { seriesId: series.id });
  assert.equal(started.ok, true);
  await waitJob(series.id, (job) => job.lecture === 2 && ['structuring', 'validate', 'anchor'].includes(job.stage));

  const dir = seriesDirOf(found);
  const out = await del('/dsh-book-slides/series?seriesId=' + series.id);
  assert.equal(out.ok, true);
  assert.equal(out.cancelledJob, true);
  assert.equal(fs.existsSync(dir), false);

  // 给被取消的作业一点时间：它不能再把系列目录写回来
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(fs.existsSync(dir), false);

  const bookOut = await json('/dsh-book-slides/book?bookId=' + book.id);
  assert.equal(bookOut.ok, true);
  const parts = await json('/dsh-book-slides/parts?bookId=' + book.id);
  assert.equal(parts.parts.length, 1);
  const list = await json('/dsh-book-slides/series?bookId=' + book.id);
  assert.deepEqual(list.series, []);
  ctl.delay = 0;
});

test('AC-130：删除不存在的系列返回 E_NOT_FOUND', async () => {
  const out = await del('/dsh-book-slides/series?seriesId=zzzzzzzzzz');
  assert.equal(out.ok, false);
  assert.equal(out.code, 'E_NOT_FOUND');
});

test('AC-131：续跑跳过已 ready 讲；单讲重试只重跑该讲；Part 不变', async () => {
  ctl.failLecture = 2;
  ctl.delay = 0;
  const { book, series, found } = makeBook('resume');
  const started = await post('/dsh-book-slides/series/start', { seriesId: series.id });
  assert.equal(started.ok, true);
  const partial = await waitJob(series.id, (job) => job.status === 'partial');
  assert.equal(partial.status, 'partial');

  const oneFile = path.join(found.dir, 'lectures', '1', 'slides.json');
  const oneMtime = fs.statSync(oneFile).mtimeMs;
  const partBefore = (await json('/dsh-book-slides/parts?bookId=' + book.id)).parts[0];

  // 先只重试失败的第 2 讲：第 1 讲不动，第 2 讲重写
  const twoFile = path.join(found.dir, 'lectures', '2', 'slides.json');
  const twoBefore = fs.existsSync(twoFile);
  const twoMtime = twoBefore ? fs.statSync(twoFile).mtimeMs : 0;
  ctl.failLecture = 0;
  await new Promise((resolve) => setTimeout(resolve, 12));
  const retried = await post('/dsh-book-slides/series/retry', { seriesId: series.id, lecture: 2 });
  assert.equal(retried.ok, true);
  assert.equal(retried.cached, false);
  await waitJob(series.id, (job) => job.status === 'ready');
  assert.equal(fs.statSync(oneFile).mtimeMs, oneMtime);
  assert.equal(fs.existsSync(twoFile), true);
  assert.notEqual(fs.statSync(twoFile).mtimeMs, twoMtime);

  // 再续跑：两讲都已 ready，命中缓存并返回 skipped
  const twoMtimeAfter = fs.statSync(twoFile).mtimeMs;
  const resumed = await post('/dsh-book-slides/series/resume', { seriesId: series.id });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.cached, true);
  assert.deepEqual(resumed.skipped, [1, 2]);
  assert.equal(fs.statSync(oneFile).mtimeMs, oneMtime);
  assert.equal(fs.statSync(twoFile).mtimeMs, twoMtimeAfter);

  const partAfter = (await json('/dsh-book-slides/parts?bookId=' + book.id)).parts[0];
  assert.equal(partAfter.version, partBefore.version);
  assert.deepEqual(partAfter.chapters, partBefore.chapters);
  assert.equal(partAfter.title, partBefore.title);
});

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
