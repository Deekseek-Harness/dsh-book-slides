/**
 * M1 接口测试 —— 用假的 ctx 接上真插件，起一个真 HTTP 服务，走完整导入流程。
 *
 *   node test/server.test.mjs
 *
 * 覆盖 AC-1 ~ AC-7 的服务端部分：导入、去重、书架、详情、书封、原件 Range、改名、软删除。
 * 不碰 DSH 的真实 profile，也不写 ~/.dsh：数据根被指到临时目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { makePdf } from './fixture.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-api-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const plugin = await import('../index.js');

/** 假 ctx：把 webServer.register 收进一张路由表。 */
function makeContext() {
  const routes = new Map();
  const scoped = {
    webServer: {
      register(options) {
        routes.set(options.path, options.handler);
        return () => routes.delete(options.path);
      },
    },
  };
  const ctx = {
    inject(names, fn) {
      fn(scoped);
    },
    on() {},
  };
  return { ctx, routes };
}

const { ctx, routes } = makeContext();
plugin.apply(ctx);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const handler = routes.get(url.pathname);
  if (!handler) {
    res.statusCode = 404;
    res.end('no route');
    return;
  }
  handler(req, res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

function post(pathname, body, headers) {
  return fetch(base + pathname, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: body,
  });
}

function importPdf(name, buffer) {
  return fetch(base + '/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) },
    body: buffer,
  }).then((res) => res.json());
}

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('空书架：/books 返回空数组与数据目录', async () => {
  const data = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  assert.equal(data.ok, true);
  assert.deepEqual(data.books, []);
  assert.equal(data.dataRoot, ROOT);
  assert.ok(data.pluginVersion);
});

test('导入：合成 PDF 能落盘并切出三章', async () => {
  const data = await importPdf('样例书.pdf', makePdf([
    ['Sample Book', 'Chapter 1 Start', 'alpha '.repeat(30)],
    ['Chapter 2 Turn', 'beta '.repeat(30)],
    ['Chapter 3 End', 'gamma '.repeat(30)],
  ]));
  assert.equal(data.ok, true, JSON.stringify(data));
  assert.match(data.bookId, /^[a-z0-9]{12}$/);
  assert.equal(data.chapters, 3);
  assert.equal(data.pages, 3);

  const dir = path.join(ROOT, 'books', data.bookId);
  for (const file of ['book.json', 'pages.json', 'chapters.json', 'source.pdf']) {
    assert.ok(fs.existsSync(path.join(dir, file)), '应该有 ' + file);
  }
  const book = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8'));
  assert.equal(book.schemaVersion, 1);
  assert.equal(book.title, '样例书');
  assert.equal(book.pages, 3);
});

test('书架与详情：章数、章节区间都在', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  assert.equal(shelf.books.length, 1);
  const id = shelf.books[0].id;
  assert.equal(shelf.books[0].chapters, 3);
  assert.equal(shelf.books[0].modules, 0);

  const detail = await fetch(base + '/dsh-book-slides/book?bookId=' + id).then((r) => r.json());
  assert.equal(detail.ok, true);
  assert.equal(detail.chapters.length >= 3, true);
  const first = detail.chapters.filter((c) => !c.front)[0];
  assert.equal(first.from, 1);
  assert.ok(first.chars > 0);
});

test('重新解析：不重传 PDF，按现规则重切章节并写回', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  const id = shelf.books[0].id;

  // 先把章节文件改坏，模拟「旧规则切错了」
  const chaptersFile = path.join(ROOT, 'books', id, 'chapters.json');
  fs.writeFileSync(chaptersFile, JSON.stringify([{ n: 1, title: '整个一坨', from: 1, to: 99, chars: 1 }]));

  const res = await post('/dsh-book-slides/reparse', JSON.stringify({ bookId: id })).then((r) => r.json());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.chapterCount, 3);
  assert.ok(Array.isArray(res.chapters) && res.chapters.length >= 3);

  const onDisk = JSON.parse(fs.readFileSync(chaptersFile, 'utf8'));
  assert.equal(onDisk.filter((c) => !c.front).length, 3);
  assert.notEqual(onDisk[0].title, '整个一坨');

  const missing = await post('/dsh-book-slides/reparse', JSON.stringify({ bookId: 'aaaaaaaaaaaa' })).then((r) => r.json());
  assert.equal(missing.code, 'E_NOT_FOUND');
});

