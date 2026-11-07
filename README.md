# 精讲台 · dsh-book-slides

DSH 左侧栏的独立面板：把带文字层的 PDF 拆成章节，先确认一个 **Part**，由讲纲规划成 N 讲，
逐讲生成并做可机检的接缝；播放时左侧 PDF 原文、右侧讲稿连播。**2.0 与 1.x 数据不兼容。**

**当前构建：包 `2.0.0-alpha.7` / 产品 `2.0` / 数据 schema `2`**（2026-11-08，M1–M5 完成 + SRS v1.3「音韵平滑」本地 ComfyUI VoiceClone 配音；修复播放中换图导致当前页音频反复重启）。
变更记录 [CHANGELOG.md](CHANGELOG.md) · 实现进度与验收 [doc/2.0-实现进度.md](doc/2.0-实现进度.md) · 需求 [doc/requirements/规范需求2.0.md](doc/requirements/规范需求2.0.md)。

## 2.0 预发布（alpha.7）

> 2.0 是**不兼容重写**：同包名覆盖安装 1.x，同数据根 `~/.dsh/book-slides/`，只认 `meta.json.schema=2`。
> 检测到 1.x 数据时自动把整根备份到同父目录 `book-slides.backup-<时间>/`，随后初始化空书架；**不迁移、不导入**，请重新导入 PDF。
> 回滚：移走同根下的 2.0 数据，把备份目录重命名回 `book-slides/`。

