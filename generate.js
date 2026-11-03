/**
 * 精讲台 · 生成流水线（M3）
 *
 * 一次生成 = 一个异步作业，四阶段（§5.4）：
 *   structuring → validate → anchor → voicing → ready / ready_degraded
 *   任一步不可恢复 → failed；用户取消 → cancelled；DSH 中途退出 → interrupted
 *
 * 这里只做「作业」这一层：
 *   - 什么时候调模型、调几次（JSON 重试 / 结构修复 / 锚点修复）
 *   - 进度、取消、幂等缓存、失败码
 *   - 把 module.json / slides.json 原子落盘
 * 文案规则、校验规则、锚点算法都在 slides.js（纯函数，可单测）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  BOOKS_DIR,
  existingBookDir,
  isValidId,
  newId,
  readJson,
  sha256Of,
  writeJson,
} from './store.js';
import {
  SLIDES_PROMPT_VERSION,
  anchorSlides,
  applyAnchorFixes,
  buildAnchorRepairUser,
  buildRepairMessages,
  buildSlidesMessages,
  expectedSlides,
  formatSlideErrors,
  mergeBatchSlides,
  moduleTextOf,
  moduleTitleOf,
  normalizeSlide,
  parseAnchorFixes,
  parseSlidesReply,
  planBatches,
  validateSlideSet,
  validateSlides,
} from './slides.js';
import { describeEmptyReply } from './tocparse.js';
import { synthesizeVoicing } from './tts.js';

/** 和面板、SRS 5.1 保持同一组上限。 */
export const MAX_MODULE_CHAPTERS = 5;
export const MAX_MODULE_CHARS = 60000;

/** 取消要能穿透正在 stream 的模型调用，所以每次生成带自己的 AbortController。 */
const ACTIVE_STATUS = ['queued', 'structuring', 'validate', 'anchor', 'voicing'];
const TERMINAL_STATUS = ['ready', 'ready_degraded', 'failed', 'cancelled', 'interrupted'];

const LLM_MAX_TOKENS = 16000;
const LLM_RETRY_MAX_TOKENS = 32000;
const ANCHOR_MAX_TOKENS = 8000;
const ANCHOR_REPAIR_THRESHOLD = 0.9;
const ANCHOR_REPAIR_TEXT_LIMIT = 20000;

/** 作业表：moduleId → job。跑完也留着，面板靠它拿到最终状态。 */
const jobs = new Map();

export class GenerateError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'GenerateError';
    this.code = code;
    this.hint = hint || '';
  }
}

/* ------------------------------ 选择与缓存键 ------------------------------ */

/**
 * 校验勾选结果并返回按章号排序的章节。
 * 章数/字数上限是 D11 的硬约束：失败要发生在点按钮前后，而不是生成到一半。
 */
export function validateSelection(chapters, rawNs) {
  const ns = Array.from(
    new Set(
      (Array.isArray(rawNs) ? rawNs : [])
        .map((n) => Math.round(Number(n) || 0))
        .filter((n) => n > 0),
    ),
  ).sort((a, b) => a - b);
  if (!ns.length) throw new GenerateError('E_SELECTION_EMPTY', '先勾选至少一章', '在章节列表里勾 1–5 章。');

  const byN = new Map(
    (Array.isArray(chapters) ? chapters : [])
      .filter((chapter) => chapter && !chapter.front)
      .map((chapter) => [Math.round(Number(chapter.n) || 0), chapter]),
  );
  const picked = [];
  for (const n of ns) {
    const chapter = byN.get(n);
    if (!chapter) throw new GenerateError('E_NO_CHAPTER', '没有第 ' + n + ' 章', '章节可能刚被重切过，刷新一下再选。');
    if (chapter.hidden) throw new GenerateError('E_CHAPTER_HIDDEN', '第 ' + n + ' 章已被排除', '恢复本章后才能生成。');
    if ((Number(chapter.chars) || 0) < 50) throw new GenerateError('E_CHAPTER_EMPTY', '第 ' + n + ' 章是空白页', '空白章节不能生成，换一章。');
    picked.push(chapter);
  }

  const chars = picked.reduce((sum, chapter) => sum + (Number(chapter.chars) || 0), 0);
  if (picked.length > MAX_MODULE_CHAPTERS || chars > MAX_MODULE_CHARS) {
    throw new GenerateError(
      'E_SELECTION_TOO_LARGE',
      '最多 ' + MAX_MODULE_CHAPTERS + ' 章、' + MAX_MODULE_CHARS / 10000 + ' 万字',
      '当前已选 ' + picked.length + ' 章、约 ' + Math.round(chars / 1000) / 10 + ' 万字。',
    );
  }
  return { chapters: picked, chars: chars };
}

