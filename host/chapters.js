/**
 * 2.0 分章：独立于导入的 build/calibrate。
 *
 * 来源语义以 1.x（v1.6）为准：
 * - bookmark：PDF 书签（outline），2.0 新增；
 * - printed_toc：模型读印刷目录 → 印刷页校准为物理页；
 * - mechanical：1.x 附录 A 的机械切章（页眉/章号行正则 + 清洗 + 目录页剔除 +
 *   相邻同标题去重；k<2 时 1 章「全文」），**不是按页数/字数切块**；
 * - auto：bookmark → printed_toc → mechanical 级联，命中即停。
 *
 * 契约见 doc/requirements/规范需求2.0.md 的 FR-21.3。
 */
import fs from 'node:fs';
import path from 'node:path';

import { buildChapters as mechanicalChapters, cleanPages } from '../lib/text.js';
import { suggestTocRange } from '../lib/tocparse.js';
import { extractOutline } from './pdf.js';
import { parsePrintedToc } from './toc.js';
import { loadBook, writeChapters } from './books.js';

export const CHAPTER_MODES = ['auto', 'bookmark', 'printed_toc', 'mechanical'];
export const CHAPTER_SOURCES = ['bookmark', 'printed_toc', 'mechanical'];

const MODE_SET = new Set(CHAPTER_MODES);
const SOURCE_CONFIDENCE = {
  bookmark: 0.95,
  printed_toc: 0.95,
  mechanical: 0.7,
};
const MECHANICAL_FALLBACK_WARNING = '自动识别未命中，已按机械切章兜底';

export class ChapterError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'ChapterError';
    this.code = code;
    this.hint = hint || '';
  }
}

function pageNo(pages, index) {
  return Number((pages[index] && pages[index].page) || index + 1);
}

function charsBetween(pages, from, to) {
  let chars = 0;
  for (const page of pages) {
    const n = Number((page && page.page) || 0);
    if (n >= from && n <= to) chars += String((page && page.text) || '').length;
  }
  return chars;
}

/**
 * 把扁平 outline（title/page/depth）还原成树。depth 是 PDF 书签层级；
 * 这里只做结构还原，不判断“部分/章/节”。
 */
function outlineTree(outline) {
  const roots = [];
  const stack = [];
  for (const item of Array.isArray(outline) ? outline : []) {
    const title = String((item && item.title) || '').trim();
    if (!title) continue;
    const page = Number(item && item.page) || 0;
    const depth = Number.isInteger(item.depth) ? Math.max(0, item.depth) : 0;
    const node = { title, page, depth, children: [] };
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (!stack.length) roots.push(node);
    else stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return roots;
}

function nodesAtDepth(nodes, depth, out = []) {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node.depth === depth) out.push(node);
    if (node.children && node.children.length) nodesAtDepth(node.children, depth, out);
  }
  return out;
}

/**
 * 当前根层的有效节点：丢弃 page<1 / page>总页数；同一层同一页只保留最后一个；
 * 页号不递增的丢弃（保留先出现者）。允许 1 个根（单根不是失败）。
 */
function rootNodesAtDepth(tree, depth, total) {
  const lastByPage = new Map();
  const order = [];
  for (const node of nodesAtDepth(tree, depth)) {
    if (!node.title || node.page < 1 || node.page > total) continue;
    if (!lastByPage.has(node.page)) order.push(node.page);
    lastByPage.set(node.page, node);
  }
  const entries = [];
  for (const page of order) {
    const node = lastByPage.get(page);
    if (!node) continue;
    if (entries.length && page <= entries[entries.length - 1].page) continue;
    entries.push(node);
  }
  return entries;
}

