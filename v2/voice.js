/**
 * 2.0 语音（FR-23）：配置、试听、独立配音作业与音频流。
 *
 * 三条硬边界：
 *   1. 配音不随文本生成自动执行，必须由 `POST /revoice` 显式触发；
 *   2. Key 只在 voice.json（0600），接口只回 hasKey / apiKeyMask；
 *   3. 配音作业只改音频字段（audio_file / audio_provider / audio_ms 与 voice 元数据），
 *      文字与锚点一个字都不动；取消/失败不写 slides.json，不留半截状态。
 *
 * 生成阶段文本 `ready` 不等待 voice_status；播放器按 audio_file 是否存在决定用文件还是浏览器朗读。
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  QWEN_MODELS,
  QWEN_VOICES,
  VOICE_PROVIDERS,
  TtsError,
  planVoicing,
  probeVoice,
  publicVoiceConfig,
  readVoiceConfig,
  synthesizeVoicing,
  writeVoiceConfig,
} from '../tts.js';
import { ROOT, writeJson } from './root.js';
import { lectureDir, loadLecture } from './lectures.js';
import { findSeries, patchSeriesLecture, persistSeries } from './series.js';
import { recordError } from './errors.js';

const ACTIVE = ['queued', 'voicing', 'cancelling'];
const READY = ['ready', 'ready_degraded'];

const jobs = new Map();
const activeBySeries = new Map();

function nowIso() {
  return new Date().toISOString();
}

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.active) continue;
    const finished = Date.parse(job.finishedAt || job.startedAt) || 0;
    if (now - finished > 30 * 60 * 1000) jobs.delete(id);
  }
}

function newJobId() {
  return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function assertActive(job) {
  if (job.cancelled) throw new TtsError('E_CANCELLED', '已取消', '');
}

function jobState(job) {
  return {
    ok: true,
    jobId: job.id,
    seriesId: job.seriesId,
    stage: job.stage,
    lecture: job.lecture,
    current: job.current,
    total: job.total,
    status: job.status,
    message: job.message,
    skipped: job.skipped || [],
    error: job.error || null,
  };
}

/* ------------------------------ 配置与试听 ------------------------------ */

export function voicePayload() {
  return {
    voice: publicVoiceConfig(readVoiceConfig()),
    providers: VOICE_PROVIDERS,
    models: QWEN_MODELS,
    qwenVoices: QWEN_VOICES,
    note: 'Qwen3-TTS 的 Key 只存本机 voice.json（0600）；配音不随文本生成自动执行。',
  };
}

export function saveVoice(patch) {
  return publicVoiceConfig(writeVoiceConfig(patch && typeof patch === 'object' ? patch : {}));
}

export async function probeVoiceConfig(text, options) {
  return probeVoice(readVoiceConfig(), text, options);
}

export function hasApiKey() {
  const config = readVoiceConfig();
  return Boolean(config.apiKey);
}

/* ------------------------------ 配音作业 ------------------------------ */

export function getRevoiceJob(jobId) {
  const job = jobs.get(String(jobId || ''));
  return job ? jobState(job) : null;
}

