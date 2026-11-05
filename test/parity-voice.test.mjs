/**
 * 2.0 M4 语音对等（FR-23 / AC-126）：文本生成不产 WAV、Key 只回尾号、独立配音、
 * 缺 Key 降级、单页失败、缓存命中、配音只改音频字段。
 *
 * 假模型走真路由跑完文本三阶段；假 Qwen 端点跑真 HTTP 配音。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-voice-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, writeChapters } = await import('../v2/books.js');
const { savePart } = await import('../v2/parts.js');
const { createSeries, findSeries } = await import('../v2/series.js');
const { routeM1 } = await import('../v2/api.js');

const SEAM = '上一讲把函数当机器；这一讲只问靠近某点时输出去哪。';
const ctl = { delay: 0, failLecture: 0 };

function makeBook(tag) {
  const rawPages = [
    { page: 1, text: '第1章 甲\n' + '甲'.repeat(11000) },
    { page: 2, text: '第2章 乙\n' + '乙'.repeat(11000) },
  ];
  const book = createBook({
    buffer: Buffer.from('m4-parity-voice-' + tag + '-' + Date.now()),
    fileName: tag + '.pdf',
    title: '语音对等 ' + tag,
    author: '',
    pages: 2,
    rawPages,
  });
  writeChapters(book.id, [
    { n: 1, title: '第1章 甲', from: 1, to: 1, chars: 11000, front: false },
    { n: 2, title: '第2章 乙', from: 2, to: 2, chars: 11000, front: false },
  ], 'manual');
  const part = savePart({ bookId: book.id, chapters: [1, 2], title: '函数' });
  const series = createSeries({
    bookId: book.id,
    partId: part.id,
    title: '函数',
    plan: {
      throughline: '把函数当机器，再看它靠近某点时输出去哪。',
      lectures: [
        { n: 1, chapters: [1], title: '第 1 讲 · 机器', goal: 'g1', in: '', out: '', pages: 6, chars: 11000 },
        { n: 2, chapters: [2], title: '第 2 讲 · 靠近', goal: 'g2', in: '机器', out: '', pages: 6, chars: 11000 },
      ],
      seams: [{ from: 1, to: 2, concept: '极限', sentence: SEAM }],
      terms: [{ name: '定义域', forbid: ['定义区间'] }],
      cut_notes: [],
      source: 'model',
      stitched: true,
      totalChars: 22000,
      totalPages: 12,
      estMinutes: 12,
    },
  });
  return { book, series, found: findSeries(series.id) };
}

function slideJson(lecture, i, chapter) {
  const mark = chapter === 1 ? '甲' : '乙';
  return {
    layout: i === 0 ? 'cover' : 'content_text',
    title: i === 0 ? '第 ' + lecture + ' 讲' : mark + '讲要点 ' + i,
    subtitle: i === 0 ? '函数与极限' : '',
    bullet_points: i === 0 ? [] : [mark.repeat(20), mark.repeat(12) + '收束'],
    quote_text: null,
    quote_source: null,
    image_prompt: mark + '机器在纸上画出曲线',
    audio_script: mark.repeat(60),
    source_quote: mark.repeat(60),
    source_pages: { from: chapter, to: chapter },
  };
}

const ctx = {
  get(name) {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
    if (name !== 'llm') return null;
    return {
      async prepareCall() {
        return {
          config: {},
          async *stream(config) {
            const user = config.messages[0].content[0].text;
            const match = /【本讲】第 (\d+)\//.exec(user);
            const lectureNo = match ? Number(match[1]) : 1;
            if (ctl.failLecture === lectureNo) throw new Error('fake lecture failure');
            if (ctl.delay) await new Promise((resolve) => setTimeout(resolve, ctl.delay));
            const chapter = lectureNo === 1 ? 1 : 2;
            yield {
              type: 'text-delta',
              text: JSON.stringify({
                module_title: '',
                slides: Array.from({ length: 6 }, (_, index) => slideJson(lectureNo, index, chapter)),
              }),
            };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      },
    };
  },
};

/* 假 Qwen：POST 返回音频 URL，GET 返回 WAV；可指定某页 500。 */
const WAV = (() => {
  const size = 3200;
  const buffer = Buffer.alloc(44 + size);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + size, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(size, 40);
  return buffer;
})();

