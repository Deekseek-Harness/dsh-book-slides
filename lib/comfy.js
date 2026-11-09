/**
 * 精讲台 · 本地 ComfyUI 配图（v1.4）
 *
 * 策略两档（image.json.provider）：
 *   prompt  —— 只出 image_prompt，播放器显示提示词占位卡（默认，v1 行为不变）
 *   comfyui —— 把 image_prompt 交给本机 / 局域网 ComfyUI，逐页落 PNG
 *
 * 配置三级回退：
 *   用户填的 host/port → 内置默认 127.0.0.1:8188
 *   用户导入的工作流 → 内置默认 workflows/z-image-turbo.json
 *
 * 安全边界：
 *   - 浏览器不直连 ComfyUI：宿主用 HTTP 取图、落盘，再由同源 /image 提供；
 *   - 工作流只收「保存（API 格式）」的 JSON，路径与体积都先校验；
 *   - image.json / 工作流里没有密钥，ComfyUI 也不带鉴权（单机 / 局域网边界）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROOT, readJson, sha256Of, writeAtomic } from './fs.js';

export const IMAGE_VERSION = 1;
export const IMAGE_FILE = path.join(ROOT, 'image.json');
export const IMAGE_WORKFLOW_FILE = path.join(ROOT, 'comfy-workflow.json');
export const IMAGE_CACHE_DIR = path.join(ROOT, 'image-cache');

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8188;
export const DEFAULT_WORKFLOW_NAME = 'z-image-turbo';

/** 默认工作流：Z-Image Turbo，1024²，8 步。随包发布，不做网络下载。 */
export const DEFAULT_WORKFLOW_PATH = fileURLToPath(new URL('../workflows/z-image-turbo.json', import.meta.url));

export const IMAGE_POLL_MS = 1000;
export const IMAGE_TIMEOUT_MS = 180000;
export const IMAGE_MODULE_BUDGET_MS = 15 * 60 * 1000;
export const IMAGE_MAX_BYTES = 32 * 1024 * 1024;
export const WORKFLOW_MAX_NODES = 2000;
export const IMAGE_CACHE_VERSION = 'comfy-v1';

/** 设置页「测试生图」的默认提示词：只验证链路，不写模块、不进缓存。 */
export const DEFAULT_TEST_PROMPT = '一本摊开的旧书，暖色台灯，书籍插画风格，无文字';
export const TEST_PROMPT_MAX = 200;

export const IMAGE_PROVIDERS = [
  { id: 'prompt', label: '提示词占位（默认）', ready: true, note: '只产出 image_prompt，配图位可查看与复制，不调用任何绘图服务。' },
  { id: 'comfyui', label: '本地 ComfyUI', ready: true, note: '模块就绪后由宿主逐页调用 ComfyUI 出图，图片落盘到模块目录。' },
];

export class ImageError extends Error {
  constructor(code, message, hint, extra) {
    super(message);
    this.name = 'ImageError';
    this.code = code;
    this.hint = hint || '';
    if (extra && typeof extra === 'object') Object.assign(this, extra);
  }
}

/* ------------------------------ 端点与配置 ------------------------------ */

function safeEndpoint(hostValue, portValue) {
  let host = String(hostValue == null ? '' : hostValue).trim();
  let port = portValue;
  if (!host) return { host: DEFAULT_HOST, port: normalizePort(port) };
  host = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  const match = /^(\[[0-9a-fA-F:]+\]|[^:\s/]+)(?::(\d{1,5}))?$/.exec(host);
  if (!match) return { host: DEFAULT_HOST, port: normalizePort(port) };
  host = match[1];
  if (match[2] && (port === undefined || port === null || port === '')) port = match[2];
  const valid =
    /^\[[0-9a-fA-F:]+\]$/.test(host) || /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(host);
  return { host: valid ? host : DEFAULT_HOST, port: normalizePort(port) };
}

function normalizePort(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_PORT;
  const port = Math.round(Number(value));
  if (!Number.isFinite(port) || port < 1 || port > 65535) return DEFAULT_PORT;
  return port;
}

