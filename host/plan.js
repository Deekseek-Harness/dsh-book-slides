/**
 * M2 讲纲：确定性装章是底线；有模型时再补主线、接缝与术语。
 * 模型输出不合格时保留规则 plan（unstitched），不阻塞用户确认。
 */
import fs from 'node:fs';

import { callModel, readJsonBlock } from './llm.js';
import { bookmarkSectionEntriesOf, buildBriefs } from './briefs.js';

const PLAN_PROMPT = new URL('../prompts/plan-v1.md', import.meta.url);
const PLAN_META_PROMPT = new URL('../prompts/plan-meta-v1.md', import.meta.url);
const PLAN_SECTIONS_PROMPT = new URL('../prompts/plan-sections-v1.md', import.meta.url);
const TARGET_CHARS = 60000;
const HARD_CHARS = 80000;
const MAX_LECTURES = 8;
const MAX_CHAPTERS_PER_LECTURE = 6;

export class PlanError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'PlanError';
    this.code = code;
    this.hint = hint || '';
  }
}

function promptText() {
  try {
    return fs.readFileSync(PLAN_PROMPT, 'utf8');
  } catch {
    return '';
  }
}

function metaPromptText() {
  try {
    return fs.readFileSync(PLAN_META_PROMPT, 'utf8');
  } catch {
    return '';
  }
}

function sectionPromptText() {
  try {
    return fs.readFileSync(PLAN_SECTIONS_PROMPT, 'utf8');
  } catch {
    return '';
  }
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function charsOf(chapter) {
  return Number(chapter.chars) || String(chapter.text || '').length;
}

function sectionHeadings(text, limit = 8) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.length > 100) continue;
    // 页眉的 "Item 7 | 51" 不是章节标题，不能喂给模型，否则整章会被误读成 Item 7
    if (/^item\s+\d+\s*[|｜]\s*\d+$/i.test(line)) continue;
    if (/^chapter\s+\d+$/i.test(line)) continue;
    if (!/^(第[一二三四五六七八九十百0-9]+[节章部分]|\d+(?:\.\d+){1,3}[\s、.．]|[一二三四五六七八九十]+[、.．]|【.+】|item\s+\d+\s*[:：]|chapter\s+\d+)/i.test(line)) continue;
    const key = line.replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}

function sliceSections(chapter, slice) {
  const text = String(chapter.text || '');
  const from = Math.max(0, Number(slice && slice.from) || 0);
  const to = Math.min(text.length, Number(slice && slice.to) || text.length);
  return sectionHeadings(text.slice(from, to), 10);
}

function slicePreview(chapter, slice) {
  const text = String(chapter.text || '');
  const from = Math.max(0, Number(slice && slice.from) || 0);
  const to = Math.min(text.length, Number(slice && slice.to) || text.length);
  return text.slice(from, to).slice(0, 800);
}

function scopeTokens(section) {
  const line = String(section || '');
  const item = /item\s+(\d+)/i.exec(line);
  if (item) return ['item ' + item[1], item[1]];
  const ch = /^(?:第\s*)?(\d+(?:\.\d+)*)/.exec(line);
  if (ch) return [ch[1]];
  return line ? [line.slice(0, 12)] : [];
}

function textHasScope(text, section) {
  const value = String(text || '').toLowerCase();
  return scopeTokens(section).some((token) => token && value.includes(String(token).toLowerCase()));
}

function metaCoversScopes(throughline, seams, lectures) {
  if (!lectures.length) return true;
  const first = lectures[0];
  const last = lectures[lectures.length - 1];
  if (first.scope && first.scope.last && !textHasScope(throughline, first.scope.last)) return false;
  if (last.scope && last.scope.last && !textHasScope(throughline, last.scope.last)) return false;
  for (let i = 0; i < seams.length; i += 1) {
    const next = lectures[i + 1];
    if (next && next.scope && next.scope.first && !textHasScope(seams[i].sentence, next.scope.first)) return false;
  }
  return true;
}

