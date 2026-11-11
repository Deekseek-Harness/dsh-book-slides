/**
 * 2.0 M3 逐讲生成：全量/单讲、批预算、锚点、预缝、作业进度/取消/续跑。
 *
 * 设计要点（§6.8 / FR-16 / §附录 B）：
 * - 一讲 = 三阶段：structuring → validate → anchor；不调 TTS，音频字段先留空。
 * - 批预算沿用 12000 / 8000 / 300；讲内批检查点落在 lectures/<n>/batches/。
 * - 预缝：cover.audio_script 逐字以接缝句开头、last.audio_script 逐字以接缝句结尾；
 *   不通过只修该页，不重跑整讲。
 * - 同一系列同一时间只允许一个作业；取消/重启后只补未完成的讲。
 * - 没有“独立模块”路径：所有讲都写在 series/<id>/lectures/<n>/ 下。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { readJson, writeJson } from './root.js';
import { newId } from './books.js';
import { listAllSeries, patchSeriesLecture, persistSeries } from './series.js';
import {
  batchesDir,
  chapterMapOf,
  loadLecture,
  seriesChapterTexts,
  slidesFile,
  writeLectureMeta,
  writeLectureOutputs,
} from './lectures.js';
import { buildStitchReport, writeStitchReport, withSeamSentence } from './stitch.js';
import { initialImageStatus } from './images.js';
import { callModel, readJsonBlock, resolveModel } from './llm.js';
import { readMustKeepAliases } from './aliases.js';
import { billingForLlm, runUsageJob } from './usage.js';
import { estimateLecture } from './usage-estimate.js';
import {
  AUDIO_MAX,
  AUDIO_MIN,
  BATCH_CHARS,
  CARRY_CHARS,
  MAX_SLIDES,
  MIN_SLIDES,
  SPLIT_CHARS,
  anchorSlides,
  applyAnchorFixes,
  buildAnchorRepairUser,
  buildRepairMessages,
  formatSlideErrors,
  mergeBatchSlides,
  normalizeSlide,
  parseAnchorFixes,
  parseSlidesReply,
  validateSlideSet,
  validateSlides,
} from '../lib/slides.js';

export const LECTURE_PROMPT_VERSION = 'lec-v2-sections-f';
const PROMPT = new URL('../prompts/lecture-v1.md', import.meta.url);
const MUSTKEEP_PROMPT = new URL('../prompts/repair-mustkeep-v1.md', import.meta.url);
const LLM_MAX_TOKENS = 16000;
const LLM_RETRY_MAX_TOKENS = 32000;
const ANCHOR_MAX_TOKENS = 8000;
const ANCHOR_REPAIR_THRESHOLD = 0.9;
const ANCHOR_REPAIR_TEXT_LIMIT = 20000;

const ACTIVE_STATUS = ['queued', 'structuring', 'validate', 'anchor'];
const SERIES_ACTIVE = ['drafting', 'stitching'];
const READY_STATUS = ['ready', 'ready_degraded'];

/** seriesId → job；跑完保留一段时间给面板取最终状态。 */
const jobsBySeries = new Map();

export class GenerationError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'GenerationError';
    this.code = code;
    this.hint = hint || '';
  }
}

