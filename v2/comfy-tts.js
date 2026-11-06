/**
 * 2.0 本地 ComfyUI Qwen3-TTS 配音（FR-23.1 / AC-148 ~ AC-155）。
 *
 * 边界：
 *   - ComfyUI 地址与配图共用 image.json.host/port；
 *   - 工作流与音色表都是本地配置，不入书档、不写进 slides/series；
 *   - 换音色只改请求里的 speaker，绝不重写工作流文件；
 *   - 工作流/音色表导入只做本地校验，不要求 ComfyUI 在线；
 *   - 配音与配图共用全局串行队列（comfy-queue.js），取消不调用 /interrupt。
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

export const TTS_WORKFLOW_FILE = path.join(ROOT, 'comfy-tts-workflow.json');
export const TTS_VOICES_FILE = path.join(ROOT, 'comfy-tts-voices.json');
export const TTS_DEFAULT_WORKFLOW_PATH = fileURLToPath(new URL('../workflows/qwen3-tts.json', import.meta.url));
export const TTS_DEFAULT_VOICES_PATH = fileURLToPath(new URL('../workflows/qwen3-tts-voices.json', import.meta.url));

export const TTS_DEFAULT_VOICE = 'Vivian';
export const TTS_DEFAULT_TABLE_NAME = 'Qwen3-TTS-CustomVoice 默认音色表';
export const TTS_DEFAULT_MODEL = 'Qwen3-TTS-CustomVoice';
export const TTS_TIMEOUT_MS = 180000;
export const TTS_PROBE_TIMEOUT_MS = 10000;
export const TTS_QUEUE_WAIT_MS = 10000;
export const TTS_MAX_AUDIO_BYTES = 32 * 1024 * 1024;
export const TTS_WORKFLOW_MAX_BYTES = 1024 * 1024;
export const TTS_WORKFLOW_MAX_NODES = 2000;
export const TTS_VOICE_TABLE_MAX_BYTES = 256 * 1024;
export const TTS_VOICE_TABLE_MAX_SPEAKERS = 200;
export const AUDIO_EXTS = ['wav', 'flac', 'mp3', 'ogg'];
export const AUDIO_CONTENT_TYPES = {
  wav: 'audio/wav',
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
};
export const TTS_TEST_TEXT = '你好，这是一段试听，用来确认 ComfyUI 的 Qwen3-TTS 能出声。';

const DEFAULT_SPEAKERS = [
  { name: 'Vivian', style: '明亮、略带个性的年轻女声', lang: '中文', default: true },
  { name: 'Serena', style: '温暖、柔和的年轻女声', lang: '中文' },
  { name: 'Uncle_fu', label: 'Uncle Fu', style: '低沉、醇厚的成熟男声', lang: '中文' },
  { name: 'Dylan', style: '充满活力的北京年轻男声', lang: '中文（北京）' },
  { name: 'Eric', style: '活泼的成都男声', lang: '中文（四川）' },
  { name: 'Ryan', style: '富有节奏感和动态的男声', lang: '英文' },
  { name: 'Aiden', style: '阳光、中音清晰的美国男声', lang: '英文' },
  { name: 'Ono_anna', label: 'Ono Anna', style: '活泼的日本女声', lang: '日文' },
  { name: 'Sohee', style: '温暖、富有情感的韩国女声', lang: '韩文' },
];

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
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

/* ------------------------------ 音色表 ------------------------------ */

function normalizeSpeakerEntry(raw) {
  if (typeof raw === 'string') {
    const name = raw.trim().slice(0, 64);
    return name ? { name: name } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name == null ? '' : raw.name).trim().slice(0, 64);
  if (!name) return null;
  const entry = { name: name };
  const label = String(raw.label == null ? '' : raw.label).trim().slice(0, 64);
  const style = String(raw.style == null ? '' : raw.style).trim().slice(0, 80);
  const lang = String(raw.lang == null ? '' : raw.lang).trim().slice(0, 16);
  if (label && label !== name) entry.label = label;
  if (style) entry.style = style;
  if (lang) entry.lang = lang;
  if (raw.default === true) entry.default = true;
  return entry;
}

