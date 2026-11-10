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

import { makePdf } from './fixture.mjs';

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

/** 按宿主注册表起一个最小服务：只认 exact 路由，未注册一律 404。 */
function startHost() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const hit =
      registered.find((item) => item.kind === 'exact' && item.path === url.pathname) ||
      registered.find(
        (item) => item.kind === 'prefix' && (url.pathname === item.path || url.pathname.startsWith(item.path + '/')),
      );
    if (!hit) {
      res.statusCode = 404;
      res.end('no route');
      return;
    }
    hit.handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: 'http://127.0.0.1:' + server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('M4 路由：偏好/进度/语音/设置/诊断/备份均由 2.0 接管', () => {
  const expected = [
    '/preference',
    '/series/progress',
    '/series/view',
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
    '/usage/summary',
    '/usage/jobs',
    '/usage/job',
    '/usage/estimate',
    '/usage/prices',
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

test('FR-27 路由：/usage/summary 与 /usage/jobs 经宿主路由表可达（回归 404）', async () => {
  const summaryPath = ROUTE_PREFIX + '/usage/summary';
  const jobsPath = ROUTE_PREFIX + '/usage/jobs';
  for (const path of [summaryPath, jobsPath]) {
    assert.ok(
      registered.some((item) => item.kind === 'exact' && item.path === path),
      '缺少宿主路由注册：' + path,
    );
  }
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
    const summary = await fetch(base + summaryPath);
    assert.equal(summary.status, 200);
    const summaryData = await summary.json();
    assert.equal(summaryData.ok, true);
    assert.ok(summaryData.totals);
    const jobs = await fetch(base + jobsPath + '?limit=5');
    assert.equal(jobs.status, 200);
    const jobsData = await jobs.json();
    assert.equal(jobsData.ok, true);
    assert.ok(Array.isArray(jobsData.jobs));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('FR-18.2 路由：/series/view 经宿主路由表可达（缺失系列返回 E_NOT_FOUND 而非 404）', async () => {
  const routePath = ROUTE_PREFIX + '/series/view';
  assert.ok(
    registered.some((item) => item.kind === 'exact' && item.path === routePath),
    '缺少宿主路由注册：' + routePath,
  );
  const host = await startHost();
  try {
    const res = await fetch(host.base + routePath + '?seriesId=nosuchseries');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.equal(data.code, 'E_NOT_FOUND');
  } finally {
    await host.close();
  }
});

test('M4 路由：PDF 仍是前缀路由（pdf.js worker/cmaps 同源）', () => {  const vendor = registered.find((item) => item.path === ROUTE_PREFIX + '/vendor/pdfjs');
  assert.ok(vendor, '缺少 pdf.js vendor 前缀路由');
  assert.equal(vendor.kind, 'prefix');
});

test('PDF 静态资源：vendor 前缀路由真能取到 pdf.min.mjs（回归 E_INTERNAL）', async () => {
  const host = await startHost();
  try {
    const res = await fetch(host.base + ROUTE_PREFIX + '/vendor/pdfjs/build/pdf.min.mjs');
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-type') || ''), /javascript/, '必须是 JS，不能落到 JSON 错误处理器');
    const text = await res.text();
    assert.ok(text.length > 1000, 'pdf.min.mjs 应返回完整模块');
    assert.ok(!text.includes('E_INTERNAL'), '不应返回错误处理器内容');
  } finally {
    await host.close();
  }
});

test('P0 路由：1.x 单讲接口全部下线，2.0 不再注册同名旧路径', () => {
  const paths = new Set(registered.map((item) => item.path));
  const legacy = ['/reparse', '/toc/parse', '/generate', '/job', '/cancel', '/module', '/progress', '/delete'];
  for (const item of legacy) {
    assert.equal(paths.has(ROUTE_PREFIX + item), false, '1.x 路由不应再注册：' + item);
  }
  assert.ok(paths.has(ROUTE_PREFIX + '/toc/preview'), '/toc/preview 仍须由宿主注册');
});

test('P0 路由：/toc/preview 经宿主路由表由 2.0 处理（跨度 >40 页被拒）', async () => {
  const host = await startHost();
  try {
    const pdf = makePdf(
      Array.from({ length: 50 }, (_, i) => ['Page ' + (i + 1), 'body text ' + (i + 1)]),
    );
    const imported = await fetch(host.base + ROUTE_PREFIX + '/import', {
      method: 'POST',
      headers: { 'x-file-name': encodeURIComponent('五十页.pdf'), 'content-type': 'application/pdf' },
      body: pdf,
    });
    const importedData = await imported.json();
    assert.equal(importedData.ok, true, JSON.stringify(importedData));
    const bookId = importedData.bookId;

    const ok = await fetch(host.base + ROUTE_PREFIX + '/toc/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bookId, from: 1, to: 40 }),
    });
    const okData = await ok.json();
    assert.equal(okData.ok, true, JSON.stringify(okData));
    assert.ok(String(okData.preview).includes('Page 1'));

    // 1.4 的处理器只校验 to <= 总页数，会放行 1..50；2.0 的跨度上限必须生效。
    const tooWide = await fetch(host.base + ROUTE_PREFIX + '/toc/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bookId, from: 1, to: 50 }),
    });
    const tooWideData = await tooWide.json();
    assert.equal(tooWideData.ok, false, '1.x 实现会放行 50 页范围；2.0 必须拒绝');
    assert.equal(tooWideData.code, 'E_BAD_RANGE');
  } finally {
    await host.close();
  }
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
