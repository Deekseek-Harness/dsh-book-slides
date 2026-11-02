/**
 * 目录驱动切章的离线测试（附录 F）。
 *
 * 不调模型：模型那一步的产物（entries）在这里直接手写，专测「校准」和「落盘」这半段。
 * 真实模型调用在 server 层联调，这里保证的是：只要目录读对了，边界一定算得对。
 *
 *   node test/toc.test.mjs
 *   真书验证：设置 BOOK_SLIDES_BOOK_DIR 指向某本书的目录（含 pages.json）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  TOC_MAX_ENTRIES,
  buildTocMessages,
  calibrate,
  chaptersFromToc,
  parseTocReply,
  printedPageOf,
  suggestTocRange,
  validateEntries,
  verifyChapters,
} from '../tocparse.js';

/* ----------------------------- 合成数据 ----------------------------- */

/** 造一本 12 页的小书：页眉「<印刷页> 某某书」是偶数页，「某某书 <印刷页>」是奇数页。 */
function makeBook() {
  const titles = { 2: '第一章 起点', 5: '第二章 转折', 9: '第三章 收尾' };
  const pages = [];
  for (let physical = 1; physical <= 12; physical += 1) {
    const printed = physical + 100; // 印刷页码从 101 起，偏移固定为 -100
    // 页眉永远在第一行：奇数页「书名 页码」，偶数页「页码 书名」
    const lines = [physical % 2 === 1 ? '某某书 ' + printed : printed + ' 某某书'];
    if (titles[physical]) lines.push(titles[physical]);
    for (let i = 0; i < 6; i += 1) lines.push('正文正文正文正文正文正文正文正文正文正文正文正文。');
    pages.push({ page: physical, text: lines.join('\n') });
  }
  return pages;
}

const ENTRIES = [
  { title: '第一章 起点', printed: 102, level: 'chapter', fixedChar: false },
  { title: '第二章 转折', printed: 105, level: 'chapter', fixedChar: false },
  { title: '第三章 收尾', printed: 109, level: 'chapter', fixedChar: false },
];

/* ------------------------------ 页码范围建议 ------------------------------ */

test('suggestTocRange：认出条目式目录页', () => {
  const pages = [
    { page: 1, text: '版权页，只有几行字。' },
    {
      page: 2,
      text: [
        '目 录',
        '第一章 起点 1',
        '第二章 转折 4',
        '第三章 收尾 8',
        '第四章 归途 12',
        '第五章 尾声 16',
        '第六章 附录 20',
        '第七章 索引 24',
        '第八章 致谢 28',
      ].join('\n'),
    },
    { page: 3, text: '正文'.repeat(200) },
  ];
  assert.deepEqual(suggestTocRange(pages), { from: 2, to: 2 });
});

test('suggestTocRange：没有目录页时返回 null', () => {
  const pages = [{ page: 1, text: '正文'.repeat(300) }];
  assert.equal(suggestTocRange(pages), null);
});

/* ------------------------------ 模型回复解析 ------------------------------ */

test('parseTocReply：能剥掉代码围栏，并纠正字段', () => {
  const reply = '```json\n{"entries":[{"title":" 第一章 起点 ","printed_page":"102","level":"CHAPTER","fixed_char":1}]}\n```';
  const entries = parseTocReply(reply);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, '第一章 起点');
  assert.equal(entries[0].printed, 102);
  assert.equal(entries[0].level, 'chapter');
  assert.equal(entries[0].fixedChar, true);
});

test('parseTocReply：没有 JSON 时抛错，错误里带原文片段', () => {
  assert.throws(() => parseTocReply('抱歉，我无法完成。'), /没有 JSON/);
});

test('validateEntries：页码倒退、条目过多都要报错', () => {
  assert.deepEqual(validateEntries(ENTRIES), []);
  const backwards = [ENTRIES[0], { title: '第二章', printed: 50, level: 'chapter' }, ENTRIES[2]];
  assert.match(validateEntries(backwards).join('；'), /页码比上一条小/);
  const many = Array.from({ length: TOC_MAX_ENTRIES + 1 }, (_, i) => ({ title: '第' + (i + 1) + '章 标题', printed: i + 1, level: 'chapter' }));
  assert.match(validateEntries(many).join('；'), /条目太多/);
});

/* -------------------------------- 校准 -------------------------------- */

test('printedPageOf：三种页眉都能读出印刷页码', () => {
  assert.equal(printedPageOf('220 第5章\n正文'), 220);
  assert.equal(printedPageOf('处 理 器 219\n正文'), 219);
  assert.equal(printedPageOf('正文正文\n' + '结尾 88'), 0, '末行不算，只看首行');
  assert.equal(printedPageOf(''), 0);
});

test('校准：页码差恒定，直接加成物理页', () => {
  const pages = makeBook();
  const result = calibrate(pages, ENTRIES);
  assert.equal(result.offset, -100, '页眉投票应该得出 物理页 - 印刷页 = -100');
});