export function normalizeVoiceTable(raw, meta) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const list = Array.isArray(raw) ? raw : Array.isArray(source.speakers) ? source.speakers : null;
  if (!list) throw new TtsError('E_TTS_VOICE_TABLE', '音色表缺少 speakers 数组', '提供 {speakers:[...]} 或纯音色名数组。');
  if (list.length < 1) throw new TtsError('E_TTS_VOICE_TABLE', '音色表至少要有 1 个音色', '');
  if (list.length > TTS_VOICE_TABLE_MAX_SPEAKERS) {
    throw new TtsError('E_TTS_VOICE_TABLE', '音色表最多 ' + TTS_VOICE_TABLE_MAX_SPEAKERS + ' 个音色', '当前 ' + list.length + ' 个。');
  }
  const speakers = [];
  const seen = new Set();
  let defaultCount = 0;
  for (const item of list) {
    const entry = normalizeSpeakerEntry(item);
    if (!entry) continue;
    if (seen.has(entry.name)) throw new TtsError('E_TTS_VOICE_TABLE', '音色名重复：' + entry.name, '每个 name 必须唯一。');
    seen.add(entry.name);
    if (entry.default) defaultCount += 1;
    speakers.push(entry);
  }
  if (!speakers.length) throw new TtsError('E_TTS_VOICE_TABLE', '音色表里没有有效音色', '每个条目至少要有 name。');
  if (defaultCount > 1) throw new TtsError('E_TTS_VOICE_TABLE', '音色表最多只能有一个默认音色', '只给一个条目加 default:true。');
  const opts = meta && typeof meta === 'object' ? meta : {};
  const defaultEntry = speakers.find((item) => item.default) || speakers[0];
  return {
    version: 1,
    name: String(opts.name || source.name || '导入的音色表').trim().slice(0, 80) || '导入的音色表',
    model: String(opts.model || source.model || '').trim().slice(0, 80),
    source: opts.source === 'default' ? 'default' : 'imported',
    savedAt: String(opts.savedAt || source.savedAt || ''),
    speakers: speakers,
    defaultVoice: defaultEntry.name,
  };
}

export function defaultVoiceTable() {
  const raw = readJson(TTS_DEFAULT_VOICES_PATH, null);
  if (raw) {
    try {
      return normalizeVoiceTable(raw, { source: 'default', name: TTS_DEFAULT_TABLE_NAME, model: TTS_DEFAULT_MODEL });
    } catch {
      /* 包内表坏了也回落到内置常量 */
    }
  }
  return normalizeVoiceTable(
    { version: 1, name: TTS_DEFAULT_TABLE_NAME, model: TTS_DEFAULT_MODEL, speakers: DEFAULT_SPEAKERS },
    { source: 'default', name: TTS_DEFAULT_TABLE_NAME, model: TTS_DEFAULT_MODEL },
  );
}

/** 读当前音色表；文件坏了回落到默认表并带 warning，不让设置页打不开。 */
export function readVoiceTable() {
  const stored = readJson(TTS_VOICES_FILE, null);
  if (!stored) return defaultVoiceTable();
  try {
    return normalizeVoiceTable(stored, {
      source: 'imported',
      name: stored.name,
      model: stored.model,
      savedAt: stored.savedAt,
    });
  } catch (err) {
    const fallback = defaultVoiceTable();
    fallback.warning = '音色表文件损坏，已回落到默认表：' + String((err && err.message) || err);
    return fallback;
  }
}

export function saveVoiceTable(body) {
  const input = body && typeof body === 'object' ? body : {};
  if (input.reset === true) {
    try {
      fs.rmSync(TTS_VOICES_FILE, { force: true });
    } catch {
      /* 删不掉也不影响读默认值 */
    }
    return voiceTablePayload();
  }
  const raw = input.table && typeof input.table === 'object' ? input.table : input.table || input;
  if (bytesOfJson(raw) > TTS_VOICE_TABLE_MAX_BYTES) {
    throw new TtsError('E_TTS_VOICE_TABLE', '音色表超过 ' + Math.round(TTS_VOICE_TABLE_MAX_BYTES / 1024) + ' KB', '删掉多余条目后重试。');
  }
  const table = normalizeVoiceTable(raw, {
    source: 'imported',
    name: input.name || (raw && raw.name),
    model: raw && raw.model,
    savedAt: nowIso(),
  });
  writeAtomic(
    TTS_VOICES_FILE,
    JSON.stringify(
      { version: 1, name: table.name, model: table.model, source: 'imported', savedAt: table.savedAt, speakers: table.speakers },
      null,
      2,
    ) + '\n',
  );
  // 把旧的 Uncle_Fu 迁移成新表的 Uncle Fu，避免面板继续显示旧下划线名
  try {
    const current = readVoiceConfig();
    const matched = matchSpeakerName(table, current.comfyVoice);
    if (matched && matched !== current.comfyVoice) writeVoiceConfig({ comfyVoice: matched });
  } catch {
    /* 配置迁移失败不影响表导入 */
  }
  return voiceTablePayload();
}

