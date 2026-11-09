/**
 * 2.0 后验缝：先用确定性指标机检，再按最小粒度修复。
 *
 * 指标（FR-17）：接缝一致、页序/章序、相邻讲重复率、术语禁用词、密度 ρ、覆盖。
 * 修复矩阵：接缝不一致 → 1 页；重复/术语漂移 → 1 页；术语是确定性的字符串替换；
 * 重复页在给定模型时做页级重写，没有模型则做确定性去重，仍不行就保留为未修复项。
 *
 * 这里的机检不调用模型；调用模型只发生在 repair 的页级重写。
 */
import fs from 'node:fs';
import path from 'node:path';

import { readJson, writeJson } from './root.js';
import { loadBook } from './books.js';
import { persistSeries } from './series.js';
import { loadSeriesLectures, seriesChapterTexts, writeLectureOutputs } from './lectures.js';
import { callModel, readJsonBlock } from './llm.js';
import {
  AUDIO_MAX,
  AUDIO_MIN,
  BULLET_COUNT_MAX,
  BULLET_MAX,
  IMAGE_PROMPT_MAX,
  MAX_SLIDES,
  MIN_SLIDES,
  QUOTE_SOURCE_MAX,
  QUOTE_TEXT_MAX,
  SOURCE_QUOTE_MAX,
  SOURCE_QUOTE_MIN,
  TITLE_MAX,
  anchorSlides,
  normalizeForMatch,
  normalizeSlide,
} from '../lib/slides.js';

const DUP_MAX = 0.5;
const RHO_MIN = 2.5;
const RHO_MAX = 8;
const SHINGLE = 8;
const REPAIR_PROMPT = new URL('../prompts/stitch-repair-v1.md', import.meta.url);

/* ------------------------------ 文本与相似度 ------------------------------ */

function promptText() {
  try {
    return fs.readFileSync(REPAIR_PROMPT, 'utf8');
  } catch {
    return '';
  }
}

function shingles(text) {
  const chars = Array.from(normalizeForMatch(text));
  const out = new Set();
  if (!chars.length) return out;
  if (chars.length <= SHINGLE) {
    out.add(chars.join(''));
    return out;
  }
  for (let i = 0; i + SHINGLE <= chars.length; i += 1) out.add(chars.slice(i, i + SHINGLE).join(''));
  return out;
}

function overlapRate(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let hit = 0;
  for (const item of aSet) if (bSet.has(item)) hit += 1;
  return hit / Math.min(aSet.size, bSet.size);
}

export function slideText(slide) {
  return [
    String((slide && slide.title) || ''),
    String((slide && slide.subtitle) || ''),
    ...(Array.isArray(slide && slide.bullet_points) ? slide.bullet_points : []),
    String((slide && slide.quote_text) || ''),
    String((slide && slide.quote_source) || ''),
    String((slide && slide.audio_script) || ''),
  ].join('\n');
}

export function allTextOfSlide(slide) {
  return [
    slideText(slide),
    String((slide && slide.image_prompt) || ''),
    String((slide && slide.source_quote) || ''),
  ].join('\n');
}

export function lectureTextOf(slidesDoc) {
  return ((slidesDoc && slidesDoc.slides) || []).map(slideText).join('\n');
}

/** 两讲之间约定逐字复用的接缝句，不算“重复内容”。 */
function seamBetween(aDoc, bDoc) {  const fromA = aDoc && aDoc.seam_next && aDoc.seam_next.sentence;
  const fromB = bDoc && bDoc.seam_prev && bDoc.seam_prev.sentence;
  return String(fromA || fromB || '').trim();
}

function withoutSentence(text, sentence) {
  if (!sentence) return String(text || '');
  return String(text || '').split(sentence).join('');
}

function previousShingles(aDoc, bDoc) {
  return shingles(withoutSentence(lectureTextOf(aDoc), seamBetween(aDoc, bDoc)));
}

/**
 * 相邻两讲重复率：取后一讲中与前一讲重叠最高的那一页。
 *
 * 这是一个“最差页”指标，而不是整讲平均：FR-17 的修复粒度是页，AC-106 也要求
 * 只重生成衔接页就能把重复率降下来；整讲平均会让单页重写几乎无效。
 */
