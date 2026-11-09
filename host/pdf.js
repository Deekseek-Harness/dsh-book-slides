/** 2.0 PDF 辅助：只做 M1 需要的目录（书签）读取。 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));

function cMapUrl() {
  return path.join(PDFJS_DIR, 'cmaps').split(path.sep).join('/') + '/';
}

function standardFontDataUrl() {
  return path.join(PDFJS_DIR, 'standard_fonts').split(path.sep).join('/') + '/';
}

export async function extractOutline(buffer) {
  const doc = await getDocument({
    data: new Uint8Array(buffer),
    cMapUrl: cMapUrl(),
    cMapPacked: true,
    standardFontDataUrl: standardFontDataUrl(),
  }).promise;
  try {
    const outline = await doc.getOutline();
    if (!Array.isArray(outline) || !outline.length) return [];
    const out = [];
    const walk = async (items, depth) => {
      for (const item of items || []) {
        let page = 0;
        try {
          let dest = item.dest;
          if (typeof dest === 'string') dest = await doc.getDestination(dest);
          if (Array.isArray(dest) && dest.length) {
            const ref = dest[0];
            if (ref && typeof ref === 'object') {
              const index = await doc.getPageIndex(ref);
              page = Number(index) + 1;
            } else if (Number.isFinite(Number(ref))) {
              page = Number(ref) + 1;
            }
          }
        } catch {
          page = 0;
        }
        const title = String(item.title || '').trim();
        if (title) out.push({ title, page, depth });
        if (item.items && item.items.length) await walk(item.items, depth + 1);
      }
    };
    await walk(outline, 0);
    return out;
  } finally {
    try {
      await doc.destroy();
    } catch {
      /* ignore */
    }
  }
}
