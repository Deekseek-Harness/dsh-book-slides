/**
 * 2.0 分章：独立于导入的 build/calibrate。
 *
 * - auto：沿用 1.x 的书签/标题/机械启发式（text.buildChapters）；
 * - toc：优先 PDF 书签；没有书签时退回 auto，并给出 warning；
 * - mech：固定页数/字数机械切分。
 */
import fs from 'node:fs';
import path from 'node:path';

import { buildChapters as heuristicChapters, cleanPages } from '../text.js';
import { extractOutline } from './pdf.js';
import { loadBook, writeChapters } from './books.js';

export class ChapterError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'ChapterError';
    this.code = code;
    this.hint = hint || '';
  }
}

function pageNo(pages, index) {
  return Number((pages[index] && pages[index].page) || index + 1);
}

function charsBetween(pages, from, to) {
  let chars = 0;
  for (const page of pages) {
    const n = Number((page && page.page) || 0);
    if (n >= from && n <= to) chars += String((page && page.text) || '').length;
  }
  return chars;
}

function mechChapters(pages) {
  const out = [];
  let start = 0;
  let chars = 0;
  const flush = (end) => {
    if (end <= start) return;
    const from = pageNo(pages, start);
    const to = pageNo(pages, end - 1);
    out.push({
      n: out.length + 1,
      title: '第 ' + (out.length + 1) + ' 部分',
      from,
      to,
      chars: charsBetween(pages, from, to),
      toc: false,
      front: false,
      fallback: true,
    });
  };
  for (let i = 0; i < pages.length; i += 1) {
    chars += String((pages[i] && pages[i].text) || '').length;
    const count = i - start + 1;
    if (count >= 20 || chars >= 12000) {
      flush(i + 1);
      start = i + 1;
      chars = 0;
    }
  }
  flush(pages.length);
  return out.length ? out : [{ n: 1, title: '全文', from: 1, to: pages.length, chars: 0, toc: false, front: false, fallback: true }];
}

function outlineChapters(outline, pages) {
  const entries = [];
  for (const item of outline) {
    if (!item.page || item.page < 1) continue;
    if (entries.length && item.page <= entries[entries.length - 1].from) continue;
    entries.push({ title: item.title, from: item.page, depth: item.depth });
  }
  if (entries.length < 2) return [];
  const total = pages.length;
  const out = [];
  for (let i = 0; i < entries.length; i += 1) {
    const from = Math.max(1, Math.min(total, entries[i].from));
    const to = i + 1 < entries.length ? Math.max(from, Math.min(total, entries[i + 1].from - 1)) : total;
    out.push({
      n: out.length + 1,
      title: entries[i].title,
      from,
      to,
      chars: charsBetween(pages, from, to),
      toc: true,
      front: false,
    });
  }
  return out;
}

export function validateChapters(chapters, pages) {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    throw new ChapterError('E_CHAPTER_EMPTY', '没有章节', '至少保留一章。');
  }
  const total = pages.length;
  let previousTo = 0;
  for (let i = 0; i < chapters.length; i += 1) {
    const c = chapters[i] || {};
    const from = Number(c.from);
    const to = Number(c.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > total || from > to) {
      throw new ChapterError('E_CHAPTER_RANGE', '第 ' + (i + 1) + ' 章页范围非法', '检查起止页是否在书内。');
    }
    if (i > 0 && from <= previousTo) {
      throw new ChapterError('E_CHAPTER_OVERLAP', '第 ' + (i + 1) + ' 章与上一章重叠', '起止页必须递增且不重叠。');
    }
    previousTo = to;
  }
  return true;
}

export function normalizeChapters(chapters) {
  return (Array.isArray(chapters) ? chapters : [])
    .map((c, i) => ({
      n: i + 1,
      title: String((c && c.title) || '第 ' + (i + 1) + ' 章').trim().slice(0, 200) || '第 ' + (i + 1) + ' 章',
      from: Math.round(Number(c && c.from)),
      to: Math.round(Number(c && c.to)),
      chars: Number(c && c.chars) || 0,
      source: String((c && (c.source || c.chapterSource)) || 'manual'),
      manual: c && c.manual === true,
      front: c && c.front === true,
      toc: c && c.toc === true,
    }))
    .filter((c) => Number.isInteger(c.from) && Number.isInteger(c.to) && c.from >= 1 && c.to >= c.from)
    .sort((a, b) => a.from - b.from)
    .map((c, i) => Object.assign({}, c, { n: i + 1 }));
}

function hasManual(chapters) {
  return (Array.isArray(chapters) ? chapters : []).some((c) => c && c.manual);
}

export async function buildBookChapters(bookId, mode = 'auto', { force = false } = {}) {
  const loaded = loadBook(bookId);
  if (!loaded) throw new ChapterError('E_NOT_FOUND', '找不到这本书', '书架里可能已经删掉了。');
  if (hasManual(loaded.chapters) && !force) {
    throw new ChapterError('E_MANUAL_EDITS', '这本书有手动修改过的章', '重新分章会覆盖它们；确认后带 force 再来一次。');
  }

  const rawPages = JSON.parse(fs.readFileSync(path.join(loaded.dir, 'pages.json'), 'utf8'));
  if (!Array.isArray(rawPages) || rawPages.length === 0) {
    throw new ChapterError('E_NO_PAGES', '这本书没有存下逐页文本', '删掉重新导入一次。');
  }

  const clean = cleanPages(rawPages);
  const warnings = [];
  let chapters = [];
  let source = mode;

  if (mode === 'mech') {
    chapters = mechChapters(clean);
  } else if (mode === 'toc') {
    try {
      const buffer = fs.readFileSync(path.join(loaded.dir, 'source.pdf'));
      const outline = await extractOutline(buffer);
      chapters = outlineChapters(outline, clean);
      if (!chapters.length) warnings.push('没有可用的 PDF 书签，已回退自动分章。');
    } catch (err) {
      warnings.push('读取 PDF 书签失败，已回退自动分章。');
    }
    if (!chapters.length) {
      chapters = heuristicChapters(clean);
      source = 'auto';
    }
  } else {
    chapters = heuristicChapters(clean);
    source = 'auto';
  }

  if (!chapters.length) {
    chapters = mechChapters(clean);
    source = 'mech';
    warnings.push('自动分章结果为空，已使用机械分章。');
  }

  chapters = normalizeChapters(chapters);
  validateChapters(chapters, clean);
  for (const c of chapters) {
    if (!c.source || c.source === 'manual') c.source = source;
  }
  writeChapters(bookId, chapters, source);
  return { chapters, source, mode, warnings, confidence: source === 'toc' ? 0.95 : 0.7 };
}

export function saveBookChapters(bookId, chapters) {
  const loaded = loadBook(bookId);
  if (!loaded) throw new ChapterError('E_NOT_FOUND', '找不到这本书', '');
  const rawPages = JSON.parse(fs.readFileSync(path.join(loaded.dir, 'pages.json'), 'utf8'));
  const normalized = normalizeChapters(chapters);
  validateChapters(normalized, rawPages);
  const old = loaded.chapters || [];
  const next = normalized.map((c, i) => {
    const prev = old[i];
    const changed =
      !prev ||
      String(prev.title || '') !== c.title ||
      Number(prev.from) !== c.from ||
      Number(prev.to) !== c.to ||
      Boolean(prev.front) !== Boolean(c.front);
    return Object.assign({}, c, {
      manual: Boolean(c.manual) || changed,
      source: c.source || prev?.source || 'manual',
    });
  });
  writeChapters(bookId, next, loaded.book.chapterSource || 'manual');
  return next;
}
