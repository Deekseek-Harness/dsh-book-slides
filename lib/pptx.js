/**
 * 精讲台 · PPTX 生成（v1.5）
 *
 * 只做「数据 → OOXML → ZIP」这一件事，不认识 HTTP、不读 slides.json。
 * 母版 / 版式 / 主题 / notesMaster 这些容易写错的骨架来自 assets/pptx-template.pptx
 * （PowerPoint 生成的空白 16:9 模板）；这里只生成会变的部分：
 *   ppt/presentation.xml、每页 slide、每页 notes、媒体与关系。
 *
 * 设计约束（附录 O）：
 *   - 16:9，13.333×7.5 in；原生文本框，不整页转图；
 *   - 每页一个音频对象（只有真实存在且通过 WAV 头校验的文件才嵌）；
 *   - 每页备注 = audio_script 原文；
 *   - 只读、流式写、WAV/PNG 用 store，不整包进内存。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';
import yauzl from 'yauzl';
import { ZipWriter } from './pkgzip.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, '..', 'assets');
export const TEMPLATE_PATH = path.join(ASSETS, 'pptx-template.pptx');
export const AUDIO_ICON_PATH = path.join(ASSETS, 'audio-icon.png');
export const AUDIO_ICON_NAME = 'ppt/media/audio-icon.png';

const EMU = 914400;
const SLIDE_W = 13.333;
const SLIDE_H = 7.5;
const MARGIN = 0.55;
const FONT = '宋体';
const FONT_PANOSE = '02010600030101010101';
const COLOR_TEXT = '241F1A';
const COLOR_MUTED = '6F5A43';
const COLOR_KICKER = '9A6B3F';
const COLOR_CITE = '8A7355';
const COLOR_FOOT = 'B3A28A';
const COLOR_RULE = 'B23A2E';
const BG = 'FBF8F1';

/* ------------------------------ XML 小工具 ------------------------------ */

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_PREFIX = 'application/vnd.openxmlformats-officedocument';
const REL_PREFIX = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** 转义文本：XML 五字符 + 去掉控制字符；换行由调用方拆段。 */
export function xmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function emu(inches) {
  return Math.round(Number(inches) * EMU);
}

function attr(name, value) {
  return value == null || value === '' ? '' : ' ' + name + '="' + xmlEscape(value) + '"';
}

/** 按换行拆段；空文本返回空数组。 */
function paragraphsOf(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .split('\n');
}

function runPr(size, opts) {
  const o = opts || {};
  return (
    '<a:rPr lang="zh-CN" altLang="en-US" sz="' +
    Math.round(Number(size) * 100) +
    '"' +
    (o.bold ? ' b="1"' : '') +
    (o.spc ? ' spc="' + Math.round(Number(o.spc) * 100) + '"' : '') +
    ' dirty="0">' +
    '<a:solidFill><a:srgbClr val="' + (o.color || COLOR_TEXT) + '"/></a:solidFill>' +
    '<a:latin typeface="' + FONT + '" panose="' + FONT_PANOSE + '" pitchFamily="2" charset="-122"/>' +
    '<a:ea typeface="' + FONT + '" panose="' + FONT_PANOSE + '" pitchFamily="2" charset="-122"/>' +
    '<a:cs typeface="' + FONT + '"/>' +
    '</a:rPr>'
  );
}

function endPr(size, opts) {
  const o = opts || {};
  return (
    '<a:endParaRPr lang="zh-CN" altLang="en-US" sz="' +
    Math.round(Number(size) * 100) +
    '"' +
    (o.bold ? ' b="1"' : '') +
    ' dirty="0"><a:solidFill><a:srgbClr val="' + (o.color || COLOR_TEXT) + '"/></a:solidFill>' +
    '<a:latin typeface="' + FONT + '" panose="' + FONT_PANOSE + '" pitchFamily="2" charset="-122"/>' +
    '<a:ea typeface="' + FONT + '" panose="' + FONT_PANOSE + '" pitchFamily="2" charset="-122"/>' +
    '</a:endParaRPr>'
  );
}

