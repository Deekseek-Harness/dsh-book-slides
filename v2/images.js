/**
 * 2.0 配图（FR-24 / P1）：配置、工作流、探活、逐页异步作业与 PNG 读取。
 *
 * 边界：
 *   - 默认 `prompt`（提示词占位），不联网、不产生图片文件；只有用户显式切到
 *     `comfyui` 并触发 `/image/regen` 才会出图；
 *   - 配图作业只改 slides.json 的图片字段，不改文字与音频；失败页留白，可单页重试；
 *   - 配置与工作流沿用 1.x 的 comfy.js（根目录 image.json / comfy-workflow.json /
 *     image-cache/），逐页产物写到讲目录 `images/NNN.png`。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_TEST_PROMPT,
  DEFAULT_WORKFLOW_NAME,
  IMAGE_MODULE_BUDGET_MS,
  IMAGE_PROVIDERS,
  IMAGE_TIMEOUT_MS,
  ImageError,
  TEST_PROMPT_MAX,
  generateImage,
  imageCacheKey,
  imageCachePath,
  probeComfy,
  publicImageConfig,
  readImageCache,
  readImageConfig,
  readWorkflowStore,
  resetWorkflow,
  saveWorkflow,
  seedFor,
  validateWorkflow,
  workflowHashOf,
  writeImageCache,
  writeImageConfig,
} from '../comfy.js';
import { BOOKS_DIR, readJson, writeAtomic, writeJson } from './root.js';
import { findSeries, patchSeriesLecture, persistSeries } from './series.js';
import { lectureDir, loadLecture } from './lectures.js';
import { recordError } from './errors.js';

const READY = ['ready', 'ready_degraded'];
const IMAGE_RE = /^images\/(\d{3})\.png$/;
const JOB_FILE = 'image-job.json';

/* ------------------------------ 配置 ------------------------------ */

export function imagePayload(extra) {
  return Object.assign(
    {
      image: publicImageConfig(),
      providers: IMAGE_PROVIDERS,
      defaults: { host: DEFAULT_HOST, port: DEFAULT_PORT, workflowName: DEFAULT_WORKFLOW_NAME },
    },
    extra || {},
  );
}

export function saveImageConfig(patch) {
  writeImageConfig(patch && typeof patch === 'object' ? patch : {});
  return imagePayload();
}

function workflowContext() {
  const store = readWorkflowStore();
  const check = validateWorkflow(store.workflow);
  const config = readImageConfig();
  const promptNode =
    config.promptNode && check.candidates.some((item) => item.id === config.promptNode)
      ? config.promptNode
      : check.promptNode;
  return { store, check, config, promptNode };
}

export function saveImageWorkflow(body) {
  if (body && body.reset === true) {
    resetWorkflow();
    return imagePayload();
  }
  const workflow = body && body.workflow && typeof body.workflow === 'object' ? body.workflow : body;
  const saved = saveWorkflow(workflow, { name: body && body.name, promptNode: body && body.promptNode });
  return imagePayload({ candidates: saved.candidates });
}

/** 测试连接：只探 ComfyUI 与模型，不出图。 */
export async function probeImage(options) {
  const store = readWorkflowStore();
  const result = await probeComfy({
    config: readImageConfig(),
    workflow: store.workflow,
    signal: options && options.signal,
    fetchImpl: options && options.fetchImpl,
  });
  return Object.assign({ workflow: { source: store.source, name: store.name } }, result);
}

