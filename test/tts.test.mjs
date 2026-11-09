/**
 * Qwen3-TTS 语音层单测：配置、Key 掩码、WAV 时长、逐页合成与缓存。
 *
 *   node test/tts.test.mjs
 *
 * 不调真实千问接口：fetch 用假实现，验证请求体、Authorization、缓存键与降级。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-tts-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const tts = await import('../lib/tts.js');

const ENDPOINT = 'https://qwen.test/tts';
process.env.DSH_BOOK_SLIDES_QWEN_ENDPOINT = ENDPOINT;

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** 0.5 秒 24k 16bit 单声道静音 WAV，足够让 wavDurationMs 读出 500ms。 */
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

function makeFetch(state) {
  return async (url, options) => {
    const body = options && options.body ? JSON.parse(String(options.body)) : null;
    if (String(url) === ENDPOINT) {
      state.calls.push({ url: url, headers: options && options.headers, body: body });
      if (body && String(body.input.text).includes('BAD')) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      if (body && String(body.input.text).includes('AUTH')) {
        return { ok: false, status: 401, json: async () => ({}) };
      }
      if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      return {
        ok: true,
        status: 200,
        json: async () => ({ output: { audio: { url: 'https://qwen.test/audio.wav' } } }),
      };
    }
    if (String(url) === 'https://qwen.test/audio.wav') {
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? String(WAV.length) : '') },
        arrayBuffer: async () => WAV,
      };
    }
    throw new Error('unexpected fetch ' + url);
  };
}

function makeSlides(prefix) {
  return [1, 2, 3].map((index) => ({
    slide_index: index,
    layout: index === 1 ? 'cover' : 'content_text',
    title: '第 ' + index + ' 页',
    audio_script: prefix + ' 第 ' + index + ' 页的朗读稿，用来测试逐页合成与缓存，内容长度足够通过校验。',
    source_pages: { from: index, to: index },
  }));
}

function tempModule(name) {
  const dir = path.join(ROOT, 'modules-' + name);
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  return dir;
}

test('音色与模型：48 个非实时音色，默认 Browser，key 不回显', () => {
  assert.equal(tts.QWEN_VOICES.length, 48);
  assert.equal(tts.QWEN_MODELS[0].id, 'qwen3-tts-flash');
  const config = tts.normalizeVoiceConfig({ provider: 'qwen3-tts', voice: 'NotAVoice', apiKey: 'sk-12345678' });
  assert.equal(config.provider, 'qwen3-tts');
  assert.equal(config.model, 'qwen3-tts-flash');
  assert.equal(config.voice, 'Cherry');
  const pub = tts.publicVoiceConfig(config);
  assert.equal(pub.hasKey, true);
  assert.equal(pub.apiKeyMask, '••••5678');
  assert.equal(Object.prototype.hasOwnProperty.call(pub, 'apiKey'), false, '公开配置不能带完整 key');
  assert.doesNotMatch(JSON.stringify(pub), /sk-12345678/);
});

test('voice.json：0600，掩码/空输入不覆盖，clearApiKey 才清除', () => {
  const saved = tts.writeVoiceConfig({ provider: 'qwen3-tts', voice: 'Serena', apiKey: 'sk-secret-9876' });
  assert.equal(saved.apiKey, 'sk-secret-9876');
  const file = path.join(ROOT, 'voice.json');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const masked = tts.writeVoiceConfig({ provider: 'qwen3-tts', apiKey: '••••9876' });
  assert.equal(masked.apiKey, 'sk-secret-9876', '打码值不能覆盖真 key');
  const empty = tts.writeVoiceConfig({ provider: 'qwen3-tts', apiKey: '' });
  assert.equal(empty.apiKey, 'sk-secret-9876', '空输入不能覆盖真 key');
  const cleared = tts.writeVoiceConfig({ clearApiKey: true });
  assert.equal(cleared.apiKey, '');
});

test('WAV 时长：从 RIFF 头读出 500ms，坏数据返回 0', () => {
  assert.equal(tts.wavDurationMs(WAV), 500);
  assert.equal(tts.wavDurationMs(Buffer.from('not wav')), 0);
});

