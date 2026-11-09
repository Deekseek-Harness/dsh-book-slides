/**
 * 2.0 M6：语音试听按钮状态机（FR-23 / AC-149 的 UI 限制）。
 *
 * 覆盖三个真机问题：生成中可连点、点击后无反馈、试听结束后仍显示“正在试听…”。
 * 只测纯派生函数与源码契约，不启动浏览器；真实出声与耗时观感留人工复核。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const React = require('react');
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

const { probeView } = clientModule.__helpers;

const generating = {
  phase: 'generating',
  kind: 'comfy',
  slow: true,
  where: 'ComfyUI 配音（参考：Vivian）',
  elapsedMs: 8400,
};

test('生成中：禁用 + 已等待秒数，不再出现“点了没反馈”', () => {
  const view = probeView(generating);
  assert.equal(view.disabled, true);
  assert.equal(view.busy, true);
  assert.equal(view.label, '生成中… 8s');
  assert.match(view.note, /ComfyUI 配音/);
  assert.match(view.note, /已等待 8s/);
  assert.match(view.note, /1–3 分钟/);

  const early = probeView(Object.assign({}, generating, { elapsedMs: 400 }));
  assert.equal(early.label, '生成中…');
});

test('播放中：可停止，不会重复生成', () => {
  const view = probeView({
    phase: 'playing',
    where: 'ComfyUI 配音（参考：Vivian）',
    audioMs: 6200,
    genMs: 8400,
  });
  assert.equal(view.label, '停止试听');
  assert.equal(view.disabled, false);
  assert.match(view.note, /正在播放试听/);
  assert.match(view.note, /音频 6\.2s/);
  assert.match(view.note, /生成 8\.4s/);
});

test('结束：按钮变「重听」，文案是完成态而不是进行中', () => {
  const ready = {
    phase: 'ready',
    where: 'ComfyUI 配音（参考：Vivian）',
    note: '试听完成：ComfyUI 配音（参考：Vivian） · 音频 6.2s · 生成 8.4s。点「重听」重放；换参考/音色后会自动重新生成。',
  };
  const view = probeView(ready);
  assert.equal(view.label, '重听');
  assert.equal(view.disabled, false);
  assert.ok(view.note.includes('试听完成'));
  assert.equal(/正在试听/.test(view.note), false);
  assert.equal(/…$/.test(view.note), false);
  // 保存/连接测试占用时仍禁用，但按钮文案保持终态。
  assert.equal(probeView(ready, { baseDisabled: true }).disabled, true);
});

test('自动播放被拦：给出「播放试听」与可读原因', () => {
  const view = probeView({
    phase: 'ready',
    blocked: true,
    where: '本机朗读',
    note: '试听音频已生成，但浏览器阻止了自动播放；点「播放试听」手动播放。',
  });
  assert.equal(view.label, '播放试听');
  assert.equal(view.tone, 'warn');
  assert.match(view.note, /阻止了自动播放/);
});

test('失败：按钮变「重试」并保留错误码', () => {
  const view = probeView({ phase: 'error', note: 'E_TTS_CONNECT：连不上 ComfyUI（检查地址）', tone: 'warn' });
  assert.equal(view.label, '重试');
  assert.equal(view.disabled, false);
  assert.equal(view.tone, 'warn');
  assert.match(view.note, /E_TTS_CONNECT/);
});

test('空闲：按钮是「试听」，受保存/连接测试占用影响', () => {
  const view = probeView({ phase: 'idle' });
  assert.equal(view.label, '试听');
  assert.equal(view.note, '');
  assert.equal(probeView({ phase: 'idle' }, { baseDisabled: true }).disabled, true);
});

test('源码契约：先置生成态再请求、结束有终态、缓存按签名失效', () => {
  assert.ok(source.includes('const startProbe = async'), '试听入口已改成状态机');
  assert.ok(
    source.indexOf("phase: 'generating'") < source.indexOf("await fetch(API + '/voice/probe'"),
    '先置「生成中」再发请求',
  );
  assert.ok(source.includes('audio.onended'), '音频结束要落终态');
  assert.ok(source.includes('试听完成：本机朗读'), '浏览器朗读结束要落终态');
  assert.ok(source.includes('E_TTS_PLAY'), '播放失败要有可读错误码');
  assert.ok(source.includes('probeLockRef.current = true'), '请求期间同步加锁');
  assert.ok(source.includes('probeSignature'), '缓存按配置签名失效');
  assert.equal(source.includes('previewAudioRef'), false, '旧音频引用已移除');
});