function deterministicSplitMeta(base, lectures) {
  const first = lectures[0];
  const last = lectures[lectures.length - 1];
  const throughline =
    '本章覆盖 ' + (first.scope.last || first.title) + ' 至 ' + (last.scope.last || last.title) + '，按节拆成 ' + lectures.length + ' 讲。';
  const seams = [];
  for (let i = 0; i < lectures.length - 1; i += 1) {
    const current = lectures[i];
    const next = lectures[i + 1];
    seams.push({
      from: i + 1,
      to: i + 2,
      concept: '',
      sentence:
        '上篇收在 ' + (current.scope.last || current.title) + '；下篇从 ' + (next.scope.first || next.title) + ' 开始。',
    });
  }
  return Object.assign({}, base, { throughline, seams, terms: [], source: 'rule', stitched: false });
}

/** 单章超过 6 万字就在章内拆：6 万字 ≈ 30 页，再长会被页数上限压掉内容。 */
const CHAPTER_SPLIT_CHARS = 60000;

/** 在 text 里找一处“居中”的切点：优先节标题行，其次行边界，最后按字。 */
function findCut(text) {
  const lines = text.split(/\r?\n/);
  const offsets = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1;
  }
  const sectionRe = /^(第[一二三四五六七八九十百0-9]+[节章部分]|\d+(?:\.\d+){1,3}[\s、.．]|[一二三四五六七八九十]+[、.．]|【.+】|item\s+\d+\s*[:：]|chapter\s+\d+)/i;
  const candidates = offsets.filter((offset, i) => {
    const line = lines[i] || '';
    if (/^item\s+\d+\s*[|｜]\s*\d+$/i.test(line.trim())) return false;
    return offset > 1000 && text.length - offset > 1000 && sectionRe.test(line.trim());
  });
  const target = Math.floor(text.length / 2);
  let cut = candidates.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
  if (!cut) {
    cut = text.lastIndexOf('\n', target);
    if (cut < 1000 || text.length - cut < 1000) cut = target;
  }
  return cut;
}

/** 纯文本二分，返回不带标签的段；两半都继续递归，避免极长章丢尾。 */
function splitRaw(text, maxChars) {
  if (text.length <= maxChars) return [{ from: 0, to: text.length, chars: text.length, text }];
  const cut = findCut(text);
  const out = splitRaw(text.slice(0, cut), maxChars);
  for (const seg of splitRaw(text.slice(cut), maxChars)) {
    out.push(Object.assign({}, seg, { from: cut + seg.from, to: cut + seg.to }));
  }
  return out;
}

function sliceChapter(chapter, maxChars = CHAPTER_SPLIT_CHARS) {
  const text = String(chapter.text || '');
  if (text.length <= maxChars) return [{ chapter: chapter.n, title: chapter.title, from: 0, to: text.length, chars: text.length, text }];
  const parts = splitRaw(text, maxChars).map((seg) => ({
    chapter: chapter.n,
    title: chapter.title,
    from: seg.from,
    to: seg.to,
    chars: seg.chars,
    text: seg.text,
  }));
  if (parts.length <= 2) {
    parts[0].partLabel = '上';
    if (parts[1]) parts[1].partLabel = '下';
  } else {
    for (let i = 0; i < parts.length; i += 1) parts[i].partLabel = String(i + 1) + '/' + parts.length;
  }
  return parts;
}

/** 节标题归一：只用于去重，不改变落盘标题。 */
function normalizeSectionTitle(title) {
  return String(title || '')
    .replace(/\s+/g, '')
    .replace(/[.．、]/g, '.')
    .toLowerCase();
}

/** 某章的节清单：优先书签子标题；没有书签时用 brief.sections 兜底。 */
function sectionEntriesForChapter(book, chapter) {
  const entries = bookmarkSectionEntriesOf(book, chapter);
  if (entries.length) return entries;
  const titles = chapter && chapter.brief && Array.isArray(chapter.brief.sections) ? chapter.brief.sections : [];
  return titles.map((title) => ({ title, page: Number(chapter.from) || 0 }));
}

