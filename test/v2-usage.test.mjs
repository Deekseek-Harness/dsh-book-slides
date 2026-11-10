/**
 * FR-27 AI 用量与费用统计（2.1，AC-159 ~ AC-165）。
 *
 * 覆盖：LLM usage 采集与阶段归属、讲义预估、TTS 字符/缓存口径、本地排除、
 * 价格快照与缺价、历史/汇总/清空、running 归一与坏记录、HTTP 路由。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-usage-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, writeChapters } = await import('../host/books.js');
const { savePart } = await import('../host/parts.js');
const { createSeries } = await import('../host/series.js');
const { writeLectureOutputs, lectureDir } = await import('../host/lectures.js');
const usage = await import('../host/usage.js');
const { estimateUsage } = await import('../host/usage-estimate.js');
const { callModel } = await import('../host/llm.js');
const { synthesizeVoicing, writeVoiceConfig } = await import('../lib/tts.js');
const { routeM1 } = await import('../host/api.js');

/* ------------------------------ 假模型 ------------------------------ */

function makeCtx(replies, options = {}) {
  const provider = options.provider || 'deepseek';
  const model = options.model || 'deepseek-chat';
  const state = { calls: 0, seen: [] };
  let index = 0;
  return {
    state,
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider, model }) };
      if (name !== 'llm') return null;
      return {
        async prepareCall(config) {
          state.seen.push(config);
          return {
            config: {},
            async *stream() {
              const current = index;
              index += 1;
              state.calls += 1;
              const reply = replies[Math.min(current, replies.length - 1)];
              yield { type: 'usage', usage: options.usage || { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 300 } };
              yield { type: 'text-delta', text: typeof reply === 'string' ? reply : '{"ok":true}' };
              yield { type: 'finish', reason: { kind: 'stop' } };
            },
          };
        },
      };
    },
  };
}

/* ------------------------------ 假 Qwen ------------------------------ */

function makeWav(ms = 200) {
  const sampleRate = 8000;
  const bits = 16;
  const size = Math.max(1600, Math.round((sampleRate * bits * ms) / 1000));
  const buffer = Buffer.alloc(44 + size);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + size, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE((sampleRate * bits) / 8, 28);
  buffer.writeUInt16LE(bits / 8, 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(size, 40);
  return buffer;
}

const WAV = makeWav();
/** 模拟 Qwen 的计费字符口径：汉字/数字 2，ASCII/标点 1。 */
function billedChars(text) {
  let total = 0;
  for (const ch of String(text || '')) {
    total += /[\u3400-\u9fff0-9]/.test(ch) ? 2 : 1;
  }
  return total;
}
const qwen = { requests: [], fail: false, noUsage: false, baseUrl: '' };
const fakeQwen = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const text = String((body.input && body.input.text) || '');
    qwen.requests.push(text);
    if (qwen.fail) {
      res.statusCode = 500;
      res.end('fail');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        output: { audio: { url: qwen.baseUrl + '/audio/' + qwen.requests.length + '.wav' } },
        ...(qwen.noUsage ? {} : { usage: { input_tokens: 0, output_tokens: 0, characters: billedChars(text) } }),
      }),
    );
    return;
  }
  if (req.method === 'GET' && req.url.startsWith('/audio/')) {
    res.setHeader('content-type', 'audio/wav');
    res.setHeader('content-length', String(WAV.length));
    res.end(WAV);
    return;
  }
  res.statusCode = 404;
  res.end('no');
});
await new Promise((resolve) => fakeQwen.listen(0, '127.0.0.1', resolve));
qwen.baseUrl = 'http://127.0.0.1:' + fakeQwen.address().port;
process.env.DSH_BOOK_SLIDES_QWEN_ENDPOINT = qwen.baseUrl + '/qwen';

/* ------------------------------ 夹具 ------------------------------ */

let seq = 0;

