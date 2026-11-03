/**
 * 精讲台 · 幻灯片生成（M3）
 *
 * 这里只做「能脱离服务端和模型单独测」的纯函数：
 *   分块 → 拼提示词 → 解析 JSON → 校验 → 合并 → 锚点回填 → 估算朗读时长
 *
 * 三条分工，和目录解析一样：
 *   模型  只写文案，并把 source_quote 从原文里**逐字抄**下来
 *   程序  判断它抄得对不对（是不是原文连续子串）、页数够不够、字段合不合规
 *   程序  用归一化匹配把 source_quote 钉回 {page, para_index}，模型不负责定位
 *
 * 关键设计：
 *   - 送模型的文本是 text.js 清洗过的；锚点匹配打的是 pages.json 的原始文本。
 *     清洗会去掉页眉页码、合并软换行，模型抄出来的句子多半仍能在原文里找到；
 *     少数跨过被删页码的句子匹配不上，走「前缀兜底」或锚点修复，不拖垮整个模块。
 *   - 校验的错误分两档：hard 直接触发修复调用；soft（摘抄不是原文子串）交给锚点阶段，
 *     因为 D10 允许 unanchored 降级，不该为一句摘抄把整套幻灯片判死。
 */

export const SLIDES_PROMPT_VERSION = 'b2p-v1';

/** 单批不超过 1.2 万字；单章超长时章内按 8 千字切，批间带 300 字衔接。 */
export const BATCH_CHARS = 12000;
export const SPLIT_CHARS = 8000;
export const CARRY_CHARS = 300;

/** 模块页数硬约束（§5.2）。 */
export const MIN_SLIDES = 6;
export const MAX_SLIDES = 30;

/** 单页字段上限（§5.2 / D9）。 */
export const TITLE_MAX = 24;
export const BULLET_MAX = 40;
export const BULLET_COUNT_MAX = 5;
export const QUOTE_TEXT_MAX = 120;
export const QUOTE_SOURCE_MAX = 60;
export const IMAGE_PROMPT_MAX = 60;
export const AUDIO_MIN = 40;
export const AUDIO_MAX = 220;
export const SOURCE_QUOTE_MIN = 10;
export const SOURCE_QUOTE_MAX = 200;

/** 一页多少字；只用来给模型一个页数目标，不参与验收。 */
const CHARS_PER_SLIDE = 2000;

/** 中文朗读速度：约每秒 4.2 字（1.0 倍速）。只用于进度条与时长预估。 */
const CHARS_PER_SECOND = 4.2;

const LAYOUTS = ['cover', 'content_text', 'quote'];
const VISUAL_WORDS = /如下图所示|如下图|见图|看图|图中|表格|图表|幻灯片|屏幕上|画面里|视频/;
const CJK = /[\u3400-\u9fff]/;
const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\ufeff]/g;

/* ------------------------------ 小工具 ------------------------------ */

