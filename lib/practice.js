/**
 * 精讲台 · 练习与复习（v1.6 / FR-11 / 附录 P）
 *
 * 一次生成 = 按章出题（异步作业），之后每场练习只读题库：
 *   drafting → checking → anchoring → ready / failed / cancelled
 *
 * 这里只做练习这一层：
 *   - 题库落盘（questions.json）、掌握度（mastery.json）、场次（sessions/）
 *   - 组卷、宿主判题、Leitner 调度
 *   - 讲解按需生成并沉淀（不预生成，D54）
 *
 * 纯函数（校验 / 去重 / 组卷 / 判题 / 调度）全部 export，供 test/practice.test.mjs 直接测。
 */
import fs from 'node:fs';
import path from 'node:path';
import { existingBookDir, isValidId, newId, readJson, sha256Of, writeJson } from './fs.js';
import { anchorSlides, normalizeForMatch } from './slides.js';

export const PRACTICE_PROMPT_VERSION = 'quiz-v1';
export const PRACTICE_BLUEPRINT_VERSION = 1;

/** 题库规模与场次规模（FR-11 / P.8）。 */
export const MIN_Q_PER_CHAPTER = 4;
export const MAX_Q_PER_CHAPTER = 6;
export const MAX_Q_PER_BOOK = 300;
export const SESSION_DEFAULT_COUNT = 8;
export const SESSION_MAX_COUNT = 20;
export const SESSION_MODES = ['mixed', 'new', 'review'];
/** 到期题占比上限：8 题时最多 3 题（向下取整）。 */
export const DUE_RATIO = 0.4;
/** 同一考点最多几题。 */
export const POINT_CAP = 2;

export const QUESTION_TYPES = ['single', 'multi', 'judge'];

/** Leitner 间隔（天）；盒 4 再答对时用 60 天。 */
export const LEITNER_DAYS = [0, 1, 3, 7, 21];
export const LEITNER_MASTER_DAYS = 60;

export class PracticeError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'PracticeError';
    this.code = code;
    this.hint = hint || '';
  }
}

/* ------------------------------ 路径 ------------------------------ */

export function practiceDir(bookId) {
  const dir = existingBookDir(bookId);
  return dir ? path.join(dir, 'practice') : null;
}

export function bankFile(bookId) {
  const dir = practiceDir(bookId);
  return dir ? path.join(dir, 'questions.json') : null;
}

export function masteryFile(bookId) {
  const dir = practiceDir(bookId);
  return dir ? path.join(dir, 'mastery.json') : null;
}

export function sessionsDir(bookId) {
  const dir = practiceDir(bookId);
  return dir ? path.join(dir, 'sessions') : null;
}

export function sessionFile(bookId, sessionId) {
  if (!isValidId(sessionId)) return null;
  const dir = sessionsDir(bookId);
  return dir ? path.join(dir, sessionId + '.json') : null;
}

export function explainCacheFile(bookId, key) {
  const dir = practiceDir(bookId);
  return dir ? path.join(dir, 'explain-cache', key + '.json') : null;
}

/* ------------------------------ 题库与掌握度 ------------------------------ */

export function emptyBank(bookId) {
  return {
    schema_version: 1,
    book_id: bookId,
    prompt_version: PRACTICE_PROMPT_VERSION,
    blueprint_version: PRACTICE_BLUEPRINT_VERSION,
    chapters: {},
    questions: [],
  };
}

export function readBank(bookId) {
  const file = bankFile(bookId);
  if (!file) return emptyBank(bookId);
  const data = readJson(file, null);
  if (!data || typeof data !== 'object' || !Array.isArray(data.questions)) return emptyBank(bookId);
  return {
    schema_version: 1,
    book_id: bookId,
    prompt_version: String(data.prompt_version || PRACTICE_PROMPT_VERSION),
    blueprint_version: Number(data.blueprint_version) || PRACTICE_BLUEPRINT_VERSION,
    chapters: data.chapters && typeof data.chapters === 'object' ? data.chapters : {},
    questions: data.questions.filter((q) => q && typeof q === 'object' && q.qid),
  };
}

export function writeBank(bookId, bank) {
  const file = bankFile(bookId);
  if (!file) throw new PracticeError('E_NOT_FOUND', '找不到这本书');
  writeJson(file, bank);
}

export function readMastery(bookId) {
  const file = masteryFile(bookId);
  const data = file ? readJson(file, null) : null;
  if (!data || typeof data !== 'object' || !data.items) return { schema_version: 1, updated_at: '', items: {} };
  return {
    schema_version: 1,
    updated_at: String(data.updated_at || ''),
    items: data.items && typeof data.items === 'object' ? data.items : {},
  };
}