function makeBookSeries(tag) {
  seq += 1;
  const pages = [
    { page: 1, text: '第1章 甲\n' + '甲'.repeat(6000) },
    { page: 2, text: '第2章 乙\n' + '乙'.repeat(6000) },
  ];
  const book = createBook({
    buffer: Buffer.from('usage-' + tag + '-' + seq + '-' + Date.now()),
    fileName: tag + '.pdf',
    title: '用量测试 ' + tag,
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
        { n: 1, chapters: [1], title: '第 1 讲', goal: 'g', in: '', out: '', pages: 6, chars: 6000 },
        { n: 2, chapters: [2], title: '第 2 讲', goal: 'g', in: '', out: '', pages: 6, chars: 6000 },
      ],
      seams: [{ from: 1, to: 2, concept: '极限', sentence: '上一讲把函数当机器，这一讲靠近某点。' }],
      terms: [],
      cut_notes: [],
      source: 'model',
      stitched: true,
      totalChars: 12000,
      totalPages: 12,
      estMinutes: 12,
    },
  });
  return { book, part, series, dir: path.dirname(path.dirname(path.dirname(path.join(ROOT, 'books', book.id)))) };
}

function slide(index, text) {
  return {
    slide_index: index,
    layout: index === 1 ? 'cover' : 'content_text',
    title: '第 ' + index + ' 页',
    subtitle: '',
    bullet_points: [],
    quote_text: null,
    quote_source: null,
    image_prompt: '配图',
    audio_script: text,
    source_quote: '甲'.repeat(40),
    source_pages: { from: 1, to: 1 },
    source_anchor: null,
    audio_file: null,
    audio_provider: 'none',
    audio_ms: 0,
    image_file: null,
    image_status: 'none',
  };
}

function writeSlides(series, n, texts) {
  const dir = path.join(ROOT, 'books', series.book_id, 'series', series.id);
  writeLectureOutputs(dir, n, { n, status: 'ready', pages: texts.length }, { slides: texts.map((text, i) => slide(i + 1, text)) });
  return lectureDir(dir, n);
}

/* ------------------------------ AC-159 ------------------------------ */

test('AC-159：LLM usage 汇总、阶段归属与失败计数', async () => {
  const ctx = makeCtx(['{"ok":true}', '{"ok":true}']);
  const out = await usage.runUsageJob(
    { jobId: 'gac159', kind: 'lecture', phase: 'plan', billing: 'cloud', book: { id: 'b', title: '书' }, series: { id: 's', title: '系' }, scope: {} },
    async () => {
      await callModel(ctx, 's', 'u1', { stage: 'briefs' });
      await callModel(ctx, 's', 'u2', { stage: 'plan' });
    },
  );
  assert.equal(out.recorded, true);
  const job = usage.readJob('gac159');
  assert.equal(job.actual.calls, 2);
  assert.equal(job.actual.tokens.input, 2000);
  assert.equal(job.actual.tokens.output, 400);
  assert.equal(job.actual.tokens.cacheRead, 600);
  assert.ok(job.byStage.briefs && job.byStage.plan);
  assert.equal(job.byStage.briefs.calls, 1);
  assert.ok(job.actual.cost > 0);
});

test('AC-159：流末没有 usage 时不编造数字，标 unknownUsage', async () => {
  const ctx = {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-chat' }) };
      if (name !== 'llm') return null;
      return {
        async prepareCall() {
          return {
            config: {},
            async *stream() {
              yield { type: 'text-delta', text: 'x' };
              yield { type: 'finish', reason: { kind: 'stop' } };
            },
          };
        },
      };
    },
  };
  await usage.runUsageJob({ jobId: 'gac159b', kind: 'lecture', phase: 'generate', billing: 'cloud', scope: {} }, () =>
    callModel(ctx, 's', 'u', { stage: 'lecture' }),
  );
  const job = usage.readJob('gac159b');
  assert.equal(job.actual.tokens.input, 0);
  assert.equal(job.actual.unknownUsage, true);
  assert.equal(job.actual.calls, 1);
});

