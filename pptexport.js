/**
 * 精讲台 · PPT 导出计划（v1.5）
 *
 * 把「模块 → 可导出的 deck」这一步单独拆出来：
 *   - 资格判定（ready / busy / empty）；
 *   - 页级音频与配图解析（只认真实存在、能通过头校验的文件）；
 *   - 字节预估、缺页清单、文件名；
 *   - 生成给 pptx.js 的纯数据 deck（含绝对路径，只在本机内存里用）。
 *
 * 不写盘、不调 TTS / ComfyUI、不改 module.json / slides.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadModuleById, isActiveStatus } from './generate.js';

const AUDIO_RE = /^audio\/(\d{3})\.(wav|mp3)$/;
const IMAGE_RE = /^images\/(\d{3})\.png$/;
const MAX_BYTES = 150 * 1024 * 1024;

export class PptxError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'PptxError';
    this.code = code;
    this.hint = hint || '';
  }
}

/** 只判状态：生成中 → busy；非 ready/degraded → not ready。 */
export function assertPptxEligible(status) {
  const value = String(status || '');
  if (isActiveStatus(value)) {
    throw new PptxError('E_PPT_BUSY', '正在生成，完成后再导出', '');
  }
  if (value !== 'ready' && value !== 'ready_degraded') {
    throw new PptxError('E_PPT_NOT_READY', '这个精讲还没生成完，完成后才能导出', '');
  }
}

function inside(root, rel) {
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) return '';
  return abs;
}

function isRiffWav(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(12);
    const read = fs.readSync(fd, head, 0, 12, 0);
    if (read < 12) return false;
    return head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 忽略 */
      }
    }
  }
}

/** 读 WAV 头算时长；只读文件头，不整文件进内存。 */
function wavDurationMsPath(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4096);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    if (read < 44) return 0;
    const size = fs.fstatSync(fd).size;
    let offset = 12;
    let byteRate = 0;
    let dataSize = 0;
    let dataOffset = 0;
    while (offset + 8 <= read) {
      const id = head.toString('ascii', offset, offset + 4);
      const chunk = head.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === 'fmt ' && body + 16 <= read) byteRate = head.readUInt32LE(body + 8);
      if (id === 'data') {
        dataSize = chunk;
        dataOffset = body;
        break;
      }
      offset = body + chunk + (chunk % 2);
    }
    if (!byteRate) return 0;
    const available = dataOffset > 0 ? Math.max(0, size - dataOffset) : Math.max(0, size - 44);
    const bytes = dataSize > 0 ? Math.min(dataSize, available) : available;
    return Math.round((bytes / byteRate) * 1000);
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 忽略 */
      }
    }
  }
}

export function pngSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(24);
    const read = fs.readSync(fd, head, 0, 24, 0);
    if (read < 24) return null;
    if (head.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
    if (head.toString('ascii', 12, 16) !== 'IHDR') return null;
    const width = head.readUInt32BE(16);
    const height = head.readUInt32BE(20);
    if (!(width > 0 && height > 0)) return null;
    return { width: width, height: height };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 忽略 */
      }
    }
  }
}

/**
 * 解析一页的音频：先认 audio_file，再按 slide_index 探 .wav / .mp3。
 * 非 RIFF 的 .wav 直接跳过（PowerPoint 对扩展名敏感，宁可没声音也不给坏文件）。
 */
export function resolveAudio(moduleDir, slide) {
  const index = Math.round(Number(slide && slide.slide_index) || 0);
  if (!(index > 0)) return null;
  const declared = String((slide && slide.audio_file) || '');
  const base = 'audio/' + String(index).padStart(3, '0');
  const candidates = [];
  if (AUDIO_RE.test(declared)) candidates.push(declared);
  candidates.push(base + '.wav', base + '.mp3');
  const seen = new Set();
  for (const rel of candidates) {
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = inside(moduleDir, rel);
    if (!abs) continue;
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0) continue;
    const ext = rel.endsWith('.wav') ? 'wav' : 'mp3';
    if (ext === 'wav' && (stat.size < 44 || !isRiffWav(abs))) continue;
    const durationMs =
      ext === 'wav'
        ? wavDurationMsPath(abs) || Math.round(Number(slide.audio_ms) || 0)
        : Math.round(Number(slide.audio_ms) || 0);
    return { path: abs, ext: ext, bytes: stat.size, file: rel, durationMs: Math.max(0, durationMs) };
  }
  return null;
}

export function resolveImage(moduleDir, slide) {
  if (String((slide && slide.image_status) || '') !== 'ready') return null;
  const rel = String((slide && slide.image_file) || '');
  if (!IMAGE_RE.test(rel)) return null;
  const abs = inside(moduleDir, rel);
  if (!abs) return null;
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size <= 0) return null;
  const size = pngSize(abs);
  if (!size) return null;
  return { path: abs, bytes: stat.size, width: size.width, height: size.height, file: rel };
}

