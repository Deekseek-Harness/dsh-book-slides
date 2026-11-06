/**
 * 2.0 v1.2 本地 ComfyUI Qwen3-TTS 配音（FR-23.1 / AC-148 ~ AC-155）。
 *
 * 假 ComfyUI 真 HTTP：/system_stats、/object_info、/prompt、/history、/view。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-tts-comfy-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { ensureRoot } = await import('../v2/root.js');
ensureRoot();
const { writeImageConfig, readImageConfig } = await import('../comfy.js');
const { createBook, writeChapters } = await import('../v2/books.js');
const { savePart } = await import('../v2/parts.js');
const { createSeries, findSeries, patchSeriesLecture, persistSeries } = await import('../v2/series.js');
const { writeLectureOutputs, loadLecture } = await import('../v2/lectures.js');
const { getRevoiceJob } = await import('../v2/voice.js');
const { routeM1 } = await import('../v2/api.js');
const { workflowPayload } = await import('../v2/comfy-tts.js');

function makeWav(ms = 200) {
  const sampleRate = 8000;
  const size = Math.max(400, Math.round((sampleRate * 2 * ms) / 1000));
  const buffer = Buffer.alloc(44 + size);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + size, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(size, 40);
  return buffer;
}

const WAV = makeWav();
const DEFAULT_SPEAKERS = ['Vivian', 'Serena', 'Uncle_fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono_anna', 'Sohee'];
const state = {
  speakers: DEFAULT_SPEAKERS.slice(),
  version: '0.3.99',
  prompts: [],
  delay: 0,
  active: 0,
  maxActive: 0,
  failSubmit: false,
  failText: '',
  ext: 'flac',
  lastId: '',
};

function ttsInputs(body) {
  const prompt = body && body.prompt && typeof body.prompt === 'object' ? body.prompt : {};
  for (const id of Object.keys(prompt)) {
    const cls = String(prompt[id].class_type || '');
    if (/qwen3tts/i.test(cls)) {
      const inputs = prompt[id].inputs || {};
      return { text: String(inputs.text || ''), speaker: String(inputs.speaker || ''), custom: String(inputs.custom_speaker_name || ''), node: id };
    }
  }
  return { text: '', speaker: '', custom: '', node: '' };
}

const comfy = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const json = (value) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(value));
  };
  if (url.pathname === '/system_stats') {
    json({ system: { comfyui_version: state.version } });
    return;
  }
  if (url.pathname === '/object_info') {
    json({
      FB_Qwen3TTSCustomVoice: {
        input: { required: { text: ['STRING', {}], speaker: [state.speakers.slice(), {}] } },
      },
      PreviewAudio: { input: { required: {} } },
    });
    return;
  }
  if (url.pathname === '/prompt') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const inputs = ttsInputs(body);
    state.prompts.push(inputs);
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
    state.active -= 1;
    state.lastId = 'p' + state.prompts.length;
    if (state.failSubmit || (state.failText && inputs.text.includes(state.failText))) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'fake comfy failure' }));
      return;
    }
    json({ prompt_id: state.lastId });
    return;
  }
  if (url.pathname.startsWith('/history/')) {
    const id = url.pathname.split('/').pop();
    json({
      [id]: {
        status: { completed: true, status_str: 'success' },
        outputs: { '2': { audio: [{ filename: 'voice-' + id + '.' + state.ext, subfolder: '', type: 'temp' }] } },
      },
    });
    return;
  }
  if (url.pathname === '/view') {
    res.setHeader('content-type', 'audio/wav');
    res.end(WAV);
    return;
  }
  res.statusCode = 404;
  res.end('no route');
});
await new Promise((resolve) => comfy.listen(0, '127.0.0.1', resolve));
const comfyPort = comfy.address().port;
writeImageConfig({ host: '127.0.0.1', port: comfyPort });

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

async function get(p) {
  const res = await fetch(baseUrl + '/dsh-book-slides' + p);
  const type = String(res.headers.get('content-type') || '');
  if (type.includes('application/json')) return { status: res.status, type: type, data: await res.json() };
  return { status: res.status, type: type, data: Buffer.from(await res.arrayBuffer()) };
}

async function post(p, body) {
  const res = await fetch(baseUrl + '/dsh-book-slides' + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const type = String(res.headers.get('content-type') || '');
  if (type.includes('application/json')) return { status: res.status, type: type, data: await res.json() };
  return { status: res.status, type: type, data: Buffer.from(await res.arrayBuffer()) };
}

async function resetAll() {
  state.speakers = DEFAULT_SPEAKERS.slice();
  state.version = '0.3.99';
  state.prompts = [];
  state.delay = 0;
  state.active = 0;
  state.maxActive = 0;
  state.failSubmit = false;
  state.failText = '';
  state.ext = 'flac';
  state.lastId = '';
  writeImageConfig({ host: '127.0.0.1', port: comfyPort });
  await post('/voice', { provider: 'comfyui-tts', comfyVoice: 'Vivian' });
  await post('/voice/speakers', { reset: true });
  await post('/voice/workflow', { reset: true });
}

/* ------------------------------ 系列夹具 ------------------------------ */

