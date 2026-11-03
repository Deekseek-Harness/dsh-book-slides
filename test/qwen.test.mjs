/**
 * Qwen3-TTS 端到端测试：真路由 + 假模型 + 假千问服务。
 *
 *   node test/qwen.test.mjs
 *
 * 覆盖：Key 掩码、试听、逐页 WAV 落盘、缺 Key 降级、部分失败降级、音频缓存。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { makePdf } from './fixture.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-qwen-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------ 假千问服务 ------------------------------ */

function fakeWav(seconds) {
  const sampleRate = 24000;
  const dataSize = Math.round(sampleRate * 2 * (seconds || 0.5));
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

const WAV = fakeWav(0.5);
const qwen = { calls: 0, failText: '', failAuth: false };
let qwenBase = '';

function readRequest(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const qwenServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/tts' && req.method === 'POST') {
    const body = JSON.parse((await readRequest(req)).toString('utf8'));
    qwen.calls += 1;
    const auth = String(req.headers.authorization || '');
    if (qwen.failAuth || auth.includes('sk-bad')) {
      res.statusCode = 401;
      res.end('{"error":"bad key"}');
      return;
    }
    if (qwen.failText && String(body.input.text).includes(qwen.failText)) {
      res.statusCode = 500;
      res.end('{"error":"synthetic failure"}');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ output: { audio: { url: qwenBase + '/audio.wav' } } }));
    return;
  }
  if (url.pathname === '/audio.wav') {
    res.setHeader('content-type', 'audio/wav');
    res.setHeader('content-length', String(WAV.length));
    res.end(WAV);
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});
await new Promise((resolve) => qwenServer.listen(0, '127.0.0.1', resolve));
qwenBase = 'http://127.0.0.1:' + qwenServer.address().port;
process.env.DSH_BOOK_SLIDES_QWEN_ENDPOINT = qwenBase + '/tts';

/* ------------------------------ 假模型与插件 ------------------------------ */

const llmCalls = [];
let queue = [];

const fakeLlm = {
  async prepareCall() {
    return {
      config: {},
      async *stream() {
        llmCalls.push(1);
        const chunks = queue.shift();
        if (!chunks) throw new Error('假模型队列空了');
        for (const chunk of chunks) yield chunk;
      },
    };
  },
};

const plugin = await import('../index.js');

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
  return fetch(base + pathname).then((res) => res.json());
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
  headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('Qwen 样书.pdf') },
  body: makePdf([
    ['Sample Book', 'Chapter 1 Start', 'alpha '.repeat(30)],
    ['Chapter 2 Turn', 'beta '.repeat(30)],
    ['Chapter 3 End', 'gamma '.repeat(30)],
  ]),
}).then((res) => res.json());
const bookId = imported.bookId;
const bookDir = path.join(ROOT, 'books', bookId);
const pages = JSON.parse(fs.readFileSync(path.join(bookDir, 'pages.json'), 'utf8'));
const detail = await getJson('/dsh-book-slides/book?bookId=' + bookId);
const chapters = detail.chapters.filter((chapter) => !chapter.front);
assert.ok(chapters.length >= 3);

function chapterOf(n) {
  return chapters.find((chapter) => chapter.n === n);
}

function quoteFrom(chapter) {
  const lines = [];
  for (const page of pages) {
    if (page.page < chapter.from || page.page > chapter.to) continue;
    for (const line of String(page.text || '').split('\n')) lines.push(line.trim());
  }
  const line = lines.find((text) => text.length >= 20 && !/^chapter\s/i.test(text));
  return (line || lines.join('')).slice(0, 80);
}

