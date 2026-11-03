/**
 * 精讲台 · 配图作业（v1.4）
 *
 * 设计要点（与「出图时机」的结论一致）：
 *   - 模块先 ready（文字 + 语音），配图是**后台补图作业**，不阻塞播放；
 *   - 逐页状态写回 slides.json（image_status / image_file / image_seed），
 *     模块状态不改，只在 module.json.images 上记一份汇总；
 *   - 单页失败只影响该页，播放器回退到提示词占位卡；
 *   - 同一时间只跑一个配图作业，其它模块排队（ComfyUI 显存不是无限的）。
 *
 * 缓存与可复现：
 *   seed = sha256(prompt|工作流哈希|nonce) 取前 52 bit；同提示词同工作流同 nonce
 *   永远命中 image-cache，重新生成模块不会重复跑 GPU。单页「重新生成」把
 *   image_nonce +1，换一张新图。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BOOKS_DIR, isValidId, readJson, writeJson, writeAtomic } from './store.js';
import { loadModuleById } from './generate.js';
import {
  IMAGE_MODULE_BUDGET_MS,
  IMAGE_TIMEOUT_MS,
  IMAGE_CACHE_DIR,
  ImageError,
  baseUrlOf,
  generateImage,
  imageCacheKey,
  imageCachePath,
  probeComfy,
  readImageCache,
  readImageConfig,
  readWorkflowStore,
  seedFor,
  validateWorkflow,
  workflowHashOf,
  writeImageCache,
} from './comfy.js';

/** moduleId → job（跑完也留着，面板靠它看最后状态）。 */
const jobs = new Map();
/** 等 ComfyUI 的模块队列：一次只跑一个。 */
const queue = [];
let active = null;

function nowIso() {
  return new Date().toISOString();
}

function imageJobFile(moduleDir) {
  return path.join(moduleDir, 'image-job.json');
}

function imagesDir(moduleDir) {
  return path.join(moduleDir, 'images');
}

function imageRel(index) {
  return 'images/' + String(index).padStart(3, '0') + '.png';
}

export function imageAbsPath(moduleDir, rel) {
  const text = String(rel || '');
  if (!/^images\/\d{3}\.png$/.test(text)) return '';
  const abs = path.join(moduleDir, 'images', text.slice('images/'.length));
  const root = path.resolve(imagesDir(moduleDir)) + path.sep;
  if (!path.resolve(abs).startsWith(root)) return '';
  return abs;
}

function publicJob(job) {
  return {
    moduleId: job.moduleId,
    bookId: job.bookId,
    provider: 'comfyui',
    status: job.status,
    stage: job.status === 'running' ? 'imaging' : 'done',
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
      imageJobFile(job.moduleDir),
      Object.assign(
        {
          moduleId: job.moduleId,
          bookId: job.bookId,
          provider: 'comfyui',
          status: job.status,
          stage: 'imaging',
          current: job.current,
          total: job.total,
          done: job.done,
          failed: job.failed,
          message: job.message,
          code: job.code || null,
          error: job.error || null,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          workflow: job.workflowInfo || null,
        },
        patch || {},
      ),
    );
  } catch {
    /* 进度写盘失败不该打断出图 */
  }
}

function updateRecord(job, patch) {
  if (job.forgotten) return;
  try {
    const file = path.join(job.moduleDir, 'module.json');
    const record = readJson(file, null);
    if (!record || typeof record !== 'object') return;
    record.images = Object.assign(
      {
        provider: 'comfyui',
        total: job.total,
        done: job.done,
        failed: job.failed,
      },
      record.images && typeof record.images === 'object' ? record.images : {},
      patch || {},
      { updatedAt: nowIso() },
    );
    writeJson(file, record);
  } catch {
    /* 汇总写不进去只影响列表显示 */
  }
}