/**
 * 给讲纲加“节级结构 + 页预算”：
 * - 每讲 sections=[{title,chapter,page,pages}]，按书签/ brief 顺序；
 * - 页数至少 1 页/节 + 1 页封面，同时不低于原字数预算；
 * - 这是验证 2 的变量：讲纲不再只是“一句 goal”，而是可验收的节清单。
 */
function attachSectionPlan(plan, chapters, book) {
  const byN = new Map((Array.isArray(chapters) ? chapters : []).map((chapter) => [Number(chapter.n), chapter]));
  for (const lecture of (plan && plan.lectures) || []) {
    if (lecture.slice) continue; // 超长章按字符切片时，页范围不在本验证内，保持原预算
    const all = [];
    for (const n of lecture.chapters || []) {
      const chapter = byN.get(Number(n));
      if (!chapter) continue;
      for (const entry of sectionEntriesForChapter(book, chapter)) {
        const key = normalizeSectionTitle(entry && entry.title);
        if (!key || all.some((item) => normalizeSectionTitle(item.title) === key)) continue;
        all.push({
          title: String(entry.title || '').trim(),
          chapter: Number(n),
          page: Number(entry.page) || Number(chapter.from) || 0,
          depth: Number(entry.depth) || 1,
          parent: String(entry.parent || '').trim(),
        });
      }
    }
    if (!all.length) continue;
    // 页数只分到 leaf；父节（1.1/1.2）不再单独占页，避免父子重复计数。
    const parentKeys = new Set(all.map((item) => normalizeSectionTitle(item.parent)).filter(Boolean));
    const leaves = all.filter((item) => !parentKeys.has(normalizeSectionTitle(item.title)));
    const sections = (leaves.length ? leaves : all).map((item) => ({
      title: item.title,
      chapter: item.chapter,
      page: item.page,
      pages: 1,
      depth: item.depth,
      parent: item.parent,
      must_keep: [],
    }));
    lecture.sections = sections;
    lecture.pages = clamp(
      Math.max(Math.round((Number(lecture.chars) || 0) / 2000), sections.length + 1),
      6,
      30,
    );
  }
  if (plan) {
    plan.totalPages = (plan.lectures || []).reduce((sum, lecture) => sum + (Number(lecture.pages) || 0), 0);
    plan.estMinutes = plan.totalPages;
  }
  return plan;
}

export function rulePlan(part, chapters, book = null) {
  const list = chapters.slice().sort((a, b) => a.n - b.n);
  const groups = [];
  let current = [];
  let currentChars = 0;
  const close = () => {
    if (!current.length) return;
    groups.push({ chapters: current.map((c) => c.n), chars: currentChars, title: '' });
    current = [];
    currentChars = 0;
  };
  for (const chapter of list) {
    const chars = charsOf(chapter);
    if (chars > CHAPTER_SPLIT_CHARS) {
      close();
      const slices = sliceChapter(chapter);
      for (const slice of slices) {
        groups.push({
          chapters: [chapter.n],
          slice,
          chars: slice.chars,
          title: '第 ' + chapter.n + ' 章（' + (slice.partLabel || '上') + '）',
        });
      }
      continue;
    }
    if (current.length >= MAX_CHAPTERS_PER_LECTURE) close();
    // I4：单讲 ≤8 万。目标 6 万是软的，但硬上限不能靠“当前讲还很短”放行；
    // 否则 41999 + 59999 会拼出 10.2 万字的一讲。
    if (current.length && currentChars + chars > HARD_CHARS) close();
    if (current.length && currentChars + chars > TARGET_CHARS && currentChars >= TARGET_CHARS * 0.7) close();
    current.push(chapter);
    currentChars += chars;
    if (current.length >= MAX_CHAPTERS_PER_LECTURE || currentChars >= TARGET_CHARS) close();
  }
  close();
  if (!groups.length) throw new PlanError('E_PART_EMPTY', 'Part 没有内容章', '');
  if (groups.length > MAX_LECTURES) {
    throw new PlanError('E_SERIES_TOO_MANY', '这个 Part 需要 ' + groups.length + ' 讲，超过 8 讲上限', '拆成两个 Part。');
  }

  const lectures = groups.map((group, i) => {
    const first = list.find((c) => c.n === group.chapters[0]);
    const pages = clamp(Math.round(group.chars / 2000), 6, 30);
    const lecture = {
      n: i + 1,
      chapters: group.chapters,
      title: group.title || '第 ' + (i + 1) + ' 讲 · ' + String((first && first.title) || part.title || ''),
      goal: '',
      in: '',
      out: '',
      chars: group.chars,
      pages,
      status: 'draft',
    };
    if (group.slice) {
      lecture.slice = {
        chapter: group.slice.chapter,
        from: group.slice.from,
        to: group.slice.to,
        part: group.slice.partLabel || '',
      };
    }
    return lecture;
  });
  const totalChars = lectures.reduce((sum, l) => sum + l.chars, 0);
  const totalPages = lectures.reduce((sum, l) => sum + l.pages, 0);
  return attachSectionPlan({
    throughline: String(part.title || ''),
    lectures,
    seams: [],
    terms: [],
    cut_notes: [],
    totalChars,
    totalPages,
    estMinutes: totalPages,
    source: 'rule',
    stitched: false,
  }, chapters, book);
}