export function cancelRevoiceJob(jobId) {
  const job = jobs.get(String(jobId || ''));
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

export function activeRevoiceJob(seriesId) {
  const job = activeBySeries.get(String(seriesId || ''));
  return job && job.active ? job : null;
}

/** 删除系列/书之前取消该系列的所有配音作业。 */
export function cancelRevoiceJobsForSeries(seriesId) {
  let cancelled = 0;
  for (const job of jobs.values()) {
    if (!job.active || String(job.seriesId) !== String(seriesId || '')) continue;
    if (cancelRevoiceJob(job.id)) cancelled += 1;
  }
  return cancelled;
}

/** 配音作业是否还在跑（删除目录前用它等收口）。 */
export function isRevoiceJobActive(seriesId) {
  return !!activeRevoiceJob(seriesId);
}

/** 可配音的讲：默认只看已就绪的讲；失败/未生成的讲配音没有意义。 */
function scopeLectures(series, lecture) {
  const all = (series.lectures || []).filter((item) => READY.includes(String(item.status)));
  if (lecture == null) return all.map((item) => Number(item.n));
  const wanted = Number(lecture);
  const hit = (series.lectures || []).find((item) => Number(item.n) === wanted);
  if (!hit) {
    throw new TtsError('E_REPLAN_RANGE', '第 ' + lecture + ' 讲不存在', '刷新系列后再试。');
  }
  if (!READY.includes(String(hit.status))) {
    throw new TtsError('E_LECTURE_EMPTY', '这一讲还没有生成内容', '先生成文本，再单独配音。');
  }
  return [wanted];
}

/**
 * 启动配音作业：同步建 job 立即返回，HTTP 不等配音完成。
 * 同一系列同时只允许一个配音作业（E_SERIES_BUSY）；文本作业不受影响。
 */
export function startRevoiceJob({ seriesId, lecture = null, force = false, options = {} }) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new TtsError('E_NOT_FOUND', '找不到这个系列', '刷新列表后再试。');
  if (activeRevoiceJob(found.series.id)) {
    throw new TtsError('E_SERIES_BUSY', '正在配音，请稍候', '同一系列同时只能有一个配音作业。');
  }
  const scope = scopeLectures(found.series, lecture);
  if (!scope.length) {
    throw new TtsError('E_LECTURE_EMPTY', '这个系列还没有可配音的讲', '先生成文本讲义。');
  }

  const job = {
    id: newJobId(),
    seriesId: String(found.series.id),
    bookId: String(found.series.book_id),
    status: 'queued',
    stage: 'queued',
    lecture: 0,
    current: 0,
    total: 0,
    message: '已排队',
    skipped: [],
    error: null,
    scope,
    force: force === true,
    startedAt: nowIso(),
    finishedAt: null,
    controller: new AbortController(),
    cancelled: false,
    active: true,
    promise: null,
  };
  jobs.set(job.id, job);
  activeBySeries.set(job.seriesId, job);
  pruneJobs();

  job.promise = runRevoiceJob(job, found, options).catch((err) => {
    // runRevoiceJob 自己收口；这里兜底，别让进程挂
    job.status = job.cancelled ? 'cancelled' : 'failed';
    job.stage = 'done';
    job.active = false;
    job.error = { code: (err && err.code) || 'E_TTS_FAIL', message: String((err && err.message) || err) };
    job.finishedAt = nowIso();
    activeBySeries.delete(job.seriesId);
  });
  return { jobId: job.id, job };
}