let seq = 0;

function slideOf(index, marker) {
  return {
    slide_index: index,
    layout: index === 1 ? 'cover' : 'content_text',
    title: marker + '第 ' + index + ' 页',
    subtitle: index === 1 ? '函数与极限' : '',
    bullet_points: index === 1 ? [] : [marker.repeat(18)],
    quote_text: null,
    quote_source: null,
    image_prompt: marker + '配图',
    audio_script: marker + '第' + index + '页讲稿',
    source_quote: marker.repeat(40),
    source_pages: { from: 1, to: 1 },
    source_anchor: { page: 1, text: marker.repeat(10), rect: null },
    audio_file: null,
    audio_provider: 'none',
    audio_ms: 0,
    image_file: null,
    image_status: 'none',
  };
}

function makeSeries(tag) {
  seq += 1;
  const book = createBook({
    buffer: Buffer.from('v2-tts-comfy-' + tag + '-' + seq + '-' + Date.now()),
    fileName: tag + '.pdf',
    title: 'TTS ' + tag,
    author: '',
    pages: 1,
    rawPages: [{ page: 1, text: '第1章 甲\n' + '甲'.repeat(6000) }],
  });
  writeChapters(book.id, [{ n: 1, title: '第1章 甲', from: 1, to: 1, chars: 6000, front: false }], 'manual');
  const part = savePart({ bookId: book.id, chapters: [1], title: '配音' });
  const series = createSeries({
    bookId: book.id,
    partId: part.id,
    title: '配音',
    plan: {
      throughline: '配音测试',
      lectures: [{ n: 1, chapters: [1], title: '第 1 讲', goal: 'g', in: '', out: '', pages: 6, chars: 6000 }],
      seams: [],
      terms: [],
      cut_notes: [],
      source: 'model',
      stitched: true,
      totalChars: 6000,
      totalPages: 6,
      estMinutes: 6,
    },
  });
  const found = findSeries(series.id);
  const marker = (tag + seq + '配').slice(0, 4);
  const slides = Array.from({ length: 6 }, (_, index) => slideOf(index + 1, marker));
  writeLectureOutputs(
    found.dir,
    1,
    {
      schema: 1,
      series_id: series.id,
      n: 1,
      lecture_id: series.id + '-1',
      title: '第 1 讲',
      chapters: [1],
      pages: 6,
      chars: 6000,
      status: 'ready',
      voice_status: 'none',
    },
    { schema_version: 1, product_version: '2.0', series_id: series.id, book_id: book.id, lecture: 1, title: '第 1 讲', chapters: [1], slides },
  );
  patchSeriesLecture(found.series, 1, { status: 'ready', pages: 6, chars: 6000 });
  found.series.status = 'ready';
  found.series.voice_status = 'none';
  persistSeries(found.series);
  return { book, series: found.series, found, marker };
}

