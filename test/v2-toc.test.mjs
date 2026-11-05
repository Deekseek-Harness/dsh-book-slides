/**
 * 2.0 M1 印刷目录：没有 PDF 书签时用模型读目录页，再校准到物理页。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makePdf } from './fixture.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-toc-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook } = await import('../v2/books.js');
const { buildBookChapters } = await import('../v2/chapters.js');

function fakeCtx(entries) {
  return {
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'fake', model: 'fake-toc' }) };
      }
      if (name === 'llm') {
        return {
          async prepareCall() {
            return {
              config: {},
              async *stream() {
                yield { type: 'text-delta', text: JSON.stringify({ entries }) };
                yield { type: 'finish', reason: { kind: 'stop' } };
              },
            };
          },
        };
      }
      return null;
    },
  };
}

test('toc：无书签时读印刷目录并校准', async () => {
  const pdf = makePdf([
    ['目录', '第一章 函数 1', '第二章 极限 5', '第三章 连续 9'],
    ['第一章 函数', '函数是输入到输出的机器。'.repeat(30)],
    ['函数的性质', '单调、奇偶、周期。'.repeat(30)],
    ['函数小结', '把函数当机器。'.repeat(30)],
    ['第二章 极限', '极限描述靠近某一点时的趋势。'.repeat(30)],
    ['极限的性质', '唯一性、有界性、保号性。'.repeat(30)],
    ['极限小结', '从数列到函数。'.repeat(30)],
    ['第三章 连续', '连续是极限等于函数值。'.repeat(30)],
    ['连续的判定', '左右极限相等。'.repeat(30)],
    ['连续小结', '把连续看成没有断点。'.repeat(30)],
  ]);
  const book = createBook({
    buffer: pdf,
    fileName: '微积分.pdf',
    title: '微积分',
    author: '',
    pages: 10,
    rawPages: [
      { page: 1, text: '目录\n第一章 函数 1\n第二章 极限 5\n第三章 连续 9' },
      { page: 2, text: '第一章 函数\n' + '函数是输入到输出的机器。'.repeat(30) },
      { page: 3, text: '函数的性质\n' + '单调、奇偶、周期。'.repeat(30) },
      { page: 4, text: '函数小结\n' + '把函数当机器。'.repeat(30) },
      { page: 5, text: '第二章 极限\n' + '极限描述靠近某一点时的趋势。'.repeat(30) },
      { page: 6, text: '极限的性质\n' + '唯一性、有界性、保号性。'.repeat(30) },
      { page: 7, text: '极限小结\n' + '从数列到函数。'.repeat(30) },
      { page: 8, text: '第三章 连续\n' + '连续是极限等于函数值。'.repeat(30) },
      { page: 9, text: '连续的判定\n' + '左右极限相等。'.repeat(30) },
      { page: 10, text: '连续小结\n' + '把连续看成没有断点。'.repeat(30) },
    ],
  });

  const ctx = fakeCtx([
    { title: '第一章 函数', printed_page: 1, level: 'chapter', fixed_char: false },
    { title: '第二章 极限', printed_page: 5, level: 'chapter', fixed_char: false },
    { title: '第三章 连续', printed_page: 8, level: 'chapter', fixed_char: false },
  ]);
  const out = await buildBookChapters(book.id, 'toc', { ctx, from: 1, to: 1, force: true });
  assert.equal(out.source, 'toc');
  assert.ok(out.chapters.length >= 3);
  assert.equal(out.chapters.find((c) => c.title.includes('函数')).from, 2);
  assert.equal(out.chapters.find((c) => c.title.includes('极限')).from, 5);
  assert.equal(out.toc.status, 'verified');
  assert.ok(fs.existsSync(path.join(ROOT, 'books', book.id, 'toc.json')));

  // 缓存重放不需要模型
  const replay = await buildBookChapters(book.id, 'toc', { ctx: null, from: 1, to: 1, force: false });
  assert.equal(replay.source, 'toc');
  assert.ok(replay.chapters.length >= 3);
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
