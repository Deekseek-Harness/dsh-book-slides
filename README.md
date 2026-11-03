# 精讲台 · dsh-book-slides

DSH 左侧栏的独立面板：把带文字层的 PDF 拆成章节，勾几章交给模型写成幻灯片式精讲，
左侧 PDF 原文、右侧讲稿同步播放。

当前版本 **包 1.2.0 / 功能阶段 v1.4**（2026-11-04，含 v1.2 语音、v1.3 书档与 v1.4 本地 ComfyUI 配图；阶段号 ≠ 包版本）。变更记录见 [CHANGELOG.md](CHANGELOG.md)。

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
| 语音 | Qwen3-TTS 逐页 WAV / 浏览器本机朗读 / 关闭；Key 只存本机、面板只显示后 4 位；音频缓存不重复计费 |
| 配图 | 默认只出提示词占位；可选本地 ComfyUI（IP+端口、导入 API 工作流）后台逐页出图，失败页回退提示词，不阻断文字与语音 |
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

生成是异步作业：点一次立刻返回，关掉面板再打开还能看到「已中断 / 已取消 / 失败」并重试。
同一组章节重复点「生成精讲」会直接秒开已有模块，不会重复花模型调用。

## 语音

设置页「语音」有三档：

| 供应商 | 要配什么 | 产物 | 适合 |
|---|---|---|---|
| Qwen3-TTS | API Key、模型（默认 `qwen3-tts-flash`）、音色（48 个非实时系统音色） | 每页 `audio/NNN.wav` | 想听云端音色 |
| 浏览器本机朗读 | 音色、语速 | 不产生文件，播放时 `speechSynthesis` | 零成本、无需 Key |
| 关闭 | — | 只出文字 | 只想看 |

- Key 存在 `voice.json`（0600），**面板只显示末 4 位**，不写日志、不写进模块 JSON 或 URL；
  `GET /voice` 只返回 `apiKeyMask`，空输入不会覆盖旧 Key，要清空得点「清除」。
- 生成时 Qwen 逐页合成（并发 2、单页超时 60s、失败重试 1 次）；音频按
  `sha256(provider|model|voice|language_type|text)` 缓存在 `audio-cache/`，同文同音色不重复计费。
- 缺 Key 或某页失败只让模块降级 `ready_degraded`，文字照常出，**不会自动回退浏览器**。
- 费用与限额由千问平台控制；插件只在下发当下下载音频，不保存过期 URL。

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

## 数据在哪

全在本机，默认 `~/.dsh/book-slides/`（可用 `DSH_BOOK_SLIDES_ROOT` 改）：

```
book-slides/
├── voice.json                     ← 语音配置（0600；Qwen Key 只存这里）
├── image.json                     ← 配图策略 / ComfyUI 地址 / 提示词节点
├── comfy-workflow.json            ← 用户导入的工作流（没有就用内置默认）
├── preference.json                ← 分隔条比例、语速、静音
├── progress.json                  ← {lastBookId, lastModuleId, lastSlide}
├── audio-cache/<sha256>.wav       ← Qwen 合成缓存（文本+音色+模型）
├── image-cache/<sha256>.png       ← ComfyUI 出图缓存（提示词+工作流+种子）
├── trash/<bookId>-<时间戳>/      ← 删除是挪进这里，不是真删
└── books/<bookId>/
    ├── book.json                 ← 书名、页数、sha256（存在即导入完成）
    ├── source.pdf                ← 原件副本
    ├── pages.json                ← 逐页原始文本
    ├── chapters.json             ← 切章结果
    ├── toc.json                  ← 目录范围与解析结果（可选）
    └── modules/<moduleId>/
        ├── module.json           ← 状态、阶段、错误码、缓存键、语音、配图汇总
        ├── slides.json           ← 规范化幻灯片（含 source_anchor / audio_ms / image_*）
        ├── image-job.json        ← 后台配图作业的进度快照（可选）
        ├── batches/              ← 生成中的批次检查点，成功后自动删除
        ├── audio/001.wav …       ← Qwen 合成（浏览器朗读时为空）
        └── images/               ← ComfyUI 出图（只给正文页）
            └── 002.png           ← 当前配图
```

