/**
 * v1.5 导出 PPT —— 生成器测试（附录 O.11 的 AC-60 / AC-61 / AC-62 / AC-64）。
 *
 *   node test/pptx.test.mjs
 *
 * 不调 PowerPoint：用假 deck 真写一个 ZIP，再按 OOXML 部件断言。
 * 真机打开 / 播放由 AC-69 人工验收，自动化替代不了。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';

import { AUDIO_ICON_PATH, buildPptxBuffer, buildTimingXml, coverCrop } from '../lib/pptx.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-pptx-'));
const WAV = path.join(TMP, 'tone.wav');
const IMG = path.join(TMP, 'pic.png');
const ICON = path.join(TMP, 'icon.png');

function wavBuffer(seconds = 0.1) {
  const rate = 8000;
  const samples = Math.round(rate * seconds);
  const data = samples * 2;
  const buffer = Buffer.alloc(44 + data);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + data, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(data, 40);
  return buffer;
}

fs.writeFileSync(WAV, wavBuffer());
fs.copyFileSync(AUDIO_ICON_PATH, IMG);
fs.copyFileSync(AUDIO_ICON_PATH, ICON);

function unzip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) {
        reject(err);
        return;
      }
      const map = new Map();
      zip.on('error', reject);
      zip.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (openErr, stream) => {
          if (openErr) {
            reject(openErr);
            return;
          }
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            map.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
          stream.on('error', reject);
        });
      });
      zip.on('end', () => resolve(map));
      zip.readEntry();
    });
  });
}

function textOf(map, name) {
  const buffer = map.get(name);
  assert.ok(buffer, '缺少部件 ' + name);
  return buffer.toString('utf8');
}

function makeDeck() {
  return {
    title: '精讲：第 1–3 章',
    bookTitle: '故事 & 材质',
    slides: [
      {
        layout: 'cover',
        title: '电影主题：不止是技巧，更是灵魂',
        subtitle: '从《故事》看主题选择',
        bookTitle: '故事 & 材质',
        notes: '第一页台词：主题是地基。',
        audio: { path: WAV, ext: 'wav' },
        image: null,
      },
      {
        layout: 'content_text',
        title: '创作的核心',
        bullets: ['电影创作的核心：主题选择', '主题评估与个人兴趣的结合'],
        notes: '第二页台词：选对主题，电影才有灵魂。',
        audio: { path: WAV, ext: 'wav' },
        image: { path: IMG, width: 64, height: 64 },
      },
      {
        layout: 'quote',
        quoteText: '故事是生活的比喻。',
        quoteSource: '罗伯特·麦基《故事》',
        notes: '第三页台词：故事是生活的比喻。',
        audio: null,
        image: null,
      },
    ],
  };
}

test('PPTX 部件齐全、页序与备注正确', async () => {
  const buffer = await buildPptxBuffer(makeDeck());
  const map = await unzip(buffer);
  assert.ok(map.get('[Content_Types].xml'));
  assert.ok(map.get('ppt/presentation.xml'));
  assert.ok(map.get('ppt/notesMasters/notesMaster1.xml'));
  assert.ok(map.get('ppt/slideMasters/slideMaster1.xml'));
  for (let i = 1; i <= 3; i += 1) {
    assert.ok(map.get('ppt/slides/slide' + i + '.xml'), '缺少 slide' + i);
    assert.ok(map.get('ppt/notesSlides/notesSlide' + i + '.xml'), '缺少 notesSlide' + i);
  }
  const presentation = textOf(map, 'ppt/presentation.xml');
  assert.equal((presentation.match(/<p:sldId /g) || []).length, 3);
  const slide1 = textOf(map, 'ppt/slides/slide1.xml');
  assert.match(slide1, /电影主题：不止是技巧，更是灵魂/);
  assert.match(slide1, /<a:audioFile r:link="rId3"\/>/);
  assert.match(slide1, /<a:hlinkClick r:id="" action="ppaction:\/\/media"\/>/);
  assert.match(slide1, /<p14:media[^>]*r:embed="rId4"\/>/);
  assert.match(slide1, /<p:timing>/);
  assert.match(slide1, /nodeType="withEffect"/);
  assert.match(slide1, /<p:cmd type="call" cmd="playFrom\(0\.0\)">/);
  assert.match(slide1, /<p:audio>/);
  assert.match(slide1, /<p:spTgt spid="7"\/>/);
  assert.match(slide1, /第 1 页/);
  const notes1 = textOf(map, 'ppt/notesSlides/notesSlide1.xml');
  assert.match(notes1, /第一页台词：主题是地基。/);
  const notes2 = textOf(map, 'ppt/notesSlides/notesSlide2.xml');
  assert.match(notes2, /第二页台词：选对主题，电影才有灵魂。/);
});

test('音频/配图关系与字节：有则嵌，无则不产空媒体', async () => {
  const buffer = await buildPptxBuffer(makeDeck());
  const map = await unzip(buffer);
  assert.ok(map.get('ppt/media/audio1.wav'));
  assert.ok(map.get('ppt/media/audio2.wav'));
  assert.ok(!map.get('ppt/media/audio3.wav'));
  assert.ok(map.get('ppt/media/image2.png'));
  assert.ok(map.get('ppt/media/audio-icon.png'));
  assert.deepEqual(map.get('ppt/media/audio1.wav'), wavBuffer());
  const rels2 = textOf(map, 'ppt/slides/_rels/slide2.xml.rels');
  assert.match(rels2, /relationships\/audio/);
  assert.match(rels2, /http:\/\/schemas\.microsoft\.com\/office\/2007\/relationships\/media/);
  assert.match(rels2, /rId5[^>]*audio-icon\.png/);
  assert.match(rels2, /rId6[^>]*image2\.png/);
  const rels3 = textOf(map, 'ppt/slides/_rels/slide3.xml.rels');
  assert.doesNotMatch(rels3, /relationships\/audio/);
  assert.doesNotMatch(rels3, /relationships\/media/);
  assert.doesNotMatch(rels3, /relationships\/image/);
  const slide2 = textOf(map, 'ppt/slides/slide2.xml');
  assert.match(slide2, /<p:spTgt spid="5"\/>/);
  const slide3 = textOf(map, 'ppt/slides/slide3.xml');
  assert.doesNotMatch(slide3, /<a:audioFile/);
  assert.doesNotMatch(slide3, /<p:timing>/);
  assert.match(slide3, /故事是生活的比喻。/);
});

test('自动播 timing 用 WPS 兼容的 withEffect + p:audio，不自动换页', () => {
  const xml = buildTimingXml('42', 5000);
  assert.match(xml, /nodeType="withEffect"/);
  assert.match(xml, /<p:cmd type="call" cmd="playFrom\(0\.0\)">/);
  assert.match(xml, /<p:cTn id="6" dur="5000" fill="hold"\/>/);
  assert.match(xml, /<p:audio>/);
  assert.match(xml, /showWhenStopped="1"/);
  assert.doesNotMatch(xml, /isNarration/);
  assert.doesNotMatch(xml, /<p:transition/);
});

test('XML 特殊字符转义，不把 & < > 写进正文', async () => {
  const deck = makeDeck();
  deck.slides[0].title = 'A & B <C> "D"';
  deck.slides[0].notes = '台词 & 备注 <不要坏>';
  const map = await unzip(await buildPptxBuffer(deck));
  const slide1 = textOf(map, 'ppt/slides/slide1.xml');
  assert.match(slide1, /A &amp; B &lt;C&gt; &quot;D&quot;/);
  const notes1 = textOf(map, 'ppt/notesSlides/notesSlide1.xml');
  assert.match(notes1, /台词 &amp; 备注 &lt;不要坏&gt;/);
});

test('内容类型覆盖每一页 slide / notes', async () => {
  const map = await unzip(await buildPptxBuffer(makeDeck()));
  const types = textOf(map, '[Content_Types].xml');
  for (let i = 1; i <= 3; i += 1) {
    assert.match(types, new RegExp('/ppt/slides/slide' + i + '\\.xml'));
    assert.match(types, new RegExp('/ppt/notesSlides/notesSlide' + i + '\\.xml'));
  }
  assert.match(types, /Extension="wav"/);
  assert.match(types, /Extension="mp3"/);
  assert.match(types, /Extension="png"/);
});

test('coverCrop 只裁不拉伸，方形进竖图裁左右', () => {
  const crop = coverCrop(100, 100, 418, 460);
  assert.ok(crop);
  assert.ok(crop.l > 0 && crop.r > 0);
  assert.equal(crop.t, undefined);
  assert.equal(coverCrop(100, 100, 100, 100), null);
});

test('空 deck 抛错，不产半截文件', async () => {
  await assert.rejects(() => buildPptxBuffer({ title: 'x', slides: [] }), /没有页面/);
});
