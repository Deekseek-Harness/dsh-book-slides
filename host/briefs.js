/**
 * 章介绍（briefs）：给讲纲提供结构信息；模型失败时回退“标题 + 首尾段”。
 * reload-marker: 2026-11-11 verification-1 fulltext+bookmarks
 *
 * v2 验证改动（全文 + 书签小节）：
 * - 不再固定只读每章前 6000 字。单章上限 6 万字、整个 Part 合计 30 万字，
 *   仅用于防止超长 Part 打爆上下文；本测试章 2.1 万字，实际全文送入。
 * - 把 PDF 书签子树里的子标题作为 `bookmark_sections` 一起送入。书签标题
 *   比正文页眉更干净，是“这一章有哪些节/概念”的权威线索。
 * - `sections` 允许来自正文或书签；落盘前做双源校验，并把书签标题补进
 *   `sections`，这样模型只写第一节也不会把后面的节全丢掉。
 */
import fs from 'node:fs';
import path from 'node:path';

import { readJson, writeJson } from './root.js';
import { callModel, readJsonBlock } from './llm.js';

const PROMPT = new URL('../prompts/briefs-v1.md', import.meta.url);

/** 缓存版本：改 briefs 输入/提示词语义时必须 bump。 */
const BRIEFS_VERSION = 'briefs-v2-fulltext-bookmarks';
/** 单章送入模型的原文上限；本测试章 21,069 字，远低于此值。 */
const BRIEF_TEXT_MAX = 60000;
/** 一个 Part 的 briefs 输入总上限；避免 48 章 × 6 万字把上下文打爆。 */
const BRIEF_TOTAL_MAX = 300000;
/** `sections` 最多保留多少条（书签子标题可能很多）。 */
const SECTION_MAX = 24;

function promptText() {
  try {
    return fs.readFileSync(PROMPT, 'utf8');
  } catch {
    return '';
  }
}

/** 小节标题归一：只用于去重/宽松匹配，不改变落盘原文。 */
function normalizeSection(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[−–—－]/g, '-')
    .replace(/[.．、]/g, '.')
    .toLowerCase();
}

/** 从正文行里提取节标题；书签存在时只是兜底。 */
function sectionsOf(text, title) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (out.length >= SECTION_MAX) break;
    if (line === title) continue;
    if (/^第[一二三四五六七八九十百0-9]+[章节部分]/.test(line) || /^\d+(?:\.\d+){0,2}[\s、.．]/.test(line) || /^[一二三四五六七八九十]+[、.．]/.test(line)) {
      // 去掉正文页眉尾巴的页码，例如「1.1 函 数 3」→「1.1 函 数」。
      const cleaned = line.replace(/^(\d+(?:\.\d+){0,2}[\s、.．].*?)\s+\d{1,4}$/, '$1').trim();
      const value = cleaned.slice(0, 80);
      const key = normalizeSection(value);
      if (key && !out.some((item) => normalizeSection(item) === key)) out.push(value);
    }
  }
  return out;
}

/** 递归找书签树里带 n 的根章节点。 */
function findBookmarkNode(nodes, n) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (Number(node && node.n) === Number(n)) return node;
    const hit = findBookmarkNode(node && node.children, n);
    if (hit) return hit;
  }
  return null;
}

/** 没有 n 时按标题兜底（人工改过章标题的旧数据）。 */
function findBookmarkNodeByTitle(nodes, title) {
  const wanted = normalizeSection(title);
  if (!wanted) return null;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (normalizeSection(node && node.title) === wanted) return node;
    const hit = findBookmarkNodeByTitle(node && node.children, title);
    if (hit) return hit;
  }
  return null;
}

/** 某章书签子树里的全部子标题（含页码；不含章根标题）。 */
export function bookmarkSectionEntriesOf(book, chapter) {
  const tree = book && Array.isArray(book.bookmarkTree) ? book.bookmarkTree : [];
  if (!tree.length || !chapter) return [];
  const root = findBookmarkNode(tree, chapter.n) || findBookmarkNodeByTitle(tree, chapter.title);
  if (!root) return [];
  const out = [];
  const walk = (node, depth, parent) => {
    if (depth >= 3) return;
    for (const child of node.children || []) {
      const title = String(child && child.title || '').trim();
      if (title) {
        const key = normalizeSection(title);
        if (key && !out.some((item) => normalizeSection(item.title) === key)) {
          out.push({ title, page: Number(child.page) || 0, depth, parent: String(parent || '').trim() });
        }
      }
      walk(child, depth + 1, title || parent);
    }
  };
  walk(root, 1, '');
  return out.slice(0, 40);
}

/** 某章书签子树里的全部子标题（不含章根标题）。 */
export function bookmarkSectionsOf(book, chapter) {
  return bookmarkSectionEntriesOf(book, chapter).map((item) => item.title);
}