export function duplicateRate(aDoc, bDoc) {
  const prev = previousShingles(aDoc, bDoc);
  const sentence = seamBetween(aDoc, bDoc);
  let max = 0;
  for (const slide of (bDoc && bDoc.slides) || []) {
    const rate = overlapRate(shingles(withoutSentence(slideText(slide), sentence)), prev);
    if (rate > max) max = rate;
  }
  return max;
}

/** 本页与另一讲的重叠率，用来定位“衔接页”。 */
function pageOverlapRate(slide, otherSet, sentence) {
  return overlapRate(shingles(withoutSentence(slideText(slide), sentence)), otherSet);
}

/* ------------------------------ 密度与页序 ------------------------------ */

function netChars(text) {
  return String(text || '').replace(/[\s\u3000\u200b-\u200f\ufeff]/g, '').length;
}

function pageTextOf(pages, from, to) {
  return (Array.isArray(pages) ? pages : [])
    .filter((p) => Number(p.page) >= from && Number(p.page) <= to)
    .map((p) => String(p.text || ''))
    .join('\n');
}

export function densityOfLecture(lectureDoc, pages) {
  let numerator = 0;
  let denominator = 0;
  for (const raw of (lectureDoc && lectureDoc.slides) || []) {
    const slide = raw || {};
    const range = slide.source_pages ? slide.source_pages : {};
    const from = Math.round(Number(range.from) || 0);
    const to = Math.round(Number(range.to) || 0);
    if (from >= 1 && to >= from) numerator += netChars(pageTextOf(pages, from, to));
    const bullets = Array.isArray(slide.bullet_points) ? slide.bullet_points : [];
    denominator += [String(slide.title || ''), ...bullets.map(String), String(slide.quote_text || ''), String(slide.audio_script || '')].join('').length;
  }
  if (!denominator) return 0;
  return numerator / denominator;
}

function inChapterPages(slide, chapterRanges) {
  const range = slide && slide.source_pages ? slide.source_pages : {};
  const from = Math.round(Number(range.from) || 0);
  const to = Math.round(Number(range.to) || 0);
  if (!(from >= 1 && to >= from)) return false;
  // 允许一页横跨相邻两章，但不允许落进 Part 章集合之间的空档
  for (let page = from; page <= to; page += 1) {
    if (!chapterRanges.some((item) => page >= item.from && page <= item.to)) return false;
  }
  return true;
}

/* ------------------------------ 报告 ------------------------------ */

function metric(id, label, ok, value, extra) {
  return Object.assign({ id, label, ok: !!ok, value }, extra || {});
}

/**
 * 生成 stitch 报告。
 * @param {{bookId:string, series:object, dir:string}} found
 */