/**
 * 模块缓存键（D13）：书 + 章节列表 + 模型 + 提示词版本。
 * 音色/语速不进键——换了音色不该重花模型调用（音频另有缓存）。
 */
export function moduleCacheKey(bookId, chapters, model, promptVersion) {
  const list = (Array.isArray(chapters) ? chapters : []).map((chapter) => Math.round(Number(chapter.n) || 0)).join(',');
  return sha256Of(
    Buffer.from([String(bookId || ''), list, String(model || ''), String(promptVersion || SLIDES_PROMPT_VERSION)].join('|'), 'utf8'),
  );
}

/* ------------------------------ 目录与记录 ------------------------------ */

function moduleJsonFile(moduleDir) {
  return path.join(moduleDir, 'module.json');
}

function slidesJsonFile(moduleDir) {
  return path.join(moduleDir, 'slides.json');
}

/* 结构化阶段的批次检查点：取消/失败后重试只补没跑完的批，不再重花模型调用。 */
function batchesDir(moduleDir) {
  return path.join(moduleDir, 'batches');
}

function checkpointFile(moduleDir, index) {
  return path.join(batchesDir(moduleDir), String(index).padStart(2, '0') + '.json');
}

function readCheckpoint(moduleDir, index, batchHash) {
  const data = readJson(checkpointFile(moduleDir, index), null);
  if (!data || data.batchHash !== batchHash || !Array.isArray(data.slides) || !data.slides.length) return null;
  return data;
}

function writeCheckpoint(moduleDir, index, batchHash, result) {
  try {
    writeJson(checkpointFile(moduleDir, index), {
      batchHash: batchHash,
      moduleTitle: result.moduleTitle || '',
      slides: result.slides,
      savedAt: nowIso(),
    });
  } catch {
    /* 检查点写不进去只影响重试成本，不影响本次生成 */
  }
}

function nowIso() {
  return new Date().toISOString();
}

function moduleSummary(record, id) {
  const voice = record.voice || {};
  return {
    id: id || record.id,
    title: String(record.title || '未命名精讲'),
    status: String(record.status || 'queued'),
    stage: String(record.stage || ''),
    message: String(record.message || ''),
    slides: Number(record.slides) || 0,
    chapters: Array.isArray(record.chapters) ? record.chapters : [],
    chapterTitles: Array.isArray(record.chapterTitles) ? record.chapterTitles : [],
    anchorHitRate: Number(record.anchorHitRate) || 0,
    anchored: Number(record.anchored) || 0,
    code: record.code || null,
    error: record.error || null,
    model: record.model || '',
    voice: {
      provider: voice.provider || 'browser',
      model: voice.model || '',
      rate: Number(voice.rate) || 1,
      voice: voice.voice || '',
      mode: voice.mode || '',
    },
    createdAt: record.createdAt || '',
    updatedAt: record.updatedAt || record.createdAt || '',
    finishedAt: record.finishedAt || '',
  };
}

/**
 * 启动时（或首次读到时）把「上次没跑完」的模块标成 interrupted。
 * 只认内存里没有活作业的那些——正在跑的不能误判。
 */
function reconcileRecord(record, moduleId, moduleDir) {
  if (!record || typeof record !== 'object') return null;
  if (ACTIVE_STATUS.includes(String(record.status)) && !jobs.has(moduleId)) {
    record.status = 'interrupted';
    record.stage = 'done';
    record.code = 'E_INTERRUPTED';
    record.error = '上次生成被中断（DSH 重启或进程退出），可以重试';
    record.message = record.error;
    record.updatedAt = nowIso();
    try {
      writeJson(moduleJsonFile(moduleDir), record);
    } catch {
      /* 写不进去也要让面板看到 interrupted */
    }
  }
  return record;
}

