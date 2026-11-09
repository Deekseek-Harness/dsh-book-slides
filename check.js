/**
 * 真书「章节切分」核对 —— DSH 命令 /chapter-check 与命令行脚本共用这一份实现。
 *
 * 数据目录（PDF 在哪）里每本书放：
 *   xxx.pdf            书
 *   【书签】xxx.txt     人工真值：每行「标题<TAB>物理页码」
 *   【目录页码】xxx.txt 目录页范围，如「16-22」
 *
 * 真值也可以放在另一个目录（truthDir），这时 PDF 目录里只剩 PDF：
 *   有 books.json 清单 → 按清单点名配对，清单外的 PDF 只报通知；
 *   没有清单        → 按文件名前缀在 truthDir 里找，找不到再回数据目录找。
 * 清单是为了挡住「计算机组成与设计.pdf」和「计算机组成与设计(OCR).pdf」这类同名前缀串台。
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

import { extractPages } from './lib/pdfread.js';
import { CHAPTER_RE, buildChapters, chapterNumberOf, cleanPages } from './lib/text.js';
import { calibrate, chaptersFromToc, suggestTocRange, tocTextOf, verifyChapters } from './lib/tocparse.js';

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

/**
 * 按前缀配对：xxx.pdf ↔ 【书签】xxx.txt ↔ 【目录页码】xxx.txt。
 * dir 可以是单个目录，也可以是目录数组（按顺序找，truthDir 排前面）。
 */
export function findPair(dir, pdfName, prefix, ext) {
  const base = pdfName.replace(/\.pdf$/i, '');
  const dirs = Array.isArray(dir) ? dir : [dir];
  for (const current of dirs) {
    if (!current) continue;
    for (const candidate of [prefix + base + ext, prefix + base.trim() + ext]) {
      const file = path.join(current, candidate);
      if (fs.existsSync(file)) return file;
    }
    const head = prefix + base.trim().slice(0, 20);
    let hit = null;
    try {
      hit = fs.readdirSync(current).find((name) => name.startsWith(head) && name.toLowerCase().endsWith(ext.toLowerCase()));
    } catch {
      hit = null;
    }
    if (hit) return path.join(current, hit);
  }
  return null;
}

/* ------------------------------ 真值清单 ------------------------------ */

export const MANIFEST_NAME = 'books.json';

/**
 * 读真值目录里的 books.json；没有清单就返回 null（退回按文件名前缀配对）。
 *
 * 清单形状：
 *   {
 *     "books": [{ "pdf": "x.pdf", "bookmark": "【书签】x.txt", "toc": "【目录页码】x.txt",
 *                 "pages": 542, "sha256": "...", "modes": ["toc", "mech"],
 *                 "expect": { "toc": { "truth": 15, "parsed": 14, "matched": 14, "serious": 0, "warn": 1 } } }],
 *     "ignored": [{ "pdf": "扫描重本.pdf", "reason": "无文字层" }]
 *   }
 *
 * expect 是当前基线快照，--baseline 用它判回归（见 renderBaseline）。
 * modes 限定这本书能用哪条路径；不在列表里的路径会被报成「跳过」而不是「严重」。
 */
export function readManifest(truthDir) {
  if (!truthDir) return null;
  const file = path.join(truthDir, MANIFEST_NAME);
  if (!fs.existsSync(file)) return null;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error('真值清单读不了（' + file + '）：' + String((err && err.message) || err));
  }
  return {
    dir: path.resolve(truthDir),
    books: Array.isArray(data && data.books) ? data.books : [],
    ignored: Array.isArray(data && data.ignored) ? data.ignored : [],
  };
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