function para(text, size, opts) {
  const o = opts || {};
  const bulletAttrs = o.bullet ? ' marL="285750" indent="-285750"' : '';
  const pPr =
    '<a:pPr' +
    bulletAttrs +
    attr('algn', o.align) +
    '>' +
    (o.lineSpacing ? '<a:lnSpc><a:spcPct val="' + Math.round(Number(o.lineSpacing) * 100000) + '"/></a:lnSpc>' : '') +
    (o.spaceAfter ? '<a:spcAft><a:spcPts val="' + Math.round(Number(o.spaceAfter) * 100) + '"/></a:spcAft>' : '') +
    (o.bullet
      ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>'
      : '<a:buNone/>') +
    '</a:pPr>';
  const content = String(text || '');
  const body = content
    ? '<a:r>' + runPr(size, o) + '<a:t>' + xmlEscape(content) + '</a:t></a:r>'
    : '';
  return '<a:p>' + pPr + body + endPr(size, o) + '</a:p>';
}

function textShape(options) {
  const o = options || {};
  const id = o.id;
  const name = o.name || 'TextBox';
  const x = emu(o.x);
  const y = emu(o.y);
  const cx = emu(o.w);
  const cy = emu(o.h);
  const bodyPr =
    '<a:bodyPr vert="horz" wrap="square" rtlCol="0" lIns="0" tIns="0" rIns="0" bIns="0"' +
    attr('anchor', o.anchor || 't') +
    '><a:spAutoFit/></a:bodyPr>';
  const paragraphs = (o.paragraphs || []).join('');
  return (
    '<p:sp>' +
    '<p:nvSpPr><p:cNvPr' + attr('id', id) + attr('name', name) + '/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>' +
    '<p:txBody>' + bodyPr + '<a:lstStyle/>' + paragraphs + '</p:txBody>' +
    '</p:sp>'
  );
}

function ruleShape(id, x, y, w, h) {
  return (
    '<p:sp>' +
    '<p:nvSpPr><p:cNvPr' + attr('id', id) + ' name="Rule"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + emu(x) + '" y="' + emu(y) + '"/><a:ext cx="' + emu(w) + '" cy="' + emu(h) + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    '<a:solidFill><a:srgbClr val="' + COLOR_RULE + '"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>' +
    '</p:sp>'
  );
}

function pictureShape(options) {
  const o = options || {};
  const id = o.id;
  const name = o.name || 'Picture';
  const x = emu(o.x);
  const y = emu(o.y);
  const cx = emu(o.w);
  const cy = emu(o.h);
  const crop = o.crop
    ? '<a:srcRect' +
      (o.crop.l ? ' l="' + o.crop.l + '"' : '') +
      (o.crop.t ? ' t="' + o.crop.t + '"' : '') +
      (o.crop.r ? ' r="' + o.crop.r + '"' : '') +
      (o.crop.b ? ' b="' + o.crop.b + '"' : '') +
      '/>'
    : '';
  const hlink = o.audioRid
    ? '<a:hlinkClick r:id="" action="ppaction://media"/>'
    : '';
  const audio = o.audioRid
    ? '<p:nvPr><a:audioFile r:link="' + o.audioRid + '"/>' +
      (o.mediaRid
        ? '<p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}">' +
          '<p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" r:embed="' + o.mediaRid + '"/>' +
          '</p:ext></p:extLst>'
        : '') +
      '</p:nvPr>'
    : '<p:nvPr/>';
  return (
    '<p:pic>' +
    '<p:nvPicPr><p:cNvPr' + attr('id', id) + attr('name', name) + '>' + hlink + '</p:cNvPr>' +
    '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>' + audio + '</p:nvPicPr>' +
    '<p:blipFill><a:blip r:embed="' + o.rid + '"/>' + crop + '<a:stretch><a:fillRect/></a:stretch></p:blipFill>' +
    '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:ln><a:noFill/></a:ln></p:spPr>' +
    '</p:pic>'
  );
}

