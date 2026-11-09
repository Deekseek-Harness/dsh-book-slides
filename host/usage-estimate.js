/**
 * FR-27.2 开始前预估：只读，不调模型、不写账本。
 *
 * 讲义按讲纲的讲数/页数/字数与批数估算；配音按待配页的朗读稿码点数估算
 * （扣除 audio-cache 命中页）；生图在本地 provider 下只返回「不产生云端费用」。
 * 估算系数 k 见 usage.js（0.6 tokens/字），金额按当前价格表的快照值计算。
 */
import { findSeries } from './series.js';
import { loadLecture } from './lectures.js';
import { readVoiceConfig, audioCacheHit, QWEN_MODEL } from '../lib/tts.js';
import { readImageConfig } from '../lib/comfy.js';
import { resolveModel } from './llm.js';
import {
  DEFAULT_TOKEN_PER_CHAR,
  UsageError,
  billingForLlm,
  effectivePrice,
  lookupPrice,
  readPrices,
} from './usage.js';

const BATCH_CHARS = 12000;
const CHARS_PER_SLIDE = 2000;
const OUTPUT_CHARS_PER_SLIDE = 600;
const PROMPT_CHARS_PER_BATCH = 4000;
const READY = ['ready', 'ready_degraded'];

function round(n) {
  return Math.round(Number(n) || 0);
}

function normalizeScope(found, scope) {
  const all = found.series.lectures || [];
  const wanted =
    scope && Array.isArray(scope.lectures) && scope.lectures.length
      ? scope.lectures.map(Number)
      : all.filter((item) => !READY.includes(String(item.status))).map((item) => Number(item.n));
  const picked = all.filter((item) => wanted.includes(Number(item.n)));
  return picked.length ? picked : all.filter((item) => !READY.includes(String(item.status)));
}

function pagesOf(lecture) {
  const pages = Number(lecture.pages);
  if (Number.isFinite(pages) && pages > 0) return pages;
  const chars = Number(lecture.chars) || 0;
  return Math.max(6, Math.min(30, Math.round(chars / CHARS_PER_SLIDE)));
}

function modelOf(ctx) {
  try {
    return resolveModel(ctx);
  } catch {
    return null;
  }
}

function currencyNote() {
  return readPrices().currency || 'CNY';
}

export function estimateLecture({ ctx = null, seriesId = '', scope = null } = {}) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new UsageError('E_NOT_FOUND', '找不到这个系列', '刷新列表后再试。');
  const lectures = normalizeScope(found, scope);
  if (!lectures.length) throw new UsageError('E_SERIES_EMPTY', '没有要估算的讲', '全部讲已就绪，无需重跑。');

  const chars = lectures.reduce((sum, item) => sum + (Number(item.chars) || 0), 0);
  const pages = lectures.reduce((sum, item) => sum + pagesOf(item), 0);
  const batches = lectures.reduce((sum, item) => sum + Math.max(1, Math.ceil((Number(item.chars) || 0) / BATCH_CHARS)), 0);
  const inputChars = chars + batches * PROMPT_CHARS_PER_BATCH;
  const outputChars = pages * OUTPUT_CHARS_PER_SLIDE;
  const tokens = {
    input: round(inputChars * DEFAULT_TOKEN_PER_CHAR),
    output: round(outputChars * DEFAULT_TOKEN_PER_CHAR),
  };

  const model = modelOf(ctx);
  const local = model ? billingForLlm(model.provider) === 'local' : false;
  const base = model && !local ? lookupPrice('llm', model.provider, model.model) : null;
  const price = base ? effectivePrice(base, new Date()) : null;
  let cost = null;
  if (local) cost = 0;
  else if (price) {
    cost = (tokens.input * (Number(price.input) || 0) + tokens.output * (Number(price.output) || 0)) / 1e6;
  }
  return {
    level: 'planned',
    kind: 'lecture',
    tokens,
    chars: 0,
    images: 0,
    cost,
    local,
    currency: currencyNote(),
    scope: { lectures: lectures.map((item) => Number(item.n)), pages, chars },
    model: model ? { provider: model.provider, model: model.model } : null,
    note: local
      ? '当前 LLM provider 标记为「本地/不计费」，不产生云端费用（用量仍按估算显示，不入账本）。'
      : (price ? '' : '当前模型未配置价格，金额显示「—」；') +
        (base && base.peak ? '按当前时段（高峰/空闲）价估算；' : '') +
        '估算 ±30%，按讲纲字数/页数推导；不含此前已发生的讲纲预览费用。',
  };
}

/**
 * Qwen3-TTS 的计费字符口径（实测）：汉字/数字按 2，ASCII/标点按 1；
 * 数字还可能被读成中文数字而膨胀（如 1234 → 一千二百三十四），所以只是近似。
 */
export function providerCharCount(text) {
  let total = 0;
  for (const ch of String(text || '')) {
    if (/[\u3400-\u9fff]/.test(ch)) total += 2;
    else if (/[0-9]/.test(ch)) total += 2;
    else total += 1;
  }
  return total;
}

