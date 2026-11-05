/**
 * 2.0 M5 回收站恢复冲突（AC-138）。
 *
 * 恢复时若书架已有同 sha256 的书 → E_BOOK_EXISTS + 已有 bookId；不覆盖、不复制。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-trash-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook } = await import('../v2/books.js');
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

function makeBook(name) {
  return createBook({
    buffer: Buffer.from('v2-trash-shared-content'),
    fileName: name + '.pdf',
    title: name,
    author: '',
    pages: 1,
    rawPages: [{ page: 1, text: '第1章 甲\n' + '甲'.repeat(1000) }],
  });
}

test('AC-138：恢复遇同 sha256 返回 E_BOOK_EXISTS 与已有 bookId，不覆盖', async () => {
  const first = makeBook('第一次导入');
  const trashed = await json('/dsh-book-slides/book?bookId=' + first.id, { method: 'DELETE' });
  assert.equal(trashed.ok, true);

  const second = makeBook('第二次导入');
  assert.notEqual(second.id, first.id);
  assert.equal(second.sha256, first.sha256);

  const conflict = await json('/dsh-book-slides/trash/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: first.id }),
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'E_BOOK_EXISTS');
  assert.equal(conflict.bookId, second.id);

  // 冲突时不改变任何一边：两本仍在各自的位置
  const shelf = await json('/dsh-book-slides/books');
  assert.deepEqual(shelf.books.map((book) => book.id), [second.id]);
  const trash = await json('/dsh-book-slides/trash');
  assert.equal(trash.books.length, 1);
  assert.equal(trash.books[0].bookId, first.id);

  // 删除占位的那本后，恢复成功
  await json('/dsh-book-slides/book?bookId=' + second.id, { method: 'DELETE' });
  const restored = await json('/dsh-book-slides/trash/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: first.id }),
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.book.id, first.id);
  const after = await json('/dsh-book-slides/books');
  assert.equal(after.books.length, 1);
  assert.equal(after.books[0].id, first.id);
});

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