function chooseOutlineRoot(tree, pages, requestedDepth, storedDepth) {
  const total = pages.length;
  const requested = Number.isInteger(requestedDepth) && requestedDepth >= 0 ? requestedDepth : null;
  const stored = Number.isInteger(storedDepth) && storedDepth >= 0 ? storedDepth : null;
  const wanted = requested === null ? (stored === null ? 0 : stored) : requested;

  let rootDepth = wanted;
  let entries = rootNodesAtDepth(tree, rootDepth, total);
  if (entries.length === 0 && rootDepth !== 0) {
    rootDepth = 0;
    entries = rootNodesAtDepth(tree, 0, total);
  }
  return { rootDepth, entries };
}

function outlineInfo(tree, rootDepth, total) {
  const nextDepth = rootDepth + 1;
  const next = rootNodesAtDepth(tree, nextDepth, total);
  return {
    rootDepth,
    rootCount: rootNodesAtDepth(tree, rootDepth, total).length,
    canDescend: next.length > 0,
    nextDepth,
    nextCount: next.length,
  };
}

/**
 * 书签路径：
 * - 原样还原 outline 树；只取当前根层为章，子节点只读展示；
 * - 根层默认 depth 0；请求/已存 rootDepth 优先；
 * - 根层有效节点 ≥1 即可（单根合法）；
 * - 每条根一章；第一个根不是第 1 页时，之前的页不建章，给 warning。
 */
function bookmarkFromOutline(outline, pages, requestedDepth, storedDepth) {
  const tree = outlineTree(outline);
  if (!tree.length) {
    return { chapters: [], warnings: [], tree: [], rootDepth: 0, outline: null, reason: 'PDF 没有可用书签' };
  }
  const total = pages.length;
  const selected = chooseOutlineRoot(tree, pages, requestedDepth, storedDepth);
  if (!selected.entries.length) {
    return {
      chapters: [],
      warnings: [],
      tree,
      rootDepth: selected.rootDepth,
      outline: null,
      reason: 'PDF 书签在当前根层没有可用条目',
    };
  }

  for (const node of nodesAtDepth(tree, selected.rootDepth)) delete node.n;
  selected.entries.forEach((node, i) => {
    node.n = i + 1;
  });

  const chapters = selected.entries.map((node, i) => {
    const to = i + 1 < selected.entries.length ? selected.entries[i + 1].page - 1 : total;
    return {
      n: i + 1,
      title: node.title,
      from: node.page,
      to,
      chars: charsBetween(pages, node.page, to),
      source: 'bookmark',
      toc: false,
      front: false,
    };
  });
  const warnings = [];
  if (selected.entries[0].page > 1) {
    warnings.push(
      '前 ' +
        (selected.entries[0].page - 1) +
        ' 页未归入任何章（书签从第 ' +
        selected.entries[0].page +
        ' 页开始）',
    );
  }
  return {
    chapters,
    warnings,
    tree,
    rootDepth: selected.rootDepth,
    outline: outlineInfo(tree, selected.rootDepth, total),
    reason: '',
  };
}

function normalizeRange(pages, range) {
  const total = pages.length;
  const from = Math.round(Number(range && range.from) || 0);
  const to = Math.round(Number(range && range.to) || 0);
  if (from >= 1 && to >= from && to <= total && to - from <= 40) return { from, to };
  return suggestTocRange(pages);
}

function printedTocChapters(printed) {
  if (!printed || !Array.isArray(printed.chapters) || printed.chapters.length < 2) return null;
  return printed.chapters.map((chapter) =>
    Object.assign({}, chapter, { source: 'printed_toc', toc: false }),
  );
}

function mechanicalChaptersFrom(pages) {
  const chapters = mechanicalChapters(pages).map((chapter) =>
    Object.assign({}, chapter, { source: 'mechanical' }),
  );
  if (chapters.length === 0) return [];
  // 1.x D6：k<2 → 全书 1 章「全文」。
  if (chapters.length === 1) {
    chapters[0].title = '全文';
    chapters[0].fallback = true;
  }
  return chapters;
}

function attempt(source, result, chapters, reason) {
  const out = { source, result, chapters: chapters || 0 };
  if (reason) out.reason = reason;
  return out;
}

