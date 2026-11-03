/**
 * M1 接口测试 —— 用假的 ctx 接上真插件，起一个真 HTTP 服务，走完整导入流程。
 *
 *   node test/server.test.mjs
 *
 * 覆盖 AC-1 ~ AC-7 的服务端部分：导入、去重、书架、详情、书封、原件 Range、改名、软删除。
 * 不碰 DSH 的真实 profile，也不写 ~/.dsh：数据根被指到临时目录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { makePdf } from './fixture.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-api-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const plugin = await import('../index.js');

/** 假 ctx：把 webServer.register 收进一张路由表。 */
function makeContext() {
  const routes = new Map();
  const commands = [];
  const scoped = {
    webServer: {
      register(options) {
        routes.set(options.path, options.handler);
        return () => routes.delete(options.path);
      },
    },
    commands: {
      register(definition) {
        commands.push(definition);
        return () => {};
      },
    },
  };
  const ctx = {
    inject(names, fn) {
      fn(scoped);
    },
    on() {},
    get() {
      return undefined;
    },
  };
  return { ctx, routes, commands };
}

const { ctx, routes, commands } = makeContext();
plugin.apply(ctx);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const handler = routes.get(url.pathname);
  if (!handler) {
    res.statusCode = 404;
    res.end('no route');
    return;
  }
  handler(req, res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

function post(pathname, body, headers) {
  return fetch(base + pathname, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
    body: body,
  });
}

function importPdf(name, buffer) {
  return fetch(base + '/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) },
    body: buffer,
  }).then((res) => res.json());
}

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('空书架：/books 返回空数组与数据目录', async () => {
  const data = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  assert.equal(data.ok, true);
  assert.deepEqual(data.books, []);
  assert.equal(data.dataRoot, ROOT);
  assert.ok(data.pluginVersion);
});

test('导入：合成 PDF 能落盘并切出三章', async () => {
  const data = await importPdf('样例书.pdf', makePdf([
    ['Sample Book', 'Chapter 1 Start', 'alpha '.repeat(30)],
    ['Chapter 2 Turn', 'beta '.repeat(30)],
    ['Chapter 3 End', 'gamma '.repeat(30)],
  ]));
  assert.equal(data.ok, true, JSON.stringify(data));
  assert.match(data.bookId, /^[a-z0-9]{12}$/);
  assert.equal(data.chapters, 3);
  assert.equal(data.pages, 3);

  const dir = path.join(ROOT, 'books', data.bookId);
  for (const file of ['book.json', 'pages.json', 'chapters.json', 'source.pdf']) {
    assert.ok(fs.existsSync(path.join(dir, file)), '应该有 ' + file);
  }
  const book = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8'));
  assert.equal(book.schemaVersion, 1);
  assert.equal(book.title, '样例书');
  assert.equal(book.pages, 3);
});

test('书架与详情：章数、章节区间都在', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  assert.equal(shelf.books.length, 1);
  const id = shelf.books[0].id;
  assert.equal(shelf.books[0].chapters, 3);
  assert.equal(shelf.books[0].modules, 0);

  const detail = await fetch(base + '/dsh-book-slides/book?bookId=' + id).then((r) => r.json());
  assert.equal(detail.ok, true);
  assert.equal(detail.chapters.length >= 3, true);
  const first = detail.chapters.filter((c) => !c.front)[0];
  assert.equal(first.from, 1);
  assert.ok(first.chars > 0);
});