/** 给章节对象挂上 bookmarkSections；build/read 两侧共用。 */
function withBookmarkSections(book, chapters) {
  return (Array.isArray(chapters) ? chapters : []).map((chapter) => {
    const bookmarkSections = bookmarkSectionsOf(book, chapter);
    return bookmarkSections.length ? Object.assign({}, chapter, { bookmarkSections }) : chapter;
  });
}

/** 合并两组节标题，按归一化标题去重，保持先出现顺序。 */
function mergeSections(primary, extra, limit = SECTION_MAX) {
  const out = [];
  for (const item of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(extra) ? extra : [])]) {
    const title = String(item || '').trim();
    if (!title) continue;
    const key = normalizeSection(title);
    if (!key || out.some((existing) => normalizeSection(existing) === key)) continue;
    out.push(title);
    if (out.length >= limit) break;
  }
  return out;
}

function fallbackSectionsOf(chapter) {
  const bookmarks = Array.isArray(chapter.bookmarkSections) ? chapter.bookmarkSections : [];
  return bookmarks.length ? bookmarks : sectionsOf(chapter.text, chapter.title);
}

function fallbackBrief(chapter) {
  const text = String(chapter.text || '').replace(/\s+/g, ' ').trim();
  const title = String(chapter.title || '').trim();
  const body = text.startsWith(title) ? text.slice(title.length).trim() : text;
  return {
    n: Number(chapter.n),
    gist: (body.slice(0, 200) || title || '本章').trim(),
    sections: fallbackSectionsOf(chapter),
    role: '',
    turning: false,
  };
}

/** 一条 section 是否能在正文或书签标题里找到（空白/全半角空格差异容忍）。 */
function sectionExists(section, chapter) {
  const value = String(section || '').trim();
  if (!value) return false;
  const text = String(chapter.text || '');
  if (text.includes(value)) return true;
  const normalized = normalizeSection(value);
  if (!normalized) return false;
  if (normalizeSection(text).includes(normalized)) return true;
  return (Array.isArray(chapter.bookmarkSections) ? chapter.bookmarkSections : [])
    .some((title) => normalizeSection(title) === normalized);
}

function validateBrief(item, chapter) {
  if (!item || Number(item.n) !== Number(chapter.n)) return false;
  const sections = Array.isArray(item.sections) ? item.sections.map((s) => String(s || '').trim()).filter(Boolean) : [];
  // sections 必须能在本章正文或本章书签小节中找到；不是“空集恒真”
  if (sections.some((s) => !sectionExists(s, chapter))) return false;
  return true;
}

function mergeBrief(item, fallback, chapter) {
  const modelSections = Array.isArray(item && item.sections)
    ? item.sections.map((s) => String(s || '').trim()).filter(Boolean)
    : [];
  // 书签存在时，以书签为“必须保留”的结构清单；模型没写全也不会丢。
  const mustKeep = Array.isArray(chapter && chapter.bookmarkSections) && chapter.bookmarkSections.length
    ? chapter.bookmarkSections
    : fallback.sections;
  const sections = mergeSections(modelSections, mustKeep, SECTION_MAX);
  return {
    n: Number(fallback.n),
    gist: String((item && item.gist) || fallback.gist).trim().slice(0, 200) || fallback.gist,
    // 模型留空时用原文/书签标题补齐：空数组不是“有结构”，只是“没写”
    sections: sections.length ? sections : fallback.sections,
    role: String((item && item.role) || '').trim().slice(0, 120),
    turning: !!(item && item.turning),
  };
}

/**
 * 逐章校验一组 brief，不合格的章回退“标题 + 首尾段”。
 * 模型回复与落盘文件走同一处校验：briefs.json 可人工改，但它不是可信输入。
 * @returns {{briefs:Array, warnings:string[], rejected:number[]}}
 */
function checkBriefs(list, chapters) {
  const byN = new Map((Array.isArray(list) ? list : []).map((b) => [Number(b && b.n), b]));
  const warnings = [];
  const rejected = [];
  const briefs = chapters.map((chapter) => {
    const item = byN.get(Number(chapter.n));
    if (!item) {
      rejected.push(Number(chapter.n));
      warnings.push('第 ' + chapter.n + ' 章缺少 brief，已回退标题 + 首尾段。');
      return fallbackBrief(chapter);
    }
    if (!validateBrief(item, chapter)) {
      rejected.push(Number(chapter.n));
      warnings.push('第 ' + chapter.n + ' 章 brief 的 sections 未逐字出现在原文或书签中，已回退标题 + 首尾段。');
      return fallbackBrief(chapter);
    }
    return mergeBrief(item, fallbackBrief(chapter), chapter);
  });
  return { briefs, warnings, rejected };
}

/**
 * 读盘并校验 briefs.json（不写盘、不覆盖人工修改）。
 * `dir` 是书目录；没传 book 时自动读 book.json，以便用书签标题做双源校验。
 * @returns {{stored:object|null, briefs:Array|null, warnings:string[], rejected:number[]}}
 */