function waitJob(jobId, predicate, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const job = getRevoiceJob(jobId);
      if (job && predicate(job)) return resolve(job);
      if (Date.now() - started > timeout) return reject(new Error('等待配音作业超时：' + JSON.stringify(job)));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function readSlides(found) {
  return JSON.parse(fs.readFileSync(path.join(found.dir, 'lectures', '1', 'slides.json'), 'utf8'));
}

/* ------------------------------ 测试 ------------------------------ */

test('AC-148/149：默认工作流与音色表、连接测试、试听测试', async () => {
  await resetAll();
  const voice = await get('/voice');
  assert.equal(voice.data.ok, true);
  assert.ok(voice.data.providers.some((item) => item.id === 'comfyui-tts'));
  assert.equal(voice.data.workflow.textNode, '1');
  assert.equal(voice.data.workflow.outputNode, '2');
  assert.equal(voice.data.voiceTable.count, 9);
  assert.equal(voice.data.voiceTable.defaultVoice, 'Vivian');
  assert.equal(voice.data.voiceTable.model, 'Qwen3-TTS-CustomVoice');

  const probe = await post('/voice/comfy/probe', {});
  assert.equal(probe.data.ok, true);
  assert.equal(probe.data.version, '0.3.99');
  assert.equal(probe.data.workflow.textNode, '1');
  assert.equal(probe.data.modelSpeakers.length, 9);
  assert.equal(probe.data.voiceTable.unsupported.length, 0);
  assert.equal(probe.data.missing.nodes.length, 0);

  const preview = await post('/voice/probe', { text: '连接试听' });
  assert.equal(preview.status, 200);
  assert.match(preview.type, /audio\/(wav|flac|mpeg|ogg)/);
  assert.ok(preview.data.length > 0);
  assert.equal(state.prompts.length, 1);
  assert.equal(state.prompts[0].speaker, 'Vivian');
  assert.equal(state.prompts[0].text, '连接试听');
  assert.equal(fs.existsSync(path.join(ROOT, 'audio-cache')), false);

  state.failSubmit = true;
  const failed = await post('/voice/probe', { text: '失败试听' });
  assert.equal(failed.data.ok, false);
  assert.equal(failed.data.code, 'E_TTS_FAIL');
  state.failSubmit = false;
});

test('AC-150：工作流导入/界面格式/多文本候选/恢复默认', async () => {
  await resetAll();
  const custom = {
    '1': { class_type: 'FB_Qwen3TTSCustomVoice', inputs: { text: 'x', speaker: 'Vivian' } },
    '2': { class_type: 'PreviewAudio', inputs: { audio: ['1', 0] } },
  };
  let out = await post('/voice/workflow', { workflow: custom, name: 'custom.json' });
  assert.equal(out.data.ok, true);
  assert.equal(out.data.workflow.source, 'imported');
  assert.equal(out.data.workflow.format, 'api');
  assert.equal(out.data.workflow.textNode, '1');

  const brokenUi = {
    nodes: [{ id: 1, type: 'FB_Qwen3TTSCustomVoice', mode: 0, widgets_values: [], inputs: [], outputs: [] }],
    links: [],
  };
  out = await post('/voice/workflow', { workflow: brokenUi });
  assert.equal(out.data.ok, false);
  assert.equal(out.data.code, 'E_TTS_WORKFLOW');
  assert.equal((await get('/voice/workflow')).data.workflow.source, 'imported');

  out = await post('/voice/workflow', { workflow: { '1': { class_type: 'PreviewAudio', inputs: {} } } });
  assert.equal(out.data.ok, false);
  assert.equal(out.data.code, 'E_TTS_WORKFLOW');

  const multi = {
    '1': { class_type: 'FB_Qwen3TTSCustomVoice', inputs: { text: 'a', speaker: 'Vivian' } },
    '2': { class_type: 'FB_Qwen3TTSCustomVoice', inputs: { text: 'b', speaker: 'Serena' } },
    '3': { class_type: 'PreviewAudio', inputs: { audio: ['2', 0] } },
  };
  await post('/voice', { textNode: '' });
  out = await post('/voice/workflow', { workflow: multi });
  assert.equal(out.data.ok, false);
  assert.equal(out.data.code, 'E_TTS_WORKFLOW_NODE');
  assert.equal(out.data.candidates.length, 2);
  out = await post('/voice/workflow', { workflow: multi, textNode: '2' });
  assert.equal(out.data.ok, true);
  assert.equal(out.data.workflow.textNode, '2');

  out = await post('/voice/workflow', { reset: true });
  assert.equal(out.data.ok, true);
  assert.equal(out.data.workflow.source, 'default');
  assert.equal(out.data.workflow.textNode, '1');
});

test('AC-153：默认/导入/恢复音色表，换音色不改工作流', async () => {
  await resetAll();
  const before = workflowPayload();
  assert.equal(before.source, 'default');
  assert.equal(before.textNode, '1');

  // 试听请求显式带音色：不依赖「保存」是否先落盘，避免不同音色听到同一段
  state.prompts = [];
  let preview = await post('/voice/probe', { text: '显式 Serena', comfyVoice: 'Serena' });
  assert.equal(preview.status, 200);
  assert.equal(state.prompts.at(-1).speaker, 'Serena');
  preview = await post('/voice/probe', { text: '显式 Dylan', comfyVoice: 'Dylan' });
  assert.equal(preview.status, 200);
  assert.equal(state.prompts.at(-1).speaker, 'Dylan');
  const headerPreview = await fetch(baseUrl + '/dsh-book-slides/voice/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '响应头音色', comfyVoice: 'Serena' }),
  });
  assert.equal(headerPreview.headers.get('x-tts-voice'), 'Serena');
  await headerPreview.arrayBuffer();

  await post('/voice', { comfyVoice: 'Serena' });
  preview = await post('/voice/probe', { text: '换音色' });
  assert.equal(preview.status, 200);
  assert.equal(state.prompts.at(-1).speaker, 'Serena');
  assert.equal(workflowPayload().source, 'default');
  assert.equal(workflowPayload().textNode, '1');

  const table = {
    name: '三音色表',
    model: 'OtherModel',
    speakers: [
      { name: 'Serena', style: '柔和', lang: '中文', default: true },
      { name: 'Nova', style: '测试', lang: '英文' },
      { name: 'Kai', style: '测试', lang: '中文' },
    ],
  };
  let out = await post('/voice/speakers', { table });
  assert.equal(out.data.ok, true);
  assert.equal(out.data.table.count, 3);
  assert.equal(out.data.table.defaultVoice, 'Serena');
  assert.equal(out.data.table.source, 'imported');

  out = await post('/voice/speakers', { table: { speakers: [{ name: 'Serena' }, { name: 'Serena' }] } });
  assert.equal(out.data.ok, false);
  assert.equal(out.data.code, 'E_TTS_VOICE_TABLE');
  assert.equal((await get('/voice/speakers')).data.table.count, 3);

  const tooMany = { speakers: Array.from({ length: 201 }, (_, index) => ({ name: 'S' + index })) };
  out = await post('/voice/speakers', { table: tooMany });
  assert.equal(out.data.ok, false);
  assert.equal(out.data.code, 'E_TTS_VOICE_TABLE');

  out = await post('/voice/speakers', { reset: true });
  assert.equal(out.data.ok, true);
  assert.equal(out.data.table.count, 9);
  assert.equal(out.data.table.defaultVoice, 'Vivian');

  // custom_speaker_name 非空会覆盖 speaker；切换音色时必须清空它
  const customSpeakerWorkflow = {
    '1': { class_type: 'FB_Qwen3TTSCustomVoice', inputs: { text: 'x', speaker: 'Vivian', custom_speaker_name: 'Vivian' } },
    '2': { class_type: 'PreviewAudio', inputs: { audio: ['1', 0] } },
  };
  out = await post('/voice/workflow', { workflow: customSpeakerWorkflow, name: 'custom-speaker.json' });
  assert.equal(out.data.ok, true);
  state.prompts = [];
  preview = await post('/voice/probe', { text: '清空自定义音色', comfyVoice: 'Serena' });
  assert.equal(preview.status, 200);
  assert.equal(state.prompts.at(-1).speaker, 'Serena');
  assert.equal(state.prompts.at(-1).custom, '');
  await post('/voice/workflow', { reset: true });

  // 导入新表时，把已保存的 Uncle_Fu 迁移成表里的 Uncle_fu
  await post('/voice', { comfyVoice: 'Uncle_Fu' });
  const sourceTable = JSON.parse(fs.readFileSync(new URL('../doc/comfyui/qwen3-tts-voices.json', import.meta.url), 'utf8'));
  out = await post('/voice/speakers', { table: sourceTable, name: 'qwen3-tts-voices.json' });
  assert.equal(out.data.ok, true);
  const afterImport = await get('/voice');
  assert.equal(afterImport.data.voice.comfyVoice, 'Uncle_fu');
  const savedVoice = JSON.parse(fs.readFileSync(path.join(ROOT, 'voice.json'), 'utf8'));
  assert.equal(savedVoice.comfyVoice, 'Uncle_fu');
});

