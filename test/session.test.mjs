/**
 * 练习纯函数测试 —— 组卷 / 判题 / 调度 / 校验 / 去重。
 *
 *   node test/session.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-session-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const practice = await import('../lib/practice.js');

const CHAPTER = { n: 3, from: 10, to: 20, title: '第三章 测试', chars: 500 };

function rawQuestion(overrides) {
  return Object.assign(
    {
      type: 'single',
      difficulty: 2,
      point: '考点甲',
      stem: '以下哪一项是测试题干？',
      options: [
        { key: 'A', text: '甲' },
        { key: 'B', text: '乙' },
        { key: 'C', text: '丙' },
        { key: 'D', text: '丁' },
      ],
      answer: ['B'],
      source_quote: '这是原文里的一段连续文字，用来做锚点。',
    },
    overrides || {},
  );
}

function makeQuestion(index, overrides) {
  const base = {
    qid: 'q' + String(index).padStart(6, '0'),
    chapter: 3,
    point: '考点' + (index % 4),
    type: 'single',
    difficulty: (index % 3) + 1,
    stem: '第 ' + index + ' 道题的题干内容',
    options: [
      { key: 'A', text: '甲' },
      { key: 'B', text: '乙' },
    ],
    answer: ['A'],
    flagged: false,
    explanation_status: 'none',
  };
  return Object.assign(base, overrides || {});
}

test('单题校验：单选/多选/判断与非法答案', () => {
  const single = practice.normalizeQuestion(rawQuestion(), CHAPTER);
  assert.equal(single.errors.length, 0);
  assert.equal(single.question.answer[0], 'B');
  assert.equal(single.question.chapter, 3);

  const multi = practice.normalizeQuestion(rawQuestion({ type: 'multi', answer: ['A', 'C'] }), CHAPTER);
  assert.equal(multi.errors.length, 0);

  const judge = practice.normalizeQuestion(rawQuestion({ type: 'judge', options: [], answer: ['错误'] }), CHAPTER);
  assert.equal(judge.errors.length, 0);
  assert.deepEqual(judge.question.options.map((option) => option.text), ['正确', '错误']);
  assert.equal(judge.question.answer[0], 'B');

  const bad = practice.normalizeQuestion(rawQuestion({ answer: ['Z'] }), CHAPTER);
  assert.equal(bad.question, null);
  assert.ok(bad.errors.some((error) => error.includes('答案')));
});

test('去重：题干精确与近似', () => {
  const first = practice.normalizeQuestion(rawQuestion(), CHAPTER).question;
  const exact = Object.assign({}, first, { qid: 'qexact000001' });
  assert.equal(practice.isDuplicate(exact, [first]), 'exact');

  const nearStem = '以下哪一项是测试题干呢？';
  const near = Object.assign({}, first, {
    qid: 'qnear0000001',
    stem: nearStem,
    dedupe_key: practice.stemKey(nearStem),
  });
  assert.equal(practice.isDuplicate(near, [first]), 'near');

  const different = practice.normalizeQuestion(rawQuestion({ stem: '完全不同的题干内容在这里' }), CHAPTER).question;
  assert.equal(practice.isDuplicate(different, [first]), '');
});

test('组卷：到期题 ≤ 40%，新题优先，同考点 ≤ 2，章覆盖', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const bank = { questions: [] };
  const mastery = { items: {} };
  // 10 道题库：前 5 道到期，后 5 道未答
  for (let i = 1; i <= 10; i += 1) {
    const question = makeQuestion(i, { chapter: i <= 5 ? 3 : 4 });
    bank.questions.push(question);
    if (i <= 5) {
      mastery.items[question.qid] = {
        attempts: 2,
        correct: 1,
        last: 'wrong',
        box: 0,
        due_at: '2026-11-01T00:00:00Z',
      };
    }
  }
  const plan = practice.composeSession({ bank, mastery, chapterNs: [3, 4], mode: 'mixed', count: 8, now });
  assert.equal(plan.length, 8);
  const dueCount = plan.filter((item) => item.source === 'due').length;
  assert.ok(dueCount <= 3, '8 题时到期题最多 3 题');
  assert.ok(plan.filter((item) => item.source === 'new').length >= 1);
  const counts = new Map();
  for (const item of plan) {
    const question = bank.questions.find((entry) => entry.qid === item.qid);
    const point = question.chapter + '|' + question.point;
    counts.set(point, (counts.get(point) || 0) + 1);
  }
  assert.equal(Array.from(counts.values()).every((value) => value <= 2), true);
  assert.equal(plan.some((item) => bank.questions.find((q) => q.qid === item.qid).chapter === 3), true);
  assert.equal(plan.some((item) => bank.questions.find((q) => q.qid === item.qid).chapter === 4), true);
});

test('组卷：review 只取到期与未掌握', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const bank = { questions: [makeQuestion(1), makeQuestion(2), makeQuestion(3)] };
  const mastery = {
    items: {
      q000001: { attempts: 1, box: 0, last: 'wrong', due_at: '2026-11-01T00:00:00Z' },
      q000002: { attempts: 3, box: 2, last: 'correct', due_at: '2026-12-01T00:00:00Z' },
    },
  };
  const plan = practice.composeSession({ bank, mastery, chapterNs: [3], mode: 'review', count: 8, now });
  assert.equal(plan.some((item) => item.qid === 'q000001'), true);
  assert.equal(plan.some((item) => item.qid === 'q000002'), false);
});

test('判题：单选比 key，多选全对才算对', () => {
  assert.equal(practice.judgePicked({ answer: ['B'] }, ['B']), true);
  assert.equal(practice.judgePicked({ answer: ['B'] }, ['A']), false);
  assert.equal(practice.judgePicked({ answer: ['A', 'C'] }, ['C', 'A']), true);
  assert.equal(practice.judgePicked({ answer: ['A', 'C'] }, ['A']), false);
});

test('Leitner：答错回盒 0 且立即到期；答对进盒；盒 4 后 60 天', () => {
  const wrong = practice.nextMastery({ attempts: 1, box: 3, correct: 2 }, false, '2026-11-04T00:00:00Z');
  assert.equal(wrong.box, 0);
  assert.equal(wrong.due_at, '2026-11-04T00:00:00.000Z');

  const firstCorrect = practice.nextMastery(null, true, '2026-11-04T00:00:00Z');
  assert.equal(firstCorrect.box, 1);
  assert.equal(firstCorrect.due_at, '2026-11-05T00:00:00.000Z');

  const master = practice.nextMastery({ attempts: 9, box: 4, correct: 9 }, true, '2026-11-04T00:00:00Z');
  assert.equal(master.box, 4);
  assert.equal(master.due_at, '2027-01-03T00:00:00.000Z');
});

test('场次：重复提交幂等，汇总分母是已答数', () => {
  const question = makeQuestion(1, { answer: ['A'] });
  const session = practice.createSession({
    bookId: 'b1testbook',
    chapterNs: [3],
    mode: 'mixed',
    count: 4,
    plan: [{ qid: question.qid, source: 'new' }],
    at: '2026-11-04T00:00:00Z',
  });
  const first = practice.appendAnswer(session, question, ['B'], 1000, '2026-11-04T00:01:00Z');
  assert.equal(first.answer.correct, false);
  const second = practice.appendAnswer(session, question, ['A'], 10, '2026-11-04T00:02:00Z');
  assert.equal(second.duplicate, true);
  assert.equal(session.answers.length, 1);

  practice.finishSession(session, '2026-11-04T00:03:00Z');
  assert.equal(session.status, 'finished');
  assert.equal(session.summary.answered, 1);
  assert.equal(session.summary.accuracy, 0);
});

test('讲解缓存键对选择顺序不敏感', () => {
  const a = practice.explainCacheKey('q000001', ['C', 'A'], 'deep');
  const b = practice.explainCacheKey('q000001', ['A', 'C'], 'deep');
  assert.equal(a, b);
  assert.notEqual(a, practice.explainCacheKey('q000001', ['A', 'C'], 'normal'));
});

test('组卷：混合新题过半；新题不足时收缩题量', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const bank = { questions: [] };
  const mastery = { items: {} };
  for (let i = 1; i <= 12; i += 1) bank.questions.push(makeQuestion(i));
  for (let i = 1; i <= 10; i += 1) {
    mastery.items['q' + String(i).padStart(6, '0')] = {
      attempts: 2,
      correct: 2,
      last: 'correct',
      box: 3,
      due_at: '2026-12-01T00:00:00Z',
    };
  }
  // 10 道已掌握旧题 + 2 道新题，N=8 → 只能开 3 题（2 新 +1 旧）
  const plan = practice.composeSession({ bank, mastery, chapterNs: [3], mode: 'mixed', count: 8, now });
  assert.equal(plan.length, 3);
  assert.equal(plan.filter((item) => item.source === 'new').length, 2);
  assert.equal(plan.filter((item) => item.source !== 'new').length, 1);

  // 0 新题：混合不再静默用旧题凑满
  const onlyOld = { questions: bank.questions.slice(0, 10) };
  const emptied = practice.composeSession({ bank: onlyOld, mastery, chapterNs: [3], mode: 'mixed', count: 8, now });
  assert.equal(emptied.length, 0);
});

test('补题计划：目标、轮数、上限与可行题量', () => {
  const newPlan = practice.planTopUp({ mode: 'new', count: 20, unseen: 0, chapters: 1, bankTotal: 0 });
  assert.equal(newPlan.targetNew, 20);
  assert.equal(newPlan.rounds, 4);
  assert.equal(newPlan.added, 20);
  assert.equal(newPlan.feasibleN, 20);

  const mixed = practice.planTopUp({ mode: 'mixed', count: 8, unseen: 0, chapters: 2, bankTotal: 0, oldAvailable: 0 });
  assert.equal(mixed.targetNew, 8, '旧题也不够时用新题补满 count');
  assert.equal(mixed.perRound, 10);
  assert.equal(mixed.rounds, 1);
  assert.equal(mixed.feasibleN, 8);

  const mixedEnoughOld = practice.planTopUp({ mode: 'mixed', count: 8, unseen: 5, chapters: 1, bankTotal: 20, oldAvailable: 10 });
  assert.equal(mixedEnoughOld.targetNew, 5);
  assert.equal(mixedEnoughOld.rounds, 0);
  assert.equal(mixedEnoughOld.feasibleN, 8);

  const mixedNoOld = practice.planTopUp({ mode: 'mixed', count: 8, unseen: 5, chapters: 1, bankTotal: 10, oldAvailable: 0 });
  assert.equal(mixedNoOld.targetNew, 8);
  assert.equal(mixedNoOld.rounds, 1);
  assert.equal(mixedNoOld.feasibleN, 8);

  const capped = practice.planTopUp({ mode: 'mixed', count: 8, unseen: 0, chapters: 1, bankTotal: 300 });
  assert.equal(capped.rounds, 0);
  assert.equal(capped.blocked, true);

  const review = practice.planTopUp({ mode: 'review', count: 8, unseen: 0, chapters: 1, bankTotal: 10 });
  assert.equal(review.rounds, 0);
  assert.equal(review.added, 0);
});
