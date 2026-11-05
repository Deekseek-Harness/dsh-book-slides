/**
 * 2.0 M1 后端验收：数据根、导入、分章、封面、书架、回收站。
 * 覆盖 AC-112、AC-113（备份成功路径）、AC-116/117/124 的后端部分。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { makePdf } from './fixture.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-m1-'));
const LEGACY = path.join(ROOT, 'legacy-root');
fs.mkdirSync(path.join(LEGACY, 'books', 'oldbook1'), { recursive: true });
fs.writeFileSync(path.join(LEGACY, 'meta.json'), JSON.stringify({ schema: 1 }) + '\n');
fs.writeFileSync(path.join(LEGACY, 'books', 'oldbook1', 'book.json'), JSON.stringify({ title: '旧书', schemaVersion: 1 }) + '\n');
fs.writeFileSync(path.join(LEGACY, 'books', 'oldbook1', 'pages.json'), '[{"page":1,"text":"旧数据"}]');
process.env.DSH_BOOK_SLIDES_ROOT = LEGACY;
delete process.env.DSH_HOME;

const { ensureRoot } = await import('../v2/root.js');
const { routeM1 } = await import('../v2/api.js');

const upgraded = ensureRoot();
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
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

function pdfOf(pageTexts) {
  return makePdf(pageTexts.map((text) => [text]));
}

test('AC-112：旧根自动备份，原路径重建 schema=2', () => {
  assert.equal(upgraded.upgraded, true);
  assert.ok(upgraded.backup && fs.existsSync(upgraded.backup));
  assert.equal(fs.existsSync(path.join(upgraded.root, 'meta.json')), true);
  const meta = JSON.parse(fs.readFileSync(path.join(upgraded.root, 'meta.json'), 'utf8'));
  assert.equal(meta.schema, 2);
  assert.equal(meta.product_version, '2.0');
  assert.equal(meta.upgraded_from, path.basename(upgraded.backup));
  assert.equal(fs.existsSync(path.join(upgraded.backup, 'books', 'oldbook1', 'book.json')), true);
  assert.equal(fs.existsSync(path.join(upgraded.root, 'books')), true);
});

test('AC-124：导入只入库，不自动分章/封面', async () => {
  const pdf = pdfOf([
    '第一章 函数',
    '函数是输入到输出的机器。'.repeat(40),
    '第二章 极限',
    '极限描述靠近某一点时的趋势。'.repeat(40),
  ]);
  const imported = await json('/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('函数.pdf'), 'content-type': 'application/pdf' },
    body: pdf,
  });
  assert.equal(imported.body.ok, true);
  assert.ok(imported.body.bookId);
  const id = imported.body.bookId;

  const book = await json('/dsh-book-slides/book?bookId=' + id);
  assert.equal(book.body.ok, true);
  assert.equal(book.body.chapters.length, 0);
  assert.equal(book.body.chaptersBuilt, false);
  assert.equal(book.body.cover, false);

  const chaptersBefore = await json('/dsh-book-slides/chapters?bookId=' + id);
  assert.equal(chaptersBefore.body.built, false);

  const coverMissing = await fetch(base + '/dsh-book-slides/cover?bookId=' + id);
  assert.equal(coverMissing.status, 200);
  const missing = await coverMissing.json();
  assert.equal(missing.ok, false);

  const built = await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'auto' }),
  });
  assert.equal(built.body.ok, true);
  assert.ok(built.body.chapters.length >= 1);

  const cover = await json('/dsh-book-slides/cover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id }),
  });
  assert.equal(cover.body.ok, true);
  const coverFile = await fetch(base + '/dsh-book-slides/cover?bookId=' + id);
  assert.equal(coverFile.status, 200);
  assert.match(coverFile.headers.get('content-type') || '', /svg/);

  const dup = await json('/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'x-file-name': 'again.pdf', 'content-type': 'application/pdf' },
    body: pdf,
  });
  assert.equal(dup.body.ok, false);
  assert.equal(dup.body.code, 'E_DUP_BOOK');
});

test('AC-116：三种模式可重跑，章校准保存并标 manual', async () => {
  const books = await json('/dsh-book-slides/books');
  const id = books.body.books[0].id;
  for (const mode of ['auto', 'mech', 'toc']) {
    const out = await json('/dsh-book-slides/chapters/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bookId: id, mode, force: true }),
    });
    assert.equal(out.body.ok, true, mode + ': ' + JSON.stringify(out.body));
    assert.ok(Array.isArray(out.body.chapters) && out.body.chapters.length >= 1);
  }
  const current = await json('/dsh-book-slides/chapters?bookId=' + id);
  const chapters = current.body.chapters;
  const edited = chapters.map((c) => Object.assign({}, c));
  edited[0].title = edited[0].title + '（改）';
  const saved = await json('/dsh-book-slides/chapters', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, chapters: edited }),
  });
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.chapters[0].manual, true);
  assert.match(saved.body.chapters[0].title, /（改）/);

  const manual = await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'auto' }),
  });
  assert.equal(manual.body.ok, false);
  assert.equal(manual.body.code, 'E_MANUAL_EDITS');
});

test('AC-117：书架、改名、回收站、恢复、冲突', async () => {
  const list = await json('/dsh-book-slides/books');
  assert.equal(list.body.books.length, 1);
  const id = list.body.books[0].id;

  const renamed = await json('/dsh-book-slides/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, title: '函数（新）' }),
  });
  assert.equal(renamed.body.ok, true);
  assert.equal(renamed.body.book.title, '函数（新）');

  const deleted = await json('/dsh-book-slides/book?bookId=' + id, { method: 'DELETE' });
  assert.equal(deleted.body.ok, true);
  assert.equal((await json('/dsh-book-slides/books')).body.books.length, 0);
  assert.equal((await json('/dsh-book-slides/trash')).body.books.length, 1);

  const restored = await json('/dsh-book-slides/trash/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id }),
  });
  assert.equal(restored.body.ok, true);
  assert.equal((await json('/dsh-book-slides/books')).body.books.length, 1);

  const meta = await json('/dsh-book-slides/meta');
  assert.equal(meta.body.schema, 2);
  assert.equal(meta.body.product_version, '2.0');
});

test('AC-124：无文字层拒绝，书架不新增', async () => {
  const pdf = makePdf([[]]);
  const out = await json('/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'x-file-name': 'scan.pdf', 'content-type': 'application/pdf' },
    body: pdf,
  });
  assert.equal(out.body.ok, false);
  assert.equal(out.body.code, 'E_PDF_NO_TEXT');
  assert.equal((await json('/dsh-book-slides/books')).body.books.length, 1);
});

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