export function estimateTts({ seriesId = '', lecture = null, missingOnly = false, force = false } = {}) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new UsageError('E_NOT_FOUND', '找不到这个系列', '刷新列表后再试。');
  const config = readVoiceConfig();
  if (String(config.provider || '') !== 'qwen3-tts') {
    return {
      level: 'planned',
      kind: 'tts',
      tokens: { input: 0, output: 0 },
      chars: 0,
      images: 0,
      cost: 0,
      currency: currencyNote(),
      local: true,
      scope: { lectures: [], pages: 0 },
      note: '本地/浏览器配音不产生云端费用，未计入用量与费用。',
    };
  }
  const wanted =
    lecture == null
      ? (found.series.lectures || []).filter((item) => READY.includes(String(item.status))).map((item) => Number(item.n))
      : [Number(lecture)];
  let chars = 0;
  let pages = 0;
  let cachedPages = 0;
  for (const n of wanted) {
    const doc = loadLecture(found.dir, n);
    if (!doc || !doc.slidesDoc || !Array.isArray(doc.slidesDoc.slides)) continue;
    for (const slide of doc.slidesDoc.slides) {
      const text = String(slide.audio_script || '').trim();
      if (!text) continue;
      if (missingOnly && slide.audio_file && slide.audio_provider && slide.audio_provider !== 'none') continue;
      if (!force && audioCacheHit(config, text)) {
        cachedPages += 1;
        continue;
      }
      chars += providerCharCount(text);
      pages += 1;
    }
  }
  const price = lookupPrice('tts', 'qwen3-tts', config.model || QWEN_MODEL);
  const cost = price ? (chars / 1000) * (Number(price.price) || 0) : null;
  return {
    level: 'planned',
    kind: 'tts',
    tokens: { input: 0, output: 0 },
    chars,
    images: 0,
    cost,
    currency: currencyNote(),
    scope: { lectures: wanted, pages, cachedPages },
    model: { provider: 'qwen3-tts', model: config.model || QWEN_MODEL },
    note:
      (price ? '' : '当前 TTS 模型未配置价格，金额显示「—」；') +
      (cachedPages ? '已扣除 ' + cachedPages + ' 页缓存命中；' : '') +
      '按云端计费字符口径估算（汉字/数字约 2、ASCII/标点约 1），数字读法可能使实际略高。',
  };
}

export function estimateImage({ seriesId = '', lecture = null, slide = null, force = false } = {}) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new UsageError('E_NOT_FOUND', '找不到这个系列', '刷新列表后再试。');
  const config = readImageConfig();
  const provider = String(config.provider || '');
  if (provider === 'prompt' || provider === '') {
    return {
      level: 'planned',
      kind: 'image',
      tokens: { input: 0, output: 0 },
      chars: 0,
      images: 0,
      cost: 0,
      currency: currencyNote(),
      local: true,
      scope: { lectures: [], pages: 0 },
      note: '当前是提示词占位，不调用任何绘图服务。',
    };
  }
  if (provider === 'comfyui') {
    let pages = 0;
    const wanted =
      lecture == null ? (found.series.lectures || []).map((item) => Number(item.n)) : [Number(lecture)];
    for (const n of wanted) {
      const doc = loadLecture(found.dir, n);
      if (!doc || !doc.slidesDoc || !Array.isArray(doc.slidesDoc.slides)) continue;
      for (const item of doc.slidesDoc.slides) {
        if (String(item.layout || '') !== 'content_text') continue;
        if (slide != null && Number(item.slide_index) !== Number(slide)) continue;
        if (!force && item.image_status === 'ready' && item.image_file) continue;
        if (!String(item.image_prompt || '').trim()) continue;
        pages += 1;
      }
    }
    return {
      level: 'planned',
      kind: 'image',
      tokens: { input: 0, output: 0 },
      chars: 0,
      images: 0,
      cost: 0,
      currency: currencyNote(),
      local: true,
      scope: { lectures: wanted, pages },
      note: '本地 ComfyUI 生成，不产生云端费用（' + pages + ' 张待生成）。',
    };
  }
  const price = lookupPrice('image', provider, '');
  return {
    level: 'planned',
    kind: 'image',
    tokens: { input: 0, output: 0 },
    chars: 0,
    images: 0,
    cost: price ? 0 : null,
    currency: currencyNote(),
    local: false,
    scope: { lectures: [], pages: 0 },
    note: '当前版本没有可用的云端生图 provider；接口已预留。',
  };
}

export function estimateUsage(input = {}) {
  const opts = input && typeof input === 'object' ? input : {};
  const kind = String(opts.kind || '');
  if (kind === 'lecture') return estimateLecture(opts);
  if (kind === 'tts') return estimateTts(opts);
  if (kind === 'image') return estimateImage(opts);
  throw new UsageError('E_BAD_ID', 'kind 只能是 lecture / tts / image', '');
}
