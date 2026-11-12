/**
 * 3.2：只读 AI 审阅。只写 quality.review，不碰 slides 正文。
 *
 * 输入契约见 doc/requirements/AI审阅-需求规范化.md；
 * 系统提示词见 prompts/quality-review-v1.md。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

import { readMustKeepAliases } from './aliases.js';
import { callModel, readJsonBlock } from './llm.js';

export const QUALITY_REVIEW_VERSION = 'quality-review-v1';
const PROMPT = new URL('../prompts/quality-review-v1.md', import.meta.url);
const MAX_SOURCE_CHARS = 12000;
const MAX_SECTION_CHARS = 2600;
const REVIEW_MAX_TOKENS = 16000;
const REVIEW_RETRY_MAX_TOKENS = 32000;

/** 只对会影响审阅结论的机检字段做摘要；用于判断旧 review 是否过期。 */
export function qualityDigest(quality) {
  const value = quality && typeof quality === 'object' ? quality : {};
  const payload = {
    content_ok: value.content_ok === true,
    density_ok: value.density_ok === true,
    planned_pages: Number(value.planned_pages) || 0,
    actual_pages: Number(value.actual_pages) || 0,
    missing_sections: value.missing_sections || [],
    must_keep_real_missing: value.must_keep_real_missing || [],
    must_keep_aliases: value.must_keep_aliases || [],
    hard_impersonations: value.hard_impersonations || [],
    soft_impersonations: value.soft_impersonations || [],
    placeholders: value.placeholders || [],
    summary_pages: value.summary_pages || [],
    duplicate_pairs: Number(value.duplicate_pairs) || 0,
    density: value.density || {},
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export class QualityReviewError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'QualityReviewError';
    this.code = code;
    this.hint = hint || '';
  }
}

function reviewPrompt() {
  try {
    return fs.readFileSync(PROMPT, 'utf8');
  } catch {
    return '';
  }
}

/** 与 generate.js 的节名归一化保持同一口径（本模块不反向依赖生成器）。 */
function sectionKey(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[−–—－]/g, '-')
    .replace(/[;；]/g, ',')
    .replace(/[，]/g, ',')
    .replace(/[.．、]/g, '.')
    .toLowerCase();
}

function numberPair(value) {
  const from = Number(value && value.from);
  const to = Number(value && value.to);
  return { from: Number.isFinite(from) ? from : 0, to: Number.isFinite(to) ? to : 0 };
}

function sectionRange(section, slides) {
  const keys = new Set([section.title, ...(section.title_aliases || [])].map(sectionKey));
  const ranges = (slides || [])
    .filter((slide) => keys.has(sectionKey(slide.section)))
    .map((slide) => numberPair(slide.source_pages))
    .filter((range) => range.from > 0);
  if (ranges.length) {
    return {
      from: Math.min(...ranges.map((range) => range.from)),
      to: Math.max(...ranges.map((range) => range.to || range.from)),
    };
  }
  const from = Number(section.page) || 1;
  const count = Math.max(1, Number(section.pages) || 1);
  return { from, to: from + count - 1 };
}

function pageText(pageMap, range, limit) {
  const parts = [];
  for (let page = range.from; page <= range.to; page += 1) {
    const text = pageMap.get(page);
    if (!text) continue;
    parts.push('[p.' + page + ']\n' + text);
  }
  return parts.join('\n').slice(0, limit);
}

function sourceExcerpts(lecture, slides, pages, quality) {
  const pageMap = new Map((Array.isArray(pages) ? pages : []).map((page) => [Number(page.page), String(page.text || '')]));
  const out = [];
  let total = 0;
  const seen = new Set();
  const push = (section, range) => {
    if (!range.from || seen.has(section + '|' + range.from + '|' + range.to)) return;
    seen.add(section + '|' + range.from + '|' + range.to);
    const text = pageText(pageMap, range, MAX_SECTION_CHARS);
    if (!text.trim()) return;
    const remaining = MAX_SOURCE_CHARS - total;
    if (remaining <= 0) return;
    const clipped = text.slice(0, remaining);
    total += clipped.length;
    out.push({ section, from: range.from, to: range.to, text: clipped });
  };
  for (const section of lecture.sections || []) {
    push(section.title, sectionRange(section, slides));
  }
  // 硬冒充页可能已不在 leaf 清单里；仍给其来源页，方便 AI 判断 section 是否只是标点/层级差异。
  for (const item of (quality && quality.hard_impersonations) || []) {
    const slide = (slides || [])[Number(item.page) - 1];
    const range = numberPair(slide && slide.source_pages);
    if (range.from) push('硬冒充页 ' + item.page + '：' + (item.section || slide.section || ''), range);
  }
  return out;
}