test('重新解析：不重传 PDF，按现规则重切章节并写回', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  const id = shelf.books[0].id;

  // 先把章节文件改坏，模拟「旧规则切错了」
  const chaptersFile = path.join(ROOT, 'books', id, 'chapters.json');
  fs.writeFileSync(chaptersFile, JSON.stringify([{ n: 1, title: '整个一坨', from: 1, to: 99, chars: 1 }]));

  const res = await post('/dsh-book-slides/reparse', JSON.stringify({ bookId: id })).then((r) => r.json());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.chapterCount, 3);
  assert.ok(Array.isArray(res.chapters) && res.chapters.length >= 3);

  const onDisk = JSON.parse(fs.readFileSync(chaptersFile, 'utf8'));
  assert.equal(onDisk.filter((c) => !c.front).length, 3);
  assert.notEqual(onDisk[0].title, '整个一坨');

  const missing = await post('/dsh-book-slides/reparse', JSON.stringify({ bookId: 'aaaaaaaaaaaa' })).then((r) => r.json());
  assert.equal(missing.code, 'E_NOT_FOUND');
});

test('重复导入同一份文件：报 E_DUP_BOOK 且不新增书', async () => {
  const pdf = makePdf([['Chapter 1 Start', 'alpha '.repeat(30)], ['Chapter 2 Turn', 'beta '.repeat(30)]]);
  const first = await importPdf('去重测试.pdf', pdf);
  assert.equal(first.ok, true);
  const second = await importPdf('去重测试.pdf', pdf);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'E_DUP_BOOK');
  assert.equal(second.bookId, first.bookId);

  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  assert.equal(shelf.books.length, 2);
});

test('拒绝非 PDF 与空文件', async () => {
  const notPdf = await importPdf('note.txt', Buffer.from('hello'));
  assert.equal(notPdf.ok, false);
  assert.equal(notPdf.code, 'E_PDF_CORRUPT');

  const empty = await importPdf('empty.pdf', Buffer.alloc(0));
  assert.equal(empty.ok, false);
});

test('坏 PDF 报 E_PDF_CORRUPT，扫描件（无文字层）报 E_PDF_NO_TEXT', async () => {
  const corrupt = await importPdf('broken.pdf', Buffer.from('这不是 PDF'));
  assert.equal(corrupt.code, 'E_PDF_CORRUPT');

  const scanned = await importPdf('scanned.pdf', makePdf([[], []]));
  assert.equal(scanned.code, 'E_PDF_NO_TEXT');
});

test('书封：返回 SVG，且同书两次内容一致', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  const id = shelf.books[0].id;
  const res = await fetch(base + '/dsh-book-slides/cover?bookId=' + id);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  const svg = await res.text();
  assert.match(svg, /<svg/);

  const again = await (await fetch(base + '/dsh-book-slides/cover?bookId=' + id)).text();
  assert.equal(again, svg, '同一本书的书封应该稳定');
});

test('原件：整文件 200，Range 请求 206 且长度对得上', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  const id = shelf.books[0].id;

  const full = await fetch(base + '/dsh-book-slides/file?bookId=' + id);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'application/pdf');
  const bytes = Buffer.from(await full.arrayBuffer());
  assert.ok(bytes.length > 100);

  const partial = await fetch(base + '/dsh-book-slides/file?bookId=' + id, { headers: { range: 'bytes=0-99' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 0-99/' + bytes.length);
  const first100 = Buffer.from(await partial.arrayBuffer());
  assert.equal(first100.length, 100);
  assert.equal(first100.toString('latin1'), bytes.slice(0, 100).toString('latin1'));
});

test('改名：书架与 book.json 一起变', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  const id = shelf.books[0].id;

  const res = await post('/dsh-book-slides/rename', JSON.stringify({ bookId: id, title: '改过的名字' })).then((r) => r.json());
  assert.equal(res.ok, true);

  const book = JSON.parse(fs.readFileSync(path.join(ROOT, 'books', id, 'book.json'), 'utf8'));
  assert.equal(book.title, '改过的名字');

  const bad = await post('/dsh-book-slides/rename', JSON.stringify({ bookId: id, title: '   ' })).then((r) => r.json());
  assert.equal(bad.code, 'E_BAD_TITLE');
});