export function voiceTablePayload() {
  const table = readVoiceTable();
  return {
    name: table.name,
    model: table.model,
    source: table.source,
    count: table.speakers.length,
    defaultVoice: table.defaultVoice,
    speakers: table.speakers,
    warning: table.warning || '',
  };
}

export function matchSpeakerName(table, wanted) {
  const names = table && Array.isArray(table.speakers) ? table.speakers.map((item) => item.name) : [];
  const exact = String(wanted == null ? '' : wanted).trim();
  if (names.includes(exact)) return exact;
  const wantedCanonical = canonicalSpeaker(exact);
  if (!wantedCanonical) return '';
  return names.find((name) => canonicalSpeaker(name) === wantedCanonical) || '';
}

export function resolveSpeaker(table, wanted, modelSpeakers) {
  const names = table.speakers.map((item) => item.name);
  const modelNameOf = (name) => {
    if (!Array.isArray(modelSpeakers) || !modelSpeakers.length) return '';
    const wantedCanonical = canonicalSpeaker(name);
    return modelSpeakers.find((item) => canonicalSpeaker(item) === wantedCanonical) || '';
  };
  const supported = (name) => speakerSupported(modelSpeakers, name);
  let name = matchSpeakerName(table, wanted) || table.defaultVoice;
  if (!names.includes(name)) name = names[0];
  const exact = modelNameOf(name);
  if (exact) return exact;
  if (supported(name)) return name;
  const first = names.find((item) => supported(item));
  if (first) return modelNameOf(first) || first;
  throw new TtsError('E_TTS_SPEAKER', '音色表与当前模型不一致：表内没有模型支持的音色', '导入与当前模型匹配的音色表后再试。');
}

/** 音色名比对口径：忽略大小写、空格/下划线/连字符，避免 Uncle_Fu vs Uncle Fu 被误判为不支持。 */
export function canonicalSpeaker(name) {
  return String(name == null ? '' : name)
    .trim()
    .toLowerCase()
    .replace(/[\s_\-]+/g, '_');
}

export function speakerSupported(modelSpeakers, name) {
  if (!Array.isArray(modelSpeakers) || !modelSpeakers.length) return true;
  const wanted = canonicalSpeaker(name);
  return modelSpeakers.some((item) => canonicalSpeaker(item) === wanted);
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

/** UI 格式 → API prompt：widgets_values_named 当 inputs，links 当引用。 */
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
    const mode = Number(node.mode == null ? 0 : node.mode);
    if (mode !== 0) continue;
    const id = String(node.id);
    if (!node.widgets_values_named || typeof node.widgets_values_named !== 'object') {
      throw new TtsError(
        'E_TTS_WORKFLOW',
        '界面格式工作流缺少 widgets_values_named，无法安全转成 API 格式',
        '用 ComfyUI「保存（API 格式）」重新导出。',
      );
    }
    if (!node.type) throw new TtsError('E_TTS_WORKFLOW', '工作流节点 ' + id + ' 缺少 type', '用「保存（API 格式）」重新导出。');
    const inputs = {};
    for (const key of Object.keys(node.widgets_values_named)) {
      if (key === 'control_after_generate') continue;
      inputs[key] = node.widgets_values_named[key];
    }
    for (const input of Array.isArray(node.inputs) ? node.inputs : []) {
      if (!input || input.link == null) continue;
      const link = linkMap.get(Number(input.link));
      if (!link) throw new TtsError('E_TTS_WORKFLOW', '工作流链接 ' + input.link + ' 不存在', '重新导出工作流。');
      inputs[input.name] = [String(link[1]), Number(link[2])];
    }
    api[id] = { class_type: String(node.type), inputs: inputs };
  }
  return api;
}

function validateApiWorkflow(raw) {
  const ids = Object.keys(raw || {});
  if (ids.length < 2) throw new TtsError('E_TTS_WORKFLOW', '工作流节点太少（' + ids.length + ' 个）', '确认导出的是 API 格式。');
  if (ids.length > TTS_WORKFLOW_MAX_NODES) {
    throw new TtsError('E_TTS_WORKFLOW', '工作流节点太多（' + ids.length + ' 个）', '最多 ' + TTS_WORKFLOW_MAX_NODES + ' 个。');
  }
  for (const id of ids) {
    const node = raw[id];
    if (!node || typeof node !== 'object' || typeof node.class_type !== 'string') {
      throw new TtsError('E_TTS_WORKFLOW', '工作流节点 ' + id + ' 缺 class_type', '用「保存（API 格式）」重新导出。');
    }
    if (!node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) {
      throw new TtsError('E_TTS_WORKFLOW', '工作流节点 ' + id + ' 缺 inputs', '用「保存（API 格式）」重新导出。');
    }
  }
  for (const id of ids) {
    const inputs = raw[id].inputs || {};
    for (const key of Object.keys(inputs)) {
      const value = inputs[key];
      if (!isRef(value)) continue;
      const target = String(value[0]);
      if (!raw[target]) throw new TtsError('E_TTS_WORKFLOW', '工作流节点 ' + id + '.' + key + ' 引用了不存在的节点 ' + target, '重新导出工作流。');
    }
  }
  return raw;
}

