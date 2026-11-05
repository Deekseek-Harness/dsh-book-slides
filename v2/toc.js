/**
 * 印刷目录解析（M1 分章的 toc 路径）。
 *
 * 优先 PDF 书签；没有书签时，把目录页交给模型读成“标题 + 印刷/page”，
 * 再复用 1.x 的校准/锚定算法落到物理页。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  TOC_PROMPT_VERSION,
  buildTocMessages,
  calibrate,
  chaptersFromToc,
  describeEmptyReply,
  parseTocReply,
  replayToc,
  suggestTocRange,
  validateEntries,
  verifyChapters,
} from '../tocparse.js';
import { writeJson } from './root.js';

const PROMPT_FILE = new URL('../prompts/toc-extract-v1.md', import.meta.url);
const TOC_MAX_TOKENS = 16000;
const TOC_RETRY_MAX_TOKENS = 32000;
const TOC_CALL_TIMEOUT_MS = 180000;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function loadPrompt() {
  try {
    return fs.readFileSync(PROMPT_FILE, 'utf8');
  } catch {
    return '';
  }
}

function resolveModel(ctx) {
  let selection = null;
  try {
    const model = ctx && ctx.get ? ctx.get('agentDefaultModel') : null;
    selection = model && typeof model.currentSelection === 'function' ? model.currentSelection() : null;
  } catch {
    selection = null;
  }
  const provider = String((selection && selection.provider) || '').trim();
  const model = String((selection && selection.model) || '').trim();
  if (!provider || !model) throw new Error('DSH 还没选好模型，先去设置里挑一个再回来');
  return { provider, model };
}

async function callModel(ctx, system, user, maxTokens) {
  const llm = ctx && ctx.get ? ctx.get('llm') : null;
  if (!llm || typeof llm.prepareCall !== 'function') throw new Error('这个 DSH 里没有可用的模型服务');
  const target = resolveModel(ctx);
  const timeoutSignal = AbortSignal.timeout(TOC_CALL_TIMEOUT_MS);
  const prepared = await llm.prepareCall({ provider: target.provider, model: target.model, maxTokens }, timeoutSignal);
  const messages = [{ role: 'user', content: [{ type: 'text', text: user }] }];
  let text = '';
  let stopReason = '';
  for await (const chunk of prepared.stream(Object.assign({}, prepared.config, { system, messages, signal: timeoutSignal }))) {
    if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
      continue;
    }
    if (chunk && chunk.type === 'finish' && chunk.reason) {
      stopReason = String(chunk.reason.kind || '');
      if (chunk.reason.kind === 'error') {
        throw new Error('模型报错：' + ((chunk.reason.failure && chunk.reason.failure.message) || '未知原因'));
      }
    }
  }
  return { text, stopReason, model: target.model };
}

function normalizeRange(pages, from, to) {
  const total = pages.length;
  let nextFrom = Math.round(Number(from) || 0);
  let nextTo = Math.round(Number(to) || 0);
  if (!(nextFrom >= 1 && nextTo >= nextFrom && nextTo <= total && nextTo - nextFrom <= 40)) {
    const suggested = suggestTocRange(pages);
    if (!suggested) return null;
    nextFrom = suggested.from;
    nextTo = suggested.to;
  }
  if (!(nextFrom >= 1 && nextTo >= nextFrom && nextTo <= total && nextTo - nextFrom <= 40)) return null;
  return { from: nextFrom, to: nextTo };
}

/**
 * @returns {Promise<null | {chapters:any[], warnings:string[], toc:object, confidence:number}>}
 */
