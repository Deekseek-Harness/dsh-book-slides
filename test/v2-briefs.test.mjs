/**
 * FR-14 / AC-99 / AC-100：briefs 的 sections 原文校验与坏 JSON 降级。
 *
 * 两条原则：
 * 1. 失败分支不靠“真模型偶尔出错”来碰，用脚本化假模型把坏输入钉死（故障注入）。
 * 2. 断言强度要够：删掉 validateBrief / 重试循环，这里必须变红；sections 不能是空数组。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-briefs-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, loadBook, writeChapters } = await import('../v2/books.js');
const { buildBriefs, fallbackBrief, readBriefs, validateBrief } = await import('../v2/briefs.js');
const { buildPlan } = await import('../v2/plan.js');
const { savePart } = await import('../v2/parts.js');
const { routeM1 } = await import('../v2/api.js');

const T1 = '第1章 通道\n4.1 CSP 是什么\n' + '甲'.repeat(2000) + '\n4.2 通道有哪些应用\n' + '乙'.repeat(2000);
const T2 = '第2章 接口\n5.1 Go 接口与 C++接口有何异同\n' + '丙'.repeat(2000);

const book = createBook({
  buffer: Buffer.from('briefs-book-' + Date.now()),
  fileName: 'briefs.pdf',
  title: 'briefs 测试书',
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
const chapters = [
  { n: 1, title: '第1章 通道', from: 1, to: 1, chars: T1.length, text: T1 },
  { n: 2, title: '第2章 接口', from: 2, to: 2, chars: T2.length, text: T2 },
];
const part = { id: 'p1', title: '测试 Part', chapters: [1, 2] };

const goodReply = JSON.stringify({
  briefs: [
    { n: 1, gist: '通道与 CSP', sections: ['4.1 CSP 是什么', '4.2 通道有哪些应用'], role: '承接', turning: true },
    { n: 2, gist: '接口对比', sections: ['5.1 Go 接口与 C++接口有何异同'], role: '铺垫', turning: false },
  ],
});

/** 脚本化假模型：按顺序吐 replies，并记调用次数。 */
function makeCtx(replies) {
  let i = 0;
  const state = { calls: 0 };
  return {
    state,
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-briefs' }) };
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

function briefsFile() {
  return path.join(loaded.dir, 'briefs.json');
}

test('AC-99：模型给出的 sections 逐字来自原文才入库；校验不是空集恒真', async () => {
  assert.equal(validateBrief({ n: 1, sections: ['4.9 原文没有这一节'] }, chapters[0]), false, '校验必须能判否');
  const ctx = makeCtx([goodReply]);
  const out = await buildBriefs({ ctx, book: loaded.book, dir: loaded.dir, chapters, force: true });
  assert.equal(out.fallback, false);
  assert.equal(out.degraded, false);
  assert.deepEqual(out.warnings, []);
  assert.equal(ctx.state.calls, 1);

  // 断言的对象是“产物”：每一条 section 都能在该章原文里检索到
  for (const brief of out.briefs) {
    const chapter = chapters.find((c) => c.n === brief.n);
    assert.ok(brief.sections.length > 0, '本章 brief 不应是空 sections');
    for (const section of brief.sections) assert.ok(chapter.text.includes(section), section);
  }

  const stored = JSON.parse(fs.readFileSync(briefsFile(), 'utf8'));
  assert.equal(stored.briefs.length, 2);
  assert.equal(stored.hash, chapters.map((c) => c.n + ':' + c.chars + ':' + c.title).join('|'));
  const recheck = readBriefs(loaded.dir, chapters);
  assert.deepEqual(recheck.warnings, []);
});

test('AC-99：模型返回一条原文查不到的 section → 该章整条回退，其余章保留', async () => {
  const badSection = JSON.stringify({
    briefs: [
      { n: 1, gist: '通道与 CSP', sections: ['4.1 CSP 是什么', '4.9 这条不在原文'], role: '承接', turning: true },
      { n: 2, gist: '接口对比', sections: ['5.1 Go 接口与 C++接口有何异同'], role: '铺垫', turning: false },
    ],
  });
  const out = await buildBriefs({ ctx: makeCtx([badSection]), book: loaded.book, dir: loaded.dir, chapters, force: true });
  assert.equal(out.fallback, false, '只应回退该章，不应整份回退');
  assert.equal(out.degraded, true);
  assert.ok(out.warnings.some((w) => /第 1 章/.test(w)), 'warning 要能定位到章');
  assert.deepEqual(out.briefs[0], fallbackBrief(chapters[0]), '坏章回退为标题 + 首尾段');
  assert.equal(out.briefs[1].gist, '接口对比', '好章不受影响');
  assert.equal(out.briefs[1].role, '铺垫');
});

test('AC-99：手工改坏落盘 briefs.json 后，读回时校验并回退该章（缓存不是免检通道）', async () => {
  await buildBriefs({ ctx: makeCtx([goodReply]), book: loaded.book, dir: loaded.dir, chapters, force: true });
  const stored = JSON.parse(fs.readFileSync(briefsFile(), 'utf8'));
  stored.briefs[0].sections[0] = '4.1 CSPxxxxx 是什么';
  fs.writeFileSync(briefsFile(), JSON.stringify(stored, null, 2));

  // 章纲不变 → hash 命中缓存；但缓存同样要过 sections 原文校验
  const ctx = makeCtx([goodReply]);
  const out = await buildBriefs({ ctx, book: loaded.book, dir: loaded.dir, chapters });
  assert.equal(ctx.state.calls, 0, '缓存命中不应调模型');
  assert.equal(out.cached, true);
  assert.equal(out.degraded, true);
  assert.ok(out.warnings.some((w) => /第 1 章/.test(w)));
  assert.deepEqual(out.briefs[0], fallbackBrief(chapters[0]));

  // 回退是“读时降级”，不静默重写人工修改
  const after = JSON.parse(fs.readFileSync(briefsFile(), 'utf8'));
  assert.equal(after.briefs[0].sections[0], '4.1 CSPxxxxx 是什么');

  const direct = readBriefs(loaded.dir, chapters);
  assert.equal(direct.rejected.length, 1);
  assert.ok(direct.warnings.length > 0);
});

test('AC-100：两次坏 JSON → 只重试 1 次，整份回退首尾段，系列仍可规划', async () => {
  const junk = makeCtx(['这不是 JSON，只是散文。', '```json\n{"briefs": [ 坏掉\n```', '仍然不是 JSON', '还是不是']);
  // force：跳过磁盘缓存，确保坏 JSON 真的打到模型边界上
  const out = await buildPlan({ ctx: junk, book: loaded.book, part, chapters, dir: loaded.dir, force: true });
  assert.equal(junk.state.calls, 4, 'briefs 2 次 + 讲纲 2 次（各重试 1 次）');
  assert.equal(out.briefs.fallback, true);
  assert.ok(out.briefs.warnings.some((w) => /解析失败/.test(w)));
  assert.equal(out.briefs.briefs.length, chapters.length);
  assert.ok(out.plan.lectures.length >= 1, '降级后仍应给出可用的规则讲纲');
  assert.deepEqual(
    out.plan.lectures.flatMap((lecture) => lecture.chapters).sort((a, b) => a - b),
    [1, 2],
    '规则讲纲要覆盖 Part 的全部章',
  );
  assert.equal(out.plan.source, 'rule');
  assert.equal(out.plan.stitched, false);
});

test('AC-100：第一次坏 JSON、第二次合法 → 一次重试即恢复，不降级', async () => {
  const ctx = makeCtx(['不是 JSON', goodReply]);
  const out = await buildBriefs({ ctx, book: loaded.book, dir: loaded.dir, chapters, force: true });
  assert.equal(ctx.state.calls, 2, '坏一次只重试一次');
  assert.equal(out.fallback, false);
  assert.equal(out.degraded, false);
  assert.equal(out.briefs[0].gist, '通道与 CSP');
});

test('AC-99：/plan/preview 把读取侧回退暴露成 warning 与 briefsSource=mixed', async () => {
  // 先落一版合法 briefs（hash 与 Part 章纲一致），再改坏一条
  await buildBriefs({ ctx: makeCtx([goodReply]), book: loaded.book, dir: loaded.dir, chapters, force: true });
  const stored = JSON.parse(fs.readFileSync(briefsFile(), 'utf8'));
  stored.briefs[0].sections[0] = '4.1 CSPxxxxx 是什么';
  fs.writeFileSync(briefsFile(), JSON.stringify(stored, null, 2));

  const savedPart = savePart({ bookId: book.id, chapters: [1, 2], title: 'briefs Part' });
  const planReply = JSON.stringify({
    throughline: '从通道到接口',
    lectures: [
      { n: 1, chapters: [1], title: '第 1 讲 通道', goal: 'g', in: 'i', out: 'o' },
      { n: 2, chapters: [2], title: '第 2 讲 接口', goal: 'g', in: 'i', out: 'o' },
    ],
    seams: [{ from: 1, to: 2, concept: '接口', sentence: '通道之后，接口登场。' }],
    terms: [{ name: '4.1 CSP 是什么', forbid: [] }],
    cut_notes: [],
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const handled = await routeM1(req, res, url, { ctx: makeCtx([planReply]) });
    if (!handled) {
      res.statusCode = 404;
      res.end('no route');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/dsh-book-slides/plan/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bookId: book.id, partId: savedPart.id }),
    });
    const out = await response.json();
    assert.equal(out.ok, true);
    assert.equal(out.briefsSource, 'mixed', '读取侧回退要能让前端看出来');
    assert.ok(out.warnings.some((w) => /第 1 章/.test(w) && /未逐字出现在原文/.test(w)));
  } finally {
    server.close();
  }
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
