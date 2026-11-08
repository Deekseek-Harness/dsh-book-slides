/**
 * 2.0 M5 练习与复习（FR-19.1 / AC-110 / AC-119 / AC-134）。
 *
 * 真服务 + 假模型：题库作业、组卷、判题、讲解、补题、标记、场次续做。
 * 系列 7 章 2 讲，用来验证「不受最多 5 章限制」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-practice-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, writeChapters } = await import('../v2/books.js');
const { savePart } = await import('../v2/parts.js');
const { createSeries, findSeries, patchSeriesLecture, persistSeries } = await import('../v2/series.js');
const { writeLectureOutputs } = await import('../v2/lectures.js');
const { routeM1 } = await import('../v2/api.js');

const MARKERS = ['甲', '乙', '丙', '丁', '戊', '己', '庚'];
const STEMS = [
  '函数把每一个输入映射到唯一的输出',
  '极限描述输入靠近某点时输出的去向',
  '定义域决定这个映射允许的输入范围',
  '值域是全部可能输出组成的集合',
  '单调性描述函数值随输入变化的趋势',
];
const POINTS = ['函数定义', '映射关系', '输入输出', '值域范围', '单调变化'];

function makeBook() {
  const pages = MARKERS.map((mark, index) => ({
    page: index + 1,
    text: '第' + (index + 1) + '章 ' + mark + '章\n' + mark.repeat(4000),
  }));
  const chapters = MARKERS.map((mark, index) => ({
    n: index + 1,
    title: '第' + (index + 1) + '章 ' + mark + '章',
    from: index + 1,
    to: index + 1,
    chars: 4000,
    front: false,
  }));
  const book = createBook({
    buffer: Buffer.from('v2-practice-' + Date.now()),
    fileName: 'practice.pdf',
    title: '练习测试书',
    author: '',
    pages: pages.length,
    rawPages: pages,
  });
  writeChapters(book.id, chapters, 'manual');
  return { book, pages, chapters };
}

function makeSeries(book, chapters) {
  const part = savePart({ bookId: book.id, chapters: chapters.map((chapter) => chapter.n), title: '函数七章' });
  const series = createSeries({
    bookId: book.id,
    partId: part.id,
    title: '函数七章',
    plan: {
      throughline: '把函数当机器，再看它靠近某点时输出去哪。',
      lectures: [
        { n: 1, chapters: [1, 2, 3, 4], title: '第 1 讲 · 机器', goal: 'g1', pages: 6, chars: 16000 },
        { n: 2, chapters: [5, 6, 7], title: '第 2 讲 · 靠近', goal: 'g2', pages: 6, chars: 12000 },
      ],
      seams: [{ from: 1, to: 2, concept: '极限', sentence: '上一讲把函数当机器，这一讲看靠近。' }],
      terms: [],
      cut_notes: [],
      source: 'model',
      stitched: true,
      totalChars: 28000,
      totalPages: 12,
      estMinutes: 12,
    },
  });
  const found = findSeries(series.id);
  for (const lecture of found.series.lectures) {
    const slides = Array.from({ length: 6 }, (_, index) => ({
      slide_index: index + 1,
      layout: index === 0 ? 'cover' : 'content_text',
      title: '第 ' + lecture.n + ' 讲 · 第 ' + (index + 1) + ' 页',
      bullet_points: ['第 ' + lecture.n + ' 讲要点' + index, '函数与极限的关系'],
      quote_text: '',
      quote_source: '',
      audio_script: '朗读稿'.repeat(10),
      source_quote: MARKERS[Number(lecture.chapters[0]) - 1].repeat(24),
      source_pages: { from: Number(lecture.chapters[0]), to: Number(lecture.chapters[0]) },
      audio_file: null,
      audio_provider: 'none',
      audio_ms: 0,
      image_prompt: '一本摊开的数学书',
      image_file: null,
      image_status: 'none',
    }));
    writeLectureOutputs(
      found.dir,
      lecture.n,
      { schema: 1, series_id: series.id, n: lecture.n, title: lecture.title, chapters: lecture.chapters, pages: 6, chars: 4000, status: 'ready', voice_status: 'none' },
      { schema_version: 1, series_id: series.id, lecture: lecture.n, slides },
    );
    patchSeriesLecture(found.series, lecture.n, { status: 'ready', pages: 6, chars: 4000 });
  }
  found.series.status = 'ready';
  persistSeries(found.series);
  return found.series;
}

const modelCalls = { bank: 0, explain: 0, delay: 0 };

const ctx = {
  get(name) {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-quiz' }) };
    if (name !== 'llm') return null;
    return {
      async prepareCall() {
        return {
          config: {},
          async *stream(config) {
            const user = String(config.messages[0].content[0].text || '');
            if (modelCalls.delay) await new Promise((resolve) => setTimeout(resolve, modelCalls.delay));
            if (user.includes('【题】')) {
              modelCalls.explain += 1;
              yield { type: 'text-delta', text: '正确项 A 的依据在原文里；B、C、D 与原文不符。' };
              yield { type: 'finish', reason: { kind: 'stop' } };
              return;
            }
            modelCalls.bank += 1;
            const match = /【章】第 (\d+) 章/.exec(user);
            const n = match ? Number(match[1]) : 1;
            const mark = MARKERS[n - 1];
            yield {
              type: 'text-delta',
              text: JSON.stringify({
                questions: STEMS.map((stem, index) => ({
                  type: 'single',
                  difficulty: index < 2 ? 1 : 2,
                  point: POINTS[index],
                  stem: '第' + n + '章 ' + POINTS[index] + '：' + mark.repeat(8) + '的理解',
                  options: [
                    { key: 'A', text: '正确选项' },
                    { key: 'B', text: '错误选项一' },
                    { key: 'C', text: '错误选项二' },
                    { key: 'D', text: '错误选项三' },
                  ],
                  answer: ['A'],
                  source_quote: mark.repeat(24),
                })),
              }),
            };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      },
    };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const handled = await routeM1(req, res, url, { ctx });
  if (!handled) {
    res.statusCode = 404;
    res.end('no route');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port;

async function json(url, options) {
  const res = await fetch(baseUrl + url, options);
  return JSON.parse(await res.text());
}

function post(url, body) {
  return json(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

async function waitJob(jobId, predicate, timeout = 8000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await json('/dsh-book-slides/practice/job?jobId=' + encodeURIComponent(jobId));
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待题库作业超时：' + JSON.stringify(last));
}

const { book, chapters } = makeBook();
const series = makeSeries(book, chapters);

test('AC-110：7 章系列准备题库，覆盖全部章，不受 5 章限制', async () => {
  const started = await post('/dsh-book-slides/practice/bank', { seriesId: series.id });
  assert.equal(started.ok, true);
  assert.ok(started.jobId);
  const done = await waitJob(started.jobId, (job) => job.status === 'ready' || job.status === 'failed');
  assert.equal(done.status, 'ready');
  assert.equal(done.chapters.length, 7);
  assert.equal(done.added, 35);

  const summary = await json('/dsh-book-slides/practice/summary?seriesId=' + series.id);
  assert.equal(summary.ok, true);
  assert.equal(summary.counts.chapters, 7);
  assert.equal(summary.counts.covered, 7);
  assert.equal(summary.counts.questions, 35);
  assert.equal(summary.chapters.filter((chapter) => chapter.count >= 4).length, 7);
  assert.ok(summary.topup);
  assert.equal(typeof summary.topup.rounds, 'number');

  // 二次准备命中章缓存，不调模型
  const before = modelCalls.bank;
  const cached = await post('/dsh-book-slides/practice/bank', { seriesId: series.id });
  assert.equal(cached.ok, true);
  assert.equal(cached.cached, true);
  assert.equal(modelCalls.bank, before);

  // 组卷覆盖 7 章（章数 ≤ 题数时每章 ≥1），且场次落盘带 series_id
  const opened = await post('/dsh-book-slides/practice/session', { seriesId: series.id, mode: 'mixed', count: 10 });
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.session.chapters, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(new Set(opened.questions.map((question) => Number(question.chapter))).size, 7, '组卷必须覆盖 7 章');
  const sessionFile = path.join(ROOT, 'books', book.id, 'practice', 'sessions', opened.sessionId + '.json');
  const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.equal(saved.series_id, series.id);
  const closed = await post('/dsh-book-slides/practice/finish', { seriesId: series.id, sessionId: opened.sessionId });
  assert.equal(closed.ok, true);
});

test('AC-119：组卷、判题、幂等、讲解、结束与续做', async () => {
  const opened = await post('/dsh-book-slides/practice/session', { seriesId: series.id, mode: 'mixed', count: 8 });
  assert.equal(opened.ok, true);
  assert.ok(opened.sessionId);
  assert.ok(opened.questions.length >= 1 && opened.questions.length <= 8);
  assert.equal(opened.session.series_id, series.id);
  assert.equal(opened.session.book_id, book.id);

  // 同系列再开一次复用未完成场次
  const again = await post('/dsh-book-slides/practice/session', { seriesId: series.id, mode: 'mixed', count: 8 });
  assert.equal(again.sessionId, opened.sessionId);
  assert.equal(again.reused, true);

  // GET 恢复未完成场次（AC-134）
  const resumed = await json('/dsh-book-slides/practice/session?seriesId=' + series.id);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.sessionId, opened.sessionId);
  assert.ok(resumed.next);

  const first = opened.questions[0];
  assert.equal(first.answer, undefined, '组卷返回的题目不得泄露答案');
  const answered = await post('/dsh-book-slides/practice/answer', {
    seriesId: series.id,
    sessionId: opened.sessionId,
    qid: first.qid,
    picked: ['A'],
  });
  assert.equal(answered.ok, true);
  assert.equal(answered.correct, true);
  assert.deepEqual(answered.answer, ['A']);
  assert.ok(answered.source_quote.length >= 10);

  // 同 qid 重复提交幂等
  const duplicate = await post('/dsh-book-slides/practice/answer', {
    seriesId: series.id,
    sessionId: opened.sessionId,
    qid: first.qid,
    picked: ['B'],
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.correct, true);

  // 答错一题：进错题本，判题不自动讲解
  const second = opened.questions[1];
  const wrong = await post('/dsh-book-slides/practice/answer', {
    seriesId: series.id,
    sessionId: opened.sessionId,
    qid: second.qid,
    picked: ['B'],
  });
  assert.equal(wrong.correct, false);
  assert.equal(wrong.explanation, undefined);

  const explained = await post('/dsh-book-slides/practice/explain', { seriesId: series.id, qid: second.qid, picked: ['B'] });
  assert.equal(explained.ok, true);
  assert.ok(explained.explanation.includes('原文'));
  const cachedExplain = await post('/dsh-book-slides/practice/explain', { seriesId: series.id, qid: second.qid, picked: ['B'] });
  assert.equal(cachedExplain.cached, true);

  const summary = await json('/dsh-book-slides/practice/summary?seriesId=' + series.id);
  assert.ok(summary.counts.wrong >= 1);
  assert.equal(summary.session.status, 'running');

  const finished = await post('/dsh-book-slides/practice/finish', { seriesId: series.id, sessionId: opened.sessionId });
  assert.equal(finished.ok, true);
  assert.equal(finished.summary.answered, 2);
  assert.equal(finished.summary.correct, 1);
  assert.equal(finished.summary.accuracy, 0.5, '正确率分母 = 已答数');
  const noSession = await json('/dsh-book-slides/practice/session?seriesId=' + series.id);
  assert.equal(noSession.ok, false);
  assert.equal(noSession.code, 'E_NO_SESSION');
});

test('AC-119：标记题不再组卷；补题受 30 题/轮上限约束；错题复习', async () => {
  const session = await post('/dsh-book-slides/practice/session', { seriesId: series.id, mode: 'mixed', count: 8 });
  assert.equal(session.ok, true);
  const flagged = await post('/dsh-book-slides/practice/flag', { seriesId: series.id, qid: session.questions[0].qid });
  assert.equal(flagged.ok, true);
  assert.equal(flagged.flagged, true);
  await post('/dsh-book-slides/practice/finish', { seriesId: series.id, sessionId: session.sessionId });

  const topup = await post('/dsh-book-slides/practice/bank', { seriesId: series.id, topup: true, rounds: 1 });
  assert.equal(topup.ok, true);
  const done = await waitJob(topup.jobId, (job) => job.status === 'ready' || job.status === 'failed');
  assert.equal(done.status, 'ready');
  assert.ok(done.added <= 30);

  const review = await post('/dsh-book-slides/practice/review', { seriesId: series.id });
  assert.equal(review.ok, true);
  assert.ok(Array.isArray(review.questions));
});

test('AC-119：Leitner 到期优先与盒子升级（注入 mastery.json）', async () => {
  const practiceDir = path.join(ROOT, 'books', book.id, 'practice');
  const masteryPath = path.join(practiceDir, 'mastery.json');
  const original = fs.existsSync(masteryPath) ? fs.readFileSync(masteryPath, 'utf8') : null;
  const bank = JSON.parse(fs.readFileSync(path.join(practiceDir, 'questions.json'), 'utf8'));
  const byQid = new Map(bank.questions.map((question) => [question.qid, question]));
  const readItems = () => JSON.parse(fs.readFileSync(masteryPath, 'utf8')).items;
  const writeItems = (items) => fs.writeFileSync(masteryPath, JSON.stringify({ schema_version: 1, updated_at: new Date().toISOString(), items }, null, 2));
  try {
    // 结束上一场（review 留下的 running 场次），否则开场会复用
    const running = await json('/dsh-book-slides/practice/session?seriesId=' + series.id);
    if (running && running.ok && running.sessionId) {
      await post('/dsh-book-slides/practice/finish', { seriesId: series.id, sessionId: running.sessionId });
    }

    const dueQids = [1, 2, 3].map((n) => bank.questions.find((question) => Number(question.chapter) === n && question.flagged !== true).qid);
    const items = {};
    for (const qid of dueQids) items[qid] = { attempts: 2, correct: 2, last: 'correct', box: 3, due_at: '2020-01-01T00:00:00.000Z' };
    writeItems(items);

    const first = await post('/dsh-book-slides/practice/session', { seriesId: series.id, mode: 'mixed', count: 10 });
    assert.equal(first.ok, true);
    const dueCount = first.session.plan.filter((item) => item.source === 'due').length;
    assert.ok(dueCount >= 1, '到期题不能被新题完全挤出去');
    assert.ok(dueCount <= 4, 'due 配额 ≤ 40%');
    await post('/dsh-book-slides/practice/finish', { seriesId: series.id, sessionId: first.sessionId });

    // review 只取到期/错题，且注入的到期题全部出现
    const review = await post('/dsh-book-slides/practice/review', { seriesId: series.id });
    assert.equal(review.ok, true);
    assert.ok(review.session.plan.every((item) => item.source === 'due' || item.source === 'weak'), 'review 只取 due/weak');
    assert.ok(dueQids.every((qid) => review.session.plan.some((item) => item.qid === qid)), 'review 必须取到全部到期题');
    await post('/dsh-book-slides/practice/finish', { seriesId: series.id, sessionId: review.sessionId });

    // 新场次做盒子升级（到期题仍在，逐题覆盖初值）
    const opened = await post('/dsh-book-slides/practice/session', { seriesId: series.id, mode: 'mixed', count: 10 });
    const plan = opened.session.plan;

    const answer = (qid, correct) => {
      const question = byQid.get(qid);
      const picked = correct
        ? question.answer.map((value) => String(value))
        : question.options.map((option) => String(option.key)).filter((key) => !question.answer.map(String).includes(key));
      return post('/dsh-book-slides/practice/answer', { seriesId: series.id, sessionId: opened.sessionId, qid, picked });
    };

    // box 2 → 3，间隔 7 天
    const up3 = plan[0].qid;
    writeItems(Object.assign({}, readItems(), { [up3]: { attempts: 2, correct: 2, last: 'correct', box: 2, due_at: '2020-01-01T00:00:00.000Z' } }));
    assert.equal((await answer(up3, true)).correct, true);
    const state3 = readItems()[up3];
    assert.equal(state3.box, 3);
    assert.equal(state3.last, 'correct');
    assert.ok(Math.abs((Date.parse(state3.due_at) - Date.parse(state3.last_at)) / 86400000 - 7) < 0.01, 'box=3 → 7 天');

    // 幂等提交不重复升级
    const duplicate = await answer(up3, true);
    assert.equal(duplicate.duplicate, true);
    const state3b = readItems()[up3];
    assert.equal(state3b.attempts, state3.attempts, '幂等提交不再累计 attempts');
    assert.equal(state3b.box, 3);

    // box 0 → 1，间隔 1 天
    const up1 = plan[1].qid;
    writeItems(Object.assign({}, readItems(), { [up1]: { attempts: 0, correct: 0, last: 'correct', box: 0, due_at: '2020-01-01T00:00:00.000Z' } }));
    assert.equal((await answer(up1, true)).correct, true);
    const state1 = readItems()[up1];
    assert.equal(state1.box, 1);
    assert.ok(Math.abs((Date.parse(state1.due_at) - Date.parse(state1.last_at)) / 86400000 - 1) < 0.01, 'box=1 → 1 天');

    // 答错回盒 0，且判题不返回 explanation
    const down = plan[2].qid;
    writeItems(Object.assign({}, readItems(), { [down]: { attempts: 2, correct: 2, last: 'correct', box: 3, due_at: '2020-01-01T00:00:00.000Z' } }));
    const wrong = await answer(down, false);
    assert.equal(wrong.correct, false);
    assert.equal(wrong.explanation, undefined, '判题不生成讲解');
    const state0 = readItems()[down];
    assert.equal(state0.box, 0);
    assert.equal(state0.last, 'wrong');

    const finished = await post('/dsh-book-slides/practice/finish', { seriesId: series.id, sessionId: opened.sessionId });
    assert.equal(finished.summary.answered, 3);
    assert.equal(finished.summary.correct, 2);
    assert.ok(Math.abs(finished.summary.accuracy - 2 / 3) < 1e-9, '正确率分母 = 已答数');
  } finally {
    if (original == null) fs.rmSync(masteryPath, { force: true });
    else fs.writeFileSync(masteryPath, original);
  }
});

test('题库不足时开场给 E_BANK_INSUFFICIENT，不调模型', async () => {
  const empty = makeBook();
  const part = savePart({ bookId: empty.book.id, chapters: [1], title: '空题库' });
  const emptySeries = createSeries({
    bookId: empty.book.id,
    partId: part.id,
    title: '空题库',
    plan: {
      throughline: '空',
      lectures: [{ n: 1, chapters: [1], title: '第 1 讲', goal: '', pages: 6, chars: 4000 }],
      seams: [],
      terms: [],
      cut_notes: [],
      source: 'rule',
      stitched: true,
      totalChars: 4000,
      totalPages: 6,
      estMinutes: 6,
    },
  });
  const before = modelCalls.bank;
  const out = await post('/dsh-book-slides/practice/session', { seriesId: emptySeries.id, mode: 'mixed', count: 8 });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'E_BANK_INSUFFICIENT');
  assert.equal(modelCalls.bank, before);
});

test('P0：题库作业运行中 summary 带活动 job；结束后回到 null', async () => {
  const fresh = makeBook();
  const freshSeries = makeSeries(fresh.book, fresh.chapters);
  modelCalls.delay = 60;
  try {
    const started = await post('/dsh-book-slides/practice/bank', { seriesId: freshSeries.id });
    assert.equal(started.ok, true);
    assert.ok(started.jobId);
    const summary = await json('/dsh-book-slides/practice/summary?seriesId=' + encodeURIComponent(freshSeries.id));
    assert.equal(summary.ok, true);
    assert.ok(summary.job, '运行中应返回活动作业');
    assert.equal(summary.job.jobId, started.jobId);
    assert.ok(['queued', 'drafting', 'checking', 'anchoring', 'cancelling'].includes(String(summary.job.status)));
    await waitJob(started.jobId, (job) => ['ready', 'failed', 'cancelled'].includes(String(job.status)));
    const after = await json('/dsh-book-slides/practice/summary?seriesId=' + encodeURIComponent(freshSeries.id));
    assert.equal(after.job, null);
  } finally {
    modelCalls.delay = 0;
  }
});

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
