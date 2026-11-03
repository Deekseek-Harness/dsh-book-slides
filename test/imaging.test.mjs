/**
 * 后台配图作业 + /image* 路由（v1.4）
 *
 *   node test/imaging.test.mjs
 *
 * 用假 ComfyUI 跑完整链路：配置 → 启动作业 → 逐页落盘 → /image 取图 →
 * 全部就绪后再点不重复出图 → force 换图 → ComfyUI 失败时逐页降级。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-imaging-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const plugin = await import('../index.js');
const imaging = await import('../imaging.js');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);

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
    get() {
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

function post(pathname, body) {
  return fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then((res) => res.json());
}

function get(pathname) {
  return fetch(base + pathname).then(async (res) => {
    const type = String(res.headers.get('content-type') || '');
    if (type.includes('application/json')) return res.json();
    return { status: res.status, type: type, buffer: Buffer.from(await res.arrayBuffer()) };
  });
}

/* ------------------------------ 假 ComfyUI ------------------------------ */

const comfyState = { mode: 'ok', prompts: [], seedByPrompt: new Map(), totalPrompts: 0 };

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
  if (url.pathname === '/prompt' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (comfyState.mode === 'fail') {
        send(400, 'application/json', JSON.stringify({ error: { message: 'boom' }, node_errors: { '57:28': { errors: [{ message: 'model not found' }] } } }));
        return;
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      comfyState.totalPrompts += 1;
      const id = 'p' + comfyState.totalPrompts;
      comfyState.prompts.push(value.prompt);
      comfyState.seedByPrompt.set(id, value.prompt['57:3'].inputs.seed);
      send(200, 'application/json', JSON.stringify({ prompt_id: id }));
    });
    return;
  }
  const history = /^\/history\/(.+)$/.exec(url.pathname);
  if (history) {
    const id = decodeURIComponent(history[1]);
    if (!comfyState.seedByPrompt.has(id)) {
      send(404, 'text/plain', 'not ready');
      return;
    }
    send(
      200,
      'application/json',
      JSON.stringify({
        [id]: {
          status: { status_str: 'success', completed: true },
          outputs: { 9: { images: [{ filename: 'z-image-turbo_' + id + '_.png', subfolder: '', type: 'output' }] } },
        },
      }),
    );
    return;
  }
  if (url.pathname === '/view') {
    const filename = String(url.searchParams.get('filename') || '');
    send(200, 'image/png', Buffer.concat([PNG, Buffer.from(filename)]));
    return;
  }
  send(404, 'text/plain', 'no');
});
await new Promise((resolve) => comfy.listen(0, '127.0.0.1', resolve));
const comfyPort = comfy.address().port;

/* ------------------------------ 造一本书和一个模块 ------------------------------ */

const bookId = 'bookimg00001';
const moduleId = 'modimg00001';
const bookDir = path.join(ROOT, 'books', bookId);
const moduleDir = path.join(bookDir, 'modules', moduleId);
fs.mkdirSync(path.join(moduleDir, 'audio'), { recursive: true });
fs.writeFileSync(
  path.join(bookDir, 'book.json'),
  JSON.stringify({ schemaVersion: 1, id: bookId, title: '配图书', pages: 2, chapters: 1 }) + '\n',
);
fs.writeFileSync(path.join(bookDir, 'pages.json'), JSON.stringify([{ page: 1, text: 'alpha' }]) + '\n');
fs.writeFileSync(path.join(bookDir, 'chapters.json'), JSON.stringify([{ n: 1, title: '第 1 章', from: 1, to: 2 }]) + '\n');
const slides = [
  { slide_index: 1, layout: 'cover', title: '封面', bullet_points: [], image_prompt: '封面图', image_status: 'none', image_file: null },
  { slide_index: 2, layout: 'content_text', title: '第一页', bullet_points: ['甲'], image_prompt: '一只在书页上行走的猫', image_status: 'none', image_file: null },
  { slide_index: 3, layout: 'content_text', title: '第二页', bullet_points: ['乙'], image_prompt: '一间亮着灯的旧书房', image_status: 'none', image_file: null },
];
fs.writeFileSync(
  path.join(moduleDir, 'slides.json'),
  JSON.stringify({ schema_version: 1, module_id: moduleId, book_id: bookId, slides: slides }, null, 2) + '\n',
);
fs.writeFileSync(
  path.join(moduleDir, 'module.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      id: moduleId,
      bookId: bookId,
      title: '精讲：第 1 章',
      chapters: [1],
      chapterTitles: ['第 1 章'],
      status: 'ready',
      stage: 'done',
      slides: 3,
      images: { provider: null, status: 'none', total: 0, done: 0, failed: 0 },
    },
    null,
    2,
  ) + '\n',
);