function nowIso() {
  return new Date().toISOString();
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isAbort(err) {
  return !!(err && (err.name === 'AbortError' || err.name === 'TimeoutError' || /aborted|abort/i.test(String(err.message || ''))));
}

function mustKeepRepairPrompt() {
  try {
    return fs.readFileSync(MUSTKEEP_PROMPT, 'utf8');
  } catch {
    return '';
  }
}

function promptText() {
  try {
    return fs.readFileSync(PROMPT, 'utf8');
  } catch {
    return '';
  }
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function assertActive(job) {
  if (job.cancelled) throw new GenerationError('E_CANCELLED', '已取消');
}

/* ------------------------------ 分批 ------------------------------ */

function sliceTextOf(chapter, slice) {
  const text = String((chapter && chapter.text) || '');
  if (!slice || Number(slice.chapter) !== Number(chapter.n)) return text;
  const from = clamp(Math.round(Number(slice.from) || 0), 0, text.length);
  const to = clamp(Math.round(Number(slice.to) || text.length), from, text.length);
  return text.slice(from, to);
}

/**
 * 把一讲切成模型批：单批 ≤1.2 万字；单章超长按 8 千字切、批间带 300 字。
 * 与 1.x 的 planBatches 同规则，但支持讲纲的章内 slice（上/中/下）。
 */
export function planLectureBatches(lecture, chapterMap) {
  const limit = BATCH_CHARS;
  const split = SPLIT_CHARS;
  const batches = [];
  let current = null;

  const flush = () => {
    if (current && current.chapters.length && current.text.trim()) batches.push(current);
    current = null;
  };

  for (const rawN of (lecture && lecture.chapters) || []) {
    const chapter = chapterMap.get(Number(rawN));
    if (!chapter) throw new GenerationError('E_NO_CHAPTER', '找不到第 ' + rawN + ' 章', '章节可能被重切过，重新规划讲纲。');
    const slice = lecture.slice && Number(lecture.slice.chapter) === Number(chapter.n) ? lecture.slice : null;
    const text = sliceTextOf(chapter, slice);
    if (!text.trim()) continue;
    const unit = {
      chapter: { n: Number(chapter.n), title: String(chapter.title || ''), from: Number(chapter.from), to: Number(chapter.to) },
      text,
    };

    if (text.length > limit) {
      flush();
      const pieces = splitLongTextLike(text, split);
      pieces.forEach((piece, index) => {
        batches.push({
          chapters: [unit.chapter],
          text: piece.text,
          context: piece.carry,
          chars: piece.text.length,
          part: pieces.length > 1 ? { index: index + 1, total: pieces.length } : null,
          minPage: unit.chapter.from,
          maxPage: unit.chapter.to,
        });
      });
      continue;
    }

    if (!current) current = { chapters: [], text: '', chars: 0, context: '', part: null, minPage: Infinity, maxPage: 0 };
    if (current.text && current.text.length + 2 + text.length > limit) flush();
    if (!current) current = { chapters: [], text: '', chars: 0, context: '', part: null, minPage: Infinity, maxPage: 0 };
    if (!current.chapters.some((item) => Number(item.n) === Number(unit.chapter.n))) current.chapters.push(unit.chapter);
    current.text += (current.text ? '\n\n' : '') + text;
    current.chars = current.text.length;
    current.minPage = Math.min(current.minPage, unit.chapter.from);
    current.maxPage = Math.max(current.maxPage, unit.chapter.to);
  }
  flush();

  if (!batches.length) throw new GenerationError('E_NO_TEXT', '这一讲的章节没有可用的文字', '换一章或重新分章后再试。');
  return batches.map((batch, index) => Object.assign({}, batch, {
    index,
    minPage: Number.isFinite(batch.minPage) ? batch.minPage : 1,
    maxPage: batch.maxPage || 1,
  }));
}

/** 与 1.x splitLongText 同规则，单独放一份避免生成路径依赖旧模块的其它导出。 */
function splitLongTextLike(text, limit) {
  const cap = Math.max(500, Math.round(Number(limit) || SPLIT_CHARS));
  const paragraphs = String(text || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const chunks = [];
  let cur = '';
  const flush = () => {
    if (cur.trim()) chunks.push(cur);
    cur = '';
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > cap) {
      flush();
      for (let at = 0; at < paragraph.length; at += cap) {
        const piece = paragraph.slice(at, at + cap);
        if (at + cap < paragraph.length) chunks.push(piece);
        else cur = piece;
      }
      continue;
    }
    if (cur && cur.length + 1 + paragraph.length > cap) flush();
    cur = cur ? cur + '\n' + paragraph : paragraph;
  }
  flush();
  return chunks.map((piece, index) => ({
    text: piece,
    carry: index > 0 ? chunks[index - 1].slice(-CARRY_CHARS) : '',
  }));
}

/** 节标题归一：只用于匹配/去重。 */
function normalizeSectionKey(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[−–—－]/g, '-')
    .replace(/[.．、]/g, '.')
    .toLowerCase();
}

/**
 * 这一批文本落在原书哪些页。
 * 拆批时 batch.text 是 chapter.text 的连续子串；用它反推页范围，
 * 这样【本批覆盖】不再错误地写成整章 23–42。
 */
function pageRangeOfBatchText(chapter, text, pages) {
  const fallback = { from: Number(chapter.from) || 1, to: Number(chapter.to) || Number(chapter.from) || 1 };
  const source = String((chapter && chapter.text) || '');
  const piece = String(text || '');
  if (!source || !piece) return fallback;
  const at = source.indexOf(piece);
  if (at < 0) return fallback;
  const bookPages = (Array.isArray(pages) ? pages : [])
    .filter((page) => Number(page.page) >= fallback.from && Number(page.page) <= fallback.to)
    .sort((a, b) => Number(a.page) - Number(b.page));
  if (!bookPages.length) return fallback;
  let cursor = 0;
  const ranges = bookPages.map((page) => {
    const start = cursor;
    const end = cursor + String(page.text || '').length;
    cursor = end + 1; // chapter.text 用 \n 连接页
    return { page: Number(page.page), start, end };
  });
  const endAt = at + Math.max(0, piece.length - 1);
  const first = ranges.find((range) => at >= range.start && at <= range.end) || ranges[0];
  const last = ranges.find((range) => endAt >= range.start && endAt <= range.end) || ranges[ranges.length - 1];
  return { from: first.page, to: Math.max(first.page, last.page) };
}

/**
 * 给每批标上“本批覆盖小节 / 承接小节 / 实际页范围”。
 * 这是验证 2 的关键：生成 prompt 不再只看到一句 goal 和整章，
 * 而是看到本批必须覆盖的节清单。
 */
function annotateBatchSections(batches, lecture, chapterMap, pages) {
  const sections = Array.isArray(lecture && lecture.sections) ? lecture.sections : [];
  if (!sections.length) return batches;
  for (const batch of batches) {
    let minPage = Infinity;
    let maxPage = 0;
    for (const chapterRef of batch.chapters || []) {
      const chapter = chapterMap.get(Number(chapterRef.n));
      if (!chapter) continue;
      const range = pageRangeOfBatchText(chapter, batch.text, pages);
      minPage = Math.min(minPage, range.from);
      maxPage = Math.max(maxPage, range.to);
    }
    if (Number.isFinite(minPage)) {
      batch.minPage = minPage;
      batch.maxPage = maxPage || minPage;
    }
    const inRange = sections.filter(
      (section) => Number(section.page) >= batch.minPage && Number(section.page) <= batch.maxPage,
    );
    const textNorm = normalizeSectionKey(batch.text);
    const byText = sections.filter((section) => textNorm.includes(normalizeSectionKey(section.title)));
    const merged = inRange.slice();
    for (const section of byText) {
      if (!merged.some((item) => item.title === section.title)) merged.push(section);
    }
    batch.sections = merged;
    if (batch.index > 0) {
      const before = sections
        .filter((section) => Number(section.page) < batch.minPage)
        .sort((a, b) => Number(b.page) - Number(a.page))[0];
      if (before) batch.carrySection = before.title;
    }
  }
  return batches;
}

function targetPages(lecture, totalChars, batchChars, isFirst, batchSections) {
  const total = clamp(Math.round(Number(lecture.pages) || Math.round(totalChars / 2000)), MIN_SLIDES, MAX_SLIDES);
  const sections = Array.isArray(lecture && lecture.sections) ? lecture.sections : [];
  const current = Array.isArray(batchSections) ? batchSections : [];
  let share;
  const currentPages = current.reduce((sum, section) => sum + (Number(section.pages) || 1), 0);
  if (sections.length && currentPages) {
    // 节页数由讲纲分配；本批页数 = 本批小节页数之和 + 首批封面。
    share = currentPages + (isFirst ? 1 : 0);
  } else {
    share = Math.round((total * (Number(batchChars) || 0)) / Math.max(1, Number(totalChars) || 1));
  }
  return { total, share: clamp(share, isFirst ? 2 : 1, 12) };
}

/* ------------------------------ 提示词 ------------------------------ */

function termsLine(terms) {
  return (Array.isArray(terms) ? terms : [])
    .map((term) => {
      const forbid = Array.isArray(term.forbid) && term.forbid.length ? '（禁用：' + term.forbid.join('、') + '）' : '';
      return String(term.name || '') + forbid;
    })
    .filter(Boolean)
    .join('；');
}

export function buildLectureMessages({ book, series, lecture, batch, totalBatches, target, covered }) {
  const isFirst = batch.index === 0;
  const chapterNos = batch.chapters.map((chapter) => '第 ' + chapter.n + ' 章').join('、');
  const chapterRange = Number(batch.minPage) > 0 && Number(batch.maxPage) >= Number(batch.minPage)
    ? '第 ' + batch.minPage + '–' + batch.maxPage + ' 页'
    : (batch.chapters.length
      ? '第 ' + batch.chapters[0].from + '–' + batch.chapters[batch.chapters.length - 1].to + ' 页'
      : '');
  const seamPrev = (series.seams || []).find((s) => Number(s.to) === Number(lecture.n));
  const seamNext = (series.seams || []).find((s) => Number(s.from) === Number(lecture.n));
  const previous = (series.lectures || [])
    .filter((item) => Number(item.n) < Number(lecture.n))
    .map((item) => String(item.title || '第 ' + item.n + ' 讲'))
    .join('、');
  const lines = [
    '【书名】' + String((book && book.title) || ''),
    '【系列】' + String(series.title || '') + '（共 ' + (series.lectures || []).length + ' 讲）',
    '【本讲】第 ' + lecture.n + '/' + (series.lectures || []).length + ' 讲：' + String(lecture.title || ''),
    '【本讲目标】' + String(lecture.goal || '') + '；【已知】' + String(lecture.in || '') + '；【讲完应会】' + String(lecture.out || ''),
    '【本部分主线】' + String(series.throughline || ''),
    '【已讲概念】' + ((covered && covered.terms && covered.terms.length) ? covered.terms.join('、') + ' —— 不要重新定义，用一句话唤起即可。' : '无'),
  ];
  if (previous) lines.push('【前几讲】' + previous);
  if (termsLine(series.terms)) lines.push('【术语】' + termsLine(series.terms));
  if (seamPrev && seamPrev.sentence) lines.push('【封面首句】必须逐字以这句开头：' + seamPrev.sentence);
  if (seamNext && seamNext.sentence) lines.push('【末页末句】必须逐字以这句结尾：' + seamNext.sentence);
  const sectionLines = [];
  if (Array.isArray(lecture.sections) && lecture.sections.length) {
    const describeSection = (section) => {
      const keep = Array.isArray(section.must_keep) && section.must_keep.length
        ? '；must_keep: ' + section.must_keep.join('、')
        : '';
      return section.title + '（' + (Number(section.pages) || 1) + ' 页' + keep + '）';
    };
    sectionLines.push('【本讲页预算】' + target.total + ' 页（每节 1–5 页，按节页分配）');
    sectionLines.push('【全讲节清单（仅用于定位，不属于本批的不要写）】' + lecture.sections.map(describeSection).join('；'));
    if (Array.isArray(batch.sections) && batch.sections.length) {
      sectionLines.push('【本批必须覆盖】' + batch.sections.map(describeSection).join('；'));
    }
    if (batch.carrySection) {
      sectionLines.push('【承接小节】' + batch.carrySection + '（上一批可能没讲完，先用一两句话收尾，不要重复已讲内容）');
    }
    if (Array.isArray(batch.previousSections) && batch.previousSections.length) {
      sectionLines.push('【已覆盖小节】' + batch.previousSections.join('；') + ' —— 不要重复讲。');
    }
    sectionLines.push('【本批只写】只写【本批必须覆盖】和【承接小节】；【全讲节清单】里其它小节不要写，不要输出“待续/后续再讲/本批回顾/下节预告”这类占位页。');
    sectionLines.push('【页级字段】每个 content_text/quote 页必须给 "section": "本批某节标题"（或承接小节标题），并给 "page_role": "concept|example|formula|graph"；跨节页才用 "page_role":"bridge" + "sections":["节1","节2"]。');
  }
  lines.push(
    '【本批覆盖】' + chapterNos + '（' + chapterRange + '）' + (batch.part ? ' · 本章第 ' + batch.part.index + '/' + batch.part.total + ' 段' : ''),
    '【本批建议页数】' + target.share + ' 页（整讲约 ' + target.total + ' 页，' + MIN_SLIDES + '–' + MAX_SLIDES + ' 页）',
    ...sectionLines,
    '【本批原文】',
    batch.chapters.map((chapter) => '【第 ' + chapter.n + ' 章 ' + String(chapter.title || '').trim() + '】').join('\n'),
    batch.text,
  );
  if (batch.context) {
    lines.push('【衔接上下文】下面是上一批的末尾，只用来理解上下文，不要从这里摘抄 source_quote：');
    lines.push(batch.context);
  }
  if (batch.previous) {
    lines.push('【上一批要点】' + String(batch.previous.title || '') + (batch.previous.points && batch.previous.points.length ? '：' + batch.previous.points.join('；') : ''));
  }
  if (!isFirst) {
    lines.push('【批缝】本批第 1 页的 audio_script 必须先用一句话承接上一批的落点，再进入本批内容。');
  }
  lines.push(
    isFirst
      ? '【版式要求】本批是整讲第一批：第 1 页必须 layout=cover；其余页在 content_text 与 quote 之间交替，quote 不超过本批页数的三分之一。'
      : '【版式要求】本批不是整讲第一批：不要输出 cover，只用 content_text 与 quote，quote 不超过本批页数的三分之一。',
  );
  lines.push('【输出】严格 JSON，不要 Markdown 围栏，不要解释。每页都给出 source_quote，且必须逐字抄自上面的【本批原文】。');
  return { system: promptText(), user: lines.join('\n'), isFirst, batchIndex: batch.index, totalBatches };
}

/* ------------------------------ 模型调用 ------------------------------ */

/** 生成单次模型调用超时；默认 180s，可用 DSH_BOOK_SLIDES_LLM_TIMEOUT_MS 调低（AC-135）。 */
function llmTimeoutMs() {
  const raw = Number(process.env.DSH_BOOK_SLIDES_LLM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 180000;
}

async function ask(job, ctx, system, user, { maxTokens = LLM_MAX_TOKENS, timeoutMs = llmTimeoutMs(), stage = 'lecture' } = {}) {
  assertActive(job);
  try {
    return await callModel(ctx, system, user, { maxTokens, timeoutMs, signal: job.controller.signal, stage });
  } catch (err) {
    if (job.cancelled) throw new GenerationError('E_CANCELLED', '已取消');
    if (err instanceof GenerationError) throw err;
    if (isAbort(err)) {
      if (job.controller && job.controller.signal.aborted) throw new GenerationError('E_CANCELLED', '已取消');
      throw new GenerationError('E_LLM_TIMEOUT', '模型响应超时', '检查网络或模型配置后重试。');
    }
    throw new GenerationError('E_LLM_FAIL', '模型调用失败', String((err && err.message) || err).slice(0, 240));
  }
}

function describeEmpty(reply) {
  const reason = String((reply && reply.stopReason) || '');
  if (reason === 'max-tokens') return '模型输出被 max_tokens 截断，没有留下 JSON';
  return '模型返回了空内容';
}

async function generateBatch(batch, job, context) {
  const target = targetPages(context.lecture, context.totalChars, batch.chars, batch.index === 0, batch.sections);
  const messages = buildLectureMessages({
    book: context.book,
    series: context.series,
    lecture: context.lecture,
    batch,
    totalBatches: context.batches.length,
    target,
    covered: context.covered,
  });
  let budget = LLM_MAX_TOKENS;
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertActive(job);
    const user = attempt === 0 ? messages.user : messages.user + '\n\n【上一次的输出不合格】' + lastError + '\n这次不要分析、不要解释，直接输出 JSON。';
    const reply = await ask(job, context.ctx, messages.system, user, { maxTokens: budget });
    try {
      if (!String(reply.text || '').trim()) throw new Error(describeEmpty(reply));
      const parsed = parseSlidesReply(reply.text);
      return parsed.slides;
    } catch (err) {
      lastError = String((err && err.message) || err);
      if (reply.stopReason === 'max-tokens') {
        budget = LLM_RETRY_MAX_TOKENS;
        lastError += '（输出被 max_tokens 截断，这次已加大预算）';
      }
    }
  }
  throw new GenerationError('E_LLM_JSON', '模型输出格式异常，已重试', lastError.slice(0, 320));
}

async function validateBatch(batch, slides, job, context) {
  const check = {
    text: batch.text,
    totalPages: context.pages.length,
    minPage: batch.minPage,
    maxPage: batch.maxPage,
    allowCover: batch.index === 0,
    requireCover: batch.index === 0,
    allowedSections: (context.lecture.sections || []).map((section) => section.title),
    requireSection: (context.lecture.sections || []).length > 0,
  };
  const errors = validateSlides(slides, check);
  const hard = errors.filter((error) => error.hard);
  if (!hard.length) return slides;
  const messages = buildRepairMessages({
    promptFile: context.prompt,
    book: context.book,
    moduleTitle: context.lecture.title,
    sourceText: batch.text,
    slides,
    errors: hard,
  });
  messages.user += batch.index === 0
    ? '\n【版式】本批是整讲第一批，第 1 页必须是 cover。'
    : '\n【版式】本批不是整讲第一批，不能输出 cover。';
  const reply = await ask(job, context.ctx, messages.system, messages.user, { maxTokens: LLM_RETRY_MAX_TOKENS });
  let repaired;
  try {
    repaired = parseSlidesReply(reply.text);
  } catch (err) {
    throw new GenerationError('E_LLM_SCHEMA', '修复调用没有返回合法 JSON', String((err && err.message) || err).slice(0, 240));
  }
  const again = validateSlides(repaired.slides, check);
  const still = again.filter((error) => error.hard);
  if (still.length) {
    throw new GenerationError(
      'E_LLM_SCHEMA',
      '生成内容不合规（修复后仍有 ' + still.length + ' 处问题）',
      formatSlideErrors(still).slice(0, 320),
    );
  }
  return repaired.slides;
}

async function repairLectureSet(slides, job, context, setErrors, lectureText) {
  const messages = buildRepairMessages({
    promptFile: context.prompt,
    book: context.book,
    moduleTitle: context.lecture.title,
    sourceText: lectureText,
    slides,
    errors: setErrors.map((message) => ({ index: -1, message: String(message) })),
  });
  const reply = await ask(job, context.ctx, messages.system, messages.user, { maxTokens: LLM_RETRY_MAX_TOKENS });
  try {
    return parseSlidesReply(reply.text).slides;
  } catch (err) {
    throw new GenerationError('E_LLM_SCHEMA', '整套修复没有返回合法 JSON', String((err && err.message) || err).slice(0, 240));
  }
}

/* ------------------------------ 预缝 ------------------------------ */

async function repairSeamPage(job, context, { role, sentence, slide }) {
  const base = String((slide && slide.audio_script) || '');
  if (context.ctx) {
    const user = [
      '【任务】只重写这一页的 audio_script，不改其它字段、不改页序。',
      '【本讲】第 ' + context.lecture.n + ' 讲 · ' + String(context.lecture.title || ''),
      role === 'cover' ? '【必须】以这句逐字开头：' + sentence : '【必须】以这句逐字结尾：' + sentence,
      '【字数】' + AUDIO_MIN + '–' + AUDIO_MAX + ' 字。',
      '【本页原 JSON】',
      JSON.stringify(slide),
      '【输出】只输出 {"audio_script":"……"}，不要解释。',
    ].join('\n');
    try {
      const reply = await ask(job, context.ctx, context.prompt, user, { maxTokens: 4000 });
      const data = readJsonBlock(reply.text);
      const script = String((data && data.audio_script) || '').trim();
      const fits = script.length >= AUDIO_MIN && script.length <= AUDIO_MAX;
      const matches = role === 'cover' ? script.startsWith(sentence) : script.endsWith(sentence);
      if (fits && matches) return { script, via: 'model', repairs: 1 };
      if (fits) return { script: withSeamSentence(role, script, sentence), via: 'deterministic', repairs: 1 };
    } catch (err) {
      if (err.code === 'E_CANCELLED') throw err;
      /* 页级模型修复失败：落回确定性修复，不让整讲失败 */
    }
  }
  return { script: withSeamSentence(role, base, sentence), via: 'deterministic', repairs: 1 };
}

async function applySeamContract(job, context, slides) {
  const list = slides.slice();
  let repairs = 0;
  const details = [];
  const seamPrev = (context.series.seams || []).find((s) => Number(s.to) === Number(context.lecture.n));
  const seamNext = (context.series.seams || []).find((s) => Number(s.from) === Number(context.lecture.n));

  if (seamPrev && seamPrev.sentence) {
    const cover = list[0];
    if (!String((cover && cover.audio_script) || '').trim().startsWith(seamPrev.sentence)) {
      assertActive(job);
      job.message = '正在修第 ' + context.lecture.n + ' 讲封面接缝句';
      const out = await repairSeamPage(job, context, { role: 'cover', sentence: seamPrev.sentence, slide: cover });
      list[0] = Object.assign({}, cover, { audio_script: out.script });
      repairs += out.repairs;
      details.push({ page: 1, role: 'cover', via: out.via });
    }
  }
  if (seamNext && seamNext.sentence) {
    const index = list.length - 1;
    const last = list[index];
    if (!String((last && last.audio_script) || '').trim().endsWith(seamNext.sentence)) {
      assertActive(job);
      job.message = '正在修第 ' + context.lecture.n + ' 讲末页接缝句';
      const out = await repairSeamPage(job, context, { role: 'last', sentence: seamNext.sentence, slide: last });
      list[index] = Object.assign({}, last, { audio_script: out.script });
      repairs += out.repairs;
      details.push({ page: index + 1, role: 'last', via: out.via });
    }
  }
  return { slides: list, repairs, details };
}

/* ------------------------------ 讲后质量审计 ------------------------------ */

function sectionPageRange(lecture, section, maxPage) {
  const sections = (lecture.sections || []).slice().sort((a, b) => Number(a.page) - Number(b.page));
  const index = sections.findIndex((item) => normalizeSectionKey(item.title) === normalizeSectionKey(section.title));
  const from = Number(section.page) || 1;
  const next = index >= 0 ? sections[index + 1] : null;
  // 节可以从书签页中途开始，允许覆盖到下一节的书签页（inclusive），
  // 避免 1.1.2/1.1.3 这种共享页被误判为冒充；真正的跨节复用仍在范围外。
  const to = next ? Math.max(from, Number(next.page) || from) : Math.max(from, Number(maxPage) || from);
  return { from, to };
}

function mustKeepAliasCovered(term, text, aliases) {
  const value = normalizeSectionKey(text);
  const rule = (aliases || []).find((item) => normalizeSectionKey(item.term) === normalizeSectionKey(term));
  if (!rule) return false;
  const all = (rule.all || []).every((item) => value.includes(normalizeSectionKey(item)));
  const any = (rule.any || []).some((item) => value.includes(normalizeSectionKey(item)));
  return rule.all ? all : any;
}

function shingleSet(text, size = 6) {
  const value = normalizeSectionKey(text);
  const out = new Set();
  for (let i = 0; i + size <= value.length; i += 1) out.add(value.slice(i, i + size));
  return out;
}

function overlapRate(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const item of a) if (b.has(item)) hit += 1;
  return hit / Math.min(a.size, b.size);
}