export function buildStitchReport(found) {
  const series = found && found.series;
  const dir = found && found.dir;
  const lectures = (series && series.lectures) || [];
  const docs = loadSeriesLectures(series, dir);
  const loaded = series ? loadBook(series.book_id) : null;
  const pages = loaded ? readJson(path.join(loaded.dir, 'pages.json'), []) : [];
  const bookPages = Array.isArray(pages) ? pages.length : 0;
  const failures = [];
  const warnings = [];

  const chapterRanges = (series && series.chapters ? series.chapters : []).map((n) => {
    const c = loaded ? (loaded.chapters || []).find((item) => Number(item.n) === Number(n)) : null;
    return c ? { n: Number(n), from: Number(c.from), to: Number(c.to) } : null;
  }).filter(Boolean);

  /* 1. 接缝一致 */
  const seams = (series && series.seams) || [];
  let seamChecks = 0;
  let seamPassed = 0;
  if (lectures.length > 1 && !seams.length) {
    failures.push({
      type: 'seam',
      lecture: null,
      page: null,
      message: '本系列未做衔接（讲纲没有接缝句）',
      action: '重新生成讲纲以补接缝',
    });
  } else if (lectures.length > 1 && seams.length !== lectures.length - 1) {
    failures.push({
      type: 'seam',
      lecture: null,
      page: null,
      message: '接缝数量应为 ' + (lectures.length - 1) + '，实际 ' + seams.length,
      action: '重新生成讲纲以修正接缝',
    });
  }
  for (const seam of seams) {
    const sentence = String(seam.sentence || '').trim();
    const fromDoc = docs.get(Number(seam.from));
    const toDoc = docs.get(Number(seam.to));
    if (!sentence) {
      failures.push({ type: 'seam', lecture: Number(seam.to), page: 1, message: '接缝句为空', action: '补接缝句' });
      continue;
    }
    if (sentence.length > 60) {
      failures.push({ type: 'seam', lecture: Number(seam.to), page: 1, message: '接缝句超过 60 字', action: '缩短接缝句' });
    }
    const cover = toDoc && toDoc.slidesDoc && (toDoc.slidesDoc.slides || [])[0];
    seamChecks += 1;
    if (!cover || !String(cover.audio_script || '').trim().startsWith(sentence)) {
      failures.push({
        type: 'seam',
        lecture: Number(seam.to),
        page: 1,
        message: '第 ' + seam.to + ' 讲封面首句与接缝句不一致',
        action: '修第 ' + seam.to + ' 讲封面朗读稿',
      });
    } else {
      seamPassed += 1;
    }
    const lastList = (fromDoc && fromDoc.slidesDoc && fromDoc.slidesDoc.slides) || [];
    const last = lastList[lastList.length - 1];
    seamChecks += 1;
    if (!last || !String(last.audio_script || '').trim().endsWith(sentence)) {
      failures.push({
        type: 'seam',
        lecture: Number(seam.from),
        page: lastList.length || 1,
        message: '第 ' + seam.from + ' 讲末页末句与接缝句不一致',
        action: '修第 ' + seam.from + ' 讲末页朗读稿',
      });
    } else {
      seamPassed += 1;
    }
  }
  const seamOk = lectures.length <= 1 ? true : seamChecks > 0 && seamPassed === seamChecks && !failures.some((f) => f.type === 'seam');
  const seamValue = lectures.length <= 1 ? '无需接缝' : seamChecks ? Math.round((seamPassed / seamChecks) * 100) + '%' : '0%';

  /* 2. 页序与章序 */
  let orderChecks = 0;
  let orderPassed = 0;
  const checkOrder = (ok, failure) => {
    orderChecks += 1;
    if (ok) orderPassed += 1;
    else failures.push(failure);
  };
  for (const item of lectures) {
    const doc = docs.get(Number(item.n));
    const slides = (doc && doc.slidesDoc && doc.slidesDoc.slides) || [];
    checkOrder(slides.length >= MIN_SLIDES && slides.length <= MAX_SLIDES, {
      type: 'order',
      lecture: Number(item.n),
      page: null,
      message: '第 ' + item.n + ' 讲页数为 ' + slides.length + '，应为 ' + MIN_SLIDES + '–' + MAX_SLIDES,
      action: '重新生成第 ' + item.n + ' 讲',
    });
    checkOrder(!!slides.length && slides[0] && String(slides[0].layout || '') === 'cover', {
      type: 'order',
      lecture: Number(item.n),
      page: 1,
      message: '第 ' + item.n + ' 讲第 1 页不是 cover',
      action: '重新生成第 ' + item.n + ' 讲封面',
    });
    checkOrder(
      JSON.stringify((doc && doc.lecture && doc.lecture.chapters) || item.chapters || []) ===
        JSON.stringify(item.chapters || []),
      {
        type: 'order',
        lecture: Number(item.n),
        page: null,
        message: '第 ' + item.n + ' 讲的章集合与讲纲不一致',
        action: '重新生成第 ' + item.n + ' 讲',
      },
    );
    slides.forEach((slide, index) => {
      const range = slide && slide.source_pages ? slide.source_pages : {};
      const from = Math.round(Number(range.from) || 0);
      const to = Math.round(Number(range.to) || 0);
      const pageOk = from >= 1 && to >= from && (!bookPages || to <= bookPages);
      checkOrder(pageOk, {
        type: 'order',
        lecture: Number(item.n),
        page: index + 1,
        message: '第 ' + item.n + ' 讲第 ' + (index + 1) + ' 页的 source_pages 不合法',
        action: '重新定位该页原文',
      });
      if (pageOk) {
        // source_pages 不要求随讲义页单调递增：回顾、引用前文都是合法的。
        // 这里只要求它落在本系列章页范围内。
        checkOrder(inChapterPages(slide, chapterRanges), {
          type: 'order',
          lecture: Number(item.n),
          page: index + 1,
          message: '第 ' + item.n + ' 讲第 ' + (index + 1) + ' 页越出本系列章范围',
          action: '重新定位该页原文',
        });
      }
    });
  }
  const orderOk = orderChecks === orderPassed;

  /* 3. 相邻讲重复率 */
  const pairs = [];
  let maxDup = 0;
  for (let i = 0; i < lectures.length - 1; i += 1) {
    const a = docs.get(Number(lectures[i].n));
    const b = docs.get(Number(lectures[i + 1].n));
    if (!a || !b || !a.slidesDoc || !b.slidesDoc) continue;
    const rate = duplicateRate(a.slidesDoc, b.slidesDoc);
    pairs.push({ from: Number(lectures[i].n), to: Number(lectures[i + 1].n), rate });
    if (rate > maxDup) maxDup = rate;
    if (rate > DUP_MAX) {
      failures.push({
        type: 'duplicate',
        lecture: Number(lectures[i + 1].n),
        page: null,
        message: '第 ' + lectures[i].n + '/' + lectures[i + 1].n + ' 讲重复率 ' + rate.toFixed(2),
        action: '重生成衔接页',
      });
    }
  }
  const dupOk = maxDup <= DUP_MAX;

  /* 4. 术语禁用词 */
  const termFailures = [];
  let termCount = 0;
  for (const term of (series && series.terms) || []) {
    const name = String(term.name || '').trim();
    for (const forbid of Array.isArray(term.forbid) ? term.forbid : []) {
      const bad = String(forbid || '').trim();
      if (!bad) continue;
      for (const item of lectures) {
        const doc = docs.get(Number(item.n));
        const slides = (doc && doc.slidesDoc && doc.slidesDoc.slides) || [];
        slides.forEach((slide, index) => {
          if (!allTextOfSlide(slide).includes(bad)) return;
          termCount += 1;
          termFailures.push({
            type: 'term',
            lecture: Number(item.n),
            page: index + 1,
            term: name,
            forbid: bad,
            message: '第 ' + item.n + ' 讲第 ' + (index + 1) + ' 页出现禁用写法「' + bad + '」',
            action: '把「' + bad + '」改成「' + name + '」',
          });
        });
      }
    }
  }
  failures.push(...termFailures);
  const termOk = termCount === 0;

  /* 5. 密度 ρ（越界只告警，不阻塞） */
  const densities = [];
  let densityWarn = false;
  for (const item of lectures) {
    const doc = docs.get(Number(item.n));
    if (!doc || !doc.slidesDoc) continue;
    const rho = densityOfLecture(doc.slidesDoc, pages);
    const ok = rho >= RHO_MIN && rho <= RHO_MAX;
    if (!ok) densityWarn = true;
    densities.push({ n: Number(item.n), rho: Math.round(rho * 100) / 100, ok });
    if (!ok) warnings.push('第 ' + item.n + ' 讲密度 ρ=' + (Math.round(rho * 100) / 100) + '，建议 ' + RHO_MIN + '–' + RHO_MAX);
  }

  /* 6. 覆盖 */
  const expected = ((series && series.chapters) || []).map(Number).sort((a, b) => a - b);
  const planSeen = [];
  for (const item of lectures) for (const n of item.chapters || []) planSeen.push(Number(n));
  const planUnique = Array.from(new Set(planSeen)).sort((a, b) => a - b);
  const coverageOk = JSON.stringify(planUnique) === JSON.stringify(expected) && lectures.length > 0;
  if (!coverageOk) {
    failures.push({
      type: 'coverage',
      lecture: null,
      page: null,
      message: '讲纲没有覆盖 Part 的全部章',
      action: '重新生成讲纲',
    });
  }

  const blocking = failures.filter((f) => ['seam', 'order', 'duplicate', 'term', 'coverage'].includes(f.type));
  const state = !blocking.length ? (lectures.length <= 1 ? 'verified' : 'stitched') : 'unstitched';

  const report = {
    schema: 1,
    series_id: series ? series.id : '',
    generated_at: new Date().toISOString(),
    state,
    metrics: [
      metric('seam', '接缝一致', seamOk, seamValue, { blocking: true }),
      metric('order', '页序与章序', orderOk, orderChecks ? Math.round((orderPassed / orderChecks) * 100) + '%' : '0%', { blocking: true }),
      metric('duplicate', '相邻讲重复率', dupOk, Math.round(maxDup * 100) / 100, { blocking: true, threshold: DUP_MAX, pairs }),
      metric('terms', '术语禁用词', termOk, termCount, { blocking: true }),
      metric('density', '密度 ρ', true, densities, { blocking: false, warn: densityWarn, range: [RHO_MIN, RHO_MAX] }),
      metric('coverage', '覆盖', coverageOk, coverageOk ? '100%' : '未覆盖', { blocking: true }),
    ],
    failures,
    actions: Array.from(new Set(failures.map((f) => f.action).filter(Boolean))),
    warnings,
  };
  return report;
}

