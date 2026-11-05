/**
 * M2 系列容器与讲纲：POST /series 只建 draft；/series/plan 才写 plan；
 * 不启动任何生成作业。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { BOOKS_DIR, readJson, writeJson } from './root.js';
import { loadBook, newId } from './books.js';
import { getPart, partChapterTexts } from './parts.js';
import { buildPlan } from './plan.js';

export class SeriesError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'SeriesError';
    this.code = code;
    this.hint = hint || '';
  }
}

function seriesRoot(bookId) {
  const bookDir = path.join(BOOKS_DIR(), bookId);
  return path.join(bookDir, 'series');
}

export function seriesDir(bookId, seriesId) {
  return path.join(seriesRoot(bookId), seriesId);
}

export function loadSeries(bookId, seriesId) {
  const file = path.join(seriesDir(bookId, seriesId), 'series.json');
  const data = readJson(file, null);
  return data && data.id ? data : null;
}

export function findSeries(seriesId) {
  let books = [];
  try {
    books = fs.readdirSync(BOOKS_DIR(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
  for (const bookId of books) {
    const dir = seriesRoot(bookId);
    let ids = [];
    try {
      ids = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    if (ids.includes(seriesId)) {
      const series = loadSeries(bookId, seriesId);
      if (series) return { bookId, series, dir: seriesDir(bookId, seriesId) };
    }
  }
  return null;
}

export function listSeries(bookId) {
  let ids = [];
  try {
    ids = fs.readdirSync(seriesRoot(bookId), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return ids
    .map((id) => loadSeries(bookId, id))
    .filter(Boolean)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function validatePlanShape(plan, chapters) {
  if (!plan || !Array.isArray(plan.lectures) || !plan.lectures.length) throw new SeriesError('E_PLAN_BAD', '讲纲为空', '');
  const expected = chapters.map((c) => Number(c.n)).sort((a, b) => a - b);
  const seen = [];
  for (const lec of plan.lectures) {
    for (const n of lec.chapters || []) seen.push(Number(n));
  }
  const unique = Array.from(new Set(seen)).sort((a, b) => a - b);
  if (JSON.stringify(unique) !== JSON.stringify(expected)) {
    throw new SeriesError('E_PLAN_COVERAGE', '讲纲没有覆盖 Part 的全部章', '检查讲次章集合。');
  }
  if (seen.length !== unique.length) {
    // 单章拆上/下：允许重复章号，但每讲必须带明确切片
    for (const lec of plan.lectures) {
      if (!lec.slice || !Number.isInteger(Number(lec.slice.chapter)) || (lec.chapters || []).length !== 1) {
        throw new SeriesError('E_PLAN_COVERAGE', '拆章讲缺少切片范围', '重新生成讲纲。');
      }
    }
  }
  return plan;
}

function planFields(plan) {
  return {
    throughline: plan.throughline || '',
    plan_source: plan.source || 'rule',
    stitched: plan.stitched === true,
    total_chars: Number(plan.totalChars) || 0,
    total_pages: Number(plan.totalPages) || 0,
    est_minutes: Number(plan.estMinutes) || 0,
    lectures: (Array.isArray(plan.lectures) ? plan.lectures : []).map((item) =>
      Object.assign({ status: 'draft' }, item),
    ),
    seams: plan.seams || [],
    terms: plan.terms || [],
    cut_notes: plan.cut_notes || [],
  };
}

function planKey(bookId, part, title, plan) {
  return crypto
    .createHash('sha256')
    .update([bookId, part.id, part.version, title, plan ? JSON.stringify(plan) : 'draft'].join('|'))
    .digest('hex');
}

export function createSeries({ bookId, partId, title, plan = null }) {
  const loaded = loadBook(bookId);
  if (!loaded) throw new SeriesError('E_NOT_FOUND', '找不到这本书', '');
  const part = getPart(bookId, partId);
  if (!part) throw new SeriesError('E_PART_NOT_FOUND', '先确认 Part，再建系列', '');
  const chapters = loaded.chapters.filter((c) => (part.chapters || []).includes(Number(c.n))).sort((a, b) => a.n - b.n);
  if (!chapters.length) throw new SeriesError('E_PART_EMPTY', 'Part 没有内容章', '');

  if (plan) validatePlanShape(plan, chapters);
  const resolvedTitle = String(title || part.title || '').trim() || part.title;
  const key = planKey(bookId, part, resolvedTitle, plan);
  const existing = listSeries(bookId).find((item) => item.idempotency_key === key);
  if (existing) return existing;
  // 兼容本次修复前创建的系列：它们没有 idempotency_key，但同一 Part/标题不应再新建
  const legacy = listSeries(bookId).find(
    (item) =>
      !item.idempotency_key &&
      item.part_id === part.id &&
      item.title === resolvedTitle,
  );
  if (legacy) {
    if (!plan) return legacy;
    const next = Object.assign({}, legacy, planFields(plan), {
      status: 'planned',
      stitch: plan.stitched ? 'stitched' : 'unstitched',
      plan_version: Number(legacy.plan_version || 0) + 1,
      idempotency_key: key,
      updated_at: new Date().toISOString(),
    });
    writeJson(path.join(seriesDir(bookId, legacy.id), 'series.json'), next);
    return next;
  }

  const id = newId(10);
  const dir = seriesDir(bookId, id);
  fs.mkdirSync(dir, { recursive: true });
  const series = {
    schema: 1,
    id,
    book_id: bookId,
    part_id: part.id,
    part_version: Number(part.version) || 1,
    title: resolvedTitle,
    chapters: chapters.map((c) => Number(c.n)),
    chars: chapters.reduce((sum, c) => sum + (Number(c.chars) || 0), 0),
    status: plan ? 'planned' : 'draft',
    stitch: plan && plan.stitched ? 'stitched' : 'unstitched',
    plan_version: plan ? 1 : 0,
    idempotency_key: key,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...(plan ? planFields(plan) : { throughline: '', plan_source: '', stitched: false, total_chars: 0, total_pages: 0, est_minutes: 0, lectures: [], seams: [], terms: [], cut_notes: [] }),
  };
  writeJson(path.join(dir, 'series.json'), series);
  return series;
}

export async function savePlan({ seriesId, plan = null, ctx = null, force = false }) {
  const found = findSeries(seriesId);
  if (!found) throw new SeriesError('E_NOT_FOUND', '找不到这个系列', '');
  const { bookId, series, dir } = found;
  const texted = partChapterTexts(bookId, series.part_id);
  if (!texted) throw new SeriesError('E_PART_NOT_FOUND', '系列引用的 Part 已删除', '');
  const chapters = texted.chapters;
  let nextPlan = plan;
  let warnings = [];
  if (!nextPlan || force) {
    const out = await buildPlan({ ctx, book: texted.loaded.book, dir: texted.loaded.dir, part: texted.part, chapters, force });
    nextPlan = out.plan;
    warnings = out.warnings || [];
  }
  validatePlanShape(nextPlan, chapters);
  const next = Object.assign({}, series, planFields(nextPlan), {
    status: 'planned',
    stitch: nextPlan.stitched ? 'stitched' : 'unstitched',
    plan_version: Number(series.plan_version || 0) + 1,
    updated_at: new Date().toISOString(),
  });
  writeJson(path.join(dir, 'series.json'), next);
  return { series: next, warnings };
}

export function markPlanDraft(series, plan) {
  return Object.assign({}, series, planFields(plan));
}

/** 写回系列文档（作业进度、讲状态、缝合状态都走这里）。 */
export function persistSeries(series) {
  if (!series || !series.book_id || !series.id) return null;
  series.updated_at = new Date().toISOString();
  writeJson(path.join(seriesDir(series.book_id, series.id), 'series.json'), series);
  return series;
}

