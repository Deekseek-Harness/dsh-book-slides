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

test('书架卡片：菜单默认收起，「⋯」按钮带 aria-expanded', () => {
  const { mod } = bootPlugin();
  const html = renderToString(
    React.createElement(mod.__components.BookCard, {
      book: { id: 'aaaaaaaaaaaa', title: '一本书', chapters: 3, modules: 0, chars: 12000 },
      onOpen: () => {},
      onRename: () => {},
      onDelete: () => {},
    }),
  );
  assert.match(html, /aria-label="更多操作"/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /bl-menu/, '没点开时不该渲染菜单');
});

test('书架菜单：点屏幕其它区域或按 Esc 关闭，点菜单与「⋯」不误关', () => {
  const { mod } = bootPlugin();
  const listeners = new Map();
  const doc = {
    addEventListener(type, fn, capture) {
      listeners.set(type + (capture ? ':capture' : ''), fn);
    },
    removeEventListener(type, fn, capture) {
      listeners.delete(type + (capture ? ':capture' : ''));
    },
    fire(type, event) {
      const fn = listeners.get(type + ':capture');
      if (fn) fn(event);
    },
  };
  const menuEl = { contains: (target) => target === menuEl };
  const toggleEl = { contains: (target) => target === toggleEl };
  const elsewhere = { tag: 'card' };
  const reasons = [];

  const cleanup = mod.__utils.bindPopupDismiss(doc, {
    menu: menuEl,
    toggle: toggleEl,
    onDismiss: (reason) => reasons.push(reason),
  });
  assert.deepEqual([...listeners.keys()].sort(), ['click:capture', 'keydown:capture'], '两个监听都要走捕获阶段');

  doc.fire('click', { target: menuEl });
  doc.fire('click', { target: toggleEl });
  doc.fire('keydown', { key: 'Enter' });
  assert.deepEqual(reasons, [], '点菜单内部、点「⋯」、按其它键都不该关');

  doc.fire('click', { target: elsewhere });
  assert.deepEqual(reasons, ['outside'], '点屏幕其它区域 → 关');

  doc.fire('keydown', { key: 'Escape' });
  assert.deepEqual(reasons, ['outside', 'escape'], '按 Esc → 关');

  cleanup();
  assert.equal(listeners.size, 0, '关闭后要摘掉监听');
  doc.fire('click', { target: elsewhere });
  assert.deepEqual(reasons, ['outside', 'escape'], '摘掉后不再响应');

  // 没有 document / 没有回调时必须是安全空操作（SSR、卸载过程中会走到）
  assert.equal(typeof mod.__utils.bindPopupDismiss(null, { onDismiss: () => {} }), 'function');
  assert.equal(typeof mod.__utils.bindPopupDismiss(doc, {}), 'function');
});

test('生成定位：滚到对应条目，并把焦点放到取消按钮', () => {
  const { mod } = bootPlugin();
  const calls = [];
  const cancel = {
    focus(options) {
      calls.push(['focus', options]);
    },
  };
  const node = {
    scrollIntoView(options) {
      calls.push(['scroll', options]);
    },
    querySelector(selector) {
      calls.push(['query', selector]);
      return cancel;
    },
  };
  let queried = '';
  const root = {
    querySelector(selector) {
      queried = selector;
      return node;
    },
  };
  assert.equal(mod.__utils.focusJobEntry(root, 'aaaaaaaaaaaa'), true);
  assert.equal(queried, '[data-job-item="aaaaaaaaaaaa"]');
  assert.deepEqual(calls[0], ['scroll', { block: 'center', behavior: 'smooth' }]);
  assert.deepEqual(
    calls.find((call) => call[0] === 'focus'),
    ['focus', { preventScroll: true }],
  );
  assert.equal(
    calls.some((call) => call[0] === 'query' && call[1] === '[data-job-cancel="1"]'),
    true,
  );

  // 不支持 smooth 的嵌入环境退回到普通滚动
  const fallback = [];
  const oldBrowser = {
    scrollIntoView(options) {
      if (options && options.behavior) throw new Error('unknown option');
      fallback.push(options);
    },
    querySelector() {
      return null;
    },
  };
  assert.equal(
    mod.__utils.focusJobEntry({ querySelector: () => oldBrowser }, 'bbbbbbbbbbbb'),
    true,
  );
  assert.deepEqual(fallback, [{ block: 'center' }]);

  // 找不到条目 / 没有容器时不能报错
  assert.equal(mod.__utils.focusJobEntry({ querySelector: () => null }, 'cccccccccccc'), false);
  assert.equal(mod.__utils.focusJobEntry(null, 'cccccccccccc'), false);
  assert.equal(mod.__utils.focusJobEntry({}, 'cccccccccccc'), false);
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
  assert.match(html, /语音/);
  assert.match(html, /浏览器朗读/);
  assert.match(html, /试听/);
});

