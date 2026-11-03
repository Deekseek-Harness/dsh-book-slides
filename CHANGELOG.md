# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
需求基线冻结在 [doc/requirements/规范需求.md](doc/requirements/规范需求.md)（v1.0），行为变化记在这里。

## [1.3.0] - 2026-11-04

v1.5「导出 PPT」：把一个已就绪的精讲模块导出为可直接放映的 `.pptx`，每页包含演示画面、该页配音（页内媒体对象）与台词（备注）。

### 新增

- **导出计划**：`GET /export/pptx/plan?moduleId=` 返回页数、含音频页数、含配图页数、缺页清单、体积预估与警告；
  只接受 `ready` / `ready_degraded`，生成中报 `E_PPT_BUSY`，其它状态报 `E_PPT_NOT_READY`，空模块报 `E_PPT_EMPTY`。
- **流式导出**：`GET /export/pptx?moduleId=&audio=1|0` 直接流式写 PPTX，不落临时文件；WAV/PNG 用 store，
  单文件上限 150MB；`content-disposition` 同时给 ASCII fallback 与 UTF-8 文件名。
- **PPTX 生成器**：`pptx.js` 生成 `presentation.xml`、逐页 slide、逐页 notes 与媒体关系；
  母版 / 版式 / 主题 / notesMaster 取自 `assets/pptx-template.pptx`（PowerPoint 生成的空白 16:9 模板），
  音频图标为 `assets/audio-icon.png`。
- **三部分**：画面用原生文本框 / 形状（封面、要点、引文三种版式，米色底 + 宋体标题）；音频嵌为
  `a:audioFile` 媒体对象（右下角、页码上方），进入页面自动播放、点喇叭可重播；台词写入 `notesSlide`，
  逐字等于该页 `audio_script`。
- **逐页降级**：没有音频文件、或 `.wav` 不是 RIFF/WAVE 的页跳过音频；`image_status != ready` 的页不嵌图，
  正文占满整宽；缺页在计划里报数，不阻断导出。
- **面板入口**：播放器控制条与模块行各一个「导出 PPT」；确认层显示页数 / 音频页 / 配图页 / 体积，
  可勾掉「含音频」；下载走 `fetch` + blob，错误以 JSON 回显，不把错误页当文件下载。

### 修复

- **PowerPoint 报「无法定位链接的多媒体文件」**：音频对象补齐 `p:cNvPr/a:hlinkClick action="ppaction://media"`、
  `p:nvPr` 的 `p14:media r:embed`，以及同一 WAV 的 `.../audio` 与
  `http://schemas.microsoft.com/office/2007/relationships/media` 两条关系。此前只有 `a:audioFile r:link`，
  PowerPoint 会当外链去找 `ppt\media\audio1.wav`；WPS 会回退到包内关系。
- **WPS 12.1 不自动播**：timing 按 WPS 自己生成的音频页结构：`nodeType="withEffect"`、
  `p:cTn id="6" dur="音频时长"`、`p:audio/p:cMediaNode`（`repeatCount="indefinite"`、
  `showWhenStopped="1"`、`onPrev` / `onStopAudio`）。`showWhenStopped="1"` 让喇叭播完仍可见，保留手动重播；
  不加 `p:transition`，保持手动翻页。
- **关系编号**：音频 `rId3`、media `rId4`、图标 `rId5`、正文配图 `rId6`；音频 `blip` 用图标，不占配图关系。

### 变更

- `package.json` 版本 1.3.0；发布清单新增 `pptx.js`、`pptexport.js`、`assets/*`。
- `slides.json` / `module.json` 结构不变；导出全程只读，不调用 LLM / TTS / ComfyUI。
- SRS 新增 FR-10、附录 O 与 AC-60 ~ AC-70；§2.2 非目标从「导出 PDF/HTML/PPT 成品」改为「导出 PDF/HTML 成品、MP4/视频」。

### 测试基线

| 项 | 结果 |
|---|---|
| `npm test`（16 套） | 228 项：**226 通过 / 2 跳过（无真书样本） / 0 失败** |
| 新增 | `test/pptx.test.mjs` 7 项（部件 / 页序 / 备注 / 音频嵌入与自动播 timing / 转义 / 裁切）、`test/pptexport.test.mjs` 7 项（计划 / 只读 / 非 RIFF / 时长 / 文件名 / HTTP 下载），`panel.test` 补 1 项导出层 |
| 真机 | PowerPoint 16：音频 `LinkFormat.SourceFullName` 为空，`Timeline.MainSequence` 识别为 `mediacall`（type 83）；WPS 12.1：自动播与点喇叭重播由用户真机验收通过 |

