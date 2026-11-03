/**
 * 目录抽取的「模型这一层」接口测试 —— 假模型，真路由。
 *
 *   node test/toc-llm.test.mjs
 *
 * 盯的是两个真实故障：
 *   1. 思考模型把 maxTokens 全花在思考上，正文为空 → 不能只说「没有 JSON」，
 *      要能识别、加预算重试、把原因写给面板（《导演创作完全手册》实测）。
 *   2. 目录里的「第X部分 / 前言」不能单独成为章节（否则 47 章切出 58 段）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { makePdf } from './fixture.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-llm-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const plugin = await import('../index.js');

/** 假模型：按队列吐出 chunk，并记录每次 prepareCall 的配置。 */
const calls = [];
let queue = [];

const fakeLlm = {
  async prepareCall(config) {
    calls.push(config);
    return {
      config: {},
      async *stream() {
        const chunks = queue.shift() || [];
        for (const chunk of chunks) yield chunk;
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

async function post(pathname, body) {
  return fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((res) => res.json());
}

const imported = await fetch(base + '/dsh-book-slides/import', {
  method: 'POST',
  headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('样书.pdf') },
  body: makePdf([
    ['Contents', 'Chapter 1 Start 1', 'Chapter 2 Turn 2', 'Chapter 3 End 3'],
    ['Sample Book', 'Chapter 1 Start', 'alpha '.repeat(30)],
    ['Chapter 2 Turn', 'beta '.repeat(30)],
    ['Chapter 3 End', 'gamma '.repeat(30)],
  ]),
}).then((res) => res.json());
const bookId = imported.bookId;

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test.beforeEach(() => {
  calls.length = 0;
  queue = [];
});

const ENTRIES = [
  { title: 'Chapter 1 Start', printed_page: 1, level: 'chapter', fixed_char: false },
  { title: 'Chapter 2 Turn', printed_page: 2, level: 'chapter', fixed_char: false },
  { title: 'Chapter 3 End', printed_page: 3, level: 'chapter', fixed_char: false },
];

test('思考吃光预算：识别成 max_tokens，并把重试预算翻倍', async () => {
  // 两次都只思考、不出正文：第一次 4k 的教训，现在第一次 16k、重试 32k
  for (let i = 0; i < 2; i += 1) {
    queue.push([
      { type: 'reasoning-delta', text: '让我先推演一下双栏目录……' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]);
  }
  const data = await post('/dsh-book-slides/toc/parse', { bookId: bookId, from: 1, to: 1, force: true });
  assert.equal(data.fallback, true);
  assert.match(data.message, /思考/, '用户要看到「token 被思考吃光」，而不是「没有 JSON」');
  assert.match(data.message, /32000/);
  assert.deepEqual(
    calls.map((c) => c.maxTokens),
    [16000, 32000],
    '第一次 16k，重试翻倍到 32k',
  );
});

test('正常 JSON：只留内容章节，分卷/前言不单独成章', async () => {
  queue.push([
    {
      type: 'text-delta',
      text: JSON.stringify({
        entries: [
          { title: '第一部分 开头', printed_page: 1, level: 'part', fixed_char: false },
          { title: '前言', printed_page: 1, level: 'front', fixed_char: false },
          ...ENTRIES,
        ],
      }),
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  const data = await post('/dsh-book-slides/toc/parse', { bookId: bookId, from: 1, to: 1, force: true });
  assert.equal(data.fallback, undefined, JSON.stringify(data));
  assert.equal(data.chapterCount, 3, '分卷/前言不能把 3 章变成 5 章');
  assert.ok(!data.chapters.filter((c) => !c.front).some((c) => /部分|前言/.test(c.title)));
  assert.equal(calls[0].maxTokens, 16000);
});

test('模型只回一段话：错误里带原文开头，预算不翻倍', async () => {
  const prose = '抱歉，这段目录有太多 OCR 错误，我无法可靠地配对页码。';
  for (let i = 0; i < 2; i += 1) {
    queue.push([
      { type: 'text-delta', text: prose },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
  }
  const data = await post('/dsh-book-slides/toc/parse', { bookId: bookId, from: 1, to: 1, force: true });
  assert.equal(data.fallback, true);
  assert.match(data.message, /抱歉，这段目录/);
  assert.deepEqual(
    calls.map((c) => c.maxTokens),
    [16000, 16000],
    '不是 token 问题就不该无脑加预算',
  );
});
