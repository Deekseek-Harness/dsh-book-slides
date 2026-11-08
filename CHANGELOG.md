# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
需求基线冻结在 [doc/requirements/规范需求.md](doc/requirements/规范需求.md)（v1.0），行为变化记在这里。

## [Unreleased]

主题「Part 默认禁选、可编辑」：修正 AC-92 与 AC-129 的文档矛盾，按预防式禁选收敛；补 Part 编辑入口。

主题「AC 判据化：可触发、可观察、可判定」：FR-14 / FR-15 的 AC-99 ~ AC-102 原先只写“性质”，没有触发失败分支的手段，也没把机检结论暴露成信号；本次补读取侧校验、故障注入与机检退出码。

### 修复

- 已确认 Part 的章在列表中始终只读且不可反选，从源头避免 Part 冲突；不提供“再勾选已属 Part 的章”或冲突三选弹窗。AC-92 改为结果型验收：UI 无重选路径，API 冲突仍返回 `E_PART_CONFLICT` 且不写盘。
- API/并发冲突只提示“请先在该 Part 的「编辑」中移出冲突章”，不自动并入/移出，不调模型。
- Part 组头新增「编辑」：可改名、移出本 Part 的章、加入未归属的章；调用 `/part/update`，成功后 `part_version+1`，系列卡显示「基于旧快照（vN）」。
- 组头补「系列数」与「已确认」徽标；确认/编辑成功后滚动到对应 Part。
- `rulePlan` 单讲可能超 8 万硬上限（I4）：当前讲不足 4.2 万字时会继续装章，`41999 + 59999` 可拼成 10.2 万字一讲；现改为“再加一章超 8 万必须换讲”，页预算与既有装章结果不变。
- 单章拆分阈值回到 6 万：原实现按 8 万才拆，6–8 万单章会被压成 1 讲 30 页（页预算被 `clamp(…,30)` 吃掉）；现 `>6 万`即拆上/下、每段 ≤6 万。
- `sliceChapter` 修丢段：极长章（>2×分段上限）原来只递归前半段、后半段被丢弃；改为两半都递归，`from/to` 首尾相接。

### 文档（FR-13 验收口径）

- AC-96 ~ AC-98 由“样例数值”改为不变量：断言 I1–I4、页预算公式、拆分阈值与包络规则；“7 章 8.4 万字”“单章 9 万字”“章 1、3、5”降为示例（SRS v1.5）。
- 修正 AC-98：3 章 ×1.2 万 = 3.6 万字 → 1 讲 18 页（原文写“2 讲”，与规则和实现矛盾）。
- 超长单章阈值明确为 `>6 万`拆、每段 ≤6 万（6 万 ≈ 30 页上限）；多章装讲的 8 万只作 I4 容差。
- 新增 SRS FR-13.1 边界夹具表 F1–F12；真书只按不变量核对讲次规划，不锁具体讲数/页数。

### 测试

- 新增 `test/v2-part-ui.test.mjs`：默认禁选/只读、无重选入口、旧快照徽标、Part 编辑弹窗静态渲染与源码入口。
- `test/v2-m2.test.mjs` 增加系列 `part_version`/章快照不随 Part 编辑改变的断言。
- `test/v2-m2.test.mjs` 的 AC-96/97/98 改为表驱动：FR-13.1 夹具 F1–F12 + 6 万整/6 万+1 边界 + 48 章 `E_SERIES_TOO_MANY`。

### 验收判据化（AC-99 ~ AC-123）

- SRS v1.6：AC-99 / AC-100 改为“构造 → 断言 → 判定 → 机检入口 → 人工边界”，`sections` 校验明确覆盖落盘 `briefs.json`，坏 JSON 用故障注入判定；§10 / §12.7 / 附录 D 同步。
- SRS v1.7：AC-101 / AC-102 同口径改造——`seams` 数 ≠ N−1 与术语凭空发明只重试 1 次；两次失败降级规则 plan 且过生成门；FR-15 校验口径改为“术语出现在原文或 briefs 中”。
- SRS v1.8：AC-103 / AC-104 改为可执行判据——构造坏接缝、字符级断言与 `seam_repairs` 计数；篡改后只修 1 页、第 2 讲其余页与第 1 讲 mtime 不变；FR-16 补“可观察”。
- SRS v1.9：AC-105 / AC-106 改为可执行判据——术语/重复率定位到页并定点修复、第 1 讲 mtime 不变；补“修复幂等”与“ρ 只告警”规则与用例；新增 `npm run verify:stitch`（六指标表 + 失败项，退出码 0/1）。
- SRS v1.10：AC-109 / AC-123 改为可注入判据——新增 `npm run inject:player`（`--fail` 置 failed 讲、`--unanchor` 清锚点、`--restore` 还原，备份在系列目录）；新增 `test/v2-inject-state.test.mjs` 证明注入能到 `/series` / `/lecture` 接口且可恢复。
- FR-18 修复（v1.11）：未锚定提示移入 sticky 容器，原文窗格滚动后不再消失；`unanchored` 判据补上 `anchor_status='unanchored'` 与空锚点（`{}`）；窗口重新聚焦/可见时刷新当前讲与系列，注入后无需整页刷新。
- SRS v1.12：AC-110 / AC-111 / AC-119 / AC-121 改为可注入判据——7 章组卷覆盖、`mastery.json` 注入到期/盒子、`questions.json` 改名造空题库；合并页数 = Σ页数 + (N−1) 且过渡页接缝句逐字；缺音频/flac 用改名注入，超限用 `DSH_PPT_MAX_BYTES` 调低触发，提示按导出模式区分。
- SRS v1.13：AC-113 改为两条可注入失败（旧根只含 0 字节文件 → 备份校验失败；`rename` 注入 `EPERM` → 重命名失败），断言原根文件与 mtime 不变、无半截 2.0 数据、修正后不重启可重试；新增 `test/v2-isolation.test.mjs`（AC-112/AC-113 + 零模型依赖）。AC-132 去掉“清理临时文件”（批量导出全内存、无临时文件），改为 abort 后数据根无残留并补用例；AC-135 写明取消矩阵与超时缺口；附录 D 清理 6 个幽灵测试文件。
- `briefs.json` 读取侧校验：讲纲缓存命中与 `GET /briefs` 都会重跑 `sections` 原文校验；改坏的章回退“标题 + 首尾段”并给 warning，不静默采用，也不覆盖人工修改。
- `/plan/preview` 的 `briefsSource` 增加 `mixed`（部分章回退）；`GET /briefs` 返回 `warnings` 与 `rejected`。
- 新增 `npm run verify:briefs`（AC-99 机检，退出码 0/1）、`test/v2-briefs.test.mjs`（AC-99/100）与 `test/v2-plan-ac.test.mjs`（AC-101/102，含降级后过生成门与 briefs 术语放行的反向用例）。