const qwen = { requests: [], failText: '', base: '' };
const fakeQwen = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/qwen') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const text = String((body.input && body.input.text) || '');
    qwen.requests.push(text);
    if (qwen.failText && text.includes(qwen.failText)) {
      res.statusCode = 500;
      res.end('fake failure');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ output: { audio: { url: qwen.base + '/audio/' + qwen.requests.length + '.wav' } } }));
    return;
  }
  if (req.url.startsWith('/audio/')) {
    res.setHeader('content-type', 'audio/wav');
    res.end(WAV);
    return;
  }
  res.statusCode = 404;
  res.end('no route');
});
await new Promise((resolve) => fakeQwen.listen(0, '127.0.0.1', resolve));
qwen.base = 'http://127.0.0.1:' + fakeQwen.address().port;
process.env.DSH_BOOK_SLIDES_QWEN_ENDPOINT = qwen.base + '/qwen';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const handled = await routeM1(req, res, url, { ctx });
  if (!handled) {
    res.statusCode = 404;
    res.end('no route');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port;

async function json(url, options) {
  const res = await fetch(baseUrl + url, options);
  return JSON.parse(await res.text());
}

function post(url, body) {
  return json(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

async function waitTypeJob(seriesId, predicate, timeout = 8000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await json('/dsh-book-slides/series/job?seriesId=' + encodeURIComponent(seriesId));
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待文本作业超时：' + JSON.stringify(last));
}

async function waitVoice(jobId, predicate, timeout = 8000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await json('/dsh-book-slides/revoice/job?jobId=' + encodeURIComponent(jobId));
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待配音作业超时：' + JSON.stringify(last));
}

function textOf(doc) {
  return (doc.slides || []).map((slide) => [slide.title, slide.audio_script, slide.source_quote, slide.bullet_points]);
}

test('FR-23：供应商/模型/音色列表与试听（浏览器参数、Qwen WAV）', async () => {
  const config = await json('/dsh-book-slides/voice');
  assert.deepEqual(config.providers.map((item) => item.id), ['qwen3-tts', 'browser', 'off']);
  assert.deepEqual(config.models.map((item) => item.id), ['qwen3-tts-flash']);
  assert.equal(config.qwenVoices.length, 48);
  assert.equal(new Set(config.qwenVoices.map((item) => item.id)).size, 48);

  await post('/dsh-book-slides/voice', { provider: 'browser', voice: '', rate: 1.2 });
  const browserProbe = await post('/dsh-book-slides/voice/probe', { text: '试听一下。' });
  assert.equal(browserProbe.ok, true);
  assert.equal(browserProbe.mode, 'browser');
  assert.equal(browserProbe.rate, 1.2);
  assert.ok(String(browserProbe.text || '').length > 0);

  await post('/dsh-book-slides/voice', { provider: 'qwen3-tts', model: 'qwen3-tts-flash', voice: 'Cherry', apiKey: 'sk-voice-5678' });
  const qwenProbe = await fetch(baseUrl + '/dsh-book-slides/voice/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '试听一下。' }),
  });
  assert.equal(qwenProbe.status, 200);
  assert.equal(qwenProbe.headers.get('content-type'), 'audio/wav');
  assert.ok((await qwenProbe.arrayBuffer()).byteLength > 44);

  await post('/dsh-book-slides/voice', { provider: 'off' });
  const offProbe = await post('/dsh-book-slides/voice/probe', { text: '试听一下。' });
  assert.equal(offProbe.ok, false);
  assert.equal(offProbe.code, 'E_TTS_UNCONFIGURED');
});

test('AC-126：文本生成 6 页不产生 WAV，audio_file=null / provider=none；配音必须显式 /revoice', async () => {
  ctl.delay = 0;
  ctl.failLecture = 0;
  qwen.requests = [];
  await post('/dsh-book-slides/voice', { provider: 'qwen3-tts', model: 'qwen3-tts-flash', voice: 'Cherry', apiKey: 'sk-voice-5678' });
  const { series, found } = makeBook('generate');
  const started = await post('/dsh-book-slides/series/start', { seriesId: series.id });
  assert.equal(started.ok, true);
  await waitTypeJob(series.id, (job) => job.status === 'ready');
  assert.equal(qwen.requests.length, 0, '文本生成不得调用 TTS');

  for (const n of [1, 2]) {
    const lecture = await json('/dsh-book-slides/lecture?seriesId=' + series.id + '&n=' + n);
    assert.equal(lecture.slides.slides.length, 6);
    for (const slide of lecture.slides.slides) {
      assert.equal(slide.audio_file, null);
      assert.equal(slide.audio_provider, 'none');
    }
    assert.equal(fs.existsSync(path.join(found.dir, 'lectures', String(n), 'audio')), false);
  }
  const seriesOut = await json('/dsh-book-slides/series?seriesId=' + series.id);
  assert.equal(seriesOut.series.voice_status || 'none', 'none');
});

test('AC-126：保存 Key 后重开只显示尾号，响应与 voice.json 都不含完整 Key 之外的泄露', async () => {
  const saved = await post('/dsh-book-slides/voice', {
    provider: 'qwen3-tts',
    model: 'qwen3-tts-flash',
    voice: 'Cherry',
    apiKey: 'sk-voice-5678',
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.voice.hasKey, true);
  assert.equal(saved.voice.apiKeyMask, '••••5678');
  assert.equal(JSON.stringify(saved).includes('sk-voice-5678'), false);
  const again = await json('/dsh-book-slides/voice');
  assert.equal(again.voice.apiKeyMask, '••••5678');
  assert.equal(JSON.stringify(again).includes('sk-voice-5678'), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'voice.json'), 'utf8')).apiKey, 'sk-voice-5678');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(ROOT, 'voice.json')).mode & 0o777, 0o600);
  }
});

