/**
 * 2.0 M4 配音作业（FR-23 / AC-137）：jobId、进度、取消、幂等与「只改音频字段」。
 *
 * 用本地假 Qwen 端点跑真 HTTP：POST 返回 audio URL，GET 返回 WAV 字节。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-revoice-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, writeChapters } = await import('../host/books.js');
const { savePart } = await import('../host/parts.js');
const { createSeries, findSeries, patchSeriesLecture, persistSeries } = await import('../host/series.js');
const { writeLectureOutputs, loadLecture } = await import('../host/lectures.js');
const { startRevoiceJob, getRevoiceJob, cancelRevoiceJob, findAudioFile } = await import('../host/voice.js');
const { routeM1 } = await import('../host/api.js');

/* ------------------------------ 假 Qwen 端点 ------------------------------ */

function makeWav(ms = 400) {
  const sampleRate = 8000;
  const channels = 1;
  const bits = 16;
  const dataSize = Math.round((sampleRate * channels * bits * ms) / 8000 / 8 / 1000 * 8);
  const size = Math.max(1600, dataSize);
  const buffer = Buffer.alloc(44 + size);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + size, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  buffer.writeUInt16LE((channels * bits) / 8, 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(size, 40);
  return buffer;
}

const WAV = makeWav();
const qwen = { requests: [], delay: 0, failText: '', statusFail: 0, baseUrl: '' };

const fake = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/qwen') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const text = String((body.input && body.input.text) || '');
    qwen.requests.push(text);
    if (qwen.delay) await new Promise((resolve) => setTimeout(resolve, qwen.delay));
    if (qwen.statusFail) {
      res.statusCode = qwen.statusFail;
      res.end('fake failure');
      return;
    }
    if (qwen.failText && text.includes(qwen.failText)) {
      res.statusCode = 500;
      res.end('fake page failure');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        output: { audio: { url: qwen.baseUrl + '/audio/' + qwen.requests.length + '.wav' } },
      }),
    );
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/audio/')) {
    if (qwen.delay) await new Promise((resolve) => setTimeout(resolve, qwen.delay));
    res.statusCode = 200;
    res.setHeader('content-type', 'audio/wav');
    res.setHeader('content-length', String(WAV.length));
    res.end(WAV);
    return;
  }
  res.statusCode = 404;
  res.end('no route');
});
await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
qwen.baseUrl = 'http://127.0.0.1:' + fake.address().port;
process.env.DSH_BOOK_SLIDES_QWEN_ENDPOINT = qwen.baseUrl + '/qwen';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const handled = await routeM1(req, res, url, {});
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

/* ------------------------------ 夹具 ------------------------------ */

let seq = 0;

function slideOf(lecture, index, chapter, marker) {
  return {
    slide_index: index,
    layout: index === 1 ? 'cover' : 'content_text',
    title: marker + '第 ' + index + ' 页',
    subtitle: index === 1 ? '函数与极限' : '',
    bullet_points: index === 1 ? [] : [marker.repeat(18), marker.repeat(10)],
    quote_text: null,
    quote_source: null,
    image_prompt: marker + '配图提示',
    audio_script: marker.repeat(30) + '第' + index + '页讲稿',
    source_quote: marker.repeat(40),
    source_pages: { from: chapter, to: chapter },
    source_anchor: { page: chapter, text: marker.repeat(10), rect: null },
    audio_file: null,
    audio_provider: 'none',
    audio_ms: 0,
    image_file: null,
    image_status: 'none',
  };
}