test('校准：印刷页整体偏移时，靠标题锚定纠正', () => {
  const pages = makeBook();
  // 假装这本书的印刷页码从 151 起（差 50），但顺序与真实一致
  const shifted = ENTRIES.map((entry) => ({ ...entry, printed: entry.printed + 50 }));
  const result = calibrate(pages, shifted);
  assert.ok(result.entries.every((entry) => entry.physical > 0), '每章都应该被定位');
  assert.deepEqual(
    result.entries.map((entry) => entry.physical),
    [2, 5, 9],
    '标题锚定应该把偏移纠正回来',
  );
  assert.ok(result.entries.every((entry) => entry.anchor === 'title'));
});

test('落盘：目录结果变成章节，页区间首尾相接', () => {
  const pages = makeBook();
  const chapters = chaptersFromToc(pages, calibrate(pages, ENTRIES));
  assert.ok(chapters);
  const list = chapters.filter((chapter) => !chapter.front);
  assert.equal(list.length, 3);
  assert.deepEqual(
    list.map((chapter) => [chapter.from, chapter.to]),
    [
      [2, 4],
      [5, 8],
      [9, 12],
    ],
  );
  assert.equal(list[0].title, '第一章 起点');
  assert.equal(list[0].source, 'toc');
});

test('抽查：标题在区间里出现才算 verified', () => {
  const pages = makeBook();
  const chapters = chaptersFromToc(pages, calibrate(pages, ENTRIES));
  const rate = verifyChapters(pages, chapters);
  assert.equal(rate, 1);
  assert.ok(chapters.filter((chapter) => !chapter.front).every((chapter) => chapter.verified));

  // 人为把第二章的起点改错 4 页，抽查应该抓出来
  const broken = chaptersFromToc(pages, calibrate(pages, ENTRIES));
  const second = broken.find((chapter) => !chapter.front && chapter.n === 2);
  second.from = 1;
  second.to = 3;
  const rate2 = verifyChapters(pages, broken);
  assert.ok(rate2 < 1, '改错的章应该抽查不中');
});

test('抽查：标题错到改不回来时命中率下降', () => {
  const pages = makeBook();
  const wrong = ENTRIES.map((entry, i) => (i === 1 ? { ...entry, title: '第二章 完全不同的名字' } : entry));
  const chapters = chaptersFromToc(pages, calibrate(pages, wrong));
  const rate = verifyChapters(pages, chapters);
  assert.ok(rate < 1);
});

/* ------------------------------ 提示词拼装 ------------------------------ */

test('buildTocMessages：只带目录页原文，并标出行号', () => {
  const pages = makeBook();
  const { system, user } = buildTocMessages({ promptFile: 'SYSTEM', book: { title: '某某书' }, pages: pages, from: 1, to: 2 });
  assert.equal(system, 'SYSTEM');
  assert.match(user, /【书名】某某书/);
  assert.match(user, /【总页数】12/);
  assert.match(user, /L1: /);
});

/* ------------------------------ 真书验证 ------------------------------ */

test('真书：目录读对之后，边界和标题都对', async (t) => {
  const dir = String(process.env.BOOK_SLIDES_BOOK_DIR || '').trim();
  if (!dir) {
    t.skip('没有设置 BOOK_SLIDES_BOOK_DIR');
    return;
  }
  const pages = JSON.parse(fs.readFileSync(path.join(dir, 'pages.json'), 'utf8'));
  const entries = [
    ['第1章 计算机概念和技术', 16],
    ['第2章 计算机指令', 42],
    ['第3章 计算机的算术运算', 114],
    ['第4章 评估和理解性能', 172],
    ['第5章 处理器：数据通路及其控制', 200],
    ['第6章 利用流水线提高性能', 252],
    ['第7章 层次结构的存储器', 322],
    ['第8章 存储器、网络和其他外围设备', 384],
    ['第9章 多处理器和集群', 422],
    ['附录A 汇编器、链接器和 SPIM模拟器', 458],
    ['附录B 逻辑设计基础', 508],
    ['附录C 控制器的硬件实现', 558],
    ['附录D 桌面计算机、服务器和嵌入式系统', 578],
  ].map(([title, physical]) => ({ title: title, printed: physical - 15, level: 'chapter', fixedChar: false }));

  const result = calibrate(pages, entries);
  const chapters = chaptersFromToc(pages, result);
  assert.ok(chapters, '应该能切出章节');
  const list = chapters.filter((chapter) => !chapter.front);
  assert.equal(list.length, 13);
  assert.equal(list[6].title, '第7章 层次结构的存储器');
  assert.equal(list[6].from, 322);
  assert.equal(list[11].title, '附录C 控制器的硬件实现', '附录C 的标题应该来自目录');
  assert.equal(list[11].from, 558);
  assert.equal(verifyChapters(pages, chapters), 1, '每一章的标题都应该能在自己的页区间里找到');
});