/** 同步更新 series.lectures 中某一讲的字段，不碰 plan 切片。 */
export function patchSeriesLecture(series, n, patch) {
  let hit = null;
  series.lectures = (series.lectures || []).map((item) => {
    if (Number(item.n) !== Number(n)) return item;
    hit = Object.assign({}, item, patch);
    return hit;
  });
  return hit;
}

/** 扫全部书、全部系列；启动归一用。 */
export function listAllSeries() {
  let books = [];
  try {
    books = fs.readdirSync(BOOKS_DIR(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const bookId of books) {
    const dir = seriesRoot(bookId);
    let ids = [];
    try {
      ids = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const id of ids) {
      const series = loadSeries(bookId, id);
      if (series) out.push({ bookId, series, dir: seriesDir(bookId, id) });
    }
  }
  return out;
}

/**
 * 删除系列目录（AC-130）：只删系列，不删书、不删 Part。
 * 调用方负责先取消运行中作业；这里再兜一层，避免删到一半又被作业写回来。
 */
export function deleteSeries(seriesId) {
  const found = findSeries(String(seriesId || ''));
  if (!found) throw new SeriesError('E_NOT_FOUND', '找不到这个系列', '刷新列表后再试。');
  fs.rmSync(found.dir, { recursive: true, force: true });
  return found;
}