function groupShape() {
  return (
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
    '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
  );
}

/** 图片按 cover 裁切：把源图多余的边裁掉，而不是拉伸。 */
export function coverCrop(imageW, imageH, boxW, boxH) {
  const iw = Number(imageW) > 0 ? Number(imageW) : 1;
  const ih = Number(imageH) > 0 ? Number(imageH) : 1;
  const bw = Number(boxW) > 0 ? Number(boxW) : 1;
  const bh = Number(boxH) > 0 ? Number(boxH) : 1;
  const imageAspect = iw / ih;
  const boxAspect = bw / bh;
  if (Math.abs(imageAspect - boxAspect) < 0.001) return null;
  if (imageAspect > boxAspect) {
    const crop = Math.max(0, (1 - boxAspect / imageAspect) / 2);
    const v = Math.round(crop * 100000);
    return v > 0 ? { l: v, r: v } : null;
  }
  const crop = Math.max(0, (1 - imageAspect / boxAspect) / 2);
  const v = Math.round(crop * 100000);
  return v > 0 ? { t: v, b: v } : null;
}

/* ------------------------------ 版式 ------------------------------ */

function footerShape(slideIndex) {
  return textShape({
    id: '90',
    name: '页码',
    x: SLIDE_W - MARGIN - 1.7,
    y: 7.05,
    w: 1.7,
    h: 0.3,
    paragraphs: [para('第 ' + slideIndex + ' 页', 10, { color: COLOR_FOOT, align: 'r' })],
  });
}

function audioPicture(slide, id) {
  if (!slide.audio) return '';
  return pictureShape({
    id: id,
    name: '音频 ' + slide.index,
    x: SLIDE_W - MARGIN - 0.36,
    y: 6.62,
    w: 0.36,
    h: 0.36,
    rid: 'rId5',
    audioRid: 'rId3',
    mediaRid: 'rId4',
  });
}

function coverShapes(slide) {
  const parts = [];
  let id = 2;
  parts.push(
    textShape({
      id: String(id++),
      name: '书名',
      x: MARGIN,
      y: 0.45,
      w: SLIDE_W - MARGIN * 2,
      h: 0.32,
      paragraphs: [para('《' + (slide.bookTitle || '') + '》', 12, { color: COLOR_KICKER })],
    }),
  );
  parts.push(
    textShape({
      id: String(id++),
      name: 'Kicker',
      x: MARGIN,
      y: 2.0,
      w: 6,
      h: 0.34,
      paragraphs: [para('精 讲', 12, { color: COLOR_KICKER, spc: 3 })],
    }),
  );
  parts.push(
    textShape({
      id: String(id++),
      name: '标题',
      x: MARGIN,
      y: 2.4,
      w: SLIDE_W - MARGIN * 2,
      h: 1.7,
      paragraphs: [para(slide.title || '精讲', 40, { bold: true, color: COLOR_TEXT, lineSpacing: 1.15 })],
    }),
  );
  if (slide.subtitle) {
    parts.push(
      textShape({
        id: String(id++),
        name: '副标题',
        x: MARGIN,
        y: 4.35,
        w: SLIDE_W - MARGIN * 2,
        h: 0.8,
        paragraphs: [para(slide.subtitle, 18, { color: COLOR_MUTED, lineSpacing: 1.3 })],
      }),
    );
  }
  parts.push(ruleShape(String(id++), MARGIN, 5.35, 1.2, 0.035));
  return { xml: parts.join(''), nextId: id };
}

