/**
 * 精讲台 · PDF 读文本
 *
 * 只用 pdfjs-dist 的 legacy 构建在 Node 里读文字层，不渲染、不需要 canvas。
 * 中文 PDF 常见「不嵌字体的预定义 CMap」，所以显式把 cMapUrl 指到包内 cmaps/，
 * 否则那类文件会解出一堆乱码或空字符串。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));

/** pdfjs 只认以正斜杠结尾的 URL，Windows 的反斜杠会直接被判成非法。 */
function assetUrl(...parts) {
  return path.join(PDFJS_DIR, ...parts).split(path.sep).join('/') + '/';
}

export const PDF_ERROR = {
  CORRUPT: 'E_PDF_CORRUPT',
  ENCRYPTED: 'E_PDF_ENCRYPTED',
  NO_TEXT: 'E_PDF_NO_TEXT',
  TOO_LARGE: 'E_PDF_TOO_LARGE',
};

export class PdfError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'PdfError';
    this.code = code;
    this.hint = hint || '';
  }
}

/** 把 pdfjs 的报错翻译成我们自己的错误码。 */
function mapError(err) {
  const name = String((err && err.name) || '');
  const message = String((err && err.message) || err || '');
  if (name === 'PasswordException' || /password/i.test(message)) {
    return new PdfError(PDF_ERROR.ENCRYPTED, '这份 PDF 有密码保护', '请在别的工具里解除加密后再导入。');
  }
  return new PdfError(PDF_ERROR.CORRUPT, '这份 PDF 打不开，可能已损坏', message.slice(0, 200));
}

/**
 * 一页的文字碎片 → 一组按阅读顺序排好的行。
 *
 * 不能直接照 item 顺序拼字符串：双栏目录里左右栏的碎片在内容流里是交替出现的，
 * 照顺序拼就会拼出「第10章 供选择的故事来源150 14.1时 间」这种东西。
 * 所以按坐标重建：先分栏，再把同一基线上的碎片并成一行，行内按 x 排序。
 */
export function linesOfItems(items) {
  const glyphs = [];
  for (const item of items || []) {
    if (!item || typeof item.str !== 'string' || !item.str.trim()) continue;
    const t = item.transform || [];
    glyphs.push({
      str: item.str,
      x: Number(t[4]) || 0,
      y: Number(t[5]) || 0,
      w: Number(item.width) || 0,
    });
  }
  if (!glyphs.length) return [];
  const out = [];
  for (const column of splitColumns(glyphs)) out.push(...assembleLines(column));
  return out;
}

/**
 * 双栏页拆成两栏。
 *
 * 判据是「有一条竖直的空带，没有任何碎片压在带子上」。
 * 不能用「相邻起点之间的大缝」——真书的栏间距只有十几磅，比行首缩进的缝还窄。
 * 单栏页的长行一定压过中线，所以这条判据不会把单栏页错拆。
 */
