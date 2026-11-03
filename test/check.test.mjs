import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { compareTruth, renderSummary, tocEntriesFromText } from '../check.js';

test('分类报告：偏移与核心遗漏算严重，缺前言算警告，跳过单独通知', () => {
  const truth = [
    { key: 'no:1', title: '第1章 甲', page: 10, core: true },
    { key: 'no:2', title: '第2章 乙', page: 40, core: true },
    { key: 'no:3', title: '第3章 丙', page: 80, core: true },
    { key: 'head:前言', title: '前言', page: 3, core: false },
  ];
  const chapters = [
    { n: 0, title: '前文', front: true },
    { n: 1, title: '第1章 甲', from: 10 }, // 对
    { n: 2, title: '第2章 乙', from: 38 }, // 偏 2 页
    // 第3章 没切出来
  ];
  const compared = compareTruth(truth, chapters);
  assert.equal(compared.ok.core, 1);
  assert.equal(compared.serious.length, 2);
  assert.deepEqual(compared.serious.map((s) => s.kind).sort(), ['偏移', '核心遗漏'].sort());
  assert.equal(compared.warn.length, 1);
  assert.equal(compared.warn[0].kind, '非核心遗漏');

  const skipped = { label: '某书', skipped: '目录页没有页码', pages: 0, ms: 0 };
  const okBook = Object.assign({ label: '好书' }, compared);
  const out = renderSummary('章节切分', [okBook, skipped]);
  const text = out.lines.join('\n');
  assert.match(text, /严重 · 偏移：1 处/);
  assert.match(text, /严重 · 核心遗漏：1 处/);
  assert.match(text, /警告 · 非核心遗漏：1 处/);
  assert.match(text, /通知 · 跳过：1 处/);
  assert.equal(out.summary.serious, 2);
  assert.equal(out.summary.notices, 1);
});

test('测试用目录解析：一行两栏也能各取各的页码', () => {
  const text = ['L1: 简 目', 'L2: 第1章 电影的世 3 第2章 确立主题 17', 'L3: 第3章 戏剧化 28'].join('\n');
  const entries = tocEntriesFromText(text);
  assert.deepEqual(
    entries.map((e) => [e.title.replace(/\s+/g, ''), e.printed]),
    [
      ['第1章电影的世', 3],
      ['第2章确立主题', 17],
      ['第3章戏剧化', 28],
    ],
  );
});

test('runBookCheck：没有 PDF 的目录给出明确错误', async () => {
  const { runBookCheck } = await import('../check.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-check-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    await assert.rejects(() => runBookCheck(dir, { mode: 'toc' }), /没有 PDF/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