/** 文件名：书名-精讲-模块标题（去掉「精讲：」前缀），非法字符替换。 */
export function buildFileName(bookTitle, moduleTitle) {
  const book = String(bookTitle || '未命名').trim();
  const rest = String(moduleTitle || '')
    .replace(/^\s*精讲\s*[：:]\s*/, '')
    .trim();
  const raw = rest ? book + '-精讲-' + rest : book + '-精讲';
  const safe = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120);
  return (safe || '精讲') + '.pptx';
}

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function notesText(value) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').trim();
}

/**
 * @param {string} moduleId
 * @param {{includeAudio?:boolean}} options
 * @returns {{plan:object, deck:object}}
 */
export function buildPptxPlan(moduleId, options) {
  const opts = options || {};
  const includeAudio = opts.includeAudio !== false;
  const found = loadModuleById(moduleId);
  if (!found) throw new PptxError('E_NOT_FOUND', '找不到这个模块', '');
  const record = found.module || {};
  assertPptxEligible(record.status);
  const doc = found.slides;
  const list = doc && Array.isArray(doc.slides) ? doc.slides : [];
  if (!list.length) throw new PptxError('E_PPT_EMPTY', '这个精讲没有页面，无法导出', '');

  const bookTitle = String((found.book && found.book.title) || '未命名');
  const moduleTitle = String(record.title || doc.module_title || '精讲');
  const missingAudio = [];
  const missingImage = [];
  const lostImages = [];
  let audioBytes = 0;
  let imageBytes = 0;
  let notesBytes = 0;
  let audioPages = 0;

  const slides = list.map((source, i) => {
    const index = i + 1;
    const audio = resolveAudio(found.moduleDir, source);
    const image = resolveImage(found.moduleDir, source);
    if (!audio) missingAudio.push(index);
    else {
      audioPages += 1;
      if (includeAudio) audioBytes += audio.bytes;
    }
    if (!image) {
      missingImage.push(index);
      if (String(source.image_status || '') === 'ready') lostImages.push(index);
    } else {
      imageBytes += image.bytes;
    }
    const notes = notesText(source.audio_script);
    notesBytes += Buffer.byteLength(notes, 'utf8');
    const layout = ['cover', 'content_text', 'quote'].includes(String(source.layout || ''))
      ? String(source.layout)
      : 'content_text';
    return {
      layout: layout,
      title: cleanText(source.title),
      subtitle: cleanText(source.subtitle),
      bullets: (Array.isArray(source.bullet_points) ? source.bullet_points : [])
        .map(cleanText)
        .filter(Boolean)
        .slice(0, 5),
      quoteText: cleanText(source.quote_text),
      quoteSource: cleanText(source.quote_source),
      notes: notes,
      bookTitle: bookTitle,
      audio: includeAudio ? audio : null,
      image: image,
    };
  });

  const imagePages = slides.filter((slide) => !!slide.image).length;
  const warnings = [];
  if (!audioPages) warnings.push('这个精讲没有可用音频，PPT 将不含声音');
  else if (missingAudio.length) warnings.push(String(missingAudio.length) + '/' + slides.length + ' 页没有音频，将跳过');
  if (!includeAudio && audioPages) warnings.push('本次不含音频（' + audioPages + ' 页可含音频）');
  if (lostImages.length) warnings.push('第 ' + lostImages.slice(0, 5).join('、') + ' 页配图文件缺失，将留白');
  else if (imagePages > 0 && imagePages < slides.length) warnings.push('部分页没有配图，将留白');

  const baseBytes = 48 * 1024 + slides.length * 6 * 1024 + notesBytes;
  const bytes = baseBytes + audioBytes + imageBytes;
  if (bytes > MAX_BYTES) {
    throw new PptxError('E_PPT_TOO_LARGE', 'PPT 会超过 150 MB，去掉音频或减少页数', '');
  }

  const plan = {
    ok: true,
    moduleId: String(moduleId),
    title: moduleTitle,
    bookTitle: bookTitle,
    fileName: buildFileName(bookTitle, moduleTitle),
    slides: slides.length,
    audioPages: audioPages,
    imagePages: imagePages,
    missingAudio: missingAudio,
    missingImage: missingImage,
    bytes: bytes,
    includeAudio: includeAudio,
    warnings: warnings,
  };
  const deck = {
    title: moduleTitle,
    bookTitle: bookTitle,
    slides: slides,
  };
  return { plan: plan, deck: deck };
}

/** 只返回可 JSON 化的计划（不带本机绝对路径）。 */
export function planPptx(moduleId, options) {
  return buildPptxPlan(moduleId, options).plan;
}

export const PPT_MAX_BYTES = MAX_BYTES;