/** 报告落盘；生成结束时同时更新 series.stitch。 */
export function writeStitchReport(found, report, { persist = false } = {}) {
  if (!found || !found.dir) return report;
  writeJson(path.join(found.dir, 'stitch.json'), report);
  if (persist && found.series) {
    found.series.stitch = report.state;
    persistSeries(found.series);
  }
  return report;
}

/* ------------------------------ 确定性修复工具 ------------------------------ */

/**
 * 把接缝句逐字装到朗读稿指定端；超过 220 字时只截正文，不截接缝句。
 * 这是“页级修复”的最后兜底：模型修不动时也能让断言成立。
 */
export function withSeamSentence(role, script, sentence) {
  const seam = String(sentence || '').trim();
  let rest = String(script || '').trim();
  if (!seam) return rest;
  if (role === 'cover') {
    if (!rest.startsWith(seam)) {
      rest = rest ? rest.replace(/\s+/g, ' ') : '';
      rest = (seam + ' ' + rest).trim();
    }
    if (rest.length > 220) rest = rest.slice(0, 220);
    if (rest.length < 40) rest = (rest + ' 这一讲从这里开始。').slice(0, 220);
    return rest;
  }
  if (!rest.endsWith(seam)) {
    rest = rest ? rest.replace(/\s+/g, ' ') : '';
    rest = (rest + ' ' + seam).trim();
  }
  if (rest.length > 220) rest = rest.slice(rest.length - 220);
  if (rest.length < 40) rest = ('这一讲先讲到这里。 ' + rest).slice(-220);
  return rest;
}

