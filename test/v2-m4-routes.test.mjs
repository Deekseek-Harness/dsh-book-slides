/**
 * 2.0 路由注册走查：插件 apply 后，2.0 的正式路径都由 v2 处理器接管，
 * 且不出现重复注册（1.x 同名处理器已默认关闭，§6.7）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-routes-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { apply, ROUTE_PREFIX } = await import('../index.js');

const registered = [];
const commands = [];
const ctx = {
  inject(names, fn) {
    fn({
      commands: {
        register(definition) {
          commands.push(definition);
        },
      },
      webServer: {
        register(definition) {
          registered.push(definition);
          return () => {};
        },
      },
    });
  },
  on() {},
};

apply(ctx);

function paths() {
  return registered.map((item) => item.path);
}

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

test('M4 路由：偏好/进度/语音/设置/诊断/备份均由 2.0 接管', () => {
  const expected = [
    '/preference',
    '/series/progress',
    '/voice',
    '/voice/probe',
    '/voice/workflow',
    '/voice/refvoices',
    '/voice/refvoices/import',
    '/voice/comfy/probe',
    '/revoice',
    '/revoice/job',
    '/revoice/cancel',
    '/audio',
    '/settings',
    '/diagnostics',
    '/backups',
    '/backups/delete',
    '/backups/open',
  ].map((item) => ROUTE_PREFIX + item);
  const actual = paths();
  for (const item of expected) {
    assert.ok(actual.includes(item), '缺少路由注册：' + item);
  }
  assert.ok(!actual.includes(ROUTE_PREFIX + '/voice/speakers'), '旧 /voice/speakers 不应再注册');
});

test('M4 路由：每个路径只注册一次，避免 1.x/2.0 双挂', () => {
  const seen = new Map();
  for (const item of paths()) seen.set(item, (seen.get(item) || 0) + 1);
  const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([item]) => item);
  assert.deepEqual(duplicated, []);
  assert.ok(seen.has(ROUTE_PREFIX + '/storage'));
  assert.ok(seen.has(ROUTE_PREFIX + '/series'));
  assert.ok(seen.has(ROUTE_PREFIX + '/part'));
});

test('M4 路由：/voice/refvoices 经宿主路由表可达（回归 HTTP 405）', async () => {
  const routePath = ROUTE_PREFIX + '/voice/refvoices';
  const route = registered.find((item) => item.kind === 'exact' && item.path === routePath);
  assert.ok(route, '缺少路由注册：' + routePath);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const hit = registered.find((item) => item.kind === 'exact' && item.path === url.pathname);
    if (!hit) {
      res.statusCode = 404;
      res.end('no route');
      return;
    }
    hit.handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + server.address().port;
    const res = await fetch(base + routePath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reset: true }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.table.count, 2);
    assert.equal(data.table.defaultVoice, 'builtin-vivian');

    const form = new FormData();
    form.append('audio', new Blob([makeWav()], { type: 'audio/wav' }), 'route-test.wav');
    form.append('ref_text', '路由回归用的参考文本。');
    const imported = await fetch(base + routePath + '/import', { method: 'POST', body: form });
    assert.equal(imported.status, 200);
    const importedData = await imported.json();
    assert.equal(importedData.ok, true);
    assert.equal(importedData.table.count, 3);
    assert.equal(importedData.entry.source, 'imported');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('M4 路由：PDF 仍是前缀路由（pdf.js worker/cmaps 同源）', () => {
  const vendor = registered.find((item) => item.path === ROUTE_PREFIX + '/vendor/pdfjs');
  assert.ok(vendor, '缺少 pdf.js vendor 前缀路由');
  assert.equal(vendor.kind, 'prefix');
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