function replyFor(quote, page, tag) {
  const slides = Array.from({ length: 6 }, (_, index) => {
    const n = index + 1;
    const layout = n === 1 ? 'cover' : n % 3 === 0 ? 'quote' : 'content_text';
    return {
      slide_index: n,
      layout: layout,
      title: '第 ' + n + ' 页',
      subtitle: n === 1 ? '第 1 章' : '',
      bullet_points: layout === 'content_text' ? ['要点一', '要点二'] : [],
      quote_text: layout === 'quote' ? '一句原文引文。' : null,
      quote_source: layout === 'quote' ? '测试书' : null,
      image_prompt: '书桌上摊开的书，暖色晨光',
      audio_script:
        (tag && n === 3 ? tag + ' ' : '') +
        '大家好，这是第 ' + n + ' 页的讲解稿，内容长度足够通过校验，也足够让语音合成服务生成一小段音频。',
      source_quote: quote,
      source_pages: { from: page, to: page },
    };
  });
  return [
    { type: 'text-delta', text: JSON.stringify({ module_title: 'Qwen 测试', slides: slides }) },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

async function waitJob(moduleId, timeout) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < (timeout || 15000)) {
    last = await getJson('/dsh-book-slides/job?moduleId=' + encodeURIComponent(moduleId));
    if (['ready', 'ready_degraded', 'failed', 'cancelled', 'interrupted'].includes(last.status)) return last;
    await sleep(80);
  }
  throw new Error('等作业超时：' + JSON.stringify(last));
}

test.after(() => {
  server.close();
  qwenServer.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test.beforeEach(() => {
  queue = [];
  llmCalls.length = 0;
});

test('Key 配置：保存后只回尾号，voice.json 含 key 但接口不回显', async () => {
  const saved = await postJson('/dsh-book-slides/voice', {
    provider: 'qwen3-tts',
    model: 'qwen3-tts-flash',
    voice: 'Cherry',
    apiKey: 'sk-qwen-secret-1234',
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.voice.provider, 'qwen3-tts');
  assert.equal(saved.voice.hasKey, true);
  assert.equal(saved.voice.apiKeyMask, '••••1234');
  assert.equal(saved.voice.apiKey, undefined);
  assert.doesNotMatch(JSON.stringify(saved), /sk-qwen-secret-1234/);

  const fetched = await getJson('/dsh-book-slides/voice');
  assert.equal(fetched.voice.hasKey, true);
  assert.equal(fetched.voice.apiKeyMask, '••••1234');
  assert.doesNotMatch(JSON.stringify(fetched), /sk-qwen-secret-1234/);
  assert.ok(fetched.qwenVoices.some((voice) => voice.id === 'Cherry'));
  assert.ok(fetched.models.some((model) => model.id === 'qwen3-tts-flash'));

  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'voice.json'), 'utf8'));
  assert.equal(config.apiKey, 'sk-qwen-secret-1234');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(ROOT, 'voice.json')).mode & 0o777, 0o600);
  }
});