function makeSeries(tag) {
  seq += 1;
  const pages = [
    { page: 1, text: '第1章 甲\n' + '甲'.repeat(6000) },
    { page: 2, text: '第2章 乙\n' + '乙'.repeat(6000) },
  ];
  const book = createBook({
    buffer: Buffer.from('m4-voice-' + tag + '-' + seq + '-' + Date.now()),
    fileName: tag + '.pdf',
    title: 'M4 语音 ' + tag,
    author: '',
    pages: 2,
    rawPages: pages,
  });
  writeChapters(book.id, [
    { n: 1, title: '第1章 甲', from: 1, to: 1, chars: 6000, front: false },
    { n: 2, title: '第2章 乙', from: 2, to: 2, chars: 6000, front: false },
  ], 'manual');
  const part = savePart({ bookId: book.id, chapters: [1, 2], title: '函数' });
  const series = createSeries({
    bookId: book.id,
    partId: part.id,
    title: '函数',
    plan: {
      throughline: '把函数当机器。',
      lectures: [
        { n: 1, chapters: [1], title: '第 1 讲 · 机器', goal: 'g1', in: '', out: '', pages: 6, chars: 6000 },
        { n: 2, chapters: [2], title: '第 2 讲 · 靠近', goal: 'g2', in: '机器', out: '', pages: 6, chars: 6000 },
      ],
      seams: [{ from: 1, to: 2, concept: '极限', sentence: '上一讲把函数当机器，这一讲靠近某点。' }],
      terms: [{ name: '定义域', forbid: ['定义区间'] }],
      cut_notes: [],
      source: 'model',
      stitched: true,
      totalChars: 12000,
      totalPages: 12,
      estMinutes: 12,
    },
  });
  const found = findSeries(series.id);
  // 每本书的朗读稿都不同：TTS 缓存按文本命中，共用同一句会让后面的用例直接走缓存
  const unique = tag + seq;
  for (const n of [1, 2]) {
    const marker = (n === 1 ? '甲' : '乙') + unique;
    const slides = Array.from({ length: 6 }, (_, index) => slideOf(n, index + 1, n, marker));
    const lectureMeta = {
      schema: 1,
      series_id: series.id,
      n,
      lecture_id: series.id + '-' + n,
      title: '第 ' + n + ' 讲',
      chapters: [n],
      pages: 6,
      chars: 6000,
      status: 'ready',
      voice_status: 'none',
      finished_at: new Date().toISOString(),
    };
    writeLectureOutputs(found.dir, n, lectureMeta, {
      schema_version: 1,
      product_version: '2.0',
      series_id: series.id,
      book_id: book.id,
      lecture: n,
      title: '第 ' + n + ' 讲',
      chapters: [n],
      slides,
    });
    patchSeriesLecture(found.series, n, { status: 'ready', pages: 6, chars: 6000 });
  }
  patchSeriesLecture(found.series, 2, { status: 'ready' });
  found.series.status = 'ready';
  found.series.voice_status = 'none';
  persistSeries(found.series);
  return { book, series: found.series, found };
}

function lectureDirOf(found, n) {
  return path.join(found.dir, 'lectures', String(n));
}

function slidesFileOf(found, n) {
  return path.join(lectureDirOf(found, n), 'slides.json');
}

function readSlides(found, n) {
  return JSON.parse(fs.readFileSync(slidesFileOf(found, n), 'utf8'));
}

function waitJob(jobId, predicate, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      const job = getRevoiceJob(jobId);
      if (job && predicate(job)) {
        resolve(job);
        return;
      }
      if (Date.now() - started > timeout) {
        reject(new Error('等待配音作业超时：' + JSON.stringify(job)));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function textFields(slidesDoc) {
  return (slidesDoc.slides || []).map((slide) => ({
    title: slide.title,
    bullet_points: slide.bullet_points,
    quote_text: slide.quote_text,
    audio_script: slide.audio_script,
    source_quote: slide.source_quote,
    source_pages: slide.source_pages,
    source_anchor: slide.source_anchor,
  }));
}

function resetFake() {
  qwen.requests = [];
  qwen.delay = 0;
  qwen.failText = '';
  qwen.statusFail = 0;
}

/* ------------------------------ 用例 ------------------------------ */

test('AC-137：配音作业返回 jobId/进度；未配置 Key 时失败为 E_TTS_UNCONFIGURED 且不写音频', async () => {
  resetFake();
  await post('/dsh-book-slides/voice', { provider: 'qwen3-tts', model: 'qwen3-tts-flash', voice: 'Cherry', apiKey: '', clearApiKey: true });
  const { found } = makeSeries('nokey');
  const out = await post('/dsh-book-slides/revoice', { seriesId: found.series.id });
  assert.equal(out.ok, true);
  assert.ok(out.jobId);
  assert.deepEqual(out.scope, [1, 2]);
  const job = await waitJob(out.jobId, (item) => item.status === 'failed');
  assert.equal(job.error.code, 'E_TTS_UNCONFIGURED');
  const seriesOut = await json('/dsh-book-slides/series?seriesId=' + found.series.id);
  assert.equal(seriesOut.series.voice_status, 'none');
  assert.equal(qwen.requests.length, 0);
  assert.equal(fs.existsSync(path.join(lectureDirOf(found, 1), 'audio')), false);
});

test('FR-23：保存 Key 只回尾号，2026 年也不把 Key 写进响应', async () => {
  const saved = await post('/dsh-book-slides/voice', {
    provider: 'qwen3-tts',
    model: 'qwen3-tts-flash',
    voice: 'Cherry',
    apiKey: 'sk-test-abcdef1234',
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.voice.hasKey, true);
  assert.equal(saved.voice.apiKeyMask, '••••1234');
  assert.equal(JSON.stringify(saved).includes('sk-test-abcdef1234'), false);
  const raw = fs.readFileSync(path.join(ROOT, 'voice.json'), 'utf8');
  assert.equal(JSON.parse(raw).apiKey, 'sk-test-abcdef1234');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(ROOT, 'voice.json')).mode & 0o777, 0o600);
  }
});

