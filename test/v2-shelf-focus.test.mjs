/**
 * AC-158：重复导入同一份 PDF 时留在书架，定位到已存在的书卡（滚动 + 聚焦 + 高亮）。
 *
 * 机检边界：导入响应归类、书卡高亮标记、定位 helper 的滚动/聚焦与降级；
 * 真机上的滚动观感与 3 秒后高亮收起属人工边界（见 SRS FR-21.2 / AC-158）。
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

function baseBook(patch) {
  return Object.assign(
    {
      id: 'babcdefghij',
      title: '函数',
      pages: 12,
      chapters: 3,
      chaptersBuilt: true,
      cover: false,
      lastOpenedAt: '2026-11-09T00:00:00.000Z',
    },
    patch || {},
  );
}

function cardProps() {
  return {
    onOpen: () => {},
    onRename: () => {},
    onDelete: () => {},
    onContinue: () => {},
    onExport: () => {},
  };
}

test('AC-158：导入响应归类保留重复书的 bookId/title', () => {
  assert.deepEqual(helpers.importOutcome({ ok: true, bookId: 'b1', book: { title: '新书' } }), {
    kind: 'created',
    bookId: 'b1',
    title: '新书',
  });
  assert.deepEqual(
    helpers.importOutcome({ ok: false, code: 'E_DUP_BOOK', bookId: 'babcdefghij', title: '函数' }),
    { kind: 'duplicate', bookId: 'babcdefghij', title: '函数' },
  );
  assert.deepEqual(helpers.importOutcome({ ok: false, code: 'E_DUP_BOOK' }), {
    kind: 'duplicate',
    bookId: '',
    title: '',
  });
  assert.deepEqual(helpers.importOutcome({ ok: false, error: 'E_PDF_CORRUPT' }), {
    kind: 'failed',
    message: 'E_PDF_CORRUPT',
  });
  assert.deepEqual(helpers.importOutcome(null), { kind: 'failed', message: '导入失败' });
});

test('AC-158：重复导入分支留在书架并触发书卡定位（不跳详情页）', () => {
  const start = source.indexOf('const result = importOutcome(out);');
  assert.ok(start >= 0, 'importFile 应使用 importOutcome 归类');
  const branch = source.slice(start, source.indexOf('} catch (err)', start));
  const duplicateAt = branch.indexOf("result.kind === 'duplicate'");
  assert.ok(duplicateAt >= 0, '应有 duplicate 分支');
  const duplicateBlock = branch.slice(duplicateAt, branch.indexOf('} else {', duplicateAt));
  assert.match(duplicateBlock, /setFocusBook\(\{ id: result\.bookId, nonce: Date\.now\(\) \}\)/);
  assert.ok(!duplicateBlock.includes("name: 'book'"), '重复导入不应跳转到详情页');
  assert.match(duplicateBlock, /prev\.name === 'shelf' \? prev : \{ name: 'shelf' \}/, '非书架上下文应回到书架');
  assert.ok(source.includes("ref: shelfRef"), '书架容器应挂 ref 供定位');
  assert.ok(source.includes('highlight: !!(focusBook && focusBook.id === book.id)'), '目标书卡应拿到高亮标记');
});

test('AC-158：书卡带稳定定位属性与键盘入口，高亮时加 blm-card-hit', () => {
  const highlighted = renderToString(
    React.createElement(components.Card, { book: baseBook(), highlight: true, ...cardProps() }),
  );
  assert.match(highlighted, /class="blm-card blm-card-hit"/);
  assert.match(highlighted, /data-book-id="babcdefghij"/);
  assert.match(highlighted, /tabindex="0"/);
  assert.match(highlighted, /role="button"/);
  assert.match(highlighted, /aria-label="函数"/);

  const plain = renderToString(
    React.createElement(components.Card, { book: baseBook(), highlight: false, ...cardProps() }),
  );
  assert.match(plain, /class="blm-card"/);
  assert.ok(!plain.includes('blm-card-hit'));
});

test('AC-158：focusBookCard 居中滚动并聚焦目标卡', () => {
  const calls = [];
  const node = {
    scrollIntoView(options) {
      calls.push(['scroll', options]);
    },
    focus(options) {
      calls.push(['focus', options]);
    },
  };
  let selector = '';
  const root = {
    querySelector(value) {
      selector = value;
      return node;
    },
  };

  assert.equal(helpers.focusBookCard(root, 'babcdefghij'), true);
  assert.equal(selector, '[data-book-id="babcdefghij"]');
  assert.deepEqual(calls[0], ['scroll', { block: 'center', behavior: 'smooth' }]);
  assert.deepEqual(calls[1], ['focus', { preventScroll: true }]);

  // 不支持 smooth / focus 参数的老嵌入环境退回普通调用
  const fallback = [];
  const oldBrowser = {
    scrollIntoView(options) {
      if (options && options.behavior) throw new Error('unknown option');
      fallback.push(['scroll', options]);
    },
    focus(options) {
      if (options) throw new Error('unknown option');
      fallback.push(['focus']);
    },
  };
  assert.equal(helpers.focusBookCard({ querySelector: () => oldBrowser }, 'babcdefghij'), true);
  assert.deepEqual(fallback, [
    ['scroll', { block: 'center' }],
    ['focus'],
  ]);
});

test('AC-158：prefers-reduced-motion 时改为即时滚动', () => {
  const calls = [];
  const node = {
    scrollIntoView(options) {
      calls.push(options);
    },
    focus() {},
  };
  const original = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  try {
    assert.equal(helpers.focusBookCard({ querySelector: () => node }, 'babcdefghij'), true);
  } finally {
    if (original === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = original;
  }
  assert.deepEqual(calls[0], { block: 'center', behavior: 'auto' });
});

test('AC-158：找不到卡/非法 ID/空容器时安全放弃', () => {
  let queried = false;
  const root = {
    querySelector() {
      queried = true;
      return null;
    },
  };
  assert.equal(helpers.focusBookCard(root, 'babcdefghij'), false);
  assert.equal(queried, true);

  queried = false;
  assert.equal(helpers.focusBookCard(root, 'b" onmouseover'), false);
  assert.equal(queried, false, '非法 ID 不应拼进选择器');

  assert.equal(helpers.focusBookCard(null, 'babcdefghij'), false);
  assert.equal(helpers.focusBookCard({}, 'babcdefghij'), false);
  assert.equal(helpers.focusBookCard(root, ''), false);
});
