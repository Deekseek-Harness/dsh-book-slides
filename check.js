/**
 * 真书「章节切分」核对 —— DSH 命令 /chapter-check 与命令行脚本共用这一份实现。
 *
 * 数据目录里每本书放：
 *   xxx.pdf            书
 *   【书签】xxx.txt     人工真值：每行「标题<TAB>物理页码」
 *   【目录页码】xxx.txt 目录页范围，如「16-22」
 *
 * 两条路径：
 *   toc   目录 → 校准 → 落盘（附录 F 主路径）
 *   mech  纯页眉切章（回退路径）
 *
 * 不调模型：目录那一步用一个极简解析器代替（只认「章头 + 紧跟的数字」），
 * 因此本模块测的是「校准与落盘」，不是「模型读目录读得准不准」。
 */
import fs from 'node:fs';
import path from 'node:path';

import { extractPages } from './pdfread.js';
import { CHAPTER_RE, buildChapters, chapterNumberOf, cleanPages } from './text.js';
import { calibrate, chaptersFromToc, suggestTocRange, tocTextOf, verifyChapters } from './tocparse.js';

/* ------------------------------ 书签 ------------------------------ */

/** 一行书签 → { title, page }。页码是最后一个 tab 字段，缩进不关心。 */
export function parseBookmarkLine(line) {
  const raw = String(line || '').replace(/\s+$/, '');
  if (!raw) return null;
  const parts = raw.split('\t');
  if (parts.length < 2) return null;
  const page = Number(String(parts[parts.length - 1]).replace(/[^\d]/g, ''));
  if (!Number.isFinite(page) || page <= 0) return null;
  const title = parts
    .slice(0, parts.length - 1)
    .join(' ')
    .replace(/^[\s\t]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) return null;
  return { title: title, page: page };
}

/** 书签里哪些算「章」：第X章 / CHAPTER N / 附录X / 序言·前言… */
export function isChapterEntry(title) {
  const text = String(title || '').trim();
  if (!text) return false;
  if (/^(part\s|第\s*[0-9一二三四五六七八九十百千零〇两]+\s*部分)/i.test(text)) return false; // 分卷不算章
  if (/^(封面|书名|版权|数字版权声明|作者介绍|扉页|献词|译者序|致谢|目录|索引|出版说明)/.test(text)) return false;
  return CHAPTER_RE.test(text);
}

/** 正文章节（核心）vs 前言/附录这类（非核心）。 */
export function isCoreChapter(title) {
  const text = String(title || '').trim();
  return /^第\s*[0-9一二三四五六七八九十百千零〇两]+\s*[章回讲课篇卷部]/.test(text) || /^chapter\s+[0-9ivxlcdm]+/i.test(text);
}

/** 比对用的键：有章号用章号，没章号用标题本身。 */
export function keyOf(title) {
  const text = String(title || '').trim();
  const no = chapterNumberOf(text);
  if (no > 0) return 'no:' + no;
  const m = CHAPTER_RE.exec(text);
  const head = m ? String((m.groups && m.groups.head) || '') : '';
  return 'head:' + (head || text).replace(/\s+/g, '').toLowerCase();
}

export function readTruth(bookmarkFile) {
  const lines = fs.readFileSync(bookmarkFile, 'utf8').split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const item = parseBookmarkLine(line);
    if (!item || !isChapterEntry(item.title)) continue;
    const key = keyOf(item.title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key: key, title: item.title, page: item.page, core: isCoreChapter(item.title) });
  }
  out.sort((a, b) => a.page - b.page);
  return out;
}

/** 「16-22」「9」「9-9」→ {from,to}；读不出来返回 null。 */
export function readTocRange(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const m = /^(\d+)\s*(?:[-–—~]\s*(\d+))?/.exec(raw);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (!(from > 0 && to >= from)) return null;
    return { from: from, to: to };
  } catch {
    return null;
  }
}

/** 按前缀配对：xxx.pdf ↔ 【书签】xxx.txt ↔ 【目录页码】xxx.txt */
export function findPair(dir, pdfName, prefix, ext) {
  const base = pdfName.replace(/\.pdf$/i, '');
  for (const candidate of [prefix + base + ext, prefix + base.trim() + ext]) {
    if (fs.existsSync(path.join(dir, candidate))) return path.join(dir, candidate);
  }
  const head = prefix + base.trim().slice(0, 20);
  const hit = fs.readdirSync(dir).find((name) => name.startsWith(head) && name.toLowerCase().endsWith(ext.toLowerCase()));
  return hit ? path.join(dir, hit) : null;
}

/* ------------------------------ 目录条目（测试用） ------------------------------ */

/**
 * 极简目录解析（代替模型那一步）。
 * 一行里可能粘着两栏，所以对每行做全局扫描：每遇到一个「章头」，
 * 就取它到下一个章头之间的第一个数字当页码。
 */
const HEAD_RE = /(第\s*[0-9一二三四五六七八九十百千零〇两]+\s*[章回讲课篇卷部]|附录\s*[A-Za-z一二三0-9]?|chapter\s+[0-9]+|前\s*言|序\s*言|致\s*谢|后\s*记)/gi;

