/**
 * v1.3 本地 ComfyUI Qwen3-TTS VoiceClone 配音。
 *
 * 与 v1.2 的差别只在 ComfyUI 请求参数与“参考 voice 库”：
 *   - 工作流：LoadAudio → FB_Qwen3TTSVoiceClone(target_text, ref_audio, ref_text, x_vector_only=false) → SaveAudio
 *   - 音色不再写 speaker，而是写 ref_audio 上游文件名 + ref_text；
 *   - 参考库是 (参考音频, 参考文本) 的静态资产，运行时注入，不重写工作流。
 * 逐页作业、五态、缓存、串行队列、取消语义与 v1.2 相同。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { readJson, writeAtomic, ROOT } from './root.js';
import { baseUrlOf, readImageConfig } from '../comfy.js';
import { estimateAudioMs } from '../slides.js';
import { TtsError, wavDurationMs, readVoiceConfig, writeVoiceConfig } from '../tts.js';
import { runComfyExclusive } from './comfy-queue.js';

export const TTS_DEFAULT_REF_DIR = fileURLToPath(new URL('../workflows/qwen3-tts-通过克隆配音', import.meta.url));
export const TTS_DEFAULT_WORKFLOW_PATH = path.join(TTS_DEFAULT_REF_DIR, 'qwen3-tts-通过克隆配音.json');
export const TTS_REFVOICES_FILE = path.join(ROOT, 'comfy-tts-refvoices.json');
export const TTS_VOICES_DIR = path.join(ROOT, 'voices');

export const TTS_DEFAULT_MODEL = 'Qwen3-TTS-12Hz-1.7B-Base';
export const TTS_DEFAULT_REF_ID = 'builtin-vivian';
export const TTS_TIMEOUT_MS = 180000;

/** 配音单次/整作业超时；默认 180s，可用 DSH_BOOK_SLIDES_TTS_TIMEOUT_MS 调低（AC-135）。 */
export function ttsTimeoutMs() {
  const raw = Number(process.env.DSH_BOOK_SLIDES_TTS_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.max(1000, Math.floor(raw)) : TTS_TIMEOUT_MS;
}
export const TTS_PROBE_TIMEOUT_MS = 10000;
export const TTS_QUEUE_WAIT_MS = 10000;
export const TTS_MAX_AUDIO_BYTES = 32 * 1024 * 1024;
export const TTS_WORKFLOW_MAX_BYTES = 1024 * 1024;
export const TTS_WORKFLOW_MAX_NODES = 2000;
export const TTS_REF_TABLE_MAX_BYTES = 256 * 1024;
export const TTS_REF_MAX_ITEMS = 50;
export const TTS_REF_TEXT_MAX = 2000;
export const TTS_REF_AUDIO_MAX_BYTES = 32 * 1024 * 1024;
export const TTS_REF_DURATION_WARN_LOW = 3000;
export const TTS_REF_DURATION_WARN_HIGH = 30000;
/** 推荐时长 5–15s；在容忍区（3–30s）但超出推荐时只给中性提示，不算 warning（AC-154）。 */
export const TTS_REF_DURATION_RECOMMEND_LOW = 5000;
export const TTS_REF_DURATION_RECOMMEND_HIGH = 15000;
export const AUDIO_EXTS = ['wav', 'flac', 'mp3', 'ogg'];
export const AUDIO_CONTENT_TYPES = { wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg', ogg: 'audio/ogg' };
export const TTS_TEST_TEXT = '你好，这是一段试听，用来确认 ComfyUI 的 Qwen3-TTS 克隆配音能出声。';

const LABELS = { 'builtin-vivian': 'Vivian', 'builtin-uncle-fu': 'Uncle Fu' };

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function bytesOfJson(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return 0;
  }
}

function audioExtOf(name) {
  const match = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  const ext = match ? match[1].toLowerCase() : '';
  return AUDIO_EXTS.includes(ext) ? ext : '';
}

/* ------------------------------ 参考 voice 库 ------------------------------ */

/** FLAC STREAMINFO（前 42 字节）→ 时长；解析失败返回 0。 */
function flacDurationMs(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 42) return 0;
  if (buffer.toString('ascii', 0, 4) !== 'fLaC') return 0;
  const sampleRate = (buffer[18] << 12) | (buffer[19] << 4) | (buffer[20] >> 4);
  const totalSamples =
    (buffer[21] & 0x0f) * 2 ** 32 + buffer[22] * 2 ** 24 + (buffer[23] << 16) + (buffer[24] << 8) + buffer[25];
  return sampleRate > 0 && totalSamples > 0 ? Math.round((totalSamples / sampleRate) * 1000) : 0;
}

export function audioDurationMs(file) {
  let buffer;
  try {
    const fd = fs.openSync(file, 'r');
    buffer = Buffer.alloc(65536);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    buffer = buffer.subarray(0, read);
  } catch {
    return 0;
  }
  return flacDurationMs(buffer) || wavDurationMs(buffer);
}

function prettifyName(id) {
  return String(id || '')
    .replace(/^builtin-/, '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** 包内默认参考：扫描目录里的 flac/wav/mp3/ogg + 同名 txt。 */
export function builtinRefVoices() {
  let files = [];
  try {
    files = fs.readdirSync(TTS_DEFAULT_REF_DIR);
  } catch {
    return [];
  }
  const voices = [];
  for (const fileName of files.sort()) {
    if (!audioExtOf(fileName)) continue;
    const base = fileName.replace(/\.[^.]+$/, '');
    const id = 'builtin-' + base.replace(/^qwen3-tts-1\.7B_/i, '').toLowerCase().replace(/_/g, '-');
    const txtPath = path.join(TTS_DEFAULT_REF_DIR, base + '.txt');
    let refText = '';
    try {
      refText = fs.readFileSync(txtPath, 'utf8').replace(/^\uFEFF/, '').trim();
    } catch {
      refText = '';
    }
    const file = path.join(TTS_DEFAULT_REF_DIR, fileName);
    voices.push({
      id,
      name: LABELS[id] || prettifyName(id),
      audio: fileName,
      ref_text: refText,
      lang: '中文',
      duration_ms: audioDurationMs(file),
      sha256: sha256(fs.readFileSync(file)),
      source: 'builtin',
      default: id === TTS_DEFAULT_REF_ID,
    });
  }
  return voices;
}

function normalizeAudioRef(value, source) {
  const text = String(value == null ? '' : value).trim().replace(/\\/g, '/');
  if (!text || text.includes('..') || text.startsWith('/')) {
    throw new TtsError('E_TTS_VOICE_REF', '参考音频路径不合法：' + text, '只接受相对路径，且不能包含 ..');
  }
  if (!audioExtOf(text)) throw new TtsError('E_TTS_VOICE_REF', '参考音频格式不支持：' + text, '支持 wav/flac/mp3/ogg。');
  if (source === 'imported' && !text.startsWith('voices/')) return 'voices/' + path.posix.basename(text);
  return text;
}

function normalizeRefEntry(raw, fallbackSource) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id == null ? '' : raw.id).trim().slice(0, 64);
  const name = String(raw.name == null ? '' : raw.name).trim().slice(0, 64);
  const refText = String(raw.ref_text == null ? '' : raw.ref_text).trim();
  if (!id || !name) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new TtsError('E_TTS_VOICE_REF', '参考 voice id 只能用字母/数字/._-：' + id, '');
  if (!refText) throw new TtsError('E_TTS_VOICE_REF', '参考 voice「' + name + '」缺少参考文本', 'ref_text 必须是参考音频的逐字转写。');
  if (refText.length > TTS_REF_TEXT_MAX) throw new TtsError('E_TTS_VOICE_REF', '参考文本超过 ' + TTS_REF_TEXT_MAX + ' 字', '截短参考音频后重试。');
  const source = fallbackSource === 'builtin' ? 'builtin' : raw.source === 'builtin' ? 'builtin' : 'imported';
  const entry = {
    id,
    name,
    audio: normalizeAudioRef(raw.audio, source),
    ref_text: refText,
    lang: String(raw.lang == null ? '' : raw.lang).trim().slice(0, 16),
    duration_ms: Math.max(0, Math.round(Number(raw.duration_ms) || 0)),
    sha256: /^[a-f0-9]{64}$/i.test(String(raw.sha256 || '')) ? String(raw.sha256).toLowerCase() : '',
    source,
  };
  const label = String(raw.label == null ? '' : raw.label).trim().slice(0, 64);
  if (label && label !== name) entry.label = label;
  if (raw.default === true) entry.default = true;
  return entry;
}