## [2.0.0-alpha.7] - 2026-11-08

主题「换图不打断播放」：修复播放中「换一张」导致当前页音频/朗读反复从头播放的问题；换图改为独立临时状态 + 作业状态轮询，失败保留旧图。

### 版本与环境

- 包 `2.0.0-alpha.7`（tag `v2.0.0-alpha.7`）、产品 `2.0`、数据 schema `2`、文档 v1.3。
- 无数据 schema / 配置字段变更，可直接覆盖 `alpha.6`。

### 修复

- 播放中「换一张」不再把当前页音频/朗读打回开头：播放 effect 的依赖从整个 `slides` 数组改为 `slides.length + playbackKey`（本页音频签名），配图/种子更新不再触发播放重建。
- 「换一张」改为轮询 `/image/status` 作业状态，结束后只拉一次 `/lecture`；换图临时状态放在独立的 `imageOverrides`，不再每 1.2 秒替换整讲数据，也不再产生最多约 150 次整讲 JSON 下载。
- 换图失败保留旧图：服务端失败/超时/取消/中断不再清空 `image_file`/`image_seed`；播放器继续显示旧图并给「重试配图」，PPTX 导出也继续使用旧图。`reset`（长按强制重配图）仍是破坏性操作，会清空旧图。

### 测试

- `test/parity-player.test.mjs` 新增 `playbackKey` / `slideWithImageOverride` / 播放依赖断言。
- `test/v2-m5-client.test.mjs` 新增失败保留旧图、生成中禁用、其它页锁定。
- `test/v2-images.test.mjs` 更新失败/取消用例：失败与取消均保留旧图引用。
- `test/v2-pptx.test.mjs` 新增失败但有旧图时导出仍使用旧图。

## [2.0.0-alpha.6] - 2026-11-07

主题「音韵平滑」：本地 ComfyUI 配音从 **CustomVoice** 切换为 **VoiceClone 参考音频克隆**（SRS `规范需求2.0.md` v1.3）。不改 provider、不改 `/revoice` 逐页流程、不改数据 schema；**旧 CustomVoice 配音工作流不再兼容**。

### 版本与环境

- 包 `2.0.0-alpha.6`（tag `v2.0.0-alpha.6`）、产品 `2.0`、数据 schema `2`、文档 v1.3。
- `voice.json` 新增可选字段 `comfyRefVoice`（默认 `builtin-vivian`）；旧 `comfyVoice` 只读保留、不再使用。
- 根目录新增 `comfy-tts-refvoices.json` 与 `voices/`；默认参考在包内 `workflows/qwen3-tts-通过克隆配音/`。

### 变更（不兼容）

- 默认工作流改为 `workflows/qwen3-tts-通过克隆配音/qwen3-tts-通过克隆配音.json`（API 格式：`LoadAudio → FB_Qwen3TTSVoiceClone → SaveAudio`），识别 `textNode=6`、`outputNode=7`、`refNode=8`。
- 合成请求改为写 `target_text` + `ref_text`，并把 `ref_audio` 上游 `LoadAudio.audio` 改为当前参考文件名；`x_vector_only` 必须为 `false`。
- 旧 CustomVoice 工作流（无 `ref_audio`）导入被 `E_TTS_WORKFLOW_NODE` 拒绝；已有的 `comfy-tts-workflow.json` 需「恢复默认」或重新导入克隆工作流。
- 音色表 → **参考 voice 库**：内置 `Vivian` / `Uncle Fu` 两组（flac + 同名 txt），支持导入/恢复默认；`/voice/speakers` → `/voice/refvoices`；`comfyVoice` → `comfyRefVoice`。
- 参考音频经 `/upload/image` 上传到 ComfyUI `input/`，按 sha256 去重。
- 音频缓存键加入 `refVoiceId / refAudioSha256 / refTextSha256`；换参考或改 `ref_text` 即失效。
- 错误码新增 `E_TTS_VOICE_REF`；`E_TTS_VOICE_TABLE` 仅作旧日志兼容，`E_TTS_SPEAKER` 仅云端仍用。
- 设置页：参考库下拉（名称/时长/语种/默认项）、导入/恢复默认、时长 warning；连接测试显示当前参考，试听文案改为参考语义。
- 打包 `package.json.files` 改为 `workflows/`，确保参考 `.flac/.txt` 进安装包。

