/**
 * 精讲台 · 语音（v1.2）
 *
 * 供应商标识（2.0 起）：
 *   browser      —— window.speechSynthesis，本机合成，不产生音频文件（M3 起）
 *   qwen3-tts    —— 千问 Qwen3-TTS 非实时 HTTP，逐页合成 WAV 落盘（v1.2）
 *   comfyui-tts  —— 本地 ComfyUI 的 Qwen3-TTS 工作流，逐页取音频（2.0 v1.2）
 *   off          —— 只出文字
 *
 * comfyui-tts 的合成逻辑在 v2/comfy-clone.js；本文件只保留配置、云端与浏览器路径。
 *
 * 安全边界：
 *   - Qwen API Key 只存 voice.json（0600），publicVoiceConfig 只回末 4 位；
 *   - Key 只进 Authorization，不写入模块 JSON、URL、错误文案或日志；
 *   - 音频缓存按 sha256(provider|model|voice|language_type|text)，
 *     命中直接复制到模块 audio/，不重复计费。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson, sha256Of, writeAtomic } from './store.js';
import { applyVoicing, estimateAudioMs } from './slides.js';

export const VOICE_VERSION = 2;
export const VOICE_FILE = path.join(ROOT, 'voice.json');
export const AUDIO_CACHE_DIR = path.join(ROOT, 'audio-cache');

export const QWEN_MODEL = 'qwen3-tts-flash';
export const QWEN_MODELS = [
  { id: QWEN_MODEL, label: 'Qwen3-TTS Flash（非实时）', ready: true },
];
export const QWEN_DEFAULT_VOICE = 'Cherry';
export const QWEN_API_URL = 'https://maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation';
export const QWEN_TIMEOUT_MS = 60000;
export const QWEN_CONCURRENCY = 2;
export const QWEN_MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/** 文档「Qwen3-TTS 非实时语音合成音色列表」的 48 个系统音色。 */
const voice = (id, desc, gender, dialect) => ({ id: id, desc: desc, gender: gender, dialect: dialect || '' });
export const QWEN_VOICES = [
  voice('Cherry', '阳光积极、亲切自然小姐姐', '女'),
  voice('Serena', '温柔小姐姐', '女'),
  voice('Ethan', '标准普通话，带部分北方口音，阳光温暖', '男'),
  voice('Chelsie', '二次元虚拟女友', '女'),
  voice('Momo', '撒娇搞怪，逗你开心', '女'),
  voice('Vivian', '拽拽的、可爱的小暴躁', '女'),
  voice('Moon', '率性帅气的月白', '男'),
  voice('Maia', '知性与温柔的碰撞', '女'),
  voice('Kai', '耳朵的一场 SPA', '男'),
  voice('Nofish', '不会翘舌音的设计师', '男'),
  voice('Bella', '喝酒不打醉拳的小萝莉', '女'),
  voice('Jennifer', '品牌级、电影质感般美语女声', '女'),
  voice('Ryan', '节奏拉满，戏感炸裂', '男'),
  voice('Katerina', '御姐音色，韵律回味十足', '女'),
  voice('Aiden', '精通厨艺的美语大男孩', '男'),
  voice('Eldric Sage', '沉稳睿智的老者，沧桑却心明如镜', '男'),
  voice('Mia', '温顺如春水，乖巧如初雪', '女'),
  voice('Mochi', '聪明伶俐的小大人，童真未泯', '男'),
  voice('Bellona', '声音洪亮，吐字清晰，人物鲜活', '女'),
  voice('Vincent', '独特的沙哑烟嗓', '男'),
  voice('Bunny', '「萌属性」爆棚的小萝莉', '女'),
  voice('Neil', '字正腔圆的专业新闻主持人', '男'),
  voice('Elias', '学科严谨又擅长叙事的讲解者', '女'),
  voice('Arthur', '被岁月和旱烟浸泡过的质朴嗓音', '男'),
  voice('Nini', '糯米糍一样又软又黏的嗓音', '女'),
  voice('Seren', '温和舒缓的助眠声线', '女'),
  voice('Pip', '调皮捣蛋却充满童真的少年', '男'),
  voice('Stella', '甜到发腻的迷糊少女音', '女'),
  voice('Bodega', '热情的西班牙大叔', '男'),
  voice('Sonrisa', '热情开朗的拉美大姐', '女'),
  voice('Alek', '战斗民族的冷与暖', '男'),
  voice('Dolce', '慵懒的意大利大叔', '男'),
  voice('Sohee', '温柔开朗、情绪丰富的韩国欧尼', '女'),
  voice('Ono Anna', '鬼灵精怪的青梅竹马', '女'),
  voice('Lenn', '理性是底色、叛逆藏在细节里的德国青年', '男'),
  voice('Emilien', '浪漫的法国大哥哥', '男'),
  voice('Andre', '磁性、自然舒服的沉稳男声', '男'),
  voice('Radio Gol', '足球诗人 Rádio Gol 的解说嗓', '男'),
  voice('Jada', '风风火火的沪上阿姐', '女', '上海话'),
  voice('Dylan', '北京胡同里长大的少年', '男', '北京话'),
  voice('Li', '耐心的瑜伽老师', '男', '南京话'),
  voice('Marcus', '面宽话短、心实声沉的老陕', '男', '陕西话'),
  voice('Roy', '诙谐直爽的台湾哥仔', '男', '闽南语'),
  voice('Peter', '天津相声专业捧哏', '男', '天津话'),
  voice('Sunny', '甜到你心里的川妹子', '女', '四川话'),
  voice('Eric', '跳脱市井的四川成都男子', '男', '四川话'),
  voice('Rocky', '幽默风趣的粤语阿强', '男', '粤语'),
  voice('Kiki', '甜美的港妹闺蜜', '女', '粤语'),
];