function findChapter(list, n) {
  return list.find((c) => Number(c.n) === Number(n));
}

function validateModelPlan(data, part, chapters, book = null) {
  if (!data || typeof data !== 'object') throw new Error('不是 JSON 对象');
  const throughline = String(data.throughline || '').trim();
  if (!throughline) throw new Error('缺少 throughline');
  const lectures = Array.isArray(data.lectures) ? data.lectures : null;
  if (!lectures || !lectures.length || lectures.length > MAX_LECTURES) throw new Error('lectures 数量不合法');

  const expected = chapters.map((c) => Number(c.n)).sort((a, b) => a - b);
  const seen = [];
  const normalized = [];
  for (let i = 0; i < lectures.length; i += 1) {
    const item = lectures[i] || {};
    if (Number(item.n) !== i + 1) throw new Error('讲次不连续');
    const nums = Array.isArray(item.chapters) ? item.chapters.map(Number) : [];
    if (!nums.length || nums.length > MAX_CHAPTERS_PER_LECTURE) throw new Error('第 ' + (i + 1) + ' 讲章数不合法');
    if (new Set(nums).size !== nums.length) throw new Error('第 ' + (i + 1) + ' 讲有重复章');
    let chars = 0;
    for (const n of nums) {
      const chapter = findChapter(chapters, n);
      if (!chapter) throw new Error('第 ' + (i + 1) + ' 讲引用了不存在的章 ' + n);
      chars += charsOf(chapter);
      seen.push(n);
    }
    if (chars > HARD_CHARS) throw new Error('第 ' + (i + 1) + ' 讲超过 8 万字');
    normalized.push({
      n: i + 1,
      chapters: nums.slice().sort((a, b) => a - b),
      title: String(item.title || '第 ' + (i + 1) + ' 讲').trim().slice(0, 80),
      goal: String(item.goal || '').trim().slice(0, 200),
      in: String(item.in || '').trim().slice(0, 200),
      out: String(item.out || '').trim().slice(0, 200),
      chars,
      pages: clamp(Math.round(chars / 2000), 6, 30),
      status: 'draft',
    });
  }
  seen.sort((a, b) => a - b);
  if (JSON.stringify(seen) !== JSON.stringify(expected)) throw new Error('讲章覆盖与 Part 不一致');

  const seams = Array.isArray(data.seams) ? data.seams : [];
  if (seams.length !== normalized.length - 1) throw new Error('seams 数量应为讲数 −1');
  const normalizedSeams = seams.map((s, i) => {
    const sentence = String((s && s.sentence) || '').trim();
    if (!sentence || sentence.length > 60) throw new Error('接缝句为空或超过 60 字');
    if (Number(s.from) !== i + 1 || Number(s.to) !== i + 2) throw new Error('接缝 from/to 不连续');
    return {
      from: i + 1,
      to: i + 2,
      concept: String((s && s.concept) || '').trim().slice(0, 40),
      sentence,
    };
  });

  const corpus = chapters.map((c) => c.title + '\n' + String(c.text || '')).join('\n');
  const briefCorpus = chapters.map((c) => (c.brief ? [c.brief.gist, c.brief.role, ...(c.brief.sections || [])].join('\n') : '')).join('\n');
  const terms = (Array.isArray(data.terms) ? data.terms : []).map((t) => ({
    name: String((t && t.name) || '').trim().slice(0, 40),
    forbid: Array.isArray(t && t.forbid) ? t.forbid.map((x) => String(x).trim()).filter(Boolean).slice(0, 20) : [],
  })).filter((t) => t.name);
  for (const term of terms) {
    if (!corpus.includes(term.name) && !briefCorpus.includes(term.name)) {
      throw new Error('术语“' + term.name + '”没有出现在原文或 briefs 中');
    }
  }

  const totalChars = normalized.reduce((sum, l) => sum + l.chars, 0);
  const totalPages = normalized.reduce((sum, l) => sum + l.pages, 0);
  return attachSectionPlan({
    throughline,
    lectures: normalized,
    seams: normalizedSeams,
    terms,
    cut_notes: Array.isArray(data.cut_notes) ? data.cut_notes.slice(0, 20) : [],
    totalChars,
    totalPages,
    estMinutes: totalPages,
    source: 'model',
    stitched: true,
  }, chapters, book);
}

