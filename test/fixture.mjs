/**
 * 测试用的最小 PDF 生成器：带文字层、不嵌字体、不用压缩。
 * 只为验证「pdfjs 能读出字」这条路，不代表真实排版。
 */

function escapePdfText(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * @param {string[][]} pages 每页若干行
 * @returns {Buffer}
 */
export function makePdf(pages) {
  const objects = [];
  const pageObjNumbers = [];
  const totalPages = pages.length;
  const firstPageObj = 3;
  for (let i = 0; i < totalPages; i += 1) pageObjNumbers.push(firstPageObj + i * 2);
  const fontObjNumber = firstPageObj + totalPages * 2;

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] =
    '<< /Type /Pages /Kids [' + pageObjNumbers.map((n) => n + ' 0 R').join(' ') + '] /Count ' + totalPages + ' >>';

  for (let i = 0; i < totalPages; i += 1) {
    const pageNo = pageObjNumbers[i];
    const contentNo = pageNo + 1;
    const lines = pages[i] || [];
    let stream = 'BT /F1 12 Tf 72 720 Td 14 TL\n';
    lines.forEach((line) => {
      stream += '(' + escapePdfText(line) + ') Tj T*\n';
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

/** 一份三章、每章一页的样书。 */
export function sampleBookPdf() {
  return makePdf([
    ['Sample Book', 'Chapter 1 Start', 'alpha '.repeat(30)],
    ['Chapter 2 Turn', 'beta '.repeat(30)],
    ['Chapter 3 End', 'gamma '.repeat(30)],
  ]);
}