/** 测试生图：只验证链路，不落盘、不进缓存。 */
export async function testImage({ prompt = '', options = {} } = {}) {
  const config = readImageConfig();
  if (config.provider !== 'comfyui') {
    throw new ImageError('E_IMG_DISABLED', '当前配图策略是「提示词占位」', '先切到「本地 ComfyUI」，再测试生图。');
  }
  if (hasActiveImageJob()) {
    throw new ImageError('E_IMG_BUSY', '配图作业正在跑，先别抢 GPU', '等这次补图完成，或取消后再试。');
  }
  let ctx;
  try {
    ctx = workflowContext();
  } catch (err) {
    throw new ImageError((err && err.code) || 'E_IMG_WORKFLOW', String((err && err.message) || err), (err && err.hint) || '');
  }
  if (!ctx.promptNode) {
    throw new ImageError('E_IMG_WORKFLOW_NODE', '工作流没认出提示词节点', '到「提示词节点」里选一个再试。');
  }
  const text = String(prompt == null ? '' : prompt).trim() || DEFAULT_TEST_PROMPT;
  if (text.length > TEST_PROMPT_MAX) {
    throw new ImageError('E_IMG_PROMPT', '测试提示词最多 ' + TEST_PROMPT_MAX + ' 字', '当前 ' + text.length + ' 字。');
  }
  const seed = seedFor(text, workflowHashOf(ctx.store.workflow), Date.now());
  const result = await generateImage({
    config: ctx.config,
    workflow: ctx.store.workflow,
    prompt: text,
    seed,
    promptNode: ctx.promptNode,
    timeoutMs: IMAGE_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  });
  return { buffer: result.buffer, seed, promptNode: ctx.promptNode };
}

/** 生成阶段用：当前策略决定初始 image_status（ComfyUI → pending，占位 → none）。 */
export function initialImageStatus() {
  try {
    return readImageConfig().provider === 'comfyui' ? 'pending' : 'none';
  } catch {
    return 'none';
  }
}

/* ------------------------------ 图片文件 ------------------------------ */

export function imageFile(seriesDirPath, lecture, index) {
  const n = Number(lecture);
  const i = Number(index);
  if (!Number.isInteger(n) || n < 1 || n > 999) return null;
  if (!Number.isInteger(i) || i < 1 || i > 999) return null;
  const rel = 'images/' + String(i).padStart(3, '0') + '.png';
  const abs = path.join(lectureDir(seriesDirPath, n), ...rel.split('/'));
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile() || stat.size <= 0) return null;
  } catch {
    return null;
  }
  return abs;
}

function imageAbs(seriesDirPath, n, rel) {
  const text = String(rel || '');
  if (!IMAGE_RE.test(text)) return '';
  const abs = path.join(lectureDir(seriesDirPath, n), ...text.split('/'));
  return abs;
}

/* ------------------------------ 作业 ------------------------------ */

const jobs = new Map();
const activeBySeries = new Map();

function nowIso() {
  return new Date().toISOString();
}

function jobFile(found) {
  return path.join(found.dir, JOB_FILE);
}

function pruneJobs() {
  const finished = Array.from(jobs.values()).filter((job) => !job.active);
  finished.sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')));
  for (const job of finished.slice(10)) jobs.delete(job.seriesId);
}

function publicJob(job) {
  return {
    ok: true,
    seriesId: job.seriesId,
    bookId: job.bookId,
    provider: 'comfyui',
    status: job.status,
    stage: job.status === 'running' ? 'imaging' : 'done',
    lecture: job.lecture || 0,
    current: Number(job.current) || 0,
    total: Number(job.total) || 0,
    done: Number(job.done) || 0,
    failed: Number(job.failed) || 0,
    message: String(job.message || ''),
    code: job.code || null,
    error: job.error || null,
    startedAt: job.startedAt || '',
    finishedAt: job.finishedAt || '',
    live: !!job.active,
  };
}

function writeJobFile(job, patch) {
  if (job.forgotten) return;
  try {
    writeJson(
      jobFile(job.found),
      Object.assign(
        {
          seriesId: job.seriesId,
          bookId: job.bookId,
          provider: 'comfyui',
          status: job.status,
          stage: 'imaging',
          lecture: job.lecture,
          current: job.current,
          total: job.total,
          done: job.done,
          failed: job.failed,
          message: job.message,
          code: job.code || null,
          error: job.error || null,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          targets: job.targets,
        },
        patch || {},
      ),
    );
  } catch {
    /* 进度写盘失败不该打断出图 */
  }
}