/**
 * 讲后软审计：不阻断生成，但把“丢节/凑页/占位/冒充/超预算/讲内重复”落进 slides.json。
 * 验证 2.1 用它验收；后续可以按这些字段触发页级修复。
 */
export function auditSections(slides, lecture, maxPage, aliases = null) {
  const aliasList = Array.isArray(aliases) ? aliases : readMustKeepAliases();
  const sections = Array.isArray(lecture.sections) ? lecture.sections : [];
  const bySection = new Map(sections.map((section) => [normalizeSectionKey(section.title), section]));
  const textBySection = new Map();
  const missingSections = [];
  const missingMustKeep = [];
  const mustKeepAliases = [];
  const mustKeepRealMissing = [];
  const placeholders = [];
  const impersonations = [];
  const summaryPages = [];
  const bridgePages = [];
  const normalizedPages = [];
  const placeholderRe = /待续|后续再讲|本批回顾|下节预告|略过|本页不展开/;

  slides.forEach((slide, index) => {
    const text = [
      slide.title,
      slide.subtitle || '',
      ...(slide.bullet_points || []),
      slide.quote_text || '',
      slide.quote_source || '',
      slide.audio_script || '',
    ].join('\n');
    normalizedPages.push(shingleSet(text));
    if (placeholderRe.test(text)) placeholders.push({ page: index + 1, title: slide.title });
    if (slide.page_role === 'summary' && index !== slides.length - 1) {
      summaryPages.push({ page: index + 1, title: slide.title });
    }
    if (slide.page_role === 'bridge') bridgePages.push({ page: index + 1, title: slide.title, sections: slide.sections || [] });
    if (slide.layout === 'cover') return;
    const section = bySection.get(normalizeSectionKey(slide.section));
    if (!section) {
      impersonations.push({ page: index + 1, title: slide.title, reason: 'section 不在本讲 leaf 清单', section: slide.section || '', hard: true });
      return;
    }
    const range = sectionPageRange(lecture, section, maxPage);
    const page = Number(slide.source_anchor && slide.source_anchor.page) || Number(slide.source_pages && slide.source_pages.from) || 0;
    if (page && (page < range.from || page > range.to)) {
      const distance = page < range.from ? range.from - page : page - range.to;
      impersonations.push({ page: index + 1, title: slide.title, section: section.title, source_page: page, range, distance, hard: distance > 1 });
    }
    textBySection.set(section.title, (textBySection.get(section.title) || '') + '\n' + text);
  });

  for (const section of sections) {
    const text = textBySection.get(section.title) || '';
    if (!text.trim()) missingSections.push(section.title);
    for (const keep of section.must_keep || []) {
      if (text && normalizeSectionKey(text).includes(normalizeSectionKey(keep))) continue;
      const item = { section: section.title, must_keep: keep };
      missingMustKeep.push(item);
      if (text && mustKeepAliasCovered(keep, text, aliasList)) mustKeepAliases.push(item);
      else mustKeepRealMissing.push(item);
    }
  }

  let duplicatePages = 0;
  for (let i = 0; i < normalizedPages.length; i += 1) {
    for (let j = i + 1; j < normalizedPages.length; j += 1) {
      if (overlapRate(normalizedPages[i], normalizedPages[j]) > 0.5) duplicatePages += 1;
    }
  }

  // 4-lite 软密度指标：只报告，不参与 content_ok。
  const contentSlides = slides.filter((slide) => slide.layout !== 'cover');
  const audioShortPages = [];
  const bulletShortPages = [];
  const quoteShortPages = [];
  const thinPages = [];
  let contentChars = 0;
  let audioChars = 0;
  slides.forEach((slide, index) => {
    const bullets = (slide.bullet_points || []).join('');
    const pageChars = String(slide.title || '').length + bullets.length
      + String(slide.quote_text || '').length + String(slide.quote_source || '').length
      + String(slide.audio_script || '').length;
    contentChars += pageChars;
    audioChars += String(slide.audio_script || '').length;
    if (slide.layout === 'cover') return;
    if (String(slide.audio_script || '').length < 160) audioShortPages.push(index + 1);
    if (slide.layout === 'content_text') {
      const list = slide.bullet_points || [];
      if (list.length < 4 || list.some((bullet) => String(bullet).length < 25)) bulletShortPages.push(index + 1);
    }
    if (slide.layout === 'quote' && String(slide.quote_text || '').length < 80) quoteShortPages.push(index + 1);
    if (pageChars < 220) thinPages.push(index + 1);
  });
  const density = {
    content_chars: contentChars,
    content_pages: contentSlides.length,
    avg_content_chars: Math.round(contentChars / Math.max(1, contentSlides.length)),
    avg_audio_chars: Math.round(audioChars / Math.max(1, contentSlides.length)),
    audio_short_pages: audioShortPages,
    bullet_short_pages: bulletShortPages,
    quote_short_pages: quoteShortPages,
    thin_pages: thinPages,
    density_ok: audioShortPages.length === 0
      && bulletShortPages.length === 0
      && quoteShortPages.length === 0
      && thinPages.length === 0,
  };

  const plannedPages = Number(lecture.planned_pages) || Number(lecture.pages) || 0;
  const hardImpersonations = impersonations.filter((item) => item.hard !== false);
  // 页数超预算只报告、不参与 content_ok（用户明确：19→24 不做强制修复）。
  const contentOk = missingSections.length === 0
    && mustKeepRealMissing.length === 0
    && placeholders.length === 0
    && hardImpersonations.length === 0
    && summaryPages.length === 0
    && duplicatePages === 0;
  const quality = {
    planned_pages: plannedPages,
    actual_pages: slides.length,
    page_count_ok: plannedPages > 0 ? Math.abs(slides.length - plannedPages) <= 2 : true,
    over_budget: plannedPages > 0 && slides.length > plannedPages + 2,
    content_ok: contentOk,
    missing_sections: missingSections,
    missing_must_keep: missingMustKeep,
    must_keep_aliases: mustKeepAliases,
    must_keep_real_missing: mustKeepRealMissing,
    placeholders,
    impersonations,
    hard_impersonations: hardImpersonations,
    summary_pages: summaryPages,
    bridge_pages: bridgePages,
    duplicate_pairs: duplicatePages,
    density,
    density_ok: density.density_ok,
    ok: contentOk,
  };
  return quality;
}

