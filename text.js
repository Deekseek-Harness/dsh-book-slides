/**
 * 精讲台 · 文本底座
 *
 * 两个纯函数，不碰磁盘、不碰网络，所以能直接拿字符串测：
 *   cleanPages(pages)    清洗逐页文本（页眉页脚、页码行、软换行）
 *   buildChapters(pages) 用正则切章，含目录块剔除与无章节兜底
 *
 * 真书（582 页、OCR 文字层）踩出来的五条经验，都写死在这里：
 *   1. 双栏目录页照碎片顺序拼会拼成一锅粥 —— 所以行由 pdfread 按坐标重建，这里只认得干净的行。
 *   2. 目录页不止一页、也未必写着「目录」 —— 按形态认：短行 + 行尾页码 + 连续多页高密度。
 *   3. 正文每页顶部常有页眉「第 1 章 电影导演的世界 23」，章号与当前章相同就是页眉。
 *   4. 页眉的章号也会被 OCR 认错（第26章 认成 第28章）—— 章号倒退或标题只差一个字，都并回当前章。
 *   5. 「第X部分 / Part II」是分卷标记不是章；真找不到章时才退而把部分当章。
 */

/**
 * 主正则：认 第X章/节/回/讲/篇/卷/部分、序章一类、Chapter N、Part N。
 * 「部分」必须排在「部」前面，否则「第三部分」会被切成「第三部 + 分」。
 */
export const CHAPTER_RE =
  /^\s*(?<head>第\s*[0-9一二三四五六七八九十百千零〇两]+\s*(?:部分|[章节回讲课篇卷部])|(?:序章|序言|前言|引子|楔子|尾声|结尾|后记|附录[一二三四五六七八九十\d]*|番外(?:篇)?[一二三四五六七八九十\d]*)|(?:chapter|part)\s+[0-9ivxlcdm]+)\s*(?<tail>.*)$/i;

/**
 * 标题里不该出现的标点：出现这些基本就是正文句子。
 * 半角逗号也算 —— 正文里「第5章“xxx”中,曾强烈推荐…」这种跨章引用就是这么混进来的。
 * 顿号与全角冒号不算：标题本身就常用（「第14章 时间、结构与情节」）。
 */