async function enrichSplitPlan({ ctx, book, part, chapters, base, dir, force }) {
  const prompt = metaPromptText();
  if (!prompt) {
    return { plan: base, briefs: null, warnings: ['超长章已拆分；讲纲元信息提示词缺失，系列保持 unstitched。'] };
  }
  const briefOut = await buildBriefs({ ctx, book, dir: dir || book.dir, chapters, force });
  const withBrief = chapters.map((c, i) => Object.assign({}, c, { brief: briefOut.briefs[i] }));
  const input = {
    part: { title: part.title, chapters: part.chapters },
    lectures: base.lectures.map((l) => {
      const chapter = withBrief.find((c) => c.n === Number(l.chapters[0]));
      const sections = chapter && l.slice ? sliceSections(chapter, l.slice) : (chapter && chapter.brief ? chapter.brief.sections || [] : []);
      return {
        n: l.n,
        chapters: l.chapters,
        title: l.title,
        chars: l.chars,
        slice: l.slice || null,
        sections,
        scope: { first: sections[0] || '', last: sections[sections.length - 1] || '', count: sections.length },
        preview: chapter && l.slice ? slicePreview(chapter, l.slice) : '',
      };
    }),
    chapters: withBrief.map((c) => ({ n: c.n, title: c.title, brief: c.brief })),
  };
  const user =
    '【Part】' +
    (part.title || '') +
    '\n【已拆讲次】\n' +
    JSON.stringify(input) +
    '\n注意：每讲可能包含多个 Item/小节，必须按上面每讲的 sections 概括，不能把整章缩成单一 Item。';
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let reply;
    try {
      reply = await callModel(ctx, prompt, attempt === 0 ? user : user + '\n\n上一次输出不合格：' + lastError + '\n只输出 JSON。', {
        maxTokens: 6000,
        stage: 'plan',
      });
    } catch (err) {
      return { plan: base, briefs: briefOut, warnings: ['超长章已拆分；讲纲模型调用失败：' + String((err && err.message) || err) + '，系列保持 unstitched。'] };
    }
    try {
      const data = readJsonBlock(reply.text);
      const throughline = String(data.throughline || '').trim();
      if (!throughline) throw new Error('缺少 throughline');
      const seams = Array.isArray(data.seams) ? data.seams : [];
      if (seams.length !== base.lectures.length - 1) throw new Error('seams 数量应为讲数 −1');
      const normalizedSeams = seams.map((s, i) => {
        const sentence = String((s && s.sentence) || '').trim();
        if (!sentence || sentence.length > 60) throw new Error('接缝句为空或超过 60 字');
        if (Number(s.from) !== i + 1 || Number(s.to) !== i + 2) throw new Error('接缝 from/to 不连续');
        return { from: i + 1, to: i + 2, concept: String((s && s.concept) || '').trim().slice(0, 40), sentence };
      });
      const corpus = chapters.map((c) => c.title + '\n' + String(c.text || '')).join('\n');
      const briefCorpus = withBrief.map((c) => (c.brief ? [c.brief.gist, c.brief.role, ...(c.brief.sections || [])].join('\n') : '')).join('\n');
      const terms = (Array.isArray(data.terms) ? data.terms : []).map((t) => ({
        name: String((t && t.name) || '').trim().slice(0, 40),
        forbid: Array.isArray(t && t.forbid) ? t.forbid.map((x) => String(x).trim()).filter(Boolean).slice(0, 20) : [],
      })).filter((t) => t.name);
      for (const term of terms) {
        if (!corpus.includes(term.name) && !briefCorpus.includes(term.name)) {
          throw new Error('术语“' + term.name + '”没有出现在原文或 briefs 中');
        }
      }
      if (!metaCoversScopes(throughline, normalizedSeams, input.lectures)) {
        throw new Error('讲纲没有覆盖每讲实际小节范围');
      }
      return {
        plan: Object.assign({}, base, { throughline, seams: normalizedSeams, terms, source: 'model', stitched: true }),
        briefs: briefOut,
        warnings: [...(briefOut.warnings || []), '第 ' + chapters.find((c) => charsOf(c) > CHAPTER_SPLIT_CHARS).n + ' 章超过 6 万字，已按节拆成 ' + base.lectures.length + ' 讲并生成接缝。'],
      };
    } catch (err) {
      lastError = String((err && err.message) || err);
    }
  }
  return {
    plan: deterministicSplitMeta(base, input.lectures),
    briefs: briefOut,
    warnings: ['超长章已拆分；模型讲纲未覆盖实际小节：' + lastError + '，已用节标题生成范围说明（unstitched）。'],
  };
}

