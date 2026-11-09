/**
 * M2 路由：Part → 预览 → 系列 draft → 写 plan。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-m2-route-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, loadBook, writeChapters } = await import('../host/books.js');
const { routeM1 } = await import('../host/api.js');

const rawPages = [];
const chapters = [];
for (let n = 1; n <= 7; n += 1) {
  rawPages.push({ page: n, text: '第' + n + '章 标题' + n + '\n' + '正'.repeat(12000) });
  chapters.push({ n, title: '第' + n + '章 标题' + n, from: n, to: n, chars: 12000, toc: false, front: false });
}
const book = createBook({ buffer: Buffer.from('m2-route'), fileName: 'm2.pdf', title: 'M2 路由书', author: '', pages: 7, rawPages });
writeChapters(book.id, chapters, 'manual');

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

async function json(url, options) {
  const res = await fetch(base + url, options);
  return JSON.parse(await res.text());
}

test('M2 路由：Part/预览/系列/计划', async () => {
  const part = await json('/dsh-book-slides/part', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: book.id, chapters: [1, 2, 3, 4, 5, 6, 7], title: '函数' }),
  });
  assert.equal(part.ok, true);
  assert.ok(part.part.id);

  const conflict = await json('/dsh-book-slides/part', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: book.id, chapters: [1], title: '冲突' }),
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'E_PART_CONFLICT');

  const updated = await json('/dsh-book-slides/part/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: book.id, partId: part.part.id, title: '函数（改）', removeChapters: [7] }),
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.part.version, 2);
  assert.equal(updated.part.title, '函数（改）');
  assert.deepEqual(updated.part.chapters, [1, 2, 3, 4, 5, 6]);

  const addedBack = await json('/dsh-book-slides/part/update', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: book.id, partId: part.part.id, addChapters: [7] }),
  });
  assert.equal(addedBack.ok, true);
  assert.equal(addedBack.part.version, 3);
  assert.deepEqual(addedBack.part.chapters, [1, 2, 3, 4, 5, 6, 7]);

  const preview = await json('/dsh-book-slides/plan/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: book.id, partId: part.part.id }),
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.plan.lectures.length, 2);

  const created = await json('/dsh-book-slides/series', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: book.id, partId: part.part.id }),
  });
  assert.equal(created.ok, true);
  assert.equal(created.status, 'draft');
  assert.equal(created.jobId, undefined);

  const planned = await json('/dsh-book-slides/series/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seriesId: created.seriesId }),
  });
  assert.equal(planned.ok, true);
  assert.equal(planned.series.status, 'planned');
  assert.equal(planned.series.lectures.length, 2);

  const list = await json('/dsh-book-slides/series?bookId=' + book.id);
  assert.equal(list.series.length, 1);
  assert.equal(list.series[0].status, 'planned');
});

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