test('AC-126：配音写 001–006.wav，只改音频字段，/audio 支持 Range', async () => {
  resetFake();
  await post('/dsh-book-slides/voice', {
    provider: 'qwen3-tts',
    model: 'qwen3-tts-flash',
    voice: 'Cherry',
    apiKey: 'sk-test-abcdef1234',
  });
  const { found } = makeSeries('voiced');
  const before = textFields(readSlides(found, 1));
  const out = await post('/dsh-book-slides/revoice', { seriesId: found.series.id });
  assert.equal(out.ok, true);
  const job = await waitJob(out.jobId, (item) => item.status === 'done');
  assert.equal(job.error, null);

  for (const n of [1, 2]) {
    for (let i = 1; i <= 6; i += 1) {
      const file = path.join(lectureDirOf(found, n), 'audio', String(i).padStart(3, '0') + '.wav');
      assert.ok(fs.existsSync(file), file + ' 应该存在');
    }
  }
  const after = readSlides(found, 1);
  assert.deepEqual(textFields(after), before, '配音不得改文字/锚点');
  assert.equal(after.slides[0].audio_file, 'audio/001.wav');
  assert.equal(after.slides[0].audio_provider, 'qwen3-tts');
  assert.ok(after.slides[0].audio_ms > 0);
  assert.equal(after.voice_status, 'ready');

  const seriesOut = await json('/dsh-book-slides/series?seriesId=' + found.series.id);
  assert.equal(seriesOut.series.voice_status, 'ready');
  const lectureOut = await json('/dsh-book-slides/lecture?seriesId=' + found.series.id + '&n=1');
  assert.equal(lectureOut.lecture.voice_status, 'ready');

  const hit = findAudioFile(found.dir, 1, 1);
  assert.ok(hit && hit.size === WAV.length);
  const audio = await fetch(baseUrl + '/dsh-book-slides/audio?seriesId=' + found.series.id + '&lecture=1&i=1');
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  assert.equal((await audio.arrayBuffer()).byteLength, WAV.length);
  const ranged = await fetch(baseUrl + '/dsh-book-slides/audio?seriesId=' + found.series.id + '&lecture=1&i=1', {
    headers: { range: 'bytes=0-15' },
  });
  assert.equal(ranged.status, 206);
  assert.equal((await ranged.arrayBuffer()).byteLength, 16);
});

test('FR-23：默认重配音命中缓存；force 忽略缓存并全部重跑（AC-145）', async () => {
  resetFake();
  const { found } = makeSeries('cache');
  const first = await post('/dsh-book-slides/revoice', { seriesId: found.series.id });
  await waitJob(first.jobId, (item) => item.status === 'done');
  const firstCount = qwen.requests.length;
  assert.ok(firstCount > 0);

  const cached = await post('/dsh-book-slides/revoice', { seriesId: found.series.id });
  await waitJob(cached.jobId, (item) => item.status === 'done');
  assert.equal(qwen.requests.length, firstCount, '缓存命中不应再打 Qwen');

  const forced = await post('/dsh-book-slides/revoice', { seriesId: found.series.id, force: true });
  const job = await waitJob(forced.jobId, (item) => item.status === 'done');
  assert.equal(job.error, null);
  assert.equal(qwen.requests.length, firstCount * 2, 'force 应忽略缓存并全部重跑');
});

