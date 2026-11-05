/**
 * 章介绍（briefs）：给讲纲提供结构信息；模型失败时回退“标题 + 首尾段”。
 */
import fs from 'node:fs';
import path from 'node:path';

import { readJson, writeJson } from './root.js';
import { callModel, readJsonBlock } from './llm.js';

const PROMPT = new URL('../prompts/briefs-v1.md', import.meta.url);

function promptText() {
  try {
    return fs.readFileSync(PROMPT, 'utf8');
  } catch {
    return '';
  }
}

function sectionsOf(text, title) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (out.length >= 6) break;
    if (line === title) continue;
    if (/^第[一二三四五六七八九十百0-9]+[章节部分]/.test(line) || /^\d+(?:\.\d+){0,2}[\s、.．]/.test(line) || /^[一二三四五六七八九十]+[、.．]/.test(line)) {
      if (!out.includes(line)) out.push(line.slice(0, 80));
    }
  }
  return out;
}

function fallbackBrief(chapter) {
  const text = String(chapter.text || '').replace(/\s+/g, ' ').trim();
  const title = String(chapter.title || '').trim();
  const body = text.startsWith(title) ? text.slice(title.length).trim() : text;
  return {
    n: Number(chapter.n),
    gist: (body.slice(0, 100) || title || '本章').trim(),
    sections: sectionsOf(chapter.text, title),
    role: '',
    turning: false,
  };
}

function validateBrief(item, chapter) {
  if (!item || Number(item.n) !== Number(chapter.n)) return false;
  const text = String(chapter.text || '');
  const sections = Array.isArray(item.sections) ? item.sections.map((s) => String(s || '').trim()).filter(Boolean) : [];
  // sections 必须逐字能在本章原文中找到
  if (sections.some((s) => !text.includes(s))) return false;
  return true;
}

function mergeBrief(item, fallback) {
  return {
    n: Number(fallback.n),
    gist: String((item && item.gist) || fallback.gist).trim().slice(0, 100) || fallback.gist,
    sections: Array.isArray(item && item.sections)
      ? item.sections.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 6)
      : fallback.sections,
    role: String((item && item.role) || '').trim().slice(0, 120),
    turning: !!(item && item.turning),
  };
}

export async function buildBriefs({ ctx, book, dir, chapters, force = false }) {
  const file = path.join(dir, 'briefs.json');
  const cached = readJson(file, null);
  const hash = chapters.map((c) => c.n + ':' + c.chars + ':' + c.title).join('|');
  if (!force && cached && cached.hash === hash && Array.isArray(cached.briefs)) {
    return { briefs: cached.briefs, cached: true, fallback: false, warnings: [] };
  }

  const fallback = chapters.map(fallbackBrief);
  if (!ctx) {
    return { briefs: fallback, cached: false, fallback: true, warnings: ['没有可用模型，briefs 使用标题 + 首尾段。'] };
  }

  const prompt = promptText();
  if (!prompt) {
    return { briefs: fallback, cached: false, fallback: true, warnings: ['briefs 提示词缺失，使用标题 + 首尾段。'] };
  }

  const input = chapters.map((c) => ({
    n: c.n,
    title: c.title,
    text: String(c.text || '').slice(0, 6000),
  }));
  const user = '【书名】' + (book.title || '') + '\n【章节】\n' + JSON.stringify(input);
  let briefs = null;
  let lastError = '';
  for (let attempt = 0; attempt < 2 && !briefs; attempt += 1) {
    let reply;
    try {
      reply = await callModel(ctx, prompt, attempt === 0 ? user : user + '\n\n上一次输出不合格：' + lastError + '\n只输出 JSON。', {
        maxTokens: 8000,
      });
    } catch (err) {
      return {
        briefs: fallback,
        cached: false,
        fallback: true,
        warnings: ['briefs 模型调用失败：' + String((err && err.message) || err) + '，已回退标题 + 首尾段。'],
      };
    }
    try {
      const data = readJsonBlock(reply.text);
      if (!Array.isArray(data.briefs)) throw new Error('缺少 briefs 数组');
      const byN = new Map(data.briefs.map((b) => [Number(b && b.n), b]));
      const warnings = [];
      briefs = chapters.map((chapter, i) => {
        const item = byN.get(Number(chapter.n));
        if (!item || !validateBrief(item, chapter)) {
          warnings.push('第 ' + chapter.n + ' 章 brief 不可用，已回退。');
          return fallback[i];
        }
        return mergeBrief(item, fallback[i]);
      });
      const other = data.briefs.filter((b) => !chapters.some((c) => Number(c.n) === Number(b && b.n)));
      if (other.length) lastError = '出现了不存在的章号';
      const result = { briefs, cached: false, fallback: false, warnings };
      writeJson(file, { schema: 1, book_id: book.id, hash, briefs, model: reply.model, at: new Date().toISOString() });
      return result;
    } catch (err) {
      lastError = String((err && err.message) || err);
    }
  }

  return {
    briefs: fallback,
    cached: false,
    fallback: true,
    warnings: ['briefs 解析失败：' + lastError + '，已回退标题 + 首尾段。'],
  };
}

export { fallbackBrief, validateBrief };
