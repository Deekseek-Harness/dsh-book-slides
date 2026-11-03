/**
 * 生成流水线接口测试 —— 假模型，真路由。
 *
 *   node test/generate.test.mjs
 *
 * 覆盖 M3 的验收骨架：AC-13（四阶段进度到就绪）、AC-14（取消）、
 * AC-15（坏 JSON/超时不留半截模块）、AC-16（幂等不重复调用）、AC-22（试听提示）。
 * 语音这一版是浏览器本机朗读，所以断言的是「audio_ms 有值、audio_provider=browser、
 * 不落 audio/*.mp3」，而不是音频字节。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { makePdf } from './fixture.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-gen-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
process.env.DSH_BOOK_SLIDES_LLM_TIMEOUT_MS = '300';
delete process.env.DSH_HOME;

const plugin = await import('../index.js');
const generate = await import('../generate.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 假模型：按队列吐 chunk，并记录每次调用的 user 文本。 */
const calls = [];
let queue = [];
let hang = false;

const fakeLlm = {
  async prepareCall(config, signal) {
    if (hang) {
      // 模拟模型不响应：只有超时/取消信号能把它叫醒
      return new Promise((resolve, reject) => {
        const abort = () => reject(signal && signal.reason ? signal.reason : Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
        if (signal && signal.aborted) abort();
        else if (signal) signal.addEventListener('abort', abort, { once: true });
      });
    }
    const entry = { config: config, user: '' };
    calls.push(entry);
    return {
      config: {},
      async *stream(params) {
        try {
          entry.user = params && params.messages && params.messages[0] && params.messages[0].content[0] ? params.messages[0].content[0].text : '';
        } catch {
          entry.user = '';
        }
        const chunks = queue.shift();
        if (!chunks) throw new Error('假模型队列空了：这次调用没有人排回复');
        for (const chunk of chunks) {
          if (chunk && chunk.delayMs) await sleep(chunk.delayMs);
          const copy = Object.assign({}, chunk);
          delete copy.delayMs;
          yield copy;
        }
      },
    };
  },
};

function makeContext() {
  const routes = new Map();
  const scoped = {
    webServer: {
      register(options) {
        routes.set(options.path, options.handler);
        return () => routes.delete(options.path);
      },
    },
    commands: { register() { return () => {}; } },
  };
  const ctx = {
    inject(names, fn) {
      fn(scoped);
    },
    on() {},
    get(name) {
      if (name === 'llm') return fakeLlm;
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) };
      return undefined;
    },
  };
  return { ctx, routes };
}

const { ctx, routes } = makeContext();
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

async function getJson(pathname) {
  const res = await fetch(base + pathname);
  return res.json();
}

async function postJson(pathname, body) {
  return fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then((res) => res.json());
}

const imported = await fetch(base + '/dsh-book-slides/import', {
  method: 'POST',
  headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('生成测试书.pdf') },
  body: makePdf([
    ['Sample Book', 'Chapter 1 Start', 'alpha '.repeat(30)],
    ['Chapter 2 Turn', 'beta '.repeat(30)],
    ['Chapter 3 End', 'gamma '.repeat(30)],
  ]),
}).then((res) => res.json());
const bookId = imported.bookId;
const bookDir = path.join(ROOT, 'books', bookId);
const pagesJson = JSON.parse(fs.readFileSync(path.join(bookDir, 'pages.json'), 'utf8'));

const detail = await getJson('/dsh-book-slides/book?bookId=' + bookId);
const chapters = detail.chapters.filter((chapter) => !chapter.front);
assert.equal(chapters.length >= 3, true, '样书应该切出 3 章');

function chapterOf(n) {
  return chapters.find((chapter) => chapter.n === n);
}

/** 从某章原文里取一段 20–80 字的连续文字，当模型「逐字摘抄」的答案。 */
function quoteFrom(chapter) {
  const lines = [];
  for (const page of pagesJson) {
    if (page.page < chapter.from || page.page > chapter.to) continue;
    for (const line of String(page.text || '').split('\n')) lines.push(line.trim());
  }
  const line = lines.find((text) => text.length >= 20 && !/^chapter\s/i.test(text));
  return (line || lines.join('')).slice(0, 80);
}