### 依据与效果

- CustomVoice 只锁音色身份，韵律随目标文本漂移：同讲 6 页实测中位 F0 极差约 3.7 个半音（第 5 页 +1.1 st、第 6 页 +2.2 st）。
- VoiceClone 以参考音频的语音码为韵律锚点，同讲页间更稳；验收见 SRS AC-155（人工 + F0/语速抽检）。
- 两个内置参考 21.3s / 22.0s 超出推荐 5–15s，已记入 SRS §12.6，后续替换为 8–12s。

### 测试

- `test/v2-tts-comfy.test.mjs` 重写为 6 项：默认参考库、连接/试听注入（`target_text/ref_text/LoadAudio`、`x_vector_only=false`）、参考库导入/校验/恢复、工作流校验（`x_vector_only=true` 拒绝、UI 格式转换）、逐页配音/缓存/换参考失效、文本入口隔离。
- 回归：`v2-revoice` 11 项、`parity-voice` 7 项、`comfy` 9 项、`parity-settings` 8 项、`v2-m4-routes` 3 项、`v2-m5-client` 12 项通过。

### 手工验证与待办

- `/upload/image` 与真实 ComfyUI 的兼容性仍需真机复核（假服务已覆盖）。
- 参考音频 + 同名 txt 的图形化成对导入未做；当前需放入 `voices/` 后导入参考库 JSON。
- 完整逐页真机配音与真书验收留 M6。

## [2.0.0-alpha.5] - 2026-11-07

对齐 SRS `规范需求2.0.md` v1.2（AC-148 ~ AC-155）：新增本地 ComfyUI Qwen3-TTS 配音 provider、默认工作流与音色表、连接/试听测试、串行队列。**不改数据 schema**。

### 版本与环境

- 包 `2.0.0-alpha.5`（tag `v2.0.0-alpha.5`）、产品 `2.0`、数据 schema `2`、文档 v1.2。
- `voice.json` 保持 version 2，只新增可选字段 `comfyVoice` / `textNode`；根目录新增 `comfy-tts-workflow.json`、`comfy-tts-voices.json`。

### 新增

- 语音供应商扩为四个：`qwen3-tts` / `comfyui-tts` / `browser` / `off`；默认仍是 browser，不自动探测 ComfyUI。
- ComfyUI 配音：默认工作流 `workflows/qwen3-tts.json`（源 `doc/comfyui/qwen3-tts-配音.json`，`FB_Qwen3TTSCustomVoice` → `PreviewAudio`），支持导入 API / 带 `widgets_values_named` 的界面格式工作流，支持文本节点手选（`voice.json.textNode`）。
- 音色表：默认 `Qwen3-TTS-CustomVoice` 9 音色（Vivian 默认），支持导入模型音色表/纯名字数组、恢复默认；换音色只写请求 `speaker`，不重写工作流；`comfyVoice` 与云端 `voice` 分开保存。
- 模型一致性：连接测试读 `/object_info` 的 `speaker` 枚举，返回 `modelSpeakers` 与 `unsupported`；全不支持时 `E_TTS_SPEAKER` 拦截，部分不支持标灰并回落；设置页在连接测试/出错时给一致性提示。
- 设置页：ComfyUI 地址（与配图共用 image.json）、工作流/音色表导入与恢复、连接测试、试听测试、配音作业排队/进度/取消。
- ComfyUI 配音与配图共用全局串行队列（`v2/comfy-queue.js`）；取消不调用 `/interrupt`，已完成页保留。
- 音频支持 wav/flac/mp3/ogg：播放器与 `/audio` 兼容，书档保留原格式；PPT 只嵌 wav/mp3，其它格式给 warning。
- 错误码：`E_TTS_CONNECT` / `E_TTS_WORKFLOW` / `E_TTS_WORKFLOW_NODE` / `E_TTS_MODEL_MISSING` / `E_TTS_VOICE_TABLE` / `E_TTS_SPEAKER` / `E_TTS_BUSY`。
- 诊断新增语音 provider、ComfyUI 工作流/格式、音色表名/模型与 `textNode`。

### 测试

- 新增 `test/v2-tts-comfy.test.mjs`（AC-148 ~ AC-155）：默认工作流/音色表、连接与试听、工作流导入/多候选/恢复、音色表导入/恢复、模型支持与一致性、逐页落盘/缓存/force、串行队列与取消。
- `npm run test:v2`：21 个文件 / 117 项，0 失败。

### 手工验证

- 2026-11-07 本机 ComfyUI：设置页导入音色表/工作流、连接测试、试听、`Uncle Fu` / `Ono Anna` 切换通过。
- **完整逐页配音尚未真机验证**：逐页合成/落盘、缓存、串行队列、flac 输出与 PPT warning 留 M6。

### 修复

