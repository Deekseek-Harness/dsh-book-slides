#!/usr/bin/env node
/**
 * 验证 2.3：对已生成的讲义做“must_keep 语义审计 + 定点补讲”，不重新生成、不改页数。
 *
 *   node scripts/refine-lecture-quality.mjs --series g91nwrt7el --lecture 1
 *   node scripts/refine-lecture-quality.mjs --series g91nwrt7el --lecture 1 --json
 *
 * 只写 lecture 1 的 slides.json / lecture.json；不调模型。
 */
import { findSeries } from '../host/series.js';
import { seriesChapterTexts, writeLectureOutputs, loadLecture } from '../host/lectures.js';
import { buildStitchReport, writeStitchReport } from '../host/stitch.js';
import { auditSections, repairMissingMustKeep } from '../host/generate.js';

function parseArgs(argv) {
  const out = { series: '', lecture: 1, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--series' || arg === '-s') out.series = String(argv[++i] || '');
    else if (arg === '--lecture' || arg === '-n') out.lecture = Number(argv[++i]) || 1;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.series) {
  console.log('用法: node scripts/refine-lecture-quality.mjs --series <seriesId> [--lecture 1] [--json]');
  process.exit(args.help ? 0 : 1);
}

const found = findSeries(args.series);
if (!found) {
  console.error('找不到系列：' + args.series);
  process.exit(1);
}
const doc = loadLecture(found.dir, args.lecture);
if (!doc.lecture || !doc.slidesDoc) {
  console.error('找不到第 ' + args.lecture + ' 讲');
  process.exit(1);
}
const texts = seriesChapterTexts(found.series.book_id, found.series);
if (!texts) {
  console.error('找不到书的逐页文本');
  process.exit(1);
}
const chapterMap = new Map(texts.chapters.map((chapter) => [Number(chapter.n), chapter]));
const used = (doc.lecture.chapters || []).map((n) => chapterMap.get(Number(n))).filter(Boolean);
const maxPage = used.length ? Math.max(...used.map((chapter) => Number(chapter.to))) : texts.pages.length;
const lecture = (found.series.lectures || []).find((item) => Number(item.n) === Number(args.lecture));
if (!lecture) {
  console.error('系列里没有第 ' + args.lecture + ' 讲');
  process.exit(1);
}

// lecture.pages 在生成后会被覆盖成实际页数；审计要用计划页数做预算对照。
const plannedPages = Number(
  (doc.slidesDoc.quality && doc.slidesDoc.quality.planned_pages)
  || (doc.lecture.quality && doc.lecture.quality.planned_pages)
  || lecture.pages,
) || 0;
const auditLecture = Object.assign({}, lecture, { pages: plannedPages || lecture.pages });
const before = auditSections(doc.slidesDoc.slides, auditLecture, maxPage);
const refined = await repairMissingMustKeep(doc.slidesDoc.slides, auditLecture, chapterMap, texts.pages, maxPage);
const after = auditSections(refined.slides, auditLecture, maxPage);
const priorRepair = (doc.slidesDoc.quality && doc.slidesDoc.quality.repair) || {};
const quality = Object.assign({}, after, {
  repair: Object.assign({}, priorRepair, {
    // 重复运行时 repair 为空，不能把上一次已补讲的记录擦掉。
    repaired_must_keep: refined.repaired.length ? refined.repaired : (priorRepair.repaired_must_keep || []),
  }),
});

doc.slidesDoc.slides = refined.slides;
doc.slidesDoc.quality = quality;
doc.lecture.quality = quality;
writeLectureOutputs(found.dir, args.lecture, doc.lecture, doc.slidesDoc);

const report = buildStitchReport(found);
writeStitchReport(found, report, { persist: true });

const summary = {
  series: found.series.id,
  lecture: Number(args.lecture),
  before: {
    content_ok: before.content_ok,
    strict_missing: before.missing_must_keep.length,
    aliases: before.must_keep_aliases.length,
    real_missing: before.must_keep_real_missing,
  },
  repaired: refined.repaired,
  after: {
    content_ok: after.content_ok,
    strict_missing: after.missing_must_keep.length,
    aliases: after.must_keep_aliases.map((item) => item.must_keep),
    real_missing: after.must_keep_real_missing,
    slides: after.actual_pages,
    planned_pages: after.planned_pages,
    over_budget: after.over_budget,
  },
  stitch: report.state,
};

if (args.json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log('系列：' + summary.series + ' · 第 ' + summary.lecture + ' 讲');
  console.log('修复前：content_ok=' + before.content_ok + '，严格 missing=' + before.missing_must_keep.length + '，别名=' + before.must_keep_aliases.length + '，真实缺=' + before.must_keep_real_missing.map((x) => x.must_keep).join('、'));
  if (refined.repaired.length) {
    for (const item of refined.repaired) console.log('  补讲：' + item.section + ' / ' + item.must_keep + ' → 第 ' + item.page + ' 页：「' + item.sentence + '」');
  }
  console.log('修复后：content_ok=' + after.content_ok + '，严格 missing=' + after.missing_must_keep.length + '，别名=' + after.must_keep_aliases.map((x) => x.must_keep).join('、') + '，真实缺=' + (after.must_keep_real_missing.map((x) => x.must_keep).join('、') || '无'));
  console.log('页数：' + after.actual_pages + ' / 计划 ' + after.planned_pages + '（over_budget=' + after.over_budget + '，未强制修复）');
  console.log('stitch：' + report.state);
}