export const VOICE_PROVIDERS = [
  { id: 'qwen3-tts', label: 'Qwen3-TTS（千问 AI）', ready: true, note: '逐页合成 WAV 存到本机；需要 API Key' },
  { id: 'comfyui-tts', label: '本地 ComfyUI（Qwen3-TTS）', ready: true, note: '逐页调用本机 ComfyUI 克隆工作流；需配置工作流与参考 voice 库' },
  { id: 'browser', label: '浏览器朗读（本机合成）', ready: true, note: '不产生音频文件，播放时由浏览器朗读' },
  { id: 'off', label: '关闭', ready: true, note: '只出文字，不朗读' },
];

export const DEFAULT_VOICE = {
  provider: 'browser',
  model: QWEN_MODEL,
  voice: '',
  comfyVoice: '',
  comfyRefVoice: 'builtin-vivian',
  textNode: '',
  rate: 1,
  apiKey: '',
};

const PROVIDER_IDS = VOICE_PROVIDERS.map((item) => item.id);
const MODEL_IDS = QWEN_MODELS.map((item) => item.id);
const VOICE_IDS = QWEN_VOICES.map((item) => item.id);

export const PROBE_TEXT = '你好，这是一段试听，用来确认 Qwen3-TTS 能出声。';

/** 语音失败统一错误：code 供作业层与面板使用，message 不包含 key。 */
export class TtsError extends Error {
  constructor(code, message, hint, extra) {
    super(message);
    this.name = 'TtsError';
    this.code = code;
    this.hint = hint || '';
    if (extra && typeof extra === 'object') Object.assign(this, extra);
  }
}

function normalizeProvider(value) {
  const id = String(value || '').toLowerCase();
  return PROVIDER_IDS.includes(id) ? id : 'browser';
}

function normalizeRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return 1;
  return Math.round(Math.min(2, Math.max(0.5, rate)) * 10) / 10;
}