const TERM_FIELDS = ['title', 'subtitle', 'quote_text', 'quote_source', 'audio_script', 'image_prompt', 'source_quote'];

function replaceTermInSlide(slide, forbid, name) {
  let changed = false;
  const next = Object.assign({}, slide);
  for (const field of TERM_FIELDS) {
    const value = next[field];
    if (typeof value !== 'string' || !value.includes(forbid)) continue;
    next[field] = value.split(forbid).join(name);
    changed = true;
  }
  if (Array.isArray(next.bullet_points)) {
    const bullets = next.bullet_points.map((item) => {
      if (typeof item === 'string' && item.includes(forbid)) {
        changed = true;
        return item.split(forbid).join(name);
      }
      return item;
    });
    next.bullet_points = bullets;
  }
  return { slide: next, changed };
}

/* ------------------------------ 修复 ------------------------------ */

function mergeRepairPage(original, raw, index) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const normalized = normalizeSlide(data, index);
  const next = Object.assign({}, original);
  if (normalized.title && normalized.title.length <= TITLE_MAX) next.title = normalized.title;
  if (normalized.subtitle && normalized.subtitle.length <= 60) next.subtitle = normalized.subtitle;
  if (normalized.quote_text && normalized.quote_text.length <= QUOTE_TEXT_MAX) next.quote_text = normalized.quote_text;
  if (normalized.quote_source && normalized.quote_source.length <= QUOTE_SOURCE_MAX) next.quote_source = normalized.quote_source;
  if (normalized.image_prompt && normalized.image_prompt.length <= IMAGE_PROMPT_MAX) next.image_prompt = normalized.image_prompt;
  if (normalized.audio_script.length >= AUDIO_MIN && normalized.audio_script.length <= AUDIO_MAX) next.audio_script = normalized.audio_script;
  if (
    normalized.source_quote.length >= SOURCE_QUOTE_MIN &&
    normalized.source_quote.length <= SOURCE_QUOTE_MAX
  ) {
    next.source_quote = normalized.source_quote;
  }
  const bullets = normalized.bullet_points;
  if (
    bullets.length >= 1 &&
    bullets.length <= BULLET_COUNT_MAX &&
    bullets.every((item) => String(item).length <= BULLET_MAX)
  ) {
    next.bullet_points = bullets;
  }
  if (data.source_pages && normalized.source_pages.from >= 1 && normalized.source_pages.to >= normalized.source_pages.from) {
    next.source_pages = normalized.source_pages;
  }
  return next;
}