test('Qwen 逐页合成：请求体/Authorization/落盘/缓存', async () => {
  const state = { calls: [] };
  const config = { provider: 'qwen3-tts', model: 'qwen3-tts-flash', voice: 'Cherry', apiKey: 'sk-test-key' };
  const slides = makeSlides('CACHE');
  const moduleDir = tempModule('one');
  const cacheDir = path.join(ROOT, 'cache-one');

  const first = await tts.synthesizeVoicing(slides, config, {
    moduleDir: moduleDir,
    cacheDir: cacheDir,
    fetchImpl: makeFetch(state),
  });
  assert.equal(first.provider, 'qwen3-tts');
  assert.equal(first.degraded, false);
  assert.equal(state.calls.length, 3);
  const request = state.calls[0];
  assert.equal(request.headers.authorization, 'Bearer sk-test-key');
  assert.equal(request.body.model, 'qwen3-tts-flash');
  assert.equal(request.body.input.voice, 'Cherry');
  assert.equal(request.body.input.language_type, 'Chinese');
  assert.equal(request.body.input.format, undefined, 'Qwen3-TTS 不接受 format 参数');
  assert.equal(request.body.input.sample_rate, undefined, 'Qwen3-TTS 不接受 sample_rate 参数');
  for (const slide of first.slides) {
    assert.equal(slide.audio_provider, 'qwen3-tts');
    assert.equal(slide.audio_file, 'audio/' + String(slide.slide_index).padStart(3, '0') + '.wav');
    assert.ok(fs.existsSync(path.join(moduleDir, slide.audio_file)));
    assert.equal(slide.audio_ms, 500);
  }

  const secondModule = tempModule('two');
  const second = await tts.synthesizeVoicing(slides, config, {
    moduleDir: secondModule,
    cacheDir: cacheDir,
    fetchImpl: makeFetch(state),
  });
  assert.equal(second.degraded, false);
  assert.equal(state.calls.length, 3, '第二次应命中音频缓存，不再请求 Qwen');
  assert.ok(fs.existsSync(path.join(secondModule, 'audio', '001.wav')));
});

test('Qwen 部分失败：成功页保留音频，失败页降级', async () => {
  const state = { calls: [] };
  const config = { provider: 'qwen3-tts', voice: 'Cherry', apiKey: 'sk-test-key' };
  const slides = makeSlides('GOOD');
  slides[1].audio_script = 'BAD 这一页应该失败，内容长度足够通过校验，但云端会返回 500。';
  const result = await tts.synthesizeVoicing(slides, config, {
    moduleDir: tempModule('partial'),
    cacheDir: path.join(ROOT, 'cache-partial'),
    fetchImpl: makeFetch(state),
  });
  assert.equal(result.degraded, true);
  assert.equal(result.code, 'E_TTS_FAIL');
  assert.equal(result.errors.length, 1);
  assert.equal(result.slides[1].audio_provider, 'none');
  assert.equal(result.slides[0].audio_provider, 'qwen3-tts');
  assert.ok(result.slides[0].audio_file);
});

test('Qwen 未配置/鉴权失败：返回明确错误码，不崩溃', async () => {
  const noKey = await tts.synthesizeVoicing(makeSlides('NO_KEY'), { provider: 'qwen3-tts' }, { moduleDir: tempModule('nokey') });
  assert.equal(noKey.degraded, true);
  assert.equal(noKey.code, 'E_TTS_UNCONFIGURED');

  const state = { calls: [] };
  const probe = await tts.probeVoice(
    { provider: 'qwen3-tts', voice: 'Cherry', apiKey: 'sk-bad' },
    'AUTH 测试',
    { fetchImpl: makeFetch(state) },
  );
  assert.equal(probe.ok, false);
  assert.equal(probe.code, 'E_TTS_AUTH');
  assert.doesNotMatch(JSON.stringify(probe), /sk-bad/);
});

test('Qwen 试听：返回 WAV Buffer，不落盘', async () => {
  const state = { calls: [] };
  const result = await tts.probeVoice(
    { provider: 'qwen3-tts', voice: 'Cherry', apiKey: 'sk-test-key' },
    '你好，试听。',
    { fetchImpl: makeFetch(state) },
  );
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'qwen');
  assert.equal(result.contentType, 'audio/wav');
  assert.ok(Buffer.isBuffer(result.audio));
  assert.equal(result.audio.length, WAV.length);
  assert.equal(result.audio_ms, 500);
});