export function prepareWorkflow(raw) {
  if (bytesOfJson(raw) > TTS_WORKFLOW_MAX_BYTES) {
    throw new TtsError('E_TTS_WORKFLOW', '工作流超过 1 MB', '删掉多余节点或重新导出。');
  }
  const format = workflowFormat(raw);
  if (!format) throw new TtsError('E_TTS_WORKFLOW', '工作流必须是 JSON 对象', '用「保存（API 格式）」导出。');
  let api;
  try {
    api = format === 'ui' ? convertUiWorkflow(raw) : validateApiWorkflow(raw);
  } catch (err) {
    if (err instanceof TtsError) throw err;
    throw new TtsError('E_TTS_WORKFLOW', '工作流解析失败：' + String((err && err.message) || err), '重新导出工作流。');
  }
  return { format: format, raw: raw, api: api };
}

export function workflowHashOf(raw) {
  return sha256(JSON.stringify(raw || {}));
}

function stringFieldOf(node) {
  const inputs = node && node.inputs && typeof node.inputs === 'object' ? node.inputs : null;
  if (!inputs) return '';
  for (const key of ['text', 'value', 'string', 'prompt']) {
    if (typeof inputs[key] === 'string') return key;
  }
  return '';
}

/** 沿引用向上游找真正保存字符串的节点/字段。 */
function followString(api, ref, seen) {
  if (!isRef(ref)) return null;
  const id = String(ref[0]);
  const node = api[id];
  if (!node) return null;
  const field = stringFieldOf(node);
  if (field) return { id: id, field: field };
  const visited = seen || new Set();
  if (visited.has(id)) return null;
  visited.add(id);
  const inputs = node.inputs || {};
  for (const key of Object.keys(inputs)) {
    if (isRef(inputs[key])) {
      const found = followString(api, inputs[key], visited);
      if (found) return found;
    }
  }
  return null;
}

function textTargetOf(api, id) {
  const node = api[id];
  if (!node) return null;
  const inputs = node.inputs || {};
  if (typeof inputs.text === 'string') return { id: id, field: 'text' };
  if (isRef(inputs.text)) return followString(api, inputs.text);
  const field = stringFieldOf(node);
  if (field) return { id: id, field: field };
  return null;
}

function ttsNodeIds(api) {
  return Object.keys(api || {}).filter((id) => {
    const cls = String((api[id] && api[id].class_type) || '');
    return /qwen3tts/i.test(cls) || (/tts/i.test(cls) && api[id].inputs && (typeof api[id].inputs.text === 'string' || isRef(api[id].inputs.text)));
  });
}

function outputNodeIds(api) {
  const ids = Object.keys(api || {});
  const save = ids.filter((id) => /SaveAudio/i.test(String(api[id].class_type || '')));
  const preview = ids.filter((id) => /PreviewAudio/i.test(String(api[id].class_type || '')));
  const audio = ids.filter((id) => /audio/i.test(String(api[id].class_type || '')));
  return Array.from(new Set(save.concat(preview, audio)));
}

function pickOutputNode(api) {
  const ids = Object.keys(api || {});
  const preferred = ids.find((id) => /SaveAudio/i.test(String(api[id].class_type || '')));
  if (preferred) return { id: preferred, warning: '' };
  const preview = ids.find((id) => /PreviewAudio/i.test(String(api[id].class_type || '')));
  if (preview) return { id: preview, warning: '' };
  const anyAudio = ids.find((id) => /audio/i.test(String(api[id].class_type || '')));
  if (anyAudio) return { id: anyAudio, warning: '工作流没有 SaveAudio/PreviewAudio，使用 ' + anyAudio + ' 作为音频输出。' };
  throw new TtsError('E_TTS_WORKFLOW', '工作流里找不到音频输出节点', '末尾加 SaveAudio 或 PreviewAudio。');
}

function inspectWorkflow(api) {
  const tts = ttsNodeIds(api);
  if (!tts.length) throw new TtsError('E_TTS_WORKFLOW', '工作流里找不到 Qwen3-TTS 节点', '确认工作流含 Qwen3TTS 节点。');
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
  const output = pickOutputNode(api);
  return { ttsIds: tts, candidates: candidates, outputNode: output.id, outputWarning: output.warning };
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
    inspect.candidates.length ? '多个文本节点都可能是入口。' : '确认 Qwen3TTS 节点有 text 输入。',
    { candidates: inspect.candidates },
  );
}

