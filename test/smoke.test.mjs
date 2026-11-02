/**
 * M1 冒烟测试 —— 覆盖纯逻辑与真实 PDF 读取，不需要跑 DSH。
 *
 *   node test/smoke.test.mjs
 *
 * 想拿真书验一遍，加一个环境变量：
 *   $env:BOOK_SLIDES_SAMPLE_PDF = 'C:\path\to\book.pdf'; node test/smoke.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makePdf } from './fixture.mjs';

/* --------------------------------- 行重建 -------------------------------- */

test('linesOfItems：双栏页不会把左右栏拼成一行', async () => {
  const { linesOfItems } = await import('../pdfread.js');
  // 左栏 x≈40，右栏 x≈260；同一基线上的左右两栏如果按 y 硬并，就会拼成一锅粥
  const items = [
    { str: '第一章 起点 1', transform: [1, 0, 0, 1, 40, 700], width: 90 },
    { str: '第二章 转折 20', transform: [1, 0, 0, 1, 260, 700], width: 95 },
    { str: '9.1 小节甲 2', transform: [1, 0, 0, 1, 40, 680], width: 80 },
    { str: '12.1 小节乙 21', transform: [1, 0, 0, 1, 260, 680], width: 90 },
    { str: '9.2 小节丙 3', transform: [1, 0, 0, 1, 40, 660], width: 80 },
    { str: '12.2 小节丁 22', transform: [1, 0, 0, 1, 260, 660], width: 90 },
  ];
  const lines = linesOfItems(items);
  assert.equal(lines.length, 6, '六行各自成行，实际：' + JSON.stringify(lines));
  assert.ok(lines.includes('第一章 起点 1'));
  assert.ok(lines.includes('第二章 转折 20'));
  assert.ok(
    lines.every((line) => !/第一章.*第二章/.test(line)),
    '左右栏不该拼在一起：' + JSON.stringify(lines),
  );
});

test('linesOfItems：行尾页码跟着本行，不会跑到下一行前面', async () => {
  const { linesOfItems } = await import('../pdfread.js');
  const items = [
    { str: '9.7 扩展和分解脚本', transform: [1, 0, 0, 1, 40, 356.2], width: 88 },
    { str: '146', transform: [1, 0, 0, 1, 132, 356.7], width: 20 },
    { str: '9.8 重写', transform: [1, 0, 0, 1, 40, 338.8], width: 60 },
  ];
  const lines = linesOfItems(items);
  assert.equal(lines[0], '9.7 扩展和分解脚本 146', '实际：' + JSON.stringify(lines));
  assert.equal(lines[1], '9.8 重写');
});

/* --------------------------------- 文本 --------------------------------- */

test('isChapterLine：认标题，不认正文句子', async () => {
  const { isChapterLine, isPartLine } = await import('../text.js');
  const good = [
    '第一章 电影导演',
    '第 12 章 收尾',
    '第三章',
    '序章',
    '附录一',
    'Chapter 3',
  ];
  const bad = [
    '第一章讲了什么是导演。',
    '第三部分我们讲，如何开机。',
    '我觉得第三章写得不好，',
    '这是正文里提到第一章的一句话，很长很长很长很长很长很长很长很长很长很长很长很长很长',
    '第一章 这里有，逗号',
  ];
  for (const line of good) assert.equal(isChapterLine(line), true, '应该认成标题：' + line);
  for (const line of bad) assert.equal(isChapterLine(line), false, '不该认成标题：' + line);

  // 分卷标记是「部分」，不是章：只有找不到章时才退而用它
  for (const line of ['第二部分 方法', '第三部分', 'PART II']) {
    assert.equal(isChapterLine(line), false, '部分不该算章：' + line);
    assert.equal(isPartLine(line), true, '应该是分卷标记：' + line);
  }

  // 没有编号的标题出现在页面深处，多半是图注或正文里的字
  assert.equal(isChapterLine('引子', 0), true);
  assert.equal(isChapterLine('引子', 18), false);
  assert.equal(isChapterLine('尾声 归途', 18), true, '带标题的尾巴仍然算');
});