/**
 * 质量修复（确定性，不调模型）：
 * - 只处理“硬冒充/占位/错位 summary”；
 * - 仅当同一 section 还有其它有效页时才删除该页，避免把一节删空；
 * - 不按计划页数删正常页（用户明确：19→24 不做强制修复）。
 */
function repairQualityPages(slides, lecture, maxPage) {
  const initial = auditSections(slides, lecture, maxPage);
  const drop = new Set();
  const badPages = [
    ...(initial.hard_impersonations || []),
    ...(initial.placeholders || []),
    ...(initial.summary_pages || []),
  ];
  const flagged = new Set(badPages.map((item) => Number(item.page)));
  for (const issue of badPages) {
    const index = Number(issue.page) - 1;
    if (index <= 0 || index >= slides.length - 1) continue;
    const sectionKey = normalizeSectionKey(issue.section || (slides[index] && slides[index].section));
    let otherValid = 0;
    slides.forEach((slide, i) => {
      if (i === index || i === 0 || i === slides.length - 1) return;
      if (normalizeSectionKey(slide.section) !== sectionKey) return;
      if (flagged.has(i + 1)) return;
      otherValid += 1;
    });
    if (otherValid > 0) drop.add(index);
  }
  if (!drop.size) return { slides, dropped: [] };
  const kept = slides
    .filter((_, index) => !drop.has(index))
    .map((slide, index) => Object.assign({}, slide, { slide_index: index + 1 }));
  return { slides: kept, dropped: Array.from(drop).sort((a, b) => a - b).map((index) => index + 1) };
}

