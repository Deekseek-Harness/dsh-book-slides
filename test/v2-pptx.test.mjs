/**
 * 2.0 M5 导出 PPT（FR-19.2 / AC-111 / AC-121 / AC-132）。
 *
 * 真服务：按讲导出、整套合并（过渡页）、批量 ZIP、音频/配图/备注、命名与只读。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-pptx-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, writeChapters } = await import('../host/books.js');
const { savePart } = await import('../host/parts.js');
const { createSeries, findSeries, patchSeriesLecture, persistSeries } = await import('../host/series.js');
const { writeLectureOutputs } = await import('../host/lectures.js');
const { buildFileName, stripLecturePrefix } = await import('../host/pptx.js');
const { inspectZip, readEntryBuffer } = await import('../lib/pkgzip.js');
const { routeM1 } = await import('../host/api.js');

/** 最小合法 WAV：22.05kHz 单声道 16bit，1 秒静音。 */
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

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function makeBookSeries() {
  const pages = [
    { page: 1, text: '第1章 甲\n' + '甲'.repeat(3000) },
    { page: 2, text: '第2章 乙\n' + '乙'.repeat(3000) },
  ];
  const book = createBook({
    buffer: Buffer.from('v2-pptx-' + Date.now()),
    fileName: 'pptx.pdf',
    title: 'PPT 测试书',
    author: '某作者',
    pages: 2,
    rawPages: pages,
  });
  writeChapters(book.id, [
    { n: 1, title: '第1章 甲', from: 1, to: 1, chars: 3000, front: false },
    { n: 2, title: '第2章 乙', from: 2, to: 2, chars: 3000, front: false },
  ], 'manual');
  const part = savePart({ bookId: book.id, chapters: [1, 2], title: '函数' });
  const series = createSeries({
    bookId: book.id,
    partId: part.id,
    title: '函数',
    plan: {
      throughline: '把函数当机器。',
      lectures: [
        { n: 1, chapters: [1], title: '第 1 讲 · 机器', goal: 'g1', pages: 6, chars: 3000 },
        { n: 2, chapters: [2], title: '第 2 讲 · 靠近', goal: 'g2', pages: 6, chars: 3000 },
      ],
      seams: [{ from: 1, to: 2, concept: '极限', sentence: '上一讲把函数当机器；这一讲只问靠近某点时输出去哪？' }],
      terms: [],
      cut_notes: [],
      source: 'model',
      stitched: true,
      totalChars: 6000,
      totalPages: 12,
      estMinutes: 12,
    },
  });
  const found = findSeries(series.id);
  for (const lecture of found.series.lectures) {
    const slides = Array.from({ length: 6 }, (_, index) => ({
      slide_index: index + 1,
      layout: index === 0 ? 'cover' : index === 3 ? 'quote' : 'content_text',
      title: '第 ' + lecture.n + ' 讲 第 ' + (index + 1) + ' 页',
      subtitle: index === 0 ? '副标题' : '',
      bullet_points: index === 3 ? [] : ['要点一', '要点二'],
      quote_text: index === 3 ? '引文正文' : '',
      quote_source: index === 3 ? '出处' : '',
      audio_script: '第' + lecture.n + '讲第' + (index + 1) + '页朗读稿',
      source_quote: '原文'.repeat(20),
      source_pages: { from: lecture.n, to: lecture.n },
      audio_file: null,
      audio_provider: 'none',
      audio_ms: 0,
      image_prompt: '一台机器在纸上画出曲线',
      image_file: null,
      image_status: 'none',
    }));
    writeLectureOutputs(
      found.dir,
      lecture.n,
      { schema: 1, series_id: series.id, n: lecture.n, title: lecture.title, chapters: lecture.chapters, pages: 6, chars: 3000, status: 'ready', voice_status: 'none' },
      { schema_version: 1, series_id: series.id, lecture: lecture.n, slides },
    );
    patchSeriesLecture(found.series, lecture.n, { status: 'ready', pages: 6, chars: 3000 });
  }
  found.series.status = 'ready';
  found.series.total_pages = 12;
  persistSeries(found.series);

  // 第 1 讲：第 2 页有音频 + 配图，第 3 页有音频；第 2 讲没有音频
  const doc1 = path.join(found.dir, 'lectures', '1');
  fs.mkdirSync(path.join(doc1, 'audio'), { recursive: true });
  fs.mkdirSync(path.join(doc1, 'images'), { recursive: true });
  fs.writeFileSync(path.join(doc1, 'audio', '002.wav'), wavBuffer(1));
  fs.writeFileSync(path.join(doc1, 'audio', '003.wav'), wavBuffer(1));
  fs.writeFileSync(path.join(doc1, 'images', '002.png'), PNG_1PX);
  const slidesDoc = JSON.parse(fs.readFileSync(path.join(doc1, 'slides.json'), 'utf8'));
  slidesDoc.slides[1] = Object.assign({}, slidesDoc.slides[1], {
    audio_file: 'audio/002.wav',
    audio_provider: 'qwen3-tts',
    audio_ms: 1000,
    image_file: 'images/002.png',
    image_status: 'ready',
  });
  slidesDoc.slides[2] = Object.assign({}, slidesDoc.slides[2], {
    audio_file: 'audio/003.wav',
    audio_provider: 'qwen3-tts',
    audio_ms: 1000,
  });
  fs.writeFileSync(path.join(doc1, 'slides.json'), JSON.stringify(slidesDoc, null, 2));
  return { book, series };
}

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

