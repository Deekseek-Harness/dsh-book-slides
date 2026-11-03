/**
 * v1.3 书档（导入/导出）—— 走真 HTTP + 真 ZIP，覆盖附录 M.10 的服务端部分。
 *
 *   node test/package.test.mjs
 *
 * 不碰 ~/.dsh：数据根指到临时目录。模块是手工造的（不调模型、不调 TTS），
 * 这样才能把「原样搬运」和「零生成」两件事分开验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import yazl from 'yazl';
import yauzl from 'yauzl';

import { makePdf } from './fixture.mjs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-pkg-'));
const ZIPS = path.join(ROOT, '.test-zips');
fs.mkdirSync(ZIPS, { recursive: true });
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const plugin = await import('../index.js');

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
  return {
    ctx: {
      inject(names, fn) {
        fn(scoped);
      },
      on() {},
      get() {
        return undefined;
      },
    },
    routes,
    prefixes,
  };
}

const { ctx, routes, prefixes } = makeContext();
plugin.apply(ctx);

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url || '/', 'http://localhost');
  let handler = routes.get(parsed.pathname);
  if (!handler) {
    for (const [prefix, candidate] of prefixes) {
      if (parsed.pathname === prefix || parsed.pathname.startsWith(prefix + '/')) {
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
const api = (pathname) => base + '/dsh-book-slides' + pathname;

async function getJson(pathname) {
  const res = await fetch(api(pathname));
  return res.json();
}

async function postJson(pathname, body) {
  const res = await fetch(api(pathname), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

async function importPdf(name, buffer) {
  const res = await fetch(api('/import'), {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(name) },
    body: buffer,
  });
  return res.json();
}

/* ------------------------------ 造数据 ------------------------------ */

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function wavBytes(seed) {
  const dataSize = 400 + seed;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(16000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < dataSize; i += 1) buffer[44 + i] = (i + seed) % 251;
  return buffer;
}

function makeModule(bookId, moduleId, options) {
  const opts = options || {};
  const chapters = opts.chapters || [1];
  const titles = opts.titles || ['第 1 章'];
  const count = opts.count || 1;
  const now = new Date().toISOString();
  const dir = path.join(ROOT, 'books', bookId, 'modules', moduleId);
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });

  const slides = [];
  for (let i = 1; i <= count; i += 1) {
    const audio = opts.audio === false ? null : 'audio/' + String(i).padStart(3, '0') + '.wav';
    slides.push({
      slide_index: i,
      layout: i === 1 ? 'cover' : 'content_text',
      title: (opts.tag || '页') + i,
      subtitle: i === 1 ? '副标题' : null,
      bullet_points: i === 1 ? [] : ['要点一', '要点二'],
      quote_text: null,
      quote_source: null,
      image_prompt: '手绘示意图',
      audio_script: '这是一段配音稿，用来测试书档搬运音频文件是否完整。',
      source_quote: 'alpha '.repeat(3),
      source_pages: { from: 1, to: 1 },
      source_anchor: { page: 1, para_index: 0 },
      anchor_status: 'anchored',
      audio_file: audio,
      audio_provider: audio ? 'qwen3-tts' : 'none',
      audio_ms: 1000,
    });
    if (audio) fs.writeFileSync(path.join(dir, 'audio', String(i).padStart(3, '0') + '.wav'), wavBytes(i));
  }

  const slidesDoc = {
    schema_version: 1,
    module_id: moduleId,
    book_id: bookId,
    module_title: '精讲：第 1 章',
    chapters: chapters,
    generated_at: now,
    model: 'fake',
    prompt_version: 'b2p-v1',
    voice: { provider: 'qwen3-tts', mode: 'file', model: 'qwen3-tts-flash', rate: 1, voice: 'Cherry' },
    anchor_hit_rate: 1,
    slides: slides,
  };
  fs.writeFileSync(path.join(dir, 'slides.json'), JSON.stringify(slidesDoc, null, 2) + '\n');

  const record = {
    schemaVersion: 1,
    id: moduleId,
    bookId: bookId,
    title: '精讲：第 1 章',
    chapters: chapters,
    chapterTitles: titles,
    status: opts.status || 'ready',
    stage: 'done',
    current: count,
    total: count,
    message: '',
    code: null,
    error: null,
    cacheKey: 'seed',
    model: 'fake',
    provider: 'fake',
    promptVersion: 'b2p-v1',
    voice: { provider: 'qwen3-tts', model: 'qwen3-tts-flash', voice: 'Cherry', rate: 1, mode: 'file', degraded: false },
    slides: count,
    anchored: count,
    anchorHitRate: 1,
    attempts: 1,
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
  };
  fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify(record, null, 2) + '\n');
  return dir;
}

function readZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true }, (err, zip) => {
      if (err) {
        reject(err);
        return;
      }
      const out = [];
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) {
            reject(streamErr);
            return;
          }
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            out.push({ name: entry.fileName, buffer: Buffer.concat(chunks) });
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(out));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

function writeZip(entries) {
  const file = path.join(ZIPS, 'rw-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.zip');
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const entry of entries) zip.addBuffer(entry.buffer, entry.name);
    zip.outputStream
      .pipe(fs.createWriteStream(file))
      .on('close', () => resolve(file))
      .on('error', reject);
    zip.end();
  });
}

/** 手写一个只有 store 的 ZIP，用来造 yazl 不肯造的恶意路径。 */
function writeRawZip(entries) {
  const file = path.join(ZIPS, 'raw-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.zip');
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.buffer;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, centralBuffer, eocd]));
  return file;
}

async function download(ids, options) {
  const opts = options || {};
  const params = new URLSearchParams({ books: ids.join(',') });
  if (opts.audio === false) params.set('audio', '0');
  const res = await fetch(api('/export') + '?' + params.toString());
  assert.equal(res.status, 200, '导出应该 200');
  assert.match(String(res.headers.get('content-type')), /application\/zip/);
  const buffer = Buffer.from(await res.arrayBuffer());
  const file = path.join(ZIPS, 'export-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.zip');
  fs.writeFileSync(file, buffer);
  return file;
}

async function importPackageFile(file, policy) {
  const buffer = fs.readFileSync(file);
  const query = policy ? '?policy=' + encodeURIComponent(policy) : '';
  const res = await fetch(api('/import/package') + query, {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'x-file-name': encodeURIComponent(path.basename(file)) },
    body: buffer,
  });
  return res.json();
}

function bookDir(bookId) {
  return path.join(ROOT, 'books', bookId);
}

async function shelf() {
  return getJson('/books');
}

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/* ------------------------------ 用例 ------------------------------ */

let bookA = '';
let bookB = '';
let chapterA = null;
let zipA = '';
let zipB = '';

test('准备：导入两本书，给 A 造一个带音频的模块', async () => {
  const a = await importPdf(
    '甲书.pdf',
    makePdf([
      ['甲书', '第 1 章 开始', 'alpha '.repeat(30)],
      ['第 2 章 转折', 'beta '.repeat(30)],
      ['第 3 章 结束', 'gamma '.repeat(30)],
    ]),
  );
  assert.equal(a.ok, true, JSON.stringify(a));
  bookA = a.bookId;

  const b = await importPdf(
    '乙书.pdf',
    makePdf([
      ['乙书', '第 1 章 另一本', 'delta '.repeat(30)],
      ['第 2 章 收尾', 'epsilon '.repeat(30)],
    ]),
  );
  assert.equal(b.ok, true, JSON.stringify(b));
  bookB = b.bookId;

  const detail = await getJson('/book?bookId=' + bookA);
  chapterA = detail.chapters.filter((chapter) => !chapter.front)[0];
  assert.ok(chapterA && chapterA.n >= 1);

  makeModule(bookA, 'modaaa1111', { chapters: [chapterA.n], titles: [chapterA.title], count: 2, tag: '甲页' });
});

test('导出预估：/export/size 返回本数、模块数、字节数与告警', async () => {
  const size = await getJson('/export/size?books=' + bookA);
  assert.equal(size.ok, true, JSON.stringify(size));
  assert.equal(size.books, 1);
  assert.equal(size.modules, 1);
  assert.ok(size.bytes > 0);
  assert.deepEqual(size.warnings, []);
});