export function normalizeRefTable(raw, meta) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const list = Array.isArray(raw) ? raw : Array.isArray(source.voices) ? source.voices : null;
  if (!list) throw new TtsError('E_TTS_VOICE_REF', '参考 voice 表缺少 voices 数组', '提供 {voices:[...]}。');
  if (!list.length) throw new TtsError('E_TTS_VOICE_REF', '参考 voice 表至少要有 1 项', '');
  if (list.length > TTS_REF_MAX_ITEMS) throw new TtsError('E_TTS_VOICE_REF', '参考 voice 表最多 ' + TTS_REF_MAX_ITEMS + ' 项', '');
  const opts = meta && typeof meta === 'object' ? meta : {};
  const src = opts.source === 'builtin' ? 'builtin' : 'imported';
  const voices = [];
  const seen = new Set();
  let defaultCount = 0;
  for (const item of list) {
    const entry = normalizeRefEntry(item, opts.source === 'builtin' ? 'builtin' : 'imported');
    if (!entry) throw new TtsError('E_TTS_VOICE_REF', '参考 voice 缺少 id 或 name', '每项至少要有 id/name/audio/ref_text。');
    if (seen.has(entry.id)) throw new TtsError('E_TTS_VOICE_REF', '参考 voice id 重复：' + entry.id, '');
    seen.add(entry.id);
    if (entry.default) defaultCount += 1;
    voices.push(entry);
  }
  if (defaultCount > 1) throw new TtsError('E_TTS_VOICE_REF', '最多只能有一个默认参考 voice', '');
  const defaultVoice = (voices.find((item) => item.default) || voices[0]).id;
  return {
    version: 1,
    name: String(opts.name || source.name || '参考 voice 库').trim().slice(0, 80) || '参考 voice 库',
    model: String(opts.model || source.model || TTS_DEFAULT_MODEL).trim().slice(0, 80),
    source: src,
    savedAt: String(opts.savedAt || source.savedAt || ''),
    voices,
    defaultVoice,
  };
}

export function defaultRefTable() {
  return normalizeRefTable(
    { version: 1, name: 'Qwen3-TTS 内置参考', model: TTS_DEFAULT_MODEL, voices: builtinRefVoices() },
    { source: 'builtin', name: 'Qwen3-TTS 内置参考', model: TTS_DEFAULT_MODEL },
  );
}

export function readRefTable() {
  const stored = readJson(TTS_REFVOICES_FILE, null);
  if (!stored) return defaultRefTable();
  try {
    return normalizeRefTable(stored, {
      source: 'imported',
      name: stored.name,
      model: stored.model,
      savedAt: stored.savedAt,
    });
  } catch (err) {
    const fallback = defaultRefTable();
    fallback.warning = '参考 voice 表损坏，已回落到内置：' + String((err && err.message) || err);
    return fallback;
  }
}

/**
 * 参考音频时长提示（AC-154）。
 *   warn = 不在容忍区（<3s 或 >30s），需要用户处理（进入 probe warnings）；
 *   tip  = 在容忍区（3–30s）但超出推荐 5–15s，只作中性提示，不阻断、不算 warning。
 * 没有时长（0）时返回空提示。
 */
export function refDurationNotice(voice) {
  const ms = Math.max(0, Math.round(Number(voice && voice.duration_ms) || 0));
  if (!ms) return { level: '', text: '' };
  const name = String((voice && (voice.label || voice.name)) || '').trim();
  const who = name ? '参考「' + name + '」' : '参考音频';
  const seconds = (ms / 1000).toFixed(1) + 's';
  if (ms < TTS_REF_DURATION_WARN_LOW || ms > TTS_REF_DURATION_WARN_HIGH) {
    return {
      level: 'warn',
      text: who + '时长 ' + seconds + '，超出推荐 5–15s（容忍区 3–30s）；可继续使用，建议截短到 5–15s 后重新导入。',
    };
  }
  if (ms < TTS_REF_DURATION_RECOMMEND_LOW || ms > TTS_REF_DURATION_RECOMMEND_HIGH) {
    return {
      level: 'tip',
      text: who + '时长 ' + seconds + '，超出推荐 5–15s，但在容忍区（3–30s）内，不影响配音。',
    };
  }
  return { level: '', text: '' };
}

/** 对外 payload：不返回绝对路径；补时长/哈希/来源/时长提示。 */
export function refTablePayload() {
  const table = readRefTable();
  return {
    name: table.name,
    model: table.model,
    source: table.source,
    count: table.voices.length,
    defaultVoice: table.defaultVoice,
    voices: table.voices
      .slice()
      .sort((a, b) => (a.id === table.defaultVoice ? -1 : b.id === table.defaultVoice ? 1 : a.name.localeCompare(b.name)))
      .map((item) => {
        const notice = refDurationNotice(item);
        return {
          id: item.id,
          name: item.label || item.name,
          audio: item.audio,
          ref_text: item.ref_text,
          lang: item.lang,
          duration_ms: item.duration_ms,
          duration_level: notice.level,
          duration_text: notice.text,
          sha256: item.sha256,
          source: item.source,
          default: item.id === table.defaultVoice,
        };
      }),
    warning: table.warning || '',
  };
}