test('生成进度条：阶段名、进度、取消按钮都能渲染', () => {
  const { mod } = bootPlugin();
  const html = renderToString(
    React.createElement(mod.__components.JobBox, {
      job: { moduleId: 'aaaaaaaaaaaa', status: 'structuring', stage: 'structuring', current: 2, total: 3, message: '正在改写第 2/3 批原文' },
      onCancel: () => {},
    }),
  );
  assert.match(html, /生成中/);
  assert.match(html, /改写文案/);
  assert.match(html, /2\/3/);
  assert.match(html, /正在改写第 2\/3 批/);
  assert.match(html, /取消/);

  const cancelling = renderToString(
    React.createElement(mod.__components.JobBox, {
      job: { moduleId: 'aaaaaaaaaaaa', status: 'cancelling', stage: 'structuring', current: 2, total: 3, message: '正在取消…' },
      onCancel: () => {},
    }),
  );
  assert.match(cancelling, /正在取消/);
});

test('模块列表：就绪、失败、删除/重试按钮都能渲染', () => {
  const { mod } = bootPlugin();
  const modules = [
    { id: 'aaaaaaaaaaaa', title: '精讲：第 1–3 章', status: 'ready', slides: 8, anchorHitRate: 0.95, chapters: [1, 2, 3] },
    { id: 'bbbbbbbbbbbb', title: '精讲：第 4 章', status: 'failed', code: 'E_LLM_JSON', error: '模型输出格式异常，已重试', slides: 0, chapters: [4] },
  ];
  const html = renderToString(
    React.createElement(mod.__components.ModuleList, {
      modules: modules,
      busy: false,
      onOpen: () => {},
      onRetry: () => {},
      onDelete: () => {},
      onRegenerate: () => {},
    }),
  );
  assert.match(html, /精讲：第 1–3 章/);
  assert.match(html, /已就绪/);
  assert.match(html, /锚定 95%/);
  assert.match(html, /打开/);
  assert.match(html, /失败/);
  assert.match(html, /E_LLM_JSON/);
  assert.match(html, /重试/);
  assert.match(html, /删除/);
  assert.match(html, /重生成/);
});

test('模块列表：生成中的模块留在列表里，带进度/取消且不重复', () => {
  const { mod } = bootPlugin();
  const modules = [
    { id: 'aaaaaaaaaaaa', title: '精讲：第 1–3 章', status: 'queued', slides: 0, chapters: [1, 2, 3] },
    { id: 'bbbbbbbbbbbb', title: '精讲：第 4 章', status: 'ready', slides: 5, anchorHitRate: 0.9, chapters: [4] },
  ];
  const html = renderToString(
    React.createElement(mod.__components.ModuleList, {
      modules: modules,
      busy: false,
      job: { moduleId: 'aaaaaaaaaaaa', status: 'structuring', stage: 'structuring', current: 2, total: 3, message: '正在改写第 2/3 批原文' },
      onCancel: () => {},
      onOpen: () => {},
      onRetry: () => {},
      onDelete: () => {},
      onRegenerate: () => {},
    }),
  );
  assert.match(html, /bl-mod-run/, '生成中的条目要有高亮样式');
  assert.match(html, /data-job-item="aaaaaaaaaaaa"/, '条目要能被定位');
  assert.match(html, /data-job-cancel="1"/, '取消按钮要能被找到');
  assert.match(html, /正在改写第 2\/3 批原文/);
  assert.equal((html.match(/精讲：第 1–3 章/g) || []).length, 1, '同一模块不能既渲染成普通行又渲染成生成中条目');
  assert.match(html, /精讲：第 4 章/, '其它模块照常显示');
  assert.match(html, /2 个/, '计数要把生成中的模块算进去');

  const synthetic = renderToString(
    React.createElement(mod.__components.ModuleList, {
      modules: [],
      busy: false,
      job: { moduleId: 'cccccccccccc', status: 'queued', stage: 'queued', current: 0, total: 0, message: '已排队' },
      onCancel: () => {},
      onOpen: () => {},
      onRetry: () => {},
      onDelete: () => {},
      onRegenerate: () => {},
    }),
  );
  assert.match(synthetic, /正在生成的精讲/, '列表还没刷新时也要先占一个条目');
  assert.match(synthetic, /排队中/);
  assert.match(synthetic, /1 个/);
});

