/**
 * 精讲台 · Host 半体（2.x）
 *
 * 只做四件事：
 *   1. 启动归一：ensureRoot、残留导入清理、v2 作业状态收口
 *   2. 把 /dsh-book-slides/* 的路径注册到宿主，全部交给 host/api.js 的 routeM1
 *   3. `/chapter-check` 命令与 pdf.js 静态资源转发
 *   4. 插件卸载时注销路由
 *
 * 1.x 的单讲生成/作业/模块/进度接口已全部下线；业务实现都在 host/。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT } from './lib/fs.js';
import { routeM1 } from './host/api.js';
import { ensureRoot } from './host/root.js';
import { reconcileAllSeries } from './host/generate.js';
import { cleanupStaleImports } from './host/package.js';
import { reconcileImageJobs } from './host/images.js';
import { reconcileVoiceJobs } from './host/voice.js';
import { reconcileUsageJobs } from './host/usage.js';
import { runBookCheck } from './check.js';

const require = createRequire(import.meta.url);

/**
 * pdf.js 的浏览器产物目录：播放器左窗格要渲染 PDF 视觉版式，客户端动态 import
 * `build/pdf.min.mjs`，worker / cmaps / standard_fonts / wasm 由本插件同源提供。
 * 用 require.resolve 定位依赖，不把第三方文件复制进仓库。
 */
let pdfjsRootCache = null;
function pdfjsRoot() {
  if (pdfjsRootCache !== null) return pdfjsRootCache;
  try {
    pdfjsRootCache = path.dirname(require.resolve('pdfjs-dist/package.json'));
  } catch {
    pdfjsRootCache = '';
  }
  return pdfjsRootCache;
}

