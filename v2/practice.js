/**
 * 2.0 练习与复习（FR-19.1 / P1）。
 *
 * 两条硬边界（与 1.x 相同，但对象换成系列）：
 *   1. 题库按**章**缓存、按**系列**组卷；准备题库（异步作业）与开场（同步）是两个独立动作，
 *      开场只读已有题库，绝不触发生成（D4）。
 *   2. 判题在宿主本地完成，不调模型；「查看讲解」是独立动作，失败不阻断下一题（D9）。
 *
 * 落盘沿用 §6.1：books/<bookId>/practice/
 *   questions.json   题库（每章 4–6 题，单书 ≤300）
 *   mastery.json     Leitner 掌握度
 *   sessions/*.json  场次（含 series_id，可断点续做）
 *
 * 纯函数（校验/去重/组卷/判题/调度）复用 1.x practice.js；这里只做 2.0 的存储、作业与系列范围。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  MAX_Q_PER_BOOK,
  MIN_Q_PER_CHAPTER,
  PRACTICE_BLUEPRINT_VERSION,
  PRACTICE_PROMPT_VERSION,
  PracticeError,
  SESSION_DEFAULT_COUNT,
  SESSION_MAX_COUNT,
  SESSION_MODES,
  TOPUP_MAX_ADDED,
  TOPUP_MAX_ROUNDS,
  TOPUP_PER_CHAPTER,
  appendAnswer,
  buildExplainMessages,
  buildPracticeMessages,
  chapterKey,
  composeSession,
  finishSession,
  generateChapterQuestions,
  judgePicked,
  nextMastery,
  parsePracticeReply,
  planTopUp,
} from '../practice.js';
import { loadBook, newId } from './books.js';
import { findSeries } from './series.js';
import { loadLecture, seriesChapterTexts } from './lectures.js';
import { callModel } from './llm.js';
import { readJson, writeJson } from './root.js';
import { recordError } from './errors.js';

export {
  PRACTICE_PROMPT_VERSION,
  PRACTICE_BLUEPRINT_VERSION,
  MIN_Q_PER_CHAPTER,
  MAX_Q_PER_BOOK,
  SESSION_DEFAULT_COUNT,
  SESSION_MAX_COUNT,
  SESSION_MODES,
  TOPUP_PER_CHAPTER,
  TOPUP_MAX_ROUNDS,
  PracticeError,
  composeSession,
  judgePicked,
  nextMastery,
  planTopUp,
  summarizeSession,
} from '../practice.js';

const PROMPT_FILE = new URL('../prompts/practice-gen-v1.md', import.meta.url);
const EXPLAIN_PROMPT_FILE = new URL('../prompts/practice-explain-v1.md', import.meta.url);
const READY = ['ready', 'ready_degraded'];
const ACTIVE = ['queued', 'drafting', 'checking', 'anchoring', 'cancelling'];

let promptCache = null;

function promptText(file) {
  if (file === PROMPT_FILE) {
    if (promptCache == null) {
      try {
        promptCache = fs.readFileSync(PROMPT_FILE, 'utf8');
      } catch {
        promptCache = '';
      }
    }
    return promptCache;
  }
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/* ------------------------------ 存储 ------------------------------ */

export function practiceDir(bookId) {
  const loaded = loadBook(bookId);
  return loaded ? path.join(loaded.dir, 'practice') : null;
}

function bankFile(bookId) {
  const dir = practiceDir(bookId);
  return dir ? path.join(dir, 'questions.json') : null;
}

function masteryFile(bookId) {
  const dir = practiceDir(bookId);
  return dir ? path.join(dir, 'mastery.json') : null;
}

function sessionsDir(bookId) {
  const dir = practiceDir(bookId);
  return dir ? path.join(dir, 'sessions') : null;
}

function sessionFile(bookId, sessionId) {
  if (!/^[a-z0-9]{8,16}$/.test(String(sessionId || ''))) return null;
  const dir = sessionsDir(bookId);
  return dir ? path.join(dir, sessionId + '.json') : null;
}