- ComfyUI 语音设置页瘦身：说明改悬停 `title`，只保留连接/试听两个测试与底部蓝色「保存」；「朗读稿输入位置」只在多文本工作流出现。
- 试听不再依赖“先保存”：`/voice/probe` 可显式带 `comfyVoice`/`voice`，修复不同音色试听结果相同。
- 写入音色时同时清空 `custom_speaker_name`（该字段非空会覆盖 `speaker`），并返回 `x-tts-voice` 让面板显示实际使用的音色。
- 音色名与 ComfyUI `/object_info` 比对忽略大小写与空格/下划线/连字符：修复 `Uncle_Fu`、`Ono_Anna` 被误判为“模型不支持”而回落到 Vivian。
- 默认音色表与本地 `ComfyUI-Qwen-TTS` 节点的 `speaker` 枚举对齐：`Uncle_fu`、`Ono_anna`（界面显示 `Uncle Fu`/`Ono Anna`）；修复发送 `Uncle Fu`/`Ono Anna` 时 ComfyUI 报“Value not in list”。
- 导入音色表/工作流时剥掉 UTF-8 BOM，避免编辑器保存的 JSON 被误判为非法。
- 把 `/voice/workflow`、`/voice/speakers`、`/voice/comfy/probe` 注册进 DSH 宿主路由；修复导入音色表报 HTTP 405。
- 连接/试听遇到非 JSON 响应时不再显示“服务端返回的不是 JSON”，改为“插件服务无响应（HTTP n），重启 DSH 后再试”。

## [2.0.0-alpha.4] - 2026-11-06

对齐 SRS `规范需求2.0.md` v1.1（AC-142 ~ AC-147）：播放器缩略图与配图提示词面板、配音失败可见与四态按钮、配图四态按钮与单页换一张。**不改数据 schema**。

### 版本与环境

- 包 `2.0.0-alpha.4`（tag `v2.0.0-alpha.4`）、产品 `2.0`、数据 schema `2`、文档 v1.1。
- 2.0 预发布之间仍不承诺数据兼容；升级到正式版前保留备份（FR-20）。

### 新增

- 播放器底部逐页缩略图改为 16:9 迷你版式（cover / content_text / quote），当前页高亮；点缩略图切换页面并停掉旧音频、原文同步（AC-142）。
- 配图提示词面板：点面板外任意区域、按 `Esc`、翻页都能收起；`Esc` 只收面板，不退全屏/返回；无 `image_prompt` 时不渲染复制按钮（AC-143）。
- 配音失败可见：`voice_status` 扩为 `none|voicing|ready|partial|failed`；系列/讲落 `voice_code`、`voice_error`、`voice_failed`、`voice_pages`；系列卡显示错误码、失败讲数与「补配音」，播放器顶部给可关闭提示（AC-144）。
- 配音按钮四态：生成配音 / 补配音（`missingOnly` 只跑缺失页）/ 重新配音（二次确认）/ 长按 3s 强制重配音（`force` 忽略缓存）（AC-145）。
- 配图按钮四态：生成配图 / 补配图 / 重新配图（二次确认）/ 长按 3s 强制重新配图（`force+reset` 清空图片并重置种子）（AC-146）。
- 播放器单页「换一张」/「重试配图」：`POST /image/regen {seriesId, lecture, slide, force}`，只替换该页（AC-147）。
- 所有二次确认（配音/配图重跑、删除系列/Part/书、清空回收站、清 Key、删备份）与重命名输入改为**插件内居中弹窗**（复用遮罩，`Esc`/点遮罩取消），不再使用浏览器原生 `confirm`/`prompt`。
- 配音/配图长按 3s 期间显示**进度条与剩余秒数**（3→2→1），松开即取消；按住时禁用上下文菜单。

### 修复

- 配图汇总改为扫描全部正文页统计，单页作业不再把 `series.images.total/done` 覆盖成 1。
- `force` 重配音忽略音频缓存；`reset` 重配图删除对应种子缓存，确保真的重跑 ComfyUI。
- `voice_error` 保留具体错误码与失败页数（如 `E_TTS_QUOTA`），不再只有一句“有 N 讲存在未配音页”。

## [2.0.0-alpha.3] - 2026-11-06

M5（P1）完成：书档导入/导出、练习与复习、本地 ComfyUI 配图、按讲/整套导出 PPT。
P0/P1 功能对等全部落地；**数据与 1.x 仍不兼容**，同根首次启动自动备份旧根。

### 版本与环境

- 包 `2.0.0-alpha.3`（tag `v2.0.0-alpha.3`）、产品 `2.0`、数据 schema `2`、文档 v1.0。
- 数据布局新增 `books/<bookId>/practice/` 与 `series/<id>/lectures/<n>/images/`；根目录新增 `image.json`、`comfy-workflow.json`、`image-cache/`。
- 1.x 同名路由 `/image*`、`/practice*`、`/export*`、`/import/package*` 全部由 2.0 接管；1.x 处理器不再注册。

### 新增（M5 书档，FR-22 / AC-125、AC-133、AC-138）

- `GET /export?bookId=|bookIds=|all`：流式 ZIP 书档（`manifest.json` + `books/<bookId>/…`），单本/批量；`GET /export/size` 预估体积。
- 内容白名单：书/页/章/原文/封面/Part/briefs、系列/讲/音频/配图、`practice/`（题库、掌握度、场次）。
  明确排除 `voice.json`（含 Key）、`audio-cache/`、`trash/`、`batches/`、`preference.json`、`progress.json`、`*.tmp`、`explain-cache/`。
