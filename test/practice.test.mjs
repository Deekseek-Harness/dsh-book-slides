/**
 * 练习与复习接口测试 —— 假模型，真路由。
 *
 *   node test/practice.test.mjs
 *
 * 覆盖 FR-11 / 附录 P 的主路径：按需出题、缓存与去重入口、组卷不下发答案、
 * 宿主判题、讲解按需生成并沉淀、场次汇总、错题与到期复习、标记坏题。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-practice-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
process.env.DSH_BOOK_SLIDES_LLM_TIMEOUT_MS = '2000';
delete process.env.DSH_HOME;

const plugin = await import('../index.js');
const practice = await import('../practice.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CALLS = [];
let QUEUE = [];

const fakeLlm = {
  async prepareCall(config) {
    const entry = { config: config, user: '' };
    CALLS.push(entry);
    return {
      config: {},
      async *stream(params) {
        try {
          entry.user = params.messages[0].content[0].text;
        } catch {
          entry.user = '';
        }
        const chunks = QUEUE.shift() || [];
        for (const chunk of chunks) {
          if (chunk && chunk.delayMs) await sleep(chunk.delayMs);
          const copy = Object.assign({}, chunk);
          delete copy.delayMs;
          yield copy;
        }
      },
    };
  },
};

function makeContext() {
  const routes = new Map();
  const scoped = {
    webServer: {
      register(options) {
        routes.set(options.path, options.handler);
        return () => routes.delete(options.path);
      },
    },
    commands: { register() { return () => {}; } },
  };
  return {
    ctx: {
      inject(names, fn) {
        fn(scoped);
      },
      on() {},
      get(name) {
        if (name === 'llm') return fakeLlm;
        if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) };
        return undefined;
      },
    },
    routes,
  };
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

const getJson = (pathname) => fetch(base + pathname).then((res) => res.json());
const postJson = (pathname, body) =>
  fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then((res) => res.json());

/* ------------------------------ 造一本书 + 一个就绪模块 ------------------------------ */

const BOOK_ID = 'b1testbook';
const MODULE_ID = 'm1testmod';
const bookDir = path.join(ROOT, 'books', BOOK_ID);

const PAGE_TEXT = [
  '第一章 开始',
  '导演的工作，远不止喊一声开机，他首先要让文字在画面里站住。',
  '预算与周期由制片负责，导演只在需要时提要求。',
  '把纸上的东西变成看得见的东西，这是导演的第一件事。',
].join('\n');
const PAGE2_TEXT = [
  '第二章 继续',
  '发行与宣传不在导演的职责范围内。',
  '开拍之前，导演要先想清楚每一场戏要说什么。',
].join('\n');