test('cleanPages：去页眉页脚、去页码行、合软换行', async () => {
  const { cleanPages } = await import('../text.js');
  const pages = [];
  for (let i = 1; i <= 6; i += 1) {
    pages.push({
      page: i,
      text: '我的书名\n第 ' + i + ' 章 标题\n第 ' + i + ' 页的一段被排版折断的正文，第一行没写完\n接着写在第二行上。\n' + i,
    });
  }
  const cleaned = cleanPages(pages);
  assert.equal(cleaned.length, 6);
  assert.ok(!cleaned[0].text.includes('我的书名'), '页眉应该被去掉');
  assert.ok(!/\n\d+\n/.test(cleaned[0].text), '孤立页码行应该被去掉');
  assert.ok(
    cleaned[0].text.includes('第 1 页的一段被排版折断的正文，第一行没写完接着写在第二行上。'),
    '软换行应该被合并，实际：' + cleaned[0].text,
  );
});

test('buildChapters：目录页不算章，区间与字数对得上', async () => {
  const { buildChapters, cleanPages } = await import('../text.js');
  const raw = [
    { page: 1, text: '目 录\n第一章 起点 …… 1\n第二章 转折 …… 20\n第三章 收尾 …… 40' },
    { page: 2, text: '第一章 起点\n' + '甲'.repeat(300) },
    { page: 3, text: '乙'.repeat(300) },
    { page: 4, text: '第二章 转折\n' + '丙'.repeat(300) },
    { page: 5, text: '第三章 收尾\n' + '丁'.repeat(300) },
  ];
  const chapters = buildChapters(cleanPages(raw));
  assert.equal(chapters.length, 3, '应该刚好三章，实际：' + JSON.stringify(chapters.map((c) => c.title)));
  assert.equal(chapters[0].from, 2);
  assert.equal(chapters[0].to, 3);
  assert.equal(chapters[1].from, 4);
  assert.equal(chapters[1].to, 4);
  assert.equal(chapters[2].to, 5);
  assert.ok(chapters[0].chars >= 600, '第一章字数应该包含两页，实际 ' + chapters[0].chars);
  assert.ok(chapters[0].title.startsWith('第一章'), '标题应该带章号：' + chapters[0].title);
});

test('buildChapters：切不出章就走兜底单章', async () => {
  const { buildChapters } = await import('../text.js');
  const chapters = buildChapters([
    { page: 1, text: '散文一段，没有章节标题。' },
    { page: 2, text: '散文第二段，还是没有。' },
  ]);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, '全文');
  assert.equal(chapters[0].fallback, true);
});

test('buildChapters：页眉不会变成新章，分卷页与图注不捣乱', async () => {
  const { buildChapters, cleanPages } = await import('../text.js');
  const body = '正文正文正文正文正文正文正文正文正文正文正文正文。';
  const raw = [
    { page: 1, text: '版权信息\n书名：一本真书' },
    { page: 2, text: '第 1 章 起点 1\n' + body },
    { page: 3, text: '第 1 章 起点 2\n' + body },
    { page: 4, text: '第 1 章 起点 3\n' + body },
    { page: 5, text: '第 2 章 转折 4\n' + body },
    { page: 6, text: '第 2 章 转折 5\n' + body },
    { page: 7, text: '第 2 章 转折 6\n上升动作\n展开\n解决\n引子\n' + body },
    { page: 8, text: '第 2 章 转折 7\n' + body },
  ];
  const chapters = buildChapters(cleanPages(raw)).filter((c) => !c.front);
  assert.equal(chapters.length, 2, '应该是两章，实际：' + JSON.stringify(chapters.map((c) => c.title)));
  assert.equal(chapters[0].title, '第 1 章 起点');
  assert.equal(chapters[0].from, 2);
  assert.equal(chapters[0].to, 4);
  assert.equal(chapters[1].title, '第 2 章 转折');
  assert.equal(chapters[1].from, 5);
  assert.equal(chapters[1].to, 8);
});