- 身份：书用 `book.json.sha256`；系列用 `contentKey = sha256(讲纲 + slides 去标识字段)`，讲另有 `lectureKey`。
- 导入：`POST /import/package` 裸 ZIP → 立即返回 `jobId`；`GET /import/package/job` 逐本进度；`POST /import/package/cancel` 幂等取消。
  解压到 `.import/<jobId>/`，整本校验 sha256/大小后 rename 进 `books/`；冲突策略 `merge/skip/copy`；同 `bookId` 不同 `sha256` 整本拒绝 `E_PKG_ID_CONFLICT`；单本坏包不影响同包其它本；1.x 包明确拒绝 `E_PKG_VERSION`。
- 状态归一：非终态讲 → `interrupted`；`slides.json` 在但音频缺失 → `ready_degraded` + `audio_file=null`/`audio_provider="none"`；缺 `source.pdf` 整本拒绝。
- 回收站恢复冲突（AC-138）：`POST /trash/restore` 遇同 `sha256` 返回 `E_BOOK_EXISTS` 与已有 `bookId`，不覆盖不复制。
- 客户端：书架「导入书档」上传 + 进度/逐本结果/取消；卡片「⋯」导出书档；设置页「导出全部书档」。

### 新增（M5 练习与复习，FR-19.1 / AC-110、AC-119、AC-134）

- 题库作业：`POST /practice/bank {seriesId, chapters?, topup?, rounds?}` 异步按章出题（每章 4–6 题、单书 ≤300）；`GET /practice/job`、`POST /practice/cancel`。
- 题库按章缓存（`sha256(bookId|章号|章标题|章字数|promptVersion|blueprintVersion)`）；二次准备命中缓存返回 `cached=true`，不调模型。
- 补题：`topup=true` 每章 +5，单次 ≤30 题、最多 6 轮；先由 `/practice/summary` 给出计划，UI 二次确认后才调模型。
- 组卷：`POST /practice/session {seriesId, mode, count}` 只读题库；`new/mixed/review`、到期 ≤40%、新题过半、同考点 ≤2、章覆盖；题库不足 `E_BANK_INSUFFICIENT`，不触发生成。
- 断点续练（AC-134）：`GET /practice/session?seriesId=` 返回未完成场次与下一题；同系列再次 POST 复用；`sessions/<id>.json` 带 `series_id`。
- 判题：`POST /practice/answer` 宿主本地判定，只返回 `{correct, answer, source_quote, source_anchor, explanation?}`；同 `qid` 重复提交幂等；答错进错题本并写 Leitner 掌握度。
- 讲解（独立动作）：`POST /practice/explain` 只在用户点「查看讲解」时调模型（≤8s），成功写回题库、失败置 `failed` 并降级为正确答案 + 原文，不阻断下一题。
- 复习：`POST /practice/review` 按到期/错题组卷；`GET /practice/summary` 给出题库/覆盖/到期/错题/补题计划；`POST /practice/flag` 标记后不再组卷。
- 客户端：系列卡「练一练」；题库状态、准备/补题、模式与题量、作答、判题反馈、查看讲解、标记、结束总结、继续上次练习。

### 新增（M5 配图，FR-24 / AC-120）

- `GET/POST /image/config`（策略 `prompt|comfyui`、host/port、风格后缀 ≤60、提示词节点）、`POST /image/workflow`（导入 API 工作流/恢复默认）、`POST /image/probe`（测试连接）、`POST /image/test`（测试生图，不落盘、不进缓存）。
- 逐页作业：`POST /image/regen {seriesId, lecture?, slide?, force?}`、`GET /image/status?seriesId=`、`POST /image/cancel`；只改 `slides.json` 的 `image_file/image_status/image_provider/image_seed`，不改文字/音频。
- 失败页留白并保留 `image_prompt`；单页重试只替换该页；取消后作业 `cancelled`，已生成页保留；ComfyUI 不可用不阻塞文字/音频。
- 生成阶段按当前策略写初始 `image_status`（ComfyUI → `pending`，占位 → `none`）；启动时把残留 `queued/running` 作业归一为 `interrupted`。
- 图片由宿主中转：`GET /image?seriesId=&lecture=&i=` 返回 PNG；播放器配图位在 `image_status=ready` 时显示真图，否则回退提示词占位。
- 设置页配图组：策略、地址、风格后缀、工作流导入/恢复默认、提示词节点、测试连接/测试生图。

### 新增（M5 导出 PPT，FR-19.2 / AC-111、AC-121、AC-132）

- `GET /export/pptx/plan`：页数/讲数/音频页/配图页/体积/文件名/warnings；`GET /export/pptx`：单讲或整套合并（讲间插过渡页：讲标题 + 接缝句）；`GET /export/pptx/batch`：每讲一个 `.pptx` + `manifest.json` 的 ZIP。
- 页数与 `slides.length` 严格一致；cover/content_text/quote 三种版式复用舞台视觉；备注逐字等于 `audio_script`；仅真实存在的 WAV/MP3 与 `image_status=ready` 的 PNG 内嵌；`image_prompt` 不上页。
- 文件名 `<书名>-精讲-<讲标题去掉「第 N 讲 · 」>.pptx`；`content-disposition` 同时给 ASCII fallback 与 `filename*=UTF-8''`。
- 只读：不调 LLM/TTS/ComfyUI，不写 `slides.json`/`series.json`，`books/` 的 size+mtime 不变；150 MB 上限与「按讲导出」提示。
- 客户端：系列卡「导出」对话框（范围/音频/配图/备注/计划/warning/下载/批量 ZIP）。