function contentShapes(slide) {
  const parts = [];
  let id = 2;
  const hasImage = !!slide.image;
  const bodyW = hasImage ? 7.75 : SLIDE_W - MARGIN * 2;
  parts.push(
    textShape({
      id: String(id++),
      name: '标题',
      x: MARGIN,
      y: 0.45,
      w: SLIDE_W - MARGIN * 2,
      h: 0.9,
      paragraphs: [para(slide.title || '', 32, { bold: true, color: COLOR_TEXT })],
    }),
  );
  const bullets = Array.isArray(slide.bullets) ? slide.bullets.filter(Boolean).slice(0, 5) : [];
  const paragraphs = bullets.length
    ? bullets.map((bullet) =>
        para(bullet, 20, { color: COLOR_TEXT, bullet: true, lineSpacing: 1.35, spaceAfter: 8 }),
      )
    : [para('', 20, { color: COLOR_TEXT })];
  parts.push(
    textShape({
      id: String(id++),
      name: '正文',
      x: MARGIN,
      y: 1.55,
      w: bodyW,
      h: 4.9,
      paragraphs: paragraphs,
    }),
  );
  if (hasImage) {
    parts.push(
      pictureShape({
        id: String(id++),
        name: '配图',
        x: 8.6,
        y: 1.55,
        w: 4.18,
        h: 4.6,
        rid: 'rId6',
        crop: coverCrop(slide.image.width, slide.image.height, 4.18, 4.6),
      }),
    );
  }
  return { xml: parts.join(''), nextId: id };
}

function quoteShapes(slide) {
  const parts = [];
  let id = 2;
  parts.push(
    textShape({
      id: String(id++),
      name: 'Kicker',
      x: MARGIN,
      y: 1.35,
      w: SLIDE_W - MARGIN * 2,
      h: 0.34,
      paragraphs: [para('原 文 摘 引', 12, { color: COLOR_KICKER, align: 'ctr', spc: 3 })],
    }),
  );
  parts.push(
    textShape({
      id: String(id++),
      name: '引文',
      x: 0.9,
      y: 1.9,
      w: SLIDE_W - 1.8,
      h: 2.9,
      paragraphs: [para(slide.quoteText || '', 32, { color: COLOR_TEXT, align: 'ctr', lineSpacing: 1.35 })],
    }),
  );
  parts.push(
    textShape({
      id: String(id++),
      name: '出处',
      x: 0.9,
      y: 4.95,
      w: SLIDE_W - 1.8,
      h: 0.45,
      paragraphs: [para('—— ' + (slide.quoteSource || '出处未知'), 16, { color: COLOR_CITE, align: 'ctr' })],
    }),
  );
  return { xml: parts.join(''), nextId: id };
}

/* ------------------------------ 幻灯片 / 备注 ------------------------------ */

/**
 * 逐页自动播放：进入页面就 playFrom(0)。
 *
 * 结构以 WPS 12.1 自己生成的「音频自动播放」页为基准（nodeType=withEffect +
 * p:audio/cMediaNode），同时兼容 PowerPoint 16：PowerPoint 也识别为 mediacall。
 * 不加 p:transition，保持手动翻页；showWhenStopped=1 让喇叭图标播完仍可见，可点击重播。
 */
export function buildTimingXml(shapeId, durationMs) {
  const spid = xmlEscape(String(shapeId));
  const dur = Math.max(1000, Math.round(Number(durationMs) || 0));
  return (
    '<p:timing><p:tnLst><p:par>' +
    '<p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>' +
    '<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>' +
    '<p:par><p:cTn id="3" fill="hold">' +
    '<p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst>' +
    '<p:childTnLst><p:par><p:cTn id="4" fill="hold">' +
    '<p:stCondLst><p:cond delay="0"/></p:stCondLst>' +
    '<p:childTnLst><p:par><p:cTn id="5" presetID="1" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="withEffect">' +
    '<p:childTnLst><p:cmd type="call" cmd="playFrom(0.0)"><p:cBhvr>' +
    '<p:cTn id="6" dur="' + dur + '" fill="hold"/>' +
    '<p:tgtEl><p:spTgt spid="' + spid + '"/></p:tgtEl>' +
    '</p:cBhvr></p:cmd></p:childTnLst>' +
    '</p:cTn></p:par></p:childTnLst>' +
    '</p:cTn></p:par></p:childTnLst>' +
    '</p:cTn></p:par></p:childTnLst>' +
    '</p:cTn>' +
    '<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>' +
    '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>' +
    '</p:seq>' +
    '<p:audio><p:cMediaNode vol="80000" showWhenStopped="1">' +
    '<p:cTn id="7" repeatCount="indefinite" fill="hold" display="0">' +
    '<p:stCondLst><p:cond delay="indefinite"/></p:stCondLst>' +
    '<p:endCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond>' +
    '<p:cond evt="onStopAudio" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:endCondLst>' +
    '</p:cTn><p:tgtEl><p:spTgt spid="' + spid + '"/></p:tgtEl></p:cMediaNode></p:audio>' +
    '</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
  );
}