export const ROUTE_PREFIX = '/dsh-book-slides';
export const ROUTE_META = ROUTE_PREFIX + '/meta';
export const ROUTE_CHAPTERS_BUILD = ROUTE_PREFIX + '/chapters/build';
export const ROUTE_TRASH = ROUTE_PREFIX + '/trash';
export const ROUTE_TRASH_RESTORE = ROUTE_PREFIX + '/trash/restore';
export const ROUTE_STORAGE = ROUTE_PREFIX + '/storage';
export const ROUTE_PARTS = ROUTE_PREFIX + '/parts';
export const ROUTE_PART = ROUTE_PREFIX + '/part';
export const ROUTE_PART_UPDATE = ROUTE_PREFIX + '/part/update';
export const ROUTE_PLAN_PREVIEW = ROUTE_PREFIX + '/plan/preview';
export const ROUTE_SERIES = ROUTE_PREFIX + '/series';
export const ROUTE_SERIES_PLAN = ROUTE_PREFIX + '/series/plan';
export const ROUTE_SERIES_START = ROUTE_PREFIX + '/series/start';
export const ROUTE_SERIES_LECTURE_GENERATE = ROUTE_PREFIX + '/series/lecture/generate';
export const ROUTE_SERIES_RESUME = ROUTE_PREFIX + '/series/resume';
export const ROUTE_SERIES_RETRY = ROUTE_PREFIX + '/series/retry';
export const ROUTE_SERIES_JOB = ROUTE_PREFIX + '/series/job';
export const ROUTE_SERIES_CANCEL = ROUTE_PREFIX + '/series/cancel';
export const ROUTE_SERIES_STITCH = ROUTE_PREFIX + '/series/stitch';
export const ROUTE_SERIES_STITCH_REPAIR = ROUTE_PREFIX + '/series/stitch/repair';
export const ROUTE_LECTURE = ROUTE_PREFIX + '/lecture';
export const ROUTE_BRIEFS = ROUTE_PREFIX + '/briefs';
export const ROUTE_BOOKS = ROUTE_PREFIX + '/books';
export const ROUTE_BOOK = ROUTE_PREFIX + '/book';
export const ROUTE_IMPORT = ROUTE_PREFIX + '/import';
export const ROUTE_RENAME = ROUTE_PREFIX + '/rename';
export const ROUTE_FILE = ROUTE_PREFIX + '/file';
export const ROUTE_COVER = ROUTE_PREFIX + '/cover';
export const ROUTE_CHAPTERS = ROUTE_PREFIX + '/chapters';
export const ROUTE_TOC = ROUTE_PREFIX + '/toc';
export const ROUTE_TOC_PREVIEW = ROUTE_PREFIX + '/toc/preview';
export const ROUTE_TOC_RANGE = ROUTE_PREFIX + '/toc/range';
export const ROUTE_AUDIO = ROUTE_PREFIX + '/audio';
export const ROUTE_VOICE = ROUTE_PREFIX + '/voice';
export const ROUTE_VOICE_PROBE = ROUTE_PREFIX + '/voice/probe';
export const ROUTE_VOICE_WORKFLOW = ROUTE_PREFIX + '/voice/workflow';
export const ROUTE_VOICE_REFVOICES = ROUTE_PREFIX + '/voice/refvoices';
export const ROUTE_VOICE_REFVOICES_IMPORT = ROUTE_PREFIX + '/voice/refvoices/import';
export const ROUTE_VOICE_COMFY_PROBE = ROUTE_PREFIX + '/voice/comfy/probe';
export const ROUTE_PAGES = ROUTE_PREFIX + '/pages';
export const ROUTE_PREFERENCE = ROUTE_PREFIX + '/preference';
export const ROUTE_TRASH_CLEAR = ROUTE_PREFIX + '/trash/clear';
export const ROUTE_PDFJS_VENDOR = ROUTE_PREFIX + '/vendor/pdfjs';
export const ROUTE_EXPORT = ROUTE_PREFIX + '/export';
export const ROUTE_EXPORT_SIZE = ROUTE_PREFIX + '/export/size';
export const ROUTE_EXPORT_PPTX = ROUTE_PREFIX + '/export/pptx';
export const ROUTE_EXPORT_PPTX_PLAN = ROUTE_PREFIX + '/export/pptx/plan';
export const ROUTE_EXPORT_PPTX_BATCH = ROUTE_PREFIX + '/export/pptx/batch';
export const ROUTE_IMPORT_PACKAGE = ROUTE_PREFIX + '/import/package';
export const ROUTE_IMPORT_PACKAGE_ACTIVE = ROUTE_PREFIX + '/import/package/active';
export const ROUTE_IMPORT_PACKAGE_JOB = ROUTE_PREFIX + '/import/package/job';
export const ROUTE_IMPORT_PACKAGE_CANCEL = ROUTE_PREFIX + '/import/package/cancel';
export const ROUTE_REVOICE = ROUTE_PREFIX + '/revoice';
export const ROUTE_IMAGE = ROUTE_PREFIX + '/image';
export const ROUTE_IMAGE_CONFIG = ROUTE_PREFIX + '/image/config';
export const ROUTE_IMAGE_WORKFLOW = ROUTE_PREFIX + '/image/workflow';
export const ROUTE_IMAGE_PROBE = ROUTE_PREFIX + '/image/probe';
export const ROUTE_IMAGE_TEST = ROUTE_PREFIX + '/image/test';
export const ROUTE_IMAGE_STATUS = ROUTE_PREFIX + '/image/status';
export const ROUTE_IMAGE_REGEN = ROUTE_PREFIX + '/image/regen';
export const ROUTE_IMAGE_CANCEL = ROUTE_PREFIX + '/image/cancel';
export const ROUTE_PRACTICE_SUMMARY = ROUTE_PREFIX + '/practice/summary';
export const ROUTE_PRACTICE_BANK = ROUTE_PREFIX + '/practice/bank';
export const ROUTE_PRACTICE_JOB = ROUTE_PREFIX + '/practice/job';
export const ROUTE_PRACTICE_CANCEL = ROUTE_PREFIX + '/practice/cancel';
export const ROUTE_PRACTICE_SESSION = ROUTE_PREFIX + '/practice/session';
export const ROUTE_PRACTICE_ANSWER = ROUTE_PREFIX + '/practice/answer';
export const ROUTE_PRACTICE_EXPLAIN = ROUTE_PREFIX + '/practice/explain';
export const ROUTE_PRACTICE_FINISH = ROUTE_PREFIX + '/practice/finish';
export const ROUTE_PRACTICE_FLAG = ROUTE_PREFIX + '/practice/flag';
export const ROUTE_PRACTICE_REVIEW = ROUTE_PREFIX + '/practice/review';