test('删除：软删除进 trash，书架立刻空一本，原件还在回收站', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  const id = shelf.books[0].id;
  const before = shelf.books.length;

  const res = await post('/dsh-book-slides/delete', JSON.stringify({ bookId: id })).then((r) => r.json());
  assert.equal(res.ok, true);

  const after = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  assert.equal(after.books.length, before - 1);

  const trashEntries = fs.readdirSync(path.join(ROOT, 'trash'));
  assert.equal(trashEntries.length, 1);
  assert.ok(fs.existsSync(path.join(ROOT, 'trash', trashEntries[0], 'book.json')));
});

test('非法与不存在的 id 一律拒绝，不拼路径', async () => {
  for (const bad of ['../etc', 'ABC', 'a'.repeat(40), '']) {
    const res = await fetch(base + '/dsh-book-slides/book?bookId=' + encodeURIComponent(bad));
    const data = await res.json();
    assert.equal(data.code, 'E_NOT_FOUND', 'bad id 应该被拒：' + bad);
  }
});

test('跨站请求被挡：sec-fetch-site: cross-site → 403', async () => {
  const res = await fetch(base + '/dsh-book-slides/books', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(res.status, 403);
});

test('存储概况：目录、占用、回收站数量', async () => {
  const data = await fetch(base + '/dsh-book-slides/storage').then((r) => r.json());
  assert.equal(data.ok, true);
  assert.equal(data.dataRoot, ROOT);
  assert.ok(data.bytes > 0);
  assert.equal(data.trashCount, 1);
});

test('清空回收站：trash 为空，占用空间下降（AC-24）', async () => {
  const before = await fetch(base + '/dsh-book-slides/storage').then((r) => r.json());
  const result = await post('/dsh-book-slides/trash/clear', '{}').then((r) => r.json());
  assert.equal(result.ok, true);
  assert.ok(result.cleared >= 1);
  assert.ok(result.bytesFreed > 0);
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'trash')), []);

  const after = await fetch(base + '/dsh-book-slides/storage').then((r) => r.json());
  assert.equal(after.trashCount, 0);
  assert.equal(after.trashBytes, 0);
  assert.ok(after.bytes < before.bytes, '清空回收站后总占用应下降');
});

test('原文页：按页区间返回未清洗文本，坏范围拒绝', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  const id = shelf.books[0].id;
  const data = await fetch(base + '/dsh-book-slides/pages?bookId=' + id + '&from=1&to=1').then((r) => r.json());
  assert.equal(data.ok, true);
  assert.equal(data.pages.length, 1);
  assert.equal(data.pages[0].page, 1);
  assert.ok(data.pages[0].text.length > 0);

  const bad = await fetch(base + '/dsh-book-slides/pages?bookId=' + id + '&from=5&to=2').then((r) => r.json());
  assert.equal(bad.code, 'E_BAD_RANGE');
});

test('偏好：分隔条比例与语速夹到合法区间并持久化', async () => {
  const initial = await fetch(base + '/dsh-book-slides/preference').then((r) => r.json());
  assert.equal(initial.ok, true);
  assert.equal(initial.preference.splitRatio, 0.55);
  assert.equal(initial.preference.rate, 1);

  const saved = await post(
    '/dsh-book-slides/preference',
    JSON.stringify({ splitRatio: 0.1, rate: 9, muted: true, fontSize: 99 }),
  ).then((r) => r.json());
  assert.equal(saved.ok, true);
  assert.equal(saved.preference.splitRatio, 0.25);
  assert.equal(saved.preference.rate, 2);
  assert.equal(saved.preference.muted, true);
  assert.equal(saved.preference.fontSize, 20);

  const again = await fetch(base + '/dsh-book-slides/preference').then((r) => r.json());
  assert.deepEqual(again.preference, saved.preference);
});

test('方法不对返回 405', async () => {
  const res = await post('/dsh-book-slides/books', '{}');
  assert.equal(res.status, 405);
});