async function rewriteMustKeepPage(job, context, target, section, source, mustKeeps) {
  const system = mustKeepRepairPrompt();
  if (!system) throw new Error('缺少 must_keep 修复提示词');
  const keeps = Array.isArray(mustKeeps) ? mustKeeps.filter(Boolean) : [mustKeeps].filter(Boolean);
  const user = JSON.stringify({
    page: {
      title: target.title,
      layout: target.layout,
      bullet_points: target.bullet_points || [],
      audio_script: target.audio_script || '',
      section: target.section,
      source_pages: target.source_pages,
    },
    must_keep: keeps,
    section_title: section.title,
    source: String(source || '').slice(0, 4000),
  });
  const reply = await ask(job, context.ctx, system, user, { maxTokens: 3000, stage: 'repair' });
  const data = readJsonBlock(reply.text);
  const bullets = (Array.isArray(data.bullet_points) ? data.bullet_points : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 5);
  const audio = String(data.audio_script || '').trim();
  if (!audio || audio.length > AUDIO_MAX) throw new Error('补讲口播为空或超长');
  const joined = bullets.join('\n') + '\n' + audio;
  const missing = keeps.filter((keep) => !joined.includes(keep));
  if (missing.length) throw new Error('补讲没有覆盖 must_keep：' + missing.join('、'));
  return { bullet_points: bullets, audio_script: audio };
}

/**
 * 定点补 must_keep：只改该 section 的一页，不增页、不改 section。
 * 3.1：有模型时先让模型改写该页；失败回退到“原文短句追加”的确定性补讲。
 */
export async function repairMissingMustKeep(slides, lecture, chapterMap, pages, maxPage, options = {}) {
  const before = auditSections(slides, lecture, maxPage);
  const real = before.must_keep_real_missing || [];
  if (!real.length) return { slides, repaired: [] };
  const working = slides.map((slide) => Object.assign({}, slide, {
    bullet_points: [...(slide.bullet_points || [])],
    sections: [...(slide.sections || [])],
  }));
  // 同一页可能缺多个 must_keep：按页分组一次处理，避免后一次模型改写覆盖前一次补讲。
  const groups = new Map();
  for (const item of real) {
    const section = (lecture.sections || []).find(
      (entry) => normalizeSectionKey(entry.title) === normalizeSectionKey(item.section),
    );
    if (!section) continue;
    const target = working.find(
      (slide) => slide.layout === 'content_text'
        && normalizeSectionKey(slide.section) === normalizeSectionKey(item.section),
    );
    if (!target) continue;
    const key = target.slide_index + '|' + normalizeSectionKey(section.title);
    if (!groups.has(key)) {
      const range = sectionPageRange(lecture, section, maxPage);
      const source = (Array.isArray(pages) ? pages : [])
        .filter((page) => Number(page.page) >= range.from && Number(page.page) <= range.to)
        .map((page) => String(page.text || ''))
        .join('\n');
      groups.set(key, { section, target, source, items: [] });
    }
    groups.get(key).items.push(item);
  }

  const repaired = [];
  for (const group of groups.values()) {
    const { section, target, source } = group;
    const keeps = group.items.map((item) => item.must_keep);
    if (options.job && options.context && options.context.ctx) {
      try {
        const rewritten = await rewriteMustKeepPage(
          options.job,
          options.context,
          target,
          section,
          source,
          keeps,
        );
        target.bullet_points = rewritten.bullet_points;
        target.audio_script = rewritten.audio_script;
        for (const item of group.items) {
          repaired.push({
            section: item.section,
            must_keep: item.must_keep,
            page: target.slide_index,
            mode: 'model',
          });
        }
        continue;
      } catch {
        /* 模型改写失败时走确定性原文补讲 */
      }
    }
    for (const item of group.items) {
      let sentence = '';
      for (const part of source.split(/[。！？\n]/)) {
        const value = part.trim();
        // 跳过“1.2.4 反函数的反函数”这类标题行，优先取正文句。
        if (/^\d+(?:\.\d+)+\s/.test(value)) continue;
        if (value && value.includes(item.must_keep) && value.length <= 60) {
          sentence = value;
          break;
        }
      }
      if (!sentence) sentence = item.must_keep;
      if (target.bullet_points.length < 5 && sentence.length <= 40) {
        target.bullet_points.push(sentence);
      } else {
        const extra = (target.audio_script || '').endsWith('。') ? sentence + '。' : '。' + sentence + '。';
        if (String(target.audio_script || '').length + extra.length <= 220) {
          target.audio_script = String(target.audio_script || '') + extra;
        } else if (target.bullet_points.length < 5) {
          target.bullet_points.push(sentence.slice(0, 40));
        } else {
          continue;
        }
      }
      repaired.push({ section: item.section, must_keep: item.must_keep, page: target.slide_index, sentence });
    }
  }
  return {
    slides: working.map((slide, index) => Object.assign({}, slide, { slide_index: index + 1 })),
    repaired,
  };
}

/* ------------------------------ 讲级生成 ------------------------------ */

function checkpointFile(dir, n, index) {
  return path.join(batchesDir(dir, n), String(index).padStart(2, '0') + '.json');
}

function readCheckpoint(dir, n, index, hash) {
  const data = readJson(checkpointFile(dir, n, index), null);
  if (!data || data.hash !== hash || !Array.isArray(data.slides) || !data.slides.length) return null;
  return data.slides;
}

function writeCheckpoint(dir, n, index, hash, slides) {
  try {
    writeJson(checkpointFile(dir, n, index), { hash, slides, saved_at: nowIso() });
  } catch {
    /* 检查点写不进去只影响重试成本 */
  }
}

function lectureKeyOf(series, lecture, model) {
  return sha256([
    series.id,
    Number(series.plan_version) || 0,
    String(series.throughline || ''),
    JSON.stringify(series.terms || []),
    lecture.n,
    JSON.stringify({
      chapters: lecture.chapters,
      slice: lecture.slice || null,
      pages: Number(lecture.planned_pages) || Number(lecture.pages),
      title: lecture.title,
      goal: lecture.goal,
      in: lecture.in,
      out: lecture.out,
      sections: (lecture.sections || []).map((section) => [section.title, section.pages, section.must_keep || []]),
    }),
    String((model && model.provider) || ''),
    String((model && model.model) || ''),
    LECTURE_PROMPT_VERSION,
  ].join('|'));
}