/* ------------------------------ AC-160 ------------------------------ */

test('AC-160：讲义预估按讲纲字数/页数推导，且不调模型', async () => {
  const { series } = makeBookSeries('estimate');
  const ctx = makeCtx(['x']);
  const before = ctx.state.calls;
  const estimate = estimateUsage({ ctx, kind: 'lecture', seriesId: series.id });
  assert.equal(ctx.state.calls, before, '预估不得调用模型');
  assert.equal(estimate.level, 'planned');
  assert.deepEqual(estimate.scope.lectures.sort(), [1, 2]);
  assert.ok(estimate.tokens.input > 0);
  assert.ok(estimate.tokens.output > 0);
  assert.ok(estimate.cost > 0, '有参考价时应给出金额');
  assert.match(estimate.note, /不含此前已发生的讲纲预览费用/);
});

test('AC-160：scope 只估指定讲；无价格时 cost=null', async () => {
  const { series } = makeBookSeries('estimate-scope');
  const ctx = makeCtx(['x'], { provider: 'fake', model: 'fake-chat' });
  usage.writePrices({ prices: [{ kind: 'llm', provider: 'fake', model: 'fake-chat', input: 0, output: 0 }] });
  const estimate = estimateUsage({ ctx, kind: 'lecture', seriesId: series.id, scope: { lectures: [2] } });
  assert.deepEqual(estimate.scope.lectures, [2]);
  assert.equal(estimate.tokens.input > 0, true);
  assert.equal(estimate.cost, 0, '显式 0 价是合法价格');
  usage.writePrices({ reset: true });
});

test('AC-160：记录保存预估与实际偏差', async () => {
  await usage.runUsageJob(
    {
      jobId: 'gac160d',
      kind: 'lecture',
      phase: 'generate',
      billing: 'cloud',
      estimate: { level: 'planned', cost: 1, tokens: { input: 1000, output: 100 } },
      scope: {},
    },
    () =>
      usage.recordLlmCall({
        provider: 'deepseek',
        model: 'deepseek-chat',
        stage: 'lecture',
        usage: { inputTokens: 2000, outputTokens: 200 },
      }),
  );
  const job = usage.readJob('gac160d');
  assert.equal(job.estimate.cost, 1);
  assert.ok(job.actual.deviation);
  assert.ok(job.actual.deviation.cost < 0, '实际低于预估时偏差为负');
  assert.ok(job.actual.deviation.inputRatio > 0);
});

test('AC-160：配音预估按云端计费字符口径（汉字 2）', async () => {
  const { series } = makeBookSeries('tts-estimate');
  writeSlides(series, 1, ['甲'.repeat(100), '乙'.repeat(200), '丙'.repeat(300)]);
  writeVoiceConfig({ provider: 'qwen3-tts', model: 'qwen3-tts-flash', voice: 'Cherry', apiKey: 'k', rate: 1 });
  try {
    const estimate = estimateUsage({ kind: 'tts', seriesId: series.id, lecture: 1 });
    assert.equal(estimate.chars, 1200, '100/200/300 个汉字按云端口径是 200/400/600');
    assert.ok(estimate.cost > 0);
    assert.match(estimate.note, /计费字符口径/);
  } finally {
    writeVoiceConfig({ provider: 'browser' });
  }
});

/* ------------------------------ AC-161 ------------------------------ */