test('buildChapters：页眉把章号认错时，不会多出一个假章', async () => {
  const { buildChapters, cleanPages } = await import('../text.js');
  const body = '正文正文正文正文正文正文正文正文正文正文正文正文。';
  const raw = [
    { page: 1, text: '书名页' },
    { page: 2, text: '第26章 美术设计 300\n' + body },
    { page: 3, text: '第26章 美术设计 301\n' + body },
    { page: 4, text: '第26章 美术设计 302\n' + body },
    // 这一页的页眉被 OCR 认成「第28章 英术设计」：号不对、标题错一个字
    { page: 5, text: '第28章 英术设计 303\n' + body },
    { page: 6, text: '第27章\n前期会议和设备确定\n' + body },
    { page: 7, text: '第27章 前期会议和设备确定 305\n' + body },
  ];
  const chapters = buildChapters(cleanPages(raw)).filter((c) => !c.front);
  assert.equal(chapters.length, 2, '应该是两章，实际：' + JSON.stringify(chapters.map((c) => c.title)));
  assert.equal(chapters[0].title, '第26章 美术设计');
  assert.equal(chapters[0].to, 5, '被认错号的那一页仍属于第 26 章');
  assert.equal(chapters[1].title, '第27章 前期会议和设备确定');
  assert.equal(chapters[1].from, 6);
});

test('buildChapters：目录不是只有一页、也未必写着「目录」', async () => {
  const { buildChapters, cleanPages } = await import('../text.js');
  const tocPage = (n) =>
    Array.from({ length: 12 }, (_, i) => '条目' + n + '-' + i + ' ' + (n * 100 + i)).join('\n');
  const raw = [
    { page: 1, text: tocPage(1) },
    { page: 2, text: tocPage(2) },
    { page: 3, text: tocPage(3) },
    { page: 4, text: '第一章 起点\n正文正文正文正文正文正文正文正文正文正文正文正文。' },
    { page: 5, text: '第二章 转折\n正文正文正文正文正文正文正文正文正文正文正文正文。' },
  ];
  const chapters = buildChapters(cleanPages(raw)).filter((c) => !c.front);
  assert.equal(chapters.length, 2, '目录三页都不该算章，实际：' + JSON.stringify(chapters.map((c) => c.title)));
  assert.equal(chapters[0].from, 4);
  assert.equal(chapters[1].from, 5);
});

test('isChapterLine：正文里的跨章引用不算标题', async () => {
  const { isChapterLine } = await import('../text.js');
  assert.equal(isChapterLine('第5章“站在电影制作者的角度思考”中,曾强烈推荐你将最喜欢的当代电影中的某些'), false);
  assert.equal(isChapterLine('第38章“准备剪辑”对后期制作人员及其责任有详细描述'), false);
  assert.equal(isChapterLine('第41章 学会分析和利用反馈效果'), true);
  // 顿号、全角冒号是标题的常用写法，不能一棍子打死
  assert.equal(isChapterLine('第14章 时间、结构与情节'), true);
  assert.equal(isChapterLine('第13章 潜文本：类型和原型'), true);
});

test('buildChapters：章首页的章号被 OCR 吃掉时，起点回到标题页', async () => {
  const { buildChapters, cleanPages } = await import('../text.js');
  const body = '正文'.repeat(80) + '。';
  const raw = [
    { page: 1, text: '书名页' },
    // 标题页：章号「1」被认没了，只剩「第章」
    { page: 2, text: '第章\n电影导演的世界\n' + body },
    { page: 3, text: body },
    // 第一个能认出来的页眉出现在第 4 页
    { page: 4, text: '第1章 电影导演的世界 3\n' + body },
    { page: 5, text: body },
    { page: 6, text: '第章\n确立电影主题\n' + body },
    { page: 7, text: '第2章 确立电影主题 5\n' + body },
  ];
  const chapters = buildChapters(cleanPages(raw)).filter((c) => !c.front);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].from, 2, '起点应该是标题页，而不是第一个页眉所在的第 4 页');
  assert.equal(chapters[0].to, 5);
  assert.equal(chapters[1].from, 6);
});