export function baseUrlOf(config) {
  const safe = safeEndpoint(config && config.host, config && config.port);
  return 'http://' + safe.host + ':' + safe.port;
}

export function normalizeImageConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const provider = String(source.provider || '').toLowerCase() === 'comfyui' ? 'comfyui' : 'prompt';
  const endpoint = safeEndpoint(source.host, source.port);
  return {
    version: IMAGE_VERSION,
    provider: provider,
    host: endpoint.host,
    port: endpoint.port,
    styleSuffix: String(source.styleSuffix == null ? '' : source.styleSuffix).trim().slice(0, 60),
    promptNode: String(source.promptNode || '').trim().slice(0, 24),
  };
}

export function readImageConfig() {
  return normalizeImageConfig(readJson(IMAGE_FILE, null));
}

/** 写 image.json：只接受白名单字段；host/port 非法就回落到默认值，不报错。 */
export function writeImageConfig(patch) {
  const current = readImageConfig();
  const merged = Object.assign({}, current, patch && typeof patch === 'object' ? patch : {});
  const next = normalizeImageConfig(merged);
  writeAtomic(IMAGE_FILE, JSON.stringify(next, null, 2) + '\n');
  return next;
}

/* ------------------------------ 工作流 ------------------------------ */

export function defaultWorkflow() {
  const raw = readJson(DEFAULT_WORKFLOW_PATH, null);
  if (!raw) {
    throw new ImageError('E_IMG_WORKFLOW', '内置默认工作流缺失', '插件安装可能不完整，重新装一次。');
  }
  return { workflow: raw, name: DEFAULT_WORKFLOW_NAME, source: 'default', savedAt: '' };
}

/** 用户导入的工作流；文件坏了 / 结构不对就回落到默认，不让设置页打不开。 */
export function readWorkflowStore() {
  const stored = readJson(IMAGE_WORKFLOW_FILE, null);
  if (stored && stored.workflow && typeof stored.workflow === 'object') {
    try {
      validateWorkflow(stored.workflow);
      return {
        workflow: stored.workflow,
        name: String(stored.name || 'imported-workflow.json').slice(0, 80),
        source: 'imported',
        savedAt: String(stored.savedAt || ''),
      };
    } catch {
      /* 坏文件当没导入过 */
    }
  }
  return defaultWorkflow();
}

function listTextNodes(workflow) {
  const out = [];
  for (const id of Object.keys(workflow)) {
    const node = workflow[id];
    const cls = String(node && node.class_type ? node.class_type : '');
    if (!/cliptextencode/i.test(cls)) continue;
    const text = node.inputs && typeof node.inputs.text === 'string' ? node.inputs.text : null;
    if (text == null) continue;
    out.push({
      id: id,
      class_type: cls,
      title: String((node._meta && node._meta.title) || cls),
      text: text.slice(0, 160),
    });
  }
  return out;
}

function isRef(value) {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(Number(value[1]));
}

/** 从 KSampler.positive / negative 往上游走，找第一个 CLIPTextEncode。 */
function traceTextNode(workflow, ref, seen) {
  if (!isRef(ref)) return '';
  const node = workflow[ref[0]];
  if (!node) return '';
  const cls = String(node.class_type || '');
  if (/cliptextencode/i.test(cls) && node.inputs && typeof node.inputs.text === 'string') return ref[0];
  const visited = seen || new Set();
  if (visited.has(ref[0])) return '';
  visited.add(ref[0]);
  const inputs = node.inputs && typeof node.inputs === 'object' ? node.inputs : {};
  for (const key of Object.keys(inputs)) {
    if (isRef(inputs[key])) {
      const found = traceTextNode(workflow, inputs[key], visited);
      if (found) return found;
    }
  }
  return '';
}