const BODY_PUNCT = /[，。！？；,.!?;:]/;
/** 标题里不该出现引号：书名号/引号一出现，基本是在引用别的章节。 */
const QUOTE_MARKS = /[“”"「」『』]/;
/** 行尾是这些字符，说明这句没说完，要与下一行合并。 */
const CONTINUES = /[^。！？；：」』”"’）)】》\u300f]$/;
const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\ufeff]/g;
const PAGE_NO_LINE = /^[-—\s]*\d{1,4}[-—\s]*$/;
const TOC_MARK = /(目\s*录|简目|细目|总目|contents)/i;
const PART_HEAD = /^(第\s*[0-9一二三四五六七八九十百千零〇两]+\s*部分|part\b)/i;
/** 目录行的尾巴：一到四位页码。 */
const TRAILING_PAGE_NO = /[\s.·—–-]*(\d{1,4})$/;

/** 行内空白归一：全角空格、零宽字符、连续空白。 */
export function normalizeLine(line) {
  return String(line || '')
    .replace(/\u3000/g, ' ')
    .replace(ZERO_WIDTH, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/* ------------------------------ 标题识别 ------------------------------ */

/**
 * 判断一行是不是「章节标题」，返回 {head, tail, isPart} 或 null。
 *
 * @param {string} line 已归一化的一行
 * @param {number} at 这一行在页面内的行号（0 起）
 * @param {boolean} allowParts 是否把「第X部分 / Part N」也算进来
 */
function matchHead(line, at, allowParts) {
  const text = normalizeLine(line);
  if (!text) return null;
  if (text.length > 48) return null;
  if (BODY_PUNCT.test(text)) return null;
  if (QUOTE_MARKS.test(text)) return null;
  const m = CHAPTER_RE.exec(text);
  if (!m) return null;
  const head = String((m.groups && m.groups.head) || '').trim();
  const tail = String((m.groups && m.groups.tail) || '').trim();
  if (tail.length > 40) return null;

  const isPart = PART_HEAD.test(head);
  if (isPart && !allowParts) return null;

  // 没有编号的标题（序章/前言/引子/后记…）出现在页面深处，多半是图注或正文
  const isNumbered = /^第/.test(head) || /^chapter/i.test(head);
  if (!isNumbered && !isPart && !tail && (at || 0) > 2) return null;

  return { head: head, tail: tail, isPart: isPart };
}

/**
 * 是不是一个章节标题行。
 */
export function isChapterLine(line, at) {
  return matchHead(line, at || 0, false) !== null;
}

/** 是不是分卷标题行（第X部分 / Part N）。只在找不到章时退而用它。 */
export function isPartLine(line, at) {
  const m = matchHead(line, at || 0, true);
  return !!(m && m.isPart);
}

/** 章号：「第 1 章」「第一章」「CHAPTER 03」都归一成数字；认不出返回 0。 */
export function chapterNumberOf(head) {
  const text = normalizeLine(head);
  const cn = /^第\s*([0-9]+|[一二三四五六七八九十百千零〇两]+)/.exec(text);
  if (cn) {
    if (/^[0-9]+$/.test(cn[1])) return Number(cn[1]);
    return cnToInt(cn[1]);
  }
  const en = /^chapter\s+([0-9]+|[ivxlcdm]+)/i.exec(text);
  if (en) {
    if (/^[0-9]+$/.test(en[1])) return Number(en[1]);
    return romanToInt(en[1]);
  }
  return 0;
}

function cnToInt(raw) {
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units = { 十: 10, 百: 100, 千: 1000 };
  let section = 0;
  let number = 0;
  for (const ch of String(raw || '')) {
    if (digits[ch] !== undefined) {
      number = digits[ch];
    } else if (units[ch] !== undefined) {
      section += (number || 1) * units[ch];
      number = 0;
    }
  }
  return section + number;
}

function romanToInt(raw) {
  const table = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  const s = String(raw || '').toLowerCase();
  let total = 0;
  for (let i = 0; i < s.length; i += 1) {
    const cur = table[s[i]] || 0;
    const next = table[s[i + 1]] || 0;
    total += cur < next ? -cur : cur;
  }
  return total;
}

/* ------------------------------ 清洗 ------------------------------ */

/** 页边行下标：页眉页脚只会在这些位置。页数少时整页都算页边。 */
function edgeIndexes(length) {
  if (length <= 4) return Array.from({ length: length }, (_, i) => i);
  return [0, 1, length - 2, length - 1];
}

/**
 * 清洗逐页文本。
 * @param {{page:number,text:string}[]} pages 原始逐页文本
 * @returns {{page:number,text:string}[]} 清洗后的逐页文本
 */
export function cleanPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return [];
  const pageCount = pages.length;

  const linePages = pages.map((p) => String((p && p.text) || '').split('\n').map(normalizeLine));

  // 页眉页脚：只看每页头两行、尾两行，去掉数字后仍在 ≥60% 页面重复出现的短行。
  // 三条限制缺一不可：只在页边、带句读的不算、章节标题不算（否则「第1章…第9章」抹掉数字后会被整批误删）。
  const seenOn = new Map();
  if (pageCount >= 4) {
    for (const lines of linePages) {
      const edge = new Set();
      for (const index of edgeIndexes(lines.length)) {
        const line = lines[index];
        if (!line) continue;
        if (isChapterLine(line, index) || isPartLine(line, index)) continue;
        if (/[。！？，；、]$/.test(line)) continue;
        const key = line.replace(/\d+/g, '').trim();
        if (!key || key.length > 30) continue;
        edge.add(key);
      }
      for (const key of edge) seenOn.set(key, (seenOn.get(key) || 0) + 1);
    }
  }
  const repeated = new Set();
  for (const [key, count] of seenOn) {
    if (count / pageCount >= 0.6) repeated.add(key);
  }

  const out = [];
  for (let i = 0; i < pages.length; i += 1) {
    const kept = [];
    for (const raw of linePages[i]) {
      const line = normalizeLine(raw);
      if (!line) continue;
      if (PAGE_NO_LINE.test(line)) continue;
      const key = line.replace(/\d+/g, '').trim();
      if (repeated.has(key)) continue;
      kept.push(line);
    }
    out.push({ page: Number((pages[i] && pages[i].page) || i + 1), text: mergeSoftBreaks(kept) });
  }
  return out;
}

/**
 * 合并软换行：中文排版里一句话被排版折断，行尾没有句末标点就接下一行。
 * 章节标题行不参与合并，否则「第一章」会被粘到正文第一句上。
 */
export function mergeSoftBreaks(lines) {
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    if (out.length === 0) {
      out.push(line);
      continue;
    }
    const prev = out[out.length - 1];
    const joinable =
      prev.length >= 12 &&
      CONTINUES.test(prev) &&
      !isChapterLine(prev) &&
      !isChapterLine(line) &&
      !/^[-*·•▲■]/.test(line) &&
      !/^\d+(\.\d+)*\s/.test(line) &&
      !/^\[\d+\]/.test(line);
    if (joinable) out[out.length - 1] = prev + line;
    else out.push(line);
  }
  return out.join('\n');
}

/* ------------------------------ 切章 ------------------------------ */

/**
 * 切章。
 *
 * 三步：先按形态把整块目录页挑出来扔掉，再按「章号」把候选连成段
 * （页眉与本章同号、章号倒退、标题只差一个字，都并进当前章），最后把段变成章节。
 *
 * @param {{page:number,text:string}[]} pages 已清洗的逐页文本
 * @returns {{n:number,title:string,from:number,to:number,chars:number,toc:boolean,front:boolean}[]}
 */
export function buildChapters(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return [];

  let scan = scanCandidates(pages, false);
  let runs = buildRuns(scan.candidates);
  if (runs.length < 2) {
    const withParts = scanCandidates(pages, true);
    const partRuns = buildRuns(withParts.candidates);
    if (partRuns.length > runs.length) {
      scan = withParts;
      runs = partRuns;
    }
  }

  const total = pages.length;
  const pageNo = (i) => Number((pages[i] && pages[i].page) || i + 1);

  if (runs.length < 2) {
    const chars = pages.reduce((sum, p) => sum + String((p && p.text) || '').length, 0);
    return [
      {
        n: 1,
        title: runs.length === 1 ? titleOfRun(runs[0].texts) : '全文',
        from: pageNo(0),
        to: pageNo(total - 1),
        chars: chars,
        toc: false,
        front: false,
        fallback: true,
      },
    ];
  }

  const chapters = [];
  // 第一章之前的内容：单独一段「前文」。目录页不算进字数，那是目录不是正文。
  if (runs[0].fromIndex > 0) {
    let chars = 0;
    for (let i = 0; i < runs[0].fromIndex; i += 1) {
      if (scan.tocPages.has(i)) continue;
      chars += String((pages[i] && pages[i].text) || '').length;
    }
    if (chars >= 200) {
      chapters.push({
        n: 0,
        title: '前文',
        from: pageNo(0),
        to: pageNo(runs[0].fromIndex - 1),
        chars: chars,
        toc: false,
        front: true,
      });
    }
  }

  for (let k = 0; k < runs.length; k += 1) {
    const from = pageNo(runs[k].fromIndex);
    const nextFrom = k + 1 < runs.length ? pageNo(runs[k + 1].fromIndex) : pageNo(total - 1) + 1;
    const to = Math.max(from, nextFrom - 1);
    chapters.push({
      n: k + 1,
      title: consistentTitle(titleOfRun(runs[k].texts), runs[k].no),
      from: from,
      to: to,
      chars: charsBetween(pages, from, to),
      toc: false,
      front: false,
    });
  }
  return chapters;
}

/**
 * 标题里的章号要和最终章号一致。
 *
 * 章号被 OCR 认错时（页眉写「第5章」，其实是第 25 章），修好的号已经存进 run.no，
 * 但标题文字还是旧的。这一步把标题的头改成正确的号，剩下的尾巴原样保留。
 */
function consistentTitle(title, no) {
  const text = normalizeLine(title);
  if (!no || no <= 0) return text;
  const m = CHAPTER_RE.exec(text);
  if (!m) return text;
  const head = String((m.groups && m.groups.head) || '').trim();
  if (!head || PART_HEAD.test(head)) return text;
  const got = chapterNumberOf(head);
  if (!got || got === no) return text;
  const tail = String((m.groups && m.groups.tail) || '').trim();
  return ('第' + no + '章' + (tail ? ' ' + tail : '')).trim();
}

/**
 * 扫出候选，并把目录块整块标掉。
 *
 * 目录页的形态比「目录」两个字可靠得多：一页里大半是短行、且行尾带页码。
 * 真书的目录往往跨十几页，还可能换个词叫「简目」，靠标记词只能碰到第一页。
 */
function scanCandidates(pages, allowParts) {
  const pageStats = [];
  const candidates = [];
  for (let i = 0; i < pages.length; i += 1) {
    const text = String((pages[i] && pages[i].text) || '');
    const lines = text.split('\n').filter(Boolean);
    const shortWithPageNo = lines.filter((line) => line.length <= 46 && TRAILING_PAGE_NO.test(line)).length;
    pageStats[i] = {
      lines: lines.length,
      chars: text.length,
      tocScore: lines.length ? shortWithPageNo / lines.length : 0,
    };

    for (let j = 0; j < lines.length; j += 1) {
      const line = lines[j];
      const hit = matchHead(line, j, allowParts);
      if (!hit) continue;
      const text = withNextLine(lines, j);
      candidates.push({
        pageIndex: i,
        text: text,
        headKey: hit.head.replace(/\s+/g, '').toLowerCase(),
        no: chapterNumberOf(hit.head),
        tail: titleTail(text),
        toc: false,
      });
    }
  }

  // 目录页：短行多、行尾带页码的多。正文页是长段落，这两条都过不了。
  const tocPages = new Set();
  for (let i = 0; i < pages.length; i += 1) {
    const stat = pageStats[i];
    if (stat.lines >= 8 && stat.tocScore >= 0.5) tocPages.add(i);
  }
  // 写着「目录/简目」而形态又不像正文的，也算
  for (let i = 0; i < pages.length; i += 1) {
    if (!TOC_MARK.test(String((pages[i] && pages[i].text) || ''))) continue;
    if (pageStats[i].tocScore >= 0.3) tocPages.add(i);
  }
  // 目录跨好几页时把它们连成一块：紧挨着的目录页、中间隔一页空白，都算同一块
  const seeds = Array.from(tocPages).sort((a, b) => a - b);
  for (const seed of seeds) {
    for (const dir of [-1, 1]) {
      let blanks = 0;
      for (let k = seed + dir; k >= 0 && k < pages.length; k += dir) {
        const stat = pageStats[k];
        // 空白页用「几乎没有字」判断，不能用行数：章节首页常常只有两三行（标题 + 一段）。
        if (!stat || stat.chars < 40) {
          blanks += 1;
          if (blanks > 1) break;
          tocPages.add(k);
          continue;
        }
        if (stat.tocScore >= 0.45) {
          blanks = 0;
          tocPages.add(k);
          continue;
        }
        break;
      }
    }
  }

  for (const c of candidates) if (tocPages.has(c.pageIndex)) c.toc = true;
  return { candidates: candidates, tocPages: tocPages };
}

/** 把候选连成段：页眉并回当前章，标题只差一个字也算同一章。 */
function buildRuns(candidates) {
  const runs = [];
  for (const cand of candidates) {
    if (cand.toc) continue;
    const last = runs[runs.length - 1];
    if (last && shouldFold(last, cand)) {
      last.texts.push(cand.text);
      last.lastIndex = cand.pageIndex;
      continue;
    }
    runs.push({
      headKey: cand.headKey,
      no: cand.no,
      texts: [cand.text],
      tail: cand.tail,
      fromIndex: cand.pageIndex,
      lastIndex: cand.pageIndex,
    });
  }
  return repairOrder(runs);
}

/**
 * 这个候选算不算「同一章的又一次出现」。
 *
 * 只看两条：章号完全一样；或者标题几乎一样（真书里页眉会被 OCR 认错章号，
 * 「第26章 美术设计」被认成「第28章 英术设计」——章号对不上，标题只差一个字）。
 * 不能只看「章号倒退就并回去」：一旦前面多出一个假章，后面所有章都会被吞进它肚子里。
 */
function shouldFold(run, cand) {
  if (run.headKey === cand.headKey) return true;
  if (cand.pageIndex - run.lastIndex > 12) return false; // 页眉一定紧跟本章，隔太多页就不认
  const a = run.tail;
  const b = cand.tail;
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.abs(a.length - b.length) <= 1 && editDistance(a, b) <= 1) return true;
  return false;
}

