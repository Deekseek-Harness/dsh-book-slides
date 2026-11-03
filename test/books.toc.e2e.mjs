/**
 * 章节切分测试（命令行入口）：目录 → 校准 → 落盘。
 *
 *   node test/books.toc.e2e.mjs <数据目录>
 *
 * 逻辑都在包根的 check.js 里，和 DSH 命令 /chapter-check 共用同一份实现。
 * 退出码：有严重问题 → 1；只有警告/通知 → 0；跑不起来 → 2。
 */
import path from 'node:path';

import { runBookCheck } from '../check.js';

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error('用法：node test/books.toc.e2e.mjs <数据目录>');
    process.exit(2);
  }
  const result = await runBookCheck(path.resolve(dir), { mode: 'toc' });
  console.log(result.text);
  process.exit(result.summary.serious > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('跑挂了：' + ((err && err.stack) || err));
  process.exit(2);
});
