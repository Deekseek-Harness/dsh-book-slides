# 精讲台 · dsh-book-slides

DSH 左侧栏的独立面板：把带文字层的 PDF 拆成章节，先确认一个 **Part**，由讲纲规划成 N 讲，
逐讲生成并做可机检的接缝；播放时默认左侧讲稿、右侧 PDF 原文（可一键左右换位，布局按系列记忆）。**2.0 与 1.x 数据不兼容。**

**当前构建：包 `2.7.0-alpha.2` / 产品 `2.5` / 数据 schema `2`**（2026-11-12 发布 2.7.0-alpha.2：修复 must_keep 误报与质量面板语义；2.7.0-alpha.1 为 3.0 信息密度/结构修复 alpha；2.6.0 用量历史时间筛选与「其他」分组折叠；`test:v2` 全绿）。
变更记录 [CHANGELOG.md](CHANGELOG.md) · 实现进度与验收 [doc/3.0-实现进度.md](doc/3.0-实现进度.md) · 需求 [doc/requirements/规范需求3.0.md](doc/requirements/规范需求3.0.md)。

## 2.7 系列（当前 2.7.0-alpha.2）

### 2.7.0-alpha.2 must_keep 误报修复（2026-11-12）

> 修复 2.7.0-alpha.1 质量面板的“内容待核对/真实缺失”误报：节标题 Unicode 减号/全角空格归一化、审计纳入 `quote_source`、别名补 `左右不等`/`正无穷`/`函数值`、同页多个 must_keep 按页分组补讲不再互相覆盖；新增 `POST /lecture/quality/recheck` 与「重新审计」，把“真实缺失”改为“自动未覆盖”、“内容待核对”改为“内容告警”。对已生成系列重新审计后 `content_ok` 可恢复 true。

### 2.7.0-alpha.1 信息密度/结构修复 alpha（2026-11-11）

> 3.0 能力的 alpha 包：briefs 全文+书签、leaf 节树与预算内自主分页、页级 `section`/`page_role`、短 `must_keep` + 语义别名、`content_ok`/`density_ok` 审计、书签刷新（`POST /book/outline/refresh`）、质量/密度面板、节页预览、planned/actual 分离。包仍走 2.x SemVer（`2.7.0-alpha.1`），产品版本保持 `2.5`，数据 schema 仍为 `2`；3.0 正式版再升。

## 2.6 系列（历史）

### 2.6.0 用量历史时间筛选与「其他」分组折叠（2026-11-11）

> 恢复 v1.21 承诺、2.1 未落地的 FR-27.6 两项能力，并修正时间显示口径；接口、数据文件与 schema 零变更。历史页新增**时间筛选**：全部时间 / 近 7 天 / 近 30 天 / 本月 / 自定义起止日期，最小粒度 1 天；复用既有 `from`/`to`（`YYYY-MM-DD`），按本地日闭区间解释，`from > to` 时就地提示且不发请求。**「其他」默认分组折叠**：全部类型下其他记录归入列表末尾「其他（N 条）」分组，默认收起，组头条数取同一范围的 `/usage/summary.byKind`，不受 500 条列表上限影响；类型选「其他」时平铺。列表与详情时间改按本地时区显示到分钟，`host/usage.js` 的日界改为本地日，使「本月」卡片与列表一致。

## 2.5 系列（历史）

### 2.5.1 用量历史详情内联展开（2026-11-11）

> 修复版本，纯客户端呈现层：设置 → 用量与费用 → 查看历史的条目点击后，详情**紧贴该条目下沿行内展开**，不再固定到列表底部。同一时刻只展开一条；点同条收起、点另一条收旧开新；面板内「收起」、`Esc`、点列表/页面空白都能收起；点详情内部不收起，工具栏与确认弹窗不触发外部收起。展开行与详情面板用浅/深 accent 底色分层，带顶部分隔与左侧 accent 条；加载/错误/重试与迟到响应保护一并补齐。接口、数据文件与 schema 零变更。

### 2.5.0 设置页顶栏标签切换（2026-11-11）