test('生成：没有模型服务时明确报 E_LLM_UNAVAILABLE，不建半截模块', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  const book = shelf.books[0];
  const detail = await fetch(base + '/dsh-book-slides/book?bookId=' + book.id).then((r) => r.json());
  const chapter = detail.chapters.filter((item) => !item.front && item.chars >= 50)[0];
  const before = detail.modules.length;

  const result = await post('/dsh-book-slides/generate', JSON.stringify({ bookId: book.id, chapters: [chapter.n] })).then((r) => r.json());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_LLM_UNAVAILABLE');

  const after = await fetch(base + '/dsh-book-slides/book?bookId=' + book.id).then((r) => r.json());
  assert.equal(after.modules.length, before);
});

/* ------------------------------ 目录切章 ------------------------------ */

test('目录接口：建议范围、预览、非法范围都有明确响应', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  const id = shelf.books[0].id;

  const info = await fetch(base + '/dsh-book-slides/toc?bookId=' + id).then((r) => r.json());
  assert.equal(info.ok, true);
  assert.ok(info.total > 0);
  assert.equal(info.toc, null, '还没跑过目录解析');

  const preview = await post('/dsh-book-slides/toc/preview', JSON.stringify({ bookId: id, from: 1, to: 1 })).then((r) => r.json());
  assert.equal(preview.ok, true);
  assert.ok(preview.chars > 0);

  const bad = await post('/dsh-book-slides/toc/preview', JSON.stringify({ bookId: id, from: 5, to: 2 })).then((r) => r.json());
  assert.equal(bad.code, 'E_BAD_RANGE');
});

test('目录解析：没有模型服务时回退机械切章，不报 500', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  const id = shelf.books[0].id;

  const result = await post('/dsh-book-slides/toc/parse', JSON.stringify({ bookId: id, from: 1, to: 1 })).then((r) => r.json());
  assert.equal(result.ok, true, '回退也算成功，不能把错误抛给面板');
  assert.equal(result.fallback, true);
  assert.ok(result.code);
  assert.ok(result.chapterCount > 0, '回退之后仍然有章节');

  const after = await fetch(base + '/dsh-book-slides/toc?bookId=' + id).then((r) => r.json());
  assert.equal(after.toc.status, 'failed');
  assert.ok(after.toc.message);
});

test('目录范围：填过就记住，并且优先于建议值', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  const id = shelf.books[0].id;

  const saved = await post('/dsh-book-slides/toc/range', JSON.stringify({ bookId: id, from: 2, to: 3 })).then((r) => r.json());
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.range, { from: 2, to: 3 });

  const after = await fetch(base + '/dsh-book-slides/toc?bookId=' + id).then((r) => r.json());
  assert.deepEqual(after.range, { from: 2, to: 3 }, '重新进来要拿得到上次填的范围');

  const bad = await post('/dsh-book-slides/toc/range', JSON.stringify({ bookId: id, from: 3, to: 2 })).then((r) => r.json());
  assert.equal(bad.code, 'E_BAD_RANGE');
});

test('防覆盖：有目录结果时，机械重切先被拦住，force 才覆盖', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  const id = shelf.books[0].id;

  // 造一份「目录切过且校验通过」的痕迹
  fs.writeFileSync(
    path.join(ROOT, 'books', id, 'toc.json'),
    JSON.stringify({ status: 'verified', offset: 15, hitRate: 1, range: { from: 1, to: 1 } }),
  );

  const blocked = await post('/dsh-book-slides/reparse', JSON.stringify({ bookId: id })).then((r) => r.json());
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'E_TOC_EXISTS');
  assert.match(blocked.error, /目录/);

  const forced = await post('/dsh-book-slides/reparse', JSON.stringify({ bookId: id, force: true })).then((r) => r.json());
  assert.equal(forced.ok, true);

  const chapters = JSON.parse(fs.readFileSync(path.join(ROOT, 'books', id, 'chapters.json'), 'utf8'));
  assert.ok(chapters.every((c) => c.source === 'mechanical'), '覆盖之后要标成机械来源，面板才看得出');
});