export function writeMastery(bookId, mastery) {
  const file = masteryFile(bookId);
  if (!file) throw new PracticeError('E_NOT_FOUND', '找不到这本书');
  mastery.updated_at = new Date().toISOString();
  writeJson(file, mastery);
}

export function readSession(bookId, sessionId) {
  const file = sessionFile(bookId, sessionId);
  if (!file) return null;
  const data = readJson(file, null);
  if (!data || typeof data !== 'object' || !Array.isArray(data.plan)) return null;
  return data;
}

export function writeSession(bookId, session) {
  const file = sessionFile(bookId, session && session.session_id);
  if (!file) throw new PracticeError('E_QZ_SESSION', '场次号不合法');
  writeJson(file, session);
}

/** 最近一场未结束的场次（断点续练，AC-81）。 */
export function latestRunningSession(bookId) {
  const dir = sessionsDir(bookId);
  if (!dir) return null;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best = null;
  for (const name of names) {
    if (!/^[a-z0-9]{8,16}\.json$/.test(name)) continue;
    const session = readJson(path.join(dir, name), null);
    if (!session || session.status !== 'running') continue;
    if (!best || String(session.created_at || '').localeCompare(String(best.created_at || '')) > 0) best = session;
  }
  return best;
}

/* ------------------------------ 纯函数：校验 ------------------------------ */

function textOf(value) {
  return String(value == null ? '' : value).trim();
}

function stripNumbering(stem) {
  return textOf(stem).replace(/^\s*(?:\d+[.、)]|[（(]\d+[）)]|第[一二三四五六七八九十\d]+题[:：]?)\s*/, '');
}

/** 选项归一：接受字符串或 {key,text}；键统一大写。 */
export function normalizeOptions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const text = textOf(item && typeof item === 'object' ? item.text : item);
    if (!text) continue;
    let key = textOf(item && typeof item === 'object' ? item.key : '').toUpperCase();
    if (!/^[A-Z]$/.test(key)) key = String.fromCharCode(65 + i);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key: key, text: text });
    if (out.length >= 6) break;
  }
  return out;
}

/** 答案归一：数组 / "A,C" / "AC" / 布尔 / 数字序号。 */
export function normalizeAnswer(raw, options) {
  const keys = options.map((option) => option.key);
  let values = [];
  if (Array.isArray(raw)) values = raw.map(textOf);
  else if (typeof raw === 'boolean') return [raw ? 'A' : 'B'];
  else {
    const text = textOf(raw);
    if (!text) return [];
    if (/^(true|对|正确|是)$/i.test(text)) values = ['A'];
    else if (/^(false|错|错误|否)$/i.test(text)) values = ['B'];
    else if (/^[A-Za-z](?:\s*[,，、/]\s*[A-Za-z])*$/.test(text)) values = text.toUpperCase().split(/[,，、/]/);
    else if (/^[A-Za-z]{2,4}$/.test(text)) values = text.toUpperCase().split('');
    else values = [text];
  }
  const aliases = { 对: 'A', 正确: 'A', 是: 'A', 真: 'A', 错: 'B', 错误: 'B', 否: 'B', 假: 'B' };
  const upper = Array.from(
    new Set(
      values
        .map((value) => {
          const text = textOf(value).toUpperCase();
          return aliases[text] || text;
        })
        .filter((value) => keys.includes(value)),
    ),
  );
  return upper.sort();
}

/**
 * 单题校验与归一。不合格返回 {question:null, errors:[...]}，
 * 校验只看结构，来源锚点留给 anchorQuestions。
 */