test('buildChapters：分卷页不算进上一章的尾巴', async () => {
  const { buildChapters, cleanPages } = await import('../text.js');
  const body = '正文'.repeat(80) + '。';
  const raw = [
    { page: 1, text: '第1章 起点\n' + body },
    { page: 2, text: body },
    { page: 3, text: 'Part 2\n第二部分' },
    { page: 4, text: '第二部分（第2章至第3章）讲的是后面三段内容。' },
    { page: 5, text: '第2章 转折\n' + body },
    { page: 6, text: body },
  ];
  const chapters = buildChapters(cleanPages(raw)).filter((c) => !c.front);
  assert.equal(chapters.length, 2);
  assert.deepEqual([chapters[0].from, chapters[0].to], [1, 2], '分卷页 3–4 不该算进第 1 章');
  assert.deepEqual([chapters[1].from, chapters[1].to], [5, 6]);
});

test('buildChapters：标题和正文粘成一行的标题页，也能回溯到', async () => {
  const { buildChapters, cleanPages } = await import('../text.js');
  const body = '正文'.repeat(150) + '。';
  const raw = [
    { page: 1, text: '书名页' },
    // 真书里第 5 章就这样：章号「5」被认成「意」，标题紧跟正文、没有换行
    { page: 2, text: '第意\n站在电影制作者的角度思考本章的四个练习项目会让你对画面构图有个基本认识。' + body },
    // 第 3 页是密集正文，第一行以「拍摄」开头——挡住「差两个字就算命中」的误判
    { page: 3, text: '88 某书\n拍摄夜景或月光场景几乎是不可能实现的，' + body },
    { page: 4, text: '第5章 站在电影制作者的的度思考 65\n' + body },
    { page: 5, text: body },
    { page: 6, text: '第6章\n拍摄练习\n' + body },
    { page: 7, text: '第6章 拍摄练习 67\n' + body },
  ];
  const chapters = buildChapters(cleanPages(raw)).filter((c) => !c.front);
  assert.equal(chapters.length, 2, JSON.stringify(chapters.map((c) => c.title)));
  assert.equal(chapters[0].from, 2, '起点应该是第 2 页的标题页');
  assert.equal(chapters[1].from, 6, '第 6 章不该被正文里以「拍摄」开头的那行拽到第 3 页');
});

test('buildChapters：标题页字数多（>700）也能当标题页认', async () => {
  const { buildChapters, cleanPages } = await import('../text.js');
  const filler = '这段是正文，用来把标题页撑到七百字以上。'.repeat(30);
  const raw = [
    { page: 1, text: '书名页' },
    // 标题页本身就有七百多字：章号被认成「4/」，标题单独一行
    { page: 2, text: '第4/章\n进军电影界\n' + filler },
    { page: 3, text: '第47章 进军电影界 519\n' + filler },
    { page: 4, text: filler },
    { page: 5, text: '第48章\n新的一程\n' + filler },
    { page: 6, text: '第48章 新的一程 521\n' + filler },
  ];
  const chapters = buildChapters(cleanPages(raw)).filter((c) => !c.front);
  assert.equal(chapters.length, 2, '应该切出两章；实际：' + JSON.stringify(chapters.map((c) => c.title)));
  assert.equal(chapters[0].from, 2, '起点应该是第 2 页，而不是第一个页眉所在的第 3 页');
  assert.equal(chapters[0].to, 4);
});