test('导出：一个 ZIP，manifest + 书目录 + 音频都在（AC-32 上半）', async () => {
  zipA = await download([bookA]);
  const entries = await readZip(zipA);
  const names = entries.map((entry) => entry.name);
  assert.ok(names.includes('manifest.json'));
  assert.ok(names.includes('README.txt'));
  assert.ok(names.includes('books/' + bookA + '/book.json'));
  assert.ok(names.includes('books/' + bookA + '/source.pdf'));
  assert.ok(names.includes('books/' + bookA + '/pages.json'));
  assert.ok(names.includes('books/' + bookA + '/chapters.json'));
  assert.ok(names.includes('books/' + bookA + '/modules/modaaa1111/module.json'));
  assert.ok(names.includes('books/' + bookA + '/modules/modaaa1111/slides.json'));
  assert.ok(names.includes('books/' + bookA + '/modules/modaaa1111/audio/001.wav'));

  const manifest = JSON.parse(entries.find((entry) => entry.name === 'manifest.json').buffer.toString('utf8'));
  assert.equal(manifest.format, 'dsh-book-slides/package');
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.contentKeyVersion, 1);
  assert.equal(manifest.books.length, 1);
  assert.equal(manifest.books[0].bookId, bookA);
  assert.equal(manifest.books[0].modules[0].contentKey.length, 64);
  assert.ok(manifest.books[0].files.source.sha256);
});

test('导出只读：导出前后 books/ 的文件清单不变（AC-33）', async () => {
  const snapshot = () => {
    const out = [];
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir).sort()) {
        const abs = path.join(dir, name);
        const stat = fs.statSync(abs);
        out.push(path.relative(ROOT, abs) + '|' + stat.size + '|' + stat.mtimeMs);
        if (stat.isDirectory()) walk(abs);
      }
    };
    walk(path.join(ROOT, 'books'));
    return out.join('\n');
  };
  const before = snapshot();
  await download([bookA]);
  assert.equal(snapshot(), before);
});

test('删除后导入：书、章节、模块、音频都回来（AC-32 下半）', async () => {
  const before = {
    chapters: fs.readFileSync(path.join(bookDir(bookA), 'chapters.json')),
    slides: fs.readFileSync(path.join(bookDir(bookA), 'modules/modaaa1111/slides.json')),
    audio: fs.readFileSync(path.join(bookDir(bookA), 'modules/modaaa1111/audio/001.wav')),
    pages: fs.readFileSync(path.join(bookDir(bookA), 'pages.json')),
  };
  const removed = await postJson('/delete', { bookId: bookA });
  assert.equal(removed.ok, true);
  assert.equal((await shelf()).books.length, 1);

  const result = await importPackageFile(zipA);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.summary.imported, 1);
  assert.equal(result.items[0].modulesAdded, 1);

  const dir = bookDir(bookA);
  assert.ok(fs.existsSync(dir), '书目录应该回来了');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'chapters.json')), before.chapters);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'pages.json')), before.pages);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'modules/modaaa1111/slides.json')), before.slides);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'modules/modaaa1111/audio/001.wav')), before.audio);

  const book = JSON.parse(fs.readFileSync(path.join(dir, 'book.json'), 'utf8'));
  assert.equal(book.id, bookA);
  assert.equal(book.source.kind, 'package');
});

test('无 Key 也能播：/audio 只读文件，不依赖 voice.json（AC-39）', async () => {
  const res = await fetch(api('/audio?moduleId=modaaa1111&i=1'));
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /audio\/wav/);
  const buffer = Buffer.from(await res.arrayBuffer());
  assert.ok(buffer.length > 44);
});

test('同一包再导一次：不新增书、不新增模块（AC-34）', async () => {
  const result = await importPackageFile(zipA);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.summary.merged, 1);
  assert.equal(result.items[0].bookId, bookA);
  assert.equal(result.items[0].modulesAdded, 0);
  assert.equal(result.items[0].moduleExists, 1);
  assert.equal((await shelf()).books.length, 2);
});