export function normalizeQuestion(raw, chapter) {
  const errors = [];
  const input = raw && typeof raw === 'object' ? raw : {};
  const type = textOf(input.type).toLowerCase();
  if (!QUESTION_TYPES.includes(type)) errors.push('type 必须是 single / multi / judge');

  let options = normalizeOptions(input.options);
  if (type === 'judge') options = [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }];

  const stem = stripNumbering(input.stem);
  if (stem.length < 5 || stem.length > 120) errors.push('题干需 5–120 字');

  const point = textOf(input.point);
  if (!point || point.length > 16) errors.push('考点需 1–16 字');

  const answer = normalizeAnswer(input.answer, options);
  if (!answer.length) errors.push('答案不在选项里');
  if (type === 'single' && answer.length !== 1) errors.push('单选只能有 1 个正确项');
  if (type === 'multi' && (answer.length < 2 || answer.length > 4)) errors.push('多选需 2–4 个正确项');
  if (type === 'judge' && answer.length !== 1) errors.push('判断只能有 1 个答案');
  if (options.length < 2 || options.length > 6) errors.push('选项需 2–6 个');
  if (options.some((option) => option.text.length > 60)) errors.push('单个选项需 ≤60 字');

  const sourceQuote = textOf(input.source_quote);
  if (sourceQuote.length < 10 || sourceQuote.length > 200) errors.push('原文片段需 10–200 字');

  const difficulty = Math.round(Number(input.difficulty) || 2);
  if (![1, 2, 3].includes(difficulty)) errors.push('难度需 1–3');

  if (errors.length) return { question: null, errors: errors };
  return {
    errors: [],
    question: {
      chapter: Number(chapter.n),
      point: point,
      slide_index: null,
      module_id: null,
      type: type,
      difficulty: difficulty,
      stem: stem,
      options: options,
      answer: answer,
      source_quote: sourceQuote,
      source_pages: { from: Number(chapter.from) || 1, to: Number(chapter.to) || Number(chapter.from) || 1 },
      source_anchor: null,
      anchor_status: 'unanchored',
      dedupe_key: stemKey(stem),
      created_at: new Date().toISOString(),
      flagged: false,
      explanation: null,
      explanation_status: 'none',
      explanation_at: null,
      explanation_model: null,
    },
  };
}

/* ------------------------------ 纯函数：去重 ------------------------------ */

export function stemKey(stem) {
  return sha256Of(Buffer.from(normalizeForMatch(stem), 'utf8'));
}

function bigrams(norm) {
  const out = new Set();
  const text = String(norm || '');
  if (text.length < 2) {
    if (text) out.add(text);
    return out;
  }
  for (let i = 0; i < text.length - 1; i += 1) out.add(text.slice(i, i + 2));
  return out;
}

export function jaccard(a, b) {
  const left = a instanceof Set ? a : bigrams(a);
  const right = b instanceof Set ? b : bigrams(b);
  if (!left.size && !right.size) return 1;
  let inter = 0;
  for (const item of left) if (right.has(item)) inter += 1;
  return inter / (left.size + right.size - inter);
}

/** 与库内题是否重复：同书精确 + 同书近似（P.3）。 */
export function isDuplicate(candidate, existing) {
  const key = candidate.dedupe_key || stemKey(candidate.stem);
  const norm = normalizeForMatch(candidate.stem);
  for (const item of Array.isArray(existing) ? existing : []) {
    if (!item || item.qid === candidate.qid) continue;
    if ((item.dedupe_key || stemKey(item.stem)) === key) return 'exact';
    if (jaccard(norm, normalizeForMatch(item.stem)) >= 0.8) return 'near';
  }
  return '';
}

/** qid 由内容派生：同书同章同题干 → 同一个 qid，掌握度不丢（P.2）。 */
export function questionId(bookId, chapterN, dedupeKey) {
  return 'q' + sha256Of(Buffer.from([bookId, String(chapterN), dedupeKey].join('|'), 'utf8')).slice(0, 11);
}

/* ------------------------------ 纯函数：锚点 ------------------------------ */

/**
 * 回填原文锚点。与精讲共用 anchorSlides：命中写 {page, para_index}，
 * 未命中保持 unanchored（是否丢弃由调用方决定）。
 */
export function anchorQuestions(questions, pages, chapter) {
  const list = Array.isArray(questions) ? questions : [];
  const result = anchorSlides(
    list.map((question) => ({ source_quote: question.source_quote, source_pages: question.source_pages })),
    pages,
    { minPage: Number(chapter.from) || 1, maxPage: Number(chapter.to) || Number(chapter.from) || 1 },
  );
  return list.map((question, index) => {
    const anchored = result.slides[index] || {};
    return Object.assign({}, question, {
      source_pages: anchored.source_pages || question.source_pages,
      source_anchor: anchored.source_anchor || null,
      anchor_status: anchored.anchor_status === 'anchored' ? 'anchored' : 'unanchored',
    });
  });
}

/* ------------------------------ 纯函数：组卷 ------------------------------ */

export function clampCount(value) {
  const n = Math.round(Number(value) || SESSION_DEFAULT_COUNT);
  return Math.max(1, Math.min(SESSION_MAX_COUNT, n));
}

