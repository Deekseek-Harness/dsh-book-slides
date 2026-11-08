/**
 * 精讲台 · 书封
 *
 * 不渲染 PDF 首页（要装 canvas 原生模块，还会拖慢导入），改用排版生成的书封：
 * 书名 + 作者 + 章数，配色由书名哈希决定 —— 同一本书永远同一个封面。
 */
import crypto from 'node:crypto';

/** SVG 里必须转义的五个字符。 */
export function escapeXml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 书名 → 稳定色相（0–359）。 */
export function hueOf(seed) {
  const digest = crypto.createHash('sha1').update(String(seed || '')).digest();
  return Math.round((digest[0] / 255) * 360);
}

/**
 * 色相归一到 0–359；非法值返回 null。
 * 改名同步封面标题时传入原色相，避免整张封面换色（FR-21.1）。
 */
export function normalizeHue(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return ((Math.round(num) % 360) + 360) % 360;
}

/** 按字数切行：中文 1 字算 1，英文半角算 0.55。 */
export function wrapTitle(title, perLine, maxLines) {
  const text = String(title || '未命名').replace(/\s+/g, ' ').trim();
  const lines = [];
  let current = '';
  let width = 0;
  for (const ch of Array.from(text)) {
    const w = /[\x00-\xff]/.test(ch) ? 0.55 : 1;
    if (width + w > perLine && current) {
      lines.push(current);
      current = '';
      width = 0;
      if (lines.length >= maxLines) break;
    }
    current += ch;
    width += w;
  }
  if (current && lines.length < maxLines) lines.push(current);
  const used = lines.join('');
  if (used.length < text.length && lines.length) {
    const last = Array.from(lines[lines.length - 1]);
    if (last.length > 1) last[last.length - 1] = '…';
    lines[lines.length - 1] = last.join('');
  }
  return lines.length ? lines : ['未命名'];
}

/**
 * 生成 300×420 的书封 SVG。
 * @param {{title:string, author?:string, chapters?:number, chars?:number, id?:string, hue?:number}} book
 */
export function coverSvg(book) {
  const title = String((book && book.title) || '未命名');
  const author = String((book && book.author) || '').trim();
  const chapterCount = Number((book && book.chapters) || 0);
  const requestedHue = normalizeHue(book && book.hue);
  const hue = requestedHue === null ? hueOf(title) : requestedHue;
  const hue2 = (hue + 36) % 360;
  const lines = wrapTitle(title, 6, 4);
  const fontSize = lines.length >= 4 ? 26 : lines.length === 3 ? 29 : 32;
  const startY = 150 - (lines.length - 1) * (fontSize * 0.62);
  const titleSpans = lines
    .map((line, i) => `<text x="34" y="${Math.round(startY + i * fontSize * 1.24)}" font-size="${fontSize}">${escapeXml(line)}</text>`)
    .join('');
  const meta = chapterCount > 0 ? chapterCount + ' 章' : '尚未切章';
  const gradientId = 'g' + hue.toString(16);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420" viewBox="0 0 300 420" role="img" aria-label="${escapeXml(title)}">
  <defs>
    <linearGradient id="${gradientId}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue} 46% 34%)"/>
      <stop offset="100%" stop-color="hsl(${hue2} 52% 20%)"/>
    </linearGradient>
  </defs>
  <rect width="300" height="420" fill="url(#${gradientId})"/>
  <rect x="0" y="0" width="300" height="420" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="1"/>
  <rect x="18" y="18" width="264" height="384" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="1" rx="2"/>
  <rect x="34" y="74" width="42" height="4" rx="2" fill="rgba(255,255,255,.55)"/>
  <g fill="#fff" font-family="'Noto Serif SC','Songti SC',serif" font-weight="600" letter-spacing="1">${titleSpans}</g>
  <text x="34" y="318" fill="rgba(255,255,255,.72)" font-size="13" font-family="system-ui,sans-serif">${escapeXml(author || '')}</text>
  <text x="34" y="366" fill="rgba(255,255,255,.6)" font-size="12" font-family="system-ui,sans-serif">${escapeXml(meta)}</text>
  <text x="266" y="366" text-anchor="end" fill="rgba(255,255,255,.42)" font-size="11" font-family="ui-monospace,monospace">精讲</text>
</svg>`;
}