function slideAt(index, quote, page) {
  const layout = index === 1 ? 'cover' : index % 3 === 0 ? 'quote' : 'content_text';
  return {
    slide_index: index,
    layout: layout,
    title: '第 ' + index + ' 页',
    subtitle: index === 1 ? '第 1 章' : '',
    bullet_points: layout === 'content_text' ? ['要点一', '要点二'] : [],
    quote_text: layout === 'quote' ? '一句来自原文的引文。' : null,
    quote_source: layout === 'quote' ? '生成测试书' : null,
    image_prompt: '书桌上摊开的书，暖色晨光',
    audio_script: '大家好，这一页我们讲一个很短的意思，尽量说得像聊天一样，不念要点，也不说第一点第二点。',
    source_quote: quote,
    source_pages: { from: page, to: page },
  };
}

function replyFor(quote, page, count) {
  const slides = Array.from({ length: count || 6 }, (_, index) => slideAt(index + 1, quote, page));
  return [{ type: 'text-delta', text: JSON.stringify({ module_title: '测试精讲', slides: slides }) }, { type: 'finish', reason: { kind: 'stop' } }];
}

/** 排队一个带延时 chunk 的慢回复，用来测取消。 */
function slowReply() {
  return [
    { type: 'text-delta', text: '{"module_title":"慢","slides":[', delayMs: 700 },
    { type: 'text-delta', text: ']}', delayMs: 700 },
    { type: 'finish', reason: { kind: 'stop' }, delayMs: 200 },
  ];
}

async function waitJob(moduleId, timeout) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < (timeout || 12000)) {
    last = await getJson('/dsh-book-slides/job?moduleId=' + encodeURIComponent(moduleId));
    if (last && ['ready', 'ready_degraded', 'failed', 'cancelled', 'interrupted'].includes(last.status)) return last;
    await sleep(80);
  }
  throw new Error('等作业超时，最后状态：' + JSON.stringify(last));
}

function onlyOk(data, label) {
  assert.equal(data.ok, true, (label || '') + ' 应该成功：' + JSON.stringify(data));
}

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test.beforeEach(() => {
  calls.length = 0;
  queue = [];
});

test('选择校验：空、超 5 章、空白章各有错误码', () => {
  assert.throws(() => generate.validateSelection(chapters, []), (error) => error.code === 'E_SELECTION_EMPTY');
  const many = Array.from({ length: 6 }, (_, index) => ({ n: index + 1, title: '第 ' + (index + 1) + ' 章', from: index + 1, to: index + 1, chars: 100 }));
  assert.throws(() => generate.validateSelection(many, many.map((chapter) => chapter.n)), (error) => error.code === 'E_SELECTION_TOO_LARGE');
  const blank = [{ n: 1, title: '空白', from: 1, to: 1, chars: 10 }];
  assert.throws(() => generate.validateSelection(blank, [1]), (error) => error.code === 'E_CHAPTER_EMPTY');
});

test('语音默认浏览器朗读：配置、试听参数、配置文件 0600', async () => {
  const data = await getJson('/dsh-book-slides/voice');
  onlyOk(data);
  assert.equal(data.voice.provider, 'browser');
  assert.equal(data.voice.rate, 1);
  assert.ok(Array.isArray(data.providers) && data.providers.some((item) => item.id === 'browser' && item.ready));
  assert.ok(data.providers.some((item) => item.id === 'doubao' && !item.ready), '豆包要明确标「未接入」');

  const probe = await postJson('/dsh-book-slides/voice/probe', { text: '试听一下。' });
  onlyOk(probe);
  assert.equal(probe.mode, 'browser');
  assert.equal(probe.text, '试听一下。');
  assert.ok(probe.audio_ms > 0);

  const saved = await postJson('/dsh-book-slides/voice', { provider: 'browser', rate: 1.2, voice: '' });
  onlyOk(saved);
  assert.equal(saved.voice.rate, 1.2);

  const file = path.join(ROOT, 'voice.json');
  assert.ok(fs.existsSync(file));
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(config.provider, 'browser');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'voice.json 必须是 0600');
  }
});

test('关掉语音后试听要提示去设置，不是抛栈', async () => {
  const off = await postJson('/dsh-book-slides/voice', { provider: 'off', rate: 1 });
  onlyOk(off);
  const probe = await postJson('/dsh-book-slides/voice/probe', { text: '试听一下。' });
  assert.equal(probe.ok, false);
  assert.equal(probe.code, 'E_TTS_UNCONFIGURED');
  assert.match(probe.hint, /浏览器朗读/);

  const back = await postJson('/dsh-book-slides/voice', { provider: 'browser', rate: 1 });
  onlyOk(back);
});

