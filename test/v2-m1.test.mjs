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

import { makePdf, makePdfWithOutline } from './fixture.mjs';
import { coverSvg, hueOf, normalizeHue } from '../lib/cover.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-m1-'));
const LEGACY = path.join(ROOT, 'legacy-root');
fs.mkdirSync(path.join(LEGACY, 'books', 'oldbook1'), { recursive: true });
fs.writeFileSync(path.join(LEGACY, 'meta.json'), JSON.stringify({ schema: 1 }) + '\n');
fs.writeFileSync(path.join(LEGACY, 'books', 'oldbook1', 'book.json'), JSON.stringify({ title: '旧书', schemaVersion: 1 }) + '\n');
fs.writeFileSync(path.join(LEGACY, 'books', 'oldbook1', 'pages.json'), '[{"page":1,"text":"旧数据"}]');
process.env.DSH_BOOK_SLIDES_ROOT = LEGACY;
delete process.env.DSH_HOME;

const { ensureRoot } = await import('../host/root.js');
const { routeM1 } = await import('../host/api.js');

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
  assert.equal(meta.product_version, '2.1');
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

test('AC-116：auto 书签级联；mechanical 用 1.x 正则；heading 被拒', async () => {
  const pageTexts = [];
  const rawPages = [];
  const headings = [
    ['Chapter 1 Functions', 4],
    ['Chapter 2 Limits', 8],
    ['Chapter 3 Continuity', 12],
  ];
  for (let i = 1; i <= 20; i += 1) {
    const hit = headings.find((entry) => entry[1] === i);
    const text = (hit ? hit[0] + '\n' : '') + ('Body page ' + i + '. '.repeat(60));
    rawPages.push({ page: i, text });
    pageTexts.push(text.split('\n'));
  }
  const pdf = makePdfWithOutline(pageTexts, [
    { title: 'BM Part I', page: 4, children: [{ title: 'BM 1.1', page: 5 }] },
    { title: 'BM Ch1', page: 4 },
    { title: 'BM Ch2', page: 8 },
    { title: 'BM Ch3', page: 12 },
    { title: 'bad', page: 999 },
  ]);
  const imported = await json('/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('书签书.pdf'), 'content-type': 'application/pdf' },
    body: pdf,
  });
  assert.equal(imported.body.ok, true, JSON.stringify(imported.body));
  const id = imported.body.bookId;

  const auto = await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'auto', force: true }),
  });
  assert.equal(auto.body.ok, true, JSON.stringify(auto.body));
  assert.equal(auto.body.source, 'bookmark');
  assert.equal(auto.body.confidence, 0.95);
  assert.deepEqual(auto.body.chapters.map((c) => c.title), ['BM Ch1', 'BM Ch2', 'BM Ch3']);
  assert.ok(!auto.body.chapters.some((c) => /1\.1/.test(c.title)), '子节点小节不得进入章节');
  assert.equal(auto.body.chapters[0].from, 4);
  assert.equal(auto.body.attempts.length, 3);
  assert.equal(auto.body.attempts[0].result, 'used');
  assert.equal(auto.body.attempts[1].result, 'skipped');
  assert.equal(auto.body.attempts[2].result, 'skipped');
  assert.ok(
    auto.body.warnings.some((warning) => /前 3 页未归入任何章/.test(warning)),
    JSON.stringify(auto.body.warnings),
  );
  assert.ok(auto.body.chapters.every((chapter) => chapter.source === 'bookmark'));
  assert.equal(auto.body.outline.rootDepth, 0);
  assert.equal(auto.body.outline.rootCount, 3);
  const book = await json('/dsh-book-slides/book?bookId=' + id);
  assert.equal(book.body.book.chapterSource, 'bookmark');
  assert.equal(book.body.book.chapterConfidence, 0.95);
  assert.equal(book.body.book.bookmarkRootDepth, 0);
  const tree = book.body.book.bookmarkTree;
  assert.equal(tree.filter((node) => Number.isInteger(node.n)).length, 3);
  const child = tree.flatMap((node) => node.children || []).find((node) => node.title === 'BM 1.1');
  assert.ok(child, 'bookmarkTree 应保留子节点');
  assert.equal(child.n, undefined, '子节点没有章号');
  assert.ok(
    Array.isArray(book.body.book.chapterWarnings) &&
      book.body.book.chapterWarnings.some((warning) => /前 3 页未归入任何章/.test(warning)),
    JSON.stringify(book.body.book.chapterWarnings),
  );

  const mech = await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'mechanical', force: true }),
  });
  assert.equal(mech.body.ok, true, JSON.stringify(mech.body));
  assert.equal(mech.body.source, 'mechanical');
  assert.equal(mech.body.attempts.length, 1);
  const mechTitles = mech.body.chapters.filter((chapter) => !chapter.front).map((chapter) => chapter.title);
  assert.deepEqual(mechTitles, ['Chapter 1 Functions', 'Chapter 2 Limits', 'Chapter 3 Continuity']);
  assert.ok(mechTitles.every((title) => !/BM/.test(title)), '机械切章走 1.x 正则，不读书签');
  assert.ok(mech.body.chapters.every((chapter) => chapter.source === 'mechanical'));
  const mechBook = await json('/dsh-book-slides/book?bookId=' + id);
  assert.equal(mechBook.body.book.bookmarkTree, null, '非书签来源清空 bookmarkTree');
  assert.equal(mechBook.body.book.bookmarkRootDepth, null, '非书签来源清空 bookmarkRootDepth');

  const heading = await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'heading', force: true }),
  });
  assert.equal(heading.body.ok, false);
  assert.equal(heading.body.code, 'E_BAD_MODE');
});