function fallbackMustKeep(title) {
  const text = String(title || '').replace(/^\s*\d+(?:\.\d+)*\s*/, '').trim();
  const parts = text.split(/[\s、,，/与和及]+/).filter(Boolean);
  const out = [];
  for (const part of parts) {
    if (part.length < 2 || part.length > 8) continue;
    if (!out.includes(part)) out.push(part);
    if (out.length >= 3) break;
  }
  if (out.length) return out;
  const compact = text.replace(/\s+/g, '');
  return compact ? [compact.slice(0, 8)] : ['本节'];
}

function fallbackSectionPages(sections, target) {
  const pages = sections.map(() => 1);
  let remaining = Math.max(0, Math.min(30, Number(target) || 0) - 1 - pages.length);
  const order = sections
    .map((section, index) => ({
      index,
      weight: Math.max(1, (sections[index + 1] ? sections[index + 1].page : section.page + 1) - section.page),
    }))
    .sort((a, b) => b.weight - a.weight);
  let guard = 0;
  while (remaining > 0 && guard < 100) {
    let changed = false;
    for (const item of order) {
      if (remaining <= 0) break;
      if (pages[item.index] >= 5) continue;
      pages[item.index] += 1;
      remaining -= 1;
      changed = true;
    }
    if (!changed) break;
    guard += 1;
  }
  return sections.map((section, index) => {
    const existing = Array.isArray(section.must_keep) ? section.must_keep.filter(Boolean) : [];
    return {
      ...section,
      pages: pages[index],
      must_keep: existing.length ? existing : fallbackMustKeep(section.title),
      must_keep_fallback: existing.length ? false : true,
    };
  });
}

