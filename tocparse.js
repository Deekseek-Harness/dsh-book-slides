/**
 * 精讲台 · 目录驱动的切章（附录 F）
 *
 * 分工写死在这里：
 *   模型  只做一件事——把目录原文读成 [{title, printed_page, level}]
 *   程序  做剩下所有能验证的事——校准印刷页→物理页、算区间、抽查标题
 *
 * 这样模型出错是可测的：页码不单调、标题在区间里找不到，都能被机械检查抓到。
 */
import { CHAPTER_RE, normalizeLine, editDistance } from './text.js';

export const TOC_PROMPT_VERSION = 'toc-extract-v1';
export const TOC_MAX_ENTRIES = 60;
export const TOC_MIN_ENTRIES = 3;

/* ------------------------------ 目录页范围建议 ------------------------------ */

/**
 * 猜目录页码范围。只用来给导入表单预填，用户可改。
 * 判据与 text.js 的 looksToc 一致：短行多 + 行尾带页码多，或纯条目式短行。
 */
export function suggestTocRange(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return null;
  const hits = [];
  for (let i = 0; i < pages.length; i += 1) {
    const text = String((pages[i] && pages[i].text) || '');
    if (text.length < 20) continue;
    const lines = text.split('\n').filter(Boolean);
    if (lines.length < 8) continue;
    const withPageNo = lines.filter((line) => line.length <= 46 && /[\s.·—–-]*\d{1,4}$/.test(line)).length;
    const avgLen = lines.reduce((sum, line) => sum + line.length, 0) / lines.length;
    if (withPageNo / lines.length >= 0.5 || avgLen <= 25) hits.push(i);
  }
  if (!hits.length) return null;
  // 取最长的一段连续页（允许中间隔一页）
  let best = { from: hits[0], to: hits[0] };
  let start = hits[0];
  let prev = hits[0];
  for (let k = 1; k < hits.length; k += 1) {
    if (hits[k] - prev <= 2) {
      prev = hits[k];
      if (prev - start > best.to - best.from) best = { from: start, to: prev };
      continue;
    }
    start = hits[k];
    prev = hits[k];
  }
  const pageNo = (i) => Number((pages[i] && pages[i].page) || i + 1);
  return { from: pageNo(best.from), to: pageNo(best.to) };
}

/* ------------------------------ 目录原文 ------------------------------ */

/** 取目录页文本，带行号，供模型引用；总长截断到 8000 字。 */
export function tocTextOf(pages, from, to, limit = 8000) {
  const parts = [];
  let n = 0;
  for (const page of pages) {
    const no = Number((page && page.page) || 0);
    if (no < from || no > to) continue;
    for (const line of String((page && page.text) || '').split('\n')) {
      const text = normalizeLine(line);
      if (!text) continue;
      n += 1;
      parts.push('L' + n + ': ' + text);
      if (parts.join('\n').length > limit) return parts.join('\n');
    }
  }
  return parts.join('\n');
}

/* ------------------------------ 提示词 ------------------------------ */

/** 拼两条消息：system 来自 prompts/toc-extract-v1.md，user 是这本书的目录原文。 */
export function buildTocMessages({ promptFile, book, pages, from, to }) {
  const total = pages.length;
  const user = [
    '【书名】' + String((book && book.title) || ''),
    '【总页数】' + total,
    '【目录原文】',
    tocTextOf(pages, from, to),
  ].join('\n');
  return { system: String(promptFile || ''), user: user };
}

/* ------------------------------ 解析与校验 ------------------------------ */

/** 模型回复 → entries。坏 JSON 抛错，错误信息带原文片段便于回灌重试。 */
export function parseTocReply(reply) {
  const raw = String(reply || '')
    .replace(/^\uFEFF/, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('回复里没有 JSON 对象');
  let data;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    throw new Error('JSON 解析失败：' + ((err && err.message) || '未知') + '；原文片段：' + raw.slice(start, start + 120));
  }
  const list = Array.isArray(data && data.entries) ? data.entries : null;
  if (!list) throw new Error('JSON 里没有 entries 数组');
  return list.map((item) => ({
    title: String((item && item.title) || '').trim(),
    printed: Math.round(Number((item && item.printed_page) || 0)),
    level: normalizeLevel(item && item.level),
    fixedChar: !!(item && item.fixed_char),
  }));
}

function normalizeLevel(level) {
  const text = String(level || '').toLowerCase();
  if (text === 'part' || text === 'appendix' || text === 'front' || text === 'chapter') return text;
  return 'chapter';
}

/**
 * 校验模型给的目录表。返回错误列表（空 = 通过）。
 * 这些错误会连同原文一起回灌给模型重试一次。
 */