### 已知限制

- **字体**：PPT 用宋体、不嵌字体；与面板的 `Noto Serif SC` 不完全一致，缺字体会由 PowerPoint 替换。
- **兼容**：只保证 Windows PowerPoint 2010+ 与 WPS 12.1；Mac PowerPoint 尽力，Google Slides 通常不保留导入的嵌入音频。
- **没声音的模块**：浏览器朗读 / 关闭语音的模块导出后没有音频，导出不会补配音；确认层会报「X/Y 页含音频」。
- **播放行为**：PowerPoint 16 与 WPS 12.1 均按目标结构验证（用户真机）；每页自动播、点喇叭重播正常。
  翻页时是否强制停止仍按各软件默认，本版不加额外 timing。
- **真机待复核**：30 页真实长音频的体积与耗时（当前 30 页 0.5s 测试音频 890KB、53ms）。

## [1.2.0] - 2026-11-04

v1.4「本地 ComfyUI 配图」：配图从「只出提示词」扩成两档策略，默认行为与以前完全一致。

### 新增

- **配图策略**：`image.json.provider` 两档 —— `prompt`（默认，只出 `image_prompt`，占位卡可查看/复制）
  与 `comfyui`（后台逐页调本地 ComfyUI，落 `images/NNN.png`）。
- **ComfyUI 配置**：IP + 端口（默认 `127.0.0.1:8188`）、风格后缀、可选工作流。工作流只收
  「保存（API 格式）」JSON；自动找 `KSampler.positive` 链上的 `CLIPTextEncode`，多个候选时面板手选；
  导入失败不覆盖上一份，可一键恢复内置 Z-Image Turbo。
- **后台配图作业**：模块先 `ready`，配图在后台逐页补，不阻塞播放；页级 `image_status` /
  `image_file` / `image_seed` / `image_nonce` 写回 `slides.json`，`module.json.images` 只记汇总。
  单页失败回退提示词占位，模块列表「补配图」、播放器单页「换一张」都可单独重试。
- **连接探测**：`/image/probe` 读 ComfyUI 版本，并按工作流里 `UNETLoader` / `CLIPLoader` /
  `VAELoader` / `CheckpointLoaderSimple` 等检查模型是否齐全。
- **测试生图**：设置页新增「测试生图」，用当前工作流与一句可编辑的测试词真跑一张，面板内预览、
  显示耗时/种子并可下载；`/image/test` 返回 PNG，**不落盘、不进缓存、不写模块**。策略为提示词占位时
  返回 `E_IMG_DISABLED`，补图作业在跑时返回 `E_IMG_BUSY`；「测试连接」保留原语义。
- **缓存与可复现**：seed 由 `sha256(提示词|工作流哈希|nonce)` 派生，同输入命中 `image-cache/`；
  force 重生成与单页换图递增 nonce，换新种子。
- **书档带图**：`images/*` 与 `audio/*` 同级入包、导入时逐字节还原；缺图时该页标 `failed` 并可补，
  模块状态不受影响（M.2 白名单已同步）。

### 变更

- `package.json` 版本 1.2.0；新增 `comfy.js`、`imaging.js`、`workflows/z-image-turbo.json` 并加入发布清单。
- 生成流水线新增 `onReady` 回调与 `imageProvider` 上下文；重生成模块时一并清掉旧 `images/` 与 `image-job.json`。
- 隐私边界从「外发两类」改为三类：新增「提示词 → 用户指定的 ComfyUI」（仅显式开启，IP 非 127.0.0.1 时面板有提示）。

### 测试基线

| 项 | 结果 |
|---|---|
| `npm test`（14 套） | 213 项：**211 通过 / 2 跳过（无真书样本） / 0 失败** |
| 新增 | `test/comfy.test.mjs` 9 项、`test/imaging.test.mjs` 9 项、`test/image-auto.test.mjs` 1 项（生成后自动起配图），并在 `package.test.mjs` 补配图往返与缺图降级 |

