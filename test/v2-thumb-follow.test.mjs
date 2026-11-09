/**
 * 播放器底部逐页缩略图：当前页跟随横向滚动（体验问题修复）。
 *
 * 机检边界：
 *  - 滚动目标计算：已可见不滚、左/右越界、首尾夹紧、无横向溢出；
 *  - scrollThumbIntoView：smooth / 减少动态效果 auto、无 scrollTo 与老环境参数降级；
 *  - B 策略：播放翻页在手动滚动后的让位期内暂缓，键盘/点击显式翻页立即跟随；
 *  - 接线：缩略图容器挂 ref，播放与键盘入口统一走 index 变化后的同一个滚动函数。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const source = fs.readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
const React = require('react');

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

const helpers = clientModule.__helpers;

/** 假的横向滚动容器：left=20，宽 400，内容 1200。 */
function strip(overrides) {
  const state = Object.assign({ scrollLeft: 0, clientWidth: 400, scrollWidth: 1200, left: 20 }, overrides || {});
  const calls = [];
  const container = {
    scrollLeft: state.scrollLeft,
    clientWidth: state.clientWidth,
    scrollWidth: state.scrollWidth,
    getBoundingClientRect: () => ({ left: state.left, right: state.left + state.clientWidth }),
    scrollTo(options) {
      calls.push(options);
    },
  };
  return { container, calls };
}

function thumbAt(left, width = 108) {
  return { getBoundingClientRect: () => ({ left, right: left + width }) };
}

test('滚动目标：当前页完整可见不滚，左右越界按最小位移滚，首尾夹紧', () => {
  // 容器可视区 [20, 420]；缩略图 [30, 138] 完整可见
  assert.equal(helpers.thumbScrollLeft(0, 400, 1200, 10, 118), null);
  // 右侧越界 8px
  assert.equal(helpers.thumbScrollLeft(0, 400, 1200, 300, 408), 8);
  // 左侧越界 30px（已滚到 100）
  assert.equal(helpers.thumbScrollLeft(100, 400, 1200, -30, 78), 70);
  // 滚到尾部时夹紧在最大滚动量 800
  assert.equal(helpers.thumbScrollLeft(790, 400, 1200, 300, 420), 800);
  assert.equal(helpers.thumbScrollLeft(790, 400, 1200, 300, 408), 798);
  // 没有横向溢出 / 宽度未知
  assert.equal(helpers.thumbScrollLeft(0, 400, 400, 10, 118), null);
  assert.equal(helpers.thumbScrollLeft(0, 0, 1200, 10, 118), null);
});

test('scrollThumbIntoView：越界时用 scrollTo(smooth) 滚到刚好可见', () => {
  const { container, calls } = strip();
  assert.equal(helpers.scrollThumbIntoView(container, thumbAt(440)), true);
  assert.deepEqual(calls, [{ left: 128, behavior: 'smooth' }]);

  // 已完整可见：不产生额外滚动
  assert.equal(helpers.scrollThumbIntoView(container, thumbAt(40)), false);
  assert.equal(calls.length, 1);

  // 左侧越界：从当前 100 回滚到 80
  const left = strip({ scrollLeft: 100 });
  assert.equal(helpers.scrollThumbIntoView(left.container, thumbAt(0)), true);
  assert.deepEqual(left.calls, [{ left: 80, behavior: 'smooth' }]);

  // 尾部夹紧
  const tail = strip({ scrollLeft: 790 });
  assert.equal(helpers.scrollThumbIntoView(tail.container, thumbAt(440)), true);
  assert.deepEqual(tail.calls, [{ left: 800, behavior: 'smooth' }]);
});

