/**
 * 本地 ComfyUI 配图 · 纯函数与客户端测试（v1.4）
 *
 *   node test/comfy.test.mjs
 *
 * 覆盖：配置默认值、默认工作流识别、API/UI 格式校验、提示词与种子写入、
 * 假 ComfyUI 的提交/轮询/下载、模型缺失探测。不碰真实 ComfyUI。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-comfy-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const comfy = await import('../lib/comfy.js');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function makeServer(handler) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://localhost');
      handler({ req, res, url, body: Buffer.concat(chunks).toString('utf8') }).catch((err) => {
        res.statusCode = 500;
        res.end(String((err && err.message) || err));
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('配置：默认 127.0.0.1:8188，provider 只认两档，非法地址回落', () => {
  const empty = comfy.normalizeImageConfig(null);
  assert.equal(empty.provider, 'prompt');
  assert.equal(empty.host, '127.0.0.1');
  assert.equal(empty.port, 8188);
  assert.equal(comfy.baseUrlOf(empty), 'http://127.0.0.1:8188');

  const pasted = comfy.normalizeImageConfig({ provider: 'comfyui', host: 'http://192.168.1.9:8000/' });
  assert.equal(pasted.host, '192.168.1.9');
  assert.equal(pasted.port, 8000);

  const badPort = comfy.normalizeImageConfig({ host: 'box', port: 70000 });
  assert.equal(badPort.port, 8188);
  const badHost = comfy.normalizeImageConfig({ host: 'bad host!', port: 8188 });
  assert.equal(badHost.host, '127.0.0.1');
});

test('默认工作流：12 个节点，提示词节点是 57:27，候选只有一个', () => {
  const store = comfy.defaultWorkflow();
  assert.equal(store.source, 'default');
  const check = comfy.validateWorkflow(store.workflow);
  assert.equal(Object.keys(store.workflow).length, 10);
  assert.equal(check.promptNode, '57:27');
  assert.equal(check.sampler, '57:3');
  assert.equal(check.candidates.length, 1);
});

test('工作流校验：界面格式与坏节点都拒绝', () => {
  assert.throws(() => comfy.validateWorkflow({ nodes: [], links: [] }), /界面格式/);
  assert.throws(() => comfy.validateWorkflow({ a: {}, b: { class_type: 'X', inputs: {} } }), /class_type/);
  assert.throws(() => comfy.validateWorkflow(null), /JSON 对象/);
});

test('写入提示词与种子：不修改原对象，seed 写进 KSampler', () => {
  const store = comfy.defaultWorkflow();
  const patched = comfy.applyPrompt(store.workflow, '一只在书页上行走的猫', 42);
  assert.equal(patched['57:27'].inputs.text, '一只在书页上行走的猫');
  assert.equal(patched['57:3'].inputs.seed, 42);
  assert.notEqual(store.workflow['57:27'].inputs.text, '一只在书页上行走的猫');
});

test('种子：同提示词同工作流可复现，nonce 改变换一张', () => {
  const hash = comfy.workflowHashOf(comfy.defaultWorkflow().workflow);
  const a = comfy.seedFor('一只猫', hash, 0);
  const b = comfy.seedFor('一只猫', hash, 0);
  const c = comfy.seedFor('一只猫', hash, 1);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(Number.isSafeInteger(a));
});

test('出图：提交 → 轮询 /history → 下载 PNG', async () => {
  let submitted = null;
  const server = await makeServer(async ({ req, res, url, body }) => {
    if (url.pathname === '/prompt' && req.method === 'POST') {
      submitted = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ prompt_id: 'p1' }));
      return;
    }
    if (url.pathname === '/history/p1') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          p1: {
            status: { status_str: 'success', completed: true },
            outputs: { 9: { images: [{ filename: 'z-image-turbo_00001_.png', subfolder: '', type: 'output' }] } },
          },
        }),
      );
      return;
    }
    if (url.pathname === '/view') {
      assert.equal(url.searchParams.get('filename'), 'z-image-turbo_00001_.png');
      res.setHeader('content-type', 'image/png');
      res.end(PNG);
      return;
    }
    res.statusCode = 404;
    res.end('no');
  });
  const config = { provider: 'comfyui', host: '127.0.0.1', port: server.port };
  const workflow = comfy.defaultWorkflow().workflow;
  try {
    const result = await comfy.generateImage({
      config: config,
      workflow: workflow,
      prompt: '书页上的猫',
      seed: 7,
      promptNode: '57:27',
    });
    assert.deepEqual(result.buffer, PNG);
    assert.equal(result.promptId, 'p1');
    assert.equal(submitted.prompt['57:27'].inputs.text, '书页上的猫');
    assert.equal(submitted.prompt['57:3'].inputs.seed, 7);
  } finally {
    await server.close();
  }
});

test('出图失败：工作流缺模型 → E_IMG_MODEL_MISSING', async () => {
  const server = await makeServer(async ({ req, res, url }) => {
    if (url.pathname === '/prompt') {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: { message: 'Prompt outputs failed validation' },
          node_errors: { '57:28': { errors: [{ message: 'Value not in list', details: 'unet_name: model not found' }] } },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end('no');
  });
  try {
    await assert.rejects(
      () =>
        comfy.generateImage({
          config: { provider: 'comfyui', host: '127.0.0.1', port: server.port },
          workflow: comfy.defaultWorkflow().workflow,
          prompt: 'x',
          seed: 1,
        }),
      (err) => err.code === 'E_IMG_MODEL_MISSING',
    );
  } finally {
    await server.close();
  }
});

test('探测：版本 + 缺失模型清单', async () => {
  const server = await makeServer(async ({ res, url }) => {
    if (url.pathname === '/system_stats') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ system: { comfyui_version: '0.3.40' } }));
      return;
    }
    if (url.pathname.startsWith('/object_info/')) {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          UNETLoader: { input: { required: { unet_name: [['other_model.safetensors']] } } },
          CLIPLoader: { input: { required: { clip_name: [['qwen_3_4b.safetensors']] } } },
          VAELoader: { input: { required: { vae_name: [['ae.safetensors']] } } },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end('no');
  });
  try {
    const result = await comfy.probeComfy({
      config: { provider: 'comfyui', host: '127.0.0.1', port: server.port },
      workflow: comfy.defaultWorkflow().workflow,
    });
    assert.equal(result.version, '0.3.40');
    assert.deepEqual(result.missing, ['UNETLoader.unet_name=z_image_turbo_bf16.safetensors']);
  } finally {
    await server.close();
  }
});

test('导入工作流：多个文本节点时抛 E_IMG_WORKFLOW_NODE 并带候选', () => {
  const workflow = {
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'a', clip: ['3', 0] } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: 'b', clip: ['3', 0] } },
    '3': { class_type: 'CLIPLoader', inputs: { clip_name: 'x', type: 'lumina2' } },
    '4': { class_type: 'KSampler', inputs: { positive: ['9', 0], negative: ['2', 0], seed: 0 } },
  };
  assert.throws(
    () => comfy.saveWorkflow(workflow, { name: 'two.json' }),
    (err) => err.code === 'E_IMG_WORKFLOW_NODE' && err.candidates.length === 2,
  );
  assert.equal(fs.existsSync(comfy.IMAGE_WORKFLOW_FILE), false, '失败时不能落盘');
});
