/**
 * AC-141：版本一致性 + 2.5.0 设置页标签切换版发布检查。
 *
 * 覆盖：
 *  - 包版本是 2.5.0（功能增量，无 alpha/beta/rc 后缀）；
 *  - package-lock 的两处版本与 package.json 一致；
 *  - README / CHANGELOG / SRS / 实现进度 / 需求索引 与包版本、文档版本一致；
 *  - CHANGELOG 的首个版本是 [2.5.0]，没有遗留 [未发布]；允许 [Unreleased] 段记录未发布变更；
 *  - GET /meta 返回 version / product_version / schema 与包一致；
 *  - 当前提交若已打 tag，tag 必须是 v2.5.0（未打 tag 的开发提交跳过）。
 *
 * 这是发布门 AC-141 的机检入口；tag 的真实存在与远端推送仍以发布步骤为准。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(REPO, file), 'utf8');

const pkg = JSON.parse(read('package.json'));
const VERSION = String(pkg.version);
const LOCK = JSON.parse(read('package-lock.json'));
const CHANGELOG = read('CHANGELOG.md');
const README = read('README.md');
const SRS = read('doc/requirements/规范需求2.0.md');
const PROGRESS = read('doc/2.0-实现进度.md');
const REQ_INDEX = read('doc/requirements/README.md');

const docVersion = (SRS.match(/\|\s*文档版本\s*\|\s*(v\d+\.\d+)/) || [])[1];

test('AC-141：包版本是 2.5.0 功能增量版，无预发布后缀', () => {
  assert.equal(pkg.name, 'dsh-book-slides');
  assert.equal(VERSION, '2.5.0');
  assert.doesNotMatch(VERSION, /-(alpha|beta|rc)\./);
});

test('AC-141：package-lock 的根版本与 package.json 一致', () => {
  assert.equal(LOCK.version, VERSION);
  assert.equal(LOCK.packages[''].version, VERSION);
});

test('AC-141：README / 实现进度 / 需求索引 的包版本与文档版本一致', () => {
  assert.ok(docVersion, 'SRS 表头缺少「文档版本」');
  assert.match(SRS, new RegExp('\\|\\s*插件包版本\\s*\\|\\s*' + VERSION.replace(/\./g, '\\.')));
  assert.match(README, new RegExp('当前构建：包 `' + VERSION.replace(/\./g, '\\.') + '`'));
  assert.match(README, new RegExp('SRS 文档 ' + docVersion.replace(/\./g, '\\.')));
  assert.match(PROGRESS, new RegExp('\\|\\s*插件包版本\\s*\\|\\s*`' + VERSION.replace(/\./g, '\\.') + '`'));
  assert.match(PROGRESS, new RegExp('\\|\\s*文档版本\\s*\\|\\s*' + docVersion.replace(/\./g, '\\.')));
  assert.match(REQ_INDEX, new RegExp('文档 ' + docVersion.replace(/\./g, '\\.')));
  assert.match(REQ_INDEX, new RegExp('包 `' + VERSION.replace(/\./g, '\\.') + '`'));
});

test('AC-141：CHANGELOG 首个版本是 [2.5.0]，没有遗留 [未发布]（允许 [Unreleased] 段）', () => {
  assert.doesNotMatch(CHANGELOG, /## \[未发布\]/);
  assert.match(CHANGELOG, /## \[2\.5\.0\] - \d{4}-\d{2}-\d{2}/);
  const versioned = (CHANGELOG.match(/## \[([^\]]+)\]/g) || [])
    .filter((header) => !/^## \[Unreleased\]$/.test(header));
  assert.equal(versioned[0], '## [2.5.0]');
});

// /meta 用临时数据根，避免碰到真实书架。
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-release-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
process.env.DSH_BOOK_SLIDES_NO_OPEN = '1';
delete process.env.DSH_HOME;

const { routeM1 } = await import('../host/api.js');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const handled = await routeM1(req, res, url, { ctx: null });
  if (!handled) {
    res.statusCode = 404;
    res.end('no route');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port;

test('AC-141：GET /meta 返回包版本、产品 2.5 与 schema=2', async () => {
  const res = await fetch(baseUrl + '/dsh-book-slides/meta');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, VERSION);
  assert.equal(body.product_version, '2.5');
  assert.equal(body.schema, 2);
});

test('AC-141：当前提交若已打 tag，必须是 v' + VERSION, () => {
  if (!fs.existsSync(path.join(REPO, '.git'))) return;
  let tags;
  try {
    tags = execFileSync('git', ['tag', '--points-at', 'HEAD'], { cwd: REPO, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return; // 无 git 或沙箱不允许时，tag 一致性由发布步骤人工核验
  }
  if (!tags.length) return; // 未打 tag 的开发提交
  assert.ok(tags.includes('v' + VERSION), 'HEAD 上的 tag：' + tags.join(', '));
});

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

