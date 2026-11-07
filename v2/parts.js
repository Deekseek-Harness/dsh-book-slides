/**
 * 2.0 Part：独立于生成的章节分组。
 * 确认 Part 只写 parts.json；生成只读 partId。
 */
import fs from 'node:fs';
import path from 'node:path';

import { loadBook, newId } from './books.js';
import { readJson, writeJson } from './root.js';

export class PartError extends Error {
  constructor(code, message, hint, conflicts) {
    super(message);
    this.name = 'PartError';
    this.code = code;
    this.hint = hint || '';
    if (conflicts) this.conflicts = conflicts;
  }
}

function partsFile(loaded) {
  return path.join(loaded.dir, 'parts.json');
}

function readParts(loaded) {
  const data = readJson(partsFile(loaded), null) || {};
  return Array.isArray(data.parts) ? data.parts : [];
}

function writeParts(loaded, parts) {
  writeJson(partsFile(loaded), { schema: 1, book_id: loaded.book.id, parts });
}

function chaptersOf(loaded) {
  return Array.isArray(loaded.chapters) ? loaded.chapters : [];
}

function contentNumbers(loaded) {
  const set = new Set();
  for (const c of chaptersOf(loaded)) {
    if (c && c.front !== true) set.add(Number(c.n));
  }
  return set;
}

function chapterChars(loaded, n) {
  const c = chaptersOf(loaded).find((item) => Number(item.n) === Number(n));
  return Number(c && c.chars) || 0;
}

function sumChars(loaded, chapters) {
  return chapters.reduce((sum, n) => sum + chapterChars(loaded, n), 0);
}

function normalizeTitle(loaded, chapters) {
  const list = chaptersOf(loaded).filter((c) => chapters.includes(Number(c.n)));
  if (!list.length) return '部分';
  const first = list[0];
  const last = list[list.length - 1];
  if (list.length === 1) return String(first.title || '第 ' + first.n + ' 章');
  return '第 ' + first.n + '–' + last.n + ' 章';
}

function validateSelection(loaded, chapters, { ignorePartId = '' } = {}) {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    throw new PartError('E_PART_EMPTY', '至少选 1 章', '勾选章节后再确认。');
  }
  const nums = chapters.map((n) => Number(n));
  if (nums.some((n) => n === 0)) {
    throw new PartError('E_PART_FRONT', '前文/目录页不能单独成 Part', '只选内容章。');
  }
  if (nums.some((n) => !Number.isInteger(n) || n < 1)) {
    throw new PartError('E_PART_BAD_CHAPTER', '章号不合法', '');
  }
  if (new Set(nums).size !== nums.length) {
    throw new PartError('E_PART_DUP', '同一章被选了多次', '去掉重复项再试。');
  }
  const content = contentNumbers(loaded);
  if (nums.some((n) => !content.has(n))) {
    throw new PartError('E_PART_FRONT', '前文/目录页不能单独成 Part', '只选内容章。');
  }
  if (nums.length > 48) {
    throw new PartError('E_PART_TOO_MANY', '一个 Part 最多 48 章', '拆成两个 Part。');
  }
  const existing = readParts(loaded).filter((p) => p.id !== ignorePartId);
  const conflicts = [];
  for (const part of existing) {
    const hit = nums.filter((n) => (part.chapters || []).includes(n));
    if (hit.length) conflicts.push({ partId: part.id, title: part.title, chapters: hit });
  }
  if (conflicts.length) {
    throw new PartError(
      'E_PART_CONFLICT',
      '第 ' + conflicts[0].chapters.join('、') + ' 章已属于《' + conflicts[0].title + '》',
      '该章已属于其它 Part；请先在原 Part「编辑」中移出，再加入新 Part。',
      conflicts,
    );
  }
  return nums.slice().sort((a, b) => a - b);
}

export function listParts(bookId) {
  const loaded = loadBook(bookId);
  if (!loaded) return [];
  return readParts(loaded).map((part) => ({
    ...part,
    chars: sumChars(loaded, part.chapters || []),
  }));
}

