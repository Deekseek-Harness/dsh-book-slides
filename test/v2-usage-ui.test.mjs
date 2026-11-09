/**
 * FR-27 客户端静态走查（C15 / §7.9 / §7.10）：设置「用量与费用」组、历史页、
 * 预估确认与「本次用量」摘要必须真的存在于面板源码与渲染结果里。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToString } = require('react-dom/server');
const source = fs.readFileSync(new URL('../v2/client.js', import.meta.url), 'utf8');

let clientModule = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      const mod = definition.factory((name) => {
        if (name === 'react') return React;
        throw new Error('插件不该 require ' + name);
      });
      const slots = {
        inject(name, fn) {
          fn();
        },
        register() {
          return () => {};
        },
      };
      mod.apply({ slots, effect: (fn) => fn() });
      clientModule = mod;
    },
  },
};
await import('../v2/client.js');

test('设置页：用量与费用组（本月/累计、价格表、本地 provider、历史入口）', () => {
  const html = renderToString(
    React.createElement(clientModule.__components.Settings, {
      onBack: () => {},
      notify: () => {},
      onOpenUsage: () => {},
    }),
  );
  for (const text of ['用量与费用', '本月', '累计', '价格表（JSON）', '本地 LLM provider', '恢复参考价', '查看历史', '清空历史']) {
    assert.ok(html.includes(text), '设置页应包含「' + text + '」');
  }
  for (const text of ['/usage/summary', '/usage/prices', '/usage/jobs']) {
    assert.ok(source.includes(text), '设置页源码应请求 ' + text);
  }
});

test('历史页：空态、类型筛选、返回设置与清空入口', () => {
  const html = renderToString(
    React.createElement(clientModule.__components.UsageView, { onBack: () => {}, notify: () => {} }),
  );
  for (const text of ['用量与费用', '还没有用量记录', '全部类型', '清空历史', '← 设置']) {
    assert.ok(html.includes(text), '历史页应包含「' + text + '」');
  }
  for (const text of ["api('/usage/jobs?limit=100'", "api('/usage/summary'", "api('/usage/job?jobId='"]) {
    assert.ok(source.includes(text), '历史页源码应请求 ' + text);
  }
});

test('用量格式化：万/千分位、金额缺价与阈值、类型标签', () => {
  const helpers = clientModule.__helpers;
  assert.equal(helpers.formatTokens(12345), '1.2 万');
  assert.equal(helpers.formatTokens(3000), '3,000');
  assert.equal(helpers.formatTokens(123456789), '1.23 亿');
  assert.equal(helpers.formatMoney(null), '—');
  assert.equal(helpers.formatMoney(0), '¥0.00');
  assert.equal(helpers.formatMoney(0.001), '<¥0.01');
  assert.equal(helpers.formatMoney(1.239), '¥1.24');
  assert.equal(helpers.usageKindLabel({ kind: 'lecture', phase: 'plan' }), '讲纲');
  assert.equal(helpers.usageKindLabel({ kind: 'lecture', phase: 'generate' }), '生成讲义');
  assert.equal(helpers.usageKindLabel({ kind: 'tts' }), '配音');
  assert.equal(helpers.usageKindLabel({ kind: 'image' }), '配图');
  assert.equal(helpers.usageKindLabel({ kind: 'other', phase: 'probe' }), '试听/测试');
  assert.equal(helpers.usageKindLabel({ kind: 'other', phase: 'practice' }), '练习');
});

test('本次用量摘要：tokens 与字符/张数不混算，金额单独显示', () => {
  const line = clientModule.__helpers.usageSummaryLine({
    actual: {
      tokens: { input: 12000, output: 3000 },
      chars: 0,
      images: 0,
      cachedPages: 0,
      calls: 2,
      cost: 0.12,
    },
    kind: 'lecture',
  });
  assert.ok(line.includes('输入 1.2 万 / 输出 3,000 tokens'));
  assert.ok(line.includes('¥0.12'));
  const cached = clientModule.__helpers.usageSummaryLine({
    actual: { tokens: { input: 1000, cacheRead: 500, output: 200 }, chars: 0, images: 0, calls: 1, cost: 0.01 },
    kind: 'lecture',
  });
  assert.ok(cached.includes('缓存读 500'), '缓存读必须与未缓存输入分开显示');
  const tts = clientModule.__helpers.usageSummaryLine({
    actual: { tokens: {}, chars: 18000, images: 0, cachedPages: 6, calls: 18, cost: 1.44 },
    kind: 'tts',
  });
  assert.ok(tts.includes('1.8 万 字符'));
  assert.ok(tts.includes('缓存命中 6 页'));
});

test('系列卡：讲义/配音开始前预估、结束摘要与本地未计入文案', () => {
  for (const text of [
    "api('/usage/estimate'",
    'confirmEstimate',
    '本次用量',
    '本地调用，未计入',
    '本地配音，未计入',
  ]) {
    assert.ok(source.includes(text), '系列卡源码应包含「' + text + '」');
  }
  assert.ok(source.includes("view.name === 'usage'"), '面板应注册 usage 视图');
  assert.ok(source.includes('UsageView'), '面板应导出 UsageView');
  assert.ok(source.includes("name === 'usage'"), 'readSavedView 应接受 usage');
});