/**
 * 修一下顺序：章号只该往前走。
 *
 * 真书的页眉会被 OCR 认错号（第31章→第3章、第41章→第4章、第26章→第28章），
 * 于是出现「chapter 号倒退」的假段。左到右走一遍，按「应该出现的号」判断它是
 * 页眉、是被认错号的真章、还是下一章的前半截。
 */
function repairOrder(runs) {
  const out = [];
  let expected = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(run);
      if (run.no > 0) expected = run.no + 1;
      continue;
    }
    if (!(run.no > 0 && prev.no > 0) || run.no >= expected) {
      out.push(run);
      if (run.no > 0) expected = run.no + 1;
      continue;
    }

    // 章号倒退了，三种可能
    const similar =
      prev.tail && prev.tail === run.tail
        ? true
        : prev.tail && run.tail && Math.abs(prev.tail.length - run.tail.length) <= 1 && editDistance(prev.tail, run.tail) <= 1;
    const next = runs[i + 1];

    if (similar || !next) {
      // 就是本章的页眉，并回去
      prev.texts.push(...run.texts);
      prev.lastIndex = Math.max(prev.lastIndex, run.lastIndex);
      continue;
    }
    if (next.no === expected) {
      // 下一段才是正主，这一段是它的前半截：往前接
      next.fromIndex = Math.min(next.fromIndex, run.fromIndex);
      next.texts = run.texts.concat(next.texts);
      continue;
    }
    if (next.no > expected) {
      // 中间正好缺这一个号：是真章，只是页眉把号认错了，改回来
      const text = '第' + expected + '章' + (run.tail ? ' ' + run.tail : '');
      run.no = expected;
      run.texts = [text];
      run.tail = run.tail;
      out.push(run);
      expected += 1;
      continue;
    }
    prev.texts.push(...run.texts);
    prev.lastIndex = Math.max(prev.lastIndex, run.lastIndex);
  }

  // 相邻同号段（被认错号拆开的同一章）合起来
  const merged = [];
  for (const run of out) {
    const prev = merged[merged.length - 1];
    if (prev && run.no > 0 && prev.no === run.no && run.fromIndex - prev.lastIndex <= 3) {
      prev.texts.push(...run.texts);
      prev.lastIndex = Math.max(prev.lastIndex, run.lastIndex);
      continue;
    }
    merged.push(run);
  }
  return merged;
}