test('AC-116：书签单根先导入 1 章，提示后下移一层', async () => {
  const pageTexts = [
    ['Book'],
    ['Chapter 1 Functions', 'alpha '.repeat(40)],
    ['Chapter 2 Limits', 'beta '.repeat(40)],
    ['Chapter 3 Continuity', 'gamma '.repeat(40)],
  ];
  const pdf = makePdfWithOutline(pageTexts, [
    {
      title: 'Book',
      page: 1,
      children: [
        { title: 'Chapter 1 Functions', page: 2 },
        { title: 'Chapter 2 Limits', page: 3 },
        { title: 'Chapter 3 Continuity', page: 4 },
      ],
    },
  ]);
  const imported = await json('/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('单根书签.pdf'), 'content-type': 'application/pdf' },
    body: pdf,
  });
  assert.equal(imported.body.ok, true, JSON.stringify(imported.body));
  const id = imported.body.bookId;

  const first = await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'auto', force: true }),
  });
  assert.equal(first.body.ok, true, JSON.stringify(first.body));
  assert.equal(first.body.source, 'bookmark');
  assert.deepEqual(first.body.chapters.map((chapter) => chapter.title), ['Book']);
  assert.deepEqual(first.body.outline, {
    rootDepth: 0,
    rootCount: 1,
    canDescend: true,
    nextDepth: 1,
    nextCount: 3,
  });
  let book = await json('/dsh-book-slides/book?bookId=' + id);
  assert.equal(book.body.book.bookmarkRootDepth, 0);
  assert.equal(book.body.book.bookmarkTree[0].n, 1);
  assert.equal(book.body.book.bookmarkTree[0].children.length, 3);

  const down = await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'auto', outlineDepth: 1, force: true }),
  });
  assert.equal(down.body.ok, true, JSON.stringify(down.body));
  assert.equal(down.body.source, 'bookmark');
  assert.deepEqual(down.body.chapters.map((chapter) => chapter.title), [
    'Chapter 1 Functions',
    'Chapter 2 Limits',
    'Chapter 3 Continuity',
  ]);
  assert.equal(down.body.outline.rootDepth, 1);
  assert.equal(down.body.outline.rootCount, 3);
  book = await json('/dsh-book-slides/book?bookId=' + id);
  assert.equal(book.body.book.bookmarkRootDepth, 1);
  assert.equal(book.body.book.bookmarkTree[0].n, undefined);
  assert.equal(book.body.book.bookmarkTree[0].children[0].n, 1);

  const again = await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'auto', force: true }),
  });
  assert.equal(again.body.ok, true, JSON.stringify(again.body));
  assert.equal(again.body.outline.rootDepth, 1, '未给 outlineDepth 时沿用已存根层');
  assert.deepEqual(again.body.chapters.map((chapter) => chapter.title), [
    'Chapter 1 Functions',
    'Chapter 2 Limits',
    'Chapter 3 Continuity',
  ]);
});