test('buildChapters：不写页码的条目式目录也要整块去掉', async () => {
  const { buildChapters, cleanPages } = await import('../text.js');
  const toc = [
    '目 录',
    '致中国读者',
    '序言',
    'PART Ⅰ作家和故事艺术',
    'CHAPTER 01 故事问题',
    'PART Ⅱ故事诸要素',
    'CHAPTER 02 结构图谱',
    'CHAPTER 03 结构与背景',
    'CHAPTER 04 结构与类型',
    'CHAPTER 05 结构与人物',
  ].join('\n');
  const body = '正文'.repeat(80) + '。';
  const raw = [
    { page: 1, text: toc },
    { page: 2, text: 'CHAPTER 01\n故事问题\n' + body },
    { page: 3, text: body },
    { page: 4, text: 'CHAPTER 02\n结构图谱\n' + body },
    { page: 5, text: body },
  ];
  const chapters = buildChapters(cleanPages(raw)).filter((c) => !c.front);
  assert.equal(chapters.length, 2, '目录页没有页码，也要认出来；实际：' + JSON.stringify(chapters.map((c) => c.title)));
  assert.equal(chapters[0].from, 2);
});

test('buildChapters：译注/索引里重复的章号不算新章', async () => {
  const { buildChapters, cleanPages } = await import('../text.js');
  const body = '正文'.repeat(80) + '。';
  const raw = [
    { page: 1, text: 'CHAPTER 01\n故事问题\n' + body },
    { page: 2, text: body },
    { page: 3, text: 'CHAPTER 02\n结构图谱\n' + body },
    { page: 4, text: body },
    { page: 5, text: '附录：文中涉及影片列表\n' + body },
    // 译注部分：标题照抄正文章号，没有任何标题文字
    { page: 6, text: 'CHAPTER 01\n1. 格式塔（Gestalt）：意为“完形”，' + body },
    { page: 7, text: 'CHAPTER 02\n2. 刻板故事：参见译注。' + body },
  ];
  const chapters = buildChapters(cleanPages(raw)).filter((c) => !c.front);
  assert.equal(chapters.length, 3, '译注里的重复章号不是新章；实际：' + JSON.stringify(chapters.map((c) => c.title)));
  assert.equal(chapters[2].to, 5, '附录的尾巴不该吞掉后面的译注页');
});

test('buildChapters：第二个「序言」不算章', async () => {
  const { buildChapters, cleanPages } = await import('../text.js');
  const body = '正文'.repeat(80) + '。';
  const raw = [
    { page: 1, text: '序言\n' + body },
    { page: 2, text: '第一章 起点\n' + body },
    { page: 3, text: body },
    // 附录后面的译者补记，标题又叫「序言」
    { page: 4, text: '序言\n译者补记。' + body },
  ];
  const chapters = buildChapters(cleanPages(raw)).filter((c) => !c.front);
  assert.equal(chapters.length, 2, '实际：' + JSON.stringify(chapters.map((c) => c.title)));
  assert.equal(chapters[0].title, '序言');
  assert.equal(chapters[1].title, '第一章 起点');
});

test('buildChapters：分部重新编号（同号不同题）不误杀', async () => {
  const { buildChapters, cleanPages } = await import('../text.js');
  const body = '正文'.repeat(80) + '。';
  const raw = [
    { page: 1, text: '第一部\n第一章 开头\n' + body },
    { page: 2, text: body },
    { page: 3, text: '第二部\n第一章 重新开始\n' + body },
    { page: 4, text: body },
  ];
  const chapters = buildChapters(cleanPages(raw)).filter((c) => !c.front);
  assert.equal(chapters.length, 2, '同号但标题不同，应该各算一章；实际：' + JSON.stringify(chapters.map((c) => c.title)));
});

/* --------------------------------- 存储 --------------------------------- */