> 纯客户端呈现层升级，接口、数据文件与 schema 零变更：设置页从六栏瀑布流改为**顶部横向标签栏 + 单栏内容区**（`语音` / `模型（只读）` / `配图` / `用量与费用` / `存储与回收站` / `诊断`），默认「语音」；活动标签用共享下划线指示条滑动（180–220ms），`prefers-reduced-motion` 下取消动效。`sessionStorage`（`blm-settings-tab`）记住本会话最后栏目，刷新页面仍停在原栏目；六个面板全部挂载、非活动 `hidden`，切换不丢未保存输入也不重复请求。标签栏滚动吸顶、窄屏单行横向滚动、活动标签自动滚入；`role=tablist/tab/tabpanel` + `aria-selected`，`←/→` 循环、`Home/End` 首尾。离开「语音」标签停止试听，生成中离开则完成后只置为可播放、不在后台出声。

## 2.4 系列（历史）

### 2.4.0 播放页左右换位（2026-11-10）

> 功能增量，数据 schema 与 HTTP 契约保持兼容：播放器默认 **幻灯片在左 / PDF 原文在右**，顶栏「⇄ 换位」一键对调，不刷新、不重建音频、不回页首。布局**按系列**记忆：方向与原文宽度写进该系列的 `series/<id>/view.json`（新接口 `GET/POST /series/view`），A 系列换位不影响 B 系列；老系列没有记录时按默认方向 + 全局 `preference.split` 渲染，首次操作才落盘。`split` 表示原文窗格宽度占比，换位只换位置不改宽度；窄屏（<1040px）隐藏换位入口、堆叠顺序仍是上幻灯片 / 下原文。`view.json` 属本机视图状态，不入书档，导入后回默认布局。

## 2.3 系列（历史）

### 2.3.0 播放页字幕（2026-11-10）

> 功能增量，数据 schema 与 HTTP 契约保持兼容：播放器右列幻灯片舞台卡下方只读展示当前页 `audio_script` 原文；随翻页/换讲切换，暂停/语速/静音不改变文本；封面/引文页同样显示。字幕只认 `audio_script`，不截断、不加前缀、不取封面 `subtitle`；空稿不渲染，长英文/命令行长串强制换行。不设焦点、不绑快捷键，不改变播放/键盘/配图面板行为；随右列滚动，不常驻（矮窗口需滚动）。

## 2.2 系列（历史）

### 2.2.1 切回窗口播放修复（2026-11-10）

> 无功能、数据 schema、HTTP 契约变更：修复窗口重新聚焦时播放“卡一下 + 重播最后几个字”。原因是焦点刷新无条件清空当前讲缓存，导致正在播的音频被销毁重建，并按滞后的 `positionRef` 回跳；现在改为先拉 `/lecture` 比对、内容没变就不动音频，确需重建时用 `audio.currentTime` 续上，`focus`/`visibilitychange` 去抖 300ms。切回仍会刷新 `/lecture` 与 `/series`，注入/手工改数据照常可见。

### 2.2.0 播放器暂停粒度（2026-11-10）

> 功能增量，数据 schema 与 HTTP 契约保持兼容：播放器“暂停/继续”从页粒度改为**当前页音频的媒体时间**。暂停保存 `offset_ms`，继续从该秒接着播；离开播放页/重启 DSH 从 `progress.json` 恢复；显式翻页/换讲从 0；语速/静音不重置位置；重新配音后音频身份不一致则旧位置失效；浏览器朗读不支持精确续播、按页重播。`progress.json` 追加 `offset_ms` 与音频身份（`audio_file`/`audio_ms`/`audio_provider`），旧文件缺字段按 0/空，不迁移。修复初始 hydration 两帧导致“页对、秒丢”。

## 2.1 系列（历史）

### 2.1.4 预览窗格居中（2026-11-10）

> 无功能、数据 schema、HTTP 契约变更：当前页缩略图由“刚好可见”改为滚到窗格正中（±2px 死区不滚）；首末页与总页数不足一屏时夹紧到边界，不靠留白强制置中。键盘、点击与播放自动翻页一致，播放仍受手动横滚后 5 秒让位约束。

### 2.1.3 预览窗格跟随翻页（2026-11-10）

> 无功能、数据 schema、HTTP 契约变更：播放器底部逐页缩略图在键盘 ←/→ 或播放自动翻页后自动滚动到当前页；用户手动横向滚动后让位 5 秒（播放翻页暂不抢滚动，键盘/点击仍立即跟随），让位结束若当前页不可见补滚一次。

### 2.1.2 并发写入修复（2026-11-10）

> 无功能、数据 schema、HTTP 契约变更：修复配音与配图作业并发写回时互相覆盖 `slides.json` / `series.json` 字段的问题（表现为“已配音变未配音”或配图丢失）。改为按 `lecture n + slide_index` 读-改-写，配图只合并 `image_*`，配音只合并 `audio_*` / `voice_*`。