test('试听：Qwen 返回 audio/wav 字节', async () => {
  const response = await fetch(base + '/dsh-book-slides/voice/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '你好，试听。' }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /audio\/wav/);
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(body.toString('ascii', 0, 4), 'RIFF');
});

test('生成：6 页 Qwen WAV 落盘，播放器接口 content-type 正确', async () => {
  const chapter = chapterOf(1);
  queue.push(replyFor(quoteFrom(chapter), chapter.from, ''));
  qwen.calls = 0;
  const started = await postJson('/dsh-book-slides/generate', { bookId: bookId, chapters: [chapter.n] });
  assert.equal(started.ok, true);
  const job = await waitJob(started.moduleId);
  assert.equal(job.status, 'ready', JSON.stringify(job));
  assert.equal(qwen.calls, 6, '6 页应有 6 次合成请求');

  const mod = await getJson('/dsh-book-slides/module?moduleId=' + started.moduleId);
  assert.equal(mod.module.voice.provider, 'qwen3-tts');
  assert.equal(mod.slides.slides.length, 6);
  for (const slide of mod.slides.slides) {
    assert.equal(slide.audio_provider, 'qwen3-tts');
    assert.ok(slide.audio_file && slide.audio_file.endsWith('.wav'));
    assert.equal(slide.audio_ms, 500);
    assert.ok(fs.existsSync(path.join(bookDir, 'modules', started.moduleId, slide.audio_file)));
  }
  const audio = await fetch(base + '/dsh-book-slides/audio?moduleId=' + started.moduleId + '&i=1');
  assert.equal(audio.status, 200);
  assert.match(audio.headers.get('content-type'), /audio\/wav/);
  assert.equal(Buffer.from(await audio.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');
  globalThis.__qwenModuleId = started.moduleId;
  globalThis.__qwenCallsAfterFirst = qwen.calls;
});

test('缓存：显式重生成命中 audio-cache，不再请求 Qwen', async () => {
  const chapter = chapterOf(1);
  queue.push(replyFor(quoteFrom(chapter), chapter.from, ''));
  const callsBefore = qwen.calls;
  const started = await postJson('/dsh-book-slides/generate', {
    bookId: bookId,
    chapters: [chapter.n],
    force: true,
  });
  assert.equal(started.ok, true);
  const job = await waitJob(started.moduleId);
  assert.equal(job.status, 'ready', JSON.stringify(job));
  assert.equal(qwen.calls, callsBefore, '同文本+音色应全部命中缓存');
  const dir = path.join(bookDir, 'modules', started.moduleId, 'audio');
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.wav')).length, 6);
});

test('缺 Key：生成降级为只出文字，且不请求 Qwen', async () => {
  const cleared = await postJson('/dsh-book-slides/voice', { clearApiKey: true });
  assert.equal(cleared.voice.hasKey, false);
  const chapter = chapterOf(2);
  queue.push(replyFor(quoteFrom(chapter), chapter.from, ''));
  const callsBefore = qwen.calls;
  const started = await postJson('/dsh-book-slides/generate', { bookId: bookId, chapters: [chapter.n] });
  const job = await waitJob(started.moduleId);
  assert.equal(job.status, 'ready_degraded');
  assert.equal(job.error.code, 'E_TTS_UNCONFIGURED');
  assert.equal(qwen.calls, callsBefore);
  const mod = await getJson('/dsh-book-slides/module?moduleId=' + started.moduleId);
  assert.equal(mod.slides.slides.every((slide) => slide.audio_provider === 'none'), true);
});

test('部分失败：失败页无音频，其余页有 WAV，模块降级', async () => {
  const restored = await postJson('/dsh-book-slides/voice', { apiKey: 'sk-qwen-secret-1234' });
  assert.equal(restored.voice.hasKey, true);
  const chapter = chapterOf(3);
  queue.push(replyFor(quoteFrom(chapter), chapter.from, 'FAIL'));
  qwen.failText = 'FAIL';
  try {
    const started = await postJson('/dsh-book-slides/generate', { bookId: bookId, chapters: [chapter.n] });
    const job = await waitJob(started.moduleId);
    assert.equal(job.status, 'ready_degraded', JSON.stringify(job));
    assert.equal(job.error.code, 'E_TTS_FAIL');
    const mod = await getJson('/dsh-book-slides/module?moduleId=' + started.moduleId);
    const failed = mod.slides.slides.find((slide) => slide.slide_index === 3);
    assert.equal(failed.audio_provider, 'none');
    assert.equal(failed.audio_file, null);
    assert.equal(mod.slides.slides.filter((slide) => slide.audio_provider === 'qwen3-tts').length, 5);
    assert.equal(fs.readdirSync(path.join(bookDir, 'modules', started.moduleId, 'audio')).filter((name) => name.endsWith('.wav')).length, 5);
  } finally {
    qwen.failText = '';
  }
});

test('错误 Key：试听返回 E_TTS_AUTH，不泄露 key', async () => {
  await postJson('/dsh-book-slides/voice', { apiKey: 'sk-bad' });
  const probe = await postJson('/dsh-book-slides/voice/probe', { text: '试听鉴权。' });
  assert.equal(probe.ok, false);
  assert.equal(probe.code, 'E_TTS_AUTH');
  assert.doesNotMatch(JSON.stringify(probe), /sk-bad/);
  await postJson('/dsh-book-slides/voice', { apiKey: 'sk-qwen-secret-1234' });
});