### 已知限制

- 插件不含 ComfyUI 与模型；默认工作流需要 `z_image_turbo_bf16` / `qwen_3_4b` / `ae` 三件套。
- 工作流必须是 API 格式；中文提示词直接发送，不额外翻译。
- 真机 ComfyUI（真实显卡、首次加载模型）未在自动化里跑过；测试用假 ComfyUI 覆盖协议与降级。

## [1.1.0] - 2026-11-04

v1.3「书档导入/导出」：把一本书的全部可再生状态打成一个自包含 ZIP，换机或换数据根导入后无需重新生成。

### 新增

- **书档容器**：`manifest.json` + `books/<bookId>/…`，单本 N=1、批量 N本 一个包；不产生嵌套 ZIP。
- **导出**：`GET /export` 流式写 ZIP（PDF/WAV store，不落临时文件）、`GET /export/size` 预检体积；
  默认含音频，原文 PDF 不可省；`voice.json`、`audio-cache/`、`trash/`、`batches/`、`preference.json` 等禁止入包。
- **导入**：`POST /import/package` 流式落 `.import/`，校验 manifest 哈希、路径、符号链接、条目数与压缩比；
  全部通过后整目录 rename 进 `books/`，失败清理，启动时清理超 24 小时残留。
- **冲突策略**：`merge`（默认，只补模块）/ `skip` / `copy`；书的身份是 `sha256`，模块身份是 `contentKey`，
  章节对不上的模块标 `orphan` 不导入；批量逐本判定，一本失败不拖累其它本。
- **仅补配音**：`POST /revoice` 只重跑 `voicing`，不调用 LLM；无音频模块导入后按 `ready_degraded` 归一，
  且 `audio_provider="none"` 不清空，避免播放器退回浏览器朗读。
- **面板**：导入书档（多选）、冲突策略下拉、多选导出、导出确认层、导入结果层、卡片菜单「导出书档」、
  语音降级模块「仅补配音」。

### 变更

- `package.json` 版本 1.1.0；新增 `pkgzip.js`、`package.js`，`dependencies` 加 `yazl` / `yauzl`。
- `slides.json` / `book.json` 只追加可选字段；书档导入零 LLM、零 TTS、零 PDF 重解析。

### 测试基线

| 项 | 结果 |
|---|---|
| `npm test` | 188 项通过 / 2 跳过（无真书样本） / 0 失败；新增 `test/package.test.mjs` 19 项 |
| 待真机 | GB 级包的内存峰值（AC-45）、生成中导出（AC-48） |

## [1.0.0] - 2026-11-03

首个正式版本。M1–M4 + v1.2 语音全部交付，M5 只完成两条体验修复（见「未完成」）。

### 新增

- **书架**：拖拽/点选导入带文字层的 PDF，首页渲染封面，改名、软删除进回收站、占用统计与清理。
  扫描件在导入阶段就被拒（`E_PDF_NO_TEXT`），不会悄悄建一本空书。
- **切章**（两条路径）：
  - 机械切分：页眉章号序列 + 标题投票 + 目录页剔除，处理 OCR 错号、裸页眉、译注重复章号、附录 A/B/C/D；
  - 目录驱动：把目录页交给模型按严格 JSON 抽取，再用「页眉页码众数」与「标题首次命中」两条证据校准
    （`tocparse.calibrate`），落盘前抽查；`E_TOC_EXISTS` 防机械结果覆盖目录结果，章节列表常驻显示来源；
    `replayToc` 从 `toc.json` 重建，不重跑模型。
- **生成流水线**：勾 1–5 章 → 分块改写 → 结构校验 → 锚点回填 → 配音；四阶段进度、取消、断点续跑、
  失败重试；同组章节重复点「生成」直接秒开已有模块（幂等），失败批次不再重调模型。
- **分屏播放器**：左 PDF 视觉版式（pdf.js 渲染 `source_pages`，`source_quote` 映射到文本项矩形叠加高亮），
  右 16:9 幻灯片；自动翻页、`空格` / `←→` / `F` / `Esc` 快捷键、分隔条比例持久化、书架「继续听」、无配音页降级。
