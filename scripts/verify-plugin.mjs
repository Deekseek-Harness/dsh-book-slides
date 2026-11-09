#!/usr/bin/env node
/**
 * AC-115 机检：安装形态唯一、路由前缀不变、客户端入口没有 1.x 面板残留。
 *
 *   npm run verify:plugin
 *
 * 只读 package.json 与 v2/api.js / v2/client.js，不启动服务、不改数据；退出码 0/1。
 * “插件列表只有一个「精讲」”属于真机安装行为，脚本只保证包身份与入口唯一，UI 部分列人工边界。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lines = [];
let failed = 0;

function check(label, ok, detail = '') {
  lines.push((ok ? 'PASS ' : 'FAIL ') + label + (detail ? '：' + detail : ''));
  if (!ok) failed += 1;
}

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

const pkg = JSON.parse(read('package.json'));

check('包名唯一', pkg.name === 'dsh-book-slides', pkg.name);
check('版本是合法 2.0 SemVer（正式版或预发布）', /^2\.0\.0(?:-(alpha|beta|rc)\.\d+)?$/.test(String(pkg.version)), pkg.version);
check('没有第二包名/并存模式声明', !pkg.dsh || !pkg.dsh.standalone, 'dsh 字段');

const clientExport = String((pkg.exports && pkg.exports['./client']) || '');
check('客户端入口指向 2.0 面板', clientExport.endsWith('v2/client.js'), clientExport || '（缺）');
check('不再导出 1.x 面板入口', !Object.values(pkg.exports || {}).some((value) => String(value) === './client.js'));

const api = read('v2/api.js');
check('路由前缀固定 /dsh-book-slides', /const PREFIX = '\/dsh-book-slides'/.test(api));
check('2.0 没有 1.x 旧前缀', !/['"]\/book-slides\//.test(api));

const client = read('v2/client.js');
check('客户端只注册一个面板入口', (client.match(/__ModuleLoader__/g) || []).length === 1);
check('没有 1.x 面板残留标记', !/bookSlidesPanelV1|1\.x 面板/.test(client));

for (const line of lines) console.log(line);
console.log('\n结论：' + (failed ? 'FAIL（' + failed + ' 项）' : 'PASS（包身份与入口唯一）'));
console.log('人工边界：真机装包后在插件列表确认只有「精讲」一个入口。');
process.exit(failed ? 1 : 0);
