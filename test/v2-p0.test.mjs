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
const { auditSections, lectureKeyOf, repairMissingMustKeep } = await import('../host/generate.js');
const { totalPagesOf } = await import('../host/progress.js');
const { DEFAULT_ALIASES, readMustKeepAliases, resetMustKeepAliases, writeMustKeepAliases } = await import('../host/aliases.js');

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

test('3.1：must_keep 别名表可覆盖/恢复，且与内置表合并', () => {
  assert.ok(DEFAULT_ALIASES.length >= 10);
  writeMustKeepAliases([{ term: '测试别名', any: ['甲', '乙'] }]);
  const merged = readMustKeepAliases();
  assert.ok(merged.some((rule) => rule.term === '测试别名'));
  assert.ok(merged.some((rule) => rule.term === '根号非负'));
  resetMustKeepAliases();
  const reset = readMustKeepAliases();
  assert.ok(!reset.some((rule) => rule.term === '测试别名'));
  assert.equal(reset.length, DEFAULT_ALIASES.length);
});

test('3.1：无模型时 must_keep 补讲回退原文短句', async () => {
  const lecture = {
    sections: [{ title: '1.1', page: 1, pages: 1, must_keep: ['反函数的反函数'] }],
  };
  const slides = [{
    slide_index: 1,
    layout: 'content_text',
    title: '反函数',
    bullet_points: ['先交换变量'],
    audio_script: '反函数像撤销按钮。',
    section: '1.1',
    source_pages: { from: 1, to: 1 },
  }];
  const pages = [{ page: 1, text: '反函数的反函数就是原始函数。' }];
  const out = await repairMissingMustKeep(slides, lecture, new Map(), pages, 1);
  assert.equal(out.repaired.length, 1);
  const after = auditSections(out.slides, lecture, 1);
  assert.deepEqual(after.must_keep_real_missing, []);
});

test('3.1：Unicode 减号/全角空格不影响节匹配，quote_source 参与 must_keep 审计', () => {
  const lecture = {
    sections: [
      { title: '3.4　在∞和-∞处的极限', page: 6, pages: 1, must_keep: ['水平渐近线'] },
      { title: '3.7　极限的基本类型小结', page: 10, pages: 1, must_keep: ['小结'] },
    ],
  };
  const slides = [
    {
      slide_index: 1,
      layout: 'content_text',
      title: '走向无穷',
      bullet_points: ['这两种极限各对应一条水平渐近线。'],
      audio_script: '口播。',
      section: '3.4 在∞和−∞处的极限',
      source_pages: { from: 6, to: 6 },
    },
    {
      slide_index: 2,
      layout: 'quote',
      title: '把各种基本类型收进一幅图',
      quote_text: '原文。',
      quote_source: '第 3 章 3.7 极限的基本类型小结',
      audio_script: '口播。',
      section: '3.7　极限的基本类型小结',
      source_pages: { from: 10, to: 10 },
    },
  ];
  const q = auditSections(slides, lecture, 20);
  assert.deepEqual(q.hard_impersonations, []);
  assert.deepEqual(q.must_keep_real_missing, []);
});

test('3.1：同一页多个 must_keep 不会被后一次补讲覆盖', async () => {
  const lecture = {
    sections: [{ title: '1.1', page: 1, pages: 1, must_keep: ['甲', '乙'] }],
  };
  const slides = [{
    slide_index: 1,
    layout: 'content_text',
    title: '测试页',
    bullet_points: ['原要点'],
    audio_script: '原口播。',
    section: '1.1',
    source_pages: { from: 1, to: 1 },
  }];
  const out = await repairMissingMustKeep(slides, lecture, new Map(), [{ page: 1, text: '甲和乙都在原文。' }], 1);
  const joined = (out.slides[0].bullet_points || []).join('\n') + '\n' + out.slides[0].audio_script;
  assert.match(joined, /甲/);
  assert.match(joined, /乙/);
  assert.equal(out.repaired.length, 2);
});

test('3.1：无 leaf 的整章回退不把所有页判成硬冒充', () => {
  const lecture = { sections: [] };
  const slides = [{
    slide_index: 1,
    layout: 'content_text',
    title: '整章回退',
    bullet_points: ['正文一', '正文二', '正文三', '正文四'],
    audio_script: '口播。',
    section: '第 1 章 全文',
  }];
  const q = auditSections(slides, lecture, 20);
  assert.deepEqual(q.hard_impersonations, []);
  assert.deepEqual(q.missing_sections, []);
  assert.equal(q.content_ok, true);
});

test('3.1：节标题分号/逗号差异不造成误报', () => {
  const lecture = {
    sections: [{
      title: '2.2.2　[0; 2π] 以外的三角函数',
      page: 6,
      pages: 1,
      must_keep: ['周期性', '同终边角', '化简', '加减周期'],
    }],
  };
  const slides = [{
    slide_index: 1,
    layout: 'content_text',
    title: '转到圈外的角',
    bullet_points: [
      '反复加减 2π 的倍数就能拉回来。',
      '转一整圈再转 90 度，和直接转 90 度落在同一条射线上。',
      '负六分之五π加上二π就退回已会算的范围。',
      '这就是周期性。',
    ],
    audio_script: '等价角；化简；加减周期。',
    section: '2.2.2 [0, 2π] 以外的三角函数',
  }];
  const q = auditSections(slides, lecture, 20);
  assert.deepEqual(q.hard_impersonations, []);
  assert.deepEqual(q.must_keep_real_missing, []);
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
