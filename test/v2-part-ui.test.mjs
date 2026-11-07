/**
 * 2.0 Part UI：AC-92 预防式禁选、AC-129 默认只读、AC-93 编辑与旧快照徽标。
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

function chapter(n, patch) {
  return Object.assign({ n, title: '第 ' + n + ' 章', from: n, to: n, chars: 12000, front: false }, patch || {});
}

test('AC-129：默认态下已有 Part 的章只读且选中，普通章可勾选', () => {
  const owner = { id: 'p1', title: '函数' };
  const owned = helpers.chapterSelectionState({ n: 1, owner, selected: [], busy: false });
  assert.equal(owned.checked, true);
  assert.equal(owned.disabled, true);
  assert.match(owned.title, /属于《函数》/);
  assert.match(owned.title, /改归属请用「编辑」/);

  const free = helpers.chapterSelectionState({ n: 2, owner: null, selected: [], busy: false });
  assert.equal(free.checked, false);
  assert.equal(free.disabled, false);
  assert.equal(free.title, '选择这一章');

  const picked = helpers.chapterSelectionState({ n: 2, owner: null, selected: [2], busy: false });
  assert.equal(picked.checked, true);

  const front = helpers.chapterSelectionState({ n: 0, front: true, owner: null, selected: [], busy: false });
  assert.equal(front.disabled, true);
  assert.match(front.title, /前文/);
});

test('AC-92：UI 不提供重选已属 Part 章的路径，冲突只由 API 兜底', () => {
  const owner = { id: 'p1', title: '函数' };
  const owned = helpers.chapterSelectionState({ n: 1, owner, selected: [1], busy: false });
  assert.equal(owned.checked, true);
  assert.equal(owned.disabled, true);

  assert.equal(source.includes('重组选择'), false);
  assert.equal(source.includes('并入已有 Part'), false);
  assert.ok(source.includes('请先在该 Part 的「编辑」中移出冲突章'));
});

test('AC-93：系列快照版本只在本系列落后于当前 Part 时显示', () => {
  assert.equal(helpers.seriesSnapshotVersion({ part_version: 1 }, { version: 2 }), 1);
  assert.equal(helpers.seriesSnapshotVersion({ part_version: 2 }, { version: 2 }), 0);
  assert.equal(helpers.seriesSnapshotVersion({ part_version: 1 }, null), 0);
  assert.equal(helpers.seriesSnapshotVersion({}, { version: 2 }), 1);
});

test('AC-93：系列卡显示「基于旧快照（v1）」', () => {
  const html = renderToString(
    React.createElement(clientModule.__components.SeriesCard, {
      series: {
        id: 'sabcdefghij',
        title: '函数',
        status: 'ready',
        stitch: 'stitched',
        voice_status: 'ready',
        part_version: 1,
        total_pages: 12,
        images: { status: 'done', done: 8, total: 8 },
        lectures: [{ n: 1, title: '第 1 讲', status: 'ready', pages: 6, chars: 3000, voice_status: 'ready' }],
      },
      part: { id: 'pabcdefghij', title: '函数', version: 2 },
      notify: () => {},
      onReload: () => {},
      onPlay: () => {},
    }),
  );
  assert.ok(html.includes('基于旧快照（v1）'));
  assert.ok(html.includes('blm-badge warn'));
});

test('AC-93：Part 编辑弹窗可改名、移出、加入，并提示版本与快照', () => {
  const partOf = new Map([
    [1, { id: 'p1', title: '函数' }],
    [2, { id: 'p1', title: '函数' }],
    [4, { id: 'p2', title: '极限' }],
  ]);
  const html = renderToString(
    React.createElement(clientModule.__components.PartEditDialog, {
      draft: { partId: 'p1', title: '函数（改）', original: [1, 2], add: [3], remove: [2], error: '' },
      chapters: [chapter(1), chapter(2), chapter(3), chapter(4)],
      partOf,
      busy: false,
      error: '',
      onTitle: () => {},
      onToggle: () => {},
      onSave: () => {},
      onClose: () => {},
    }),
  );
  for (const text of ['编辑 Part', '保存修改', '将移出', '将加入', '属于《极限》', 'part_version', '基于旧快照']) {
    assert.ok(html.includes(text), 'Part 编辑弹窗应包含「' + text + '」');
  }
});

test('Detail 源码包含组头编辑、系列数与旧快照入口', () => {
  for (const text of ['编辑 Part', '个系列', '基于旧快照', '确认此部分']) {
    assert.ok(source.includes(text), 'client.js 应包含「' + text + '」');
  }
});
