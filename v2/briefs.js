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
  const sections = Array.isArray(item && item.sections)
    ? item.sections.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 6)
    : [];
  return {
    n: Number(fallback.n),
    gist: String((item && item.gist) || fallback.gist).trim().slice(0, 100) || fallback.gist,
    // 模型留空时用原文标题补齐：空数组不是“有结构”，只是“没写”
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
      warnings.push('第 ' + chapter.n + ' 章 brief 的 sections 未逐字出现在原文，已回退标题 + 首尾段。');
      return fallbackBrief(chapter);
    }
    return mergeBrief(item, fallbackBrief(chapter));
  });
  return { briefs, warnings, rejected };
}

/**
 * 读盘并校验 briefs.json（不写盘、不覆盖人工修改）。
 * @returns {{stored:object|null, briefs:Array|null, warnings:string[], rejected:number[]}}
 */
export function readBriefs(dir, chapters) {
  const stored = readJson(path.join(dir, 'briefs.json'), null);
  if (!stored || !Array.isArray(stored.briefs)) {
    return { stored: null, briefs: null, warnings: ['briefs.json 缺失或不可读。'], rejected: [] };
  }
  const checked = checkBriefs(stored.briefs, chapters);
  return { stored, briefs: checked.briefs, warnings: checked.warnings, rejected: checked.rejected };
}

export async function buildBriefs({ ctx, book, dir, chapters, force = false }) {
  const file = path.join(dir, 'briefs.json');
  const cached = readJson(file, null);
  const hash = chapters.map((c) => c.n + ':' + c.chars + ':' + c.title).join('|');
  if (!force && cached && cached.hash === hash && Array.isArray(cached.briefs)) {
    // 缓存不是免检通道：人工改过的 briefs.json 同样要过 sections 原文校验
    const checked = checkBriefs(cached.briefs, chapters);
    return {
      briefs: checked.briefs,
      cached: true,
      fallback: false,
      degraded: checked.warnings.length > 0,
      warnings: checked.warnings,
    };
  }

  const fallback = chapters.map(fallbackBrief);
  if (!ctx) {
    return { briefs: fallback, cached: false, fallback: true, degraded: true, warnings: ['没有可用模型，briefs 使用标题 + 首尾段。'] };
  }

  const prompt = promptText();
  if (!prompt) {
    return { briefs: fallback, cached: false, fallback: true, degraded: true, warnings: ['briefs 提示词缺失，使用标题 + 首尾段。'] };
  }

  const input = chapters.map((c) => ({
    n: c.n,
    title: c.title,
    text: String(c.text || '').slice(0, 6000),
  }));
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
        warnings: ['briefs 模型调用失败：' + String((err && err.message) || err) + '，已回退标题 + 首尾段。'],
      };
    }
    try {
      const data = readJsonBlock(reply.text);
      if (!Array.isArray(data.briefs)) throw new Error('缺少 briefs 数组');
      const checked = checkBriefs(data.briefs, chapters);
      const other = data.briefs.filter((b) => !chapters.some((c) => Number(c.n) === Number(b && b.n)));
      if (other.length) lastError = '出现了不存在的章号';
      const result = {
        briefs: checked.briefs,
        cached: false,
        fallback: false,
        degraded: checked.warnings.length > 0,
        warnings: checked.warnings,
      };
      writeJson(file, { schema: 1, book_id: book.id, hash, briefs: checked.briefs, model: reply.model, at: new Date().toISOString() });
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
    warnings: ['briefs 解析失败：' + lastError + '，已回退标题 + 首尾段。'],
  };
}

export { fallbackBrief, validateBrief };
