/**
 * 2.4 系列播放布局：series/<seriesId>/view.json（FR-18.2 / §6.3 / §6.7 /series/view）。
 *
 * 每个系列一份：`layout`（ppt-left | pdf-left）+ `split`（原文窗格宽度占比）。
 * - 无记录时返回默认值，**不落盘**；只有换位/拖动过才写这个系列的文件。
 * - `split` 的初始值取全局 `preference.split`，所以老用户调过的比例在首次进入时仍然生效。
 * - 独立文件：不并入 series.json（配音/配图作业会写回，2.1.2 处理过并发覆盖），
 *   也不并入 progress.json（翻页写入频繁）。`view.json` 不入书档（FR-22）。
 */
import path from 'node:path';

import { readJson, writeJson } from './root.js';
import { clampSplit, readPreference } from './prefs.js';

export const LAYOUT_PPT_LEFT = 'ppt-left';
export const LAYOUT_PDF_LEFT = 'pdf-left';
export const LAYOUTS = [LAYOUT_PPT_LEFT, LAYOUT_PDF_LEFT];

export function viewFile(seriesDirPath) {
  return path.join(seriesDirPath, 'view.json');
}

/** 只认两个方向；缺失/非法一律回 ppt-left。 */
export function normalizeLayout(value) {
  const text = String(value || '');
  return LAYOUTS.includes(text) ? text : LAYOUT_PPT_LEFT;
}

/**
 * 原文窗格占比：夹到 [0.25, 0.75]（与 prefs.clampSplit 同一口径）；
 * 非法值退回 fallback（再非法则 0.55）。
 */
export function clampViewSplit(value, fallback) {
  const ratio = Number(value);
  if (!Number.isFinite(ratio)) return clampSplit(fallback);
  return clampSplit(ratio);
}

/**
 * 读该系列的布局；文件缺失/损坏时给默认值（不写盘）。
 * `series_id` 以目录里的系列为准，不信任旧文件里的值。
 */
export function readView(seriesDirPath, series) {
  const raw = readJson(viewFile(seriesDirPath), null);
  const source = raw && typeof raw === 'object' ? raw : {};
  const seed = readPreference().split;
  return {
    schema: 1,
    series_id: String((series && series.id) || ''),
    layout: normalizeLayout(source.layout),
    split: clampViewSplit(source.split, seed),
    updated_at: String(source.updated_at || ''),
  };
}

/** 只写传入字段；layout / split 归一化后落盘，返回完整视图。 */
export function saveView({ series, dir, layout, split }) {
  const current = readView(dir, series);
  const next = {
    schema: 1,
    series_id: String(series.id),
    layout: layout === undefined || layout === null ? current.layout : normalizeLayout(layout),
    split: split === undefined || split === null ? current.split : clampViewSplit(split, current.split),
    updated_at: new Date().toISOString(),
  };
  writeJson(viewFile(dir), next);
  return next;
}