export function saveRefTable(body) {
  const input = body && typeof body === 'object' ? body : {};
  if (input.reset === true) {
    try {
      fs.rmSync(TTS_REFVOICES_FILE, { force: true });
    } catch {
      /* 删不掉也不影响读内置 */
    }
    return refTablePayload();
  }
  if (input.remove != null) {
    const id = String(input.remove).trim();
    const current = readRefTable();
    const target = current.voices.find((item) => item.id === id);
    if (!target) throw new TtsError('E_TTS_VOICE_REF', '参考 voice 不存在：' + (id || '(空)'), '刷新后重试。');
    if (target.source === 'builtin') throw new TtsError('E_TTS_VOICE_REF', '内置参考不能删除', '用「恢复默认」回到内置 2 项。');
    const voices = current.voices
      .filter((item) => item.id !== id)
      .map((item) => Object.assign({}, item, { default: item.id === current.defaultVoice }));
    if (!voices.some((item) => item.source === 'imported')) {
      try {
        fs.rmSync(TTS_REFVOICES_FILE, { force: true });
      } catch {
        /* 删不掉就留空表，读取侧仍会回落到内置 */
      }
      return refTablePayload();
    }
    const table = normalizeRefTable(
      { name: current.name, model: current.model, voices },
      { source: 'imported', name: current.name, model: current.model, savedAt: nowIso() },
    );
    writeAtomic(
      TTS_REFVOICES_FILE,
      JSON.stringify(
        { version: 1, name: table.name, model: table.model, source: 'imported', savedAt: table.savedAt, voices: table.voices },
        null,
        2,
      ) + '\n',
    );
    return refTablePayload();
  }
  const raw = input.table && typeof input.table === 'object' ? input.table : input.table || input;
  if (bytesOfJson(raw) > TTS_REF_TABLE_MAX_BYTES) throw new TtsError('E_TTS_VOICE_REF', '参考 voice 表超过 256 KB', '');
  const table = normalizeRefTable(raw, {
    source: 'imported',
    name: input.name || (raw && raw.name),
    model: raw && raw.model,
    savedAt: nowIso(),
  });
  // 已存在的本地 wav/flac 必须能解码（AC-154）；不存在的文件留待上传后再校验。
  for (const voice of table.voices) {
    const ext = String(voice.audio || '').split('.').pop().toLowerCase();
    if (ext !== 'wav' && ext !== 'flac') continue;
    const abs = path.join(ROOT, 'voices', path.basename(voice.audio));
    if (!fs.existsSync(abs)) continue;
    let duration = 0;
    try {
      duration = audioDurationMs(abs);
    } catch {
      duration = 0;
    }
    if (!duration) {
      throw new TtsError('E_TTS_VOICE_REF', '参考音频无法解码：' + voice.name, '换一个可正常播放的 wav/flac。');
    }
  }
  writeAtomic(
    TTS_REFVOICES_FILE,
    JSON.stringify(
      { version: 1, name: table.name, model: table.model, source: 'imported', savedAt: table.savedAt, voices: table.voices },
      null,
      2,
    ) + '\n',
  );
  return refTablePayload();
}

function refVoiceIdFrom(name, used) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40);
  const stem = base || 'ref-' + crypto.randomBytes(4).toString('hex');
  let id = 'ref-' + stem;
  let n = 2;
  while (used.has(id)) {
    id = 'ref-' + stem + '-' + n;
    n += 1;
  }
  return id.slice(0, 64);
}

/**
 * 成对导入一个参考 voice：参考音频 + 逐字转写文本。
 * 音频复制到数据根 voices/，条目追加到当前参考库（保留内置项），返回整表与新条目。
 */
export function addRefVoice(input) {
  const audioBuffer = input && Buffer.isBuffer(input.audioBuffer) ? input.audioBuffer : null;
  if (!audioBuffer || audioBuffer.length < 1024) {
    throw new TtsError('E_TTS_VOICE_REF', '没有收到可用的参考音频', '选择一个 wav/flac/mp3/ogg 文件（≤32MB）。');
  }
  if (audioBuffer.length > TTS_REF_AUDIO_MAX_BYTES) {
    throw new TtsError('E_TTS_VOICE_REF', '参考音频超过 32MB', '截短参考音频后重试。');
  }
  const audioName = String((input && input.audioName) || '').trim();
  const ext = audioExtOf(audioName);
  if (!ext) {
    throw new TtsError('E_TTS_VOICE_REF', '参考音频格式不支持：' + (audioName || '未命名'), '支持 wav/flac/mp3/ogg。');
  }
  const refText = String((input && input.refText) || '').replace(/^\uFEFF/, '').trim();
  if (!refText) {
    throw new TtsError('E_TTS_VOICE_REF', '参考文本为空', '请同时选择参考音频的逐字转写 .txt。');
  }
  if (refText.length > TTS_REF_TEXT_MAX) {
    throw new TtsError('E_TTS_VOICE_REF', '参考文本超过 ' + TTS_REF_TEXT_MAX + ' 字', '截短参考音频后重试。');
  }
  const table = readRefTable();
  if (table.voices.length >= TTS_REF_MAX_ITEMS) {
    throw new TtsError('E_TTS_VOICE_REF', '参考 voice 库最多 ' + TTS_REF_MAX_ITEMS + ' 项', '先删除一些参考 voice。');
  }
  const display =
    String((input && input.name) || audioName.replace(/\.[^.]+$/, '')).trim().slice(0, 64) || '参考 voice';
  const id = refVoiceIdFrom(display, new Set(table.voices.map((item) => item.id)));
  const fileName = id + '.' + ext;
  const file = path.join(TTS_VOICES_DIR, fileName);
  const duration = flacDurationMs(audioBuffer) || wavDurationMs(audioBuffer) || 0;
  fs.mkdirSync(TTS_VOICES_DIR, { recursive: true });
  writeAtomic(file, audioBuffer);
  const voices = table.voices.map((item) => ({
    id: item.id,
    name: item.name,
    label: item.label,
    audio: item.audio,
    ref_text: item.ref_text,
    lang: item.lang,
    duration_ms: item.duration_ms,
    sha256: item.sha256,
    source: item.source,
    default: item.id === table.defaultVoice,
  }));
  voices.push({
    id,
    name: display,
    audio: 'voices/' + fileName,
    ref_text: refText,
    lang: '',
    duration_ms: duration,
    sha256: sha256(audioBuffer),
    source: 'imported',
    default: false,
  });
  const tableName = table.source === 'builtin' ? '自定义参考' : table.name;
  try {
    const saved = saveRefTable({ table: { name: tableName, model: table.model, voices }, name: tableName });
    return { table: saved, entry: (saved.voices || []).find((item) => item.id === id) || null };
  } catch (err) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 回滚音频失败时保留文件也无害 */
    }
    throw err;
  }
}

export function resolveRefVoice(table, wanted) {
  const voices = table && Array.isArray(table.voices) ? table.voices : [];
  if (!voices.length) throw new TtsError('E_TTS_VOICE_REF', '参考 voice 库为空', '导入参考 voice 或恢复默认。');
  const id = String(wanted == null ? '' : wanted).trim();
  if (!id) return voices.find((item) => item.id === table.defaultVoice) || voices[0];
  const exact = voices.find((item) => item.id === id);
  if (exact) return exact;
  const lower = voices.find((item) => item.id.toLowerCase() === id.toLowerCase());
  if (lower) return lower;
  throw new TtsError('E_TTS_VOICE_REF', '参考 voice 不存在：' + id, '到设置里重新选择参考 voice。');
}