function ttsNodeForTarget(api, inspect, textTarget) {
  if (inspect.ttsIds.includes(textTarget.id)) return textTarget.id;
  for (const id of inspect.ttsIds) {
    const inputs = api[id].inputs || {};
    if (isRef(inputs.text)) {
      const resolved = followString(api, inputs.text);
      if (resolved && resolved.id === textTarget.id) return id;
    }
  }
  return inspect.ttsIds[0];
}

function applySpeaker(api, inspect, speaker) {
  const ttsId = inspect.ttsIds[0];
  const node = api[ttsId];
  const inputs = node && node.inputs ? node.inputs : {};
  const value = String(speaker || '').trim();
  if (!value) return '';
  let applied = '';
  if (typeof inputs.speaker === 'string') {
    inputs.speaker = value;
    applied = 'speaker';
  } else if (isRef(inputs.speaker)) {
    const target = followString(api, inputs.speaker);
    if (target) {
      api[target.id].inputs[target.field] = value;
      applied = target.id + '.' + target.field;
    }
  }
  if (applied) {
    // 该节点优先使用 custom_speaker_name；不清空会覆盖 speaker，导致换音色无效。
    if (typeof inputs.custom_speaker_name === 'string') {
      inputs.custom_speaker_name = '';
    } else if (isRef(inputs.custom_speaker_name)) {
      const target = followString(api, inputs.custom_speaker_name);
      if (target) api[target.id].inputs[target.field] = '';
    }
  }
  return applied;
}

/** 把文本与音色写入 API prompt；返回深拷贝，不改原工作流。 */
export function applyTtsInputs(api, text, speaker, textNode) {
  const clone = JSON.parse(JSON.stringify(api || {}));
  const inspect = inspectWorkflow(clone);
  const target = resolveTextTarget(clone, textNode, inspect);
  if (!clone[target.id] || !clone[target.id].inputs) {
    throw new TtsError('E_TTS_WORKFLOW_NODE', '文本节点不存在', String(textNode || ''));
  }
  clone[target.id].inputs[target.field] = String(text || '');
  const speakerField = applySpeaker(clone, Object.assign({}, inspect, { ttsIds: [ttsNodeForTarget(clone, inspect, target)] }), speaker);
  return { workflow: clone, textTarget: target, speakerField: speakerField };
}

/* ------------------------------ 工作流存取 ------------------------------ */

function defaultWorkflow() {
  const raw = readJson(TTS_DEFAULT_WORKFLOW_PATH, null);
  if (!raw) throw new TtsError('E_TTS_WORKFLOW', '内置默认配音工作流缺失', '插件安装可能不完整，重新装一次。');
  const prepared = prepareWorkflow(raw);
  const inspect = inspectWorkflow(prepared.api);
  return { raw: raw, prepared: prepared, inspect: inspect, name: 'qwen3-tts', source: 'default', savedAt: '', warning: '' };
}

export function readWorkflowStore() {
  const stored = readJson(TTS_WORKFLOW_FILE, null);
  if (stored && stored.workflow && typeof stored.workflow === 'object') {
    try {
      const prepared = prepareWorkflow(stored.workflow);
      const inspect = inspectWorkflow(prepared.api);
      return {
        raw: stored.workflow,
        prepared: prepared,
        inspect: inspect,
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
    textNode: textNode,
    outputNode: inspect.outputNode,
    candidates: inspect.candidates,
    warnings: warnings,
    valid: !!textNode && !textError,
    error: textError,
  };
}

function readVoiceConfigTextNode() {
  const raw = readJson(path.join(ROOT, 'voice.json'), null);
  return raw && typeof raw === 'object' ? String(raw.textNode || '') : '';
}

export function saveWorkflow(body) {
  const input = body && typeof body === 'object' ? body : {};
  const name = String(input.name || 'imported-workflow.json').slice(0, 80);
  if (input.reset === true) {
    try {
      fs.rmSync(TTS_WORKFLOW_FILE, { force: true });
    } catch {
      /* 删不掉也不影响读默认值 */
    }
    writeVoiceConfig({ textNode: '1' });
    return workflowPayload();
  }
  const prepared = prepareWorkflow(input.workflow);
  const inspect = inspectWorkflow(prepared.api);
  const textNode = String(input.textNode || '').trim();
  // 导入时必须能确定文本入口；多个候选时要求调用方手选
  const target = resolveTextTarget(prepared.api, textNode || readVoiceConfigTextNode(), inspect);
  writeAtomic(
    TTS_WORKFLOW_FILE,
    JSON.stringify({ name: name, format: prepared.format, savedAt: nowIso(), workflow: prepared.raw }, null, 2) + '\n',
  );
  writeVoiceConfig({ textNode: target.id });
  return workflowPayload();
}

/* ------------------------------ ComfyUI HTTP ------------------------------ */

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new TtsError('E_CANCELLED', '已取消', ''));
      return;
    }
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
  }, Math.max(1000, Number(timeoutMs) || TTS_TIMEOUT_MS));
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
    if (timedOut || (err && err.name === 'AbortError')) {
      throw new TtsError('E_TTS_TIMEOUT', 'ComfyUI 超过 ' + Math.round(timeoutMs / 1000) + ' 秒没有响应', '稍后重试。');
    }
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
      for (const error of list) {
        parts.push(String((error && (error.message || error.type)) || '节点 ' + id + ' 出错'));
      }
    }
  }
  return parts.filter(Boolean).join('；').slice(0, 400);
}

