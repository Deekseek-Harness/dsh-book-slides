/**
 * FR-27 AI 用量与费用统计（2.1）：账本、价格表与采集。
 *
 * 三条硬边界（SRS FR-27 / D83）：
 *   1. 只统计本插件发起的调用；DSH 会话用量不算；
 *   2. 本地调用全局不计（billing=local 不写账本，UI 只显示「未计入」）；
 *   3. 账本是作业的旁路：写盘失败只提示 E_USAGE_IO，绝不回滚或阻断作业。
 *
 * 采集走 AsyncLocalStorage：作业入口 runUsageJob(spec, fn) 建立上下文，
 * 各调用点只负责 recordLlm / recordTtsPage / recordImageCall，不需要逐层传参。
 * 第一次真正计费调用才落盘（lazy），全程缓存命中的作业不会留下空记录。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

import { ROOT, readJson, writeJson } from './root.js';
import { recordError } from './errors.js';

export const USAGE_DIR = path.join(ROOT, 'usage');
export const JOBS_DIR = path.join(USAGE_DIR, 'jobs');
export const PRICES_FILE = path.join(USAGE_DIR, 'prices.json');
export const CONFIG_FILE = path.join(USAGE_DIR, 'config.json');

export const USAGE_SCHEMA = 1;
export const KINDS = ['lecture', 'tts', 'image', 'other'];
export const PHASES = ['plan', 'generate', 'revoice', 'regen', 'toc', 'practice', 'probe'];
export const STATUSES = ['running', 'done', 'failed', 'cancelled', 'interrupted'];

/** 字符 → token 的默认估算系数（SRS FR-27.2 / 附录 A）。 */
export const DEFAULT_TOKEN_PER_CHAR = 0.6;

export class UsageError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'UsageError';
    this.code = code;
    this.hint = hint || '';
  }
}

/* ------------------------------ 价格表 ------------------------------ */

/**
 * 随包参考价：只用于估算，不承诺与供应商账单一致。
 * 用户可在设置页改；改价只影响之后的作业（记录保存 priceVersion 快照）。
 *
 * DeepSeek 分时价：`input/output/cacheRead/cacheWrite` 是**空闲时段**价，
 * `peak` 是高峰时段覆盖值（北京时间周一至周五 9–12、14–18；法定节假日未处理）。
 */
const BUILTIN_PRICE_VERSION = '2026-11-10';
const REFERENCE_PRICES = [
  {
    kind: 'llm',
    provider: 'deepseek',
    model: 'deepseek-flash',
    unit: 'perMillionTokens',
    input: 1,
    output: 4,
    cacheRead: 0.02,
    cacheWrite: 1,
    peak: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 2 },
  },
  {
    kind: 'llm',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    unit: 'perMillionTokens',
    input: 4.5,
    output: 13.5,
    cacheRead: 0.15,
    cacheWrite: 4.5,
    peak: { input: 9, output: 27, cacheRead: 0.3, cacheWrite: 9 },
  },
  {
    kind: 'llm',
    provider: 'deepseek',
    model: '*',
    unit: 'perMillionTokens',
    input: 1,
    output: 4,
    cacheRead: 0.02,
    cacheWrite: 1,
    peak: { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 2 },
  },
  { kind: 'tts', provider: 'qwen3-tts', model: 'qwen3-tts-flash', unit: 'perKChars', price: 0.08 },
  { kind: 'tts', provider: 'qwen3-tts', model: '*', unit: 'perKChars', price: 0.1 },
];