test('生成：四阶段走完进入 ready，6 页都带浏览器朗读时长与锚点', async () => {
  const chapter = chapterOf(1);
  const quote = quoteFrom(chapter);
  queue.push(replyFor(quote, chapter.from));

  const before = await getJson('/dsh-book-slides/book?bookId=' + bookId);
  assert.equal(before.modules.length, 0);

  const started = await postJson('/dsh-book-slides/generate', { bookId: bookId, chapters: [chapter.n] });
  onlyOk(started, 'POST /generate');
  assert.match(started.moduleId, /^[a-z0-9]{8,16}$/);
  assert.equal(started.jobId, started.moduleId);

  const job = await waitJob(started.moduleId);
  assert.equal(job.status, 'ready', JSON.stringify(job));
  assert.equal(job.slides, 6);
  assert.equal(calls.length, 1, '一批只需要一次模型调用');

  const mod = await getJson('/dsh-book-slides/module?moduleId=' + started.moduleId);
  onlyOk(mod);
  assert.equal(mod.module.title, '精讲：第 1 章');
  assert.equal(mod.module.status, 'ready');
  assert.equal(mod.module.voice.provider, 'browser');
  assert.equal(mod.slides.slides.length, 6);
  assert.equal(mod.slides.prompt_version, 'b2p-v1');
  assert.ok(mod.module.anchorHitRate >= 0.9, '摘抄来自原文，锚定率应该足够高');
  for (const slide of mod.slides.slides) {
    assert.equal(slide.audio_provider, 'browser');
    assert.ok(slide.audio_ms > 0);
    assert.equal(slide.audio_file, null);
    assert.equal(slide.anchor_status, 'anchored');
    assert.ok(slide.source_anchor && slide.source_anchor.page >= chapter.from);
  }

  const slidesFile = path.join(bookDir, 'modules', started.moduleId, 'slides.json');
  const moduleFile = path.join(bookDir, 'modules', started.moduleId, 'module.json');
  assert.ok(fs.existsSync(slidesFile));
  assert.ok(fs.existsSync(moduleFile));
  assert.equal(fs.readdirSync(path.join(bookDir, 'modules', started.moduleId, 'audio')).length, 0, '浏览器朗读不落音频文件');

  const after = await getJson('/dsh-book-slides/book?bookId=' + bookId);
  assert.equal(after.modules.length, 1);
  assert.equal(after.modules[0].id, started.moduleId);
  assert.equal(after.modules[0].status, 'ready');

  const shelf = await getJson('/dsh-book-slides/books');
  assert.equal(shelf.books.find((book) => book.id === bookId).modules, 1);

  const audio = await fetch(base + '/dsh-book-slides/audio?moduleId=' + started.moduleId + '&i=1');
  assert.equal(audio.status, 404, '没有音频文件时给 404，播放器降级为仅文字');

  // 记下来给后面的幂等/删除用例用
  globalThis.__firstModuleId = started.moduleId;
  globalThis.__quote1 = quote;
});

test('幂等：同组章节再点一次直接秒开，不新增模块、不再调模型', async () => {
  const chapter = chapterOf(1);
  const beforeCalls = calls.length;
  const beforeModules = (await getJson('/dsh-book-slides/book?bookId=' + bookId)).modules.length;

  const again = await postJson('/dsh-book-slides/generate', { bookId: bookId, chapters: [chapter.n] });
  onlyOk(again);
  assert.equal(again.cached, true);
  assert.equal(again.moduleId, globalThis.__firstModuleId);
  assert.equal(calls.length, beforeCalls, '命中缓存不该再花一次模型调用');
  assert.equal((await getJson('/dsh-book-slides/book?bookId=' + bookId)).modules.length, beforeModules);
});