export function refVoiceFile(voice) {
  const table = readRefTable();
  const entry = voice && voice.id ? voice : resolveRefVoice(table, '');
  const root = entry.source === 'builtin' ? TTS_DEFAULT_REF_DIR : ROOT;
  const file = path.join(root, entry.audio);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new TtsError('E_TTS_VOICE_REF', '参考音频文件不存在：' + entry.audio, '把参考音频放到数据根 voices/ 下，或恢复默认。');
  }
  if (!stat.isFile() || stat.size < 1024) throw new TtsError('E_TTS_VOICE_REF', '参考音频为空或不可读：' + entry.audio, '');
  if (stat.size > TTS_REF_AUDIO_MAX_BYTES) throw new TtsError('E_TTS_VOICE_REF', '参考音频超过 32MB', '');
  return { file, size: stat.size, ext: audioExtOf(file) };
}

export function refVoiceSha(voice) {
  const { file } = refVoiceFile(voice);
  const buffer = fs.readFileSync(file);
  return { sha256: sha256(buffer), buffer, file };
}

export function refVoiceSummary(voice) {
  const notice = refDurationNotice(voice);
  return {
    id: voice.id,
    name: voice.label || voice.name,
    lang: voice.lang || '',
    duration_ms: Number(voice.duration_ms) || 0,
    duration_level: notice.level,
    duration_text: notice.text,
    source: voice.source || '',
  };
}

/* ------------------------------ 工作流 ------------------------------ */

function isRef(value) {
  return Array.isArray(value) && value.length === 2 && (typeof value[0] === 'string' || typeof value[0] === 'number') && Number.isInteger(Number(value[1]));
}

function workflowFormat(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  if (Array.isArray(raw.nodes) && Array.isArray(raw.links)) return 'ui';
  return 'api';
}

export function convertUiWorkflow(raw) {
  const links = Array.isArray(raw && raw.links) ? raw.links : [];
  const nodes = Array.isArray(raw && raw.nodes) ? raw.nodes : [];
  const linkMap = new Map();
  for (const link of links) {
    if (!Array.isArray(link) || link.length < 5) continue;
    linkMap.set(Number(link[0]), link);
  }
  const api = {};
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (Number(node.mode == null ? 0 : node.mode) !== 0) continue;
    const id = String(node.id);
    if (!node.widgets_values_named || typeof node.widgets_values_named !== 'object') {
      throw new TtsError('E_TTS_WORKFLOW', '界面格式工作流缺少 widgets_values_named，无法安全转成 API 格式', '用 ComfyUI「保存（API 格式）」重新导出。');
    }
    if (!node.type) throw new TtsError('E_TTS_WORKFLOW', '工作流节点 ' + id + ' 缺少 type', '');
    const inputs = {};
    for (const key of Object.keys(node.widgets_values_named)) {
      if (key === 'control_after_generate') continue;
      inputs[key] = node.widgets_values_named[key];
    }
    for (const input of Array.isArray(node.inputs) ? node.inputs : []) {
      if (!input || input.link == null) continue;
      const link = linkMap.get(Number(input.link));
      if (!link) throw new TtsError('E_TTS_WORKFLOW', '工作流链接 ' + input.link + ' 不存在', '');
      inputs[input.name] = [String(link[1]), Number(link[2])];
    }
    api[id] = { class_type: String(node.type), inputs };
  }
  return api;
}

function validateApiWorkflow(raw) {
  const ids = Object.keys(raw || {});
  if (ids.length < 2) throw new TtsError('E_TTS_WORKFLOW', '工作流节点太少（' + ids.length + ' 个）', '确认导出的是 API 格式。');
  if (ids.length > TTS_WORKFLOW_MAX_NODES) throw new TtsError('E_TTS_WORKFLOW', '工作流节点太多（' + ids.length + ' 个）', '');
  for (const id of ids) {
    const node = raw[id];
    if (!node || typeof node !== 'object' || typeof node.class_type !== 'string') {
      throw new TtsError('E_TTS_WORKFLOW', '工作流节点 ' + id + ' 缺 class_type', '');
    }
    if (!node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) {
      throw new TtsError('E_TTS_WORKFLOW', '工作流节点 ' + id + ' 缺 inputs', '');
    }
  }
  for (const id of ids) {
    const inputs = raw[id].inputs || {};
    for (const key of Object.keys(inputs)) {
      if (!isRef(inputs[key])) continue;
      if (!raw[String(inputs[key][0])]) throw new TtsError('E_TTS_WORKFLOW', '工作流节点 ' + id + '.' + key + ' 引用了不存在的节点', '');
    }
  }
  return raw;
}

export function prepareWorkflow(raw) {
  if (bytesOfJson(raw) > TTS_WORKFLOW_MAX_BYTES) throw new TtsError('E_TTS_WORKFLOW', '工作流超过 1 MB', '');
  const format = workflowFormat(raw);
  if (!format) throw new TtsError('E_TTS_WORKFLOW', '工作流必须是 JSON 对象', '');
  let api;
  try {
    api = format === 'ui' ? convertUiWorkflow(raw) : validateApiWorkflow(raw);
  } catch (err) {
    if (err instanceof TtsError) throw err;
    throw new TtsError('E_TTS_WORKFLOW', '工作流解析失败：' + String((err && err.message) || err), '');
  }
  return { format, raw, api };
}

export function workflowHashOf(raw) {
  return sha256(JSON.stringify(raw || {}));
}

const TEXT_FIELDS = ['text', 'target_text'];
const AUDIO_FILE_FIELDS = ['audio', 'filename', 'path', 'file'];

function stringFieldOf(node, whitelist) {
  const inputs = node && node.inputs && typeof node.inputs === 'object' ? node.inputs : null;
  if (!inputs) return '';
  for (const key of whitelist) {
    if (typeof inputs[key] === 'string') return key;
  }
  return '';
}

function followString(api, ref, whitelist, seen) {
  if (!isRef(ref)) return null;
  const id = String(ref[0]);
  const node = api[id];
  if (!node) return null;
  const field = stringFieldOf(node, whitelist);
  if (field) return { id, field };
  const visited = seen || new Set();
  if (visited.has(id)) return null;
  visited.add(id);
  const inputs = node.inputs || {};
  for (const key of Object.keys(inputs)) {
    if (isRef(inputs[key])) {
      const found = followString(api, inputs[key], whitelist, visited);
      if (found) return found;
    }
  }
  return null;
}

function textTargetOf(api, id) {
  const node = api[id];
  if (!node) return null;
  const inputs = node.inputs || {};
  for (const key of TEXT_FIELDS) {
    if (typeof inputs[key] === 'string') return { id, field: key };
  }
  for (const key of TEXT_FIELDS) {
    if (isRef(inputs[key])) return followString(api, inputs[key], TEXT_FIELDS);
  }
  return null;
}

