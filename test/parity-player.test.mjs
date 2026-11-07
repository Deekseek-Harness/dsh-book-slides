/**
 * 2.0 M4 播放器对等（FR-18 / AC-107 / AC-108 / AC-109 / AC-123）。
 *
 * 纯函数覆盖：PDF 锚点高亮矩形、键盘映射、音频模式、连播去向、续播页码；
 * SSR 覆盖：原文窗格（命中/未命中锚点）、过渡卡、系列目录、三种版式与空态。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../v2/client.js', import.meta.url), 'utf8');
const React = require('react');
const { renderToString } = require('react-dom/server');

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

const VIEWPORT = { width: 600, height: 800, scale: 1, transform: [1, 0, 0, -1, 0, 800] };

function pdfItem(str, x, y, width = 60) {
  return { str, transform: [10, 0, 0, 10, x, y], width };
}

test('AC-123：source_anchor 命中时返回页面内百分比矩形，未命中返回空', () => {
  const items = [
    pdfItem('函数把输入映到输出。', 40, 700, 200),
    pdfItem('极限只关心靠近某点时的结果，并且这是同一行的后半句。', 40, 670, 320),
  ];
  const full = '极限只关心靠近某点时的结果，并且这是同一行的后半句。';
  const rects = helpers.pdfHighlightRects(items, full, VIEWPORT);
  assert.equal(rects.length, 1);
  const rect = rects[0];
  assert.ok(rect.left >= 0 && rect.left <= 100);
  assert.ok(rect.top >= 0 && rect.top <= 100);
  assert.ok(rect.width > 0 && rect.width <= 100);
  assert.ok(rect.height > 0 && rect.height <= 100);
  // viewport 变换把基线 y=670 映射到 130；减去字高 10 后顶部 120 → 15%
  assert.ok(Math.abs(rect.top - (120 / 800) * 100) < 0.5, 'top 应贴近该行顶部');
  assert.ok(Math.abs(rect.left - (40 / 600) * 100) < 0.5, 'left 应贴近该行起点');

  assert.deepEqual(helpers.pdfHighlightRects(items, '这段原文不在页面上', VIEWPORT), []);
  // 长句找不到时用前 14 字兜底
  const prefix = helpers.pdfHighlightRects(items, '极限只关心靠近某点时的结果，并且这一句并不在原页上。', VIEWPORT);
  assert.equal(prefix.length, 1);
});

test('AC-123：PDF 文本归一化去空白/标点并做全角半角', () => {
  assert.equal(helpers.normalizePdfText(' 极 限，ＡＢＣ！ '), '极限abc');
  assert.equal(helpers.normalizePdfText(''), '');
  assert.deepEqual(helpers.pdfTransform([1, 0, 0, 1, 10, 20], [2, 0, 0, 2, 5, 5]), [2, 0, 0, 2, 15, 25]);
});

test('AC-123：键盘映射 空格/←/→/F/Esc；表单与修饰键不抢', () => {
  assert.equal(helpers.playerKeyAction({ code: 'Space', key: ' ' }), 'play');
  assert.equal(helpers.playerKeyAction({ key: 'ArrowRight' }), 'next');
  assert.equal(helpers.playerKeyAction({ key: 'ArrowLeft' }), 'prev');
  assert.equal(helpers.playerKeyAction({ key: 'f' }), 'fullscreen');
  assert.equal(helpers.playerKeyAction({ key: 'F' }), 'fullscreen');
  assert.equal(helpers.playerKeyAction({ key: 'Escape' }), 'escape');
  assert.equal(helpers.playerKeyAction({ key: 'ArrowRight', ctrlKey: true }), null);
  assert.equal(helpers.playerKeyAction({ key: 'ArrowRight', metaKey: true }), null);
  assert.equal(helpers.playerKeyAction({ code: 'Space', key: ' ', target: { tagName: 'INPUT' } }), null);
  assert.equal(helpers.playerKeyAction({ key: 'ArrowRight', target: { tagName: 'TEXTAREA' } }), null);
  // 配图位等 role=button 自己处理空格；方向键仍全局生效
  assert.equal(
    helpers.playerKeyAction({ code: 'Space', key: ' ', target: { tagName: 'DIV', getAttribute: () => 'button' } }),
    null,
  );
  assert.equal(helpers.playerKeyAction({ code: 'Space', key: ' ', target: { tagName: 'BUTTON' } }), null);
  assert.equal(helpers.playerKeyAction({ key: 'ArrowRight', target: { tagName: 'BUTTON' } }), 'next');
  assert.equal(helpers.playerKeyAction({ key: 'x' }), null);
});

test('AC-109：有音频播文件；browser 才朗读；Qwen 失败不回退浏览器', () => {
  assert.equal(helpers.slideAudioMode({ audio_file: 'audio/001.wav', audio_provider: 'qwen3-tts' }), 'file');
  assert.equal(helpers.slideAudioMode({ audio_file: null, audio_provider: 'browser', audio_script: '稿子' }), 'speech');
  assert.equal(helpers.slideAudioMode({ audio_file: null, audio_provider: 'qwen3-tts', audio_script: '稿子' }), 'none');
  assert.equal(helpers.slideAudioMode({ audio_file: null, audio_provider: 'none', audio_script: '' }), 'none');
  assert.equal(helpers.slideAudioMode(null), 'none');
});

test('换一张不重启播放：playbackKey 只认本页音频字段，图片变化不影响', () => {
  const base = {
    slide_index: 3,
    audio_file: 'audio/003.wav',
    audio_provider: 'qwen3-tts',
    audio_ms: 1200,
    audio_script: '上一 p 说到……',
  };
  const key = helpers.playbackKey(base);
  assert.equal(helpers.playbackKey(Object.assign({}, base, { image_status: 'ready', image_file: 'images/003.png', image_seed: 7 })), key);
  assert.equal(helpers.playbackKey(Object.assign({}, base, { image_status: 'generating', image_file: null, image_seed: null })), key);
  assert.notEqual(helpers.playbackKey(Object.assign({}, base, { audio_file: 'audio/004.wav' })), key);
  assert.notEqual(helpers.playbackKey(Object.assign({}, base, { audio_script: '换了一段稿子' })), key);
  assert.notEqual(helpers.playbackKey(Object.assign({}, base, { audio_ms: 2400 })), key);
  assert.equal(helpers.playbackKey(null), '');
});

test('播放 effect 依赖的是音频签名，不是整个 slides 数组', () => {
  assert.ok(source.includes('slides.length, pageAudioKey'), '依赖里应有 slides.length + pageAudioKey');
  assert.equal(source.includes('lectureN, seriesId, slides, advance'), false, '不应再把整个 slides 数组放进依赖');
});

test('换一张期间不写 slides：只轮询 job 状态，结束时刷新一次', () => {
  const start = source.indexOf('const regenImage = useCallback');
  const end = source.indexOf('const nextPage = useCallback');
  assert.ok(start >= 0 && end > start, '能找到 regenImage 函数体');
  const body = source.slice(start, end);
  assert.equal((body.match(/setSlidesByLecture/g) || []).length, 1, 'regenImage 里只允许结束时刷新一次讲数据');
  assert.ok(body.includes('/image/status'), '应先轮询 /image/status');
  assert.equal((body.match(/\/lecture\?seriesId=/g) || []).length, 1, '结束时只拉一次 /lecture');
});

test('换图临时覆盖：只换图片字段，保留旧图给生成期/失败回退', () => {
  const slide = {
    slide_index: 3,
    image_status: 'failed',
    image_file: 'images/003.png',
    image_seed: 7,
    title: '页面',
  };
  assert.equal(helpers.slideWithImageOverride(slide, null), slide, '没有覆盖时原样返回');
  const display = helpers.slideWithImageOverride(slide, { status: 'regenerating', file: 'images/003.png', seed: 7 });
  assert.equal(display.image_file, 'images/003.png');
  assert.equal(display.image_seed, 7);
  assert.equal(display.image_status, 'failed', '生成中不伪造 ready，避免影响状态判断');
  assert.equal(display.title, '页面');
  const noImage = helpers.slideWithImageOverride(
    { slide_index: 4, image_status: 'failed', image_file: null, image_seed: null },
    { status: 'regenerating', file: '', seed: 0 },
  );
  assert.equal(noImage.image_file, '');
});

test('AC-107/109：讲末页 → 下一讲就绪给过渡；失败讲 blocked；最后一讲结束', () => {
  const ready = {
    lectures: [
      { n: 1, status: 'ready', title: '第 1 讲' },
      { n: 2, status: 'ready', title: '第 2 讲 · 极限' },
    ],
  };
  assert.deepEqual(helpers.nextLectureAfter(ready, 1), { kind: 'transition', n: 2, title: '第 2 讲 · 极限', skipped: [] });
  assert.deepEqual(helpers.nextLectureAfter(ready, 2), { kind: 'end' });

  const failed = {
    lectures: [
      { n: 1, status: 'ready', title: '第 1 讲' },
      { n: 2, status: 'failed', title: '第 2 讲 · 极限' },
    ],
  };
  const blocked = helpers.nextLectureAfter(failed, 1);
  assert.equal(blocked.kind, 'blocked');
  assert.equal(blocked.n, 2);

  // 中间讲失败但后面还有就绪讲：跳过失败讲，记下 skipped
  const skip = {
    lectures: [
      { n: 1, status: 'ready', title: '第 1 讲' },
      { n: 2, status: 'failed', title: '第 2 讲' },
      { n: 3, status: 'ready', title: '第 3 讲' },
    ],
  };
  assert.deepEqual(helpers.nextLectureAfter(skip, 1), {
    kind: 'transition',
    n: 3,
    title: '第 3 讲',
    skipped: [2],
  });

  const single = { lectures: [{ n: 1, status: 'ready', title: '唯一一讲' }] };
  assert.deepEqual(helpers.nextLectureAfter(single, 1), { kind: 'end' });
  assert.deepEqual(helpers.nextLectureAfter({ lectures: [] }, 1), { kind: 'end' });
});

test('AC-108：按上次页码续播，越界夹回第 1/最后一页', () => {
  const slides = [{ slide_index: 1 }, { slide_index: 2 }, { slide_index: 3 }];
  assert.equal(helpers.resolveInitialSlide(slides, 3), 2);
  assert.equal(helpers.resolveInitialSlide(slides, 99), 2);
  assert.equal(helpers.resolveInitialSlide(slides, 0), 0);
  assert.equal(helpers.resolveInitialSlide([], 2), 0);
});

test('AC-123：原文窗格命中锚点显示页码 chip 与原句；未锚定显示提示', () => {
  const base = {
    slide_index: 3,
    layout: 'content_text',
    title: '第 3 页',
    source_pages: { from: 7, to: 7 },
    source_quote: '极限只关心靠近某点时的结果。',
    source_anchor: { page: 7, text: '极限只关心靠近某点时的结果。', rect: null },
  };
  const anchored = renderToString(
    React.createElement(components.SourcePane, {
      pdfDoc: null,
      pdfLoading: true,
      pdfError: null,
      slide: base,
      bookId: 'aaaaaaaaaaaa',
    }),
  );
  assert.ok(anchored.includes('第 7 页'), '应显示页码 chip');
  assert.ok(anchored.includes('打开原始 PDF'));
  assert.ok(anchored.includes('正在渲染 PDF 原文'));
  assert.ok(anchored.includes('blm-source-top'), '页码与提示区必须在 sticky 容器里，滚动时提示不消失');

  const unanchored = renderToString(
    React.createElement(components.SourcePane, {
      pdfDoc: null,
      pdfLoading: true,
      pdfError: null,
      slide: Object.assign({}, base, { source_anchor: null }),
      bookId: 'aaaaaaaaaaaa',
    }),
  );
  assert.ok(unanchored.includes('本页未定位到原句'));

  // 数据一致性兜底：只把 anchor_status 置 unanchored（旧锚点还在）也要降级提示
  const statusOnly = renderToString(
    React.createElement(components.SourcePane, {
      pdfDoc: null,
      pdfLoading: true,
      pdfError: null,
      slide: Object.assign({}, base, { anchor_status: 'unanchored' }),
      bookId: 'aaaaaaaaaaaa',
    }),
  );
  assert.ok(statusOnly.includes('本页未定位到原句'), 'anchor_status=unanchored 必须优先于残留的 source_anchor');

  // 空锚点（{}）不能静默：既不高亮也不提示是缺陷
  const emptyAnchor = renderToString(
    React.createElement(components.SourcePane, {
      pdfDoc: null,
      pdfLoading: true,
      pdfError: null,
      slide: Object.assign({}, base, { source_anchor: {} }),
      bookId: 'aaaaaaaaaaaa',
    }),
  );
  assert.ok(emptyAnchor.includes('本页未定位到原句'), 'source_anchor 没有 page 时按未锚定处理');
});

test('AC-107：过渡卡显示下一讲标题与倒计时，可跳过', () => {
  const html = renderToString(
    React.createElement(components.TransitionCard, {
      next: { n: 2, title: '第 2 讲 · 函数（中）：极限' },
      seconds: 5,
      onSkip: () => {},
    }),
  );
  assert.ok(html.includes('第 2 讲'));
  assert.ok(html.includes('第 2 讲 · 函数（中）：极限'));
  assert.ok(html.includes('5 秒后自动进入'));
  assert.ok(html.includes('立即进入'));
});

test('AC-109：系列目录列出各讲，未就绪的禁用并标状态', () => {
  const series = {
    id: 'ssssssssss',
    title: '函数',
    lectures: [
      { n: 1, status: 'ready', title: '第 1 讲 · 机器', pages: 30 },
      { n: 2, status: 'failed', title: '第 2 讲 · 极限', pages: 12 },
    ],
  };
  const html = renderToString(
    React.createElement(components.SeriesDirectory, {
      series,
      current: 1,
      progress: { heard: { 1: 12 } },
      onPick: () => {},
      onClose: () => {},
    }),
  );
  assert.ok(html.includes('系列目录'));
  assert.ok(html.includes('第 1 讲 · 机器'));
  assert.ok(html.includes('第 2 讲 · 极限'));
  assert.ok(html.includes('已听 12'));
  assert.ok(html.includes('failed'));
  assert.ok(html.includes('disabled'), '未就绪讲应禁用');
});

test('FR-18：三种版式渲染米色舞台（cover / content_text / quote）', () => {
  const cover = renderToString(
    React.createElement(components.SlideStage, {
      slide: { slide_index: 1, layout: 'cover', title: '第 2 讲 · 极限', subtitle: '函数（中）' },
    }),
  );
  assert.ok(cover.includes('blm-stage'));
  assert.ok(cover.includes('第 2 讲 · 极限'));
  assert.ok(cover.includes('函数（中）'));
  assert.ok(cover.includes('第 1 页'));

  const content = renderToString(
    React.createElement(components.SlideStage, {
      slide: { slide_index: 4, layout: 'content_text', title: '靠近某点', bullet_points: ['要点一', '要点二'], image_prompt: '机器' },
    }),
  );
  assert.ok(content.includes('要点一'));
  assert.ok(content.includes('配图位'));
  assert.ok(content.includes('点击查看提示词'));
  assert.ok(content.includes('role="button"'), '配图位应可点击');
  assert.ok(content.includes('aria-label="查看配图提示词"'));
  assert.ok(content.includes('aria-expanded="false"'));
  assert.ok(content.includes('第 4 页'));

  const quote = renderToString(
    React.createElement(components.SlideStage, {
      slide: { slide_index: 5, layout: 'quote', quote_text: '极限是靠近的艺术。', quote_source: '第 6 章' },
    }),
  );
  assert.ok(quote.includes('原文摘引'));
  assert.ok(quote.includes('极限是靠近的艺术。'));
  assert.ok(quote.includes('第 6 章'));
});

test('播放器首屏是「正在打开系列」，不抛异常', () => {
  const html = renderToString(
    React.createElement(components.Player, {
      bookId: 'aaaaaaaaaaaa',
      seriesId: 'ssssssssss',
      initialLecture: 2,
      initialSlide: 3,
      onBack: () => {},
      notify: () => {},
    }),
  );
  assert.ok(html.includes('正在打开系列'));
  assert.ok(html.includes('返回'));
});

test('FR-18：配图位点击后显示 image_prompt，可复制、可收起', () => {
  const expanded = renderToString(
    React.createElement(components.StageFigure, {
      prompt: '米色纸上画一条趋近某点的曲线',
      open: true,
      copied: false,
      onToggle: () => {},
      onCopy: () => {},
    }),
  );
  assert.ok(expanded.includes('米色纸上画一条趋近某点的曲线'));
  assert.ok(expanded.includes('复制提示词'));
  assert.ok(expanded.includes('收起'));
  assert.ok(expanded.includes('aria-expanded="true"'));

  const collapsed = renderToString(
    React.createElement(components.StageFigure, {
      prompt: '米色纸上画一条趋近某点的曲线',
      open: false,
      copied: false,
      onToggle: () => {},
      onCopy: () => {},
    }),
  );
  assert.ok(collapsed.includes('点击查看提示词'));
  assert.equal(collapsed.includes('复制提示词'), false);
  assert.ok(collapsed.includes('aria-expanded="false"'));

  const empty = renderToString(
    React.createElement(components.StageFigure, {
      prompt: '',
      open: true,
      copied: false,
      onToggle: () => {},
      onCopy: () => {},
    }),
  );
  assert.ok(empty.includes('（没有配图提示词）'));
  assert.equal(empty.includes('复制提示词'), false, '没有提示词时不渲染复制按钮');
  assert.equal(empty.includes('disabled'), false);

  const copied = renderToString(
    React.createElement(components.StageFigure, {
      prompt: '某页提示词',
      open: true,
      copied: true,
      onToggle: () => {},
      onCopy: () => {},
    }),
  );
  assert.ok(copied.includes('已复制'));
});

test('AC-117：书架「⋯」菜单点外部/按 Esc 都能关，且不吞这次点击', () => {
  const listeners = new Map();
  const doc = {
    addEventListener(type, fn, capture) {
      const key = type + ':' + String(capture);
      listeners.set(key, (listeners.get(key) || []).concat(fn));
    },
    removeEventListener(type, fn, capture) {
      const key = type + ':' + String(capture);
      listeners.set(key, (listeners.get(key) || []).filter((item) => item !== fn));
    },
  };
  const menu = { contains: (target) => target === 'menu-child' };
  const toggle = { contains: (target) => target === 'toggle' };
  const dismisses = [];
  const cleanup = helpers.bindMenuDismiss(doc, {
    menu,
    toggle,
    onDismiss: (reason) => dismisses.push(reason),
  });
  const fire = (type, event) => (listeners.get(type + ':true') || []).forEach((fn) => fn(event));

  fire('click', { target: 'menu-child' });
  fire('click', { target: 'toggle' });
  assert.deepEqual(dismisses, [], '点菜单内部/⋯ 不关');
  fire('click', { target: 'outside' });
  assert.deepEqual(dismisses, ['outside'], '点外部关闭');
  fire('keydown', { key: 'Escape' });
  assert.deepEqual(dismisses, ['outside', 'escape'], 'Esc 关闭');
  fire('keydown', { key: 'Enter' });
  assert.deepEqual(dismisses, ['outside', 'escape'], '其它键不关');

  cleanup();
  assert.equal((listeners.get('click:true') || []).length, 0);
  assert.equal((listeners.get('keydown:true') || []).length, 0);
});

test('书架卡展示系列数与「继续听」；设置入口在书架栏', () => {
  const card = renderToString(
    React.createElement(components.Card, {
      book: {
        id: 'aaaaaaaaaaaa',
        title: '函数',
        chapters: 7,
        pages: 300,
        chaptersBuilt: true,
        seriesCount: 2,
        lastSeries: { id: 'ssssssssss', title: '函数', status: 'ready' },
      },
      onOpen: () => {},
      onRename: () => {},
      onDelete: () => {},
      onContinue: () => {},
    }),
  );
  assert.ok(card.includes('2 个系列'));
  assert.ok(card.includes('继续听'));
});
