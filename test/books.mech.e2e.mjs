/**
 * 机械切分测试（命令行入口）：纯页眉切章，不读目录。
 *
 *   node test/books.mech.e2e.mjs [数据目录] [--truth <真值目录>] [--baseline]
 *
 * 参数与 books.toc.e2e.mjs 相同：数据目录默认仓库旁边的 `测试书籍/`，
 * 真值可用 --truth / BOOK_SLIDES_TRUTH_DIR 指到 test/truth。
 *
 * 逻辑都在包根的 check.js 里。退出码：有严重问题或基线回归 → 1；其它 → 0；跑不起来 → 2。
 */
import path from 'node:path';

import { parseCheckArgs, checkExitCode } from './check-cli.mjs';
import { runBookCheck } from '../check.js';

async function main() {
  const args = parseCheckArgs(process.argv.slice(2), 'mech');
  const result = await runBookCheck(path.resolve(args.dir), {
    mode: 'mech',
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