function masteryOf(mastery, qid) {
  const items = mastery && mastery.items ? mastery.items : {};
  return items[qid] || null;
}

function dueAt(mastery, qid) {
  const state = masteryOf(mastery, qid);
  return state && state.due_at ? String(state.due_at) : '';
}

/**
 * 组卷（P.4）：`new` 全取未答；`mixed` 到期 ≤40% 且新题 >50%；`review` 只取到期/错题。
 * 新题不足时按可行题量收缩（new: N=unseen；mixed: N=2*unseen−1），0 题返回 []。
 */
export function composeSession({ bank, mastery, chapterNs, mode, count, now }) {
  const requested = clampCount(count);
  const modeValue = SESSION_MODES.includes(mode) ? mode : 'mixed';
  const ns = Array.from(new Set((Array.isArray(chapterNs) ? chapterNs : []).map(Number).filter((n) => n > 0))).sort((a, b) => a - b);
  const at = now ? new Date(now) : new Date();
  const nowMs = at.getTime();
  const pool = (bank && Array.isArray(bank.questions) ? bank.questions : []).filter(
    (question) => question && !question.flagged && ns.includes(Number(question.chapter)),
  );

  const stateOf = (question) => masteryOf(mastery, question.qid);
  const isDue = (question) => {
    const due = dueAt(mastery, question.qid);
    return due ? new Date(due).getTime() <= nowMs : false;
  };
  const isUnseen = (question) => {
    const state = stateOf(question);
    return !state || Number(state.attempts) === 0;
  };

  const due = pool.filter(isDue).sort((a, b) => String(dueAt(mastery, a.qid)).localeCompare(String(dueAt(mastery, b.qid))));
  const unseen = pool.filter(isUnseen).sort((a, b) => (Number(a.difficulty) || 2) - (Number(b.difficulty) || 2) || String(a.qid).localeCompare(String(b.qid)));
  const weak = pool.filter((question) => {
    const state = stateOf(question);
    return state && Number(state.attempts) > 0 && Number(state.box) <= 1 && !isDue(question);
  });
  const solid = pool.filter((question) => !due.includes(question) && !unseen.includes(question) && !weak.includes(question));

  let N = requested;
  let targetNew = 0;
  if (modeValue === 'new') {
    N = Math.min(N, unseen.length);
  } else if (modeValue === 'mixed') {
    targetNew = Math.floor(N / 2) + 1;
    if (unseen.length < targetNew) {
      N = Math.min(N, 2 * unseen.length - 1);
      if (N >= 1) targetNew = Math.floor(N / 2) + 1;
    }
  }
  if (N < 1) return [];

  const picked = [];
  const pointCount = new Map();
  const pickedIds = new Set();
  const pointOf = (question) => String(question.chapter) + '|' + String(question.point || '');
  const add = (question, source) => {
    if (picked.length >= N || !question || pickedIds.has(question.qid)) return false;
    const point = pointOf(question);
    if ((pointCount.get(point) || 0) >= POINT_CAP) return false;
    pointCount.set(point, (pointCount.get(point) || 0) + 1);
    pickedIds.add(question.qid);
    picked.push({ qid: question.qid, source: source });
    return true;
  };

  if (modeValue === 'review') {
    for (const question of due) add(question, 'due');
    for (const question of weak) add(question, 'weak');
  } else if (modeValue === 'new') {
    for (const question of unseen) add(question, 'new');
  } else {
    const oldSlots = N - targetNew;
    const dueTake = Math.min(due.length, Math.floor(N * DUE_RATIO), oldSlots);
    for (const question of due.slice(0, dueTake)) add(question, 'due');
    for (const question of unseen) add(question, 'new');
    for (const question of weak) add(question, 'weak');
    for (const question of solid.slice().sort((a, b) => (Number((stateOf(a) || {}).box) || 0) - (Number((stateOf(b) || {}).box) || 0))) {
      add(question, 'solid');
    }
  }

  // 章覆盖：章数 ≤ 题数时，每章至少 1 题；从题最多的章挪一题给缺的章
  if (ns.length <= N) {
    for (const n of ns) {
      if (picked.some((item) => Number((pool.find((q) => q.qid === item.qid) || {}).chapter) === n)) continue;
      const candidate = pool.find((question) => Number(question.chapter) === n && !pickedIds.has(question.qid));
      if (!candidate) continue;
      const counts = new Map();
      for (const item of picked) {
        const question = pool.find((q) => q.qid === item.qid);
        const chapter = Number((question || {}).chapter) || 0;
        counts.set(chapter, (counts.get(chapter) || 0) + 1);
      }
      let donor = -1;
      let donorCount = 0;
      for (const [chapter, value] of counts) {
        if (chapter !== n && value > donorCount) {
          donor = chapter;
          donorCount = value;
        }
      }
      if (donor < 0 || donorCount < 2) continue;
      const index = picked.map((item, i) => ({ item: item, i: i })).reverse().find(({ item }) => {
        const question = pool.find((q) => q.qid === item.qid);
        return Number((question || {}).chapter) === donor;
      });
      if (!index) continue;
      const point = pointOf(candidate);
      if ((pointCount.get(point) || 0) >= POINT_CAP) continue;
      const removed = picked[index.i];
      const removedQuestion = pool.find((q) => q.qid === removed.qid);
      const removedPoint = pointOf(removedQuestion || {});
      pointCount.set(removedPoint, Math.max(0, (pointCount.get(removedPoint) || 1) - 1));
      pickedIds.delete(removed.qid);
      picked[index.i] = { qid: candidate.qid, source: 'weak' };
      pickedIds.add(candidate.qid);
      pointCount.set(point, (pointCount.get(point) || 0) + 1);
    }
  }

  // 排序：难度升序；相邻同考点则与后面第一道不同考点的题换位
  const byId = new Map(pool.map((question) => [question.qid, question]));
  const ordered = picked
    .slice()
    .sort((a, b) => (Number((byId.get(a.qid) || {}).difficulty) || 2) - (Number((byId.get(b.qid) || {}).difficulty) || 2));
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = byId.get(ordered[i - 1].qid) || {};
    const cur = byId.get(ordered[i].qid) || {};
    if (String(prev.chapter) + '|' + String(prev.point || '') !== String(cur.chapter) + '|' + String(cur.point || '')) continue;
    for (let j = i + 1; j < ordered.length; j += 1) {
      const next = byId.get(ordered[j].qid) || {};
      if (String(next.chapter) + '|' + String(next.point || '') !== String(cur.chapter) + '|' + String(cur.point || '')) {
        const tmp = ordered[i];
        ordered[i] = ordered[j];
        ordered[j] = tmp;
        break;
      }
    }
  }
  return ordered;
}