/**
 * 生成一页 slide XML。
 * @param {object} slide deck.slides 里的一项
 */
export function buildSlideXml(slide) {
  const layout = String(slide.layout || 'content_text');
  let body;
  if (layout === 'cover') body = coverShapes(slide);
  else if (layout === 'quote') body = quoteShapes(slide);
  else body = contentShapes(slide);
  const audioId = slide.audio ? String(body.nextId++) : '';
  const audio = audioId ? audioPicture(slide, audioId) : '';
  const shapes = body.xml + audio + footerShape(slide.index);
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<p:sld xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '" xmlns:p="' + NS_P + '">' +
    '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="' + BG + '"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
    '<p:spTree>' + groupShape() + shapes + '</p:spTree></p:cSld>' +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
    (audioId ? buildTimingXml(audioId, slide.audio && slide.audio.durationMs) : '') +
    '</p:sld>'
  );
}

/** 备注页：只放幻灯片缩略占位 + 台词正文。 */
export function buildNotesXml(text) {
  const paragraphs = paragraphsOf(text).map((line) => para(line, 12, { color: COLOR_TEXT }));
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<p:notes xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '" xmlns:p="' + NS_P + '">' +
    '<p:cSld><p:spTree>' + groupShape() +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="幻灯片图像占位符"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="备注"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/>' + paragraphs.join('') + '</p:txBody></p:sp>' +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>'
  );
}

/* ------------------------------ 关系与包 ------------------------------ */

function rel(id, type, target) {
  const full = /^https?:\/\//i.test(type) ? type : REL_PREFIX + '/' + type;
  return '<Relationship Id="' + id + '" Type="' + full + '" Target="' + target + '"/>';
}

export function buildSlideRels(slide, index) {
  const items = [
    rel('rId1', 'slideLayout', '../slideLayouts/slideLayout7.xml'),
    rel('rId2', 'notesSlide', '../notesSlides/notesSlide' + index + '.xml'),
  ];
  if (slide.audio) {
    items.push(rel('rId3', 'audio', '../media/audio' + index + '.' + slide.audio.ext));
    items.push(
      rel(
        'rId4',
        'http://schemas.microsoft.com/office/2007/relationships/media',
        '../media/audio' + index + '.' + slide.audio.ext,
      ),
    );
    items.push(rel('rId5', 'image', '../media/audio-icon.png'));
  }
  if (slide.image) {
    items.push(rel('rId6', 'image', '../media/image' + index + '.png'));
  }
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="' + NS_REL + '">' + items.join('') + '</Relationships>';
}

export function buildNotesRels(index) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="' + NS_REL + '">' +
    rel('rId1', 'notesMaster', '../notesMasters/notesMaster1.xml') +
    rel('rId2', 'slide', '../slides/slide' + index + '.xml') +
    '</Relationships>'
  );
}