/** 标题尾巴：去掉章号与行尾页码，只留下真正的标题文字。 */
function titleTail(text) {
  const m = CHAPTER_RE.exec(normalizeLine(text));
  if (!m) return '';
  return String((m.groups && m.groups.tail) || '')
    .replace(TRAILING_PAGE_NO, '')
    .replace(/\s+/g, '')
    .trim();
}

/** 编辑距离，只用来判「差一个字」，长度差超过 2 直接返回大数。 */
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = new Array(cols);
  let cur = new Array(cols);
  for (let j = 0; j < cols; j += 1) prev[j] = j;
  for (let i = 1; i < rows; i += 1) {
    cur[0] = i;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[cols - 1];
}

/** 下一行当标题时可以有的标点：顿号、冒号都常见，句读不行。 */
const NEXT_LINE_BAD = /[。！？，；]/;

/** 标题只有「第1 章」时，把下一行的短标题接上：第1 章 电影导演的世界。 */
function withNextLine(lines, index) {
  const text = normalizeLine(lines[index]);
  const m = CHAPTER_RE.exec(text);
  const tail = String((m && m.groups && m.groups.tail) || '').trim();
  if (tail) return text;
  for (let k = index + 1; k < lines.length; k += 1) {
    const next = normalizeLine(lines[k]);
    if (!next) continue;
    if (next.length <= 20 && !NEXT_LINE_BAD.test(next) && !QUOTE_MARKS.test(next) && !matchHead(next, k, true)) {
      return text + ' ' + next;
    }
    break;
  }
  return text;
}