test('合并：本地已有书时只补缺失模块（AC-35）', async () => {
  makeModule(bookA, 'modbbb2222', { chapters: [chapterA.n], titles: [chapterA.title], count: 1, tag: '补页' });
  const zipWithBoth = await download([bookA]);
  fs.rmSync(path.join(bookDir(bookA), 'modules/modbbb2222'), { recursive: true, force: true });
  const result = await importPackageFile(zipWithBoth);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.items[0].status, 'merged');
  assert.equal(result.items[0].modulesAdded, 1);
  assert.ok(fs.existsSync(path.join(bookDir(bookA), 'modules/modbbb2222/module.json')));
  assert.ok(fs.existsSync(path.join(bookDir(bookA), 'modules/modaaa1111/module.json')), '原有模块不能被动');
});

test('手改章节不被覆盖（AC-36）', async () => {
  const chaptersFile = path.join(bookDir(bookB), 'chapters.json');
  const chapters = JSON.parse(fs.readFileSync(chaptersFile, 'utf8'));
  const target = chapters.filter((chapter) => !chapter.front)[0];
  target.title = target.title + '（手改）';
  target.manual = true;
  fs.writeFileSync(chaptersFile, JSON.stringify(chapters, null, 2) + '\n');
  makeModule(bookB, 'modccc3333', { chapters: [target.n], titles: [target.title], count: 1, tag: '乙页' });

  zipB = await download([bookB]);
  await postJson('/delete', { bookId: bookB });
  const result = await importPackageFile(zipB);
  assert.equal(result.ok, true, JSON.stringify(result));

  const restored = JSON.parse(fs.readFileSync(path.join(bookDir(bookB), 'chapters.json'), 'utf8'));
  const hit = restored.find((chapter) => chapter.n === target.n);
  assert.equal(hit.title, target.title);
  assert.equal(hit.manual, true);
});

test('篡改 pages.json：整本拒绝，不写半本（AC-43）', async () => {
  const entries = await readZip(zipA);
  const changed = entries.map((entry) => {
    if (entry.name === 'books/' + bookA + '/pages.json') {
      return { name: entry.name, buffer: Buffer.from(entry.buffer.toString('utf8').replace('alpha', 'alphx'), 'utf8') };
    }
    return entry;
  });
  const bad = await writeZip(changed);
  const result = await importPackageFile(bad);
  assert.equal(result.ok, false);
  assert.equal(result.items[0].status, 'failed');
  assert.equal(result.items[0].code, 'E_PKG_CHECKSUM');
});

test('缺原文 PDF：E_PKG_NO_PDF，书架不新增（AC-42）', async () => {
  const entries = (await readZip(zipA)).filter((entry) => entry.name !== 'books/' + bookA + '/source.pdf');
  const bad = await writeZip(entries);
  const before = (await shelf()).books.length;
  const result = await importPackageFile(bad);
  assert.equal(result.ok, false);
  assert.equal(result.items[0].code, 'E_PKG_NO_PDF');
  assert.equal((await shelf()).books.length, before);
});

test('格式版本过高：E_PKG_VERSION（AC-46）', async () => {
  const entries = await readZip(zipA);
  const changed = entries.map((entry) => {
    if (entry.name === 'manifest.json') {
      const manifest = JSON.parse(entry.buffer.toString('utf8'));
      manifest.formatVersion = 99;
      return { name: entry.name, buffer: Buffer.from(JSON.stringify(manifest), 'utf8') };
    }
    return entry;
  });
  const bad = await writeZip(changed);
  const result = await importPackageFile(bad);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_PKG_VERSION');
});

test('路径穿越：E_PKG_UNSAFE，根目录外不落文件（AC-44）', async () => {
  const evil = writeRawZip([
    { name: '../../evil.txt', buffer: Buffer.from('pwned') },
    { name: 'manifest.json', buffer: Buffer.from('{}') },
  ]);
  const outside = path.join(os.tmpdir(), 'evil.txt');
  fs.rmSync(outside, { force: true });
  const result = await importPackageFile(evil);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_PKG_UNSAFE');
  assert.equal(fs.existsSync(outside), false);
});