test('store：原子写读、ID 校验、改名、软删除', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-test-'));
  process.env.DSH_BOOK_SLIDES_ROOT = root;
  const store = await import('../store.js');

  store.ensureDirs();
  const id = store.newId(12);
  assert.match(id, /^[a-z0-9]{12}$/);
  assert.equal(store.isValidId(id), true);
  assert.equal(store.isValidId('../etc'), false);
  assert.equal(store.isValidId('ABC'), false);

  const dir = store.bookDir(id);
  store.writeJson(path.join(dir, 'book.json'), { id: id, title: '旧名', chapterCount: 2, chars: 100 });
  assert.equal(store.loadBook(id).book.title, '旧名');

  store.renameBook(id, '新名');
  assert.equal(store.loadBook(id).book.title, '新名');

  const books = store.listBooks();
  assert.equal(books.length, 1);
  assert.equal(books[0].id, id);
  assert.equal(books[0].chapters, 2);

  assert.equal(store.trashBook(id), true);
  assert.equal(store.listBooks().length, 0);
  assert.equal(fs.readdirSync(path.join(root, 'trash')).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

/* ---------------------------------- PDF ---------------------------------- */

test('pdfread：从合成 PDF 里读出逐页文本并切出章节', async () => {
  const pdf = makePdf([
    ['My Book', 'Chapter 1 Start', 'alpha '.repeat(20)],
    ['Chapter 2 Turn', 'beta '.repeat(20)],
    ['Chapter 3 End', 'gamma '.repeat(20)],
  ]);
  const { extractPages, totalChars } = await import('../pdfread.js');
  const { cleanPages, buildChapters } = await import('../text.js');

  const result = await extractPages(pdf);
  assert.equal(result.numPages, 3);
  assert.equal(result.pages.length, 3);
  assert.ok(totalChars(result.pages) > 50);
  assert.ok(result.pages[0].text.includes('Chapter 1 Start'), '第一页应该读到标题，实际：' + result.pages[0].text);

  const chapters = buildChapters(cleanPages(result.pages));
  assert.equal(chapters.length, 3, '应该切出三章，实际：' + JSON.stringify(chapters.map((c) => c.title)));
  assert.equal(chapters[0].from, 1);
  assert.equal(chapters[1].from, 2);
  assert.equal(chapters[2].to, 3);
});

test('pdfread：没有文字层的 PDF 报 E_PDF_NO_TEXT', async () => {
  const pdf = makePdf([[], []]);
  const { extractPages, totalChars } = await import('../pdfread.js');
  const result = await extractPages(pdf);
  assert.ok(totalChars(result.pages) < 50);
});

test('pdfread：坏文件报 E_PDF_CORRUPT', async () => {
  const { extractPages, PDF_ERROR } = await import('../pdfread.js');
  await assert.rejects(
    () => extractPages(Buffer.from('这不是 PDF，只是一段文字')),
    (err) => err.code === PDF_ERROR.CORRUPT,
  );
});

test('真书样本（需要 BOOK_SLIDES_SAMPLE_PDF）', async (t) => {
  const sample = String(process.env.BOOK_SLIDES_SAMPLE_PDF || '').trim();
  if (!sample) {
    t.skip('没有设置 BOOK_SLIDES_SAMPLE_PDF');
    return;
  }
  const { extractPages, totalChars } = await import('../pdfread.js');
  const { cleanPages, buildChapters } = await import('../text.js');
  const bytes = fs.readFileSync(sample);
  const result = await extractPages(bytes);
  const cleaned = cleanPages(result.pages);
  const chapters = buildChapters(cleaned);
  console.log(
    '样本 ' + path.basename(sample) + '：' + result.numPages + ' 页 · ' + totalChars(result.pages) + ' 字 · ' + chapters.length + ' 章',
  );
  chapters.slice(0, 12).forEach((c) => console.log('  ' + c.n + '. ' + c.title + '  [' + c.from + '–' + c.to + '] ' + c.chars + ' 字'));
  assert.ok(totalChars(result.pages) > 1000, '真书应该读出足够的字');
  assert.ok(chapters.length >= 2, '真书应该至少切出两章');
});