test('AC-161：TTS 以云端 usage.characters 计费（不是码点），缓存页计 0', async () => {
  const config = { provider: 'qwen3-tts', model: 'qwen3-tts-flash', voice: 'Cherry', apiKey: 'k', rate: 1 };
  const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-tts-mod-'));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-tts-cache-'));
  const texts = ['甲'.repeat(100), '乙'.repeat(200), '丙'.repeat(300)];
  const first = [];
  await usage.runUsageJob({ jobId: 'gac161', kind: 'tts', phase: 'revoice', billing: 'cloud', scope: {} }, () =>
    synthesizeVoicing(texts.map((text, i) => slide(i + 1, text)), config, {
      moduleDir,
      cacheDir,
      fetchImpl: fetch,
      onPage: (page) => {
        first.push(page);
        usage.recordTtsPage(page);
      },
    }),
  );
  const job = usage.readJob('gac161');
  assert.equal(job.actual.chars, 1200, '100/200/300 个汉字按云端口径是 200/400/600');
  assert.equal(job.actual.charsSource, 'provider');
  assert.equal(job.actual.calls, 3);
  assert.equal(job.actual.cachedPages, 0);

  const second = [];
  await usage.runUsageJob({ jobId: 'gac161b', kind: 'tts', phase: 'revoice', billing: 'cloud', scope: {} }, () =>
    synthesizeVoicing(texts.map((text, i) => slide(i + 1, text)), config, {
      moduleDir,
      cacheDir,
      fetchImpl: fetch,
      onPage: (page) => {
        second.push(page);
        usage.recordTtsPage(page);
      },
    }),
  );
  const cached = usage.readJob('gac161b');
  assert.equal(cached.actual.chars, 0);
  assert.equal(cached.actual.cachedPages, 3);
  assert.ok(second.every((page) => page.cached === true));
});

test('AC-161：TTS 失败只记次数、不计字符', async () => {
  const config = { provider: 'qwen3-tts', model: 'qwen3-tts-flash', voice: 'Cherry', apiKey: 'k', rate: 1 };
  const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-tts-fail-'));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-tts-fail-cache-'));
  qwen.fail = true;
  try {
    await usage.runUsageJob({ jobId: 'gac161c', kind: 'tts', phase: 'revoice', billing: 'cloud', scope: {} }, () =>
      synthesizeVoicing([slide(1, '失败的朗读稿' + Date.now())], config, {
        moduleDir,
        cacheDir,
        fetchImpl: fetch,
        onPage: (page) => usage.recordTtsPage(page),
      }),
    );
  } finally {
    qwen.fail = false;
  }
  const job = usage.readJob('gac161c');
  assert.equal(job.actual.chars, 0);
  assert.ok(job.actual.failedCalls >= 2, '两次尝试都记失败次数');
});

test('AC-161：响应没有 usage 时回落码点并标 charsSource=text', async () => {
  const config = { provider: 'qwen3-tts', model: 'qwen3-tts-flash', voice: 'Cherry', apiKey: 'k', rate: 1 };
  const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-tts-fallback-'));
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-tts-fallback-cache-'));
  const text = '没有用量字段时的回落' + Date.now();
  qwen.noUsage = true;
  try {
    await usage.runUsageJob({ jobId: 'gac161d', kind: 'tts', phase: 'revoice', billing: 'cloud', scope: {} }, () =>
      synthesizeVoicing([slide(1, text)], config, {
        moduleDir,
        cacheDir,
        fetchImpl: fetch,
        onPage: (page) => usage.recordTtsPage(page),
      }),
    );
  } finally {
    qwen.noUsage = false;
  }
  const job = usage.readJob('gac161d');
  assert.equal(job.actual.chars, Array.from(text).length);
  assert.equal(job.actual.charsSource, 'text');
});

/* ------------------------------ AC-162 ------------------------------ */

test('AC-162：本地调用完全不写账本', async () => {
  const before = usage.listUsageJobs({}).total;
  await usage.runUsageJob({ jobId: 'gac162', kind: 'lecture', phase: 'generate', billing: 'local', scope: {} }, () => {
    usage.recordLlmCall({ provider: 'ollama', model: 'local', stage: 'lecture', usage: { inputTokens: 10, outputTokens: 5 } });
    usage.recordTtsPage({ chars: 100, ok: true, model: 'x' });
  });
  assert.equal(usage.readJob('gac162'), null);
  assert.equal(usage.listUsageJobs({}).total, before);
});