export function normalizeVoiceConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const provider = normalizeProvider(source.provider);
  const model = MODEL_IDS.includes(String(source.model || '')) ? String(source.model) : QWEN_MODEL;
  let selected = String(source.voice || '').slice(0, 80);
  if (provider === 'qwen3-tts' && !VOICE_IDS.includes(selected)) selected = QWEN_DEFAULT_VOICE;
  return {
    version: VOICE_VERSION,
    provider: provider,
    model: model,
    voice: selected,
    comfyVoice: String(source.comfyVoice == null ? '' : source.comfyVoice).slice(0, 80),
    comfyRefVoice: String(source.comfyRefVoice == null ? '' : source.comfyRefVoice).trim().slice(0, 80) || 'builtin-vivian',
    textNode: String(source.textNode == null ? '' : source.textNode).trim().slice(0, 24),
    rate: normalizeRate(source.rate),
    apiKey: String(source.apiKey || '').trim().slice(0, 500),
  };
}

export function readVoiceConfig() {
  return normalizeVoiceConfig(readJson(VOICE_FILE, null));
}

/**
 * 写 voice.json：0600。空 apiKey / 打码值不覆盖旧 key；
 * 要删除 key 传 `{clearApiKey:true}`。
 */
export function writeVoiceConfig(patch) {
  const current = readVoiceConfig();
  const merged = Object.assign({}, current, patch && typeof patch === 'object' ? patch : {});
  if (patch && patch.clearApiKey === true) {
    merged.apiKey = '';
  } else {
    const key = String(merged.apiKey || '').trim();
    if (!key || key.includes('•') || key.includes('***') || /^\*+$/.test(key)) merged.apiKey = current.apiKey;
  }
  const next = normalizeVoiceConfig(merged);
  writeAtomic(VOICE_FILE, JSON.stringify(next, null, 2) + '\n');
  try {
    fs.chmodSync(VOICE_FILE, 0o600);
  } catch {
    /* Windows / 受限文件系统：权限尽力而为 */
  }
  return next;
}

export function maskApiKey(key) {
  const text = String(key || '');
  if (!text) return '';
  return '••••' + text.slice(-4);
}

/** 给面板看的配置：永远不返回完整 apiKey。 */
export function publicVoiceConfig(config) {
  const voiceConfig = normalizeVoiceConfig(config);
  const hasKey = !!voiceConfig.apiKey;
  const qwenReady = voiceConfig.provider === 'qwen3-tts' && hasKey;
  return {
    provider: voiceConfig.provider,
    model: voiceConfig.model,
    voice: voiceConfig.voice,
    comfyVoice: voiceConfig.comfyVoice,
    comfyRefVoice: voiceConfig.comfyRefVoice,
    textNode: voiceConfig.textNode,
    rate: voiceConfig.rate,
    hasKey: hasKey,
    apiKeyMask: maskApiKey(voiceConfig.apiKey),
    configured:
      voiceConfig.provider === 'browser' ||
      voiceConfig.provider === 'off' ||
      voiceConfig.provider === 'comfyui-tts' ||
      qwenReady,
    note:
      voiceConfig.provider === 'browser'
        ? '语音由本机浏览器合成，不上传、不产生音频文件。'
        : voiceConfig.provider === 'off'
          ? '语音已关闭，模块只出文字。'
          : voiceConfig.provider === 'comfyui-tts'
            ? 'ComfyUI 配音：逐页调用用户配置的本地克隆工作流；换参考只改请求参数，不改工作流。'
            : hasKey
              ? 'Qwen3-TTS 已配置：生成时逐页合成 WAV，播放器直接播音频文件。'
              : '还没填 Qwen API Key；生成会降级为只出文字。',
  };
}

/* ------------------------------ Qwen3-TTS ------------------------------ */

function qwenEndpoint() {
  return String(process.env.DSH_BOOK_SLIDES_QWEN_ENDPOINT || '').trim() || QWEN_API_URL;
}

function isAbortError(err) {
  return !!(err && (err.name === 'AbortError' || err.name === 'TimeoutError' || /abort/i.test(String(err.message || ''))));
}