### 2.1.1 清理版（2026-11-10）

> 无功能、数据 schema、HTTP 契约变更，可直接覆盖安装 2.1.0：移除 1.x 代码与旧套件，共享内核迁入 `lib/`，`v2/` 拆为 `host/` + `client/`，并修复 pdf.js 静态资源 `E_INTERNAL` 回归。

> 2.1 在 2.0 基础上新增 **AI 用量与费用统计（FR-27）**；包名、数据根、`meta.json.schema=2` 不变，可覆盖安装 2.0.0。

> 2.0 是**不兼容重写**：同包名覆盖安装 1.x，同数据根 `~/.dsh/book-slides/`，只认 `meta.json.schema=2`。
> 检测到 1.x 数据时自动把整根备份到同父目录 `book-slides.backup-<时间>/`，随后初始化空书架；**不迁移、不导入**，请重新导入 PDF。
> 回滚：移走同根下的 2.0 数据，把备份目录重命名回 `book-slides/`。

| 项 | 内容 |
|---|---|
| 包版本 | `2.7.0-alpha.2`（tag `v2.7.0-alpha.2`；alpha.1 为 3.0 能力 alpha，alpha.2 为质量误报修复；2.6/2.5/2.4/2.3/2.2/2.1 基线保留） |
| 产品 / schema | 产品 `2.5`、数据 schema `2`、SRS 文档 v3.0 |
| 发布状态 | 2026-11-12 发布 2.7.0-alpha.2；`npm run test:v2` 全绿；`npm run verify:plugin` 通过 |
| 2.7.0-alpha.2 修复 | 节标题 Unicode 归一化、`quote_source` 审计、别名补全、同页多 must_keep 分组、`/lecture/quality/recheck`、质量面板文案与“重新审计” |
| 2.7.0-alpha.1 新增 | 3.0 信息密度/结构修复：briefs 全文+书签、leaf 节树/自主分页、页级 section/page_role、must_keep 语义/别名、content_ok/density_ok、书签刷新、质量面板、节页预览、planned/actual 分离；schema 仍 2 |
| 2.6.0 新增 | 用量历史时间筛选（全部/近 7 天/近 30 天/本月/自定义，日粒度、本地日闭区间）与「其他」默认分组折叠（组头计数）；列表/详情本地时间显示、`from`/`to` 本地日界；不改接口契约/数据/schema |
| 2.5.1 新增 | 用量历史条目内联展开：详情紧贴条目下沿、单开互斥、点空白/`Esc`/「收起」收起、详情与概览行分层、加载/错误与竞态处理；纯客户端呈现层，不改接口/数据/schema |
| 2.5.0 新增 | 设置页顶栏标签切换：六栏目单栏展示、共享下划线指示条动效、`sessionStorage` 会话记忆、键盘与 ARIA tabs、窄屏横向滚动；纯客户端呈现层，不改接口/数据/schema |
| 2.4.0 新增 | 播放页原文/幻灯片左右换位：默认 PPT 左 / 原文右；方向与原文宽度按系列记忆（`view.json` + `/series/view`）；换位不打断播放、不改宽度；窄屏隐藏入口；不改 `series.json` / `progress.json` / 数据 schema |
| 2.3.0 新增 | 播放页字幕：右列舞台卡下方只读展示当前页 `audio_script`；随翻页切换，空稿不渲染，长文本换行；不改播放/键盘/数据契约 |
| 2.2.1 修复 | 切回窗口不再断音/回退重播：焦点刷新先拉后换，内容没变不重建音频；确需重建用 `currentTime` 续上；focus/visibilitychange 去抖 |
| 2.2.0 新增 | 播放器暂停/继续改为页内媒体时间粒度：暂停存 `offset_ms`，离开/重启恢复；显式翻页从 0；语速/静音不回页首；音频身份失效；`progress.json` 追加 offset + 音频身份 |
| 2.1.4 优化 | 预览窗格当前页改为“尽量居中”：中间页居中、首末页与不足一屏夹紧、2px 死区不滚 |
| 2.1.3 修复 | 预览窗格：键盘/播放翻页后当前页缩略图自动滚入可视区；手动横滚后让位 5 秒，键盘/点击仍立即跟随 |
| 2.1.2 修复 | 配音/配图并发写回改为按 `lecture n + slide_index` 字段合并；配图与配音各管各的字段，并补并发回归 |
| 2.1.0 新增 | FR-27 AI 用量与费用统计：云端 LLM tokens / TTS 字符 / 生图张数记账，本地调用不计；作业前预估、结束后摘要、历史可浏览；`usage/` 账本 + `/usage/*` 接口 + 设置「用量与费用」组 |
| 已完成 | M1 数据根/导入/分章/书架（**v1.17 书签树/根章/单根下移/Part 只选根**） · M2 Part/briefs/讲纲 · M3 生成/预缝/后验缝/作业 · M4 播放器/连播/偏好/设置/语音 · M5 书档/练习/配图/导出 PPT/**本地 ComfyUI Qwen3-TTS VoiceClone 配音（参考 voice 音频 + `.txt` 成对导入）** · M6 真书/真机抽检与发布门 · P0–P2 作业态恢复/长任务取消/目录范围、导入策略与 view 持久化 · v1.1 子能力（逐页缩略图/配图提示词面板/配音与配图四态按钮/单页换一张/失败可见） · 2.2 暂停粒度与切回播放修复 · 2.3 播放页字幕 · 2.4 播放页左右换位（按系列布局） · 2.5 设置页顶栏标签切换 · 2.5.1 用量历史详情展开 · 2.6 用量历史时间筛选与「其他」分组折叠 |
| 兼容 | 不读 1.x 数据、不迁移、无独立单讲；1.x 最后版本仍是 1.4.0 |

**2.5 流程（沿用 2.4/2.3/2.2/2.1/2.0）**

1. 导入 PDF（只入库，不自动分章）。
2. 「自动分章」：书签 → 印刷目录 → 机械切章级联。书签原样导入为树，只把根层作为章；单根时提示是否下移一层，由你决定。
3. 校准章节：书签来源只改根标题/起止页（子节点只读）；目录/机械来源可合并/拆分/重命名。保存前校验起止递增与不重叠。
4. 勾选一组**根章** →「确认此部分」落 `parts.json`（Part 只选根；草稿预览不落盘）。
5. 「预览讲纲」：看 N 讲、页数、时长、接缝句、术语与 `cut_warn`；可对草稿预览。
6. 「保存为系列」→ 系列卡「开始生成讲义」：文本三阶段（不配音），进度可取消/续跑/重试/单讲重跑。
7. 「缝合报告」：六项指标与一键确定性修复；`unstitched` 也可播放。
8. 「继续听」进分屏播放器：默认左幻灯片、右 PDF 视觉版式（顶栏「⇄ 换位」可对调，方向与宽度按系列记住），底部逐页缩略图，连播 / 系列目录 / 进度；系列卡「生成配音 / 补配音 / 重新配音」独立配音（Qwen 或浏览器朗读），长按 3s 可强制重配。
9. 「练一练」：先准备题库（按章 4–6 题，异步、可取消），再开场（5–20 题）；判题在本地，答错可点「查看讲解」；错题按 Leitner 复习，关面板可续做。
10. 「导出」：按讲或整套合并导出 PPTX（音频/配图/备注可选，过渡页含讲接缝句），或批量 ZIP；书架/设置可导出书档，换机导入后不需要重新生成。

**2.4 数据布局（同根，schema=2）**

```
~/.dsh/book-slides/
├── meta.json                ← schema=2
├── preference.json          ← 分隔条/语速/静音/上次位置
├── voice.json               ← 语音配置（0600）
├── image.json               ← 配图配置（策略/地址/风格后缀）
├── comfy-workflow.json      ← ComfyUI 配图工作流
├── comfy-tts-workflow.json  ← ComfyUI 克隆配音工作流（没有就用内置）
├── comfy-tts-refvoices.json ← 参考 voice 表（内部存储；导入后生成，没有就用内置 2 项）
├── voices/                  ← 导入的参考音频（与 .txt 一起导入时复制到这里）
├── audio-cache/             ← TTS 缓存
├── image-cache/             ← 配图缓存
├── usage/jobs/<jobId>.json  ← AI 用量账本（2.1；不入书档）
├── usage/prices.json        ← 价格表 + priceVersion
├── usage/config.json        ← 本地/不计费 provider 标记
├── trash/<bookId>/          ← 软删除（7 天可恢复）
└── books/<bookId>/
    ├── book.json / pages.json / source.pdf / cover.svg
    ├── chapters.json / parts.json / briefs.json
    ├── practice/{questions.json, mastery.json, sessions/}
    └── series/<seriesId>/
        ├── series.json / stitch.json / progress.json / view.json
        │   （progress.json：lecture/slide/offset_ms + 音频身份；view.json：该系列的布局 layout + 原文宽度 split，2.4）
        └── lectures/<n>/{lecture.json, slides.json, audio/…, images/…}
```

**2.5.1 验证**

```powershell
npm run test:v2     # 43 个文件 / 398 项，0 失败
```

**2.6 验证**

```powershell
node test/v2-usage-ui.test.mjs   # AC-178 ~ AC-179：范围/校验/分组/本地时间
node test/v2-usage.test.mjs      # 本地日界、summary 仍含 other
npm run test:v2                  # 43 个文件 / 403 项，0 失败
```

2.6 覆盖：时间预设与自定义日期、非法范围不请求、组头计数与展开/收起、列表与详情本地时间、`from`/`to` 本地日界；接口契约、`usage/*` 数据与 schema 不变。

覆盖 M1–M6：数据根与升级备份、导入/分章、Part/讲纲、逐讲生成/接缝、播放器、设置/偏好/诊断、语音与独立配音（Qwen 云端 / ComfyUI 本地 / 浏览器）、书档往返/冲突/批量、练习组卷/判题/讲解/复习、ComfyUI 配图、按讲/整套/批量导出 PPT、长任务取消、回收站冲突、版本一致性与 1.x 基线登记。2.3 播放页字幕（FR-18.1）与 2.4 左右换位（FR-18.2）由 `test/parity-player.test.mjs`、`test/parity-settings.test.mjs` 覆盖；2.5 设置页标签切换（AC-172 ~ AC-174）由 `test/parity-settings.test.mjs` 覆盖；2.5.1 用量历史条目内联展开（AC-175 ~ AC-177）由 `test/v2-usage-ui.test.mjs` 覆盖。ComfyUI TTS 的设置页导入/连接/试听/参考切换已手工验证；真书、真 Qwen、真 ComfyUI 全流程与发布门已在 M6 复核（记录见 [doc/2.0-实现进度.md](doc/2.0-实现进度.md) §8）。

## 1.x 文档（已归档）

1.x 已冻结，代码与数据迁移都不再提供；其使用说明、数据布局与已知限制见 [doc/legacy-1.x.md](doc/legacy-1.x.md)。

## 安装（2.x）

**前置条件**

| 项 | 要求 | 实测 |
|---|---|---|
| DSH | `engines.dsh` ≥ 0.2.0-rc.2 | 0.2.1-rc.5 |
| Node.js | ≥ 20 | 24 |
| PDF | 必须带文字层（OCR 过的）；扫描件会被拒 | — |
| Qwen Key | 可选；不填就用浏览器朗读 | — |

**Windows 一键装**（把本地目录链进 `web` profile，并把包名写进 `dsh.profile.bundles`）：

```powershell
cd <本目录>
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

**手动装**（效果相同）：

```powershell
dsh plugin --profile web add "<本目录>"
```

`dsh plugin add` 会把包名写进 profile `package.json` 的 `dsh.profile.bundles`，不用手改。
装完**重启 DSH**，左侧栏出现「精讲」图标。重复执行安装是安全的。

**卸载**：

```powershell
dsh plugin --profile web remove dsh-book-slides
```

再把 `dsh-book-slides` 从 profile `package.json` 的 `bundles` 里删掉。书与系列数据留在
`~/.dsh/book-slides/`，不会跟着删；要彻底清掉就手动删这个目录。

## 开发

零构建：`index.js` 是宿主入口，`host/` 放 Node 侧实现，`client/index.js` 是浏览器面板（走 `window.__ModuleLoader__.load`），`lib/` 是版本无关的共享内核；改完重启 DSH（或刷新面板）生效。

```powershell
cd dsh-book-slides
npm install
npm test          # 2.x 门禁（等同 npm run test:v2）
```

> 1.x 的旧套件已随 1.x 代码在 P1 删除；仍有价值的纯函数测试（分章/PDF/目录/幻灯片/对照/TTS/ComfyUI/PPTX/练习调度）已并入 `test:v2`。

| 测试 | 跑什么 |
|---|---|
| `npm run test:v2` | **2.x 门禁**：共享内核纯函数 + 2.0–2.5 全量 —— 数据根/分章、Part/讲纲、生成/接缝、播放器、设置/偏好/标签栏、语音/配音、ComfyUI 克隆配音/工作流/参考 voice 库、系列删除、练习/配图/导出/书档、用量、路由归属与宿主可达 |
| `node test/smoke.test.mjs` | 纯逻辑：行重建、清洗、机械切章、PDF 读取 |
| `node test/toc.test.mjs` | 目录解析、校准、抽查、分卷/前言不成章 |
| `node test/slides.test.mjs` | 分块、页数/字段校验、锚点归一化、朗读时长（纯函数） |
| `node test/check.test.mjs` | 真书对照报告的偏移/遗漏分类 |
| `node test/tts.test.mjs` | Qwen 配置、Key 掩码、WAV 时长、缓存 |
| `node test/comfy.test.mjs` | 配图配置默认值、默认工作流识别、API/界面格式校验 |
| `node test/pptx.test.mjs` | PPTX 生成器：部件、页序、备注、音频嵌入、配图关系 |
| `node test/session.test.mjs` | 组卷配额、判题、Leitner 调度、去重、讲解缓存键（纯函数） |

`npm test` 现在就是 2.x 门禁（`npm run test:v2` 的别名）。

**真值核对**（需要本地 PDF，PDF 不进仓库）：

```powershell
npm run test:truth        # 目录驱动，与 test/truth/books.json 的基线比
npm run test:truth:mech   # 机械切分，同样只报回归
```

默认 PDF 目录是仓库旁边的 `../测试书籍/`；PDF 在别处时：

```powershell
$env:BOOK_SLIDES_PDF_DIR = 'D:\books'
node test/books.toc.e2e.mjs --truth test/truth --baseline
```

在 DSH 里跑同一套逻辑：

```
/chapter-check @D:\books mech
```

把环境变量 `BOOK_SLIDES_TRUTH_DIR` 指到本仓库的 `test/truth`，命令就会用收进仓库的真值与清单。

**改了解析规则**：在该书详情点「自动分章」重新构建章节（2.x 的 `/chapters/build`）；1.x 的「重新解析」入口已下线。

> 在 Windows 沙箱里 `node --test` 会因为要 fork 子进程报 EPERM，所以测试统一用 `node test/xxx.mjs` 直接跑。

## 文档

| 文件 | 内容 |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | 版本变更、测试基线、已知限制 |
| [doc/2.0-实现进度.md](doc/2.0-实现进度.md) | 2.0 M1–M6 进度、AC 证据、发布门记录与已知缺口 |
| [doc/requirements/规范需求2.0.md](doc/requirements/规范需求2.0.md) | 2.x SRS：Part/讲/系列、接缝、功能对等、发布门；v1.25 含 2.3 播放页字幕（FR-18.1） |
| [doc/requirements/暂停粒度-需求规范化.md](doc/requirements/暂停粒度-需求规范化.md) | v1.23 播放器暂停/继续的页内媒体时间粒度：D1=B / D2=A、AC-166 与实现记录；随 2.2.0 发布 |
| [doc/requirements/2.0 版本关于“接缝”的探索.md](doc/requirements/2.0%20版本关于“接缝”的探索.md) | 接缝探索稿 v0.8（历史存档） |
| [doc/requirements/规范需求.md](doc/requirements/规范需求.md) | v1.0 基线 + v1.1–v1.6 附录（已归档；当前需求见 2.0 SRS） |
| [doc/legacy-1.x.md](doc/legacy-1.x.md) | 1.x 使用说明、数据布局与已知限制（归档，仅回滚对照） |
| [doc/requirements/PPT导出-需求审阅.md](doc/requirements/PPT导出-需求审阅.md) | v1.5 导出 PPT 的评审过程、选项与已拍板默认值（已并入 SRS，仅存档） |
| [doc/requirements/练习-需求审阅.md](doc/requirements/练习-需求审阅.md) | v1.6 练习与复习的评审过程与决策 D51–D61（已并入 SRS，仅存档） |
| [doc/requirements/初步需求.md](doc/requirements/初步需求.md) | 最初一版需求原文（历史存档） |
| [test/truth/README.md](test/truth/README.md) | 真值语料、基线数字、已知缺口 |
| [prompts/](prompts/) | 目录抽取与幻灯片生成的提示词（版本号进缓存键） |
| [doc/qwen/](doc/qwen/) | 千问语音接口与音色表的抓取存档 |
| [doc/z_image/](doc/z_image/) | 默认 ComfyUI 工作流（Z-Image Turbo，API 格式） |

## 许可

MIT，见 [LICENSE](LICENSE)。