function splitColumns(glyphs) {
  if (glyphs.length < 6) return [glyphs];
  const spans = glyphs
    .map((g) => [g.x, g.x + Math.max(g.w, 4)])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1] + 8) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  if (merged.length < 2) return [glyphs];
  const minX = merged[0][0];
  const maxX = merged[merged.length - 1][1];
  const width = maxX - minX;
  if (width < 200) return [glyphs];

  let best = null;
  for (let i = 1; i < merged.length; i += 1) {
    const gapStart = merged[i - 1][1];
    const gapEnd = merged[i][0];
    const gap = gapEnd - gapStart;
    if (gap < 18) continue;
    const mid = (gapStart + gapEnd) / 2;
    const ratio = (mid - minX) / width;
    if (ratio < 0.2 || ratio > 0.8) continue;
    if (!best || gap > best.gap) best = { gap: gap, mid: mid };
  }
  if (!best) return [glyphs];

  const left = glyphs.filter((g) => g.x < best.mid);
  const right = glyphs.filter((g) => g.x >= best.mid);
  if (left.length / glyphs.length < 0.25 || right.length / glyphs.length < 0.25) return [glyphs];
  if (right.every((g) => /^[\dOolI\s.,:;'’-]+$/.test(g.str))) return [glyphs];
  return [left, right];
}

/** 一栏之内：按 y 聚类成行，行内按 x 排序，按缝隙决定要不要补空格。 */
function assembleLines(glyphs) {
  const sorted = glyphs.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const clusters = [];
  for (const glyph of sorted) {
    const line = clusters[clusters.length - 1];
    if (line && Math.abs(line.y - glyph.y) <= 3) {
      line.items.push(glyph);
      continue;
    }
    clusters.push({ y: glyph.y, items: [glyph] });
  }
  return clusters.map((line) => {
    line.items.sort((a, b) => a.x - b.x);
    let text = '';
    let prev = null;
    for (const glyph of line.items) {
      if (prev) {
        const gap = glyph.x - (prev.x + prev.w);
        if (gap > 6) text += ' ';
        else if (gap > 1.2 && (isAscii(prev.str) || isAscii(glyph.str))) text += ' ';
      }
      text += glyph.str;
      prev = glyph;
    }
    return text.replace(/\s+/g, ' ').trim();
  });
}

function isAscii(text) {
  const s = String(text || '');
  if (!s) return false;
  return /[\x00-\xff]/.test(s.charAt(0)) || /[\x00-\xff]/.test(s.charAt(s.length - 1));
}

/**
 * 一页的 textContent → 纯文本（保留行）。
 * @deprecated 保留导出只为兼容旧调用；新代码用 linesOfItems。
 */
export function textOfItems(items) {
  return linesOfItems(items).join('\n');
}

/**
 * 读一份 PDF 的逐页文本与元信息。
 * @param {Buffer|Uint8Array} bytes
 * @param {{onProgress?:(done:number,total:number)=>void, maxPages?:number}} [options]
 * @returns {Promise<{pages:{page:number,text:string}[], numPages:number, title:string, author:string}>}
 */
export async function extractPages(bytes, options) {
  const opts = options || {};
  const data = new Uint8Array(bytes);
  let loading;
  let doc;
  try {
    loading = getDocument({
      data: data,
      cMapUrl: assetUrl('cmaps'),
      cMapPacked: true,
      standardFontDataUrl: assetUrl('standard_fonts'),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });
    doc = await loading.promise;
  } catch (err) {
    throw mapError(err);
  }

  const pages = [];
  let meta = {};
  try {
    try {
      const info = await doc.getMetadata();
      const raw = (info && info.info) || {};
      meta = { title: String(raw.Title || '').trim(), author: String(raw.Author || '').trim() };
    } catch {
      meta = { title: '', author: '' };
    }
    const total = doc.numPages;
    const limit = opts.maxPages && opts.maxPages > 0 ? Math.min(opts.maxPages, total) : total;
    for (let i = 1; i <= limit; i += 1) {
      const page = await doc.getPage(i);
      let text = '';
      try {
        const content = await page.getTextContent();
        text = linesOfItems(content && content.items).join('\n');
      } finally {
        try {
          page.cleanup();
        } catch {
          /* 清理失败不影响已读到的文本 */
        }
      }
      pages.push({ page: i, text: text });
      if (typeof opts.onProgress === 'function') opts.onProgress(i, total);
    }
    return { pages: pages, numPages: total, title: meta.title, author: meta.author };
  } catch (err) {
    throw mapError(err);
  } finally {
    // v6 的 PDFDocumentProxy 没有 destroy，要关的是 loading task
    try {
      if (loading && typeof loading.destroy === 'function') await loading.destroy();
      else if (doc && typeof doc.destroy === 'function') await doc.destroy();
    } catch {
      /* 关文档失败不影响结果 */
    }
  }
}

/** 全书的可提取字数，用来判「有没有文字层」。 */
export function totalChars(pages) {
  return (Array.isArray(pages) ? pages : []).reduce((sum, p) => sum + String((p && p.text) || '').length, 0);
}

/**
 * 从文件名与正文猜书名：文件名像乱码/编号时，用首页第一段像标题的行。
 */
export function guessTitle(fileName, pages, metaTitle) {
  if (metaTitle && metaTitle.length >= 2) return metaTitle;
  const base = String(fileName || '').replace(/\.pdf$/i, '').trim();
  const fromName = base.replace(/^\d+[-_\s]*/, '').replace(/[_\s]+/g, ' ').trim();
  if (fromName && !/^[\d\s-]+$/.test(fromName) && fromName.length >= 2) return fromName;
  const first = pages && pages[0] ? String(pages[0].text || '') : '';
  for (const line of first.split('\n')) {
    const t = line.trim();
    if (t.length >= 2 && t.length <= 40) return t;
  }
  return '未命名';
}
