/**
 * 3.1：must_keep 同义/别名表。内置一份策展表，用户可在数据根覆盖/追加。
 * 文件：<root>/must-keep-aliases.json
 */
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, readJson, writeJson } from './root.js';

export const ALIASES_SCHEMA = 1;

export const DEFAULT_ALIASES = [
  { term: '根号非负', all: ['根号', '非负'] },
  { term: '唯一交点', any: ['只交一次', '至多一次', '唯一交点', '至多相交一次'] },
  { term: '一一对应', any: ['一一对应', '只对应一个', '唯一输出', '最多交一次', '对应正负两个'] },
  { term: '解出变量', any: ['解出 x', '解出 y', '解出变量'] },
  { term: '函数复合', any: ['复合'] },
  { term: '图像变换', any: ['变换', '平移'] },
  { term: '对称性', any: ['对称'] },
  { term: '交点', any: ['交点', '相交', '交一次'] },
  { term: '原函数', any: ['原函数', '原始函数'] },
  { term: '恒等', any: ['恒等', '等于 x', '回到原来的输入', '等于原来的输入'] },
  { term: '纵轴', any: ['纵轴', 'y 轴', 'y轴'] },
  { term: '左右不等', any: ['左右不等', '左右不相等', '两边不相等', '左右两边不相等'] },
  { term: '正无穷', any: ['正无穷', '趋于无穷', 'x 越来越大', '越来越大'] },
  { term: '函数值', any: ['函数值', '函数的值', '那一点的取值', '那一点上的取值', '落点'] },
];

export function aliasesFile() {
  return path.join(ROOT, 'must-keep-aliases.json');
}

function cleanPatterns(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter((item) => item.length > 0 && item.length <= 40)
    .slice(0, 12);
}

function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const term = String(rule.term || '').trim();
  if (!term || term.length > 24) return null;
  const any = cleanPatterns(rule.any);
  const all = cleanPatterns(rule.all);
  if (!any.length && !all.length) return null;
  return { term, any, all };
}

export function normalizeAliases(input) {
  const list = Array.isArray(input) ? input : (input && Array.isArray(input.aliases) ? input.aliases : []);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const rule = normalizeRule(item);
    if (!rule) continue;
    const key = rule.term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rule);
  }
  return out;
}

function mergeAliases(custom) {
  const map = new Map();
  for (const rule of DEFAULT_ALIASES) map.set(rule.term.toLowerCase(), rule);
  for (const rule of normalizeAliases(custom)) map.set(rule.term.toLowerCase(), rule);
  return Array.from(map.values());
}

export function readMustKeepAliases() {
  const stored = readJson(aliasesFile(), null);
  if (!stored || stored.schema !== ALIASES_SCHEMA || !Array.isArray(stored.aliases)) {
    return DEFAULT_ALIASES.slice();
  }
  return mergeAliases(stored.aliases);
}

export function readMustKeepAliasConfig() {
  const stored = readJson(aliasesFile(), null);
  const custom = stored && stored.schema === ALIASES_SCHEMA ? normalizeAliases(stored.aliases) : [];
  return {
    schema: ALIASES_SCHEMA,
    aliases: mergeAliases(custom),
    custom,
    defaults: DEFAULT_ALIASES,
    file: aliasesFile(),
    warnings: stored && stored.schema !== ALIASES_SCHEMA ? ['别名表 schema 不兼容，已使用内置表。'] : [],
  };
}

export function writeMustKeepAliases(input) {
  const custom = normalizeAliases(input);
  writeJson(aliasesFile(), { schema: ALIASES_SCHEMA, aliases: custom, updated_at: new Date().toISOString() });
  return readMustKeepAliasConfig();
}

export function resetMustKeepAliases() {
  try {
    fs.rmSync(aliasesFile(), { force: true });
  } catch {
    /* ignore */
  }
  return readMustKeepAliasConfig();
}