/** 扫已就绪讲的全部正文页，得到真实的配图汇总（单页作业不能把 total 算成 1）。 */
function summarizeImages(found) {
  let total = 0;
  let ready = 0;
  let failed = 0;
  for (const lecture of found.series.lectures || []) {
    if (!READY.includes(String(lecture.status))) continue;
    const doc = loadSlides(found, lecture.n);
    if (!doc) continue;
    for (const item of doc.slidesDoc.slides) {
      if (String(item.layout || '') !== 'content_text') continue;
      total += 1;
      if (item.image_status === 'ready' && item.image_file) ready += 1;
      else if (item.image_status === 'failed') failed += 1;
    }
  }
  return { total, ready, failed };
}

function saveSummary(found, job) {
  try {
    const counts = summarizeImages(found);
    const active = ['queued', 'running', 'cancelling'].includes(String(job.status || ''));
    let status;
    if (active) status = job.status === 'queued' ? 'queued' : 'running';
    else if (!counts.total) status = 'none';
    else if (counts.ready === counts.total) status = 'done';
    else if (counts.ready > 0) status = 'partial';
    else if (counts.failed > 0) status = 'failed';
    else status = 'none';
    found.series.images = Object.assign(
      {},
      found.series.images && typeof found.series.images === 'object' ? found.series.images : {},
      {
        provider: 'comfyui',
        total: counts.total,
        done: counts.ready,
        failed: counts.failed,
        status,
        code: job.code || null,
        error: job.error ? job.error.message : null,
        updatedAt: nowIso(),
      },
    );
    persistSeries(found.series);
  } catch {
    /* 汇总写不进去只影响列表显示 */
  }
}

function loadSlides(found, n) {
  const doc = loadLecture(found.dir, n);
  if (!doc.exists || !doc.slidesDoc || !Array.isArray(doc.slidesDoc.slides)) return null;
  return doc;
}

function saveSlides(doc) {
  try {
    writeJson(path.join(doc.dir, 'slides.json'), doc.slidesDoc);
    return true;
  } catch {
    return false;
  }
}

function stylePrompt(prompt, suffix) {
  const base = String(prompt || '').trim();
  const extra = String(suffix || '').trim();
  if (!base) return '';
  if (!extra || base.includes(extra)) return base;
  return base.replace(/[，,。.\s]+$/, '') + '，' + extra;
}

