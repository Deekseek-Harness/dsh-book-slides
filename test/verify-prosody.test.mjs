/**
 * AC-155 韵律度量脚本（scripts/verify-prosody.mjs）的合成音频用例：
 * 同讲 6 页用 220Hz 正弦 → F0 极差 0；把一页换成 330Hz → 极差 ≈7 个半音并列为离群页。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { analyzeLecture, medianF0, readWav } from '../scripts/verify-prosody.mjs';

const SAMPLE_RATE = 16000;

function makeSineWav(f0, seconds = 1) {
  const frames = Math.round(SAMPLE_RATE * seconds);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * f0 * i) / SAMPLE_RATE) * 0.5 * 32767);
    data.writeInt16LE(value, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function makeLecture(root, tag, f0s) {
  const dir = path.join(root, tag);
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  const slides = f0s.map((_, index) => ({
    slide_index: index + 1,
    layout: index === 0 ? 'cover' : 'content_text',
    title: '第 ' + (index + 1) + ' 页',
    audio_script: '字'.repeat(40),
    audio_file: 'audio/' + String(index + 1).padStart(3, '0') + '.wav',
  }));
  fs.writeFileSync(path.join(dir, 'slides.json'), JSON.stringify({ schema_version: 1, slides }, null, 2));
  f0s.forEach((f0, index) => {
    fs.writeFileSync(path.join(dir, 'audio', String(index + 1).padStart(3, '0') + '.wav'), makeSineWav(f0));
  });
  return dir;
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-prosody-'));

test('WAV 读取与 F0 估计：220Hz 正弦', () => {
  const wav = readWav(makeSineWav(220));
  assert.ok(wav);
  assert.equal(wav.sampleRate, SAMPLE_RATE);
  const f0 = medianF0(wav.samples, wav.sampleRate);
  assert.ok(Math.abs(f0 - 220) < 5, '估计 F0=' + f0);
});

test('AC-155：同讲 6 页同 F0 → PASS；一页离群 → FAIL 并列出离群页', () => {
  const stable = makeLecture(ROOT, 'stable', [220, 220, 220, 220, 220, 220]);
  const stableOut = analyzeLecture(stable);
  assert.equal(stableOut.pages.length, 6);
  assert.equal(stableOut.f0SpreadSt, 0);
  assert.equal(stableOut.ok, true);

  const shifted = makeLecture(ROOT, 'shifted', [220, 220, 220, 220, 220, 330]);
  const shiftedOut = analyzeLecture(shifted);
  assert.ok(shiftedOut.f0SpreadSt > 2, '极差 ' + shiftedOut.f0SpreadSt + ' st');
  assert.equal(shiftedOut.ok, false);
  assert.deepEqual(shiftedOut.outliers, [6]);
});

test.after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