test('幻灯片舞台：封面、要点、引文三种版式各自渲染', () => {
  const { mod } = bootPlugin();
  const slide = {
    slide_index: 2,
    layout: 'content_text',
    title: '一页讲一个意思',
    subtitle: '',
    bullet_points: ['要点一', '要点二'],
    image_prompt: '书桌上摊开的书，暖色晨光',
    audio_script: '大家好，这一页我们讲一个很短的意思。',
    source_pages: { from: 2, to: 4 },
    source_anchor: { page: 3, para_index: 1 },
    anchor_status: 'anchored',
  };
  const content = renderToString(React.createElement(mod.__components.SlideStage, { slide: slide }));
  assert.match(content, /一页讲一个意思/);
  assert.match(content, /要点一/);
  assert.match(content, /配图位/);
  assert.match(content, /第 2 页/);

  const quote = renderToString(
    React.createElement(mod.__components.SlideStage, {
      slide: Object.assign({}, slide, { layout: 'quote', quote_text: '导演的工作，远不止喊一声「开机」。', quote_source: '测试书' }),
    }),
  );
  assert.match(quote, /bl-stage-quote/);
  assert.match(quote, /导演的工作/);
  assert.match(quote, /测试书/);

  const cover = renderToString(
    React.createElement(mod.__components.SlideStage, {
      slide: { slide_index: 1, layout: 'cover', title: '封面大标题', subtitle: '第 1 章' },
    }),
  );
  assert.match(cover, /封面大标题/);
  assert.match(cover, /第 1 章/);
  assert.match(cover, /bl-stage-rule/);
});

test('PDF 原文窗格：视觉版式容器、页码与锚点提示条', () => {
  const { mod } = bootPlugin();
  const slide = {
    slide_index: 2,
    source_quote: '第二段文字',
    source_pages: { from: 2, to: 3 },
    source_anchor: { page: 2, para_index: 1 },
    anchor_status: 'anchored',
  };
  const html = renderToString(
    React.createElement(mod.__components.SourcePane, {
      pdfDoc: {},
      pdfLoading: false,
      pdfError: null,
      slide: slide,
      bookId: 'aaaaaaaaaaaa',
    }),
  );
  assert.match(html, /bl-pdf-pages/);
  assert.match(html, /bl-pdf-page/);
  assert.match(html, /data-page="2"/);
  assert.match(html, /data-page="3"/);
  assert.match(html, /第 2 页/);
  assert.match(html, /#page=2/);
  assert.match(html, /打开原始 PDF/);
  assert.doesNotMatch(html, /未定位到原句/);

  const unanchored = renderToString(
    React.createElement(mod.__components.SourcePane, {
      pdfDoc: {},
      pdfLoading: false,
      pdfError: null,
      slide: Object.assign({}, slide, { source_anchor: null, anchor_status: 'unanchored' }),
      bookId: 'aaaaaaaaaaaa',
    }),
  );
  assert.match(unanchored, /未定位到原句/);
  assert.match(unanchored, /显示整页 PDF/);

  const loading = renderToString(
    React.createElement(mod.__components.SourcePane, {
      pdfDoc: null,
      pdfLoading: true,
      pdfError: null,
      slide: slide,
      bookId: 'aaaaaaaaaaaa',
    }),
  );
  assert.match(loading, /正在渲染 PDF 原文/);
});

test('PDF 高亮几何：把 source_quote 映射成页内百分比矩形', () => {
  const { mod } = bootPlugin();
  const pdfjs = {
    Util: {
      transform: (m1, m2) => [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
      ],
    },
  };
  const items = [
    { str: '第一段文字', transform: [1, 0, 0, 10, 100, 700], width: 40 },
    { str: '第二段文字', transform: [1, 0, 0, 10, 150, 700], width: 40 },
    { str: '下一行', transform: [1, 0, 0, 10, 100, 680], width: 30 },
  ];
  const viewport = { transform: [1, 0, 0, -1, 0, 800], width: 600, height: 800, scale: 1 };
  const rects = mod.__utils.pdfHighlightRects(items, '第二段文字', viewport, pdfjs);
  assert.equal(rects.length, 1);
  assert.ok(rects[0].left > 20 && rects[0].left < 30, 'left 应约 25%');
  assert.ok(rects[0].width > 5 && rects[0].width < 10, '宽约 6.7%');
  assert.ok(rects[0].top > 0 && rects[0].top < 100);
  assert.equal(mod.__utils.normalizePdfText('第二段，文字！'), '第二段文字');
  assert.equal(mod.__utils.pdfHighlightRects(items, '完全不存在的句子', viewport, pdfjs).length, 0);
});

test('PDF 渲染取消：取消异常不显示为渲染失败', () => {
  const { mod } = bootPlugin();
  assert.equal(mod.__utils.isRenderCancelled({ name: 'RenderingCancelledException', message: 'cancelled' }), true);
  assert.equal(mod.__utils.isRenderCancelled(new Error('Rendering cancelled')), true);
  assert.equal(
    mod.__utils.isRenderCancelled(new Error('Cannot use the same canvas during multiple render() operations.')),
    false,
  );
});

test('书架「继续听」：有播放进度时显示页码入口', () => {
  const { mod } = bootPlugin();
  const books = [
    { id: 'aaaaaaaaaaaa', title: '一本书', author: '某人', pages: 10, chapters: 3, modules: 1, chars: 12000 },
    { id: 'bbbbbbbbbbbb', title: '另一本书', author: '', pages: 5, chapters: 1, modules: 1, chars: 800 },
  ];
  const progress = { lastBookId: 'aaaaaaaaaaaa', lastModuleId: 'cccccccccccc', lastSlide: 7 };
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
      progress: progress,
      onContinue: () => {},
    }),
  );
  assert.match(html, /继续听 · 第 7 页/);
  assert.equal((html.match(/继续听/g) || []).length, 1, '只有进度指向的那本书显示继续听');
});

