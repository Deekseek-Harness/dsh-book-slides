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