export function emptyBank(bookId) {
  return {
    schema_version: 1,
    product_version: '2.0',
    book_id: String(bookId || ''),
    prompt_version: PRACTICE_PROMPT_VERSION,
    blueprint_version: PRACTICE_BLUEPRINT_VERSION,
    chapters: {},
    questions: [],
  };
}

export function readBank(bookId) {
  const file = bankFile(bookId);
  const data = file ? readJson(file, null) : null;
  if (!data || typeof data !== 'object' || !Array.isArray(data.questions)) return emptyBank(bookId);
  return {
    schema_version: 1,
    product_version: '2.0',
    book_id: String(bookId || ''),
    prompt_version: String(data.prompt_version || PRACTICE_PROMPT_VERSION),
    blueprint_version: Number(data.blueprint_version) || PRACTICE_BLUEPRINT_VERSION,
    chapters: data.chapters && typeof data.chapters === 'object' ? data.chapters : {},
    questions: data.questions.filter((question) => question && typeof question === 'object' && question.qid),
  };
}

export function writeBank(bookId, bank) {
  const file = bankFile(bookId);
  if (!file) throw new PracticeError('E_NOT_FOUND', '找不到这本书');
  writeJson(file, bank);
  return bank;
}

export function readMastery(bookId) {
  const file = masteryFile(bookId);
  const data = file ? readJson(file, null) : null;
  if (!data || typeof data !== 'object' || !data.items) return { schema_version: 1, updated_at: '', items: {} };
  return { schema_version: 1, updated_at: String(data.updated_at || ''), items: data.items };
}

function writeMastery(bookId, mastery) {
  const file = masteryFile(bookId);
  if (!file) return null;
  mastery.updated_at = new Date().toISOString();
  writeJson(file, mastery);
  return mastery;
}

function readSession(bookId, sessionId) {
  const file = sessionFile(bookId, sessionId);
  if (!file) return null;
  const data = readJson(file, null);
  if (!data || typeof data !== 'object' || !Array.isArray(data.plan)) return null;
  return data;
}

function writeSession(bookId, session) {
  const file = sessionFile(bookId, session && session.session_id);
  if (!file) throw new PracticeError('E_BAD_ID', '场次号不合法');
  writeJson(file, session);
  return session;
}

/** 某系列最近一场未结束的场次（断点续练 AC-134）。 */
export function latestRunningSession(bookId, seriesId) {
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
    if (seriesId && String(session.series_id || '') !== String(seriesId)) continue;
    if (!best || String(session.created_at || '').localeCompare(String(best.created_at || '')) > 0) best = session;
  }
  return best;
}

/* ------------------------------ 系列范围与出题素材 ------------------------------ */

function readyLecturesOf(series) {
  return (series.lectures || []).filter((lecture) => READY.includes(String(lecture.status)));
}

function coveredChapters(series) {
  const set = new Set();
  for (const lecture of readyLecturesOf(series)) {
    for (const n of lecture.chapters || []) set.add(Number(n));
  }
  return set;
}

function lectureDocsOf(found) {
  const docs = [];
  for (const item of readyLecturesOf(found.series)) {
    const doc = loadLecture(found.dir, item.n);
    if (doc.exists && doc.slidesDoc && Array.isArray(doc.slidesDoc.slides)) docs.push({ n: Number(item.n), doc });
  }
  return docs;
}

/** 一章的精讲考点：取自覆盖该章的已就绪讲的要点与引文。 */
function pointsOf(docs, chapter) {
  const points = [];
  const from = Number(chapter.from) || 1;
  const to = Number(chapter.to) || from;
  for (const { doc } of docs) {
    for (const slide of doc.slidesDoc.slides) {
      const pages = slide.source_pages || {};
      const overlaps = Number(pages.to || pages.from || 0) >= from && Number(pages.from || 0) <= to;
      if (!overlaps) continue;
      for (const bullet of Array.isArray(slide.bullet_points) ? slide.bullet_points : []) {
        const text = String(bullet || '').trim();
        if (text) points.push(text);
      }
      if (slide.quote_text) points.push(String(slide.quote_text).trim());
    }
  }
  return Array.from(new Set(points.filter(Boolean))).slice(0, 40);
}