function findSampler(workflow) {
  const ids = Object.keys(workflow);
  const preferred = ids.filter((id) => /^(KSampler|KSamplerAdvanced|SamplerCustom)/i.test(String(workflow[id].class_type || '')));
  const rest = ids.filter((id) => !preferred.includes(id) && /sampler/i.test(String(workflow[id].class_type || '')));
  for (const id of preferred.concat(rest)) {
    const inputs = workflow[id].inputs || {};
    if (inputs.positive || inputs.negative) return { id: id, inputs: inputs };
  }
  return null;
}

/**
 * 校验一份 API 格式工作流，并找出提示词节点。
 * 返回 {workflow, promptNode, negativeNode, candidates, sampler}；
 * 结构不对抛 E_IMG_WORKFLOW（UI 格式单独提示）。
 */
export function validateWorkflow(raw) {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!obj) {
    throw new ImageError('E_IMG_WORKFLOW', '工作流必须是 JSON 对象', '在 ComfyUI 里用「保存（API 格式）」导出。');
  }
  if (Array.isArray(obj.nodes) && Array.isArray(obj.links)) {
    throw new ImageError('E_IMG_WORKFLOW', '这是 ComfyUI 的界面格式，不能直接执行', '请用「保存（API 格式）」重新导出。');
  }
  const ids = Object.keys(obj);
  if (ids.length < 2) {
    throw new ImageError('E_IMG_WORKFLOW', '工作流节点太少（' + ids.length + ' 个）', '确认导出的是 API 格式。');
  }
  if (ids.length > WORKFLOW_MAX_NODES) {
    throw new ImageError('E_IMG_WORKFLOW', '工作流节点太多（' + ids.length + ' 个）', '最多 ' + WORKFLOW_MAX_NODES + ' 个。');
  }
  const broken = [];
  for (const id of ids) {
    const node = obj[id];
    if (!node || typeof node !== 'object' || typeof node.class_type !== 'string') broken.push(id);
    else if (!node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) broken.push(id);
  }
  if (broken.length) {
    throw new ImageError('E_IMG_WORKFLOW', '工作流里有节点缺 class_type 或 inputs', '出问题的节点：' + broken.slice(0, 5).join(', '));
  }
  const candidates = listTextNodes(obj);
  const sampler = findSampler(obj);
  let promptNode = sampler ? traceTextNode(obj, sampler.inputs.positive) : '';
  let negativeNode = sampler ? traceTextNode(obj, sampler.inputs.negative) : '';
  if (!promptNode && candidates.length === 1) promptNode = candidates[0].id;
  return {
    workflow: obj,
    promptNode: promptNode,
    negativeNode: negativeNode,
    candidates: candidates,
    sampler: sampler ? sampler.id : '',
  };
}

function resolvePromptNode(check, wanted) {
  const ids = check.candidates.map((item) => item.id);
  const wantedId = String(wanted || '').trim();
  if (wantedId) {
    if (ids.includes(wantedId)) return wantedId;
    throw new ImageError('E_IMG_WORKFLOW_NODE', '选中的节点不是文本编码节点', '重新选一个 CLIPTextEncode 节点。', {
      candidates: check.candidates,
    });
  }
  if (check.promptNode) return check.promptNode;
  if (check.candidates.length === 1) return check.candidates[0].id;
  throw new ImageError(
    'E_IMG_WORKFLOW_NODE',
    check.candidates.length ? '没能自动认出提示词节点，请手动选一个' : '工作流里没有文本编码节点（CLIPTextEncode）',
    check.candidates.length ? '多个文本节点都可能是提示词入口。' : '换一个带 CLIPTextEncode 的工作流。',
    { candidates: check.candidates },
  );
}

export function workflowHashOf(workflow) {
  return sha256Of(Buffer.from(JSON.stringify(workflow || {}), 'utf8'));
}