test('AC-116：auto 无书签无目录 → mechanical 1 章「全文」', async () => {
  const pageTexts = Array.from({ length: 30 }, (_, index) => [
    'Prose page ' + (index + 1) + '. ' + 'No chapter heading here. '.repeat(40),
  ]);
  const pdf = makePdf(pageTexts);
  const imported = await json('/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('散文.pdf'), 'content-type': 'application/pdf' },
    body: pdf,
  });
  assert.equal(imported.body.ok, true, JSON.stringify(imported.body));
  const id = imported.body.bookId;

  const auto = await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'auto', force: true }),
  });
  assert.equal(auto.body.ok, true, JSON.stringify(auto.body));
  assert.equal(auto.body.source, 'mechanical');
  assert.equal(auto.body.chapters.length, 1);
  assert.equal(auto.body.chapters[0].title, '全文');
  assert.deepEqual(auto.body.attempts.map((item) => item.result), ['empty', 'skipped', 'used']);
  assert.ok(auto.body.warnings.some((warning) => /自动识别未命中/.test(warning)));

  const chaptersFile = path.join(LEGACY, 'books', id, 'chapters.json');
  const beforeText = fs.readFileSync(chaptersFile, 'utf8');
  const beforeMtime = fs.statSync(chaptersFile).mtimeMs;
  const beforeBook = await json('/dsh-book-slides/book?bookId=' + id);

  const bookmark = await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'bookmark', force: true }),
  });
  assert.equal(bookmark.body.ok, false);
  assert.equal(bookmark.body.code, 'E_CHAPTER_SOURCE');

  const noRange = await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'printed_toc', force: true }),
  });
  assert.equal(noRange.body.ok, false);
  assert.equal(noRange.body.code, 'E_BAD_RANGE');

  const noModel = await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'printed_toc', range: { from: 1, to: 1 }, force: true }),
  });
  assert.equal(noModel.body.ok, false);
  assert.equal(noModel.body.code, 'E_CHAPTER_SOURCE');

  const heading = await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'heading', force: true }),
  });
  assert.equal(heading.body.ok, false);
  assert.equal(heading.body.code, 'E_BAD_MODE');

  assert.equal(fs.readFileSync(chaptersFile, 'utf8'), beforeText, '强制失败不得改写 chapters.json');
  assert.equal(fs.statSync(chaptersFile).mtimeMs, beforeMtime, '强制失败不得触碰 chapters.json');
  const afterBook = await json('/dsh-book-slides/book?bookId=' + id);
  assert.equal(afterBook.body.book.chapterSource, beforeBook.body.book.chapterSource);
});

test('AC-157：/toc/preview 返回目录页原文前 800 字，非法范围报 E_BAD_RANGE', async () => {
  const pdf = makePdf([
    ['Contents', 'Chapter 1 Functions 1', 'Chapter 2 Limits 5', 'Chapter 3 Continuity 9', 'x'.repeat(80)],
  ]);
  const imported = await json('/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('预览.pdf'), 'content-type': 'application/pdf' },
    body: pdf,
  });
  assert.equal(imported.body.ok, true, JSON.stringify(imported.body));
  const id = imported.body.bookId;

  const preview = await json('/dsh-book-slides/toc/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, from: 1, to: 1 }),
  });
  assert.equal(preview.body.ok, true, JSON.stringify(preview.body));
  assert.ok(preview.body.preview.includes('Contents'));
  assert.ok(preview.body.preview.length <= 800);
  assert.ok(preview.body.chars > 0);

  const bad = await json('/dsh-book-slides/toc/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, from: 5, to: 1 }),
  });
  assert.equal(bad.body.ok, false);
  assert.equal(bad.body.code, 'E_BAD_RANGE');
});

test('AC-116：章校准保存标 manual；无 force 重分被拒', async () => {
  const pdf = makePdf([
    ['Chapter 1 Functions', 'alpha '.repeat(200)],
    ['Chapter 2 Limits', 'beta '.repeat(200)],
    ['Chapter 3 Continuity', 'gamma '.repeat(200)],
  ]);
  const imported = await json('/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('校准.pdf'), 'content-type': 'application/pdf' },
    body: pdf,
  });
  assert.equal(imported.body.ok, true, JSON.stringify(imported.body));
  const id = imported.body.bookId;

  const built = await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'mechanical', force: true }),
  });
  assert.equal(built.body.ok, true, JSON.stringify(built.body));

  const current = await json('/dsh-book-slides/chapters?bookId=' + id);
  const edited = current.body.chapters.map((chapter) => Object.assign({}, chapter));
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

  const forced = await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'auto', force: true }),
  });
  assert.equal(forced.body.ok, true, JSON.stringify(forced.body));
  assert.ok(forced.body.chapters.every((chapter) => !chapter.manual));
});

