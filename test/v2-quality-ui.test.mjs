/** 3.2：质量面板机检文案与系列徽标拆分（源码契约）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');

test('质量面板使用「刷新机检」，不再用「重新审计」', () => {
  assert.ok(source.includes('刷新机检'), '应有刷新机检按钮');
  assert.ok(!source.includes('重新审计'), '不应残留重新审计文案');
  assert.ok(source.includes('用当前别名重算本讲机检；不调用模型，不改讲义'), '按钮 tooltip 要说明只重算');
});

test('系列卡分别统计内容告警与密度偏低', () => {
  assert.ok(source.includes("'内容告警 ' + contentWarnings.length + ' 讲'"));
  assert.ok(source.includes("'密度偏低 ' + densityWarnings.length + ' 讲'"));
  assert.ok(!source.includes("'内容告警 ' + qualityWarnings.length + ' 讲'"));
});

test('刷新机检 toast 区分内容与密度', () => {
  assert.ok(source.includes('本讲内容机检通过；密度仍偏低（软目标）'));
  assert.ok(source.includes('本讲内容与密度机检通过'));
});

test('刷新机检后旧 AI 审阅仍可见并标记旧快照', () => {
  assert.ok(source.includes("review.stale ? ' · 旧快照'"));
  assert.ok(source.includes('建议重新 AI 审阅'));
});