/* ------------------------------ 小工具 ------------------------------ */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function sendError(res, code, message, hint) {
  sendJson(res, 200, { ok: false, code: code, error: message, hint: hint || '' });
}

function isCrossSite(headers) {
  return String((headers && headers['sec-fetch-site']) || '').toLowerCase() === 'cross-site';
}

/**
 * 同源代理 pdf.js 的浏览器产物（build / cmaps / standard_fonts / wasm / iccs /
 * image_decoders）。只读、只允许这些目录，路径先 resolve 再确认仍在依赖目录内。
 */
const PDFJS_ASSET_TYPES = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.icc': 'application/octet-stream',
};
const PDFJS_ALLOWED_DIRS = /^(build|cmaps|standard_fonts|wasm|iccs|image_decoders)\//;

function handlePdfjsAsset(req, res) {
  const root = pdfjsRoot();
  if (!root) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const prefix = ROUTE_PDFJS_VENDOR + '/';
  let rel = '';
  try {
    const pathname = new URL(String((req && req.url) || '/'), 'http://localhost').pathname;
    if (!pathname.startsWith(prefix)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    rel = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    res.statusCode = 404;
    res.end();
    return;
  }
  if (!rel || rel.includes('\0') || rel.includes('..') || path.isAbsolute(rel) || !PDFJS_ALLOWED_DIRS.test(rel)) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const resolvedRoot = path.resolve(root);
  const file = path.resolve(resolvedRoot, rel);
  const inside = path.relative(resolvedRoot, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    res.statusCode = 404;
    res.end();
    return;
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    res.statusCode = 404;
    res.end();
    return;
  }
  if (!stat.isFile()) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const type = PDFJS_ASSET_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.statusCode = 200;
  res.setHeader('content-type', type);
  res.setHeader('content-length', String(stat.size));
  res.setHeader('cache-control', 'public, max-age=3600');
  fs.createReadStream(file).pipe(res);
}

function guard(handler) {
  return (req, res) => {
    const headers = (req && req.headers) || {};
    if (isCrossSite(headers)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    Promise.resolve()
      .then(() => handler(req, res, headers))
      .catch((err) => {
        try {
          if (!res.headersSent) sendError(res, 'E_INTERNAL', '服务端出错', String((err && err.message) || err).slice(0, 200));
          else res.end();
        } catch {
          /* 响应已经结束 */
        }
      });
  };
}

/** 把 `/chapter-check @测试书籍` 里的参数解析成绝对目录。 */
function resolveCheckDir(ctx, agent, rawInput) {
  const arg = String(rawInput || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!arg) return '';
  if (path.isAbsolute(arg)) return arg;
  let base = '';
  try {
    const session = agent && agent.session;
    const service = ctx.get && ctx.get('workingDirectory');
    if (session && service && typeof service.get === 'function') base = String(service.get(session) || '');
  } catch {
    base = '';
  }
  return path.resolve(base || process.cwd(), arg);
}

/** 启动清理：超过 24 小时的导入暂存（进程被杀会留下半截解压）。 */
function cleanupImportStaging() {
  const dir = path.join(ROOT, '.import');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of names) {
    const target = path.join(dir, name);
    try {
      const stat = fs.statSync(target);
      if (stat.mtimeMs < cutoff) fs.rmSync(target, { recursive: true, force: true });
    } catch {
      /* 正在清理或被占用，下次再说 */
    }
  }
}

export function apply(ctx) {
  ensureRoot();
  try {
    cleanupImportStaging();
  } catch {
    /* 清理失败不挡插件启动 */
  }
  // 上次 DSH 退出时还在跑的 2.x 作业，重新打开面板要能看到「已中断」而不是永远转圈
  try {
    reconcileAllSeries();
  } catch {
    /* 坏系列不能挡插件启动 */
  }
  // 2.0 M5：清理残留书档 staging、把上次没跑完的配图作业标成 interrupted
  try {
    cleanupStaleImports();
  } catch {
    /* 清理失败不挡启动 */
  }
  try {
    reconcileImageJobs();
  } catch {
    /* 2.0 配图作业归一失败也不能挡启动 */
  }
  try {
    reconcileVoiceJobs();
  } catch {
    /* 2.0 配音作业归一失败也不能挡启动 */
  }
  // FR-27：上次退出时未收口的用量账本 running → interrupted
  try {
    reconcileUsageJobs();
  } catch {
    /* 账本归一失败不能挡启动 */
  }
  // 真书对照命令：跑「目录 → 校准」这条路，按严重程度分类报告
  ctx.inject(['commands'], (scoped) => {
    scoped.commands.register({
      name: 'chapter-check',
      description: '真书对照测试：逐章比对书签，按严重程度分类报告（默认按目录切章，末尾加 mech 改测机械切分）',
      input: { hint: '@数据目录 [mech]' },
      handler: async ({ agent, rawInput, signal }) => {
        const raw = String(rawInput || '').trim();
        const mech = /\s+mech\s*$/i.test(raw);
        const arg = mech ? raw.replace(/\s+mech\s*$/i, '') : raw;
        const root = resolveCheckDir(ctx, agent, arg);
        if (!root) {
          return {
            kind: 'error',
            text:
              '用法：/chapter-check @数据目录 [mech]\n' +
              '数据目录放 PDF；【书签】/【目录页码】txt 可以在同一目录，也可以把环境变量 BOOK_SLIDES_TRUTH_DIR 指到仓库的 test/truth（真值已收进仓库，推荐这样用）。',
          };
        }
        const truthDir = String(process.env.BOOK_SLIDES_TRUTH_DIR || '').trim();
        try {
          const result = await runBookCheck(root, { mode: mech ? 'mech' : 'toc', truthDir: truthDir, signal: signal });
          return { kind: result.summary.serious > 0 ? 'error' : 'success', text: result.text };
        } catch (err) {
          return { kind: 'error', text: '跑不起来：' + String((err && err.message) || err) };
        }
      },
    });
  });

  ctx.inject(['webServer'], (scoped) => {
    const offs = [];
    const route = (path, handler) => {
      offs.push(scoped.webServer.register({ kind: 'exact', path: path, handler: guard(handler) }));
    };

    const routeV2 = (req, res) => {
      routeM1(req, res, new URL(req.url || '/', 'http://localhost'), { ctx }).then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      });
    };

    // 1.x 单讲/目录/进度路由（/reparse、/toc/parse、/generate、/job、/cancel、/module、/progress、/delete）
    // 已全部下线：不再注册同名旧路径，未命中由 routeV2 返回 404。
    route(ROUTE_BOOKS, routeV2);

    route(ROUTE_META, routeV2);
    route(ROUTE_CHAPTERS_BUILD, routeV2);
    route(ROUTE_TRASH, routeV2);
    route(ROUTE_TRASH_RESTORE, routeV2);
    route(ROUTE_STORAGE, routeV2);
    route(ROUTE_PARTS, routeV2);
    route(ROUTE_PART, routeV2);
    route(ROUTE_PART_UPDATE, routeV2);
    route(ROUTE_PLAN_PREVIEW, routeV2);
    route(ROUTE_SERIES, routeV2);
    route(ROUTE_SERIES_PLAN, routeV2);
    route(ROUTE_SERIES_START, routeV2);
    route(ROUTE_SERIES_LECTURE_GENERATE, routeV2);
    route(ROUTE_SERIES_RESUME, routeV2);
    route(ROUTE_SERIES_RETRY, routeV2);
    route(ROUTE_SERIES_JOB, routeV2);
    route(ROUTE_SERIES_CANCEL, routeV2);
    route(ROUTE_SERIES_STITCH, routeV2);
    route(ROUTE_SERIES_STITCH_REPAIR, routeV2);
    route(ROUTE_LECTURE, routeV2);
    route(ROUTE_BRIEFS, routeV2);

    route(ROUTE_BOOK, routeV2);

    route(ROUTE_IMPORT, routeV2);

    route(ROUTE_RENAME, routeV2);

    route(ROUTE_FILE, routeV2);

    route(ROUTE_COVER, routeV2);

    route(ROUTE_CHAPTERS, routeV2);

    route(ROUTE_TOC, routeV2);

    route(ROUTE_TOC_PREVIEW, routeV2);

    route(ROUTE_TOC_RANGE, routeV2);

    route(ROUTE_AUDIO, routeV2);

    route(ROUTE_VOICE, routeV2);

    route(ROUTE_VOICE_PROBE, routeV2);

    route(ROUTE_VOICE_WORKFLOW, routeV2);

    route(ROUTE_VOICE_REFVOICES, routeV2);

    route(ROUTE_VOICE_REFVOICES_IMPORT, routeV2);

    route(ROUTE_VOICE_COMFY_PROBE, routeV2);

    // 2.0 M5：配图 / 练习 / 导出 / 书档由 2.0 接管（1.x 同名处理器不再注册）
    route(ROUTE_IMAGE, routeV2);
    route(ROUTE_IMAGE_CONFIG, routeV2);
    route(ROUTE_IMAGE_WORKFLOW, routeV2);
    route(ROUTE_IMAGE_PROBE, routeV2);
    route(ROUTE_IMAGE_TEST, routeV2);
    route(ROUTE_IMAGE_STATUS, routeV2);
    route(ROUTE_IMAGE_REGEN, routeV2);
    route(ROUTE_IMAGE_CANCEL, routeV2);

    route(ROUTE_PRACTICE_SUMMARY, routeV2);
    route(ROUTE_PRACTICE_BANK, routeV2);
    route(ROUTE_PRACTICE_JOB, routeV2);
    route(ROUTE_PRACTICE_CANCEL, routeV2);
    route(ROUTE_PRACTICE_SESSION, routeV2);
    route(ROUTE_PRACTICE_ANSWER, routeV2);
    route(ROUTE_PRACTICE_EXPLAIN, routeV2);
    route(ROUTE_PRACTICE_FINISH, routeV2);
    route(ROUTE_PRACTICE_FLAG, routeV2);
    route(ROUTE_PRACTICE_REVIEW, routeV2);

    route(ROUTE_PAGES, routeV2);

    route(ROUTE_PREFERENCE, routeV2);

    route(ROUTE_TRASH_CLEAR, routeV2);

    route(ROUTE_EXPORT, routeV2);
    route(ROUTE_EXPORT_SIZE, routeV2);
    route(ROUTE_EXPORT_PPTX_PLAN, routeV2);
    route(ROUTE_EXPORT_PPTX, routeV2);
    route(ROUTE_EXPORT_PPTX_BATCH, routeV2);

    route(ROUTE_IMPORT_PACKAGE, routeV2);
    route(ROUTE_IMPORT_PACKAGE_ACTIVE, routeV2);
    route(ROUTE_IMPORT_PACKAGE_JOB, routeV2);
    route(ROUTE_IMPORT_PACKAGE_CANCEL, routeV2);

    route(ROUTE_REVOICE, routeV2);
    route(ROUTE_PREFIX + '/revoice/job', routeV2);
    route(ROUTE_PREFIX + '/revoice/cancel', routeV2);

    // pdf.js 浏览器产物：前缀路由（worker / cmaps / fonts / wasm 都在这个目录下）
    offs.push(
      scoped.webServer.register({
        kind: 'prefix',
        path: ROUTE_PDFJS_VENDOR,
        handler: guard(handlePdfjsAsset),
      }),
    );

    // 2.0 M4：偏好、系列进度、设置/诊断、升级备份
    route(ROUTE_PREFIX + '/series/progress', routeV2);
    // 2.4 FR-18.2：按系列的播放布局（漏注册会线上 404）
    route(ROUTE_PREFIX + '/series/view', routeV2);
    route(ROUTE_PREFIX + '/settings', routeV2);
    route(ROUTE_PREFIX + '/diagnostics', routeV2);
    route(ROUTE_PREFIX + '/backups', routeV2);
    route(ROUTE_PREFIX + '/backups/delete', routeV2);
    route(ROUTE_PREFIX + '/backups/open', routeV2);
    // FR-27 用量与费用（2.1）：路由必须逐个注册，routeM1 才能收到请求
    route(ROUTE_PREFIX + '/usage/summary', routeV2);
    route(ROUTE_PREFIX + '/usage/jobs', routeV2);
    route(ROUTE_PREFIX + '/usage/job', routeV2);
    route(ROUTE_PREFIX + '/usage/estimate', routeV2);
    route(ROUTE_PREFIX + '/usage/prices', routeV2);

    ctx.on('dispose', () => {
      for (const off of offs) {
        try {
          off();
        } catch {
          /* 卸载时路由可能已随宿主消失 */
        }
      }
    });
  });
}