function timeoutSignal(ms, callerSignal) {
  const timeout = AbortSignal.timeout(ms);
  if (!callerSignal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([callerSignal, timeout]);
  return callerSignal;
}

async function qwenErrorForStatus(response) {
  const status = Number(response && response.status) || 0;
  let detail = '';
  try {
    if (response && typeof response.text === 'function') {
      const raw = String(await response.text()).trim();
      if (raw) {
        try {
          const data = JSON.parse(raw);
          detail = String((data && (data.message || data.code)) || '').trim().slice(0, 240);
        } catch {
          detail = raw.slice(0, 240);
        }
      }
    }
  } catch {
    detail = '';
  }
  if (status === 401 || status === 403) {
    return new TtsError('E_TTS_AUTH', 'Qwen API Key 无效或没有语音合成权限' + (detail ? '：' + detail : ''), '到千问平台确认 Key 与模型权限后重试。');
  }
  if (status === 429) {
    return new TtsError('E_TTS_QUOTA', 'Qwen 请求过于频繁或额度不足' + (detail ? '：' + detail : ''), '稍后重试，或到千问平台查看配额。');
  }
  return new TtsError(
    'E_TTS_BAD_RESPONSE',
    'Qwen 返回 HTTP ' + status + (detail ? '：' + detail : ''),
    '检查模型名、音色与请求参数。',
  );
}

/** Qwen3-TTS 输入上限 600 字；这里按是否含中文选 language_type，英文书也能正常读。 */
function qwenLanguage(text) {
  return /[\u3400-\u9fff]/.test(String(text || '')) ? 'Chinese' : 'English';
}

/** 从 WAV 头算时长；算不出返回 0，由调用方回退到字数估算。 */
export function wavDurationMs(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return 0;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      byteRate = buffer.readUInt32LE(body + 8);
    } else if (id === 'data') {
      dataSize = Math.min(size, Math.max(0, buffer.length - body));
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!byteRate || !dataSize) return 0;
  return Math.round((dataSize / byteRate) * 1000);
}

/**
 * 调一次 Qwen3-TTS：POST 拿 24h 音频 URL，再立刻下载成 Buffer。
 * 不写盘、不缓存；缓存与落盘由 synthesizeVoicing 负责。
 */
