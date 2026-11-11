# 验证 1：briefs 全文 + 书签节标题

- 日期：2026-11-11
- 数据：`测试书籍/普林斯顿微积分读本(修订版)-2016-中文版.pdf` 第 1 章（book `ak5ywpl4x5q4`，series `g91nwrt7el`，lecture 1）
- 基线：`验证1/baseline/`
- 结果：`验证1/after/`（最终，已做术语确定性修复）；`验证1/after-prerepair/`（修复前，术语门禁为 unstitched）
- 指标：`验证1/metrics.json`

## 0. 一句话结论

**假设 1 成立，但不充分。** briefs 只读每章前 6,000 字、且不带书签子标题，确实是“讲纲只认识 1.1、重点偏移”的直接原因；改成全文 + 13 个书签小节后，讲纲标题/goal/terms 和 slides 的 1.2–1.6 覆盖明显改善。但只改 briefs 不够：讲纲仍然是一句 goal，页数仍是 11 页，生成只能做零和取舍——后面修好了 1.2.2 / 1.4 / 1.5 / 1.6 指数对数，前面却丢掉了 1.1.1 区间、1.1.2 求定义域规则、1.3 平移，1.1.3 和 1.6 有理仍缺。

## 1. 改了什么

| 文件 | 改动 |
|---|---|
| [host/briefs.js](../../../host/briefs.js) | 每章不再固定 `slice(0, 6000)`；单章上限 6 万字、整个 Part 上限 30 万字（本测试章 21,069 字全文进入）。新增 `bookmarkSectionsOf(book, chapter)`，从 `book.json.bookmarkTree` 递归取本章子标题，作为 `bookmark_sections` 送入模型。`sections` 支持“正文或书签”双源校验；落盘前把书签标题补进 `sections`（最多 24 条）。`gist` 上限 100→200。新增 `BRIEFS_VERSION` / `input_key` 缓存键。 |
| [prompts/briefs-v1.md](../../../prompts/briefs-v1.md) | 输入说明增加 `bookmark_sections` / `truncated`；要求 `sections` 优先用书签、最多 16 条；`gist` 必须覆盖本章所有二级小节，不能只写第一节。 |
| [host/generate.js](../../../host/generate.js) | 批检查点 hash 加入讲纲契约（`goal/in/out/throughline/terms`），否则改了讲纲，旧批仍会命中，新讲纲进不了已生成的页。 |
| [scripts/verify-briefs.mjs](../../../scripts/verify-briefs.mjs) | sections 机检支持书签标题，避免把 `1.1　函数` 这类书签写法误报为 MISS。 |

为什么还改 `generate.js`：验证 1 要验证“新 briefs → 新 plan → 新 slides”。如果批检查点仍只按原文 hash，旧批会直接复用，新讲纲根本到不了模型；这个改动是让实验有效，不是实验变量本身。

## 2. 怎么跑的

当前 3080 进程仍缓存旧 host 模块（插件管理器 reload 没有替换 linked package 的 host 代码）。为了不重启用户正在用的 3080，使用**同一数据根**临时启动 3090：

```
dsh web --port 3090 --no-open
```

在 3090 上：

1. `POST /dsh-book-slides/series/plan {seriesId:"g91nwrt7el", force:true}`，强制重建 briefs + plan。
2. `POST /dsh-book-slides/series/start {seriesId:"g91nwrt7el"}`，启动第 1 讲生成。
3. 轮询 `GET /series/job?seriesId=g91nwrt7el` 到 `ready`。
4. 对术语误伤做一次确定性修复：`POST /series/stitch/repair {targets:["term"]}`（不调模型）。
5. 关闭 3090。

3080 与 3090 共用 `~/.dsh/book-slides`，所以 3080 刷新后能看到新数据；但 **不要在 3080 上再次点击“重新生成”**，它仍是旧代码，会用 6,000 字 briefs 覆盖新结果。重启 DSH 后 3080 才会加载新代码。

## 3. briefs / 讲纲的变化

