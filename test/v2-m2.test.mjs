/**
 * 2.0 M2 后端：Part 确认/冲突、规则讲纲、系列容器/计划。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-m2-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, loadBook, writeChapters } = await import('../v2/books.js');
const { savePart, listParts, updatePart, deletePart } = await import('../v2/parts.js');
const { buildPlan } = await import('../v2/plan.js');
const { createSeries, savePlan } = await import('../v2/series.js');

function makeBook() {
  const rawPages = [];
  const chapters = [];
  for (let n = 1; n <= 7; n += 1) {
    rawPages.push({ page: n, text: '第' + n + '章 标题' + n + '\n' + '正'.repeat(12000) });
    chapters.push({ n, title: '第' + n + '章 标题' + n, from: n, to: n, chars: 12000, toc: false, front: false });
  }
  const buffer = Buffer.from('fake-pdf-' + Date.now());
  const book = createBook({ buffer, fileName: 'm2.pdf', title: 'M2 测试书', author: '', pages: 7, rawPages });
  writeChapters(book.id, chapters, 'manual');
  return loadBook(book.id);
}

test('AC-92/95：Part 确认、冲突、校验、编辑、删除', () => {
  const loaded = makeBook();
  const part = savePart({ bookId: loaded.book.id, chapters: [1, 2, 3, 4, 5, 6, 7], title: '函数' });
  assert.equal(part.version, 1);
  assert.equal(listParts(loaded.book.id).length, 1);
  const series = createSeries({ bookId: loaded.book.id, partId: part.id });
  assert.equal(series.part_version, 1);

  assert.throws(
    () => savePart({ bookId: loaded.book.id, chapters: [7], title: '冲突' }),
    (err) => err.code === 'E_PART_CONFLICT' && err.conflicts[0].partId === part.id && /编辑/.test(err.hint),
  );
  assert.throws(() => savePart({ bookId: loaded.book.id, chapters: [0], title: '' }), (err) => err.code === 'E_PART_FRONT');
  assert.throws(() => savePart({ bookId: loaded.book.id, chapters: [1, 1], title: '' }), (err) => err.code === 'E_PART_DUP');

  const updated = updatePart({ bookId: loaded.book.id, partId: part.id, addChapters: [], removeChapters: [7], title: '函数（改）' });
  assert.equal(updated.version, 2);
  assert.equal(updated.title, '函数（改）');
  // AC-93：系列保存的是创建时的 Part 章快照，不随 Part 改名/增删章静默改变。
  assert.equal(series.part_version, 1);
  assert.deepEqual(series.chapters, [1, 2, 3, 4, 5, 6, 7]);
  deletePart(loaded.book.id, part.id);
  assert.equal(listParts(loaded.book.id).length, 0);
});

test('AC-96/98：7 章 8.4 万字 → 2 讲 30+12 页；非连续章按字数', async () => {
  const loaded = makeBook();
  const nums = [1, 2, 3, 4, 5, 6, 7];
  const chapters = nums.map((n) => {
    const c = loaded.chapters.find((x) => x.n === n);
    return { n, title: c.title, from: c.from, to: c.to, chars: 12000, text: '正'.repeat(12000) };
  });
  const part = { id: 'p1', title: '函数', chapters: nums, version: 1 };
  const out = await buildPlan({ ctx: null, book: loaded.book, part, chapters });
  assert.equal(out.plan.source, 'rule');
  assert.equal(out.plan.lectures.length, 2);
  assert.deepEqual(out.plan.lectures.map((l) => l.pages), [30, 12]);
  assert.equal(out.plan.totalPages, 42);
  assert.equal(out.plan.lectures[0].chapters.length, 5);

  const odd = [1, 3, 5];
  const oddChapters = odd.map((n) => chapters.find((c) => c.n === n));
  const oddPlan = await buildPlan({ ctx: null, book: loaded.book, part: { id: 'p2', title: '奇数章', chapters: odd }, chapters: oddChapters });
  assert.equal(oddPlan.plan.lectures.length, 1);
  assert.deepEqual(oddPlan.plan.lectures[0].chapters, odd);
  assert.equal(oddPlan.plan.lectures[0].pages, 18); // 36k / 2000
});

test('AC-139：系列先 draft，写 plan 后才 planned，不产生作业', () => {
  const loaded = makeBook();
  const part = savePart({ bookId: loaded.book.id, chapters: [1, 2, 3, 4, 5, 6, 7], title: '函数' });
  const series = createSeries({ bookId: loaded.book.id, partId: part.id });
  assert.equal(series.status, 'draft');
  assert.equal(series.plan_version, 0);
  assert.equal(fs.existsSync(path.join(ROOT, 'books', loaded.book.id, 'series', series.id, 'series.json')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'books', loaded.book.id, 'series', series.id, 'lectures')), false);
});

test('AC-101/102：模型讲纲合法则采用；术语凭空发明则回退规则 plan', async () => {
  const loaded = makeBook();
  const part = savePart({ bookId: loaded.book.id, chapters: [1, 2, 3, 4, 5, 6, 7], title: '函数' });
  const chapters = [1, 2, 3, 4, 5, 6, 7].map((n) => {
    const c = loaded.chapters.find((x) => x.n === n);
    return { n, title: c.title, from: c.from, to: c.to, chars: 12000, text: '正'.repeat(12000) };
  });
  const makeCtx = (plan) => {
    let calls = 0;
    return {
      get(name) {
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
        if (name !== 'llm') return null;
        return {
          async prepareCall() {
            return {
              config: {},
              async *stream() {
                calls += 1;
                if (calls === 1) {
                  yield { type: 'text-delta', text: JSON.stringify({ briefs: chapters.map((c) => ({ n: c.n, gist: c.title, sections: [], role: '', turning: false })) }) };
                } else {
                  yield { type: 'text-delta', text: JSON.stringify(plan) };
                }
                yield { type: 'finish', reason: { kind: 'stop' } };
              },
            };
          },
        };
      },
    };
  };
  const good = {
    throughline: '把函数当机器',
    lectures: [
      { n: 1, chapters: [1, 2, 3, 4, 5], title: '第 1 讲', goal: 'g', in: 'i', out: 'o' },
      { n: 2, chapters: [6, 7], title: '第 2 讲', goal: 'g', in: 'i', out: 'o' },
    ],
    seams: [{ from: 1, to: 2, concept: '极限', sentence: '上一讲把函数当机器；这一讲问它靠近某点时会去哪？' }],
    terms: [{ name: '标题1', forbid: ['標題'] }],
    cut_notes: [],
  };
  const out = await buildPlan({ ctx: makeCtx(good), book: loaded.book, dir: loaded.dir, part, chapters });
  assert.equal(out.plan.source, 'model');
  assert.equal(out.plan.seams.length, 1);

  const bad = Object.assign({}, good, { terms: [{ name: '不存在的术语', forbid: [] }] });
  const fallback = await buildPlan({ ctx: makeCtx(bad), book: loaded.book, dir: loaded.dir, part, chapters });
  assert.equal(fallback.plan.source, 'rule');
  assert.ok(fallback.warnings.some((w) => /术语/.test(w)));
});

test('AC-97：单章 9 万字拆上/下两讲，切点落在节标题', async () => {
  const text = '第9章 超长章\n' + '甲'.repeat(44000) + '\n9.1 第一节\n' + '乙'.repeat(44000);
  const rawPages = [{ page: 1, text }];
  const book = createBook({ buffer: Buffer.from('big-chapter-' + Date.now()), fileName: 'big.pdf', title: '超长书', author: '', pages: 1, rawPages });
  writeChapters(book.id, [{ n: 9, title: '第9章 超长章', from: 1, to: 1, chars: text.length, toc: false, front: false }], 'manual');
  const loaded = loadBook(book.id);
  const part = savePart({ bookId: book.id, chapters: [9], title: '超长章' });
  const chapters = [{ n: 9, title: '第9章 超长章', from: 1, to: 1, chars: text.length, text }];
  const out = await buildPlan({ ctx: null, book: loaded.book, part, chapters });
  assert.equal(out.plan.lectures.length, 2);
  assert.deepEqual(out.plan.lectures.map((l) => l.chapters), [[9], [9]]);
  assert.deepEqual(out.plan.lectures.map((l) => l.slice.part), ['上', '下']);
  assert.equal(out.plan.totalChars, text.length);

  const series = createSeries({ bookId: book.id, partId: part.id, plan: out.plan });
  assert.equal(series.status, 'planned');
  assert.equal(series.lectures.length, 2);
  const again = createSeries({ bookId: book.id, partId: part.id, plan: out.plan });
  assert.equal(again.id, series.id);

  let calls = 0;
  const metaCtx = {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
      if (name !== 'llm') return null;
      return {
        async prepareCall() {
          return {
            config: {},
            async *stream() {
              calls += 1;
              if (calls === 1) {
                yield { type: 'text-delta', text: JSON.stringify({ briefs: [{ n: 9, gist: '超长章', sections: [], role: '', turning: false }] }) };
              } else {
                yield {
                  type: 'text-delta',
                  text: JSON.stringify({
                    throughline: '第9章 超长章拆分：上半讲到第9章，下半讲从 9.1 第一节开始。',
                    seams: [{ from: 1, to: 2, concept: '9.1 第一节', sentence: '上篇收在第9章；下篇从 9.1 第一节开始。' }],
                    terms: [{ name: '超长章', forbid: [] }],
                  }),
                };
              }
              yield { type: 'finish', reason: { kind: 'stop' } };
            },
          };
        },
      };
    },
  };
  const modeled = await buildPlan({ ctx: metaCtx, book: loaded.book, dir: loaded.dir, part, chapters });
  assert.equal(modeled.plan.source, 'model');
  assert.equal(modeled.plan.seams.length, 1);
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