function seriesScope(found, chapters) {
  const texts = seriesChapterTexts(found.series.book_id, found.series);
  if (!texts) throw new PracticeError('E_NOT_FOUND', '找不到这本书');
  const wanted = Array.isArray(chapters) && chapters.length
    ? Array.from(new Set(chapters.map(Number).filter((n) => n > 0)))
    : (found.series.chapters || []).map(Number);
  const all = new Map(texts.chapters.map((chapter) => [Number(chapter.n), chapter]));
  const scope = wanted
    .filter((n) => all.has(n))
    .sort((a, b) => a - b)
    .map((n) => all.get(n));
  return { texts, scope, docs: lectureDocsOf(found) };
}

function publicQuestion(question) {
  return {
    qid: question.qid,
    chapter: Number(question.chapter),
    type: String(question.type || 'single'),
    difficulty: Number(question.difficulty) || 2,
    point: String(question.point || ''),
    stem: String(question.stem || ''),
    options: Array.isArray(question.options) ? question.options : [],
    flagged: question.flagged === true,
    anchor_status: String(question.anchor_status || 'unanchored'),
  };
}

/* ------------------------------ 汇总 ------------------------------ */

export function practiceSummary(seriesId) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new PracticeError('E_NOT_FOUND', '找不到这个系列');
  const bookId = found.series.book_id;
  const scope = seriesScope(found, null);
  const bank = readBank(bookId);
  const mastery = readMastery(bookId);
  const questions = bank.questions;
  const byChapter = new Map();
  for (const question of questions) {
    const n = Number(question.chapter);
    byChapter.set(n, (byChapter.get(n) || 0) + 1);
  }
  const now = Date.now();
  const stateOf = (qid) => (mastery.items && mastery.items[qid]) || null;
  const isDue = (question) => {
    const state = stateOf(question.qid);
    if (!state || !state.due_at) return false;
    return Date.parse(state.due_at) <= now;
  };
  const wrong = questions.filter((question) => {
    const state = stateOf(question.qid);
    return state && (state.last === 'wrong' || Number(state.box) === 0);
  }).length;
  const due = questions.filter(isDue).length;
  const unseen = questions.filter((question) => {
    const state = stateOf(question.qid);
    return !state || Number(state.attempts) === 0;
  }).length;
  const covered = coveredChapters(found.series);
  const chapters = scope.scope.map((chapter) => ({
    n: Number(chapter.n),
    title: String(chapter.title || ''),
    covered: covered.has(Number(chapter.n)),
    count: byChapter.get(Number(chapter.n)) || 0,
    key: chapterKey(bookId, chapter),
  }));
  const readyChapters = chapters.filter((chapter) => chapter.covered);
  const topup = planTopUp({
    mode: 'mixed',
    count: SESSION_DEFAULT_COUNT,
    unseen: unseen,
    chapters: Math.max(1, readyChapters.length),
    bankTotal: questions.length,
    oldAvailable: Math.max(0, questions.length - unseen),
  });
  return {
    seriesId: found.series.id,
    bookId,
    chapters,
    counts: {
      questions: questions.length,
      covered: readyChapters.length,
      chapters: chapters.length,
      readyChapters: readyChapters.filter((chapter) => chapter.count >= MIN_Q_PER_CHAPTER).length,
      unseen,
      due,
      wrong,
      flagged: questions.filter((question) => question.flagged === true).length,
    },
    topup,
    session: latestRunningSession(bookId, found.series.id),
  };
}

/* ------------------------------ 场次：组卷 / 判题 / 讲解 ------------------------------ */

