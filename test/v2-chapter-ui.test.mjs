/**
 * 2.0 分章 UI：AC-157 自动/高级入口、来源徽标、来源/置信度/warnings 常驻、重分入口。
 *
 * 只做纯状态/静态渲染与源码入口断言；真实点击走查留给 M6 真书。
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

const helpers = clientModule.__helpers;
const components = clientModule.__components;

function basePanel(patch) {
  return Object.assign(
    {
      built: false,
      advancedOpen: false,
      advancedSource: 'printed_toc',
      tocFrom: '',
      tocTo: '',
      suggested: null,
      tocPreview: '',
      busy: false,
      source: '',
      confidence: null,
      warnings: [],
      attempts: [],
      manualCount: 0,
      onToggleAdvanced: () => {},
      onSource: () => {},
      onFrom: () => {},
      onTo: () => {},
      onPreview: () => {},
      onBuild: () => {},
      onClose: null,
    },
    patch || {},
  );
}

test('AC-157：分章请求体只含自动/印刷目录/机械切章，不带旧 mode/toc', () => {
  const auto = helpers.chapterBuildRequest({
    bookId: 'b1',
    advancedOpen: false,
    advancedSource: 'mechanical',
    tocFrom: '1',
    tocTo: '3',
  });
  assert.deepEqual(auto, { bookId: 'b1', mode: 'auto' });

  const printed = helpers.chapterBuildRequest({
    bookId: 'b1',
    advancedOpen: true,
    advancedSource: 'printed_toc',
    tocFrom: '2',
    tocTo: '4',
  });
  assert.deepEqual(printed, { bookId: 'b1', mode: 'printed_toc', range: { from: 2, to: 4 } });

  const mech = helpers.chapterBuildRequest({
    bookId: 'b1',
    advancedOpen: true,
    advancedSource: 'mechanical',
    tocFrom: '2',
    tocTo: '4',
  });
  assert.deepEqual(mech, { bookId: 'b1', mode: 'mechanical' });

  const forced = helpers.chapterBuildRequest({
    bookId: 'b1',
    advancedOpen: false,
    advancedSource: 'printed_toc',
    force: true,
  });
  assert.equal(forced.force, true);

  const descended = helpers.chapterBuildRequest({
    bookId: 'b1',
    advancedOpen: false,
    advancedSource: 'mechanical',
    outlineDepth: 1,
    modeOverride: 'auto',
  });
  assert.deepEqual(descended, { bookId: 'b1', mode: 'auto', outlineDepth: 1 });

  const top = helpers.chapterBuildRequest({
    bookId: 'b1',
    advancedOpen: true,
    advancedSource: 'mechanical',
    outlineDepth: 0,
    modeOverride: 'auto',
  });
  assert.deepEqual(top, { bookId: 'b1', mode: 'auto', outlineDepth: 0 });
});

test('AC-157：来源标签覆盖书签/目录/机械/手动/前文', () => {
  assert.equal(helpers.sourceLabel('bookmark'), '书签');
  assert.equal(helpers.sourceLabel('printed_toc'), '目录');
  assert.equal(helpers.sourceLabel('mechanical'), '机械');
  assert.equal(helpers.sourceLabel('heading'), '');
  assert.equal(helpers.chapterSourceLabel({ source: 'bookmark' }), '书签');
  assert.equal(helpers.chapterSourceLabel({ source: 'bookmark', manual: true }), '手动');
  assert.equal(helpers.chapterSourceLabel({ source: 'mechanical', front: true }), '前文');
});

test('AC-157：无章节时只有「自动分章」+「高级」，没有三选一/标题/固定切页', () => {
  const html = renderToString(React.createElement(components.ChapterBuildPanel, basePanel()));
  assert.ok(html.includes('自动分章'));
  assert.ok(html.includes('高级'));
  assert.ok(html.includes('书签 → 印刷目录 → 机械切章'));
  for (const banned of ['自动（书签/标题/机械）', '目录（书签或印刷目录）', '固定切页', '正文标题']) {
    assert.equal(html.includes(banned), false, '不应出现「' + banned + '」');
  }
  // 高级未展开时没有页码输入。
  assert.equal(html.includes('起始页'), false);
});

test('AC-157：高级展开后两个强制项；只有印刷目录出现页码输入', () => {
  const printed = renderToString(
    React.createElement(
      components.ChapterBuildPanel,
      basePanel({ advancedOpen: true, advancedSource: 'printed_toc', tocFrom: '1', tocTo: '3', suggested: { from: 1, to: 3 } }),
    ),
  );
  for (const text of ['强制来源', '印刷目录', '机械切章', '起始页', '结束页', '预览这几页', '建议 1–3 页']) {
    assert.ok(printed.includes(text), '印刷目录高级态应包含「' + text + '」');
  }

  const mech = renderToString(
    React.createElement(components.ChapterBuildPanel, basePanel({ advancedOpen: true, advancedSource: 'mechanical' })),
  );
  assert.ok(mech.includes('机械切章 = 1.x 的页眉/章号行正则'));
  assert.equal(mech.includes('起始页'), false, '机械切章不得出现页数/字数输入');
  assert.equal(mech.includes('固定切页'), false);
});

test('AC-157：已分章显示本次来源、置信度、warnings 与 attempts', () => {
  const html = renderToString(
    React.createElement(
      components.ChapterBuildPanel,
      basePanel({
        built: true,
        source: 'bookmark',
        confidence: 0.95,
        warnings: ['前 3 页未归入任何章（书签从第 4 页开始）'],
        attempts: [
          { source: 'bookmark', result: 'used', chapters: 3 },
          { source: 'printed_toc', result: 'skipped', chapters: 0, reason: '已由前序来源命中' },
        ],
        onClose: () => {},
      }),
    ),
  );
  for (const text of ['本次来源：书签', '置信度 0.95', '前 3 页未归入任何章', '为什么用这个来源', '书签：已用 · 3 章']) {
    assert.ok(html.includes(text), '已分章面板应包含「' + text + '」');
  }
});

test('AC-157：章行来源徽标覆盖书签/目录/机械/手动/前文', () => {
  const cases = [
    [{ source: 'bookmark' }, '书签'],
    [{ source: 'printed_toc' }, '目录'],
    [{ source: 'mechanical' }, '机械'],
    [{ source: 'mechanical', manual: true }, '手动'],
    [{ source: 'mechanical', front: true }, '前文'],
  ];
  for (const [chapter, label] of cases) {
    const html = renderToString(React.createElement(components.ChapterSourceBadge, { chapter }));
    assert.ok(html.includes(label), '徽标应显示「' + label + '」');
  }
});

test('AC-157：outlineInfo 从 bookmarkTree 恢复单根提示', () => {
  const info = helpers.outlineInfo({
    chapterSource: 'bookmark',
    pages: 4,
    bookmarkRootDepth: 0,
    bookmarkTree: [
      {
        title: 'Book',
        page: 1,
        depth: 0,
        n: 1,
        children: [
          { title: 'Chapter 1', page: 2, depth: 1, children: [] },
          { title: 'Chapter 2', page: 3, depth: 1, children: [] },
        ],
      },
    ],
  });
  assert.deepEqual(info, {
    rootDepth: 0,
    rootCount: 1,
    canDescend: true,
    nextDepth: 1,
    nextCount: 2,
  });
  assert.equal(helpers.outlineInfo({ chapterSource: 'mechanical' }), null);
});

test('AC-157：书签树根可勾选、子节点只读；单根提示与回到顶层', () => {
  const tree = [
    {
      title: 'Book',
      page: 1,
      depth: 0,
      n: 1,
      children: [{ title: 'Chapter 1 Functions', page: 2, depth: 1, children: [] }],
    },
  ];
  const chapters = [{ n: 1, title: 'Book', from: 1, to: 4, chars: 100, source: 'bookmark' }];
  const html = renderToString(
    React.createElement(components.ChapterTree, {
      tree,
      rootDepth: 0,
      chapters,
      partOf: new Map(),
      selected: [],
      busy: false,
      expanded: new Set([1]),
      outline: { rootDepth: 0, rootCount: 1, canDescend: true, nextDepth: 1, nextCount: 1 },
      onToggleExpand: () => {},
      onToggleChapter: () => {},
      onDescend: () => {},
      onKeep: () => {},
      onTop: () => {},
    }),
  );
  for (const text of ['1 章 · 1 节', 'Book', 'Chapter 1 Functions', '书签原页', '下移一层导入', '保持 1 章']) {
    assert.ok(html.includes(text), '书签树应包含「' + text + '」');
  }
  assert.equal((html.match(/type="checkbox"/g) || []).length, 1, '只有根有 checkbox');

  const deeper = renderToString(
    React.createElement(components.ChapterTree, {
      tree: [
        {
          title: 'Book',
          page: 1,
          depth: 0,
          children: [{ title: 'Chapter 1', page: 2, depth: 1, n: 1, children: [] }],
        },
      ],
      rootDepth: 1,
      chapters: [{ n: 1, title: 'Chapter 1', from: 2, to: 4, chars: 100, source: 'bookmark' }],
      partOf: new Map(),
      selected: [],
      busy: false,
      expanded: new Set(),
      outline: { rootDepth: 1, rootCount: 1, canDescend: false, nextDepth: 2, nextCount: 0 },
      onToggleExpand: () => {},
      onToggleChapter: () => {},
      onDescend: () => {},
      onKeep: () => {},
      onTop: () => {},
    }),
  );
  assert.ok(deeper.includes('回到顶层'), '根层>0 应提供回到顶层');
  assert.ok(deeper.includes('书签只有 1 个根'));
  assert.equal(deeper.includes('下移一层导入'), false);
});

test('AC-157：Detail 有重新分章入口，且旧三选一文案不残留', () => {
  for (const text of [
    '重新分章',
    'openBuild',
    'ChapterBuildPanel',
    'ChapterTree',
    'chapterBuildRequest(',
    'outlineDepth',
    '下移一层导入',
    '回到顶层',
    '重新分章会覆盖',
  ]) {
    assert.ok(source.includes(text), 'client.js 应包含「' + text + '」');
  }
  for (const banned of ['自动（书签/标题/机械）', '目录（书签或印刷目录）', '固定切页']) {
    assert.equal(source.includes(banned), false, 'client.js 不应再出现「' + banned + '」');
  }
});