fs.mkdirSync(path.join(bookDir, 'modules', MODULE_ID), { recursive: true });
fs.writeFileSync(
  path.join(bookDir, 'book.json'),
  JSON.stringify({ id: BOOK_ID, title: '练习测试书', author: '', pages: 2, chapterCount: 1, chars: 200, sha256: 'a'.repeat(64), importedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString() }),
);
fs.writeFileSync(
  path.join(bookDir, 'pages.json'),
  JSON.stringify([
    { page: 1, text: PAGE_TEXT },
    { page: 2, text: PAGE2_TEXT },
  ]),
);
fs.writeFileSync(
  path.join(bookDir, 'chapters.json'),
  JSON.stringify([{ n: 1, title: '第一章 开始', from: 1, to: 2, chars: 200, manual: false, toc: false, front: false }]),
);
fs.writeFileSync(
  path.join(bookDir, 'modules', MODULE_ID, 'module.json'),
  JSON.stringify({
    id: MODULE_ID,
    bookId: BOOK_ID,
    title: '精讲：第 1 章',
    chapters: [1],
    chapterTitles: ['第一章 开始'],
    status: 'ready',
    stage: 'done',
    slides: 2,
    anchored: 2,
    anchorHitRate: 1,
    model: 'fake-model',
    promptVersion: 'b2p-v1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }),
);
fs.writeFileSync(
  path.join(bookDir, 'modules', MODULE_ID, 'slides.json'),
  JSON.stringify({
    schema_version: 1,
    module_id: MODULE_ID,
    book_id: BOOK_ID,
    slides: [
      { slide_index: 1, layout: 'content_text', title: '导演的职责', bullet_points: ['导演要把文字变成画面', '预算由制片负责'], source_pages: { from: 1, to: 1 } },
      { slide_index: 2, layout: 'content_text', title: '开拍之前', bullet_points: ['先想清楚每场戏'], source_pages: { from: 2, to: 2 } },
    ],
  }),
);

function question(type, point, stem, options, answer, quote) {
  return { type: type, difficulty: 2, point: point, stem: stem, options: options, answer: answer, source_quote: quote };
}

const OPTIONS = [
  { key: 'A', text: '把文字变成画面' },
  { key: 'B', text: '控制拍摄预算' },
  { key: 'C', text: '协调发行宣传' },
  { key: 'D', text: '决定演员片酬' },
];

const GENERATED = {
  questions: [
    question('single', '导演职责', '导演的首要职责是什么？', OPTIONS, ['A'], '导演的工作，远不止喊一声开机，他首先要让文字在画面里站住。'),
    question('single', '预算归属', '拍摄预算与周期由谁负责？', OPTIONS, ['B'], '预算与周期由制片负责，导演只在需要时提要求。'),
    question('single', '转化文字', '把纸上的东西变成看得见的东西，被原文称为什么？', OPTIONS, ['A'], '把纸上的东西变成看得见的东西，这是导演的第一件事。'),
    question('judge', '发行职责', '发行与宣传在导演的职责范围内。', [], ['B'], '发行与宣传不在导演的职责范围内。'),
    question('single', '开拍准备', '开拍之前导演要先做什么？', OPTIONS, ['A'], '开拍之前，导演要先想清楚每一场戏要说什么。'),
  ],
};

const APPENDED = {
  questions: [
    question('single', '职责边界', '导演的职责边界如何界定？', OPTIONS, ['A'], '发行与宣传不在导演的职责范围内。'),
    question('single', '周期管理', '谁负责拍摄周期？', OPTIONS, ['B'], '预算与周期由制片负责，导演只在需要时提要求。'),
    question('single', '第一件事', '原文说导演的第一件事是什么？', OPTIONS, ['A'], '把纸上的东西变成看得见的东西，这是导演的第一件事。'),
    question('single', '开拍准备', '开拍之前要先想清楚什么？', OPTIONS, ['A'], '开拍之前，导演要先想清楚每一场戏要说什么。'),
    question('single', '转化文字', '导演在喊开机之前做的工作是什么？', OPTIONS, ['A'], '导演的工作，远不止喊一声开机，他首先要让文字在画面里站住。'),
  ],
};

/* ------------------------------ 测试 ------------------------------ */

test('summary 初始为空，且有就绪模块', async () => {
  const data = await getJson('/dsh-book-slides/practice/summary?bookId=' + BOOK_ID);
  assert.equal(data.ok, true);
  assert.equal(data.bank.total, 0);
  assert.equal(data.modules.length, 1);
  assert.equal(data.modules[0].moduleId, MODULE_ID);
});

test('按需出题：异步作业到 ready，题目带锚点且不下发答案', async () => {
  QUEUE = [[{ type: 'text-delta', text: JSON.stringify(GENERATED) }]];
  const started = await postJson('/dsh-book-slides/practice/generate', { bookId: BOOK_ID, chapters: [1] });
  assert.equal(started.ok, true);
  assert.ok(started.jobId);

  let job = null;
  for (let i = 0; i < 60; i += 1) {
    job = await getJson('/dsh-book-slides/practice/job?jobId=' + started.jobId);
    if (job.status === 'ready' || job.status === 'failed') break;
    await sleep(100);
  }
  assert.equal(job.status, 'ready', job.error || '');
  assert.equal(CALLS.length, 1);

  const bank = practice.readBank(BOOK_ID);
  assert.equal(bank.questions.length, 5);
  assert.equal(bank.questions.every((item) => item.anchor_status === 'anchored'), true);
  assert.equal(bank.questions.every((item) => item.explanation === null), true);
  assert.equal(bank.chapters['1'].status, 'ready');

  const summary = await getJson('/dsh-book-slides/practice/summary?bookId=' + BOOK_ID);
  assert.equal(summary.bank.total, 5);
  assert.equal(summary.bank.unseen, 5);
});

test('同章再次出题命中缓存，不再调模型', async () => {
  const before = CALLS.length;
  const again = await postJson('/dsh-book-slides/practice/generate', { bookId: BOOK_ID, chapters: [1] });
  assert.equal(again.ok, true);
  assert.equal(again.cached, true);
  assert.equal(CALLS.length, before);
});

test('summary 补题计划：混合补满 count，复习无题时 blocked', async () => {
  const mixed = await getJson('/dsh-book-slides/practice/summary?bookId=' + BOOK_ID + '&mode=mixed&count=8');
  assert.equal(mixed.topup.unseen, 5);
  assert.equal(mixed.topup.targetNew, 8, '没有旧题时用新题补满 8 题');
  assert.equal(mixed.topup.rounds, 1);
  assert.equal(mixed.topup.feasibleN, 8);

  const newMode = await getJson('/dsh-book-slides/practice/summary?bookId=' + BOOK_ID + '&mode=new&count=20');
  assert.equal(newMode.topup.targetNew, 20);
  assert.equal(newMode.topup.rounds, 3);
  assert.equal(newMode.topup.feasibleN, 20);

  const review = await getJson('/dsh-book-slides/practice/summary?bookId=' + BOOK_ID + '&mode=review&count=8');
  assert.equal(review.topup.blocked, true);
  assert.ok(String(review.topup.reason).includes('到期'));
});

test('组卷不下发答案；宿主判题；错题讲解按需生成并沉淀', async () => {
  const session = await postJson('/dsh-book-slides/practice/session', {
    bookId: BOOK_ID,
    chapters: [1],
    mode: 'mixed',
    count: 5,
  });
  assert.equal(session.ok, true);
  assert.equal(session.questions.length, 5);
  assert.equal(session.questions.every((item) => !('answer' in item) && !('explanation' in item)), true);

  const bank = practice.readBank(BOOK_ID);
  const first = session.questions[0];
  const question = bank.questions.find((item) => item.qid === first.qid);
  const wrong = question.answer[0] === 'A' ? 'B' : 'A';

  const answered = await postJson('/dsh-book-slides/practice/answer', {
    bookId: BOOK_ID,
    sessionId: session.sessionId,
    qid: first.qid,
    picked: [wrong],
    elapsedMs: 1200,
  });
  assert.equal(answered.ok, true);
  assert.equal(answered.correct, false);
  assert.equal(answered.explanation, null);
  assert.equal(answered.mastery.box, 0);

  const duplicate = await postJson('/dsh-book-slides/practice/answer', {
    bookId: BOOK_ID,
    sessionId: session.sessionId,
    qid: first.qid,
    picked: [question.answer[0]],
    elapsedMs: 1,
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.correct, false, '同一题重复提交按首次结果，不改判');

  QUEUE = [[{ type: 'text-delta', text: '正确项的依据在原文第一句；错误项把制片职责当成了导演职责。' }]];
  const explained = await postJson('/dsh-book-slides/practice/explain', {
    bookId: BOOK_ID,
    sessionId: session.sessionId,
    qid: first.qid,
    picked: [wrong],
  });
  assert.equal(explained.ok, true);
  assert.ok(explained.explanation.length > 10);

  const refreshed = practice.readBank(BOOK_ID);
  const updated = refreshed.questions.find((item) => item.qid === first.qid);
  assert.equal(updated.explanation_status, 'ready');
  assert.ok(updated.explanation.includes('制片'));

  const again = await postJson('/dsh-book-slides/practice/explain', {
    bookId: BOOK_ID,
    sessionId: session.sessionId,
    qid: first.qid,
    picked: [wrong],
  });
  assert.equal(again.cached, true);

  const second = session.questions[1];
  const secondQuestion = refreshed.questions.find((item) => item.qid === second.qid);
  const correct = await postJson('/dsh-book-slides/practice/answer', {
    bookId: BOOK_ID,
    sessionId: session.sessionId,
    qid: second.qid,
    picked: secondQuestion.answer,
    elapsedMs: 800,
  });
  assert.equal(correct.correct, true);
  assert.equal(correct.mastery.box, 1);

  const finished = await postJson('/dsh-book-slides/practice/finish', { bookId: BOOK_ID, sessionId: session.sessionId });
  assert.equal(finished.ok, true);
  assert.equal(finished.summary.answered, 2);
  assert.equal(finished.summary.correct, 1);
  assert.equal(finished.summary.accuracy, 0.5);
  assert.equal(finished.details.length, 2);

  const resumed = await getJson('/dsh-book-slides/practice/session?bookId=' + BOOK_ID + '&sessionId=' + session.sessionId);
  assert.equal(resumed.nextIndex, 2);
  assert.equal(resumed.questions.every((item) => !('answer' in item)), true);

  const review = await getJson('/dsh-book-slides/practice/review?bookId=' + BOOK_ID);
  assert.equal(review.ok, true);
  assert.equal(review.wrong.some((item) => item.qid === first.qid), true);
  assert.equal(review.due.some((item) => item.qid === first.qid), true, '答错后立即到期');
});

test('标记坏题后不再进入组卷，但题库保留', async () => {
  const bank = practice.readBank(BOOK_ID);
  const target = bank.questions[2];
  const flagged = await postJson('/dsh-book-slides/practice/flag', { bookId: BOOK_ID, qid: target.qid, reason: '答案有争议' });
  assert.equal(flagged.ok, true);
  assert.equal(flagged.hidden, true);

  const after = practice.readBank(BOOK_ID);
  assert.equal(after.questions.length, 5);
  assert.equal(after.questions.find((item) => item.qid === target.qid).flagged, true);

  const session = await postJson('/dsh-book-slides/practice/session', {
    bookId: BOOK_ID,
    chapters: [1],
    mode: 'mixed',
    count: 5,
  });
  assert.equal(session.ok, true);
  assert.equal(session.questions.some((item) => item.qid === target.qid), false);
});

test('没有精讲覆盖的章不能出新题', async () => {
  fs.writeFileSync(
    path.join(bookDir, 'chapters.json'),
    JSON.stringify([
      { n: 1, title: '第一章 开始', from: 1, to: 2, chars: 200, manual: false, toc: false, front: false },
      { n: 2, title: '第二章 未讲', from: 2, to: 2, chars: 100, manual: false, toc: false, front: false },
    ]),
  );
  const failed = await postJson('/dsh-book-slides/practice/generate', { bookId: BOOK_ID, chapters: [2] });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'E_QZ_NO_SOURCE');
});

test('组卷 0 题时明确报错', async () => {
  const emptyBook = 'b2emptybook';
  const dir = path.join(ROOT, 'books', emptyBook);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'book.json'), JSON.stringify({ id: emptyBook, title: '空书', pages: 1, chapterCount: 1, chars: 60 }));
  fs.writeFileSync(path.join(dir, 'pages.json'), JSON.stringify([{ page: 1, text: 'x'.repeat(80) }]));
  fs.writeFileSync(path.join(dir, 'chapters.json'), JSON.stringify([{ n: 1, title: '全文', from: 1, to: 1, chars: 80, front: false }]));
  const data = await postJson('/dsh-book-slides/practice/session', { bookId: emptyBook, chapters: [1], mode: 'mixed', count: 8 });
  assert.equal(data.ok, false);
  assert.equal(data.code, 'E_QZ_NOT_ENOUGH');
});