### 测试与验证

- `npm run test:v2`：20 个测试文件、**99 项**，**0 失败**；新增 `v2-practice`、`v2-pptx`、`v2-package`、`v2-images`、`v2-m5-client`、`v2-trash`、`v2-longtask`。
- 全部用真 HTTP 路由 + 假模型 / 假 ComfyUI：书档往返/冲突/批量坏包/状态归一、练习组卷/判题/讲解/Leitner/续做、配图逐页/单页重试/失败兜底/取消、PPT 页序/过渡页/音频/配图/备注/批量 ZIP/只读。
- 真书、真 Qwen、真 ComfyUI 与发布门（AC-92 ~ AC-141 全绿）留到 M6。

### 已知未完成（M6）

- `POST /series/replan`（`replanFrom(k)`，附录 B）仍未实现，手动改切点会走重建系列。
- 真书 e2e（三种分章模式 + 文科/技术两本）、AC-136 全量 UI 反馈走查、版本/tag/meta 一致性（AC-141）与 §2.6 基线走查（AC-128）。

## [2.0.0-alpha.2] - 2026-11-06

M1–M4（P0）完成的可安装构建：数据根与书籍体验、Part 与讲纲、逐讲生成与接缝、播放/设置/偏好/语音。
P1（M5：书档、练习、配图、导出 PPT）尚未开始；**数据与 1.x 不兼容**，同根首次启动会自动备份旧根。

### 版本与环境

- 包 `2.0.0-alpha.2`（tag `v2.0.0-alpha.2`）、产品 `2.0`、数据 schema `2`、文档 v1.0。
- 同包名 `dsh-book-slides` 覆盖 1.x；同根 `~/.dsh/book-slides/`，检测到旧 schema 自动备份到同父目录 `book-slides.backup-<时间>/`，原路径重建空书架，不迁移，需重新导入 PDF。
- P0 功能对等（§2.5）P-0 ~ P-7、P-12、P-13 全部落地；M5 的 P-8 ~ P-11 不在本版。
- 实现进度、AC 对照与已知缺口见 [doc/2.0-实现进度.md](doc/2.0-实现进度.md)。

### 新增（M1 数据根、导入、分章与书籍体验）

- 2.0 数据根：同根 `schema=2`、旧 schema 自动备份、`/meta`。
- 导入只入库（PDF/pages/book），分章与封面改为独立动作。
- 分章：`auto/toc/mech` 可重跑、章校准、手动章保护；`toc` 支持 PDF 书签，无书签时读印刷目录（模型 + 校准 + `toc.json` 缓存，可离线重放）。
- 书架、改名、软删除、回收站恢复与冲突、存储统计；卡片「⋯」菜单点外部 / 再点 / Esc 都能关，且不吞这次点击（AC-117）。
- M1 客户端：书架、拖拽导入、分章构建、章校准、封面、回收站；目录模式可指定目录页码；深色模式使用 Canvas/DSH 主题变量，不再白底浅字。
- M1 路由：`/meta`、`/import`、`/chapters/build`、`/chapters`、`/cover`、`/book`、`/trash`、`/file` 等。

### 新增（M2 Part、briefs 与讲纲）

- Part：`/parts`、`/part`、`/part/update`；非空/去重/front/48 章校验、两两不相交、冲突返回 conflicts。
- briefs：模型生成 + `sections` 原文检索校验；失败回退“标题 + 首尾段”。
- 讲纲：规则装章（≤6 章、目标 6 万、上限 8 万、最多 8 讲）；模型主线/接缝/术语校验；失败回退 `unstitched`。
- 超长章：按节标题拆上/下；模型只补主线/接缝/术语，并按实际 `sections/scope` 校验，防止整章缩成单一 Item。
- 系列：`POST /series` 只建 draft；`POST /series/plan` 写 plan；重复保存按幂等键复用/更新，不重复建系列。
- M2 客户端：章节多选、Part 组头、冲突三选、讲纲居中预览、保存为系列。

### 新增（M3 生成、预缝与后验缝）

- 逐讲生成：`POST /series/start` 全量、`POST /series/lecture/generate` 单讲；文本三阶段 `structuring → validate → anchor`，不调 TTS，音频字段初始为 `null/none`。
- 批预算：单批 ≤1.2 万字、单章超长按 8 千字切、批间 300 字承接；批检查点落 `lectures/<n>/batches/`，取消/重试只补未完成批。
- 预缝：cover `audio_script` 逐字以接缝句开头、末页逐字以接缝句结尾；不通过只做页级修复（模型优先，确定性兜底），不重跑整讲。
- 后验缝：`GET /series/stitch` 六项指标（接缝一致、页序/章序、相邻讲重复率、术语禁用词、密度 ρ、覆盖）；`POST /series/stitch/repair` 补接缝、替换禁用术语；重复页有模型时页级重写。
- 作业：`GET /series/job` 返回第 k/N 讲与页进度；`POST /series/cancel` 取消并保留已完成讲；`POST /series/resume` 跳过已 ready 讲；`POST /series/retry` 只重跑失败讲；启动时把 drafting/stitching 归一为 `interrupted`。
- 单讲存储：`series/<id>/lectures/<n>/{lecture.json, slides.json, batches/}`；`GET /lecture` 读取讲义；N=1 系列同样走系列模型，缝合状态直接 `verified`。
- M3 客户端：系列卡显示生成进度、取消/续跑/重试/单讲重新生成、逐讲状态与后验缝报告（含一键确定性修复）。