function persistSlides(job) {
  if (job.forgotten) return false;
  try {
    writeJson(path.join(job.moduleDir, 'slides.json'), job.slidesDoc);
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

/**
 * 启动（或续跑）一个模块的配图作业。
 * @param {{moduleId:string, force?:boolean, only?:number[], reason?:string}} options
 *   force=true  : 所有正文页重出，nonce+1（换图）
 *   force=false : 只补 pending / failed 的页
 *   only=[n]    : 只重出指定页（单页重生成）
 */
export function startImaging(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const moduleId = String(opts.moduleId || '').trim();
  if (!isValidId(moduleId)) return { ok: false, code: 'E_BAD_ID', message: 'moduleId 不合法' };

  const config = readImageConfig();
  if (config.provider !== 'comfyui') {
    return {
      ok: false,
      code: 'E_IMG_DISABLED',
      message: '当前配图策略是「提示词占位」，先到设置 → 配图切到「本地 ComfyUI」',
    };
  }

  const existing = jobs.get(moduleId);
  if (existing && (existing.status === 'queued' || existing.status === 'running')) {
    return { ok: true, running: true, job: publicJob(existing) };
  }

  const found = loadModuleById(moduleId);
  if (!found) return { ok: false, code: 'E_NOT_FOUND', message: '找不到这个模块' };
  const slidesDoc = found.slides;
  if (!slidesDoc || !Array.isArray(slidesDoc.slides) || !slidesDoc.slides.length) {
    return { ok: false, code: 'E_IMG_NOTHING', message: '这个模块还没有幻灯片数据' };
  }

  let workflowStore;
  let check;
  try {
    workflowStore = readWorkflowStore();
    check = validateWorkflow(workflowStore.workflow);
  } catch (err) {
    return { ok: false, code: (err && err.code) || 'E_IMG_WORKFLOW', message: String((err && err.message) || err) };
  }
  const promptNode = config.promptNode && check.candidates.some((item) => item.id === config.promptNode)
    ? config.promptNode
    : check.promptNode;
  if (!promptNode) {
    return { ok: false, code: 'E_IMG_WORKFLOW_NODE', message: '工作流没认出提示词节点，先到设置 → 配图里选一个' };
  }

  const only = Array.isArray(opts.only) ? new Set(opts.only.map((n) => Math.round(Number(n) || 0))) : null;
  const force = opts.force === true;
  const targets = [];
  for (const slide of slidesDoc.slides) {
    const index = Number(slide.slide_index) || 0;
    if (String(slide.layout || '') !== 'content_text') {
      slide.image_status = 'none';
      slide.image_file = null;
      slide.image_provider = null;
      continue;
    }
    if (only && !only.has(index)) continue;
    if (!only && !force && slide.image_status === 'ready' && slide.image_file) continue;
    if (!String(slide.image_prompt || '').trim()) {
      slide.image_status = 'failed';
      slide.image_error = 'E_IMG_PROMPT：这一页没有提示词';
      slide.image_file = null;
      continue;
    }
    targets.push(index);
  }

  if (!targets.length) {
    return { ok: false, code: 'E_IMG_NOTHING', message: '没有需要补的配图（正文页都已就绪）' };
  }

  for (const index of targets) {
    const slide = slidesDoc.slides.find((item) => Number(item.slide_index) === index);
    if (!slide) continue;
    if (only || force) slide.image_nonce = (Number(slide.image_nonce) || 0) + 1;
    slide.image_status = 'queued';
    slide.image_provider = 'comfyui';
    slide.image_error = null;
  }
  persistSlides(found.moduleDir);

  const job = {
    moduleId: moduleId,
    bookId: found.bookId,
    moduleDir: found.moduleDir,
    slidesDoc: slidesDoc,
    targets: targets,
    status: 'queued',
    current: 0,
    total: targets.length,
    done: 0,
    failed: 0,
    message: targets.length + ' 页配图排队中',
    code: null,
    error: null,
    startedAt: nowIso(),
    finishedAt: '',
    controller: null,
    cancelled: false,
    active: true,
    promise: null,
    workflowInfo: { source: workflowStore.source, name: workflowStore.name, hash: workflowHashOf(workflowStore.workflow) },
  };
  jobs.set(moduleId, job);
  queue.push(job);
  updateRecord(job, { status: 'queued', total: job.total, done: 0, failed: 0, code: null, error: null });
  writeJobFile(job);
  pump();
  return { ok: true, job: publicJob(job), queued: true };
}

function pump() {
  if (active || !queue.length) return;
  const job = queue.shift();
  active = job;
  job.promise = runImagingJob(job)
    .catch((err) => {
      job.status = 'failed';
      job.code = (err && err.code) || 'E_IMG_FAIL';
      job.error = String((err && err.message) || err).slice(0, 300);
      job.message = job.error;
      job.finishedAt = nowIso();
      job.active = false;
      updateRecord(job, { status: 'failed', code: job.code, error: job.error, finishedAt: job.finishedAt });
      writeJobFile(job, { status: 'failed', code: job.code, error: job.error, finishedAt: job.finishedAt });
    })
    .finally(() => {
      active = null;
      job.active = false;
      pump();
    });
}

async function runImagingJob(job) {
  if (job.cancelled) {
    finishCancelled(job);
    return;
  }
  job.status = 'running';
  job.startedAt = job.startedAt || nowIso();
  job.message = '正在连接 ComfyUI';
  updateRecord(job, { status: 'running' });
  writeJobFile(job, { status: 'running' });

  const config = readImageConfig();
  const workflowStore = readWorkflowStore();
  const workflow = workflowStore.workflow;
  const hash = workflowHashOf(workflow);
  const check = validateWorkflow(workflow);
  const promptNode =
    config.promptNode && check.candidates.some((item) => item.id === config.promptNode) ? config.promptNode : check.promptNode;
  job.workflowInfo = { source: workflowStore.source, name: workflowStore.name, hash: hash };

  const controller = new AbortController();
  job.controller = controller;
  const budgetDeadline = Date.now() + IMAGE_MODULE_BUDGET_MS;

  /* 开跑前先确认 ComfyUI 活着、模型在：不然 18 页会挨个失败一遍 */
  try {
    const probe = await probeComfy({ config: config, workflow: workflow, signal: controller.signal });
    if (probe.missing.length) {
      throw new ImageError(
        'E_IMG_MODEL_MISSING',
        'ComfyUI 缺少工作流需要的模型：' + probe.missing.slice(0, 3).join('；'),
        '先在 ComfyUI 里装好这些模型，或在设置里换一份工作流。',
      );
    }
  } catch (err) {
    if (job.cancelled) {
      finishCancelled(job);
      return;
    }
    const code = (err && err.code) || 'E_IMG_CONNECT';
    const text = String((err && err.message) || err);
    markAllFailed(job, code, text);
    finishJob(job, 'failed', code, text);
    return;
  }

  try {
    fs.mkdirSync(imagesDir(job.moduleDir), { recursive: true });
  } catch {
    /* 写图时还会再建 */
  }

  let firstError = null;
  for (let i = 0; i < job.targets.length; i += 1) {
    if (job.cancelled || job.forgotten) break;
    const index = job.targets[i];
    const slide = job.slidesDoc.slides.find((item) => Number(item.slide_index) === index);
    if (!slide) continue;
    if (Date.now() > budgetDeadline) {
      slide.image_status = 'failed';
      slide.image_error = 'E_IMG_TIMEOUT：配图总时长超过 ' + Math.round(IMAGE_MODULE_BUDGET_MS / 60000) + ' 分钟，可稍后单独补';
      slide.image_file = null;
      job.failed += 1;
      if (!firstError) firstError = { code: 'E_IMG_TIMEOUT', message: slide.image_error };
      persistSlides(job);
      continue;
    }

    job.message = '正在生成配图 ' + (i + 1) + '/' + job.targets.length + '（第 ' + index + ' 页）';
    updateRecord(job, { status: 'running', done: job.done, failed: job.failed });
    writeJobFile(job, { current: i, message: job.message });

    const prompt = stylePrompt(slide.image_prompt, config.styleSuffix);
    const seed = seedFor(prompt, hash, slide.image_nonce);
    const cacheKey = imageCacheKey(prompt, hash, seed);
    let buffer = readImageCache(cacheKey);
    let lastError = null;

    if (!buffer) {
      for (let attempt = 0; attempt < 2 && !buffer; attempt += 1) {
        if (job.cancelled || job.forgotten) break;
        try {
          const remaining = Math.max(15000, budgetDeadline - Date.now());
          const result = await generateImage({
            config: config,
            workflow: workflow,
            prompt: prompt,
            seed: seed,
            promptNode: promptNode,
            signal: controller.signal,
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

    if (job.cancelled || job.forgotten) break;

    if (!buffer) {
      slide.image_status = 'failed';
      slide.image_file = null;
      slide.image_provider = 'comfyui';
      slide.image_error =
        String((lastError && lastError.code) || 'E_IMG_FAIL') + '：' + String((lastError && lastError.message) || '出图失败').slice(0, 200);
      job.failed += 1;
      if (!firstError) firstError = { code: (lastError && lastError.code) || 'E_IMG_FAIL', message: slide.image_error };
    } else {
      const rel = imageRel(index);
      const abs = imageAbsPath(job.moduleDir, rel);
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

    job.current = i + 1;
    persistSlides(job);
    updateRecord(job, { status: 'running', done: job.done, failed: job.failed });
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

function finishCancelled(job) {
  for (const index of job.targets) {
    const slide = job.slidesDoc.slides.find((item) => Number(item.slide_index) === index);
    if (slide && slide.image_status !== 'ready') {
      slide.image_status = 'failed';
      slide.image_file = null;
      slide.image_error = 'E_IMG_CANCELLED：已取消';
    }
  }
  persistSlides(job);
  finishJob(job, 'cancelled', 'E_IMG_CANCELLED', '配图已取消');
}

function markAllFailed(job, code, message) {
  for (const index of job.targets) {
    const slide = job.slidesDoc.slides.find((item) => Number(item.slide_index) === index);
    if (!slide) continue;
    slide.image_status = 'failed';
    slide.image_file = null;
    slide.image_provider = 'comfyui';
    slide.image_error = code + '：' + String(message || '').slice(0, 200);
  }
  job.failed = job.targets.length;
  job.error = {
    code: code,
    message: String(message || '').slice(0, 300),
    hint: '配图失败不影响文字与语音；修好 ComfyUI 后可在模块上点「补配图」。',
  };
  persistSlides(job);
}

function finishJob(job, status, code, message) {
  job.status = status;
  job.code = code || null;
  job.error = code ? { code: code, message: String(message || ''), hint: job.error && job.error.hint ? job.error.hint : '' } : null;
  job.message = String(message || '');
  job.finishedAt = nowIso();
  updateRecord(job, {
    status: status,
    done: job.done,
    failed: job.failed,
    code: job.code,
    error: job.code ? job.message : null,
    finishedAt: job.finishedAt,
  });
  writeJobFile(job, { status: status, code: job.code, error: job.code ? job.message : null, finishedAt: job.finishedAt });
}

export function getImagingStatus(moduleId) {
  if (!isValidId(moduleId)) return { ok: false, code: 'E_BAD_ID', message: 'moduleId 不合法' };
  const live = jobs.get(moduleId);
  if (live) return Object.assign({ ok: true }, publicJob(live));

  const found = loadModuleById(moduleId);
  if (!found) return { ok: false, code: 'E_NOT_FOUND', message: '找不到这个模块' };
  const file = readJson(imageJobFile(found.moduleDir), null);
  if (file && (file.status === 'queued' || file.status === 'running')) {
    // 进程重启后没有内存作业了：归一为 interrupted，别让面板永远转圈
    const fixed = Object.assign({}, file, {
      moduleId: moduleId,
      status: 'interrupted',
      stage: 'done',
      code: 'E_INTERRUPTED',
      error: '上次配图被中断（DSH 重启或进程退出），可以重新补',
      message: '上次配图被中断，可以重新补',
      live: false,
    });
    try {
      writeJson(imageJobFile(found.moduleDir), fixed);
      updateRecord({ moduleDir: found.moduleDir, total: fixed.total, done: fixed.done, failed: fixed.failed }, {
        status: 'interrupted',
        code: 'E_INTERRUPTED',
        error: fixed.error,
      });
    } catch {
      /* 写不进去也照样回给面板 */
    }
    return Object.assign({ ok: true }, fixed);
  }
  if (file) return Object.assign({ ok: true, live: false, moduleId: moduleId }, file);
  const images = found.module && found.module.images;
  if (images && ['pending', 'queued', 'running'].includes(String(images.status))) {
    interruptStaleImages(found.moduleDir, found.module);
    return {
      ok: true,
      moduleId: moduleId,
      provider: 'comfyui',
      status: 'interrupted',
      total: Number(images.total) || 0,
      done: Number(images.done) || 0,
      failed: Number(images.failed) || 0,
      code: 'E_INTERRUPTED',
      error: '上次配图被中断，可以重新补',
      live: false,
    };
  }
  return Object.assign(
    {
      ok: true,
      moduleId: moduleId,
      provider: (images && images.provider) || 'none',
      status: (images && images.status) || 'none',
      total: (images && images.total) || 0,
      done: (images && images.done) || 0,
      failed: (images && images.failed) || 0,
      live: false,
    },
  );
}

/** 这本书有没有正在跑的配图作业（书档导出用它拦「导到一半」的包）。 */
export function bookHasImagingJob(bookId) {
  for (const job of jobs.values()) {
    if (String(job.bookId) !== String(bookId)) continue;
    if (job.status === 'queued' || job.status === 'running') return true;
  }
  return false;
}

/** 全局是否有配图作业在跑；设置页「测试生图」用它避免和补图抢 GPU。 */
export function hasActiveImagingJob() {
  for (const job of jobs.values()) {
    if (job.status === 'queued' || job.status === 'running') return true;
  }
  return false;
}

/** 把「没有作业却还标着 pending/queued/running」的配图归一为失败，避免面板永远转圈。 */
function interruptStaleImages(moduleDir, record) {
  if (!record || !record.images || typeof record.images !== 'object') return;
  if (!['pending', 'queued', 'running'].includes(String(record.images.status))) return;
  try {
    const slidesFile = path.join(moduleDir, 'slides.json');
    const slidesDoc = readJson(slidesFile, null);
    if (slidesDoc && Array.isArray(slidesDoc.slides)) {
      for (const slide of slidesDoc.slides) {
        if (!slide) continue;
        if (['pending', 'queued', 'running'].includes(String(slide.image_status || ''))) {
          slide.image_status = 'failed';
          slide.image_file = null;
          slide.image_error = 'E_INTERRUPTED：配图上一次没跑完，点「补配图」重试';
        }
      }
      writeJson(slidesFile, slidesDoc);
    }
  } catch {
    /* 写不进去也要让列表看到 interrupted */
  }
  record.images.status = 'interrupted';
  record.images.code = 'E_INTERRUPTED';
  record.images.error = '上次配图被中断（DSH 重启或进程退出），可以重新补';
  record.images.updatedAt = nowIso();
  try {
    writeJson(path.join(moduleDir, 'module.json'), record);
  } catch {
    /* 同上 */
  }
}

export function cancelImaging(moduleId) {
  const job = jobs.get(moduleId);
  if (job && job.status === 'queued') {
    const index = queue.indexOf(job);
    if (index >= 0) queue.splice(index, 1);
    job.cancelled = true;
    finishCancelled(job);
    return true;
  }
  if (job && job.status === 'running') {
    job.cancelled = true;
    if (job.controller) {
      try {
        job.controller.abort();
      } catch {
        /* 已经结束 */
      }
    }
    return true;
  }
  return false;
}

export function forgetModule(moduleId) {
  const job = jobs.get(moduleId);
  if (job) job.forgotten = true;
  cancelImaging(moduleId);
  jobs.delete(moduleId);
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].moduleId === moduleId) queue.splice(i, 1);
  }
}

/** 启动时把上次没跑完的配图作业标成 interrupted（只扫 image-job.json，不读 PDF）。 */
export function reconcileImagingJobs() {
  let books = [];
  try {
    books = fs.readdirSync(BOOKS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return;
  }
  for (const bookId of books) {
    if (!isValidId(bookId)) continue;
    const modulesDir = path.join(BOOKS_DIR, bookId, 'modules');
    let modules = [];
    try {
      modules = fs.readdirSync(modulesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const moduleId of modules) {
      if (!isValidId(moduleId) || jobs.has(moduleId)) continue;
      const moduleDir = path.join(modulesDir, moduleId);
      const file = readJson(imageJobFile(moduleDir), null);
      if (!file || (file.status !== 'queued' && file.status !== 'running')) {
        // 没有活作业却还挂着 pending/queued/running：多半是 ready 之后、起作业之前进程退了
        const record = readJson(path.join(moduleDir, 'module.json'), null);
        if (record && ['ready', 'ready_degraded'].includes(String(record.status))) {
          interruptStaleImages(moduleDir, record);
        }
        continue;
      }
      const fixed = Object.assign({}, file, {
        moduleId: moduleId,
        status: 'interrupted',
        stage: 'done',
        message: '上次配图被中断，可以重新补',
        code: 'E_INTERRUPTED',
        error: '上次配图被中断（DSH 重启或进程退出），可以重新补',
        finishedAt: nowIso(),
      });
      try {
        writeJson(imageJobFile(moduleDir), fixed);
        updateRecord({ moduleDir: moduleDir, total: fixed.total, done: fixed.done, failed: fixed.failed }, {
          status: 'interrupted',
          code: 'E_INTERRUPTED',
          error: fixed.error,
        });
      } catch {
        /* 坏模块不能挡插件启动 */
      }
    }
  }
}

export { IMAGE_CACHE_DIR, imageCachePath, baseUrlOf };
