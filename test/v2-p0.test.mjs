/**
 * 3.0 P0：书签刷新只改树、不改章节；节结构变化会换讲缓存键。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-p0-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, loadBook, writeBookmark, writeChapters } = await import('../host/books.js');
const { refreshBookmarkTree } = await import('../host/chapters.js');
const { lectureKeyOf } = await import('../host/generate.js');
const { totalPagesOf } = await import('../host/progress.js');

function makeBook() {
  const rawPages = [];
  for (let n = 1; n <= 10; n += 1) rawPages.push({ page: n, text: '第 ' + n + ' 页正文' + '字'.repeat(80) });
  const book = createBook({
    buffer: Buffer.from('fake-pdf-' + Date.now()),
    fileName: 'p0.pdf',
    title: 'P0 测试书',
    author: '',
    pages: rawPages.length,
    rawPages,
  });
  const chapters = [{ n: 1, title: '第1章　函数', from: 1, to: 10, chars: 900, toc: false, front: false }];
  writeChapters(book.id, chapters, 'bookmark', 0.95, [], {
    tree: [{ title: '第1章　函数', page: 1, depth: 0, children: [] }],
    rootDepth: 0,
  });
  return loadBook(book.id);
}

test('P0：XML 书签刷新保留 1.2.4 子节，不改 chapters', async () => {
  const loaded = makeBook();
  const pages = JSON.parse(fs.readFileSync(path.join(loaded.dir, 'pages.json'), 'utf8'));
  const xml = [
    '<ITEM INDENT="1" PAGE="0" NAME="第1章　函数"/>',
    '<ITEM INDENT="2" PAGE="3" NAME="1.1　函数"/>',
    '<ITEM INDENT="2" PAGE="4" NAME="1.2　反函数"/>',
    '<ITEM INDENT="3" PAGE="4" NAME="1.2.4　反函数的反函数"/>',
  ].join('');
  const out = await refreshBookmarkTree(loaded, pages, { source: 'xml', xml, outlineDepth: null });
  assert.equal(out.rootDepth, 0);
  assert.equal(out.rootCount, 1);
  const chapter = out.tree.find((node) => node.n === 1);
  assert.ok(chapter);
  const section = chapter.children.find((node) => node.title.includes('1.2　'));
  assert.ok(section);
  assert.ok(section.children.some((node) => node.title.includes('1.2.4')));

  writeBookmark(loaded.book.id, out.tree, out.rootDepth, 'xml');
  const again = loadBook(loaded.book.id);
  assert.equal(again.book.bookmarkRootDepth, 0);
  assert.ok(JSON.stringify(again.book.bookmarkTree).includes('1.2.4'));
  assert.deepEqual(again.chapters.map((c) => c.n), [1]);
});

test('P0：sections/must_keep 变化会换 lectureKey', () => {
  const series = { id: 's1', plan_version: 1, throughline: '主线', terms: [] };
  const base = {
    n: 1, chapters: [1], pages: 10, title: '第1讲', goal: 'g', in: 'i', out: 'o',
    sections: [{ title: '1.1', pages: 1, must_keep: ['区间'] }],
  };
  const key1 = lectureKeyOf(series, base, { provider: 'p', model: 'm' });
  const key2 = lectureKeyOf(series, Object.assign({}, base, {
    sections: [{ title: '1.1', pages: 2, must_keep: ['区间'] }],
  }), { provider: 'p', model: 'm' });
  const key3 = lectureKeyOf(series, Object.assign({}, base, {
    sections: [{ title: '1.1', pages: 1, must_keep: ['闭区间'] }],
  }), { provider: 'p', model: 'm' });
  assert.notEqual(key1, key2);
  assert.notEqual(key1, key3);
  // 实际页数变化不应换讲纲键（计划页数才是契约）。
  const key4 = lectureKeyOf(series, Object.assign({}, base, {
    pages: 12,
    planned_pages: 10,
    actual_pages: 12,
  }), { provider: 'p', model: 'm' });
  assert.equal(key1, key4);
});

test('P0：进度/系列总页数按实际页数，计划页数不覆盖实际', () => {
  const series = {
    lectures: [
      { n: 1, pages: 10, planned_pages: 10, actual_pages: 12 },
      { n: 2, pages: 20, planned_pages: 20, actual_pages: 18 },
    ],
  };
  assert.equal(totalPagesOf(series), 30);
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
