/**
 * 2.0 M3 后端：逐讲生成、批预算、锚点、预缝、后验缝与修复。
 * 模型全部为假模型；真路由在 v2-m3-server.test.mjs。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-v2-m3-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, loadBook, writeChapters } = await import('../v2/books.js');
const { savePart } = await import('../v2/parts.js');
const { createSeries, findSeries } = await import('../v2/series.js');
const { startSeriesJob, startLectureJob, reconcileAllSeries } = await import('../v2/generate.js');
const { buildStitchReport, repairStitch, duplicateRate } = await import('../v2/stitch.js');
const { loadLecture, writeLectureOutputs, writeLectureMeta } = await import('../v2/lectures.js');
const { writeJson } = await import('../v2/root.js');

const SEAM = '上一讲把函数当机器；这一讲只问靠近某点时输出去哪。';

function makeBook(tag) {
  const rawPages = [
    { page: 1, text: '第1章 甲\n' + '甲'.repeat(11000) },
    { page: 2, text: '第2章 乙\n' + '乙'.repeat(11000) },
  ];
  const chapters = [
    { n: 1, title: '第1章 甲', from: 1, to: 1, chars: 11000, toc: false, front: false },
    { n: 2, title: '第2章 乙', from: 2, to: 2, chars: 11000, toc: false, front: false },
  ];
  const book = createBook({ buffer: Buffer.from('m3-' + tag + '-' + Date.now()), fileName: tag + '.pdf', title: 'M3 ' + tag, author: '', pages: 2, rawPages });
  writeChapters(book.id, chapters, 'manual');
  return loadBook(book.id);
}

function makePlan() {
  return {
    throughline: '把函数当机器，再看它靠近某点时输出去哪。',
    lectures: [
      { n: 1, chapters: [1], title: '第 1 讲 · 函数是机器', goal: '认识函数', in: '无', out: '会读函数', pages: 6, chars: 11000 },
      { n: 2, chapters: [2], title: '第 2 讲 · 靠近某点', goal: '理解极限', in: '函数是机器', out: '会看趋势', pages: 6, chars: 11000 },
    ],
    seams: [{ from: 1, to: 2, concept: '极限', sentence: SEAM }],
    terms: [{ name: '定义域', forbid: ['定义区间'] }],
    cut_notes: [],
    source: 'model',
    stitched: true,
    totalChars: 24000,
    totalPages: 12,
    estMinutes: 12,
  };
}

function makeSeries(loaded, plan) {
  const part = savePart({ bookId: loaded.book.id, chapters: [1, 2], title: '函数' });
  return createSeries({ bookId: loaded.book.id, partId: part.id, title: '函数', plan: plan || makePlan() });
}

function baseSlide(lectureNo, index, chapterNo) {
  const sourcePage = chapterNo;
  const mark = chapterNo === 1 ? '甲' : '乙';
  const common = {
    layout: 'content_text',
    title: mark + '讲要点 ' + index,
    subtitle: '',
    bullet_points: [mark.repeat(20), mark.repeat(12) + '收束'],
    quote_text: null,
    quote_source: null,
    image_prompt: mark + '机器在纸上画出曲线',
    audio_script: mark.repeat(60),
    source_quote: mark.repeat(60),
    source_pages: { from: sourcePage, to: sourcePage },
  };
  if (index === 0) {
    return Object.assign({}, common, {
      layout: 'cover',
      title: '第 ' + lectureNo + ' 讲',
      subtitle: '函数与极限',
      bullet_points: [],
      quote_text: null,
      quote_source: null,
    });
  }
  return common;
}

function slidesFor(lectureNo) {
  const chapterNo = lectureNo;
  return Array.from({ length: 6 }, (_, index) => baseSlide(lectureNo, index, chapterNo));
}

function textChunk(text) {
  return { type: 'text-delta', text };
}

function makeCtx() {
  const calls = { generate: 0, seam: 0, duplicate: 0 };
  return {
    calls,
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
      if (name !== 'llm') return null;
      return {
        async prepareCall() {
          return {
            config: {},
            async *stream(config) {
              const user = config.messages && config.messages[0] && config.messages[0].content[0] ? config.messages[0].content[0].text : '';
              if (user.includes('【待重写页】')) {
                calls.duplicate += 1;
                const page = JSON.parse(user.split('【待重写页】')[1].split('【要求】')[0].trim());
                yield textChunk(JSON.stringify({
                  slides: [Object.assign({}, page, {
                    audio_script: '换个角度说乙章：这里只讲第二讲自己的推理，不复述前一讲已经讲过的内容，接着往下走。',
                    bullet_points: ['乙章自己的要点', '继续往后推理'],
                  })],
                }));
              } else if (user.includes('【任务】只重写这一页的 audio_script')) {
                calls.seam += 1;
                const line = user.split('\n').find((item) => item.includes('【必须】')) || '';
                const sentence = line.split('：').slice(1).join('：').trim();
                const isCover = line.includes('逐字开头');
                yield textChunk(JSON.stringify({
                  audio_script: isCover
                    ? sentence + ' 这是修好之后的封面朗读稿，长度也落在规定区间里面。'
                    : '这是修好之后的末页朗读稿，内容保持完整。 ' + sentence,
                }));
              } else {
                calls.generate += 1;
                const lectureNo = Number((/【本讲】第 (\d+)\//.exec(user) || [0, 1])[1]) || 1;
                yield textChunk(JSON.stringify({ module_title: '', slides: slidesFor(lectureNo) }));
              }
              yield { type: 'finish', reason: { kind: 'stop' } };
            },
          };
        },
      };
    },
  };
}

async function run(series, ctx) {
  const found = findSeries(series.id);
  const out = startSeriesJob({ found, ctx, force: [] });
  assert.equal(out.cached, false);
  await out.job.promise;
  return findSeries(series.id);
}

test('AC-103：2 讲生成后预缝断言逐字通过，音频字段留空，系列 ready/stitched', async () => {
  const loaded = makeBook('pre');
  const series = makeSeries(loaded);
  const found = await run(series, makeCtx());

  assert.equal(found.series.status, 'ready');
  assert.equal(found.series.stitch, 'stitched');
  const first = loadLecture(found.dir, 1);
  const second = loadLecture(found.dir, 2);
  assert.equal(first.slidesDoc.slides.length, 6);
  assert.equal(second.slidesDoc.slides.length, 6);
  assert.ok(String(second.slidesDoc.slides[0].audio_script).trim().startsWith(SEAM));
  assert.ok(String(first.slidesDoc.slides[5].audio_script).trim().endsWith(SEAM));
  assert.equal(second.slidesDoc.slides[0].audio_file, null);
  assert.equal(second.slidesDoc.slides[0].audio_provider, 'none');
  assert.equal(found.series.lectures[0].status, 'ready');

  const report = buildStitchReport(found);
  assert.equal(report.state, 'stitched');
  assert.equal(report.metrics.find((m) => m.id === 'seam').ok, true);
  assert.equal(report.metrics.find((m) => m.id === 'coverage').ok, true);
});

test('AC-104：篡改第 2 讲封面后只触发 1 次页级修复，第 1 讲文件不变', async () => {
  const loaded = makeBook('seam');
  const series = makeSeries(loaded);
  const generated = await run(series, makeCtx());
  const second = loadLecture(generated.dir, 2);
  const firstFile = path.join(generated.dir, 'lectures', '1', 'slides.json');
  const firstMtime = fs.statSync(firstFile).mtimeMs;

  second.slidesDoc.slides[0] = Object.assign({}, second.slidesDoc.slides[0], {
    audio_script: '被改坏的开头，' + '这一段仍然有足够长度但它没有接缝句。'.repeat(2),
  });
  writeLectureOutputs(generated.dir, 2, second.lecture, second.slidesDoc);
  const before = buildStitchReport(generated);
  assert.equal(before.state, 'unstitched');
  assert.ok(before.failures.some((f) => f.type === 'seam' && f.lecture === 2));

  const ctx = makeCtx();
  const out = await repairStitch({ found: generated, ctx });
  const secondAfter = loadLecture(generated.dir, 2);
  assert.ok(String(secondAfter.slidesDoc.slides[0].audio_script).trim().startsWith(SEAM));
  assert.equal(out.report.state, 'stitched');
  assert.ok(out.repaired.some((item) => item.type === 'seam' && item.lecture === 2));
  assert.equal(out.repaired.filter((item) => item.type === 'seam').length, 1);
  assert.equal(fs.statSync(firstFile).mtimeMs, firstMtime);
  assert.equal(ctx.calls.generate, 0);
});

test('AC-105：术语禁用词报告定位到讲，确定性修复后术语 0', async () => {
  const loaded = makeBook('term');
  const series = makeSeries(loaded);
  const generated = await run(series, makeCtx());
  const second = loadLecture(generated.dir, 2);
  second.slidesDoc.slides[2] = Object.assign({}, second.slidesDoc.slides[2], { title: '定义区间与邻域' });
  writeLectureOutputs(generated.dir, 2, second.lecture, second.slidesDoc);

  const before = buildStitchReport(generated);
  const termMetric = before.metrics.find((m) => m.id === 'terms');
  assert.equal(termMetric.ok, false);
  assert.ok(before.failures.some((f) => f.type === 'term' && f.lecture === 2 && f.forbid === '定义区间'));

  const out = await repairStitch({ found: generated, ctx: null, targets: ['term'] });
  assert.equal(out.report.metrics.find((m) => m.id === 'terms').ok, true);
  const after = loadLecture(generated.dir, 2);
  assert.ok(String(after.slidesDoc.slides[2].title).includes('定义域'));
  assert.ok(!String(after.slidesDoc.slides[2].title).includes('定义区间'));
});

test('AC-106：重复率超限报告建议重生成衔接页，页级修复后 ≤0.5 且第 1 讲不变', async () => {
  const loaded = makeBook('dup');
  const series = makeSeries(loaded);
  const generated = await run(series, makeCtx());
  const first = loadLecture(generated.dir, 1);
  const second = loadLecture(generated.dir, 2);
  const dupIndex = 3;
  second.slidesDoc.slides[dupIndex] = Object.assign({}, first.slidesDoc.slides[dupIndex], {
    source_pages: { from: 2, to: 2 },
    source_quote: '乙'.repeat(60),
  });
  writeLectureOutputs(generated.dir, 2, second.lecture, second.slidesDoc);
  const firstFile = path.join(generated.dir, 'lectures', '1', 'slides.json');
  const firstMtime = fs.statSync(firstFile).mtimeMs;

  const before = buildStitchReport(generated);
  const dupMetric = before.metrics.find((m) => m.id === 'duplicate');
  assert.equal(dupMetric.ok, false);
  assert.ok(before.failures.some((f) => f.type === 'duplicate' && /重生成衔接页/.test(f.action)));

  const ctx = makeCtx();
  const out = await repairStitch({ found: generated, ctx, targets: ['duplicate'] });
  const after = buildStitchReport(findSeries(series.id));
  const rate = duplicateRate(first.slidesDoc, loadLecture(generated.dir, 2).slidesDoc);
  assert.ok(rate <= 0.5, '重复率应降到 0.5 以下，实际 ' + rate);
  assert.equal(after.metrics.find((m) => m.id === 'duplicate').ok, true);
  assert.ok(out.repaired.some((item) => item.type === 'duplicate'));
  assert.ok(ctx.calls.duplicate >= 1);
  assert.equal(fs.statSync(firstFile).mtimeMs, firstMtime);
});

test('作业幂等：已 ready 的系列再次 start 命中缓存，不产生新调用', async () => {
  const loaded = makeBook('cached');
  const series = makeSeries(loaded);
  const generated = await run(series, makeCtx());
  const ctx = makeCtx();
  const out = startSeriesJob({ found: generated, ctx, force: [] });
  assert.equal(out.cached, true);
  assert.equal(out.jobId, null);
  assert.deepEqual(out.skipped, [1, 2]);
  assert.equal(ctx.calls.generate, 0);
});

test('启动归一：drafting/stitching 与进行中的讲标成 interrupted', () => {
  const loaded = makeBook('reconcile');
  const series = makeSeries(loaded);
  const found = findSeries(series.id);
  found.series.status = 'drafting';
  found.series.lectures[0].status = 'structuring';
  writeJson(path.join(found.dir, 'series.json'), found.series);
  writeLectureMeta(found.dir, 1, { schema: 1, series_id: series.id, n: 1, status: 'structuring' });

  reconcileAllSeries();
  const after = findSeries(series.id);
  assert.equal(after.series.status, 'interrupted');
  assert.equal(after.series.lectures[0].status, 'interrupted');
  assert.equal(loadLecture(after.dir, 1).lecture.status, 'interrupted');
});

test('页序与章序：后一页允许回顾前文，source_pages 回退不算失败', async () => {
  const loaded = makeBook('order');
  const series = makeSeries(loaded);
  const generated = await run(series, makeCtx());
  const second = loadLecture(generated.dir, 2);
  // 第 2 讲第 3 页回顾第 1 章：source_pages 从第 2 页回退到第 1 页，这是合法讲法
  second.slidesDoc.slides[2] = Object.assign({}, second.slidesDoc.slides[2], {
    source_pages: { from: 1, to: 1 },
  });
  writeLectureOutputs(generated.dir, 2, second.lecture, second.slidesDoc);

  const report = buildStitchReport(generated);
  assert.equal(report.metrics.find((m) => m.id === 'order').ok, true);
  assert.equal(report.state, 'stitched');
  assert.ok(!report.failures.some((failure) => /页序回退/.test(failure.message)));
});

test('批预算：超长章按 1.2 万/8 千切批，后续批不出 cover；重跑复用批检查点', async () => {
  const text = '第1章 长\n' + '甲'.repeat(20000);
  const rawPages = [{ page: 1, text }];
  const book = createBook({
    buffer: Buffer.from('m3-batch-' + Date.now()),
    fileName: 'batch.pdf',
    title: '批预算书',
    author: '',
    pages: 1,
    rawPages,
  });
  writeChapters(book.id, [{ n: 1, title: '第1章 长', from: 1, to: 1, chars: text.length, front: false }], 'manual');
  const part = savePart({ bookId: book.id, chapters: [1], title: '长章' });
  const series = createSeries({
    bookId: book.id,
    partId: part.id,
    title: '长章',
    plan: {
      throughline: '长章拆批',
      lectures: [{ n: 1, chapters: [1], title: '第 1 讲 · 长章', goal: 'g', in: '', out: '', pages: 10, chars: text.length }],
      seams: [],
      terms: [],
      cut_notes: [],
      source: 'rule',
      stitched: false,
      totalChars: text.length,
      totalPages: 10,
      estMinutes: 10,
    },
  });

  let calls = 0;
  const ctx = {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
      if (name !== 'llm') return null;
      return {
        async prepareCall() {
          return {
            config: {},
            async *stream(config) {
              calls += 1;
              const user = config.messages[0].content[0].text;
              const first = user.includes('本批是整讲第一批');
              const count = first ? 6 : 2;
              const slides = Array.from({ length: count }, (_, index) => ({
                layout: first && index === 0 ? 'cover' : 'content_text',
                title: first && index === 0 ? '第 1 讲' : '长章要点 ' + index,
                subtitle: '',
                bullet_points: first && index === 0 ? [] : ['甲'.repeat(20)],
                quote_text: null,
                quote_source: null,
                image_prompt: '甲机器在纸上画出曲线',
                audio_script: '甲'.repeat(60),
                source_quote: '甲'.repeat(60),
                source_pages: { from: 1, to: 1 },
              }));
              yield { type: 'text-delta', text: JSON.stringify({ module_title: '', slides }) };
              yield { type: 'finish', reason: { kind: 'stop' } };
            },
          };
        },
      };
    },
  };
  const found = findSeries(series.id);
  const out = startSeriesJob({ found, ctx, force: [] });
  await out.job.promise;
  const after = findSeries(series.id);
  assert.equal(after.series.status, 'ready');
  assert.ok(calls >= 2, '超长章应切成多批，实际调用 ' + calls);
  const doc = loadLecture(after.dir, 1);
  assert.ok(doc.slidesDoc.slides.length > 6);
  assert.equal(doc.slidesDoc.slides.filter((slide) => slide.layout === 'cover').length, 1);
  assert.equal(doc.lecture.pages, doc.slidesDoc.slides.length);
  assert.equal(after.series.stitch, 'verified');

  // 强制重跑同一讲：批检查点命中，不再调用模型
  const throwingCtx = {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake' }) };
      if (name !== 'llm') return null;
      return {
        async prepareCall() {
          return {
            config: {},
            async *stream() {
              throw new Error('不应调用模型：批检查点应命中');
            },
          };
        },
      };
    },
  };
  const rerun = startLectureJob({ found: findSeries(series.id), n: 1, force: true, ctx: throwingCtx });
  const callsBefore = calls;
  await rerun.job.promise;
  assert.equal(rerun.job.status, 'ready');
  assert.equal(calls, callsBefore, '重跑不应增加模型调用');
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});