export function buildPresentationXml(slideCount) {
  const ids = [];
  for (let i = 1; i <= slideCount; i += 1) {
    ids.push('<p:sldId id="' + (255 + i) + '" r:id="rId' + (6 + i) + '"/>');
  }
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<p:presentation xmlns:a="' + NS_A + '" xmlns:r="' + NS_R + '" xmlns:p="' + NS_P + '" saveSubsetFonts="1">' +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>' +
    '<p:sldIdLst>' + ids.join('') + '</p:sldIdLst>' +
    '<p:sldSz cx="12192000" cy="6858000"/>' +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    '<p:defaultTextStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr></p:defaultTextStyle>' +
    '</p:presentation>'
  );
}

export function buildPresentationRels(slideCount) {
  const items = [
    rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'),
    rel('rId2', 'notesMaster', 'notesMasters/notesMaster1.xml'),
    rel('rId3', 'presProps', 'presProps.xml'),
    rel('rId4', 'viewProps', 'viewProps.xml'),
    rel('rId5', 'theme', 'theme/theme1.xml'),
    rel('rId6', 'tableStyles', 'tableStyles.xml'),
  ];
  for (let i = 1; i <= slideCount; i += 1) {
    items.push(rel('rId' + (6 + i), 'slide', 'slides/slide' + i + '.xml'));
  }
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="' + NS_REL + '">' + items.join('') + '</Relationships>';
}

export function buildContentTypes(slideCount) {
  const overrides = [];
  const add = (part, type) => overrides.push('<Override PartName="' + part + '" ContentType="' + CT_PREFIX + '.' + type + '"/>');
  add('/ppt/presentation.xml', 'presentationml.presentation.main+xml');
  add('/ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster+xml');
  for (let i = 1; i <= 11; i += 1) add('/ppt/slideLayouts/slideLayout' + i + '.xml', 'presentationml.slideLayout+xml');
  add('/ppt/notesMasters/notesMaster1.xml', 'presentationml.notesMaster+xml');
  add('/ppt/theme/theme1.xml', 'theme+xml');
  add('/ppt/theme/theme2.xml', 'theme+xml');
  add('/ppt/presProps.xml', 'presentationml.presProps+xml');
  add('/ppt/viewProps.xml', 'presentationml.viewProps+xml');
  add('/ppt/tableStyles.xml', 'presentationml.tableStyles+xml');
  for (let i = 1; i <= slideCount; i += 1) {
    add('/ppt/slides/slide' + i + '.xml', 'presentationml.slide+xml');
    add('/ppt/notesSlides/notesSlide' + i + '.xml', 'presentationml.notesSlide+xml');
  }
  add('/docProps/core.xml', 'package.core-properties+xml');
  add('/docProps/app.xml', 'extended-properties+xml');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="wav" ContentType="audio/wav"/>' +
    '<Default Extension="mp3" ContentType="audio/mpeg"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    overrides.join('') +
    '</Types>'
  );
}

export function buildRootRels() {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="' + NS_REL + '">' +
    '<Relationship Id="rId1" Type="' + REL_PREFIX + '/officeDocument" Target="ppt/presentation.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="' + REL_PREFIX + '/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>'
  );
}

export function buildCoreXml(deck) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<dc:title>' + xmlEscape(deck.title || '精讲') + '</dc:title>' +
    '<dc:creator>精讲台</dc:creator><cp:lastModifiedBy>精讲台</cp:lastModifiedBy><cp:revision>1</cp:revision>' +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>' +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>' +
    '</cp:coreProperties>'
  );
}

export function buildAppXml(slideCount) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>Microsoft Office PowerPoint</Application><PresentationFormat>宽屏</PresentationFormat>' +
    '<Slides>' + slideCount + '</Slides><Notes>' + slideCount + '</Notes>' +
    '<HiddenSlides>0</HiddenSlides><MMClips>0</MMClips><ScaleCrop>false</ScaleCrop>' +
    '<Company/><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>' +
    '<HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>'
  );
}

/* ------------------------------ 模板骨架 ------------------------------ */