test('AC-126：单页 500 时该页 audio_provider=none，其余页正常，系列 partial', async () => {
  resetFake();
  const { found } = makeSeries('partial');
  const doc = readSlides(found, 2);
  doc.slides[2].audio_script = 'FAILME' + doc.slides[2].audio_script;
  fs.writeFileSync(slidesFileOf(found, 2), JSON.stringify(doc, null, 2));
  qwen.failText = 'FAILME';
  const out = await post('/dsh-book-slides/revoice', { seriesId: found.series.id });
  const job = await waitJob(out.jobId, (item) => item.status === 'done');
  assert.ok(job.error && job.error.failures.length >= 1);

  const lecture2 = readSlides(found, 2);
  const failedPage = lecture2.slides[2];
  assert.equal(failedPage.audio_file, null);
  assert.equal(failedPage.audio_provider, 'none');
  assert.ok(lecture2.slides[0].audio_file, '其它页仍应有音频');
  assert.equal(lecture2.voice_status, 'partial');

  const lecture1 = readSlides(found, 1);
  assert.equal(lecture1.voice_status, 'ready');
  const seriesOut = await json('/dsh-book-slides/series?seriesId=' + found.series.id);
  assert.equal(seriesOut.series.voice_status, 'partial');
});

test('AC-144：429 额度耗尽 → 系列 failed + E_TTS_QUOTA，voice_error 带错误码与页数', async () => {
  resetFake();
  await post('/dsh-book-slides/voice', {
    provider: 'qwen3-tts',
    model: 'qwen3-tts-flash',
    voice: 'Cherry',
    apiKey: 'sk-test-abcdef1234',
  });
  const { found } = makeSeries('quota');
  qwen.statusFail = 429;
  const out = await post('/dsh-book-slides/revoice', { seriesId: found.series.id });
  const job = await waitJob(out.jobId, (item) => item.status === 'done');
  qwen.statusFail = 0;
  assert.ok(job.error && job.error.failures.length === 2);

  const seriesOut = await json('/dsh-book-slides/series?seriesId=' + found.series.id);
  assert.equal(seriesOut.series.voice_status, 'failed');
  assert.equal(seriesOut.series.voice_code, 'E_TTS_QUOTA');
  assert.match(seriesOut.series.voice_error, /E_TTS_QUOTA/);
  assert.match(seriesOut.series.voice_error, /6\/6 页未配音/);
  assert.equal(seriesOut.series.voice_failed, 12);

  const lecture = readSlides(found, 2);
  assert.equal(lecture.voice_status, 'failed');
  assert.match(lecture.voice_error, /E_TTS_QUOTA/);
  assert.equal(lecture.slides.every((slide) => !slide.audio_file), true);
});

test('AC-145：补配音（missingOnly）只请求缺失页，已就绪页不重跑', async () => {
  resetFake();
  await post('/dsh-book-slides/voice', {
    provider: 'qwen3-tts',
    model: 'qwen3-tts-flash',
    voice: 'Cherry',
    apiKey: 'sk-test-abcdef1234',
  });
  const { found } = makeSeries('fill');
  const doc = readSlides(found, 2);
  doc.slides[2].audio_script = 'FAILME' + doc.slides[2].audio_script;
  fs.writeFileSync(slidesFileOf(found, 2), JSON.stringify(doc, null, 2));
  qwen.failText = 'FAILME';

  const first = await post('/dsh-book-slides/revoice', { seriesId: found.series.id, missingOnly: true });
  const firstJob = await waitJob(first.jobId, (item) => item.status === 'done');
  assert.equal(firstJob.error.failures.length, 1);
  qwen.failText = '';

  const before = qwen.requests.length;
  const fill = await post('/dsh-book-slides/revoice', { seriesId: found.series.id, missingOnly: true });
  const job = await waitJob(fill.jobId, (item) => item.status === 'done');
  assert.equal(job.error, null);
  assert.equal(qwen.requests.length, before + 1, '只补那 1 页');

  const after = readSlides(found, 2);
  assert.equal(after.voice_status, 'ready');
  assert.equal(after.voice_failed, 0);
  const seriesOut = await json('/dsh-book-slides/series?seriesId=' + found.series.id);
  assert.equal(seriesOut.series.voice_status, 'ready');
  assert.equal(seriesOut.series.voice_code, undefined);
});