test('重复导入同一份文件：报 E_DUP_BOOK 且不新增书', async () => {
  const pdf = makePdf([['Chapter 1 Start', 'alpha '.repeat(30)], ['Chapter 2 Turn', 'beta '.repeat(30)]]);
  const first = await importPdf('去重测试.pdf', pdf);
  assert.equal(first.ok, true);
  const second = await importPdf('去重测试.pdf', pdf);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'E_DUP_BOOK');
  assert.equal(second.bookId, first.bookId);

  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  assert.equal(shelf.books.length, 2);
});

test('拒绝非 PDF 与空文件', async () => {
  const notPdf = await importPdf('note.txt', Buffer.from('hello'));
  assert.equal(notPdf.ok, false);
  assert.equal(notPdf.code, 'E_PDF_CORRUPT');

  const empty = await importPdf('empty.pdf', Buffer.alloc(0));
  assert.equal(empty.ok, false);
});

test('坏 PDF 报 E_PDF_CORRUPT，扫描件（无文字层）报 E_PDF_NO_TEXT', async () => {
  const corrupt = await importPdf('broken.pdf', Buffer.from('这不是 PDF'));
  assert.equal(corrupt.code, 'E_PDF_CORRUPT');

  const scanned = await importPdf('scanned.pdf', makePdf([[], []]));
  assert.equal(scanned.code, 'E_PDF_NO_TEXT');
});

test('书封：返回 SVG，且同书两次内容一致', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  const id = shelf.books[0].id;
  const res = await fetch(base + '/dsh-book-slides/cover?bookId=' + id);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  const svg = await res.text();
  assert.match(svg, /<svg/);

  const again = await (await fetch(base + '/dsh-book-slides/cover?bookId=' + id)).text();
  assert.equal(again, svg, '同一本书的书封应该稳定');
});

test('原件：整文件 200，Range 请求 206 且长度对得上', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  const id = shelf.books[0].id;

  const full = await fetch(base + '/dsh-book-slides/file?bookId=' + id);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await full.arrayBuffer());
  assert.ok(bytes.length > 100);

  const partial = await fetch(base + '/dsh-book-slides/file?bookId=' + id, { headers: { range: 'bytes=0-99' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 0-99/' + bytes.length);
  const first100 = Buffer.from(await partial.arrayBuffer());
  assert.equal(first100.length, 100);
  assert.equal(first100.toString('latin1'), bytes.slice(0, 100).toString('latin1'));
});

test('改名：书架与 book.json 一起变', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  const id = shelf.books[0].id;

  const res = await post('/dsh-book-slides/rename', JSON.stringify({ bookId: id, title: '改过的名字' })).then((r) => r.json());
  assert.equal(res.ok, true);

  const book = JSON.parse(fs.readFileSync(path.join(ROOT, 'books', id, 'book.json'), 'utf8'));
  assert.equal(book.title, '改过的名字');

  const bad = await post('/dsh-book-slides/rename', JSON.stringify({ bookId: id, title: '   ' })).then((r) => r.json());
  assert.equal(bad.code, 'E_BAD_TITLE');
});

test('删除：软删除进 trash，书架立刻空一本，原件还在回收站', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  const id = shelf.books[0].id;
  const before = shelf.books.length;

  const res = await post('/dsh-book-slides/delete', JSON.stringify({ bookId: id })).then((r) => r.json());
  assert.equal(res.ok, true);

  const after = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  assert.equal(after.books.length, before - 1);

  const trashEntries = fs.readdirSync(path.join(ROOT, 'trash'));
  assert.equal(trashEntries.length, 1);
  assert.ok(fs.existsSync(path.join(ROOT, 'trash', trashEntries[0], 'book.json')));
});

test('非法与不存在的 id 一律拒绝，不拼路径', async () => {
  for (const bad of ['../etc', 'ABC', 'a'.repeat(40), '']) {
    const res = await fetch(base + '/dsh-book-slides/book?bookId=' + encodeURIComponent(bad));
    const data = await res.json();
    assert.equal(data.code, 'E_NOT_FOUND', 'bad id 应该被拒：' + bad);
  }
});

test('跨站请求被挡：sec-fetch-site: cross-site → 403', async () => {
  const res = await fetch(base + '/dsh-book-slides/books', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(res.status, 403);
});

test('存储概况：目录、占用、回收站数量', async () => {
  const data = await fetch(base + '/dsh-book-slides/storage').then((r) => r.json());
  assert.equal(data.ok, true);
  assert.equal(data.dataRoot, ROOT);
  assert.ok(data.bytes > 0);
  assert.equal(data.trashCount, 1);
});

test('方法不对返回 405', async () => {
  const res = await post('/dsh-book-slides/books', '{}');
  assert.equal(res.status, 405);
});