async function buildBookmark(loaded, pages, outlineDepth) {
  let outline = [];
  try {
    const buffer = fs.readFileSync(path.join(loaded.dir, 'source.pdf'));
    outline = await extractOutline(buffer);
  } catch (err) {
    return {
      chosen: null,
      attempt: attempt('bookmark', 'failed', 0, '读取 PDF 书签失败：' + String((err && err.message) || err).slice(0, 120)),
    };
  }
  const result = bookmarkFromOutline(
    outline,
    pages,
    outlineDepth,
    loaded.book.bookmarkRootDepth,
  );
  if (!result.chapters.length) {
    return { chosen: null, attempt: attempt('bookmark', 'empty', 0, result.reason) };
  }
  try {
    validateChapters(result.chapters, pages);
  } catch (err) {
    return {
      chosen: null,
      attempt: attempt('bookmark', 'failed', 0, '书签章节校验失败：' + String((err && err.message) || err)),
    };
  }
  return {
    chosen: {
      source: 'bookmark',
      chapters: result.chapters,
      warnings: result.warnings,
      confidence: SOURCE_CONFIDENCE.bookmark,
      toc: null,
      tree: result.tree,
      rootDepth: result.rootDepth,
      outline: result.outline,
    },
    attempt: attempt('bookmark', 'used', result.chapters.length),
  };
}

async function buildPrintedToc(loaded, ctx, pages, range, { auto }) {
  const resolved = normalizeRange(pages, range);
  if (!resolved) {
    return {
      chosen: null,
      attempt: auto
        ? attempt('printed_toc', 'skipped', 0, '未定位到目录页，未调用模型')
        : attempt('printed_toc', 'failed', 0, '没有可用的目录页码范围'),
      badRange: !auto,
    };
  }
  let printed = null;
  try {
    printed = await parsePrintedToc({
      ctx,
      book: loaded.book,
      pages,
      dir: loaded.dir,
      from: resolved.from,
      to: resolved.to,
      force: false,
    });
  } catch (err) {
    return {
      chosen: null,
      attempt: attempt('printed_toc', 'failed', 0, '读取印刷目录失败：' + String((err && err.message) || err).slice(0, 120)),
    };
  }
  const chapters = printedTocChapters(printed);
  if (!chapters) {
    const reason =
      (printed && Array.isArray(printed.warnings) && printed.warnings[0]) ||
      '印刷目录不可用';
    return { chosen: null, attempt: attempt('printed_toc', 'failed', 0, reason) };
  }
  try {
    validateChapters(chapters, pages);
  } catch (err) {
    return {
      chosen: null,
      attempt: attempt('printed_toc', 'failed', 0, '目录章节校验失败：' + String((err && err.message) || err)),
    };
  }
  const verified = !!(printed && printed.toc && printed.toc.status === 'verified');
  const confidence = Number(printed && printed.confidence) || (verified ? 0.95 : 0.65);
  return {
    chosen: {
      source: 'printed_toc',
      chapters,
      warnings: (printed && printed.warnings) || [],
      confidence,
      toc: (printed && printed.toc) || null,
    },
    attempt: attempt('printed_toc', 'used', chapters.length),
  };
}

function fullTextChapter(pages) {
  const from = pageNo(pages, 0);
  const to = pageNo(pages, pages.length - 1);
  return {
    n: 1,
    title: '全文',
    from,
    to,
    chars: charsBetween(pages, from, to),
    source: 'mechanical',
    toc: false,
    front: false,
  };
}

function buildMechanical(pages, { auto }) {
  let chapters = mechanicalChaptersFrom(pages);
  // 机械路径必须可用（1.x D6）：若正则结果自身不合法，退回全书 1 章「全文」。
  try {
    validateChapters(chapters, pages);
  } catch {
    chapters = [fullTextChapter(pages)];
  }
  return {
    chosen: {
      source: 'mechanical',
      chapters,
      warnings: auto ? [MECHANICAL_FALLBACK_WARNING] : [],
      confidence: SOURCE_CONFIDENCE.mechanical,
      toc: null,
    },
    attempt: attempt('mechanical', 'used', chapters.length),
  };
}

