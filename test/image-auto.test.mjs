/**
 * 生成 → 后台配图 的接线测试（v1.4，AC-54 的自动路径）
 *
 *   node test/image-auto.test.mjs
 *
 * 真 HTTP + 假模型 + 假 ComfyUI：点生成后模块先 ready，配图作业随后自动开跑；
 * 不需要用户再点一次「补配图」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { makePdf } from './fixture.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-imgauto-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const plugin = await import('../index.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let replies = [];
const fakeLlm = {
  async prepareCall() {
    return {
      config: {},
      async *stream() {
        const chunks = replies.shift() || [];
        for (const chunk of chunks) yield chunk;
      },
    };
  },
};

function makeContext() {
  const routes = new Map();
  const prefixes = new Map();
  const scoped = {
    webServer: {
      register(options) {
        const table = options.kind === 'prefix' ? prefixes : routes;
        table.set(options.path, options.handler);
        return () => table.delete(options.path);
      },
    },
    commands: { register: () => () => {} },
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
  return { ctx, routes, prefixes };
}

const { ctx, routes, prefixes } = makeContext();
plugin.apply(ctx);

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  let handler = routes.get(url.pathname);
  if (!handler) {
    for (const [prefix, candidate] of prefixes) {
      if (url.pathname === prefix || url.pathname.startsWith(prefix + '/')) {
        handler = candidate;
        break;
      }
    }
  }
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

/* ------------------------------ 假 ComfyUI ------------------------------ */

let comfyPrompts = 0;
const comfy = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const send = (status, type, body) => {
    res.statusCode = status;
    res.setHeader('content-type', type);
    res.end(body);
  };
  if (url.pathname === '/system_stats') {
    send(200, 'application/json', JSON.stringify({ system: { comfyui_version: '0.3.40' } }));
    return;
  }
  if (url.pathname.startsWith('/object_info/')) {
    const map = {
      UNETLoader: { unet_name: ['z_image_turbo_bf16.safetensors'] },
      CLIPLoader: { clip_name: ['qwen_3_4b.safetensors'] },
      VAELoader: { vae_name: ['ae.safetensors'] },
    };
    const cls = url.pathname.split('/').pop();
    const field = Object.keys(map[cls] || {})[0];
    const info = {};
    info[cls] = field ? { input: { required: { [field]: [map[cls][field]] } } } : { input: { required: {} } };
    send(200, 'application/json', JSON.stringify(info));
    return;
  }
  if (url.pathname === '/prompt') {
    comfyPrompts += 1;
    send(200, 'application/json', JSON.stringify({ prompt_id: 'auto' + comfyPrompts }));
    return;
  }
  if (url.pathname.startsWith('/history/')) {
    const id = url.pathname.split('/').pop();
    send(
      200,
      'application/json',
      JSON.stringify({
        [id]: {
          status: { status_str: 'success', completed: true },
          outputs: { 9: { images: [{ filename: 'auto_' + id + '.png', subfolder: '', type: 'output' }] } },
        },
      }),
    );
    return;
  }
  if (url.pathname === '/view') {
    send(200, 'image/png', PNG);
    return;
  }
  send(404, 'text/plain', 'no');
});
await new Promise((resolve) => comfy.listen(0, '127.0.0.1', resolve));
const comfyPort = comfy.address().port;

/* ------------------------------ 导入 + 假模型回复 ------------------------------ */

const imported = await fetch(base + '/dsh-book-slides/import', {
  method: 'POST',
  headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent('配图接线书.pdf') },
  body: makePdf([
    ['Sample Book', 'Chapter 1 Start', 'alpha '.repeat(30)],
    ['Chapter 2 Turn', 'beta '.repeat(30)],
  ]),
}).then((res) => res.json());
const bookId = imported.bookId;
const detail = await getJson('/dsh-book-slides/book?bookId=' + bookId);
const chapters = detail.chapters.filter((chapter) => !chapter.front);
const chapter = chapters[0];

function slideAt(index) {
  return {
    slide_index: index,
    layout: index === 1 ? 'cover' : 'content_text',
    title: '第 ' + index + ' 页',
    subtitle: index === 1 ? '第 1 章' : null,
    bullet_points: index === 1 ? [] : ['要点一', '要点二'],
    quote_text: null,
    quote_source: null,
    image_prompt: '第 ' + index + ' 页：书桌上摊开的书，暖色晨光',
    audio_script: '这一页我们讲一个核心概念，把它拆成三个部分来看，先看背景，再看方法，最后看它为什么重要。',
    source_quote: 'alpha alpha alpha alpha alpha alpha',
    source_pages: { from: chapter.from, to: chapter.from },
  };
}

replies = [
  [
    {
      type: 'text-delta',
      text: JSON.stringify({ module_title: '测试精讲', slides: Array.from({ length: 6 }, (_, index) => slideAt(index + 1)) }),
    },
    { type: 'finish', reason: { kind: 'stop' } },
  ],
];

test.after(async () => {
  await new Promise((resolve) => comfy.close(resolve));
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('生成完成 → 自动起配图作业 → 正文页图片落盘', async () => {
  const configured = await postJson('/dsh-book-slides/image/config', { provider: 'comfyui', host: '127.0.0.1', port: comfyPort });
  assert.equal(configured.ok, true, JSON.stringify(configured));

  const started = await postJson('/dsh-book-slides/generate', { bookId: bookId, chapters: [chapter.n] });
  assert.equal(started.ok, true, JSON.stringify(started));
  const moduleId = started.moduleId;

  const deadline = Date.now() + 20000;
  let job = null;
  while (Date.now() < deadline) {
    job = await getJson('/dsh-book-slides/job?moduleId=' + encodeURIComponent(moduleId));
    if (job && ['ready', 'ready_degraded', 'failed', 'cancelled', 'interrupted'].includes(job.status)) break;
    await sleep(80);
  }
  assert.equal(job.status, 'ready', JSON.stringify(job));

  let status = null;
  while (Date.now() < deadline) {
    status = await getJson('/dsh-book-slides/image/status?moduleId=' + encodeURIComponent(moduleId));
    if (['done', 'partial', 'failed', 'cancelled', 'interrupted'].includes(status.status)) break;
    await sleep(200);
  }
  assert.equal(status.status, 'done', JSON.stringify(status));
  assert.equal(status.total, 5, '封面不出图，5 个正文页各一张');
  assert.ok(comfyPrompts >= 5, '应该逐页请求 ComfyUI，实际 ' + comfyPrompts + ' 次，状态 ' + JSON.stringify(status));

  const moduleDir = path.join(ROOT, 'books', bookId, 'modules', moduleId);
  for (let i = 2; i <= 6; i += 1) {
    assert.ok(fs.existsSync(path.join(moduleDir, 'images', String(i).padStart(3, '0') + '.png')), '第 ' + i + ' 页配图应该落盘');
  }
  assert.equal(fs.existsSync(path.join(moduleDir, 'images', '001.png')), false);

  const slidesDoc = JSON.parse(fs.readFileSync(path.join(moduleDir, 'slides.json'), 'utf8'));
  assert.equal(slidesDoc.slides[0].image_status, 'none');
  assert.equal(slidesDoc.slides[1].image_status, 'ready');
  assert.equal(slidesDoc.slides[1].image_provider, 'comfyui');

  const record = JSON.parse(fs.readFileSync(path.join(moduleDir, 'module.json'), 'utf8'));
  assert.equal(record.status, 'ready');
  assert.equal(record.images.status, 'done');
  assert.equal(record.images.done, 5);
});