/* ------------------------------ 纯函数：补题计划 ------------------------------ */

export const TOPUP_PER_CHAPTER = 5;
export const TOPUP_MAX_ROUNDS = 6;
export const TOPUP_MAX_ADDED = 30;

/**
 * 计算一次「开始练习」需要补几轮题（P.4）。
 * 目标：new = N；mixed = floor(N/2)+1；每轮每章 +5，最多 6 轮/30 题/单书 300。
 * 返回的 `feasibleN` 是补完后能保证的最大场次题量；blocked 表示连 1 题都组不出。
 */
export function planTopUp({ mode, count, unseen, chapters, bankTotal, oldAvailable }) {
  const modeValue = SESSION_MODES.includes(mode) ? mode : 'mixed';
  const N = clampCount(count);
  const base = { mode: modeValue, count: N, targetNew: 0, unseen: Number(unseen) || 0, need: 0, perRound: 0, rounds: 0, added: 0, feasibleN: 0, blocked: false, reason: '' };
  if (modeValue === 'review') return base;

  const have = Number(unseen) || 0;
  const oldAvail = Math.max(0, Number(oldAvailable) || 0);
  // new：补满 N；mixed：至少过半，且旧题不够时用新题补满 N
  const targetNew = modeValue === 'new' ? N : Math.min(N, Math.max(Math.floor(N / 2) + 1, N - oldAvail));
  const need = Math.max(0, targetNew - have);
  const perRound = TOPUP_PER_CHAPTER * Math.max(1, Number(chapters) || 1);
  const capacity = Math.max(0, MAX_Q_PER_BOOK - (Number(bankTotal) || 0));
  const byNeed = need > 0 ? Math.ceil(need / perRound) : 0;
  const rounds = Math.max(0, Math.min(byNeed, TOPUP_MAX_ROUNDS, Math.floor(TOPUP_MAX_ADDED / perRound), Math.floor(capacity / perRound)));
  const added = rounds * perRound;
  const totalNew = have + added;
  const feasibleN =
    modeValue === 'new'
      ? Math.min(N, totalNew)
      : Math.min(N, totalNew + oldAvail, Math.max(0, 2 * totalNew - 1));
  const blocked = feasibleN < 1;
  return {
    mode: modeValue,
    count: N,
    targetNew: targetNew,
    unseen: have,
    need: need,
    perRound: perRound,
    rounds: rounds,
    added: added,
    feasibleN: feasibleN,
    blocked: blocked,
    reason: blocked ? (Number(bankTotal) >= MAX_Q_PER_BOOK ? '题库已满 300 题' : '没有新题可加') : '',
  };
}