function coveredConcepts(series, dir, n) {
  const terms = new Set();
  for (const item of series.lectures || []) {
    if (Number(item.n) >= Number(n)) continue;
    const doc = loadLecture(dir, item.n);
    const slides = (doc.slidesDoc && doc.slidesDoc.slides) || [];
    const text = slides
      .map((slide) => [slide.title, ...(slide.bullet_points || []), slide.audio_script].join('\n'))
      .join('\n');
    for (const term of series.terms || []) {
      if (term.name && text.includes(term.name)) terms.add(term.name);
    }
  }
  return { terms: Array.from(terms) };
}

function rememberPreviousBatch(batches, index, slides) {
  const next = batches[index + 1];
  if (!next || !Array.isArray(slides) || !slides.length) return;
  const points = [];
  for (const slide of slides) {
    for (const bullet of slide.bullet_points || []) {
      if (points.length < 6 && !points.includes(bullet)) points.push(String(bullet));
    }
  }
  next.previous = { title: String(slides[0].title || ''), points };
}

async function generateLecture(job, context, planLecture) {
  const { series, dir, chapterMap, pages, model } = context;
  const n = Number(planLecture.n);
  const key = lectureKeyOf(series, planLecture, model);
  const plannedPages = Number(planLecture.planned_pages) || Number(planLecture.pages) || MIN_SLIDES;
  const startedAt = nowIso();
  const stage = { structuring: false, validate: false, anchor: false };
  let meta = {
    schema: 1,
    series_id: series.id,
    n,
    lecture_id: series.id + '-' + n,
    title: String(planLecture.title || '第 ' + n + ' 讲'),
    chapters: (planLecture.chapters || []).map(Number),
    pages: plannedPages,
    planned_pages: plannedPages,
    actual_pages: null,
    chars: Number(planLecture.chars) || 0,
    status: 'queued',
    key,
    model: model.model,
    provider: model.provider,
    prompt_version: LECTURE_PROMPT_VERSION,
    started_at: startedAt,
    finished_at: null,
    stages: stage,
  };
  writeLectureMeta(dir, n, meta);
  patchSeriesLecture(series, n, {
    status: 'queued',
    code: null,
    error: null,
    pages: plannedPages,
    planned_pages: plannedPages,
    actual_pages: null,
    quality_summary: null,
  });
  persistSeries(series);

  try {
    const batches = planLectureBatches(planLecture, chapterMap);
    annotateBatchSections(batches, planLecture, chapterMap, pages);
    const totalChars = batches.reduce((sum, batch) => sum + batch.chars, 0);
    const lectureText = batches.map((batch) => batch.text).join('\n\n');
    const usedChapters = (planLecture.chapters || [])
      .map((chapterN) => chapterMap.get(Number(chapterN)))
      .filter(Boolean);
    const minPage = usedChapters.length ? Math.min(...usedChapters.map((chapter) => Number(chapter.from) || 1)) : 1;
    const maxPage = usedChapters.length ? Math.max(...usedChapters.map((chapter) => Number(chapter.to) || pages.length)) : pages.length;
    const pageTarget = clamp(plannedPages, MIN_SLIDES, MAX_SLIDES);

    const shared = Object.assign({}, context, {
      lecture: planLecture,
      batches,
      totalChars,
      minPage,
      maxPage,
      covered: coveredConcepts(series, dir, n),
    });

    /* 阶段 1：structuring */
    stage.structuring = true;
    meta.status = 'structuring';
    writeLectureMeta(dir, n, meta);
    patchSeriesLecture(series, n, { status: 'structuring' });
    persistSeries(series);
    job.stage = 'structuring';
    job.current = 0;
    job.total = pageTarget;
    job.message = '第 ' + n + ' 讲 · 正在改写原文';

    // 批检查点必须绑定“这一讲的讲纲契约”：只靠原文 + prompt 版本的话，
    // 改了 goal/throughline/terms 后旧批仍会命中，新讲纲永远进不了已生成的页。
    const contract = JSON.stringify({
      goal: planLecture.goal || '',
      in: planLecture.in || '',
      out: planLecture.out || '',
      throughline: series.throughline || '',
      terms: series.terms || [],
      sections: (planLecture.sections || []).map((section) => [section.title, section.pages, section.must_keep || []]),
    });

    const results = [];
    const previousSections = [];
    for (let index = 0; index < batches.length; index += 1) {
      assertActive(job);
      job.current = Math.min(pageTarget, Math.round(((index + 1) / batches.length) * pageTarget));
      job.total = pageTarget;
      batches[index].previousSections = previousSections.slice();
      const hash = sha256(
        [LECTURE_PROMPT_VERSION, context.model.provider, context.model.model, n, contract, batches[index].text].join('|'),
      );
      const cached = readCheckpoint(dir, n, index, hash);
      if (cached) {
        const normalized = cached.map((slide, at) => normalizeSlide(slide, at));
        results.push(normalized);
        for (const section of batches[index].sections || []) {
          if (!previousSections.includes(section.title)) previousSections.push(section.title);
        }
        rememberPreviousBatch(batches, index, normalized);
        job.message = '第 ' + n + ' 讲 · 复用已完成第 ' + (index + 1) + '/' + batches.length + ' 批';
        continue;
      }
      const generated = await generateBatch(batches[index], job, shared);
      const checked = await validateBatch(batches[index], generated, job, shared);
      writeCheckpoint(dir, n, index, hash, checked);
      results.push(checked);
      for (const section of batches[index].sections || []) {
        if (!previousSections.includes(section.title)) previousSections.push(section.title);
      }
      rememberPreviousBatch(batches, index, checked);
      job.message = '第 ' + n + ' 讲 · 已改写第 ' + (index + 1) + '/' + batches.length + ' 批';
    }

    /* 阶段 2：validate（批内硬错误已修；这里做整讲页数与封面） */
    stage.validate = true;
    meta.status = 'validate';
    writeLectureMeta(dir, n, meta);
    patchSeriesLecture(series, n, { status: 'validate' });
    persistSeries(series);
    job.stage = 'validate';
    job.current = 0;
    job.total = pageTarget;
    job.message = '第 ' + n + ' 讲 · 正在校验页数与封面';

    let slides = mergeBatchSlides(results.map((items) => ({ slides: items })));
    const setErrors = validateSlideSet(slides);
    if (setErrors.length) {
      assertActive(job);
      slides = await repairLectureSet(slides, job, shared, setErrors, lectureText);
      const again = validateSlideSet(slides);
      if (again.length) {
        throw new GenerationError('E_LLM_SCHEMA', '生成内容不合规（' + again.join('；') + '）', '');
      }
    }
    job.current = 1;

    /* 阶段 3：anchor */
    stage.anchor = true;
    meta.status = 'anchor';
    writeLectureMeta(dir, n, meta);
    patchSeriesLecture(series, n, { status: 'anchor' });
    persistSeries(series);
    job.stage = 'anchor';
    job.current = 0;
    job.total = slides.length;
    job.message = '第 ' + n + ' 讲 · 正在定位原文锚点';

    let anchored = anchorSlides(slides, pages, { minPage, maxPage });
    job.current = anchored.anchored;
    job.message = '第 ' + n + ' 讲 · 已定位 ' + anchored.anchored + '/' + slides.length + ' 页原文';

    if (anchored.hitRate < ANCHOR_REPAIR_THRESHOLD && anchored.unanchored > 0) {
      assertActive(job);
      try {
        const user = buildAnchorRepairUser({ slides: anchored.slides, text: lectureText.slice(0, ANCHOR_REPAIR_TEXT_LIMIT) });
        const reply = await ask(job, context.ctx, context.prompt, user, { maxTokens: ANCHOR_MAX_TOKENS });
        const fixes = parseAnchorFixes(reply.text);
        if (fixes.length) {
          const fixed = applyAnchorFixes(anchored.slides, fixes);
          const again = anchorSlides(fixed, pages, { minPage, maxPage });
          if (again.hitRate >= anchored.hitRate) anchored = again;
        }
      } catch (err) {
        if (err.code === 'E_CANCELLED') throw err;
        meta.anchor_repair_error = String((err && err.message) || err).slice(0, 200);
      }
    }

    /* 质量修复：只删“同节还有有效页”的硬冒充/占位页，不按计划页数删正常页 */
    job.stage = 'anchor';
    job.message = '第 ' + n + ' 讲 · 正在修复冒充/占位页';
    const repaired = repairQualityPages(anchored.slides, planLecture, maxPage);
    const mustKeepRepair = await repairMissingMustKeep(repaired.slides, planLecture, chapterMap, pages, maxPage, {
      job,
      context: shared,
    });

    /* 预缝：只修边界页 */
    job.message = '第 ' + n + ' 讲 · 正在写接缝句';
    const seams = await applySeamContract(job, shared, mustKeepRepair.slides);
    slides = seams.slides;
    const quality = auditSections(slides, planLecture, maxPage);
    quality.repair = {
      dropped_pages: repaired.dropped,
      repaired_must_keep: mustKeepRepair.repaired,
    };

    assertActive(job);
    const finishedAt = nowIso();
    const imageState = initialImageStatus();
    const withAudio = slides.map((slide) => Object.assign({}, slide, {
      audio_file: null,
      audio_provider: 'none',
      audio_ms: 0,
      image_file: null,
      image_status: imageState,
    }));
    const seamPrev = (series.seams || []).find((s) => Number(s.to) === n) || null;
    const seamNext = (series.seams || []).find((s) => Number(s.from) === n) || null;
    const slidesDoc = {
      schema_version: 1,
      product_version: '2.0',
      series_id: series.id,
      book_id: series.book_id,
      lecture: n,
      title: meta.title,
      chapters: meta.chapters,
      throughline: String(series.throughline || ''),
      seam_prev: seamPrev,
      seam_next: seamNext,
      generated_at: finishedAt,
      planned_pages: plannedPages,
      actual_pages: slides.length,
      model: model.model,
      provider: model.provider,
      prompt_version: LECTURE_PROMPT_VERSION,
      anchor_hit_rate: anchored.hitRate,
      quality,
      slides: withAudio,
    };
    meta = Object.assign({}, meta, {
      pages: slides.length,
      planned_pages: plannedPages,
      actual_pages: slides.length,
      chars: Number(planLecture.chars) || totalChars,
      status: 'ready',
      anchor_hit_rate: anchored.hitRate,
      quality,
      seam_repairs: seams.repairs,
      seam_repair_details: seams.details,
      finished_at: finishedAt,
      stages: stage,
    });
    writeLectureOutputs(dir, n, meta, slidesDoc);
    patchSeriesLecture(series, n, {
      status: 'ready',
      pages: plannedPages,
      planned_pages: plannedPages,
      actual_pages: slides.length,
      chars: meta.chars,
      lecture_id: meta.lecture_id,
      quality_summary: {
        content_ok: quality.content_ok === true,
        density_ok: quality.density_ok === true,
        over_budget: quality.over_budget === true,
        planned_pages: Number(quality.planned_pages) || 0,
        actual_pages: Number(quality.actual_pages) || 0,
      },
      code: null,
      error: null,
    });
    persistSeries(series);
    job.current = slides.length;
    job.total = slides.length;
    job.message = '第 ' + n + ' 讲已生成（' + slides.length + ' 页）';
    return { lecture: meta, slidesDoc };
  } catch (err) {
    const cancelled = job.cancelled || (err && err.code === 'E_CANCELLED');
    const status = cancelled ? 'cancelled' : 'failed';
    const code = cancelled ? 'E_CANCELLED' : (err && err.code) || 'E_GENERATE';
    const message = cancelled ? '已取消' : String((err && err.message) || err);
    const detail = cancelled ? '' : String((err && err.hint) || '');
    const failed = Object.assign({}, meta, {
      status,
      code,
      error: message,
      error_detail: detail,
      message,
      finished_at: nowIso(),
      stages: stage,
    });
    writeLectureMeta(dir, n, failed);
    // 强制重跑时旧 slides 已删；失败/取消后不要留下半截幻灯片
    try {
      fs.rmSync(slidesFile(dir, n), { force: true });
    } catch {
      /* ignore */
    }
    patchSeriesLecture(series, n, {
      status,
      code,
      error: message,
      error_detail: detail,
      pages: plannedPages,
      planned_pages: plannedPages,
      actual_pages: null,
      quality_summary: null,
    });
    persistSeries(series);
    throw err;
  }
}

