/**
 * v1.3 本地 ComfyUI VoiceClone 配音（AC-148 ~ AC-156 的核心链路）。
 * 假 ComfyUI 真 HTTP：/system_stats、/object_info、/upload/image、/prompt、/history、/view。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-clone-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { ensureRoot } = await import('../v2/root.js');
ensureRoot();
const { writeImageConfig } = await import('../comfy.js');
const { createBook, writeChapters } = await import('../v2/books.js');
const { savePart } = await import('../v2/parts.js');
const { createSeries, findSeries, patchSeriesLecture, persistSeries } = await import('../v2/series.js');
const { writeLectureOutputs } = await import('../v2/lectures.js');
const { getRevoiceJob } = await import('../v2/voice.js');
const { reconcileVoiceJobs } = await import('../v2/voice.js');
const { routeM1 } = await import('../v2/api.js');
const { applyCloneInputs, refTablePayload } = await import('../v2/comfy-clone.js');

const REF_TEXT = fs
  .readFileSync(new URL('../workflows/qwen3-tts-通过克隆配音/qwen3-tts-1.7B_vivian.txt', import.meta.url), 'utf8')
  .trim();

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
const state = { prompts: [], uploads: 0, ext: 'flac', lastId: '', hang: false };

function cloneInputs(body) {
  const prompt = body && body.prompt && typeof body.prompt === 'object' ? body.prompt : {};
  for (const id of Object.keys(prompt)) {
    if (!/qwen3tts/i.test(String(prompt[id].class_type || ''))) continue;
    const inputs = prompt[id].inputs || {};
    const refNode = Array.isArray(inputs.ref_audio) ? prompt[String(inputs.ref_audio[0])] : null;
    return {
      id,
      text: String(inputs.target_text || ''),
      refText: String(inputs.ref_text || ''),
      xVector: inputs.x_vector_only,
      refAudio: refNode && refNode.inputs ? String(refNode.inputs.audio || '') : '',
    };
  }
  return null;
}

const comfy = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const json = (value) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(value));
  };
  if (url.pathname === '/system_stats') return json({ system: { comfyui_version: '0.3.99' } });
  if (url.pathname === '/object_info') {
    return json({
      FB_Qwen3TTSVoiceClone: { input: { required: { target_text: ['STRING', {}] }, optional: { ref_audio: ['AUDIO', {}] } } },
      LoadAudio: { input: { required: { audio: [['x.flac'], {}] } } },
      SaveAudio: { input: { required: {} } },
    });
  }
  if (url.pathname === '/upload/image') {
    for await (const _ of req) void _;
    state.uploads += 1;
    return json({ name: 'dsh-ref-uploaded-' + state.uploads + '.flac', subfolder: '', type: 'input' });
  }
  if (url.pathname === '/prompt') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const inputs = cloneInputs(body);
    state.prompts.push(inputs);
    state.lastId = 'p' + state.prompts.length;
    return json({ prompt_id: state.lastId });
  }
  if (url.pathname.startsWith('/history/')) {
    if (state.hang) return json({}); // 一直没跑完：客户端按 deadline 判超时（AC-135）
    const id = url.pathname.split('/').pop();
    return json({
      [id]: {
        status: { completed: true, status_str: 'success' },
        outputs: { '7': { audio: [{ filename: 'voice-' + id + '.' + state.ext, subfolder: 'audio', type: 'output' }] } },
      },
    });
  }
  if (url.pathname === '/view') {
    res.setHeader('content-type', 'audio/wav');
    return res.end(WAV);
  }
  res.statusCode = 404;
  res.end('no route');
});
await new Promise((resolve) => comfy.listen(0, '127.0.0.1', resolve));
writeImageConfig({ host: '127.0.0.1', port: comfy.address().port });

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
async function api(method, p, body) {
  const res = await fetch(baseUrl + '/dsh-book-slides' + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = String(res.headers.get('content-type') || '');
  if (type.includes('application/json')) return { status: res.status, data: await res.json(), type };
  return { status: res.status, data: Buffer.from(await res.arrayBuffer()), type };
}

await api('POST', '/voice', { provider: 'comfyui-tts', comfyRefVoice: 'builtin-vivian' });

function waitJob(jobId, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const job = getRevoiceJob(jobId);
      if (job && ['done', 'failed', 'cancelled'].includes(String(job.status))) return resolve(job);
      if (Date.now() - started > timeout) return reject(new Error('等待配音作业超时'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function makeSeries(tag) {
  const book = createBook({
    buffer: Buffer.from('v2-clone-' + tag + '-' + Date.now()),
    fileName: tag + '.pdf',
    title: 'Clone ' + tag,
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
      throughline: 't',
      lectures: [{ n: 1, chapters: [1], title: '第 1 讲', goal: 'g', in: '', out: '', pages: 3, chars: 6000 }],
      seams: [],
      terms: [],
      cut_notes: [],
      source: 'model',
      stitched: true,
      totalChars: 6000,
      totalPages: 3,
      estMinutes: 3,
    },
  });
  const found = findSeries(series.id);
  const slides = [1, 2, 3].map((index) => ({
    slide_index: index,
    layout: index === 1 ? 'cover' : 'content_text',
    title: '第 ' + index + ' 页',
    subtitle: '',
    bullet_points: [],
    quote_text: null,
    quote_source: null,
    image_prompt: '配图',
    audio_script: tag + '第' + index + '页讲稿',
    source_quote: tag.repeat(20),
    source_pages: { from: 1, to: 1 },
    source_anchor: { page: 1, text: tag.repeat(10), rect: null },
    audio_file: null,
    audio_provider: 'none',
    audio_ms: 0,
    image_file: null,
    image_status: 'none',
  }));
  writeLectureOutputs(
    found.dir,
    1,
    { schema: 1, series_id: series.id, n: 1, lecture_id: series.id + '-1', title: '第 1 讲', chapters: [1], pages: 3, chars: 6000, status: 'ready', voice_status: 'none' },
    { schema_version: 1, product_version: '2.0', series_id: series.id, book_id: book.id, lecture: 1, title: '第 1 讲', chapters: [1], slides },
  );
  patchSeriesLecture(found.series, 1, { status: 'ready', pages: 3, chars: 6000 });
  found.series.status = 'ready';
  found.series.voice_status = 'none';
  persistSeries(found.series);
  return { series: found.series, found };
}

test('AC-153：表外参考回落 default，带 fallbackFrom 且不改写 voice.json', async () => {
  const voiceFile = path.join(ROOT, 'voice.json');
  await api('POST', '/voice', { comfyRefVoice: 'missing-voice' });
  assert.equal(JSON.parse(fs.readFileSync(voiceFile, 'utf8')).comfyRefVoice, 'missing-voice');
  const out = await api('GET', '/voice');
  assert.equal(out.data.ok, true);
  assert.equal(out.data.voice.comfyRefVoice, 'builtin-vivian');
  assert.equal(out.data.voice.fallbackFrom, 'missing-voice');
  assert.equal(JSON.parse(fs.readFileSync(voiceFile, 'utf8')).comfyRefVoice, 'missing-voice', '回落不得改写文件');
  await api('POST', '/voice', { comfyRefVoice: 'builtin-vivian' });
});

test('AC-148：ComfyUI 未启动 → E_TTS_CONNECT，/prompt 0 次、不落盘', async () => {
  const probe = http.createServer(() => {});
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const deadPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const cacheDir = path.join(ROOT, 'audio-cache');
  const booksDir = path.join(ROOT, 'books');
  const countFiles = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => (
        sum + (entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1)
      ), 0);
    } catch {
      return 0;
    }
  };
  const filesBefore = countFiles(cacheDir) + countFiles(booksDir);
  const promptsBefore = state.prompts.length;
  writeImageConfig({ host: '127.0.0.1', port: deadPort });
  try {
    const out = await api('POST', '/voice/comfy/probe');
    assert.equal(out.data.ok, false);
    assert.equal(out.data.code, 'E_TTS_CONNECT');
    assert.ok(String(out.data.hint || out.data.message || '').length > 0, '要给出可读原因');
    assert.equal(countFiles(cacheDir) + countFiles(booksDir), filesBefore, '连接失败不得落盘');
    assert.equal(state.prompts.length, promptsBefore, '连接失败不得调 /prompt');
  } finally {
    writeImageConfig({ host: '127.0.0.1', port: comfy.address().port });
  }
});

test('默认参考库：内置 2 项，默认 Vivian，工作流识别 6/7/8', async () => {
  const voice = await api('GET', '/voice');
  assert.equal(voice.data.ok, true);
  assert.equal(voice.data.voice.comfyRefVoice, 'builtin-vivian');
  assert.equal(voice.data.refVoices.count, 2);
  assert.equal(voice.data.refVoices.defaultVoice, 'builtin-vivian');
  assert.equal(voice.data.workflow.textNode, '6');
  assert.equal(voice.data.workflow.outputNode, '7');
  assert.equal(voice.data.workflow.refNode, '8');
  const table = refTablePayload();
  assert.deepEqual(table.voices.map((item) => item.id).sort(), ['builtin-uncle-fu', 'builtin-vivian']);
  assert.ok(table.voices.every((item) => item.ref_text.length > 0 && item.duration_ms > 0));
});

test('连接测试与试听：注入 target_text/ref_text/LoadAudio 文件名，x_vector_only=false', async () => {
  const probe = await api('POST', '/voice/comfy/probe', {});
  assert.equal(probe.data.ok, true);
  assert.equal(probe.data.refVoice.id, 'builtin-vivian');
  assert.equal(probe.data.workflow.refNode, '8');

  state.prompts = [];
  const preview = await api('POST', '/voice/probe', { text: '克隆试听', comfyRefVoice: 'builtin-uncle-fu' });
  assert.equal(preview.status, 200);
  assert.match(preview.type, /audio\//);
  assert.equal(state.prompts.length, 1);
  const sent = state.prompts[0];
  assert.equal(sent.text, '克隆试听');
  assert.equal(sent.refText, REF_TEXT);
  assert.equal(sent.xVector, false);
  assert.match(sent.refAudio, /^dsh-ref-/);
  assert.equal(state.uploads, 1);
});

test('参考库导入/校验/恢复默认', async () => {
  const table = {
    name: '三参考',
    voices: [
      { id: 'a', name: 'A', audio: 'voices/a.flac', ref_text: '甲', default: true },
      { id: 'b', name: 'B', audio: 'voices/b.flac', ref_text: '乙' },
      { id: 'c', name: 'C', audio: 'voices/c.flac', ref_text: '丙' },
    ],
  };
  let out = await api('POST', '/voice/refvoices', { table });
  assert.equal(out.data.ok, true);
  assert.equal(out.data.table.count, 3);
  assert.equal(out.data.table.defaultVoice, 'a');

  out = await api('POST', '/voice/refvoices', { table: { voices: [{ id: 'a', name: 'A', audio: 'voices/a.flac', ref_text: '甲' }, { id: 'a', name: 'A2', audio: 'voices/a2.flac', ref_text: '乙' }] } });
  assert.equal(out.data.ok, false);
  assert.equal(out.data.code, 'E_TTS_VOICE_REF');
  assert.equal((await api('GET', '/voice/refvoices')).data.table.count, 3);

  out = await api('POST', '/voice/refvoices', { table: { voices: [{ id: 'x', name: 'X', audio: 'voices/x.flac', ref_text: '' }] } });
  assert.equal(out.data.code, 'E_TTS_VOICE_REF');

  out = await api('POST', '/voice/refvoices', { reset: true });
  assert.equal(out.data.table.count, 2);
  assert.equal(out.data.table.defaultVoice, 'builtin-vivian');
});

test('成对导入：参考音频 + .txt 复制到 voices/，保留内置项，删除自定义项，恢复默认清空', async () => {
  const text = '这是成对导入的参考文本，必须和音频逐字对应。';
  const form = new FormData();
  form.append('audio', new Blob([makeWav(500)], { type: 'audio/wav' }), '参考样本.wav');
  form.append('ref_text', text);
  const res = await fetch(baseUrl + '/dsh-book-slides/voice/refvoices/import', { method: 'POST', body: form });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.equal(out.table.count, 3);
  assert.equal(out.entry.source, 'imported');
  assert.equal(out.entry.ref_text, text);
  assert.ok(out.entry.duration_ms > 0);
  assert.ok(fs.existsSync(path.join(ROOT, 'voices', path.basename(out.entry.audio))), '音频必须复制到 voices/');
  assert.deepEqual(
    out.table.voices.filter((item) => item.source === 'builtin').map((item) => item.id).sort(),
    ['builtin-uncle-fu', 'builtin-vivian'],
    '导入后内置参考仍在',
  );
  const removed = await api('POST', '/voice/refvoices', { remove: out.entry.id });
  assert.equal(removed.data.ok, true);
  assert.equal(removed.data.table.count, 2);
  assert.ok(removed.data.table.voices.every((item) => item.source === 'builtin'), '删掉最后一个自定义项后回到内置表');
  await api('POST', '/voice/refvoices', { reset: true });
  assert.equal((await api('GET', '/voice/refvoices')).data.table.count, 2);
});

test('成对导入校验：缺 .txt 与不支持的音频格式都拒绝', async () => {
  const missing = new FormData();
  missing.append('audio', new Blob([makeWav()], { type: 'audio/wav' }), 'no-text.wav');
  const res = await fetch(baseUrl + '/dsh-book-slides/voice/refvoices/import', { method: 'POST', body: missing });
  const out = await res.json();
  assert.equal(out.ok, false);
  assert.equal(out.code, 'E_TTS_VOICE_REF');

  const wrong = new FormData();
  wrong.append('audio', new Blob([Buffer.alloc(2048, 1)], { type: 'application/octet-stream' }), 'bad.txt');
  wrong.append('ref_text', '参考文本');
  const res2 = await fetch(baseUrl + '/dsh-book-slides/voice/refvoices/import', { method: 'POST', body: wrong });
  const out2 = await res2.json();
  assert.equal(out2.ok, false);
  assert.equal(out2.code, 'E_TTS_VOICE_REF');

  const builtin = await api('POST', '/voice/refvoices', { remove: 'builtin-vivian' });
  assert.equal(builtin.data.ok, false);
  assert.equal(builtin.data.code, 'E_TTS_VOICE_REF');
});

test('工作流校验：x_vector_only=true 拒绝；UI 格式可转换', async () => {
  const bad = {
    '1': { class_type: 'FB_Qwen3TTSVoiceClone', inputs: { target_text: 'x', ref_text: 'y', x_vector_only: true, ref_audio: ['2', 0] } },
    '2': { class_type: 'LoadAudio', inputs: { audio: 'a.flac' } },
    '3': { class_type: 'SaveAudio', inputs: { audio: ['1', 0] } },
  };
  let out = await api('POST', '/voice/workflow', { workflow: bad });
  assert.equal(out.data.ok, false);
  assert.equal(out.data.code, 'E_TTS_WORKFLOW_NODE');

  const ui = {
    nodes: [
      { id: 1, type: 'FB_Qwen3TTSVoiceClone', mode: 0, widgets_values_named: { target_text: 'x', ref_text: 'y', x_vector_only: false, model_choice: '1.7B' }, inputs: [{ name: 'ref_audio', link: 9 }], outputs: [] },
      { id: 2, type: 'LoadAudio', mode: 0, widgets_values_named: { audio: 'a.flac' }, inputs: [], outputs: [] },
      { id: 3, type: 'SaveAudio', mode: 0, widgets_values_named: {}, inputs: [{ name: 'audio', link: 10 }], outputs: [] },
    ],
    links: [[9, 2, 0, 1, 0, 'AUDIO'], [10, 1, 0, 3, 0, 'AUDIO']],
  };
  out = await api('POST', '/voice/workflow', { workflow: ui, name: 'ui.json' });
  assert.equal(out.data.ok, true);
  assert.equal(out.data.workflow.source, 'imported');
  assert.equal(out.data.workflow.textNode, '1');
  await api('POST', '/voice/workflow', { reset: true });
});

test('AC-154：超时长参考给 warning；不可解码 flac 被拒且旧表不变', async () => {
  const longTable = { voices: [{ id: 'long', name: 'Long', audio: 'voices/long.wav', ref_text: '参考文本', duration_ms: 40000 }] };
  const saved = await api('POST', '/voice/refvoices', { table: longTable });
  assert.equal(saved.data.ok, true);
  const longEntry = (saved.data.table.voices || []).find((item) => item.id === 'long');
  assert.equal(longEntry.duration_level, 'warn', '40s 表项应带 warn 级别');
  assert.match(longEntry.duration_text, /超出推荐 5–15s/, '表项要带可渲染的 warning 文案');
  assert.match(longEntry.duration_text, /建议截短/, 'warning 要给出处理建议');

  // 21.3s 内置参考在容忍区：连接测试不告警，只给中性提示（AC-154 ①）。
  await api('POST', '/voice/refvoices', { reset: true });
  await api('POST', '/voice', { comfyRefVoice: 'builtin-vivian' });
  const calm = await api('POST', '/voice/comfy/probe', { comfyRefVoice: 'builtin-vivian' });
  assert.equal(calm.data.ok, true);
  assert.equal(calm.data.refVoice.duration_level, 'tip');
  assert.match(calm.data.refVoice.duration_text, /容忍区/);
  assert.equal(
    (calm.data.warnings || []).some((text) => String(text).includes('超出推荐')),
    false,
    '21.3s 属容忍区，不得告警：' + JSON.stringify(calm.data.warnings),
  );

  // 连接测试按请求里的 comfyRefVoice（当前下拉选中项）检查，而不是 voice.json 里的旧值。
  await api('POST', '/voice/refvoices', { table: longTable });
  const explicit = await api('POST', '/voice/comfy/probe', { comfyRefVoice: 'long' });
  assert.equal(explicit.data.ok, true);
  assert.equal(explicit.data.refVoice.id, 'long');
  const probeText = (explicit.data.warnings || []).join('；');
  assert.match(probeText, /超出推荐 5–15s/, '40s 参考应给时长 warning：' + JSON.stringify(explicit.data.warnings));
  assert.match(probeText, /Long/, 'warning 要点名是哪个参考');
  assert.match(probeText, /建议截短/, 'warning 要给出处理建议');

  // 导入接口直接回传时长提示，UI 不需要自己算（也不会因为没跑连接测试而看不到）。
  const formData = new FormData();
  formData.append('audio', new Blob([makeWav(40000)], { type: 'audio/wav' }), 'long-import.wav');
  formData.append('ref_text', '参考文本');
  const importedRes = await fetch(baseUrl + '/dsh-book-slides/voice/refvoices/import', { method: 'POST', body: formData });
  const imported = await importedRes.json();
  assert.equal(imported.ok, true);
  assert.equal(imported.entry.duration_level, 'warn');
  assert.match(imported.entry.duration_text, /超出推荐 5–15s/);

  const voicesDir = path.join(ROOT, 'voices');
  fs.mkdirSync(voicesDir, { recursive: true });
  fs.writeFileSync(path.join(voicesDir, 'bad.flac'), 'not-a-flac');
  const before = (await api('GET', '/voice/refvoices')).data.table.count;
  const bad = await api('POST', '/voice/refvoices', {
    table: { voices: [{ id: 'bad', name: 'Bad', audio: 'voices/bad.flac', ref_text: '参考文本' }] },
  });
  assert.equal(bad.data.ok, false);
  assert.equal(bad.data.code, 'E_TTS_VOICE_REF');
  assert.equal((await api('GET', '/voice/refvoices')).data.table.count, before, '坏表不得覆盖旧表');
  await api('POST', '/voice/refvoices', { reset: true });
  await api('POST', '/voice', { comfyRefVoice: 'builtin-vivian' });
});

test('AC-152：重启后 voicing 归一为 partial，已完成页保留', async () => {
  const { series, found } = makeSeries('restart');
  const slidesPath = path.join(found.dir, 'lectures', '1', 'slides.json');
  const doc = JSON.parse(fs.readFileSync(slidesPath, 'utf8'));
  doc.slides[0] = Object.assign({}, doc.slides[0], { audio_file: 'audio/001.wav', audio_provider: 'comfyui-tts' });
  fs.writeFileSync(slidesPath, JSON.stringify(doc, null, 2));
  const lecturePath = path.join(found.dir, 'lectures', '1', 'lecture.json');
  const lecture = JSON.parse(fs.readFileSync(lecturePath, 'utf8'));
  lecture.voice_status = 'voicing';
  fs.writeFileSync(lecturePath, JSON.stringify(lecture, null, 2));
  const foundNow = findSeries(series.id);
  foundNow.series.voice_status = 'voicing';
  persistSeries(foundNow.series);

  reconcileVoiceJobs();

  const after = findSeries(series.id);
  assert.equal(after.series.voice_status, 'partial');
  assert.equal(after.series.voice_code, 'E_INTERRUPTED');
  assert.equal(after.series.lectures[0].voice_status, 'partial');
  const lectureAfter = JSON.parse(fs.readFileSync(lecturePath, 'utf8'));
  assert.equal(lectureAfter.voice_status, 'partial');
  assert.equal(lectureAfter.voice_code, 'E_INTERRUPTED');
  assert.match(lectureAfter.voice_error, /中断/);
  const slidesAfter = JSON.parse(fs.readFileSync(slidesPath, 'utf8'));
  assert.equal(slidesAfter.slides[0].audio_file, 'audio/001.wav', '已完成页的音频字段必须保留');
});

test('AC-150：界面格式缺 widgets / 无 TTS 节点 / 多候选手选落盘', async () => {
  let out = await api('POST', '/voice/workflow', {
    workflow: { nodes: [{ id: 1, type: 'FB_Qwen3TTSVoiceClone', mode: 0, inputs: [], outputs: [] }], links: [] },
  });
  assert.equal(out.data.ok, false);
  assert.equal(out.data.code, 'E_TTS_WORKFLOW');

  out = await api('POST', '/voice/workflow', {
    workflow: {
      '1': { class_type: 'LoadAudio', inputs: { audio: 'a.flac' } },
      '2': { class_type: 'SaveAudio', inputs: { audio: ['1', 0] } },
    },
  });
  assert.equal(out.data.code, 'E_TTS_WORKFLOW');

  const twoClones = {
    '1': { class_type: 'FB_Qwen3TTSVoiceClone', inputs: { target_text: '甲', ref_text: 'r', x_vector_only: false, ref_audio: ['3', 0] } },
    '2': { class_type: 'FB_Qwen3TTSVoiceClone', inputs: { target_text: '乙', ref_text: 'r', x_vector_only: false, ref_audio: ['4', 0] } },
    '3': { class_type: 'LoadAudio', inputs: { audio: 'a.flac' } },
    '4': { class_type: 'LoadAudio', inputs: { audio: 'b.flac' } },
    '5': { class_type: 'SaveAudio', inputs: { audio: ['1', 0] } },
  };
  out = await api('POST', '/voice/workflow', { workflow: twoClones });
  assert.equal(out.data.code, 'E_TTS_WORKFLOW_NODE');
  assert.equal(out.data.candidates.length, 2, '多候选要回传 candidates');
  out = await api('POST', '/voice/workflow', { workflow: twoClones, textNode: '1' });
  assert.equal(out.data.ok, true);
  assert.equal(out.data.workflow.textNode, '1');
  const voice = JSON.parse(fs.readFileSync(path.join(ROOT, 'voice.json'), 'utf8'));
  assert.equal(voice.textNode, '1', '手选后落盘 voice.json.textNode');
  await api('POST', '/voice/workflow', { reset: true });
});

test('逐页配音、缓存与换参考失效', async () => {
  const { series, found } = makeSeries('clone');
  state.prompts = [];
  let out = await api('POST', '/revoice', { seriesId: series.id });
  let job = await waitJob(out.data.jobId);
  assert.equal(job.status, 'done');
  assert.equal(state.prompts.length, 3);
  const slides = JSON.parse(fs.readFileSync(path.join(found.dir, 'lectures', '1', 'slides.json'), 'utf8')).slides;
  for (const slide of slides) assert.equal(slide.audio_provider, 'comfyui-tts');

  const before = state.prompts.length;
  out = await api('POST', '/revoice', { seriesId: series.id });
  job = await waitJob(out.data.jobId);
  assert.equal(job.status, 'done');
  assert.equal(state.prompts.length, before, '同文本同参考应命中缓存');

  await api('POST', '/voice', { comfyRefVoice: 'builtin-uncle-fu' });
  out = await api('POST', '/revoice', { seriesId: series.id });
  job = await waitJob(out.data.jobId);
  assert.equal(job.status, 'done');
  assert.equal(state.prompts.length, before + 3, '换参考后缓存键变化');
  assert.ok(state.prompts.slice(-3).every((item) => item.refText === REF_TEXT));
});

test('文本入口隔离：只改 target_text，不碰 ref_text', () => {
  const apiPrompt = {
    '1': { class_type: 'FB_Qwen3TTSVoiceClone', inputs: { target_text: '旧正文', ref_text: '参考文本', x_vector_only: false, ref_audio: ['2', 0] } },
    '2': { class_type: 'LoadAudio', inputs: { audio: 'ref.flac' } },
    '3': { class_type: 'SaveAudio', inputs: { audio: ['1', 0] } },
  };
  const out = applyCloneInputs(apiPrompt, '新正文', { id: 'r', ref_text: '参考文本', name: 'R' }, 'uploaded.flac', '1');
  assert.equal(out.workflow['1'].inputs.target_text, '新正文');
  assert.equal(out.workflow['1'].inputs.ref_text, '参考文本');
  assert.equal(out.workflow['1'].inputs.x_vector_only, false);
  assert.equal(out.workflow['2'].inputs.audio, 'uploaded.flac');
});

test('AC-135：ComfyUI 配音超时 → E_TTS_TIMEOUT，不留半截音频', async () => {
  const { series, found } = makeSeries('tts-timeout');
  state.hang = true;
  process.env.DSH_BOOK_SLIDES_TTS_TIMEOUT_MS = '1000';
  try {
    const started = await api('POST', '/revoice', { seriesId: series.id, lecture: 1 });
    assert.equal(started.data.ok, true);
    const job = await waitJob(started.data.jobId, 20000);
    assert.ok(['done', 'failed'].includes(String(job.status)), 'job 状态：' + job.status);
    const seriesOut = await api('GET', '/series?seriesId=' + series.id);
    assert.equal(seriesOut.data.series.voice_code, 'E_TTS_TIMEOUT');
    const audioDir = path.join(found.dir, 'lectures', '1', 'audio');
    const files = fs.existsSync(audioDir) ? fs.readdirSync(audioDir).filter((name) => /\.(wav|mp3|flac|ogg)$/.test(name)) : [];
    assert.deepEqual(files, [], '超时不得留下半截音频');
  } finally {
    state.hang = false;
    delete process.env.DSH_BOOK_SLIDES_TTS_TIMEOUT_MS;
  }
});

test.after(() => {
  server.close();
  comfy.close();
});