function sentencesOf(text) {
  return String(text || '')
    .split(/(?<=[。！？；!?;])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 没有模型时的去重：删掉与前一讲逐字重复的句子/要点，至少保留一条要点。 */
function dedupePage(slide, previousText) {
  const prevNorm = normalizeForMatch(previousText);
  const next = Object.assign({}, slide);
  let changed = false;

  const sentences = sentencesOf(next.audio_script);
  if (sentences.length > 1) {
    const kept = sentences.filter((s) => {
      const norm = normalizeForMatch(s);
      return norm.length < 8 || !prevNorm.includes(norm);
    });
    const joined = kept.join('');
    if (joined.length >= 40 && joined !== String(next.audio_script || '')) {
      next.audio_script = joined;
      changed = true;
    }
  }

  if (Array.isArray(next.bullet_points) && next.bullet_points.length > 1) {
    const kept = next.bullet_points.filter((item) => {
      const norm = normalizeForMatch(item);
      return norm.length < 8 || !prevNorm.includes(norm);
    });
    if (kept.length && kept.length !== next.bullet_points.length) {
      next.bullet_points = kept;
      changed = true;
    }
  }
  return { slide: next, changed };
}

async function rewriteDuplicatePage({ ctx, previousDoc, currentDoc, pageIndex }) {
  const prompt = promptText();
  if (!ctx || !prompt) return null;
  const prevText = lectureTextOf(previousDoc.slidesDoc).slice(-2500);
  const page = currentDoc.slidesDoc.slides[pageIndex];
  const user = [
    '【前一讲末尾】',
    prevText,
    '【本讲】第 ' + currentDoc.n + ' 讲 · ' + String(currentDoc.lecture && currentDoc.lecture.title || ''),
    '【待重写页】',
    JSON.stringify(page),
    '【要求】保持页数与 source_pages 不变，只改写这一页；不要复述前一讲已经讲过的话；',
    '如果这是 cover，audio_script 仍必须以本讲接缝句逐字开头；末页仍必须以接缝句逐字结尾。',
    '只输出 {"slides":[{...}]}，数组里只有这一页，不要解释。',
  ].join('\n');
  try {
    const reply = await callModel(ctx, prompt, user, { maxTokens: 8000, stage: 'stitch' });
    const data = readJsonBlock(reply.text);
    const raw = Array.isArray(data.slides) ? data.slides[0] : data;
    const next = mergeRepairPage(page, raw, pageIndex);
    // 重写页若正好是封面/末页，接缝契约不能被破坏
    if (pageIndex === 0 && currentDoc.slidesDoc.seam_prev && currentDoc.slidesDoc.seam_prev.sentence) {
      next.audio_script = withSeamSentence('cover', next.audio_script, currentDoc.slidesDoc.seam_prev.sentence);
    }
    const lastIndex = (currentDoc.slidesDoc.slides || []).length - 1;
    if (pageIndex === lastIndex && currentDoc.slidesDoc.seam_next && currentDoc.slidesDoc.seam_next.sentence) {
      next.audio_script = withSeamSentence('last', next.audio_script, currentDoc.slidesDoc.seam_next.sentence);
    }
    return next;
  } catch {
    return null;
  }
}

/**
 * 修复 stitch 报告里的问题。
 * @param {{found:object, ctx?:object, targets?:string[]}} options
 */
export async function repairStitch({ found, ctx = null, targets = null } = {}) {
  const series = found && found.series;
  const dir = found && found.dir;
  if (!series || !dir) return { report: null, repaired: [], unresolved: [] };
  const docs = loadSeriesLectures(series, dir);
  const texts = seriesChapterTexts(series.book_id, series);
  const pages = (texts && texts.pages) || [];
  const chapterRanges = (texts && texts.chapters ? texts.chapters : []).map((c) => ({ n: c.n, from: c.from, to: c.to }));
  const wanted = (type) => !Array.isArray(targets) || targets.includes(type);
  const repaired = [];
  const unresolved = [];
  const touched = new Set();

  const reanchor = (doc) => {
    if (!doc || !doc.slidesDoc) return;
    const minPage = chapterRanges.length ? Math.min(...chapterRanges.map((c) => c.from)) : 1;
    const maxPage = chapterRanges.length ? Math.max(...chapterRanges.map((c) => c.to)) : pages.length || 1;
    const out = anchorSlides(doc.slidesDoc.slides, pages, { minPage, maxPage });
    doc.slidesDoc.slides = out.slides;
    doc.slidesDoc.anchor_hit_rate = out.hitRate;
  };

  /* 术语：确定性替换 */
  if (wanted('term')) {
    for (const term of series.terms || []) {
      const name = String(term.name || '').trim();
      for (const forbid of Array.isArray(term.forbid) ? term.forbid : []) {
        const bad = String(forbid || '').trim();
        if (!bad || !name) continue;
        for (const item of series.lectures || []) {
          const doc = docs.get(Number(item.n));
          if (!doc || !doc.slidesDoc) continue;
          let changed = false;
          doc.slidesDoc.slides = (doc.slidesDoc.slides || []).map((slide) => {
            const out = replaceTermInSlide(slide, bad, name);
            if (out.changed) changed = true;
            return out.slide;
          });
          if (changed) {
            reanchor(doc);
            touched.add(Number(item.n));
            repaired.push({ type: 'term', lecture: Number(item.n), page: null, action: '把「' + bad + '」改成「' + name + '」' });
          }
        }
      }
    }
  }

  /* 接缝：页级字符串修复，不重生成整讲 */
  if (wanted('seam')) {
    for (const seam of series.seams || []) {
      const sentence = String(seam.sentence || '').trim();
      if (!sentence) continue;
      const fromDoc = docs.get(Number(seam.from));
      const toDoc = docs.get(Number(seam.to));
      if (fromDoc && fromDoc.slidesDoc) {
        const list = fromDoc.slidesDoc.slides || [];
        const index = list.length - 1;
        if (index >= 0 && !String(list[index].audio_script || '').trim().endsWith(sentence)) {
          list[index] = Object.assign({}, list[index], {
            audio_script: withSeamSentence('last', list[index].audio_script, sentence),
          });
          fromDoc.slidesDoc.slides = list;
          touched.add(Number(seam.from));
          repaired.push({ type: 'seam', lecture: Number(seam.from), page: index + 1, action: '末页接缝句' });
        }
      }
      if (toDoc && toDoc.slidesDoc) {
        const list = toDoc.slidesDoc.slides || [];
        if (list.length && !String(list[0].audio_script || '').trim().startsWith(sentence)) {
          list[0] = Object.assign({}, list[0], {
            audio_script: withSeamSentence('cover', list[0].audio_script, sentence),
          });
          toDoc.slidesDoc.slides = list;
          touched.add(Number(seam.to));
          repaired.push({ type: 'seam', lecture: Number(seam.to), page: 1, action: '封面接缝句' });
        }
      }
    }
  }

  /* 重复：先确定性去重，仍有模型时做页级重写 */
  if (wanted('duplicate')) {
    for (let i = 0; i < (series.lectures || []).length - 1; i += 1) {
      const a = docs.get(Number(series.lectures[i].n));
      const b = docs.get(Number(series.lectures[i + 1].n));
      if (!a || !b || !a.slidesDoc || !b.slidesDoc) continue;
      let rate = duplicateRate(a.slidesDoc, b.slidesDoc);
      if (rate <= DUP_MAX) continue;
      const sentence = seamBetween(a.slidesDoc, b.slidesDoc);
      const prevSet = previousShingles(a.slidesDoc, b.slidesDoc);
      const slides = b.slidesDoc.slides || [];
      let bestIndex = 0;
      let bestRate = -1;
      slides.forEach((slide, index) => {
        const overlap = pageOverlapRate(slide, prevSet, sentence);
        if (overlap > bestRate) {
          bestRate = overlap;
          bestIndex = index;
        }
      });
      const deduped = dedupePage(slides[bestIndex], withoutSentence(lectureTextOf(a.slidesDoc), sentence));
      if (deduped.changed) {
        slides[bestIndex] = deduped.slide;
        b.slidesDoc.slides = slides;
        touched.add(Number(b.n));
      }
      rate = duplicateRate(a.slidesDoc, b.slidesDoc);
      if (rate > DUP_MAX) {
        const rewritten = await rewriteDuplicatePage({ ctx, previousDoc: a, currentDoc: b, pageIndex: bestIndex });
        if (rewritten) {
          slides[bestIndex] = rewritten;
          b.slidesDoc.slides = slides;
          reanchor(b);
          touched.add(Number(b.n));
          rate = duplicateRate(a.slidesDoc, b.slidesDoc);
        }
      }
      if (rate > DUP_MAX) {
        unresolved.push({
          type: 'duplicate',
          lecture: Number(b.n),
          page: bestIndex + 1,
          message: '重复率仍为 ' + rate.toFixed(2),
          action: '手工重生成衔接页或开启模型后重试',
        });
      } else {
        repaired.push({ type: 'duplicate', lecture: Number(b.n), page: bestIndex + 1, action: '重写衔接页' });
      }
    }
  }

  /* 落盘：只写被改过的讲 */
  for (const n of touched) {
    const doc = docs.get(Number(n));
    if (!doc || !doc.slidesDoc) continue;
    const lecture = Object.assign({}, doc.lecture || {});
    if (!lecture.status) lecture.status = 'ready';
    if (!lecture.series_id) lecture.series_id = series.id;
    if (!lecture.n) lecture.n = Number(n);
    lecture.updated_at = new Date().toISOString();
    if (typeof doc.slidesDoc.anchor_hit_rate === 'number') lecture.anchor_hit_rate = doc.slidesDoc.anchor_hit_rate;
    doc.slidesDoc.generated_at = doc.slidesDoc.generated_at || new Date().toISOString();
    writeLectureOutputs(dir, Number(n), lecture, doc.slidesDoc);
  }

  const report = buildStitchReport(found);
  // 报告里仍存在的可修复项，统一收进 unresolved，避免“点了修复但没修好”没有反馈
  for (const failure of report.failures) {
    if (!['seam', 'term', 'duplicate'].includes(failure.type)) continue;
    const exists = unresolved.some(
      (item) => item.type === failure.type && item.lecture === failure.lecture && (failure.type === 'duplicate' || item.page === failure.page),
    );
    if (!exists) unresolved.push(failure);
  }
  writeStitchReport(found, report, { persist: true });
  return { report, repaired, unresolved };
}

export { DUP_MAX, RHO_MIN, RHO_MAX };