/* ------------------------------ AC-163 ------------------------------ */

test('AC-163：价格快照——改价不重算历史；缺价显示 null', async () => {
  usage.writePrices({ prices: [{ kind: 'llm', provider: 'price', model: 'a', input: 1, output: 2 }] });
  await usage.runUsageJob({ jobId: 'gac163a', kind: 'lecture', phase: 'generate', billing: 'cloud', scope: {} }, () =>
    usage.recordLlmCall({ provider: 'price', model: 'a', stage: 'lecture', usage: { inputTokens: 1000000, outputTokens: 0 } }),
  );
  usage.writePrices({ prices: [{ kind: 'llm', provider: 'price', model: 'a', input: 10, output: 20 }] });
  await usage.runUsageJob({ jobId: 'gac163b', kind: 'lecture', phase: 'generate', billing: 'cloud', scope: {} }, () =>
    usage.recordLlmCall({ provider: 'price', model: 'a', stage: 'lecture', usage: { inputTokens: 1000000, outputTokens: 0 } }),
  );
  const first = usage.readJob('gac163a');
  const second = usage.readJob('gac163b');
  assert.equal(first.actual.cost, 1);
  assert.equal(second.actual.cost, 10);

  await usage.runUsageJob({ jobId: 'gac163c', kind: 'lecture', phase: 'generate', billing: 'cloud', scope: {} }, () =>
    usage.recordLlmCall({ provider: 'price', model: 'unknown', stage: 'lecture', usage: { inputTokens: 100, outputTokens: 0 } }),
  );
  const missing = usage.readJob('gac163c');
  assert.equal(missing.actual.cost, null);
  assert.equal(missing.actual.unknownPrice, true);
  usage.writePrices({ reset: true });
});

test('FR-27.4：provider 家族别名回落参考价（deepseek-official → deepseek）', async () => {
  usage.writePrices({ reset: true });
  await usage.runUsageJob({ jobId: 'gac163d', kind: 'lecture', phase: 'generate', billing: 'cloud', scope: {} }, () =>
    usage.recordLlmCall({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      stage: 'lecture',
      usage: { inputTokens: 1000000, outputTokens: 0 },
    }),
  );
  const job = usage.readJob('gac163d');
  assert.equal(job.actual.unknownPrice, false, '别名应回落到 deepseek 家族价');
  assert.ok(job.actual.cost > 0);
});

test('FR-27.4：DeepSeek 分时价按北京时间取档；reasoning 不重复计价', async () => {
  const peakAt = new Date('2026-11-10T02:00:00Z'); // 周二 10:00 北京
  const offPeakAt = new Date('2026-11-10T12:00:00Z'); // 周二 20:00 北京
  const weekendAt = new Date('2026-11-14T02:00:00Z'); // 周六 10:00 北京
  assert.equal(usage.isPeakHour(peakAt), true);
  assert.equal(usage.isPeakHour(offPeakAt), false);
  assert.equal(usage.isPeakHour(weekendAt), false);
  const base = { input: 1, output: 4, cacheRead: 0.02, peak: { input: 2, output: 8, cacheRead: 0.04 } };
  assert.equal(usage.effectivePrice(base, peakAt).input, 2);
  assert.equal(usage.effectivePrice(base, offPeakAt).input, 1);

  usage.writePrices({ prices: [{ kind: 'llm', provider: 'reason', model: 'r', input: 0, output: 10 }] });
  await usage.runUsageJob({ jobId: 'gac163e', kind: 'lecture', phase: 'generate', billing: 'cloud', scope: {} }, () =>
    usage.recordLlmCall({
      provider: 'reason',
      model: 'r',
      stage: 'lecture',
      usage: { inputTokens: 0, outputTokens: 100, reasoningTokens: 50 },
    }),
  );
  const job = usage.readJob('gac163e');
  assert.equal(job.actual.cost, 0.001, 'completion_tokens 已含 reasoning，不能按 150 计');
  assert.equal(job.actual.tokens.reasoning, 50, 'reasoning 仍单独展示');
  usage.writePrices({ reset: true });
});