/**
 * auto：固定 3 条 attempts，恰 1 条 used。
 */
async function buildAuto(loaded, ctx, pages, outlineDepth) {
  let bookmark = await buildBookmark(loaded, pages, outlineDepth);
  if (bookmark.chosen) {
    return {
      chosen: bookmark.chosen,
      attempts: [
        bookmark.attempt,
        attempt('printed_toc', 'skipped', 0, '已由前序来源命中'),
        attempt('mechanical', 'skipped', 0, '已由前序来源命中'),
      ],
    };
  }

  const printed = await buildPrintedToc(loaded, ctx, pages, null, { auto: true });
  if (printed.chosen) {
    return {
      chosen: printed.chosen,
      attempts: [
        bookmark.attempt,
        printed.attempt,
        attempt('mechanical', 'skipped', 0, '已由前序来源命中'),
      ],
    };
  }

  const mechanical = buildMechanical(pages, { auto: true });
  return {
    chosen: mechanical.chosen,
    attempts: [bookmark.attempt, printed.attempt, mechanical.attempt],
  };
}

async function buildForced(mode, loaded, ctx, pages, range, outlineDepth) {
  if (mode === 'bookmark') {
    const result = await buildBookmark(loaded, pages, outlineDepth);
    if (!result.chosen) {
      throw new ChapterError(
        'E_CHAPTER_SOURCE',
        result.attempt.reason || 'PDF 书签不可用',
        '改用自动分章，或在高级里选印刷目录/机械切章。',
      );
    }
    return { chosen: result.chosen, attempts: [result.attempt] };
  }
  if (mode === 'printed_toc') {
    const result = await buildPrintedToc(loaded, ctx, pages, range, { auto: false });
    if (!result.chosen) {
      if (result.badRange) {
        throw new ChapterError(
          'E_BAD_RANGE',
          '目录页码范围非法或无法定位',
          '填目录页码（1–总页数，跨度 ≤40 页），或改用自动分章。',
        );
      }
      throw new ChapterError(
        'E_CHAPTER_SOURCE',
        result.attempt.reason || '印刷目录不可用',
        '改用自动分章，或改选机械切章。',
      );
    }
    return { chosen: result.chosen, attempts: [result.attempt] };
  }
  const result = buildMechanical(pages, { auto: false });
  return { chosen: result.chosen, attempts: [result.attempt] };
}

export function validateChapters(chapters, pages) {
  if (!Array.isArray(chapters) || chapters.length === 0) {
    throw new ChapterError('E_CHAPTER_EMPTY', '没有章节', '至少保留一章。');
  }
  const total = pages.length;
  let previousTo = 0;
  for (let i = 0; i < chapters.length; i += 1) {
    const c = chapters[i] || {};
    const from = Number(c.from);
    const to = Number(c.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > total || from > to) {
      throw new ChapterError('E_CHAPTER_RANGE', '第 ' + (i + 1) + ' 章页范围非法', '检查起止页是否在书内。');
    }
    if (i > 0 && from <= previousTo) {
      throw new ChapterError('E_CHAPTER_OVERLAP', '第 ' + (i + 1) + ' 章与上一章重叠', '起止页必须递增且不重叠。');
    }
    previousTo = to;
  }
  return true;
}

export function normalizeChapters(chapters) {
  return (Array.isArray(chapters) ? chapters : [])
    .map((c, i) => ({
      n: i + 1,
      title: String((c && c.title) || '第 ' + (i + 1) + ' 章').trim().slice(0, 200) || '第 ' + (i + 1) + ' 章',
      from: Math.round(Number(c && c.from)),
      to: Math.round(Number(c && c.to)),
      chars: Number(c && c.chars) || 0,
      source: String((c && (c.source || c.chapterSource)) || ''),
      manual: c && c.manual === true,
      front: c && c.front === true,
      toc: c && c.toc === true,
    }))
    .filter((c) => Number.isInteger(c.from) && Number.isInteger(c.to) && c.from >= 1 && c.to >= c.from)
    .sort((a, b) => a.from - b.from)
    .map((c, i) => Object.assign({}, c, { n: i + 1 }));
}