export function tocEntriesFromText(text) {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.replace(/^L\d+:\s*/, '').trim());
  const out = [];
  const seen = new Set();
  for (const line of lines) {
    const heads = Array.from(line.matchAll(HEAD_RE));
    for (let k = 0; k < heads.length; k += 1) {
      const m = heads[k];
      const start = m.index + m[0].length;
      const end = k + 1 < heads.length ? heads[k + 1].index : line.length;
      const segment = line.slice(start, end);
      const num = /(\d{1,4})(?!\d)/.exec(segment);
      if (!num) continue;
      const printed = Number(num[1]);
      if (!(printed > 0)) continue;
      const head = m[0].replace(/\s+/g, '');
      const title = (m[0] + ' ' + segment.slice(0, num.index)).replace(/\s+/g, ' ').trim();
      const key = keyOf(title);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title: title, printed: printed, level: /附录/.test(head) ? 'appendix' : 'chapter', fixedChar: false });
    }
  }
  out.sort((a, b) => a.printed - b.printed);
  return out;
}

/* ------------------------------ 比对 ------------------------------ */

export function compareTruth(truth, chapters) {
  const parsed = (chapters || []).filter((c) => !c.front);
  const byKey = new Map();
  for (const chapter of parsed) byKey.set(keyOf(chapter.title), chapter);

  const serious = [];
  const warn = [];
  const ok = { core: 0, other: 0 };

  for (const item of truth) {
    const hit = byKey.get(item.key);
    if (!hit) {
      if (item.core) serious.push({ kind: '核心遗漏', title: item.title, truth: item.page });
      else warn.push({ kind: '非核心遗漏', title: item.title, truth: item.page });
      continue;
    }
    const diff = hit.from - item.page;
    if (diff === 0) {
      if (item.core) ok.core += 1;
      else ok.other += 1;
      continue;
    }
    serious.push({ kind: '偏移', title: item.title, truth: item.page, got: hit.from, diff: diff });
  }

  const truthKeys = new Set(truth.map((t) => t.key));
  const extras = parsed.filter((c) => !truthKeys.has(keyOf(c.title)));
  return { serious: serious, warn: warn, ok: ok, extras: extras, parsedCount: parsed.length, truthCount: truth.length };
}

/* ------------------------------ 跑一本书 ------------------------------ */

async function runOne(root, pdf, mode) {
  const label = pdf.replace(/\.pdf$/i, '').trim();
  const base = { label: label, mode: mode };
  const bookmarkFile = findPair(root, pdf, '【书签】', '.txt');
  if (!bookmarkFile) return Object.assign(base, { skipped: '没有书签文件，无法对照' });

  const bookmarkToc = findPair(root, pdf, '【目录页码】', '.txt');
  const range = readTocRange(bookmarkToc || '');
  if (mode === 'toc' && !range) return Object.assign(base, { skipped: '没有【目录页码】文件，不知道目录在哪几页' });

  const truth = readTruth(bookmarkFile);
  const t0 = Date.now();
  const extracted = await extractPages(fs.readFileSync(path.join(root, pdf)));
  const pages = cleanPages(extracted.pages);

  let chapters = [];
  let note = '';
  if (mode === 'toc') {
    const toc = tocTextOf(pages, range.from, range.to);
    const entries = tocEntriesFromText(toc.text);
    if (entries.length < 3) {
      return Object.assign(base, {
        skipped: '目录页（' + range.from + '–' + range.to + '）里没有可用的页码，只认出 ' + entries.length + ' 条',
        pages: extracted.numPages,
        ms: Date.now() - t0,
      });
    }
    const calibrated = calibrate(pages, entries, range);
    const built = chaptersFromToc(pages, calibrated);
    chapters = built || [];
    const hitRate = built ? verifyChapters(pages, chapters) : 0;
    note = '目录条目 ' + entries.length + ' 条 · 偏移 ' + calibrated.offset + ' · 抽查 ' + Math.round(hitRate * 100) + '%' + (toc.truncated ? ' · 目录被截断' : '');
  } else {
    chapters = buildChapters(pages);
    const guessed = suggestTocRange(pages);
    note = range
      ? '目录页：人工 ' + range.from + '–' + range.to + ' · 猜测 ' + (guessed ? guessed.from + '–' + guessed.to : '无') + (guessed && guessed.from === range.from && guessed.to === range.to ? ' ✓' : ' ✗')
      : '目录页：未提供人工标注';
  }

  const compared = compareTruth(truth, chapters);
  return Object.assign(compared, {
    label: label,
    mode: mode,
    pages: extracted.numPages,
    ms: Date.now() - t0,
    note: note,
  });
}

/* ------------------------------ 报告 ------------------------------ */

function rowOf(item) {
  const detail =
    item.kind === '偏移'
      ? '真值 ' + item.truth + ' → 解析 ' + item.got + '（' + (item.diff > 0 ? '+' : '') + item.diff + ' 页）'
      : '真值 ' + item.truth + ' 页，没切出来';
  return '    ✗ [' + item.kind + '] ' + String(item.title).slice(0, 30) + ' — ' + detail;
}