test('AC-154/155：模型支持标记、部分回落、全不支持拦截', async () => {
  await resetAll();
  state.speakers = ['Vivian', 'Serena', 'Uncle_fu', 'Ono_anna'];
  let probe = await post('/voice/comfy/probe', {});
  assert.equal(probe.data.ok, true);
  assert.equal(probe.data.voiceTable.unsupported.includes('Uncle_fu'), false);
  assert.equal(probe.data.voiceTable.unsupported.includes('Ono_anna'), false);

  // 模型列表用空格、音色表用下划线：不能因此回落到 Vivian
  let preview = await post('/voice/probe', { text: '下划线音色', comfyVoice: 'Uncle_Fu' });
  assert.equal(preview.status, 200);
  assert.equal(state.prompts.at(-1).speaker, 'Uncle_fu');
  const headerPreview = await fetch(baseUrl + '/dsh-book-slides/voice/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '精确值响应头', comfyVoice: 'Uncle_Fu' }),
  });
  assert.equal(headerPreview.headers.get('x-tts-voice'), 'Uncle_fu');
  assert.equal(headerPreview.headers.get('x-tts-voice-label'), 'Uncle Fu');
  await headerPreview.arrayBuffer();
  preview = await post('/voice/probe', { text: '下划线音色 2', comfyVoice: 'Ono_Anna' });
  assert.equal(preview.status, 200);
  assert.equal(state.prompts.at(-1).speaker, 'Ono_anna');

  // 表里写显示名、模型枚举是 API 名时，请求要发模型能接受的精确值
  await post('/voice/speakers', { table: { speakers: [{ name: 'Uncle Fu', default: true }] } });
  state.speakers = ['Uncle_fu'];
  preview = await post('/voice/probe', { text: '模型精确名', comfyVoice: 'Uncle Fu' });
  assert.equal(preview.status, 200);
  assert.equal(state.prompts.at(-1).speaker, 'Uncle_fu');
  await post('/voice/speakers', { reset: true });

  state.speakers = ['Vivian', 'Serena'];
  probe = await post('/voice/comfy/probe', {});
  assert.equal(probe.data.ok, true);
  assert.equal(probe.data.voiceTable.unsupported.length, 7);

  await post('/voice', { comfyVoice: 'Dylan' });
  preview = await post('/voice/probe', { text: '部分回落' });
  assert.equal(preview.status, 200);
  assert.equal(state.prompts.at(-1).speaker, 'Vivian');

  const allUnsupported = {
    speakers: Array.from({ length: 9 }, (_, index) => ({ name: 'X' + index, default: index === 0 })),
  };
  await post('/voice/speakers', { table: allUnsupported });
  const countBefore = state.prompts.length;
  probe = await post('/voice/comfy/probe', {});
  assert.equal(probe.data.voiceTable.unsupported.length, 9);
  preview = await post('/voice/probe', { text: '全不支持' });
  assert.equal(preview.data.ok, false);
  assert.equal(preview.data.code, 'E_TTS_SPEAKER');
  assert.equal(state.prompts.length, countBefore);
});