/* ------------------------------ 纯函数：判题与调度 ------------------------------ */

/** 判断题/单选题比 key，多选题比集合且全对才算对（D52）。 */
export function judgePicked(question, picked) {
  const answer = Array.isArray(question && question.answer) ? question.answer.map((v) => String(v).toUpperCase()).sort() : [];
  const chosen = Array.from(new Set((Array.isArray(picked) ? picked : []).map((v) => String(v).toUpperCase()).filter(Boolean))).sort();
  if (!answer.length || chosen.length !== answer.length) return false;
  return chosen.every((value, index) => value === answer[index]);
}

/** 下一盒与到期时间（P.6）。 */
export function nextMastery(previous, correct, at) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const oldBox = Math.max(0, Math.min(4, Number(prev.box) || 0));
  const attempts = (Number(prev.attempts) || 0) + 1;
  const correctCount = (Number(prev.correct) || 0) + (correct ? 1 : 0);
  const stamp = at ? new Date(at) : new Date();
  if (!correct) {
    return {
      attempts: attempts,
      correct: correctCount,
      last: 'wrong',
      last_at: stamp.toISOString(),
      box: 0,
      due_at: stamp.toISOString(),
    };
  }
  const box = Math.min(oldBox + 1, 4);
  const days = oldBox >= 4 ? LEITNER_MASTER_DAYS : LEITNER_DAYS[box];
  const due = new Date(stamp.getTime() + days * 24 * 60 * 60 * 1000);
  return {
    attempts: attempts,
    correct: correctCount,
    last: 'correct',
    last_at: stamp.toISOString(),
    box: box,
    due_at: due.toISOString(),
  };
}

/* ------------------------------ 场次 ------------------------------ */

export function createSession({ bookId, moduleId, chapterNs, mode, count, plan, at }) {
  const stamp = at ? new Date(at) : new Date();
  return {
    schema_version: 1,
    session_id: 's' + newId(10),
    book_id: bookId,
    module_id: moduleId || null,
    chapters: (Array.isArray(chapterNs) ? chapterNs : []).map(Number).filter((n) => n > 0).sort((a, b) => a - b),
    mode: SESSION_MODES.includes(mode) ? mode : 'mixed',
    count: clampCount(count),
    status: 'running',
    created_at: stamp.toISOString(),
    finished_at: null,
    plan: (Array.isArray(plan) ? plan : []).map((item, index) => ({
      qid: String(item.qid),
      source: String(item.source || 'new'),
      order: index + 1,
    })),
    answers: [],
    summary: null,
  };
}

export function summarizeSession(session) {
  const answers = Array.isArray(session.answers) ? session.answers : [];
  const correct = answers.filter((answer) => answer.correct).length;
  const wrong = answers.filter((answer) => !answer.correct).map((answer) => answer.qid);
  return {
    total: Array.isArray(session.plan) ? session.plan.length : 0,
    answered: answers.length,
    correct: correct,
    wrong: answers.length - correct,
    accuracy: answers.length ? correct / answers.length : 0,
    wrongQids: wrong,
    elapsedMs: answers.reduce((sum, answer) => sum + (Number(answer.elapsed_ms) || 0), 0),
  };
}

/** 追加一次作答；同一 qid 重复提交按幂等处理（返回已有记录）。 */
export function appendAnswer(session, question, picked, elapsedMs, at) {
  const existing = session.answers.find((answer) => answer.qid === question.qid);
  if (existing) return { session: session, answer: existing, duplicate: true };
  const answer = {
    qid: question.qid,
    picked: Array.isArray(picked) ? picked.map((value) => String(value).toUpperCase()).filter(Boolean) : [],
    correct: judgePicked(question, picked),
    elapsed_ms: Math.max(0, Math.min(60 * 60 * 1000, Math.round(Number(elapsedMs) || 0))),
    at: (at ? new Date(at) : new Date()).toISOString(),
  };
  session.answers.push(answer);
  return { session: session, answer: answer, duplicate: false };
}

export function finishSession(session, at) {
  if (session.status !== 'finished') {
    session.status = 'finished';
    session.finished_at = (at ? new Date(at) : new Date()).toISOString();
    session.summary = summarizeSession(session);
  }
  return session;
}