test('坏 JSON：两次都不合法 → failed / E_LLM_JSON，不留 slides.json', async () => {
  const chapter = chapterOf(2);
  queue.push([{ type: 'text-delta', text: '抱歉，我写不出来。' }, { type: 'finish', reason: { kind: 'stop' } }]);
  queue.push([{ type: 'text-delta', text: '还是写不出来。' }, { type: 'finish', reason: { kind: 'stop' } }]);

  const started = await postJson('/dsh-book-slides/generate', { bookId: bookId, chapters: [chapter.n] });
  onlyOk(started);
  const job = await waitJob(started.moduleId);
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'E_LLM_JSON');
  assert.equal(calls.length, 2, '坏 JSON 要重试一次');
  assert.equal(fs.existsSync(path.join(bookDir, 'modules', started.moduleId, 'slides.json')), false, '失败不能留半截模块');
  const record = JSON.parse(fs.readFileSync(path.join(bookDir, 'modules', started.moduleId, 'module.json'), 'utf8'));
  assert.equal(record.status, 'failed');
  assert.equal(record.code, 'E_LLM_JSON');
});

test('结构修复：第一次字段不合规，第二次合法 → ready，且用户能看到修复原因', async () => {
  const chapter = chapterOf(3);
  const quote = quoteFrom(chapter);
  const bad = replyFor(quote, chapter.from);
  const parsed = JSON.parse(bad[0].text);
  parsed.slides[1].title = '这是一个明显超过二十四个字的标题用于触发结构校验失败';
  bad[0].text = JSON.stringify(parsed);
  queue.push(bad);
  queue.push(replyFor(quote, chapter.from));

  const started = await postJson('/dsh-book-slides/generate', { bookId: bookId, chapters: [chapter.n] });
  onlyOk(started);
  const job = await waitJob(started.moduleId);
  assert.equal(job.status, 'ready', JSON.stringify(job));
  assert.equal(calls.length, 2, '一次结构修复');
  assert.match(calls[1].user, /标题 \d+ 字，最多 24 字/, '修复提示词要说明具体哪里不合格');

  const mod = await getJson('/dsh-book-slides/module?moduleId=' + started.moduleId);
  assert.equal(mod.slides.slides[1].title.length <= 24, true);
});