### 新增（M4 播放、设置、偏好与语音）

- 分屏播放器（FR-18 / AC-107 ~ AC-109、AC-123）：左 PDF 视觉版式（pdf.js，同源 vendor）、右幻灯片舞台（cover / content_text / quote）；`source_pages` 切页、`source_anchor` 段落高亮并滚入视野，未锚定显示「本页未定位到原句」；顶部页码 chip 与「打开原始 PDF」。
- 配图位：点击/Enter/空格展开 `image_prompt`，可复制、可收起；翻页与跳讲自动收起（M5 接真配图）。
- 系列连播：讲末页播完进 5 秒过渡卡（显示下一讲标题，可点击/空格跳过）；下一讲未就绪时提示并停在当前讲，后面还有就绪讲则跳过失败讲继续（记入提示）；N=1 隐藏系列目录与过渡卡。
- 系列目录抽屉：列出 N 讲的标题、页数、已听页与状态，可跳讲、未就绪禁用。
- 系列进度：`GET/POST /series/progress` 落 `progress.json`（当前讲/页 + 每讲已听最大页），显示「系列 24/42 页 · 第 2 讲 3/18 页」；同步 `preference.json` 的「上次打开」，书架「继续听」回到该讲该页且不自动播放。
- 偏好（FR-21.7 / AC-127）：`GET/POST /preference` 记录分隔条比例、语速（0.8/1.0/1.2）、静音与上次位置；服务端夹紧（split 0.25–0.75、语速吸附到三档、页码非负）。
- 语音（FR-23 / AC-126）：`GET/POST /voice`（Key 只回 `hasKey`/`apiKeyMask`，`voice.json` 0600）、`POST /voice/probe`（Qwen 回 WAV、浏览器回朗读参数）、`GET /audio?seriesId=&lecture=&i=` 支持 Range。
- 独立配音（AC-137）：`POST /revoice` 只对 `ready/ready_degraded` 讲、返回 `jobId`；`GET /revoice/job` 有逐页进度；`POST /revoice/cancel` 幂等取消且不写半截音频字段；同系列同时只允许一个配音作业；同文本同音色命中 `audio-cache/` 不重复计费；失败页 `audio_provider="none"`、系列 `voice_status=partial`，未配置 Key 为 `none` + `E_TTS_UNCONFIGURED`，不自动回退浏览器。
- 设置与运维（FR-21.5 / AC-118）：`GET /settings` 给出数据根、占用、回收站、升级备份列表与只读模型；`GET /diagnostics` 给出插件包版本、产品版本 `2.0`、schema、DSH/pdfjs 版本与最近 5 条错误（只含错误码与长度）；`GET /backups`、`POST /backups/delete`、`POST /backups/open` 管理同父目录 `book-slides.backup-*`；设置页四组（语音/模型只读/配图占位/存储与诊断）。
- 系列删除（AC-130）：`DELETE /series` 先取消运行中作业（含配音）并等其收口，再删系列目录；书与 Part 保留、无游离讲。删除书时同样先取消该书全部作业。
- 书架卡补「K 个系列」与「继续听」；`GET /books` 增加 `seriesCount`/`lastSeries`。

### 修复（M4）

- **播放器「配图位」点击无响应**：`SlideStage` 只画了静态占位，没有展开状态与点击处理；现改为可聚焦的配图位，点击/Enter/空格展开 `image_prompt`，支持「复制提示词」「收起」，翻页自动收起；同时让空格快捷键不再与按钮/配图位抢事件。

### 测试与验证

- `npm run test:v2`：13 个测试文件、70 项，**0 失败**；覆盖数据根/升级备份、导入分章、Part/讲纲、逐讲生成/预缝/后验缝、播放器（PDF 高亮/键盘/连播/目录/进度）、设置/偏好/备份/诊断、语音与独立配音、系列删除、书架菜单关闭、路由唯一注册。
- 假模型与假 Qwen 端点走真 HTTP；真书（文科 + 技术）、真 Qwen 与三模式真 PDF 验收留到 M6。
- 说明：`npm test` 是 1.x 冻结套件，从 M1 替换同名路由与数据模型起不再作为 2.0 门禁；2.0 以 `npm run test:v2` 为准。

### 已知未完成（M5 / M6）

- P1：书档导入/导出、练习与复习、ComfyUI 配图、导出 PPT（FR-19、FR-22、FR-24）。
- `POST /series/replan`（`replanFrom(k)`，附录 B）按规范“本期未实现”。
- 真书验收、发布门（AC-92 ~ AC-141 全绿）、版本/tag/meta 一致性检查（M6）。

## [2.0.0-alpha.1] - 2026-11-05

2.0 预发布起点：首版需求规范落库，代码尚未开始迁移。

### 文档