function isRetryable(code) {
  return code === 'E_IMG_CONNECT' || code === 'E_IMG_TIMEOUT' || code === 'E_IMG_BAD_RESPONSE';
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

export function activeImageJob(seriesId) {
  const job = activeBySeries.get(String(seriesId || ''));
  return job && job.active ? job : null;
}

export function hasActiveImageJob() {
  for (const job of jobs.values()) if (job.active) return true;
  return false;
}

export function isImageJobActive(seriesId) {
  return !!activeImageJob(seriesId);
}

export function cancelImageJobsForSeries(seriesId) {
  const job = jobs.get(String(seriesId || ''));
  if (!job || !job.active) return false;
  job.cancelled = true;
  job.status = 'cancelling';
  job.message = '正在取消…';
  try {
    job.controller.abort();
  } catch {
    /* 已经结束 */
  }
  return true;
}

export function cancelImageJobsForBook(bookId) {
  let cancelled = 0;
  for (const job of jobs.values()) {
    if (!job.active || String(job.bookId) !== String(bookId || '')) continue;
    if (cancelImageJobsForSeries(job.seriesId)) cancelled += 1;
  }
  return cancelled;
}

/**
 * 启动（或续跑）一个系列的配图作业。
 * - force：忽略「已 ready 跳过」，全部重出；
 * - reset：先清空该讲 images/ 并把 image_nonce 归零，再重出（长按 3s 的「强制」）；
 * - slide：只跑该页（单页「换一张」）。
 * @param {{seriesId:string, lecture?:number, slide?:number, force?:boolean, reset?:boolean, options?:object}} input
 */
export function startImageJob({ seriesId, lecture = null, slide = null, force = false, reset = false, options = {} }) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new ImageError('E_NOT_FOUND', '找不到这个系列', '刷新列表后再试。');
  const config = readImageConfig();
  if (config.provider !== 'comfyui') {
    throw new ImageError('E_IMG_DISABLED', '当前配图策略是「提示词占位」', '先到设置 → 配图切到「本地 ComfyUI」。');
  }
  if (activeImageJob(found.series.id)) {
    throw new ImageError('E_IMG_BUSY', '配图作业正在跑', '等这次补图完成，或取消后再试。');
  }
  let ctx;
  try {
    ctx = workflowContext();
  } catch (err) {
    throw new ImageError((err && err.code) || 'E_IMG_WORKFLOW', String((err && err.message) || err), (err && err.hint) || '');
  }
  if (!ctx.promptNode) {
    throw new ImageError('E_IMG_WORKFLOW_NODE', '工作流没认出提示词节点', '到「提示词节点」里选一个再试。');
  }

  const scope = (found.series.lectures || [])
    .filter((item) => READY.includes(String(item.status)))
    .map((item) => Number(item.n))
    .filter((n) => (lecture == null ? true : Number(n) === Number(lecture)));
  if (!scope.length) throw new ImageError('E_LECTURE_EMPTY', '这个系列还没有就绪的讲', '先生成讲义。');

  const only = slide == null ? null : Number(slide);
  if (only != null) {
    let hit = false;
    for (const n of scope) {
      const doc = loadSlides(found, n);
      if (!doc) continue;
      if (doc.slidesDoc.slides.some((item) => Number(item.slide_index) === only && String(item.layout || '') === 'content_text')) {
        hit = true;
        break;
      }
    }
    if (!hit) {
      throw new ImageError('E_NOT_FOUND', '这一页不是正文页，或不属于该讲', '确认讲次与页码后再试。');
    }
  }

  // 「强制重新配图」：清掉旧图、种子归零，再全量重出
  if (reset) {
    for (const n of scope) {
      const doc = loadSlides(found, n);
      if (!doc) continue;
      try {
        fs.rmSync(path.join(doc.dir, 'images'), { recursive: true, force: true });
      } catch {
        /* 目录不存在或删不掉：交给覆盖写 */
      }
      for (const item of doc.slidesDoc.slides) {
        item.image_nonce = 0;
        item.image_file = null;
        item.image_status = 'none';
        item.image_error = null;
      }
      saveSlides(doc);
    }
  }

  const docs = new Map();
  const targets = [];
  for (const n of scope) {
    const doc = loadSlides(found, n);
    if (!doc) continue;
    docs.set(n, doc);
    for (const item of doc.slidesDoc.slides) {
      const index = Number(item.slide_index) || 0;
      if (String(item.layout || '') !== 'content_text') {
        item.image_status = 'none';
        item.image_file = null;
        continue;
      }
      if (only != null && index !== only) continue;
      if (only == null && !force && item.image_status === 'ready' && item.image_file) continue;
      if (!String(item.image_prompt || '').trim()) {
        item.image_status = 'failed';
        item.image_file = null;
        item.image_error = 'E_IMG_PROMPT：这一页没有提示词';
        continue;
      }
      targets.push({ n, i: index });
    }
    saveSlides(doc);
  }
  if (!targets.length) {
    throw new ImageError('E_IMG_NOTHING', '没有需要补的配图', '正文页都已就绪，或这一页不是正文页。');
  }

  const workflowHash = workflowHashOf(ctx.store.workflow);
  for (const target of targets) {
    const doc = docs.get(target.n);
    const item = doc.slidesDoc.slides.find((slideItem) => Number(slideItem.slide_index) === target.i);
    if (!item) continue;
    if (only != null || force) item.image_nonce = (Number(item.image_nonce) || 0) + 1;
    // 「强制重新配图」必须真的重跑 ComfyUI：删掉该种子对应的缓存，否则 reset 会命中旧图
    if (reset) {
      try {
        const prompt = stylePrompt(item.image_prompt, config.styleSuffix);
        const seed = seedFor(prompt, workflowHash, item.image_nonce);
        fs.rmSync(imageCachePath(imageCacheKey(prompt, workflowHash, seed)), { force: true });
      } catch {
        /* 缓存删不掉不影响重出 */
      }
    }
    item.image_status = 'queued';
    item.image_provider = 'comfyui';
    item.image_error = null;
    saveSlides(doc);
  }

  const job = {
    seriesId: found.series.id,
    bookId: found.series.book_id,
    found,
    docs,
    targets,
    status: 'queued',
    stage: 'queued',
    lecture: 0,
    current: 0,
    total: targets.length,
    done: 0,
    failed: 0,
    message: targets.length + ' 页配图排队中',
    code: null,
    error: null,
    startedAt: nowIso(),
    finishedAt: '',
    cancelled: false,
    active: true,
    forgotten: false,
    controller: null,
    workflow: { source: ctx.store.source, name: ctx.store.name, hash: workflowHashOf(ctx.store.workflow) },
  };
  jobs.set(job.seriesId, job);
  activeBySeries.set(job.seriesId, job);
  saveSummary(found, job);
  writeJobFile(job);
  pruneJobs();

  job.promise = runImageJob(job, ctx, options)
    .catch((err) => {
      job.status = 'failed';
      job.code = (err && err.code) || 'E_IMG_FAIL';
      job.error = { code: job.code, message: String((err && err.message) || err).slice(0, 300) };
      job.message = job.error.message;
      job.finishedAt = nowIso();
      saveSummary(found, job);
      writeJobFile(job, { status: 'failed', code: job.code, error: job.message, finishedAt: job.finishedAt });
    })
    .finally(() => {
      job.active = false;
      job.controller = null;
      activeBySeries.delete(job.seriesId);
      pruneJobs();
    });
  return publicJob(job);
}