export function readBriefs(dir, chapters, book = null) {
  const stored = readJson(path.join(dir, 'briefs.json'), null);
  if (!stored || !Array.isArray(stored.briefs)) {
    return { stored: null, briefs: null, warnings: ['briefs.json 缺失或不可读。'], rejected: [] };
  }
  const source = book || readJson(path.join(dir, 'book.json'), null);
  const list = source ? withBookmarkSections(source, chapters) : chapters;
  const checked = checkBriefs(stored.briefs, list);
  return { stored, briefs: checked.briefs, warnings: checked.warnings, rejected: checked.rejected };
}

export async function buildBriefs({ ctx, book, dir, chapters, force = false }) {
  const file = path.join(dir, 'briefs.json');
  const cached = readJson(file, null);
  const chaptersWithBookmarks = withBookmarkSections(book, chapters);
  const hash = chapters.map((c) => c.n + ':' + c.chars + ':' + c.title).join('|');
  const inputKey = [
    BRIEFS_VERSION,
    ...chaptersWithBookmarks.map((c) =>
      [c.n, String(c.text || '').length, (c.bookmarkSections || []).join('|')].join(':'),
    ),
  ].join('|');
  const chapterCount = Math.max(1, chaptersWithBookmarks.length);
  const perChapter = Math.max(6000, Math.min(BRIEF_TEXT_MAX, Math.floor(BRIEF_TOTAL_MAX / chapterCount)));
  const truncWarnings = chaptersWithBookmarks
    .filter((c) => String(c.text || '').length > perChapter)
    .map((c) => '第 ' + c.n + ' 章超过 ' + perChapter + ' 字，briefs 只读前 ' + perChapter + ' 字。');

  if (!force && cached && cached.hash === hash && cached.input_key === inputKey && Array.isArray(cached.briefs)) {
    // 缓存不是免检通道：人工改过的 briefs.json 同样要过 sections 原文校验
    const checked = checkBriefs(cached.briefs, chaptersWithBookmarks);
    return {
      briefs: checked.briefs,
      cached: true,
      fallback: false,
      degraded: checked.warnings.length > 0,
      warnings: [...checked.warnings, ...truncWarnings],
    };
  }

  const fallback = chaptersWithBookmarks.map(fallbackBrief);
  if (!ctx) {
    return {
      briefs: fallback,
      cached: false,
      fallback: true,
      degraded: true,
      warnings: ['没有可用模型，briefs 使用标题 + 首尾段。', ...truncWarnings],
    };
  }

  const prompt = promptText();
  if (!prompt) {
    return {
      briefs: fallback,
      cached: false,
      fallback: true,
      degraded: true,
      warnings: ['briefs 提示词缺失，使用标题 + 首尾段。', ...truncWarnings],
    };
  }

  const input = chaptersWithBookmarks.map((c) => {
    const full = String(c.text || '');
    return {
      n: c.n,
      title: c.title,
      text: full.slice(0, perChapter),
      truncated: full.length > perChapter,
      bookmark_sections: c.bookmarkSections || [],
    };
  });
  const user = '【书名】' + (book.title || '') + '\n【章节】\n' + JSON.stringify(input);
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let reply;
    try {
      reply = await callModel(ctx, prompt, attempt === 0 ? user : user + '\n\n上一次输出不合格：' + lastError + '\n只输出 JSON。', {
        maxTokens: 8000,
        stage: 'briefs',
      });
    } catch (err) {
      return {
        briefs: fallback,
        cached: false,
        fallback: true,
        degraded: true,
        warnings: ['briefs 模型调用失败：' + String((err && err.message) || err) + '，已回退标题 + 首尾段。', ...truncWarnings],
      };
    }
    try {
      const data = readJsonBlock(reply.text);
      if (!Array.isArray(data.briefs)) throw new Error('缺少 briefs 数组');
      const checked = checkBriefs(data.briefs, chaptersWithBookmarks);
      const other = data.briefs.filter((b) => !chaptersWithBookmarks.some((c) => Number(c.n) === Number(b && b.n)));
      if (other.length) lastError = '出现了不存在的章号';
      const result = {
        briefs: checked.briefs,
        cached: false,
        fallback: false,
        degraded: checked.warnings.length > 0,
        warnings: [...checked.warnings, ...truncWarnings],
      };
      writeJson(file, {
        schema: 1,
        book_id: book.id,
        hash,
        input_key: inputKey,
        version: BRIEFS_VERSION,
        briefs: checked.briefs,
        model: reply.model,
        at: new Date().toISOString(),
      });
      return result;
    } catch (err) {
      lastError = String((err && err.message) || err);
    }
  }

  return {
    briefs: fallback,
    cached: false,
    fallback: true,
    degraded: true,
    warnings: ['briefs 解析失败：' + lastError + '，已回退标题 + 首尾段。', ...truncWarnings],
  };
}

export { fallbackBrief, validateBrief, BRIEFS_VERSION };
