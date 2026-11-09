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

const { createBook, loadBook, writeChapters } = await import('../host/books.js');
const { savePart, listParts, updatePart, deletePart } = await import('../host/parts.js');
const { buildPlan } = await import('../host/plan.js');
const { createSeries, savePlan } = await import('../host/series.js');

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

const clampPages = (chars) => Math.max(6, Math.min(30, Math.round(chars / 2000)));

/** FR-13 的判据：对任意章集合成立的不变量（I1–I4 + 页预算公式）。 */
function assertInvariants(plan, nums, label) {
  assert.ok(plan.lectures.length >= 1 && plan.lectures.length <= 8, label + '：讲数应在 1–8');
  const covered = [];
  plan.lectures.forEach((lecture, i) => {
    assert.equal(lecture.n, i + 1, label + '：讲次应连续');
    assert.ok(lecture.chapters.length >= 1 && lecture.chapters.length <= 6, label + '：每讲 1–6 章');
    assert.ok(lecture.chars <= 80000, label + '：每讲应 ≤8 万字，实际 ' + lecture.chars);
    assert.equal(lecture.pages, clampPages(lecture.chars), label + '：页预算公式');
    covered.push(...lecture.chapters);
  });
  // 章内拆分时同一章会跨讲重复出现（带 slice），此时只要求覆盖完备。
  if (!plan.lectures.some((l) => l.slice)) {
    assert.equal(new Set(covered).size, covered.length, label + '：章不应重复');
  }
  assert.ok(covered.every((n) => nums.includes(n)), label + '：不应出现 Part 外的章');
  assert.deepEqual(
    [...new Set(covered)].sort((a, b) => a - b),
    nums.slice().sort((a, b) => a - b),
    label + '：章覆盖应完备',
  );
  assert.equal(plan.totalPages, plan.lectures.reduce((sum, l) => sum + l.pages, 0), label + '：总页数');
  assert.equal(plan.estMinutes, plan.totalPages, label + '：时长由页数派生');
}

const mkChapter = (n, chars, text) => {
  const body = text || '正'.repeat(chars);
  return { n, title: '第' + n + ' 章', from: n, to: n, chars: body.length, text: body };
};

async function planOf(loaded, chapters) {
  const part = { id: 'p-' + chapters.map((c) => c.n).join('-'), title: '规则夹具', chapters: chapters.map((c) => c.n) };
  const out = await buildPlan({ ctx: null, book: loaded.book, part, chapters });
  return out.plan;
}

test('AC-96/98：任意章集合满足 I1–I4 与页预算（FR-13.1 夹具 F1–F12）', async () => {
  const loaded = makeBook();
  const heading = '\n9.1 第一节\n';
  const cases = [
    { id: 'F1', chapters: [1, 2, 3, 4, 5, 6, 7].map((n) => mkChapter(n, 12000)), shape: [[1, 2, 3, 4, 5], [6, 7]], pages: [30, 12] },
    { id: 'F2', chapters: [1, 2, 3, 4, 5, 6].map((n) => mkChapter(n, 12000)), shape: [[1, 2, 3, 4, 5], [6]], pages: [30, 6] },
    { id: 'F3', chapters: [mkChapter(1, 60000)], pages: [30] },
    { id: 'F4', chapters: [mkChapter(1, 80000)], parts: ['上', '下'], pages: [20, 20] },
    { id: 'F5', chapters: [mkChapter(1, 60001, '甲'.repeat(29996) + heading + '乙'.repeat(29996))], parts: ['上', '下'] },
    { id: 'F6', chapters: [mkChapter(1, 41999), mkChapter(2, 59999)], pages: [21, 30] },
    { id: 'F7', chapters: [mkChapter(1, 40000), mkChapter(2, 41000)], pages: [20, 21] },
    { id: 'F8', chapters: [1, 3, 5].map((n) => mkChapter(n, 12000)), shape: [[1, 3, 5]], pages: [18] },
    { id: 'F10', chapters: [mkChapter(1, 5000)], pages: [6] },
    { id: 'F12', chapters: [mkChapter(1, 240000)], parts: ['1/4', '2/4', '3/4', '4/4'], pages: [30, 30, 30, 30] },
  ];
  for (const item of cases) {
    const plan = await planOf(loaded, item.chapters);
    assertInvariants(plan, item.chapters.map((c) => c.n), item.id);
    if (item.pages) assert.deepEqual(plan.lectures.map((l) => l.pages), item.pages, item.id + '：页预算');
    if (item.shape) assert.deepEqual(plan.lectures.map((l) => l.chapters), item.shape, item.id + '：装章');
    if (item.parts) assert.deepEqual(plan.lectures.map((l) => l.slice && l.slice.part), item.parts, item.id + '：拆分标签');
  }

  // F9：48 章 ×1.2 万 = 10 讲 > 8，报 E_SERIES_TOO_MANY，不静默截断。
  const many = Array.from({ length: 48 }, (_, i) => mkChapter(i + 1, 12000));
  await assert.rejects(planOf(loaded, many), (err) => err.code === 'E_SERIES_TOO_MANY');
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
  const cutAt = out.plan.lectures[0].slice.to;
  assert.equal(out.plan.lectures[1].slice.from, cutAt, '上/下两段应首尾相接');
  assert.ok(text.slice(cutAt).startsWith('9.1 第一节'), '切点应落在节标题行');
  assert.ok(out.plan.lectures.every((l) => l.chars <= 60000), '每段 ≤6 万');

  // 边界：6 万整不拆；6 万+1 字拆；6–8 万必须拆（否则 30 页上限会压掉内容）。
  const atCap = await planOf(loaded, [mkChapter(1, 60000)]);
  assert.equal(atCap.lectures.length, 1, '恰好 6 万不拆');
  const overCap = await planOf(loaded, [mkChapter(1, 60001)]);
  assert.equal(overCap.lectures.length, 2, '6 万+1 字应拆上/下');
  assert.deepEqual(overCap.lectures.map((l) => l.chapters), [[1], [1]]);
  assert.deepEqual(overCap.lectures.map((l) => l.slice.part), ['上', '下']);
  assert.ok(overCap.lectures.every((l) => l.chars <= 60000), '每段 ≤6 万');
  const mid = await planOf(loaded, [mkChapter(1, 70000)]);
  assert.equal(mid.lectures.length, 2, '6–8 万要拆');
  const atOldHard = await planOf(loaded, [mkChapter(1, 80000)]);
  assert.equal(atOldHard.lectures.length, 2, '8 万也要拆');

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
