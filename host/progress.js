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
    lecturePages: pagesOf(series, lecture),
    heard: (progress && progress.heard) || {},
    heardPages: heardPagesOf(series, progress),
    totalPages,
    updated_at: String((progress && progress.updated_at) || ''),
  };
}

/**
 * 记一次进度。lecture 必须是系列里的讲次；slide 夹到该讲页数内。
 * 返回 `{progress, summary}`。
 */
export function saveProgress({ series, dir, lecture, slide }) {
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
  const heard = Object.assign({}, current.heard);
  if (clamped > 0) heard[wanted] = Math.max(Number(heard[wanted]) || 0, clamped);
  const next = {
    schema: 1,
    series_id: String(series.id),
    lecture: wanted,
    slide: clamped,
    heard: heard,
    updated_at: new Date().toISOString(),
  };
  writeJson(progressFile(dir), next);
  writePreference({
    lastBookId: String(series.book_id || ''),
    lastSeriesId: String(series.id || ''),
    lastSlide: clamped,
  });
  return { progress: next, summary: progressSummary(series, next) };
}