function hasManual(chapters) {
  return (Array.isArray(chapters) ? chapters : []).some((c) => c && c.manual);
}

export async function buildBookChapters(
  bookId,
  mode = 'auto',
  { force = false, ctx = null, range = null, outlineDepth = null } = {},
) {
  const requested = String(mode || 'auto');
  if (!MODE_SET.has(requested)) {
    throw new ChapterError(
      'E_BAD_MODE',
      '分章方式不合法',
      '用自动分章，或在高级里选印刷目录/机械切章。',
    );
  }

  const loaded = loadBook(bookId);
  if (!loaded) throw new ChapterError('E_NOT_FOUND', '找不到这本书', '书架里可能已经删掉了。');
  if (hasManual(loaded.chapters) && !force) {
    throw new ChapterError('E_MANUAL_EDITS', '这本书有手动修改过的章', '重新分章会覆盖它们；确认后带 force 再来一次。');
  }

  const rawPages = JSON.parse(fs.readFileSync(path.join(loaded.dir, 'pages.json'), 'utf8'));
  if (!Array.isArray(rawPages) || rawPages.length === 0) {
    throw new ChapterError('E_NO_PAGES', '这本书没有存下逐页文本', '删掉重新导入一次。');
  }

  const pages = cleanPages(rawPages);
  if (!pages.length) {
    throw new ChapterError('E_NO_PAGES', '这本书没有存下逐页文本', '删掉重新导入一次。');
  }

  const result =
    requested === 'auto'
      ? await buildAuto(loaded, ctx, pages, outlineDepth)
      : await buildForced(requested, loaded, ctx, pages, range, outlineDepth);

  const source = result.chosen.source;
  const chapters = normalizeChapters(result.chosen.chapters);
  for (const chapter of chapters) {
    if (!chapter.source || chapter.source === 'manual') chapter.source = source;
  }
  validateChapters(chapters, pages);

  const bookmark =
    source === 'bookmark'
      ? { tree: result.chosen.tree || [], rootDepth: result.chosen.rootDepth }
      : null;
  writeChapters(
    bookId,
    chapters,
    source,
    result.chosen.confidence,
    result.chosen.warnings || [],
    bookmark,
  );
  return {
    chapters,
    source,
    mode: requested,
    confidence: result.chosen.confidence,
    attempts: result.attempts,
    warnings: result.chosen.warnings || [],
    outline: result.chosen.outline || null,
    toc: result.chosen.toc || null,
  };
}

export function saveBookChapters(bookId, chapters) {
  const loaded = loadBook(bookId);
  if (!loaded) throw new ChapterError('E_NOT_FOUND', '找不到这本书', '');
  const rawPages = JSON.parse(fs.readFileSync(path.join(loaded.dir, 'pages.json'), 'utf8'));
  const normalized = normalizeChapters(chapters);
  validateChapters(normalized, rawPages);
  const old = loaded.chapters || [];
  const next = normalized.map((c, i) => {
    const prev = old[i];
    const changed =
      !prev ||
      String(prev.title || '') !== c.title ||
      Number(prev.from) !== c.from ||
      Number(prev.to) !== c.to ||
      Boolean(prev.front) !== Boolean(c.front);
    return Object.assign({}, c, {
      manual: Boolean(c.manual) || changed,
      source: c.source || prev?.source || 'manual',
    });
  });
  const bookmark =
    loaded.book.chapterSource === 'bookmark'
      ? { tree: loaded.book.bookmarkTree || [], rootDepth: loaded.book.bookmarkRootDepth }
      : null;
  writeChapters(
    bookId,
    next,
    loaded.book.chapterSource || 'manual',
    loaded.book.chapterConfidence,
    loaded.book.chapterWarnings,
    bookmark,
  );
  return next;
}