function compactBook(book) {
  const value = book && typeof book === 'object' ? book : {};
  return {
    title: String(value.title || ''),
    author: String(value.author || ''),
    chapters: Array.isArray(value.chapters)
      ? value.chapters.slice(0, 40).map((chapter) => ({
          n: Number(chapter.n) || 0,
          title: String(chapter.title || ''),
          from: Number(chapter.from) || 0,
          to: Number(chapter.to) || 0,
        }))
      : [],
  };
}

function compactLecture(lecture) {
  return {
    n: Number(lecture.n) || 0,
    title: String(lecture.title || ''),
    goal: String(lecture.goal || ''),
    in: lecture.in || null,
    out: lecture.out || null,
    planned_pages: Number(lecture.planned_pages) || Number(lecture.pages) || 0,
    sections: (lecture.sections || []).map((section) => ({
      title: String(section.title || ''),
      page: Number(section.page) || 0,
      pages: Number(section.pages) || 0,
      must_keep: Array.isArray(section.must_keep) ? section.must_keep : [],
      section_source: String(section.section_source || ''),
      must_keep_fallback: Array.isArray(section.must_keep_fallback) ? section.must_keep_fallback : [],
    })),
  };
}

function compactQuality(quality) {
  const value = quality && typeof quality === 'object' ? quality : {};
  return {
    content_ok: value.content_ok === true,
    density_ok: value.density_ok === true,
    planned_pages: Number(value.planned_pages) || 0,
    actual_pages: Number(value.actual_pages) || 0,
    over_budget: value.over_budget === true,
    missing_sections: value.missing_sections || [],
    must_keep_real_missing: value.must_keep_real_missing || [],
    must_keep_aliases: value.must_keep_aliases || [],
    hard_impersonations: value.hard_impersonations || [],
    soft_impersonations: value.soft_impersonations || [],
    placeholders: value.placeholders || [],
    summary_pages: value.summary_pages || [],
    duplicate_pairs: Number(value.duplicate_pairs) || 0,
    density: value.density || {},
    repair: value.repair || {},
  };
}

function compactSlides(slides) {
  return (slides || []).map((slide) => ({
    section: String(slide.section || ''),
    layout: String(slide.layout || ''),
    page_role: String(slide.page_role || ''),
    title: String(slide.title || ''),
    subtitle: String(slide.subtitle || ''),
    bullet_points: Array.isArray(slide.bullet_points) ? slide.bullet_points : [],
    audio_script: String(slide.audio_script || ''),
    quote_text: slide.quote_text ? String(slide.quote_text) : '',
    source_pages: slide.source_pages || null,
    source_anchor: slide.source_anchor || null,
  }));
}

function relevantAliases(lecture, aliases) {
  const terms = new Set();
  for (const section of lecture.sections || []) {
    for (const keep of section.must_keep || []) terms.add(String(keep));
  }
  return (aliases || [])
    .filter((rule) => terms.has(String(rule.term || '')))
    .map((rule) => ({ term: rule.term, any: rule.any || [], all: rule.all || [] }));
}

export function buildQualityReviewPayload({ book, lecture, slides, quality, pages, aliases }) {
  const compactLectureValue = compactLecture(lecture);
  return {
    prompt_version: QUALITY_REVIEW_VERSION,
    book: compactBook(book),
    lecture: compactLectureValue,
    aliases: relevantAliases(lecture, aliases || readMustKeepAliases()),
    auto_audit: compactQuality(quality),
    slides: compactSlides(slides),
    source_excerpts: sourceExcerpts(lecture, slides, pages, quality),
    repair: (quality && quality.repair) || {},
    previous_review: quality && quality.review ? quality.review : null,
  };
}

const JUDGMENTS = new Set(['covered', 'synonym', 'missing', 'section_mismatch', 'false_positive', 'unclear']);
const ACTIONS = new Set(['none', 'add_alias', 'rewrite_page', 'regenerate', 'human_review']);

function cleanText(value, max = 400) {
  return String(value || '').trim().slice(0, max);
}