export async function synthesizeQwen(options) {
  const opts = options || {};
  const config = normalizeVoiceConfig(opts.config);
  if (!config.apiKey) throw new TtsError('E_TTS_UNCONFIGURED', '还没配置 Qwen API Key', '到设置页填入 Key。');
  const text = String(opts.text || '').trim();
  if (!text) throw new TtsError('E_TTS_FAIL', '这一页没有朗读稿', '');
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!fetchImpl) throw new TtsError('E_TTS_NETWORK', '当前 Node 没有 fetch，无法调用 Qwen', '');
  const signal = timeoutSignal(Number(opts.timeoutMs) || QWEN_TIMEOUT_MS, opts.signal);

  let response;
  try {
    response = await fetchImpl(qwenEndpoint(), {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + config.apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        input: {
          text: text,
          voice: config.voice,
          language_type: qwenLanguage(text),
        },
      }),
      signal: signal,
    });
  } catch (err) {
    if (opts.signal && opts.signal.aborted) throw new TtsError('E_CANCELLED', '已取消', '');
    if (isAbortError(err)) throw new TtsError('E_TTS_TIMEOUT', 'Qwen 语音合成超时', '检查网络后重试。');
    throw new TtsError('E_TTS_NETWORK', '连不上 Qwen 语音服务', String((err && err.message) || err).slice(0, 160));
  }
  if (!response.ok) throw await qwenErrorForStatus(response);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new TtsError('E_TTS_BAD_RESPONSE', 'Qwen 返回的不是 JSON', '检查模型服务状态。');
  }
  const audioUrl = payload && payload.output && payload.output.audio && payload.output.audio.url;
  if (!audioUrl || typeof audioUrl !== 'string' || !/^https?:\/\//i.test(audioUrl)) {
    throw new TtsError('E_TTS_BAD_RESPONSE', 'Qwen 响应里没有有效音频 URL', '检查模型与 voice 是否匹配。');
  }

  let audioResponse;
  try {
    audioResponse = await fetchImpl(audioUrl, { signal: signal });
  } catch (err) {
    if (opts.signal && opts.signal.aborted) throw new TtsError('E_CANCELLED', '已取消', '');
    if (isAbortError(err)) throw new TtsError('E_TTS_TIMEOUT', '下载 Qwen 音频超时', '');
    throw new TtsError('E_TTS_NETWORK', '下载 Qwen 音频失败', String((err && err.message) || err).slice(0, 160));
  }
  if (!audioResponse.ok) throw new TtsError('E_TTS_BAD_RESPONSE', 'Qwen 音频下载返回 HTTP ' + audioResponse.status, '');
  const length = Number(audioResponse.headers && audioResponse.headers.get ? audioResponse.headers.get('content-length') : 0) || 0;
  if (length > QWEN_MAX_AUDIO_BYTES) throw new TtsError('E_TTS_BAD_RESPONSE', 'Qwen 音频文件过大', '');
  let buffer;
  try {
    buffer = Buffer.from(await audioResponse.arrayBuffer());
  } catch (err) {
    throw new TtsError('E_TTS_NETWORK', '读取 Qwen 音频失败', String((err && err.message) || err).slice(0, 160));
  }
  if (!buffer.length) throw new TtsError('E_TTS_BAD_RESPONSE', 'Qwen 返回了空音频', '');
  if (buffer.length > QWEN_MAX_AUDIO_BYTES) throw new TtsError('E_TTS_BAD_RESPONSE', 'Qwen 音频文件过大', '');
  return {
    buffer: buffer,
    contentType: 'audio/wav',
    audioMs: wavDurationMs(buffer) || estimateAudioMs(text, 1),
    model: config.model,
    voice: config.voice,
  };
}

/**
 * 试听：browser 返回合成参数（面板自己念）；qwen 返回 WAV Buffer；
 * 关闭/未配置返回 ok:false + code。
 */
export async function probeVoice(config, text, options) {
  const voiceConfig = normalizeVoiceConfig(config);
  const sample = String(text || '').trim().slice(0, 120) || PROBE_TEXT;
  if (voiceConfig.provider === 'off') {
    return {
      ok: false,
      code: 'E_TTS_UNCONFIGURED',
      error: '语音已关闭',
      hint: '在设置里把供应商改成「浏览器朗读」或「Qwen3-TTS」再试听。',
    };
  }
  if (voiceConfig.provider === 'browser') {
    return {
      ok: true,
      mode: 'browser',
      provider: 'browser',
      text: sample,
      voice: voiceConfig.voice,
      rate: voiceConfig.rate,
      audio_ms: estimateAudioMs(sample, voiceConfig.rate),
      note: '由浏览器窗口朗读，音量/音色取决于系统与浏览器设置。',
    };
  }
  if (voiceConfig.provider === 'comfyui-tts') {
    return {
      ok: false,
      code: 'E_TTS_UNCONFIGURED',
      error: 'ComfyUI 配音需在 2.0 设置页试听',
      hint: '打开设置 → 语音 → 本地 ComfyUI。',
    };
  }
  if (!voiceConfig.apiKey) {
    return {
      ok: false,
      code: 'E_TTS_UNCONFIGURED',
      error: '还没配置 Qwen API Key',
      hint: '在设置页填入 Key 并保存后再试听。',
    };
  }
  try {
    const result = await synthesizeQwen({
      config: voiceConfig,
      text: sample,
      fetchImpl: options && options.fetchImpl,
      signal: options && options.signal,
    });
    return {
      ok: true,
      mode: 'qwen',
      provider: 'qwen3-tts',
      model: result.model,
      voice: result.voice,
      audio: result.buffer,
      contentType: result.contentType,
      audio_ms: result.audioMs,
      note: 'Qwen3-TTS 试听；不落盘、不缓存。',
    };
  } catch (err) {
    if (err instanceof TtsError) {
      return { ok: false, code: err.code, error: err.message, hint: err.hint };
    }
    return { ok: false, code: 'E_TTS_FAIL', error: String((err && err.message) || err), hint: '' };
  }
}

