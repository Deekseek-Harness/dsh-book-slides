/**
 * 面板渲染测试 —— 不开浏览器，用 react-dom/server 把面板首屏渲染出来。
 *
 *   node test/panel.test.mjs
 *
 * 能抓到的东西：client.js 的语法错、组件里的属性拼错、首屏直接抛异常。
 * 抓不到的：交互、样式、真实数据（首屏是加载态，useEffect 在 SSR 里不跑）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToString } = require('react-dom/server');

/** 截住 window.__ModuleLoader__.load，拿到插件定义。 */
let definition = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      definition = def;
    },
  },
};

await import('../client.js');

/** 按插件的 require 约定取模块。 */
function pluginRequire(name) {
  if (name === 'react') return React;
  throw new Error('插件不该 require ' + name);
}

function bootPlugin() {
  assert.ok(definition, 'client.js 应该调用 window.__ModuleLoader__.load');
  assert.equal(definition.id, 'dsh-book-slides');
  const mod = definition.factory(pluginRequire);
  const registered = [];
  const slots = {
    inject(name, fn) {
      fn();
    },
    register(entry, component) {
      registered.push({ entry: entry, component: component });
      return () => {};
    },
  };
  const ctx = {
    slots: slots,
    effect(fn) {
      return fn();
    },
  };
  mod.apply(ctx);
  return { registered, mod };
}

test('插件注册：侧栏图标 + 主面板两个插槽', () => {
  const { registered } = bootPlugin();
  const sidebar = registered.find((r) => r.entry.name === 'sidebar.panellist');
  const main = registered.find((r) => r.entry.name === 'main');
  assert.ok(sidebar, '应该注册 sidebar.panellist');
  assert.equal(sidebar.entry.id, 'book-slides');
  assert.equal(sidebar.entry.label, '精讲');
  assert.equal(sidebar.entry.order, 30, '侧栏顺序要排在书库（25）后面');
  assert.ok(main, '应该注册 main 面板');
  assert.equal(main.entry.key, 'book-slides');
});

test('首屏渲染不炸：加载态能出 DOM', () => {
  const { registered } = bootPlugin();
  const main = registered.find((r) => r.entry.name === 'main');
  const html = renderToString(React.createElement(main.component));
  assert.match(html, /bl-root/, '应该有面板根节点');
  assert.match(html, /正在翻书架/, '首屏应该是加载态');
  assert.match(html, /导入 PDF/, '顶栏应该有导入按钮');
});

test('图标能单独渲染，且是个 24×24 的 SVG', () => {
  const { registered } = bootPlugin();
  const sidebar = registered.find((r) => r.entry.name === 'sidebar.panellist');
  const html = renderToString(React.createElement(sidebar.component, { size: 18 }));
  assert.match(html, /<svg/);
  assert.match(html, /width="18"/);
});

test('书架有书时渲染卡片：书名、章数、字数', () => {
  const { mod } = bootPlugin();
  const books = [
    { id: 'aaaaaaaaaaaa', title: '一本书', author: '某人', pages: 10, chapters: 3, modules: 0, chars: 12000 },
    { id: 'bbbbbbbbbbbb', title: '另一本书', author: '', pages: 5, chapters: 1, modules: 2, chars: 800 },
  ];
  const html = renderToString(
    React.createElement(mod.__components.Shelf, {
      books: books,
      loading: false,
      onOpen: () => {},
      onRename: () => {},
      onDelete: () => {},
      onImport: () => {},
      error: null,
      onDismissError: () => {},
    }),
  );
  assert.match(html, /一本书/);
  assert.match(html, /3 章 · 1\.2 万字/);
  assert.match(html, /2 个精讲/);
  assert.match(html, /\/dsh-book-slides\/cover\?bookId=aaaaaaaaaaaa/);
});

test('详情页在加载态与出错态都能渲染', () => {
  const { mod } = bootPlugin();
  const loading = renderToString(
    React.createElement(mod.__components.Detail, {
      bookId: 'aaaaaaaaaaaa',
      onBack: () => {},
      error: null,
      setError: () => {},
    }),
  );
  assert.match(loading, /正在打开/);
  assert.match(loading, /勾选章节，合成一个精讲模块/, '底栏应该有选章引导');
  assert.match(loading, /生成精讲/);

  const failed = renderToString(
    React.createElement(mod.__components.Detail, {
      bookId: 'aaaaaaaaaaaa',
      onBack: () => {},
      error: { message: '找不到这本书', hint: '书架里可能已经删掉了。' },
      setError: () => {},
    }),
  );
  assert.match(failed, /找不到这本书/);
});

test('设置页能渲染', () => {
  const { mod } = bootPlugin();
  const html = renderToString(React.createElement(mod.__components.Settings, { onBack: () => {} }));
  assert.match(html, /正在读/);
});

test('目录切章面板：建议范围、预览、状态文案都能渲染', () => {
  const { mod } = bootPlugin();
  const base = { from: '9', to: '15', total: 608, suggested: { from: 9, to: 15 }, busy: false, message: '', preview: '' };
  const html = renderToString(
    React.createElement(mod.__components.TocBox, {
      toc: base,
      onFrom: () => {},
      onTo: () => {},
      onPreview: () => {},
      onParse: () => {},
    }),
  );
  assert.match(html, /按目录切章/);
  assert.match(html, /建议 9–15 页（共 608 页）/);
  assert.match(html, /value="9"/);
  assert.match(html, /value="15"/);

  const preview = renderToString(
    React.createElement(mod.__components.TocBox, {
      toc: Object.assign({}, base, { message: 'verified · 偏移 15 页 · 标题命中率 100%', preview: 'L1: 第1章 计算机概念和技术' }),
      onFrom: () => {},
      onTo: () => {},
      onPreview: () => {},
      onParse: () => {},
    }),
  );
  assert.match(preview, /标题命中率 100%/);
  assert.match(preview, /L1: 第1章/);

  const busy = renderToString(
    React.createElement(mod.__components.TocBox, { toc: Object.assign({}, base, { busy: true }), onFrom: () => {}, onTo: () => {}, onPreview: () => {}, onParse: () => {} }),
  );
  assert.match(busy, /读目录中/);
});
test('来源提示：目录结果、机械回退、以及「有更好的没被采用」都要看得出来', () => {
  const { mod } = bootPlugin();
  const tocInfo = { status: 'verified', offset: 15, hitRate: 1 };

  const tocChapters = [
    { n: 0, title: '前文', front: true, source: 'toc' },
    { n: 1, title: '第1章 甲', source: 'toc' },
    { n: 2, title: '第2章 乙', source: 'toc' },
  ];
  const fromToc = renderToString(React.createElement(mod.__components.SourceNote, { chapters: tocChapters, info: tocInfo }));
  assert.match(fromToc, /结果来源：目录/);
  assert.match(fromToc, /偏移 15 页 · 命中 100%/);
  assert.doesNotMatch(fromToc, /没被采用/);

  const mechChapters = [
    { n: 1, title: '第1章 甲', source: 'mechanical' },
    { n: 2, title: '第2章 乙', source: 'mechanical' },
  ];
  const mech = renderToString(React.createElement(mod.__components.SourceNote, { chapters: mechChapters, info: tocInfo }));
  assert.match(mech, /结果来源：页眉（机械）/);
  assert.match(mech, /没被采用/, '库里有目录结果却没在用时，必须提醒');

  const plain = renderToString(React.createElement(mod.__components.SourceNote, { chapters: mechChapters, info: null }));
  assert.match(plain, /结果来源：页眉（机械）/);
  assert.doesNotMatch(plain, /没被采用/, '没有目录结果时不该提醒');
});