- **语音**：Qwen3-TTS 逐页 WAV（并发 2、单页超时 60s、失败重试 1 次）、浏览器本机朗读、关闭三档；
  Key 只存 `voice.json`（0600），面板只回末尾 4 位；音频按文本+音色+模型做 `sha256` 缓存，同文同音色不重复计费；
  缺 Key 或单页失败只降级 `ready_degraded`，不阻断文字。
- **运维**：`/chapter-check` 真书对照命令；回收站一键清理；面板「插件版本」跟随 `package.json`。
- **真值回归**：`test/truth/` 收进 5 本真书的人工切章真值与 `books.json` 基线清单，`npm run test:truth`
  / `test:truth:mech` 只报「比基线更差」，不要求基线全绿。

### 修复（开发过程中已并入）

- 目录切章四处误判：目录文本被截断、偏移判据过严、锚点被目录页/分卷页骗走、短标题互相命中。
- 目录结果被机械结果静默覆盖；重放拿到已被覆盖的 `chapters.json`。
- 章节页范围整体偏 1–2 页（标题与正文粘连、标题页超过 700 字、无页码的条目式目录）。
- 译注/索引里重复的章号被当成新章；第二个「序言」逃过判重。
- 附录 A/B/C/D 并成一章；页眉只剩章号时标题丢失；OCR 错号后标题变成「未命名」。
- 全屏/拖动分隔条时 PDF 同一 canvas 并发渲染。
- 书架卡片「⋯」菜单只能再点「⋯」关闭；生成后「生成中」条目不在视野、找不到取消。

### 测试基线

| 项 | 结果 |
|---|---|
| `npm test`（10 套） | 168 项：**166 通过 / 2 跳过（无真书样本） / 0 失败** |
| `npm run test:truth`（目录路径） | 4 本参与，**0 回归**；一致 92/109，严重 14（导演 12 + 普林斯顿 2，已登记） |
| `npm run test:truth:mech`（机械路径） | 5 本参与，**0 回归**；一致 124/130，严重 3（附录 C 偏 17 页、普林斯顿附录 A/B） |
| 真书实测 | 《故事》542 页：导入 2.2 秒；《导演创作完全手册》582 页：提取 0.98 秒、切出 48 段（前文 + 47 章） |

真值核对为什么红、哪些书漏在哪，见 [test/truth/README.md](test/truth/README.md)。

### 未完成（推迟到 1.x）

- **暗色主题**：`client.js` 没有 `prefers-color-scheme` 分支，只有一套浅色。
- **无障碍完整审计**：目前只有 29 处 `aria-*` 与少量 `role`，没有键盘全流程与读屏实测。
- **诊断/日志**：没有诊断面板或可导出的运行日志；排查靠 `~/.dsh/book-slides` 下的 JSON。
- **真机全流程**：M5 出口条件里的「一次真实书 ≥ 300 页全流程」只在开发机验证过，没有跨机器验收记录。
- 暗色、无障碍、诊断、真机验收都需要新增 UI 与跨机器验收，不在 1.0.0 内；1.0.0 只包含 M5 的两条体验修复。

### 已知限制

- **扫描件不支持**：只认带文字层的 PDF；《计算机组成与设计》扫描版在真值目录里被显式排除。
- **源文件 OCR 错字改不了**：「剪辑」被认成「剪镭」这类，标题靠投票选多数写法；全书都错的无解。
- **页数硬约束 6–30**：模型给少了先整套重写一次，仍不合规报 `E_LLM_SCHEMA`，不静默截断。
- **锚点可能失配**：`source_quote` 不是原文连续子串时标 `unanchored`，播放按页定位、不高亮。
- **pdf.js 资源同源转发**：module / worker / cmaps / standard_fonts / wasm 由插件从依赖目录转发
  （`/dsh-book-slides/vendor/pdfjs/`），不往仓库里复制第三方文件；首次打开模块会加载 worker。
- **移动端**：播放器 < 1024px 时上下堆叠，不保证手机竖屏比例。
- **换音色只影响新生成**：缓存键不含音色，已有模块要按新音色重做需「重生成」（会重跑 LLM）。
- **Qwen 费用与限额**由千问平台控制；插件不保存过期音频 URL，只缓存合成结果。
- **开发环境**：Windows 沙箱里 `node --test` 会因 fork 子进程报 EPERM，测试是直接 `node test/xxx.mjs` 跑的。