function validateSectionAllocation(data, sections, min, max) {
  if (!data || !Array.isArray(data.sections)) throw new Error('缺少 sections 数组');
  const byKey = new Map(sections.map((section) => [normalizeSectionTitle(section.title), section]));
  const seen = new Set();
  const out = [];
  for (const item of data.sections) {
    const key = normalizeSectionTitle(item && item.title);
    const section = byKey.get(key);
    if (!section) throw new Error('出现了不存在的节：' + String((item && item.title) || ''));
    if (seen.has(key)) throw new Error('节重复：' + item.title);
    seen.add(key);
    const pages = Math.round(Number(item.pages) || 0);
    if (pages < 1 || pages > 5) throw new Error('节页数必须在 1–5：' + item.title + ' ' + pages);
    const mustKeep = [];
    for (const raw of Array.isArray(item.must_keep) ? item.must_keep : []) {
      const value = String(raw || '').trim();
      if (!value) continue;
      if (value.length > 8) throw new Error('must_keep 必须是短关键词（≤8 字）：' + value);
      if (/[=()（）]/.test(value)) throw new Error('must_keep 不要写公式：' + value);
      if (!mustKeep.includes(value)) mustKeep.push(value);
      if (mustKeep.length >= 5) break;
    }
    if (!mustKeep.length) throw new Error('缺少 must_keep：' + item.title);
    out.push(Object.assign({}, section, { pages, must_keep: mustKeep }));
  }
  if (out.length !== sections.length) throw new Error('节数量不一致');
  const totalPages = 1 + out.reduce((sum, section) => sum + section.pages, 0);
  if (totalPages < min || totalPages > max) {
    throw new Error('总页数 ' + totalPages + ' 不在预算 ' + min + '–' + max);
  }
  return { sections: out, total_pages: totalPages };
}

/**
 * 讲纲阶段：让 LLM 在预算内自主分配每个 leaf 的页数 + must_keep。
 * 失败/无模型时退化为确定性分配（1 页/节，按页跨度补足到 target）。
 */
async function allocateSectionPages({ ctx, book, plan, briefs }) {
  const prompt = sectionPromptText();
  for (const lecture of (plan && plan.lectures) || []) {
    if (lecture.slice) continue;
    const sections = Array.isArray(lecture.sections) ? lecture.sections : [];
    if (!sections.length) continue;
    const brief = (briefs && Array.isArray(briefs.briefs) ? briefs.briefs : [])
      .find((item) => Number(item.n) === Number((lecture.chapters || [])[0]));
    const target = clamp(Math.round((Number(lecture.chars) || 0) / 1100), sections.length + 1, 30);
    const min = Math.max(sections.length + 1, target - 2);
    const max = Math.min(30, target + 3);
    let allocated = null;
    let lastError = '';
    if (ctx && prompt) {
      const input = {
        book: String((book && book.title) || ''),
        lecture: {
          title: String(lecture.title || ''),
          goal: String(lecture.goal || ''),
          chars: Number(lecture.chars) || 0,
        },
        brief: brief ? { gist: brief.gist, role: brief.role, sections: brief.sections } : null,
        sections: sections.map((section) => ({
          title: section.title,
          parent: section.parent || '',
          page: section.page,
        })),
        budget: { target, min, max, cover: 1 },
      };
      const user = '【节页分配】\n' + JSON.stringify(input) + '\n【硬约束】每个 leaf 恰好一条；total_pages=1+Σpages，落在 ' + min + '–' + max + '；每节 1–5 页；must_keep 2–5 条。只输出 JSON。';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const reply = await callModel(
            ctx,
            prompt,
            attempt === 0 ? user : user + '\n\n上一次不合格：' + lastError + '\n只输出 JSON。',
            { maxTokens: 6000, stage: 'plan' },
          );
          const checked = validateSectionAllocation(readJsonBlock(reply.text), sections, min, max);
          allocated = checked.sections;
          lecture.pages = checked.total_pages;
          lecture.section_source = 'model';
          break;
        } catch (err) {
          lastError = String((err && err.message) || err);
        }
      }
    }
    if (!allocated) {
      const fallback = fallbackSectionPages(sections, target);
      lecture.sections = fallback;
      lecture.pages = clamp(1 + fallback.reduce((sum, section) => sum + section.pages, 0), 6, 30);
      lecture.section_source = 'rule';
    } else {
      lecture.sections = allocated;
    }
  }
  if (plan) {
    plan.totalPages = (plan.lectures || []).reduce((sum, lecture) => sum + (Number(lecture.pages) || 0), 0);
    plan.estMinutes = plan.totalPages;
  }
  return plan;
}