async function runOne(root, pdf, mode, opts) {
  const options = opts || {};
  const truthDir = options.truthDir || '';
  const entry = options.entry || null;
  const label = pdf.replace(/\.pdf$/i, '').trim();
  const base = { label: label, pdf: pdf, mode: mode };

  if (entry && Array.isArray(entry.modes) && !entry.modes.includes(mode)) {
    return Object.assign(base, { skipped: '清单只登记了 ' + entry.modes.join('/') + ' 路径' + (entry.note ? '：' + entry.note : '') });
  }

  const bookmarkFile = entry && entry.bookmark
    ? path.join(truthDir, entry.bookmark)
    : findPair([truthDir, root], pdf, '【书签】', '.txt');
  if (!bookmarkFile || !fs.existsSync(bookmarkFile)) return Object.assign(base, { skipped: '没有书签文件，无法对照' });

  const bookmarkToc = entry
    ? (entry.toc ? path.join(truthDir, entry.toc) : null)
    : findPair([truthDir, root], pdf, '【目录页码】', '.txt');
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
    pdf: pdf,
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

/* ------------------------------ 基线对照 ------------------------------ */

/** 一次运行的数字快照，用于和清单里的 expect 比。 */
export function baselineOf(result) {
  return {
    truth: result.truthCount,
    parsed: result.parsedCount,
    matched: result.ok.core + result.ok.other,
    serious: result.serious.length,
    warn: result.warn.length,
  };
}

/**
 * 与 books.json 里登记的基线比。
 * 真值数或切出章数变了算回归（说明真值被改过、或算法结构动了）；一致数变少、严重/警告变多也算回归。
 * 变好只提示、不算失败；跳过（本地没 PDF、清单没登记）的书不参与，否则换台机器就永远红。
 */
export function renderBaseline(results, manifest) {
  const entries = new Map(((manifest && manifest.books) || []).map((b) => [b.pdf, b]));
  const lines = [];
  lines.push('');
  lines.push('════════ 基线对照（books.json）════════');
  let failed = 0;
  let passed = 0;
  let improved = 0;
  for (const result of results) {
    if (result.skipped) continue;
    const entry = entries.get(result.pdf);
    const expect = entry && entry.expect && entry.expect[result.mode];
    if (!expect) {
      failed += 1;
      lines.push('    ✗ ' + result.label + '（' + result.mode + '）清单里没有登记基线');
      continue;
    }
    const actual = baselineOf(result);
    const worse = [];
    if (actual.truth !== expect.truth) worse.push('真值 ' + expect.truth + ' → ' + actual.truth + ' 章');
    if (actual.parsed !== expect.parsed) worse.push('切出 ' + expect.parsed + ' → ' + actual.parsed + ' 段');
    if (actual.matched < expect.matched) worse.push('一致 ' + expect.matched + ' → ' + actual.matched);
    if (actual.serious > expect.serious) worse.push('严重 ' + expect.serious + ' → ' + actual.serious);
    if (actual.warn > expect.warn) worse.push('警告 ' + expect.warn + ' → ' + actual.warn);
    if (worse.length) {
      failed += 1;
      lines.push('    ✗ ' + result.label + '（' + result.mode + '）回归：' + worse.join('、'));
      continue;
    }
    passed += 1;
    if (actual.matched > expect.matched || actual.serious < expect.serious || actual.warn < expect.warn) {
      improved += 1;
      lines.push(
        '    ↑ ' + result.label + '（' + result.mode + '）好于基线：一致 ' + actual.matched + '/' + actual.truth + '，严重 ' + actual.serious +
          '（基线 ' + expect.matched + '/' + expect.truth + '，严重 ' + expect.serious + '）',
      );
    }
  }
  lines.push('');
  lines.push('基线结论：通过 ' + passed + ' 本，回归 ' + failed + ' 本，改善 ' + improved + ' 本（跳过的不参与）');
  return { lines: lines, summary: { passed: passed, failed: failed, improved: improved } };
}

/* ------------------------------ 对外入口 ------------------------------ */

/**
 * 跑一整个数据目录。
 * @param {string} root 数据目录的绝对路径（放 PDF）
 * @param {{mode?: 'toc'|'mech', truthDir?: string, baseline?: boolean, signal?: AbortSignal, onBook?: Function}} options
 */
export async function runBookCheck(root, options) {
  const opts = options || {};
  const mode = opts.mode === 'mech' ? 'mech' : 'toc';
  const truthDir = opts.truthDir ? path.resolve(opts.truthDir) : '';
  if (!fs.existsSync(root)) throw new Error('目录不存在：' + root);
  if (truthDir && !fs.existsSync(truthDir)) throw new Error('真值目录不存在：' + truthDir);

  const pdfs = fs.readdirSync(root).filter((name) => /\.pdf$/i.test(name)).sort();
  if (pdfs.length === 0) throw new Error('目录里没有 PDF：' + root);
  const manifest = readManifest(truthDir);
  if (opts.baseline && !manifest) throw new Error('没有真值清单（' + (truthDir || '未指定真值目录') + '），--baseline 无从对照');

  const labelOf = (pdf) => String(pdf || '?').replace(/\.pdf$/i, '').trim();
  const title = mode === 'toc' ? '章节切分' : '机械切分';
  const results = [];
  const push = (result) => {
    results.push(result);
    if (opts.onBook) opts.onBook(result);
  };

  if (manifest && manifest.books.length) {
    const present = new Set(pdfs);
    const covered = new Set();
    for (const entry of manifest.books) {
      if (opts.signal && opts.signal.aborted) throw new Error('已取消');
      const pdf = entry && entry.pdf;
      if (pdf && present.has(pdf)) {
        covered.add(pdf);
        push(await runOne(root, pdf, mode, { truthDir: manifest.dir, entry: entry }));
      } else {
        push({ label: labelOf(pdf), pdf: pdf, mode: mode, skipped: '本地没有这本 PDF（真值已登记，本轮未跑）' });
      }
    }
    const ignored = manifest.ignored || [];
    for (const item of ignored) {
      if (covered.has(item && item.pdf)) continue;
      push({
        label: labelOf(item && item.pdf),
        pdf: item && item.pdf,
        mode: mode,
        skipped: '清单标记为不参与对照：' + String((item && item.reason) || '未写原因'),
      });
    }
    for (const pdf of pdfs) {
      if (covered.has(pdf)) continue;
      if (ignored.some((item) => item && item.pdf === pdf)) continue;
      push({ label: labelOf(pdf), pdf: pdf, mode: mode, skipped: '真值清单里没有登记，未参与对照' });
    }
  } else {
    for (const pdf of pdfs) {
      if (opts.signal && opts.signal.aborted) throw new Error('已取消');
      push(await runOne(root, pdf, mode, { truthDir: truthDir }));
    }
  }

  const lines = [];
  lines.push('《' + title + '》真书对照：' + root);
  if (truthDir) lines.push('真值目录：' + truthDir + (manifest ? '（books.json 清单）' : '（按文件名配对）'));

  const all = results.map(renderBook);
  for (const block of all) for (const line of block) lines.push(line);

  const base = opts.baseline ? renderBaseline(results, manifest) : null;
  if (base) for (const line of base.lines) lines.push(line);

  const sum = renderSummary(title, results);
  for (const line of sum.lines) lines.push(line);

  const summary = Object.assign({}, sum.summary);
  if (base) summary.baseline = base.summary;
  return { mode: mode, results: results, summary: summary, text: lines.join('\n') };
}
