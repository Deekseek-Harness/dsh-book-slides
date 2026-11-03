/**
 * v1.5 导出 PPT —— 计划/资格/只读测试（附录 O.11 的 AC-63 / AC-65 / AC-66 / AC-67）。
 *
 *   node test/pptexport.test.mjs
 *
 * 数据根指到临时目录；模块是手工造的，不调模型、不调 TTS。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AUDIO_ICON_PATH } from '../pptx.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-pptx-plan-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const BOOK_ID = 'aaaaaaaaaaaa';
const MODULE_ID = 'bbbbbbbbbbbb';
const BOOK_DIR = path.join(ROOT, 'books', BOOK_ID);
const MODULE_DIR = path.join(BOOK_DIR, 'modules', MODULE_ID);
fs.mkdirSync(path.join(MODULE_DIR, 'audio'), { recursive: true });
fs.mkdirSync(path.join(MODULE_DIR, 'images'), { recursive: true });

function wavBuffer(seconds = 0.1) {
  const rate = 8000;
  const samples = Math.round(rate * seconds);
  const data = samples * 2;
  const buffer = Buffer.alloc(44 + data);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + data, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(data, 40);
  return buffer;
}

const VALID_WAV = wavBuffer();
fs.writeFileSync(path.join(MODULE_DIR, 'audio', '001.wav'), VALID_WAV);
fs.copyFileSync(AUDIO_ICON_PATH, path.join(MODULE_DIR, 'images', '002.png'));

fs.writeFileSync(
  path.join(BOOK_DIR, 'book.json'),
  JSON.stringify({
    title: '故事/材质：结构',
    author: '罗伯特·麦基',
    pages: 40,
    chapterCount: 3,
    chars: 12000,
    sha256: 'x'.repeat(64),
    schemaVersion: 1,
  }),
);

function writeModule(status) {
  fs.writeFileSync(
    path.join(MODULE_DIR, 'module.json'),
    JSON.stringify({
      id: MODULE_ID,
      bookId: BOOK_ID,
      title: '精讲：第 1–3 章',
      status: status,
      chapters: [1, 2, 3],
      chapterTitles: ['一', '二', '三'],
      slides: 2,
      anchorHitRate: 1,
      voice: { provider: 'qwen3-tts', voice: 'Cherry', rate: 1 },
      createdAt: '2026-11-04T00:00:00.000Z',
      updatedAt: '2026-11-04T00:00:00.000Z',
    }),
  );
}

function writeSlides() {
  fs.writeFileSync(
    path.join(MODULE_DIR, 'slides.json'),
    JSON.stringify({
      schema_version: 1,
      module_id: MODULE_ID,
      book_id: BOOK_ID,
      module_title: '精讲：第 1–3 章',
      chapters: [1, 2, 3],
      voice: { provider: 'qwen3-tts', mode: 'file', model: 'qwen3-tts-flash', voice: 'Cherry', rate: 1 },
      anchor_hit_rate: 1,
      slides: [
        {
          slide_index: 1,
          layout: 'cover',
          title: '电影主题',
          subtitle: '从《故事》看主题选择',
          audio_script: '第一页台词。',
          audio_file: 'audio/001.wav',
          audio_provider: 'qwen3-tts',
          source_pages: { from: 1, to: 2 },
        },
        {
          slide_index: 2,
          layout: 'content_text',
          title: '创作的核心',
          bullet_points: ['一', '二'],
          audio_script: '第二页台词。',
          audio_file: null,
          audio_provider: 'browser',
          image_status: 'ready',
          image_file: 'images/002.png',
          source_pages: { from: 3, to: 4 },
        },
      ],
    }),
  );
}

writeModule('ready');
writeSlides();

const { assertPptxEligible, buildPptxPlan, planPptx } = await import('../pptexport.js');
const { buildPptxBuffer } = await import('../pptx.js');

function snapshot(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = fs.statSync(full);
        out.push(full + '|' + stat.size + '|' + stat.mtimeMs);
      }
    }
  };
  walk(dir);
  return out.sort().join('\n');
}

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('ready 模块：页数、音频页、配图页、缺页与字节', () => {
  const built = buildPptxPlan(MODULE_ID);
  const plan = built.plan;
  assert.equal(plan.ok, true);
  assert.equal(plan.slides, 2);
  assert.equal(plan.audioPages, 1);
  assert.equal(plan.imagePages, 1);
  assert.deepEqual(plan.missingAudio, [2]);
  assert.equal(plan.bytes > 0, true);
  assert.match(plan.warnings.join('；'), /1\/2 页没有音频/);
  assert.match(plan.fileName, /^故事_材质：结构-精讲-第 1–3 章\.pptx$/);
  assert.equal(built.deck.slides[0].audio.path, path.join(MODULE_DIR, 'audio', '001.wav'));
  assert.ok(built.deck.slides[0].audio.durationMs > 0);
  assert.equal(built.deck.slides[1].image.width, 64);
});

test('audio=0 仍报真实音频页数，但体积更小且 deck 不带音频', async () => {
  const withAudio = planPptx(MODULE_ID, { includeAudio: true });
  const without = planPptx(MODULE_ID, { includeAudio: false });
  assert.equal(without.audioPages, 1);
  assert.equal(without.includeAudio, false);
  assert.ok(without.bytes < withAudio.bytes);
  assert.match(without.warnings.join('；'), /本次不含音频/);
  const built = buildPptxPlan(MODULE_ID, { includeAudio: false });
  assert.equal(built.deck.slides[0].audio, null);
  const buffer = await buildPptxBuffer(built.deck);
  assert.ok(buffer.length > 0);
});

test('非 RIFF 的 .wav 被跳过，不嵌坏文件', () => {
  const file = path.join(MODULE_DIR, 'audio', '001.wav');
  fs.writeFileSync(file, 'this is not a wav');
  try {
    const plan = planPptx(MODULE_ID);
    assert.equal(plan.audioPages, 0);
    assert.match(plan.warnings.join('；'), /没有可用音频/);
  } finally {
    fs.writeFileSync(file, VALID_WAV);
  }
});

test('生成中 E_PPT_BUSY；失败 E_PPT_NOT_READY；缺 slides E_PPT_EMPTY', () => {
  assert.throws(() => assertPptxEligible('voicing'), (err) => err.code === 'E_PPT_BUSY');
  writeModule('failed');
  try {
    assert.throws(() => planPptx(MODULE_ID), (err) => err.code === 'E_PPT_NOT_READY');
  } finally {
    writeModule('ready');
  }
  const slidesFile = path.join(MODULE_DIR, 'slides.json');
  const saved = fs.readFileSync(slidesFile);
  fs.rmSync(slidesFile);
  try {
    assert.throws(() => planPptx(MODULE_ID), (err) => err.code === 'E_PPT_EMPTY');
  } finally {
    fs.writeFileSync(slidesFile, saved);
  }
});

test('只读：计划与生成前后 books/ 的 size+mtime 不变', async () => {
  const before = snapshot(path.join(ROOT, 'books'));
  const built = buildPptxPlan(MODULE_ID);
  await buildPptxBuffer(built.deck);
  const after = snapshot(path.join(ROOT, 'books'));
  assert.equal(after, before);
});

test('文件名去掉非法字符，保留中文', () => {
  const plan = planPptx(MODULE_ID);
  assert.doesNotMatch(plan.fileName, /[\\/:*?"<>|]/);
  assert.match(plan.fileName, /故事_材质：结构/);
});

test('HTTP 计划与下载：content-type、content-disposition、ZIP 字节', async () => {
  const http = await import('node:http');
  const plugin = await import('../index.js');
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
    get() {
      return undefined;
    },
  };
  plugin.apply(ctx);
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const handler = routes.get(pathname);
    if (!handler) {
      res.statusCode = 404;
      res.end();
      return;
    }
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const plan = await (await fetch(base + '/dsh-book-slides/export/pptx/plan?moduleId=' + MODULE_ID)).json();
    assert.equal(plan.ok, true);
    assert.equal(plan.slides, 2);
    assert.equal(plan.audioPages, 1);
    const response = await fetch(base + '/dsh-book-slides/export/pptx?moduleId=' + MODULE_ID);
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get('content-type') || ''), /presentationml\.presentation/);
    assert.match(String(response.headers.get('content-disposition') || ''), /filename\*=UTF-8''/);
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.slice(0, 2).toString('ascii'), 'PK');
    assert.ok(buffer.length > 1000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
