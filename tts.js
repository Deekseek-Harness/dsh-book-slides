/**
 * 精讲台 · 语音（M3）
 *
 * 这一版只落「浏览器本机朗读」：
 *   - 不调用任何云端服务，不产生 audios/*.mp3；
 *   - slides.json 里保留 audio_script + audio_ms（按字数估），
 *     由面板在播放时用 window.speechSynthesis 出声（M4 播放器接线）；
 *   - voice.json 仍然独立存（0600），和「书库」插件互不读写。
 *
 * 豆包（火山引擎）只保留配置字段与供应商占位：合成函数留到后续里程碑，
 * 现在选它不会阻断生成，模块落 ready_degraded 并说明「本次只出文字」。
 * 这也是 D16 的原则：语音是最容易缺配置的一环，做成可降级比做成硬依赖好用。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson, writeAtomic } from './store.js';
import { applyVoicing, estimateAudioMs } from './slides.js';

export const VOICE_VERSION = 1;
export const VOICE_FILE = path.join(ROOT, 'voice.json');

/** 本版可选的供应商。豆包等云端合成排在后面（保留 id，方便以后加）。 */
export const VOICE_PROVIDERS = [
  { id: 'browser', label: '浏览器朗读（本机合成）', ready: true, note: '不产生音频文件，播放时由浏览器朗读' },
  { id: 'doubao', label: '豆包（火山引擎）', ready: false, note: '合成接口还没接，选定后本次只出文字' },
  { id: 'off', label: '关闭', ready: true, note: '只出文字，不朗读' },
];

export const DEFAULT_VOICE = {
  provider: 'browser',
  voice: '',
  rate: 1,
  appId: '',
  token: '',
};

const PROVIDER_IDS = VOICE_PROVIDERS.map((item) => item.id);

/** 试听文案：3 秒内能念完，且不依赖原文。 */
export const PROBE_TEXT = '这是一段试听，用来确认本机朗读能出声。';

function normalizeProvider(value) {
  const id = String(value || '').toLowerCase();
  return PROVIDER_IDS.includes(id) ? id : 'browser';
}

function normalizeRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return 1;
  return Math.round(Math.min(2, Math.max(0.5, rate)) * 10) / 10;
}

/** 合并默认值，顺手把非法字段掰回合法值。 */
export function normalizeVoiceConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const provider = normalizeProvider(source.provider);
  return {
    version: VOICE_VERSION,
    provider: provider,
    voice: String(source.voice || '').slice(0, 120),
    rate: normalizeRate(source.rate),
    // 豆包字段先存着：等云端合成接进来不用再改配置文件
    appId: String(source.appId || '').slice(0, 80),
    token: String(source.token || '').slice(0, 300),
  };
}

export function readVoiceConfig() {
  return normalizeVoiceConfig(readJson(VOICE_FILE, null));
}

/**
 * 写 voice.json：0600。
 *
 * Windows 上 chmod 基本是空操作（ACL 才是权限），失败也不该让保存失败；
 * 这里只保证「文件存在且内容完整」，权限尽力而为。
 */
export function writeVoiceConfig(patch) {
  const current = readVoiceConfig();
  const merged = Object.assign({}, current, patch && typeof patch === 'object' ? patch : {});
  // 面板回传的是打码后的 token 时，不要用星号覆盖真 token
  const token = String(merged.token || '').trim();
  if (!token || token.includes('***') || /^\*+$/.test(token)) merged.token = current.token;
  const next = normalizeVoiceConfig(merged);
  writeAtomic(VOICE_FILE, JSON.stringify(next, null, 2) + '\n');
  try {
    fs.chmodSync(VOICE_FILE, 0o600);
  } catch {
    /* Windows / 受限文件系统：权限尽力而为 */
  }
  return next;
}

/** 给面板看的配置：token 只回传打码占位。 */
export function publicVoiceConfig(config) {
  const voice = normalizeVoiceConfig(config);
  const token = voice.token;
  return {
    provider: voice.provider,
    voice: voice.voice,
    rate: voice.rate,
    appId: voice.appId,
    hasToken: !!token,
    tokenMask: token ? token.slice(0, 2) + '***' + token.slice(-2) : '',
    configured: voice.provider === 'browser' || voice.provider === 'off' || (voice.provider === 'doubao' && !!voice.appId && !!token),
    note:
      voice.provider === 'browser'
        ? '语音由本机浏览器合成，不上传、不产生音频文件。'
        : voice.provider === 'off'
          ? '语音已关闭，模块只出文字。'
          : '豆包合成还没接入，本次只出文字；先用「浏览器朗读」即可出声。',
  };
}

/**
 * 试听。浏览器朗读没法在服务端出声：返回合成参数，面板拿到后用 speechSynthesis 念。
 * 未启用/未配置时返回 ok:false + 错误码（AC-22 的「点试听先提示去设置」）。
 */
export function probeVoice(config, text) {
  const voice = normalizeVoiceConfig(config);
  const sample = String(text || '').trim().slice(0, 120) || PROBE_TEXT;
  if (voice.provider === 'off') {
    return {
      ok: false,
      code: 'E_TTS_UNCONFIGURED',
      error: '语音已关闭',
      hint: '在设置里把语音供应商改成「浏览器朗读」再试听。',
    };
  }
  if (voice.provider === 'browser') {
    return {
      ok: true,
      mode: 'browser',
      provider: 'browser',
      text: sample,
      voice: voice.voice,
      rate: voice.rate,
      audio_ms: estimateAudioMs(sample, voice.rate),
      note: '由浏览器窗口朗读，音量/音色取决于系统与浏览器设置。',
    };
  }
  return {
    ok: false,
    code: 'E_TTS_UNCONFIGURED',
    error: '豆包语音还没接入',
    hint: '先用「浏览器朗读」，这条链路不需要任何密钥。',
  };
}

/**
 * 生成阶段的「配音」步骤。
 *
 * browser：给每页估 audio_ms，标记 audio_provider=browser；
 * off：全部标 none，不算降级（用户主动关的）；
 * 其余：降级，文字照常可用（D16）。
 */
export function planVoicing(slides, config) {
  const voice = normalizeVoiceConfig(config);
  if (voice.provider === 'browser') {
    return {
      provider: 'browser',
      mode: 'browser',
      degraded: false,
      code: null,
      message: '',
      slides: applyVoicing(slides, voice),
    };
  }
  if (voice.provider === 'off') {
    return {
      provider: 'off',
      mode: 'none',
      degraded: false,
      code: null,
      message: '',
      slides: applyVoicing(slides, { provider: 'off', rate: voice.rate }),
    };
  }
  return {
    provider: voice.provider,
    mode: 'none',
    degraded: true,
    code: 'E_TTS_UNCONFIGURED',
    message: '语音供应商「' + voice.provider + '」还没接入，本次只出文字',
    slides: applyVoicing(slides, { provider: 'off', rate: voice.rate }),
  };
}