/** 把提示词与种子写进工作流；返回深拷贝，不改内存里的原对象。 */
export function applyPrompt(workflow, prompt, seed, promptNode) {
  const clone = JSON.parse(JSON.stringify(workflow || {}));
  const check = validateWorkflow(clone);
  const wantedId = promptNode ? String(promptNode) : '';
  if (wantedId && !check.candidates.some((item) => item.id === wantedId)) {
    throw new ImageError('E_IMG_WORKFLOW_NODE', '配置里的提示词节点不在当前工作流里', '到设置 → 配图重新选一个节点。');
  }
  const id = wantedId || resolvePromptNode(check, '');
  const node = clone[id];
  if (!node || !node.inputs) {
    throw new ImageError('E_IMG_WORKFLOW_NODE', '提示词节点不存在', String(promptNode || ''));
  }
  node.inputs.text = String(prompt || '');
  const numericSeed = Math.max(0, Math.round(Number(seed) || 0));
  for (const nodeId of Object.keys(clone)) {
    const item = clone[nodeId];
    const inputs = item && item.inputs;
    if (!inputs || typeof inputs !== 'object') continue;
    if (typeof inputs.seed === 'number') inputs.seed = numericSeed;
    if (typeof inputs.noise_seed === 'number') inputs.noise_seed = numericSeed;
  }
  return clone;
}

/**
 * 导入工作流：先校验、再原子落盘；失败不覆盖上一份可用工作流。
 * promptNode 未识别时抛 E_IMG_WORKFLOW_NODE，并带回候选节点供面板选择。
 */
export function saveWorkflow(raw, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const check = validateWorkflow(raw);
  const promptNode = resolvePromptNode(check, opts.promptNode);
  const name = String(opts.name || 'imported-workflow.json').slice(0, 80);
  const savedAt = new Date().toISOString();
  writeAtomic(IMAGE_WORKFLOW_FILE, JSON.stringify({ name: name, savedAt: savedAt, workflow: check.workflow }, null, 2) + '\n');
  const config = writeImageConfig({ promptNode: promptNode });
  return { ok: true, config: config, promptNode: promptNode, candidates: check.candidates };
}

/** 恢复默认工作流：删掉导入文件，并清掉 promptNode 覆盖。 */
export function resetWorkflow() {
  try {
    fs.rmSync(IMAGE_WORKFLOW_FILE, { force: true });
  } catch {
    /* 删不掉也不影响读默认值 */
  }
  const config = writeImageConfig({ promptNode: '' });
  return { ok: true, config: config, candidates: validateWorkflow(defaultWorkflow().workflow).candidates };
}

/** 面板看到的配置：不含任何密钥，工作流只给节点摘要与候选。 */
export function publicImageConfig() {
  const config = readImageConfig();
  let store;
  let check;
  try {
    store = readWorkflowStore();
    check = validateWorkflow(store.workflow);
  } catch (err) {
    return {
      provider: config.provider,
      host: config.host,
      port: config.port,
      baseUrl: baseUrlOf(config),
      styleSuffix: config.styleSuffix,
      providers: IMAGE_PROVIDERS,
      workflow: { source: 'default', name: DEFAULT_WORKFLOW_NAME, nodes: 0, promptNode: '', candidates: [], valid: false },
      defaults: { host: DEFAULT_HOST, port: DEFAULT_PORT, workflowName: DEFAULT_WORKFLOW_NAME },
      testPrompt: DEFAULT_TEST_PROMPT,
      error: String((err && err.message) || err),
      note: '工作流读不出来：' + String((err && err.message) || err),
    };
  }
  const validIds = check.candidates.map((item) => item.id);
  const promptNode =
    config.promptNode && validIds.includes(config.promptNode) ? config.promptNode : check.promptNode || (check.candidates[0] || {}).id || '';
  const nodeTitle = (check.candidates.find((item) => item.id === promptNode) || {}).title || '';
  return {
    provider: config.provider,
    host: config.host,
    port: config.port,
    baseUrl: baseUrlOf(config),
    styleSuffix: config.styleSuffix,
    providers: IMAGE_PROVIDERS,
    workflow: {
      source: store.source,
      name: store.name,
      savedAt: store.savedAt,
      nodes: Object.keys(store.workflow).length,
      promptNode: promptNode,
      promptNodeTitle: nodeTitle,
      candidates: check.candidates,
      sampler: check.sampler,
      valid: !!promptNode,
    },
    defaults: { host: DEFAULT_HOST, port: DEFAULT_PORT, workflowName: 'Z-Image Turbo（1024² / 8 步）' },
    testPrompt: DEFAULT_TEST_PROMPT,
    note:
      config.provider === 'comfyui'
        ? '模块就绪后自动调用 ' + baseUrlOf(config) + ' 逐页出图；失败页回退提示词占位，不阻断文字与语音。'
        : '当前只产出提示词，不调用 ComfyUI。',
  };
}