test('FR-27.4：内置价表升级自动刷新，自定义价表保留', () => {
  const pricesFile = path.join(ROOT, 'usage', 'prices.json');
  fs.mkdirSync(path.dirname(pricesFile), { recursive: true });
  fs.writeFileSync(
    pricesFile,
    JSON.stringify({ currency: 'CNY', priceVersion: '2026-11-09', source: 'builtin', prices: [] }),
  );
  const refreshed = usage.readPrices();
  assert.equal(refreshed.source, 'builtin');
  assert.notEqual(refreshed.priceVersion, '2026-11-09', '旧内置版本应被刷新');
  assert.ok(refreshed.prices.some((item) => item.kind === 'llm' && item.peak));

  fs.writeFileSync(
    pricesFile,
    JSON.stringify({ currency: 'CNY', priceVersion: 'mine', source: 'custom', prices: [{ kind: 'llm', provider: 'x', model: 'm', input: 9, output: 9 }] }),
  );
  const custom = usage.readPrices();
  assert.equal(custom.source, 'custom');
  assert.equal(custom.priceVersion, 'mine');
  usage.writePrices({ reset: true });
});

/* ------------------------------ AC-164 ------------------------------ */

test('AC-164：历史筛选、汇总、清空与归属快照', async () => {
  const { series } = makeBookSeries('history');
  await usage.runUsageJob(
    { jobId: 'gac164', kind: 'lecture', phase: 'generate', billing: 'cloud', book: { id: series.book_id, title: '旧标题' }, series: { id: series.id, title: '旧系列' }, scope: { lectures: [1] } },
    () => usage.recordLlmCall({ provider: 'fake', model: 'm', stage: 'lecture', usage: { inputTokens: 100, outputTokens: 50 } }),
  );
  const list = usage.listUsageJobs({ seriesId: series.id });
  assert.equal(list.total, 1);
  assert.equal(list.jobs[0].series.title, '旧系列');
  const summary = usage.usageSummary({ seriesId: series.id });
  assert.equal(summary.totals.jobs, 1);
  assert.equal(summary.totals.tokens.input, 100);
  const removed = usage.clearUsageJobs();
  assert.ok(removed >= 1);
  assert.equal(usage.listUsageJobs({}).total, 0);
  assert.equal(usage.clearUsageJobs(), 0, '二次清空幂等');
});

/* ------------------------------ AC-178 / AC-179 ------------------------------ */