隐私边界：PDF、逐页文本、讲稿、音频、配图都只落在上面这个目录；插件不主动外发任何内容。
联网只发生在三处——调 LLM 生成讲稿、调千问合成语音、调你指定的 ComfyUI 出图（三者都只在用户点按钮时发生）；
ComfyUI 地址不是 `127.0.0.1` 时，提示词会发到局域网那台机器。没有遥测、没有云端同步。

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

## 开发

零构建：`index.js` 是普通 ESM，`client.js` 走 `window.__ModuleLoader__.load`，改完重启 DSH 生效。

```powershell
cd dsh-book-slides
npm install
npm test
```

| 测试 | 跑什么 |
|---|---|
| `node test/smoke.test.mjs` | 纯逻辑：正则、清洗、切章、存储、PDF 读取 |
| `node test/server.test.mjs` | 起真服务：导入/书架/书封/Range/改名/删除 + 原文页/偏好/回收站清理 + pdf.js 资源转发 |
| `node test/panel.test.mjs` | react-dom/server 渲染：书架、详情、生成进度、幻灯片舞台、PDF 窗格、高亮几何、播放器首屏 |
| `node test/toc.test.mjs` | 目录解析、校准、抽查、分卷/前言不成章 |
| `node test/toc-llm.test.mjs` | 假模型走真路由：思考吃光 token、JSON 不合格、重试预算 |
| `node test/check.test.mjs` | 真书对照报告的偏移/遗漏分类 |
| `node test/slides.test.mjs` | 分块、页数/字段校验、锚点归一化、朗读时长（纯函数） |
| `node test/generate.test.mjs` | 假模型走真路由：四阶段、修复、锚点修复、取消、超时、幂等、重试复用、播放进度 |
| `node test/tts.test.mjs` | Qwen 配置、Key 掩码、WAV 时长、逐页合成、缓存、部分失败 |
| `node test/qwen.test.mjs` | 假千问服务走真路由：试听、6 页 WAV 落盘、缺 Key、部分失败、缓存、错误 Key |
| `node test/package.test.mjs` | 书档导入/导出：ZIP 往返、只读、幂等、合并、手改保留、篡改/穿越拦截、批量 |
| `node test/comfy.test.mjs` | 配图配置默认值、默认工作流识别、API/界面格式校验、提示词与种子、假 ComfyUI 出图与缺模型 |
| `node test/imaging.test.mjs` | 后台配图作业：只给正文页出图、落盘与状态回写、`/image` 取图、force 换图、失败降级、重启归一、测试生图 |
| `node test/image-auto.test.mjs` | 生成 → 自动起配图作业：模块先 ready，5 张正文页图随后落盘 |

`npm test` 当前 213 项：211 通过、2 项按环境跳过（真书样本没设），0 失败。

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
| [doc/requirements/规范需求.md](doc/requirements/规范需求.md) | v1.0 基线 + v1.1–v1.4 附录（目录切章、语音、书档、配图） |
| [doc/requirements/初步需求.md](doc/requirements/初步需求.md) | 最初一版需求原文（历史存档） |
| [test/truth/README.md](test/truth/README.md) | 真值语料、基线数字、已知缺口 |
| [prompts/](prompts/) | 目录抽取与幻灯片生成的提示词（版本号进缓存键） |
| [doc/qwen/](doc/qwen/) | 千问语音接口与音色表的抓取存档 |
| [doc/z_image/](doc/z_image/) | 默认 ComfyUI 工作流（Z-Image Turbo，API 格式） |

## 许可

MIT，见 [LICENSE](LICENSE)。