function refTargetOf(api, id) {
  const node = api[id];
  const inputs = node && node.inputs ? node.inputs : {};
  const ref = inputs.ref_audio;
  if (!isRef(ref)) return null;
  const upstream = api[String(ref[0])];
  if (!upstream) return null;
  const field = stringFieldOf(upstream, AUDIO_FILE_FIELDS);
  return field ? { id: String(ref[0]), field, link: ref } : null;
}

function ttsNodeIds(api) {
  return Object.keys(api || {}).filter((id) => /qwen3tts/i.test(String((api[id] && api[id].class_type) || '')));
}

function pickOutputNode(api) {
  const ids = Object.keys(api || {});
  const save = ids.find((id) => /SaveAudio/i.test(String(api[id].class_type || '')));
  if (save) return { id: save, warning: '' };
  const preview = ids.find((id) => /PreviewAudio/i.test(String(api[id].class_type || '')));
  if (preview) return { id: preview, warning: '' };
  const anyAudio = ids.find((id) => /audio/i.test(String(api[id].class_type || '')));
  if (anyAudio) return { id: anyAudio, warning: '工作流没有 SaveAudio/PreviewAudio，使用 ' + anyAudio + ' 作为音频输出。' };
  throw new TtsError('E_TTS_WORKFLOW', '工作流里找不到音频输出节点', '末尾加 SaveAudio 或 PreviewAudio。');
}

function inspectWorkflow(api) {
  const tts = ttsNodeIds(api);
  if (!tts.length) throw new TtsError('E_TTS_WORKFLOW', '工作流里找不到 Qwen3-TTS 节点', '确认工作流含 VoiceClone 节点。');
  const candidates = [];
  for (const id of tts) {
    const target = textTargetOf(api, id);
    const targetId = target ? target.id : id;
    candidates.push({
      id: targetId,
      tts_node: id,
      class_type: String(api[id].class_type || ''),
      text: target ? String((api[target.id].inputs || {})[target.field] || '').slice(0, 80) : '',
    });
  }
  const clone = tts.find((id) => refTargetOf(api, id)) || tts[0];
  const refTarget = refTargetOf(api, clone);
  if (!refTarget) {
    throw new TtsError('E_TTS_WORKFLOW_NODE', '工作流缺少 ref_audio（克隆节点必需）', '用 VoiceClone 节点，并把 LoadAudio 接到 ref_audio。');
  }
  const inputs = api[clone].inputs || {};
  if (inputs.x_vector_only === true) {
    throw new TtsError('E_TTS_WORKFLOW_NODE', '工作流 x_vector_only=true：只克隆说话人，参考文本失效', '把 x_vector_only 改成 false 再导入。');
  }
  const output = pickOutputNode(api);
  return {
    ttsIds: tts,
    cloneId: clone,
    candidates,
    textTargets: candidates,
    refTarget,
    outputNode: output.id,
    outputWarning: output.warning,
  };
}

function resolveTextTarget(api, wanted, inspect) {
  const wantedId = String(wanted || '').trim();
  if (wantedId) {
    const target = textTargetOf(api, wantedId);
    if (target) return target;
    throw new TtsError('E_TTS_WORKFLOW_NODE', '配置里的文本节点不在当前工作流里', '到设置里重新选一个文本节点。', {
      candidates: inspect.candidates,
    });
  }
  if (inspect.ttsIds.length === 1) {
    const target = textTargetOf(api, inspect.ttsIds[0]);
    if (target) return target;
  }
  if (inspect.candidates.length === 1) {
    const target = textTargetOf(api, inspect.candidates[0].id);
    if (target) return target;
  }
  throw new TtsError(
    'E_TTS_WORKFLOW_NODE',
    inspect.candidates.length ? '没能自动认出文本节点，请在设置里手选' : '工作流里没有可写入的文本输入',
    inspect.candidates.length ? '多个文本节点都可能是入口。' : '确认克隆节点有 target_text。',
    { candidates: inspect.candidates },
  );
}

/** 把目标文本、参考文本、参考音频文件名写入 API prompt；返回深拷贝。 */
export function applyCloneInputs(api, text, refVoice, refAudioName, textNode) {
  const clone = JSON.parse(JSON.stringify(api || {}));
  const inspect = inspectWorkflow(clone);
  const target = resolveTextTarget(clone, textNode, inspect);
  if (!clone[target.id] || !clone[target.id].inputs) throw new TtsError('E_TTS_WORKFLOW_NODE', '文本节点不存在', String(textNode || ''));
  clone[target.id].inputs[target.field] = String(text || '');

  const ttsInputs = clone[inspect.cloneId].inputs || {};
  if (typeof ttsInputs.ref_text === 'string') {
    ttsInputs.ref_text = String(refVoice.ref_text || '');
  } else if (isRef(ttsInputs.ref_text)) {
    const found = followString(clone, ttsInputs.ref_text, ['text', 'value', 'string', 'prompt']);
    if (found) clone[found.id].inputs[found.field] = String(refVoice.ref_text || '');
  }
  if (typeof ttsInputs.x_vector_only === 'boolean') ttsInputs.x_vector_only = false;

  const refNode = clone[inspect.refTarget.id];
  if (refNode && refNode.inputs) refNode.inputs[inspect.refTarget.field] = String(refAudioName || '');

  return { workflow: clone, textTarget: target, refTarget: inspect.refTarget, cloneId: inspect.cloneId };
}

/* ------------------------------ 工作流存取 ------------------------------ */

function defaultWorkflow() {
  const raw = readJson(TTS_DEFAULT_WORKFLOW_PATH, null);
  if (!raw) throw new TtsError('E_TTS_WORKFLOW', '内置克隆工作流缺失', '插件安装可能不完整，重新装一次。');
  const prepared = prepareWorkflow(raw);
  const inspect = inspectWorkflow(prepared.api);
  return { raw, prepared, inspect, name: 'qwen3-tts-clone', source: 'default', savedAt: '', warning: '' };
}

export function readWorkflowStore() {
  const stored = readJson(path.join(ROOT, 'comfy-tts-workflow.json'), null);
  if (stored && stored.workflow && typeof stored.workflow === 'object') {
    try {
      const prepared = prepareWorkflow(stored.workflow);
      const inspect = inspectWorkflow(prepared.api);
      return {
        raw: stored.workflow,
        prepared,
        inspect,
        name: String(stored.name || 'imported-workflow.json').slice(0, 80),
        source: 'imported',
        savedAt: String(stored.savedAt || ''),
        warning: '',
      };
    } catch (err) {
      const fallback = defaultWorkflow();
      fallback.warning = '导入的工作流无效，已回落到默认：' + String((err && err.message) || err);
      return fallback;
    }
  }
  return defaultWorkflow();
}

function readVoiceConfigTextNode() {
  const raw = readJson(path.join(ROOT, 'voice.json'), null);
  return raw && typeof raw === 'object' ? String(raw.textNode || '') : '';
}