/** 一本书的模块列表（供 /book 与书架详情用）。 */
export function listModules(bookId) {
  const bookDir = existingBookDir(bookId);
  if (!bookDir) return [];
  const modulesDir = path.join(bookDir, 'modules');
  let names = [];
  try {
    names = fs.readdirSync(modulesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const out = [];
  for (const id of names) {
    if (!isValidId(id)) continue;
    const dir = path.join(modulesDir, id);
    const record = reconcileRecord(readJson(moduleJsonFile(dir), null), id, dir);
    if (record) out.push(moduleSummary(record, id));
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}

/** 按 moduleId 找模块（moduleId 全局唯一，扫书目录即可；单机 ≤50 模块/书）。 */
export function loadModuleById(moduleId) {
  if (!isValidId(moduleId)) return null;
  let books = [];
  try {
    books = fs.readdirSync(BOOKS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return null;
  }
  for (const bookId of books) {
    if (!isValidId(bookId)) continue;
    const moduleDir = path.join(BOOKS_DIR, bookId, 'modules', moduleId);
    const record = readJson(moduleJsonFile(moduleDir), null);
    if (!record) continue;
    const bookDir = path.join(BOOKS_DIR, bookId);
    const reconciled = reconcileRecord(record, moduleId, moduleDir);
    return {
      bookId: bookId,
      bookDir: bookDir,
      moduleDir: moduleDir,
      module: reconciled,
      slides: readJson(slidesJsonFile(moduleDir), null),
      book: readJson(path.join(bookDir, 'book.json'), null),
    };
  }
  return null;
}

/** 同一缓存键的已有模块；有多个时取最近更新的。 */
export function findModuleByKey(bookDir, cacheKey) {
  const modulesDir = path.join(bookDir, 'modules');
  let names = [];
  try {
    names = fs.readdirSync(modulesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return null;
  }
  let best = null;
  for (const id of names) {
    if (!isValidId(id)) continue;
    const dir = path.join(modulesDir, id);
    const record = readJson(moduleJsonFile(dir), null);
    if (!record || record.cacheKey !== cacheKey) continue;
    const updated = String(record.updatedAt || record.createdAt || '');
    if (!best || updated > best.updatedAt) best = { id: id, dir: dir, record: record, updatedAt: updated };
  }
  return best;
}

export function deleteModuleById(bookId, moduleId) {
  if (!isValidId(bookId) || !isValidId(moduleId)) return false;
  const bookDir = existingBookDir(bookId);
  if (!bookDir) return false;
  const moduleDir = path.join(bookDir, 'modules', moduleId);
  if (!fs.existsSync(moduleJsonFile(moduleDir))) return false;
  fs.rmSync(moduleDir, { recursive: true, force: true });
  jobs.delete(moduleId);
  return true;
}

/* ------------------------------ 作业 ------------------------------ */

/** 只暴露给面板的状态，别把 controller / promise 发出去。 */
export function getJobState(moduleId) {
  const job = jobs.get(moduleId);
  if (!job) return null;
  return {
    moduleId: job.moduleId,
    bookId: job.bookId,
    status: job.status,
    stage: job.stage,
    current: job.current,
    total: job.total,
    message: job.message,
    slides: job.slides || 0,
    error: job.error || null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
  };
}

export function findRunningByKey(cacheKey) {
  for (const job of jobs.values()) {
    if (job.active && job.cacheKey === cacheKey) return job;
  }
  return null;
}

export function cancelJob(moduleId) {
  const job = jobs.get(moduleId);
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

export function isActiveStatus(status) {
  return ACTIVE_STATUS.includes(String(status));
}

export function isTerminalStatus(status) {
  return TERMINAL_STATUS.includes(String(status));
}

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.active) continue;
    const finished = Date.parse(job.finishedAt || job.startedAt) || 0;
    if (now - finished > 30 * 60 * 1000) jobs.delete(id);
  }
}

function isAbort(err) {
  return !!(err && (err.name === 'AbortError' || err.name === 'TimeoutError' || /aborted|abort/i.test(String(err.message || ''))));
}

/**
 * 启动一个生成作业。同步把 module.json 写成 queued 后立即返回，HTTP 不等它跑完。
 *
 * @param {{
 *   book: object, selected: object[], pages: object[], cleanedPages: object[],
 *   voice: object, cacheKey: string, model: {provider:string,model:string}, prompt: string,
 *   existing: null|{id:string,dir:string,record:object},
 *   callModel: (system:string,user:string,options:object)=>Promise<object>
 * }} options
 */
export function startGeneration(options) {
  const { book, selected, pages, cleanedPages, voice, cacheKey, model, prompt, existing, callModel } = options || {};
  if (!book || !isValidId(book.id)) throw new GenerateError('E_NOT_FOUND', '找不到这本书');
  if (!Array.isArray(selected) || selected.length === 0) throw new GenerateError('E_SELECTION_EMPTY', '先勾选至少一章');
  if (typeof callModel !== 'function') throw new GenerateError('E_LLM_UNAVAILABLE', '模型服务不可用');

  const bookDir = existingBookDir(book.id);
  if (!bookDir) throw new GenerateError('E_NOT_FOUND', '找不到这本书');
  const moduleId = existing ? existing.id : newId(10);
  const moduleDir = existing ? existing.dir : path.join(bookDir, 'modules', moduleId);

  fs.mkdirSync(path.join(moduleDir, 'audio'), { recursive: true });
  fs.mkdirSync(batchesDir(moduleDir), { recursive: true });
  if (existing) {
    // 重跑：旧 slides 与音频都不能留，否则面板会读到上一轮的半成品
    try {
      fs.rmSync(slidesJsonFile(moduleDir), { force: true });
      fs.rmSync(path.join(moduleDir, 'audio'), { recursive: true, force: true });
      fs.mkdirSync(path.join(moduleDir, 'audio'), { recursive: true });
    } catch {
      /* 删不掉就让写入覆盖 */
    }
  }

  const createdAt = existing && existing.record && existing.record.createdAt ? existing.record.createdAt : nowIso();
  const record = {
    schemaVersion: 1,
    id: moduleId,
    bookId: book.id,
    title: moduleTitleOf(selected),
    chapters: selected.map((chapter) => Number(chapter.n)),
    chapterTitles: selected.map((chapter) => String(chapter.title || '')),
    status: 'queued',
    stage: 'queued',
    current: 0,
    total: 0,
    message: '已排队',
    code: null,
    error: null,
    cacheKey: cacheKey,
    model: model.model,
    provider: model.provider,
    promptVersion: SLIDES_PROMPT_VERSION,
    voice: {
      provider: voice.provider,
      model: voice.model || '',
      voice: voice.voice || '',
      rate: Number(voice.rate) || 1,
      mode: voice.provider === 'browser' ? 'browser' : 'none',
      degraded: false,
    },
    slides: 0,
    anchored: 0,
    anchorHitRate: 0,
    attempts: existing && existing.record ? (Number(existing.record.attempts) || 1) + 1 : 1,
    createdAt: createdAt,
    updatedAt: nowIso(),
    finishedAt: null,
  };
  writeJson(moduleJsonFile(moduleDir), record);

  const controller = new AbortController();
  const job = {
    moduleId: moduleId,
    bookId: book.id,
    cacheKey: cacheKey,
    status: 'queued',
    stage: 'queued',
    current: 0,
    total: 0,
    message: '已排队',
    slides: 0,
    error: null,
    startedAt: record.updatedAt,
    finishedAt: null,
    controller: controller,
    cancelled: false,
    active: true,
    promise: null,
  };
  jobs.set(moduleId, job);
  pruneJobs();

  job.promise = runJob(job, {
    book: book,
    selected: selected,
    pages: Array.isArray(pages) ? pages : [],
    cleanedPages: Array.isArray(cleanedPages) ? cleanedPages : pages,
    voice: voice,
    model: model,
    prompt: prompt,
    moduleId: moduleId,
    moduleDir: moduleDir,
    record: record,
    callModel: callModel,
  }).catch((err) => {
    // runJob 自己会收口；走到这里说明收口代码也抛了（比如磁盘满），兜底别让进程挂
    try {
      job.status = 'failed';
      job.stage = 'done';
      job.active = false;
      job.error = { code: 'E_GENERATE', message: String((err && err.message) || err) };
      job.finishedAt = nowIso();
      record.status = 'failed';
      record.code = 'E_GENERATE';
      record.error = job.error.message;
      record.finishedAt = job.finishedAt;
      writeJson(moduleJsonFile(moduleDir), record);
    } catch {
      /* 兜底失败只能记在内存里 */
    }
  });

  return job;
}

function createPersist(record, moduleDir) {
  return function persist(patch) {
    if (patch && typeof patch === 'object') Object.assign(record, patch);
    record.updatedAt = nowIso();
    try {
      writeJson(moduleJsonFile(moduleDir), record);
    } catch {
      /* 进度写盘失败不该打断生成 */
    }
  };
}

function setStage(job, persist, stage, total, message) {
  job.status = stage;
  job.stage = stage;
  job.current = 0;
  job.total = total;
  job.message = message;
  persist({ status: stage, stage: stage, current: 0, total: total, message: message });
}

function progress(job, current, total, message) {
  job.current = current;
  job.total = total;
  if (message) job.message = message;
}

function assertActive(job) {
  if (job.cancelled) throw new GenerateError('E_CANCELLED', '已取消');
}

/**
 * 模型调用统一出口：把超时/取消/其他错误翻成有错误码的 GenerateError。
 * 超时与取消要分开：取消是用户意图，不能报成模型超时。
 */
async function ask(job, callModel, system, user, options) {
  assertActive(job);
  try {
    return await callModel(system, user, Object.assign({ maxTokens: LLM_MAX_TOKENS, signal: job.controller.signal }, options || {}));
  } catch (err) {
    if (job.cancelled) throw new GenerateError('E_CANCELLED', '已取消');
    if (err instanceof GenerateError) throw err;
    if (isAbort(err)) {
      // 调用方信号没被 abort，说明是超时定时器触发的
      if (!job.controller.signal.aborted) {
        throw new GenerateError('E_LLM_TIMEOUT', '模型响应超时', '检查网络或模型配置后重试。');
      }
      throw new GenerateError('E_CANCELLED', '已取消');
    }
    throw new GenerateError('E_LLM_FAIL', '模型调用失败', String((err && err.message) || err).slice(0, 240));
  }
}

/** 一批的结构化：JSON 解析失败时把错误回灌，重试一次，并给截断加预算。 */
async function generateBatch(batch, job, context) {
  const target = expectedSlides(context.totalChars, batch.chars, batch.index === 0);
  const messages = buildSlidesMessages({
    promptFile: context.prompt,
    book: context.book,
    moduleTitle: context.moduleTitle,
    batch: batch,
    index: batch.index,
    totalBatches: context.batches.length,
    target: target,
  });
  let budget = LLM_MAX_TOKENS;
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertActive(job);
    const user =
      attempt === 0
        ? messages.user
        : messages.user + '\n\n【上一次的输出不合格】' + lastError + '\n这次不要分析、不要解释，直接输出 JSON。';
    const reply = await ask(job, context.callModel, messages.system, user, { maxTokens: budget });
    try {
      if (!reply.text.trim()) throw new Error(describeEmptyReply(reply));
      const parsed = parseSlidesReply(reply.text);
      return { moduleTitle: parsed.moduleTitle, slides: parsed.slides };
    } catch (err) {
      lastError = String((err && err.message) || err);
      if (reply.stopReason === 'max-tokens') {
        budget = LLM_RETRY_MAX_TOKENS;
        lastError += '（输出被 max_tokens 截断，这次已加大预算）';
      }
    }
  }
  throw new GenerateError('E_LLM_JSON', '模型输出格式异常，已重试', lastError.slice(0, 320));
}

/** 一批的结构校验；硬错误触发一次修复调用，软错误（摘抄漂移）留给锚点阶段。 */
async function validateBatch(batch, result, job, context) {
  const minPage = Math.min.apply(null, batch.chapters.map((chapter) => Number(chapter.from) || 1));
  const maxPage = Math.max.apply(null, batch.chapters.map((chapter) => Number(chapter.to) || context.pages.length));
  const check = {
    text: batch.text,
    totalPages: context.pages.length,
    minPage: minPage,
    maxPage: maxPage,
    allowCover: batch.index === 0,
    requireCover: batch.index === 0,
  };
  const errors = validateSlides(result.slides, check);
  const hard = errors.filter((error) => error.hard);
  if (!hard.length) return { result: result, softErrors: errors.length };

  const messages = buildRepairMessages({
    promptFile: context.prompt,
    book: context.book,
    moduleTitle: context.moduleTitle,
    sourceText: batch.text,
    slides: result.slides,
    errors: hard,
  });
  const reply = await ask(job, context.callModel, messages.system, messages.user, { maxTokens: LLM_RETRY_MAX_TOKENS });
  let repaired;
  try {
    repaired = parseSlidesReply(reply.text);
  } catch (err) {
    throw new GenerateError('E_LLM_SCHEMA', '修复调用没有返回合法 JSON', String((err && err.message) || err).slice(0, 240));
  }
  const again = validateSlides(repaired.slides, check);
  const stillHard = again.filter((error) => error.hard);
  if (stillHard.length) {
    throw new GenerateError(
      'E_LLM_SCHEMA',
      '生成内容不合规（修复后仍有 ' + stillHard.length + ' 处问题）',
      formatSlideErrors(stillHard).slice(0, 320),
    );
  }
  return { result: repaired, softErrors: again.length };
}

/** 模块级修复：页数越界/封面位置不对时，拿全文重写一次。 */
async function repairModuleSet(slides, moduleTitle, errors, job, context, moduleText) {
  const messages = buildRepairMessages({
    promptFile: context.prompt,
    book: context.book,
    moduleTitle: moduleTitle,
    sourceText: moduleText,
    slides: slides,
    errors: errors.map((message) => ({ index: -1, message: String(message) })),
  });
  const reply = await ask(job, context.callModel, messages.system, messages.user, { maxTokens: LLM_RETRY_MAX_TOKENS });
  return parseSlidesReply(reply.text);
}

function progressMessage(stage, current, total) {
  if (stage === 'structuring') return '正在改写第 ' + current + '/' + total + ' 批原文';
  if (stage === 'validate') return '正在校验第 ' + current + '/' + total + ' 批结构';
  if (stage === 'anchor') return '正在定位原文锚点 ' + current + '/' + total + ' 页';
  if (stage === 'voicing') return '正在合成语音 ' + current + '/' + total + ' 页';
  return '处理中';
}

async function runJob(job, context) {
  const persist = createPersist(context.record, context.moduleDir);
  try {
    assertActive(job);
    const moduleText = moduleTextOf(context.cleanedPages, context.selected);
    if (!moduleText.trim()) throw new GenerateError('E_NO_TEXT', '选中的章节没有可用的文字', '换一章再试。');

    const batches = planBatches(context.selected, context.cleanedPages);
    if (!batches.length) throw new GenerateError('E_NO_TEXT', '选中的章节没有可用的文字', '换一章再试。');
    const totalChars = batches.reduce((sum, batch) => sum + batch.chars, 0);
    const moduleTitle = moduleTitleOf(context.selected);
    const shared = Object.assign({}, context, {
      batches: batches,
      totalChars: totalChars,
      moduleTitle: moduleTitle,
    });

    /* 阶段 1：结构（逐批调模型） */
    setStage(job, persist, 'structuring', batches.length, progressMessage('structuring', 1, batches.length));
    const results = [];
    for (let index = 0; index < batches.length; index += 1) {
      assertActive(job);
      progress(job, index + 1, batches.length, progressMessage('structuring', index + 1, batches.length));
      const batchHash = sha256Of(Buffer.from(batches[index].text, 'utf8'));
      const cached = readCheckpoint(context.moduleDir, index, batchHash);
      if (cached) {
        // 上次取消/失败前已经改完的批，直接拿来用（FR-5「重试复用已完成阶段」）
        results.push({
          moduleTitle: cached.moduleTitle || '',
          slides: cached.slides.map((slide, at) => normalizeSlide(slide, at)),
        });
        job.message = '复用已完成的第 ' + (index + 1) + '/' + batches.length + ' 批';
        continue;
      }
      const result = await generateBatch(batches[index], job, shared);
      writeCheckpoint(context.moduleDir, index, batchHash, result);
      results.push(result);
    }

    /* 阶段 2：校验（硬错误修复一次） */
    setStage(job, persist, 'validate', batches.length, progressMessage('validate', 1, batches.length));
    let softErrors = 0;
    for (let index = 0; index < batches.length; index += 1) {
      assertActive(job);
      progress(job, index + 1, batches.length, progressMessage('validate', index + 1, batches.length));
      const checked = await validateBatch(batches[index], results[index], job, shared);
      results[index] = checked.result;
      softErrors += checked.softErrors;
    }

    let slides = mergeBatchSlides(results);
    // 模块标题按勾选章节自动生成（FR-4），模型给的 module_title 只当参考，不覆盖它
    const title = moduleTitle;

    /* 模块级：页数 6–30、封面只能第 1 页 */
    const setErrors = validateSlideSet(slides);
    if (setErrors.length) {
      progress(job, batches.length, batches.length, '页数或封面不合规，正在重写整套');
      let repaired;
      try {
        repaired = await repairModuleSet(slides, title, setErrors, job, shared, moduleText);
      } catch (err) {
        if (err.code === 'E_CANCELLED') throw err;
        throw new GenerateError('E_LLM_SCHEMA', '生成内容不合规（' + setErrors.join('；') + '）', String((err && err.message) || err).slice(0, 240));
      }
      slides = repaired.slides;
      const againSet = validateSlideSet(slides);
      if (againSet.length) {
        throw new GenerateError('E_LLM_SCHEMA', '生成内容不合规（' + againSet.join('；') + '）', '');
      }
      const globalErrors = validateSlides(slides, {
        text: moduleText,
        totalPages: context.pages.length,
        minPage: Math.min.apply(null, context.selected.map((chapter) => Number(chapter.from) || 1)),
        maxPage: Math.max.apply(null, context.selected.map((chapter) => Number(chapter.to) || context.pages.length)),
        allowCover: true,
        requireCover: true,
      });
      const hard = globalErrors.filter((error) => error.hard);
      if (hard.length) {
        throw new GenerateError('E_LLM_SCHEMA', '生成内容不合规（重写后仍有 ' + hard.length + ' 处问题）', formatSlideErrors(hard).slice(0, 320));
      }
    }

    /* 阶段 3：锚点 */
    setStage(job, persist, 'anchor', slides.length, progressMessage('anchor', 0, slides.length));
    const minPage = Math.min.apply(null, context.selected.map((chapter) => Number(chapter.from) || 1));
    const maxPage = Math.max.apply(null, context.selected.map((chapter) => Number(chapter.to) || context.pages.length));
    let anchored = anchorSlides(slides, context.pages, { minPage: minPage, maxPage: maxPage });
    progress(job, anchored.anchored, slides.length, progressMessage('anchor', anchored.anchored, slides.length));

    if (anchored.hitRate < ANCHOR_REPAIR_THRESHOLD && anchored.unanchored > 0) {
      assertActive(job);
      job.message = '锚定率 ' + Math.round(anchored.hitRate * 100) + '%，正在修复摘抄';
      try {
        const user = buildAnchorRepairUser({ slides: anchored.slides, text: moduleText.slice(0, ANCHOR_REPAIR_TEXT_LIMIT) });
        const reply = await ask(job, context.callModel, context.prompt, user, { maxTokens: ANCHOR_MAX_TOKENS });
        const fixes = parseAnchorFixes(reply.text);
        if (fixes.length) {
          const fixed = applyAnchorFixes(anchored.slides, fixes);
          const again = anchorSlides(fixed, context.pages, { minPage: minPage, maxPage: maxPage });
          if (again.hitRate >= anchored.hitRate) anchored = again;
        }
      } catch (err) {
        if (err.code === 'E_CANCELLED') throw err;
        // 锚点修复只是锦上添花：失败就保留 unanchored，让播放器按页降级（D10）
        context.record.anchorRepairError = String((err && err.message) || err).slice(0, 200);
      }
      progress(job, anchored.anchored, slides.length, progressMessage('anchor', anchored.anchored, slides.length));
    }

    /* 阶段 4：配音（Qwen3-TTS 逐页合成 WAV；浏览器只算时长） */
    setStage(job, persist, 'voicing', slides.length, progressMessage('voicing', 0, slides.length));
    const voiced = await synthesizeVoicing(anchored.slides, context.voice, {
      moduleDir: context.moduleDir,
      signal: job.controller.signal,
      onProgress: (done, total) => progress(job, done, total, '正在合成语音 ' + done + '/' + total + ' 页'),
    });
    progress(job, slides.length, slides.length, voiced.degraded ? '文字已就绪，语音降级' : '语音已就绪');

    assertActive(job);
    const generatedAt = nowIso();
    const status = voiced.degraded ? 'ready_degraded' : 'ready';
    const slidesDoc = {
      schema_version: 1,
      module_id: context.moduleId,
      book_id: context.book.id,
      module_title: title,
      chapters: context.selected.map((chapter) => Number(chapter.n)),
      generated_at: generatedAt,
      model: context.model.model,
      prompt_version: SLIDES_PROMPT_VERSION,
      voice: {
        provider: voiced.provider,
        mode: voiced.mode,
        model: voiced.model || context.voice.model || '',
        rate: Number(context.voice.rate) || 1,
        voice: context.voice.voice || '',
      },
      anchor_hit_rate: anchored.hitRate,
      slides: voiced.slides,
    };
    writeJson(slidesJsonFile(context.moduleDir), slidesDoc);
    // 成品已经落盘，批次检查点没用了；留着只会占地方
    try {
      fs.rmSync(batchesDir(context.moduleDir), { recursive: true, force: true });
    } catch {
      /* 删不掉不影响结果 */
    }

    const message = voiced.degraded ? voiced.message : '生成完成';
    persist({
      status: status,
      stage: 'done',
      current: slides.length,
      total: slides.length,
      message: message,
      slides: slides.length,
      anchored: anchored.anchored,
      anchorHitRate: anchored.hitRate,
      softErrors: softErrors,
      code: voiced.degraded ? voiced.code : null,
      error: voiced.degraded ? voiced.message : null,
      voice: {
        provider: voiced.provider,
        model: voiced.model || context.voice.model || '',
        voice: context.voice.voice || '',
        rate: Number(context.voice.rate) || 1,
        mode: voiced.mode,
        degraded: !!voiced.degraded,
      },
      modelTextChars: moduleText.length,
      finishedAt: generatedAt,
    });
    job.status = status;
    job.stage = 'done';
    job.current = slides.length;
    job.total = slides.length;
    job.slides = slides.length;
    job.message = message;
    job.error = voiced.degraded ? { code: voiced.code, message: voiced.message, hint: '' } : null;
    job.finishedAt = generatedAt;
  } catch (err) {
    const cancelled = job.cancelled || (err && err.code === 'E_CANCELLED');
    const status = cancelled ? 'cancelled' : 'failed';
    const code = cancelled ? 'E_CANCELLED' : (err && err.code) || 'E_GENERATE';
    const message = cancelled ? '已取消' : String((err && err.message) || err);
    job.status = status;
    job.stage = 'done';
    job.message = message;
    job.error = { code: code, message: message, hint: (err && err.hint) || '' };
    job.finishedAt = nowIso();
    persist({
      status: status,
      stage: 'done',
      code: code,
      error: message,
      message: message,
      finishedAt: job.finishedAt,
    });
  } finally {
    job.active = false;
    job.controller = null;
    if (!job.finishedAt) job.finishedAt = nowIso();
    pruneJobs();
  }
}

/**
 * 启动时跑一遍：把上次没跑完的模块标成 interrupted。
 * 只扫目录，不读 PDF；200 本书也是毫秒级。
 */
export function reconcileAllModules() {
  let books = [];
  try {
    books = fs.readdirSync(BOOKS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return;
  }
  for (const bookId of books) {
    if (!isValidId(bookId)) continue;
    try {
      listModules(bookId);
    } catch {
      /* 一本书读坏了不能拖垮启动 */
    }
  }
}