export function validateEntries(entries) {
  const errors = [];
  if (!Array.isArray(entries) || entries.length === 0) return ['没有任何条目'];
  if (entries.length < TOC_MIN_ENTRIES) errors.push('条目太少（' + entries.length + ' 条），至少要 ' + TOC_MIN_ENTRIES + ' 条');
  if (entries.length > TOC_MAX_ENTRIES) errors.push('条目太多（' + entries.length + ' 条），可能把小节也算进来了');
  entries.forEach((entry, index) => {
    const at = '第 ' + (index + 1) + ' 条';
    if (!entry.title) errors.push(at + '没有标题');
    else if (entry.title.length > 40) errors.push(at + '标题过长（' + entry.title.length + ' 字）');
    if (!(entry.printed > 0)) errors.push(at + '页码不是正整数');
    if (index > 0) {
      const prev = entries[index - 1];
      if (entry.printed > 0 && prev.printed > 0 && entry.printed < prev.printed) {
        errors.push(at + '页码比上一条小（' + prev.printed + ' → ' + entry.printed + '）');
      }
    }
  });
  return errors;
}

/* ------------------------------ 校准 ------------------------------ */

/**
 * 从页眉/页脚里读印刷页码。返回 0 表示这页看不出页码。
 * 只认三种形态：行首数字（「220 第5章」）、行尾数字（「处理器 219」）、首行全数字。
 */
export function printedPageOf(text) {
  const lines = String(text || '').split('\n').filter(Boolean);
  if (!lines.length) return 0;
  const head = normalizeLine(lines[0]);
  const lead = /^(\d{1,4})\s*\D/.exec(head);
  if (lead) return Number(lead[1]);
  if (head.length <= 60) {
    const trail = /\D\s*(\d{1,4})$/.exec(head);
    if (trail) return Number(trail[1]);
  }
  const first = /^(\d{1,4})$/.exec(head);
  if (first) return Number(first[1]);
  return 0;
}

/** 页眉页码投票：physical - printed 的众数。 */
export function guessOffset(pages) {
  const counts = new Map();
  let samples = 0;
  for (const page of pages) {
    const printed = printedPageOf(page && page.text);
    if (!printed) continue;
    samples += 1;
    const delta = Number((page && page.page) || 0) - printed;
    counts.set(delta, (counts.get(delta) || 0) + 1);
  }
  if (samples < 10) return { offset: 0, share: 0, samples: samples };
  let best = { delta: 0, count: 0 };
  for (const [delta, count] of counts) if (count > best.count) best = { delta: delta, count: count };
  return { offset: best.delta, share: best.count / samples, samples: samples };
}

/** 标题去掉章号后的部分：「第7章 层次结构的存储器」→「层次结构的存储器」。 */
export function titleTailOf(title) {
  const m = CHAPTER_RE.exec(String(title || '').replace(/\s+/g, ' ').trim());
  return m ? String((m.groups && m.groups.tail) || '').replace(/\s+/g, '').trim() : '';
}

/**
 * 在某一页里找标题：只看前 3 行。
 *
 * 两条命中途径，缺一不可：
 *   a) 行首就是标题的正文部分（「层次结构的存储器…」）——页眉常见写法；
 *   b) 整行就是完整标题（「第3章 计算机的算术运算」「附录C」）——标题页常见写法。
 * 不能只比整行：光比整行的话，「第6章 利用流水线提高性能」会和「第7章 层次结构的存储器」
 * 差两个字就命中，把第 7 章钉到第 6 章的标题页上。
 */
export function pageHasTitle(text, title) {
  const whole = String(title || '').replace(/\s+/g, '');
  if (whole.length < 2) return false;
  const tail = titleTailOf(title);
  const tolerance = whole.length >= 10 ? 2 : 1;
  const lines = String(text || '').split('\n').slice(0, 3);
  for (const line of lines) {
    const text2 = normalizeLine(line).replace(/\s+/g, '');
    if (!text2) continue;
    // a) 行首就是标题正文（页眉写法：「控制器的硬件实现 545」）
    if (tail.length >= 2) {
      const probe = text2.slice(0, tail.length);
      if (probe.length >= Math.min(2, tail.length) && editDistance(probe, tail) <= tolerance) return true;
    }
    // b) 整行就是完整标题（标题页写法：「第3章 计算机的算术运算」「附录C」）
    const probe2 = text2.slice(0, whole.length);
    if (editDistance(probe2, whole) <= tolerance) return true;
    // c) 标题页把副标题省了，只印前半截（TOC 写「处理器：数据通路及其控制」，书里只印「处理器」）
    const pageTail = titleTailOf(text2);
    if (pageTail.length >= 3 && tail.length >= pageTail.length) {
      if (editDistance(tail.slice(0, pageTail.length), pageTail) <= tolerance) return true;
    }
  }
  return false;
}