export function workflowPayload() {
  const store = readWorkflowStore();
  const { inspect, prepared } = store;
  let textNode = '';
  let textError = '';
  try {
    textNode = resolveTextTarget(prepared.api, readVoiceConfigTextNode(), inspect).id;
  } catch (err) {
    textError = String((err && err.message) || err);
  }
  const warnings = [store.warning, inspect.outputWarning].filter(Boolean);
  if (textError) warnings.push(textError);
  return {
    name: store.name,
    source: store.source,
    format: prepared.format,
    nodes: Object.keys(prepared.api).length,
    textNode,
    outputNode: inspect.outputNode,
    refNode: inspect.refTarget.id,
    candidates: inspect.candidates,
    warnings,
    valid: !!textNode && !textError,
    error: textError,
  };
}

export function saveWorkflow(body) {
  const input = body && typeof body === 'object' ? body : {};
  const name = String(input.name || 'imported-workflow.json').slice(0, 80);
  if (input.reset === true) {
    try {
      fs.rmSync(path.join(ROOT, 'comfy-tts-workflow.json'), { force: true });
    } catch {
      /* 删不掉也不影响读默认 */
    }
    writeVoiceConfig({ textNode: '6' });
    return workflowPayload();
  }
  const prepared = prepareWorkflow(input.workflow);
  const inspect = inspectWorkflow(prepared.api);
  const textNode = String(input.textNode || '').trim();
  const target = resolveTextTarget(prepared.api, textNode || readVoiceConfigTextNode(), inspect);
  writeAtomic(
    path.join(ROOT, 'comfy-tts-workflow.json'),
    JSON.stringify({ name, format: prepared.format, savedAt: nowIso(), workflow: prepared.raw }, null, 2) + '\n',
  );
  writeVoiceConfig({ textNode: target.id });
  return workflowPayload();
}

/* ------------------------------ ComfyUI HTTP ------------------------------ */

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new TtsError('E_CANCELLED', '已取消', ''));
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TtsError('E_CANCELLED', '已取消', ''));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      controller.abort();
    } catch {
      /* 已结束 */
    }
  }, Math.max(1000, Number(timeoutMs) || ttsTimeoutMs()));
  const onAbort = () => {
    try {
      controller.abort();
    } catch {
      /* 已结束 */
    }
  };
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetchImpl(url, Object.assign({}, init || {}, { signal: controller.signal }));
  } catch (err) {
    if (signal && signal.aborted) throw new TtsError('E_CANCELLED', '已取消', '');
    if (timedOut || (err && err.name === 'AbortError')) throw new TtsError('E_TTS_TIMEOUT', 'ComfyUI 超过 ' + Math.round(timeoutMs / 1000) + ' 秒没有响应', '稍后重试。');
    throw new TtsError('E_TTS_CONNECT', '连不上 ComfyUI', '确认地址、端口与服务是否在运行。');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function formatComfyError(data) {
  if (!data || typeof data !== 'object') return '';
  const parts = [];
  if (typeof data.error === 'string') parts.push(data.error);
  if (data.error && typeof data.error === 'object' && data.error.message) parts.push(String(data.error.message));
  if (data.node_errors && typeof data.node_errors === 'object') {
    for (const id of Object.keys(data.node_errors)) {
      const item = data.node_errors[id];
      const list = item && Array.isArray(item.errors) ? item.errors : [];
      for (const error of list) parts.push(String((error && (error.message || error.type)) || '节点 ' + id + ' 出错'));
    }
  }
  return parts.filter(Boolean).join('；').slice(0, 400);
}

function classifyPromptError(text) {
  const detail = String(text || '');
  if (/ref_audio|ref_text|参考|voice_clone|clone/i.test(detail)) return 'E_TTS_VOICE_REF';
  if (/model|checkpoint|not found|does not exist|no such/i.test(detail)) return 'E_TTS_MODEL_MISSING';
  return 'E_TTS_WORKFLOW';
}

async function getObjectInfo(fetchImpl, base, signal) {
  try {
    const res = await fetchWithTimeout(fetchImpl, base + '/object_info', {}, TTS_PROBE_TIMEOUT_MS, signal);
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

function multipartBody(field, filename, buffer, extra) {
  const boundary = '----dsh' + crypto.randomBytes(12).toString('hex');
  const chunks = [];
  for (const [key, value] of Object.entries(extra || {})) {
    chunks.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + key + '"\r\n\r\n' + value + '\r\n'));
  }
  chunks.push(
    Buffer.from(
      '--' + boundary + '\r\nContent-Disposition: form-data; name="' + field + '"; filename="' + filename + '"\r\n' +
        'Content-Type: application/octet-stream\r\n\r\n',
    ),
  );
  chunks.push(buffer);
  chunks.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
  return { body: Buffer.concat(chunks), contentType: 'multipart/form-data; boundary=' + boundary };
}

const uploadedRefs = new Map();

/** 把参考音频上传到 ComfyUI input 目录，返回可写进 LoadAudio 的文件名。 */
async function ensureRefUploaded(fetchImpl, base, voice, signal) {
  const { buffer, sha256: digest, file } = refVoiceSha(voice);
  const baseName = path.basename(file).replace(/[^\w.-]+/g, '_');
  const cacheKey = base + '|' + digest;
  if (uploadedRefs.has(cacheKey)) return uploadedRefs.get(cacheKey);
  const uploadName = 'dsh-ref-' + digest.slice(0, 10) + '-' + baseName;
  const form = multipartBody('image', uploadName, buffer, { overwrite: 'true', type: 'input' });
  let res;
  try {
    res = await fetchWithTimeout(
      fetchImpl,
      base + '/upload/image',
      { method: 'POST', headers: { 'content-type': form.contentType }, body: form.body },
      60000,
      signal,
    );
  } catch (err) {
    if (err && err.code === 'E_CANCELLED') throw err;
    throw new TtsError('E_TTS_VOICE_REF', '参考音频上传失败：' + String((err && err.message) || err), '确认 ComfyUI 可写 input 目录。');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new TtsError('E_TTS_VOICE_REF', '参考音频上传失败（HTTP ' + res.status + '）', text.slice(0, 200));
  }
  const data = await res.json().catch(() => null);
  const name = String((data && data.name) || uploadName);
  const subfolder = String((data && data.subfolder) || '');
  const filename = subfolder ? subfolder + '/' + name : name;
  uploadedRefs.set(cacheKey, filename);
  return filename;
}

export async function probeComfyTts(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const fetchImpl = opts.fetchImpl || fetch;
  const signal = opts.signal;
  const config = readImageConfig();
  const base = baseUrlOf(config);
  const store = readWorkflowStore();
  const table = readRefTable();
  const inspect = store.inspect;
  const statsRes = await fetchWithTimeout(fetchImpl, base + '/system_stats', {}, TTS_PROBE_TIMEOUT_MS, signal);
  if (!statsRes.ok) throw new TtsError('E_TTS_CONNECT', 'ComfyUI 返回 HTTP ' + statsRes.status, '');
  const stats = await statsRes.json().catch(() => null);
  const version = String((stats && stats.system && (stats.system.comfyui_version || stats.system.version)) || '未知');
  const objectInfo = await getObjectInfo(fetchImpl, base, signal);
  const classes = Array.from(new Set(Object.keys(store.prepared.api).map((id) => String(store.prepared.api[id].class_type))));
  const missingNodes = [];
  if (objectInfo) for (const cls of classes) if (!objectInfo[cls]) missingNodes.push(cls);
  const warnings = [store.warning, inspect.outputWarning].filter(Boolean);
  let refVoice;
  const wantedRef = String(opts.comfyRefVoice || readVoiceConfig().comfyRefVoice || '').trim();
  try {
    refVoice = resolveRefVoice(table, wantedRef);
  } catch (err) {
    // 选中项不在表内（或表外 id）时回落默认；只告警，不改写 voice.json。
    refVoice = resolveRefVoice(table, '');
    warnings.push('参考 voice 未选中：' + String((err && err.message) || err));
  }
  let refFile = '';
  try {
    refFile = refVoiceFile(refVoice).file;
  } catch (err) {
    warnings.push(String((err && err.message) || err));
  }
  const durationNotice = refDurationNotice(refVoice);
  if (durationNotice.level === 'warn') warnings.push(durationNotice.text);
  if (!objectInfo) warnings.push('没能读取 /object_info，节点/模型未校验。');
  return {
    ok: true,
    baseUrl: base,
    version,
    workflow: {
      name: store.name,
      source: store.source,
      format: store.prepared.format,
      textNode: inspect.candidates[0] ? inspect.candidates[0].id : '',
      outputNode: inspect.outputNode,
      refNode: inspect.refTarget.id,
    },
    refVoice: refVoiceSummary(refVoice),
    refVoiceFile: refFile,
    missing: { nodes: missingNodes, models: [] },
    warnings,
  };
}

function audioOutputOf(outputs) {
  if (!outputs || typeof outputs !== 'object') return null;
  for (const id of Object.keys(outputs)) {
    const out = outputs[id];
    if (!out || typeof out !== 'object') continue;
    const list = Array.isArray(out.audio) ? out.audio : Array.isArray(out.audios) ? out.audios : [];
    for (const item of list) {
      if (!item || !item.filename) continue;
      const ext = audioExtOf(item.filename);
      if (!ext) continue;
      return { filename: String(item.filename), subfolder: String(item.subfolder || ''), type: String(item.type || 'output'), ext };
    }
  }
  return null;
}

function executionErrorText(status) {
  const messages = Array.isArray(status && status.messages) ? status.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const item = messages[i];
    if (Array.isArray(item) && item[0] === 'execution_error' && item[1]) {
      const info = item[1];
      return [info.node_type, info.exception_message, info.exception_type].filter(Boolean).join(' · ').slice(0, 400);
    }
  }
  return '执行失败（ComfyUI 没有给出原因）';
}