test('目录重放：chapters.json 被机械结果覆盖后，靠 toc.json 重放能恢复', async () => {
  const shelf = await fetch(base + '/dsh-book-slides/books').then((r) => r.json());
  const id = shelf.books[0].id;
  const dir = path.join(ROOT, 'books', id);
  const book = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8'));

  // 造一份「目录切过」的痕迹：标题取自这本书真实切出来的章，
  // 并故意把 physical 写成错的（1），验证重放会重算而不是照抄。
  const mech = JSON.parse(fs.readFileSync(path.join(dir, 'chapters.json'), 'utf8')).filter((c) => !c.front);
  // 用第 2、3 章做条目：范围 1-1 会跳过第 1 页，而第 1 章恰好在那页上
  const entries = mech.slice(1, 3).map((c) => ({ title: c.title, printed: c.from, physical: 1, level: 'chapter', anchor: 'title' }));
  // 缓存键由服务端算：书 sha + 范围 + 提示词版本
  const { sha256Of } = await import('../store.js');
  const { TOC_PROMPT_VERSION } = await import('../tocparse.js');
  const cacheKey = sha256Of(Buffer.from([book.sha256 || '', 1, 1, TOC_PROMPT_VERSION].join('|'), 'utf8'));
  fs.writeFileSync(
    path.join(dir, 'toc.json'),
    JSON.stringify({ status: 'verified', offset: 0, hitRate: 1, entries: entries, cacheKey: cacheKey, range: { from: 1, to: 1 } }),
  );

  // 先把 chapters.json 换成机械结果
  await post('/dsh-book-slides/reparse', JSON.stringify({ bookId: id, force: true })).then((r) => r.json());

  // 不带 force 走缓存路径：服务端根本不比对 cacheKey 的模型部分时也该能重放
  const replayed = await post('/dsh-book-slides/toc/parse', JSON.stringify({ bookId: id, from: 1, to: 1 })).then((r) => r.json());
  assert.equal(replayed.ok, true);
  assert.ok(Array.isArray(replayed.chapters));

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'chapters.json'), 'utf8'));
  assert.ok(onDisk.every((c) => c.source === 'toc'), '重放之后章节应标回目录来源');
  const first = onDisk.filter((c) => !c.front)[0];
  assert.equal(first.from, mech[1].from, '重放必须按 printed 重算起点，不能照抄 toc.json 里错的 physical');
  assert.ok(cacheKey);
});

/* ---------------------------- 章节手动修正 ---------------------------- */

/** 五页两章：第 1 章占 1–3 页，第 2 章占 4–5 页，够拆分用。 */
function chapterPdf() {
  return makePdf([
    ['Chapter 1 Start', 'one '.repeat(40)],
    ['one-b '.repeat(40)],
    ['one-c '.repeat(40)],
    ['Chapter 2 Turn', 'two '.repeat(40)],
    ['two-b '.repeat(40)],
  ]);
}

const op = (body) => post('/dsh-book-slides/chapters', JSON.stringify(body)).then((r) => r.json());
let chapterBookId = '';

test('章节操作：先确认两章各自跨页', async () => {
  const imported = await importPdf('章节操作用书.pdf', chapterPdf());
  assert.equal(imported.ok, true, JSON.stringify(imported));
  chapterBookId = imported.bookId;
  const detail = await fetch(base + '/dsh-book-slides/book?bookId=' + imported.bookId).then((r) => r.json());
  const chapters = detail.chapters.filter((c) => !c.front);
  assert.equal(chapters.length, 2);
  assert.deepEqual([chapters[0].from, chapters[0].to], [1, 3]);
  assert.deepEqual([chapters[1].from, chapters[1].to], [4, 5]);
});