test('AC-117：书架、改名、回收站、恢复、冲突', async () => {
  const list = await json('/dsh-book-slides/books');
  const before = list.body.books.length;
  assert.ok(before >= 1);
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
  assert.equal((await json('/dsh-book-slides/books')).body.books.length, before - 1);
  assert.ok((await json('/dsh-book-slides/trash')).body.books.some((item) => item.bookId === id));

  const restored = await json('/dsh-book-slides/trash/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id }),
  });
  assert.equal(restored.body.ok, true);
  assert.equal((await json('/dsh-book-slides/books')).body.books.length, before);

  const meta = await json('/dsh-book-slides/meta');
  assert.equal(meta.body.schema, 2);
  assert.equal(meta.body.product_version, '2.1');
});

test('AC-124：无文字层拒绝，书架不新增', async () => {
  const before = (await json('/dsh-book-slides/books')).body.books.length;
  const pdf = makePdf([[]]);
  const out = await json('/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'x-file-name': 'scan.pdf', 'content-type': 'application/pdf' },
    body: pdf,
  });
  assert.equal(out.body.ok, false);
  assert.equal(out.body.code, 'E_PDF_NO_TEXT');
  assert.equal((await json('/dsh-book-slides/books')).body.books.length, before);
});

test('AC-116：mechanical 用正文标题，不用目录标题；重叠/越界被拒；空白章 chars=0', async () => {
  const pdf = makePdf([
    [
      'Contents',
      'Chapter 1 Functions 1',
      'Chapter 2 Limits 5',
      'Chapter 3 Continuity 9',
      'Chapter 4 Series 13',
      'Chapter 5 Integrals 17',
      'Chapter 6 Derivatives 21',
      'Chapter 7 Limits 25',
      'Chapter 8 Appendix 29',
    ],
    ['Chapter 1 Functions', 'alpha '.repeat(200)],
    [''],
    ['Chapter 2 Limits', 'beta '.repeat(200)],
  ]);
  const imported = await json('/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('四页.pdf'), 'content-type': 'application/pdf' },
    body: pdf,
  });
  assert.equal(imported.body.ok, true);
  const id = imported.body.bookId;

  const mech = await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'mechanical', force: true }),
  });
  assert.equal(mech.body.ok, true, JSON.stringify(mech.body));
  assert.equal(mech.body.source, 'mechanical');
  const titles = mech.body.chapters.map((chapter) => chapter.title);
  assert.deepEqual(titles, ['Chapter 1 Functions', 'Chapter 2 Limits']);
  assert.ok(titles.every((title) => !/Contents|Part \d+/.test(title)), '机械切章不得用目录标题或固定页块');

  const saved = await json('/dsh-book-slides/chapters', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      bookId: id,
      chapters: [
        { n: 1, title: '第一章 函数', from: 1, to: 2 },
        { n: 2, title: '空白页', from: 3, to: 3 },
        { n: 3, title: '第二章 极限', from: 4, to: 4 },
      ],
    }),
  });
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.chapters[1].chars, 0, '空白章 chars=0（UI 据此置灰）');

  const overlap = await json('/dsh-book-slides/chapters', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, chapters: [{ n: 1, from: 1, to: 3 }, { n: 2, from: 2, to: 4 }] }),
  });
  assert.equal(overlap.body.ok, false);
  assert.equal(overlap.body.code, 'E_CHAPTER_OVERLAP');

  const range = await json('/dsh-book-slides/chapters', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, chapters: [{ n: 1, from: 1, to: 999 }] }),
  });
  assert.equal(range.body.ok, false);
  assert.equal(range.body.code, 'E_CHAPTER_RANGE');
});

test('AC-124：300 页导入不建章节/封面，删源 PDF 后原文仍可读', async () => {
  const pages = Array.from({ length: 300 }, (_, index) => ['第' + (index + 1) + ' 页 ' + '文'.repeat(40)]);
  const pdf = makePdf(pages);
  const started = Date.now();
  const imported = await json('/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'x-file-name': 'big.pdf', 'content-type': 'application/pdf' },
    body: pdf,
  });
  const elapsed = Date.now() - started;
  assert.equal(imported.body.ok, true);
  assert.ok(elapsed < 60000, '300 页导入耗时 ' + elapsed + 'ms（15s 为真机目标，不作 CI 门）');
  const id = imported.body.bookId;

  const book = await json('/dsh-book-slides/book?bookId=' + id);
  assert.equal(book.body.chapters.length, 0);
  assert.equal(book.body.chaptersBuilt, false);
  assert.equal(book.body.cover, false);

  const dup = await json('/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'x-file-name': 'big-again.pdf', 'content-type': 'application/pdf' },
    body: pdf,
  });
  assert.equal(dup.body.ok, false);
  assert.equal(dup.body.code, 'E_DUP_BOOK');

  fs.rmSync(path.join(ROOT, 'books', id, 'source.pdf'), { force: true });
  const pageOut = await json('/dsh-book-slides/pages?bookId=' + id);
  assert.equal(pageOut.body.ok, true);
  assert.equal(pageOut.body.pages.length, 300);
});

