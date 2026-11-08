/**
 * M1 路由接入测试：用假 ctx 接真插件，走 /dsh-book-slides 的 2.0 M1 API。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { makePdf } from './fixture.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-route-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const plugin = await import('../index.js');

function makeContext() {
  const routes = new Map();
  const prefixes = new Map();
  const scoped = {
    webServer: {
      register(options) {
        const table = options.kind === 'prefix' ? prefixes : routes;
        table.set(options.path, options.handler);
        return () => table.delete(options.path);
      },
    },
    commands: { register() { return () => {}; } },
  };
  return {
    ctx: {
      inject(names, fn) {
        fn(scoped);
      },
      on() {},
      get() {},
    },
    routes,
    prefixes,
  };
}

const { ctx, routes, prefixes } = makeContext();
plugin.apply(ctx);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  let handler = routes.get(url.pathname);
  if (!handler) {
    for (const [prefix, candidate] of prefixes) {
      if (url.pathname === prefix || url.pathname.startsWith(prefix + '/')) {
        handler = candidate;
        break;
      }
    }
  }
  if (!handler) {
    res.statusCode = 404;
    res.end('no route');
    return;
  }
  Promise.resolve(handler(req, res)).catch((err) => {
    res.statusCode = 500;
    res.end(String((err && err.stack) || err));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

async function json(url, options) {
  const res = await fetch(base + url, options);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, status: res.status };
  }
}

test('插件路由：/meta、导入、分章、封面、回收站', async () => {
  const meta = await json('/dsh-book-slides/meta');
  assert.equal(meta.ok, true);
  assert.equal(meta.schema, 2);
  assert.equal(meta.product_version, '2.0');

  const pdf = makePdf([
    ['第一章 函数'],
    ['函数是输入到输出的机器。'.repeat(40)],
    ['第二章 极限'],
    ['极限描述趋势。'.repeat(40)],
  ]);
  const imported = await json('/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('书.pdf'), 'content-type': 'application/pdf' },
    body: pdf,
  });
  assert.equal(imported.ok, true);
  const id = imported.bookId;

  const book = await json('/dsh-book-slides/book?bookId=' + id);
  assert.equal(book.ok, true);
  assert.equal(book.chapters.length, 0);
  assert.equal(book.chaptersBuilt, false);

  const built = await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'mechanical' }),
  });
  assert.equal(built.ok, true);
  assert.ok(built.chapters.length >= 1);

  const cover = await json('/dsh-book-slides/cover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id }),
  });
  assert.equal(cover.ok, true);

  const renamed = await json('/dsh-book-slides/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, title: '改名后' }),
  });
  assert.equal(renamed.ok, true);

  const deleted = await json('/dsh-book-slides/book?bookId=' + id, { method: 'DELETE' });
  assert.equal(deleted.ok, true);
  assert.equal((await json('/dsh-book-slides/books')).books.length, 0);
  assert.equal((await json('/dsh-book-slides/trash')).books.length, 1);

  const restored = await json('/dsh-book-slides/trash/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id }),
  });
  assert.equal(restored.ok, true);
  assert.equal((await json('/dsh-book-slides/books')).books.length, 1);
});

test('P2：目录范围可持久化并在重新读取时恢复', async () => {
  const pdf = makePdf([
    ['目录', '第一章 函数 1', '第二章 极限 4'],
    ['第一章 函数', '函数是输入到输出的机器。'.repeat(40)],
    ['函数的性质', '单调、奇偶、周期。'.repeat(40)],
    ['第二章 极限', '极限描述趋势。'.repeat(40)],
  ]);
  const imported = await json('/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('toc.pdf'), 'content-type': 'application/pdf' },
    body: pdf,
  });
  assert.equal(imported.ok, true);
  const id = imported.bookId;

  const before = await json('/dsh-book-slides/toc?bookId=' + id);
  assert.equal(before.ok, true);
  assert.equal(before.total, 4);
  assert.equal(before.range, null);

  const saved = await json('/dsh-book-slides/toc/range', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, from: 1, to: 1 }),
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.range, { from: 1, to: 1 });

  const after = await json('/dsh-book-slides/toc?bookId=' + id);
  assert.deepEqual(after.range, { from: 1, to: 1 });

  const bad = await json('/dsh-book-slides/toc/range', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, from: 1, to: 99 }),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E_BAD_RANGE');
});

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