test('锚点修复：摘抄全错时调一次修复，命中后状态回 anchored', async () => {
  const chapterA = chapterOf(2);
  const chapterB = chapterOf(3);
  const quote = quoteFrom(chapterA);
  const badQuote = '这段文字在书里根本不存在只是一句编出来的话';
  queue.push(replyFor(badQuote, chapterA.from));
  queue.push([
    {
      type: 'text-delta',
      text: JSON.stringify({
        fixes: Array.from({ length: 6 }, (_, index) => ({ slide_index: index + 1, source_quote: quote })),
      }),
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);

  const started = await postJson('/dsh-book-slides/generate', { bookId: bookId, chapters: [chapterA.n, chapterB.n] });
  onlyOk(started);
  const job = await waitJob(started.moduleId);
  assert.equal(job.status, 'ready', JSON.stringify(job));
  assert.equal(calls.length, 2, '锚定率低于 90% 要触发一次锚点修复');
  assert.match(calls[1].user, /source_quote/);

  const mod = await getJson('/dsh-book-slides/module?moduleId=' + started.moduleId);
  assert.equal(mod.module.anchorHitRate, 1);
  assert.ok(mod.slides.slides.every((slide) => slide.anchor_status === 'anchored'));
});

test('重试复用：失败前改完的批次不再重调模型（FR-5）', async () => {
  const chapterA = chapterOf(1);
  const chapterB = chapterOf(2);
  const chapterC = chapterOf(3);
  const quote = quoteFrom(chapterA);

  // 第一次：结构没问题，但页数只有 5 → 整套重写；重写回复坏 JSON → 失败
  queue.push(replyFor(quote, chapterA.from, 5));
  queue.push([{ type: 'text-delta', text: '这次也不给 JSON' }, { type: 'finish', reason: { kind: 'stop' } }]);
  const first = await postJson('/dsh-book-slides/generate', {
    bookId: bookId,
    chapters: [chapterA.n, chapterB.n, chapterC.n],
  });
  onlyOk(first);
  const failed = await waitJob(first.moduleId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'E_LLM_SCHEMA');
  assert.equal(calls.length, 2, '结构化 1 次 + 整套重写 1 次');
  const checkpointDir = path.join(bookDir, 'modules', first.moduleId, 'batches');
  assert.equal(fs.readdirSync(checkpointDir).length, 1, '改完的批要留检查点');

  // 第二次：同一缓存键，结构化直接读检查点；只补一次整套重写
  const before = calls.length;
  queue.push(replyFor(quote, chapterA.from, 6));
  const retried = await postJson('/dsh-book-slides/generate', {
    bookId: bookId,
    chapters: [chapterA.n, chapterB.n, chapterC.n],
  });
  onlyOk(retried);
  assert.equal(retried.moduleId, first.moduleId, '失败重试原地复用模块');
  const job = await waitJob(first.moduleId);
  assert.equal(job.status, 'ready', JSON.stringify(job));
  assert.equal(calls.length, before + 1, '只补一次修复调用，结构化的批不再重跑');
  assert.equal(fs.existsSync(checkpointDir), false, '成品落盘后检查点要清掉');
});

test('取消：慢模型下 10 秒内停，模块 cancelled 且没有 slides.json', async () => {
  const chapterA = chapterOf(1);
  const chapterB = chapterOf(2);
  queue.push(slowReply());

  const started = await postJson('/dsh-book-slides/generate', { bookId: bookId, chapters: [chapterA.n, chapterB.n] });
  onlyOk(started);
  await sleep(120);
  const cancelled = await postJson('/dsh-book-slides/cancel', { moduleId: started.moduleId });
  onlyOk(cancelled);
  assert.equal(cancelled.status, 'cancelling');

  const job = await waitJob(started.moduleId, 10000);
  assert.equal(job.status, 'cancelled', JSON.stringify(job));
  assert.equal(job.error.code, 'E_CANCELLED');
  assert.equal(fs.existsSync(path.join(bookDir, 'modules', started.moduleId, 'slides.json')), false);

  const mod = JSON.parse(fs.readFileSync(path.join(bookDir, 'modules', started.moduleId, 'module.json'), 'utf8'));
  assert.equal(mod.status, 'cancelled');
});

test('超时：模型不回话 → E_LLM_TIMEOUT，不留 slides.json（AC-15 的失败路径）', async () => {
  const chapterA = chapterOf(1);
  const chapterB = chapterOf(3);
  hang = true;
  try {
    const started = await postJson('/dsh-book-slides/generate', { bookId: bookId, chapters: [chapterA.n, chapterB.n] });
    onlyOk(started);
    const job = await waitJob(started.moduleId, 5000);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, 'E_LLM_TIMEOUT');
    assert.equal(fs.existsSync(path.join(bookDir, 'modules', started.moduleId, 'slides.json')), false);
    const record = JSON.parse(fs.readFileSync(path.join(bookDir, 'modules', started.moduleId, 'module.json'), 'utf8'));
    assert.equal(record.code, 'E_LLM_TIMEOUT');
  } finally {
    hang = false;
  }
});

test('中断恢复：磁盘上遗留的 structuring 模块读出来就是 interrupted', async () => {
  const moduleId = 'interrupt001';
  const moduleDir = path.join(bookDir, 'modules', moduleId);
  fs.mkdirSync(path.join(moduleDir, 'audio'), { recursive: true });
  fs.writeFileSync(
    path.join(moduleDir, 'module.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: moduleId,
      bookId: bookId,
      title: '精讲：第 1 章',
      chapters: [1],
      status: 'structuring',
      stage: 'structuring',
      message: '正在改写',
      cacheKey: 'deadbeef',
      model: 'fake-model',
      promptVersion: 'b2p-v1',
      slides: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );

  const mod = await getJson('/dsh-book-slides/module?moduleId=' + moduleId);
  onlyOk(mod);
  assert.equal(mod.module.status, 'interrupted');
  assert.equal(mod.module.code, 'E_INTERRUPTED');
  const onDisk = JSON.parse(fs.readFileSync(path.join(moduleDir, 'module.json'), 'utf8'));
  assert.equal(onDisk.status, 'interrupted', '读一次就要写回，别让它永远转圈');
});

test('模块删除：只删模块，书还在', async () => {
  const moduleId = globalThis.__firstModuleId;
  const res = await fetch(base + '/dsh-book-slides/module?moduleId=' + moduleId, { method: 'DELETE' });
  const data = await res.json();
  onlyOk(data);
  const missing = await getJson('/dsh-book-slides/module?moduleId=' + moduleId);
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'E_NOT_FOUND');
  const book = await getJson('/dsh-book-slides/book?bookId=' + bookId);
  onlyOk(book);
});