/** 字符数：中文按字算，和面板里的「字」一致。 */
export function charCount(text) {
  return String(text == null ? '' : text).length;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 行内文本归一：换行压成空格、去首尾空白。 */
function cleanInline(raw, limit) {
  const text = String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    .trim();
  return limit && text.length > limit ? text.slice(0, limit) : text;
}

/**
 * 归一化匹配：去空白、去标点、全角转半角、统一小写。
 *
 * 只做这些。不做繁简转换（D10）——那会改变原文字符，让「命中」变成猜。
 * source_quote 从清洗后的文本抄来，原文页上可能有被去掉的页码和换行，
 * 所以两边都按同一规则归一，再比字符串。
 */
export function normalizeForMatch(text) {
  return String(text == null ? '' : text)
    .replace(ZERO_WIDTH, '')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/* ------------------------------ 标题与原文 ------------------------------ */

/**
 * 模块标题：「精讲：第 1–3 章」/「精讲：第 1、3 章」/「精讲：第 2 章」。
 * 连续段用 –，不连续用 、，和 FR-4 一致。
 */
export function moduleTitleOf(chapters) {
  const ns = (Array.isArray(chapters) ? chapters : [])
    .map((c) => Math.round(Number(c && c.n) || 0))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  if (!ns.length) return '精讲：未选章节';
  const ranges = [];
  let start = ns[0];
  let prev = ns[0];
  for (let i = 1; i < ns.length; i += 1) {
    if (ns[i] === prev + 1) {
      prev = ns[i];
      continue;
    }
    ranges.push([start, prev]);
    start = ns[i];
    prev = ns[i];
  }
  ranges.push([start, prev]);
  const parts = ranges.map(([a, b]) => (b > a ? a + '–' + b : String(a)));
  return '精讲：第 ' + parts.join('、') + ' 章';
}

/** 一章的文本：按页序取该章页区间的清洗文本，页与页之间空行。 */
export function chapterTextOf(pages, chapter) {
  if (!Array.isArray(pages) || !chapter) return '';
  const from = Math.round(Number(chapter.from) || 0);
  const to = Math.round(Number(chapter.to) || 0);
  const parts = [];
  for (const page of pages) {
    const no = Math.round(Number((page && page.page) || 0) || 0);
    if (!no || no < from || no > to) continue;
    const text = String((page && page.text) || '').trim();
    if (text) parts.push(text);
  }
  return parts.join('\n\n');
}

/** 选中章节拼起来（模块级修复、锚点修复用）。 */
export function moduleTextOf(pages, chapters) {
  return (Array.isArray(chapters) ? chapters : [])
    .map((chapter) => chapterTextOf(pages, chapter))
    .filter(Boolean)
    .join('\n\n');
}

/* ------------------------------ 分块 ------------------------------ */

/**
 * 把超长章节按段落切成 ≤ limit 的块，并给后一块带上前一块末尾 300 字。
 *
 * 硬切只在「单段本身超长」时发生：宁可切断一句话，也不把一万字一段整块塞给模型。
 * @returns {{text:string, carry:string}[]}
 */
export function splitLongText(text, limit) {
  const cap = Math.max(500, Math.round(Number(limit) || SPLIT_CHARS));
  const paragraphs = String(text || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const chunks = [];
  let cur = '';

  const flush = () => {
    if (cur.trim()) chunks.push(cur);
    cur = '';
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > cap) {
      flush();
      for (let at = 0; at < paragraph.length; at += cap) {
        const piece = paragraph.slice(at, at + cap);
        if (at + cap < paragraph.length) chunks.push(piece);
        else cur = piece;
      }
      continue;
    }
    if (cur && cur.length + 1 + paragraph.length > cap) flush();
    cur = cur ? cur + '\n' + paragraph : paragraph;
  }
  flush();

  return chunks.map((text, index) => ({
    text: text,
    carry: index > 0 ? chunks[index - 1].slice(-CARRY_CHARS) : '',
  }));
}

/**
 * 把选中的章节排成批次。
 *
 * 规则（D11）：
 *   - 按章节边界累积，单批 ≤ 12000 字；
 *   - 单章超过 12000 字，章内按 8000 字切，批间带前批末尾 300 字衔接；
 *   - 每批记住自己覆盖的章节和页码范围，校验与锚点都按批走。
 *
 * @param {{n:number,title:string,from:number,to:number}[]} chapters 选中的章节（按 n 升序）
 * @param {{page:number,text:string}[]} pages 清洗后的逐页文本
 * @returns {{index:number,chapters:object[],text:string,context:string,chars:number,part:object|null}[]}
 */
export function planBatches(chapters, pages, options) {
  const opts = options || {};
  const batchLimit = Math.max(2000, Math.round(Number(opts.batchChars) || BATCH_CHARS));
  const splitLimit = Math.max(1000, Math.round(Number(opts.splitChars) || SPLIT_CHARS));
  const batches = [];
  let current = null;

  const flush = () => {
    if (current && current.chapters.length) batches.push(current);
    current = null;
  };

  for (const chapter of Array.isArray(chapters) ? chapters : []) {
    if (!chapter) continue;
    const text = chapterTextOf(pages, chapter);
    if (!text.trim()) continue;

    if (text.length > batchLimit) {
      flush();
      const pieces = splitLongText(text, splitLimit);
      pieces.forEach((piece, index) => {
        batches.push({
          chapters: [chapter],
          text: piece.text,
          context: piece.carry,
          chars: piece.text.length,
          part: pieces.length > 1 ? { index: index + 1, total: pieces.length } : null,
        });
      });
      continue;
    }

    if (!current) current = { chapters: [], text: '' };
    if (current.text && current.text.length + 2 + text.length > batchLimit) flush();
    if (!current) current = { chapters: [], text: '' };
    current.chapters.push(chapter);
    current.text += (current.text ? '\n\n' : '') + text;
    current.chars = current.text.length;
    current.context = '';
    current.part = null;
  }
  flush();

  return batches.map((batch, index) => ({
    index: index,
    chapters: batch.chapters,
    text: batch.text,
    context: batch.context || '',
    chars: batch.text.length,
    part: batch.part || null,
  }));
}

/**
 * 这一批大概要几页。
 *
 * 目标密度 1 页 / 2000 字，整模块夹在 6–30 页之间；再按字数占比分到各批。
 * 只写进提示词，最终以模型输出＋校验为准。
 */
export function expectedSlides(totalChars, batchChars, isFirst) {
  const total = clamp(Math.round((Number(totalChars) || 0) / CHARS_PER_SLIDE), MIN_SLIDES, MAX_SLIDES);
  const share = clamp(Math.round((total * (Number(batchChars) || 0)) / Math.max(1, Number(totalChars) || 1)), isFirst ? 2 : 1, 12);
  return { total: total, share: share };
}

/* ------------------------------ 提示词 ------------------------------ */

function chapterLines(chapters) {
  return (Array.isArray(chapters) ? chapters : [])
    .map((chapter) => '【第 ' + chapter.n + ' 章 ' + String(chapter.title || '').trim() + '】')
    .join('\n');
}

/**
 * 拼一批的提示词。
 *
 * 原文只放正文，章节标题单独一行放上面：标题是我们造的短标签，不是原文，
 * 模型若把它抄进 source_quote，会被「不是本批原文连续子串」抓到。
 */
export function buildSlidesMessages({ promptFile, book, moduleTitle, batch, index, totalBatches, target }) {
  const isFirst = index === 0;
  const chapterNos = batch.chapters.map((chapter) => '第 ' + chapter.n + ' 章').join('、');
  const chapterRange = batch.chapters.length
    ? '第 ' + batch.chapters[0].from + '–' + batch.chapters[batch.chapters.length - 1].to + ' 页'
    : '';
  const lines = [
    '【书名】' + String((book && book.title) || ''),
    '【精讲模块】' + String(moduleTitle || ''),
    '【本批覆盖】' + chapterNos + '（' + chapterRange + '）' +
      (batch.part ? ' · 本章第 ' + batch.part.index + '/' + batch.part.total + ' 段' : ''),
    '【本批建议页数】' + target.share + ' 页（整个模块约 ' + target.total + ' 页，6–30 页之间）',
    '【本批原文】',
    chapterLines(batch.chapters),
    batch.text,
  ];
  if (batch.context) {
    lines.push('【衔接上下文】下面是上一批的末尾，只用来理解上下文，不要从这里摘抄 source_quote：');
    lines.push(batch.context);
  }
  lines.push(
    isFirst
      ? '【版式要求】本批是模块第一批：第 1 页必须 layout=cover；其余页在 content_text 与 quote 之间交替，quote 不超过本批页数的三分之一。'
      : '【版式要求】本批不是模块第一批：不要输出 cover，只用 content_text 与 quote，quote 不超过本批页数的三分之一。',
  );
  lines.push('【输出】严格 JSON，不要 Markdown 围栏，不要解释。每页都给出 source_quote，且必须逐字抄自上面的【本批原文】。');
  return {
    system: String(promptFile || ''),
    user: lines.join('\n'),
    isFirst: isFirst,
    batchIndex: index,
    totalBatches: totalBatches,
  };
}

/**
 * 修复调用的提示词：把不合格项和原文一起回灌。
 * 这是 §5.2 的「违反即触发修复调用」。
 */
export function buildRepairMessages({ promptFile, book, moduleTitle, sourceText, slides, errors }) {
  const shown = formatSlideErrors(errors);
  const payload = JSON.stringify({ module_title: moduleTitle || '', slides: slides || [] }, null, 0);
  const text = String(sourceText || '');
  const bounded = text.length > 30000 ? text.slice(0, 30000) + '\n……（原文过长，后面截断）' : text;
  const user = [
    '【上一次输出不合格】',
    shown,
    '【原文】',
    bounded,
    '【上一次的 JSON】',
    payload,
    '【要求】只修正不合格的字段，页数、版式、逐字摘抄的规则不变。只输出完整 JSON，不要解释、不要 Markdown 围栏。',
  ].join('\n');
  return { system: String(promptFile || ''), user: user };
}

/** 错误列表变成人能读的几行，也直接喂回模型。 */
export function formatSlideErrors(errors) {
  return (Array.isArray(errors) ? errors : [])
    .map((error) => {
      const at = Number(error.index) >= 0 ? '第 ' + (Number(error.index) + 1) + ' 页：' : '';
      return at + error.message;
    })
    .join('\n');
}

/* ------------------------------ 解析 ------------------------------ */

/** 模型回复 → {moduleTitle, slides}。坏 JSON 抛错，错误里带开头片段。 */
export function parseSlidesReply(reply) {
  const raw = String(reply || '')
    .replace(/^\uFEFF/, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('回复里没有 JSON 对象；开头是「' + raw.slice(0, 60) + '」');
  let data;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    throw new Error('JSON 解析失败：' + ((err && err.message) || '未知') + '；原文片段：' + raw.slice(start, start + 120));
  }
  if (!Array.isArray(data && data.slides)) throw new Error('JSON 里没有 slides 数组');
  if (!data.slides.length) throw new Error('slides 是空数组');
  return {
    moduleTitle: cleanInline(data.module_title, 80),
    slides: data.slides.map((slide, index) => normalizeSlide(slide, index)),
  };
}

/** 把模型给的一页收成固定形状；缺的字段留空，交给校验报错。 */
export function normalizeSlide(raw, index) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const pages = source.source_pages && typeof source.source_pages === 'object' ? source.source_pages : {};
  const layout = String(source.layout || '').trim();
  const bullets = Array.isArray(source.bullet_points)
    ? source.bullet_points.map((item) => cleanInline(item)).filter(Boolean)
    : [];
  return {
    slide_index: index + 1,
    layout: layout,
    title: cleanInline(source.title),
    subtitle: cleanInline(source.subtitle),
    bullet_points: bullets,
    quote_text: source.quote_text ? cleanInline(source.quote_text) : null,
    quote_source: source.quote_source ? cleanInline(source.quote_source) : null,
    image_prompt: cleanInline(source.image_prompt),
    audio_script: String(source.audio_script == null ? '' : source.audio_script).trim(),
    source_quote: String(source.source_quote == null ? '' : source.source_quote).trim(),
    source_pages: {
      from: Math.round(Number(pages.from) || 0),
      to: Math.round(Number(pages.to) || 0),
    },
  };
}

/** 把几批的幻灯片首尾接起来，并重排 slide_index。 */
export function mergeBatchSlides(batchResults) {
  const slides = [];
  for (const result of Array.isArray(batchResults) ? batchResults : []) {
    for (const slide of (result && result.slides) || []) slides.push(slide);
  }
  return slides.map((slide, index) => Object.assign({}, slide, { slide_index: index + 1 }));
}

/* ------------------------------ 校验 ------------------------------ */

/**
 * 校验一批幻灯片。返回错误列表（空 = 通过）。
 *
 * hard=true：结构/字段不合规，必须修复；
 * hard=false：source_quote 不是原文连续子串——留给锚点阶段降级，不阻断生成（D10）。
 *
 * @param {object[]} slides
 * @param {{text?:string,textNorm?:string,totalPages?:number,minPage?:number,maxPage?:number,allowCover?:boolean,requireCover?:boolean}} context
 */
export function validateSlides(slides, context) {
  const ctx = context || {};
  const errors = [];
  const push = (index, field, message, hard) => errors.push({ index: index, field: field, message: message, hard: hard !== false });
  if (!Array.isArray(slides) || slides.length === 0) {
    push(-1, 'slides', '没有任何幻灯片', true);
    return errors;
  }
  const textNorm = ctx.textNorm != null ? String(ctx.textNorm) : normalizeForMatch(ctx.text || '');
  const totalPages = Number(ctx.totalPages) > 0 ? Number(ctx.totalPages) : Infinity;
  const allowCover = ctx.allowCover !== false;
  const requireCover = ctx.requireCover === true;

  slides.forEach((slide, index) => {
    const title = String((slide && slide.title) || '');
    const layout = String((slide && slide.layout) || '');
    const bullets = Array.isArray(slide && slide.bullet_points) ? slide.bullet_points : [];
    const quoteText = String((slide && slide.quote_text) || '');
    const quoteSource = String((slide && slide.quote_source) || '');
    const imagePrompt = String((slide && slide.image_prompt) || '');
    const script = String((slide && slide.audio_script) || '');
    const quote = String((slide && slide.source_quote) || '');

    if (!LAYOUTS.includes(layout)) {
      push(index, 'layout', '版式只能是 cover / content_text / quote，当前是「' + layout + '」');
    } else if (layout === 'cover') {
      if (index !== 0 || !allowCover) push(index, 'layout', 'cover 只能出现在第 1 页');
      if (bullets.length) push(index, 'bullet_points', 'cover 不能带要点');
      if (quoteText || quoteSource) push(index, 'quote_text', 'cover 不能带引文');
    } else if (layout === 'content_text') {
      if (bullets.length < 1 || bullets.length > BULLET_COUNT_MAX) {
        push(index, 'bullet_points', 'content_text 需要 1–' + BULLET_COUNT_MAX + ' 条要点，当前 ' + bullets.length + ' 条');
      }
      bullets.forEach((bullet, bulletIndex) => {
        if (String(bullet).length > BULLET_MAX) {
          push(index, 'bullet_points', '第 ' + (bulletIndex + 1) + ' 条要点 ' + String(bullet).length + ' 字，最多 ' + BULLET_MAX + ' 字');
        }
      });
      if (quoteText || quoteSource) push(index, 'quote_text', 'content_text 不能带引文');
    } else if (layout === 'quote') {
      if (!quoteText) push(index, 'quote_text', 'quote 缺少 quote_text');
      else if (quoteText.length > QUOTE_TEXT_MAX) push(index, 'quote_text', 'quote_text ' + quoteText.length + ' 字，最多 ' + QUOTE_TEXT_MAX + ' 字');
      if (!quoteSource) push(index, 'quote_source', 'quote 缺少 quote_source');
      else if (quoteSource.length > QUOTE_SOURCE_MAX) push(index, 'quote_source', 'quote_source 最多 ' + QUOTE_SOURCE_MAX + ' 字');
      if (bullets.length) push(index, 'bullet_points', 'quote 不能带要点');
    }

    if (!title) push(index, 'title', '缺少标题');
    else {
      if (title.length > TITLE_MAX) push(index, 'title', '标题 ' + title.length + ' 字，最多 ' + TITLE_MAX + ' 字');
      if (/[\r\n]/.test(title)) push(index, 'title', '标题不能换行');
    }

    if (!imagePrompt) push(index, 'image_prompt', '缺少 image_prompt');
    else {
      if (imagePrompt.length > IMAGE_PROMPT_MAX) push(index, 'image_prompt', 'image_prompt ' + imagePrompt.length + ' 字，最多 ' + IMAGE_PROMPT_MAX + ' 字');
      if (!CJK.test(imagePrompt)) push(index, 'image_prompt', 'image_prompt 必须是中文');
    }

    if (!script) push(index, 'audio_script', '缺少 audio_script');
    else {
      if (script.length < AUDIO_MIN) push(index, 'audio_script', 'audio_script ' + script.length + ' 字，至少 ' + AUDIO_MIN + ' 字');
      if (script.length > AUDIO_MAX) push(index, 'audio_script', 'audio_script ' + script.length + ' 字，最多 ' + AUDIO_MAX + ' 字');
      if (VISUAL_WORDS.test(script)) push(index, 'audio_script', 'audio_script 不能出现依赖画面的说法（如「如下图所示」「幻灯片」）');
    }

    if (!quote) push(index, 'source_quote', '缺少 source_quote');
    else {
      if (quote.length < SOURCE_QUOTE_MIN) push(index, 'source_quote', 'source_quote ' + quote.length + ' 字，至少 ' + SOURCE_QUOTE_MIN + ' 字');
      if (quote.length > SOURCE_QUOTE_MAX) push(index, 'source_quote', 'source_quote ' + quote.length + ' 字，最多 ' + SOURCE_QUOTE_MAX + ' 字');
      // 摘抄漂移不算结构错误：锚点阶段会标 unanchored，播放器按页降级（D10）
      if (textNorm && normalizeForMatch(quote) && !textNorm.includes(normalizeForMatch(quote))) {
        push(index, 'source_quote', 'source_quote 不是原文的连续片段（模型改写了摘抄）', false);
      }
    }

    const from = Math.round(Number(slide && slide.source_pages && slide.source_pages.from) || 0);
    const to = Math.round(Number(slide && slide.source_pages && slide.source_pages.to) || 0);
    if (!(from >= 1 && to >= from)) push(index, 'source_pages', 'source_pages 必须是 1 ≤ from ≤ to');
    else {
      if (to > totalPages) push(index, 'source_pages', 'source_pages 超出全书 ' + totalPages + ' 页');
      if (Number(ctx.minPage) > 0 && from < Number(ctx.minPage)) push(index, 'source_pages', 'source_pages 早于本批起始页 ' + ctx.minPage);
      if (Number(ctx.maxPage) > 0 && to > Number(ctx.maxPage)) push(index, 'source_pages', 'source_pages 晚于本批结束页 ' + ctx.maxPage);
    }

    if (index === 0 && requireCover && layout !== 'cover') {
      push(index, 'layout', '模块第 1 页必须是 cover');
    }
    if (index === 0 && requireCover && !allowCover) {
      push(index, 'layout', '这一批不能输出 cover');
    }
  });

  return errors;
}

/** 模块级检查：只数页数与封面，字段级校验已经在各批做过。 */
export function validateSlideSet(slides) {
  const errors = [];
  const list = Array.isArray(slides) ? slides : [];
  if (list.length < MIN_SLIDES) errors.push('只有 ' + list.length + ' 页，至少 ' + MIN_SLIDES + ' 页');
  if (list.length > MAX_SLIDES) errors.push('有 ' + list.length + ' 页，最多 ' + MAX_SLIDES + ' 页');
  if (list.length && String(list[0].layout || '') !== 'cover') errors.push('模块第 1 页不是 cover');
  list.forEach((slide, index) => {
    if (index > 0 && String(slide.layout || '') === 'cover') errors.push('第 ' + (index + 1) + ' 页又出现了 cover');
  });
  return errors;
}

/* ------------------------------ 锚点回填 ------------------------------ */

/**
 * 在一段页区间上建归一化索引：每个字符都能反查它在哪一页、第几段。
 * 段落 = 原始文本的一行（pages.json 里没有真正的段落结构，行是最小单位）。
 */
export function buildAnchorIndex(pages, minPage, maxPage) {
  const from = Number(minPage) > 0 ? Number(minPage) : 0;
  const to = Number(maxPage) > 0 ? Number(maxPage) : Infinity;
  let norm = '';
  const positions = [];
  for (const page of Array.isArray(pages) ? pages : []) {
    const no = Math.round(Number((page && page.page) || 0));
    if (!no || no < from || no > to) continue;
    const lines = String((page && page.text) || '').split('\n');
    lines.forEach((line, paraIndex) => {
      const normalized = normalizeForMatch(line);
      for (const ch of normalized) {
        norm += ch;
        positions.push({ page: no, para_index: paraIndex });
      }
    });
  }
  return { norm: norm, positions: positions };
}

/**
 * 回填锚点。
 *
 * 先用整句归一化匹配；匹配不上时用前 14 个字符兜底——模型常常只改末尾，
 * 前缀对得上已经足以证明它抄的是哪一段。两种都记为 anchored，kind 区分。
 */
export function anchorSlides(slides, pages, options) {
  const opts = options || {};
  const index = buildAnchorIndex(pages, opts.minPage, opts.maxPage);
  let anchored = 0;
  const out = (Array.isArray(slides) ? slides : []).map((slide) => {
    const quote = normalizeForMatch(slide.source_quote);
    let hit = null;
    let kind = '';
    if (quote.length >= 6) {
      const at = index.norm.indexOf(quote);
      if (at >= 0) {
        hit = index.positions[at];
        kind = 'exact';
      } else {
        const prefix = quote.slice(0, Math.min(14, quote.length));
        if (prefix.length >= 6) {
          const at2 = index.norm.indexOf(prefix);
          if (at2 >= 0) {
            hit = index.positions[at2];
            kind = 'prefix';
          }
        }
      }
    }
    if (hit) anchored += 1;
    const next = Object.assign({}, slide, {
      source_anchor: hit ? { page: hit.page, para_index: hit.para_index } : null,
      anchor_status: hit ? 'anchored' : 'unanchored',
      anchor_kind: kind || null,
    });
    // 摘抄所在页比模型猜的页码范围可信：不包含锚点的范围直接收成单页
    if (hit) {
      const range = slide.source_pages || {};
      const from = Math.round(Number(range.from) || 0);
      const to = Math.round(Number(range.to) || 0);
      if (!(from >= 1 && to >= from && hit.page >= from && hit.page <= to)) {
        next.source_pages = { from: hit.page, to: hit.page };
      }
    }
    return next;
  });
  const total = out.length;
  return {
    slides: out,
    anchored: anchored,
    hitRate: total > 0 ? anchored / total : 0,
    unanchored: total - anchored,
  };
}

/** 锚点修复调用：只让模型重抄没匹配上的引用。 */
export function buildAnchorRepairUser({ slides, text }) {
  const failing = (Array.isArray(slides) ? slides : [])
    .filter((slide) => slide.anchor_status !== 'anchored')
    .map((slide) => ({ slide_index: slide.slide_index, title: slide.title, source_quote: slide.source_quote }));
  const source = String(text || '');
  const bounded = source.length > 20000 ? source.slice(0, 20000) + '\n……（原文过长，后面截断）' : source;
  return [
    '【任务】下面这些幻灯片的 source_quote 没能在原文里逐字找到。请只修 source_quote：',
    '1. 逐字复制原文里一段连续文字，10–200 字，不改写、不加省略号；',
    '2. 不要改标题、页数或其他字段；',
    '3. 输出严格 JSON：{"fixes":[{"slide_index":1,"source_quote":"……"}]}，不要解释。',
    '【待修的页】',
    JSON.stringify(failing, null, 0),
    '【原文】',
    bounded,
  ].join('\n');
}

/** 解析锚点修复回复。坏 JSON 抛错，交给上层的「修复失败不阻断生成」吞掉。 */
export function parseAnchorFixes(reply) {
  const raw = String(reply || '')
    .replace(/^\uFEFF/, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('锚点修复回复里没有 JSON 对象');
  const data = JSON.parse(raw.slice(start, end + 1));
  const fixes = Array.isArray(data && data.fixes) ? data.fixes : [];
  return fixes
    .map((fix) => ({
      slide_index: Math.round(Number(fix && fix.slide_index) || 0),
      source_quote: String((fix && fix.source_quote) || '').trim(),
    }))
    .filter((fix) => fix.slide_index > 0 && fix.source_quote.length >= SOURCE_QUOTE_MIN && fix.source_quote.length <= SOURCE_QUOTE_MAX);
}

export function applyAnchorFixes(slides, fixes) {
  const byIndex = new Map((Array.isArray(fixes) ? fixes : []).map((fix) => [fix.slide_index, fix.source_quote]));
  return (Array.isArray(slides) ? slides : []).map((slide) =>
    byIndex.has(slide.slide_index) ? Object.assign({}, slide, { source_quote: byIndex.get(slide.slide_index) }) : slide,
  );
}

/* ------------------------------ 配音计划 ------------------------------ */

/**
 * 浏览器朗读没有音频文件，用字数估一个时长给进度条和自动翻页兜底。
 * 真人朗读中文约 4.2 字/秒；语速 1.2 就按比例缩短。
 */
export function estimateAudioMs(script, rate) {
  const speed = Math.max(0.5, Math.min(2, Number(rate) || 1));
  const chars = charCount(script);
  if (!chars) return 0;
  return Math.max(800, Math.round((chars / (CHARS_PER_SECOND * speed)) * 1000));
}

/** 给每页挂上音频元数据，并把配音稿原样留在 slides.json 里供播放器朗读。 */
export function applyVoicing(slides, voice) {
  const provider = String((voice && voice.provider) || 'browser');
  const rate = Number((voice && voice.rate) || 1);
  return (Array.isArray(slides) ? slides : []).map((slide) =>
    Object.assign({}, slide, {
      audio_ms: provider === 'off' ? 0 : estimateAudioMs(slide.audio_script, rate),
      audio_provider: provider === 'off' ? 'none' : 'browser',
      audio_file: null,
    }),
  );
}
