/**
 * 章节切分测试（命令行入口）：目录 → 校准 → 落盘。
 *
 *   node test/books.toc.e2e.mjs [数据目录] [--truth <真值目录>] [--baseline]
 *
 * 数据目录放 PDF，默认取仓库旁边的 `测试书籍/`（可用第一个参数或 BOOK_SLIDES_PDF_DIR 覆盖）。
 * 真值默认在数据目录里找；用 --truth 或 BOOK_SLIDES_TRUTH_DIR 指到 test/truth 这种独立目录。
 * --baseline 与真值目录里 books.json 登记的基线比，只报回归（真值没被改、算法没退化就退出 0）。
 *
 * 逻辑都在包根的 check.js 里，和 DSH 命令 /chapter-check 共用同一份实现。
 * 退出码：有严重问题或基线回归 → 1；其它 → 0；跑不起来 → 2。
 */
import path from 'node:path';

import { parseCheckArgs, checkExitCode } from './check-cli.mjs';
import { runBookCheck } from '../check.js';

async function main() {
  const args = parseCheckArgs(process.argv.slice(2), 'toc');
  const result = await runBookCheck(path.resolve(args.dir), {
    mode: 'toc',
    truthDir: args.truthDir,
    baseline: args.baseline,
  });
  console.log(result.text);
  process.exit(checkExitCode(result, args.baseline));
}

main().catch((err) => {
  console.error('跑挂了：' + ((err && err.stack) || err));
  process.exit(2);
});
