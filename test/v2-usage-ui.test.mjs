/**
 * FR-27 客户端静态走查（C15 / §7.9 / §7.10 / FR-27.6）：设置「用量与费用」组、历史页、
 * 历史条目行内展开（AC-175 ~ AC-177）、预估确认与「本次用量」摘要必须真的存在于面板源码与渲染结果里。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToString } = require('react-dom/server');
const source = fs.readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');

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
await import('../client/index.js');

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

const USAGE_JOB = {
  jobId: 'g-usage-1',
  kind: 'lecture',
  phase: 'generate',
  startedAt: '2026-11-11T00:00:00.000Z',
  book: { title: '测试书' },
  series: { title: '测试系列' },
  actual: { tokens: { input: 1200, output: 300 }, chars: 0, images: 0, calls: 2, cost: 0.12 },
};

const USAGE_DETAIL = {
  ...USAGE_JOB,
  status: 'done',
  billing: 'cloud',
  finishedAt: '2026-11-11T00:05:00.000Z',
  priceVersion: '2026-11-09',
  billingModel: [
    { provider: 'deepseek', model: 'deepseek-chat', calls: 2, tokens: { input: 1200, output: 300, cacheRead: 0 }, cost: 0.12 },
  ],
  byStage: { lecture: { cost: 0.12 } },
};

function renderUsageRow(options = {}) {
  return renderToString(
    React.createElement(clientModule.__components.UsageRow, {
      job: USAGE_JOB,
      open: Boolean(options.open),
      detail: options.detail === undefined
        ? { status: 'ready', jobId: USAGE_JOB.jobId, job: USAGE_DETAIL, error: '' }
        : options.detail,
      onToggle: () => {},
      onRetry: () => {},
      onCollapse: () => {},
    }),
  );
}

test('历史条目：展开详情是摘要行的下一个兄弟节点，收起时 hidden', () => {
  const openHtml = renderUsageRow({ open: true });
  assert.ok(openHtml.includes('blm-usage-item is-open'), '展开条目应有 is-open');
  assert.ok(openHtml.includes('aria-expanded="true"'), '摘要按钮应标记 aria-expanded=true');
  assert.ok(openHtml.includes('role="region"'), '详情应有 region 语义');
  const controls = (openHtml.match(/aria-controls="([^"]+)"/) || [])[1];
  assert.ok(controls && openHtml.includes('id="' + controls + '"'), 'aria-controls 应指向详情节点');
  assert.ok(openHtml.includes('aria-labelledby="blm-usage-summary-g-usage-1"'), '详情应关联摘要按钮');
  assert.ok(openHtml.includes('明细'), '详情面板应显示「明细」标题');
  assert.ok(openHtml.includes('测试系列'), '展开内容应包含明细字段');
  assert.ok(openHtml.includes('deepseek'), '展开内容应包含逐模型明细');
  assert.ok(
    openHtml.indexOf('class="blm-usage-detail"') > openHtml.indexOf('class="blm-usage-summary"'),
    '详情必须位于摘要行之后',
  );
  assert.ok(
    openHtml.indexOf('</button>') < openHtml.indexOf('class="blm-usage-detail"'),
    '详情不能嵌套在摘要按钮内',
  );

  const closedHtml = renderUsageRow({ open: false });
  assert.ok(closedHtml.includes('aria-expanded="false"'), '收起时 aria-expanded=false');
  assert.match(closedHtml, /class="blm-usage-detail"[^>]*hidden/, '收起时详情应 hidden');
  assert.ok(!closedHtml.includes('正在读取明细'), '收起时不应渲染明细内容');
});

test('历史条目：加载态、错误态与重试入口', () => {
  const loadingHtml = renderUsageRow({
    open: true,
    detail: { status: 'loading', jobId: USAGE_JOB.jobId, job: null, error: '' },
  });
  assert.ok(loadingHtml.includes('正在读取明细…'), '展开后应先显示加载态');
  assert.ok(loadingHtml.includes('role="status"'), '加载态应有 status 语义');

  const errorHtml = renderUsageRow({
    open: true,
    detail: { status: 'error', jobId: USAGE_JOB.jobId, job: null, error: 'E_TEST' },
  });
  assert.ok(errorHtml.includes('读取明细失败：E_TEST'), '错误应行内显示');
  assert.ok(errorHtml.includes('role="alert"'), '错误应有 alert 语义');
  assert.ok(errorHtml.includes('重试'), '错误应提供重试');
});

test('历史条目：单开互斥与稳定 DOM id', () => {
  const helpers = clientModule.__helpers;
  assert.equal(helpers.usageToggleJobId('', 'g-1'), 'g-1');
  assert.equal(helpers.usageToggleJobId('g-1', 'g-1'), '', '点同一条应收起');
  assert.equal(helpers.usageToggleJobId('g-1', 'g-2'), 'g-2', '点另一条应收旧开新');
  assert.equal(helpers.usageDetailSafeId('g-1'), 'g-1');
  assert.equal(helpers.usageDetailSafeId('a/b c'), 'a_b_c');
});

test('历史条目：源码契约（行内结构、竞态、外部点击与视觉分层）', () => {
  for (const text of [
    'function UsageRow',
    "className: 'blm-usage-item'",
    'aria-expanded',
    'aria-controls',
    'openJobId',
    'detailSeqRef',
    'usageToggleJobId',
    "document.addEventListener('click'",
    "'.blm-modal-mask'",
    "'.blm-usage-item'",
    'list.some((job) => job.jobId === current)',
  ]) {
    assert.ok(source.includes(text), '源码应包含「' + text + '」');
  }
  for (const css of [
    '.blm-usage-item{',
    '.blm-usage-detail{',
    '.blm-usage-detail[hidden]{display:none}',
    'border-top:1px solid color-mix',
    'border-left:3px solid color-mix',
    '@media (prefers-reduced-motion:reduce){.blm-usage-caret{transition:none}}',
  ]) {
    assert.ok(source.includes(css), '样式应包含「' + css + '」');
  }
  assert.ok(!source.includes("className: 'blm-note', style: { marginTop: 10 }"), '旧底部详情块应删除');
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
