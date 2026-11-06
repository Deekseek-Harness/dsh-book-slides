/**
 * 2.0 路由注册走查：插件 apply 后，2.0 的正式路径都由 v2 处理器接管，
 * 且不出现重复注册（1.x 同名处理器已默认关闭，§6.7）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

test('M4 路由：偏好/进度/语音/设置/诊断/备份均由 2.0 接管', () => {
  const expected = [
    '/preference',
    '/series/progress',
    '/voice',
    '/voice/probe',
    '/voice/workflow',
    '/voice/speakers',
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

test('M4 路由：PDF 仍是前缀路由（pdf.js worker/cmaps 同源）', () => {
  const vendor = registered.find((item) => item.path === ROUTE_PREFIX + '/vendor/pdfjs');
  assert.ok(vendor, '缺少 pdf.js vendor 前缀路由');
  assert.equal(vendor.kind, 'prefix');
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