/* ------------------------------ 生成：提示词与解析 ------------------------------ */

/** 题库提示词：考点白名单 + 章原文 + 避重列表；模型不产出讲解（P.3）。 */
export function buildPracticeMessages({ prompt, book, chapter, slidePoints, sourceText, avoidStems, count }) {
  const target = Math.max(MIN_Q_PER_CHAPTER, Math.min(MAX_Q_PER_CHAPTER, Number(count) || 5));
  const points = (Array.isArray(slidePoints) ? slidePoints : []).filter(Boolean).slice(0, 40);
  const avoid = (Array.isArray(avoidStems) ? avoidStems : []).filter(Boolean).slice(0, 60);
  const text = String(sourceText || '').slice(0, 12000);
  const user = [
    '【书】' + String((book && book.title) || '未命名'),
    '【章】第 ' + chapter.n + ' 章 ' + String(chapter.title || ''),
    '',
    '【本章精讲的考点（只考这些）】',
    points.length ? points.map((point, index) => index + 1 + '. ' + point).join('\n') : '（无，按原文出题）',
    '',
    '【已有题目（新题不得与其重复或同义改写）】',
    avoid.length ? avoid.map((stem) => '- ' + stem).join('\n') : '（无）',
    '',
    '【本章原文】',
    text,
    '',
    '请输出 ' + target + ' 道题，严格 JSON：',
    '{"questions":[{"type":"single|multi|judge","difficulty":1|2|3,"point":"考点，≤16字","stem":"题干，5–120字","options":[{"key":"A","text":"选项"}],"answer":["A"],"source_quote":"原文中连续的一段，10–200字"}]}',
    '硬约束：',
    '1. 只考上面列出的考点；考点没覆盖到的内容不要出题。',
    '2. source_quote 必须从本章原文逐字复制连续一段，不得改写、不得加省略号。',
    '3. 单选 4 个选项、1 个正确项；多选 4 个选项、2–4 个正确项；判断固定 A=正确、B=错误。',
    '4. 不要输出 explanation（讲解之后按需生成）。',
    '5. 不要 Markdown 围栏，不要解释。',
  ].join('\n');
  return { system: String(prompt || ''), user: user };
}

/** 解析练习题回复：剥围栏、容错前后文字；失败抛 E_QZ_SCHEMA。 */
export function parsePracticeReply(reply) {
  let text = String(reply || '').trim();
  if (!text) throw new PracticeError('E_QZ_SCHEMA', '模型没有返回内容');
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new PracticeError('E_QZ_SCHEMA', '模型返回的不是 JSON');
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new PracticeError('E_QZ_SCHEMA', '模型返回的 JSON 解析失败');
  }
  const list = Array.isArray(data) ? data : Array.isArray(data.questions) ? data.questions : [];
  if (!list.length) throw new PracticeError('E_QZ_SCHEMA', '模型没有给出题目');
  return list;
}

/* ------------------------------ 生成：单章 ------------------------------ */

/**
 * 生成并净化一章的题：解析 → 校验 → 锚点 → 去重 → 考点上限。
 * 重复题丢弃后补生成一次；仍不足按实际数量返回，并给 warning。
 */