async function waitStatus(id, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  while (Date.now() < deadline) {
    const state = await get('/dsh-book-slides/image/status?moduleId=' + encodeURIComponent(id));
    if (['done', 'partial', 'failed', 'cancelled', 'interrupted'].includes(state.status)) return state;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('配图作业超时');
}

async function waitDone(timeoutMs) {
  return waitStatus(moduleId, timeoutMs);
}

test.after(async () => {
  await new Promise((resolve) => comfy.close(resolve));
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

test('配置接口：POST 保存 IP+端口，GET 回读并带工作流摘要', async () => {
  const saved = await post('/dsh-book-slides/image/config', {
    provider: 'comfyui',
    host: '127.0.0.1',
    port: comfyPort,
    styleSuffix: '书籍插画，无文字',
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.image.provider, 'comfyui');
  assert.equal(saved.image.port, comfyPort);
  assert.equal(saved.image.workflow.source, 'default');
  assert.equal(saved.image.workflow.promptNode, '57:27');
  assert.ok(saved.image.workflow.nodes > 4);

  const read = await get('/dsh-book-slides/image/config');
  assert.equal(read.image.styleSuffix, '书籍插画，无文字');
});

test('配图作业：只给正文页出图，图片落盘，状态写回 slides 与 module', async () => {
  const started = await post('/dsh-book-slides/image/regen', { moduleId: moduleId });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.job.total, 2, '封面不出图');

  const done = await waitDone();
  assert.equal(done.status, 'done');
  assert.equal(done.done, 2);
  assert.equal(done.failed, 0);

  assert.ok(fs.existsSync(path.join(moduleDir, 'images', '002.png')));
  assert.ok(fs.existsSync(path.join(moduleDir, 'images', '003.png')));
  assert.equal(fs.existsSync(path.join(moduleDir, 'images', '001.png')), false);

  const slidesDoc = JSON.parse(fs.readFileSync(path.join(moduleDir, 'slides.json'), 'utf8'));
  assert.equal(slidesDoc.slides[0].image_status, 'none');
  assert.equal(slidesDoc.slides[1].image_status, 'ready');
  assert.equal(slidesDoc.slides[1].image_file, 'images/002.png');
  assert.ok(Number.isSafeInteger(slidesDoc.slides[1].image_seed));
  assert.equal(slidesDoc.slides[2].image_file, 'images/003.png');

  const record = JSON.parse(fs.readFileSync(path.join(moduleDir, 'module.json'), 'utf8'));
  assert.equal(record.status, 'ready', '配图不改模块状态');
  assert.equal(record.images.status, 'done');
  assert.equal(record.images.done, 2);

  // 提示词带上了风格后缀
  const prompt = comfyState.prompts[comfyState.prompts.length - 1]['57:27'].inputs.text;
  assert.match(prompt, /书籍插画，无文字/);
});

test('/image：同源取图 200，缺页 404', async () => {
  const found = await get('/dsh-book-slides/image?moduleId=' + moduleId + '&i=2');
  assert.equal(found.status, 200);
  assert.match(found.type, /image\/png/);
  assert.equal(found.buffer[0], 0x89);

  const missing = await get('/dsh-book-slides/image?moduleId=' + moduleId + '&i=1');
  assert.equal(missing.status, 404);
});

test('已全部就绪时再点不重复出图；force 才换图', async () => {
  const again = await post('/dsh-book-slides/image/regen', { moduleId: moduleId });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'E_IMG_NOTHING');

  const before = comfyState.totalPrompts;
  const forced = await post('/dsh-book-slides/image/regen', { moduleId: moduleId, force: true });
  assert.equal(forced.ok, true);
  const done = await waitDone();
  assert.equal(done.status, 'done');
  assert.ok(comfyState.totalPrompts > before, 'force 应该重新请求 ComfyUI');

  const slidesDoc = JSON.parse(fs.readFileSync(path.join(moduleDir, 'slides.json'), 'utf8'));
  assert.equal(slidesDoc.slides[1].image_nonce, 1, 'force 后 nonce 递增，换一张图');
});

test('ComfyUI 出错：逐页降级，模块仍是 ready，文字与语音不受影响', async () => {
  comfyState.mode = 'fail';
  try {
    const started = await post('/dsh-book-slides/image/regen', { moduleId: moduleId, force: true });
    assert.equal(started.ok, true);
    const done = await waitDone();
    assert.equal(done.status, 'failed');

    const slidesDoc = JSON.parse(fs.readFileSync(path.join(moduleDir, 'slides.json'), 'utf8'));
    assert.equal(slidesDoc.slides[1].image_status, 'failed');
    assert.match(String(slidesDoc.slides[1].image_error), /E_IMG_/);
    const record = JSON.parse(fs.readFileSync(path.join(moduleDir, 'module.json'), 'utf8'));
    assert.equal(record.status, 'ready');
  } finally {
    comfyState.mode = 'ok';
  }
});

test('路径校验：只认 images/NNN.png', () => {
  assert.equal(imaging.imageAbsPath(moduleDir, 'images/002.png'), path.join(moduleDir, 'images', '002.png'));
  assert.equal(imaging.imageAbsPath(moduleDir, '../slides.json'), '');
  assert.equal(imaging.imageAbsPath(moduleDir, 'images/../../slides.json'), '');
});

test('重启归一：pending 但没有作业 → interrupted + 该页 failed，可再补图', async () => {
  const recoverId = 'modrec00001';
  const recoverDir = path.join(ROOT, 'books', bookId, 'modules', recoverId);
  fs.mkdirSync(path.join(recoverDir, 'audio'), { recursive: true });
  fs.writeFileSync(
    path.join(recoverDir, 'slides.json'),
    JSON.stringify(
      {
        schema_version: 1,
        module_id: recoverId,
        book_id: bookId,
        slides: [
          {
            slide_index: 2,
            layout: 'content_text',
            title: '恢复页',
            bullet_points: ['甲'],
            image_prompt: '恢复页上的一只猫',
            image_status: 'pending',
            image_file: null,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  fs.writeFileSync(
    path.join(recoverDir, 'module.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        id: recoverId,
        bookId: bookId,
        title: '恢复测试',
        chapters: [1],
        chapterTitles: ['第 1 章'],
        status: 'ready',
        stage: 'done',
        slides: 1,
        images: { provider: 'comfyui', status: 'pending', total: 1, done: 0, failed: 0 },
      },
      null,
      2,
    ) + '\n',
  );

  imaging.reconcileImagingJobs();

  const record = JSON.parse(fs.readFileSync(path.join(recoverDir, 'module.json'), 'utf8'));
  assert.equal(record.images.status, 'interrupted');
  assert.equal(record.images.code, 'E_INTERRUPTED');
  const slidesDoc = JSON.parse(fs.readFileSync(path.join(recoverDir, 'slides.json'), 'utf8'));
  assert.equal(slidesDoc.slides[0].image_status, 'failed');
  assert.match(String(slidesDoc.slides[0].image_error), /E_INTERRUPTED/);

  const resumed = await post('/dsh-book-slides/image/regen', { moduleId: recoverId });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  const done = await waitStatus(recoverId);
  assert.equal(done.status, 'done');
  assert.ok(fs.existsSync(path.join(recoverDir, 'images', '002.png')));
});

test('工作流接口：导入 API 格式、拒绝界面格式且不覆盖、恢复默认', async () => {
  const workflow = JSON.parse(fs.readFileSync(new URL('../workflows/z-image-turbo.json', import.meta.url), 'utf8'));

  const imported = await post('/dsh-book-slides/image/workflow', { workflow: workflow, name: 'custom.json' });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  assert.equal(imported.image.workflow.source, 'imported');
  assert.equal(imported.image.workflow.name, 'custom.json');
  assert.equal(imported.image.workflow.promptNode, '57:27');

  const bad = await post('/dsh-book-slides/image/workflow', { nodes: [], links: [] });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E_IMG_WORKFLOW');

  const still = await get('/dsh-book-slides/image/config');
  assert.equal(still.image.workflow.source, 'imported', '坏工作流不能覆盖上一份');

  const reset = await post('/dsh-book-slides/image/workflow', { reset: true });
  assert.equal(reset.ok, true);
  assert.equal(reset.image.workflow.source, 'default');
  assert.equal(reset.image.workflow.promptNode, '57:27');
});

test('测试生图：返回 PNG 预览，不写模块、不进缓存；提示词策略下明确拒绝', async () => {
  const cacheDir = path.join(ROOT, 'image-cache');
  const before = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).length : 0;

  const res = await fetch(base + '/dsh-book-slides/image/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '测试生图用的一只猫' }),
  });
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /image\/png/);
  const buffer = Buffer.from(await res.arrayBuffer());
  assert.equal(buffer[0], 0x89);
  assert.ok(Number(res.headers.get('x-image-ms')) >= 0);
  assert.ok(Number(res.headers.get('x-image-seed')) > 0);

  const after = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).length : 0;
  assert.equal(after, before, '测试图不能进 image-cache');

  const promptConfig = await post('/dsh-book-slides/image/config', {
    provider: 'prompt',
    host: '127.0.0.1',
    port: comfyPort,
  });
  assert.equal(promptConfig.image.provider, 'prompt');
  const rejected = await fetch(base + '/dsh-book-slides/image/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }).then((response) => response.json());
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'E_IMG_DISABLED');

  await post('/dsh-book-slides/image/config', { provider: 'comfyui', host: '127.0.0.1', port: comfyPort });
});