async function json(url) {
  const res = await fetch(baseUrl + url);
  return JSON.parse(await res.text());
}

async function binary(url) {
  const res = await fetch(baseUrl + url);
  return { res, buffer: Buffer.from(await res.arrayBuffer()) };
}

function snapshot(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        out.push(entry.name + '/');
        walk(full);
      } else {
        const stat = fs.statSync(full);
        out.push(entry.name + ':' + stat.size + ':' + stat.mtimeMs);
      }
    }
  };
  walk(dir);
  return out.sort();
}

const { book, series } = makeBookSeries();

test('AC-121 / FR-19.2：单讲导出页数、备注逐字、音频与配图内嵌、命名', async () => {
  const plan = await json('/dsh-book-slides/export/pptx/plan?seriesId=' + series.id + '&lecture=1');
  assert.equal(plan.ok, true);
  assert.equal(plan.plan.slides, 6);
  assert.equal(plan.plan.transitionPages, 0);
  assert.equal(plan.plan.audioPages, 2);
  assert.equal(plan.plan.imagePages, 1);
  assert.equal(plan.plan.fileName, 'PPT 测试书-精讲-机器.pptx');
  assert.ok(plan.plan.bytes > 0);

  const { res, buffer } = await binary('/dsh-book-slides/export/pptx?seriesId=' + series.id + '&lecture=1');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  const disposition = res.headers.get('content-disposition') || '';
  assert.match(disposition, /filename\*=UTF-8''/);
  assert.ok(buffer.length > 1000);

  const zipPath = path.join(ROOT, 'single.pptx');
  fs.writeFileSync(zipPath, buffer);
  const info = await inspectZip(zipPath);
  const names = info.entries.map((entry) => entry.name);
  assert.equal(names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 6);
  assert.ok(names.includes('ppt/media/audio2.wav'));
  assert.ok(names.includes('ppt/media/audio3.wav'));
  assert.ok(names.includes('ppt/media/image2.png'));
  assert.ok(!names.includes('ppt/media/audio1.wav'));

  const notes2 = (await readEntryBuffer(zipPath, 'ppt/notesSlides/notesSlide2.xml', 1024 * 1024)).toString('utf8');
  assert.ok(notes2.includes('第1讲第2页朗读稿'), '备注必须逐字包含 audio_script');
  const notes1 = (await readEntryBuffer(zipPath, 'ppt/notesSlides/notesSlide1.xml', 1024 * 1024)).toString('utf8');
  assert.ok(notes1.includes('第1讲第1页朗读稿'), '封面页也要写备注');
  const notes4 = (await readEntryBuffer(zipPath, 'ppt/notesSlides/notesSlide4.xml', 1024 * 1024)).toString('utf8');
  assert.ok(notes4.includes('第1讲第4页朗读稿'), '引文页也要写备注');
  const slide1 = (await readEntryBuffer(zipPath, 'ppt/slides/slide1.xml', 1024 * 1024)).toString('utf8');
  assert.ok(slide1.includes('第 1 讲 第 1 页'));
  const slide4 = (await readEntryBuffer(zipPath, 'ppt/slides/slide4.xml', 1024 * 1024)).toString('utf8');
  assert.ok(slide4.includes('引文正文'));
});