/* ------------------------------ 生成阶段配音 ------------------------------ */

function audioCacheKey(voiceConfig, text) {
  return sha256Of(
    Buffer.from(
      [voiceConfig.provider, voiceConfig.model, voiceConfig.voice, qwenLanguage(text), text].join('|'),
      'utf8',
    ),
  );
}

function readCache(file) {
  try {
    const buffer = fs.readFileSync(file);
    if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
    return buffer;
  } catch {
    return null;
  }
}

function writeBinary(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, buffer);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 临时文件清不掉不影响结果 */
    }
    throw err;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        const err = new TtsError('E_CANCELLED', '已取消', '');
        reject(err);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

async function synthesizeQwenWithRetry(text, voiceConfig, options) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await synthesizeQwen({
        config: voiceConfig,
        text: text,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
    } catch (err) {
      last = err;
      if (err && (err.code === 'E_CANCELLED' || err.code === 'E_TTS_AUTH' || err.code === 'E_TTS_UNCONFIGURED')) break;
      if (attempt === 0) await sleep(400, options.signal);
    }
  }
  throw last || new TtsError('E_TTS_FAIL', '语音合成失败', '');
}

/**
 * 生成阶段的「配音」步骤（async）。browser/off 走原同步逻辑；qwen 逐页合成。
 *
 * @returns {Promise<{provider, mode, model?, voice?, degraded, code, message, slides}>}
 */
export async function synthesizeVoicing(slides, config, options) {
  const voiceConfig = normalizeVoiceConfig(config);
  const opts = options || {};
  if (voiceConfig.provider === 'browser' || voiceConfig.provider === 'off') {
    return planVoicing(slides, voiceConfig);
  }
  if (voiceConfig.provider === 'comfyui-tts') {
    return planVoicing(slides, voiceConfig);
  }
  if (!voiceConfig.apiKey) {
    return {
      provider: 'qwen3-tts',
      mode: 'none',
      model: voiceConfig.model,
      voice: voiceConfig.voice,
      degraded: true,
      code: 'E_TTS_UNCONFIGURED',
      message: '未配置 Qwen API Key，本次只出文字',
      slides: applyVoicing(slides, { provider: 'off', rate: voiceConfig.rate }),
    };
  }
  if (!opts.moduleDir) throw new TtsError('E_TTS_FAIL', '缺少模块目录，无法保存语音', '');
  const total = slides.length;
  const out = slides.map((slide) => Object.assign({}, slide));
  const audioDir = path.join(opts.moduleDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const cacheDir = opts.cacheDir || AUDIO_CACHE_DIR;
  fs.mkdirSync(cacheDir, { recursive: true });
  const errors = [];
  let completed = 0;
  let cursor = 0;
  const signal = opts.signal;

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= total) return;
      if (signal && signal.aborted) throw new TtsError('E_CANCELLED', '已取消', '');
      const slide = out[index];
      const text = String(slide.audio_script || '').trim();
      try {
        if (!text) throw new TtsError('E_TTS_FAIL', '这一页没有朗读稿', '');
        const cacheKey = audioCacheKey(voiceConfig, text);
        const cacheFile = path.join(cacheDir, cacheKey + '.wav');
        // force 重配音（长按 3s）必须忽略缓存，否则「强制」与「重新配音」没有区别
        let buffer = opts.ignoreCache ? null : readCache(cacheFile);
        if (!buffer) {
          const result = await synthesizeQwenWithRetry(text, voiceConfig, {
            fetchImpl: opts.fetchImpl,
            signal: signal,
            timeoutMs: opts.timeoutMs,
          });
          buffer = result.buffer;
          writeBinary(cacheFile, buffer);
        }
        if (signal && signal.aborted) throw new TtsError('E_CANCELLED', '已取消', '');
        const fileName = String(slide.slide_index).padStart(3, '0') + '.wav';
        const target = path.join(audioDir, fileName);
        writeBinary(target, buffer);
        slide.audio_file = 'audio/' + fileName;
        slide.audio_provider = 'qwen3-tts';
        slide.audio_ms = wavDurationMs(buffer) || estimateAudioMs(text, voiceConfig.rate);
      } catch (err) {
        if (err && err.code === 'E_CANCELLED') throw err;
        slide.audio_file = null;
        slide.audio_provider = 'none';
        errors.push({
          slide_index: slide.slide_index,
          code: (err && err.code) || 'E_TTS_FAIL',
          message: String((err && err.message) || err).slice(0, 200),
        });
      }
      completed += 1;
      if (typeof opts.onProgress === 'function') opts.onProgress(completed, total);
    }
  };

  const workers = [];
  const count = Math.max(1, Math.min(QWEN_CONCURRENCY, total));
  for (let i = 0; i < count; i += 1) workers.push(worker());
  await Promise.all(workers);

  const degraded = errors.length > 0;
  return {
    provider: 'qwen3-tts',
    mode: 'file',
    model: voiceConfig.model,
    voice: voiceConfig.voice,
    degraded: degraded,
    code: degraded ? 'E_TTS_FAIL' : null,
    message: degraded
      ? '有 ' +
        errors.length +
        ' 页配音失败（第 ' +
        errors.map((item) => item.slide_index).join('、') +
        ' 页），其余可听；' +
        errors[0].code +
        '：' +
        errors[0].message
      : '',
    errors: errors,
    slides: out,
  };
}

