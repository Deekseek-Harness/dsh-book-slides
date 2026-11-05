/**
 * 2.0 讲：series/<seriesId>/lectures/<n>/ 的读写。
 *
 * 讲只能存在于系列之下（D76）；这里不含生成逻辑，只负责目录、章节文本快照、
 * lecture.json / slides.json 的原子落盘。生成与缝合都通过这一层读写，避免出现
 * 两套路径。
 */
import fs from 'node:fs';
import path from 'node:path';

import { readJson, writeJson } from './root.js';
import { loadBook } from './books.js';

export function lecturesRoot(seriesDirPath) {
  return path.join(seriesDirPath, 'lectures');
}

export function lectureDir(seriesDirPath, n) {
  return path.join(lecturesRoot(seriesDirPath), String(Number(n)));
}

export function lectureFile(seriesDirPath, n) {
  return path.join(lectureDir(seriesDirPath, n), 'lecture.json');
}

export function slidesFile(seriesDirPath, n) {
  return path.join(lectureDir(seriesDirPath, n), 'slides.json');
}

export function batchesDir(seriesDirPath, n) {
  return path.join(lectureDir(seriesDirPath, n), 'batches');
}

/** 读一讲的元数据与幻灯片；缺文件时返回 null，不抛错。 */
export function loadLecture(seriesDirPath, n) {
  const dir = lectureDir(seriesDirPath, n);
  return {
    n: Number(n),
    dir,
    lecture: readJson(path.join(dir, 'lecture.json'), null),
    slidesDoc: readJson(path.join(dir, 'slides.json'), null),
    exists: fs.existsSync(path.join(dir, 'lecture.json')),
  };
}

/** 按系列讲次顺序读出全部讲（含缺文件的占位），缝合报告用。 */
export function loadSeriesLectures(series, dir = '') {
  const map = new Map();
  const root = dir || (series && series.dir) || '';
  if (!root) return map;
  for (const item of (series && series.lectures) || []) {
    map.set(Number(item.n), loadLecture(root, item.n));
  }
  return map;
}

/** 只写讲元数据：排队、阶段、失败/取消时用。 */
export function writeLectureMeta(seriesDirPath, n, lecture) {
  writeJson(lectureFile(seriesDirPath, n), lecture);
  return lecture;
}

/**
 * 写一讲的成品：slides.json 先落盘，lecture.json 后落盘。
 * lecture.json 存在且 status=ready 是“这一讲可用”的唯一判据。
 */
export function writeLectureOutputs(seriesDirPath, n, lecture, slidesDoc) {
  const dir = lectureDir(seriesDirPath, n);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, 'slides.json'), slidesDoc);
  writeJson(path.join(dir, 'lecture.json'), lecture);
  return { lecture, slidesDoc };
}

export function removeLectureDir(seriesDirPath, n) {
  try {
    fs.rmSync(lectureDir(seriesDirPath, n), { recursive: true, force: true });
  } catch {
    /* 删不掉时由后续写入覆盖 */
  }
}

/**
 * 系列章快照 → 带原文的章节。
 *
 * 与 v2/parts.js 的 partChapterTexts 使用同一种拼接方式（页文本用 \n 连接），
 * 这样讲纲里按字符偏移计算的 slice 能直接切到同一段文字。
 */
export function seriesChapterTexts(bookId, series) {
  const loaded = loadBook(bookId);
  if (!loaded) return null;
  const wanted = new Set(((series && series.chapters) || []).map(Number));
  const pages = readJson(path.join(loaded.dir, 'pages.json'), []);
  const pageList = Array.isArray(pages) ? pages : [];
  const chapters = (loaded.chapters || [])
    .filter((c) => wanted.has(Number(c.n)))
    .sort((a, b) => Number(a.n) - Number(b.n))
    .map((c) => {
      const text = pageList
        .filter((p) => Number(p.page) >= Number(c.from) && Number(p.page) <= Number(c.to))
        .map((p) => String(p.text || ''))
        .join('\n');
      return {
        n: Number(c.n),
        title: String(c.title || ''),
        from: Number(c.from),
        to: Number(c.to),
        chars: Number(c.chars) || text.length,
        text,
      };
    });
  return { loaded, pages: pageList, chapters };
}

/** 讲用到的章（按 series.chapters 快照，不依赖 Part 是否还在）。 */
export function chapterMapOf(texts) {
  return new Map((texts.chapters || []).map((c) => [Number(c.n), c]));
}