/** 一本 → 文本行 */
export function renderBook(b) {
  const lines = [];
  lines.push('');
  lines.push('《' + b.label + '》' + (b.pages ? ' ' + b.pages + ' 页 · ' + b.ms + 'ms' : ''));
  if (b.note) lines.push('  ' + b.note);
  if (b.skipped) {
    lines.push('  ⓘ 通知：跳过 — ' + b.skipped);
    return lines;
  }
  lines.push(
    '  真值 ' + b.truthCount + ' 章 · 解析 ' + b.parsedCount + ' 段 · 一致 ' + (b.ok.core + b.ok.other) + ' · 严重 ' + b.serious.length + ' · 警告 ' + b.warn.length,
  );
  for (const item of b.serious) lines.push(rowOf(item));
  for (const item of b.warn) lines.push('    ! [非核心遗漏] ' + String(item.title).slice(0, 30) + ' — 真值 ' + item.truth + ' 页');
  if (b.extras.length) {
    lines.push('    · 书签里没有、解析多出来的：' + b.extras.slice(0, 5).map((c) => String(c.title).slice(0, 18)).join('、') + (b.extras.length > 5 ? ' …' : ''));
  }
  return lines;
}

/** 全部 → { lines, summary } */
export function renderSummary(title, results) {
  const all = { offset: [], missingCore: [], missingOther: [], notices: [], truth: 0, matched: 0 };
  for (const b of results) {
    if (b.skipped) {
      all.notices.push({ book: b.label, reason: b.skipped });
      continue;
    }
    for (const item of b.serious) {
      if (item.kind === '偏移') all.offset.push(Object.assign({ book: b.label }, item));
      else all.missingCore.push(Object.assign({ book: b.label }, item));
    }
    for (const item of b.warn) all.missingOther.push(Object.assign({ book: b.label }, item));
    all.truth += b.truthCount;
    all.matched += b.ok.core + b.ok.other;
  }

  const lines = [];
  lines.push('');
  lines.push('════════ ' + title + ' 汇总（' + results.length + ' 本 · 真值 ' + all.truth + ' 章）════════');
  const section = (list, label, fmt) => {
    lines.push(label + '：' + list.length + ' 处');
    for (const item of list.slice(0, 12)) lines.push('    · ' + String(item.book).slice(0, 16) + ' ' + fmt(item));
    if (list.length > 12) lines.push('    … 还有 ' + (list.length - 12) + ' 处');
  };
  section(all.offset, '严重 · 偏移', (i) => '《' + String(i.title).slice(0, 22) + '》 真值 ' + i.truth + ' → ' + i.got + '（' + (i.diff > 0 ? '+' : '') + i.diff + '）');
  section(all.missingCore, '严重 · 核心遗漏', (i) => '《' + String(i.title).slice(0, 22) + '》 真值 ' + i.truth);
  section(all.missingOther, '警告 · 非核心遗漏', (i) => '《' + String(i.title).slice(0, 22) + '》 真值 ' + i.truth);
  section(all.notices, '通知 · 跳过', (i) => i.reason);

  const serious = all.offset.length + all.missingCore.length;
  lines.push('');
  lines.push('结论：一致 ' + all.matched + '/' + all.truth + '，严重 ' + serious + ' 处，警告 ' + all.missingOther.length + ' 处，跳过 ' + all.notices.length + ' 本');
  return { lines: lines, summary: { serious: serious, warn: all.missingOther.length, notices: all.notices.length, matched: all.matched, truth: all.truth } };
}

/* ------------------------------ 对外入口 ------------------------------ */

/**
 * 跑一整个数据目录。
 * @param {string} root 数据目录的绝对路径
 * @param {{mode?: 'toc'|'mech', signal?: AbortSignal, onBook?: Function}} options
 */
export async function runBookCheck(root, options) {
  const opts = options || {};
  const mode = opts.mode === 'mech' ? 'mech' : 'toc';
  if (!fs.existsSync(root)) throw new Error('目录不存在：' + root);
  const pdfs = fs.readdirSync(root).filter((name) => /\.pdf$/i.test(name)).sort();
  if (pdfs.length === 0) throw new Error('目录里没有 PDF：' + root);

  const title = mode === 'toc' ? '章节切分' : '机械切分';
  const results = [];
  for (const pdf of pdfs) {
    if (opts.signal && opts.signal.aborted) throw new Error('已取消');
    const result = await runOne(root, pdf, mode);
    results.push(result);
    if (opts.onBook) opts.onBook(result);
  }

  const lines = [];
  lines.push('《' + title + '》真书对照：' + root);

  const all = results.map(renderBook);
  for (const block of all) for (const line of block) lines.push(line);

  const sum = renderSummary(title, results);
  for (const line of sum.lines) lines.push(line);

  return { mode: mode, results: results, summary: sum.summary, text: lines.join('\n') };
}