test('断点续练：不带 sessionId 取最近未结束场次', async () => {
  const session = await postJson('/dsh-book-slides/practice/session', {
    bookId: BOOK_ID,
    chapters: [1],
    mode: 'mixed',
    count: 3,
  });
  assert.equal(session.ok, true);
  const bank = practice.readBank(BOOK_ID);
  const question = bank.questions.find((item) => item.qid === session.questions[0].qid);
  await postJson('/dsh-book-slides/practice/answer', {
    bookId: BOOK_ID,
    sessionId: session.sessionId,
    qid: question.qid,
    picked: question.answer,
    elapsedMs: 300,
  });
  const resumed = await getJson('/dsh-book-slides/practice/session?bookId=' + BOOK_ID);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.session.session_id, session.sessionId);
  assert.equal(resumed.nextIndex, 1);
  assert.equal(resumed.questions.every((item) => !('answer' in item)), true);
  await postJson('/dsh-book-slides/practice/finish', { bookId: BOOK_ID, sessionId: session.sessionId });
});

test('书档往返：practice 随包走，导入按 qid / session_id 合并', async () => {
  const crypto = await import('node:crypto');
  const pdf = Buffer.from('%PDF-1.4 practice roundtrip\n');
  fs.writeFileSync(path.join(bookDir, 'source.pdf'), pdf);
  const book = JSON.parse(fs.readFileSync(path.join(bookDir, 'book.json'), 'utf8'));
  book.sha256 = crypto.createHash('sha256').update(pdf).digest('hex');
  fs.writeFileSync(path.join(bookDir, 'book.json'), JSON.stringify(book));

  const before = practice.readBank(BOOK_ID);
  const zipRes = await fetch(base + '/dsh-book-slides/export?books=' + BOOK_ID);
  assert.equal(zipRes.ok, true);
  const zip = Buffer.from(await zipRes.arrayBuffer());
  assert.ok(zip.length > 1000);

  const imported = await fetch(base + '/dsh-book-slides/import/package?policy=merge', {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'x-file-name': encodeURIComponent('practice-roundtrip.zip') },
    body: zip,
  }).then((response) => response.json());
  assert.equal(imported.ok, true);
  assert.equal(imported.items[0].status, 'merged');

  const after = practice.readBank(BOOK_ID);
  assert.deepEqual(
    after.questions.map((item) => item.qid).sort(),
    before.questions.map((item) => item.qid).sort(),
  );
  const mastery = practice.readMastery(BOOK_ID);
  assert.ok(Object.keys(mastery.items).length >= 1);
});