export function savePart({ bookId, chapters, title, partId = '', source = 'manual' }) {
  const loaded = loadBook(bookId);
  if (!loaded) throw new PartError('E_NOT_FOUND', '找不到这本书', '');
  const parts = readParts(loaded);
  const nums = validateSelection(loaded, chapters, { ignorePartId: partId });
  const now = new Date().toISOString();

  if (partId) {
    const index = parts.findIndex((p) => p.id === partId);
    if (index < 0) throw new PartError('E_PART_NOT_FOUND', '找不到这个 Part', '');
    const current = parts[index];
    const merged = Array.from(new Set([...(current.chapters || []), ...nums])).sort((a, b) => a - b);
    // 合并后的整体再校验一次，避免把别的 Part 的章带进来
    validateSelection(loaded, merged, { ignorePartId: partId });
    const next = {
      ...current,
      title: String(title || current.title || '').trim() || normalizeTitle(loaded, merged),
      chapters: merged,
      source: source || current.source || 'manual',
      version: Number(current.version || 1) + 1,
      updated_at: now,
    };
    parts[index] = next;
    writeParts(loaded, parts);
    return { ...next, chars: sumChars(loaded, merged) };
  }

  const id = newId(10);
  const part = {
    id,
    title: String(title || '').trim() || normalizeTitle(loaded, nums),
    chapters: nums,
    source: String(source || 'manual'),
    version: 1,
    created_at: now,
    updated_at: now,
  };
  parts.push(part);
  writeParts(loaded, parts);
  return { ...part, chars: sumChars(loaded, nums) };
}

export function updatePart({ bookId, partId, title, addChapters = [], removeChapters = [] }) {
  const loaded = loadBook(bookId);
  if (!loaded) throw new PartError('E_NOT_FOUND', '找不到这本书', '');
  const parts = readParts(loaded);
  const index = parts.findIndex((p) => p.id === partId);
  if (index < 0) throw new PartError('E_PART_NOT_FOUND', '找不到这个 Part', '');
  const current = parts[index];
  let chapters = (current.chapters || []).filter((n) => !removeChapters.map(Number).includes(Number(n)));
  chapters = Array.from(new Set([...chapters, ...addChapters.map(Number)])).sort((a, b) => a - b);
  const nums = validateSelection(loaded, chapters, { ignorePartId: partId });
  const next = {
    ...current,
    title: String(title == null ? current.title : title).trim() || normalizeTitle(loaded, nums),
    chapters: nums,
    version: Number(current.version || 1) + 1,
    updated_at: new Date().toISOString(),
  };
  parts[index] = next;
  writeParts(loaded, parts);
  return { ...next, chars: sumChars(loaded, nums) };
}

export function deletePart(bookId, partId) {
  const loaded = loadBook(bookId);
  if (!loaded) throw new PartError('E_NOT_FOUND', '找不到这本书', '');
  const parts = readParts(loaded);
  const next = parts.filter((p) => p.id !== partId);
  if (next.length === parts.length) throw new PartError('E_PART_NOT_FOUND', '找不到这个 Part', '');
  writeParts(loaded, next);
  return true;
}

export function getPart(bookId, partId) {
  const loaded = loadBook(bookId);
  if (!loaded) return null;
  const part = readParts(loaded).find((p) => p.id === partId);
  if (!part) return null;
  return { ...part, chars: sumChars(loaded, part.chapters || []) };
}

export function partChapterTexts(bookId, partId) {
  const loaded = loadBook(bookId);
  if (!loaded) return null;
  const part = readParts(loaded).find((p) => p.id === partId);
  if (!part) return null;
  const pages = readJson(path.join(loaded.dir, 'pages.json'), []);
  const chapters = chaptersOf(loaded).filter((c) => (part.chapters || []).includes(Number(c.n)));
  const out = chapters.map((c) => {
    const text = (Array.isArray(pages) ? pages : [])
      .filter((p) => Number(p.page) >= Number(c.from) && Number(p.page) <= Number(c.to))
      .map((p) => String(p.text || ''))
      .join('\n');
    return { n: Number(c.n), title: String(c.title || ''), from: Number(c.from), to: Number(c.to), chars: Number(c.chars) || text.length, text };
  });
  return { loaded, part, chapters: out };
}

export { validateSelection, sumChars };