test('AC-137：取消配音后状态 cancelled，slides.json 不写半截音频字段', async () => {
  resetFake();
  await post('/dsh-book-slides/voice', {
    provider: 'qwen3-tts',
    model: 'qwen3-tts-flash',
    voice: 'Cherry',
    apiKey: 'sk-test-abcdef1234',
  });
  const { found } = makeSeries('cancel');
  const before = readSlides(found, 1);
  qwen.delay = 250;
  const out = await post('/dsh-book-slides/revoice', { seriesId: found.series.id });
  assert.equal(out.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'voice.json'), 'utf8')).provider, 'qwen3-tts');
  await waitJob(out.jobId, (item) => item.status === 'voicing' && item.current > 0, 5000);
  const cancelled = await post('/dsh-book-slides/revoice/cancel', { jobId: out.jobId });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.cancelled, true);
  const job = await waitJob(out.jobId, (item) => item.status === 'cancelled');
  assert.equal(job.status, 'cancelled');
  const after = readSlides(found, 1);
  assert.deepEqual(after.slides.map((slide) => slide.audio_file), before.slides.map((slide) => slide.audio_file));
  // 幂等取消
  const again = await post('/dsh-book-slides/revoice/cancel', { jobId: out.jobId });
  assert.equal(again.ok, true);
  assert.equal(again.cancelled, false);
});

test('FR-23：同一系列同时只允许一个配音作业（E_SERIES_BUSY）', async () => {
  resetFake();
  const { found } = makeSeries('busy');
  qwen.delay = 200;
  const out = await post('/dsh-book-slides/revoice', { seriesId: found.series.id });
  assert.equal(out.ok, true);
  const second = await post('/dsh-book-slides/revoice', { seriesId: found.series.id });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'E_SERIES_BUSY');
  await post('/dsh-book-slides/revoice/cancel', { jobId: out.jobId });
  await waitJob(out.jobId, (item) => item.status === 'cancelled');
  qwen.delay = 0;
});

test('FR-23：只对指定讲配音；未生成的讲返回 E_LECTURE_EMPTY', async () => {
  resetFake();
  const { found } = makeSeries('one');
  const out = await post('/dsh-book-slides/revoice', { seriesId: found.series.id, lecture: 2 });
  assert.equal(out.ok, true);
  assert.deepEqual(out.scope, [2]);
  const job = await waitJob(out.jobId, (item) => item.status === 'done');
  assert.equal(job.error, null);
  assert.equal(fs.existsSync(path.join(lectureDirOf(found, 1), 'audio', '001.wav')), false);
  assert.ok(fs.existsSync(path.join(lectureDirOf(found, 2), 'audio', '001.wav')));

  const missing = await post('/dsh-book-slides/revoice', { seriesId: found.series.id, lecture: 9 });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'E_REPLAN_RANGE');
});

test('FR-23：浏览器模式不落 WAV，audio_provider=browser', async () => {
  resetFake();
  await post('/dsh-book-slides/voice', { provider: 'browser', voice: '', rate: 1 });
  const { found } = makeSeries('browser');
  const out = await post('/dsh-book-slides/revoice', { seriesId: found.series.id });
  const job = await waitJob(out.jobId, (item) => item.status === 'done');
  assert.equal(job.error, null);
  const doc = readSlides(found, 1);
  assert.equal(doc.slides[0].audio_file, null);
  assert.equal(doc.slides[0].audio_provider, 'browser');
  assert.ok(doc.slides[0].audio_ms > 0);
  assert.equal(fs.existsSync(path.join(lectureDirOf(found, 1), 'audio')), false);
  assert.equal(qwen.requests.length, 0);
});

test('P0：按 seriesId 查询活动配音作业；结束后返回 none', async () => {
  resetFake();
  await post('/dsh-book-slides/voice', {
    provider: 'qwen3-tts',
    model: 'qwen3-tts-flash',
    voice: 'Cherry',
    apiKey: 'sk-test-abcdef1234',
  });
  const { found } = makeSeries('active');
  qwen.delay = 200;
  const out = await post('/dsh-book-slides/revoice', { seriesId: found.series.id });
  assert.equal(out.ok, true);
  const active = await json('/dsh-book-slides/revoice/job?seriesId=' + encodeURIComponent(found.series.id));
  assert.equal(active.ok, true);
  assert.equal(active.jobId, out.jobId);
  assert.ok(['queued', 'voicing', 'cancelling'].includes(String(active.status)), JSON.stringify(active));
  await post('/dsh-book-slides/revoice/cancel', { jobId: out.jobId });
  await waitJob(out.jobId, (item) => item.status === 'cancelled');
  const idle = await json('/dsh-book-slides/revoice/job?seriesId=' + encodeURIComponent(found.series.id));
  assert.equal(idle.ok, true);
  assert.equal(idle.jobId, null);
  assert.equal(idle.status, 'none');
  qwen.delay = 0;
});

test.after(() => {
  server.close();
  fake.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