function builtinPrices() {
  return {
    currency: 'CNY',
    priceVersion: BUILTIN_PRICE_VERSION,
    source: 'builtin',
    note: '参考价，可能过期；以供应商账单为准。DeepSeek 为空闲价，peak 为高峰价。设置页可改。',
    prices: REFERENCE_PRICES.map((item) => Object.assign({}, item, item.peak ? { peak: Object.assign({}, item.peak) } : {})),
  };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function validatePrices(body) {
  const source = body && typeof body === 'object' ? body : {};
  const list = Array.isArray(source.prices) ? source.prices : null;
  if (!list) throw new UsageError('E_USAGE_PRICE', '价格表缺少 prices 数组', '用「恢复参考价」或按 JSON 格式提交。');
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') throw new UsageError('E_USAGE_PRICE', '价格项必须是对象', '');
    const kind = String(raw.kind || '');
    if (!['llm', 'tts', 'image'].includes(kind)) {
      throw new UsageError('E_USAGE_PRICE', '价格项 kind 只能是 llm/tts/image', String(kind));
    }
    const provider = String(raw.provider || '').trim();
    const model = String(raw.model || '*').trim() || '*';
    if (!provider) throw new UsageError('E_USAGE_PRICE', '价格项缺少 provider', '');
    if (kind === 'llm') {
      const item = {
        kind,
        provider,
        model,
        unit: 'perMillionTokens',
        input: numberOrNull(raw.input),
        output: numberOrNull(raw.output),
        cacheRead: numberOrNull(raw.cacheRead),
        cacheWrite: numberOrNull(raw.cacheWrite),
      };
      if (item.input == null || item.output == null) {
        throw new UsageError('E_USAGE_PRICE', 'LLM 价格必须给 input / output（元/百万 tokens）', provider + '/' + model);
      }
      if (raw.peak && typeof raw.peak === 'object') {
        const peak = {};
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
          const value = numberOrNull(raw.peak[key]);
          if (value != null) peak[key] = value;
        }
        if (Object.keys(peak).length) item.peak = peak;
      }
      out.push(item);
      continue;
    }
    const price = numberOrNull(raw.price);
    if (price == null) throw new UsageError('E_USAGE_PRICE', kind + ' 价格必须给 price', provider + '/' + model);
    out.push({ kind, provider, model, unit: kind === 'tts' ? 'perKChars' : 'perImage', price });
  }
  return out;
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(source.localProviders) ? source.localProviders : [];
  return { localProviders: Array.from(new Set(list.map((item) => String(item || '').trim()).filter(Boolean))) };
}

export function readUsageConfig() {
  return normalizeConfig(readJson(CONFIG_FILE, null));
}

export function writeUsageConfig(patch) {
  const next = normalizeConfig(Object.assign({}, readUsageConfig(), patch && typeof patch === 'object' ? patch : {}));
  writeJson(CONFIG_FILE, next);
  return next;
}

export function readPrices() {
  const raw = readJson(PRICES_FILE, null);
  if (!raw || !Array.isArray(raw.prices) || (raw.source === 'builtin' && raw.priceVersion !== BUILTIN_PRICE_VERSION)) {
    const fresh = builtinPrices();
    try {
      writeJson(PRICES_FILE, fresh);
    } catch {
      /* 只读数据根：用内存默认值，别让读价格失败 */
    }
    return Object.assign({}, fresh, readUsageConfig());
  }
  return Object.assign(
    {
      currency: String(raw.currency || 'CNY'),
      priceVersion: String(raw.priceVersion || ''),
      source: String(raw.source || 'custom'),
      note: String(raw.note || ''),
      prices: raw.prices.filter((item) => item && typeof item === 'object').map((item) => Object.assign({}, item)),
    },
    readUsageConfig(),
  );
}

/** 改价 / 恢复参考价；同时可改 localProviders（本地/不计费的 LLM provider）。 */
export function writePrices(body) {
  const source = body && typeof body === 'object' ? body : {};
  if (source.reset === true) {
    if (source.localProviders !== undefined) writeUsageConfig({ localProviders: source.localProviders });
    const fresh = builtinPrices();
    writeJson(PRICES_FILE, fresh);
    return Object.assign({}, fresh, readUsageConfig());
  }
  const prices = validatePrices(source);
  if (source.localProviders !== undefined) writeUsageConfig({ localProviders: source.localProviders });
  const current = readPrices();
  const next = {
    currency: String(source.currency || current.currency || 'CNY'),
    priceVersion: String(source.priceVersion || new Date().toISOString().slice(0, 10)),
    source: 'custom',
    note: String(source.note || ''),
    prices,
  };
  writeJson(PRICES_FILE, next);
  return Object.assign({}, next, readUsageConfig());
}

