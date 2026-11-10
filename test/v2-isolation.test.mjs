/**
 * 2.0 数据根隔离与升级（FR-20 / AC-112 / AC-113）。
 *
 * AC-113 原先要求“把目录权限改成不可写”，普通用户（尤其 Windows）造不出来。
 * 这里改成两条可注入的失败路径，断言同一组观测量：
 *   ① 备份校验失败：旧根只含 0 字节文件 → rename 成功，但备份不可信；
 *   ② 重命名失败：注入 fs.renameSync 抛 EPERM，模拟目录被占用 / 只读。
 * 两者都必须：报 E_UPGRADE_BACKUP_FAILED、原根文件与 mtime 不变、无半截 2.0 数据；
 * 修正后再次 ensureRoot 即可成功（实现每次调用都会重试，不必重启）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const PARENT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-isolation-'));
const ROOT = path.join(PARENT, 'book-slides');
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { ensureRoot } = await import('../host/root.js');
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
const base = 'http://127.0.0.1:' + server.address().port;

test.after(() => {
  server.close();
  fs.rmSync(PARENT, { recursive: true, force: true });
});

function wipe() {
  fs.rmSync(ROOT, { recursive: true, force: true });
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** 相对路径 → { size, mtimeMs }，用来证明“原根与文件不变”。 */
function tree(dir) {
  const out = new Map();
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const stat = fs.statSync(full);
        out.set(path.relative(dir, full).split(path.sep).join('/'), { size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  };
  walk(dir);
  return out;
}

function isUpgradeFailure(err) {
  assert.equal(err && err.code, 'E_UPGRADE_BACKUP_FAILED');
  return true;
}

test('AC-112：旧根自动备份，备份内文件与 mtime 保持，/meta 提示完整备份路径', async () => {
  wipe();
  const bookFile = path.join(ROOT, 'books', 'oldbook1', 'book.json');
  writeFile(bookFile, '{"schema":1,"title":"旧书"}');
  const oldTime = new Date('2020-01-02T03:04:05.000Z');
  fs.utimesSync(bookFile, oldTime, oldTime);
  const before = tree(ROOT);

  const out = ensureRoot();
  assert.equal(out.upgraded, true);
  assert.ok(out.backup && fs.existsSync(out.backup), '备份目录应存在');
  assert.match(path.basename(out.backup), /^book-slides\.backup-\d{8}-\d{6}(-\d+)?$/);
  const copied = tree(out.backup);
  assert.equal(copied.size, before.size);
  assert.deepEqual(copied.get('books/oldbook1/book.json'), before.get('books/oldbook1/book.json'), '备份内文件字节与 mtime 必须保持');
  assert.equal(fs.readFileSync(path.join(out.backup, 'books', 'oldbook1', 'book.json'), 'utf8'), '{"schema":1,"title":"旧书"}');

  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'meta.json'), 'utf8'));
  assert.equal(meta.schema, 2);
  assert.equal(meta.product_version, '2.4');
  assert.equal(meta.upgraded_from, path.basename(out.backup));
  assert.equal(meta.upgraded_to, out.backup);
  assert.equal(fs.existsSync(path.join(ROOT, 'books')), true);

  const metaRes = await (await fetch(base + '/dsh-book-slides/meta')).json();
  assert.equal(metaRes.ok, true);
  assert.equal(metaRes.notice, '旧数据已备份到 ' + out.backup, '提示必须带完整备份路径');
});

test('AC-113：备份为空（0 字节旧根）→ E_UPGRADE_BACKUP_FAILED，原根复原，修正后成功', async () => {
  wipe();
  const empty = path.join(ROOT, 'empty.dat');
  writeFile(empty, '');
  const before = tree(ROOT);

  assert.throws(() => ensureRoot(), isUpgradeFailure);
  assert.deepEqual(tree(ROOT), before, '失败后旧根文件与 mtime 不变');
  assert.equal(fs.existsSync(path.join(ROOT, 'books')), false, '不得创建半截 2.0 数据');
  assert.equal(fs.existsSync(path.join(ROOT, 'meta.json')), false, '不得写入 schema=2');

  // 路由侧同样返回该错误码（ensureRoot 在每个路由入口执行）
  const apiOut = await (await fetch(base + '/dsh-book-slides/books')).json();
  assert.equal(apiOut.ok, false);
  assert.equal(apiOut.code, 'E_UPGRADE_BACKUP_FAILED');

  // 修正：写入非空内容后重试（不重启）
  fs.writeFileSync(empty, 'x');
  const out = ensureRoot();
  assert.equal(out.upgraded, true);
  assert.match(path.basename(out.backup), /^book-slides\.backup-/);
  assert.equal(fs.existsSync(path.join(out.backup, 'empty.dat')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'meta.json'), 'utf8')).schema, 2);
});

test('AC-113：rename 被占用 / 只读阻断 → 同错误码，原根不动，恢复后可重试', () => {
  wipe();
  const legacy = path.join(ROOT, 'legacy.txt');
  writeFile(legacy, 'legacy-data');
  const before = tree(ROOT);

  const realRename = fs.renameSync;
  fs.renameSync = () => {
    const err = new Error('EPERM: operation not permitted, rename');
    err.code = 'EPERM';
    throw err;
  };
  try {
    assert.throws(() => ensureRoot(), isUpgradeFailure);
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(tree(ROOT), before, 'rename 失败后原根必须原样保留');
  assert.equal(fs.existsSync(path.join(ROOT, 'meta.json')), false);

  const out = ensureRoot();
  assert.equal(out.upgraded, true);
  assert.equal(fs.readFileSync(path.join(out.backup, 'legacy.txt'), 'utf8'), 'legacy-data');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'meta.json'), 'utf8')).schema, 2);
});

test('AC-113：升级路径不依赖模型（root.js 无 llm/tts 依赖）', () => {
  const src = fs.readFileSync(new URL('../host/root.js', import.meta.url), 'utf8');
  assert.equal(/from\s+'\.\.\/(llm|tts|voice|comfy-clone)\.js'/.test(src), false, '数据根升级不得引入模型/语音模块');
});
