/**
 * 真书核对脚本（books.*.e2e.mjs）共用的命令行参数。
 *
 *   <数据目录> [--truth <真值目录>] [--baseline]
 *
 * 数据目录默认取仓库旁边的 `测试书籍/`，可用第一个参数或 BOOK_SLIDES_PDF_DIR 覆盖；
 * 真值目录默认留空（表示真值就在数据目录里），用 --truth 或 BOOK_SLIDES_TRUTH_DIR 指到 test/truth。
 * --baseline 打开基线对照（与真值目录里 books.json 的 expect 比），只报回归。
 */
import path from 'node:path';

export function parseCheckArgs(argv, mode) {
  const args = { mode: mode, dir: '', truthDir: '', baseline: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || '');
    if (arg === '--truth') {
      args.truthDir = String(argv[i + 1] || '');
      i += 1;
    } else if (arg.startsWith('--truth=')) {
      args.truthDir = arg.slice('--truth='.length);
    } else if (arg === '--baseline') {
      args.baseline = true;
    } else if (!args.dir) {
      args.dir = arg;
    }
  }
  if (!args.dir) args.dir = process.env.BOOK_SLIDES_PDF_DIR || path.resolve('..', '测试书籍');
  if (!args.truthDir) args.truthDir = process.env.BOOK_SLIDES_TRUTH_DIR || '';
  return args;
}

/** 退出码：--baseline 只看回归；否则有严重问题就 1。 */
export function checkExitCode(result, baseline) {
  const summary = (result && result.summary) || {};
  if (baseline) return summary.baseline && summary.baseline.failed > 0 ? 1 : 0;
  return summary.serious > 0 ? 1 : 0;
}