| 项 | 内容 |
|---|---|
| 包版本 | `2.0.0-alpha.7`（tag `v2.0.0-alpha.7`） |
| 产品 / schema | 产品 `2.0`、数据 schema `2`、SRS 文档 v1.6 |
| 已完成 | M1 数据根/导入/分章/书架 · M2 Part/briefs/讲纲 · M3 生成/预缝/后验缝/作业 · M4 播放器/连播/偏好/设置/语音 · M5 书档/练习/配图/导出 PPT/**本地 ComfyUI Qwen3-TTS VoiceClone 配音（参考 voice 库）** · v1.1 子能力（逐页缩略图/配图提示词面板/配音与配图四态按钮/单页换一张/失败可见） |
| 待完成 | M6 真书验收、发布门（AC-92 ~ AC-155）与正式版 `2.0.0` |
| 兼容 | 不读 1.x 数据、不迁移、无独立单讲；1.x 最后版本仍是 1.4.0 |

**2.0 流程（8 步）**

1. 导入 PDF（只入库，不自动分章）。
2. 「生成章节目录」：自动 / 目录 / 机械三选一；目录模式可指定页码范围并校准。
3. 校准章节（起止页、合并、拆分、重命名），保存前校验覆盖与递增。
4. 勾选一组章 →「确认此部分」落 `parts.json`（草稿预览不落盘）。
5. 「预览讲纲」：看 N 讲、页数、时长、接缝句、术语与 `cut_warn`；可对草稿预览。
6. 「保存为系列」→ 系列卡「开始生成讲义」：文本三阶段（不配音），进度可取消/续跑/重试/单讲重跑。
7. 「缝合报告」：六项指标与一键确定性修复；`unstitched` 也可播放。
8. 「继续听」进分屏播放器：左 PDF 视觉版式、右幻灯片，底部逐页缩略图，连播 / 系列目录 / 进度；系列卡「生成配音 / 补配音 / 重新配音」独立配音（Qwen 或浏览器朗读），长按 3s 可强制重配。
9. 「练一练」：先准备题库（按章 4–6 题，异步、可取消），再开场（5–20 题）；判题在本地，答错可点「查看讲解」；错题按 Leitner 复习，关面板可续做。
10. 「导出」：按讲或整套合并导出 PPTX（音频/配图/备注可选，过渡页含讲接缝句），或批量 ZIP；书架/设置可导出书档，换机导入后不需要重新生成。

**2.0 数据布局（同根）**

```
~/.dsh/book-slides/
├── meta.json                ← schema=2
├── preference.json          ← 分隔条/语速/静音/上次位置
├── voice.json               ← 语音配置（0600）
├── image.json               ← 配图配置（策略/地址/风格后缀）
├── comfy-workflow.json      ← ComfyUI 配图工作流
├── comfy-tts-workflow.json  ← ComfyUI 克隆配音工作流（没有就用内置）
├── comfy-tts-refvoices.json ← 参考 voice 库（默认内置 2 项）
├── voices/                  ← 用户导入的参考音频 + 同名 txt
├── audio-cache/             ← TTS 缓存
├── image-cache/             ← 配图缓存
├── trash/<bookId>/          ← 软删除（7 天可恢复）
└── books/<bookId>/
    ├── book.json / pages.json / source.pdf / cover.svg
    ├── chapters.json / parts.json / briefs.json
    ├── practice/{questions.json, mastery.json, sessions/}
    └── series/<seriesId>/
        ├── series.json / stitch.json / progress.json
        └── lectures/<n>/{lecture.json, slides.json, audio/…, images/…}
```

**2.0 验证**

```powershell
npm run test:v2     # 20 个文件 / 99 项，0 失败
```

覆盖 M1–M5：数据根与升级备份、导入/分章、Part/讲纲、逐讲生成/接缝、播放器、设置/偏好/诊断、语音与独立配音（Qwen 云端 / ComfyUI 本地 / 浏览器）、书档往返/冲突/批量、练习组卷/判题/讲解/复习、ComfyUI 配图、按讲/整套/批量导出 PPT、长任务取消、回收站冲突。ComfyUI TTS 的设置页导入/连接/试听/参考切换已手工验证；完整逐页配音与真书、真 Qwen、真 ComfyUI 全流程验收在 M6。

## 1.x 使用说明（包 1.4.0 / 功能阶段 v1.6，冻结）

> 以下是 1.4.0 的说明，保留用于回滚与对照。2.0 的安装命令相同（同包名覆盖安装），但数据与交互以本节之前的内容为准。

1.x 最后版本 **包 1.4.0 / 功能阶段 v1.6**（2026-11-04，含 v1.2 语音、v1.3 书档、v1.4 本地 ComfyUI 配图、v1.5 导出 PPT 与 v1.6 练习与复习；阶段号 ≠ 包版本）。变更记录见 [CHANGELOG.md](CHANGELOG.md)。

v1.6「练习与复习」：按章出题、模式驱动补题、即时判题、答错按需讲解、错题按遗忘节奏复习；数据落在 `practice/`，随书档一起走。

## 为什么做这个

一本 500 页的技术书或剧本，读起来的成本不在「读」，在「找不到重点」和「读完就忘」。
精讲台把书拆成章，按你勾的 1–5 章生成 6–30 页精讲：每页有标题、要点、视觉提示词、朗读稿，
并把每页回填到原文页码和摘抄。播放时左边 PDF 跟着翻页、摘抄高亮，右边讲稿同步朗读——
想核对原话就看左边，想听讲解就听右边。

它和「书库」类插件是两套东西：独立面板、独立数据目录（`~/.dsh/book-slides/`）、零代码依赖，卸载互不影响。

## 能做什么

| 模块 | 能力 |
|---|---|
| 书架 | 拖拽/点选导入、首页渲染封面、改名、软删除进回收站、占用统计与清理 |
| 切章 | 两条路径：页眉机械切分（回退）与目录驱动切分（模型读目录 + 页码校准 + 抽查）；来源常驻可见，防静默覆盖 |
| 生成 | 勾 1–5 章 → 分块改写 → 结构校验 → 锚点回填 → 配音；异步作业、进度、取消、断点续跑、失败重试、同章幂等复用 |
| 播放 | 左 PDF 视觉版式 + 摘抄高亮，右 16:9 幻灯片；自动翻页、快捷键、进度持久化、「继续听」、无配音页降级 |
| 语音 | Qwen3-TTS 云端 WAV / 本地 ComfyUI Qwen3-TTS VoiceClone（默认克隆工作流 + 参考 voice 库）/ 浏览器本机朗读 / 关闭；Key 只存本机、面板只显示后 4 位；音频缓存不重复计费 |
| 配图 | 默认只出提示词占位；可选本地 ComfyUI（IP+端口、导入 API 工作流）后台逐页出图，失败页回退提示词，不阻断文字与语音 |
| 导出 | 单模块 → 一个 `.pptx`：每页画面 + 页内配音 + 台词备注；缺音频 / 缺配图逐页降级，确认层显示页数、音频页、配图页与体积 |
| 练习 | 按章出题（考点来自精讲讲点、出处回填原文）；宿主即时判题，多选全对才算对；答错按需生成讲解并写回题库；**只有一个「开始练习」**，缺题时按模式先补题（确认后执行，每章 +5，补到 count/过半），混合模式新题 >50%；Leitner 5 盒 + 错题本；下发题目不含答案 |
| 运维 | 回收站清理、`/chapter-check` 真书对照命令、面板显示插件版本 |

**v1.0 不包含**：暗色主题、无障碍完整审计、诊断日志、跨机器真机验收。这四项是 M5 的剩余打磨；
v1.0 里的 M5 只包含两条体验修复（书架菜单点外部关闭、生成后自动定位到「生成中」条目），详见 CHANGELOG。

## 安装

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

再把 `dsh-book-slides` 从 profile `package.json` 的 `bundles` 里删掉。书与模块数据留在
`~/.dsh/book-slides/`，不会跟着删；要彻底清掉就手动删这个目录。

## 上手

1. 点「导入 PDF」，或把 PDF 直接拖进面板。导入读完文字层会自动切章，然后进入书籍详情。
2. 详情页能看章数、页码范围、每章字数，也能「打开 PDF」翻原件。
3. 切章不准时：点右上角「按目录切章」，填目录页码范围（会预填猜测值），模型读目录后校准页码；
   或者点「重新解析」按页眉重切（只读本地逐页文本，不重传 PDF）。列表上方会写明这次结果来自目录还是页眉。
4. 勾 1–5 章，点底部「生成精讲」。进度条依次走「改写文案 → 校验结构 → 定位原文 → 准备配音」，
   条目右侧可以取消；生成完自动进分屏播放器。
5. 播放器里点「开始听」：有 Qwen WAV 就播音频文件，没有就由本机浏览器朗读当前页，读完自动翻页。
   左侧原文窗格跟着 `source_pages` 换页，摘抄段落高亮并滚进视野。
6. 拖中间分隔条调左右比例（记进 `preference.json`）；底部缩略图可跳页；
   `空格` 播放/暂停、`←/→` 翻页、`F` 全屏、`Esc` 退出全屏或返回。
7. 关掉面板再打开，书架卡片上出现「继续听 · 第 N 页」，点它回到上次位置，**不会自动播放**。
8. 模块行或播放器点「导出 PPT」：确认层会显示页数、含音频页数、配图页数与预估体积，可去掉音频；
   下载后每页有画面，进入自动播放，点喇叭可重播，台词写在备注里。
9. 模块行点「练习」或播放器点「练一练」：首次会先按章出题（异步，约几十秒），然后逐题作答；
   提交即判，答错后几秒内出讲解，点「第 N 页 · 看原文」回到播放器对应页；答完看正确率与错题，
   之后从详情页「复习」按遗忘节奏再练；新题不够时直接点「开始练习」，会先问你是否补题（每章 +5，补到本次题量或混合过半）。

生成是异步作业：点一次立刻返回，关掉面板再打开还能看到「已中断 / 已取消 / 失败」并重试。
同一组章节重复点「生成精讲」会直接秒开已有模块，不会重复花模型调用。

## 语音

设置页「语音」有四档：

| 供应商 | 要配什么 | 产物 | 适合 |
|---|---|---|---|
| Qwen3-TTS | API Key、模型（默认 `qwen3-tts-flash`）、音色（48 个非实时系统音色） | 每页 `audio/NNN.wav` | 想听云端音色 |
| 本地 ComfyUI（Qwen3-TTS） | 地址（默认 `127.0.0.1:8188`，与配图共用）、克隆工作流、参考 voice 库 | 每页 `audio/NNN.<ext>`（wav/flac/mp3/ogg） | 想用本机 GPU / 自定义音色与讲法 |
| 浏览器本机朗读 | 音色、语速 | 不产生文件，播放时 `speechSynthesis` | 零成本、无需 Key |
| 关闭 | — | 只出文字 | 只想看 |

- Key 存在 `voice.json`（0600），**面板只显示末 4 位**，不写日志、不写进模块 JSON 或 URL；
  `GET /voice` 只返回 `apiKeyMask`，空输入不会覆盖旧 Key，要清空得点「清除」。
- 生成时 Qwen 逐页合成（并发 2、单页超时 60s、失败重试 1 次）；音频按
  `sha256(provider|model|voice|language_type|text)` 缓存在 `audio-cache/`，同文同音色不重复计费。
- 缺 Key 或某页失败只让模块降级 `ready_degraded`，文字照常出，**不会自动回退浏览器**。
- 费用与限额由千问平台控制；插件只在下发当下下载音频，不保存过期 URL。
- **本地 ComfyUI（Qwen3-TTS）**：v1.3 起默认是 **VoiceClone 克隆**——工作流 `workflows/qwen3-tts-通过克隆配音/`（API 格式：`LoadAudio → FB_Qwen3TTSVoiceClone → SaveAudio`），内置参考 `Vivian` / `Uncle Fu` 两组（flac + 同名 txt），每页只替换 `target_text`，并把 `(参考音频, 参考文本)` 注入请求；**换参考不重写工作流**。
- ComfyUI 的地址与配图共用 `image.json`；配音与配图共用**全局串行队列**，同一时间只跑一个 ComfyUI 作业。设置页提供「连接测试」（只读 `/system_stats` + `/object_info`）与「试听测试」（真跑一次，不落盘/不缓存）。
- 参考是**成对资产**：`ref_text` 必须是参考音频的逐字转写，与目标正文无关；`x_vector_only` 必须为 `false`（为 `true` 只克隆说话人、参考文本失效，导入时会 `E_TTS_WORKFLOW_NODE` 拒绝）。参考音频会经 `/upload/image` 上传到 ComfyUI 的 `input/`，按 sha256 去重。
- ComfyUI 输出可能是 `.flac`/`.ogg`：播放器可直接播；导出 PPT 只嵌 `.wav`/`.mp3`，其它格式给 warning 并提示把工作流输出改成 `SaveAudio`（`audio_format=wav`）。

> Qwen3-TTS 走 `/api/v1/services/aigc/multimodal-generation/generation`，`input` 只放
> `text` / `voice` / `language_type`；不要加 `format`、`sample_rate`（会 400）。
> 旧的 `audio/*.mp3` 仍兼容，播放器优先找 `.wav`。

## 配图（可选本地 ComfyUI）

设置页「配图」有两档策略，默认第一档，不装 ComfyUI 的人零感知：

| 策略 | 要配什么 | 产物 | 说明 |
|---|---|---|---|
| 提示词占位（默认） | — | 只出 `image_prompt` | 播放器右侧配图卡可查看、复制提示词 |
| 本地 ComfyUI | IP + 端口（默认 `127.0.0.1:8188`）、工作流（可选，默认内置 Z-Image Turbo） | 每个正文页 `images/NNN.png` | 模块先就绪，配图在后台逐页补，不耽误听 |

- **只给正文页出图**：封面与引文页保持纯排版；尺寸沿用工作流（默认 1024×1024，按卡片裁切）。
- **出图不阻塞**：模块状态仍是 `ready` / `ready_degraded`；单页失败只让该页回退提示词占位，
  模块上会出现「补配图」按钮，播放器里也能单页「换一张」。
- **工作流只收 API 格式**：ComfyUI 里用「保存（API 格式）」导出 JSON。插件会自动找
  `KSampler.positive` 链上的 `CLIPTextEncode` 作为提示词节点；有多个候选时面板让你选一次。
- **模型要自备**：默认工作流需要 `z_image_turbo_bf16.safetensors`、`qwen_3_4b.safetensors`、
  `ae.safetensors`；设置页「测试连接」会读 `/object_info` 检查缺哪些。
- **两个测试入口**：「测试连接」只查版本与模型；「测试生图」用当前工作流真跑一张并在面板预览，
  显示耗时/种子，可下载。测试图**不落盘、不进缓存、不写模块**；提示词策略下会提示先切 ComfyUI，
  补图作业在跑时会提示稍后再试。
- **可复现 + 缓存**：seed 由提示词与工作流哈希派生，同提示词命中 `image-cache/`，重生成模块不重复跑 GPU；
  单页「换一张」会递增 `image_nonce` 换新种子。单页超时 180s、单模块总预算 15 分钟。
- **网络边界**：浏览器不直连 ComfyUI，宿主取图落盘后由同源 `/image` 提供。IP 填的不是
  `127.0.0.1` 时，提示词会发到那台机器上（设置页有提示）。

## 导出 PPT（v1.5）

模块行或播放器里的「导出 PPT」把一个精讲模块导出为 16:9 的 `.pptx`。一页精讲对应一页 PPT：

| 部分 | 落在哪 |
|---|---|
| 演示页面 | 幻灯片：标题、要点或引文、可选配图，米色底 + 宋体标题，原生文本框（可改字） |
| 声音媒体 | 幻灯片右下角、页码上方的喇叭对象；音频文件嵌入 PPT 本体，**进入该页自动播放**，点喇叭可重播 |
| 底部的台词 | 该页备注（`notesSlide`），文本 = 该页 `audio_script` 原文；放映时观众看不到 |

- **自动播、手动翻页**：每页进入时 `playFrom(0.0)`；不加自动换页，讲完点一下/按方向键翻页。点喇叭可重播。
- **PowerPoint 2010+ / WPS 12.1**：音频嵌入用 `p14:media`；timing 用 WPS 自己生成的
  `nodeType="withEffect"` + `p:audio` 结构，PowerPoint 也识别为 `mediacall`。不兼容更早版本。
- **只读**：不调 LLM / TTS / ComfyUI，不改 `slides.json` / `module.json`，不落临时文件。
- **缺音频就跳过**：只有真实存在且通过 WAV 头校验的 `.wav`（兼容旧 `.mp3`）才嵌；浏览器朗读 / 关闭语音
  的页没有文件，确认层会显示「X/Y 页含音频」。导出**不会**为了补声音去调 TTS。
- **缺配图就留白**：只嵌 `image_status=ready` 的页；无图时正文占满整宽，不留空图位，也不把提示词印上去。
- **可用性**：`.pptx` 直接下载，不落盘；确认层可勾掉「含音频」。单文件上限 150MB、导出目标 ≤15 秒。
- **接口**：`GET /export/pptx/plan?moduleId=` 先返回页数 / 音频页 / 配图页 / 体积 / 警告；
  `GET /export/pptx?moduleId=&audio=1|0` 流式返回 PPTX。错误码 `E_PPT_*` 见 SRS 附录 B。

## 数据在哪

全在本机，默认 `~/.dsh/book-slides/`（可用 `DSH_BOOK_SLIDES_ROOT` 改）：

```
book-slides/
├── voice.json                     ← 语音配置（0600；Qwen Key 只存这里）
├── image.json                     ← 配图策略 / ComfyUI 地址 / 提示词节点
├── comfy-workflow.json            ← 用户导入的配图工作流（没有就用内置默认）
├── comfy-tts-workflow.json        ← 用户导入的克隆配音工作流（没有就用内置）
├── comfy-tts-refvoices.json       ← 参考 voice 库（默认内置 2 项）
├── voices/                        ← 用户导入的参考音频 + 同名 txt
├── preference.json                ← 分隔条比例、语速、静音
├── progress.json                  ← {lastBookId, lastModuleId, lastSlide}
├── audio-cache/<sha256>.<ext>     ← 语音缓存（云端 wav / ComfyUI wav|flac|mp3|ogg）
├── image-cache/<sha256>.png       ← ComfyUI 出图缓存（提示词+工作流+种子）
├── trash/<bookId>-<时间戳>/      ← 删除是挪进这里，不是真删
└── books/<bookId>/
    ├── book.json                 ← 书名、页数、sha256（存在即导入完成）
    ├── source.pdf                ← 原件副本
    ├── pages.json                ← 逐页原始文本
    ├── chapters.json             ← 切章结果
    ├── toc.json                  ← 目录范围与解析结果（可选）
    ├── modules/<moduleId>/
    │   ├── module.json           ← 状态、阶段、错误码、缓存键、语音、配图汇总
    │   ├── slides.json           ← 规范化幻灯片（含 source_anchor / audio_ms / image_*）
    │   ├── image-job.json        ← 后台配图作业的进度快照（可选）
    │   ├── batches/              ← 生成中的批次检查点，成功后自动删除
    │   ├── audio/001.wav …       ← Qwen 合成（浏览器朗读时为空）
    │   └── images/               ← ComfyUI 出图（只给正文页）
    │       └── 002.png           ← 当前配图
    └── practice/                 ← v1.6 练习与复习
        ├── questions.json        ← 题库（全书按章索引；讲解懒填充）
        ├── mastery.json          ← 每题掌握状态（box / due_at / attempts）
        ├── explain-cache/<hash>.json  ← 「再讲讲」缓存（不入书档）
        └── sessions/<sessionId>.json  ← 场次：计划 + 作答 + 汇总
```

隐私边界：PDF、逐页文本、讲稿、音频、配图、题库与作答记录都只落在上面这个目录；插件不主动外发任何内容。
联网只发生在五处——调 LLM 生成讲稿、调千问合成语音、调你指定的 ComfyUI 出图、调你指定的 ComfyUI 配音、出题与答错时生成讲解
（都只在用户点按钮时发生）；ComfyUI 地址不是 `127.0.0.1` 时，提示词、朗读稿与**当前参考音频/参考文本**会发到局域网那台机器。
答错时发给模型的是该题题干、你的选择、正确项与原文片段，不发整场记录。没有遥测、没有云端同步。

## 已知限制

- **只认带文字层的 PDF**：扫描件在导入阶段就被拒（`E_PDF_NO_TEXT`），不会建一本空书。
- **源文件的 OCR 错字改不了**：这份 PDF 的文字层本身就把「剪辑」写成「剪镭」、「鉴别」写成「签别」。
  标题会投票选出现次数最多的写法，多数能选对；全书都写错的那种没法救。
- **机械切章有已知边界**：一章首页整行乱码时会从下一页页眉起算，少算一页；页眉把「第31章」写成
  「第3章」靠章号序列修；分部重新编号的书目前不区分。改用「按目录切章」可以绕开大部分。
- **真值核对不是全绿**：`npm run test:truth` 当前一致 92/109、14 处严重，集中在《导演创作完全手册》的
  双栏简目（12 处）与《普林斯顿微积分读本》第 24、26 章。这是脚本里极简目录解析器的边界，
  产品路径用模型读目录。逐本明细与原因见 [test/truth/README.md](test/truth/README.md)。
- **页数硬约束 6–30**：模型给少了先整套重写一次，仍不合规报 `E_LLM_SCHEMA`；给多了同样重写，不静默截断。
- **锚点可能失配**：`source_quote` 不是原文连续子串时标 `unanchored`，不判死整个模块，播放按页定位、不高亮。
- **pdf.js 资源同源转发**：module / worker / cmaps / standard_fonts / wasm 由插件从依赖目录转发
  （`/dsh-book-slides/vendor/pdfjs/`），不往仓库里复制第三方文件；首次打开模块会加载 worker。
- **移动端**：播放器 < 1024px 时上下堆叠，不保证手机竖屏比例。
- **换音色/模型只影响新生成**：缓存键不含音色，已有模块要按新音色重做需点「重生成」（会重跑 LLM）。
- **配图缓存不自动清理**：`image-cache/` 按提示词+工作流+种子积累；换提示词后会留下旧图，需要时手动删目录。
- **ComfyUI 要自己装**：插件不含 ComfyUI、模型与自定义节点。默认工作流需要 Z-Image Turbo 的三件套；
  缺模型时「测试连接」会列出来，生成时逐页降级为提示词占位。
- **工作流只支持 API 格式**：界面格式（含 `nodes` / `links`）会被拒绝；识别不到 `CLIPTextEncode`
  时导入会失败，不会悄悄用错节点。
- **中文提示词配非 Z-Image 工作流可能偏弱**：`image_prompt` 按原样发送，不额外翻译；
  接 SDXL/Flux 这类英文编码器时出图质量取决于模型本身。
- **导出 PPT 的字体是宋体**：与面板的 `Noto Serif SC` 不完全一致，也不嵌字体；这是为了在
  Windows PowerPoint 与 WPS 上稳定打开。目标机缺字体会由 PowerPoint 自行替换。
- **PPT 只保证 Windows PowerPoint 2010+ 与 WPS**：Mac PowerPoint 尽力，Google Slides 通常不保留导入的嵌入音频。
- **浏览器朗读 / 关闭语音的模块导出后没有声音**：导出不补配音、不调用 TTS；确认层会报「X/Y 页含音频」。
- **自动播与翻页停止按各软件默认媒体行为**：PowerPoint 16 与 WPS 12.1 已验证每页自动播、点喇叭重播；
  翻页时是否强制停止由软件决定，本版不做额外 timing。
- **练习只做客观题**：单选 / 多选 / 判断；简答、填空、跨章综合题不做。多选全对才算对。
- **讲解首次生成要联网**：答错后生成一次（目标 ≤8s）并写回题库，同题再错秒出；离线时只显示正确答案与原文。
- **题库按章生成、按模式补题**：每章首批 4–6 题；缺题时「开始练习」先确认再补（每章 +5，单书上限 300）；混合模式新题必须 >50%，只练新题补到所选题量；没有精讲覆盖的章不能出新题。

## 开发

零构建：`index.js` 是普通 ESM，2.0 面板 `v2/client.js` 走 `window.__ModuleLoader__.load`，改完重启 DSH（或刷新面板）生效。

```powershell
cd dsh-book-slides
npm install
npm run test:v2   # 2.0 门禁
npm test          # 1.4.0 冻结套件，仅作 1.x 回归参考
```

> 2.0 替换了同名路由与数据模型，`npm test`（1.x）从 M1 起不再与当前实现一致；2.0 的验收以 `npm run test:v2` 与 [doc/2.0-实现进度.md](doc/2.0-实现进度.md) 为准。

| 测试 | 跑什么 |
|---|---|
| `npm run test:v2` | **2.0 门禁**：全量测试 —— 数据根/分章、Part/讲纲、生成/接缝、播放器、设置/偏好、语音/配音、ComfyUI 克隆配音/工作流/参考库、系列删除、路由唯一注册 |
| `node test/smoke.test.mjs` | 纯逻辑：正则、清洗、切章、存储、PDF 读取 |
| `node test/server.test.mjs` | 起真服务：导入/书架/书封/Range/改名/删除 + 原文页/偏好/回收站清理 + pdf.js 资源转发 |
| `node test/panel.test.mjs` | react-dom/server 渲染：书架、详情、生成进度、幻灯片舞台、PDF 窗格、高亮几何、播放器首屏 |
| `node test/toc.test.mjs` | 目录解析、校准、抽查、分卷/前言不成章 |
| `node test/toc-llm.test.mjs` | 假模型走真路由：思考吃光 token、JSON 不合格、重试预算 |
| `node test/check.test.mjs` | 真书对照报告的偏移/遗漏分类 |
| `node test/slides.test.mjs` | 分块、页数/字段校验、锚点归一化、朗读时长（纯函数） |
| `node test/generate.test.mjs` | 假模型走真路由：四阶段、修复、锚点修复、取消、超时、幂等、重试复用、播放进度 |
| `node test/practice.test.mjs` | 假模型走真路由：按需出题与缓存、补题计划、组卷不下发答案、宿主判题、讲解沉淀、错题与到期复习、标记坏题、书档删除后重导、扩题 |
| `node test/session.test.mjs` | 组卷配额/混合过半与收缩、补题计划、判题、Leitner 调度、单题校验、去重、讲解缓存键（纯函数） |
| `node test/tts.test.mjs` | Qwen 配置、Key 掩码、WAV 时长、逐页合成、缓存、部分失败 |
| `node test/qwen.test.mjs` | 假千问服务走真路由：试听、6 页 WAV 落盘、缺 Key、部分失败、缓存、错误 Key |
| `node test/package.test.mjs` | 书档导入/导出：ZIP 往返、只读、幂等、合并、手改保留、篡改/穿越拦截、批量 |
| `node test/comfy.test.mjs` | 配图配置默认值、默认工作流识别、API/界面格式校验、提示词与种子、假 ComfyUI 出图与缺模型 |
| `node test/imaging.test.mjs` | 后台配图作业：只给正文页出图、落盘与状态回写、`/image` 取图、force 换图、失败降级、重启归一、测试生图 |
| `node test/image-auto.test.mjs` | 生成 → 自动起配图作业：模块先 ready，5 张正文页图随后落盘 |
| `node test/pptx.test.mjs` | PPTX 生成器：部件齐全、页序、备注、音频嵌入/自动播 timing、配图关系与字节、无音频、缺图、XML 转义、裁切 |
| `node test/pptexport.test.mjs` | 导出计划：页数/音频页/配图页、缺页、只读、非 RIFF、文件名、HTTP 下载 |

`npm test` 当前 250 项：248 通过、2 项按环境跳过（真书样本没设），0 失败。

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

**单本生成冒烟**（导入真 PDF，假模型从原文挑长句当摘抄，验分块与锚点回填）：

```powershell
node test/books.gen.e2e.mjs "..\测试书籍\911780342-故事-材质-结构-风格和银幕剧作的原理-罗伯特-麦基.pdf" 2
```

**解析规则改后**：点开这本书「重新解析」，只读本地逐页文本重切，不重传 PDF；缓存与来源见
[doc/requirements/规范需求.md](doc/requirements/规范需求.md) 附录 F。

> 在 Windows 沙箱里 `node --test` 会因为要 fork 子进程报 EPERM，所以测试统一用 `node test/xxx.mjs` 直接跑。

## 文档

| 文件 | 内容 |
|---|---|
| [CHANGELOG.md](CHANGELOG.md) | 版本变更、测试基线、已知限制 |
| [doc/2.0-实现进度.md](doc/2.0-实现进度.md) | 2.0 M1–M4 进度、AC 证据、已知缺口与下一步 |
| [doc/requirements/规范需求2.0.md](doc/requirements/规范需求2.0.md) | 2.0 SRS：Part/讲/系列、接缝、功能对等、发布门 |
| [doc/requirements/2.0 版本关于“接缝”的探索.md](doc/requirements/2.0%20版本关于“接缝”的探索.md) | 接缝探索稿 v0.8（历史存档） |
| [doc/requirements/规范需求.md](doc/requirements/规范需求.md) | v1.0 基线 + v1.1–v1.6 附录（目录切章、语音、书档、配图、PPT 导出、练习与复习） |
| [doc/requirements/PPT导出-需求审阅.md](doc/requirements/PPT导出-需求审阅.md) | v1.5 导出 PPT 的评审过程、选项与已拍板默认值（已并入 SRS，仅存档） |
| [doc/requirements/练习-需求审阅.md](doc/requirements/练习-需求审阅.md) | v1.6 练习与复习的评审过程与决策 D51–D61（已并入 SRS，仅存档） |
| [doc/requirements/初步需求.md](doc/requirements/初步需求.md) | 最初一版需求原文（历史存档） |
| [test/truth/README.md](test/truth/README.md) | 真值语料、基线数字、已知缺口 |
| [prompts/](prompts/) | 目录抽取与幻灯片生成的提示词（版本号进缓存键） |
| [doc/qwen/](doc/qwen/) | 千问语音接口与音色表的抓取存档 |
| [doc/z_image/](doc/z_image/) | 默认 ComfyUI 工作流（Z-Image Turbo，API 格式） |

## 许可

MIT，见 [LICENSE](LICENSE)。
