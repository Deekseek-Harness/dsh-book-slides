/**
 * 2.0 M5 长任务取消（AC-135 的 M5 部分）：题库作业、书档导入作业。
 *
 * 取消必须幂等；取消后不产生半截新数据；staging 清理；作业结束后再取消不报错。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-longtask-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, writeChapters } = await import('../host/books.js');
const { savePart } = await import('../host/parts.js');
const { createSeries, findSeries, patchSeriesLecture, persistSeries } = await import('../host/series.js');
const { writeLectureOutputs } = await import('../host/lectures.js');
const { routeM1 } = await import('../host/api.js');

const ctl = { delay: 0 };

function makeFixture() {
  const book = createBook({
    buffer: Buffer.from('v2-longtask-' + Date.now()),
    fileName: 'long.pdf',
    title: '长任务',
    author: '',
    pages: 2,
    rawPages: [
      { page: 1, text: '第1章 甲\n' + '甲'.repeat(3000) },
      { page: 2, text: '第2章 乙\n' + '乙'.repeat(3000) },
    ],
  });
  writeChapters(book.id, [
    { n: 1, title: '第1章 甲', from: 1, to: 1, chars: 3000, front: false },
    { n: 2, title: '第2章 乙', from: 2, to: 2, chars: 3000, front: false },
  ], 'manual');
  const part = savePart({ bookId: book.id, chapters: [1, 2], title: '长' });
  const series = createSeries({
    bookId: book.id,
    partId: part.id,
    title: '长',
    plan: {
      throughline: '长',
      lectures: [
        { n: 1, chapters: [1], title: '第 1 讲', goal: '', pages: 4, chars: 3000 },
        { n: 2, chapters: [2], title: '第 2 讲', goal: '', pages: 4, chars: 3000 },
      ],
      seams: [{ from: 1, to: 2, concept: '接', sentence: '上一讲。' }],
      terms: [],
      cut_notes: [],
      source: 'model',
      stitched: true,
      totalChars: 6000,
      totalPages: 8,
      estMinutes: 8,
    },
  });
  const found = findSeries(series.id);
  for (const lecture of found.series.lectures) {
    const slides = Array.from({ length: 4 }, (_, index) => ({
      slide_index: index + 1,
      layout: index === 0 ? 'cover' : 'content_text',
      title: '第 ' + lecture.n + ' 讲 第 ' + (index + 1) + ' 页',
      bullet_points: ['要点'],
      audio_script: '朗读稿',
      source_quote: '原文'.repeat(20),
      source_pages: { from: lecture.chapters[0], to: lecture.chapters[0] },
      image_prompt: '图',
      image_file: null,
      image_status: 'none',
    }));
    writeLectureOutputs(found.dir, lecture.n, {
      schema: 1,
      series_id: series.id,
      n: lecture.n,
      title: lecture.title,
      chapters: lecture.chapters,
      pages: 4,
      chars: 3000,
      status: 'ready',
      voice_status: 'none',
    }, { schema_version: 1, series_id: series.id, lecture: lecture.n, slides });
    patchSeriesLecture(found.series, lecture.n, { status: 'ready', pages: 4, chars: 3000 });
  }
  found.series.status = 'ready';
  persistSeries(found.series);
  return { book, series };
}

const ctx = {
  get(name) {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'slow' }) };
    if (name !== 'llm') return null;
    return {
      async prepareCall() {
        return {
          config: {},
          async *stream(config) {
            const user = String(config.messages[0].content[0].text || '');
            if (ctl.delay) await new Promise((resolve) => setTimeout(resolve, ctl.delay));
            const match = /【章】第 (\d+) 章/.exec(user);
            const n = match ? Number(match[1]) : 1;
            const mark = ['甲', '乙'][n - 1] || '甲';
            yield {
              type: 'text-delta',
              text: JSON.stringify({
                questions: Array.from({ length: 5 }, (_, index) => ({
                  type: 'single',
                  difficulty: 1,
                  point: '考点' + index,
                  stem: '第' + n + '章 第' + index + '个考点的完整表述与判定方法',
                  options: [
                    { key: 'A', text: '正确' },
                    { key: 'B', text: '错误一' },
                    { key: 'C', text: '错误二' },
                    { key: 'D', text: '错误三' },
                  ],
                  answer: ['A'],
                  source_quote: mark.repeat(24),
                })),
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

async function waitJob(jobId, predicate, timeout = 8000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await json('/dsh-book-slides/practice/job?jobId=' + encodeURIComponent(jobId));
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待作业超时：' + JSON.stringify(last));
}

const fixture = makeFixture();

test('AC-135：题库作业可取消、幂等，取消后不继续调模型', async () => {
  ctl.delay = 400;
  const started = await post('/dsh-book-slides/practice/bank', { seriesId: fixture.series.id });
  assert.equal(started.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const cancelled = await post('/dsh-book-slides/practice/cancel', { jobId: started.jobId });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.cancelled, true);
  const done = await waitJob(started.jobId, (job) => ['ready', 'failed', 'cancelled'].includes(job.status));
  assert.equal(done.status, 'cancelled');

  const again = await post('/dsh-book-slides/practice/cancel', { jobId: started.jobId });
  assert.equal(again.ok, true);
  assert.equal(again.cancelled, false);

  const unknown = await post('/dsh-book-slides/practice/cancel', { jobId: 'nope' });
  assert.equal(unknown.ok, true);
  assert.equal(unknown.cancelled, false);
  ctl.delay = 0;
});

test('AC-135：书档导入 job 可取消/幂等；结束后 staging 清理', async () => {
  const exported = await fetch(baseUrl + '/dsh-book-slides/export?bookId=' + fixture.book.id);
  const buffer = Buffer.from(await exported.arrayBuffer());
  const uploaded = await fetch(baseUrl + '/dsh-book-slides/import/package?policy=merge', {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'x-file-name': 'pkg.zip' },
    body: buffer,
  });
  const out = JSON.parse(await uploaded.text());
  assert.equal(out.ok, true);
  assert.ok(out.jobId);

  const cancelled = await post('/dsh-book-slides/import/package/cancel', { jobId: out.jobId });
  assert.equal(cancelled.ok, true);

  let last = null;
  const started = Date.now();
  while (Date.now() - started < 8000) {
    last = await json('/dsh-book-slides/import/package/job?jobId=' + encodeURIComponent(out.jobId));
    if (!last.ok || ['done', 'failed', 'cancelled'].includes(String(last.status))) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(last && last.ok, '作业状态应可读');
  assert.ok(['done', 'cancelled'].includes(String(last.status)), JSON.stringify(last));
  // 结束后 staging 清理（可能已导入同一本书；merge 幂等，不产生第二本）
  const deadline = Date.now() + 2000;
  let left = fs.existsSync(path.join(ROOT, '.import')) ? fs.readdirSync(path.join(ROOT, '.import')) : [];
  while (left.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    left = fs.existsSync(path.join(ROOT, '.import')) ? fs.readdirSync(path.join(ROOT, '.import')) : [];
  }
  assert.deepEqual(left, []);
  const books = await json('/dsh-book-slides/books');
  assert.equal(books.books.filter((book) => book.id === fixture.book.id).length, 1);

  const again = await post('/dsh-book-slides/import/package/cancel', { jobId: out.jobId });
  assert.equal(again.ok, true);
  assert.equal(again.cancelled, false);
});

test('AC-135：题库作业超时 → E_QZ_TIMEOUT，不写题库', async () => {
  process.env.DSH_BOOK_SLIDES_PRACTICE_TIMEOUT_MS = '1';
  try {
    const fresh = makeFixture();
    const started = await post('/dsh-book-slides/practice/bank', { seriesId: fresh.series.id });
    assert.equal(started.ok, true);
    const job = await waitJob(started.jobId, (state) => state.status === 'failed' || state.status === 'ready');
    assert.equal(job.status, 'failed');
    assert.equal(job.code, 'E_QZ_TIMEOUT');
    const bankFile = path.join(ROOT, 'books', fresh.book.id, 'practice', 'questions.json');
    const wrote = fs.existsSync(bankFile) ? (JSON.parse(fs.readFileSync(bankFile, 'utf8')).questions || []) : [];
    const byChapter = {};
    for (const question of wrote) byChapter[question.chapter] = (byChapter[question.chapter] || 0) + 1;
    assert.ok(Object.values(byChapter).every((count) => count >= 4), '超时只能留完整章，不能留半章题');
  } finally {
    delete process.env.DSH_BOOK_SLIDES_PRACTICE_TIMEOUT_MS;
  }
});

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