| 项 | 基线 | 验证 1 |
|---|---|---|
| briefs sections | 5 条（1.1–1.1.4） | **13 条**（1.1–1.6 + 1.2.x） |
| briefs 输入 tokens | 4,244 | **10,463** |
| plan 输入 tokens | 386 | 501 |
| 讲纲标题 | `第 1 讲 函数、图像和直线：从定义域到垂线检验` | `第 1 讲　函数、图像与直线：从定义域到常见函数图像` |
| 讲纲 goal | 只覆盖 1.1 | 函数概念/定义域/值域/图像检验 + 反函数/复合/奇偶/线性/常见函数 |
| terms | 4 个 | **13 个** |
| plan warnings | 无 | 无（`plan_source=model`） |

新 goal 原文：

> 系统复习函数的概念、定义域与值域、图像检验，并掌握反函数、函数复合、奇偶性、线性函数与常见函数图像。

新 terms：定义域、上域、值域、垂线检验、反函数、水平线检验、限制定义域、函数的复合、奇函数、偶函数、线性函数、点斜式、两点式。

briefs 的 `gist` 已经明确写到“区间表示、求定义域、借图像求值域、反函数、复合、奇偶、线性、多项式、二次配方、有理函数、指数与对数、绝对值”。**briefs 侧的结构信息已经到位。**

## 4. slides 的变化：修好后面，丢掉前面

| 小节 | 基线 | 验证 1 | 判断 |
|---|---|---|---|
| 1.1.1 区间表示法 | 1 条要点 + 口播 | **0 次“区间”** | 回归 |
| 1.1.2 求定义域 | 分母/偶次根/对数/交集 4 条 | **0 条求法**（只有“定义域”概念） | 回归 |
| 1.1.3 利用图像求值域 | 无独立页 | 无独立页 | 仍缺 |
| 1.1.4 垂线检验 | 有 | 有 | 保持 |
| 1.2.1 水平线检验 | 有 | 有 | 保持 |
| 1.2.2 求反函数 | 0 | **1 条方法：由 y=f(x) 解出 x** | 修复 |
| 1.2.3 限制定义域 | 有 | 有 | 保持 |
| 1.2.4 反函数的反函数 | 有 | 有 | 保持 |
| 1.3 函数的复合 | 有 + `f(x-a)` 平移 | 有，**0 次“平移”** | 部分回归 |
| 1.4 奇偶 | 1 页 quote | **1 页内容，4 条要点** | 改善 |
| 1.5 线性函数 | 1 页 | **2 页** | 改善 |
| 1.6 多项式/二次 | 有 | 有 | 保持 |
| 1.6 有理函数 | 0 | **0 次“有理”** | 仍缺 |
| 1.6 指数/对数 | 0 | **各 3 次** | 修复 |
| 1.6 绝对值 | 有 | 有 | 保持 |

关键解释：**讲纲的 goal 仍然是一句摘要，terms 是模型自选，页数仍是 11 页。** 模型为了给反函数、奇偶、线性、常见函数腾页，把 1.1 的基础操作（区间、求定义域限制）和 1.3 的平移挤掉了。briefs 里有的词，只要 plan 的 goal/terms 没接住，生成就不会写。这就是“briefs 修好了输入，但讲纲没有节级必覆盖清单”的下一个瓶颈。

## 5. 密度指标

| 指标 | 基线 | 验证 1 |
|---|---|---|
| 新增讲义字数（标题+要点+引文+口播+quote_source） | 1,970 | **2,319（+17.6%）** |
| 字段上限 | 4,624 | 4,624 |
| 字段使用率 | 42.6% | **50.2%** |
| 口播总字 | 1,238 | 1,446 |
| 要点总字 | 507 | 592 |
| 整章 ρ（净字 17,156 / 讲义） | 8.71 | **7.40** |
| 整章 ρ（原始字 21,069 / 讲义） | 10.96 | **9.31** |
| stitch ρ（锚点页口径） | 5.74 | 5.65 |
| 页数 | 11 | 11 |
| `source_pages` 覆盖 | 10/20 页 | 10/20 页 |
| `source_pages` 漏掉的净字 | 7,995 | 8,243 |

注意：

- 模型确实写多了，ρ 从 8.71 降到 7.40，但仍高于文档的 4.5 警戒线；11 页 + 每页 420 字实际上限，结构下限仍在 3.7–4.6。
- stitch 的 5.65 仍是“锚点页口径”：它只对 11 页 `source_pages` 求和，漏掉 10 页；整章口径是 7.40。`coverage=100%` 仍只查“讲纲章集合”，不查 slides 是否覆盖章内小节。**指标依然看不见 1.1.1/1.1.2/1.6 有理的丢失。**
- 结论：ρ 可以改善，但 ρ 不等于覆盖率；验证 2 必须按小节验收，不能只看 ρ。