test('导出 → 删除 → 重新导入：practice 不丢', async () => {
  const before = practice.readBank(BOOK_ID);
  const beforeMastery = practice.readMastery(BOOK_ID);
  const beforeQids = before.questions.map((item) => item.qid).sort();

  const zipRes = await fetch(base + '/dsh-book-slides/export?books=' + BOOK_ID);
  assert.equal(zipRes.ok, true);
  const zip = Buffer.from(await zipRes.arrayBuffer());

  const deleted = await postJson('/dsh-book-slides/delete', { bookId: BOOK_ID });
  assert.equal(deleted.ok, true);
  assert.equal(fs.existsSync(path.join(bookDir, 'book.json')), false, '删除后书目录应移走');

  const imported = await fetch(base + '/dsh-book-slides/import/package', {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'x-file-name': encodeURIComponent('practice-delete-import.zip') },
    body: zip,
  }).then((response) => response.json());
  assert.equal(imported.ok, true);
  assert.equal(imported.items[0].status, 'imported');

  const after = practice.readBank(BOOK_ID);
  assert.deepEqual(
    after.questions.map((item) => item.qid).sort(),
    beforeQids,
    '重新导入后题库必须原样回来',
  );
  const afterMastery = practice.readMastery(BOOK_ID);
  assert.deepEqual(Object.keys(afterMastery.items).sort(), Object.keys(beforeMastery.items).sort());

  const summary = await getJson('/dsh-book-slides/practice/summary?bookId=' + BOOK_ID);
  const active = before.questions.filter((item) => !item.flagged).length;
  assert.equal(summary.bank.total, active, '可练题数不含已标记的坏题');
  assert.ok(active > 0, '面板不能再显示每个模块练习为 0');
  assert.equal(after.questions.filter((item) => item.flagged).length, before.questions.filter((item) => item.flagged).length);
});