test('章节操作：拆分、合并、改名、排除、恢复', async () => {
  const id = chapterBookId;
  assert.ok(id, '前面的测试应该先导入一本书');

  let res = await op({ bookId: id, op: 'split', n: 1, page: 2 });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.chapterCount, 3);
  const afterSplit = res.chapters.filter((c) => !c.front);
  assert.deepEqual([afterSplit[0].from, afterSplit[0].to], [1, 1]);
  assert.deepEqual([afterSplit[1].from, afterSplit[1].to], [2, 3]);
  assert.equal(afterSplit[0].manual, true);

  res = await op({ bookId: id, op: 'merge', n: 1 });
  assert.equal(res.chapterCount, 2);
  const afterMerge = res.chapters.filter((c) => !c.front);
  assert.deepEqual([afterMerge[0].from, afterMerge[0].to], [1, 3]);

  res = await op({ bookId: id, op: 'rename', n: 2, title: '改过的第二章' });
  assert.equal(res.chapters.find((c) => c.n === 2).title, '改过的第二章');
  assert.equal(res.chapters.find((c) => c.n === 2).manual, true);

  res = await op({ bookId: id, op: 'exclude', n: 2 });
  assert.equal(res.chapters.find((c) => c.n === 2).hidden, true);
  res = await op({ bookId: id, op: 'include', n: 2 });
  assert.equal(res.chapters.find((c) => c.n === 2).hidden, false);

  // 字数要按页区间重算，不能停在旧值
  const detail = await fetch(base + '/dsh-book-slides/book?bookId=' + id).then((r) => r.json());
  const first = detail.chapters.filter((c) => !c.front)[0];
  assert.ok(first.chars > 0);
});

test('章节操作：非法参数都有明确错误码', async () => {
  const id = chapterBookId;
  assert.equal((await op({ bookId: id, op: 'split', n: 1, page: 99 })).code, 'E_BAD_PAGE');
  assert.equal((await op({ bookId: id, op: 'split', n: 1, page: 1 })).code, 'E_BAD_PAGE');
  assert.equal((await op({ bookId: id, op: 'rename', n: 99, title: 'x' })).code, 'E_NO_CHAPTER');
  assert.equal((await op({ bookId: id, op: 'rename', n: 1, title: '   ' })).code, 'E_BAD_TITLE');
  assert.equal((await op({ bookId: id, op: 'explode', n: 1 })).code, 'E_BAD_OP');
  assert.equal((await op({ bookId: '../../../etc', op: 'rename', n: 1, title: 'x' })).code, 'E_NOT_FOUND');
});

test('重新解析：有手改时先拦住，带 force 才覆盖', async () => {
  const id = chapterBookId;
  const guarded = await post('/dsh-book-slides/reparse', JSON.stringify({ bookId: id })).then((r) => r.json());
  assert.equal(guarded.ok, false);
  assert.equal(guarded.code, 'E_MANUAL_EDITS');

  const forced = await post('/dsh-book-slides/reparse', JSON.stringify({ bookId: id, force: true })).then((r) => r.json());
  assert.equal(forced.ok, true);
  assert.equal(forced.chapterCount, 2);

  const onDisk = JSON.parse(fs.readFileSync(path.join(ROOT, 'books', id, 'chapters.json'), 'utf8'));
  assert.equal(onDisk.some((c) => c.manual), false, '覆盖之后不该还留着 manual 标记');
});

test('命令：注册了 chapter-check，参数支持 @目录 与末尾 mech', async () => {
  const command = commands.find((item) => item.name === 'chapter-check');
  assert.ok(command, '没注册 chapter-check');
  assert.equal(typeof command.handler, 'function');
  assert.match(String(command.description), /书签/);

  const empty = await command.handler({ agent: null, rawInput: '  ', signal: undefined });
  assert.equal(empty.kind, 'error');
  assert.match(empty.text, /用法/);
});