async function runImageJob(job, ctx, options) {
  const config = ctx.config;
  const workflow = ctx.store.workflow;
  const hash = workflowHashOf(workflow);
  const controller = new AbortController();
  job.controller = controller;
  const budgetDeadline = Date.now() + IMAGE_MODULE_BUDGET_MS;
  const fetchImpl = options && options.fetchImpl;

  job.status = 'running';
  job.message = '正在连接 ComfyUI';
  saveSummary(job.found, job);
  writeJobFile(job, { status: 'running' });

  try {
    const probe = await probeComfy({ config, workflow, signal: controller.signal, fetchImpl });
    if (probe.missing.length) {
      throw new ImageError(
        'E_IMG_MODEL_MISSING',
        'ComfyUI 缺少工作流需要的模型：' + probe.missing.slice(0, 3).join('；'),
        '先在 ComfyUI 里装好这些模型，或换一份工作流。',
      );
    }
  } catch (err) {
    if (job.cancelled) {
      finishCancelled(job);
      return;
    }
    const code = (err && err.code) || 'E_IMG_CONNECT';
    const message = String((err && err.message) || err);
    markTargets(job, 'failed', code, message);
    finishJob(job, 'failed', code, message);
    return;
  }

  let firstError = null;
  for (let index = 0; index < job.targets.length; index += 1) {
    if (job.cancelled) break;
    const target = job.targets[index];
    const doc = job.docs.get(target.n);
    const slide = doc && doc.slidesDoc.slides.find((item) => Number(item.slide_index) === target.i);
    if (!slide) continue;
    job.lecture = target.n;
    if (Date.now() > budgetDeadline) {
      slide.image_status = 'failed';
      slide.image_file = null;
      slide.image_error = 'E_IMG_TIMEOUT：配图总时长超过 ' + Math.round(IMAGE_MODULE_BUDGET_MS / 60000) + ' 分钟，可稍后单独补';
      job.failed += 1;
      if (!firstError) firstError = { code: 'E_IMG_TIMEOUT', message: slide.image_error };
      saveSlides(doc);
      continue;
    }

    job.message = '第 ' + target.n + ' 讲 · 正在生成配图 ' + (index + 1) + '/' + job.targets.length + '（第 ' + target.i + ' 页）';
    writeJobFile(job, { current: index, message: job.message });

    const prompt = stylePrompt(slide.image_prompt, config.styleSuffix);
    const seed = seedFor(prompt, hash, slide.image_nonce);
    const cacheKey = imageCacheKey(prompt, hash, seed);
    let buffer = null;
    try {
      buffer = readImageCache(cacheKey);
    } catch {
      buffer = null;
    }
    let lastError = null;
    if (!buffer) {
      for (let attempt = 0; attempt < 2 && !buffer; attempt += 1) {
        if (job.cancelled) break;
        try {
          const remaining = Math.max(15000, budgetDeadline - Date.now());
          const result = await generateImage({
            config,
            workflow,
            prompt,
            seed,
            promptNode: ctx.promptNode,
            signal: controller.signal,
            fetchImpl,
            timeoutMs: Math.min(IMAGE_TIMEOUT_MS, remaining),
          });
          buffer = result.buffer;
        } catch (err) {
          lastError = err;
          if (job.cancelled || !isRetryable(err && err.code) || attempt > 0) break;
          await sleep(1500, controller.signal);
        }
      }
    }
    if (job.cancelled) break;

    if (!buffer) {
      slide.image_status = 'failed';
      slide.image_file = null;
      slide.image_provider = 'comfyui';
      slide.image_error =
        String((lastError && lastError.code) || 'E_IMG_FAIL') + '：' + String((lastError && lastError.message) || '出图失败').slice(0, 200);
      job.failed += 1;
      if (!firstError) firstError = { code: (lastError && lastError.code) || 'E_IMG_FAIL', message: slide.image_error };
    } else {
      const rel = 'images/' + String(target.i).padStart(3, '0') + '.png';
      const abs = imageAbs(job.found.dir, target.n, rel);
      if (!abs) {
        slide.image_status = 'failed';
        slide.image_error = 'E_IMG_FAIL：图片路径不合法';
        job.failed += 1;
      } else {
        try {
          writeAtomic(abs, buffer);
          writeImageCache(cacheKey, buffer);
          slide.image_file = rel;
          slide.image_status = 'ready';
          slide.image_provider = 'comfyui';
          slide.image_seed = seed;
          slide.image_error = null;
          job.done += 1;
        } catch (err) {
          slide.image_status = 'failed';
          slide.image_file = null;
          slide.image_error = 'E_IMG_FAIL：写图失败 ' + String((err && err.message) || err).slice(0, 120);
          job.failed += 1;
        }
      }
    }
    job.current = index + 1;
    saveSlides(doc);
    saveSummary(job.found, job);
    writeJobFile(job, { current: job.current, done: job.done, failed: job.failed, message: job.message });
  }

  if (job.cancelled) {
    finishCancelled(job);
    return;
  }
  const status = job.failed === 0 ? 'done' : job.done === 0 ? 'failed' : 'partial';
  const code = status === 'done' ? null : (firstError && firstError.code) || 'E_IMG_FAIL';
  const message =
    status === 'done'
      ? '配图已就绪（' + job.done + ' 张）'
      : status === 'partial'
        ? '配图完成 ' + job.done + ' 张，' + job.failed + ' 张失败（可单独重试）'
        : '配图全部失败：' + String((firstError && firstError.message) || '');
  finishJob(job, status, code, message);
}