test('AC-126：POST /revoice 后 001–006.wav 存在且可播，文字字段一个字不变', async () => {
  qwen.requests = [];
  const { series, found } = makeBook('revoice');
  await post('/dsh-book-slides/series/start', { seriesId: series.id });
  await waitTypeJob(series.id, (job) => job.status === 'ready');
  const before = JSON.parse(fs.readFileSync(path.join(found.dir, 'lectures', '1', 'slides.json'), 'utf8'));

  const out = await post('/dsh-book-slides/revoice', { seriesId: series.id });
  assert.equal(out.ok, true);
  assert.ok(out.jobId);
  const job = await waitVoice(out.jobId, (item) => item.status === 'done');
  assert.equal(job.error, null);

  for (const n of [1, 2]) {
    for (let i = 1; i <= 6; i += 1) {
      const file = path.join(found.dir, 'lectures', String(n), 'audio', String(i).padStart(3, '0') + '.wav');
      assert.ok(fs.existsSync(file), file);
    }
  }
  const after = JSON.parse(fs.readFileSync(path.join(found.dir, 'lectures', '1', 'slides.json'), 'utf8'));
  assert.deepEqual(textOf(after), textOf(before));
  assert.equal(after.slides[0].audio_file, 'audio/001.wav');
  assert.equal(after.voice_status, 'ready');
  const seriesOut = await json('/dsh-book-slides/series?seriesId=' + series.id);
  assert.equal(seriesOut.series.voice_status, 'ready');

  const audio = await fetch(baseUrl + '/dsh-book-slides/audio?seriesId=' + series.id + '&lecture=1&i=1');
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
});

test('AC-126：无 Key 时 voice_status=none 且 E_TTS_UNCONFIGURED；不自动回退浏览器', async () => {
  await post('/dsh-book-slides/voice', { provider: 'qwen3-tts', apiKey: '', clearApiKey: true });
  const { series, found } = makeBook('nokey');
  await post('/dsh-book-slides/series/start', { seriesId: series.id });
  await waitTypeJob(series.id, (job) => job.status === 'ready');
  const out = await post('/dsh-book-slides/revoice', { seriesId: series.id });
  const job = await waitVoice(out.jobId, (item) => item.status === 'failed');
  assert.equal(job.error.code, 'E_TTS_UNCONFIGURED');
  const seriesOut = await json('/dsh-book-slides/series?seriesId=' + series.id);
  assert.equal(seriesOut.series.voice_status, 'none');
  const lecture = await json('/dsh-book-slides/lecture?seriesId=' + series.id + '&n=1');
  for (const slide of lecture.slides.slides) {
    assert.equal(slide.audio_file, null);
    assert.notEqual(slide.audio_provider, 'browser', '缺 Key 时不得回退浏览器');
  }
  assert.equal(fs.existsSync(path.join(found.dir, 'lectures', '1', 'audio')), false);
});

