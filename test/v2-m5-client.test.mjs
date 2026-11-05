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

function makeSeries() {
  return {
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
      { n: 1, title: '第 1 讲 · 机器', status: 'ready', pages: 6, chars: 3000 },
      { n: 2, title: '第 2 讲 · 靠近', status: 'ready', pages: 6, chars: 3000 },
    ],
  };
}

test('系列卡：练一练 / 导出 / 补配图入口与配图徽标', () => {
  const html = renderToString(
    React.createElement(clientModule.__components.SeriesCard, { series: makeSeries(), notify: () => {}, onReload: () => {}, onPlay: () => {} }),
  );
  for (const text of ['练一练', '导出', '补配图', '配图 8 张', '已配音', '已衔接']) {
    assert.ok(html.includes(text), '系列卡应包含「' + text + '」');
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

test('客户端导出 M5 组件与上传/下载辅助', () => {
  const helpers = clientModule.__helpers;
  assert.equal(typeof helpers.downloadUrl, 'function');
  assert.equal(typeof helpers.uploadZip, 'function');
  for (const name of ['PracticePanel', 'ExportDialog', 'ImportPackageDialog']) {
    assert.equal(typeof clientModule.__components[name], 'function');
  }
});