/* ------------------------------ 种子与缓存 ------------------------------ */

export function seedFor(prompt, workflowHash, nonce) {
  const digest = sha256Of(
    Buffer.from([IMAGE_CACHE_VERSION, String(prompt || ''), String(workflowHash || ''), String(Math.max(0, Math.round(Number(nonce) || 0)))].join('|'), 'utf8'),
  );
  // 取 13 个十六进制位（52 bit），远小于 Number.MAX_SAFE_INTEGER，可安全进 JSON
  return parseInt(digest.slice(0, 13), 16);
}

export function imageCacheKey(prompt, workflowHash, seed) {
  return sha256Of(
    Buffer.from([IMAGE_CACHE_VERSION, String(prompt || ''), String(workflowHash || ''), String(seed)].join('|'), 'utf8'),
  );
}

export function imageCachePath(key) {
  return path.join(IMAGE_CACHE_DIR, String(key).replace(/[^a-f0-9]/gi, '').slice(0, 64) + '.png');
}

export function readImageCache(key) {
  try {
    const buffer = fs.readFileSync(imageCachePath(key));
    return isPng(buffer) ? buffer : null;
  } catch {
    return null;
  }
}

export function writeImageCache(key, buffer) {
  try {
    writeAtomic(imageCachePath(key), buffer);
  } catch {
    /* 缓存写不进去不影响本次出图 */
  }
}

/* ------------------------------ HTTP ------------------------------ */

const CLIENT_ID = 'dsh-book-slides-' + crypto.randomBytes(4).toString('hex');