function classifyPromptError(text) {
  const detail = String(text || '');
  if (/speaker|音色|not in list|value not in|not one of/i.test(detail)) return 'E_TTS_SPEAKER';
  if (/model|checkpoint|not found|does not exist|no such/i.test(detail)) return 'E_TTS_MODEL_MISSING';
  return 'E_TTS_WORKFLOW';
}

function readSpeakerOptions(info, classType) {
  const entry = info && info[classType];
  if (!entry || !entry.input) return null;
  for (const group of ['required', 'optional']) {
    const spec = entry.input[group] && entry.input[group].speaker;
    if (!Array.isArray(spec)) continue;
    const first = spec[0];
    const options = Array.isArray(first) ? first : first && Array.isArray(first.options) ? first.options : null;
    if (options) return options.map(String);
  }
  return null;
}

function modelLabelOf(api, table) {
  for (const id of Object.keys(api || {})) {
    const value = api[id] && api[id].inputs && api[id].inputs.model_choice;
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return table.model || '';
}

async function getObjectInfo(fetchImpl, base, signal) {
  try {
    const res = await fetchWithTimeout(fetchImpl, base + '/object_info', {}, TTS_PROBE_TIMEOUT_MS, signal);
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch (err) {
    if (err && err.code === 'E_CANCELLED') throw err;
    return null;
  }
}

export async function probeComfyTts(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const fetchImpl = opts.fetchImpl || fetch;
  const signal = opts.signal;
  const config = readImageConfig();
  const base = baseUrlOf(config);
  let store;
  try {
    store = readWorkflowStore();
  } catch (err) {
    throw err instanceof TtsError ? err : new TtsError('E_TTS_WORKFLOW', String((err && err.message) || err), '');
  }
  const table = readVoiceTable();
  const inspect = store.inspect;
  let statsRes;
  try {
    statsRes = await fetchWithTimeout(fetchImpl, base + '/system_stats', {}, TTS_PROBE_TIMEOUT_MS, signal);
  } catch (err) {
    if (err && err.code === 'E_CANCELLED') throw err;
    throw new TtsError('E_TTS_CONNECT', '连不上 ComfyUI：' + String((err && err.message) || err), '确认地址、端口与服务是否在运行。');
  }
  if (!statsRes.ok) throw new TtsError('E_TTS_CONNECT', 'ComfyUI 返回 HTTP ' + statsRes.status, '确认地址是 ComfyUI 的服务端口。');
  const stats = await statsRes.json().catch(() => null);
  const version = String((stats && stats.system && (stats.system.comfyui_version || stats.system.version)) || '未知');
  const objectInfo = await getObjectInfo(fetchImpl, base, signal);
  const classes = Array.from(new Set(Object.keys(store.prepared.api).map((id) => String(store.prepared.api[id].class_type))));
  const missingNodes = [];
  if (objectInfo) {
    for (const cls of classes) if (!objectInfo[cls]) missingNodes.push(cls);
  }
  const ttsClass = String(store.prepared.api[inspect.ttsIds[0]].class_type || '');
  const modelSpeakers = objectInfo ? readSpeakerOptions(objectInfo, ttsClass) : null;
  let speaker = '';
  try {
    speaker = resolveSpeaker(table, readVoiceConfigComfyVoice(), modelSpeakers);
  } catch (err) {
    speaker = '';
  }
  const unsupported = Array.isArray(modelSpeakers)
    ? table.speakers.map((item) => item.name).filter((name) => !speakerSupported(modelSpeakers, name))
    : [];
  let textNode = '';
  try {
    textNode = resolveTextTarget(store.prepared.api, readVoiceConfigTextNode(), inspect).id;
  } catch {
    textNode = (inspect.candidates[0] || {}).id || '';
  }
  const warnings = [store.warning, inspect.outputWarning].filter(Boolean);
  if (!objectInfo) warnings.push('没能读取 /object_info，模型音色列表未校验。');
  if (!Array.isArray(modelSpeakers)) warnings.push('模型未暴露音色列表，音色支持性未校验。');
  if (unsupported.length) warnings.push('音色表里有 ' + unsupported.length + ' 个音色不被当前模型支持。');
  return {
    ok: true,
    baseUrl: base,
    version: version,
    workflow: {
      name: store.name,
      source: store.source,
      format: store.prepared.format,
      textNode: textNode,
      outputNode: inspect.outputNode,
    },
    modelSpeakers: Array.isArray(modelSpeakers) ? modelSpeakers : null,
    voiceTable: {
      name: table.name,
      model: table.model,
      source: table.source,
      count: table.speakers.length,
      unsupported: unsupported,
    },
    speaker: speaker,
    missing: { nodes: missingNodes, models: [] },
    warnings: warnings,
  };
}

function readVoiceConfigComfyVoice() {
  const raw = readJson(path.join(ROOT, 'voice.json'), null);
  return raw && typeof raw === 'object' ? String(raw.comfyVoice || '') : '';
}

/* ------------------------------ 生成与下载 ------------------------------ */

function audioExtOf(filename) {
  const match = /\.([a-z0-9]+)$/i.exec(String(filename || ''));
  const ext = match ? match[1].toLowerCase() : '';
  return AUDIO_EXTS.includes(ext) ? ext : '';
}

function findAudioOutput(outputs) {
  if (!outputs || typeof outputs !== 'object') return null;
  for (const id of Object.keys(outputs)) {
    const out = outputs[id];
    if (!out || typeof out !== 'object') continue;
    const list = Array.isArray(out.audio) ? out.audio : Array.isArray(out.audios) ? out.audios : [];
    for (const item of list) {
      if (!item || !item.filename) continue;
      const ext = audioExtOf(item.filename);
      if (!ext) continue;
      return { filename: String(item.filename), subfolder: String(item.subfolder || ''), type: String(item.type || 'output'), ext: ext, node: id };
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
      const text = [info.node_type, info.exception_message, info.exception_type].filter(Boolean).join(' · ');
      if (text) return text.slice(0, 400);
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
  const speaker = String(opts.speaker || '');
  const text = String(opts.text || '');
  const applied = applyTtsInputs(prepared.api, text, speaker, opts.textNode);
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
    throw new TtsError(code, 'ComfyUI 拒绝了配音任务：' + detail, code === 'E_TTS_SPEAKER' ? '换一个模型支持的音色，或导入匹配的音色表。' : '检查工作流节点参数。');
  }
  const promptId = String((submitData && submitData.prompt_id) || '');
  if (!promptId) throw new TtsError('E_TTS_BAD_RESPONSE', 'ComfyUI 没有返回 prompt_id', '');

  const timeoutMs = Math.max(10000, Number(opts.timeoutMs) || TTS_TIMEOUT_MS);
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
    if (status.status_str === 'error') {
      const detail = executionErrorText(status);
      throw new TtsError(classifyPromptError(detail), 'ComfyUI 配音执行出错：' + detail, '检查工作流、模型与音色。');
    }
    if (entry.outputs && Object.keys(entry.outputs).length) break;
    if (status.completed) throw new TtsError('E_TTS_BAD_RESPONSE', 'ComfyUI 跑完了但没有音频输出', '确认工作流末尾是 SaveAudio/PreviewAudio。');
    entry = null;
  }
  if (!entry) throw new TtsError('E_TTS_TIMEOUT', '等 ComfyUI 配音超时（' + Math.round(timeoutMs / 1000) + ' 秒）', '模型首次加载可能很久，稍后补配音。');

  const audio = findAudioOutput(entry.outputs);
  if (!audio) throw new TtsError('E_TTS_BAD_RESPONSE', '工作流没有输出音频', '确认工作流末尾是 SaveAudio/PreviewAudio。');
  const params = new URLSearchParams({ filename: audio.filename, subfolder: audio.subfolder, type: audio.type });
  const download = await fetchWithTimeout(fetchImpl, base + '/view?' + params.toString(), {}, 60000, signal);
  if (!download.ok) throw new TtsError('E_TTS_BAD_RESPONSE', '下载音频失败（HTTP ' + download.status + '）', '');
  const buffer = Buffer.from(await download.arrayBuffer());
  if (!buffer.length) throw new TtsError('E_TTS_BAD_RESPONSE', 'ComfyUI 返回了空音频', '');
  if (buffer.length > TTS_MAX_AUDIO_BYTES) throw new TtsError('E_TTS_BAD_RESPONSE', '音频文件超过 32MB', '换小一点的工作流。');
  return {
    buffer: buffer,
    ext: audio.ext,
    contentType: AUDIO_CONTENT_TYPES[audio.ext] || 'application/octet-stream',
    filename: audio.filename,
    promptId: promptId,
    audioMs: audio.ext === 'wav' ? wavDurationMs(buffer) || estimateAudioMs(text, 1) : estimateAudioMs(text, 1),
    model: modelLabelOf(prepared.api, opts.table || { model: '' }),
    voice: speaker,
  };
}

export async function testComfyTts(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const text = String(opts.text || '').slice(0, 200) || TTS_TEST_TEXT;
  const table = readVoiceTable();
  const store = readWorkflowStore();
  const inspect = store.inspect;
  const speaker = resolveSpeaker(table, opts.speaker || readVoiceConfigComfyVoice(), opts.modelSpeakers);
  const result = await runComfyExclusive(
    () =>
      submitAndWait({
        prepared: store.prepared,
        table: table,
        text: text,
        speaker: speaker,
        textNode: readVoiceConfigTextNode() || (inspect.candidates[0] || {}).id,
        baseUrl: opts.baseUrl,
        fetchImpl: opts.fetchImpl,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
      }),
    { signal: opts.signal, maxWaitMs: Number(opts.maxWaitMs) || TTS_QUEUE_WAIT_MS },
  );
  const entry = table.speakers.find((item) => canonicalSpeaker(item.name) === canonicalSpeaker(result.voice));
  return Object.assign({}, result, { voiceLabel: entry && entry.label ? entry.label : '' });
}

/** 设置页「试听」：先读模型音色列表，再真跑一次工作流；不落盘、不缓存。 */
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
      text: text,
      fetchImpl: opts.fetchImpl,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      maxWaitMs: opts.maxWaitMs,
      modelSpeakers: probe.modelSpeakers,
      baseUrl: probe.baseUrl,
      speaker: opts.speaker || opts.comfyVoice,
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
      note: 'ComfyUI 试听；不落盘、不缓存。',
    };
  } catch (err) {
    if (err instanceof TtsError) return { ok: false, code: err.code, error: err.message, hint: err.hint };
    return { ok: false, code: 'E_TTS_FAIL', error: String((err && err.message) || err), hint: '' };
  }
}