test('AC-151：逐页落盘、缓存、force 与单页失败', async () => {
  await resetAll();
  const { series, found } = makeSeries('cache');
  let out = await post('/revoice', { seriesId: series.id });
  assert.equal(out.data.ok, true);
  let job = await waitJob(out.data.jobId, (item) => ['done', 'failed', 'cancelled'].includes(String(item.status)));
  assert.equal(job.status, 'done');
  assert.equal(state.prompts.length, 6);
  let doc = readSlides(found);
  assert.equal(doc.slides.length, 6);
  for (const slide of doc.slides) {
    assert.equal(slide.audio_provider, 'comfyui-tts');
    assert.match(slide.audio_file, /^audio\/\d{3}\.flac$/);
    assert.ok(fs.statSync(path.join(found.dir, 'lectures', '1', slide.audio_file)).size > 0);
  }
  const lecture = loadLecture(found.dir, 1);
  assert.equal(lecture.lecture.voice_status, 'ready');
  const audio = await get('/audio?seriesId=' + series.id + '&lecture=1&i=1');
  assert.equal(audio.status, 200);
  assert.match(audio.type, /audio\/flac/);
  const plan = await get('/export/pptx/plan?seriesId=' + series.id + '&lecture=1');
  assert.equal(plan.data.ok, true);
  assert.match((plan.data.plan.lectures[0].warnings || []).join('；'), /flac/);

  const before = state.prompts.length;
  out = await post('/revoice', { seriesId: series.id });
  job = await waitJob(out.data.jobId, (item) => ['done', 'failed', 'cancelled'].includes(String(item.status)));
  assert.equal(job.status, 'done');
  assert.equal(state.prompts.length, before);

  out = await post('/revoice', { seriesId: series.id, force: true });
  job = await waitJob(out.data.jobId, (item) => ['done', 'failed', 'cancelled'].includes(String(item.status)));
  assert.equal(job.status, 'done');
  assert.equal(state.prompts.length, before + 6);

  state.failText = '第3页';
  out = await post('/revoice', { seriesId: series.id, force: true });
  job = await waitJob(out.data.jobId, (item) => ['done', 'failed', 'cancelled'].includes(String(item.status)));
  assert.equal(job.status, 'done');
  doc = readSlides(found);
  assert.equal(doc.slides[2].audio_provider, 'none');
  assert.equal(doc.slides[2].audio_file, null);
  assert.equal(doc.voice_status, 'partial');
  const patched = findSeries(series.id);
  assert.equal(patched.series.voice_status, 'partial');
  assert.equal(patched.series.voice_code, 'E_TTS_FAIL');
});

