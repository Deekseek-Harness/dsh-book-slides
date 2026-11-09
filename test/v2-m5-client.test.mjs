/**
 * 2.0 M5 客户端：练习 / 导出 / 书档 / 配图入口渲染（对应 §7.6 / §7.9 与 C8–C11 的可见入口）。
 *
 * 只做静态渲染走查 + 源码文案断言：按钮、字段、提示必须存在，保证 P1 功能不是“只有接口没有入口”。
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

function makeSeries(patch) {
  return Object.assign({
    id: 'sabcdefghij',
    book_id: 'babcdefghij',
    title: '函数',
    status: 'ready',
    stitch: 'stitched',
    voice_status: 'ready',
    total_pages: 12,
    chapters: [1, 2],
    images: { status: 'done', done: 8, total: 8 },
    lectures: [
      { n: 1, title: '第 1 讲 · 机器', status: 'ready', pages: 6, chars: 3000, voice_status: 'ready' },
      { n: 2, title: '第 2 讲 · 靠近', status: 'ready', pages: 6, chars: 3000, voice_status: 'ready' },
    ],
  }, patch || {});
}

test('AC-112：升级提示一次性显示（读 /meta.notice，sessionStorage 去重）', () => {
  assert.ok(source.includes("api('/meta')"), '面板启动时读 /meta');
  assert.ok(source.includes('blm-upgrade-notice'), '用 sessionStorage 保证只提示一次');
  assert.ok(source.includes('data.notice') || source.includes('.notice'), '提示文案取自 /meta.notice');
});

test('卡面封面用 coverUpdatedAt 换缓存（改名后上半标题即时刷新）', () => {
  const base = {
    id: 'babcdefghij',
    title: '新名',
    pages: 12,
    chapters: 3,
    chaptersBuilt: true,
    cover: true,
    coverUpdatedAt: '2026-11-09T00:00:00.000Z',
    lastOpenedAt: '2026-11-08T00:00:00.000Z',
  };
  const props = {
    onOpen: () => {},
    onRename: () => {},
    onDelete: () => {},
    onContinue: () => {},
    onExport: () => {},
  };
  const html = renderToString(React.createElement(clientModule.__components.Card, { book: base, ...props }));
  assert.ok(html.includes('v=2026-11-09T00%3A00%3A00.000Z'), '封面 URL 带上 coverUpdatedAt');
  assert.ok(!html.includes('2026-11-08T00%3A00%3A00.000Z'), '有封面版本时不再用 lastOpenedAt');

  const legacy = renderToString(
    React.createElement(clientModule.__components.Card, { book: { ...base, coverUpdatedAt: undefined }, ...props }),
  );
  assert.ok(legacy.includes('v=2026-11-08T00%3A00%3A00.000Z'), '老数据回退到 lastOpenedAt');
});

test('系列卡：练一练 / 导出 / 配图与语音四态入口', () => {
  const html = renderToString(
    React.createElement(clientModule.__components.SeriesCard, { series: makeSeries(), notify: () => {}, onReload: () => {}, onPlay: () => {} }),
  );
  for (const text of ['练一练', '导出', '重新配图', '配图 8 张', '已配音', '已衔接', '重新配音', '长按 3s']) {
    assert.ok(html.includes(text), '系列卡应包含「' + text + '」');
  }

  const partial = renderToString(
    React.createElement(clientModule.__components.SeriesCard, {
      series: makeSeries({
        voice_status: 'partial',
        voice_code: 'E_TTS_QUOTA',
        voice_error: '第 2 讲有页未配音：E_TTS_QUOTA（3/6 页未配音）',
        images: { status: 'partial', done: 5, total: 8, failed: 2 },
        lectures: [
          { n: 1, title: '第 1 讲 · 机器', status: 'ready', pages: 6, chars: 3000, voice_status: 'ready' },
          { n: 2, title: '第 2 讲 · 靠近', status: 'ready', pages: 6, chars: 3000, voice_status: 'partial', voice_error: 'E_TTS_QUOTA' },
        ],
      }),
      notify: () => {},
      onReload: () => {},
      onPlay: () => {},
    }),
  );
  for (const text of ['补配音', '补配图', 'E_TTS_QUOTA', '1 讲未完成', '部分未配']) {
    assert.ok(partial.includes(text), '部分状态卡应包含「' + text + '」');
  }

  const fresh = renderToString(
    React.createElement(clientModule.__components.SeriesCard, {
      series: makeSeries({
        voice_status: 'none',
        images: { status: 'none' },
        lectures: [
          { n: 1, title: '第 1 讲 · 机器', status: 'ready', pages: 6, chars: 3000, voice_status: 'none' },
          { n: 2, title: '第 2 讲 · 靠近', status: 'ready', pages: 6, chars: 3000, voice_status: 'none' },
        ],
      }),
      notify: () => {},
      onReload: () => {},
      onPlay: () => {},
    }),
  );
  for (const text of ['生成配音', '生成配图']) {
    assert.ok(fresh.includes(text), '未开始状态卡应包含「' + text + '」');
  }
});

test('P0：刷新后配图 state=running 时仍渲染「配图中… / 取消配图」', () => {
  const html = renderToString(
    React.createElement(clientModule.__components.SeriesCard, {
      series: makeSeries({ images: { status: 'running', done: 2, total: 8, failed: 0 } }),
      notify: () => {},
      onReload: () => {},
      onPlay: () => {},
    }),
  );
  assert.ok(html.includes('配图中…'), '系列卡应显示配图进行中');
  assert.ok(html.includes('取消配图'), '刷新后仍应提供取消配图入口');
});

test('P0：作业恢复接线（配音按 seriesId、配图状态、练习 summary.job、书档 active）', () => {
  for (const text of [
    "'/revoice/job?seriesId='",
    "'/image/status?seriesId='",
    "'/import/package/active'",
    'out.job && PRACTICE_ACTIVE.includes',
  ]) {
    assert.ok(source.includes(text), '客户端应接线「' + text + '」');
  }
});

test('练习面板：题库状态与准备/补题/开始练习（源码入口 + 加载态渲染）', () => {
  const html = renderToString(
    React.createElement(clientModule.__components.PracticePanel, { series: makeSeries(), notify: () => {}, onClose: () => {} }),
  );
  for (const text of ['练一练', '正在读题库', '关闭']) {
    assert.ok(html.includes(text), '练习面板应包含「' + text + '」');
  }
  for (const text of ['准备题库', '补题', '开始练习', '继续上次练习', '题库不足', '混合（新题 + 到期）', '只复习到期/错题', '查看讲解', '这题有问题']) {
    assert.ok(source.includes(text), '练习面板源码应包含「' + text + '」');
  }
});

test('导出对话框：范围、音频/配图/备注开关与按讲/整套出口', () => {
  const html = renderToString(
    React.createElement(clientModule.__components.ExportDialog, { series: makeSeries(), notify: () => {}, onClose: () => {} }),
  );
  for (const text of ['导出 PPT', '整套合并', '含音频', '含配图', '含备注', '关闭']) {
    assert.ok(html.includes(text), '导出对话框应包含「' + text + '」');
  }
  for (const text of ['下载 PPTX', '批量导出 ZIP（每讲一份）', '过渡页', '体积', '文件名']) {
    assert.ok(source.includes(text), '导出对话框源码应包含「' + text + '」');
  }
});

test('书档导入：冲突策略与逐本结果区', () => {
  const html = renderToString(
    React.createElement(clientModule.__components.ImportPackageDialog, {
      file: { name: 'book.zip' },
      notify: () => {},
      onClose: () => {},
      onDone: () => {},
    }),
  );
  for (const text of ['导入书档', '冲突策略', '并入（默认）', '跳过已有', '复制一本', '逐本校验']) {
    assert.ok(html.includes(text), '书档对话框应包含「' + text + '」');
  }
  for (const text of ['取消导入', '上传后逐本校验', 'policy=']) {
    assert.ok(source.includes(text), '书档源码应包含「' + text + '」');
  }
});

test('设置页：配图组（策略/地址/工作流/测试）与书档导出入口', () => {
  const html = renderToString(React.createElement(clientModule.__components.Settings, { onBack: () => {}, notify: () => {} }));
  for (const text of ['配图', '语音', '存储与回收站', '诊断', '导出全部书档']) {
    assert.ok(html.includes(text), '设置页应包含「' + text + '」');
  }
  for (const text of ['策略', '测试连接', '测试生图', '导入 API 工作流', '恢复默认', '提示词节点', '风格后缀']) {
    assert.ok(source.includes(text), '设置页源码应包含「' + text + '」');
  }
});

test('设置页：参考 voice 一次导入音频 + .txt（不再导入 JSON）', () => {
  const html = renderToString(
    React.createElement(clientModule.__components.Settings, {
      onBack: () => {},
      notify: () => {},
      initial: {
        voice: { provider: 'comfyui-tts', comfyRefVoice: 'builtin-vivian', model: 'qwen3-tts-flash', textNode: '' },
        voiceTable: {
          name: '内置',
          model: '',
          source: 'builtin',
          count: 2,
          defaultVoice: 'builtin-vivian',
          voices: [
            { id: 'builtin-vivian', name: 'Vivian', source: 'builtin', default: true, duration_ms: 21300 },
            { id: 'builtin-uncle-fu', name: 'Uncle Fu', source: 'builtin', default: false, duration_ms: 22000 },
          ],
        },
      },
    }),
  );
  for (const text of ['参考 voice 库', '导入参考 voice', '一次选两个文件']) {
    assert.ok(html.includes(text), '设置页应包含「' + text + '」');
  }
  assert.ok(html.includes('audio/*'), '文件选择应接受音频');
  assert.ok(html.includes('.txt'), '文件选择应接受 .txt');
  assert.ok(source.includes("api('/voice/refvoices/import'"), '应调用成对导入接口');
  assert.ok(!source.includes("id: 'blm-tts-table-input'"), '不应再出现 JSON 清单文件选择');
});

test('AC-154：参考时长 warning / 容忍区提示在设置页可见（不依赖连接测试）', () => {
  const initialFor = (voice) => ({
    voice: { provider: 'comfyui-tts', comfyRefVoice: voice.id, model: 'qwen3-tts-flash', textNode: '' },
    voiceTable: {
      name: '自定义参考',
      model: '',
      source: 'imported',
      count: 1,
      defaultVoice: voice.id,
      voices: [voice],
    },
  });
  const render = (voice) =>
    renderToString(
      React.createElement(clientModule.__components.Settings, {
        onBack: () => {},
        notify: () => {},
        initial: initialFor(voice),
      }),
    );

  const warn = render({
    id: 'long',
    name: 'Long',
    source: 'imported',
    default: true,
    duration_ms: 40000,
    duration_level: 'warn',
    duration_text: '参考「Long」时长 40.0s，超出推荐 5–15s（容忍区 3–30s）；可继续使用，建议截短到 5–15s 后重新导入。',
  });
  assert.match(warn, /参考「Long」/, 'warning 要点名是哪个参考');
  assert.match(warn, /超出推荐 5–15s/);
  assert.match(warn, /建议截短/, 'warning 要给处理建议');
  assert.match(warn, /blm-note warn/, '超阈值用红色 warning');

  const tip = render({ id: 'anna', name: 'Ono_anna-22s', source: 'imported', default: true, duration_ms: 22200 });
  assert.match(tip, /Ono_anna-22s/, '容忍区提示也要点名参考');
  assert.match(tip, /22\.2s/);
  assert.match(tip, /容忍区/);
  assert.match(tip, /blm-note tip/, '21–22s 用中性提示，不是红色 warning');
  assert.equal(/；可继续使用/.test(tip), false, '22.2s 不得渲染超阈值 warning');

  const { refDurationNotice } = clientModule.__helpers;
  assert.equal(refDurationNotice({ duration_ms: 10000 }), null, '5–15s 不提示');
  assert.equal(refDurationNotice({ duration_ms: 2000 }).level, 'warn');
  assert.equal(refDurationNotice({ duration_ms: 31000 }).level, 'warn');
  assert.equal(refDurationNotice({ duration_ms: 21000 }).level, 'tip');
  assert.match(refDurationNotice({ duration_ms: 22200, name: 'Ono' }).text, /参考「Ono」时长 22\.2s/);
  assert.match(refDurationNotice({ duration_ms: 50000 }).text, /建议截短/);

  assert.ok(source.includes('超出推荐 5–15s，容忍区内'), '连接成功摘要要带时长标记');
  assert.ok(source.includes('连接测试提示：'), '连接测试要展示全部 warnings，不再过滤前 2 条');
  assert.ok(source.includes('comfyRefVoice: comfyRefVoiceValue'), '连接测试按当前下拉选中项检查');
  assert.ok(source.includes('const saved = await save({ comfyRefVoice: entry.id })'), '导入后要落盘选中项');
});

test('播放器配图：image_status=ready 时渲染 img，占位时渲染提示词入口', () => {
  const ready = renderToString(
    React.createElement(clientModule.__components.SlideStage, {
      seriesId: 'sabcdefghij',
      lecture: 1,
      slide: { slide_index: 2, layout: 'content_text', title: '页面', bullet_points: ['要点'], image_prompt: '一台机器', image_status: 'ready', image_file: 'images/002.png', image_seed: 7 },
    }),
  );
  assert.ok(ready.includes('/dsh-book-slides/image?seriesId=sabcdefghij'), '有图时应从 /image 取图');
  assert.ok(ready.includes('<img'), '有图时应渲染 img');

  const placeholder = renderToString(
    React.createElement(clientModule.__components.SlideStage, {
      seriesId: 'sabcdefghij',
      lecture: 1,
      slide: { slide_index: 2, layout: 'content_text', title: '页面', bullet_points: ['要点'], image_prompt: '一台机器', image_status: 'none', image_file: null },
    }),
  );
  assert.ok(placeholder.includes('配图位'));
  assert.ok(placeholder.includes('点击查看提示词'));
});

test('AC-147：ready 页出「换一张」、failed 页出「重试配图」、占位页没有入口', () => {
  const stage = (slide) =>
    renderToString(
      React.createElement(clientModule.__components.SlideStage, {
        seriesId: 'sabcdefghij',
        lecture: 1,
        imageBusy: false,
        onRegenImage: () => {},
        slide: Object.assign(
          { slide_index: 2, layout: 'content_text', title: '页面', bullet_points: ['要点'], image_prompt: '一台机器' },
          slide,
        ),
      }),
    );
  const ready = stage({ image_status: 'ready', image_file: 'images/002.png', image_seed: 7 });
  assert.ok(ready.includes('换一张'));
  assert.ok(ready.includes('blm-stage-figure-tools'));

  const failed = stage({ image_status: 'failed', image_file: null, image_error: 'E_IMG_CONNECT' });
  assert.ok(failed.includes('重试配图'));

  const none = stage({ image_status: 'none', image_file: null });
  assert.equal(none.includes('换一张'), false);
  assert.equal(none.includes('重试配图'), false);
});

test('P1：换图进行中提供「取消换图」入口', () => {
  const base = {
    seriesId: 'sabcdefghij',
    lecture: 1,
    imageBusy: true,
    onRegenImage: () => {},
    slide: { slide_index: 2, layout: 'content_text', title: '页面', bullet_points: [], image_prompt: '一台机器', image_status: 'ready', image_file: 'images/002.png', image_seed: 7 },
  };
  const withoutCancel = renderToString(React.createElement(clientModule.__components.SlideStage, base));
  assert.ok(withoutCancel.includes('生成中…'));
  assert.equal(withoutCancel.includes('取消换图'), false);

  const withCancel = renderToString(
    React.createElement(clientModule.__components.SlideStage, Object.assign({}, base, { onCancelImage: () => {} })),
  );
  assert.ok(withCancel.includes('取消换图'));
});

test('P1：分章/讲纲/封面长请求可 abort，并显示取消入口', () => {
  for (const text of [
    "beginLong('build')",
    "beginLong('plan')",
    "beginLong('cover')",
    'signal: controller.signal',
    'isAbortError',
    '本系列配图作业进行中',
    'cancelSeriesImage',
    'onCancelImage: cancelRegenImage',
  ]) {
    assert.ok(source.includes(text), '客户端应包含长请求/取消接线「' + text + '」');
  }
});

test('P2：目录范围、书档策略与页面 view 持久化助手', () => {
  const localStore = new Map();
  const sessionStore = new Map();
  const oldLocal = globalThis.localStorage;
  const oldSession = globalThis.sessionStorage;
  globalThis.localStorage = {
    getItem: (key) => (localStore.has(key) ? localStore.get(key) : null),
    setItem: (key, value) => localStore.set(key, String(value)),
  };
  globalThis.sessionStorage = {
    getItem: (key) => (sessionStore.has(key) ? sessionStore.get(key) : null),
    setItem: (key, value) => sessionStore.set(key, String(value)),
  };
  try {
    clientModule.__helpers.savePackagePolicy('skip');
    assert.equal(clientModule.__helpers.readPackagePolicy(), 'skip');

    clientModule.__helpers.saveView({ name: 'book', bookId: 'babcdefghij' });
    assert.deepEqual(clientModule.__helpers.readSavedView(), { name: 'book', bookId: 'babcdefghij' });

    clientModule.__helpers.saveView({ name: 'player', bookId: 'babcdefghij', seriesId: 'sabcdefghij', lecture: 2, slide: 3 });
    assert.deepEqual(clientModule.__helpers.readSavedView(), {
      name: 'player',
      bookId: 'babcdefghij',
      seriesId: 'sabcdefghij',
      lecture: 2,
      slide: 3,
    });

    globalThis.sessionStorage.setItem('book-slides.view', '{bad json');
    assert.deepEqual(clientModule.__helpers.readSavedView(), { name: 'shelf' });
  } finally {
    if (oldLocal === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = oldLocal;
    if (oldSession === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = oldSession;
  }
});

test('P2：客户端读取/保存目录范围接线', () => {
  for (const text of ["api('/toc?bookId='", "api('/toc/range'", 'readSavedView', 'saveView']) {
    assert.ok(source.includes(text), '客户端应包含持久化接线「' + text + '」');
  }
});

test('AC-147：换图失败但有旧图时继续显示旧图并给「重试配图」；生成中禁用并提示', () => {
  const oldImage = renderToString(
    React.createElement(clientModule.__components.SlideStage, {
      seriesId: 'sabcdefghij',
      lecture: 1,
      imageBusy: false,
      onRegenImage: () => {},
      slide: {
        slide_index: 2,
        layout: 'content_text',
        title: '页面',
        bullet_points: ['要点'],
        image_prompt: '一台机器',
        image_status: 'failed',
        image_file: 'images/002.png',
        image_seed: 7,
        image_error: 'E_IMG_CONNECT',
      },
    }),
  );
  assert.ok(oldImage.includes('<img'), '失败但有旧图时仍要渲染旧图');
  assert.ok(oldImage.includes('重试配图'));

  const busy = renderToString(
    React.createElement(clientModule.__components.SlideStage, {
      seriesId: 'sabcdefghij',
      lecture: 1,
      imageBusy: true,
      onRegenImage: () => {},
      slide: { slide_index: 2, layout: 'content_text', title: '页面', bullet_points: [], image_prompt: '一台机器', image_status: 'ready', image_file: 'images/002.png', image_seed: 7 },
    }),
  );
  assert.ok(busy.includes('生成中…'));
  assert.ok(busy.includes('disabled'));

  const locked = renderToString(
    React.createElement(clientModule.__components.SlideStage, {
      seriesId: 'sabcdefghij',
      lecture: 1,
      imageLocked: true,
      onRegenImage: () => {},
      slide: { slide_index: 2, layout: 'content_text', title: '页面', bullet_points: [], image_prompt: '一台机器', image_status: 'ready', image_file: 'images/002.png', image_seed: 7 },
    }),
  );
  assert.ok(locked.includes('换一张'));
  assert.ok(locked.includes('disabled'), '另一页换图进行中时按钮也要禁用');
});

test('AC-142：底部缩略图按 cover/content_text/quote 渲染迷你版式', () => {
  const thumb = (slide, index, active) =>
    renderToString(
      React.createElement(clientModule.__components.SlideThumb, { slide, index, active, onClick: () => {} }),
    );
  const cover = thumb({ slide_index: 1, layout: 'cover', title: '函数', subtitle: '从机器说起', bullet_points: [] }, 0, true);
  assert.ok(cover.includes('blm-thumb-cover'));
  assert.ok(cover.includes('aria-current="page"'));
  assert.ok(cover.includes('从机器说起'));

  const body = thumb({ slide_index: 2, layout: 'content_text', title: '机器', bullet_points: ['一', '二', '三'] }, 1, false);
  assert.ok(body.includes('blm-thumb-content_text'));
  assert.ok((body.match(/blm-thumb-line/g) || []).length >= 3, '要点应渲染成缩略线条');

  const quote = thumb({ slide_index: 3, layout: 'quote', title: '引文', quote_text: '极限是靠近的艺术' }, 2, false);
  assert.ok(quote.includes('blm-thumb-quote'));
  assert.ok(quote.includes('极限是靠近的艺术'));
});

test('AC-143：无提示词不渲染复制按钮；点外部/按 Esc 关闭并拦住这次 Esc', () => {
  const empty = renderToString(
    React.createElement(clientModule.__components.StageFigure, {
      prompt: '',
      open: true,
      copied: false,
      onToggle: () => {},
      onCopy: () => {},
    }),
  );
  assert.ok(empty.includes('（没有配图提示词）'));
  assert.equal(empty.includes('复制提示词'), false);

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
  const figure = { contains: (target) => target === 'inside' };
  const calls = [];
  const cleanup = clientModule.__helpers.bindMenuDismiss(doc, {
    menu: figure,
    onDismiss: (why) => calls.push(why),
    stopEscape: true,
  });
  const clicks = listeners.get('click:true') || [];
  clicks.forEach((fn) => fn({ target: 'inside' }));
  clicks.forEach((fn) => fn({ target: 'outside' }));
  assert.deepEqual(calls, ['outside'], '点面板内不关，点面板外关闭');

  let stopped = 0;
  const keys = listeners.get('keydown:true') || [];
  keys.forEach((fn) => fn({ key: 'Escape', stopPropagation: () => { stopped += 1; }, preventDefault: () => {} }));
  assert.ok(calls.includes('escape'));
  assert.equal(stopped, 1, 'Esc 应被拦住，避免又退全屏/返回');
  cleanup();
});

test('二次确认：插件内居中弹窗（blm-modal-mask），不是浏览器原生 confirm', async () => {
  const pending = clientModule.__helpers.confirmAction('会重跑 12 页；命中缓存不产生费用。', {
    title: '重新配音',
    okText: '重新配音',
  });
  const html = renderToString(React.createElement(clientModule.__components.ConfirmHost));
  assert.ok(html.includes('blm-modal-mask'), '应复用插件遮罩（flex 居中）');
  assert.ok(html.includes('role="dialog"'));
  assert.ok(html.includes('重新配音'));
  assert.ok(html.includes('取消'));
  assert.ok(html.includes('命中缓存不产生费用'));

  assert.equal(clientModule.__helpers.cancelPendingConfirm(), true);
  assert.equal(await pending, false);
  const closed = renderToString(React.createElement(clientModule.__components.ConfirmHost));
  assert.equal(closed.includes('blm-modal-mask'), false);

  const pendingPrompt = clientModule.__helpers.promptAction('输入新的书名', '旧书名', { title: '重命名' });
  const promptHtml = renderToString(React.createElement(clientModule.__components.ConfirmHost));
  assert.ok(promptHtml.includes('blm-confirm-input'), '重命名也用同一弹窗');
  assert.ok(promptHtml.includes('旧书名'));
  assert.equal(clientModule.__helpers.cancelPendingConfirm(), true);
  assert.equal(await pendingPrompt, null);
});

test('AC-145：长按期间有进度条与剩余秒数（源码入口）', () => {
  for (const token of ['blm-hold-bar', 'blm-hold-count', 'blm-btn holdable', 'setPointerCapture', 'secondsLeft']) {
    assert.ok(source.includes(token), '长按反馈应包含「' + token + '」');
  }
});

test('客户端导出 M5 组件与上传/下载辅助', () => {
  const helpers = clientModule.__helpers;
  assert.equal(typeof helpers.downloadUrl, 'function');
  assert.equal(typeof helpers.uploadZip, 'function');
  for (const name of ['PracticePanel', 'ExportDialog', 'ImportPackageDialog']) {
    assert.equal(typeof clientModule.__components[name], 'function');
  }
});