function markTargets(job, status, code, message) {
  for (const target of job.targets) {
    const doc = job.docs.get(target.n);
    if (!doc) continue;
    const slide = doc.slidesDoc.slides.find((item) => Number(item.slide_index) === target.i);
    if (!slide) continue;
    slide.image_status = status;
    slide.image_file = null;
    slide.image_provider = 'comfyui';
    slide.image_error = code + '：' + String(message || '').slice(0, 200);
    saveSlides(doc);
  }
  job.failed = job.targets.length;
}

function finishCancelled(job) {
  for (const target of job.targets) {
    const doc = job.docs.get(target.n);
    if (!doc) continue;
    const slide = doc.slidesDoc.slides.find((item) => Number(item.slide_index) === target.i);
    if (!slide || slide.image_status === 'ready') continue;
    slide.image_status = 'failed';
    slide.image_file = null;
    slide.image_error = 'E_IMG_CANCELLED：已取消';
    saveSlides(doc);
  }
  finishJob(job, 'cancelled', 'E_IMG_CANCELLED', '配图已取消');
}

function finishJob(job, status, code, message) {
  job.status = status;
  job.code = code || null;
  job.error = code ? { code, message: String(message || '') } : null;
  job.message = String(message || '');
  job.finishedAt = nowIso();
  saveSummary(job.found, job);
  writeJobFile(job, { status, code: job.code, error: job.message, finishedAt: job.finishedAt });
}