export async function generateChapterQuestions({ bookId, book, chapter, slidePoints, sourceText, pages, prompt, callModel, existing, count, at, moduleId }) {
  const target = Math.max(MIN_Q_PER_CHAPTER, Math.min(MAX_Q_PER_CHAPTER, Number(count) || 5));
  const accepted = [];
  const warnings = [];
  const avoid = (Array.isArray(existing) ? existing : []).map((question) => question.stem);
  let lastErrors = [];

  for (let round = 0; round < 2 && accepted.length < target; round += 1) {
    const messages = buildPracticeMessages({
      prompt: prompt,
      book: book,
      chapter: chapter,
      slidePoints: slidePoints,
      sourceText: sourceText,
      avoidStems: avoid.concat(accepted.map((question) => question.stem)),
      count: Math.max(1, target - accepted.length),
    });
    let rawList = [];
    try {
      const reply = await callModel(messages.system, messages.user, { maxTokens: 8000, timeoutMs: 120000 });
      rawList = parsePracticeReply(reply && reply.text);
    } catch (err) {
      if (accepted.length) {
        warnings.push('补生成失败，按已有 ' + accepted.length + ' 题入库');
        break;
      }
      throw err;
    }
    for (const raw of rawList) {
      const normalized = normalizeQuestion(raw, chapter);
      if (!normalized.question) {
        lastErrors = lastErrors.concat(normalized.errors);
        continue;
      }
      const candidate = normalized.question;
      candidate.module_id = moduleId || null;
      candidate.created_at = (at ? new Date(at) : new Date()).toISOString();
      candidate.qid = questionId(bookId, chapter.n, candidate.dedupe_key);
      if (isDuplicate(candidate, (Array.isArray(existing) ? existing : []).concat(accepted))) {
        warnings.push('重复题已丢弃');
        continue;
      }
      const pointCount = (Array.isArray(existing) ? existing : [])
        .concat(accepted)
        .filter((question) => Number(question.chapter) === Number(chapter.n) && question.point === candidate.point).length;
      if (pointCount >= POINT_CAP) {
        warnings.push('同考点超限已丢弃');
        continue;
      }
      accepted.push(candidate);
      if (accepted.length >= target) break;
    }
  }

  if (!accepted.length) {
    if (lastErrors.length) throw new PracticeError('E_QZ_SCHEMA', '题目结构不合规：' + lastErrors.slice(0, 3).join('；'));
    throw new PracticeError('E_QZ_EMPTY', '这一章没能生成可用的题');
  }

  const anchored = anchorQuestions(accepted, pages, chapter);
  const kept = anchored.filter((question) => question.anchor_status === 'anchored');
  const dropped = anchored.length - kept.length;
  if (dropped > 0) warnings.push(dropped + ' 题的原文出处没定位到，已跳过');
  if (!kept.length) throw new PracticeError('E_QZ_ANCHOR', '题目出处都没能在原文里定位');
  return { questions: kept, warnings: warnings };
}

/* ------------------------------ 生成：作业 ------------------------------ */

/** 章节缓存键（P.3）：书 + 章 + 字数 + 提示词/蓝图版本。 */
export function chapterKey(bookId, chapter) {
  return sha256Of(
    Buffer.from(
      [
        String(bookId),
        String(chapter.n),
        String(chapter.title || ''),
        String(Number(chapter.chars) || 0),
        PRACTICE_PROMPT_VERSION,
        String(PRACTICE_BLUEPRINT_VERSION),
      ].join('|'),
      'utf8',
    ),
  );
}

const jobs = new Map();
const ACTIVE = ['queued', 'drafting', 'checking', 'anchoring'];

export function getPracticeJob(jobId) {
  const job = jobs.get(String(jobId || ''));
  if (!job) return null;
  return {
    jobId: job.jobId,
    bookId: job.bookId,
    chapters: job.chapters,
    status: job.status,
    stage: job.stage,
    current: job.current,
    total: job.total,
    message: job.message,
    code: job.code || null,
    error: job.error || null,
    append: !!job.append,
    added: Number(job.added) || 0,
    warnings: Array.isArray(job.warnings) ? job.warnings.slice(0, 20) : [],
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

export function cancelPracticeJob(jobId) {
  const job = jobs.get(String(jobId || ''));
  if (!job || !ACTIVE.includes(job.status)) return false;
  job.cancelled = true;
  try {
    job.controller.abort();
  } catch {
    /* 已经结束 */
  }
  return true;
}

export function buildExplainMessages({ prompt, question, picked, pageText }) {
  const options = (Array.isArray(question.options) ? question.options : [])
    .map((option) => option.key + '. ' + option.text)
    .join('\n');
  const chosen = Array.isArray(picked) && picked.length ? picked.join('、') : '（未选，直接看了答案）';
  const user = [
    '【题】' + question.stem,
    options,
    '【正确答案】' + (Array.isArray(question.answer) ? question.answer.join('、') : ''),
    '【读者选择】' + chosen,
    '【原文片段】' + question.source_quote,
    pageText ? '【这段原文所在的页（节选）】\n' + String(pageText).slice(0, 1200) : '',
    '请用中文写 150–300 字讲解，覆盖：正确项为什么对、每个错误选项为什么错、依据原文哪一句。',
    '只依据上面给的原文，不要补充原文没有的事实；不要提「幻灯片」「如上图」。',
  ]
    .filter(Boolean)
    .join('\n');
  return { system: String(prompt || ''), user: user };
}

export function explainCacheKey(qid, picked, mode) {
  const list = (Array.isArray(picked) ? picked : []).map((value) => String(value).toUpperCase()).sort().join(',');
  return sha256Of(Buffer.from([String(qid), list, String(mode || 'normal'), PRACTICE_PROMPT_VERSION].join('|'), 'utf8'));
}