test('AC-152：配音与试听共用串行队列；取消不残留 voicing', async () => {
  await resetAll();
  const { series, found } = makeSeries('queue');
  state.delay = 200;
  const jobOut = await post('/revoice', { seriesId: series.id });
  const previewPromise = post('/voice/probe', { text: '排队试听' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const preview = await previewPromise;
  const job = await waitJob(jobOut.data.jobId, (item) => ['done', 'failed', 'cancelled'].includes(String(item.status)));
  assert.equal(preview.status, 200);
  assert.equal(job.status, 'done');
  assert.equal(state.maxActive, 1);

  state.delay = 500;
  const cancelledOut = await post('/revoice', { seriesId: series.id, force: true });
  await new Promise((resolve) => setTimeout(resolve, 80));
  const cancelled = await post('/revoice/cancel', { jobId: cancelledOut.data.jobId });
  assert.equal(cancelled.data.ok, true);
  const final = await waitJob(cancelledOut.data.jobId, (item) => item.status === 'cancelled' || item.status === 'done', 12000);
  assert.equal(final.status, 'cancelled');
  const lecture = loadLecture(found.dir, 1);
  assert.notEqual(lecture.lecture.voice_status, 'voicing');
});

test('BOM：带 UTF-8 BOM 的音色表也能读', async () => {
  await resetAll();
  const table = { version: 1, name: 'BOM 表', speakers: [{ name: 'Serena', default: true }] };
  fs.writeFileSync(path.join(ROOT, 'comfy-tts-voices.json'), '\uFEFF' + JSON.stringify(table), 'utf8');
  const out = await get('/voice/speakers');
  assert.equal(out.data.ok, true);
  assert.equal(out.data.table.count, 1);
  assert.equal(out.data.table.defaultVoice, 'Serena');
  await post('/voice/speakers', { reset: true });
});

test('默认音色表与 doc/comfyui 源文件保持一致', () => {
  const packaged = JSON.parse(fs.readFileSync(new URL('../workflows/qwen3-tts-voices.json', import.meta.url), 'utf8'));
  const source = JSON.parse(fs.readFileSync(new URL('../doc/comfyui/qwen3-tts-voices.json', import.meta.url), 'utf8'));
  assert.deepEqual(packaged.speakers.map((item) => item.name), source.speakers.map((item) => item.name));
});

test('设置页：ComfyUI 语音、音色表、连接/试听测试与一致性提示入口', () => {
  const src = fs.readFileSync(new URL('../v2/client.js', import.meta.url), 'utf8');
  assert.match(src, /comfyui-tts/);
  assert.match(src, /导入音色表/);
  assert.match(src, /连接测试/);
  assert.match(src, /试听/);
  assert.match(src, /音色表与当前模型不完全一致/);
  assert.match(src, /blm-tts-workflow-input/);
  assert.match(src, /blm-tts-table-input/);
  assert.match(src, /确认导入/);
  assert.match(src, /\\uFEFF/);
});

test.after(() => {
  server.close();
  comfy.close();
});