export async function parsePrintedToc({ ctx, book, pages, dir, from, to, force = false }) {
  const range = normalizeRange(pages, from, to);
  if (!range) return null;
  const tocFile = path.join(dir, 'toc.json');
  const cacheKey = sha256([book.sha256 || '', range.from, range.to, TOC_PROMPT_VERSION].join('|'));

  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(tocFile, 'utf8'));
  } catch {
    cached = null;
  }
  if (!force && cached && cached.cacheKey === cacheKey && cached.status !== 'failed' && Array.isArray(cached.entries)) {
    const replay = replayToc(pages, cached);
    if (replay && replay.chapters) {
      const hitRate = verifyChapters(pages, replay.chapters);
      const toc = Object.assign({}, cached, {
        entries: replay.calibrated.entries,
        offset: replay.calibrated.offset,
        offsetShare: replay.calibrated.offsetShare,
        hitRate,
      });
      writeJson(tocFile, toc);
      return {
        chapters: replay.chapters,
        warnings: hitRate < 0.8 ? ['目录缓存校验命中率 ' + Math.round(hitRate * 100) + '%，请抽查章节。'] : [],
        toc,
        confidence: hitRate >= 0.8 ? 0.95 : 0.65,
      };
    }
  }

  const prompt = loadPrompt();
  if (!prompt) return null;
  if (!ctx) {
    return {
      chapters: null,
      warnings: ['没有可用的模型，无法读取印刷目录；已回退自动分章。'],
      toc: { status: 'failed', range, error: 'no-model' },
      confidence: 0,
    };
  }
  const built = buildTocMessages({ promptFile: prompt, book, pages, from: range.from, to: range.to });
  let entries = null;
  let lastError = '';
  let budget = TOC_MAX_TOKENS;
  let usedModel = '';
  for (let attempt = 0; attempt < 2 && !entries; attempt += 1) {
    const user =
      attempt === 0
        ? built.user
        : built.user + '\n\n【上一次的输出不合格】' + lastError + '\n这次不要分析目录、不要解释，直接输出 JSON 对象。';
    let reply;
    try {
      reply = await callModel(ctx, built.system, user, budget);
      usedModel = reply.model;
    } catch (err) {
      return {
        chapters: null,
        warnings: ['目录模型调用失败：' + String((err && err.message) || err) + '，已回退自动分章。'],
        toc: { status: 'failed', range, error: String((err && err.message) || err) },
        confidence: 0,
      };
    }
    try {
      if (!reply.text.trim()) throw new Error(describeEmptyReply(reply));
      const parsed = parseTocReply(reply.text);
      const errors = validateEntries(parsed);
      if (errors.length) {
        lastError = errors.join('；');
        if (reply.stopReason === 'max-tokens') budget = Math.max(budget, TOC_RETRY_MAX_TOKENS);
        continue;
      }
      entries = parsed;
    } catch (err) {
      lastError = String((err && err.message) || err);
      if (reply.stopReason === 'max-tokens') budget = Math.max(budget, TOC_RETRY_MAX_TOKENS);
    }
  }

  if (!entries) {
    return {
      chapters: null,
      warnings: ['印刷目录没读出来：' + (lastError || '模型没给出可用条目') + '，已回退自动分章。'],
      toc: { status: 'failed', range, error: lastError || 'empty' },
      confidence: 0,
    };
  }

  const calibrated = calibrate(pages, entries, range);
  const chapters = chaptersFromToc(pages, calibrated);
  if (calibrated.status === 'failed' || !chapters || chapters.length < 2) {
    return {
      chapters: null,
      warnings: ['目录页码与 PDF 页对不上，已回退自动分章。'],
      toc: { status: 'failed', range, entries: calibrated.entries, offset: calibrated.offset },
      confidence: 0,
    };
  }

  const hitRate = verifyChapters(pages, chapters);
  const status = calibrated.status === 'verified' && hitRate >= 0.8 ? 'verified' : 'unverified';
  const toc = {
    status,
    range,
    cacheKey,
    promptVersion: TOC_PROMPT_VERSION,
    model: usedModel,
    offset: calibrated.offset,
    offsetShare: calibrated.offsetShare,
    hitRate,
    entries: calibrated.entries,
    at: new Date().toISOString(),
  };
  writeJson(tocFile, toc);
  return {
    chapters,
    warnings: [
      ...(built.truncated ? ['目录文本过长，已截断到 ' + built.chars + ' 字。'] : []),
      ...(status !== 'verified' ? ['目录校准未完全通过（命中率 ' + Math.round(hitRate * 100) + '%），请抽查章节。'] : []),
    ],
    toc,
    confidence: status === 'verified' ? 0.95 : 0.65,
  };
}
