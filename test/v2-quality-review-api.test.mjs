/** 3.2：只读 AI 审阅 API——只写 quality.review，不改 slides 正文。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-ai-review-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const { createBook, writeChapters } = await import('../host/books.js');
const { savePart } = await import('../host/parts.js');
const { createSeries, seriesDir } = await import('../host/series.js');
const { writeLectureOutputs } = await import('../host/lectures.js');
const { routeM1 } = await import('../host/api.js');

const book = createBook({
  buffer: Buffer.from('ai-review-' + Date.now()),
  fileName: 'ai-review.pdf',
  title: 'AI 审阅',
  author: '',
  pages: 1,
  rawPages: [{ page: 1, text: '第1章 周期\n' + '周期'.repeat(120) }],
});
writeChapters(book.id, [{ n: 1, title: '第1章 周期', from: 1, to: 1, chars: 260, front: false }], 'manual');
const part = savePart({ bookId: book.id, chapters: [1], title: '第1章 周期' });
const series = createSeries({
  bookId: book.id,
  partId: part.id,
  title: '第1章 周期',
  plan: {
    throughline: '周期',
    lectures: [{
      n: 1,
      chapters: [1],
      title: '第 1 讲 周期',
      goal: '讲周期',
      in: '',
      out: '',
      pages: 1,
      chars: 260,
      sections: [{ title: '1.1 周期', page: 1, pages: 1, must_keep: ['周期'] }],
    }],
    seams: [],
    terms: [],
    cut_notes: [],
    source: 'model',
    stitched: false,
    totalChars: 260,
    totalPages: 1,
    estMinutes: 1,
  },
});
const lecture = {
  schema: 1,
  series_id: series.id,
  n: 1,
  title: '第 1 讲 周期',
  chapters: [1],
  pages: 1,
  planned_pages: 1,
  actual_pages: 1,
  quality: {
    content_ok: false,
    must_keep_real_missing: [{ section: '1.1 周期', must_keep: '周期' }],
    planned_pages: 1,
    actual_pages: 1,
  },
};
const slidesDoc = {
  schema: 1,
  slides: [{
    slide_index: 1,
    layout: 'content_text',
    page_role: 'concept',
    section: '1.1 周期',
    title: '周期',
    bullet_points: ['周期函数会重复。'],
    audio_script: '这一段讲周期。',
    source_pages: { from: 1, to: 1 },
  }],
  quality: lecture.quality,
};
writeLectureOutputs(seriesDir(book.id, series.id), 1, lecture, slidesDoc);

const ctx = {
  get(name) {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-review' }) };
    if (name !== 'llm') return null;
    return {
      async prepareCall() {
        return {
          config: {},
          async *stream() {
            yield {
              type: 'text-delta',
              text: JSON.stringify({
                lecture: 1,
                verdict: 'needs_human',
                items: [{
                  id: 'mk:1.1:周期',
                  machine_type: 'must_keep_real_missing',
                  page: 1,
                  judgment: 'unclear',
                  evidence: { slide_quote: '周期函数会重复。', source_page: 1, source_quote: '周期' },
                  confidence: 0.5,
                  action: 'human_review',
                  patch: null,
                }],
                summary: '需要人工确认',
              }),
            };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      },
    };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const handled = await routeM1(req, res, url, { ctx });
  if (!handled) {
    res.statusCode = 404;
    res.end('no route');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = 'http://127.0.0.1:' + server.address().port;

test('3.2：POST /lecture/quality/review 只写 review，不改 slides', async () => {
  const before = JSON.parse(fs.readFileSync(path.join(seriesDir(book.id, series.id), 'lectures/1/slides.json'), 'utf8'));
  const beforeHash = JSON.stringify(before.slides);
  const res = await fetch(baseUrl + '/dsh-book-slides/lecture/quality/review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seriesId: series.id, n: 1 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.review.verdict, 'needs_human');
  assert.equal(body.quality.review.verdict, 'needs_human');
  const after = JSON.parse(fs.readFileSync(path.join(seriesDir(book.id, series.id), 'lectures/1/slides.json'), 'utf8'));
  assert.equal(JSON.stringify(after.slides), beforeHash);
  assert.equal(after.quality.review.prompt_version, 'quality-review-v1');
});

test.after(() => {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});