function priceOf(table, kind, provider, model) {
  const list = (table && table.prices) || [];
  const exact = list.find((item) => item.kind === kind && item.provider === provider && item.model === model);
  if (exact) return exact;
  const wildcard =
    list.find((item) => item.kind === kind && item.provider === provider && (item.model === '*' || !item.model)) || null;
  if (wildcard) return wildcard;
  // 供应商别名：deepseek-official / deepseek 视为同一家族；只在没有精确价时回落
  const family = String(provider || '').split('-')[0];
  if (family && family !== provider) {
    return (
      list.find((item) => item.kind === kind && item.provider === family && (item.model === '*' || !item.model)) || null
    );
  }
  return null;
}

/** 供估算模块查价；找不到返回 null（金额显示「—」）。 */
export function lookupPrice(kind, provider, model) {
  return priceOf(readPrices(), kind, provider, model);
}

/**
 * DeepSeek 高峰时段：北京时间（Asia/Shanghai）周一至周五 9:00–12:00、14:00–18:00。
 * 法定节假日无法离线判断，按工作日处理；空闲时段价 = 价格表基础值。
 */
export function isPeakHour(at = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hourCycle: 'h23',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(at);
  } catch {
    return false;
  }
  const value = (type) => {
    const hit = parts.find((part) => part.type === type);
    return hit ? hit.value : '';
  };
  const weekday = value('weekday');
  if (!['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(weekday)) return false;
  const minutes = (Number(value('hour')) || 0) * 60 + (Number(value('minute')) || 0);
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}

/** 有 peak 覆盖时按当前时段取价；没有 peak 的价格原样返回。 */
export function effectivePrice(price, at = new Date()) {
  if (!price || !price.peak) return price;
  return isPeakHour(at) ? Object.assign({}, price, price.peak) : price;
}

/* ------------------------------ 计费范围 ------------------------------ */

/** 本地/内网自建：全局不计（D83）。 */
export function billingForLlm(provider) {
  const id = String(provider || '').trim();
  if (!id) return 'cloud';
  return readUsageConfig().localProviders.includes(id) ? 'local' : 'cloud';
}

export function billingForTts(provider) {
  const id = String(provider || '').trim();
  if (id === 'qwen3-tts') return 'cloud';
  if (id === 'off' || id === '') return 'none';
  return 'local';
}

export function billingForImage(provider) {
  const id = String(provider || '').trim();
  if (id === 'prompt' || id === '') return 'none';
  if (id === 'comfyui') return 'local';
  return 'cloud';
}

/* ------------------------------ 账本运行时 ------------------------------ */

const STORE = new AsyncLocalStorage();

export function currentUsageJob() {
  return STORE.getStore() || null;
}

function nowIso() {
  return new Date().toISOString();
}

export function usageJobId(prefix = 'u') {
  return prefix + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

export function codepoints(text) {
  return Array.from(String(text || '')).length;
}

function round6(n) {
  return Math.round((Number(n) || 0) * 1e6) / 1e6;
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function jobFile(id) {
  return path.join(JOBS_DIR, id + '.json');
}

function createRuntime(spec) {
  return {
    id: String(spec.jobId || usageJobId('u')),
    spec: spec || {},
    startedAt: nowIso(),
    status: 'running',
    materialized: false,
    price: readPrices(),
    state: {
      calls: 0,
      failedCalls: 0,
      cachedPages: 0,
      tokens: emptyTokens(),
      chars: 0,
      charsFromProvider: 0,
      charsFromText: 0,
      priceTiers: { peak: 0, offPeak: 0 },
      images: 0,
      cost: 0,
      unknownPrice: false,
      unknownUsage: false,
      byStage: {},
      byModel: {},
      notes: [],
    },
  };
}

function billingOf(runtime) {
  return String((runtime.spec && runtime.spec.billing) || 'cloud');
}

function isLocal(runtime) {
  return billingOf(runtime) === 'local' || billingOf(runtime) === 'none';
}

function stageBucket(runtime, stage) {
  const key = String(stage || (runtime.spec && runtime.spec.phase) || 'other');
  if (!runtime.state.byStage[key]) runtime.state.byStage[key] = Object.assign({ calls: 0, tokens: emptyTokens(), chars: 0, images: 0, cost: 0 }, { failed: 0 });
  return runtime.state.byStage[key];
}

function modelBucket(runtime, provider, model) {
  const key = String(provider || '') + '/' + String(model || '');
  if (!runtime.state.byModel[key]) {
    runtime.state.byModel[key] = { provider: String(provider || ''), model: String(model || ''), calls: 0, tokens: emptyTokens(), chars: 0, images: 0, cost: 0 };
  }
  return runtime.state.byModel[key];
}

function addTokens(target, source) {
  target.input += Number(source.input) || 0;
  target.output += Number(source.output) || 0;
  target.cacheRead += Number(source.cacheRead) || 0;
  target.cacheWrite += Number(source.cacheWrite) || 0;
  target.reasoning += Number(source.reasoning) || 0;
}

function llmCost(price, tokens) {
  if (!price) return null;
  const inputPrice = Number(price.input) || 0;
  const outputPrice = Number(price.output) || 0;
  const cacheReadPrice = price.cacheRead == null ? inputPrice : Number(price.cacheRead) || 0;
  const cacheWritePrice = price.cacheWrite == null ? inputPrice : Number(price.cacheWrite) || 0;
  // OpenAI / DeepSeek 的 completion_tokens 已包含 reasoning_tokens（pi-ai 明确如此）；
  // reasoning 只做展示，不能再加一次输出价。
  const million =
    (Number(tokens.input) || 0) * inputPrice +
    (Number(tokens.cacheRead) || 0) * cacheReadPrice +
    (Number(tokens.cacheWrite) || 0) * cacheWritePrice +
    (Number(tokens.output) || 0) * outputPrice;
  return million / 1e6;
}

function applyCost(runtime, bucket, modelBucketRef, cost) {
  if (cost == null) {
    runtime.state.unknownPrice = true;
    return;
  }
  runtime.state.cost += cost;
  if (bucket) bucket.cost = round6(bucket.cost + cost);
  if (modelBucketRef) modelBucketRef.cost = round6(modelBucketRef.cost + cost);
}

function materialize(runtime) {
  if (runtime.materialized) return;
  if (isLocal(runtime)) return;
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  runtime.materialized = true;
}

function snapshot(runtime) {
  const spec = runtime.spec || {};
  const state = runtime.state;
  const actual = {
    calls: state.calls,
    failedCalls: state.failedCalls,
    tokens: state.tokens,
    chars: state.chars,
    charsSource:
      state.charsFromProvider && state.charsFromText
        ? 'mixed'
        : state.charsFromProvider
          ? 'provider'
          : state.charsFromText
            ? 'text'
            : null,
    images: state.images,
    cost: state.unknownPrice ? null : round6(state.cost),
    currency: runtime.price.currency || 'CNY',
    priceTiers: state.priceTiers,
    unknownPrice: state.unknownPrice,
    unknownUsage: state.unknownUsage,
    cachedPages: state.cachedPages,
  };
  const estimate = spec.estimate;
  if (estimate && actual.cost != null && estimate.cost != null) {
    actual.deviation = {
      cost: round6(actual.cost - Number(estimate.cost)),
      costRatio: Number(estimate.cost) > 0 ? round6((actual.cost - Number(estimate.cost)) / Number(estimate.cost)) : null,
      inputRatio:
        estimate.tokens && Number(estimate.tokens.input) > 0
          ? round6((actual.tokens.input - Number(estimate.tokens.input)) / Number(estimate.tokens.input))
          : null,
      outputRatio:
        estimate.tokens && Number(estimate.tokens.output) > 0
          ? round6((actual.tokens.output - Number(estimate.tokens.output)) / Number(estimate.tokens.output))
          : null,
    };
  }
  return {
    usageSchema: USAGE_SCHEMA,
    jobId: runtime.id,
    kind: String(spec.kind || 'other'),
    phase: String(spec.phase || (spec.kind === 'lecture' ? 'generate' : spec.kind) || 'other'),
    status: runtime.status,
    billing: billingOf(runtime),
    startedAt: runtime.startedAt,
    finishedAt: runtime.finishedAt || null,
    book: spec.book || null,
    series: spec.series || null,
    scope: spec.scope || {},
    priceVersion: runtime.price.priceVersion,
    estimate: spec.estimate || null,
    billingModel: Object.values(state.byModel),
    actual,
    byStage: state.byStage,
    notes: state.notes,
  };
}

function writeSnapshot(runtime) {
  if (!runtime.materialized) return;
  try {
    writeJson(jobFile(runtime.id), snapshot(runtime));
  } catch (err) {
    const message = String((err && err.message) || err).slice(0, 160);
    runtime.notes.push('E_USAGE_IO: ' + message);
    try {
      recordError('E_USAGE_IO', message);
    } catch {
      /* 诊断失败也不能挡作业 */
    }
    runtime.materialized = false;
  }
}

/** 在账本上下文里执行一个作业；返回值带 usageJobId 方便同步接口回传。 */
export async function runUsageJob(spec, fn, statusFn) {
  const runtime = createRuntime(spec);
  let result;
  try {
    result = await STORE.run(runtime, fn);
  } catch (err) {
    finishRuntime(runtime, err && (err.code === 'E_CANCELLED' || err.name === 'AbortError') ? 'cancelled' : 'failed');
    throw err;
  }
  finishRuntime(runtime, typeof statusFn === 'function' ? statusFn() : 'done');
  return { result, usageJobId: runtime.id, recorded: runtime.materialized };
}

function finishRuntime(runtime, status) {
  runtime.status = STATUSES.includes(String(status)) ? String(status) : 'done';
  runtime.finishedAt = nowIso();
  if (runtime.materialized) writeSnapshot(runtime);
}

/** 一次 LLM 调用结束（成功带 usage；失败 ok=false、usage 为空）。 */
export function recordLlmCall(input) {
  const runtime = currentUsageJob();
  if (!runtime || isLocal(runtime)) return;
  const opts = input && typeof input === 'object' ? input : {};
  const stage = String(opts.stage || 'other');
  const provider = String(opts.provider || '');
  const model = String(opts.model || '');
  const usage = opts.usage && typeof opts.usage === 'object' ? opts.usage : null;
  const tokens = emptyTokens();
  if (usage) {
    tokens.input = Number(usage.inputTokens) || 0;
    tokens.output = Number(usage.outputTokens) || 0;
    tokens.cacheRead = Number(usage.cacheReadTokens) || 0;
    tokens.cacheWrite = Number(usage.cacheWriteTokens) || 0;
    tokens.reasoning = Number(usage.reasoningTokens) || 0;
  }

  const bucket = stageBucket(runtime, stage);
  const modelRef = modelBucket(runtime, provider, model);
  runtime.state.calls += 1;
  bucket.calls += 1;
  modelRef.calls += 1;

  if (opts.ok === false) {
    runtime.state.failedCalls += 1;
    bucket.failed = (bucket.failed || 0) + 1;
    materialize(runtime);
    writeSnapshot(runtime);
    return;
  }
  if (!usage) {
    runtime.state.unknownUsage = true;
    materialize(runtime);
    writeSnapshot(runtime);
    return;
  }

  addTokens(runtime.state.tokens, tokens);
  addTokens(bucket.tokens, tokens);
  addTokens(modelRef.tokens, tokens);
  const price = priceOf(runtime.price, 'llm', provider, model);
  const at = new Date();
  const rate = effectivePrice(price, at);
  if (price && price.peak) {
    runtime.state.priceTiers[isPeakHour(at) ? 'peak' : 'offPeak'] += 1;
  }
  const cost = llmCost(rate, tokens);
  applyCost(runtime, bucket, modelRef, cost);
  materialize(runtime);
  writeSnapshot(runtime);
}

/** 一次云 TTS 页处理：缓存命中不记调用；失败只记次数。 */
export function recordTtsPage(input) {
  const runtime = currentUsageJob();
  if (!runtime || isLocal(runtime)) return;
  const opts = input && typeof input === 'object' ? input : {};
  if (opts.cached === true) {
    runtime.state.cachedPages += 1;
    materialize(runtime);
    writeSnapshot(runtime);
    return;
  }
  const chars = Math.max(0, Number(opts.chars) || 0);
  const failedAttempts = Math.max(0, Number(opts.failedAttempts) || 0);
  const bucket = stageBucket(runtime, 'tts');
  const modelRef = modelBucket(runtime, 'qwen3-tts', opts.model || '');
  if (opts.ok === false) {
    const attempts = Math.max(1, failedAttempts);
    runtime.state.calls += attempts;
    bucket.calls += attempts;
    modelRef.calls += attempts;
    runtime.state.failedCalls += attempts;
    bucket.failed = (bucket.failed || 0) + attempts;
    materialize(runtime);
    writeSnapshot(runtime);
    return;
  }
  runtime.state.calls += 1;
  bucket.calls += 1;
  modelRef.calls += 1;
  if (failedAttempts) {
    runtime.state.failedCalls += failedAttempts;
    bucket.failed = (bucket.failed || 0) + failedAttempts;
  }
  runtime.state.chars += chars;
  if (opts.charsSource === 'text') runtime.state.charsFromText += chars;
  else runtime.state.charsFromProvider += chars;
  bucket.chars += chars;
  modelRef.chars += chars;
  const price = priceOf(runtime.price, 'tts', 'qwen3-tts', opts.model || '');
  const cost = price ? (chars / 1000) * (Number(price.price) || 0) : null;
  applyCost(runtime, bucket, modelRef, cost);
  materialize(runtime);
  writeSnapshot(runtime);
}

/** 一次云生图请求（本地 provider 已在 billing 层排除）。 */
export function recordImageCall(input) {
  const runtime = currentUsageJob();
  if (!runtime || isLocal(runtime)) return;
  const opts = input && typeof input === 'object' ? input : {};
  const count = Math.max(0, Number(opts.count) || 1);
  const bucket = stageBucket(runtime, 'image');
  const modelRef = modelBucket(runtime, opts.provider || 'image', opts.model || '');
  runtime.state.calls += 1;
  bucket.calls += 1;
  modelRef.calls += 1;
  if (opts.ok === false) {
    runtime.state.failedCalls += 1;
    bucket.failed = (bucket.failed || 0) + 1;
    materialize(runtime);
    writeSnapshot(runtime);
    return;
  }
  runtime.state.images += count;
  bucket.images += count;
  modelRef.images += count;
  const price = priceOf(runtime.price, 'image', opts.provider || '', opts.model || '');
  const cost = price ? count * (Number(price.price) || 0) : null;
  applyCost(runtime, bucket, modelRef, cost);
  materialize(runtime);
  writeSnapshot(runtime);
}

/* ------------------------------ 读取与汇总 ------------------------------ */

function safeJobId(id) {
  const value = String(id || '');
  return /^[a-z0-9_-]{4,48}$/i.test(value) ? value : '';
}

function listFiles() {
  let names = [];
  try {
    names = fs.readdirSync(JOBS_DIR);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
}

export function readJob(id) {
  const jobId = safeJobId(id);
  if (!jobId) return null;
  const data = readJson(jobFile(jobId), null);
  return data && data.jobId ? data : null;
}

function dayOf(iso) {
  return String(iso || '').slice(0, 10);
}

function matchesRange(job, from, to) {
  const day = dayOf(job.startedAt);
  if (from && day < String(from)) return false;
  if (to && day > String(to)) return false;
  return true;
}

function matchesOwner(job, bookId, seriesId) {
  if (bookId && String((job.book && job.book.id) || '') !== String(bookId)) return false;
  if (seriesId && String((job.series && job.series.id) || '') !== String(seriesId)) return false;
  return true;
}

function addTotals(target, job) {
  const actual = (job && job.actual) || {};
  target.jobs += 1;
  target.cost += Number(actual.cost) || 0;
  if (actual.cost == null) target.unknownCost += 1;
  const tokens = actual.tokens || {};
  target.tokens.input += Number(tokens.input) || 0;
  target.tokens.output += Number(tokens.output) || 0;
  target.tokens.cacheRead += Number(tokens.cacheRead) || 0;
  target.tokens.cacheWrite += Number(tokens.cacheWrite) || 0;
  target.chars += Number(actual.chars) || 0;
  target.images += Number(actual.images) || 0;
}

function emptyTotals() {
  return {
    jobs: 0,
    cost: 0,
    unknownCost: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    chars: 0,
    images: 0,
  };
}

export function listUsageJobs(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const kind = String(opts.kind || '');
  const from = String(opts.from || '');
  const to = String(opts.to || '');
  const bookId = String(opts.bookId || '');
  const seriesId = String(opts.seriesId || '');
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 50));
  const offset = Math.max(0, Number(opts.offset) || 0);
  const jobs = [];
  for (const id of listFiles()) {
    const job = readJob(id);
    if (!job) continue;
    if (kind && String(job.kind) !== kind) continue;
    if (!matchesRange(job, from, to)) continue;
    if (!matchesOwner(job, bookId, seriesId)) continue;
    jobs.push(job);
  }
  jobs.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  return { total: jobs.length, limit, offset, jobs: jobs.slice(offset, offset + limit) };
}

export function usageSummary(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const from = String(opts.from || '');
  const to = String(opts.to || '');
  const bookId = String(opts.bookId || '');
  const seriesId = String(opts.seriesId || '');
  const totals = emptyTotals();
  const byKind = new Map();
  for (const id of listFiles()) {
    const job = readJob(id);
    if (!job) continue;
    if (!matchesRange(job, from, to)) continue;
    if (!matchesOwner(job, bookId, seriesId)) continue;
    addTotals(totals, job);
    const key = String(job.kind || 'other') + ':' + String(job.phase || '');
    if (!byKind.has(key)) {
      byKind.set(key, Object.assign({ kind: String(job.kind || 'other'), phase: String(job.phase || '') }, emptyTotals()));
    }
    addTotals(byKind.get(key), job);
  }
  totals.cost = round6(totals.cost);
  for (const item of byKind.values()) item.cost = round6(item.cost);
  return {
    range: { from: from || null, to: to || null },
    totals,
    byKind: Array.from(byKind.values()).sort((a, b) => b.jobs - a.jobs),
  };
}

export function clearUsageJobs() {
  let removed = 0;
  for (const id of listFiles()) {
    try {
      fs.rmSync(jobFile(id), { force: true });
      removed += 1;
    } catch {
      /* 单个删不掉不影响其它 */
    }
  }
  return removed;
}

/** 启动归一（AC-165）：上次进程留下的 running 一律 interrupted，不丢已发生的用量。 */
export function reconcileUsageJobs() {
  let changed = 0;
  for (const id of listFiles()) {
    const job = readJob(id);
    if (!job || job.status !== 'running') continue;
    job.status = 'interrupted';
    job.finishedAt = job.finishedAt || nowIso();
    job.notes = Array.isArray(job.notes) ? job.notes : [];
    job.notes.push('进程退出时作业未收口，已归一为 interrupted');
    try {
      writeJson(jobFile(id), job);
      changed += 1;
    } catch {
      /* 写不动就跳过 */
    }
  }
  return changed;
}
