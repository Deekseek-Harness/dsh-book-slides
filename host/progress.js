/**
 * 2.0 系列进度：series/<seriesId>/progress.json（FR-18 / §6.7 /series/progress）。
 *
 * 形状 `{schema:1, series_id, lecture, slide, heard:{n: 已听页数}, updated_at}`。
 * `heard` 记每讲听到的最大页码，用来算「系列 24/42 页」；跳讲不回退已完成进度。
 * 每次落进度顺手把 preference 的「上次打开的书/系列/页」指向这里，书架「继续听」不必再存一份。
 */
import path from 'node:path';

import { readJson, writeJson } from './root.js';
import { writePreference } from './prefs.js';

/** 页内位置上限：24h，防止坏数据把进度写成天文数字。 */
export const MAX_OFFSET_MS = 24 * 60 * 60 * 1000;

/** 页内媒体时间（毫秒）归一化：负数/非数字/过小一律 0，最大 24h。 */
export function normalizeOffsetMs(value) {
  const ms = Math.round(Number(value));
  if (!Number.isFinite(ms) || ms < 0) return 0;
  if (ms < 500) return 0;
  return Math.min(MAX_OFFSET_MS, ms);
}

export function progressFile(seriesDirPath) {
  return path.join(seriesDirPath, 'progress.json');
}

function lectureList(series) {
  return (series && series.lectures) || [];
}

function pagesOf(series, n) {
  const hit = lectureList(series).find((item) => Number(item.n) === Number(n));
  return hit ? Number(hit.pages) || 0 : 0;
}

export function totalPagesOf(series) {
  return lectureList(series).reduce((sum, item) => sum + (Number(item.pages) || 0), 0);
}

/** 已听页数 = 各讲 heard 之和；没有 heard 时退回 0。 */
export function heardPagesOf(series, progress) {
  const heard = (progress && progress.heard) || {};
  let sum = 0;
  for (const item of lectureList(series)) {
    const pages = Number(item.pages) || 0;
    const value = Math.max(0, Math.min(pages, Number(heard[item.n]) || 0));
    sum += value;
  }
  return sum;
}

export function readProgress(seriesDirPath, series) {
  const raw = readJson(progressFile(seriesDirPath), null);
  const source = raw && typeof raw === 'object' ? raw : {};
  const lectures = lectureList(series);
  const first = lectures.length ? Number(lectures[0].n) : 1;
  const validLecture = lectures.some((item) => Number(item.n) === Number(source.lecture));
  return {
    schema: 1,
    series_id: String((series && series.id) || ''),
    lecture: validLecture ? Number(source.lecture) : first,
    slide: Math.max(0, Math.round(Number(source.slide) || 0)),
    offset_ms: normalizeOffsetMs(source.offset_ms != null ? source.offset_ms : source.offsetMs),
    audio_file: String(source.audio_file || ''),
    audio_ms: Math.max(0, Math.round(Number(source.audio_ms) || 0)),
    audio_provider: String(source.audio_provider || ''),
    heard: source.heard && typeof source.heard === 'object' ? source.heard : {},
    updated_at: String(source.updated_at || ''),
  };
}

/** 给面板的汇总：当前讲/页 + 系列已听页数。 */
export function progressSummary(series, progress) {
  const totalPages = totalPagesOf(series);
  const lecture = Number(progress && progress.lecture) || 0;
  return {
    seriesId: String((series && series.id) || ''),
    lecture,
    slide: Number(progress && progress.slide) || 0,
    offsetMs: normalizeOffsetMs(progress && progress.offset_ms),
    audioFile: String((progress && progress.audio_file) || ''),
    audioMs: Math.max(0, Math.round(Number(progress && progress.audio_ms) || 0)),
    audioProvider: String((progress && progress.audio_provider) || ''),
    lecturePages: pagesOf(series, lecture),
    heard: (progress && progress.heard) || {},
    heardPages: heardPagesOf(series, progress),
    totalPages,
    updated_at: String((progress && progress.updated_at) || ''),
  };
}

/**
 * 记一次进度。lecture 必须是系列里的讲次；slide 夹到该讲页数内。
 * `offsetMs` 是当前页音频的媒体时间：显式传入（含 0）就以它为准；
 * 未传时同页保留旧值、换页归 0，避免“翻页写进度”把页内位置冲掉。
 * 返回 `{progress, summary}`。
 */
export function saveProgress({ series, dir, lecture, slide, offsetMs, audioFile, audioMs, audioProvider }) {
  const current = readProgress(dir, series);
  const lectures = lectureList(series);
  if (!lectures.length) {
    const err = new Error('这个系列还没有讲次');
    err.code = 'E_SERIES_EMPTY';
    throw err;
  }
  const wanted = lectures.some((item) => Number(item.n) === Number(lecture)) ? Number(lecture) : current.lecture;
  const pages = pagesOf(series, wanted);
  const clamped = pages > 0 ? Math.max(0, Math.min(pages, Math.round(Number(slide)))) : 0;
  const samePosition = Number(current.lecture) === wanted && Number(current.slide) === clamped;
  const offsetProvided = offsetMs !== undefined && offsetMs !== null && Number.isFinite(Number(offsetMs));
  const offset = offsetProvided ? normalizeOffsetMs(offsetMs) : samePosition ? normalizeOffsetMs(current.offset_ms) : 0;
  const hasOffset = offset > 0;
  const nextAudioFile = hasOffset ? String(offsetProvided ? audioFile || '' : current.audio_file || '') : '';
  const nextAudioMs = hasOffset ? Math.max(0, Math.round(Number(offsetProvided ? audioMs : current.audio_ms) || 0)) : 0;
  const nextAudioProvider = hasOffset
    ? String(offsetProvided ? audioProvider || '' : current.audio_provider || '')
    : '';
  const heard = Object.assign({}, current.heard);
  if (clamped > 0) heard[wanted] = Math.max(Number(heard[wanted]) || 0, clamped);
  const next = {
    schema: 1,
    series_id: String(series.id),
    lecture: wanted,
    slide: clamped,
    offset_ms: offset,
    audio_file: nextAudioFile,
    audio_ms: nextAudioMs,
    audio_provider: nextAudioProvider,
    heard: heard,
    updated_at: new Date().toISOString(),
  };
  writeJson(progressFile(dir), next);
  // 页内位置的周期写入不反复改「上次打开」偏好，只在页/讲真正变化时写一次。
  if (!samePosition) {
    writePreference({
      lastBookId: String(series.book_id || ''),
      lastSeriesId: String(series.id || ''),
      lastSlide: clamped,
    });
  }
  return { progress: next, summary: progressSummary(series, next) };
}