function sessionScope(found, chapters) {
  if (Array.isArray(chapters) && chapters.length) {
    const wanted = new Set(chapters.map(Number));
    const ns = (found.series.chapters || []).map(Number).filter((n) => wanted.has(n));
    return ns.length ? ns.sort((a, b) => a - b) : (found.series.chapters || []).map(Number);
  }
  return (found.series.chapters || []).map(Number);
}

function createV2Session({ found, chapterNs, mode, plan }) {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    product_version: '2.0',
    session_id: 's' + newId(10),
    book_id: found.series.book_id,
    series_id: found.series.id,
    chapters: chapterNs.slice().sort((a, b) => a - b),
    mode: SESSION_MODES.includes(mode) ? mode : 'mixed',
    count: plan.length,
    status: 'running',
    created_at: now,
    finished_at: null,
    plan: plan.map((item, index) => ({ qid: String(item.qid), source: String(item.source || 'new'), order: index + 1 })),
    answers: [],
    summary: null,
  };
}

function sessionPayload(found, session) {
  const bank = readBank(found.series.book_id);
  const map = new Map(bank.questions.map((question) => [question.qid, question]));
  const questions = session.plan
    .map((item) => map.get(String(item.qid)))
    .filter(Boolean)
    .map(publicQuestion);
  const answered = new Set((session.answers || []).map((answer) => String(answer.qid)));
  const next = session.plan.find((item) => !answered.has(String(item.qid))) || null;
  return {
    sessionId: session.session_id,
    session: Object.assign({}, session, { completed: (session.answers || []).length }),
    questions,
    next: next ? { qid: String(next.qid), order: Number(next.order) || 0 } : null,
  };
}

function requireSession(found, sessionId) {
  const session = readSession(found.series.book_id, sessionId);
  if (!session || String(session.series_id || '') !== String(found.series.id)) {
    throw new PracticeError('E_NO_SESSION', '找不到这场练习', '刷新后重新开始。');
  }
  return session;
}

export function getRunningSession(seriesId) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new PracticeError('E_NOT_FOUND', '找不到这个系列');
  const session = latestRunningSession(found.series.book_id, found.series.id);
  return session ? sessionPayload(found, session) : null;
}

export function startSession({ seriesId, mode = 'mixed', count = SESSION_DEFAULT_COUNT, chapters = null }) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new PracticeError('E_NOT_FOUND', '找不到这个系列');
  const running = latestRunningSession(found.series.book_id, found.series.id);
  if (running) return Object.assign({ reused: true }, sessionPayload(found, running));

  const bank = readBank(found.series.book_id);
  const mastery = readMastery(found.series.book_id);
  const chapterNs = sessionScope(found, chapters);
  const plan = composeSession({ bank, mastery, chapterNs, mode, count });
  if (!plan.length) {
    throw new PracticeError('E_BANK_INSUFFICIENT', '题库里还没有可出的题', '先「准备题库」，或到错题本复习已有题。');
  }
  const session = createV2Session({ found, chapterNs, mode, plan });
  writeSession(found.series.book_id, session);
  return Object.assign({ reused: false }, sessionPayload(found, session));
}

export function reviewSession({ seriesId }) {
  return startSession({ seriesId, mode: 'review', count: SESSION_MAX_COUNT });
}

/** 判题：只读题库与场次，不调模型。同 qid 重复提交幂等。 */
export function submitAnswer({ seriesId, sessionId, qid, picked = [] }) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new PracticeError('E_NOT_FOUND', '找不到这个系列');
  const session = requireSession(found, sessionId);
  if (session.status !== 'running') throw new PracticeError('E_NO_SESSION', '这场练习已经结束', '重新开一场。');
  const bank = readBank(found.series.book_id);
  const question = bank.questions.find((item) => String(item.qid) === String(qid));
  if (!question) throw new PracticeError('E_NOT_FOUND', '题库里找不到这道题', '');

  const appended = appendAnswer(session, question, picked, 0, new Date());
  const result = {
    correct: appended.answer.correct,
    answer: (question.answer || []).map((value) => String(value)),
    source_quote: String(question.source_quote || ''),
    source_anchor: question.source_anchor || null,
    duplicate: appended.duplicate,
  };
  if (!appended.duplicate) {
    writeSession(found.series.book_id, session);
    const mastery = readMastery(found.series.book_id);
    mastery.items = mastery.items || {};
    mastery.items[question.qid] = nextMastery(mastery.items[question.qid], appended.answer.correct, new Date());
    writeMastery(found.series.book_id, mastery);
  }
  if (question.explanation_status === 'ready' && question.explanation) {
    result.explanation = String(question.explanation);
  }
  return result;
}

