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
  /^\s*(?<head>第\s*[0-9一二三四五六七八九十百千零〇两]+\s*(?:部分|[章节回讲课篇卷部])|(?:序章|序言|前言|引子|楔子|尾声|结尾|后记|附录\s*[一二三四五六七八九十\dA-Za-z]*|番外(?:篇)?[一二三四五六七八九十\d]*)|(?:chapter|part)\s+[0-9ivxlcdm]+)\s*(?<tail>.*)$/i;

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
function matchHead(line, at, allowParts, prose) {
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

  // 正文里常有「第6章中主要内容……」这种跨章引用：位置在页面中段、句子又长。
  // 真标题要么在页首几行，要么本身很短，所以中段的长句一律不认。
  // 只对「散文页」生效：目录页本来就满是中段的长条目，不能按正文的规矩卡它。
  if (prose !== false && isNumbered && !isPart && tail && (at || 0) > 2 && text.length > 14) return null;

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
  let runs = buildRuns(scan.candidates, pages);
  if (runs.length < 2) {
    const withParts = scanCandidates(pages, true);
    const partRuns = buildRuns(withParts.candidates, pages);
    if (partRuns.length > runs.length) {
      scan = withParts;
      runs = partRuns;
    }
  }

  const total = pages.length;
  const pageNo = (i) => Number((pages[i] && pages[i].page) || i + 1);

  // 章号已经出现过的，是「引用」不是「新章」：译注、索引、附录里的小标题会照抄正文章号。
  markReferences(runs);
  const kept = [];
  for (let k = 0; k < runs.length; k += 1) if (!runs[k].repeat) kept.push(k);

  if (kept.length < 2) {
    const only = kept.length === 1 ? runs[kept[0]] : null;
    const chars = pages.reduce((sum, p) => sum + String((p && p.text) || '').length, 0);
    return [
      {
        n: 1,
        title: only ? titleOfRun(only) : '全文',
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
  const firstIndex = runs[kept[0]].fromIndex;
  if (firstIndex > 0) {
    let chars = 0;
    for (let i = 0; i < firstIndex; i += 1) {
      if (scan.tocPages.has(i)) continue;
      chars += String((pages[i] && pages[i].text) || '').length;
    }
    if (chars >= 200) {
      chapters.push({
        n: 0,
        title: '前文',
        from: pageNo(0),
        to: pageNo(firstIndex - 1),
        chars: chars,
        toc: false,
        front: true,
      });
    }
  }

  for (let i = 0; i < kept.length; i += 1) {
    const k = kept[i];
    const fromIndex = runs[k].fromIndex;
    // 终点止于「下一个段」的起点，哪怕那一段是引用——这样译注页不会被并进附录的尾巴
    const nextIndex = k + 1 < runs.length ? runs[k + 1].fromIndex : total;
    let toIndex = nextIndex - 1 - partBlockBefore(pages, nextIndex, fromIndex);
    // 尾部的空白页也不算（印刷留白，不该进章节）。阈值要小：短页不等于空页。
    while (toIndex > fromIndex && String((pages[toIndex] && pages[toIndex].text) || '').length < 10) toIndex -= 1;
    const from = pageNo(fromIndex);
    const to = Math.max(from, pageNo(toIndex));
    chapters.push({
      n: chapters.filter((c) => !c.front).length + 1,
      title: consistentTitle(titleOfRun(runs[k]), runs[k].no),
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
 * 标出「引用」段：同一本书里章号或标题重复出现的，是译注、索引、附录里的小标题，不是新章。
 *
 * 判据要保守，否则会把「第一部 / 第二部各自从第 1 章数起」这种书吃掉：
 *   同号 + 标题也重名，或者同号 + 根本没有标题（译注里就写「CHAPTER 01」）；
 *   没有编号的（序言、附录）只按标题重名判断。
 */
function markReferences(runs) {
  const seenNo = new Set();
  const seenTail = new Set();
  const seenHead = new Set();
  for (const run of runs) {
    const tail = String(run.tail || '');
    const head = String(run.headKey || '');
    // 有编号的：同号 + 标题重名，或者同号 + 根本没有标题（译注里就写「CHAPTER 01」）
    const repeatNo = run.no > 0 && seenNo.has(run.no) && (!tail || seenTail.has(tail));
    // 没编号的：判重名。这类章的「标题」就是章号本身（序言、附录），tail 是空的
    const repeatNamed = run.no === 0 && head !== '' && seenHead.has(head);
    run.repeat = repeatNo || repeatNamed;
    if (run.repeat) continue;
    if (run.no > 0) seenNo.add(run.no);
    if (tail) seenTail.add(tail);
    if (head) seenHead.add(head);
  }
  return runs;
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
    const totalLen = lines.reduce((sum, line) => sum + line.length, 0);
    pageStats[i] = {
      lines: lines.length,
      chars: text.length,
      avgLen: lines.length ? totalLen / lines.length : 0,
      tocScore: lines.length ? shortWithPageNo / lines.length : 0,
      text: text,
      cands: 0,
    };

    // 散文页：行长、行少。目录页是一列短条目，不能按散文的规矩卡它
    const prose = !(lines.length >= 8 && pageStats[i].avgLen <= 25);

    for (let j = 0; j < lines.length; j += 1) {
      const line = lines[j];
      const hit = matchHead(line, j, allowParts, prose);
      if (!hit) continue;
      const candText = withNextLine(lines, j);
      pageStats[i].cands += 1;
      candidates.push({
        pageIndex: i,
        text: candText,
        headKey: hit.head.replace(/\s+/g, '').toLowerCase(),
        no: chapterNumberOf(hit.head),
        tail: titleTail(candText),
        toc: false,
      });
    }
  }

  /**
   * 是不是目录页。三条判据，任一成立即可：
   *   1. 短行多 + 行尾带页码多（常见的中文目录）
   *   2. 平均行长很短 + 有足够多的章节候选（不写页码的条目式目录）
   *   3. 页面上写着「目录/简目」+ 行尾页码不算少
   * 正文页是长段落，三条都过不了。
   */
  function looksToc(i) {
    const stat = pageStats[i];
    if (!stat || stat.chars < 20) return false;
    if (stat.lines >= 8 && stat.tocScore >= 0.5) return true;
    // 下面两条弱一些，必须同时有够多的章节候选，免得把练习清单、片目页当成目录
    if (stat.cands < 3) return false;
    if (stat.lines >= 8 && stat.avgLen <= 25) return true;
    if (TOC_MARK.test(stat.text) && stat.tocScore >= 0.3) return true;
    return false;
  }

  const tocPages = new Set();
  for (let i = 0; i < pages.length; i += 1) if (looksToc(i)) tocPages.add(i);
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
        if (looksToc(k)) {
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

/**
 * 把候选连成段：页眉并回当前章，标题只差一个字也算同一章。
 * 每条候选都记下所在页——定标题时要用「开篇页上那一条」，那里写得最完整。
 */
function buildRuns(candidates, pages) {
  const runs = [];
  for (const cand of candidates) {
    if (cand.toc) continue;
    const last = runs[runs.length - 1];
    if (last && shouldFold(last, cand)) {
      last.texts.push({ text: cand.text, pageIndex: cand.pageIndex });
      last.lastIndex = cand.pageIndex;
      continue;
    }
    runs.push({
      headKey: cand.headKey,
      no: cand.no,
      texts: [{ text: cand.text, pageIndex: cand.pageIndex }],
      tail: cand.tail,
      fromIndex: cand.pageIndex,
      lastIndex: cand.pageIndex,
    });
  }
  return anchorOpeners(repairOrder(runs), pages);
}

/**
 * 把章节起点往前挪到真正的「标题页」。
 *
 * 章节首页常把章号印成「第章」（数字被 OCR 吃掉），或者干脆只有一行书名式的标题，
 * 于是第一个能认出来的页眉往往落在这章的第 2、3 页上。往回找 5 页以内、字数很少（标题页）
 * 且含本章标题的那一页，把它当成真正的起点。
 */
function anchorOpeners(runs, pages) {
  for (let k = 0; k < runs.length; k += 1) {
    const run = runs[k];
    const tail = String(run.tail || '').replace(/\s+/g, '');
    if (tail.length < 2) continue;
    const floor = k > 0 ? runs[k - 1].fromIndex + 1 : 0;
    for (let j = run.fromIndex - 1; j >= floor && run.fromIndex - j <= 5; j -= 1) {
      const text = String((pages[j] && pages[j].text) || '');
      if (text.length >= 1600) continue; // 太密的正文页当不了标题页
      const lines = text.split('\n').slice(0, 3);
      // 标题页的头一行总是很短，且以「第」/Chapter/Part 开头；
      // 正文页的第一行是「页码 + 书名」或「章名 + 页码」，长度过不了这一关。
      const head = normalizeLine(lines[0] || '');
      // 标题页有两条长相：
      //   a) 首行是「第X章 / Chapter N」这类章号行（≤12 字）
      //   b) 首行被 OCR 认花了（「管 (意」「5意笛」「笛」），但很短，而且紧接着的一行
      //      正好就是本章标题——这是标题页的铁证，不能因为认不出章号就放过
      const lookHead = head.length <= 12 && /^(第|chapter|part)/i.test(head);
      const exactNext = lines.slice(1, 3).some((line) => normalizeLine(line).replace(/\s+/g, '') === tail);
      if (!lookHead && !(head.length <= 8 && exactNext)) continue;
      if (lines.some((line) => matchesTitle(line, tail))) {
        run.fromIndex = j;
        break;
      }
    }
  }
  return runs;
}

/**
 * 这一行是不是本章标题。
 *
 * 标题页上常见三种写法：整行就是标题、标题后面紧跟正文（没有换行）、标题被 OCR 认错一两个字。
 * 所以只比「行首 tail 长度那一段」，容错随标题长度缩放——短标题容 1 字，长标题容 2 字，
 * 否则 4 个字的标题允许错 2 个，什么都能算命中。
 */
function matchesTitle(line, tail) {
  const text = normalizeLine(line).replace(/\s+/g, '');
  if (!text || text.length < tail.length - 2) return false;
  const tolerance = tail.length >= 10 ? 2 : 1;
  return editDistance(text.slice(0, tail.length), tail) <= tolerance;
}

/**
 * 分卷页（第X部分 / Part N 及其导语）不属于任何一章。
 * 不做这一步，下一部分的分卷页会被算进上一章的尾巴里。
 */
function partBlockBefore(pages, index, floor) {
  let block = 0;
  for (let j = index - 1; j >= floor && block < 3; j -= 1) {
    const text = String((pages[j] && pages[j].text) || '');
    const first = normalizeLine(text.split('\n')[0] || '');
    if (!PART_HEAD.test(first)) break;
    if (text.length > 900) break;
    block += 1;
  }
  return block;
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
      // 「下一段才是正主，这一段是它的前半截」——只在两段真像同一章时才成立：
      // 号相关（第5章 vs 第25章，OCR 丢了首位），或者标题相似。
      // 否则这一段只是上一章里的一条杂号页眉（例如图表标签粘出来的「第6章 多发射和深流水线」），
      // 并回前一段即可。少了这个判断，第 7 章会被拽到第 313 页、标题也变成图表标签。
      const related = String(next.no).endsWith(String(run.no)) || String(run.no).endsWith(String(next.no));
      const alike = run.tail && next.tail && Math.abs(run.tail.length - next.tail.length) <= 2 && editDistance(run.tail, next.tail) <= 2;
      if (related || alike) {
        next.fromIndex = Math.min(next.fromIndex, run.fromIndex);
        next.texts = run.texts.concat(next.texts);
        continue;
      }
    }
    if (next.no > expected) {
      // 中间正好缺这一个号：是真章，只是页眉把号认错了，改回来
      const text = '第' + expected + '章' + (run.tail ? ' ' + run.tail : '');
      run.no = expected;
      // 换成改好的标题，但页面归属要保留：texts 里存的是 {text, pageIndex}，别退化成字符串
      run.texts = [{ text: text, pageIndex: run.fromIndex }];
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
export function editDistance(a, b) {
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
 * 一段的标题。
 *
 * 先看开篇页上那一条：标题页写的标题永远是最完整的（页眉经常只印章号，或者把标题和页码粘一起）。
 * 开篇页上没有可用候选时（章号被 OCR 吃掉、压根不成候选）才退回去投票。
 * 投票时跳过「只有章号、没有标题」的候选——它们对定标题零信息量，却在版面上出现得最多，
 * 一旦参与投票就会把真标题投掉（真书里第 1–8 章就是这样丢的标题）。
 */
function titleOfRun(run) {
  const texts = (run && run.texts) || [];
  const opener = texts.find((item) => item.pageIndex === run.fromIndex);
  const openerTitle = opener ? stripTrailingPageNo(opener.text) : '';
  if (openerTitle && hasTitlePart(openerTitle)) return openerTitle;

  const counts = new Map();
  for (const item of texts) {
    const text = stripTrailingPageNo(item.text);
    if (!text || !hasTitlePart(text)) continue;
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
  if (best) return best;
  // 全都没有标题：退回最短的写法（通常就是「第1章」）
  let shortest = '';
  for (const item of texts) {
    const text = stripTrailingPageNo(item.text);
    if (text && (!shortest || text.length < shortest.length)) shortest = text;
  }
  return shortest || '未命名';
}

/** 这一行除了章号之外还有没有标题文字。 */
function hasTitlePart(text) {
  const m = CHAPTER_RE.exec(String(text || ''));
  if (!m) return true;
  return String((m.groups && m.groups.tail) || '').trim() !== '';
}

/** 去掉行尾的页码：「第 1 章 电影导演的世界 5」→「第 1 章 电影导演的世界」。 */
function stripTrailingPageNo(text) {
  const raw = String(text || '').trim();
  // 「CHAPTER 01」「第1章」这种整行只有章号的，行尾的数字就是章号本身，不能当页码剥掉
  const m = CHAPTER_RE.exec(raw);
  if (m && !String((m.groups && m.groups.tail) || '').trim() && /\d{1,4}$/.test(raw)) return raw;
  return raw.replace(/[\s·—–-]*\d{1,4}$/, '').trim();
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
