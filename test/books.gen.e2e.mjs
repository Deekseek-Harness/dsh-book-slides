/**
 * 真书生成冒烟：用真 PDF 的原文喂一个「假模型」，把 M3 的分块 → 校验 → 锚定走通。
 *
 *   node test/books.gen.e2e.mjs <book.pdf> [章数]
 *
 * 假模型不做任何创作：它从提示词的【本批原文】里挑长句当 source_quote，
 * 拼成合法幻灯片。这样能验证的是「真书的文字层 + 清洗 + 分块 + 锚点回填」，
 * 而不是文案质量。真模型质量要等面板里点一次才知道。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const pdfPath = process.argv[2];
const wanted = Math.max(1, Math.min(5, Math.round(Number(process.argv[3]) || 2)));
if (!pdfPath || !fs.existsSync(pdfPath)) {
  console.error('用法：node test/books.gen.e2e.mjs <book.pdf> [章数]');
  process.exit(2);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'book-slides-gen-e2e-'));
process.env.DSH_BOOK_SLIDES_ROOT = ROOT;
delete process.env.DSH_HOME;

const plugin = await import('../index.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const calls = [];

function buildReply(user) {
  if (user.includes('【待修的页】')) {
    // 真书锚点通常能对上；万一触发修复，就原样不动，让 unanchored 如实留在结果里
    return JSON.stringify({ fixes: [] });
  }
  const start = user.indexOf('【本批原文】');
  const tailMark = user.indexOf('【衔接上下文】') >= 0 ? user.indexOf('【衔接上下文】') : user.indexOf('【输出】');
  const block = user.slice(start + '【本批原文】'.length, tailMark);
  const isFirst = user.includes('本批是模块第一批');
  const range = /【本批覆盖】[^\n]*（第 (\d+)–(\d+) 页）/.exec(user);
  const from = range ? Number(range[1]) : 1;
  const to = range ? Number(range[2]) : from;
  const candidates = block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('【第 '))
    .filter((line) => line.length >= 40 && line.length <= 200 && !/^\d+$/.test(line));

  if (!candidates.length) return JSON.stringify({ module_title: '空', slides: [] });
  const quoteAt = (index) => {
    const line = candidates[index % candidates.length];
    return line.slice(0, Math.min(80, line.length));
  };
  const slides = Array.from({ length: 6 }, (_, index) => {
    const n = index + 1;
    const cover = isFirst && n === 1;
    const layout = cover ? 'cover' : n % 3 === 0 ? 'quote' : 'content_text';
    return {
      slide_index: n,
      layout: layout,
      title: '第 ' + n + ' 页：' + quoteAt(index).slice(0, 8),
      subtitle: cover ? '自动生成冒烟' : '',
      bullet_points: layout === 'content_text' ? ['这一段的关键意思', '另一条要点'] : [],
      quote_text: layout === 'quote' ? quoteAt(index).slice(0, 40) : null,
      quote_source: layout === 'quote' ? '原文' : null,
      image_prompt: '书桌上摊开的一本书，暖色晨光',
      audio_script: '大家好，这一页我们顺着原文讲一个意思，把这段话里的重点慢慢说清楚，不念要点，也不说第一点第二点。',
      source_quote: quoteAt(index),
      source_pages: { from: from, to: to },
    };
  });
  return JSON.stringify({ module_title: '真书冒烟', slides: slides });
}

const fakeLlm = {
  async prepareCall() {
    return {
      config: {},
      async *stream(params) {
        const user = params && params.messages && params.messages[0] ? params.messages[0].content[0].text : '';
        calls.push(user);
        yield { type: 'text-delta', text: buildReply(user) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    };
  },
};

const routes = new Map();
const scoped = {
  webServer: {
    register(options) {
      routes.set(options.path, options.handler);
      return () => routes.delete(options.path);
    },
  },
  commands: { register() { return () => {}; } },
};
plugin.apply({
  inject(names, fn) {
    fn(scoped);
  },
  on() {},
  get(name) {
    if (name === 'llm') return fakeLlm;
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) };
    return undefined;
  },
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const handler = routes.get(url.pathname);
  if (!handler) {
    res.statusCode = 404;
    res.end('no route');
    return;
  }
  handler(req, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

async function getJson(pathname) {
  return fetch(base + pathname).then((res) => res.json());
}

async function postJson(pathname, body) {
  return fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then((res) => res.json());
}

async function main() {
  const startedAt = Date.now();
  const buffer = fs.readFileSync(pdfPath);
  const imported = await fetch(base + '/dsh-book-slides/import', {
    method: 'POST',
    headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(path.basename(pdfPath)) },
    body: buffer,
  }).then((res) => res.json());
  if (!imported.ok) throw new Error('导入失败：' + JSON.stringify(imported));
  console.log('导入：' + imported.title + ' · ' + imported.pages + ' 页 · ' + imported.chapters + ' 章 · ' + (Date.now() - startedAt) + 'ms');

  const detail = await getJson('/dsh-book-slides/book?bookId=' + imported.bookId);
  const chapters = detail.chapters.filter((chapter) => !chapter.front && !chapter.hidden && (chapter.chars || 0) >= 50);
  const selected = [];
  let chars = 0;
  for (const chapter of chapters) {
    if (selected.length >= wanted) break;
    if (chars + chapter.chars > 60000) break;
    selected.push(chapter);
    chars += chapter.chars;
  }
  if (!selected.length) throw new Error('没有可生成的章节');
  console.log('选章：' + selected.map((chapter) => '第' + chapter.n + '章(' + chapter.chars + '字)').join('、') + ' · 共 ' + chars + ' 字');

  const generatedAt = Date.now();
  const started = await postJson('/dsh-book-slides/generate', { bookId: imported.bookId, chapters: selected.map((chapter) => chapter.n) });
  if (!started.ok) throw new Error('生成没起来：' + JSON.stringify(started));
  let job = null;
  let lastStage = '';
  for (let i = 0; i < 300; i += 1) {
    job = await getJson('/dsh-book-slides/job?moduleId=' + started.moduleId);
    if (job.stage !== lastStage) {
      lastStage = job.stage;
      console.log('  ' + lastStage + ' ' + (job.current || 0) + '/' + (job.total || 0) + ' ' + (job.message || ''));
    }
    if (['ready', 'ready_degraded', 'failed', 'cancelled', 'interrupted'].includes(job.status)) break;
    await sleep(100);
  }
  console.log('生成：' + job.status + ' · ' + (Date.now() - generatedAt) + 'ms · 模型调用 ' + calls.length + ' 次');
  if (job.status !== 'ready' && job.status !== 'ready_degraded') throw new Error('作业失败：' + JSON.stringify(job));

  const mod = await getJson('/dsh-book-slides/module?moduleId=' + started.moduleId);
  const slides = mod.slides && mod.slides.slides ? mod.slides.slides : [];
  const unanchored = slides.filter((slide) => slide.anchor_status !== 'anchored');
  console.log('结果：' + slides.length + ' 页 · 锚定率 ' + Math.round((mod.module.anchorHitRate || 0) * 100) + '% · 未定位 ' + unanchored.length + ' 页');
  if (unanchored.length) {
    for (const slide of unanchored.slice(0, 5)) console.log('  未定位：第 ' + slide.slide_index + ' 页「' + String(slide.source_quote).slice(0, 40) + '」');
  }
  const audio = slides.filter((slide) => slide.audio_ms > 0 && slide.audio_provider === 'browser').length;
  console.log('朗读稿：' + audio + '/' + slides.length + ' 页有浏览器朗读时长（不落音频文件）');
  if (slides.length < 6) throw new Error('页数不足：' + slides.length);
  if ((mod.module.anchorHitRate || 0) < 0.9) throw new Error('锚定率低于 90%');
  console.log('OK');
}

try {
  await main();
} catch (err) {
  console.error('跑挂了：' + ((err && err.stack) || err));
  process.exitCode = 1;
} finally {
  server.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
}