async function submitAndWait(options) {
  const opts = options || {};
  const fetchImpl = opts.fetchImpl || fetch;
  const signal = opts.signal;
  const base = String(opts.baseUrl || '').trim() || baseUrlOf(readImageConfig());
  const prepared = opts.prepared;
  const refVoice = opts.refVoice;
  const text = String(opts.text || '');
  const uploaded = await ensureRefUploaded(fetchImpl, base, refVoice, signal);
  const applied = applyCloneInputs(prepared.api, text, refVoice, uploaded, opts.textNode);
  const submit = await fetchWithTimeout(
    fetchImpl,
    base + '/prompt',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: applied.workflow, client_id: 'dsh-book-slides-tts' }) },
    30000,
    signal,
  );
  const submitText = await submit.text().catch(() => '');
  let submitData = null;
  try {
    submitData = JSON.parse(submitText);
  } catch {
    submitData = null;
  }
  if (!submit.ok) {
    const detail = formatComfyError(submitData) || submitText.slice(0, 300) || 'HTTP ' + submit.status;
    const code = submit.status >= 500 ? 'E_TTS_FAIL' : classifyPromptError(detail);
    throw new TtsError(code, 'ComfyUI 拒绝了配音任务：' + detail, '检查工作流与参考音频。');
  }
  const promptId = String((submitData && submitData.prompt_id) || '');
  if (!promptId) throw new TtsError('E_TTS_BAD_RESPONSE', 'ComfyUI 没有返回 prompt_id', '');

  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || ttsTimeoutMs());
  const deadline = Date.now() + timeoutMs;
  let entry = null;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new TtsError('E_CANCELLED', '已取消', '');
    await sleep(1000, signal);
    const history = await fetchWithTimeout(fetchImpl, base + '/history/' + encodeURIComponent(promptId), {}, 15000, signal);
    if (!history.ok) continue;
    const data = await history.json().catch(() => null);
    entry = data && data[promptId] ? data[promptId] : null;
    if (!entry) continue;
    const status = entry.status || {};
    if (status.status_str === 'error') throw new TtsError(classifyPromptError(executionErrorText(status)), 'ComfyUI 配音执行出错：' + executionErrorText(status), '检查工作流与参考音频。');
    if (entry.outputs && Object.keys(entry.outputs).length) break;
    if (status.completed) throw new TtsError('E_TTS_BAD_RESPONSE', 'ComfyUI 跑完了但没有音频输出', '');
    entry = null;
  }
  if (!entry) throw new TtsError('E_TTS_TIMEOUT', '等 ComfyUI 配音超时（' + Math.round(timeoutMs / 1000) + ' 秒）', '稍后补配音。');

  const audio = audioOutputOf(entry.outputs);
  if (!audio) throw new TtsError('E_TTS_BAD_RESPONSE', '工作流没有输出音频', '确认末尾是 SaveAudio/PreviewAudio。');
  const params = new URLSearchParams({ filename: audio.filename, subfolder: audio.subfolder, type: audio.type });
  const download = await fetchWithTimeout(fetchImpl, base + '/view?' + params.toString(), {}, 60000, signal);
  if (!download.ok) throw new TtsError('E_TTS_BAD_RESPONSE', '下载音频失败（HTTP ' + download.status + '）', '');
  const buffer = Buffer.from(await download.arrayBuffer());
  if (!buffer.length) throw new TtsError('E_TTS_BAD_RESPONSE', 'ComfyUI 返回了空音频', '');
  if (buffer.length > TTS_MAX_AUDIO_BYTES) throw new TtsError('E_TTS_BAD_RESPONSE', '音频文件超过 32MB', '');
  return {
    buffer,
    ext: audio.ext,
    contentType: AUDIO_CONTENT_TYPES[audio.ext] || 'application/octet-stream',
    filename: audio.filename,
    promptId,
    audioMs: audio.ext === 'wav' ? wavDurationMs(buffer) || estimateAudioMs(text, 1) : estimateAudioMs(text, 1),
    model: modelLabelOf(prepared.api),
    voice: refVoice.id,
    voiceLabel: refVoice.label || refVoice.name || '',
  };
}