test('封面色相归一：缺省回退书名哈希，0 是合法色相', () => {
  assert.equal(normalizeHue(null), null);
  assert.equal(normalizeHue(undefined), null);
  assert.equal(normalizeHue(''), null);
  assert.equal(normalizeHue(0), 0);
  assert.equal(normalizeHue(360), 0);
  assert.equal(normalizeHue(-10), 350);
  assert.equal(coverSvg({ title: '甲' }), coverSvg({ title: '甲', hue: hueOf('甲') }));
});

test('重命名同步刷新封面标题：只换书名，色相不变；旧封面无 meta 也能回退', async () => {
  const pdf = makePdf([
    ['第一章 旧书', '旧书正文。'.repeat(40)],
    ['第二章 续', '续页正文。'.repeat(40)],
  ]);
  const imported = await json('/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'x-file-name': encodeURIComponent('旧名.pdf'), 'content-type': 'application/pdf' },
    body: pdf,
  });
  assert.equal(imported.body.ok, true);
  const id = imported.body.bookId;
  assert.equal(imported.body.book.title, '旧名');

  await json('/dsh-book-slides/chapters/build', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, mode: 'mechanical' }),
  });
  const made = await json('/dsh-book-slides/cover', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id }),
  });
  assert.equal(made.body.ok, true);

  const coverText = async () => (await fetch(base + '/dsh-book-slides/cover?bookId=' + id)).text();
  const stops = (svg) => Array.from(svg.matchAll(/stop-color="([^"]+)"/g)).map((match) => match[1]);
  const bookFile = path.join(LEGACY, 'books', id, 'book.json');
  const readBookJson = () => JSON.parse(fs.readFileSync(bookFile, 'utf8'));
  const before = await coverText();
  assert.ok(before.includes('旧名'), '生成封面时写入旧书名');
  assert.equal(stops(before).length, 2, '封面渐变有两个 stop');
  const generated = readBookJson();
  assert.equal(generated.coverMeta.title, '旧名');

  // 模拟 alpha.8 老数据：封面已生成，但没有 coverMeta / coverUpdatedAt。
  delete generated.coverMeta;
  delete generated.coverUpdatedAt;
  fs.writeFileSync(bookFile, JSON.stringify(generated, null, 2) + '\n');

  const renamed = await json('/dsh-book-slides/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, title: '新名' }),
  });
  assert.equal(renamed.body.ok, true);
  const afterFirst = await coverText();
  assert.ok(afterFirst.includes('新名'), '改名后封面标题立即更新');
  assert.ok(!afterFirst.includes('旧名'), '封面不再残留旧书名');
  assert.deepEqual(stops(afterFirst), stops(before), '改名不得换封面配色');
  const firstJson = readBookJson();
  assert.equal(firstJson.coverMeta.title, '新名');
  assert.ok(firstJson.coverUpdatedAt, '改名后补写 coverUpdatedAt 供卡面换 URL');
  const firstHue = Number(firstJson.coverMeta.hue);

  const renamedAgain = await json('/dsh-book-slides/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: id, title: '定名' }),
  });
  assert.equal(renamedAgain.body.ok, true);
  const afterSecond = await coverText();
  assert.ok(afterSecond.includes('定名'));
  assert.ok(!afterSecond.includes('新名') && !afterSecond.includes('旧名'));
  assert.deepEqual(stops(afterSecond), stops(before), '后续改名沿用已保存的色相');
  const secondJson = readBookJson();
  assert.equal(secondJson.coverMeta.title, '定名');
  assert.equal(Number(secondJson.coverMeta.hue), firstHue);
  assert.notEqual(secondJson.coverUpdatedAt, firstJson.coverUpdatedAt);

  const listed = (await json('/dsh-book-slides/books')).body.books.find((item) => item.id === id);
  assert.equal(listed.title, '定名');
  assert.equal(listed.coverUpdatedAt, secondJson.coverUpdatedAt, '书架返回封面版本供卡面换缓存');
});

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