test('AC-126：单页 500 时该页 audio_provider=none，其余页正常；同文本二次配音命中缓存', async () => {
  await post('/dsh-book-slides/voice', { provider: 'qwen3-tts', model: 'qwen3-tts-flash', voice: 'Cherry', apiKey: 'sk-voice-5678' });
  qwen.requests = [];
  qwen.failText = '';
  const { series, found } = makeBook('cache');
  await post('/dsh-book-slides/series/start', { seriesId: series.id });
  await waitTypeJob(series.id, (job) => job.status === 'ready');

  // 第二讲第 3 页单独换成会失败的稿子
  const file = path.join(found.dir, 'lectures', '2', 'slides.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.slides[2].audio_script = 'FAILME' + doc.slides[2].audio_script;
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  qwen.failText = 'FAILME';

  const first = await post('/dsh-book-slides/revoice', { seriesId: series.id });
  const firstJob = await waitVoice(first.jobId, (item) => item.status === 'done');
  assert.ok(firstJob.error && firstJob.error.failures.length >= 1);
  const lecture2 = await json('/dsh-book-slides/lecture?seriesId=' + series.id + '&n=2');
  assert.equal(lecture2.slides.slides[2].audio_file, null);
  assert.equal(lecture2.slides.slides[2].audio_provider, 'none');
  assert.ok(lecture2.slides.slides[0].audio_file);
  assert.equal(lecture2.lecture.voice_status, 'partial');

  const seriesOut = await json('/dsh-book-slides/series?seriesId=' + series.id);
  assert.equal(seriesOut.series.voice_status, 'partial');

  qwen.failText = '';
  const before = qwen.requests.length;
  const second = await post('/dsh-book-slides/revoice', { seriesId: series.id });
  const secondJob = await waitVoice(second.jobId, (item) => item.status === 'done');
  assert.equal(secondJob.error, null);
  // 只补「上次失败、没进缓存」的那一页；其余页命中缓存
  const extra = qwen.requests.length - before;
  assert.ok(extra <= 1, '同文本同音色应命中缓存，实际多请求 ' + extra + ' 次');
  if (extra === 1) assert.ok(qwen.requests[before].includes('FAILME'));
  const seriesAfter = await json('/dsh-book-slides/series?seriesId=' + series.id);
  assert.equal(seriesAfter.series.voice_status, 'ready');
});

test('AC-126：配音只改音频字段，不改 slides.json 的文字与锚点', async () => {
  const { series, found } = makeBook('fields');
  await post('/dsh-book-slides/series/start', { seriesId: series.id });
  await waitTypeJob(series.id, (job) => job.status === 'ready');
  const before = JSON.parse(fs.readFileSync(path.join(found.dir, 'lectures', '1', 'slides.json'), 'utf8'));
  const beforeKeys = Object.keys(before.slides[0]).sort();
  const out = await post('/dsh-book-slides/revoice', { seriesId: series.id });
  await waitVoice(out.jobId, (item) => item.status === 'done');
  const after = JSON.parse(fs.readFileSync(path.join(found.dir, 'lectures', '1', 'slides.json'), 'utf8'));
  assert.deepEqual(textOf(after), textOf(before));
  assert.deepEqual(Object.keys(after.slides[0]).sort(), beforeKeys, '不得新增/删除页字段');
  for (let i = 0; i < before.slides.length; i += 1) {
    const a = before.slides[i];
    const b = after.slides[i];
    for (const key of ['layout', 'title', 'subtitle', 'bullet_points', 'quote_text', 'quote_source', 'image_prompt', 'audio_script', 'source_quote', 'source_pages', 'source_anchor']) {
      assert.deepEqual(b[key], a[key], '字段 ' + key + ' 不应变化');
    }
  }
});

test.after(() => {
  server.close();
  fakeQwen.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