/**
 * 印刷页 → 物理页。
 *
 * 两条独立证据：
 *   A 页眉页码众数（全局偏移）
 *   B 目录标题在正文里首次命中（逐章定位）
 * A 可信（占比 ≥ 0.6）且与 B 相差 ≤ 2 页 → 用 A；否则用 B。
 * 两条都没命中才算这一章定位失败。
 */
export function calibrate(pages, entries) {
  const vote = guessOffset(pages);
  const offsetA = vote.offset;
  const total = pages.length;
  const trusted = vote.share >= 0.6;
  const out = [];
  let searchFrom = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const guess = entry.printed + offsetA;

    // 证据 B：从上一章起点往后找标题
    let found = 0;
    for (let k = searchFrom; k < total; k += 1) {
      if (!pageHasTitle(pages[k] && pages[k].text, entry.title)) continue;
      found = Number((pages[k] && pages[k].page) || k + 1);
      break;
    }

    let physical = 0;
    let anchor = 'none';
    const guessInRange = guess >= 1 && guess <= total;
    if (trusted && guessInRange && (!found || Math.abs(found - guess) <= 2)) {
      physical = guess;
      anchor = 'header';
    } else if (found) {
      physical = found;
      anchor = 'title';
    } else if (guessInRange && trusted) {
      physical = guess;
      anchor = 'header';
    }

    if (physical) searchFrom = physical - 1;
    out.push({
      title: entry.title,
      printed: entry.printed,
      physical: physical,
      level: entry.level,
      anchor: anchor,
      fixedChar: entry.fixedChar,
    });
  }

  const placed = out.filter((item) => item.physical > 0).length;
  const hitRate = out.length ? placed / out.length : 0;
  let status = 'verified';
  if (!out.length || hitRate < 0.5) status = 'failed';
  else if (hitRate < 0.8) status = 'unverified';
  return { status: status, offset: offsetA, offsetShare: vote.share, entries: out, hitRate: hitRate };
}

/**
 * 校准结果 → chapters。
 * 结构必须和机械路径完全一致（n/title/from/to/chars/toc/front/verified/source）。
 */
export function chaptersFromToc(pages, calibrated) {
  const total = pages.length;
  const pageNo = (i) => Number((pages[i] && pages[i].page) || i + 1);
  const list = (calibrated && calibrated.entries ? calibrated.entries : []).filter((item) => item.physical > 0);
  list.sort((a, b) => a.physical - b.physical);
  if (list.length < 2) return null;

  const charsBetween = (from, to) => {
    let sum = 0;
    for (const page of pages) {
      const no = Number((page && page.page) || 0);
      if (no >= from && no <= to) sum += String((page && page.text) || '').length;
    }
    return sum;
  };

  const chapters = [];
  const firstFrom = list[0].physical;
  if (firstFrom > pageNo(0)) {
    const chars = charsBetween(pageNo(0), firstFrom - 1);
    if (chars >= 200) {
      chapters.push({ n: 0, title: '前文', from: pageNo(0), to: firstFrom - 1, chars: chars, toc: false, front: true, verified: true, source: 'toc' });
    }
  }
  for (let i = 0; i < list.length; i += 1) {
    const from = list[i].physical;
    const to = i + 1 < list.length ? Math.max(from, list[i + 1].physical - 1) : pageNo(total - 1);
    chapters.push({
      n: chapters.filter((c) => !c.front).length + 1,
      title: list[i].title,
      from: from,
      to: to,
      chars: charsBetween(from, to),
      toc: false,
      front: false,
      verified: true,
      source: 'toc',
    });
  }
  return chapters;
}

/* ------------------------------ 抽查 ------------------------------ */

/**
 * 标题抽查：每一章的页区间里，标题是否真的出现过。
 * 这是「这次解析可不可信」的唯一客观依据。
 */
export function verifyChapters(pages, chapters) {
  let hit = 0;
  let total = 0;
  for (const chapter of chapters) {
    if (chapter.front) continue;
    total += 1;
    let found = false;
    for (const page of pages) {
      const no = Number((page && page.page) || 0);
      if (no < chapter.from || no > chapter.to) continue;
      if (pageHasTitle(page && page.text, chapter.title)) {
        found = true;
        break;
      }
    }
    chapter.verified = found;
    if (found) hit += 1;
  }
  return total ? hit / total : 0;
}
