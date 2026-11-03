import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { baselineOf, compareTruth, findPair, readManifest, renderBaseline, renderSummary, tocEntriesFromText } from '../check.js';
import { checkExitCode, parseCheckArgs } from './check-cli.mjs';

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

test('真值清单：读 books.json；没有清单返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-manifest-'));
  try {
    assert.equal(readManifest(dir), null);
    assert.equal(readManifest(''), null);
    fs.writeFileSync(
      path.join(dir, 'books.json'),
      JSON.stringify({
        books: [
          {
            pdf: 'a.pdf',
            bookmark: '【书签】a.txt',
            modes: ['mech'],
            expect: { mech: { truth: 1, parsed: 1, matched: 1, serious: 0, warn: 0 } },
          },
        ],
        ignored: [{ pdf: 'b.pdf', reason: '扫描件' }],
      }),
    );
    const manifest = readManifest(dir);
    assert.equal(manifest.books.length, 1);
    assert.deepEqual(manifest.books[0].modes, ['mech']);
    assert.equal(manifest.ignored[0].pdf, 'b.pdf');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('配对：真值目录优先，其次数据目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-pair-root-'));
  const truth = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-pair-truth-'));
  try {
    fs.writeFileSync(path.join(truth, '【书签】a.txt'), 'truth');
    fs.writeFileSync(path.join(root, '【书签】a.txt'), 'root');
    assert.equal(findPair([truth, root], 'a.pdf', '【书签】', '.txt'), path.join(truth, '【书签】a.txt'));
    fs.rmSync(path.join(truth, '【书签】a.txt'));
    assert.equal(findPair([truth, root], 'a.pdf', '【书签】', '.txt'), path.join(root, '【书签】a.txt'));
    assert.equal(findPair([truth, root], 'missing.pdf', '【书签】', '.txt'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(truth, { recursive: true, force: true });
  }
});

test('基线对照：数字变差算回归，跳过不参与，没登记也算失败', () => {
  const manifest = {
    books: [{ pdf: 'a.pdf', expect: { toc: { truth: 2, parsed: 2, matched: 2, serious: 0, warn: 0 } } }],
  };
  const good = { label: 'A', pdf: 'a.pdf', mode: 'toc', truthCount: 2, parsedCount: 2, ok: { core: 2, other: 0 }, serious: [], warn: [] };
  assert.deepEqual(baselineOf(good), { truth: 2, parsed: 2, matched: 2, serious: 0, warn: 0 });

  const skipped = { label: 'B', pdf: 'b.pdf', mode: 'toc', skipped: '本地没有这本 PDF' };
  const pass = renderBaseline([good, skipped], manifest);
  assert.equal(pass.summary.passed, 1);
  assert.equal(pass.summary.failed, 0);

  const worse = Object.assign({}, good, { ok: { core: 1, other: 0 }, serious: [{ kind: '核心遗漏' }] });
  const fail = renderBaseline([worse], manifest);
  assert.equal(fail.summary.failed, 1);
  assert.match(fail.lines.join('\n'), /回归/);

  const unknown = Object.assign({}, good, { pdf: 'c.pdf' });
  assert.equal(renderBaseline([unknown], manifest).summary.failed, 1);
});

test('命令行参数与退出码', () => {
  const args = parseCheckArgs(['D:\\books', '--truth', 'test/truth', '--baseline']);
  assert.equal(args.dir, 'D:\\books');
  assert.equal(args.truthDir, 'test/truth');
  assert.equal(args.baseline, true);
  assert.equal(parseCheckArgs(['--truth=x']).truthDir, 'x');
  assert.equal(checkExitCode({ summary: { serious: 2 } }, false), 1);
  assert.equal(checkExitCode({ summary: { serious: 2 } }, true), 0);
  assert.equal(checkExitCode({ summary: { serious: 2, baseline: { failed: 1 } } }, true), 1);
});