test('分屏播放器：初始页、舞台、控制条、缩略图都能渲染', () => {
  const { mod } = bootPlugin();
  const slides = [
    { slide_index: 1, layout: 'cover', title: '封面标题', source_pages: { from: 1, to: 1 }, source_anchor: { page: 1, para_index: 0 }, anchor_status: 'anchored' },
    { slide_index: 2, layout: 'content_text', title: '第二页标题', bullet_points: ['要点'], source_pages: { from: 2, to: 2 }, source_anchor: { page: 2, para_index: 0 }, anchor_status: 'anchored' },
    { slide_index: 3, layout: 'quote', title: '第三页标题', quote_text: '一句引文', quote_source: '书', source_pages: { from: 3, to: 3 }, source_anchor: { page: 3, para_index: 0 }, anchor_status: 'anchored' },
  ];
  const html = renderToString(
    React.createElement(mod.__components.Player, {
      book: { id: 'aaaaaaaaaaaa', title: '一本书' },
      module: { id: 'bbbbbbbbbbbb', title: '精讲：第 1 章', status: 'ready', voice: { provider: 'browser', rate: 1 }, slides: 3 },
      slides: slides,
      initialSlide: 2,
      onBack: () => {},
      setError: () => {},
    }),
  );
  assert.match(html, /第二页标题/);
  assert.match(html, /第 2 \/ 3 页/);
  assert.match(html, /开始听/);
  assert.match(html, /正在渲染 PDF 原文/);
  assert.match(html, /播放语速/);
  assert.match(html, /静音/);
  assert.match(html, /空格 播放\/暂停/);
  assert.match(html, /bl-thumbs/);
  assert.match(html, /封面标题/);
  assert.match(html, /第三页标题/);
  assert.match(html, /aria-label="跳到第 1 页"/);
  assert.match(html, /aria-current="page"/);
  assert.match(html, /width:0%/);
});

test('模块预览页：加载态能渲染', () => {
  const { mod } = bootPlugin();
  const html = renderToString(
    React.createElement(mod.__components.ModuleView, {
      moduleId: 'aaaaaaaaaaaa',
      onBack: () => {},
      error: null,
      setError: () => {},
    }),
  );
  assert.match(html, /正在打开模块/);
});