test('scrollThumbIntoView：减少动态效果用 auto；无 scrollTo / 老环境参数降级', () => {
  const original = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  try {
    const reduced = strip();
    assert.equal(helpers.scrollThumbIntoView(reduced.container, thumbAt(440)), true);
    assert.deepEqual(reduced.calls, [{ left: 128, behavior: 'auto' }]);
  } finally {
    if (original === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = original;
  }

  // 不支持 scrollTo：直接写 scrollLeft
  const plain = {
    scrollLeft: 0,
    clientWidth: 400,
    scrollWidth: 1200,
    getBoundingClientRect: () => ({ left: 20, right: 420 }),
  };
  assert.equal(helpers.scrollThumbIntoView(plain, thumbAt(440)), true);
  assert.equal(plain.scrollLeft, 128);

  // 老嵌入环境不接受 behavior 参数：退回不带 behavior 的调用
  const calls = [];
  const oldBrowser = {
    scrollLeft: 0,
    clientWidth: 400,
    scrollWidth: 1200,
    getBoundingClientRect: () => ({ left: 20, right: 420 }),
    scrollTo(options) {
      if (options && options.behavior) throw new Error('unknown option');
      calls.push(options);
    },
  };
  assert.equal(helpers.scrollThumbIntoView(oldBrowser, thumbAt(440)), true);
  assert.deepEqual(calls, [{ left: 128 }]);

  assert.equal(helpers.scrollThumbIntoView(null, thumbAt(0)), false);
  assert.equal(helpers.scrollThumbIntoView({}, null), false);
});

test('B 策略：只有播放翻页在让位期内暂缓，键盘/点击与让位结束立即滚动', () => {
  const now = 1_000_000;
  assert.equal(helpers.thumbScrollDeferMs('playback', now + 5000, now), 5000);
  assert.equal(helpers.thumbScrollDeferMs('playback', now + 1, now), 1);
  assert.equal(helpers.thumbScrollDeferMs('playback', now, now), 0);
  assert.equal(helpers.thumbScrollDeferMs('playback', now - 1, now), 0);
  assert.equal(helpers.thumbScrollDeferMs('user', now + 5000, now), 0);
  assert.equal(helpers.thumbScrollDeferMs(undefined, now + 5000, now), 0);
});

test('接线：.blm-thumbs 挂 ref，播放/键盘入口统一到 index 变化', () => {
  assert.match(
    source,
    /className: 'blm-thumbs', role: 'tablist', 'aria-label': '逐页缩略图', ref: thumbsRef/,
    '缩略图容器应挂 ref 供滚动定位',
  );
  assert.match(source, /const THUMB_SCROLL_YIELD_MS = 5000;/, '让位期应为 5 秒');

  const advance = source.slice(
    source.indexOf('const advance = useCallback'),
    source.indexOf('}, [finishLecture]);'),
  );
  assert.match(advance, /indexSourceRef\.current = 'playback'/, '播放自动翻页应标记为 playback');

  const userTags = source.match(/indexSourceRef\.current = 'user';/g) || [];
  assert.ok(userTags.length >= 3, 'goTo/nextPage/prevPage 三个显式入口都应标记为 user');
  const yieldClears = source.match(/thumbYieldRef\.current = 0;/g) || [];
  assert.ok(yieldClears.length >= 4, '三个显式入口与跟随 effect 都应结束让位期');

  const follow = source.slice(
    source.indexOf('预览窗格跟随当前页'),
    source.indexOf('/* 手动横向滚动预览窗格后让位'),
  );
  assert.match(follow, /container\.children\[index\]/, '应取当前页对应的缩略图元素');
  assert.match(follow, /scrollThumbIntoView\(container, thumb/, '应统一调用滚动函数');
  assert.match(follow, /thumbScrollDeferMs\(source/, '应根据翻页来源决定是否让位');
  assert.match(follow, /\[index, slides\.length\]/, 'index 变化是统一触发点');

  const manual = source.slice(
    source.indexOf('手动横向滚动预览窗格后让位'),
    source.indexOf('}, [slides.length]);', source.indexOf('手动横向滚动预览窗格后让位')),
  );
  assert.match(manual, /addEventListener\('wheel'/, '横向滚轮应进入让位期');
  assert.match(manual, /addEventListener\('touchstart'/, '触摸滑动应进入让位期');
  assert.match(manual, /addEventListener\('pointerdown'/, '拖动滚动条应进入让位期');
  assert.ok(!manual.includes("addEventListener('scroll'"), '不能监听 scroll，否则程序滚动会把自己锁住');
  assert.match(source, /new ResizeObserver\(keepVisible\)/, '窗口/侧栏改变宽度后应校正当前页可见性');
});