/* ------------------------------ 作业 ------------------------------ */

function isReady(item) {
  return item && READY_STATUS.includes(String(item.status));
}

function activeJob(seriesId) {
  const job = jobsBySeries.get(String(seriesId));
  return job && job.active ? job : null;
}

function pruneJobs() {
  const now = Date.now();
  for (const [seriesId, job] of jobsBySeries) {
    if (job.active) continue;
    const finished = Date.parse(job.finishedAt || job.startedAt) || 0;
    if (now - finished > 30 * 60 * 1000) {
      jobsBySeries.delete(seriesId);
    }
  }
}

function jobState(job) {
  return {
    ok: true,
    jobId: job.id,
    seriesId: job.seriesId,
    stage: job.stage,
    lecture: job.lecture,
    lecturesTotal: job.lecturesTotal,
    current: job.current,
    total: job.total,
    message: job.message,
    status: job.status,
    skipped: job.skipped || [],
    scope: job.scope || [],
    error: job.error || null,
    usageJobId: job.usageJobId || job.id,
    usageBilling: job.usageBilling || 'cloud',
  };
}

export function getSeriesJob(seriesId) {
  const job = jobsBySeries.get(String(seriesId));
  return job ? jobState(job) : null;
}

export function cancelSeriesJob(seriesId) {
  const job = activeJob(seriesId);
  if (!job) return false;
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

/** 删除系列/书之前等待作业收口，避免删掉目录后又被作业写回来。 */
export function isSeriesJobActive(seriesId) {
  return !!activeJob(seriesId);
}

function normalizeScope(series, nums) {
  const all = (series.lectures || []).map((item) => Number(item.n)).sort((a, b) => a - b);
  if (!Array.isArray(nums) || !nums.length) return all;
  const wanted = Array.from(new Set(nums.map(Number))).sort((a, b) => a - b);
  for (const n of wanted) {
    if (!all.includes(n)) throw new GenerationError('E_REPLAN_RANGE', '第 ' + n + ' 讲不存在', '刷新系列后再试。');
  }
  return wanted;
}

async function runSeriesJob(job, context) {
  const { series } = context;
  try {
    series.status = 'drafting';
    series.started_at = series.started_at || nowIso();
    series.model = context.model.model;
    series.prompt_version = LECTURE_PROMPT_VERSION;
    series.failures = [];
    delete series.code;
    delete series.error;
    delete series.finished_at;
    persistSeries(series);
    job.stage = 'drafting';
    job.status = 'drafting';
    job.message = '已开始生成';

    const failures = [];
    for (let index = 0; index < job.scope.length; index += 1) {
      assertActive(job);
      const n = Number(job.scope[index]);
      job.lecture = n;
      job.lecturesTotal = (series.lectures || []).length;
      const planLecture = (series.lectures || []).find((item) => Number(item.n) === n);
      if (!planLecture) continue;
      if (job.skipSet.has(n)) {
        job.skipped.push(n);
        continue;
      }
      try {
        await generateLecture(job, context, planLecture);
      } catch (err) {
        if (job.cancelled || (err && err.code === 'E_CANCELLED')) throw err;
        failures.push({ n, code: (err && err.code) || 'E_GENERATE', message: String((err && err.message) || err) });
      }
    }

    assertActive(job);
    job.stage = 'stitching';
    job.status = 'stitching';
    job.lecture = 0;
    job.current = 0;
    job.total = 0;
    job.message = '正在做后验缝…';
    series.status = 'stitching';
    persistSeries(series);

    const report = buildStitchReport(context.found);
    writeStitchReport(context.found, report, { persist: false });
    series.stitch = report.state;
    const ready = (series.lectures || []).filter(isReady).length;
    const total = (series.lectures || []).length;
    series.status = ready === total ? 'ready' : ready > 0 ? 'partial' : 'failed';
    series.total_pages = (series.lectures || []).reduce(
      (sum, item) => sum + (Number(item.actual_pages) || Number(item.pages) || 0),
      0,
    );
    series.planned_total_pages = (series.lectures || []).reduce(
      (sum, item) => sum + (Number(item.planned_pages) || Number(item.pages) || 0),
      0,
    );
    series.est_minutes = series.total_pages;
    series.failures = failures;
    series.finished_at = nowIso();
    if (failures.length) {
      series.code = failures[0].code;
      series.error = failures[0].message;
    } else {
      delete series.code;
      delete series.error;
    }
    persistSeries(series);

    job.status = series.status;
    job.stage = 'done';
    job.message = series.status === 'ready' ? '生成完成' : '部分讲未就绪：' + ready + '/' + total;
    job.error = failures.length ? { failures } : null;
    job.finishedAt = nowIso();
  } catch (err) {
    const cancelled = job.cancelled || (err && err.code === 'E_CANCELLED');
    const status = cancelled ? 'cancelled' : 'failed';
    const message = cancelled ? '已取消' : String((err && err.message) || err);
    series.status = status;
    series.stitch = series.stitch || 'unstitched';
    series.code = cancelled ? 'E_CANCELLED' : (err && err.code) || 'E_GENERATE';
    series.error = message;
    series.finished_at = nowIso();
    persistSeries(series);
    job.status = status;
    job.stage = 'done';
    job.message = message;
    job.error = { code: series.code, message };
    job.finishedAt = nowIso();
  } finally {
    job.active = false;
    job.controller = null;
    if (!job.finishedAt) job.finishedAt = nowIso();
    pruneJobs();
  }
}

/**
 * 启动系列作业。同步建 job 后立即返回；HTTP 不等生成完成。
 *
 * @param {{found:object, nums?:number[]|null, force?:boolean|number[], ctx:object}} options
 */
export function startSeriesJob({ found, nums = null, force = false, ctx = null }) {
  const { series, dir } = found;
  if (!series || !series.id) throw new GenerationError('E_NOT_FOUND', '找不到这个系列', '');
  if (activeJob(series.id)) throw new GenerationError('E_SERIES_BUSY', '正在生成，请稍候', '同一系列同时只能有一个作业。');
  if (!series.plan_version || !(series.lectures || []).length) {
    throw new GenerationError('E_SERIES_UNPLANNED', '先生成/保存讲纲，再开始生成', '');
  }
  let model;
  try {
    model = resolveModel(ctx);
  } catch (err) {
    throw new GenerationError('E_LLM_FAIL', String((err && err.message) || err), '先在设置里选择 DSH 默认模型。');
  }

  const scope = normalizeScope(series, nums);
  const forceSet = force === true ? new Set(scope) : new Set(Array.isArray(force) ? force.map(Number) : []);
  const skipSet = new Set();
  const skipped = [];
  for (const n of scope) {
    const planLecture = (series.lectures || []).find((item) => Number(item.n) === Number(n));
    if (!planLecture) continue;
    if (forceSet.has(Number(n))) continue;
    const doc = loadLecture(dir, n);
    const key = lectureKeyOf(series, planLecture, model);
    const ready = doc.lecture && READY_STATUS.includes(String(doc.lecture.status)) && doc.lecture.key === key && doc.slidesDoc;
    if (ready) {
      skipSet.add(Number(n));
      skipped.push(Number(n));
    }
  }
  const pending = scope.filter((n) => !skipSet.has(Number(n)));
  if (!pending.length) {
    // 全部已 ready：即使上次停在 stitching，也把系列收口为 ready（不调用模型）
    const allReady = (series.lectures || []).every(isReady);
    if (allReady && series.status !== 'ready') {
      const report = buildStitchReport(found);
      writeStitchReport(found, report, { persist: false });
      series.stitch = report.state;
      series.status = 'ready';
      series.total_pages = (series.lectures || []).reduce(
        (sum, item) => sum + (Number(item.actual_pages) || Number(item.pages) || 0),
        0,
      );
      series.planned_total_pages = (series.lectures || []).reduce(
        (sum, item) => sum + (Number(item.planned_pages) || Number(item.pages) || 0),
        0,
      );
      series.est_minutes = series.total_pages;
      series.finished_at = series.finished_at || nowIso();
      series.failures = [];
      delete series.code;
      delete series.error;
      persistSeries(series);
    }
    return { cached: true, skipped, jobId: null, scope: { nums: scope, pending: [] } };
  }

  const texts = seriesChapterTexts(series.book_id, series);
  if (!texts) throw new GenerationError('E_NOT_FOUND', '找不到这本书', '');
  const chapterMap = chapterMapOf(texts);
  for (const item of series.lectures || []) {
    for (const n of item.chapters || []) {
      if (!chapterMap.has(Number(n))) throw new GenerationError('E_NO_CHAPTER', '找不到第 ' + n + ' 章', '章节可能被重切过，重新规划讲纲。');
    }
  }

  const jobId = newId(10);
  const job = {
    id: jobId,
    seriesId: String(series.id),
    bookId: String(series.book_id),
    status: 'queued',
    stage: 'queued',
    lecture: 0,
    lecturesTotal: (series.lectures || []).length,
    current: 0,
    total: 0,
    message: '已排队',
    error: null,
    skipped,
    scope: pending,
    skipSet,
    startedAt: nowIso(),
    finishedAt: null,
    controller: new AbortController(),
    cancelled: false,
    active: true,
    promise: null,
  };
  jobsBySeries.set(String(series.id), job);
  pruneJobs();

  const context = {
    found,
    series,
    dir,
    ctx,
    model,
    prompt: promptText(),
    book: texts.loaded.book,
    pages: texts.pages,
    chapterMap,
  };
  let usageEstimate = null;
  try {
    usageEstimate = estimateLecture({ ctx, seriesId: series.id, scope: { lectures: pending } });
  } catch {
    usageEstimate = null;
  }
  job.promise = runUsageJob(
    {
      jobId,
      kind: 'lecture',
      phase: 'generate',
      billing: billingForLlm(model.provider),
      book: { id: String(found.bookId), title: String((texts.loaded.book && texts.loaded.book.title) || '') },
      series: { id: String(series.id), title: String(series.title || '') },
      estimate: usageEstimate,
      scope: {
        lectures: pending.map(Number),
        pages: pending.reduce((sum, n) => {
          const hit = (series.lectures || []).find((item) => Number(item.n) === Number(n));
          return sum + (Number(hit && hit.pages) || 0);
        }, 0),
      },
    },
    () => runSeriesJob(job, context),
    () => (job.status === 'cancelled' ? 'cancelled' : job.status === 'failed' ? 'failed' : 'done'),
  ).catch((err) => {
    // runSeriesJob 自己收口；走到这里说明收口也抛了，兜底别让进程挂
    try {
      job.status = 'failed';
      job.stage = 'done';
      job.active = false;
      job.error = { code: 'E_GENERATE', message: String((err && err.message) || err) };
      job.finishedAt = nowIso();
    } catch {
      /* ignore */
    }
  });
  job.usageBilling = billingForLlm(model.provider);
  job.usageJobId = jobId;
  return { cached: false, skipped, jobId, job, scope: { nums: scope, pending } };
}

/** 只重跑指定讲（单讲生成/重试）；已 ready 且 force=false 时直接跳过。 */
export function startLectureJob({ found, n, ctx = null, force = true }) {
  return startSeriesJob({ found, nums: [Number(n)], force, ctx });
}

/** 续跑：跳过已 ready 讲，只补未完成讲。 */
export function resumeSeriesJob({ found, ctx = null }) {
  return startSeriesJob({ found, nums: null, force: [], ctx });
}

/** 启动归一：DSH 重启后把 drafting/stitching 和进行中的讲标成 interrupted。 */
export function reconcileAllSeries() {
  for (const item of listAllSeries()) {
    const { series, dir } = item;
    let changed = false;
    if (SERIES_ACTIVE.includes(String(series.status)) && !activeJob(series.id)) {
      series.status = 'interrupted';
      series.code = 'E_INTERRUPTED';
      series.error = '上次生成被中断（DSH 重启或进程退出），可以续跑';
      changed = true;
    }
    for (const lec of series.lectures || []) {
      if (!ACTIVE_STATUS.includes(String(lec.status))) continue;
      lec.status = 'interrupted';
      changed = true;
      try {
        const doc = loadLecture(dir, lec.n);
        if (doc.lecture) {
          writeLectureMeta(dir, lec.n, Object.assign({}, doc.lecture, {
            status: 'interrupted',
            code: 'E_INTERRUPTED',
            error: '上次生成被中断，可以重试',
            finished_at: nowIso(),
          }));
        }
      } catch {
        /* 单讲归一失败不影响其它讲 */
      }
    }
    if (changed) persistSeries(series);
  }
}

export { isReady, lectureKeyOf, ACTIVE_STATUS, READY_STATUS };