/* ------------------------------ 缓存与逐页配音 ------------------------------ */

function audioCacheKey(ctx, text) {
  return sha256(['comfyui-tts', ctx.workflowHash, ctx.textNode, ctx.speaker, ctx.model, text].join('|'));
}

function readAudioCache(cacheDir, key) {
  for (const ext of AUDIO_EXTS) {
    const file = path.join(cacheDir, key + '.' + ext);
    try {
      const buffer = fs.readFileSync(file);
      if (buffer.length > 0) return { buffer: buffer, ext: ext };
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
        table: ctx.table,
        text: text,
        speaker: ctx.speaker,
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

/**
 * 逐页配音（串行，一页一个 /prompt）。返回与 tts.synthesizeVoicing 相同的形状。
 * @param {Array} slides
 * @param {object} ctx {prepared, table, speaker, textNode, workflowHash, model, cacheDir, moduleDir}
 */
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
      let cached = opts.ignoreCache ? null : readAudioCache(cacheDir, key);
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
    voice: ctx.speaker,
    degraded: errors.length > 0,
    code: errors.length ? errors[0].code || 'E_TTS_FAIL' : null,
    message: errors.length ? '有 ' + errors.length + ' 页配音失败；' + errors[0].code + '：' + errors[0].message : '',
    errors: errors,
    slides: out,
  };
}

/** 给 voice.js 用：作业启动时的配置快照与支持性校验。 */
export async function prepareComfyVoice(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const probe = await probeComfyTts({ fetchImpl: opts.fetchImpl, signal: opts.signal });
  const table = readVoiceTable();
  const store = readWorkflowStore();
  const speaker = resolveSpeaker(table, readVoiceConfigComfyVoice(), probe.modelSpeakers);
  return {
    prepared: store.prepared,
    table: table,
    speaker: speaker,
    textNode: readVoiceConfigTextNode() || (store.inspect.candidates[0] || {}).id,
    workflowHash: workflowHashOf(store.raw),
    model: modelLabelOf(store.prepared.api, table),
    modelSpeakers: probe.modelSpeakers,
    baseUrl: probe.baseUrl,
    probe: probe,
  };
}

export { ROOT };