export function validateQualityReview(input, { lecture = 1 } = {}) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.items)) {
    throw new QualityReviewError('E_REVIEW_INVALID', 'AI 审阅没有返回合法 JSON', '重试或换模型。');
  }
  let verdict = String(input.verdict || 'needs_human');
  if (!['pass', 'needs_fix', 'needs_human'].includes(verdict)) verdict = 'needs_human';
  const items = input.items.slice(0, 100).map((item, index) => {
    const judgment = JUDGMENTS.has(String(item && item.judgment)) ? String(item.judgment) : 'unclear';
    const action = ACTIONS.has(String(item && item.action)) ? String(item.action) : 'human_review';
    const evidence = item && item.evidence && typeof item.evidence === 'object' ? item.evidence : {};
    const alias = item && item.alias && typeof item.alias === 'object'
      ? {
          term: cleanText(item.alias.term, 40),
          any: Array.isArray(item.alias.any) ? item.alias.any.map((x) => cleanText(x, 40)).filter(Boolean).slice(0, 12) : [],
          all: Array.isArray(item.alias.all) ? item.alias.all.map((x) => cleanText(x, 40)).filter(Boolean).slice(0, 12) : [],
        }
      : null;
    return {
      id: cleanText(item && item.id, 120) || 'ai:' + (index + 1),
      machine_type: cleanText(item && item.machine_type, 80) || 'unknown',
      page: Number(item && item.page) || 0,
      judgment,
      evidence: {
        slide_quote: cleanText(evidence.slide_quote, 500),
        source_page: Number(evidence.source_page) || 0,
        source_quote: cleanText(evidence.source_quote, 500),
      },
      confidence: Math.max(0, Math.min(1, Number(item && item.confidence) || 0)),
      action,
      alias,
      patch: null,
    };
  });
  if (verdict === 'pass' && items.some((item) => item.judgment === 'missing' || item.judgment === 'unclear')) {
    verdict = 'needs_human';
  }
  return {
    lecture: Number(input.lecture) || Number(lecture) || 1,
    verdict,
    items,
    summary: cleanText(input.summary, 500),
  };
}

async function callReviewAttempt(ctx, system, user, maxTokens) {
  const reply = await callModel(ctx, system, user, {
    maxTokens,
    timeoutMs: 180000,
    stage: 'quality-review',
  });
  const text = String(reply.text || '');
  let parseError = '';
  if (text.trim()) {
    try {
      return { reply, parsed: readJsonBlock(text) };
    } catch (err) {
      parseError = String((err && err.message) || err);
    }
  }
  if (/max[-_]?tokens/i.test(String(reply.stopReason || ''))) {
    throw new QualityReviewError(
      'E_REVIEW_TRUNCATED',
      '模型输出预算不足（' + maxTokens + ' tokens），没有生成完整 JSON；已尝试重试。',
      '请重试、换模型或缩短讲义/原文输入。',
    );
  }
  throw new QualityReviewError(
    'E_REVIEW_INVALID',
    '模型没有返回可解析的 JSON（stop=' + (reply.stopReason || '—') + '，len=' + text.length + '）。',
    parseError || '让模型只输出 JSON 对象后重试。',
  );
}

export async function reviewLectureQuality({ ctx, book, lecture, slides, quality, pages, aliases }) {
  const system = reviewPrompt();
  if (!system) throw new QualityReviewError('E_REVIEW_FAILED', '缺少 AI 审阅提示词', '');
  const payload = buildQualityReviewPayload({ book, lecture, slides, quality, pages, aliases });
  const user = JSON.stringify(payload);
  let attempt;
  try {
    attempt = await callReviewAttempt(ctx, system, user, REVIEW_MAX_TOKENS);
  } catch (err) {
    if (!(err instanceof QualityReviewError) || err.code !== 'E_REVIEW_TRUNCATED') throw err;
    try {
      attempt = await callReviewAttempt(ctx, system, user, REVIEW_RETRY_MAX_TOKENS);
    } catch (retryErr) {
      if (retryErr instanceof QualityReviewError && retryErr.code === 'E_REVIEW_TRUNCATED') {
        throw new QualityReviewError(
          'E_REVIEW_TRUNCATED',
          '模型在 16000 / 32000 tokens 预算内都没有生成完整 JSON。',
          '请缩短讲义或原文输入，或换一个模型后重试。',
        );
      }
      throw retryErr;
    }
  }
  let review;
  try {
    review = validateQualityReview(attempt.parsed, { lecture: lecture.n });
  } catch (err) {
    throw new QualityReviewError(
      'E_REVIEW_INVALID',
      'AI 审阅返回了 JSON，但结构不合法：' + String((err && err.message) || err),
      '重试或换模型；不要应用该结果。',
    );
  }
  return Object.assign(review, {
    model: attempt.reply.model,
    provider: attempt.reply.provider,
    prompt_version: QUALITY_REVIEW_VERSION,
    reviewed_at: new Date().toISOString(),
    audit_digest: qualityDigest(quality),
  });
}

/** 只改 quality.review；slides 数组/正文保持引用不变。 */
export function applyQualityReview(doc, review) {
  const nextSlidesDoc = Object.assign({}, doc.slidesDoc, {
    quality: Object.assign({}, doc.slidesDoc.quality || {}, { review }),
  });
  const nextLecture = Object.assign({}, doc.lecture, { quality: nextSlidesDoc.quality });
  return { lecture: nextLecture, slidesDoc: nextSlidesDoc };
}