test('设置页语音：Qwen 模型/Key 掩码/音色下拉能渲染', () => {
  const { mod } = bootPlugin();
  const html = renderToString(
    React.createElement(mod.__components.Settings, {
      onBack: () => {},
      initial: {
        voice: {
          provider: 'qwen3-tts',
          model: 'qwen3-tts-flash',
          voice: 'Cherry',
          rate: 1,
          hasKey: true,
          apiKeyMask: '••••1234',
          configured: true,
        },
        providers: [
          { id: 'qwen3-tts', label: 'Qwen3-TTS（千问 AI）', ready: true },
          { id: 'browser', label: '浏览器朗读（本机合成）', ready: true },
          { id: 'off', label: '关闭', ready: true },
        ],
        models: [{ id: 'qwen3-tts-flash', label: 'Qwen3-TTS Flash（非实时）', ready: true }],
        qwenVoices: [
          { id: 'Cherry', desc: '阳光积极、亲切自然小姐姐', gender: '女', dialect: '' },
          { id: 'Serena', desc: '温柔小姐姐', gender: '女', dialect: '' },
        ],
      },
    }),
  );
  assert.match(html, /Qwen3-TTS（千问 AI）/);
  assert.match(html, /AI 模型/);
  assert.match(html, /Qwen3-TTS Flash（非实时）/);
  assert.match(html, /已保存 · 尾号 1234/);
  assert.match(html, /Cherry · 阳光积极/);
  assert.match(html, /试听/);
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
test('书架工具栏：导入书档、策略下拉、选择模式与导出条', () => {
  const { mod } = bootPlugin();
  const books = [
    { id: 'aaaaaaaaaaaa', title: '一本书', author: '', pages: 10, chapters: 3, modules: 0, chars: 12000 },
    { id: 'bbbbbbbbbbbb', title: '另一本书', author: '', pages: 5, chapters: 1, modules: 0, chars: 800 },
  ];
  const html = renderToString(
    React.createElement(mod.__components.Shelf, {
      books: books,
      loading: false,
      onOpen: () => {},
      onRename: () => {},
      onDelete: () => {},
      onImport: () => {},
      onImportPackage: () => {},
      onSelecting: () => {},
      selecting: true,
      selected: ['aaaaaaaaaaaa'],
      onToggleSelect: () => {},
      onExport: () => {},
      onPolicyChange: () => {},
      policy: 'merge',
      error: null,
      onDismissError: () => {},
    }),
  );
  assert.match(html, /导入书档/);
  assert.match(html, /已有则合并/);
  assert.match(html, /已有则跳过/);
  assert.match(html, /已有则另存/);
  assert.match(html, /已选 1 本/);
  assert.match(html, /导出书档/);
  assert.match(html, /aria-label="选择《一本书》"/);
  assert.match(html, /bl-card bl-line picked/);
});

test('导出确认层：先估体积，再决定含不含音频', () => {
  const { mod } = bootPlugin();
  const html = renderToString(React.createElement(mod.__components.ExportDialog, { ids: ['aaaaaaaaaaaa'], onClose: () => {} }));
  assert.match(html, /role="dialog"/);
  assert.match(html, /正在估算体积/);
  assert.match(html, /开始导出/);
  assert.match(html, /aria-label="导出书档"/);
});

test('导入结果层：四类计数、逐项错误码与「打开」入口', () => {
  const { mod } = bootPlugin();
  const result = {
    items: [
      { file: 'a.zip', bookId: 'aaaaaaaaaaaa', title: '一本书', status: 'imported', modulesAdded: 2 },
      { file: 'b.zip', bookId: 'bbbbbbbbbbbb', title: '另一本书', status: 'merged', modulesAdded: 0, moduleExists: 1 },
      { file: 'c.zip', title: '', status: 'failed', code: 'E_PKG_CHECKSUM' },
    ],
    summary: { imported: 1, merged: 1, skipped: 0, failed: 1 },
  };
  const html = renderToString(
    React.createElement(mod.__components.ImportResult, {
      result: result,
      onClose: () => {},
      onOpenBook: () => {},
    }),
  );
  assert.match(html, /导入 1 · 合并 1 · 已存在 0 · 失败 1/);
  assert.match(html, /E_PKG_CHECKSUM/);
  assert.match(html, /打开《一本书》/);
});

test('文件选择框：清空 value 之前先把 FileList 复制出来（导入 zip 静默失败的回归）', () => {
  const { mod } = bootPlugin();
  const files = [{ name: '书档.zip' }];
  const target = { value: 'C:\\fakepath\\书档.zip' };
  Object.defineProperty(target, 'files', {
    get() {
      return target.value === '' ? [] : files;
    },
    configurable: true,
  });
  const picked = mod.__utils.takeFilesFromInput({ target });
  assert.equal(picked.length, 1, '清空后仍应拿到选中的文件');
  assert.equal(picked[0].name, '书档.zip');
  assert.equal(target.value, '', '拿完必须清空，才能再次选同一个文件');

  const empty = mod.__utils.takeFilesFromInput({ target: { files: null, value: '' } });
  assert.deepEqual(empty, []);
});