/** 模板里只搬这些「不随内容变」的骨架；slides/notes/docProps 一律自己生成。 */
export function isShellPart(name) {
  return (
    name.startsWith('ppt/slideMasters/') ||
    name.startsWith('ppt/slideLayouts/') ||
    name.startsWith('ppt/theme/') ||
    name.startsWith('ppt/notesMasters/') ||
    name === 'ppt/presProps.xml' ||
    name === 'ppt/viewProps.xml' ||
    name === 'ppt/tableStyles.xml'
  );
}

function readZipEntries(buffer, accept) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) {
        reject(err);
        return;
      }
      const map = new Map();
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      zip.on('error', fail);
      zip.on('entry', (entry) => {
        if (settled) return;
        if (!accept(entry.fileName) || /\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (openErr, stream) => {
          if (openErr) {
            fail(openErr);
            return;
          }
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            map.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
          stream.on('error', fail);
        });
      });
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(map);
      });
      zip.readEntry();
    });
  });
}

let shellCache = null;

export async function loadShellParts() {
  if (shellCache) return shellCache;
  const buffer = await fs.promises.readFile(TEMPLATE_PATH);
  const map = await readZipEntries(buffer, isShellPart);
  shellCache = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  return shellCache;
}

/* ------------------------------ 写 PPTX ------------------------------ */

/**
 * 把 deck 写成 pptx 流。
 * @param {import('node:stream').Writable} output
 * @param {{title:string, slides:object[]}} deck
 */
export async function writePptx(output, deck) {
  const slides = Array.isArray(deck && deck.slides) ? deck.slides : [];
  if (!slides.length) throw new Error('PPTX 没有页面');
  const shell = await loadShellParts();
  const zip = new ZipWriter();
  for (const [name, buffer] of shell) zip.addBuffer(buffer, name);

  zip.addBuffer(Buffer.from(buildContentTypes(slides.length), 'utf8'), '[Content_Types].xml');
  zip.addBuffer(Buffer.from(buildRootRels(), 'utf8'), '_rels/.rels');
  zip.addBuffer(Buffer.from(buildCoreXml(deck), 'utf8'), 'docProps/core.xml');
  zip.addBuffer(Buffer.from(buildAppXml(slides.length), 'utf8'), 'docProps/app.xml');
  zip.addBuffer(Buffer.from(buildPresentationXml(slides.length), 'utf8'), 'ppt/presentation.xml');
  zip.addBuffer(Buffer.from(buildPresentationRels(slides.length), 'utf8'), 'ppt/_rels/presentation.xml.rels');

  for (let i = 0; i < slides.length; i += 1) {
    const index = i + 1;
    const slide = Object.assign({}, slides[i], { index: index });
    zip.addBuffer(Buffer.from(buildSlideXml(slide), 'utf8'), 'ppt/slides/slide' + index + '.xml');
    zip.addBuffer(Buffer.from(buildSlideRels(slide, index), 'utf8'), 'ppt/slides/_rels/slide' + index + '.xml.rels');
    zip.addBuffer(Buffer.from(buildNotesXml(slide.notes || ''), 'utf8'), 'ppt/notesSlides/notesSlide' + index + '.xml');
    zip.addBuffer(Buffer.from(buildNotesRels(index), 'utf8'), 'ppt/notesSlides/_rels/notesSlide' + index + '.xml.rels');
    if (slide.audio) zip.addFile(slide.audio.path, 'ppt/media/audio' + index + '.' + slide.audio.ext);
    if (slide.image) zip.addFile(slide.image.path, 'ppt/media/image' + index + '.png');
  }
  zip.addFile(AUDIO_ICON_PATH, AUDIO_ICON_NAME);
  const stream = zip.end();
  await pipeline(stream, output);
}

/** 测试用：把 PPTX 收成 Buffer。 */
export async function buildPptxBuffer(deck) {
  const chunks = [];
  const sink = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  await writePptx(sink, deck);
  return Buffer.concat(chunks);
}