function modelLabelOf(api) {
  for (const id of Object.keys(api || {})) {
    const value = api[id] && api[id].inputs && api[id].inputs.model_choice;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export async function testComfyTts(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const text = String(opts.text || '').slice(0, 200) || TTS_TEST_TEXT;
  const table = readRefTable();
  const store = readWorkflowStore();
  const refVoice = resolveRefVoice(table, opts.refVoice || readVoiceConfig().comfyRefVoice);
  const result = await runComfyExclusive(
    () =>
      submitAndWait({
        prepared: store.prepared,
        text,
        refVoice,
        textNode: readVoiceConfigTextNode() || (store.inspect.candidates[0] || {}).id,
        baseUrl: opts.baseUrl,
        fetchImpl: opts.fetchImpl,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
      }),
    { signal: opts.signal, maxWaitMs: Number(opts.maxWaitMs) || TTS_QUEUE_WAIT_MS },
  );
  return Object.assign({}, result, { voiceLabel: refVoice.label || refVoice.name || '' });
}

export async function probeComfySpeech(text, options) {
  const opts = options && typeof options === 'object' ? options : {};
  let probe;
  try {
    probe = await probeComfyTts({ fetchImpl: opts.fetchImpl, signal: opts.signal });
  } catch (err) {
    if (err instanceof TtsError) return { ok: false, code: err.code, error: err.message, hint: err.hint };
    return { ok: false, code: 'E_TTS_FAIL', error: String((err && err.message) || err), hint: '' };
  }
  try {
    const result = await testComfyTts({
      text,
      fetchImpl: opts.fetchImpl,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      maxWaitMs: opts.maxWaitMs,
      baseUrl: probe.baseUrl,
      refVoice: opts.refVoice || opts.comfyRefVoice,
    });
    return {
      ok: true,
      mode: 'comfyui',
      provider: 'comfyui-tts',
      model: result.model,
      voice: result.voice,
      voiceLabel: result.voiceLabel || '',
      audio: result.buffer,
      contentType: result.contentType,
      audio_ms: result.audioMs,
      note: 'ComfyUI 克隆试听；不落盘、不缓存。',
    };
  } catch (err) {
    if (err instanceof TtsError) return { ok: false, code: err.code, error: err.message, hint: err.hint };
    return { ok: false, code: 'E_TTS_FAIL', error: String((err && err.message) || err), hint: '' };
  }
}

/* ------------------------------ 缓存与逐页配音 ------------------------------ */

function audioCacheKey(ctx, text) {
  return sha256([
    'comfyui-tts-clone',
    ctx.workflowHash,
    ctx.textNode,
    ctx.refVoice.id,
    ctx.refAudioSha256,
    sha256(ctx.refVoice.ref_text || ''),
    ctx.model,
    text,
  ].join('|'));
}

function readAudioCache(cacheDir, key) {
  for (const ext of AUDIO_EXTS) {
    const file = path.join(cacheDir, key + '.' + ext);
    try {
      const buffer = fs.readFileSync(file);
      if (buffer.length > 0) return { buffer, ext };
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

function writeBinary(file, buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, buffer);
}

function writeAudioCache(cacheDir, key, buffer, ext) {
  try {
    writeBinary(path.join(cacheDir, key + '.' + ext), buffer);
  } catch {
    /* 缓存写不进去不影响本次配音 */
  }
}

function retryable(code) {
  return code === 'E_TTS_CONNECT' || code === 'E_TTS_TIMEOUT' || code === 'E_TTS_BAD_RESPONSE' || code === 'E_TTS_NETWORK';
}

async function generateWithRetry(ctx, text, options) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await submitAndWait({
        prepared: ctx.prepared,
        refVoice: ctx.refVoice,
        text,
        textNode: ctx.textNode,
        baseUrl: ctx.baseUrl,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
      });
    } catch (err) {
      last = err;
      if (!err || err.code === 'E_CANCELLED' || !retryable(err.code)) break;
      if (attempt === 0) await sleep(800, options.signal);
    }
  }
  throw last || new TtsError('E_TTS_FAIL', 'ComfyUI 配音失败', '');
}

export async function synthesizeComfyVoicing(slides, ctx, options) {
  const opts = options && typeof options === 'object' ? options : {};
  if (!opts.moduleDir) throw new TtsError('E_TTS_FAIL', '缺少讲目录，无法保存 ComfyUI 音频', '');
  const cacheDir = opts.cacheDir || path.join(ROOT, 'audio-cache');
  const audioDir = path.join(opts.moduleDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = slides.map((slide) => Object.assign({}, slide));
  const errors = [];
  let completed = 0;
  for (let index = 0; index < out.length; index += 1) {
    if (opts.signal && opts.signal.aborted) throw new TtsError('E_CANCELLED', '已取消', '');
    const slide = out[index];
    const text = String(slide.audio_script || '').trim();
    try {
      if (!text) throw new TtsError('E_TTS_FAIL', '这一页没有朗读稿', '');
      const key = audioCacheKey(ctx, text);
      const cached = opts.ignoreCache ? null : readAudioCache(cacheDir, key);
      let result = null;
      if (cached) {
        result = { buffer: cached.buffer, ext: cached.ext, audioMs: cached.ext === 'wav' ? wavDurationMs(cached.buffer) || estimateAudioMs(text, 1) : estimateAudioMs(text, 1) };
      } else {
        result = await runComfyExclusive(() => generateWithRetry(ctx, text, opts), { signal: opts.signal });
        writeAudioCache(cacheDir, key, result.buffer, result.ext);
      }
      if (opts.signal && opts.signal.aborted) throw new TtsError('E_CANCELLED', '已取消', '');
      const fileName = String(slide.slide_index).padStart(3, '0') + '.' + result.ext;
      writeBinary(path.join(audioDir, fileName), result.buffer);
      slide.audio_file = 'audio/' + fileName;
      slide.audio_provider = 'comfyui-tts';
      slide.audio_ms = result.audioMs || estimateAudioMs(text, 1);
    } catch (err) {
      if (err && err.code === 'E_CANCELLED') throw err;
      slide.audio_file = null;
      slide.audio_provider = 'none';
      errors.push({ slide_index: slide.slide_index, code: (err && err.code) || 'E_TTS_FAIL', message: String((err && err.message) || err).slice(0, 200) });
    }
    completed += 1;
    if (typeof opts.onProgress === 'function') opts.onProgress(completed, out.length);
  }
  return {
    provider: 'comfyui-tts',
    mode: 'file',
    model: ctx.model,
    voice: ctx.refVoice.id,
    degraded: errors.length > 0,
    code: errors.length ? errors[0].code || 'E_TTS_FAIL' : null,
    message: errors.length ? '有 ' + errors.length + ' 页配音失败；' + errors[0].code + '：' + errors[0].message : '',
    errors,
    slides: out,
  };
}

export async function prepareComfyVoice(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const probe = await probeComfyTts({ fetchImpl: opts.fetchImpl, signal: opts.signal });
  const table = readRefTable();
  const store = readWorkflowStore();
  const refVoice = resolveRefVoice(table, opts.refVoice || readVoiceConfig().comfyRefVoice);
  const audio = refVoiceSha(refVoice);
  return {
    prepared: store.prepared,
    table,
    refVoice,
    refAudioSha256: audio.sha256,
    textNode: readVoiceConfigTextNode() || (store.inspect.candidates[0] || {}).id,
    workflowHash: workflowHashOf(store.raw),
    model: modelLabelOf(store.prepared.api),
    baseUrl: probe.baseUrl,
    probe,
  };
}

export { ROOT };
