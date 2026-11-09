/**
 * AC-128：1.x 功能保留基线（SRS §2.5 / §2.6）的登记检查。
 *
 * SRS 要求“按子能力逐项走查，0 未登记缺失”。本文件把“登记完整性”做成机检：
 *  - §2.5 的 P-0 ~ P-14 全在，优先级是 P0/P1，且每行至少指向一个 AC；
 *  - §2.6 的每一行都有 2.0 落点与处置（直接保留 / 适配保留 / 明确替代）；
 *  - §2.5 引用的 AC 在 SRS 中都有定义；
 *  - AC-92 ~ AC-158 在 SRS 中都有定义；
 *  - 发布门点名的子能力（逐页缩略图、配图提示词面板、单页换一张、四态按钮、
 *    失败可见、连接/试听测试、参考 voice 库、x_vector_only 校验）都在表内列名。
 *
 * 这是“登记”证据；行为证据由各 AC 的测试与真机/真书抽检承担，见
 * doc/2.0-实现进度.md 的发布门记录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRS = fs.readFileSync(path.join(REPO, 'doc/requirements/规范需求2.0.md'), 'utf8');

function between(start, end) {
  const from = SRS.indexOf(start);
  assert.ok(from >= 0, '找不到章节：' + start);
  const to = SRS.indexOf(end, from + start.length);
  assert.ok(to > from, '找不到章节边界：' + end);
  return SRS.slice(from, to);
}

function tableRows(markdown) {
  const rows = [];
  for (const line of markdown.split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('|')) continue;
    const cells = text.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
    if (!cells.length) continue;
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue; // 分隔行
    if (cells[0] === '#' || cells[0] === '1.x 依据') continue; // 表头
    rows.push(cells);
  }
  return rows;
}

const parity = between('### 2.5 功能对等（Parity）', '### 2.6 1.x 能力保留总表');
const baseline = between('### 2.6 1.x 能力保留总表', '**判定规则**');
const definedAcs = new Set([...SRS.matchAll(/\*\*AC-(\d+)/g)].map((match) => match[1]));

test('AC-128：§2.5 的 P-0 ~ P-14 全部登记', () => {
  const rows = tableRows(parity).filter((cells) => /^P-\d+$/.test(cells[0]));
  assert.equal(rows.length, 15);
  assert.deepEqual(rows.map((cells) => cells[0]), Array.from({ length: 15 }, (_, i) => 'P-' + i));
});

test('AC-128：§2.5 每行都有优先级、2.0 落点与至少一个 AC', () => {
  for (const cells of tableRows(parity).filter((row) => /^P-\d+$/.test(row[0]))) {
    assert.equal(cells.length, 6, cells[0] + ' 列数不是 6');
    const id = cells[0];
    assert.ok(cells[1], id + ' 缺能力名');
    assert.match(cells[4], /^P[01]$/, id + ' 缺 P0/P1 优先级');
    assert.match(cells[2], /FR-|附录|—/, id + ' 缺 1.x 依据');
    assert.match(cells[3], /FR-|§/, id + ' 缺 2.0 落点');
    assert.match(cells[5], /AC-\d+/, id + ' 缺 AC 验收');
  }
});

test('AC-128：§2.6 每项都有 2.0 落点与处置，且没有“不保留”漏写替代', () => {
  const rows = tableRows(baseline);
  assert.ok(rows.length >= 16, '§2.6 行数 ' + rows.length + '，疑似表被截断');
  for (const cells of rows) {
    assert.equal(cells.length, 4, cells[0] + ' 列数不是 4');
    const [basis, capability, landing, disposition] = cells;
    assert.ok(basis, '缺 1.x 依据');
    assert.ok(capability, basis + ' 缺能力名');
    assert.ok(landing, basis + ' 缺 2.0 落点');
    assert.match(disposition, /^(直接保留|适配保留|明确替代)/, basis + ' 的处置不是三种之一：' + disposition);
    assert.match(landing, /FR-|不保留/, basis + ' 的 2.0 落点缺 FR 条款');
  }
});

test('AC-128：§2.5 引用的 AC 都在 SRS 中有定义', () => {
  const referenced = new Set([...parity.matchAll(/AC-(\d+)/g)].map((match) => match[1]));
  for (const id of referenced) {
    assert.ok(definedAcs.has(id), 'AC-' + id + ' 被 §2.5 引用但 SRS 中没有定义');
  }
});

test('AC-128：AC-92 ~ AC-158 在 SRS 中全部有定义', () => {
  assert.deepEqual([...definedAcs].map(Number).sort((a, b) => a - b),
    Array.from({ length: 158 - 92 + 1 }, (_, i) => 92 + i));
});

test('AC-128：发布门点名的子能力在基线表/对等表中列名', () => {
  const required = [
    '逐页缩略图',
    '配图提示词面板',
    '单页「换一张」',
    '四态',
    '失败可见',
    '连接测试',
    '试听测试',
    '参考 voice 库',
    'x_vector_only',
  ];
  for (const phrase of required) {
    assert.ok(SRS.includes(phrase), '基线表缺少子能力：' + phrase);
  }
});