## 6. 副作用：术语表误伤

验证 1 的讲纲 terms 把 `限制域` 列为 `限制定义域` 的禁用写法，但生成页 7 自己用了“限制域”，导致 stitch 变成 `unstitched`。这是计划生成的术语表自相矛盾，不是内容错误。跑了一次确定性 term 修复（`repairStitch(targets:["term"])`，不调模型），把“限制域”替换为“限制定义域”，状态恢复 `verified`：

- 修复前：`验证1/after-prerepair/stitch.json`（`state=unstitched`）
- 修复后：`验证1/after/stitch.json`（`state=verified`）

## 7. 判定

| 问题 | 判定 |
|---|---|
| briefs 只读 6,000 字是否造成重点偏移？ | **是。** 修后 plan 的标题/goal/terms 从 1.1 扩展到 1.2–1.6。 |
| 只改 briefs 是否足够？ | **不够。** 1.1.1、1.1.2 求法、1.3 平移、1.1.3、1.6 有理仍丢；讲纲没有节级必覆盖清单和页预算。 |
| 密度是否改善？ | 有改善（ρ 8.71→7.40，利用率 42.6%→50.2%），但仍高；11 页是硬约束。 |
| 指标是否可靠？ | stitch ρ / coverage 仍不能反映小节丢失，只能做辅助。 |

## 8. 验证 2 建议

验证 2 应该只改“讲纲的节级结构 + 页预算”，不要同时改 briefs/模型，否则无法归因：

1. 讲纲 lectures 增加 `sections[]`：每节 `{title, pages, must_keep[]}`；由书签子标题 + brief 的 sections 确定性生成，不依赖模型自由发挥。
2. 页数改为 `max(字数/2000, sections.length + 1)`：本章 13 节 → 至少 14 页；每节至少 1 页；1.6 这种多概念节可给 2 页。
3. 生成 prompt 注入 `【本讲必覆盖小节】` 和 `【本批覆盖小节】`（按批的页范围/文本范围映射），并要求“本批每个小节至少一条要点或口播”；同时注入 `【已覆盖小节】`，防止批间重复。
4. 生成后按小节验收：每节至少在 title/bullet/audio/quote 中出现一次；先修 1.1.1、1.1.2、1.1.3、1.6 有理，再看总 ρ。

预期：验证 2 会把页数从 11 提到 14 左右，1.1 的基础操作和 1.6 有理有机会回来；如果仍丢，说明问题在“单节内容量/模型取舍”，需要继续拆讲或加页。

## 9. 复现步骤

```powershell
# 1. 临时 3090（同一 DSH_HOME / 同一数据根）
dsh web --port 3090 --no-open

# 2. 重建 briefs + plan
POST http://127.0.0.1:3090/dsh-book-slides/series/plan
{ "seriesId": "g91nwrt7el", "force": true }

# 3. 生成
POST http://127.0.0.1:3090/dsh-book-slides/series/start
{ "seriesId": "g91nwrt7el" }

# 4. 轮询
GET http://127.0.0.1:3090/dsh-book-slides/series/job?seriesId=g91nwrt7el

# 5. 术语确定性修复
POST http://127.0.0.1:3090/dsh-book-slides/series/stitch/repair
{ "seriesId": "g91nwrt7el", "targets": ["term"] }
```

## 10. 产物

| 路径 | 内容 |
|---|---|
| `验证1/baseline/briefs.json` | 基线 briefs（5 条 sections） |
| `验证1/baseline/series.json` | 基线讲纲（1.1 重点） |
| `验证1/baseline/slides.json` | 基线 11 页 |
| `验证1/baseline/stitch.json` | 基线 stitch（verified） |
| `验证1/after/briefs.json` | 验证 1 briefs（13 条 sections，带 `input_key`/`version`） |
| `验证1/after/series.json` | 验证 1 讲纲（13 terms，整章 goal） |
| `验证1/after/slides.json` | 验证 1 最终 11 页（术语修复后） |
| `验证1/after/stitch.json` | 验证 1 最终 stitch（verified） |
| `验证1/after-prerepair/` | 术语修复前的 slides/stitch（unstitched） |
| `验证1/metrics.json` | 基线/验证 1 指标与小节覆盖表 |