/** 状态：先看内存作业，再看 series/image-job.json；重启后残留的 running 归一为 interrupted。 */
export function getImageStatus(seriesId) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new ImageError('E_NOT_FOUND', '找不到这个系列', '');
  const live = jobs.get(found.series.id);
  if (live) return publicJob(live);
  const stored = readJson(jobFile(found), null);
  if (stored && (stored.status === 'queued' || stored.status === 'running' || stored.status === 'cancelling')) {
    const fixed = Object.assign({}, stored, {
      status: 'interrupted',
      stage: 'done',
      code: 'E_INTERRUPTED',
      error: '上次配图被中断（DSH 重启或进程退出），可以重新补',
      message: '上次配图被中断，可以重新补',
      live: false,
    });
    try {
      writeJson(jobFile(found), fixed);
      interruptStaleSlides(found);
      found.series.images = Object.assign({}, found.series.images || {}, {
        status: 'interrupted',
        code: 'E_INTERRUPTED',
        error: fixed.error,
        updatedAt: nowIso(),
      });
      persistSeries(found.series);
    } catch {
      /* 写不进去也照样回给面板 */
    }
    return Object.assign({ ok: true, seriesId: found.series.id, live: false }, fixed);
  }
  if (stored) return Object.assign({ ok: true, seriesId: found.series.id, live: false }, stored);
  const summary = found.series.images || {};
  return {
    ok: true,
    seriesId: found.series.id,
    provider: summary.provider || 'none',
    status: summary.status || 'none',
    lecture: 0,
    current: 0,
    total: Number(summary.total) || 0,
    done: Number(summary.done) || 0,
    failed: Number(summary.failed) || 0,
    message: '',
    code: summary.code || null,
    error: summary.error || null,
    live: false,
  };
}

function interruptStaleSlides(found) {
  for (const lecture of found.series.lectures || []) {
    const doc = loadSlides(found, lecture.n);
    if (!doc) continue;
    let touched = false;
    for (const slide of doc.slidesDoc.slides) {
      if (!['pending', 'queued', 'running'].includes(String(slide.image_status || ''))) continue;
      slide.image_status = 'failed';
      slide.image_file = null;
      slide.image_error = 'E_INTERRUPTED：配图上一次没跑完，点「补配图」重试';
      touched = true;
    }
    if (touched) saveSlides(doc);
  }
}

/** 启动归一：把上次没跑完的作业标成 interrupted。 */
export function reconcileImageJobs() {
  let books = [];
  try {
    books = fs.readdirSync(BOOKS_DIR(), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return;
  }
  for (const bookId of books) {
    const seriesRoot = path.join(BOOKS_DIR(), bookId, 'series');
    let ids = [];
    try {
      ids = fs.readdirSync(seriesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (jobs.has(id)) continue;
      const found = findSeries(id);
      if (!found) continue;
      const stored = readJson(jobFile(found), null);
      if (!stored || !['queued', 'running', 'cancelling'].includes(String(stored.status))) continue;
      const fixed = Object.assign({}, stored, {
        status: 'interrupted',
        stage: 'done',
        code: 'E_INTERRUPTED',
        error: '上次配图被中断（DSH 重启或进程退出），可以重新补',
        message: '上次配图被中断，可以重新补',
        finishedAt: nowIso(),
      });
      try {
        writeJson(jobFile(found), fixed);
        interruptStaleSlides(found);
        found.series.images = Object.assign({}, found.series.images || {}, {
          status: 'interrupted',
          code: 'E_INTERRUPTED',
          error: fixed.error,
          updatedAt: nowIso(),
        });
        persistSeries(found.series);
      } catch {
        /* 坏数据不能挡插件启动 */
      }
    }
  }
}