/** 独立讲解动作（D9）：用户点「查看讲解」才调模型；失败只标该题，不阻断下一题。 */
export async function explainQuestion({ seriesId, qid, picked = [], ctx = null, options = {} }) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new PracticeError('E_NOT_FOUND', '找不到这个系列');
  const bookId = found.series.book_id;
  const bank = readBank(bookId);
  const question = bank.questions.find((item) => String(item.qid) === String(qid));
  if (!question) throw new PracticeError('E_NOT_FOUND', '题库里找不到这道题', '');
  if (question.explanation_status === 'ready' && question.explanation) {
    return { explanation: String(question.explanation), cached: true };
  }
  const texts = seriesChapterTexts(bookId, found.series);
  const chapter = (texts.chapters || []).find((item) => Number(item.n) === Number(question.chapter));
  const pages = texts.loaded ? readJson(path.join(texts.loaded.dir, 'pages.json'), []) : [];
  const pageText = (Array.isArray(pages) ? pages : [])
    .filter((page) => {
      const from = Number((question.source_pages || {}).from) || 0;
      const to = Number((question.source_pages || {}).to) || from;
      const n = Number(page.page);
      return n >= from && n <= to;
    })
    .map((page) => String(page.text || ''))
    .join('\n');
  const messages = buildExplainMessages({
    prompt: promptText(EXPLAIN_PROMPT_FILE),
    question,
    picked,
    pageText: pageText || String((chapter && chapter.text) || ''),
  });
  try {
    const reply = await callModel(ctx, messages.system, messages.user, {
      maxTokens: 2000,
      timeoutMs: Number(options.timeoutMs) || 8000,
      signal: options.signal || null,
    });
    const text = String((reply && reply.text) || '').trim();
    if (!text) throw new PracticeError('E_EXPLAIN_FAILED', '模型没有返回讲解', '');
    question.explanation = text;
    question.explanation_status = 'ready';
    question.explanation_at = new Date().toISOString();
    question.explanation_model = String((reply && reply.model) || '');
    writeBank(bookId, bank);
    return { explanation: text, cached: false };
  } catch (err) {
    const code = err && err.code === 'E_CANCELLED' ? 'E_CANCELLED' : 'E_EXPLAIN_FAILED';
    question.explanation_status = 'failed';
    try {
      writeBank(bookId, bank);
    } catch {
      /* 写不进去也不阻断答题 */
    }
    recordError(code, (err && err.message) || '讲解失败');
    throw new PracticeError(code, '讲解暂时生成不了', '先看正确答案与原文，继续下一题。');
  }
}

export function finishSessionById({ seriesId, sessionId }) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new PracticeError('E_NOT_FOUND', '找不到这个系列');
  const session = requireSession(found, sessionId);
  finishSession(session, new Date());
  writeSession(found.series.book_id, session);
  return session.summary;
}

export function flagQuestion({ seriesId, qid, flagged = true }) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new PracticeError('E_NOT_FOUND', '找不到这个系列');
  const bank = readBank(found.series.book_id);
  const question = bank.questions.find((item) => String(item.qid) === String(qid));
  if (!question) throw new PracticeError('E_NOT_FOUND', '题库里找不到这道题', '');
  question.flagged = flagged !== false;
  writeBank(found.series.book_id, bank);
  return { qid: String(question.qid), flagged: question.flagged };
}

/* ------------------------------ 题库作业 ------------------------------ */

const jobs = new Map();
const activeBySeries = new Map();