- 新增 [规范需求2.0.md](doc/requirements/规范需求2.0.md)（文档 v1.0）：功能对等、Part/讲/系列、接缝、解耦契约、版本与预发布跟踪。
- 新增 [2.0 版本关于“接缝”的探索.md](doc/requirements/2.0%20版本关于“接缝”的探索.md)（探索稿 v0.8）。
- 版本四维：文档 `v1.0`、产品 `2.0`、插件包 `2.0.0-alpha.1`、数据 schema `2`。

## [1.4.0] - 2026-11-04

v1.6「练习与复习」：把精讲延伸成「听完 → 做题 → 看讲解 → 按遗忘节奏复习」的闭环。

### 新增

- **题库生成**：按章异步作业（`queued → drafting → checking → anchoring → ready / failed / cancelled`）；
  输入 = 覆盖该章的 ready 模块幻灯片要点（考点白名单）+ 章原文；每章 4–6 题，单选 60% / 多选 20% / 判断 20%，
  难度 易 30% / 中 50% / 难 20%；每题带 `point`、`source_quote`，锚点复用精讲的归一化回填。
- **去重**：同书精确（`dedupe_key` = 题干归一化哈希）+ 近似（bigram Jaccard ≥ 0.80）+ 同考点 ≤ 2；
  重复题丢弃并补生成一次；`qid` 由 `bookId + 章号 + dedupe_key` 派生，同题重生成不丢掌握度。
- **补题**：由「开始练习」按模式触发，没有独立「再出一组」按钮；确认后逐轮 `append`，每轮每章 +5，
  最多 6 轮 / 30 题、单书 300；某轮 0 新增即停。
- **组卷**：默认 8 题（可选 5 / 10 / 15，上限 20）；`new` 只取未答；`mixed` 到期 ≤40% 且新题 **>50%**
  （8 题 ≥5），其余旧题按未掌握→已掌握补；`review` 只取到期/错题。新题不足先补到
  `max(floor(N/2)+1, N−旧题数)`；补不到按 `N'` 收缩并披露。
- **判题**：宿主本地同步判定，单选/判断比 key、多选全对才算对；下发题目剥离 `answer` / `explanation`；
  同一 qid 重复提交按幂等处理（只记首次）。
- **讲解**：不预生成。答错后按需生成一次（目标 ≤8s），覆盖「正确项为什么对 / 每个错误选项为什么错 / 原文依据」，
  写回题库并置 `ready`；同题再错秒出；「再讲讲」按 `qid + 选择` 单独缓存；失败/离线降级为正确答案 + 原文。
- **复习**：Leitner 5 盒（1 / 3 / 7 / 21 / 60 天）+ 错题本；答错回盒 0 并立即到期，只影响下一场；
  详情页「复习」入口按到期/错题组卷。
- **面板**：第 4 视图（准备 / 作答 / 结果）；模块行「练习」、播放器「练一练」、详情页「复习」；
  准备页只有「开始练习」，缺题时先弹补题确认层（模式 / 章数 / 轮数 / 预计新增 / 耗时 / 300 上限），
  确认后补题并开场；反馈卡逐项标出正确/错选，答错自动请求讲解，「第 N 页 · 看原文」跳回播放器对应页。
- **数据**：`books/<bookId>/practice/{questions.json, mastery.json, sessions/, explain-cache/}`；
  随书档导出：题库 MUST、掌握度与场次 SHOULD，`explain-cache/` 属缓存不入包。

### 修复

- **书档丢练习数据**：`buildManifest()` 漏掉 `practice`，导入白名单随之拒绝 `practice/**`；导出、删除、
  再导入后题库/掌握度/场次全丢，面板显示模块练习为 0。清单补 `practice` 字段，并兼容修复前导出的旧包。
- **补题 0 新增误判失败**：重复题或满 300 时，作业返回 `ready` + `added:0` + warning，不再整章报失败。

### 变更

- `package.json` 1.4.0；发布清单新增 `practice.js`、`prompts/practice-gen-v1.md`、`prompts/practice-explain-v1.md`。
- `slides.json` / `module.json` 零改动；生成状态机不变；题库作业是独立队列，失败不影响模块。
- 隐私边界新增第四类外发：答错（或点「看讲解」）时，该题题干、选择、正确项与原文片段 → 模型；不发整场记录。
- **交互收敛**：删除「再出一组」「先生成一组题」，补题成为「开始练习」的前置阶段；补题前必须确认；
  混合模式新题必须过半；补题中关闭面板，回来只刷新题库、不自动开场。

### 测试基线

| 项 | 结果 |
|---|---|
| `npm test`（18 套） | 250 项：**248 通过 / 2 跳过（无真书样本） / 0 失败** |
| 新增 | `test/practice.test.mjs` 12 项（出题/缓存/补题计划/组卷/判题/讲解/复习/坏题/续练/书档往返/删除后重导/扩题）、`test/session.test.mjs` 10 项（校验/去重/组卷/混合过半与收缩/补题计划/判题/Leitner/场次） |

### 已知限制

- 练习只做客观题；简答、填空、跨章综合题不做，多选全对才算对。
- 讲解首次生成需要联网；离线时只有正确答案与原文。
- 题库按章生成、按模式补题：单书上限 300 题；没有精讲覆盖的章不能出新题。
- AC-71 ~ AC-91 由 `practice` / `session` 测试覆盖；真机走查（真书 → 听 → 练 → 次日复习）待做。

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
