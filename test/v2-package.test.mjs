/**
 * 2.0 M5 书档（FR-22 / AC-125 / AC-133）。
 *
 * 覆盖：导出白名单、manifest/contentKey、单本往返（书/章/系列/讲/音频/练习）、
 * 二次导入幂等、同 bookId 不同 sha256 冲突、批量中单本坏包不影响其它本、
 * 导入状态归一（生成中 → interrupted、缺音频 → ready_degraded）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-package-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, writeChapters, writeCover, loadBook } = await import('../host/books.js');
const { savePart } = await import('../host/parts.js');
const { createSeries, findSeries, patchSeriesLecture, persistSeries } = await import('../host/series.js');
const { writeLectureOutputs } = await import('../host/lectures.js');
const { ZipWriter, inspectZip, readEntryBuffer } = await import('../lib/pkgzip.js');
const { routeM1 } = await import('../host/api.js');

function wavBuffer(seconds = 1) {
  const sampleRate = 22050;
  const dataSize = sampleRate * 2 * seconds;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function makeBook(tag, options = {}) {
  const chapters = options.chapters || [
    { n: 1, title: '第1章 甲', from: 1, to: 1, chars: 3000, front: false },
    { n: 2, title: '第2章 乙', from: 2, to: 2, chars: 3000, front: false },
  ];
  const pages = chapters.map((chapter) => ({
    page: chapter.from,
    text: chapter.title + '\n' + '文'.repeat(3000),
  }));
  const book = createBook({
    buffer: Buffer.from('v2-package-' + tag + '-' + Date.now()),
    fileName: tag + '.pdf',
    title: '书档 ' + tag,
    author: '作者 ' + tag,
    pages: pages.length,
    rawPages: pages,
  });
  writeChapters(book.id, chapters, 'manual');
  writeCover(book.id, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const part = savePart({ bookId: book.id, chapters: chapters.map((chapter) => chapter.n), title: '部分 ' + tag });
  const series = createSeries({
    bookId: book.id,
    partId: part.id,
    title: '系列 ' + tag,
    plan: {
      throughline: '主线 ' + tag,
      lectures: chapters.map((chapter, index) => ({
        n: index + 1,
        chapters: [chapter.n],
        title: '第 ' + (index + 1) + ' 讲 · ' + tag,
        goal: 'g' + (index + 1),
        pages: 6,
        chars: 3000,
      })),
      seams: chapters.length > 1
        ? [{ from: 1, to: 2, concept: '接缝', sentence: '上一讲说了甲，这一讲说乙。' }]
        : [],
      terms: [{ name: '甲', forbid: ['乙'] }],
      cut_notes: [],
      source: 'model',
      stitched: true,
      totalChars: chapters.length * 3000,
      totalPages: chapters.length * 6,
      estMinutes: chapters.length * 6,
    },
  });
  const found = findSeries(series.id);
  for (const lecture of found.series.lectures) {
    const slides = Array.from({ length: 6 }, (_, index) => ({
      slide_index: index + 1,
      layout: index === 0 ? 'cover' : 'content_text',
      title: '第 ' + lecture.n + ' 讲 第 ' + (index + 1) + ' 页',
      bullet_points: ['要点' + index],
      quote_text: '',
      quote_source: '',
      audio_script: '第' + lecture.n + '讲第' + (index + 1) + '页朗读稿',
      source_quote: '原文'.repeat(20),
      source_pages: { from: lecture.chapters[0], to: lecture.chapters[0] },
      audio_file: index === 1 ? 'audio/002.wav' : null,
      audio_provider: index === 1 ? 'qwen3-tts' : 'none',
      audio_ms: index === 1 ? 1000 : 0,
      image_prompt: '插图',
      image_file: null,
      image_status: 'none',
    }));
    writeLectureOutputs(
      found.dir,
      lecture.n,
      {
        schema: 1,
        series_id: series.id,
        n: lecture.n,
        title: lecture.title,
        chapters: lecture.chapters,
        pages: 6,
        chars: 3000,
        status: String(lecture.status || 'ready'),
        voice_status: 'none',
      },
      { schema_version: 1, series_id: series.id, lecture: lecture.n, slides },
    );
    const dir = path.join(found.dir, 'lectures', String(lecture.n));
    fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
    if (options.missingAudio) {
      // 故意不写 002.wav：导入端应归一为 ready_degraded + audio_file=null
    } else {
      fs.writeFileSync(path.join(dir, 'audio', '002.wav'), wavBuffer(1));
    }
    patchSeriesLecture(found.series, lecture.n, { status: 'ready', pages: 6, chars: 3000 });
  }
  found.series.status = 'ready';
  persistSeries(found.series);

  // 练习数据：题库 + 掌握度 + 一个场次
  const practice = path.join(path.dirname(path.dirname(found.dir)), 'practice');
  fs.mkdirSync(path.join(practice, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(practice, 'explain-cache'), { recursive: true });
  fs.writeFileSync(
    path.join(practice, 'questions.json'),
    JSON.stringify({ schema_version: 1, product_version: '2.0', prompt_version: 'quiz-v1', blueprint_version: 1, chapters: {}, questions: [{ qid: 'qtest' + tag, chapter: 1, type: 'single', stem: '题干', options: [], answer: ['A'], source_quote: '原文'.repeat(10), flagged: false }] }, null, 2),
  );
  fs.writeFileSync(path.join(practice, 'mastery.json'), JSON.stringify({ schema_version: 1, items: {} }));
  fs.writeFileSync(
    path.join(practice, 'sessions', 'sabcdefghi.json'),
    JSON.stringify({ session_id: 'sabcdefghi', book_id: book.id, status: 'finished', plan: [], answers: [] }),
  );
  fs.writeFileSync(path.join(practice, 'explain-cache', 'x.json'), '{}', { flag: 'w' });

  return { book, series: found.series };
}

function makeInterruptedBook(tag) {
  const made = makeBook(tag, { missingAudio: true });
  const found = findSeries(made.series.id);
  patchSeriesLecture(found.series, 1, { status: 'structuring' });
  persistSeries(found.series);
  const dir = path.join(found.dir, 'lectures', '1');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'lecture.json'), 'utf8'));
  writeLectureOutputs(
    found.dir,
    1,
    Object.assign({}, meta, { status: 'structuring' }),
    JSON.parse(fs.readFileSync(path.join(dir, 'slides.json'), 'utf8')),
  );
  return made;
}

const A = makeBook('A');
const B = makeInterruptedBook('B');
const C = makeBook('C');

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

async function json(url, options) {
  const res = await fetch(baseUrl + url, options);
  return JSON.parse(await res.text());
}

async function binary(url, options) {
  const res = await fetch(baseUrl + url, options);
  return { res, buffer: Buffer.from(await res.arrayBuffer()) };
}

async function waitImport(jobId, timeout = 15000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await json('/dsh-book-slides/import/package/job?jobId=' + encodeURIComponent(jobId));
    if (['done', 'failed', 'cancelled'].includes(String(last.status))) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待导入作业超时：' + JSON.stringify(last));
}

async function startImportZip(buffer, policy = 'merge') {
  const { buffer: resBuffer } = await binary('/dsh-book-slides/import/package?policy=' + policy, {
    method: 'POST',
    headers: { 'content-type': 'application/zip', 'x-file-name': 'package.zip' },
    body: buffer,
  });
  return JSON.parse(resBuffer.toString('utf8'));
}

async function importZip(buffer, policy = 'merge') {
  const out = await startImportZip(buffer, policy);
  if (!out.ok) return out;
  return waitImport(out.jobId);
}

async function rewriteZip(input, output, options = {}) {
  const info = await inspectZip(input);
  const manifestBuffer = await readEntryBuffer(input, 'manifest.json', 8 * 1024 * 1024);
  const manifest = JSON.parse(manifestBuffer.toString('utf8'));
  const writer = new ZipWriter();
  writer.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'), 'manifest.json');
  const skip = new Set(options.skip || []);
  for (const entry of info.entries) {
    if (entry.isDir || entry.name === 'manifest.json') continue;
    if (skip.has(entry.name)) continue;
    const data = await readEntryBuffer(input, entry.name, 8 * 1024 * 1024);
    writer.addBuffer(data, entry.name);
  }
  const stream = writer.end();
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  fs.writeFileSync(output, Buffer.concat(chunks));
}

let packageA = null;
let packageAll = null;

test('AC-125：导出书档，manifest 索引与白名单', async () => {
  // FR-18.2：view.json 是本机视图状态，不能随书档走
  fs.writeFileSync(
    path.join(ROOT, 'books', A.book.id, 'series', A.series.id, 'view.json'),
    JSON.stringify({ schema: 1, series_id: A.series.id, layout: 'pdf-left', split: 0.3 }),
  );
  const { res, buffer } = await binary('/dsh-book-slides/export?bookId=' + A.book.id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition') || '', /filename\*=UTF-8''/);
  packageA = buffer;
  const zipPath = path.join(ROOT, 'A.zip');
  fs.writeFileSync(zipPath, buffer);
  const info = await inspectZip(zipPath);
  const names = info.entries.map((entry) => entry.name);
  assert.ok(names.includes('manifest.json'));
  assert.ok(names.includes('books/' + A.book.id + '/source.pdf'));
  assert.ok(names.includes('books/' + A.book.id + '/parts.json'));
  assert.ok(names.includes('books/' + A.book.id + '/briefs.json') === false);
  assert.ok(names.some((name) => name.startsWith('books/' + A.book.id + '/series/' + A.series.id + '/lectures/1/audio/')));
  assert.ok(names.includes('books/' + A.book.id + '/practice/questions.json'));
  assert.ok(names.includes('books/' + A.book.id + '/practice/sessions/sabcdefghi.json'));
  assert.ok(!names.some((name) => name.includes('explain-cache')));
  for (const forbidden of ['voice.json', 'audio-cache/', 'trash/', 'preference.json', '/progress.json', 'view.json', '.tmp']) {
    assert.ok(!names.some((name) => name.includes(forbidden)), '不得包含 ' + forbidden);
  }

  const manifest = JSON.parse((await readEntryBuffer(zipPath, 'manifest.json', 8 * 1024 * 1024)).toString('utf8'));
  assert.equal(manifest.format, 'dsh-book-slides/package');
  assert.equal(manifest.formatVersion, 2);
  assert.equal(manifest.books.length, 1);
  assert.equal(manifest.books[0].sha256, A.book.sha256);
  assert.equal(manifest.books[0].series.length, 1);
  assert.ok(manifest.books[0].series[0].contentKey);
  assert.ok(manifest.books[0].series[0].lectures.every((lecture) => lecture.lectureKey));

  const size = await json('/dsh-book-slides/export/size?bookId=' + A.book.id);
  assert.equal(size.ok, true);
  assert.ok(size.bytes > 0);
});

test('AC-125：导出 → 删除 → 导入，书/章/系列/讲/音频/练习都在', async () => {
  const deleted = await json('/dsh-book-slides/book?bookId=' + A.book.id, { method: 'DELETE' });
  assert.equal(deleted.ok, true);
  assert.equal(loadBook(A.book.id), null);

  const job = await importZip(packageA);
  assert.equal(job.ok, true);
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.items.length, 1);
  assert.equal(job.items[0].status, 'ok');
  assert.equal(job.items[0].action, 'import');
  assert.equal(job.summary.imported, 1);

  const loaded = loadBook(A.book.id);
  assert.ok(loaded, '书应在原 bookId 恢复');
  assert.equal(loaded.book.sha256, A.book.sha256);
  assert.equal(loaded.chapters.length, 2);

  const seriesOut = await json('/dsh-book-slides/series?bookId=' + A.book.id);
  assert.equal(seriesOut.ok, true);
  assert.equal(seriesOut.series.length, 1);
  const restored = seriesOut.series[0];
  assert.equal(restored.status, 'ready');

  const lecture = await json('/dsh-book-slides/lecture?seriesId=' + restored.id + '&n=1');
  assert.equal(lecture.ok, true);
  assert.equal(lecture.slides.slides[1].audio_file, 'audio/002.wav');
  const audio = await fetch(baseUrl + '/dsh-book-slides/audio?seriesId=' + restored.id + '&lecture=1&i=2');
  assert.equal(audio.status, 200);
  assert.equal(Buffer.from(await audio.arrayBuffer()).slice(0, 4).toString('ascii'), 'RIFF');

  // FR-18.2：导入后布局回默认（view.json 不随包走）
  const importedView = await json('/dsh-book-slides/series/view?seriesId=' + restored.id);
  assert.equal(importedView.ok, true);
  assert.equal(importedView.view.layout, 'ppt-left');
  assert.equal(fs.existsSync(path.join(loaded.dir, 'series', restored.id, 'view.json')), false);

  const questions = JSON.parse(fs.readFileSync(path.join(loaded.dir, 'practice', 'questions.json'), 'utf8'));
  assert.equal(questions.questions.length, 1);
  assert.ok(fs.existsSync(path.join(loaded.dir, 'practice', 'sessions', 'sabcdefghi.json')));

  // 二次导入同包：命中 contentKey，不重复
  const again = await importZip(packageA);
  assert.equal(again.status, 'done');
  assert.equal(again.items[0].action, 'merge');
  assert.equal(again.items[0].series.skipped, 1);
  assert.equal(again.items[0].series.added, 0);
  const seriesAgain = await json('/dsh-book-slides/series?bookId=' + A.book.id);
  assert.equal(seriesAgain.series.length, 1);
});

test('AC-125 / AC-133：批量中单本坏包不影响其它本；导入状态归一', async () => {
  const { buffer } = await binary('/dsh-book-slides/export?bookIds=' + [A.book.id, B.book.id, C.book.id].join(','));
  packageAll = buffer;
  const zipPath = path.join(ROOT, 'all.zip');
  fs.writeFileSync(zipPath, buffer);
  const manifest = JSON.parse((await readEntryBuffer(zipPath, 'manifest.json', 8 * 1024 * 1024)).toString('utf8'));
  assert.equal(manifest.books.length, 3);
  assert.equal(manifest.scope, 'library');

  // 删掉 C 的 source.pdf，制造「单本坏包」
  const badPath = path.join(ROOT, 'bad.zip');
  await rewriteZip(zipPath, badPath, { skip: ['books/' + C.book.id + '/source.pdf'] });

  // 先删掉 B，确保它是新导入
  await json('/dsh-book-slides/book?bookId=' + B.book.id, { method: 'DELETE' });
  const job = await importZip(fs.readFileSync(badPath));
  assert.equal(job.ok, true);
  assert.equal(job.status, 'done', JSON.stringify(job));
  const byId = new Map(job.items.map((item) => [item.bookId, item]));
  assert.equal(byId.get(A.book.id).status, 'ok');
  assert.equal(byId.get(B.book.id).status, 'ok');
  assert.equal(byId.get(C.book.id).status, 'failed');
  assert.equal(byId.get(C.book.id).code, 'E_PKG_CHECKSUM');
  assert.equal(job.summary.failed, 1);

  // B 的讲在导出前是 structuring、且缺音频：导入后应归一为 interrupted / 音频降级
  const bLoaded = loadBook(B.book.id);
  assert.ok(bLoaded);
  const bSeries = (await json('/dsh-book-slides/series?bookId=' + B.book.id)).series[0];
  assert.equal(bSeries.lectures[0].status, 'interrupted');
  const bLecture = await json('/dsh-book-slides/lecture?seriesId=' + bSeries.id + '&n=1');
  assert.equal(bLecture.ok, true);
  assert.equal(bLecture.slides.slides[1].audio_file, null);
  assert.equal(bLecture.slides.slides[1].audio_provider, 'none');
});

test('AC-125：目标 bookId 已被不同 sha256 占用时整本拒绝（E_PKG_ID_CONFLICT）', async () => {
  const loaded = loadBook(A.book.id);
  const bookJson = JSON.parse(fs.readFileSync(path.join(loaded.dir, 'book.json'), 'utf8'));
  bookJson.sha256 = 'f'.repeat(64);
  fs.writeFileSync(path.join(loaded.dir, 'book.json'), JSON.stringify(bookJson, null, 2));

  const job = await importZip(packageA);
  assert.equal(job.ok, true);
  assert.equal(job.items[0].status, 'failed');
  assert.equal(job.items[0].code, 'E_PKG_ID_CONFLICT');
  assert.equal(job.summary.failed, 1);

  // 把 sha 改回来，后续测试不受影响
  bookJson.sha256 = A.book.sha256;
  fs.writeFileSync(path.join(loaded.dir, 'book.json'), JSON.stringify(bookJson, null, 2));
});

test('AC-133：导入 staging 在作业结束后清理；1.x 包明确拒绝', async () => {
  const staging = path.join(ROOT, '.import');
  const deadline = Date.now() + 3000;
  let left = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
  while (left.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    left = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
  }
  assert.deepEqual(left, [], '导入结束后 .import/ 应清理干净');

  const v1Path = path.join(ROOT, 'v1.zip');
  const writer = new ZipWriter();
  writer.addBuffer(Buffer.from(JSON.stringify({ format: 'dsh-book-slides/package', formatVersion: 1, books: [] })), 'manifest.json');
  const stream = writer.end();
  const chunks = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  fs.writeFileSync(v1Path, Buffer.concat(chunks));
  const job = await importZip(fs.readFileSync(v1Path));
  assert.equal(job.status, 'failed');
  assert.equal(job.code, 'E_PKG_VERSION');
});

test('AC-135：书档导入超时 → E_PKG_TIMEOUT，staging 清理', async () => {
  process.env.DSH_BOOK_SLIDES_PKG_TIMEOUT_MS = '1';
  try {
    const job = await importZip(packageA);
    assert.equal(job.status, 'failed');
    assert.equal(job.code, 'E_PKG_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const importRoot = path.join(ROOT, '.import');
    const leftovers = fs.existsSync(importRoot) ? fs.readdirSync(importRoot) : [];
    assert.deepEqual(leftovers, [], '超时后不得留下 staging');
  } finally {
    delete process.env.DSH_BOOK_SLIDES_PKG_TIMEOUT_MS;
  }
});

test('P0：书档导入 active 查询；有作业时重复导入返回 E_PKG_BUSY', async () => {
  process.env.DSH_BOOK_SLIDES_PKG_STEP_DELAY_MS = '300';
  try {
    const started = await startImportZip(packageA);
    assert.equal(started.ok, true);
    assert.ok(started.jobId);
    const active = await json('/dsh-book-slides/import/package/active');
    assert.equal(active.ok, true);
    assert.ok(active.job, '运行中应返回活动导入作业');
    assert.equal(active.job.jobId, started.jobId);
    assert.ok(['queued', 'running', 'cancelling'].includes(String(active.job.status)));

    const second = await startImportZip(packageA);
    assert.equal(second.ok, false);
    assert.equal(second.code, 'E_PKG_BUSY');

    await json('/dsh-book-slides/import/package/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId: started.jobId }),
    });
    const done = await waitImport(started.jobId);
    assert.ok(['done', 'cancelled'].includes(String(done.status)), JSON.stringify(done));
    const idle = await json('/dsh-book-slides/import/package/active');
    assert.equal(idle.ok, true);
    assert.equal(idle.job, null);
  } finally {
    delete process.env.DSH_BOOK_SLIDES_PKG_STEP_DELAY_MS;
  }
});

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