function nowIso() {
  return new Date().toISOString();
}

function pruneJobs() {
  const finished = Array.from(jobs.values()).filter((job) => !job.active);
  finished.sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')));
  for (const job of finished.slice(20)) jobs.delete(job.jobId);
}

function jobState(job) {
  return {
    ok: true,
    jobId: job.jobId,
    seriesId: job.seriesId,
    bookId: job.bookId,
    chapters: job.chapters.slice(),
    status: job.status,
    stage: job.stage,
    current: job.current,
    total: job.total,
    message: job.message,
    code: job.code || null,
    error: job.error || null,
    added: Number(job.added) || 0,
    round: Number(job.round) || 0,
    rounds: Number(job.rounds) || 0,
    warnings: (job.warnings || []).slice(0, 20),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

export function getPracticeJob(jobId) {
  const job = jobs.get(String(jobId || ''));
  return job ? jobState(job) : null;
}

export function activePracticeJob(seriesId) {
  const job = activeBySeries.get(String(seriesId || ''));
  return job && job.active ? job : null;
}

export function isPracticeJobActive(seriesId) {
  return !!activePracticeJob(seriesId);
}

export function cancelPracticeJob(jobId) {
  const job = jobs.get(String(jobId || ''));
  if (!job || !job.active) return false;
  job.cancelled = true;
  job.status = 'cancelling';
  job.message = '正在取消…';
  try {
    job.controller.abort();
  } catch {
    /* 已经结束 */
  }
  return true;
}

export function cancelPracticeJobsForSeries(seriesId) {
  let cancelled = 0;
  for (const job of jobs.values()) {
    if (!job.active || String(job.seriesId) !== String(seriesId || '')) continue;
    if (cancelPracticeJob(job.jobId)) cancelled += 1;
  }
  return cancelled;
}

export function cancelPracticeJobsForBook(bookId) {
  let cancelled = 0;
  for (const job of jobs.values()) {
    if (!job.active || String(job.bookId) !== String(bookId || '')) continue;
    if (cancelPracticeJob(job.jobId)) cancelled += 1;
  }
  return cancelled;
}

function assertActive(job) {
  if (job.cancelled) throw new PracticeError('E_CANCELLED', '已取消');
}

/**
 * 启动题库作业（异步）：
 *   - 只收「已被 ready/ready_degraded 讲覆盖」的章；
 *   - 未补题时命中章缓存（key 不变且已有 ≥4 题）直接跳过；
 *   - topup=true 时按每轮每章 +5 补题，最多 6 轮、单次 ≤30 题。
 */
export function startPracticeBankJob({ seriesId, chapters = null, topup = false, rounds = 1, ctx = null, options = {} }) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new PracticeError('E_NOT_FOUND', '找不到这个系列');
  if (activePracticeJob(found.series.id)) {
    throw new PracticeError('E_SERIES_BUSY', '正在准备题库，请稍候', '同一系列同时只能有一个题库作业。');
  }
  const scope = seriesScope(found, chapters);
  if (!scope.scope.length) throw new PracticeError('E_PART_EMPTY', '这个系列没有可出题的章', '');
  const covered = coveredChapters(found.series);
  const ready = scope.scope.filter((chapter) => covered.has(Number(chapter.n)));
  if (!ready.length) {
    throw new PracticeError('E_LECTURE_EMPTY', '这些章还没有就绪的讲', '先生成讲义，再准备题库。');
  }
  const roundCount = topup ? Math.max(1, Math.min(TOPUP_MAX_ROUNDS, Math.round(Number(rounds) || 1))) : 1;
  const bank = readBank(found.series.book_id);
  const planned = [];
  for (const chapter of ready) {
    const key = chapterKey(found.series.book_id, chapter);
    const state = bank.chapters[String(chapter.n)] || null;
    const have = bank.questions.filter((question) => Number(question.chapter) === Number(chapter.n) && question.flagged !== true).length;
    if (!topup && state && state.key === key && have >= MIN_Q_PER_CHAPTER) continue;
    planned.push(chapter);
  }
  if (!planned.length) {
    const cached = new PracticeError('E_BANK_CACHED', '题库已就绪，无需重复生成', '直接开始练习即可。');
    cached.cached = true;
    throw cached;
  }
  let effectiveRounds = roundCount;
  if (topup) {
    if (bank.questions.length >= MAX_Q_PER_BOOK) {
      throw new PracticeError('E_BANK_FULL', '题库已达 300 题上限', '先标记不用的题，或换一本书。');
    }
  }

  const job = {
    jobId: 'p' + newId(10),
    seriesId: found.series.id,
    bookId: found.series.book_id,
    chapters: planned.map((chapter) => Number(chapter.n)),
    status: 'queued',
    stage: 'queued',
    current: 0,
    total: planned.length * effectiveRounds,
    message: '已排队',
    code: null,
    error: null,
    added: 0,
    round: 0,
    rounds: effectiveRounds,
    warnings: [],
    topup: topup === true,
    plannedKeys: new Map(planned.map((chapter) => [Number(chapter.n), chapterKey(found.series.book_id, chapter)])),
    startedAt: nowIso(),
    finishedAt: null,
    cancelled: false,
    active: true,
    controller: new AbortController(),
    promise: null,
  };
  jobs.set(job.jobId, job);
  activeBySeries.set(job.seriesId, job);
  pruneJobs();

  job.promise = runBankJob(job, found, scope, planned, topup === true, effectiveRounds, ctx, options).catch((err) => {
    job.status = job.cancelled ? 'cancelled' : 'failed';
    job.stage = 'done';
    job.code = job.cancelled ? 'E_CANCELLED' : (err && err.code) || 'E_QZ_FAIL';
    job.error = job.cancelled ? '已取消' : String((err && err.message) || err);
    job.message = job.error;
    job.finishedAt = nowIso();
    job.active = false;
    activeBySeries.delete(job.seriesId);
  });
  job.promise.finally(() => {
    job.active = false;
    job.controller = null;
    activeBySeries.delete(job.seriesId);
    pruneJobs();
  }).catch(() => {});
  return jobState(job);
}

async function runBankJob(job, found, scope, planned, topup, roundCount, ctx, options) {
  const raw = Number(process.env.DSH_BOOK_SLIDES_PRACTICE_TIMEOUT_MS);
  const budgetMs = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5 * 60 * 1000;
  const deadline = Date.parse(job.startedAt) + budgetMs;
  const modelCall = (system, user, callOptions) =>
    callModel(ctx, system, user, Object.assign({ signal: job.controller.signal }, callOptions || {}));
  const prompt = promptText(PROMPT_FILE);
  const pages = scope.texts.pages;
  const failures = [];
  let wrote = 0;
  let cursor = 0;

  for (let round = 1; round <= roundCount; round += 1) {
    job.round = round;
    for (const chapter of planned) {
      assertActive(job);
      if (Date.now() > deadline) throw new PracticeError('E_QZ_TIMEOUT', '题库作业超时（5 分钟）', '可重试未完成的章。');
      // 单次补题 ≤30 题：补满就收手，剩下的留给下一轮
      if (topup && job.added >= TOPUP_MAX_ADDED) break;
      job.stage = 'drafting';
      job.current = cursor;
      job.total = planned.length * roundCount;
      job.message = '第 ' + chapter.n + ' 章 · 第 ' + round + '/' + roundCount + ' 轮出题';
      const bank = readBank(found.series.book_id);
      const existing = bank.questions;
      const inChapter = existing.filter((question) => Number(question.chapter) === Number(chapter.n) && question.flagged !== true);
      if (!topup && inChapter.length >= MIN_Q_PER_CHAPTER) {
        cursor += 1;
        continue;
      }
      const points = pointsOf(scope.docs, chapter);
      if (!String(chapter.text || '').trim()) {
        failures.push({ chapter: chapter.n, code: 'E_QZ_NO_SOURCE', message: '第 ' + chapter.n + ' 章没有原文' });
        continue;
      }
      try {
        job.stage = 'checking';
        job.message = '第 ' + chapter.n + ' 章 · 校验题目';
        const result = await generateChapterQuestions({
          bookId: found.series.book_id,
          book: scope.texts.loaded.book,
          chapter,
          slidePoints: points,
          sourceText: String(chapter.text || '').slice(0, 12000),
          pages,
          prompt,
          callModel: modelCall,
          existing,
          count: 5,
          at: nowIso(),
          moduleId: null,
        });
        assertActive(job);
        job.stage = 'anchoring';
        const fresh = readBank(found.series.book_id);
        const known = new Set(fresh.questions.map((question) => question.qid));
        let added = 0;
        for (const question of result.questions) {
          if (known.has(question.qid)) continue;
          if (fresh.questions.length >= MAX_Q_PER_BOOK) break;
          fresh.questions.push(question);
          known.add(question.qid);
          added += 1;
        }
        fresh.chapters[String(chapter.n)] = {
          status: 'ready',
          count: fresh.questions.filter((question) => Number(question.chapter) === Number(chapter.n)).length,
          key: job.plannedKeys.get(Number(chapter.n)) || chapterKey(found.series.book_id, chapter),
          generated_at: nowIso(),
        };
        writeBank(found.series.book_id, fresh);
        wrote += added;
        job.added = wrote;
        job.warnings.push(...result.warnings.map((warning) => '第 ' + chapter.n + ' 章：' + warning));
      } catch (err) {
        if (job.cancelled || (err && err.code === 'E_CANCELLED')) throw err;
        const code = (err && err.code) || (/timeout|timed out/i.test(String((err && err.message) || '')) ? 'E_QZ_TIMEOUT' : 'E_QZ_FAIL');
        failures.push({ chapter: chapter.n, code, message: String((err && err.message) || err) });
      }
      cursor += 1;
      job.current = cursor;
    }
  }

  if (job.cancelled) {
    job.status = 'cancelled';
    job.stage = 'done';
    job.message = '已取消';
    job.finishedAt = nowIso();
    return;
  }
  if (!wrote && failures.length === planned.length * roundCount) {
    job.status = 'failed';
    job.stage = 'done';
    job.code = failures[0].code;
    job.error = failures.map((failure) => '第 ' + failure.chapter + ' 章：' + failure.message).join('；');
    job.message = '题库没有生成成功';
    job.finishedAt = nowIso();
    recordError(job.code, job.error);
    return;
  }

  const bank = readBank(found.series.book_id);
  for (const chapter of planned) {
    const count = bank.questions.filter((question) => Number(question.chapter) === Number(chapter.n) && question.flagged !== true).length;
    bank.chapters[String(chapter.n)] = Object.assign(
      { status: count >= MIN_Q_PER_CHAPTER ? 'ready' : 'partial', count, key: job.plannedKeys.get(Number(chapter.n)) },
      bank.chapters[String(chapter.n)] || {},
      { count, updated_at: nowIso() },
    );
  }
  writeBank(found.series.book_id, bank);

  job.status = 'ready';
  job.stage = 'done';
  job.current = job.total;
  job.message = topup ? '已新增 ' + wrote + ' 题' : '题库已更新（' + wrote + ' 题）';
  job.finishedAt = nowIso();
  if (failures.length) {
    job.warnings.push('部分章失败：' + failures.map((failure) => '第 ' + failure.chapter + ' 章 ' + failure.code).join('，'));
  }
}

/** 只给测试与调用方用的补充参数：单章补题。 */
export function chapterQuestionsFor(seriesId, chapterN) {
  const found = findSeries(String(seriesId || ''));
  if (!found) return [];
  return readBank(found.series.book_id).questions.filter((question) => Number(question.chapter) === Number(chapterN));
}

export { ACTIVE as PRACTICE_ACTIVE, READY as PRACTICE_READY, parsePracticeReply, buildPracticeMessages };