async function runRevoiceJob(job, found, options) {
  const { series, dir } = found;
  const config = readVoiceConfig();
  const cacheDir = path.join(ROOT, 'audio-cache');
  const touched = [];
  const failedLectures = [];
  try {
    if (config.provider === 'qwen3-tts' && !config.apiKey) {
      throw new TtsError('E_TTS_UNCONFIGURED', '未配置 Qwen API Key', '到设置页填入 Key，或改用浏览器朗读。');
    }
    job.status = 'voicing';
    job.stage = 'voicing';
    for (const n of job.scope) {
      assertActive(job);
      const doc = loadLecture(dir, n);
      if (!doc.exists || !doc.slidesDoc || !Array.isArray(doc.slidesDoc.slides) || !doc.slidesDoc.slides.length) {
        job.skipped.push(n);
        continue;
      }
      job.lecture = n;
      job.current = 0;
      job.total = doc.slidesDoc.slides.length;
      job.message = '第 ' + n + ' 讲 · 正在配音';
      const result =
        config.provider === 'browser' || config.provider === 'off'
          ? planVoicing(doc.slidesDoc.slides, config)
          : await synthesizeVoicing(doc.slidesDoc.slides, config, {
              moduleDir: doc.dir,
              cacheDir,
              signal: job.controller.signal,
              fetchImpl: options.fetchImpl,
              timeoutMs: options.timeoutMs,
              onProgress: (done, total) => {
                job.current = done;
                job.total = total;
                job.message = '第 ' + n + ' 讲 · 已配音 ' + done + '/' + total + ' 页';
              },
            });
      assertActive(job);

      const byIndex = new Map((result.slides || []).map((slide) => [Number(slide.slide_index), slide]));
      const slides = doc.slidesDoc.slides.map((slide) => {
        const hit = byIndex.get(Number(slide.slide_index));
        if (!hit) {
          return Object.assign({}, slide, { audio_file: null, audio_provider: 'none' });
        }
        return Object.assign({}, slide, {
          audio_file: hit.audio_file == null ? null : String(hit.audio_file),
          audio_provider: String(hit.audio_provider || 'none'),
          audio_ms: Number(hit.audio_ms) || 0,
        });
      });
      const degraded = result.degraded === true;
      const voiceStatus = result.mode === 'none' ? 'none' : degraded ? 'partial' : 'ready';
      const voiceMeta = {
        provider: result.provider,
        model: result.model || config.model || '',
        voice: config.voice || '',
        rate: Number(config.rate) || 1,
        mode: result.mode,
        degraded: degraded,
      };
      const at = nowIso();
      writeJson(
        path.join(doc.dir, 'slides.json'),
        Object.assign({}, doc.slidesDoc, {
          slides,
          voice: voiceMeta,
          voice_status: voiceStatus,
          voiced_at: at,
        }),
      );
      writeJson(
        path.join(doc.dir, 'lecture.json'),
        Object.assign({}, doc.lecture, {
          voice_status: voiceStatus,
          voice: voiceMeta,
          voiced_at: at,
        }),
      );
      patchSeriesLecture(series, n, {
        voice_status: voiceStatus,
        code: degraded ? result.code || 'E_TTS_FAIL' : null,
      });
      touched.push(n);
      if (degraded) failedLectures.push({ n, code: result.code || 'E_TTS_FAIL', message: result.message || '' });
      job.current = job.total;
    }

    const readyLectures = (series.lectures || []).filter((item) => READY.includes(String(item.status)));
    const statuses = readyLectures.map((item) => String(item.voice_status || 'none'));
    series.voice_status = statuses.every((item) => item === 'ready')
      ? 'ready'
      : statuses.some((item) => item === 'ready' || item === 'partial')
        ? 'partial'
        : 'none';
    series.voiced_at = nowIso();
    if (series.voice_status === 'partial') {
      series.voice_code = 'E_TTS_FAIL';
      series.voice_error = '有 ' + failedLectures.length + ' 讲存在未配音页，播放时会跳过或提示未配音';
    } else {
      delete series.voice_code;
      delete series.voice_error;
    }
    persistSeries(series);

    job.status = 'done';
    job.stage = 'done';
    job.message =
      series.voice_status === 'ready'
        ? '配音完成'
        : series.voice_status === 'none'
          ? '未产生音频（语音供应商为关闭）'
          : '部分页未配音';
    job.error = failedLectures.length ? { failures: failedLectures } : null;
    job.finishedAt = nowIso();
  } catch (err) {
    const cancelled = job.cancelled || (err && err.code === 'E_CANCELLED');
    job.status = cancelled ? 'cancelled' : 'failed';
    job.stage = 'done';
    job.message = cancelled ? '已取消' : String((err && err.message) || err);
    job.error = cancelled ? { code: 'E_CANCELLED', message: '已取消' } : { code: (err && err.code) || 'E_TTS_FAIL', message: job.message };
    job.finishedAt = nowIso();
    if (!cancelled) {
      recordError(job.error.code, job.message);
      // 整体失败（例如未配置 Key）：系列 voice_status=none，文本不受影响
      try {
        series.voice_status = 'none';
        series.voice_code = job.error.code;
        series.voice_error = job.message;
        persistSeries(series);
      } catch {
        /* 系列文件可能已不存在 */
      }
    }
  } finally {
    job.active = false;
    job.controller = null;
    if (!job.finishedAt) job.finishedAt = nowIso();
    activeBySeries.delete(job.seriesId);
    pruneJobs();
  }
  return job;
}

/* ------------------------------ 音频文件 ------------------------------ */

function pad3(index) {
  return String(index).padStart(3, '0');
}

/**
 * 找一页的音频文件：优先 slides.json 里的 audio_file，其次按约定路径 audio/NNN.wav|mp3。
 * 只接受 audio/NNN.(wav|mp3) 形式的相对路径，避免把任意路径读出去。
 */
export function findAudioFile(seriesDirPath, n, i) {
  const lecture = Number(n);
  const index = Number(i);
  if (!Number.isInteger(lecture) || lecture < 1 || lecture > 999) return null;
  if (!Number.isInteger(index) || index < 1 || index > 999) return null;
  const dir = lectureDir(seriesDirPath, lecture);
  const candidates = [];
  const doc = loadLecture(seriesDirPath, lecture);
  const slide = doc.slidesDoc && Array.isArray(doc.slidesDoc.slides)
    ? doc.slidesDoc.slides.find((item) => Number(item.slide_index) === index)
    : null;
  if (slide && slide.audio_file) {
    const rel = String(slide.audio_file).replace(/\\/g, '/');
    if (/^audio\/\d{3}\.(wav|mp3)$/.test(rel)) candidates.push(path.join(dir, rel));
  }
  candidates.push(path.join(dir, 'audio', pad3(index) + '.wav'));
  candidates.push(path.join(dir, 'audio', pad3(index) + '.mp3'));
  for (const file of candidates) {
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.size > 0) {
        return { file, size: stat.size, type: file.toLowerCase().endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav' };
      }
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

export { ACTIVE as REVOICE_ACTIVE, READY as LECTURE_READY };
