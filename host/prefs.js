/**
 * 2.0 偏好：preference.json（FR-21.7 / §6.7 /preference）。
 *
 * 记录分隔条比例、语速（0.8/1.0/1.2）、静音与上次打开的书/系列/页。
 * 区间一律由服务端夹紧：面板拖到边界外、或旧客户端传了非法值，读回来也是合法值。
 * 与 1.x 的 preference.json 同根同文件，但字段不同（split 取代 splitRatio），
 * 2.0 只读自己认识的字段，读到 1.x 残留时按默认值处理。
 */
import path from 'node:path';

import { ROOT, readJson, writeJson } from './root.js';
import { isValidId } from './books.js';

/** 播放器允许的三档语速（FR-18）。 */
export const RATE_STEPS = [0.8, 1, 1.2];
export const SPLIT_MIN = 0.25;
export const SPLIT_MAX = 0.75;

export const DEFAULT_PREFERENCE = {
  schema: 2,
  split: 0.55,
  rate: 1,
  muted: false,
  lastBookId: '',
  lastSeriesId: '',
  lastSlide: 0,
};

export function preferenceFile() {
  return path.join(ROOT, 'preference.json');
}

/** 分隔条比例夹到 [0.25, 0.75]；非法值退回默认。 */
export function clampSplit(value) {
  const ratio = Number(value);
  if (!Number.isFinite(ratio)) return DEFAULT_PREFERENCE.split;
  return Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ratio)) * 1000) / 1000;
}

/** 语速吸附到最近的允许档位（0.8 / 1.0 / 1.2）。 */
export function clampRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return DEFAULT_PREFERENCE.rate;
  let best = RATE_STEPS[0];
  let distance = Infinity;
  for (const step of RATE_STEPS) {
    const next = Math.abs(step - rate);
    if (next < distance) {
      best = step;
      distance = next;
    }
  }
  return best;
}

export function clampSlide(value) {
  const slide = Math.round(Number(value));
  if (!Number.isFinite(slide) || slide < 0) return 0;
  return Math.min(100000, slide);
}

export function normalizePreference(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    schema: 2,
    split: clampSplit(source.split),
    rate: clampRate(source.rate),
    muted: source.muted === true,
    lastBookId: isValidId(String(source.lastBookId || '')) ? String(source.lastBookId) : '',
    lastSeriesId: isValidId(String(source.lastSeriesId || '')) ? String(source.lastSeriesId) : '',
    lastSlide: clampSlide(source.lastSlide),
  };
}

export function readPreference() {
  return normalizePreference(readJson(preferenceFile(), null));
}

/** 只写传进来的字段；写前夹紧，写后返回完整偏好。 */
export function writePreference(patch) {
  const merged = Object.assign({}, readPreference(), patch && typeof patch === 'object' ? patch : {});
  const next = normalizePreference(merged);
  writeJson(preferenceFile(), next);
  return next;
}
