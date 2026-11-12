import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyQualityReview,
  buildQualityReviewPayload,
  QUALITY_REVIEW_VERSION,
  QualityReviewError,
  reviewLectureQuality,
  validateQualityReview,
} from '../host/quality-review.js';

const lecture = {
  n: 1,
  title: '第 1 讲 测试',
  goal: '讲清周期',
  planned_pages: 10,
  sections: [{
    title: '2.2.2　[0; 2π] 以外的三角函数',
    page: 6,
    pages: 1,
    must_keep: ['周期性'],
  }],
};

const slides = [{
  slide_index: 1,
  section: '2.2.2 [0, 2π] 以外的三角函数',
  layout: 'content_text',
  page_role: 'concept',
  title: '转到圈外的角',
  bullet_points: ['反复加减 2π 的倍数，体现周期性。'],
  audio_script: '这一段讲周期性。',
  source_pages: { from: 59, to: 60 },
}];

const pages = [
  { page: 59, text: '原文第 59 页：周期函数。' },
  { page: 60, text: '原文第 60 页：加减 2π。' },
  { page: 61, text: '无关页：不要进入 source_excerpts。' },
];

const quality = {
  content_ok: false,
  planned_pages: 10,
  actual_pages: 10,
  missing_sections: [],
  must_keep_real_missing: [{ section: lecture.sections[0].title, must_keep: '周期性' }],
  hard_impersonations: [],
  density: {},
};

test('3.2：AI 审阅 payload 只带相关原文与结构化输入', () => {
  const payload = buildQualityReviewPayload({
    book: { title: '测试书', author: '作者' },
    lecture,
    slides,
    quality,
    pages,
    aliases: [{ term: '周期性', any: ['周期', '重复'], all: [] }],
  });
  assert.equal(payload.prompt_version, QUALITY_REVIEW_VERSION);
  assert.equal(payload.lecture.sections.length, 1);
  assert.equal(payload.aliases[0].term, '周期性');
  assert.equal(payload.auto_audit.must_keep_real_missing.length, 1);
  assert.equal(payload.slides[0].bullet_points.length, 1);
  assert.ok(payload.source_excerpts.length >= 1);
  const source = payload.source_excerpts.map((item) => item.text).join('\n');
  assert.match(source, /原文第 59 页/);
  assert.match(source, /原文第 60 页/);
  assert.doesNotMatch(source, /无关页/);
});

test('3.2：AI 审阅输出校验与 patch 恒为 null', () => {
  const review = validateQualityReview({
    lecture: 1,
    verdict: 'pass',
    items: [{
      id: 'mk:2.2.2:周期性',
      machine_type: 'must_keep_real_missing',
      page: 6,
      judgment: 'covered',
      evidence: { slide_quote: '反复加减 2π', source_page: 59, source_quote: '原文第 59 页' },
      confidence: 0.9,
      action: 'none',
      patch: { should: 'be ignored' },
    }],
    summary: '内容已覆盖',
  }, { lecture: 1 });
  assert.equal(review.verdict, 'pass');
  assert.equal(review.items[0].patch, null);
  assert.equal(review.items[0].judgment, 'covered');
});

test('3.2：非法输出与 missing+pass 不会直接通过', () => {
  assert.throws(
    () => validateQualityReview({ verdict: 'pass', items: null }),
    (err) => err instanceof QualityReviewError && err.code === 'E_REVIEW_INVALID',
  );
  const review = validateQualityReview({
    lecture: 1,
    verdict: 'pass',
    items: [{ judgment: 'missing', page: 1, evidence: {}, confidence: 0.8, action: 'regenerate' }],
  });
  assert.equal(review.verdict, 'needs_human');
});

function fakeReviewCtx(mode) {
  let calls = 0;
  const ctx = {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-review' }) };
      if (name !== 'llm') return null;
      return {
        async prepareCall() {
          return {
            config: {},
            async *stream() {
              calls += 1;
              if (mode === 'always-truncated' || calls === 1) {
                yield { type: 'finish', reason: { kind: 'max-tokens' } };
                return;
              }
              yield {
                type: 'text-delta',
                text: JSON.stringify({
                  lecture: 1,
                  verdict: 'needs_human',
                  items: [{ id: 'mk:1', judgment: 'unclear', page: 1, evidence: {}, confidence: 0.4, action: 'human_review' }],
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
  return { ctx, calls: () => calls };
}

test('3.2：max-tokens 时自动重试 32000', async () => {
  const fake = fakeReviewCtx('retry');
  const review = await reviewLectureQuality({
    ctx: fake.ctx,
    book: { title: '测试书' },
    lecture,
    slides,
    quality,
    pages,
    aliases: [],
  });
  assert.equal(fake.calls(), 2);
  assert.equal(review.verdict, 'needs_human');
  assert.ok(review.audit_digest);
});

test('3.2：两次都 max-tokens 时返回 E_REVIEW_TRUNCATED', async () => {
  const fake = fakeReviewCtx('always-truncated');
  await assert.rejects(
    () => reviewLectureQuality({ ctx: fake.ctx, book: {}, lecture, slides, quality, pages, aliases: [] }),
    (err) => err instanceof QualityReviewError && err.code === 'E_REVIEW_TRUNCATED',
  );
  assert.equal(fake.calls(), 2);
});

test('3.2：只读写入只改 quality.review，不改 slides 正文', () => {
  const doc = {
    lecture: { n: 1, quality: { content_ok: true } },
    slidesDoc: { quality: { content_ok: true }, slides: [{ title: '原页' }] },
  };
  const review = { verdict: 'pass', items: [], summary: 'ok', reviewed_at: '2026-11-12T00:00:00.000Z' };
  const next = applyQualityReview(doc, review);
  assert.deepEqual(next.slidesDoc.slides, doc.slidesDoc.slides);
  assert.equal(next.slidesDoc.quality.content_ok, true);
  assert.equal(next.slidesDoc.quality.review.summary, 'ok');
  assert.equal(doc.slidesDoc.quality.review, undefined);
});