test('AC-178：from/to 按本地日过滤；AC-179：汇总仍含 other', () => {
  const jobsDir = path.join(ROOT, 'usage', 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  const localIso = (date) => date.toISOString();
  const before = new Date(2020, 4, 6, 23, 30); // 本地 2020-05-06 23:30
  const after = new Date(2020, 4, 7, 0, 30); // 本地 2020-05-07 00:30
  const write = (id, kind, startedAt) => {
    fs.writeFileSync(
      path.join(jobsDir, id + '.json'),
      JSON.stringify({
        usageSchema: 1,
        jobId: id,
        kind,
        phase: kind === 'other' ? 'probe' : 'generate',
        status: 'done',
        billing: 'cloud',
        startedAt,
        finishedAt: startedAt,
        book: { id: 'b', title: '书' },
        series: { id: 's', title: '系列' },
        actual: { calls: 1, tokens: { input: 10, output: 5 }, chars: 0, images: 0, cost: 0.01, currency: 'CNY' },
      }),
    );
  };
  write('gday10', 'lecture', localIso(before));
  write('gday11', 'lecture', localIso(after));
  write('gday11other', 'other', localIso(after));
  try {
    assert.deepEqual(
      usage.listUsageJobs({ from: '2020-05-07', to: '2020-05-07' }).jobs.map((job) => job.jobId).sort(),
      ['gday11', 'gday11other'],
      '本地 00:30 的记录属于 05-07，不属于 05-06',
    );
    assert.deepEqual(
      usage.listUsageJobs({ from: '2020-05-06', to: '2020-05-06' }).jobs.map((job) => job.jobId),
      ['gday10'],
    );
    const summary = usage.usageSummary({ from: '2020-05-07', to: '2020-05-07' });
    assert.equal(summary.totals.jobs, 2);
    assert.equal(summary.byKind.find((item) => item.kind === 'other').jobs, 1, '折叠只影响呈现，汇总仍含 other');
    assert.equal(summary.byKind.find((item) => item.kind === 'lecture').jobs, 1);
  } finally {
    for (const id of ['gday10', 'gday11', 'gday11other']) {
      fs.rmSync(path.join(jobsDir, id + '.json'), { force: true });
    }
  }
});

/* ------------------------------ AC-165 ------------------------------ */

test('AC-165：running 归一 interrupted；坏记录跳过', () => {
  const jobsDir = path.join(ROOT, 'usage', 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(path.join(jobsDir, 'grunning.json'), JSON.stringify({ usageSchema: 1, jobId: 'grunning', status: 'running', startedAt: new Date().toISOString(), actual: {} }));
  fs.writeFileSync(path.join(jobsDir, 'gbroken.json'), '{not json');
  const changed = usage.reconcileUsageJobs();
  assert.ok(changed >= 1);
  const fixed = usage.readJob('grunning');
  assert.equal(fixed.status, 'interrupted');
  assert.ok(fixed.finishedAt);
  assert.equal(usage.readJob('gbroken'), null);
  assert.ok(usage.listUsageJobs({}).total >= 1);
});

/* ------------------------------ HTTP 路由 ------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const handled = await routeM1(req, res, url, { ctx: null });
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

test('FR-27：/usage/summary、/usage/jobs、/usage/job、/usage/prices、/usage/estimate、DELETE', async () => {
  usage.clearUsageJobs();
  await usage.runUsageJob({ jobId: 'ghttp', kind: 'tts', phase: 'revoice', billing: 'cloud', series: { id: 's', title: 'S' }, scope: {} }, () =>
    usage.recordTtsPage({ chars: 500, ok: true, model: 'qwen3-tts-flash' }),
  );
  const summary = await json('/dsh-book-slides/usage/summary?seriesId=s');
  assert.equal(summary.ok, true);
  assert.equal(summary.totals.chars, 500);

  const list = await json('/dsh-book-slides/usage/jobs?kind=tts');
  assert.equal(list.ok, true);
  assert.equal(list.total, 1);

  const one = await json('/dsh-book-slides/usage/job?jobId=ghttp');
  assert.equal(one.job.jobId, 'ghttp');
  const missing = await json('/dsh-book-slides/usage/job?jobId=nope1234');
  assert.equal(missing.code, 'E_USAGE_NOT_FOUND');

  const prices = await json('/dsh-book-slides/usage/prices');
  assert.equal(prices.ok, true);
  assert.ok(Array.isArray(prices.prices.prices));

  const bad = await json('/dsh-book-slides/usage/prices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prices: [{ kind: 'llm', provider: 'x' }] }),
  });
  assert.equal(bad.code, 'E_USAGE_PRICE');

  const estimate = await json('/dsh-book-slides/usage/estimate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'tts', seriesId: 'missing' }),
  });
  assert.equal(estimate.code, 'E_NOT_FOUND');

  const cleared = await json('/dsh-book-slides/usage/jobs', { method: 'DELETE' });
  assert.equal(cleared.ok, true);
  assert.ok(cleared.removed >= 1);
});

test.after(() => {
  server.close();
  fakeQwen.close();
});