async function buildPlanCore({ ctx, book, part, chapters, dir = '', force = false }) {
  const base = rulePlan(part, chapters, book);
  const huge = chapters.filter((c) => charsOf(c) > CHAPTER_SPLIT_CHARS);
  if (huge.length) {
    const detail = huge
      .map((c) => '第 ' + c.n + ' 章 ' + charsOf(c) + ' 字')
      .join('、');
    if (!ctx) {
      return {
        plan: base,
        briefs: null,
        warnings: [detail + '超过单章 6 万字，已自动按节拆成上/下；没有可用模型，系列保持 unstitched。'],
      };
    }
    const split = await enrichSplitPlan({ ctx, book, part, chapters, base, dir, force });
    return split;
  }
  if (!ctx) return { plan: base, briefs: null, warnings: ['没有可用模型，讲纲使用规则 planning（unstitched）。'] };

  const prompt = promptText();
  if (!prompt) return { plan: base, briefs: null, warnings: ['讲纲提示词缺失，使用规则 planning。'] };

  const briefOut = await buildBriefs({ ctx, book, dir: dir || book.dir, chapters, force });
  const withBrief = chapters.map((c, i) => Object.assign({}, c, { brief: briefOut.briefs[i] }));
  const input = {
    part: { title: part.title, chapters: part.chapters },
    chapters: withBrief.map((c) => ({
      n: c.n,
      title: c.title,
      chars: charsOf(c),
      brief: c.brief,
    })),
    capacity: { targetChars: TARGET_CHARS, maxChars: HARD_CHARS, maxLectures: MAX_LECTURES, maxChaptersPerLecture: MAX_CHAPTERS_PER_LECTURE },
  };
  const user = '【Part】' + (part.title || '') + '\n【章介绍】\n' + JSON.stringify(input);
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let reply;
    try {
      reply = await callModel(ctx, prompt, attempt === 0 ? user : user + '\n\n上一次输出不合格：' + lastError + '\n只输出 JSON。', {
        maxTokens: 12000,
        stage: 'plan',
      });
    } catch (err) {
      return { plan: base, briefs: briefOut, warnings: ['讲纲模型调用失败：' + String((err && err.message) || err) + '，已使用规则 planning。'] };
    }
    try {
      const parsed = validateModelPlan(readJsonBlock(reply.text), part, withBrief, book);
      return { plan: parsed, briefs: briefOut, warnings: briefOut.warnings || [] };
    } catch (err) {
      lastError = String((err && err.message) || err);
    }
  }
  return {
    plan: base,
    briefs: briefOut,
    warnings: ['讲纲输出不合格：' + lastError + '，已使用规则 planning（unstitched）。'],
  };
}

/**
 * 对外入口：先走原讲纲（规则/模型），再在同一“讲纲阶段”做节页分配。
 * 分配失败不能拖垮讲纲：保留 attachSectionPlan 的默认 1 页/节 + 页数下限。
 */
export async function buildPlan(options) {
  const out = await buildPlanCore(options || {});
  if (!out || !out.plan) return out;
  if (options.sectionAllocation === false) return out;
  try {
    const plan = await allocateSectionPages({
      ctx: options.ctx || null,
      book: options.book,
      plan: out.plan,
      briefs: out.briefs,
    });
    return Object.assign({}, out, { plan });
  } catch (err) {
    return Object.assign({}, out, {
      warnings: [...(out.warnings || []), '节页分配失败：' + String((err && err.message) || err).slice(0, 200)],
    });
  }
}

export { charsOf };
