/**
 * 生成纯函数测试 —— 不碰模型、不碰 HTTP。
 *
 *   node test/slides.test.mjs
 *
 * 盯的是 M3 里最容易悄悄错的地方：分块边界、页数/字段校验、锚点归一化匹配。
 * 这些函数一旦错，真书生成出来的幻灯片会「看着能播，但原文对不上」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BATCH_CHARS,
  MAX_SLIDES,
  MIN_SLIDES,
  anchorSlides,
  applyVoicing,
  buildSlidesMessages,
  chapterTextOf,
  estimateAudioMs,
  expectedSlides,
  mergeBatchSlides,
  moduleTextOf,
  moduleTitleOf,
  normalizeForMatch,
  normalizeSlide,
  parseSlidesReply,
  planBatches,
  validateSlideSet,
  validateSlides,
} from '../lib/slides.js';

const PAGES = [
  { page: 1, text: '第一章 开始\n导演的工作，远不止喊一声「开机」。\n这是第一段的文字，用来做锚点测试。' },
  { page: 2, text: '第二章 继续\n第二页第一段有一些文字。\n第二页第二段也有文字，用于匹配。' },
];
const CHAPTERS = [
  { n: 1, title: '第一章 开始', from: 1, to: 1, chars: 45 },
  { n: 2, title: '第二章 继续', from: 2, to: 2, chars: 40 },
];

function makeSlide(index, overrides) {
  const layout = index === 1 ? 'cover' : index % 3 === 0 ? 'quote' : 'content_text';
  return Object.assign(
    {
      slide_index: index,
      layout: layout,
      title: '第 ' + index + ' 页标题',
      subtitle: index === 1 ? '第 1 章' : '',
      bullet_points: layout === 'content_text' ? ['要点一', '要点二'] : [],
      quote_text: layout === 'quote' ? '原文里的一句引文。' : null,
      quote_source: layout === 'quote' ? '测试书' : null,
      image_prompt: '书桌上摊开的书，暖色晨光',
      audio_script: '大家好，这一页我们讲一个很短的意思，尽量说得像聊天一样，不念要点，也不说第一点第二点。',
      source_quote: '导演的工作，远不止喊一声开机。',
      source_pages: { from: 1, to: 1 },
    },
    overrides || {},
  );
}

function makeSlides(count) {
  return Array.from({ length: count || 6 }, (_, index) => makeSlide(index + 1));
}

const CHECK = { text: PAGES.map((page) => page.text).join('\n'), totalPages: 2, minPage: 1, maxPage: 2, allowCover: true, requireCover: true };

test('模块标题：连续用 –，不连续用 、', () => {
  assert.equal(moduleTitleOf([{ n: 1 }, { n: 2 }, { n: 3 }]), '精讲：第 1–3 章');
  assert.equal(moduleTitleOf([{ n: 1 }, { n: 3 }]), '精讲：第 1、3 章');
  assert.equal(moduleTitleOf([{ n: 2 }]), '精讲：第 2 章');
  assert.equal(moduleTitleOf([{ n: 1 }, { n: 3 }, { n: 4 }, { n: 5 }]), '精讲：第 1、3–5 章');
});

test('归一化匹配：空白、标点、全角都不影响命中', () => {
  assert.equal(normalizeForMatch('导演的工作，远不止喊一声「开机」。'), '导演的工作远不止喊一声开机');
  assert.equal(normalizeForMatch('ＡＢＣ 123，'), 'abc123');
});

test('章节与模块原文：按页区间取文本，页间留空行', () => {
  assert.match(chapterTextOf(PAGES, CHAPTERS[0]), /导演的工作/);
  assert.doesNotMatch(chapterTextOf(PAGES, CHAPTERS[0]), /第二页第一段/);
  assert.match(moduleTextOf(PAGES, CHAPTERS), /第一段的文字[\s\S]*第二页第一段/);
});

test('分块：按章节边界累积，单章超长章内切且带 300 字衔接', () => {
  const two = planBatches(CHAPTERS, [
    { page: 1, text: '甲'.repeat(7000) },
    { page: 2, text: '乙'.repeat(7000) },
  ]);
  assert.equal(two.length, 2, '两章各 7000 字，单批 12000 装不下');
  assert.ok(two.every((batch) => batch.chars <= BATCH_CHARS));

  const long = planBatches([{ n: 1, title: '长章', from: 1, to: 1 }], [
    { page: 1, text: Array.from({ length: 10 }, () => '丙'.repeat(2000)).join('\n') },
  ]);
  assert.ok(long.length > 1, '2 万字必须切');
  assert.ok(long.every((batch) => batch.chars <= 8000), '章内按 8000 字切');
  assert.ok(long.slice(1).every((batch) => batch.context.length <= 300), '衔接上下文最多 300 字');
  assert.ok(long.slice(1).every((batch) => batch.context.length > 0), '后续块要带前文');
});

test('页数目标：夹在 6–30，按字数占比分到各批', () => {
  assert.equal(expectedSlides(300, 300, true).total, MIN_SLIDES);
  assert.equal(expectedSlides(1000000, 1000000, true).total, MAX_SLIDES);
  const shared = expectedSlides(24000, 12000, false);
  assert.equal(shared.total, 12);
  assert.equal(shared.share, 6);
});

test('解析：围栏与前后废话都能剥掉，缺字段留空交给校验', () => {
  const payload = {
    module_title: '测试精讲',
    slides: [{ slide_index: 9, layout: 'content_text', title: '一页', bullet_points: ['要点'], source_pages: { from: 2, to: 2 } }],
  };
  const parsed = parseSlidesReply('好的，下面是结果：\n```json\n' + JSON.stringify(payload) + '\n```\n希望有用。');
  assert.equal(parsed.moduleTitle, '测试精讲');
  assert.equal(parsed.slides.length, 1);
  assert.equal(parsed.slides[0].slide_index, 1, 'slide_index 按数组顺序重排');
  assert.equal(parsed.slides[0].audio_script, '');
  assert.equal(parsed.slides[0].quote_text, null);
  assert.deepEqual(parsed.slides[0].source_pages, { from: 2, to: 2 });

  assert.throws(() => parseSlidesReply('抱歉，我写不出来'), /没有 JSON/);
  assert.throws(() => parseSlidesReply('{"slides":[]}'), /空数组/);
});

test('校验：合法的 6 页能过', () => {
  const errors = validateSlides(makeSlides(6), CHECK);
  assert.deepEqual(errors, []);
});

test('校验：标题、要点、引文、配图、配音稿、页码各有硬错误', () => {
  const cases = [
    [{ title: '标'.repeat(30) }, /标题 30 字/],
    [{ layout: 'content_text', bullet_points: [] }, /1–5 条要点/],
    [{ layout: 'content_text', bullet_points: ['要'.repeat(41)] }, /最多 40 字/],
    [{ audio_script: '太短' }, /至少 40 字/],
    [{ audio_script: '大家好，这一页请看幻灯片上的这张图，我来给你解释一下这张图到底在说什么内容。' }, /不能出现依赖画面/],
    [{ image_prompt: 'camera on a desk' }, /必须是中文/],
    [{ source_quote: '太短' }, /至少 10 字/],
    [{ source_pages: { from: 5, to: 6 } }, /超出全书 2 页/],
    [{ layout: 'video' }, /版式只能是/],
  ];
  for (const [patch, pattern] of cases) {
    const slides = makeSlides(6);
    slides[1] = Object.assign({}, slides[1], patch);
    const errors = validateSlides(slides, CHECK);
    assert.ok(errors.some((error) => error.hard && pattern.test(error.message)), '应该抓到：' + pattern + '，实际：' + JSON.stringify(errors));
  }
});

test('校验：封面只能第 1 页，第 1 页必须是封面', () => {
  const slides = makeSlides(6);
  slides[1] = Object.assign({}, slides[1], { layout: 'cover', bullet_points: [], quote_text: null, quote_source: null });
  const errors = validateSlides(slides, CHECK);
  assert.ok(errors.some((error) => /cover 只能出现在第 1 页/.test(error.message)));

  const noCover = makeSlides(6);
  noCover[0] = Object.assign({}, noCover[0], { layout: 'content_text', bullet_points: ['要点'] });
  assert.ok(validateSlides(noCover, CHECK).some((error) => /必须是 cover/.test(error.message)));
});

test('校验：摘抄不是原文子串是软错误，锚点阶段降级而不是判死', () => {
  const slides = makeSlides(6);
  slides[2] = Object.assign({}, slides[2], { source_quote: '这句话在原文里完全不存在啊啊啊' });
  const errors = validateSlides(slides, CHECK);
  const soft = errors.filter((error) => !error.hard);
  assert.equal(errors.length, 1);
  assert.match(soft[0].message, /不是原文的连续片段/);
});

test('模块级校验：页数 6–30，封面位置不能重复', () => {
  assert.ok(validateSlideSet(makeSlides(6)).length === 0);
  assert.ok(validateSlideSet(makeSlides(5)).some((message) => /至少 6 页/.test(message)));
  const tooMany = makeSlides(31);
  assert.ok(validateSlideSet(tooMany).some((message) => /最多 30 页/.test(message)));

  const twoCovers = makeSlides(6);
  twoCovers[3] = Object.assign({}, twoCovers[3], { layout: 'cover', bullet_points: [] });
  assert.ok(validateSlideSet(twoCovers).some((message) => /又出现了 cover/.test(message)));
});

test('合并：按批次首尾相接并重排 slide_index', () => {
  const merged = mergeBatchSlides([
    { slides: [makeSlide(1), makeSlide(2)] },
    { slides: [makeSlide(1), makeSlide(2)] },
  ]);
  assert.deepEqual(
    merged.map((slide) => slide.slide_index),
    [1, 2, 3, 4],
  );
});

test('锚点：整句匹配定位到页与段，跨行也能命中', () => {
  const slides = makeSlides(6);
  slides[1] = Object.assign({}, slides[1], { source_quote: '第二页第一段有一些文字。\n第二页第二段也有文字，用于匹配。' });
  const result = anchorSlides(slides, PAGES, { minPage: 1, maxPage: 2 });
  assert.equal(result.slides[1].anchor_status, 'anchored');
  assert.equal(result.slides[1].anchor_kind, 'exact');
  assert.deepEqual(result.slides[1].source_anchor, { page: 2, para_index: 1 });
  assert.equal(result.hitRate, 1);
});

test('锚点：模型改了结尾时用前缀兜底，仍算定位', () => {
  const slides = makeSlides(6);
  slides[0] = Object.assign({}, slides[0], { source_quote: '第二页第一段有一些文字第二页第二段也有文字但结尾被改了' });
  const result = anchorSlides(slides, PAGES, { minPage: 1, maxPage: 2 });
  assert.equal(result.slides[0].anchor_status, 'anchored');
  assert.equal(result.slides[0].anchor_kind, 'prefix');
  assert.equal(result.slides[0].source_anchor.page, 2);
});

test('锚点：找不到就 unanchored，命中率下降；摘抄页会收窄错误范围', () => {
  const slides = makeSlides(6);
  slides[0] = Object.assign({}, slides[0], { source_quote: '完全不存在的句子内容啊啊啊', source_pages: { from: 1, to: 1 } });
  slides[1] = Object.assign({}, slides[1], { source_quote: '第二页第二段也有文字', source_pages: { from: 1, to: 1 } });
  const result = anchorSlides(slides, PAGES, { minPage: 1, maxPage: 2 });
  assert.equal(result.slides[0].anchor_status, 'unanchored');
  assert.equal(result.slides[0].source_anchor, null);
  assert.deepEqual(result.slides[1].source_pages, { from: 2, to: 2 }, '锚点在第 2 页，范围收窄到第 2 页');
  assert.equal(result.anchored, 5);
  assert.ok(Math.abs(result.hitRate - 5 / 6) < 1e-9);
});

test('朗读时长：按字数估，语速越快越短', () => {
  const script = '这是一段四十个字以上的朗读稿，用来检查时长估算是不是随语速变化，数字不必精确，趋势必须对。';
  const slow = estimateAudioMs(script, 0.8);
  const normal = estimateAudioMs(script, 1);
  const fast = estimateAudioMs(script, 1.2);
  assert.ok(slow > normal);
  assert.ok(normal > fast);
  assert.ok(normal > 5000, '40 多字至少几秒');
  assert.equal(estimateAudioMs('', 1), 0);
});

test('配音计划：浏览器只标时长，关闭时标 none', () => {
  const browser = applyVoicing(makeSlides(2), { provider: 'browser', rate: 1 });
  assert.ok(browser.every((slide) => slide.audio_provider === 'browser'));
  assert.ok(browser.every((slide) => slide.audio_ms > 0));
  assert.ok(browser.every((slide) => slide.audio_file === null));

  const off = applyVoicing(makeSlides(2), { provider: 'off', rate: 1 });
  assert.ok(off.every((slide) => slide.audio_provider === 'none'));
  assert.ok(off.every((slide) => slide.audio_ms === 0));
});

test('提示词：带原文、批次要求与 JSON 约束', () => {
  const batch = planBatches(CHAPTERS, PAGES)[0];
  const messages = buildSlidesMessages({
    promptFile: '系统提示',
    book: { title: '测试书' },
    moduleTitle: '精讲：第 1、2 章',
    batch: batch,
    index: 0,
    totalBatches: 1,
    target: { total: 6, share: 6 },
  });
  assert.equal(messages.system, '系统提示');
  assert.match(messages.user, /【本批原文】/);
  assert.match(messages.user, /导演的工作/);
  assert.match(messages.user, /第 1 页必须 layout=cover/);
  assert.match(messages.user, /严格 JSON/);
});

test('normalizeSlide：未知版式原样保留，让校验报错', () => {
  const slide = normalizeSlide({ layout: 'video', title: ' 一页 ', bullet_points: [' 要点 ', ''] }, 3);
  assert.equal(slide.slide_index, 4);
  assert.equal(slide.layout, 'video');
  assert.equal(slide.title, '一页');
  assert.deepEqual(slide.bullet_points, ['要点']);
});
