/**
 * 测试用的最小 PDF 生成器：带文字层、不嵌字体、不用压缩。
 * 只为验证「pdfjs 能读出字」这条路，不代表真实排版。
 *
 * 可选 outline：形如 `[{ title, page, children?: [...] }]`，用于分章的书签路径。
 */

function escapePdfText(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * @param {string[][]} pages 每页若干行
 * @param {{outline?: {title:string,page:number,children?:any[]}[]}} [options]
 * @returns {Buffer}
 */
export function makePdf(pages, options = {}) {
  const objects = [];
  const pageObjNumbers = [];
  const totalPages = pages.length;
  const firstPageObj = 3;
  for (let i = 0; i < totalPages; i += 1) pageObjNumbers.push(firstPageObj + i * 2);
  const fontObjNumber = firstPageObj + totalPages * 2;

  objects[2] =
    '<< /Type /Pages /Kids [' + pageObjNumbers.map((n) => n + ' 0 R').join(' ') + '] /Count ' + totalPages + ' >>';

  for (let i = 0; i < totalPages; i += 1) {
    const pageNo = pageObjNumbers[i];
    const contentNo = pageNo + 1;
    const lines = pages[i] || [];
    let stream = 'BT /F1 12 Tf 72 720 Td\n';
    lines.forEach((line, index) => {
      if (index > 0) stream += '0 -14 Td\n';
      stream += '(' + escapePdfText(line) + ') Tj\n';
    });
    stream += 'ET';
    objects[pageNo] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ' +
      fontObjNumber +
      ' 0 R >> >> /Contents ' +
      contentNo +
      ' 0 R >>';
    objects[contentNo] = '<< /Length ' + Buffer.byteLength(stream, 'latin1') + ' >>\nstream\n' + stream + '\nendstream';
  }
  objects[fontObjNumber] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

  let catalog = '<< /Type /Catalog /Pages 2 0 R >>';
  const outline = Array.isArray(options.outline) ? options.outline : [];
  if (outline.length) {
    const all = [];
    const walk = (items, parent) => {
      const nodes = (items || [])
        .map((item) => {
          const node = {
            title: String((item && item.title) || ''),
            page: Number(item && item.page) || 0,
            parent,
            children: [],
          };
          all.push(node);
          return node;
        });
      for (let i = 0; i < nodes.length; i += 1) {
        nodes[i].children = walk((items[i] && items[i].children) || [], nodes[i]);
      }
      return nodes;
    };
    const roots = walk(outline, null);

    let next = fontObjNumber + 1;
    const rootObj = next;
    next += 1;
    for (const node of all) {
      node.obj = next;
      next += 1;
    }

    const pageRef = (page) => pageObjNumbers[page - 1] + ' 0 R';

    const itemString = (node, siblings, index) => {
      const parentObj = node.parent ? node.parent.obj : rootObj;
      const parts = ['/Title (' + escapePdfText(node.title) + ')', '/Parent ' + parentObj + ' 0 R'];
      if (node.page >= 1 && node.page <= totalPages) {
        parts.push('/Dest [' + pageRef(node.page) + ' /Fit]');
      }
      if (node.children.length) {
        parts.push('/First ' + node.children[0].obj + ' 0 R');
        parts.push('/Last ' + node.children[node.children.length - 1].obj + ' 0 R');
        parts.push('/Count ' + node.children.length);
      }
      if (index > 0) parts.push('/Prev ' + siblings[index - 1].obj + ' 0 R');
      if (index + 1 < siblings.length) parts.push('/Next ' + siblings[index + 1].obj + ' 0 R');
      return '<< ' + parts.join(' ') + ' >>';
    };

    const rootParts = ['/Type /Outlines'];
    if (roots.length) {
      rootParts.push('/First ' + roots[0].obj + ' 0 R');
      rootParts.push('/Last ' + roots[roots.length - 1].obj + ' 0 R');
      rootParts.push('/Count ' + roots.length);
    }
    objects[rootObj] = '<< ' + rootParts.join(' ') + ' >>';
    for (const node of all) {
      const siblings = node.parent ? node.parent.children : roots;
      objects[node.obj] = itemString(node, siblings, siblings.indexOf(node));
    }
    catalog = '<< /Type /Catalog /Pages 2 0 R /Outlines ' + rootObj + ' 0 R >>';
  }
  objects[1] = catalog;

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objects.length; i += 1) {
    if (objects[i] === undefined) objects[i] = '<< >>';
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += i + ' 0 obj\n' + objects[i] + '\nendobj\n';
  }
  const xrefOffset = Buffer.byteLength(out, 'latin1');
  const count = objects.length;
  out += 'xref\n0 ' + count + '\n';
  out += '0000000000 65535 f \n';
  for (let i = 1; i < count; i += 1) {
    out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  }
  out += 'trailer\n<< /Size ' + count + ' /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

/** 带 PDF 书签的夹具；outline 项可带 children 形成层级。 */
export function makePdfWithOutline(pages, outline) {
  return makePdf(pages, { outline });
}

/** 一份三章、每章一页的样书。 */
export function sampleBookPdf() {
  return makePdf([
    ['Sample Book', 'Chapter 1 Start', 'alpha '.repeat(30)],
    ['Chapter 2 Turn', 'beta '.repeat(30)],
    ['Chapter 3 End', 'gamma '.repeat(30)],
  ]);
}