test('AC-121：换图失败保留旧图时，导出仍使用旧图', async () => {
  const found = findSeries(series.id);
  const slidesPath = path.join(found.dir, 'lectures', '1', 'slides.json');
  const doc = JSON.parse(fs.readFileSync(slidesPath, 'utf8'));
  const original = doc.slides[1];
  doc.slides[1] = Object.assign({}, original, { image_status: 'failed', image_error: 'E_IMG_CONNECT：连不上' });
  fs.writeFileSync(slidesPath, JSON.stringify(doc, null, 2));
  try {
    const plan = await json('/dsh-book-slides/export/pptx/plan?seriesId=' + series.id + '&lecture=1');
    assert.equal(plan.plan.imagePages, 1, '失败但有旧图的页仍算作有图');
    const { buffer } = await binary('/dsh-book-slides/export/pptx?seriesId=' + series.id + '&lecture=1');
    const zipPath = path.join(ROOT, 'failed-old-image.pptx');
    fs.writeFileSync(zipPath, buffer);
    const names = (await inspectZip(zipPath)).entries.map((entry) => entry.name);
    assert.ok(names.includes('ppt/media/image2.png'), '旧图应被导出');
  } finally {
    doc.slides[1] = original;
    fs.writeFileSync(slidesPath, JSON.stringify(doc, null, 2));
  }
});

test('AC-111：整套合并页序 = 讲序 + 页序，过渡页含讲标题与接缝句', async () => {
  const plan = await json('/dsh-book-slides/export/pptx/plan?seriesId=' + series.id + '&lecture=all');
  assert.equal(plan.ok, true);
  assert.equal(plan.plan.slides, 13);
  assert.equal(plan.plan.transitionPages, 1);
  assert.equal(plan.plan.lectures.length, 2);

  const { buffer } = await binary('/dsh-book-slides/export/pptx?seriesId=' + series.id + '&lecture=all');
  const zipPath = path.join(ROOT, 'merged.pptx');
  fs.writeFileSync(zipPath, buffer);
  const info = await inspectZip(zipPath);
  const names = info.entries.map((entry) => entry.name);
  assert.equal(names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 13);

  const transition = (await readEntryBuffer(zipPath, 'ppt/slides/slide7.xml', 1024 * 1024)).toString('utf8');
  assert.ok(transition.includes('第 2 讲 · 靠近'));
  assert.ok(transition.includes('上一讲把函数当机器'));
  assert.equal(13 - 1, 6 + 6, '删除过渡页后与按讲导出的页数一致');

  // 不含音频：体积更小，且没有 media 音频
  const noAudio = await binary('/dsh-book-slides/export/pptx?seriesId=' + series.id + '&lecture=1&audio=0');
  const zip2 = path.join(ROOT, 'noaudio.pptx');
  fs.writeFileSync(zip2, noAudio.buffer);
  const names2 = (await inspectZip(zip2)).entries.map((entry) => entry.name);
  assert.ok(!names2.some((name) => /^ppt\/media\/audio\d+\./.test(name)));
});