test('不含音频导出：导入后全页无配音，但不换声（AC-40 / AC-47 上半）', async () => {
  const zipNoAudio = await download([bookA], { audio: false });
  const entries = await readZip(zipNoAudio);
  assert.equal(entries.some((entry) => entry.name.includes('/audio/')), false);
  await postJson('/delete', { bookId: bookA });
  const result = await importPackageFile(zipNoAudio);
  assert.equal(result.ok, true, JSON.stringify(result));

  const record = JSON.parse(fs.readFileSync(path.join(bookDir(bookA), 'modules/modaaa1111/module.json'), 'utf8'));
  assert.equal(record.status, 'ready_degraded');
  const slidesDoc = JSON.parse(fs.readFileSync(path.join(bookDir(bookA), 'modules/modaaa1111/slides.json'), 'utf8'));
  for (const slide of slidesDoc.slides) {
    assert.equal(slide.audio_file, null);
    assert.equal(slide.audio_provider, 'none');
  }
  const audio = await fetch(api('/audio?moduleId=modaaa1111&i=1'));
  assert.equal(audio.status, 404, '没有文件就该 404，由播放器显示「本页无配音」');
});

test('仅补配音：未配置 Qwen 时明确报错，不写盘（AC-47 下半）', async () => {
  const result = await postJson('/revoice', { moduleId: 'modaaa1111' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_TTS_UNCONFIGURED');
});

test('批量：两本一个包，一次导入（AC-49）', async () => {
  const zipBoth = await download([bookA, bookB]);
  const entries = await readZip(zipBoth);
  const names = entries.map((entry) => entry.name);
  assert.ok(names.includes('books/' + bookA + '/book.json'));
  assert.ok(names.includes('books/' + bookB + '/book.json'));

  await postJson('/delete', { bookId: bookA });
  await postJson('/delete', { bookId: bookB });
  assert.equal((await shelf()).books.length, 0);

  const result = await importPackageFile(zipBoth);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.summary.imported, 2);
});

test('批量部分失败：一本坏不拖累另一本（AC-41）', async () => {
  const zipBoth = await download([bookA, bookB]);
  const entries = await readZip(zipBoth);
  const broken = entries.filter((entry) => entry.name !== 'books/' + bookB + '/pages.json');
  const bad = await writeZip(broken);
  const result = await importPackageFile(bad, 'copy');
  assert.equal(result.ok, false);
  assert.equal(result.summary.failed, 1);
  assert.ok(result.summary.imported >= 1, '另一本应该照常入库');
  const codes = result.items.map((item) => item.code);
  assert.ok(codes.includes('E_PKG_CHECKSUM'));
});

test('导出互斥：书号不合法 / 空选择都有明确错误', async () => {
  const empty = await fetch(api('/export?books=')).then((res) => res.json());
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'E_EXPORT_EMPTY');

  const bad = await fetch(api('/export?books=..%2Fetc')).then((res) => res.json());
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'E_BAD_ID');
});

test('音频被改一个字节：CRC 校验拦住，不落半本（AC-43 扩展）', async () => {
  const buffer = fs.readFileSync(zipA);
  const fullName = 'books/' + bookA + '/modules/modaaa1111/audio/001.wav';
  const at = buffer.indexOf(Buffer.from(fullName, 'utf8'));
  assert.ok(at > 30, '包内应该能找到音频文件名');
  const start = at - 30;
  assert.equal(buffer.readUInt32LE(start), 0x04034b50, '本地文件头签名');
  assert.equal(buffer.readUInt16LE(start + 8), 0, 'wav 应该是 store（不压缩）');
  const nameLen = buffer.readUInt16LE(start + 26);
  const extraLen = buffer.readUInt16LE(start + 28);
  const dataStart = start + 30 + nameLen + extraLen;
  buffer[dataStart + 60] = buffer[dataStart + 60] ^ 0xff;

  const bad = path.join(ZIPS, 'crc-broken.zip');
  fs.writeFileSync(bad, buffer);
  const result = await importPackageFile(bad);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_PKG_CORRUPT');
});
