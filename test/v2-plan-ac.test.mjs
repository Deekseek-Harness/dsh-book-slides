/**
 * FR-15 / AC-101 / AC-102：讲纲的 seams 数校验、术语凭空发明与重试降级。
 *
 * 判据化原则同 AC-99/100：
 * - 失败分支用脚本化假模型注入（不改真模型、不靠偶发）；
 * - 断言可判真假的字段（调用次数、source、seams 数、terms、降级后能否进生成门）；
 * - 重试只允许 1 次（讲纲调用 2 次，加 briefs 1 次 = 3 次）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-plan-ac-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, loadBook, writeChapters } = await import('../host/books.js');
const { savePart } = await import('../host/parts.js');
const { buildPlan } = await import('../host/plan.js');
const { createSeries } = await import('../host/series.js');

// 每章 5 万字：规则讲纲会拆成 2 讲（50k + 50k 超过 8 万硬上限），便于核对“降级后仍覆盖全部章”
const T1 = '第1章 通道\n4.1 CSP 是什么\n' + '甲'.repeat(50000);
const T2 = '第2章 接口\n5.1 Go 接口与 C++接口有何异同\n' + '丙'.repeat(50000);

const book = createBook({
  buffer: Buffer.from('plan-ac-book-' + Date.now()),
  fileName: 'plan-ac.pdf',
  title: '讲纲判据书',
  author: '',
  pages: 2,
  rawPages: [
    { page: 1, text: T1 },
    { page: 2, text: T2 },
  ],
});
writeChapters(
  book.id,
  [
    { n: 1, title: '第1章 通道', from: 1, to: 1, chars: T1.length, toc: false, front: false },
    { n: 2, title: '第2章 接口', from: 2, to: 2, chars: T2.length, toc: false, front: false },
  ],
  'manual',
);
const loaded = loadBook(book.id);
const part = savePart({ bookId: book.id, chapters: [1, 2], title: '讲纲 Part' });
const chapters = [
  { n: 1, title: '第1章 通道', from: 1, to: 1, chars: T1.length, text: T1 },
  { n: 2, title: '第2章 接口', from: 2, to: 2, chars: T2.length, text: T2 },
];

const briefsGood = JSON.stringify({
  briefs: [
    { n: 1, gist: '通道与 CSP', sections: ['4.1 CSP 是什么'], role: '承接', turning: true },
    { n: 2, gist: '接口对比', sections: ['5.1 Go 接口与 C++接口有何异同'], role: '铺垫', turning: false },
  ],
});

const seam = { from: 1, to: 2, concept: '接口', sentence: '通道之后，接口登场。' };
const planBase = {
  throughline: '从通道到接口',
  lectures: [
    { n: 1, chapters: [1], title: '第 1 讲 通道', goal: 'g', in: 'i', out: 'o' },
    { n: 2, chapters: [2], title: '第 2 讲 接口', goal: 'g', in: 'i', out: 'o' },
  ],
  seams: [seam],
  terms: [{ name: '4.1 CSP 是什么', forbid: [] }],
  cut_notes: [],
};
const withSeams = (seams) => JSON.stringify(Object.assign({}, planBase, { seams }));
const withTerm = (name) => JSON.stringify(Object.assign({}, planBase, { terms: [{ name, forbid: [] }] }));

/** 脚本化假模型：按顺序吐 replies；第 1 次是 briefs，其余是讲纲。 */
function makeCtx(replies) {
  let i = 0;
  const state = { calls: 0 };
  return {
    state,
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-plan' }) };
      if (name !== 'llm') return null;
      return {
        async prepareCall() {
          return {
            config: {},
            async *stream() {
              state.calls += 1;
              const text = replies[Math.min(i, replies.length - 1)];
              i += 1;
              yield { type: 'text-delta', text };
              yield { type: 'finish', reason: { kind: 'stop' } };
            },
          };
        },
      };
    },
  };
}

test('AC-101：seams 数 ≠ N−1 判不合格并重试 1 次，第二次合格则采用', async () => {
  const ctx = makeCtx([briefsGood, withSeams([]), JSON.stringify(planBase)]);
  const out = await buildPlan({ ctx, book: loaded.book, part, chapters, dir: loaded.dir, force: true });
  assert.equal(ctx.state.calls, 3, 'briefs 1 次 + 讲纲 2 次（重试 1 次）');
  assert.equal(out.plan.source, 'model');
  assert.equal(out.plan.seams.length, 1, '2 讲恰有 1 条 seam');
  assert.equal(out.plan.stitched, true);
});

test('AC-101：两次 seams 数都不对 → 规则 plan（unstitched），仍覆盖 Part 且可进入生成', async () => {
  const twoSeams = withSeams([seam, { from: 2, to: 3, concept: '多余', sentence: '多余的一条。' }]);
  const ctx = makeCtx([briefsGood, twoSeams, withSeams([])]);
  const out = await buildPlan({ ctx, book: loaded.book, part, chapters, dir: loaded.dir, force: true });
  assert.equal(ctx.state.calls, 3, '两次坏讲纲也只重试 1 次');
  assert.equal(out.plan.source, 'rule');
  assert.equal(out.plan.stitched, false);
  assert.equal(out.plan.seams.length, 0);
  assert.deepEqual(
    out.plan.lectures.flatMap((lecture) => lecture.chapters).sort((a, b) => a - b),
    [1, 2],
    '降级 plan 必须覆盖 Part 全部章',
  );
  assert.ok(out.warnings.some((w) => /seams|讲纲输出不合格/.test(w)), '降级原因要能定位到校验项');

  // “仍可生成”的判定门：plan_version≥1 且 lectures 非空（generate.js 的 E_SERIES_UNPLANNED）
  const series = createSeries({ bookId: book.id, partId: part.id, plan: out.plan });
  assert.equal(series.status, 'planned');
  assert.equal(series.stitch, 'unstitched');
  assert.ok(Number(series.plan_version) >= 1);
  assert.ok((series.lectures || []).length >= 1);
});

test('AC-102：术语凭空发明判不合格并重试 1 次，第二次合格则采用（briefs 里的词可合法）', async () => {
  const ctx = makeCtx([briefsGood, withTerm('不存在的术语'), withTerm('接口对比')]);
  const out = await buildPlan({ ctx, book: loaded.book, part, chapters, dir: loaded.dir, force: true });
  assert.equal(ctx.state.calls, 3, '术语校验失败同样只重试 1 次');
  assert.equal(out.plan.source, 'model');
  assert.equal(out.plan.terms[0].name, '接口对比', '出现在 briefs 里的术语必须放行');
});

test('AC-102：两次凭空发明 → 规则 plan，warning 含“术语”', async () => {
  const ctx = makeCtx([briefsGood, withTerm('不存在的术语'), withTerm('另一个不存在的词')]);
  const out = await buildPlan({ ctx, book: loaded.book, part, chapters, dir: loaded.dir, force: true });
  assert.equal(ctx.state.calls, 3);
  assert.equal(out.plan.source, 'rule');
  assert.equal(out.plan.stitched, false);
  assert.ok(out.warnings.some((w) => /术语/.test(w)));
  assert.deepEqual(
    out.plan.lectures.flatMap((lecture) => lecture.chapters).sort((a, b) => a - b),
    [1, 2],
  );
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