/**
 * 一段之内的标题：页眉与章首页的写法会不一样，取出现次数最多的那个；
 * 次数一样时取最短的。OCR 只错一处时，高频的那个通常是对的。
 */
function titleOfRun(texts) {
  const counts = new Map();
  for (const raw of texts) {
    const text = stripTrailingPageNo(raw);
    if (!text) continue;
    counts.set(text, (counts.get(text) || 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [text, count] of counts) {
    if (count > bestCount || (count === bestCount && text.length < best.length)) {
      best = text;
      bestCount = count;
    }
  }
  return best || (texts[0] ? stripTrailingPageNo(texts[0]) : '未命名');
}

/** 去掉行尾的页码：「第 1 章 电影导演的世界 5」→「第 1 章 电影导演的世界」。 */
function stripTrailingPageNo(text) {
  return String(text || '')
    .replace(/[\s·—–-]*\d{1,4}$/, '')
    .trim();
}

/** 统计一段页区间内的字数。 */
function charsBetween(pages, from, to) {
  let sum = 0;
  for (const p of pages) {
    const n = Number((p && p.page) || 0);
    if (n >= from && n <= to) sum += String((p && p.text) || '').length;
  }
  return sum;
}

/**
 * 一本书的阅读统计：总字数、章数，给书架卡片用。
 */
export function summarize(pages, chapters) {
  const chars = pages.reduce((sum, p) => sum + String((p && p.text) || '').length, 0);
  return {
    pages: pages.length,
    chars: chars,
    chapters: Array.isArray(chapters) ? chapters.filter((c) => !c.front).length : 0,
  };
}