function isPng(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  );
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new ImageError('E_IMG_CANCELLED', '已取消'));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ImageError('E_IMG_CANCELLED', '已取消'));
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
      /* 已经结束 */
    }
  }, Math.max(1000, Number(timeoutMs) || IMAGE_TIMEOUT_MS));
  const onAbort = () => {
    try {
      controller.abort();
    } catch {
      /* 已经结束 */
    }
  };
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetchImpl(url, Object.assign({}, init || {}, { signal: controller.signal }));
  } catch (err) {
    if (signal && signal.aborted) throw new ImageError('E_IMG_CANCELLED', '已取消');
    if (timedOut || (err && err.name === 'AbortError')) {
      throw new ImageError('E_IMG_TIMEOUT', 'ComfyUI 超过 ' + Math.round(timeoutMs / 1000) + ' 秒没有响应');
    }
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {
      origin = '';
    }
    throw new ImageError(
      'E_IMG_CONNECT',
      '连不上 ComfyUI' + (origin ? '（' + origin + '）' : ''),
      '确认 ComfyUI 正在运行、IP 与端口正确，且不是只监听 127.0.0.1。',
    );
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function formatComfyError(data) {
  if (!data || typeof data !== 'object') return '';
  const parts = [];
  if (data.error && typeof data.error === 'string') parts.push(data.error);
  if (data.error && typeof data.error === 'object' && data.error.message) parts.push(String(data.error.message));
  const nodeErrors = data.node_errors && typeof data.node_errors === 'object' ? data.node_errors : null;
  if (nodeErrors) {
    for (const nodeId of Object.keys(nodeErrors)) {
      const item = nodeErrors[nodeId];
      if (!item) continue;
      const errors = Array.isArray(item.errors) ? item.errors : [];
      for (const error of errors) {
        parts.push(String(error.message || error.type || '节点 ' + nodeId + ' 出错') + (error.details ? '：' + String(error.details) : ''));
      }
    }
  }
  if (Array.isArray(data.messages)) parts.push(data.messages.map(String).join(' '));
  return parts.filter(Boolean).join('；').slice(0, 400);
}

function formatExecutionError(status) {
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

function firstOutputImage(outputs) {
  if (!outputs || typeof outputs !== 'object') return null;
  let fallback = null;
  for (const nodeId of Object.keys(outputs)) {
    const out = outputs[nodeId];
    if (!out || typeof out !== 'object') continue;
    const images = Array.isArray(out.images) ? out.images : [];
    for (const image of images) {
      if (!image || !image.filename) continue;
      const entry = {
        filename: String(image.filename),
        subfolder: String(image.subfolder || ''),
        type: String(image.type || 'output'),
        node: nodeId,
      };
      if (entry.type === 'output') return entry;
      if (!fallback) fallback = entry;
    }
  }
  return fallback;
}

/** 测试 / 局域网排障用：读版本 + 检查工作流用到的模型是否都在。 */
export async function probeComfy(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const config = opts.config || readImageConfig();
  const workflow = opts.workflow || readWorkflowStore().workflow;
  const fetchImpl = opts.fetchImpl || fetch;
  const base = baseUrlOf(config);
  const signal = opts.signal;
  const statsRes = await fetchWithTimeout(fetchImpl, base + '/system_stats', {}, 8000, signal);
  if (!statsRes.ok) {
    throw new ImageError('E_IMG_CONNECT', 'ComfyUI 返回 HTTP ' + statsRes.status, '确认地址是 ComfyUI 的服务端口。');
  }
  const stats = await statsRes.json().catch(() => null);
  const version = String((stats && stats.system && (stats.system.comfyui_version || stats.system.version)) || '未知');
  const wanted = collectModelRefs(workflow);
  const missing = [];
  const cache = new Map();
  for (const item of wanted) {
    if (!cache.has(item.classType)) {
      let list = null;
      try {
        const res = await fetchWithTimeout(fetchImpl, base + '/object_info/' + encodeURIComponent(item.classType), {}, 8000, signal);
        if (res.ok) {
          const info = await res.json().catch(() => null);
          list = readModelList(info, item.classType, item.field);
        }
      } catch {
        list = null;
      }
      cache.set(item.classType, list);
    }
    const list = cache.get(item.classType);
    if (Array.isArray(list) && list.length) {
      if (!list.map(String).includes(item.value)) missing.push(item.classType + '.' + item.field + '=' + item.value);
    }
  }
  return { ok: true, version: version, baseUrl: base, missing: missing, checked: wanted.length };
}

function readModelList(info, classType, field) {
  const entry = info && info[classType];
  const required = entry && entry.input && entry.input.required ? entry.input.required : null;
  const spec = required && required[field] ? required[field] : null;
  if (!Array.isArray(spec)) return null;
  return Array.isArray(spec[0]) ? spec[0].map(String) : null;
}

const MODEL_FIELDS = {
  CheckpointLoaderSimple: ['ckpt_name'],
  UNETLoader: ['unet_name'],
  CLIPLoader: ['clip_name'],
  DualCLIPLoader: ['clip_name1', 'clip_name2'],
  VAELoader: ['vae_name'],
  LoraLoader: ['lora_name'],
};

function collectModelRefs(workflow) {
  const out = [];
  for (const id of Object.keys(workflow || {})) {
    const node = workflow[id];
    const classType = String(node.class_type || '');
    const fields = MODEL_FIELDS[classType];
    if (!fields) continue;
    for (const field of fields) {
      const value = node.inputs && node.inputs[field];
      if (typeof value === 'string' && value) out.push({ classType: classType, field: field, value: value });
    }
  }
  return out;
}

/**
 * 跑一次出图：提交 → 轮询 /history → 从 /view 下载 PNG。
 * 不落盘，缓存与落盘由 imaging.js 负责。
 */
export async function generateImage(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const config = opts.config || readImageConfig();
  const patched = applyPrompt(opts.workflow, String(opts.prompt || ''), opts.seed, opts.promptNode);
  const result = await submitPreparedWorkflow({
    config: config,
    workflow: patched,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
  result.seed = opts.seed;
  return result;
}

/** 提交一份已经写好参数的工作流，等到输出图并下载。 */
async function submitPreparedWorkflow(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const config = opts.config || readImageConfig();
  const workflow = opts.workflow;
  const signal = opts.signal;
  const fetchImpl = opts.fetchImpl || fetch;
  const base = baseUrlOf(config);
  const body = JSON.stringify({ prompt: workflow, client_id: CLIENT_ID });

  const submit = await fetchWithTimeout(
    fetchImpl,
    base + '/prompt',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: body },
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
    const missingModel = /checkpoint|unet|clip|vae|lora|model|not found|does not exist|No such/i.test(detail);
    throw new ImageError(
      missingModel ? 'E_IMG_MODEL_MISSING' : 'E_IMG_BAD_WORKFLOW',
      'ComfyUI 拒绝了这次任务：' + detail,
      missingModel ? '先在 ComfyUI 里装好工作流需要的模型（可点「测试连接」检查）。' : '检查工作流节点参数。',
    );
  }
  const promptId = String((submitData && submitData.prompt_id) || '');
  if (!promptId) {
    throw new ImageError('E_IMG_BAD_RESPONSE', 'ComfyUI 没有返回 prompt_id', submitText.slice(0, 200));
  }

  const timeoutMs = Math.max(10000, Number(opts.timeoutMs) || IMAGE_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  let entry = null;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new ImageError('E_IMG_CANCELLED', '已取消');
    await sleep(IMAGE_POLL_MS, signal);
    const history = await fetchWithTimeout(fetchImpl, base + '/history/' + encodeURIComponent(promptId), {}, 15000, signal);
    if (!history.ok) continue;
    const data = await history.json().catch(() => null);
    entry = data && data[promptId] ? data[promptId] : null;
    if (!entry) continue;
    const status = entry.status || {};
    if (status.status_str === 'error') {
      throw new ImageError('E_IMG_BAD_WORKFLOW', 'ComfyUI 执行出错：' + formatExecutionError(status), '检查工作流所需的模型与自定义节点。');
    }
    if (entry.outputs && Object.keys(entry.outputs).length) break;
    if (status.completed) {
      throw new ImageError('E_IMG_BAD_RESPONSE', 'ComfyUI 跑完了但没有输出图片', '确认工作流里有 SaveImage 节点。');
    }
    entry = null;
  }
  if (!entry) throw new ImageError('E_IMG_TIMEOUT', '等 ComfyUI 出图超时（' + Math.round(timeoutMs / 1000) + ' 秒）', '模型首次加载可能很久，稍后单独重试这一页。');

  const image = firstOutputImage(entry.outputs);
  if (!image) {
    throw new ImageError('E_IMG_BAD_RESPONSE', '工作流没有输出图片', '确认工作流末尾是 SaveImage。');
  }
  const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type });
  const download = await fetchWithTimeout(fetchImpl, base + '/view?' + params.toString(), {}, 60000, signal);
  if (!download.ok) {
    throw new ImageError('E_IMG_BAD_RESPONSE', '下载图片失败（HTTP ' + download.status + '）', '');
  }
  const buffer = Buffer.from(await download.arrayBuffer());
  if (buffer.length > IMAGE_MAX_BYTES) {
    throw new ImageError('E_IMG_TOO_LARGE', '图片超过 ' + Math.round(IMAGE_MAX_BYTES / 1024 / 1024) + 'MB', '');
  }
  if (!isPng(buffer)) {
    throw new ImageError('E_IMG_BAD_RESPONSE', 'ComfyUI 返回的不是 PNG 图片', '工作流可能输出的是其它格式。');
  }
  return { buffer: buffer, filename: image.filename, promptId: promptId };
}