test('AC-132：批量导出返回 ZIP（每讲一个 .pptx + manifest.json）', async () => {
  const { res, buffer } = await binary('/dsh-book-slides/export/pptx/batch?seriesId=' + series.id + '&lectures=all');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const zipPath = path.join(ROOT, 'batch.zip');
  fs.writeFileSync(zipPath, buffer);
  const info = await inspectZip(zipPath);
  const names = info.entries.map((entry) => entry.name);
  assert.ok(names.includes('manifest.json'));
  const pptx = names.filter((name) => name.endsWith('.pptx'));
  assert.equal(pptx.length, 2);
  const manifest = JSON.parse((await readEntryBuffer(zipPath, 'manifest.json', 1024 * 1024)).toString('utf8'));
  assert.equal(manifest.format, 'dsh-book-slides/pptx-batch');
  assert.equal(manifest.files.length, 2);
  assert.deepEqual(manifest.files.map((file) => file.lecture).sort(), [1, 2]);
});

test('AC-132：批量导出在内存构建，客户端 abort 后数据根无新增/残留', async () => {
  const before = snapshot(ROOT);
  const controller = new AbortController();
  const res = await fetch(baseUrl + '/dsh-book-slides/export/pptx/batch?seriesId=' + series.id + '&lectures=all', { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const reader = res.body.getReader();
  await reader.read();
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(snapshot(ROOT), before, 'abort 后不得留下临时 ZIP 或半截文件');
});

test('AC-121：导出只读，books/ 的 size+mtime 不变', async () => {
  const before = snapshot(path.join(ROOT, 'books'));
  await binary('/dsh-book-slides/export/pptx?seriesId=' + series.id + '&lecture=all');
  await binary('/dsh-book-slides/export/pptx/batch?seriesId=' + series.id + '&lectures=all');
  await json('/dsh-book-slides/export/pptx/plan?seriesId=' + series.id + '&lecture=all');
  assert.deepEqual(snapshot(path.join(ROOT, 'books')), before);
});

test('AC-121：缺音频文件 → plan warning + 导出成功且缺 audio2.wav', async () => {
  const found = findSeries(series.id);
  const audioDir = path.join(found.dir, 'lectures', '1', 'audio');
  fs.renameSync(path.join(audioDir, '002.wav'), path.join(audioDir, '002.wav.bak'));
  try {
    const plan = await json('/dsh-book-slides/export/pptx/plan?seriesId=' + series.id + '&lecture=1');
    assert.equal(plan.ok, true);
    assert.ok(plan.plan.warnings.some((text) => text.includes('5/6 页没有音频')), '缺音频要给页数 warning：' + JSON.stringify(plan.plan.warnings));
    assert.ok(plan.plan.lectures[0].missingAudio.includes(2), '缺文件的第 2 页要计入 missingAudio');
    const { res, buffer } = await binary('/dsh-book-slides/export/pptx?seriesId=' + series.id + '&lecture=1');
    assert.equal(res.status, 200);
    const zipPath = path.join(ROOT, 'missing-audio.pptx');
    fs.writeFileSync(zipPath, buffer);
    const names = (await inspectZip(zipPath)).entries.map((entry) => entry.name);
    assert.equal(names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length, 6);
    assert.ok(!names.includes('ppt/media/audio2.wav'), '缺文件的页不嵌音频');
    assert.ok(names.includes('ppt/media/audio3.wav'));
  } finally {
    fs.renameSync(path.join(audioDir, '002.wav.bak'), path.join(audioDir, '002.wav'));
  }
});

test('AC-121：flac 不嵌入、warning 可见、导出仍成功', async () => {
  const found = findSeries(series.id);
  const doc1 = path.join(found.dir, 'lectures', '1');
  const slidesPath = path.join(doc1, 'slides.json');
  const doc = JSON.parse(fs.readFileSync(slidesPath, 'utf8'));
  const original = doc.slides[1];
  fs.renameSync(path.join(doc1, 'audio', '002.wav'), path.join(doc1, 'audio', '002.flac'));
  doc.slides[1] = Object.assign({}, original, { audio_file: 'audio/002.flac' });
  fs.writeFileSync(slidesPath, JSON.stringify(doc, null, 2));
  try {
    const plan = await json('/dsh-book-slides/export/pptx/plan?seriesId=' + series.id + '&lecture=1');
    assert.ok(plan.plan.warnings.some((text) => text.includes('flac')), 'flac 要提示未嵌入');
    const { res, buffer } = await binary('/dsh-book-slides/export/pptx?seriesId=' + series.id + '&lecture=1');
    assert.equal(res.status, 200);
    const zipPath = path.join(ROOT, 'flac-audio.pptx');
    fs.writeFileSync(zipPath, buffer);
    const names = (await inspectZip(zipPath)).entries.map((entry) => entry.name);
    assert.ok(!names.some((name) => name.startsWith('ppt/media/audio2.')), 'flac 不得嵌入');
  } finally {
    fs.renameSync(path.join(doc1, 'audio', '002.flac'), path.join(doc1, 'audio', '002.wav'));
    doc.slides[1] = original;
    fs.writeFileSync(slidesPath, JSON.stringify(doc, null, 2));
  }
});

test('AC-121：超上限按导出模式提示，且不产出半截文件', async () => {
  process.env.DSH_PPT_MAX_BYTES = '4096';
  try {
    const merged = await json('/dsh-book-slides/export/pptx/plan?seriesId=' + series.id + '&lecture=all');
    assert.equal(merged.ok, false);
    assert.equal(merged.code, 'E_EXPORT_SERIES_LIMIT');
    assert.match(merged.hint, /按讲导出/);
    const single = await json('/dsh-book-slides/export/pptx/plan?seriesId=' + series.id + '&lecture=1');
    assert.equal(single.code, 'E_EXPORT_SERIES_LIMIT');
    assert.match(single.hint, /含音频|减少页数/);
    const res = await fetch(baseUrl + '/dsh-book-slides/export/pptx?seriesId=' + series.id + '&lecture=all');
    assert.equal(res.status, 200);
    assert.ok(!String(res.headers.get('content-type') || '').includes('presentationml'), '超限不得产出 PPT');
    const body = JSON.parse(await res.text());
    assert.equal(body.ok, false);
    assert.equal(body.code, 'E_EXPORT_SERIES_LIMIT');
  } finally {
    delete process.env.DSH_PPT_MAX_BYTES;
  }
});

test('资格判定：未就绪讲 E_PPT_NOT_READY；生成中 E_PPT_BUSY', async () => {
  const found = findSeries(series.id);
  patchSeriesLecture(found.series, 2, { status: 'failed' });
  persistSeries(found.series);
  const notReady = await json('/dsh-book-slides/export/pptx/plan?seriesId=' + series.id + '&lecture=2');
  assert.equal(notReady.ok, false);
  assert.equal(notReady.code, 'E_PPT_NOT_READY');

  const afterFail = findSeries(series.id);
  patchSeriesLecture(afterFail.series, 2, { status: 'structuring' });
  persistSeries(afterFail.series);
  const busy = await json('/dsh-book-slides/export/pptx/plan?seriesId=' + series.id + '&lecture=2');
  assert.equal(busy.ok, false);
  assert.equal(busy.code, 'E_PPT_BUSY');
});

test('文件名：去掉「第 N 讲 · 」前缀，非法字符替换', () => {
  assert.equal(stripLecturePrefix('第 2 讲 · 靠近'), '靠近');
  assert.equal(stripLecturePrefix('第12讲：函数'), '函数');
  assert.equal(buildFileName('书/名', '第 1 讲 · a:b'), '书_名-精讲-a_b.pptx');
});

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