test('扩题：append 追加新题；重复题不新增也不报失败', async () => {
  const before = practice.readBank(BOOK_ID);
  const countBefore = before.questions.length;

  QUEUE = [[{ type: 'text-delta', text: JSON.stringify(APPENDED) }]];
  const started = await postJson('/dsh-book-slides/practice/generate', {
    bookId: BOOK_ID,
    chapters: [1],
    append: true,
  });
  assert.equal(started.ok, true);
  assert.notEqual(started.cached, true);
  let job = null;
  for (let i = 0; i < 60; i += 1) {
    job = await getJson('/dsh-book-slides/practice/job?jobId=' + started.jobId);
    if (job.status === 'ready' || job.status === 'failed') break;
    await sleep(100);
  }
  assert.equal(job.status, 'ready', job.error || '');
  assert.equal(job.append, true);
  assert.equal(job.added, 5);
  assert.equal(practice.readBank(BOOK_ID).questions.length, countBefore + 5);

  // 同一批再补一次：全部是重复题，应 ready + added=0，而不是 failed
  QUEUE = [
    [{ type: 'text-delta', text: JSON.stringify(APPENDED) }],
    [{ type: 'text-delta', text: JSON.stringify(APPENDED) }],
  ];
  const second = await postJson('/dsh-book-slides/practice/generate', {
    bookId: BOOK_ID,
    chapters: [1],
    append: true,
  });
  assert.equal(second.ok, true);
  let again = null;
  for (let i = 0; i < 60; i += 1) {
    again = await getJson('/dsh-book-slides/practice/job?jobId=' + second.jobId);
    if (again.status === 'ready' || again.status === 'failed') break;
    await sleep(100);
  }
  assert.equal(again.status, 'ready', again.error || '');
  assert.equal(again.added, 0);
  assert.equal(practice.readBank(BOOK_ID).questions.length, countBefore + 5);
  assert.ok((again.warnings || []).some((warning) => warning.includes('没有新题') || warning.includes('没有新增')));
});

after(() => new Promise((resolve) => server.close(resolve)));