/**
 * 同步配音计划：browser 只算时长；off 标 none；其余（含未配置的 qwen）降级。
 * 生成作业现在优先走 async synthesizeVoicing；这个函数保留给旧调用与单测。
 */
export function planVoicing(slides, config) {
  const voiceConfig = normalizeVoiceConfig(config);
  if (voiceConfig.provider === 'browser') {
    return {
      provider: 'browser',
      mode: 'browser',
      model: voiceConfig.model,
      voice: voiceConfig.voice,
      degraded: false,
      code: null,
      message: '',
      slides: applyVoicing(slides, voiceConfig),
    };
  }
  if (voiceConfig.provider === 'off') {
    return {
      provider: 'off',
      mode: 'none',
      model: voiceConfig.model,
      voice: voiceConfig.voice,
      degraded: false,
      code: null,
      message: '',
      slides: applyVoicing(slides, { provider: 'off', rate: voiceConfig.rate }),
    };
  }
  if (voiceConfig.provider === 'comfyui-tts') {
    return {
      provider: 'comfyui-tts',
      mode: 'none',
      model: voiceConfig.model,
      voice: voiceConfig.comfyVoice,
      degraded: true,
      code: 'E_TTS_UNCONFIGURED',
      message: 'ComfyUI 配音需由 2.0 语音作业执行',
      slides: applyVoicing(slides, { provider: 'off', rate: voiceConfig.rate }),
    };
  }
  return {
    provider: 'qwen3-tts',
    mode: 'none',
    model: voiceConfig.model,
    voice: voiceConfig.voice,
    degraded: true,
    code: voiceConfig.apiKey ? 'E_TTS_FAIL' : 'E_TTS_UNCONFIGURED',
    message: voiceConfig.apiKey ? '云端语音未启用，本次只出文字' : '未配置 Qwen API Key，本次只出文字',
    slides: applyVoicing(slides, { provider: 'off', rate: voiceConfig.rate }),
  };
}
