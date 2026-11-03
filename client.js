/**
 * 精讲台 · Client 半体
 *
 * 左侧栏一个「精讲」图标，点开就是书架：
 *   - 拖入 PDF，看得到上传进度与解析等待
 *   - 卡片流看书封、章数、字数、模块数
 *   - 点开一本书：目录切章、勾选章节、生成精讲（M3：进度/取消/重试）
 *   - 生成完进分屏播放器（M4）：左 PDF 视觉版式 + 锚点高亮、右幻灯片、本机朗读、自动翻页、快捷键
 *   - 书架「继续听」回到上次页码；设置页：语音、试听、存储与回收站
 *
 * 本文件不碰磁盘：所有数据走 Host 半体的 /dsh-book-slides/* 路由。
 */
window.__ModuleLoader__.load({
  id: 'dsh-book-slides',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const h = React.createElement;

    const BOOKS_API = '/dsh-book-slides/books';
    const BOOK_API = '/dsh-book-slides/book';
    const IMPORT_API = '/dsh-book-slides/import';
    const RENAME_API = '/dsh-book-slides/rename';
    const DELETE_API = '/dsh-book-slides/delete';
    const REPARSE_API = '/dsh-book-slides/reparse';
    const CHAPTERS_API = '/dsh-book-slides/chapters';
    const TOC_API = '/dsh-book-slides/toc';
    const TOC_PREVIEW_API = '/dsh-book-slides/toc/preview';
    const TOC_PARSE_API = '/dsh-book-slides/toc/parse';
    const TOC_RANGE_API = '/dsh-book-slides/toc/range';
    const GENERATE_API = '/dsh-book-slides/generate';
    const JOB_API = '/dsh-book-slides/job';
    const CANCEL_API = '/dsh-book-slides/cancel';
    const MODULE_API = '/dsh-book-slides/module';
    const AUDIO_API = '/dsh-book-slides/audio';
    const VOICE_API = '/dsh-book-slides/voice';
    const VOICE_PROBE_API = '/dsh-book-slides/voice/probe';
    const PROGRESS_API = '/dsh-book-slides/progress';
    const PREFERENCE_API = '/dsh-book-slides/preference';
    const TRASH_CLEAR_API = '/dsh-book-slides/trash/clear';
    const EXPORT_API = '/dsh-book-slides/export';
    const EXPORT_SIZE_API = '/dsh-book-slides/export/size';
    const PPTX_API = '/dsh-book-slides/export/pptx';
    const PPTX_PLAN_API = '/dsh-book-slides/export/pptx/plan';
    const IMPORT_PACKAGE_API = '/dsh-book-slides/import/package';
    const REVOICE_API = '/dsh-book-slides/revoice';
    const IMAGE_API = '/dsh-book-slides/image';
    const IMAGE_CONFIG_API = '/dsh-book-slides/image/config';
    const IMAGE_WORKFLOW_API = '/dsh-book-slides/image/workflow';
    const IMAGE_PROBE_API = '/dsh-book-slides/image/probe';
    const IMAGE_TEST_API = '/dsh-book-slides/image/test';
    const IMAGE_STATUS_API = '/dsh-book-slides/image/status';
    const IMAGE_REGEN_API = '/dsh-book-slides/image/regen';
    const PDFJS_BASE = '/dsh-book-slides/vendor/pdfjs/';
    const PDFJS_MODULE = PDFJS_BASE + 'build/pdf.min.mjs';
    const PDFJS_WORKER = PDFJS_BASE + 'build/pdf.worker.min.mjs';
    const FILE_API = '/dsh-book-slides/file';
    const COVER_API = '/dsh-book-slides/cover';
    const STORAGE_API = '/dsh-book-slides/storage';
    const PANEL_ID = 'book-slides';

    /** 选章上限，和服务端 index.js 里那组数字保持一致。 */
    const MAX_MODULE_CHAPTERS = 5;
    const MAX_MODULE_CHARS = 60000;

    /* ------------------------------ 样式 ------------------------------ */

    const FONT_CSS = `
.bl-root{height:100%;display:flex;flex-direction:column;position:relative;overflow:hidden;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.6;color:inherit}
.bl-bar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--bl-line);flex:0 0 auto}
.bl-bar-sub{padding:7px 14px;flex-wrap:wrap}
.bl-bar h1{margin:0;font-size:14px;font-weight:600;letter-spacing:.02em}
.bl-grow{flex:1 1 auto;min-width:0}
.bl-body{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:14px}
.bl-line{--bl-line:color-mix(in oklab,currentColor 14%,transparent)}
.bl-btn{appearance:none;border:1px solid var(--bl-line);background:transparent;color:inherit;font:inherit;padding:4px 10px;border-radius:7px;cursor:pointer;white-space:nowrap}
.bl-btn:hover{background:color-mix(in oklab,currentColor 8%,transparent)}
.bl-btn:focus-visible{outline:2px solid color-mix(in oklab,currentColor 45%,transparent);outline-offset:2px}
.bl-btn[disabled]{opacity:.45;cursor:not-allowed}
.bl-btn-primary{border-color:transparent;background:color-mix(in oklab,currentColor 14%,transparent);font-weight:600}
.bl-btn-primary:hover{background:color-mix(in oklab,currentColor 20%,transparent)}
.bl-shelf{display:grid;grid-template-columns:repeat(auto-fill,minmax(122px,1fr));gap:14px;padding-bottom:20px}
.bl-card{position:relative;display:flex;flex-direction:column;gap:6px;cursor:pointer;border-radius:10px;padding:6px;margin:-6px;outline:none}
.bl-card:hover{background:color-mix(in oklab,currentColor 6%,transparent)}
.bl-card:focus-visible{outline:2px solid color-mix(in oklab,currentColor 45%,transparent);outline-offset:2px}
.bl-cover{width:100%;aspect-ratio:300/420;border-radius:6px;overflow:hidden;background:color-mix(in oklab,currentColor 8%,transparent);display:block;object-fit:cover}
.bl-card-title{font-size:12.5px;font-weight:600;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.bl-card-meta{font-size:11px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bl-more{position:absolute;top:10px;right:10px;width:26px;height:26px;border-radius:7px;border:none;background:rgba(0,0,0,.42);color:#fff;cursor:pointer;font-size:13px;line-height:1;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .12s}
.bl-card:hover .bl-more,.bl-more:focus-visible{opacity:1}
.bl-menu{position:absolute;top:40px;right:10px;z-index:20;min-width:118px;padding:4px;border-radius:9px;border:1px solid var(--bl-line);background:Canvas;color:CanvasText;box-shadow:0 10px 26px rgba(0,0,0,.22)}
@supports (background: color-mix(in oklab, white 50%, black)){.bl-menu{background:color-mix(in oklab,Canvas 92%,CanvasText)}}
.bl-menu button{display:block;width:100%;text-align:left;border:none;background:transparent;color:inherit;font:inherit;padding:6px 9px;border-radius:6px;cursor:pointer}
.bl-menu button:hover{background:color-mix(in oklab,currentColor 9%,transparent)}
.bl-menu button.danger{color:#d9484b}
.bl-drop{position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;border:2px dashed color-mix(in oklab,currentColor 35%,transparent);border-radius:12px;background:color-mix(in oklab,Canvas 80%,transparent);font-size:13px;font-weight:600;pointer-events:none}
.bl-empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;padding:30px 18px;opacity:.9}
.bl-empty h2{margin:0;font-size:15px}
.bl-empty p{margin:0;font-size:12.5px;opacity:.65;max-width:280px}
.bl-tip{font-size:11.5px;opacity:.6;margin-top:14px}
.bl-note{border:1px solid var(--bl-line);border-radius:9px;padding:8px 11px;font-size:12px;opacity:.85;margin-bottom:12px;background:color-mix(in oklab,currentColor 4%,transparent)}
.bl-err{border:1px solid #d9484b66;color:#d9484b;background:#d9484b12;border-radius:9px;padding:8px 11px;font-size:12px;margin-bottom:12px;white-space:pre-wrap;word-break:break-word}
.bl-book{display:flex;gap:14px;margin-bottom:14px}
.bl-book-cover{width:96px;flex:0 0 auto;border-radius:6px;overflow:hidden;background:color-mix(in oklab,currentColor 8%,transparent)}
.bl-book-cover img{width:100%;display:block}
.bl-book-info{min-width:0;display:flex;flex-direction:column;gap:4px}
.bl-book-title{font-size:15px;font-weight:600;line-height:1.4;word-break:break-word}
.bl-book-meta{font-size:12px;opacity:.62}
.bl-back{display:inline-flex;align-items:center;gap:5px;border:none;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:2px 0;opacity:.75}
.bl-back:hover{opacity:1}
.bl-list{border:1px solid var(--bl-line);border-radius:10px;overflow:hidden}
.bl-row{display:flex;align-items:flex-start;gap:9px;padding:9px 11px;border-bottom:1px solid var(--bl-line)}
.bl-row:last-child{border-bottom:none}
.bl-row:hover{background:color-mix(in oklab,currentColor 4%,transparent)}
.bl-row input[type=checkbox]{margin:2px 0 0;accent-color:currentColor;flex:0 0 auto}
.bl-row input[type=checkbox]:disabled{opacity:.35}
.bl-row-main{min-width:0;flex:1 1 auto}
.bl-row-title{font-size:12.5px;line-height:1.45;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.bl-row-sub{font-size:11px;opacity:.55;margin-top:1px}
.bl-row.blank .bl-row-title{opacity:.45}
.bl-foot{display:flex;align-items:center;gap:10px;padding:10px 14px;border-top:1px solid var(--bl-line);flex:0 0 auto}
.bl-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12px}
.bl-kv dt{opacity:.55}
.bl-kv dd{margin:0;word-break:break-all}
.bl-progress{height:4px;border-radius:2px;background:color-mix(in oklab,currentColor 12%,transparent);overflow:hidden;margin-top:8px}
.bl-progress i{display:block;height:100%;background:currentColor;transition:width .18s ease}
.bl-spin{display:inline-block;width:12px;height:12px;border:2px solid color-mix(in oklab,currentColor 25%,transparent);border-top-color:currentColor;border-radius:50%;animation:bl-spin .8s linear infinite;vertical-align:-2px}
@keyframes bl-spin{to{transform:rotate(360deg)}}
.bl-input{width:100%;box-sizing:border-box;font:inherit;color:inherit;background:transparent;border:1px solid var(--bl-line);border-radius:7px;padding:5px 8px}
.bl-input:focus-visible{outline:2px solid color-mix(in oklab,currentColor 45%,transparent);outline-offset:1px}
.bl-toolbar{display:flex;align-items:center;gap:8px;margin:10px 0 8px}
.bl-hint{font-size:11px;opacity:.5}
.bl-chapter{border-bottom:1px solid var(--bl-line)}
.bl-chapter:last-child{border-bottom:none}
.bl-row{border-bottom:none}
.bl-row-off .bl-row-title{opacity:.45;text-decoration:line-through}
.bl-more-inline{appearance:none;border:none;background:transparent;color:inherit;cursor:pointer;width:22px;height:22px;border-radius:6px;opacity:.4;font-size:14px;line-height:1;flex:0 0 auto}
.bl-more-inline:hover{opacity:.9;background:color-mix(in oklab,currentColor 8%,transparent)}
.bl-more-inline:focus-visible{outline:2px solid color-mix(in oklab,currentColor 45%,transparent);opacity:1}
.bl-row-menu{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:0 11px 9px 34px;font-size:12px}
.bl-row-menu .bl-btn{padding:3px 9px;font-size:11.5px}
.bl-toc{border:1px solid var(--bl-line);border-radius:9px;padding:9px 11px;margin:10px 0 4px;background:color-mix(in oklab,currentColor 3%,transparent)}
.bl-toc-title{font-size:12.5px;font-weight:600;margin-bottom:6px}
.bl-toc-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.bl-toc-row .bl-btn{padding:3px 9px;font-size:11.5px}
.bl-input-num{width:62px;padding:3px 6px;font-size:12px}
.bl-toc-msg{margin-top:6px;color:inherit;opacity:.85}
.bl-source{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:11.5px;opacity:.68;margin:8px 0 0}
.bl-source-warn{color:#d9484b;opacity:.95}
.bl-toc-preview{max-height:180px;overflow:auto;margin:8px 0 0;padding:8px;border-radius:7px;background:color-mix(in oklab,currentColor 5%,transparent);font:11px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
.bl-mods{margin:12px 0 4px;border:1px solid var(--bl-line);border-radius:10px;overflow:hidden}
.bl-mods-head{display:flex;align-items:center;gap:8px;padding:8px 11px;border-bottom:1px solid var(--bl-line);font-size:12.5px;font-weight:600}
.bl-mod{display:flex;align-items:flex-start;gap:8px;padding:8px 11px;border-bottom:1px solid var(--bl-line);font-size:12px}
.bl-mod:last-child{border-bottom:none}
.bl-mod-main{flex:1 1 auto;min-width:0}
.bl-mod-title{font-size:12.5px;overflow-wrap:anywhere}
.bl-mod-meta{font-size:11px;opacity:.58;margin-top:1px}
.bl-mod-err{font-size:11px;color:#d9484b;margin-top:1px;word-break:break-word}
.bl-mod-actions{display:flex;gap:5px;flex:0 0 auto}
.bl-mod-actions .bl-btn{padding:2px 7px;font-size:11px}
.bl-chip{display:inline-block;border:1px solid var(--bl-line);border-radius:20px;padding:0 7px;font-size:10.5px;line-height:1.7;opacity:.8;white-space:nowrap}
.bl-chip-ok{border-color:#2f9e5566;color:#2f9e55}
.bl-chip-run{border-color:#b8860b66;color:#b8860b}
.bl-chip-bad{border-color:#d9484b66;color:#d9484b}
.bl-mod-run{background:color-mix(in oklab,#b8860b 7%,transparent);box-shadow:inset 3px 0 0 #b8860b;scroll-margin:14px}
.bl-mod-run .bl-mod-title{font-weight:600}
.bl-mod-run .bl-progress{margin-top:7px}
.bl-job-msg{font-size:11.5px;opacity:.7;margin-top:4px}
.bl-slide{border:1px solid var(--bl-line);border-radius:10px;padding:10px 12px;margin-bottom:10px}
.bl-slide-cover{background:color-mix(in oklab,currentColor 5%,transparent)}
.bl-slide-head{display:flex;align-items:center;gap:8px;font-size:11px;opacity:.6;margin-bottom:4px}
.bl-slide-title{font-size:14px;font-weight:600;line-height:1.45;font-family:"Noto Serif SC","Songti SC",serif;overflow-wrap:anywhere}
.bl-slide-sub{font-size:12px;opacity:.65;margin-top:2px}
.bl-slide ul{margin:6px 0 0;padding-left:18px;font-size:12.5px}
.bl-slide li{margin:2px 0;overflow-wrap:anywhere}
.bl-slide-quote{margin-top:6px;padding-left:10px;border-left:2px solid color-mix(in oklab,currentColor 30%,transparent);font-family:"Noto Serif SC","Songti SC",serif;font-size:13.5px;line-height:1.6}
.bl-slide-quote small{display:block;font-family:system-ui;font-size:11px;opacity:.55;margin-top:2px}
.bl-slide-script{margin-top:7px;font-size:12px;line-height:1.7;background:color-mix(in oklab,currentColor 4%,transparent);border-radius:7px;padding:7px 9px;white-space:pre-wrap}
.bl-slide-foot{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:7px;font-size:11px;opacity:.65}
.bl-slide-foot .bl-btn{padding:1px 7px;font-size:11px;opacity:1}
.bl-img-hint{margin-top:6px;font-size:11px;opacity:.6;display:flex;gap:6px;align-items:flex-start}
.bl-img-hint code{font:11px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.bl-voice-note{font-size:11.5px;opacity:.65;margin:6px 0 0;line-height:1.6}
.bl-image-test{margin:8px 0 2px;display:flex;flex-direction:column;gap:6px;align-items:flex-start}
.bl-image-test img{max-width:100%;max-height:320px;border-radius:9px;border:1px solid var(--bl-line,#d8c8ad);display:block;object-fit:contain;background:#f6efe2}
.bl-key-mask{font:11.5px/1.6 ui-monospace,Consolas,monospace;border:1px solid var(--bl-line);border-radius:7px;padding:4px 8px;opacity:.8}
.bl-voice-row{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin:8px 0}
.bl-select{font:inherit;color:var(--dsw-alias-label-primary,CanvasText);background:var(--dsw-alias-bg-layer-2,Canvas);border:1px solid var(--bl-line);border-radius:7px;padding:4px 7px;max-width:100%;color-scheme:light}
body[data-ds-dark-theme] .bl-select{color-scheme:dark}
.bl-select option{background-color:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText)}
.bl-select option:disabled{color:var(--dsw-alias-label-tertiary,GrayText)}
.bl-select:focus-visible{outline:2px solid color-mix(in oklab,currentColor 45%,transparent);outline-offset:1px}
.bl-kv{margin-bottom:14px}
/* ------------------------------ 播放器 ------------------------------ */
.bl-player{height:100%;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base,Canvas);color:var(--dsw-alias-label-primary,CanvasText)}
.bl-player-main{flex:1 1 auto;display:flex;min-height:0;overflow:hidden}
.bl-pane-source{flex:0 0 var(--bl-split,55%);min-width:0;overflow-y:auto;overflow-x:hidden;padding:12px 16px 40px;scroll-behavior:smooth}
.bl-pane-stage{flex:1 1 auto;min-width:0;display:flex;align-items:flex-start;justify-content:center;padding:14px;overflow:auto;background:color-mix(in oklab,currentColor 3%,transparent)}
.bl-divider{flex:0 0 6px;position:relative;cursor:col-resize;touch-action:none}
.bl-divider::before{content:"";position:absolute;left:2px;top:0;bottom:0;width:1px;background:var(--bl-line)}
.bl-divider:hover::before,.bl-divider:focus-visible::before{width:2px;background:currentColor;opacity:.5}
.bl-divider:focus-visible{outline:none}
.bl-source-sticky{position:sticky;top:-12px;z-index:2;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 0;background:var(--dsw-alias-bg-base,Canvas);border-bottom:1px solid var(--bl-line);margin-bottom:10px}
.bl-source-sticky a{color:inherit;text-decoration:none}
.bl-source-banner{border:1px solid var(--bl-line);border-radius:7px;padding:5px 9px;font-size:11.5px;opacity:.7;margin:0 0 10px;background:color-mix(in oklab,currentColor 4%,transparent)}
.bl-pdf-pages{padding-bottom:22px}
.bl-pdf-page{position:relative;margin:0 auto 12px;max-width:100%;min-height:120px;background:#fff;border-radius:5px;box-shadow:0 6px 18px rgba(0,0,0,.16);overflow:hidden}
.bl-pdf-page canvas{display:block;width:100%;height:auto}
.bl-pdf-hl-layer{position:absolute;inset:0;pointer-events:none}
.bl-pdf-hl{position:absolute;background:rgba(240,180,41,.38);box-shadow:0 0 0 1px rgba(217,154,0,.35);border-radius:2px;mix-blend-mode:multiply}
.bl-pdf-page-no{position:absolute;right:8px;top:6px;font-size:10px;color:#8a7355;background:rgba(251,248,241,.85);padding:1px 5px;border-radius:4px}
.bl-stage-wrap{width:100%;max-width:min(100%,calc((100vh - 250px) * 16 / 9));margin:0 auto}
.bl-stage{width:100%;aspect-ratio:16/9;container-type:inline-size;background:#fbf8f1;color:#241f1a;border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,.22);overflow:hidden;position:relative;display:flex;flex-direction:column;padding:clamp(14px,3.4cqw,44px)}
.bl-stage-cover{justify-content:center}
.bl-stage-kicker{font-size:clamp(9px,1.4cqw,15px);letter-spacing:.2em;color:#9a6b3f;margin-bottom:clamp(8px,1.6cqw,18px)}
.bl-stage-title{font-family:"Noto Serif SC","Songti SC",serif;font-size:clamp(20px,5cqw,60px);line-height:1.28;font-weight:700;letter-spacing:.01em;overflow-wrap:anywhere}
.bl-stage-sub{margin-top:clamp(8px,1.8cqw,22px);font-size:clamp(12px,2.1cqw,24px);color:#6f5a43;line-height:1.6}
.bl-stage-rule{width:clamp(40px,8cqw,110px);height:3px;background:#b23a2e;margin-top:clamp(14px,3cqw,34px);border-radius:2px}
.bl-stage-body{display:flex;gap:clamp(14px,3cqw,40px);flex:1;min-height:0;margin-top:clamp(10px,2.4cqw,28px)}
.bl-stage-copy{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;overflow:auto;padding-right:2px}
.bl-stage-bullets{margin:0;padding-left:1.3em;font-size:clamp(11px,1.9cqw,22px);line-height:1.6}
.bl-stage-bullets li{margin:0 0 clamp(6px,1.2cqw,14px);padding-left:.15em;overflow-wrap:anywhere}
.bl-stage-figure{flex:0 0 34%;min-width:0;position:relative;border:1px dashed #c9b79b;border-radius:10px;background:linear-gradient(135deg,#f4ecdf,#fbf7ee);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:clamp(8px,1.6cqw,16px);color:#8a7355;cursor:pointer;text-align:center;overflow:hidden}
.bl-stage-figure:hover{background:linear-gradient(135deg,#f0e6d4,#f8f2e6)}
.bl-stage-figure b{font-size:clamp(11px,1.6cqw,17px);font-weight:600}
.bl-stage-figure span{font-size:clamp(9px,1.3cqw,13px);opacity:.75}
.bl-stage-figure-prompt{font-size:clamp(10px,1.5cqw,15px);line-height:1.6;color:#5c4a33;white-space:pre-wrap;overflow-wrap:anywhere;max-height:100%;overflow:auto;text-align:left}
.bl-stage-figure .bl-btn{color:#5c4a33;border-color:#c9b79b;padding:1px 7px;font-size:11px}
.bl-stage-figure.has-img{padding:0;border-style:solid;border-color:#d8c8ad;background:#f6efe2}
.bl-stage-figure-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:9px;display:block}
.bl-stage-figure-tools{position:absolute;right:6px;bottom:6px;z-index:2;display:flex;gap:4px}
.bl-stage-figure-tools .bl-btn{background:color-mix(in oklab,#fff 84%,transparent);backdrop-filter:blur(3px)}
.bl-stage-figure-prompt{position:relative;z-index:2;background:color-mix(in oklab,#fbf7ee 94%,transparent);border-radius:8px;padding:6px 8px;box-shadow:0 2px 12px rgba(60,40,20,.16)}
.bl-stage-figure-pending{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:#8a7355;font-size:clamp(10px,1.4cqw,13px);background:repeating-linear-gradient(135deg,#f7efe1,#f7efe1 8px,#f3e8d6 8px,#f3e8d6 16px)}
.bl-stage-figure-err{color:#b4453f;font-size:clamp(9px,1.3cqw,12px);line-height:1.4;padding:0 6px;word-break:break-word}
.bl-stage-quote{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:0 4%}
.bl-stage-quote blockquote{margin:0;font-family:"Noto Serif SC","Songti SC",serif;font-size:clamp(17px,3.4cqw,42px);line-height:1.55;color:#2a241c}
.bl-stage-quote cite{margin-top:clamp(10px,2.4cqw,26px);font-style:normal;font-size:clamp(10px,1.6cqw,17px);color:#8a7355;letter-spacing:.06em}
.bl-stage-foot{position:absolute;right:clamp(10px,2cqw,24px);bottom:clamp(8px,1.6cqw,18px);font-size:clamp(8px,1.1cqw,12px);color:#b3a28a;letter-spacing:.08em}
.bl-player-foot{flex:0 0 auto;border-top:1px solid var(--bl-line);padding:8px 12px 10px;display:flex;flex-direction:column;gap:7px;background:var(--dsw-alias-bg-base,Canvas)}
.bl-controls{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0}
.bl-controls .bl-btn{padding:3px 9px}
.bl-play-btn{min-width:88px;font-weight:600}
.bl-pagebar{flex:1 1 120px;min-width:70px;height:5px;border-radius:3px;background:color-mix(in oklab,currentColor 12%,transparent);overflow:hidden}
.bl-pagebar i{display:block;height:100%;background:currentColor;transition:width .15s linear}
.bl-thumbs{display:flex;gap:6px;overflow-x:auto;padding-bottom:2px}
.bl-thumb{position:relative;flex:0 0 98px;height:56px;overflow:hidden;border:1px solid #d8ccb6;background:#fbf8f1;color:#241f1a;font:inherit;font-size:9px;line-height:1.3;padding:15px 6px 4px;border-radius:5px;cursor:pointer;opacity:.72;text-align:left}
.bl-thumb b{position:absolute;left:5px;top:2px;font-size:9px;font-weight:700;color:#b23a2e}
.bl-thumb-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;font-family:"Noto Serif SC","Songti SC",serif}
.bl-thumb-cover{background:#f1e6d2}
.bl-thumb-quote .bl-thumb-title{font-style:italic;text-align:center}
.bl-thumb:hover{opacity:1}
.bl-thumb.on{opacity:1;border-color:#b23a2e;box-shadow:0 0 0 1px #b23a2e}
.bl-noaudio{font-size:11.5px;color:#b8860b}
.bl-player-status{font-size:11.5px;opacity:.65;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bl-continue{margin-top:2px;align-self:flex-start;font-size:11px;padding:2px 7px;border-radius:6px}
.bl-player:fullscreen{background:var(--dsw-alias-bg-base,Canvas)}
.bl-player:fullscreen .bl-player-main{background:var(--dsw-alias-bg-base,Canvas)}
.bl-player:fullscreen .bl-stage-wrap{max-width:min(100%,calc((100vh - 180px) * 16 / 9))}
@media (max-width:1023px){
 .bl-player-main{flex-direction:column}
 .bl-pane-stage{order:1;flex:0 0 46%;padding:8px;background:color-mix(in oklab,currentColor 4%,transparent)}
 .bl-pane-source{order:2;flex:1 1 auto;padding:10px 12px 24px;border-top:1px solid var(--bl-line)}
 .bl-divider{display:none}
 .bl-stage-wrap{max-width:100%;height:100%;display:flex;align-items:center}
}
.bl-pick{position:absolute;top:10px;left:10px;z-index:6;width:18px;height:18px;accent-color:currentColor}
.bl-card.picked{background:color-mix(in oklab,currentColor 10%,transparent);outline:2px solid color-mix(in oklab,currentColor 35%,transparent);outline-offset:2px}
.bl-overlay{position:absolute;inset:0;z-index:45;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.3);padding:16px}
.bl-dialog{width:100%;max-width:390px;max-height:82%;overflow:auto;background:Canvas;color:CanvasText;border:1px solid var(--bl-line);border-radius:12px;padding:14px;box-shadow:0 18px 44px rgba(0,0,0,.32)}
.bl-dialog h2{margin:0 0 8px;font-size:14px}
.bl-dialog p{margin:6px 0;font-size:12px;opacity:.75}
.bl-dialog-foot{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
.bl-check{display:flex;align-items:center;gap:7px;font-size:12.5px;margin:10px 0}
.bl-select{font:inherit;font-size:12px;color:inherit;background:transparent;border:1px solid var(--bl-line);border-radius:7px;padding:3px 6px;max-width:132px}
.bl-pkg-item{display:flex;gap:8px;align-items:baseline;font-size:12px;padding:5px 0;border-bottom:1px dashed var(--bl-line)}
.bl-pkg-item:last-child{border-bottom:none}
.bl-pkg-item .bl-pkg-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bl-pkg-item .bl-pkg-status{flex:0 0 auto;opacity:.75}
.bl-pkg-item.bad .bl-pkg-status{color:#d9484b}
.bl-pkg-sum{font-size:12px;opacity:.8;margin-bottom:6px}
`;

    /* ------------------------------ 数据 ------------------------------ */

    async function getJson(url) {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('请求失败（HTTP ' + res.status + '）');
      const data = await res.json();
      if (!data || data.ok === false) {
        const err = new Error((data && (data.error || data.code)) || '请求失败');
        err.code = data && data.code;
        err.hint = (data && data.hint) || '';
        throw err;
      }
      return data;
    }

    async function postJson(url, body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!data || data.ok === false) {
        const err = new Error((data && (data.error || data.code)) || '请求失败');
        err.code = data && data.code;
        err.hint = (data && data.hint) || '';
        throw err;
      }
      return data;
    }

    async function deleteJson(url) {
      const res = await fetch(url, { method: 'DELETE', headers: { accept: 'application/json' } });
      const data = await res.json().catch(() => ({}));
      if (!data || data.ok === false) {
        const err = new Error((data && (data.error || data.code)) || '删除失败');
        err.code = data && data.code;
        err.hint = (data && data.hint) || '';
        throw err;
      }
      return data;
    }

    /** 上传走 XHR：只有它能拿到字节级进度。 */
    function uploadPdf(file, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', IMPORT_API, true);
        xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name || 'upload.pdf'));
        xhr.setRequestHeader('content-type', 'application/pdf');
        xhr.upload.onprogress = (event) => {
          if (onProgress && event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
        };
        xhr.onload = () => {
          let data = {};
          try {
            data = JSON.parse(xhr.responseText || '{}');
          } catch {
            reject(new Error('服务端返回的不是 JSON'));
            return;
          }
          resolve(data);
        };
        xhr.onerror = () => reject(new Error('上传失败：连接断了'));
        xhr.onabort = () => reject(new Error('已取消上传'));
        xhr.send(file);
      });
    }

    function formatSize(bytes) {
      const n = Number(bytes) || 0;
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
      return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    /** 书档导入走 XHR：GB 级包只有它能给字节级进度。 */
    function uploadPackage(file, policy, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const query = policy ? '?policy=' + encodeURIComponent(policy) : '';
        xhr.open('POST', IMPORT_PACKAGE_API + query, true);
        xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name || 'package.zip'));
        xhr.setRequestHeader('content-type', 'application/zip');
        xhr.upload.onprogress = (event) => {
          if (onProgress && event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
        };
        xhr.onload = () => {
          try {
            resolve(JSON.parse(xhr.responseText || '{}'));
          } catch {
            reject(new Error('服务端返回的不是 JSON'));
          }
        };
        xhr.onerror = () => reject(new Error('上传失败：连接断了'));
        xhr.onabort = () => reject(new Error('已取消上传'));
        xhr.send(file);
      });
    }

    /**
     * 取文件选择框里的文件。必须在清空 input.value **之前**复制：
     * 清空 value 会让浏览器同步清掉 FileList，之后再读 length 就是 0——
     * 那正好是「选了 zip 却什么都不发生」的成因。
     */
    function takeFilesFromInput(event) {
      const target = (event && event.target) || {};
      const picked = target.files ? Array.from(target.files) : [];
      try {
        target.value = '';
      } catch {
        /* 只读 input，忽略 */
      }
      return picked;
    }

    /** 多个包/多次请求的结果合成一张清单：包级错误也要落到 items 里看得见。 */
    function mergeImportResults(results) {
      const items = [];
      const summary = { imported: 0, merged: 0, skipped: 0, failed: 0, modulesAdded: 0, modulesExisting: 0 };
      for (const data of results) {
        if (data && Array.isArray(data.items)) {
          for (const item of data.items) {
            items.push(item);
            if (item.status === 'imported') summary.imported += 1;
            else if (item.status === 'merged') summary.merged += 1;
            else if (item.status === 'skipped') summary.skipped += 1;
            else summary.failed += 1;
            summary.modulesAdded += Number(item.modulesAdded) || 0;
            summary.modulesExisting += Number(item.moduleExists) || 0;
          }
        } else {
          items.push({
            file: '',
            title: '',
            status: 'failed',
            code: (data && data.code) || 'E_PKG_MANIFEST',
            message: (data && (data.error || data.message)) || '导入失败',
          });
          summary.failed += 1;
        }
      }
      return { items, summary, ok: summary.failed === 0 };
    }

    function formatChars(chars) {
      const n = Number(chars) || 0;
      if (n < 10000) return n + ' 字';
      return (n / 10000).toFixed(1) + ' 万字';
    }

    /** 作业阶段与模块状态的中文文案，面板与 aria-label 共用。 */
    const STAGE_LABELS = {
      queued: '排队中',
      structuring: '改写文案',
      validate: '校验结构',
      anchor: '定位原文',
      voicing: '准备配音',
      done: '完成',
    };
    const STATUS_LABELS = {
      queued: '排队中',
      structuring: '生成中',
      validate: '生成中',
      anchor: '生成中',
      voicing: '生成中',
      ready: '已就绪',
      ready_degraded: '部分降级',
      failed: '失败',
      cancelled: '已取消',
      interrupted: '已中断',
    };
    function statusLabel(status) {
      return STATUS_LABELS[status] || String(status || '未知');
    }
    function isReady(status) {
      return status === 'ready' || status === 'ready_degraded';
    }
    function isTerminal(status) {
      return ['ready', 'ready_degraded', 'failed', 'cancelled', 'interrupted'].includes(String(status));
    }

    /** 语速下拉固定三档；配置里若有别的值，临时补一个，避免 select 显示空白。 */
    function rateOptions(value) {
      const base = [0.8, 1, 1.2];
      const rate = Number(value);
      if (Number.isFinite(rate) && !base.includes(rate)) return base.concat([rate]).sort((a, b) => a - b);
      return base;
    }

    /* ------------------------------ 本机朗读（Web Speech） ------------------------------ */

    function speechSupported() {
      return (
        typeof window !== 'undefined' &&
        typeof window.speechSynthesis !== 'undefined' &&
        typeof window.SpeechSynthesisUtterance !== 'undefined'
      );
    }

    function speechVoices() {
      if (!speechSupported()) return [];
      try {
        return window.speechSynthesis.getVoices() || [];
      } catch {
        return [];
      }
    }

    /**
     * 用浏览器本机声音念一段稿子。
     * 先 cancel 再 speak：播放器/试听都只允许一个声音，避免上一页残留（AC-18 的前提）。
     */
    function speakText(text, options) {
      if (!speechSupported()) throw new Error('这个浏览器不支持本机朗读');
      const synth = window.speechSynthesis;
      try {
        synth.cancel();
      } catch {
        /* 有些浏览器初次调用会抛，忽略 */
      }
      const utterance = new window.SpeechSynthesisUtterance(String(text || ''));
      utterance.lang = 'zh-CN';
      const rate = Number(options && options.rate);
      utterance.rate = Number.isFinite(rate) ? Math.min(2, Math.max(0.5, rate)) : 1;
      const volume = Number(options && options.volume);
      utterance.volume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
      const wanted = String((options && options.voice) || '');
      if (wanted) {
        const voice = speechVoices().find((item) => item.name === wanted || item.voiceURI === wanted);
        if (voice) utterance.voice = voice;
      }
      if (options && typeof options.onend === 'function') utterance.onend = options.onend;
      if (options && typeof options.onerror === 'function') utterance.onerror = options.onerror;
      synth.speak(utterance);
      return utterance;
    }

    function stopSpeech() {
      if (!speechSupported()) return;
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* 忽略 */
      }
    }

    /* ------------------------------ PDF 视觉版式（M4 变更） ------------------------------ */

    /**
     * pdf.js 不走 npm bundler：客户端动态 import 宿主同源转发的
     * /dsh-book-slides/vendor/pdfjs/build/pdf.min.mjs，worker 也用同源文件。
     * 这样插件仍然零构建，PDF 字节直接从 /file（支持 Range）流进来。
     */
    let pdfjsPromise = null;

    function loadPdfJs() {
      if (typeof window === 'undefined') return Promise.reject(new Error('没有浏览器环境'));
      if (!pdfjsPromise) {
        pdfjsPromise = import(PDFJS_MODULE)
          .then((mod) => {
            if (mod && mod.GlobalWorkerOptions) mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
            return mod;
          })
          .catch((err) => {
            pdfjsPromise = null;
            throw err;
          });
      }
      return pdfjsPromise;
    }

    async function openPdfDocument(bookId) {
      const pdfjs = await loadPdfJs();
      const task = pdfjs.getDocument({
        url: FILE_API + '?bookId=' + encodeURIComponent(bookId),
        cMapUrl: PDFJS_BASE + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: PDFJS_BASE + 'standard_fonts/',
        wasmUrl: PDFJS_BASE + 'wasm/',
        disableWorkerRendering: true,
        // 播放器一次只看当前 source_pages 的几页，别让 pdf.js 预取整本 200MB
        disableAutoFetch: true,
        isEvalSupported: false,
      });
      const doc = await task.promise;
      // pdf.js 的 destroy 在 loadingTask 上，PDFDocumentProxy 本身不一定有
      return {
        doc: doc,
        destroy: () => {
          try {
            return task.destroy();
          } catch {
            return Promise.resolve();
          }
        },
      };
    }

    /** 与 slides.js 的归一化保持一致：去空白、去标点、全角转半角、小写。 */
    function normalizePdfText(value) {
      return String(value == null ? '' : value)
        .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
        .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
        .replace(/[\s\u3000]+/g, '')
        .replace(/[\p{P}\p{S}]/gu, '')
        .toLowerCase();
    }

    /**
     * 把 source_quote 映射到 pdf.js 文本项的矩形，返回相对页面的百分比坐标。
     * 整句优先，找不到时用前 14 字兜底；按基线聚成行，一行一个高亮块。
     */
    function pdfHighlightRects(items, quote, viewport, pdfjs) {
      const needle = normalizePdfText(quote);
      if (!needle || !Array.isArray(items) || !viewport || !viewport.width || !pdfjs || !pdfjs.Util) return [];
      let text = '';
      const owners = [];
      items.forEach((item, index) => {
        const str = String((item && item.str) || '');
        if (!str) return;
        for (const ch of normalizePdfText(str)) {
          text += ch;
          owners.push(index);
        }
      });
      let start = text.indexOf(needle);
      let length = needle.length;
      if (start < 0) {
        const prefix = needle.slice(0, Math.min(14, needle.length));
        start = text.indexOf(prefix);
        length = prefix.length;
      }
      if (start < 0) return [];

      const used = new Set();
      for (let i = start; i < start + length && i < owners.length; i += 1) used.add(owners[i]);

      // 同一基线的碎片合成一行，避免一句话被拆成十几个小色块
      const lines = new Map();
      for (const index of used) {
        const item = items[index];
        if (!item || !item.transform) continue;
        const tx = pdfjs.Util.transform(viewport.transform, item.transform);
        const fontHeight = Math.max(5, Math.hypot(tx[2], tx[3]));
        const width = Math.max(2, (Number(item.width) || 0) * viewport.scale);
        const x = tx[4];
        const baseline = tx[5];
        const key = Math.round(baseline * 2) / 2;
        const line = lines.get(key);
        if (line) {
          line.left = Math.min(line.left, x);
          line.right = Math.max(line.right, x + width);
        } else {
          lines.set(key, { left: x, right: x + width, top: baseline - fontHeight, height: fontHeight });
        }
      }

      return Array.from(lines.values())
        .map((line) => {
          const left = (line.left / viewport.width) * 100;
          const top = (line.top / viewport.height) * 100;
          const width = ((line.right - line.left) / viewport.width) * 100;
          const height = ((line.height * 1.35) / viewport.height) * 100;
          return {
            left: Math.max(0, Math.min(100, left)),
            top: Math.max(0, Math.min(100, top)),
            width: Math.max(0.5, Math.min(100, width)),
            height: Math.max(0.5, Math.min(100, height)),
          };
        })
        .filter((rect) => rect.left >= 0 && rect.top >= 0 && rect.width > 0 && rect.height > 0);
    }

    /**
     * pdf.js 在 canvas 已有未完成 RenderTask 时会报
     * "Cannot use the same canvas during multiple render() operations"。
     * 取消任务时抛的是 RenderingCancelledException，属于正常控制流，不当作失败。
     */
    function isRenderCancelled(err) {
      const name = String((err && err.name) || '');
      const message = String((err && err.message) || err || '').trim();
      // pdf.js 的取消异常名固定；不能只看 message 里有没有 "cancelled"，
      // 「same canvas ... cancelled or completed」也含这个词，但那是真错误。
      return /RenderingCancel/i.test(name) || /^Rendering cancelled/i.test(message);
    }

    /* ------------------------------ 生成定位 ------------------------------ */

    /**
     * 点「生成精讲」后，把模块列表里对应的「生成中」条目滚进视野，焦点落到「取消」上（AC-14）。
     * 条目就是 JobBox；找不到（例如列表尚未挂载）或嵌入环境不支持滚动时静默放弃。
     */
    function focusJobEntry(root, moduleId) {
      if (!root || !moduleId || typeof root.querySelector !== 'function') return false;
      let node = null;
      try {
        node = root.querySelector('[data-job-item="' + moduleId + '"]');
      } catch {
        return false;
      }
      if (!node) return false;
      if (typeof node.scrollIntoView === 'function') {
        try {
          node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        } catch {
          try {
            node.scrollIntoView({ block: 'center' });
          } catch {
            /* 忽略：某些嵌入环境不接受参数 */
          }
        }
      }
      const cancel = typeof node.querySelector === 'function' ? node.querySelector('[data-job-cancel="1"]') : null;
      if (cancel && typeof cancel.focus === 'function') {
        try {
          cancel.focus({ preventScroll: true });
        } catch {
          try {
            cancel.focus();
          } catch {
            /* 忽略：焦点被别处抢走也不影响取消按钮可见 */
          }
        }
      }
      return true;
    }

    /* ------------------------------ 弹出菜单 ------------------------------ */

    /**
     * 卡片右上「⋯」菜单的关闭规则（M5 体验修复）：
     *   - 点菜单内部 → 交给菜单按钮自己处理；
     *   - 点「⋯」按钮 → 交给它的 onClick 做开/关切换，避免这里抢先关掉；
     *   - 点屏幕上其它任何区域（卡片本体、别的卡片、面板空白、面板外）→ 关闭；
     *   - Esc → 关闭。
     * 挂在 document 上是因为面板外的点击也要能关；走捕获阶段是因为卡片里的「⋯」「继续听」
     * 自己会 stopPropagation，冒泡的监听会被截断、收不到。用 click 而不是 pointerdown 是为了
     * 只认真实点击——拖滚动条、选字、右键按下都不会误关菜单。
     * 这里只关菜单、不拦这次点击：点卡片本体时菜单收起后，点击照常走到卡片自己的 onClick，
     * 于是直接打开这本书（实测就是这样，用户也认可）。返回清理函数，反复开关不堆监听。
     */
    function bindPopupDismiss(doc, options) {
      if (!doc || typeof doc.addEventListener !== 'function') return () => {};
      const opts = options || {};
      const dismiss = typeof opts.onDismiss === 'function' ? opts.onDismiss : null;
      if (!dismiss) return () => {};
      const inside = (element, target) =>
        Boolean(element && target && typeof element.contains === 'function' && element.contains(target));
      const closeIfOutside = (event) => {
        const target = event && event.target;
        if (inside(opts.menu, target) || inside(opts.toggle, target)) return;
        dismiss('outside');
      };
      const closeOnEscape = (event) => {
        if (!event || event.key !== 'Escape') return;
        dismiss('escape');
      };
      doc.addEventListener('click', closeIfOutside, true);
      doc.addEventListener('keydown', closeOnEscape, true);
      return () => {
        doc.removeEventListener('click', closeIfOutside, true);
        doc.removeEventListener('keydown', closeOnEscape, true);
      };
    }

    /* ------------------------------ 组件 ------------------------------ */

    function SlideIcon({ size = 18 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 3, y: 4, width: 18, height: 13, rx: 2 }),
        h('path', { d: 'M12 21h6' }),
        h('path', { d: 'M12 17v4' }),
        h('path', { d: 'M10.2 8.2v4.6l3.9-2.3z', fill: 'currentColor', stroke: 'none' }),
      );
    }

    /** 面板里任何渲染错误都在这里兜住，别把整个 DSH 拖下水。 */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error: error };
      }

      componentDidCatch(error) {
        try {
          console.error('[book-slides] panel error', error);
        } catch {
          /* 忽略 */
        }
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'bl-root bl-line' },
            h(
              'div',
              { className: 'bl-body' },
              h('div', { className: 'bl-err' }, '精讲面板出错了：' + String((this.state.error && this.state.error.message) || this.state.error)),
              h(
                'button',
                { className: 'bl-btn', onClick: () => this.setState({ error: null }) },
                '重试',
              ),
            ),
          );
        }
        return this.props.children;
      }
    }

    function ErrorBanner({ error, onClose }) {
      if (!error) return null;
      return h(
        'div',
        { className: 'bl-err' },
        String(error.message || error),
        error.hint ? '\n' + error.hint : '',
        onClose
          ? h(
              'button',
              { className: 'bl-btn', style: { marginTop: 8 }, onClick: onClose },
              '知道了',
            )
          : null,
      );
    }

    function BookCard({ book, onOpen, onRename, onDelete, progress, onContinue, selecting, selected, onToggleSelect, onExport }) {
      const [menu, setMenu] = useState(false);
      const [renaming, setRenaming] = useState(false);
      const [draft, setDraft] = useState(book.title);
      const [armed, setArmed] = useState(false);
      const inputRef = useRef(null);
      const moreRef = useRef(null);
      const menuRef = useRef(null);
      const resume = progress && progress.lastBookId === book.id && progress.lastModuleId ? progress : null;

      useEffect(() => {
        if (renaming && inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, [renaming]);

      const closeMenu = useCallback((reason) => {
        setMenu(false);
        setArmed(false);
        // Esc 时把焦点还给「⋯」，键盘用户不会掉在空处；点外面时不动焦点。
        if (reason === 'escape' && moreRef.current && typeof moreRef.current.focus === 'function') {
          moreRef.current.focus();
        }
      }, []);

      // 菜单开着时挂全局监听：点屏幕其它区域或按 Esc 都能关。只关菜单、不吞这次点击，
      // 所以点卡片本体仍会进入详情（用户已确认这个行为），点别的卡片/按钮也照常响应。
      useEffect(() => {
        if (!menu) return undefined;
        return bindPopupDismiss(typeof document === 'undefined' ? null : document, {
          menu: menuRef.current,
          toggle: moreRef.current,
          onDismiss: closeMenu,
        });
      }, [menu, closeMenu]);

      const submitRename = useCallback(() => {
        const title = String(draft || '').trim();
        if (!title || title === book.title) {
          setRenaming(false);
          return;
        }
        onRename(book.id, title);
        setRenaming(false);
      }, [draft, book.id, book.title, onRename]);

      return h(
        'div',
        {
          className: 'bl-card bl-line' + (selected ? ' picked' : ''),
          tabIndex: 0,
          role: 'button',
          'aria-label': book.title,
          onClick: () => {
            if (menu || renaming) return;
            if (selecting) {
              onToggleSelect && onToggleSelect(book.id);
              return;
            }
            onOpen(book.id);
          },
          onKeyDown: (event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              if (selecting) {
                onToggleSelect && onToggleSelect(book.id);
                return;
              }
              onOpen(book.id);
            }
          },
        },
        selecting
          ? h('input', {
              type: 'checkbox',
              className: 'bl-pick',
              checked: !!selected,
              'aria-label': '选择《' + book.title + '》',
              onClick: (event) => event.stopPropagation(),
              onChange: () => onToggleSelect && onToggleSelect(book.id),
            })
          : null,
        h('img', { className: 'bl-cover', src: COVER_API + '?bookId=' + encodeURIComponent(book.id), alt: '', loading: 'lazy' }),
        h(
          'button',
          {
            ref: moreRef,
            className: 'bl-more',
            'aria-label': '更多操作',
            'aria-expanded': menu ? 'true' : 'false',
            onClick: (event) => {
              event.stopPropagation();
              setMenu((v) => !v);
              setArmed(false);
            },
          },
          '\u22ef',
        ),
        menu
          ? h(
              'div',
              { ref: menuRef, className: 'bl-menu bl-line', onClick: (event) => event.stopPropagation() },
              h(
                'button',
                {
                  onClick: () => {
                    setMenu(false);
                    setRenaming(true);
                  },
                },
                '改名',
              ),
              h(
                'button',
                {
                  onClick: () => {
                    setMenu(false);
                    if (onExport) onExport(book.id);
                  },
                },
                '导出书档',
              ),
              h(
                'button',
                {
                  className: 'danger',
                  onClick: () => {
                    if (!armed) {
                      setArmed(true);
                      return;
                    }
                    setMenu(false);
                    onDelete(book.id);
                  },
                },
                armed ? '确认删除？' : '删除',
              ),
            )
          : null,
        renaming
          ? h('input', {
              ref: inputRef,
              className: 'bl-input',
              value: draft,
              onClick: (event) => event.stopPropagation(),
              onChange: (event) => setDraft(event.target.value),
              onBlur: submitRename,
              onKeyDown: (event) => {
                if (event.key === 'Enter') submitRename();
                if (event.key === 'Escape') {
                  setDraft(book.title);
                  setRenaming(false);
                }
              },
            })
          : h('div', { className: 'bl-card-title' }, book.title),
        h(
          'div',
          { className: 'bl-card-meta' },
          (book.chapters || 0) + ' 章 · ' + formatChars(book.chars),
          book.modules > 0 ? ' · ' + book.modules + ' 个精讲' : '',
        ),
        resume
          ? h(
              'button',
              {
                className: 'bl-btn bl-continue',
                onClick: (event) => {
                  event.stopPropagation();
                  if (onContinue) onContinue(book.id, resume.lastModuleId, resume.lastSlide);
                },
              },
              '继续听 · 第 ' + (Number(resume.lastSlide) || 1) + ' 页',
            )
          : null,
      );
    }

    function Shelf({
      books,
      loading,
      onOpen,
      onRename,
      onDelete,
      onImport,
      onImportPackage,
      onSelecting,
      selecting,
      selected = [],
      onToggleSelect,
      onExport,
      onPolicyChange,
      policy,
      pkgBusy,
      error,
      onDismissError,
      progress,
      onContinue,
    }) {
      const [dragging, setDragging] = useState(false);
      const dragDepth = useRef(0);

      /* 多选模式下 Esc 退出；卡片「⋯」菜单开着时让菜单先关（AC-31）。 */
      useEffect(() => {
        if (!selecting || typeof document === 'undefined') return undefined;
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          if (document.querySelector('.bl-menu')) return;
          if (onSelecting) onSelecting(false);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [selecting, onSelecting]);

      const handleFiles = useCallback(
        (fileList) => {
          const files = Array.from(fileList || []).filter((f) => /\.pdf$/i.test(f.name || ''));
          if (!files.length) {
            onImport(null, '只支持 .pdf 文件');
            return;
          }
          onImport(files[0], null);
        },
        [onImport],
      );

      return h(
        'div',
        {
          className: 'bl-root bl-line',
          style: { position: 'relative' },
          onDragEnter: (event) => {
            event.preventDefault();
            dragDepth.current += 1;
            setDragging(true);
          },
          onDragOver: (event) => event.preventDefault(),
          onDragLeave: (event) => {
            event.preventDefault();
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          },
          onDrop: (event) => {
            event.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            handleFiles(event.dataTransfer && event.dataTransfer.files);
          },
        },
        h(
          'div',
          { className: 'bl-bar' },
          h('h1', null, '精讲'),
          h('div', { className: 'bl-grow' }),
          h(
            'button',
            { className: 'bl-btn bl-btn-primary', onClick: () => onImport('pick', null) },
            '导入 PDF',
          ),
        ),
        h(
          'div',
          { className: 'bl-bar bl-bar-sub' },
          h('button', { className: 'bl-btn', disabled: !!pkgBusy, onClick: () => onImportPackage && onImportPackage('pick') }, '导入书档'),
          h(
            'select',
            {
              className: 'bl-select',
              value: policy || 'merge',
              title: '已有同一本书时怎么处理',
              onChange: (event) => onPolicyChange && onPolicyChange(event.target.value),
            },
            h('option', { value: 'merge' }, '已有则合并'),
            h('option', { value: 'skip' }, '已有则跳过'),
            h('option', { value: 'copy' }, '已有则另存'),
          ),
          h('button', { className: 'bl-btn', onClick: () => onSelecting && onSelecting(!selecting) }, selecting ? '取消选择' : '选择'),
        ),
        selecting
          ? h(
              'div',
              { className: 'bl-foot' },
              h('span', { className: 'bl-hint' }, selected.length ? '已选 ' + selected.length + ' 本' : '点卡片选择要导出的书'),
              h('span', { className: 'bl-grow' }),
              h(
                'button',
                { className: 'bl-btn bl-btn-primary', disabled: !selected.length, onClick: () => onExport && onExport(selected) },
                '导出书档',
              ),
            )
          : null,
        pkgBusy
          ? h(
              'div',
              { className: 'bl-foot', style: { flexDirection: 'column', alignItems: 'stretch', gap: 4 } },
              h(
                'div',
                { style: { fontSize: 11.5, display: 'flex', gap: 6, minWidth: 0 } },
                h('span', null, '正在导入书档 ' + (pkgBusy.index || 1) + '/' + (pkgBusy.total || 1) + ' · ' + Math.round((pkgBusy.ratio || 0) * 100) + '%'),
                h('span', { className: 'bl-grow' }),
                h('span', { style: { opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '55%' } }, pkgBusy.name || ''),
              ),
              h('div', { className: 'bl-progress' }, h('i', { style: { width: Math.max(6, Math.round((pkgBusy.ratio || 0) * 100)) + '%' } })),
            )
          : null,
        h(
          'div',
          { className: 'bl-body' },
          h(ErrorBanner, { error: error, onClose: onDismissError }),
          loading
            ? h(
                'div',
                { style: { padding: '26px 4px', opacity: 0.7 } },
                h('span', { className: 'bl-spin' }),
                ' 正在翻书架…',
              )
            : books.length === 0
              ? h(
                  'div',
                  { className: 'bl-empty' },
                  h(SlideIcon, { size: 32 }),
                  h('h2', null, '书架还是空的'),
                  h('p', null, '把一份带文字层的 PDF 拖进来，或者点右上角「导入 PDF」。'),
                  h('div', { className: 'bl-tip' }, '扫描件不行：这一版只认已经 OCR 过的纯文本 PDF。'),
                )
              : h(
                  'div',
                  { className: 'bl-shelf' },
                  books.map((book) =>
                    h(BookCard, {
                      key: book.id,
                      book: book,
                      onOpen: onOpen,
                      onRename: onRename,
                      onDelete: onDelete,
                      progress: progress,
                      onContinue: onContinue,
                      selecting: selecting,
                      selected: selected.indexOf(book.id) >= 0,
                      onToggleSelect: onToggleSelect,
                      onExport: (id) => onExport && onExport([id]),
                    }),
                  ),
                ),
          books.length > 0
            ? h('div', { className: 'bl-tip' }, '也可以直接把 PDF 拖进这块面板。')
            : null,
        ),
        dragging ? h('div', { className: 'bl-drop' }, '松手就导入') : null,
      );
    }

    /**
     * 书籍详情：章节清单 + 勾选 + 手动修正。
     * 手动修正全部走服务端的章节操作接口，前端只负责收集意图、刷新结果。
     */
    /**
     * 结果来源提示：当前章节是目录切的还是页眉切的。
     * 另外管一种情况——库里有更准的目录结果，但当前章节是机械重切出来的，
     * 这里要显式提醒「可以重放」，不然用户永远不知道自己丢了什么。
     */
    function SourceNote({ chapters, info }) {
      const list = (chapters || []).filter((c) => !c.front);
      const fromToc = list.length > 0 && list.every((c) => c.source === 'toc');
      const stale = !!(info && info.status === 'verified' && !fromToc);
      return h(
        'div',
        { className: 'bl-source' },
        h(
          'span',
          null,
          '结果来源：' +
            (fromToc ? '目录' : '页眉（机械）') +
            (fromToc && info
              ? ' · 偏移 ' + info.offset + ' 页 · 命中 ' + Math.round((Number(info.hitRate) || 0) * 100) + '%'
              : ''),
        ),
        stale ? h('span', { className: 'bl-source-warn' }, '有更准的目录结果没被采用，点「按目录切章」可以重放') : null,
      );
    }
    /** 目录页码范围 + 预览 + 按目录切章。单独拆出来是为了能直接渲染测。 */
    function TocBox({ toc, onFrom, onTo, onPreview, onParse }) {
      return h(
        'div',
        { className: 'bl-toc' },
        h('div', { className: 'bl-toc-title' }, '按目录切章'),
        h(
          'div',
          { className: 'bl-toc-row' },
          h('span', { className: 'bl-hint' }, '目录页码范围'),
          h('input', {
            className: 'bl-input bl-input-num',
            type: 'number',
            placeholder: '起',
            'aria-label': '目录起始页',
            value: toc.from,
            onChange: (event) => onFrom(event.target.value),
          }),
          h('span', { className: 'bl-hint' }, '–'),
          h('input', {
            className: 'bl-input bl-input-num',
            type: 'number',
            placeholder: '止',
            'aria-label': '目录结束页',
            value: toc.to,
            onChange: (event) => onTo(event.target.value),
          }),
          h('button', { className: 'bl-btn', disabled: toc.busy, onClick: onPreview }, '看这几页'),
          h('button', { className: 'bl-btn bl-btn-primary', disabled: toc.busy, onClick: onParse }, toc.busy ? '读目录中…' : '按目录切章'),
        ),
        h(
          'div',
          { className: 'bl-hint' },
          toc.suggested
            ? '建议 ' + toc.suggested.from + '–' + toc.suggested.to + ' 页（共 ' + toc.total + ' 页），猜得不对就改'
            : '没猜出目录在哪，自己填页码（共 ' + toc.total + ' 页）',
        ),
        toc.message ? h('div', { className: 'bl-hint bl-toc-msg' }, toc.message) : null,
        toc.preview ? h('pre', { className: 'bl-toc-preview' }, toc.preview) : null,
      );
    }
    /**
     * 生成中的模块条目：作为模块列表里的一行，显示阶段 / 进度 / 取消（AC-13 / AC-14）。
     * 和普通模块行共用 .bl-mod 布局，生成一开始就出现在列表顶部，用户不用回头找。
     */
    function JobBox({ job, onCancel, title }) {
      const stage = STAGE_LABELS[job.stage] || statusLabel(job.status);
      const total = Number(job.total) || 0;
      const current = Number(job.current) || 0;
      const pct = total > 0 ? Math.max(4, Math.min(100, Math.round((current / total) * 100))) : 6;
      const cancelling = job.status === 'cancelling';
      const chip = cancelling ? '正在取消' : job.status === 'queued' && job.stage === 'queued' ? '排队中' : '生成中';
      const stageText = stage && stage !== chip ? ' · ' + stage : '';
      return h(
        'div',
        {
          className: 'bl-mod bl-mod-run',
          'data-job-item': job.moduleId || '',
          'data-module-id': job.moduleId || undefined,
          tabIndex: -1,
        },
        h(
          'div',
          { className: 'bl-mod-main' },
          h('div', { className: 'bl-mod-title' }, title || '正在生成的精讲'),
          h(
            'div',
            { role: 'status', 'aria-live': 'polite' },
            h(
              'div',
              { className: 'bl-mod-meta' },
              h('span', { className: 'bl-chip bl-chip-run' }, chip),
              stageText + (total > 0 ? ' · ' + current + '/' + total : ''),
            ),
            h('div', { className: 'bl-job-msg' }, job.message || '正在排队…'),
          ),
          h('div', { className: 'bl-progress' }, h('i', { style: { width: pct + '%' } })),
        ),
        h(
          'div',
          { className: 'bl-mod-actions' },
          h(
            'button',
            {
              className: 'bl-btn',
              disabled: cancelling || !onCancel,
              onClick: onCancel,
              title: cancelling ? '正在停止…' : '停止生成，已完成的步骤会保留',
              'aria-label': '取消生成',
              'data-job-cancel': '1',
            },
            cancelling ? '取消中…' : '取消',
          ),
        ),
      );
    }

    /** 详情页的模块列表：打开 / 重试 / 重新生成 / 删除；生成中的模块就地显示进度与取消。 */
    function ModuleList({ modules, busy, job, onCancel, onOpen, onRetry, onDelete, onRegenerate, onRevoice, onImages, onPptx, imageEnabled }) {
      const list = Array.isArray(modules) ? modules : [];
      const active = job && job.moduleId ? job : null;
      const runningId = active ? active.moduleId : '';
      const runningItem = runningId ? list.find((item) => item.id === runningId) : null;
      const rows = runningId ? list.filter((item) => item.id !== runningId) : list;
      const count = list.length + (runningId && !runningItem ? 1 : 0);
      return h(
        'div',
        { className: 'bl-mods' },
        h(
          'div',
          { className: 'bl-mods-head' },
          h('span', null, '精讲模块'),
          h('span', { className: 'bl-grow' }),
          h('span', { className: 'bl-hint' }, count ? count + ' 个' : '还没有'),
        ),
        active ? h(JobBox, { job: active, onCancel: onCancel, title: runningItem ? runningItem.title : '' }) : null,
        !active && list.length === 0
          ? h('div', { className: 'bl-mod' }, h('div', { className: 'bl-mod-main bl-hint' }, '勾选章节后点底部的「生成精讲」，生成完在这里打开。'))
          : rows.map((item) => {
              const ready = isReady(item.status);
              const bad = item.status === 'failed' || item.status === 'interrupted' || item.status === 'cancelled';
              const chip = ready ? 'bl-chip-ok' : bad ? 'bl-chip-bad' : 'bl-chip-run';
              const images = item.images && typeof item.images === 'object' ? item.images : null;
              const imageBusy = !!images && ['queued', 'running', 'pending'].includes(String(images.status));
              const imageMissing =
                !!images && images.provider === 'comfyui' && (Number(images.failed) > 0 || String(images.status) === 'interrupted');
              const imageText =
                images && images.provider === 'comfyui'
                  ? ' · 配图 ' + (Number(images.done) || 0) + '/' + (Number(images.total) || 0) + (imageBusy ? ' 生成中' : '')
                  : '';
              const canImage =
                ready &&
                !!onImages &&
                imageEnabled &&
                !imageBusy &&
                (imageMissing || !images || images.provider !== 'comfyui' || String(images.status) === 'interrupted');
              return h(
                'div',
                { className: 'bl-mod', key: item.id, 'data-module-id': item.id },
                h(
                  'div',
                  { className: 'bl-mod-main' },
                  h('div', { className: 'bl-mod-title' }, item.title || '精讲'),
                  h(
                    'div',
                    { className: 'bl-mod-meta' },
                    h('span', { className: 'bl-chip ' + chip }, statusLabel(item.status)),
                    ' · ' + (Number(item.slides) || 0) + ' 页 · 锚定 ' + Math.round((Number(item.anchorHitRate) || 0) * 100) + '% · ' +
                      (item.chapters || []).length + ' 章' +
                      (item.status === 'ready_degraded' ? ' · 语音降级' : '') +
                      imageText,
                  ),
                  item.code && item.error && !ready ? h('div', { className: 'bl-mod-err' }, item.code + '：' + item.error) : null,
                ),
                h(
                  'div',
                  { className: 'bl-mod-actions' },
                  ready ? h('button', { className: 'bl-btn', disabled: busy, onClick: () => onOpen(item.id) }, '打开') : null,
                  ready && onPptx
                    ? h('button', { className: 'bl-btn', disabled: busy, title: '导出为 PPT（画面 + 配音 + 备注）', onClick: () => onPptx(item) }, '导出 PPT')
                    : null,
                  item.status === 'ready_degraded' && onRevoice
                    ? h(
                        'button',
                        { className: 'bl-btn', disabled: busy, title: '只重跑配音，不重新生成文案', onClick: () => onRevoice(item) },
                        '仅补配音',
                      )
                    : null,
                  ready && canImage
                    ? h(
                        'button',
                        { className: 'bl-btn', disabled: busy, title: '只补配图，不重跑文案与语音', onClick: () => onImages(item) },
                        images && Number(images.done) > 0 ? '补配图' : '生成配图',
                      )
                    : null,
                  bad ? h('button', { className: 'bl-btn', disabled: busy, onClick: () => onRetry(item) }, '重试') : null,
                  ready ? h('button', { className: 'bl-btn', disabled: busy, title: '重新生成会覆盖这一份', onClick: () => onRegenerate(item) }, '重生成') : null,
                  h('button', { className: 'bl-btn', disabled: busy, onClick: () => onDelete(item) }, '删除'),
                ),
              );
            }),
      );
    }

    /** 幻灯片舞台：独立「书页白」主题，不跟着编辑器明暗变灰（§6.4）。 */
    function SlideStage({ slide, moduleId, onRegenImage }) {
      const [showPrompt, setShowPrompt] = useState(false);
      const [copied, setCopied] = useState(false);
      if (!slide) return null;
      const layout = String(slide.layout || 'content_text');
      const status = String(slide.image_status || 'none');
      const hasImage = status === 'ready' && !!slide.image_file;
      const pending = status === 'pending' || status === 'queued' || status === 'running';
      const failed = status === 'failed';
      const copyPrompt = (event) => {
        if (event) event.stopPropagation();
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(String(slide.image_prompt || ''));
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }
        } catch {
          setCopied(false);
        }
      };
      const regen = (event) => {
        if (event) event.stopPropagation();
        if (onRegenImage) onRegenImage(slide.slide_index);
      };
      const imageSrc =
        IMAGE_API +
        '?moduleId=' +
        encodeURIComponent(String(moduleId || '')) +
        '&i=' +
        encodeURIComponent(String(slide.slide_index)) +
        '&v=' +
        encodeURIComponent(String(slide.image_seed || 0));
      const promptPanel = h(
        'div',
        { className: 'bl-stage-figure-prompt', onClick: (event) => event.stopPropagation() },
        h('div', null, slide.image_prompt || '（没有配图提示词）'),
        h(
          'div',
          { style: { display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' } },
          h('button', { className: 'bl-btn', onClick: copyPrompt }, copied ? '已复制' : '复制提示词'),
          onRegenImage && moduleId
            ? h('button', { className: 'bl-btn', onClick: regen, title: '重新生成这一页的配图' }, failed ? '重试配图' : '换一张')
            : null,
        ),
      );
      const figure = h(
        'div',
        {
          className: 'bl-stage-figure' + (hasImage ? ' has-img' : ''),
          role: 'button',
          tabIndex: 0,
          'aria-label': hasImage ? '配图，点击查看提示词' : '配图提示词',
          onClick: () => setShowPrompt((value) => !value),
          onKeyDown: (event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setShowPrompt((value) => !value);
            }
          },
        },
        hasImage ? h('img', { className: 'bl-stage-figure-img', src: imageSrc, alt: slide.title || '配图' }) : null,
        showPrompt
          ? promptPanel
          : h(
              React.Fragment,
              null,
              hasImage
                ? h(
                    'div',
                    { className: 'bl-stage-figure-tools' },
                    h('button', { className: 'bl-btn', onClick: (event) => { event.stopPropagation(); setShowPrompt(true); } }, '提示词'),
                  )
                : pending
                  ? h(
                      'div',
                      { className: 'bl-stage-figure-pending' },
                      h('b', null, '配图生成中'),
                      h('span', null, '文字与语音不受影响'),
                    )
                  : h(
                      React.Fragment,
                      null,
                      h('b', null, failed ? '配图失败' : '配图位'),
                      h('span', null, failed ? '点击查看提示词或重试' : '点击查看提示词'),
                      failed && slide.image_error ? h('span', { className: 'bl-stage-figure-err' }, String(slide.image_error).slice(0, 120)) : null,
                    ),
            ),
      );
      const foot = h('div', { className: 'bl-stage-foot' }, '第 ' + slide.slide_index + ' 页');

      if (layout === 'cover') {
        return h(
          'div',
          { className: 'bl-stage-wrap' },
          h(
            'div',
            { className: 'bl-stage bl-stage-cover' },
            h('div', { className: 'bl-stage-kicker' }, '精讲'),
            h('div', { className: 'bl-stage-title' }, slide.title || ''),
            slide.subtitle ? h('div', { className: 'bl-stage-sub' }, slide.subtitle) : null,
            h('div', { className: 'bl-stage-rule' }),
            foot,
          ),
        );
      }
      if (layout === 'quote') {
        return h(
          'div',
          { className: 'bl-stage-wrap' },
          h(
            'div',
            { className: 'bl-stage' },
            h('div', { className: 'bl-stage-kicker' }, '原文摘引'),
            h(
              'div',
              { className: 'bl-stage-quote' },
              h('blockquote', null, slide.quote_text || ''),
              h('cite', null, '—— ' + (slide.quote_source || '出处未知')),
            ),
            foot,
          ),
        );
      }
      return h(
        'div',
        { className: 'bl-stage-wrap' },
        h(
          'div',
          { className: 'bl-stage' },
          h('div', { className: 'bl-stage-title' }, slide.title || ''),
          h(
            'div',
            { className: 'bl-stage-body' },
            h(
              'div',
              { className: 'bl-stage-copy' },
              h(
                'ul',
                { className: 'bl-stage-bullets' },
                (Array.isArray(slide.bullet_points) ? slide.bullet_points : []).map((bullet, index) =>
                  h('li', { key: index }, bullet),
                ),
              ),
            ),
            figure,
          ),
          foot,
        ),
      );
    }

    /** 原文窗格：按 source_pages 显示原始文本，命中锚点的段落高亮并滚进视野。 */
    /** 原文窗格：用 pdf.js 把 source_pages 渲染成 PDF 视觉版式，锚点段落叠加高亮。 */
    function SourcePane({ pdfDoc, pdfLoading, pdfError, slide, bookId }) {
      const rootRef = useRef(null);
      const canvasRefs = useRef(new Map());
      const renderTasksRef = useRef(new Map());
      const renderChainRef = useRef(Promise.resolve());
      const renderGenerationRef = useRef(0);
      const [width, setWidth] = useState(0);
      const [highlights, setHighlights] = useState({});
      const [renderError, setRenderError] = useState(null);
      const [highlightMiss, setHighlightMiss] = useState(false);
      const anchor = slide && slide.source_anchor ? slide.source_anchor : null;
      const range = (slide && slide.source_pages) || { from: 1, to: 1 };
      const from = Math.max(1, Math.round(Number(range.from) || 1));
      const to = Math.max(from, Math.round(Number(range.to) || from));
      const chipPage = anchor ? Math.max(1, Math.round(Number(anchor.page) || from)) : from;
      const anchorPage = anchor ? Math.max(1, Math.round(Number(anchor.page) || 0)) : 0;
      const slideKey = slide ? slide.slide_index : 0;
      const quote = slide ? slide.source_quote : '';

      // 窗格宽度决定 canvas 分辨率；百分比高亮不依赖具体像素，所以拖动分隔条不用重算坐标。
      // 防抖：全屏/拖分隔条会连续触发 ResizeObserver，每个像素都重画会把 pdf.js 拖死。
      useEffect(() => {
        const element = rootRef.current;
        if (!element) return undefined;
        let timer = null;
        let last = 0;
        const schedule = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            const next = Math.floor(element.clientWidth - 32);
            if (next > 0 && Math.abs(next - last) >= 8) {
              last = next;
              setWidth(next);
            }
          }, 150);
        };
        schedule();
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(schedule);
          observer.observe(element);
          return () => {
            if (timer) clearTimeout(timer);
            observer.disconnect();
          };
        }
        window.addEventListener('resize', schedule);
        return () => {
          if (timer) clearTimeout(timer);
          window.removeEventListener('resize', schedule);
        };
      }, []);

      useEffect(() => {
        if (!pdfDoc || !width) return undefined;
        const generation = renderGenerationRef.current + 1;
        renderGenerationRef.current = generation;
        const canvasMap = canvasRefs.current;
        setRenderError(null);
        setHighlights({});
        setHighlightMiss(false);

        const cancelTasks = () => {
          for (const task of renderTasksRef.current.values()) {
            try {
              task.cancel();
            } catch {
              /* 已经完成 */
            }
          }
          renderTasksRef.current.clear();
        };

        // 所有渲染串行排队：前一轮 cancel 后必须等它的 promise 落地，
        // 才能对同一个 canvas 再调 page.render（pdf.js 的硬约束）。
        const job = renderChainRef.current.then(async () => {
          if (generation !== renderGenerationRef.current) return;
          const pdfjs = await loadPdfJs();
          const found = {};
          for (let pageNo = from; pageNo <= to; pageNo += 1) {
            if (generation !== renderGenerationRef.current) return;
            const page = await pdfDoc.getPage(pageNo);
            const base = page.getViewport({ scale: 1 });
            const cssScale = Math.max(0.05, width / base.width);
            const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
            const renderViewport = page.getViewport({ scale: cssScale * dpr });
            const canvas = canvasMap.get(pageNo);
            if (!canvas) continue;
            canvas.width = Math.max(1, Math.floor(renderViewport.width));
            canvas.height = Math.max(1, Math.floor(renderViewport.height));
            let task;
            try {
              task = page.render({ canvas: canvas, viewport: renderViewport });
            } catch (err) {
              if (isRenderCancelled(err) || generation !== renderGenerationRef.current) return;
              throw err;
            }
            renderTasksRef.current.set(pageNo, task);
            try {
              await task.promise;
            } catch (err) {
              if (isRenderCancelled(err) || generation !== renderGenerationRef.current) return;
              throw err;
            } finally {
              if (renderTasksRef.current.get(pageNo) === task) renderTasksRef.current.delete(pageNo);
            }
            if (generation !== renderGenerationRef.current) return;
            if (pageNo === anchorPage && quote) {
              const text = await page.getTextContent();
              const rects = pdfHighlightRects(text.items, quote, page.getViewport({ scale: cssScale }), pdfjs);
              if (rects.length) found[pageNo] = rects;
            }
          }
          if (generation !== renderGenerationRef.current) return;
          setHighlights(found);
          setHighlightMiss(!!anchorPage && !!quote && !Object.keys(found).length);
        });

        renderChainRef.current = job.catch(() => {});
        job.catch((err) => {
          if (generation === renderGenerationRef.current && !isRenderCancelled(err)) setRenderError(err);
        });

        return () => {
          // 先让 generation 失效，再 cancel；新 effect 会排在旧 job 之后
          if (renderGenerationRef.current === generation) renderGenerationRef.current += 1;
          cancelTasks();
        };
      }, [pdfDoc, width, from, to, slideKey, quote, anchorPage]);

      // 高亮出来后滚到高亮位置；没有高亮就滚到锚点页顶部
      useEffect(() => {
        if (pdfLoading) return;
        const root = rootRef.current;
        if (!root) return;
        const node = root.querySelector('[data-highlight="1"]') || root.querySelector('[data-anchor="1"]');
        if (node && typeof node.scrollIntoView === 'function') {
          try {
            node.scrollIntoView({ block: 'center' });
          } catch {
            /* 某些嵌入环境不支持参数 */
          }
        }
      }, [highlights, slideKey, pdfLoading]);

      let body = null;
      if (pdfLoading) {
        body = h('div', { style: { padding: '22px 4px', opacity: 0.65 } }, h('span', { className: 'bl-spin' }), ' 正在渲染 PDF 原文…');
      } else if (pdfError) {
        body = h('div', { className: 'bl-err' }, 'PDF 原文没打开：' + String((pdfError && pdfError.message) || pdfError));
      } else if (!pdfDoc) {
        body = h('div', { className: 'bl-note' }, 'PDF 原文还没有加载好。');
      } else {
        const pageNos = [];
        for (let pageNo = from; pageNo <= to; pageNo += 1) pageNos.push(pageNo);
        body = h(
          'div',
          { className: 'bl-pdf-pages' },
          renderError ? h('div', { className: 'bl-err' }, '这一页 PDF 渲染失败：' + String((renderError && renderError.message) || renderError)) : null,
          pageNos.map((pageNo) =>
            h(
              'section',
              {
                className: 'bl-pdf-page',
                key: pageNo,
                'data-page': pageNo,
                'data-anchor': pageNo === anchorPage ? '1' : undefined,
              },
              h('canvas', {
                ref: (node) => {
                  if (node) canvasRefs.current.set(pageNo, node);
                  else canvasRefs.current.delete(pageNo);
                },
              }),
              h(
                'div',
                { className: 'bl-pdf-hl-layer' },
                (highlights[pageNo] || []).map((rect, index) =>
                  h('i', {
                    key: index,
                    className: 'bl-pdf-hl',
                    'data-highlight': index === 0 ? '1' : undefined,
                    style: {
                      left: rect.left + '%',
                      top: rect.top + '%',
                      width: rect.width + '%',
                      height: rect.height + '%',
                    },
                  }),
                ),
              ),
              h('div', { className: 'bl-pdf-page-no' }, '第 ' + pageNo + ' 页'),
            ),
          ),
        );
      }

      return h(
        'div',
        { className: 'bl-pane-source', ref: rootRef },
        h(
          'div',
          { className: 'bl-source-sticky' },
          h('span', { className: 'bl-chip bl-chip-ok' }, '第 ' + chipPage + ' 页'),
          h('span', { className: 'bl-hint' }, from === to ? '原文第 ' + from + ' 页' : '原文第 ' + from + '–' + to + ' 页'),
          h('span', { className: 'bl-grow' }),
          h(
            'a',
            {
              className: 'bl-btn',
              href: FILE_API + '?bookId=' + encodeURIComponent(bookId || '') + '#page=' + chipPage,
              target: '_blank',
              rel: 'noreferrer',
            },
            '打开原始 PDF',
          ),
        ),
        !anchor ? h('div', { className: 'bl-source-banner' }, '本页未定位到原句，显示整页 PDF') : null,
        highlightMiss ? h('div', { className: 'bl-source-banner' }, '本页原句没能在 PDF 页面上定位，显示整页') : null,
        body,
      );
    }

    /**
     * 分屏播放器（M4）。
     *
     * 音频优先级：云端 mp3（audio_file）> 浏览器 speechSynthesis > 无配音。
     * 浏览器朗读没有可 seek 的音频，进度条按 audio_ms 估算；云端音频用 timeupdate。
     * 翻页统一走「停当前 → 改 index → effect 起新页」，旧回调用 token 作废，
     * 避免 AC-18 里上一页的 onend 把播放器又推回下一页。
     */
    function Player({ book, module, slides: incomingSlides, initialSlide, onBack }) {
      const [slides, setSlides] = useState(incomingSlides);
      const total = slides.length;
      const startIndex = Math.min(Math.max(1, Math.round(Number(initialSlide) || 1)), total || 1) - 1;
      const moduleVoice = (module && module.voice) || {};
      const voiceName = String(moduleVoice.voice || '');
      const [index, setIndex] = useState(startIndex);
      const [playing, setPlaying] = useState(false);
      const [imageNote, setImageNote] = useState('');
      const imagePollRef = useRef(0);
      const [pref, setPref] = useState({
        splitRatio: 0.55,
        rate: Number(moduleVoice.rate) || 1,
        muted: false,
      });
      const [split, setSplit] = useState(0.55);
      const [dragging, setDragging] = useState(false);
      const [status, setStatus] = useState('点「开始听」从这一页开始朗读');
      const [noAudio, setNoAudio] = useState(false);
      const [progress, setProgress] = useState(0);
      const [pdfDoc, setPdfDoc] = useState(null);
      const [pdfLoading, setPdfLoading] = useState(true);
      const [pdfError, setPdfError] = useState(null);
      const [fullscreen, setFullscreen] = useState(false);
      const [pptxOpen, setPptxOpen] = useState(false);

      const rootRef = useRef(null);
      const mainRef = useRef(null);
      const audioRef = useRef(null);
      const skipTimerRef = useRef(null);
      const tickTimerRef = useRef(null);
      const preloadRef = useRef(null);
      const tokenRef = useRef(0);
      const indexRef = useRef(index);
      const playingRef = useRef(playing);
      const prefRef = useRef(pref);
      const splitRef = useRef(split);
      const slidesRef = useRef(slides);
      const actionsRef = useRef({});
      indexRef.current = index;
      playingRef.current = playing;
      prefRef.current = pref;
      splitRef.current = split;
      slidesRef.current = slides;

      const slide = slides[index] || null;

      /* 父级重新拉过模块时同步一次；配图作业的轮询结果也写进本地 slides */
      useEffect(() => {
        setSlides(incomingSlides);
      }, [incomingSlides]);

      /**
       * 配图是后台作业：只要还有 pending/queued/running 的页，就轮询
       * /image/status；作业收口后重新拉一次模块，把真图或失败态换进来。
       */
      useEffect(() => {
        const pending = slides.some((item) => item && ['pending', 'queued', 'running'].includes(String(item.image_status || '')));
        if (!pending) return undefined;
        let alive = true;
        let timer = null;
        const tick = async () => {
          try {
            const state = await getJson(IMAGE_STATUS_API + '?moduleId=' + encodeURIComponent(module.id));
            if (!alive) return;
            if (state && state.ok !== false && ['queued', 'running', 'pending'].includes(String(state.status))) {
              imagePollRef.current = 0;
              setImageNote(
                '配图生成中 ' + (Number(state.done) || 0) + '/' + (Number(state.total) || 0) +
                  (Number(state.failed) ? ' · 失败 ' + state.failed : ''),
              );
              timer = setTimeout(tick, 2000);
              return;
            }
            const data = await getJson(MODULE_API + '?moduleId=' + encodeURIComponent(module.id));
            if (!alive) return;
            const next = data && data.slides && Array.isArray(data.slides.slides) ? data.slides.slides : null;
            if (!next) return;
            const stillPending = next.some((item) => item && ['pending', 'queued', 'running'].includes(String(item.image_status || '')));
            imagePollRef.current += 1;
            if (stillPending && imagePollRef.current >= 3) {
              // 服务端已经归一但 slides 还挂着 pending 的极端情况：本地收口，别无限轮询
              setSlides(
                next.map((item) =>
                  item && ['pending', 'queued', 'running'].includes(String(item.image_status || ''))
                    ? Object.assign({}, item, { image_status: 'failed', image_error: 'E_INTERRUPTED：配图没跑起来，可点「补配图」重试' })
                    : item,
                ),
              );
              setImageNote('配图没跑起来，可到模块列表点「补配图」');
              return;
            }
            if (!stillPending) imagePollRef.current = 0;
            setSlides(next);
            setImageNote('');
          } catch {
            if (alive) timer = setTimeout(tick, 4000);
          }
        };
        timer = setTimeout(tick, 1200);
        return () => {
          alive = false;
          if (timer) clearTimeout(timer);
        };
      }, [slides, module.id]);

      /** 单页重出：只跑这一页，成功后轮询自动换图 */
      const regenImage = useCallback(
        async (slideIndex) => {
          try {
            const result = await postJson(IMAGE_REGEN_API, { moduleId: module.id, slide: slideIndex });
            if (!result || result.ok === false) {
              setImageNote(String((result && (result.message || result.code)) || '配图没启动'));
              return;
            }
            setImageNote('已提交，配图生成中…');
            setSlides((prev) =>
              prev.map((item) =>
                Number(item.slide_index) === Number(slideIndex)
                  ? Object.assign({}, item, { image_status: 'pending', image_error: null })
                  : item,
              ),
            );
          } catch (err) {
            setImageNote(String((err && err.message) || err));
          }
        },
        [module.id],
      );

      /* 从「继续听」进来时初始页来自 props；同一播放器里若外部再指定页码，也跟着走 */
      useEffect(() => {
        if (!slides.length) return;
        const next = Math.min(Math.max(1, Math.round(Number(initialSlide) || 1)), slides.length) - 1;
        setIndex(next);
      }, [initialSlide, slides.length]);

      /* 偏好：分隔条比例、语速、静音跨面板保留 */
      useEffect(() => {
        let alive = true;
        getJson(PREFERENCE_API)
          .then((data) => {
            if (!alive || !data || !data.preference) return;
            const next = data.preference;
            setPref((prev) => Object.assign({}, prev, next));
            if (Number.isFinite(Number(next.splitRatio))) setSplit(Number(next.splitRatio));
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, []);

      const savePreference = useCallback((patch) => {
        setPref((prev) => Object.assign({}, prev, patch));
        postJson(PREFERENCE_API, patch).catch(() => {});
      }, []);

      const stopAudio = useCallback(() => {
        tokenRef.current += 1;
        if (skipTimerRef.current) {
          clearTimeout(skipTimerRef.current);
          skipTimerRef.current = null;
        }
        if (tickTimerRef.current) {
          clearInterval(tickTimerRef.current);
          tickTimerRef.current = null;
        }
        if (audioRef.current) {
          const audio = audioRef.current;
          audioRef.current = null;
          try {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
          } catch {
            /* 已经停了 */
          }
        }
        if (speechSupported()) {
          try {
            window.speechSynthesis.cancel();
          } catch {
            /* 忽略 */
          }
        }
      }, []);

      /* 挂载时存一次进度，之后每次翻页都存（AC-19 依赖它） */
      useEffect(() => {
        if (!slides.length) return;
        postJson(PROGRESS_API, { bookId: book.id, moduleId: module.id, slide: index + 1 }).catch(() => {});
      }, [index, book.id, module.id, slides.length]);

      /* 打开整本 PDF；页面渲染由 SourcePane 按 source_pages 做 */
      useEffect(() => {
        let alive = true;
        let handle = null;
        setPdfLoading(true);
        setPdfError(null);
        setPdfDoc(null);
        openPdfDocument(book.id)
          .then((value) => {
            if (!alive) {
              try {
                value.destroy();
              } catch {
                /* 已经销毁 */
              }
              return;
            }
            handle = value;
            setPdfDoc(value.doc);
            setPdfLoading(false);
          })
          .catch((err) => {
            if (!alive) return;
            setPdfError(err);
            setPdfLoading(false);
          });
        return () => {
          alive = false;
          if (handle) {
            try {
              handle.destroy();
            } catch {
              /* 已经销毁 */
            }
          }
        };
      }, [book.id]);

      /* 预加载下一页云端音频；浏览器朗读没有文件可预载 */
      useEffect(() => {
        if (preloadRef.current) {
          try {
            preloadRef.current.pause();
          } catch {
            /* 忽略 */
          }
          preloadRef.current = null;
        }
        const nextSlide = slides[index + 1];
        if (nextSlide && nextSlide.audio_file) {
          try {
            const audio = new Audio(AUDIO_API + '?moduleId=' + encodeURIComponent(module.id) + '&i=' + (index + 2));
            audio.preload = 'auto';
            preloadRef.current = audio;
          } catch {
            preloadRef.current = null;
          }
        }
        return () => {
          if (preloadRef.current) {
            try {
              preloadRef.current.pause();
            } catch {
              /* 忽略 */
            }
            preloadRef.current = null;
          }
        };
      }, [index, module.id, slides]);

      /* 播放：当前页有音频就播，没有就提示并在自动模式下跳过（AC-21） */
      useEffect(() => {
        stopAudio();
        if (!playing) {
          setProgress(0);
          return undefined;
        }
        const token = tokenRef.current;
        const current = indexRef.current;
        const currentSlide = slidesRef.current[current];
        if (!currentSlide) return undefined;
        const canSpeech =
          (currentSlide.audio_provider === 'browser' || !currentSlide.audio_provider) &&
          !!currentSlide.audio_script &&
          speechSupported();
        const mode = currentSlide.audio_file ? 'file' : canSpeech ? 'speech' : 'none';

        const advance = () => {
          if (token !== tokenRef.current) return;
          const next = indexRef.current + 1;
          if (next >= slidesRef.current.length) {
            setPlaying(false);
            setStatus('已经读到最后一页');
            return;
          }
          setStatus('正在播放第 ' + (next + 1) + ' 页');
          setIndex(next);
        };
        const scheduleSkip = () => {
          if (skipTimerRef.current) return;
          skipTimerRef.current = setTimeout(advance, 1100);
        };

        if (mode === 'none') {
          setNoAudio(true);
          setProgress(0);
          const hasNext = current + 1 < slidesRef.current.length;
          setStatus('本页无配音' + (hasNext ? '，即将跳过' : ''));
          if (hasNext) {
            scheduleSkip();
          } else {
            setPlaying(false);
          }
          return () => stopAudio();
        }

        setNoAudio(false);
        setStatus('正在播放第 ' + (current + 1) + ' 页');
        setProgress(0);

        if (mode === 'speech') {
          const estimate = Math.max(1200, Number(currentSlide.audio_ms) || String(currentSlide.audio_script).length * 240);
          const startedAt = Date.now();
          tickTimerRef.current = setInterval(() => {
            if (token !== tokenRef.current) return;
            setProgress(Math.min(0.98, (Date.now() - startedAt) / estimate));
          }, 250);
          try {
            speakText(currentSlide.audio_script, {
              rate: prefRef.current.rate,
              voice: voiceName,
              volume: prefRef.current.muted ? 0 : 1,
              onend: advance,
              onerror: () => {
                if (token !== tokenRef.current) return;
                setNoAudio(true);
                setStatus('本页配音失败');
                if (tickTimerRef.current) {
                  clearInterval(tickTimerRef.current);
                  tickTimerRef.current = null;
                }
                if (current + 1 < slidesRef.current.length) {
                  scheduleSkip();
                } else {
                  setPlaying(false);
                }
              },
            });
          } catch (err) {
            if (tickTimerRef.current) {
              clearInterval(tickTimerRef.current);
              tickTimerRef.current = null;
            }
            setNoAudio(true);
            setStatus('本页配音失败：' + String((err && err.message) || err));
          }
        } else {
          const audio = new Audio(AUDIO_API + '?moduleId=' + encodeURIComponent(module.id) + '&i=' + (current + 1));
          audio.preload = 'auto';
          audio.volume = prefRef.current.muted ? 0 : 1;
          audio.playbackRate = prefRef.current.rate;
          audio.ontimeupdate = () => {
            if (token !== tokenRef.current) return;
            const duration = audio.duration;
            if (Number.isFinite(duration) && duration > 0) setProgress(Math.min(0.99, audio.currentTime / duration));
          };
          audio.onended = advance;
          audio.onerror = () => {
            if (token !== tokenRef.current) return;
            setNoAudio(true);
            setStatus('本页没有音频文件');
            if (current + 1 < slidesRef.current.length) {
              scheduleSkip();
            } else {
              setPlaying(false);
            }
          };
          audioRef.current = audio;
          const promise = audio.play();
          if (promise && typeof promise.catch === 'function') {
            promise.catch(() => {
              if (token !== tokenRef.current) return;
              setPlaying(false);
              setStatus('浏览器阻止了自动播放，点「开始听」继续');
            });
          }
        }
        return () => stopAudio();
      }, [index, playing, pref.rate, pref.muted, module.id, voiceName, stopAudio]);

      /* 分隔条拖动：拖完才写 preference，别在 pointermove 里打接口 */
      useEffect(() => {
        if (!dragging) return undefined;
        const move = (event) => {
          const rect = mainRef.current ? mainRef.current.getBoundingClientRect() : null;
          if (!rect || !rect.width) return;
          const next = Math.min(0.75, Math.max(0.25, (event.clientX - rect.left) / rect.width));
          splitRef.current = next;
          setSplit(next);
        };
        const up = () => {
          setDragging(false);
          postJson(PREFERENCE_API, { splitRatio: splitRef.current }).catch(() => {});
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up, { once: true });
        return () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
      }, [dragging]);

      const adjustSplit = useCallback((delta) => {
        const next = Math.min(0.75, Math.max(0.25, splitRef.current + delta));
        splitRef.current = next;
        setSplit(next);
        postJson(PREFERENCE_API, { splitRatio: next }).catch(() => {});
      }, []);

      const toggleFullscreen = useCallback(async () => {
        const element = rootRef.current;
        if (!element) return;
        try {
          if (document.fullscreenElement) await document.exitFullscreen();
          else if (element.requestFullscreen) await element.requestFullscreen();
        } catch {
          setStatus('浏览器不允许进入全屏');
        }
      }, []);

      useEffect(() => {
        const onChange = () => setFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', onChange);
        return () => document.removeEventListener('fullscreenchange', onChange);
      }, []);

      const togglePlay = useCallback(() => {
        const next = !playingRef.current;
        setPlaying(next);
        setStatus(next ? '正在开始…' : '已暂停');
      }, []);

      const goTo = useCallback(
        (target) => {
          const next = Math.max(0, Math.min(total - 1, Math.round(Number(target) || 0)));
          if (next === indexRef.current) return;
          setIndex(next);
        },
        [total],
      );

      const nextPage = useCallback(() => {
        if (indexRef.current >= total - 1) {
          setPlaying(false);
          setStatus('已经到最后一页');
          return;
        }
        setIndex(indexRef.current + 1);
      }, [total]);

      const prevPage = useCallback(() => {
        if (indexRef.current <= 0) return;
        setIndex(indexRef.current - 1);
      }, []);

      const handleBack = useCallback(() => {
        stopAudio();
        if (onBack) onBack();
      }, [stopAudio, onBack]);

      /* 键盘：空格、←/→、F、Esc（AC-20）；表单控件里不抢键 */
      actionsRef.current = {
        togglePlay: togglePlay,
        next: nextPage,
        prev: prevPage,
        fullscreen: toggleFullscreen,
        back: handleBack,
      };
      useEffect(() => {
        const onKey = (event) => {
          const target = event.target || {};
          const tag = String(target.tagName || '').toUpperCase();
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.code === 'Space') {
            event.preventDefault();
            actionsRef.current.togglePlay();
            return;
          }
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            actionsRef.current.next();
            return;
          }
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            actionsRef.current.prev();
            return;
          }
          if (event.key === 'f' || event.key === 'F') {
            event.preventDefault();
            actionsRef.current.fullscreen();
            return;
          }
          if (event.key === 'Escape') {
            if (document.fullscreenElement) {
              document.exitFullscreen().catch(() => {});
            } else {
              actionsRef.current.back();
            }
          }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, []);

      useEffect(
        () => () => {
          if (preloadRef.current) {
            try {
              preloadRef.current.pause();
            } catch {
              /* 忽略 */
            }
            preloadRef.current = null;
          }
          stopAudio();
        },
        [stopAudio],
      );

      const pageLabel = fromToLabel(slide);
      return h(
        'div',
        {
          className: 'bl-player bl-line',
          ref: rootRef,
          style: { '--bl-split': (split * 100).toFixed(2) + '%', cursor: dragging ? 'col-resize' : undefined },
        },
        h(
          'div',
          { className: 'bl-bar' },
          h('button', { className: 'bl-back', onClick: handleBack }, '\u2039 返回'),
          h('span', { className: 'bl-hint' }, module.title || '精讲'),
          imageNote ? h('span', { className: 'bl-hint bl-toc-msg' }, imageNote) : null,
          h('div', { className: 'bl-grow' }),
          h('span', { className: 'bl-chip' }, '第 ' + (index + 1) + ' / ' + total + ' 页'),
          h('button', { className: 'bl-btn', onClick: toggleFullscreen, title: '全屏（F）' }, fullscreen ? '退出全屏' : '全屏'),
          h(
            'a',
            {
              className: 'bl-btn',
              href: FILE_API + '?bookId=' + encodeURIComponent(book.id),
              target: '_blank',
              rel: 'noreferrer',
            },
            '打开 PDF',
          ),
        ),
        h(
          'div',
          { className: 'bl-player-main', ref: mainRef },
          h(SourcePane, {
            pdfDoc: pdfDoc,
            pdfLoading: pdfLoading,
            pdfError: pdfError,
            slide: slide,
            bookId: book.id,
          }),
          h('div', {
            className: 'bl-divider',
            role: 'separator',
            'aria-orientation': 'vertical',
            'aria-label': '拖动调整原文与幻灯片宽度',
            'aria-valuenow': Math.round(split * 100),
            tabIndex: 0,
            onPointerDown: (event) => {
              event.preventDefault();
              setDragging(true);
            },
            onDoubleClick: () => adjustSplit(0.55 - splitRef.current),
            onKeyDown: (event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                adjustSplit(-0.02);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                adjustSplit(0.02);
              }
            },
          }),
          h('div', { className: 'bl-pane-stage' }, h(SlideStage, { slide: slide, moduleId: module.id, onRegenImage: regenImage })),
        ),
        h(
          'div',
          { className: 'bl-player-foot' },
          module.status === 'ready_degraded'
            ? h(
                'div',
                { className: 'bl-voice-note bl-source-warn' },
                slides.some((item) => item.audio_file)
                  ? '部分页没有音频：播放时会自动跳过，或停在本页显示「本页无配音」。'
                  : '本次没有可用语音（未配置 Qwen 或合成失败），只显示文字。',
              )
            : null,
          h(
            'div',
            { className: 'bl-controls' },
            h(
              'button',
              {
                className: 'bl-btn bl-btn-primary bl-play-btn',
                onClick: togglePlay,
                'aria-label': playing ? '暂停' : '开始听',
              },
              playing ? '暂停' : '开始听',
            ),
            h('button', { className: 'bl-btn', onClick: prevPage, disabled: index === 0, 'aria-label': '上一页' }, '\u2039'),
            h('button', { className: 'bl-btn', onClick: nextPage, disabled: index >= total - 1, 'aria-label': '下一页' }, '\u203a'),
            h('span', { className: 'bl-hint' }, pageLabel),
            h('div', { className: 'bl-pagebar', 'aria-hidden': 'true' }, h('i', { style: { width: Math.round(progress * 100) + '%' } })),
            h('span', { className: 'bl-hint' }, Math.round(progress * 100) + '%'),
            h(
              'select',
              {
                className: 'bl-select',
                'aria-label': '播放语速',
                value: String(pref.rate),
                onChange: (event) => savePreference({ rate: Number(event.target.value) }),
              },
              rateOptions(pref.rate).map((rate) => h('option', { key: rate, value: String(rate) }, rate.toFixed(1) + '×')),
            ),
            h(
              'button',
              { className: 'bl-btn', onClick: () => savePreference({ muted: !pref.muted }), 'aria-label': pref.muted ? '取消静音' : '静音' },
              pref.muted ? '取消静音' : '静音',
            ),
            h('button', { className: 'bl-btn', onClick: () => setPptxOpen(true), title: '导出为 PPT（画面 + 配音 + 备注）' }, '导出 PPT'),
          ),
          h(
            'div',
            { className: 'bl-controls' },
            noAudio ? h('span', { className: 'bl-noaudio' }, '本页无配音') : null,
            h('span', { className: 'bl-player-status' }, status),
            h('span', { className: 'bl-grow' }),
            h('span', { className: 'bl-hint' }, '空格 播放/暂停 · ←/→ 翻页 · F 全屏 · Esc 返回'),
          ),
          h(
            'div',
            { className: 'bl-thumbs' },
            slides.map((item, itemIndex) =>
              h(
                'button',
                {
                  key: item.slide_index,
                  className: 'bl-thumb bl-thumb-' + (item.layout || 'content_text') + (itemIndex === index ? ' on' : ''),
                  title: item.title || '',
                  'aria-label': '跳到第 ' + (itemIndex + 1) + ' 页',
                  'aria-current': itemIndex === index ? 'page' : undefined,
                  onClick: () => goTo(itemIndex),
                },
                h('b', null, itemIndex + 1),
                h('span', { className: 'bl-thumb-title' }, item.title || '未命名'),
              ),
            ),
          ),
        ),
        pptxOpen
          ? h(PptxDialog, {
              moduleId: module.id,
              title: module.title || '精讲',
              onClose: () => setPptxOpen(false),
            })
          : null,
      );
    }

    function fromToLabel(slide) {
      const range = (slide && slide.source_pages) || {};
      const from = Math.round(Number(range.from) || 0);
      const to = Math.round(Number(range.to) || 0);
      if (!from) return '原文页码未知';
      return from === to ? '原文第 ' + from + ' 页' : '原文第 ' + from + '–' + to + ' 页';
    }

    /** 模块入口：取模块数据，就绪就交给分屏播放器。 */
    function ModuleView({ moduleId, initialSlide, onBack, error, setError }) {
      const [state, setState] = useState({ loading: true, module: null, slides: null, book: null });

      useEffect(() => {
        let alive = true;
        setState({ loading: true, module: null, slides: null, book: null });
        getJson(MODULE_API + '?moduleId=' + encodeURIComponent(moduleId))
          .then((data) => {
            if (alive) setState({ loading: false, module: data.module, slides: data.slides, book: data.book });
          })
          .catch((err) => {
            if (!alive) return;
            setState({ loading: false, module: null, slides: null, book: null });
            setError(err);
          });
        return () => {
          alive = false;
          stopSpeech();
        };
      }, [moduleId, setError]);

      if (state.loading) {
        return h(
          'div',
          { className: 'bl-root bl-line' },
          h(
            'div',
            { className: 'bl-bar' },
            h('button', { className: 'bl-back', onClick: onBack }, '\u2039 返回书籍'),
            h('div', { className: 'bl-grow' }),
          ),
          h(
            'div',
            { className: 'bl-body' },
            h(ErrorBanner, { error: error, onClose: () => setError(null) }),
            h('div', { style: { padding: '26px 4px', opacity: 0.7 } }, h('span', { className: 'bl-spin' }), ' 正在打开模块…'),
          ),
        );
      }
      const module = state.module;
      const slides = state.slides && Array.isArray(state.slides.slides) ? state.slides.slides : [];
      if (!module) {
        return h(
          'div',
          { className: 'bl-root bl-line' },
          h(
            'div',
            { className: 'bl-bar' },
            h('button', { className: 'bl-back', onClick: onBack }, '\u2039 返回书籍'),
            h('div', { className: 'bl-grow' }),
          ),
          h(
            'div',
            { className: 'bl-body' },
            h(ErrorBanner, { error: error, onClose: () => setError(null) }),
            h('div', { style: { opacity: 0.7 } }, '这个模块打不开了。'),
          ),
        );
      }
      if (!isReady(module.status)) {
        return h(
          'div',
          { className: 'bl-root bl-line' },
          h(
            'div',
            { className: 'bl-bar' },
            h('button', { className: 'bl-back', onClick: onBack }, '\u2039 返回书籍'),
            h('div', { className: 'bl-grow' }),
          ),
          h(
            'div',
            { className: 'bl-body' },
            h(ErrorBanner, { error: error, onClose: () => setError(null) }),
            h(
              'div',
              { className: 'bl-note' },
              '这个模块还没就绪（' + statusLabel(module.status) + '）。' +
                (module.code ? '错误码 ' + module.code + '：' + (module.error || '') : '回书籍详情重新生成。'),
            ),
          ),
        );
      }
      if (!slides.length) {
        return h(
          'div',
          { className: 'bl-root bl-line' },
          h(
            'div',
            { className: 'bl-bar' },
            h('button', { className: 'bl-back', onClick: onBack }, '\u2039 返回书籍'),
            h('div', { className: 'bl-grow' }),
          ),
          h(
            'div',
            { className: 'bl-body' },
            h(ErrorBanner, { error: error, onClose: () => setError(null) }),
            h('div', { className: 'bl-note' }, '模块里没有幻灯片数据。'),
          ),
        );
      }
      return h(Player, {
        book: state.book || { id: module.bookId, title: '' },
        module: module,
        slides: slides,
        initialSlide: initialSlide,
        onBack: onBack,
      });
    }

    function Detail({ bookId, onBack, error, setError, onOpenModule, onSettings }) {
      const [state, setState] = useState({ loading: true, book: null, chapters: [], modules: [] });
      const [refresh, setRefresh] = useState(0);
      const [busy, setBusy] = useState(false);
      const [selected, setSelected] = useState(() => ({}));
      const [menu, setMenu] = useState(0);
      const [edit, setEdit] = useState(null);
      const [askReparse, setAskReparse] = useState(false);
      const [toc, setToc] = useState({ from: '', to: '', suggested: null, total: 0, info: null, preview: '', busy: false, message: '' });
      const [job, setJob] = useState(null);
      const [jobId, setJobId] = useState('');
      const [jobFocus, setJobFocus] = useState(0);
      const [genBusy, setGenBusy] = useState(false);
      const [pptxModule, setPptxModule] = useState(null);

      /** 详情页滚动容器：生成开始后用它找到对应条目。 */
      const bodyRef = useRef(null);
      /** 已经成功载入过的书；刷新模块列表时不要退回「正在打开」把列表卸掉。 */
      const loadedBookRef = useRef('');

      useEffect(() => {
        let alive = true;
        const sameBook = loadedBookRef.current === bookId;
        setState((prev) => ({ ...prev, loading: sameBook ? prev.loading : true }));
        getJson(BOOK_API + '?bookId=' + encodeURIComponent(bookId))
          .then((data) => {
            if (!alive) return;
            loadedBookRef.current = bookId;
            setState({ loading: false, book: data.book, chapters: data.chapters || [], modules: data.modules || [], imageProvider: data.imageProvider || 'prompt' });
          })
          .catch((err) => {
            if (!alive) return;
            // 刷新失败时保留已经显示的书与模块列表，别把生成中的条目一起卸掉
            setState((prev) =>
              prev.book && prev.book.id === bookId
                ? { ...prev, loading: false }
                : { loading: false, book: null, chapters: [], modules: [] },
            );
            setError(err);
          });
        // 取目录范围：用户上次填的优先，其次是猜测值
        getJson(TOC_API + '?bookId=' + encodeURIComponent(bookId))
          .then((data) => {
            if (!alive) return;
            const suggested = data.suggested || null;
            const saved = data.range || null;
            const use = saved || suggested;
            setToc((prev) => ({
              ...prev,
              total: data.total || 0,
              suggested: suggested,
              info: data.toc || null,
              from: use ? String(use.from) : prev.from,
              to: use ? String(use.to) : prev.to,
            }));
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, [bookId, setError, refresh]);

      /**
       * 范围改了（含首次带出建议值）：防抖存盘 + 重新拉预览。
       * 这样退出再进来，填过的页码和「看这几页」的内容都还在。
       */
      useEffect(() => {
        const from = Number(toc.from);
        const to = Number(toc.to);
        if (!from || !to || to < from) return undefined;
        const timer = setTimeout(async () => {
          try {
            await postJson(TOC_RANGE_API, { bookId: bookId, from: from, to: to });
            const data = await postJson(TOC_PREVIEW_API, { bookId: bookId, from: from, to: to });
            setToc((prev) =>
              Number(prev.from) === from && Number(prev.to) === to
                ? Object.assign({}, prev, { preview: data.preview || '' })
                : prev,
            );
          } catch (err) {
            /* 范围还没填完整时静默，别一边打字一边报错 */
          }
        }, 600);
        return () => clearTimeout(timer);
      }, [bookId, toc.from, toc.to]);

      /**
       * 生成作业轮询：1s 一次。
       * 进入 ready/ready_degraded 就刷新模块列表并打开模块预览；
       * failed/cancelled/interrupted 停在详情页，把错误码亮出来。
       */
      useEffect(() => {
        if (!jobId) return undefined;
        let alive = true;
        let timer = null;
        const tick = async () => {
          try {
            const data = await getJson(JOB_API + '?moduleId=' + encodeURIComponent(jobId));
            if (!alive) return;
            setJob(Object.assign({ moduleId: jobId }, data));
            if (isReady(data.status)) {
              setJobId('');
              setSelected({});
              setRefresh((value) => value + 1);
              setError(null);
              if (onOpenModule) onOpenModule(jobId);
              return;
            }
            if (isTerminal(data.status)) {
              setJobId('');
              setJob(null);
              setRefresh((value) => value + 1);
              if (data.error && data.error.code) {
                const err = new Error(data.error.message || data.error.code);
                err.code = data.error.code;
                err.hint = data.error.hint || '';
                setError(err);
              }
              return;
            }
          } catch (err) {
            if (!alive) return;
            setJobId('');
            setError(err);
            return;
          }
          if (alive) timer = setTimeout(tick, 1000);
        };
        tick();
        return () => {
          alive = false;
          if (timer) clearTimeout(timer);
        };
      }, [jobId, onOpenModule, setError]);

      /** 有模块在后台补配图时，每 4 秒刷新一次模块列表，让「配图 3/18」有变化 */
      useEffect(() => {
        const running = (state.modules || []).some(
          (item) => item.images && ['queued', 'running'].includes(String(item.images.status)),
        );
        if (!running) return undefined;
        const timer = setInterval(() => setRefresh((value) => value + 1), 4000);
        return () => clearInterval(timer);
      }, [state.modules]);

      /** 生成一开始就把模块列表里的对应条目滚进视野，焦点落到「取消」上。 */
      useEffect(() => {
        if (!jobFocus || !jobId || state.loading) return;
        focusJobEntry(bodyRef.current, jobId);
      }, [jobFocus, jobId, state.loading]);

      const book = state.book;
      const chapters = state.chapters || [];
      const visible = useMemo(() => chapters.filter((c) => !c.front), [chapters]);
      const picked = useMemo(() => visible.filter((c) => selected[c.n]), [visible, selected]);
      const pickedChars = picked.reduce((sum, c) => sum + (c.chars || 0), 0);
      const estimate = pickedChars > 0 ? Math.max(6, Math.min(30, Math.round(pickedChars / 2000))) : 0;
      const overLimit = picked.length > MAX_MODULE_CHAPTERS || pickedChars > MAX_MODULE_CHARS;

      /** 勾选：超上限时不静默截断，直接说明为什么勾不上。 */
      const toggle = useCallback(
        (chapter) => {
          if (selected[chapter.n]) {
            setSelected((prev) => {
              const next = { ...prev };
              delete next[chapter.n];
              return next;
            });
            return;
          }
          if (picked.length >= MAX_MODULE_CHAPTERS) {
            setError(new Error('最多选 ' + MAX_MODULE_CHAPTERS + ' 章，先取消别的章'));
            return;
          }
          if (pickedChars + (chapter.chars || 0) > MAX_MODULE_CHARS) {
            setError(new Error('已选内容会超过 ' + MAX_MODULE_CHARS / 10000 + ' 万字，先取消别的章'));
            return;
          }
          setSelected((prev) => ({ ...prev, [chapter.n]: true }));
          setError(null);
        },
        [selected, picked, pickedChars, setError],
      );

      const selectAll = useCallback(() => {
        const next = {};
        let count = 0;
        let chars = 0;
        for (const chapter of visible) {
          if (chapter.hidden || (chapter.chars || 0) < 50) continue;
          if (count >= MAX_MODULE_CHAPTERS) break;
          if (chars + (chapter.chars || 0) > MAX_MODULE_CHARS) break;
          next[chapter.n] = true;
          count += 1;
          chars += chapter.chars || 0;
        }
        setSelected(next);
        if (visible.filter((c) => !c.hidden && (c.chars || 0) >= 50).length > count) {
          setError(new Error('书名下能选的章太多，已按上限选了前 ' + count + ' 章'));
        } else {
          setError(null);
        }
      }, [visible, setError]);

      /** 章节操作：改标题、拆分、合并、排除、恢复。 */
      const runOp = useCallback(
        async (op, extra) => {
          setBusy(true);
          try {
            const data = await postJson(CHAPTERS_API, Object.assign({ bookId: bookId, op: op }, extra || {}));
            setState((prev) => ({
              ...prev,
              chapters: data.chapters || [],
              book: Object.assign({}, prev.book, { chapterCount: data.chapterCount }),
            }));
            const alive = {};
            for (const chapter of data.chapters || []) if (selected[chapter.n]) alive[chapter.n] = true;
            setSelected(alive);
            setMenu(0);
            setError(null);
            return true;
          } catch (err) {
            setError(err);
            return false;
          } finally {
            setBusy(false);
          }
        },
        [bookId, selected, setError],
      );

      const doReparse = useCallback(
        async (force) => {
          setBusy(true);
          setAskReparse('');
          try {
            await postJson(REPARSE_API, { bookId: bookId, force: !!force });
            setSelected({});
            setRefresh((v) => v + 1);
            setError(null);
          } catch (err) {
            // 两种「会覆盖好东西」的情况都要先问一声
            if (err && err.code === 'E_MANUAL_EDITS') setAskReparse('manual');
            else if (err && err.code === 'E_TOC_EXISTS') setAskReparse('toc');
            setError(err);
          } finally {
            setBusy(false);
          }
        },
        [bookId, setError],
      );

      /** 目录页预览：让用户确认自己选的是目录那几页。 */
      const previewToc = useCallback(async () => {
        setToc((prev) => ({ ...prev, busy: true, message: '' }));
        try {
          const data = await postJson(TOC_PREVIEW_API, { bookId: bookId, from: Number(toc.from), to: Number(toc.to) });
          setToc((prev) => ({ ...prev, busy: false, preview: data.preview || '' }));
        } catch (err) {
          setToc((prev) => ({ ...prev, busy: false, preview: '' }));
          setError(err);
        }
      }, [bookId, toc.from, toc.to, setError]);

      /** 按目录切章：模型读目录 → 校准 → 落盘；失败会自动回退并说明原因。 */
      const parseToc = useCallback(
        async (force) => {
          setToc((prev) => ({ ...prev, busy: true, message: '' }));
          setBusy(true);
          try {
            const data = await postJson(TOC_PARSE_API, {
              bookId: bookId,
              from: Number(toc.from),
              to: Number(toc.to),
              force: !!force,
            });
            setSelected({});
            setRefresh((v) => v + 1);
            setError(null);
            if (data.fallback) {
              setToc((prev) => ({ ...prev, busy: false, message: '已按页眉回退：' + String(data.message || data.code) }));
            } else {
              const summary =
                (data.cached ? '用的是上次结果：' : '') +
                data.status +
                ' · 偏移 ' +
                data.offset +
                ' 页 · 标题命中率 ' +
                Math.round((data.hitRate || 0) * 100) +
                '%';
              // 目录被截断时，少掉的章不是模型的错，得说清楚
              const cut = data.truncated ? '；目录原文超过上限被截断，后面的章没读（已读 ' + (data.tocChars || 0) + ' 字）' : '';
              setToc((prev) => ({ ...prev, busy: false, message: summary + cut }));
            }
          } catch (err) {
            setToc((prev) => ({ ...prev, busy: false }));
            if (err && err.code === 'E_MANUAL_EDITS') {
              setToc((prev) => ({ ...prev, message: '有手动修改，确认后点「覆盖并重切」' }));
            }
            setError(err);
          } finally {
            setBusy(false);
          }
        },
        [bookId, toc.from, toc.to, setError],
      );

      /** 生成/重试/重生成共用一个入口：后端按缓存键幂等，重复点不会重复烧钱。 */
      const startGenerate = useCallback(
        async (chapters, force) => {
          setGenBusy(true);
          setError(null);
          try {
            const data = await postJson(GENERATE_API, { bookId: bookId, chapters: chapters, force: !!force });
            if (data.cached) {
              setRefresh((value) => value + 1);
              if (onOpenModule) onOpenModule(data.moduleId);
              return;
            }
            setJob({
              moduleId: data.moduleId,
              status: data.status || 'queued',
              stage: 'queued',
              current: 0,
              total: 0,
              message: data.running ? '已有生成作业在跑，接着看进度' : '已排队',
            });
            setJobId(data.moduleId);
            // 让真实模块记录立刻进列表（标题/章数不必等轮询），随后把这一条滚进视野
            setRefresh((value) => value + 1);
            setJobFocus((value) => value + 1);
          } catch (err) {
            setError(err);
          } finally {
            setGenBusy(false);
          }
        },
        [bookId, onOpenModule, setError],
      );

      const generate = useCallback(() => {
        if (!picked.length) {
          setError(new Error('先勾选至少一章'));
          return;
        }
        startGenerate(
          picked.map((chapter) => chapter.n),
          false,
        );
      }, [picked, startGenerate, setError]);

      const retryModule = useCallback(
        (item) => startGenerate(item.chapters || [], false),
        [startGenerate],
      );

      const regenerateModule = useCallback(
        (item) => {
          const ok = typeof window === 'undefined' || window.confirm('重新生成会覆盖「' + (item.title || '这个模块') + '」，确定？');
          if (ok) startGenerate(item.chapters || [], true);
        },
        [startGenerate],
      );

      const revoiceModule = useCallback(
        async (item) => {
          setBusy(true);
          try {
            const data = await postJson(REVOICE_API, { moduleId: item.id });
            setRefresh((value) => value + 1);
            if (data && data.degraded) {
              const err = new Error('有 ' + (data.total - data.voiced) + ' 页配音失败，可稍后再补');
              err.code = data.code;
              setError(err);
            } else {
              setError(null);
            }
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        },
        [setError],
      );

      /** 补配图：只补失败/缺图的页，不重跑文案与语音（v1.4） */
      const imagesModule = useCallback(
        async (item) => {
          setBusy(true);
          try {
            const data = await postJson(IMAGE_REGEN_API, { moduleId: item.id });
            setRefresh((value) => value + 1);
            if (!data || data.ok === false) {
              const err = new Error(String((data && (data.message || data.code)) || '配图没启动'));
              err.code = data && data.code;
              setError(err);
            } else {
              setError(null);
            }
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        },
        [setError],
      );

      const removeModule = useCallback(        async (item) => {
          const ok = typeof window === 'undefined' || window.confirm('删除「' + (item.title || '这个模块') + '」？只删模块，不动书。');
          if (!ok) return;
          setBusy(true);
          try {
            await deleteJson(MODULE_API + '?moduleId=' + encodeURIComponent(item.id));
            setRefresh((value) => value + 1);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        },
        [setError],
      );

      const cancelGenerate = useCallback(async () => {
        if (!job || !job.moduleId) return;
        try {
          await postJson(CANCEL_API, { moduleId: job.moduleId });
          setJob((prev) => (prev ? Object.assign({}, prev, { status: 'cancelling', message: '正在取消…' }) : prev));
        } catch (err) {
          setError(err);
        }
      }, [job, setError]);

      const submitEdit = useCallback(async () => {
        if (!edit) return;
        if (edit.mode === 'rename') {
          const title = String(edit.value || '').trim();
          if (!title) {
            setEdit(null);
            return;
          }
          if (await runOp('rename', { n: edit.n, title: title })) setEdit(null);
          return;
        }
        const page = Math.round(Number(edit.value) || 0);
        if (!page) {
          setError(new Error('填一个页码'));
          return;
        }
        if (await runOp('split', { n: edit.n, page: page })) setEdit(null);
      }, [edit, runOp, setError]);

      const renderMenu = (chapter, hasNext) =>
        h(
          'div',
          { className: 'bl-row-menu' },
          h(
            'button',
            {
              className: 'bl-btn',
              disabled: busy,
              onClick: () => setEdit({ n: chapter.n, mode: 'rename', value: chapter.title }),
            },
            '改名',
          ),
          h(
            'button',
            {
              className: 'bl-btn',
              disabled: busy,
              onClick: () =>
                setEdit({ n: chapter.n, mode: 'split', value: String(Math.floor((chapter.from + chapter.to) / 2) || chapter.from + 1) }),
            },
            '从这里拆分',
          ),
          h(
            'button',
            {
              className: 'bl-btn',
              disabled: busy || !hasNext,
              onClick: () => runOp('merge', { n: chapter.n }),
            },
            '与下一章合并',
          ),
          h(
            'button',
            {
              className: 'bl-btn',
              disabled: busy,
              onClick: () => runOp(chapter.hidden ? 'include' : 'exclude', { n: chapter.n }),
            },
            chapter.hidden ? '恢复本章' : '排除本章',
          ),
        );

      const renderRow = (chapter, hasNext) => {
        const editing = edit && edit.n === chapter.n;
        const blank = (chapter.chars || 0) < 50;
        return h(
          'div',
          { key: chapter.n, className: 'bl-chapter' },
          h(
            'div',
            { className: 'bl-row' + (chapter.hidden ? ' bl-row-off' : '') + (blank ? ' blank' : '') },
            h('input', {
              type: 'checkbox',
              checked: !!selected[chapter.n],
              disabled: chapter.hidden || blank,
              title: chapter.hidden ? '已排除' : blank ? '空白页，不能选' : '选中合成一个精讲模块',
              'aria-label': '选择 ' + chapter.title,
              onChange: () => toggle(chapter),
            }),
            h(
              'div',
              { className: 'bl-row-main' },
              editing && edit.mode === 'rename'
                ? h('input', {
                    className: 'bl-input',
                    autoFocus: true,
                    value: edit.value,
                    onChange: (event) => setEdit(Object.assign({}, edit, { value: event.target.value })),
                    onBlur: submitEdit,
                    onKeyDown: (event) => {
                      if (event.key === 'Enter') submitEdit();
                      if (event.key === 'Escape') setEdit(null);
                    },
                  })
                : h('div', { className: 'bl-row-title', title: chapter.title }, chapter.title),
              h(
                'div',
                { className: 'bl-row-sub' },
                '第 ' + chapter.from + (chapter.to !== chapter.from ? '–' + chapter.to : '') + ' 页 · ' + formatChars(chapter.chars),
                chapter.hidden ? ' · 已排除' : '',
                chapter.manual ? ' · 手改' : '',
              ),
            ),
            h(
              'button',
              {
                className: 'bl-more-inline',
                'aria-label': '章节操作',
                onClick: () => {
                  setMenu(menu === chapter.n ? 0 : chapter.n);
                  setEdit(null);
                },
              },
              '\u22ef',
            ),
          ),
          menu === chapter.n ? renderMenu(chapter, hasNext) : null,
          editing && edit.mode === 'split'
            ? h(
                'div',
                { className: 'bl-row-menu' },
                h('span', { style: { fontSize: 11.5, opacity: 0.6 } }, '从第 ' + chapter.from + '–' + chapter.to + ' 页里切开：'),
                h('input', {
                  className: 'bl-input',
                  style: { width: 70 },
                  type: 'number',
                  autoFocus: true,
                  min: chapter.from + 1,
                  max: chapter.to,
                  value: edit.value,
                  onChange: (event) => setEdit(Object.assign({}, edit, { value: event.target.value })),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') submitEdit();
                    if (event.key === 'Escape') setEdit(null);
                  },
                }),
                h('button', { className: 'bl-btn bl-btn-primary', disabled: busy, onClick: submitEdit }, '切开'),
                h('button', { className: 'bl-btn', onClick: () => setEdit(null) }, '取消'),
              )
            : null,
        );
      };

      return h(
        'div',
        { className: 'bl-root bl-line' },
        h(
          'div',
          { className: 'bl-bar' },
          h('button', { className: 'bl-back', onClick: onBack }, '\u2039 书架'),
          h('div', { className: 'bl-grow' }),
          onSettings
            ? h('button', { className: 'bl-btn', title: '语音与存储设置', onClick: onSettings }, '\u2699 设置')
            : null,
          book
            ? h(
                'button',
                { className: 'bl-btn', disabled: busy, title: '按当前的切章规则重切一遍，不用重传 PDF', onClick: () => doReparse(false) },
                busy ? '处理中…' : '重新解析',
              )
            : null,
          book
            ? h(
                'a',
                {
                  className: 'bl-btn',
                  href: FILE_API + '?bookId=' + encodeURIComponent(bookId),
                  target: '_blank',
                  rel: 'noreferrer',
                  style: { textDecoration: 'none' },
                },
                '打开 PDF',
              )
            : null,
        ),
        h(
          'div',
          { className: 'bl-body', ref: bodyRef },
          h(ErrorBanner, { error: error, onClose: () => setError(null) }),
          askReparse
            ? h(
                'div',
                { className: 'bl-note' },
                askReparse === 'toc'
                  ? '当前章节是按目录切出来的，按页眉重切会丢掉它。'
                  : '这本书有手动改过的章节，重新解析会覆盖它们。',
                h(
                  'button',
                  { className: 'bl-btn', style: { marginLeft: 8 }, disabled: busy, onClick: () => doReparse(true) },
                  '覆盖并重解析',
                ),
                h(
                  'button',
                  { className: 'bl-btn', style: { marginLeft: 6 }, onClick: () => setAskReparse('') },
                  '算了',
                ),
              )
            : null,
          state.loading
            ? h('div', { style: { padding: '26px 4px', opacity: 0.7 } }, h('span', { className: 'bl-spin' }), ' 正在打开…')
            : book
              ? h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'bl-book' },
                    h('div', { className: 'bl-book-cover' }, h('img', { src: COVER_API + '?bookId=' + encodeURIComponent(bookId), alt: '' })),
                    h(
                      'div',
                      { className: 'bl-book-info' },
                      h('div', { className: 'bl-book-title' }, book.title),
                      h('div', { className: 'bl-book-meta' }, book.author ? book.author : '作者未知'),
                      h(
                        'div',
                        { className: 'bl-book-meta' },
                        (book.pages || 0) + ' 页 · ' + visible.length + ' 章 · ' + formatChars(book.chars),
                      ),
                      h(
                        'div',
                        { className: 'bl-book-meta' },
                        state.modules.length ? state.modules.length + ' 个精讲模块' : '还没有精讲模块',
                      ),
                    ),
                  ),
                  h(ModuleList, {
                    modules: state.modules,
                    busy: busy || genBusy,
                    job: jobId ? job : null,
                    onCancel: cancelGenerate,
                    onOpen: (id) => onOpenModule && onOpenModule(id),
                    onRetry: retryModule,
                    onDelete: removeModule,
                    onRegenerate: regenerateModule,
                    onRevoice: revoiceModule,
                    onImages: imagesModule,
                    onPptx: setPptxModule,
                    imageEnabled: state.imageProvider === 'comfyui',
                  }),
                  h(TocBox, {
                    toc: toc,
                    onFrom: (value) => setToc((prev) => Object.assign({}, prev, { from: value, preview: '' })),
                    onTo: (value) => setToc((prev) => Object.assign({}, prev, { to: value, preview: '' })),
                    onPreview: previewToc,
                    onParse: () => parseToc(false),
                  }),
                  h(SourceNote, { chapters: chapters, info: toc.info }),
                  h(
                    'div',
                    { className: 'bl-toolbar' },
                    h('button', { className: 'bl-btn', disabled: busy, onClick: selectAll }, '全选'),
                    h(
                      'button',
                      { className: 'bl-btn', disabled: busy || picked.length === 0, onClick: () => setSelected({}) },
                      '清空',
                    ),
                    h('div', { className: 'bl-grow' }),
                    h('span', { className: 'bl-hint' }, '上限 ' + MAX_MODULE_CHAPTERS + ' 章 · ' + MAX_MODULE_CHARS / 10000 + ' 万字'),
                  ),
                  visible.length === 0
                    ? h('div', { className: 'bl-note' }, '这本书没切出章节，点右上角「重新解析」试试。')
                    : h(
                        'div',
                        { className: 'bl-list' },
                        visible.map((chapter, index) => renderRow(chapter, index + 1 < visible.length)),
                      ),
                )
              : h('div', { style: { opacity: 0.7 } }, '这本书打不开了。'),
        ),
        h(
          'div',
          { className: 'bl-foot' },
          h(
            'div',
            { className: 'bl-grow', style: { fontSize: 11.5, opacity: overLimit ? 1 : 0.62, color: overLimit ? '#d9484b' : 'inherit' } },
            picked.length === 0
              ? '勾选章节，合成一个精讲模块'
              : '已选 ' + picked.length + ' 章 · ' + formatChars(pickedChars) + ' · 预计 ' + estimate + ' 页' + (overLimit ? ' · 超上限' : ''),
          ),
          h(
            'button',
            {
              className: 'bl-btn bl-btn-primary',
              disabled: genBusy || !!jobId || picked.length === 0 || overLimit,
              title: overLimit
                ? '最多 ' + MAX_MODULE_CHAPTERS + ' 章、' + MAX_MODULE_CHARS / 10000 + ' 万字'
                : '把这 ' + picked.length + ' 章合成一个精讲模块',
              onClick: generate,
            },
            genBusy || jobId ? '生成中…' : '生成精讲',
          ),
        ),
        pptxModule
          ? h(PptxDialog, {
              moduleId: pptxModule.id,
              title: pptxModule.title || '精讲',
              onClose: () => setPptxModule(null),
            })
          : null,
      );
    }

    /**
     * 设置 → 配图（v1.4）：策略、ComfyUI 地址、工作流导入。
     * 工作流只接受「保存（API 格式）」的 JSON；识别到多个文本节点时让用户选一次。
     */
    function ImageSettings() {
      const [image, setImage] = useState(null);
      const [providers, setProviders] = useState([]);
      const [form, setForm] = useState({ provider: 'prompt', host: '', port: '', styleSuffix: '' });
      const [workflow, setWorkflow] = useState(null);
      const [candidates, setCandidates] = useState([]);
      const [pendingWorkflow, setPendingWorkflow] = useState(null);
      const [selectedNode, setSelectedNode] = useState('');
      const [message, setMessage] = useState('');
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [testPrompt, setTestPrompt] = useState('');
      const [testImage, setTestImage] = useState(null);
      const [testing, setTesting] = useState(false);
      const testUrlRef = useRef('');

      const apply = useCallback((config) => {
        const value = config || {};
        setImage(value);
        setForm({
          provider: value.provider || 'prompt',
          host: value.host || '',
          port: value.port ? String(value.port) : '',
          styleSuffix: value.styleSuffix || '',
        });
        setWorkflow(value.workflow || null);
        setCandidates((value.workflow && value.workflow.candidates) || []);
        setSelectedNode((value.workflow && value.workflow.promptNode) || '');
      }, []);

      useEffect(() => {
        let alive = true;
        getJson(IMAGE_CONFIG_API)
          .then((data) => {
            if (!alive) return;
            setProviders(data.providers || []);
            apply(data.image);
            setTestPrompt((prev) => prev || (data.image && data.image.testPrompt) || '');
          })
          .catch((err) => {
            if (alive) setError(err);
          });
        return () => {
          alive = false;
        };
      }, [apply]);

      /* 预览图是 blob URL，卸载时必须还回去 */
      useEffect(
        () => () => {
          if (testUrlRef.current) {
            try {
              URL.revokeObjectURL(testUrlRef.current);
            } catch {
              /* 已经释放 */
            }
            testUrlRef.current = '';
          }
        },
        [],
      );

      const save = useCallback(
        async (patch) => {
          setBusy(true);
          setMessage('');
          try {
            const data = await postJson(IMAGE_CONFIG_API, Object.assign({}, form, patch || {}));
            apply(data.image);
            setMessage('已保存');
            setError(null);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        },
        [form, apply],
      );

      const probe = useCallback(async () => {
        setBusy(true);
        setMessage('正在连接 ComfyUI…');
        setError(null);
        try {
          const data = await postJson(IMAGE_PROBE_API, {});
          if (!data || data.ok === false) {
            const err = new Error(String((data && (data.error || data.code)) || '连接失败'));
            err.code = data && data.code;
            throw err;
          }
          const missing = Array.isArray(data.missing) ? data.missing : [];
          setMessage(
            '连接成功：ComfyUI ' + (data.version || '未知版本') +
              (missing.length ? '；工作流缺模型 ' + missing.slice(0, 3).join('、') : '；工作流所需模型齐全'),
          );
        } catch (err) {
          setMessage(String((err && err.message) || err));
        } finally {
          setBusy(false);
        }
      }, []);

      /** 测试生图：走完整出图链路，但只在内存里预览，不写模块、不进缓存 */
      const testGenerate = useCallback(async () => {
        setTesting(true);
        setMessage('正在让 ComfyUI 出图…');
        setError(null);
        try {
          const res = await fetch(IMAGE_TEST_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: testPrompt }),
          });
          const type = String(res.headers.get('content-type') || '');
          if (type.includes('image/')) {
            const blob = await res.blob();
            if (testUrlRef.current) {
              try {
                URL.revokeObjectURL(testUrlRef.current);
              } catch {
                /* 已经释放 */
              }
            }
            const url = URL.createObjectURL(blob);
            testUrlRef.current = url;
            const ms = Number(res.headers.get('x-image-ms')) || 0;
            const seed = res.headers.get('x-image-seed') || '';
            setTestImage({ url: url, ms: ms, seed: seed, bytes: blob.size });
            setMessage('测试生图成功：' + (ms ? (ms / 1000).toFixed(1) + ' 秒 · ' : '') + Math.max(1, Math.round(blob.size / 1024)) + ' KB');
            return;
          }
          const data = await res.json().catch(() => ({}));
          setMessage(String((data && (data.error || data.code)) || '测试生图失败') + (data && data.hint ? '：' + data.hint : ''));
        } catch (err) {
          setMessage(String((err && err.message) || err));
        } finally {
          setTesting(false);
        }
      }, [testPrompt]);

      const submitWorkflow = useCallback(
        async (json, name, promptNode) => {
          setBusy(true);
          setMessage('');
          setError(null);
          try {
            const data = await postJson(IMAGE_WORKFLOW_API, {
              workflow: json,
              name: name || 'imported-workflow.json',
              promptNode: promptNode || undefined,
            });
            if (!data || data.ok === false) {
              const list = (data && data.candidates) || [];
              if (list.length) {
                setPendingWorkflow({ json: json, name: name });
                setCandidates(list);
                setSelectedNode('');
                setMessage('这份工作流有多个文本节点：选一个作为提示词入口，再点「用这个节点」。');
              } else {
                setMessage(String((data && (data.error || data.code)) || '导入失败'));
              }
              return;
            }
            setPendingWorkflow(null);
            apply(data.image);
            setMessage('工作流已导入，之后的配图都用它');
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        },
        [apply],
      );

      const importFile = useCallback(
        async (event) => {
          const files = takeFilesFromInput(event);
          const file = files[0];
          if (!file) return;
          let json = null;
          try {
            json = JSON.parse(await file.text());
          } catch {
            setMessage('这个文件不是合法 JSON，确认导出的是 API 格式工作流');
            return;
          }
          await submitWorkflow(json, file.name, '');
        },
        [submitWorkflow],
      );

      const resetDefault = useCallback(async () => {
        const ok = typeof window === 'undefined' || window.confirm('恢复内置默认工作流（Z-Image Turbo）？导入的那份会被删掉。');
        if (!ok) return;
        setBusy(true);
        setMessage('');
        try {
          const data = await postJson(IMAGE_WORKFLOW_API, { reset: true });
          apply(data.image);
          setPendingWorkflow(null);
          setMessage('已恢复默认工作流');
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }, [apply]);


      const isComfy = form.provider === 'comfyui';
      const info = workflow || {};
      const providerNote = (providers.find((item) => item.id === form.provider) || {}).note || (image && image.note) || '';

      return h(
        'div',
        { style: { padding: '0 2px' } },
        h(ErrorBanner, { error: error, onClose: () => setError(null) }),
        h(
          'div',
          { className: 'bl-voice-row' },
          h('span', { className: 'bl-hint' }, '策略'),
          h(
            'select',
            {
              className: 'bl-select',
              value: form.provider,
              disabled: busy,
              'aria-label': '配图策略',
              onChange: (event) => save({ provider: event.target.value }),
            },
            (providers.length ? providers : [{ id: 'prompt', label: '提示词占位（默认）', ready: true }]).map((item) =>
              h('option', { key: item.id, value: item.id }, item.label),
            ),
          ),
          h('span', { className: 'bl-hint' }, '默认只出提示词；切到 ComfyUI 才会真的出图'),
        ),
        isComfy
          ? h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'bl-voice-row' },
                h('span', { className: 'bl-hint' }, 'IP'),
                h('input', {
                  className: 'bl-input',
                  style: { width: 130 },
                  value: form.host,
                  disabled: busy,
                  placeholder: '127.0.0.1',
                  'aria-label': 'ComfyUI IP 或主机名',
                  onChange: (event) => setForm((prev) => Object.assign({}, prev, { host: event.target.value })),
                }),
                h('span', { className: 'bl-hint' }, '端口'),
                h('input', {
                  className: 'bl-input',
                  style: { width: 72 },
                  value: form.port,
                  disabled: busy,
                  placeholder: '8188',
                  inputMode: 'numeric',
                  'aria-label': 'ComfyUI 端口',
                  onChange: (event) => setForm((prev) => Object.assign({}, prev, { port: event.target.value })),
                }),
                h('button', { className: 'bl-btn', disabled: busy, onClick: () => save({}) }, busy ? '保存中…' : '保存地址'),
              ),
              h(
                'div',
                { className: 'bl-voice-note' },
                '留空即用默认 ' + ((image && image.defaults && image.defaults.host) || '127.0.0.1') + ':' + ((image && image.defaults && image.defaults.port) || 8188) +
                  '。如果这里填的不是 127.0.0.1，提示词会离开本机发到那台机器上。',
              ),
              h(
                'div',
                { className: 'bl-voice-row' },
                h('span', { className: 'bl-hint' }, '风格后缀'),
                h('input', {
                  className: 'bl-input',
                  style: { flex: '1 1 180px' },
                  value: form.styleSuffix,
                  disabled: busy,
                  placeholder: '可选，例如：书籍插画，暖色调，无文字',
                  'aria-label': '配图风格后缀',
                  onChange: (event) => setForm((prev) => Object.assign({}, prev, { styleSuffix: event.target.value })),
                }),
                h('button', { className: 'bl-btn', disabled: busy, onClick: () => save({}) }, '保存'),
              ),
            )
          : null,
        h(
          'div',
          { className: 'bl-voice-row' },
          h('span', { className: 'bl-hint' }, '工作流'),
          h(
            'span',
            { className: 'bl-key-mask' },
            info.source === 'imported' ? '已导入 · ' + (info.name || '') : '默认 · Z-Image Turbo',
          ),
          h('span', { className: 'bl-hint' }, (info.nodes || 0) + ' 节点'),
          info.promptNode
            ? h('span', { className: 'bl-hint' }, '提示词节点 ' + info.promptNode + (info.promptNodeTitle ? ' · ' + info.promptNodeTitle : ''))
            : h('span', { className: 'bl-hint' }, '未识别提示词节点'),
        ),
        h(
          'div',
          { className: 'bl-voice-row' },
          h('label', { className: 'bl-btn', style: { cursor: busy ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center' } },
            '导入工作流 API',
            h('input', {
              type: 'file',
              accept: '.json,application/json',
              disabled: busy,
              style: { display: 'none' },
              onChange: importFile,
            }),
          ),
          h('button', { className: 'bl-btn', disabled: busy, onClick: resetDefault }, '恢复默认'),
          h('button', { className: 'bl-btn', disabled: busy, onClick: probe }, busy ? '请稍候…' : '测试连接'),
          info.valid === false ? h('span', { className: 'bl-hint bl-source-warn' }, '工作流还没法用，先在下面选提示词节点') : null,
        ),
        candidates.length > 1
          ? h(
              'div',
              { className: 'bl-voice-row' },
              h('span', { className: 'bl-hint' }, '提示词节点'),
              h(
                'select',
                {
                  className: 'bl-select',
                  value: selectedNode || info.promptNode || '',
                  disabled: busy,
                  'aria-label': '提示词节点',
                  onChange: (event) => setSelectedNode(event.target.value),
                },
                candidates.map((item) =>
                  h('option', { key: item.id, value: item.id }, item.id + ' · ' + item.title + ' · ' + String(item.text || '').slice(0, 24)),
                ),
              ),
              pendingWorkflow
                ? h(
                    'button',
                    {
                      className: 'bl-btn bl-btn-primary',
                      disabled: busy || !selectedNode,
                      onClick: () => submitWorkflow(pendingWorkflow.json, pendingWorkflow.name, selectedNode),
                    },
                    '用这个节点',
                  )
                : h('button', { className: 'bl-btn', disabled: busy || !selectedNode, onClick: () => save({ promptNode: selectedNode }) }, '保存节点'),
            )
          : null,
        h(
          'div',
          { className: 'bl-voice-row' },
          h('span', { className: 'bl-hint' }, '测试生图'),
          h('input', {
            className: 'bl-input',
            style: { flex: '1 1 200px' },
            value: testPrompt,
            maxLength: 200,
            disabled: busy || testing,
            placeholder: (image && image.testPrompt) || '一句提示词',
            'aria-label': '测试生图提示词',
            onChange: (event) => setTestPrompt(event.target.value),
          }),
          h(
            'button',
            {
              className: 'bl-btn bl-btn-primary',
              disabled: !isComfy || busy || testing,
              title: isComfy ? '用当前工作流真正生成一张，只预览不落盘' : '先切到「本地 ComfyUI」',
              onClick: testGenerate,
            },
            testing ? '生成中…' : '测试生图',
          ),
        ),
        testImage
          ? h(
              'div',
              { className: 'bl-image-test' },
              h('img', { src: testImage.url, alt: '测试生图结果' }),
              h(
                'div',
                { className: 'bl-voice-note' },
                '耗时 ' + (Number(testImage.ms) / 1000).toFixed(1) + ' 秒 · ' +
                  Math.max(1, Math.round(Number(testImage.bytes) / 1024)) + ' KB' +
                  (testImage.seed ? ' · seed ' + testImage.seed : '') +
                  ' · 测试图不写入模块、不进缓存',
              ),
              h('a', { className: 'bl-btn', href: testImage.url, download: 'comfy-test.png' }, '下载测试图'),
            )
          : null,
        h(
          'div',
          { className: 'bl-voice-note' },
          '「测试连接」只查版本与模型；「测试生图」会真正跑一次当前工作流，成功后在下方预览。首次加载模型可能较慢，等一两分钟属正常。',
        ),
        h(
          'div',
          { className: 'bl-voice-note' },
          '工作流只收 ComfyUI「保存（API 格式）」导出的 JSON；默认工作流 1024×1024、8 步，每页一张 PNG。',
        ),
        message ? h('div', { className: 'bl-voice-note bl-toc-msg' }, message) : null,
        providerNote ? h('div', { className: 'bl-voice-note' }, providerNote) : null,
      );
    }

    function Settings({ onBack, initial }) {
      const seed = initial && typeof initial === 'object' ? initial : {};
      const seedVoice = seed.voice || null;
      const [data, setData] = useState(null);
      const [voice, setVoice] = useState(seedVoice);
      const [providers, setProviders] = useState(seed.providers || []);
      const [models, setModels] = useState(seed.models || []);
      const [qwenVoices, setQwenVoices] = useState(seed.qwenVoices || []);
      const [form, setForm] = useState({
        provider: (seedVoice && seedVoice.provider) || 'browser',
        model: (seedVoice && seedVoice.model) || 'qwen3-tts-flash',
        voice: (seedVoice && seedVoice.voice) || '',
        rate: Number(seedVoice && seedVoice.rate) || 1,
      });
      const [apiKeyInput, setApiKeyInput] = useState('');
      const [editingKey, setEditingKey] = useState(false);
      const [voices, setVoices] = useState([]);
      const [message, setMessage] = useState('');
      const [saving, setSaving] = useState(false);
      const [trashBusy, setTrashBusy] = useState(false);
      const [trashMessage, setTrashMessage] = useState('');
      const [error, setError] = useState(null);

      useEffect(() => {
        let alive = true;
        Promise.all([getJson(STORAGE_API), getJson(VOICE_API)])
          .then(([storage, config]) => {
            if (!alive) return;
            setData(storage);
            setVoice(config.voice || null);
            setProviders(config.providers || []);
            setModels(config.models || []);
            setQwenVoices(config.qwenVoices || []);
            if (config.voice) {
              setForm({
                provider: config.voice.provider || 'browser',
                model: config.voice.model || 'qwen3-tts-flash',
                voice: config.voice.voice || '',
                rate: Number(config.voice.rate) || 1,
              });
            }
          })
          .catch((err) => {
            if (alive) setError(err);
          });
        return () => {
          alive = false;
        };
      }, []);

      // 浏览器音色列表是异步加载的（Chrome 首次是空数组）
      useEffect(() => {
        if (!speechSupported()) return undefined;
        const refresh = () => setVoices(speechVoices());
        refresh();
        const synth = window.speechSynthesis;
        const handler = () => refresh();
        try {
          synth.addEventListener('voiceschanged', handler);
        } catch {
          synth.onvoiceschanged = handler;
        }
        return () => {
          try {
            synth.removeEventListener('voiceschanged', handler);
          } catch {
            if (synth.onvoiceschanged === handler) synth.onvoiceschanged = null;
          }
          stopSpeech();
        };
      }, []);

      const save = useCallback(
        async (patch) => {
          const next = Object.assign({}, form, patch || {});
          setSaving(true);
          setMessage('');
          try {
            const result = await postJson(VOICE_API, next);
            const nextVoice = result.voice || null;
            setVoice(nextVoice);
            if (nextVoice) {
              setForm({
                provider: nextVoice.provider || 'browser',
                model: nextVoice.model || 'qwen3-tts-flash',
                voice: nextVoice.voice || '',
                rate: Number(nextVoice.rate) || 1,
              });
            }
            if (result.providers) setProviders(result.providers);
            if (result.models) setModels(result.models);
            if (result.qwenVoices) setQwenVoices(result.qwenVoices);
            setMessage('已保存');
            setError(null);
            return nextVoice;
          } catch (err) {
            setError(err);
            return null;
          } finally {
            setSaving(false);
          }
        },
        [form],
      );

      const saveApiKey = useCallback(async () => {
        const key = String(apiKeyInput || '').trim();
        if (!key) return;
        const saved = await save({ apiKey: key });
        if (saved) {
          setApiKeyInput('');
          setEditingKey(false);
          setMessage('API Key 已保存（面板只显示尾号）');
        }
      }, [apiKeyInput, save]);

      const clearApiKey = useCallback(async () => {
        const ok = typeof window === 'undefined' || window.confirm('清除已保存的 Qwen API Key？清除后生成会降级为只出文字。');
        if (!ok) return;
        const saved = await save({ clearApiKey: true });
        if (saved) {
          setApiKeyInput('');
          setEditingKey(false);
          setMessage('API Key 已清除');
        }
      }, [save]);

      /** 试听：浏览器返回合成参数；Qwen 返回 WAV 字节，直接播放 Blob。 */
      const probe = useCallback(async () => {
        setMessage('');
        setError(null);
        try {
          const res = await fetch(VOICE_PROBE_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: '你好，这是一段试听，用来确认语音能出声。' }),
          });
          const type = String(res.headers.get('content-type') || '');
          if (type.includes('audio/')) {
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio.onended = () => URL.revokeObjectURL(url);
            audio.onerror = () => URL.revokeObjectURL(url);
            await audio.play();
            setMessage('正在试听 Qwen3-TTS…');
            return;
          }
          const result = await res.json().catch(() => ({}));
          if (!result || result.ok === false) {
            const err = new Error((result && (result.error || result.code)) || '试听失败');
            err.code = result && result.code;
            err.hint = (result && result.hint) || '';
            throw err;
          }
          if (result.mode === 'browser') {
            speakText(result.text, { rate: result.rate, voice: result.voice });
            setMessage('正在用本机声音试听…');
          } else {
            setMessage('试听已提交。');
          }
        } catch (err) {
          if (err && err.code === 'E_TTS_UNCONFIGURED') {
            setMessage('语音没配置好：' + String(err.message || '') + (err.hint ? ' ' + err.hint : ''));
          } else {
            setMessage(String((err && err.message) || err));
          }
        }
      }, []);

      const speechOk = speechSupported();
      const providerNote = (providers.find((item) => item.id === form.provider) || {}).note || (voice && voice.note) || '';

      /** 清空回收站（AC-24）：清完重新读存储概况，占用空间要立刻下降。 */
      const clearTrashNow = useCallback(async () => {
        const ok = typeof window === 'undefined' || window.confirm('清空回收站？删除的书会真正被删掉，不能再恢复。');
        if (!ok) return;
        setTrashBusy(true);
        setTrashMessage('');
        setError(null);
        try {
          const result = await postJson(TRASH_CLEAR_API, {});
          const storage = await getJson(STORAGE_API);
          setData(storage);
          setTrashMessage('已清空 ' + (result.cleared || 0) + ' 本，释放 ' + formatSize(result.bytesFreed || 0));
        } catch (err) {
          setError(err);
        } finally {
          setTrashBusy(false);
        }
      }, [setError]);

      return h(
        'div',
        { className: 'bl-root bl-line' },
        h(
          'div',
          { className: 'bl-bar' },
          h('button', { className: 'bl-back', onClick: onBack }, '\u2039 返回'),
          h('div', { className: 'bl-grow' }),
          h(
            'button',
            { className: 'bl-btn', onClick: () => window.location.reload() },
            '刷新页面',
          ),
        ),
        h(
          'div',
          { className: 'bl-body' },
          h(ErrorBanner, { error: error, onClose: () => setError(null) }),
          data
            ? h(
                'dl',
                { className: 'bl-kv' },
                h('dt', null, '数据目录'),
                h('dd', null, data.dataRoot),
                h('dt', null, '占用空间'),
                h('dd', null, formatSize(data.bytes)),
                h('dt', null, '回收站'),
                h('dd', null, (data.trashCount || 0) + ' 本 · ' + formatSize(data.trashBytes || 0)),
                h('dt', null, '插件版本'),
                h('dd', null, data.pluginVersion || '—'),
              )
            : h('div', { style: { opacity: 0.7 } }, h('span', { className: 'bl-spin' }), ' 正在读…'),
          data
            ? h(
                'div',
                { className: 'bl-voice-row', style: { marginTop: 0 } },
                h(
                  'button',
                  { className: 'bl-btn', disabled: trashBusy || !data.trashCount, onClick: clearTrashNow },
                  trashBusy ? '清理中…' : '清空回收站',
                ),
                trashMessage ? h('span', { className: 'bl-voice-note bl-toc-msg' }, trashMessage) : null,
              )
            : null,
          h('div', { className: 'bl-mods', style: { marginTop: 4 } }, h('div', { className: 'bl-mods-head' }, '语音')),
          h(
            'div',
            { style: { padding: '0 2px' } },
            h(
              'div',
              { className: 'bl-voice-row' },
              h('span', { className: 'bl-hint' }, '供应商'),
              h(
                'select',
                {
                  className: 'bl-select',
                  value: form.provider,
                  disabled: saving,
                  'aria-label': '语音供应商',
                  onChange: (event) => {
                    const provider = event.target.value;
                    const patch = { provider: provider };
                    if (provider === 'qwen3-tts' && !form.voice && qwenVoices.length) patch.voice = qwenVoices[0].id;
                    if (provider === 'browser' && form.provider === 'qwen3-tts') patch.voice = '';
                    save(patch);
                  },
                },
                (providers.length ? providers : [{ id: 'browser', label: '浏览器朗读（本机合成）', ready: true }]).map((item) =>
                  h(
                    'option',
                    { key: item.id, value: item.id, disabled: !item.ready },
                    item.label + (item.ready ? '' : '（未接入）'),
                  ),
                ),
              ),
            ),
            h(
              'div',
              { className: 'bl-voice-row' },
              h('span', { className: 'bl-hint' }, 'AI 模型'),
              h(
                'select',
                {
                  className: 'bl-select',
                  value: form.model,
                  disabled: saving || form.provider !== 'qwen3-tts',
                  'aria-label': '语音合成模型',
                  onChange: (event) => save({ model: event.target.value }),
                },
                (models.length ? models : [{ id: 'qwen3-tts-flash', label: 'Qwen3-TTS Flash（非实时）', ready: true }]).map((item) =>
                  h('option', { key: item.id, value: item.id, disabled: !item.ready }, item.label + (item.ready ? '' : '（未接入）')),
                ),
              ),
              h('span', { className: 'bl-hint' }, '只切语音模型；生成文案仍走 DSH 默认模型'),
            ),
            form.provider === 'qwen3-tts'
              ? h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'bl-voice-row' },
                    h('span', { className: 'bl-hint' }, 'API Key'),
                    voice && voice.hasKey && !editingKey
                      ? h(
                          React.Fragment,
                          null,
                          h('span', { className: 'bl-key-mask' }, '已保存 · 尾号 ' + String(voice.apiKeyMask || '').slice(-4)),
                          h('button', { className: 'bl-btn', disabled: saving, onClick: () => setEditingKey(true) }, '更换'),
                          h('button', { className: 'bl-btn', disabled: saving, onClick: clearApiKey }, '清除'),
                        )
                      : h(
                          React.Fragment,
                          null,
                          h('input', {
                            className: 'bl-input',
                            type: 'password',
                            value: apiKeyInput,
                            placeholder: '粘贴 Qwen API Key（只存本机）',
                            autoComplete: 'new-password',
                            'aria-label': 'Qwen API Key',
                            onChange: (event) => setApiKeyInput(event.target.value),
                            onKeyDown: (event) => {
                              if (event.key === 'Enter') saveApiKey();
                            },
                          }),
                          h('button', { className: 'bl-btn bl-btn-primary', disabled: saving || !apiKeyInput.trim(), onClick: saveApiKey }, '保存 Key'),
                          voice && voice.hasKey
                            ? h(
                                'button',
                                {
                                  className: 'bl-btn',
                                  onClick: () => {
                                    setEditingKey(false);
                                    setApiKeyInput('');
                                  },
                                },
                                '取消',
                              )
                            : null,
                        ),
                  ),
                  h('div', { className: 'bl-voice-note' }, 'Key 存 voice.json（0600），面板只显示末 4 位；不写入模块、URL 或日志。'),
                )
              : null,
            h(
              'div',
              { className: 'bl-voice-row' },
              h('span', { className: 'bl-hint' }, '音色'),
              form.provider === 'qwen3-tts'
                ? h(
                    'select',
                    {
                      className: 'bl-select',
                      value: form.voice,
                      disabled: saving,
                      'aria-label': 'Qwen 音色',
                      onChange: (event) => save({ voice: event.target.value }),
                    },
                    qwenVoices.map((item) =>
                      h(
                        'option',
                        { key: item.id, value: item.id },
                        item.id + ' · ' + item.desc + '（' + item.gender + (item.dialect ? '，' + item.dialect : '') + '）',
                      ),
                    ),
                  )
                : h(
                    'select',
                    {
                      className: 'bl-select',
                      value: form.voice,
                      disabled: saving || form.provider !== 'browser',
                      'aria-label': '朗读音色',
                      onChange: (event) => save({ voice: event.target.value }),
                    },
                    h('option', { value: '' }, '系统默认'),
                    voices.map((item) => h('option', { key: item.voiceURI || item.name, value: item.name }, item.name + ' · ' + item.lang)),
                  ),
            ),
            form.provider === 'browser'
              ? h(
                  'div',
                  { className: 'bl-voice-row' },
                  h('span', { className: 'bl-hint' }, '语速'),
                  h(
                    'select',
                    {
                      className: 'bl-select',
                      value: String(form.rate),
                      disabled: saving,
                      'aria-label': '朗读语速',
                      onChange: (event) => save({ rate: Number(event.target.value) }),
                    },
                    rateOptions(form.rate).map((rate) => h('option', { key: rate, value: String(rate) }, rate.toFixed(1) + '×')),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'bl-voice-row' },
              h('button', { className: 'bl-btn', disabled: saving, onClick: probe }, '试听'),
              h('button', { className: 'bl-btn', disabled: saving, onClick: () => save({}) }, saving ? '保存中…' : '保存'),
            ),
            message ? h('div', { className: 'bl-voice-note bl-toc-msg' }, message) : null,
            providerNote ? h('div', { className: 'bl-voice-note' }, providerNote) : null,
            form.provider === 'browser' && !speechOk
              ? h('div', { className: 'bl-voice-note bl-source-warn' }, '当前浏览器不支持本机朗读；换 Chrome / Edge 最新版。')
              : null,
            h(
              'div',
              { className: 'bl-voice-note' },
              'Qwen3-TTS 会把每页朗读稿发给千问并下载 WAV；浏览器朗读完全在本机。Qwen Key 只保存在本机。',
            ),
          ),
          h('div', { className: 'bl-mods', style: { marginTop: 4 } }, h('div', { className: 'bl-mods-head' }, '配图')),
          h(ImageSettings, null),
        ),
      );
    }

    /* ------------------------------ 面板根 ------------------------------ */

    /** 导出确认层：先估体积，再决定含不含音频。 */
    function ExportDialog({ ids, onClose }) {
      const [audio, setAudio] = useState(true);
      const [info, setInfo] = useState(null);
      const [error, setError] = useState(null);

      useEffect(() => {
        let alive = true;
        setInfo(null);
        setError(null);
        const params = '?books=' + encodeURIComponent(ids.join(',')) + '&audio=' + (audio ? 1 : 0);
        getJson(EXPORT_SIZE_API + params)
          .then((data) => {
            if (alive) setInfo(data);
          })
          .catch((err) => {
            if (alive) setError(err);
          });
        return () => {
          alive = false;
        };
      }, [ids, audio]);

      const download = useCallback(() => {
        const params = '?books=' + encodeURIComponent(ids.join(',')) + '&audio=' + (audio ? 1 : 0);
        const anchor = document.createElement('a');
        anchor.href = EXPORT_API + params;
        anchor.download = '';
        anchor.rel = 'noopener';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        onClose();
      }, [ids, audio, onClose]);

      const tooLarge = info && info.bytes > 4 * 1024 ** 3;
      return h(
        'div',
        {
          className: 'bl-overlay',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          'div',
          { className: 'bl-dialog', role: 'dialog', 'aria-label': '导出书档' },
          h('h2', null, ids.length > 1 ? '导出 ' + ids.length + ' 本书档' : '导出书档'),
          error ? h('div', { className: 'bl-err' }, String(error.message || error)) : null,
          !info && !error ? h('div', { className: 'bl-hint' }, h('span', { className: 'bl-spin' }), ' 正在估算体积…') : null,
          info
            ? h(
                'div',
                null,
                h('div', { className: 'bl-pkg-sum' }, '共 ' + info.books + ' 本 · ' + info.modules + ' 个模块 · 约 ' + formatSize(info.bytes)),
                h(
                  'label',
                  { className: 'bl-check' },
                  h('input', { type: 'checkbox', checked: audio, onChange: (event) => setAudio(event.target.checked) }),
                  '含音频',
                ),
                h('p', null, audio ? '音频一起带走，换台机器点开就能听（包会大一些）。' : '不含音频：导入后每页显示「本页无配音」，可在书里点「仅补配音」补回来。'),
                info.warnings && info.warnings.length ? h('div', { className: 'bl-note' }, info.warnings.join('；')) : null,
                tooLarge ? h('div', { className: 'bl-err' }, '超过 4 GB，请去掉「含音频」或分批导出。') : null,
              )
            : null,
          h(
            'div',
            { className: 'bl-dialog-foot' },
            h('button', { className: 'bl-btn', onClick: onClose }, '取消'),
            h('button', { className: 'bl-btn bl-btn-primary', disabled: !info || tooLarge, onClick: download }, '开始导出'),
          ),
        ),
      );
    }

    /** 导出 PPT 确认层：先取计划（页数 / 音频页 / 配图页 / 体积），再下载。 */
    function PptxDialog({ moduleId, title, onClose }) {
      const [audio, setAudio] = useState(true);
      const [info, setInfo] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);

      useEffect(() => {
        let alive = true;
        setInfo(null);
        setError(null);
        const params = '?moduleId=' + encodeURIComponent(moduleId) + '&audio=' + (audio ? 1 : 0);
        getJson(PPTX_PLAN_API + params)
          .then((data) => {
            if (alive) setInfo(data);
          })
          .catch((err) => {
            if (alive) setError(err);
          });
        return () => {
          alive = false;
        };
      }, [moduleId, audio]);

      const download = useCallback(async () => {
        setBusy(true);
        setError(null);
        try {
          const params = '?moduleId=' + encodeURIComponent(moduleId) + '&audio=' + (audio ? 1 : 0);
          const response = await fetch(PPTX_API + params, {
            headers: { accept: 'application/vnd.openxmlformats-officedocument.presentationml.presentation, application/json' },
          });
          const type = String(response.headers.get('content-type') || '');
          if (!response.ok || type.includes('application/json')) {
            let data = null;
            try {
              data = await response.json();
            } catch {
              /* 不是 JSON 就按通用错误处理 */
            }
            const err = new Error((data && (data.error || data.message)) || '导出失败');
            err.code = data && data.code;
            throw err;
          }
          const blob = await response.blob();
          const objectUrl = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = objectUrl;
          anchor.download = (info && info.fileName) || '精讲.pptx';
          anchor.rel = 'noopener';
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          setTimeout(() => {
            try {
              URL.revokeObjectURL(objectUrl);
            } catch {
              /* 忽略 */
            }
          }, 30000);
          onClose();
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }, [moduleId, audio, info, onClose]);

      const tooLarge = info && info.bytes > 150 * 1024 ** 2;
      return h(
        'div',
        {
          className: 'bl-overlay',
          onClick: (event) => {
            if (event.target === event.currentTarget && !busy) onClose();
          },
        },
        h(
          'div',
          { className: 'bl-dialog', role: 'dialog', 'aria-label': '导出 PPT' },
          h('h2', null, '导出 PPT'),
          title ? h('p', { className: 'bl-hint' }, title) : null,
          error ? h('div', { className: 'bl-err' }, String(error.message || error)) : null,
          !info && !error ? h('div', { className: 'bl-hint' }, h('span', { className: 'bl-spin' }), ' 正在检查音频与配图…') : null,
          info
            ? h(
                'div',
                null,
                h(
                  'div',
                  { className: 'bl-pkg-sum' },
                  '共 ' + info.slides + ' 页 · 含音频 ' + info.audioPages + ' 页 · 含配图 ' + info.imagePages + ' 页 · 约 ' + formatSize(info.bytes),
                ),
                h(
                  'label',
                  { className: 'bl-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: audio && info.audioPages > 0,
                    disabled: !info.audioPages,
                    onChange: (event) => setAudio(event.target.checked),
                  }),
                  '含音频',
                ),
                h(
                  'p',
                  null,
                  audio && info.audioPages > 0
                    ? '每页一个音频对象，进入自动播放，点喇叭可重播。'
                    : '不含音频：文件更小，幻灯片没有声音。',
                ),
                info.warnings && info.warnings.length ? h('div', { className: 'bl-note' }, info.warnings.join('；')) : null,
                h('p', { className: 'bl-hint' }, '导出文件包含书籍文字、配图与配音，转发前请自行确认范围。'),
                tooLarge ? h('div', { className: 'bl-err' }, '超过 150 MB，请去掉「含音频」或减少页数。') : null,
              )
            : null,
          h(
            'div',
            { className: 'bl-dialog-foot' },
            h('button', { className: 'bl-btn', onClick: onClose, disabled: busy }, '取消'),
            h('button', { className: 'bl-btn bl-btn-primary', disabled: !info || busy || tooLarge, onClick: download }, busy ? '正在导出…' : '开始导出'),
          ),
        ),
      );
    }

    /** 导入结果层：四类计数 + 逐项明细，失败项直接给错误码。 */
    function ImportResult({ result, onClose, onOpenBook }) {
      const items = (result && result.items) || [];
      const summary = (result && result.summary) || { imported: 0, merged: 0, skipped: 0, failed: 0 };
      const labels = { imported: '已导入', merged: '已合并', skipped: '已存在', failed: '失败' };
      const first = items.find((item) => item.status === 'imported' || item.status === 'merged');
      return h(
        'div',
        {
          className: 'bl-overlay',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          'div',
          { className: 'bl-dialog', role: 'dialog', 'aria-label': '导入结果' },
          h('h2', null, '导入结果'),
          h(
            'div',
            { className: 'bl-pkg-sum' },
            '导入 ' + summary.imported + ' · 合并 ' + summary.merged + ' · 已存在 ' + summary.skipped + ' · 失败 ' + summary.failed,
          ),
          items.map((item, index) =>
            h(
              'div',
              { className: 'bl-pkg-item bl-line' + (item.status === 'failed' ? ' bad' : ''), key: index },
              h('span', { className: 'bl-pkg-name' }, item.title || item.file || '(未知书档)'),
              h('span', { className: 'bl-pkg-status' }, labels[item.status] || item.status),
              item.code ? h('span', { className: 'bl-hint' }, item.code) : null,
            ),
          ),
          summary.failed > 0 ? h('div', { className: 'bl-tip' }, '失败项不影响已成功的书；错误码见附录 B。') : null,
          h(
            'div',
            { className: 'bl-dialog-foot' },
            first && first.bookId
              ? h('button', { className: 'bl-btn', onClick: () => onOpenBook(first.bookId) }, '打开《' + (first.title || '这本书') + '》')
              : null,
            h('button', { className: 'bl-btn bl-btn-primary', onClick: onClose }, '知道了'),
          ),
        ),
      );
    }

    function BookSlidesPanel() {
      const [nav, setNav] = useState('shelf');
      const [books, setBooks] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [bookId, setBookId] = useState('');
      const [moduleId, setModuleId] = useState('');
      const [initialSlide, setInitialSlide] = useState(1);
      const [progress, setProgress] = useState(null);
      const [upload, setUpload] = useState(null);
      const [selecting, setSelecting] = useState(false);
      const [selected, setSelected] = useState([]);
      const [exportIds, setExportIds] = useState(null);
      const [importResult, setImportResult] = useState(null);
      const [pkgBusy, setPkgBusy] = useState(null);
      const [pkgPolicy, setPkgPolicy] = useState(() => {
        try {
          return (typeof localStorage !== 'undefined' && localStorage.getItem('book-slides.pkg-policy')) || 'merge';
        } catch {
          return 'merge';
        }
      });
      const changePkgPolicy = useCallback((value) => {
        setPkgPolicy(value);
        try {
          if (typeof localStorage !== 'undefined') localStorage.setItem('book-slides.pkg-policy', value);
        } catch {
          /* 隐私模式下 localStorage 会抛，忽略 */
        }
      }, []);
      const fileInputRef = useRef(null);
      const pkgInputRef = useRef(null);

      const load = useCallback(() => {
        setLoading(true);
        Promise.all([getJson(BOOKS_API), getJson(PROGRESS_API).catch(() => ({ progress: null }))])
          .then(([data, saved]) => {
            setBooks(data.books || []);
            setProgress((saved && saved.progress) || null);
            setError(null);
          })
          .catch((err) => setError(err))
          .finally(() => setLoading(false));
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      const refreshProgress = useCallback(() => {
        getJson(PROGRESS_API)
          .then((saved) => setProgress((saved && saved.progress) || null))
          .catch(() => {});
      }, []);

      const doImport = useCallback(
        async (fileOrPick, immediateError) => {
          if (immediateError) {
            setError(new Error(immediateError));
            return;
          }
          if (fileOrPick === 'pick') {
            if (fileInputRef.current) fileInputRef.current.click();
            return;
          }
          const file = fileOrPick;
          if (!file) return;
          if (!/\.pdf$/i.test(file.name || '')) {
            setError(new Error('只支持 .pdf 文件'));
            return;
          }
          if (file.size > 200 * 1024 * 1024) {
            setError(new Error('文件超过 200 MB，请先压缩或拆分'));
            return;
          }
          setError(null);
          setUpload({ name: file.name, phase: 'upload', ratio: 0 });
          try {
            const data = await uploadPdf(file, (ratio) => setUpload({ name: file.name, phase: 'upload', ratio: ratio }));
            if (!data || data.ok === false) {
              const err = new Error((data && (data.error || data.code)) || '导入失败');
              err.code = data && data.code;
              err.hint = (data && data.hint) || '';
              if (data && data.code === 'E_DUP_BOOK' && data.bookId) {
                setUpload(null);
                setBookId(data.bookId);
                setNav('detail');
                setError(err);
                return;
              }
              throw err;
            }
            setUpload({ name: file.name, phase: 'done', ratio: 1 });
            load();
            setUpload(null);
            setBookId(data.bookId);
            setNav('detail');
          } catch (err) {
            setUpload(null);
            setError(err);
          }
        },
        [load],
      );

      const handleRename = useCallback(
        async (id, title) => {
          try {
            await postJson(RENAME_API, { bookId: id, title: title });
            setBooks((prev) => prev.map((b) => (b.id === id ? { ...b, title: title } : b)));
            if (bookId === id) setBookId(id);
          } catch (err) {
            setError(err);
          }
        },
        [bookId],
      );

      const handleDelete = useCallback(
        async (id) => {
          try {
            await postJson(DELETE_API, { bookId: id });
            setBooks((prev) => prev.filter((b) => b.id !== id));
            if (bookId === id) {
              setBookId('');
              setNav('shelf');
            }
          } catch (err) {
            setError(err);
          }
        },
        [bookId],
      );

      const openBook = useCallback((id) => {
        setBookId(id);
        setError(null);
        setNav('detail');
      }, []);

      const openModule = useCallback(
        (id, slide) => {
          const remembered = progress && progress.lastModuleId === id ? Number(progress.lastSlide) || 1 : 1;
          setModuleId(id);
          setInitialSlide(Math.max(1, Math.round(Number(slide) || remembered)));
          setError(null);
          setNav('module');
        },
        [progress],
      );

      const continueListening = useCallback(
        (id, savedModuleId, slide) => {
          setBookId(id);
          openModule(savedModuleId, slide);
        },
        [openModule],
      );

      const toggleSelect = useCallback((id) => {
        setSelected((prev) => (prev.indexOf(id) >= 0 ? prev.filter((value) => value !== id) : prev.concat(id)));
      }, []);

      const startExport = useCallback((ids) => {
        const list = Array.from(ids || []);
        if (!list.length) {
          setError(new Error('先选至少一本书'));
          return;
        }
        setExportIds(list);
      }, []);

      const closeExport = useCallback(() => {
        setExportIds(null);
        setSelecting(false);
        setSelected([]);
      }, []);

      const doImportPackages = useCallback(
        async (fileList) => {
          const files = Array.from(fileList || []).filter((file) => /\.zip$/i.test(file.name || ''));
          if (!files.length) {
            setError(new Error('只支持 .zip 书档'));
            return;
          }
          setError(null);
          const results = [];
          for (let index = 0; index < files.length; index += 1) {
            const file = files[index];
            const progress = (ratio) => setPkgBusy({ name: file.name, ratio: ratio, index: index + 1, total: files.length });
            progress(0);
            try {
              results.push(await uploadPackage(file, pkgPolicy, progress));
            } catch (err) {
              results.push({ ok: false, code: 'E_PKG_CORRUPT', error: String((err && err.message) || err) });
            }
          }
          setPkgBusy(null);
          setImportResult(mergeImportResults(results));
          setSelecting(false);
          setSelected([]);
          load();
        },
        [pkgPolicy, load],
      );

      const body =
        nav === 'module' && moduleId
          ? h(ModuleView, {
              moduleId: moduleId,
              initialSlide: initialSlide,
              onBack: () => {
                setNav(bookId ? 'detail' : 'shelf');
                refreshProgress();
              },
              error: error,
              setError: setError,
            })
          : nav === 'detail' && bookId
            ? h(Detail, {
                bookId: bookId,
                onBack: () => {
                  setNav('shelf');
                  load();
                },
                onDeleted: () => {
                  setNav('shelf');
                  load();
                },
                onOpenModule: openModule,
                onSettings: () => setNav('settings'),
                error: error,
                setError: setError,
              })
            : nav === 'settings'
              ? h(Settings, { onBack: () => setNav(bookId ? 'detail' : 'shelf') })
              : h(Shelf, {
                  books: books,
                  loading: loading,
                  onOpen: openBook,
                  onRename: handleRename,
                  onDelete: handleDelete,
                  onImport: doImport,
                  onImportPackage: (action) => {
                    if (action === 'pick' && pkgInputRef.current) pkgInputRef.current.click();
                  },
                  onSelecting: setSelecting,
                  selecting: selecting,
                  selected: selected,
                  onToggleSelect: toggleSelect,
                  onExport: startExport,
                  onPolicyChange: changePkgPolicy,
                  policy: pkgPolicy,
                  pkgBusy: pkgBusy,
                  error: error,
                  onDismissError: () => setError(null),
                  progress: progress,
                  onContinue: continueListening,
                });

      return h(
        'div',
        { className: 'bl-root bl-line', style: { height: '100%' } },
        body,
        h('input', {
          ref: fileInputRef,
          type: 'file',
          accept: 'application/pdf,.pdf',
          style: { display: 'none' },
          onChange: (event) => {
            const file = event.target.files && event.target.files[0];
            event.target.value = '';
            if (file) doImport(file, null);
          },
        }),
        h('input', {
          ref: pkgInputRef,
          type: 'file',
          accept: '.zip,application/zip',
          multiple: true,
          style: { display: 'none' },
          onChange: (event) => {
            const picked = takeFilesFromInput(event);
            if (!picked.length) {
              setError(new Error('没有读到文件，请重新选择 .zip 书档'));
              return;
            }
            doImportPackages(picked);
          },
        }),
        exportIds ? h(ExportDialog, { ids: exportIds, onClose: closeExport }) : null,
        importResult
          ? h(ImportResult, {
              result: importResult,
              onClose: () => setImportResult(null),
              onOpenBook: (id) => {
                setImportResult(null);
                openBook(id);
                load();
              },
            })
          : null,
        nav === 'shelf'
          ? h(
              'button',
              {
                className: 'bl-btn',
                title: '设置',
                style: { position: 'absolute', right: 12, bottom: 12, padding: '3px 8px', opacity: 0.7 },
                onClick: () => setNav('settings'),
              },
              '\u2699',
            )
          : null,
        upload
          ? h(
              'div',
              {
                className: 'bl-bar bl-line',
                style: {
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background: 'Canvas',
                  borderTop: '1px solid var(--bl-line)',
                  flexDirection: 'column',
                  alignItems: 'stretch',
                  gap: 2,
                },
              },
              h(
                'div',
                { style: { fontSize: 11.5, display: 'flex', gap: 6, minWidth: 0 } },
                upload.phase === 'upload' && upload.ratio < 1
                  ? h('span', null, '正在上传 ' + Math.round(upload.ratio * 100) + '%')
                  : h('span', null, '正在解析 PDF，读文字层、切章…'),
                h('span', { className: 'bl-grow' }),
                h('span', { style: { opacity: 0.55, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' } }, upload.name),
              ),
              h(
                'div',
                { className: 'bl-progress' },
                h('i', {
                  style: {
                    width: (upload.phase === 'upload' ? Math.max(6, Math.round(upload.ratio * 100)) : 100) + '%',
                    opacity: upload.phase === 'upload' ? 1 : 0.45,
                  },
                }),
              ),
            )
          : null,
      );
    }

    /* ------------------------------ 注册 ------------------------------ */

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots;
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined;
          const tag = document.createElement('style');
          tag.setAttribute('data-book-slides-style', '1');
          tag.textContent = FONT_CSS;
          document.head.appendChild(tag);
          return () => {
            try {
              tag.remove();
            } catch {
              /* 忽略 */
            }
          };
        });

        ctx.effect(() =>
          slots.inject('sidebar.panellist', () =>
            slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: '精讲' }, SlideIcon),
          ),
        );

        ctx.effect(() =>
          slots.inject('main', () =>
            slots.register({ name: 'main', key: PANEL_ID }, function BookSlidesRoot() {
              return h(PanelBoundary, null, h(BookSlidesPanel));
            }),
          ),
        );
      },

      /** 测试用：SSR 里直接渲染内部组件，生产代码不会碰它。 */
      __components: {
        BookSlidesPanel: BookSlidesPanel,
        Shelf: Shelf,
        Detail: Detail,
        Settings: Settings,
        ImageSettings: ImageSettings,
        BookCard: BookCard,
        TocBox: TocBox,
        SourceNote: SourceNote,
        JobBox: JobBox,
        ModuleList: ModuleList,
        SlideStage: SlideStage,
        SourcePane: SourcePane,
        Player: Player,
        ModuleView: ModuleView,
        ExportDialog: ExportDialog,
        PptxDialog: PptxDialog,
        ImportResult: ImportResult,
      },

      /** 测试用：PDF 高亮几何是纯函数，单独验证，不用起浏览器。 */
      __utils: {
        normalizePdfText: normalizePdfText,
        pdfHighlightRects: pdfHighlightRects,
        isRenderCancelled: isRenderCancelled,
        bindPopupDismiss: bindPopupDismiss,
        focusJobEntry: focusJobEntry,
        takeFilesFromInput: takeFilesFromInput,
      },
    };
  },
});
