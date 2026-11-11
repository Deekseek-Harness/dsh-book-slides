/**
 * 2.0 客户端：书架、导入、分章构建、章校准、封面、回收站、Part/讲纲、
 * 系列生成进度/取消/续跑/重试与后验缝报告。播放器在 M4 接入。
 */
window.__ModuleLoader__.load({
  id: 'dsh-book-slides',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useRef, useState } = React;
    const h = React.createElement;
    const PANEL_ID = 'book-slides';
    const API = '/dsh-book-slides';
    const FILE_API = API + '/file';
    const AUDIO_API = API + '/audio';
    const PDFJS_BASE = API + '/vendor/pdfjs/';
    const PDFJS_MODULE = PDFJS_BASE + 'build/pdf.min.mjs';
    const PDFJS_WORKER = PDFJS_BASE + 'build/pdf.worker.min.mjs';
    const RATE_STEPS = [0.8, 1, 1.2];
    const ACTIVE_LECTURE = ['queued', 'structuring', 'validate', 'anchor'];
    const READY_LECTURE = ['ready', 'ready_degraded'];
    // 切回窗口时 focus 与 visibilitychange 常结伴触发：去抖窗口内只刷新一次
    const REFRESH_DEBOUNCE_MS = 300;

    const CSS = `
.blm-root{
  height:100%;display:flex;flex-direction:column;overflow:hidden;position:relative;
  font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  font-size:13px;line-height:1.55;
  color:var(--dsw-alias-label-primary,CanvasText);
  background:var(--dsw-alias-bg-base,Canvas);
  --blm-line:color-mix(in oklab,currentColor 16%,transparent);
  --blm-card:var(--dsw-alias-bg-layer-2,Canvas);
  --blm-bg:var(--dsw-alias-bg-base,Canvas);
  --blm-text:var(--dsw-alias-label-primary,CanvasText);
  --blm-dim:color-mix(in oklab,currentColor 58%,transparent);
  --blm-btn-hover:color-mix(in oklab,currentColor 8%,transparent);
  --blm-accent:#2f6fed;
  color-scheme:light;
}
body[data-ds-dark-theme] .blm-root{color-scheme:dark}
.blm-bar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--blm-line);flex:0 0 auto}
.blm-bar h1{margin:0;font-size:14px;font-weight:600;flex:1;letter-spacing:.02em}
.blm-btn{appearance:none;border:1px solid var(--blm-line);background:transparent;color:inherit;border-radius:6px;padding:5px 10px;font:inherit;cursor:pointer;white-space:nowrap}
.blm-btn:hover{background:var(--blm-btn-hover)}
.blm-btn.primary{background:var(--blm-accent);border-color:var(--blm-accent);color:#fff}
.blm-btn:disabled{opacity:.55;cursor:default}
.blm-body{flex:1;min-height:0;overflow:auto;padding:14px}
.blm-empty{height:100%;min-height:260px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;border:1px dashed var(--blm-line);border-radius:12px;color:var(--blm-dim);text-align:center;padding:24px}
.blm-empty strong{font-size:15px;color:var(--blm-text);font-weight:600}
.blm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:14px}
.blm-card{border:1px solid var(--blm-line);border-radius:10px;overflow:hidden;background:var(--blm-card);color:var(--blm-text);cursor:pointer;position:relative}
.blm-card:hover{border-color:var(--blm-accent)}
.blm-card:focus-visible{outline:2px solid var(--blm-accent);outline-offset:2px}
.blm-card-hit{border-color:var(--blm-accent);box-shadow:0 0 0 3px color-mix(in oklab,var(--blm-accent) 30%,transparent),0 10px 26px rgba(0,0,0,.18);animation:blm-card-hit 1.1s ease-in-out 2}
@keyframes blm-card-hit{0%,100%{transform:translateY(0)}35%{transform:translateY(-3px)}}
@media (prefers-reduced-motion:reduce){.blm-card-hit{animation:none}}
.blm-cover{aspect-ratio:5/7;background:linear-gradient(135deg,#536,#213);display:flex;align-items:center;justify-content:center;overflow:hidden}
.blm-cover img{width:100%;height:100%;object-fit:cover;display:block}
.blm-cover span{font-size:28px;color:rgba(255,255,255,.8);font-family:serif}
.blm-card-main{padding:8px 10px 10px;background:var(--blm-card);color:var(--blm-text)}
.blm-title{font-weight:600;font-size:13px;color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.blm-meta{color:var(--blm-dim);font-size:11px;margin-top:2px;display:flex;gap:6px;flex-wrap:wrap}
.blm-badge{font-size:10px;border:1px solid var(--blm-line);border-radius:99px;padding:0 6px;color:var(--blm-dim)}
.blm-badge.ok{color:#2ea043;border-color:color-mix(in oklab,#2ea043 35%,transparent);background:color-mix(in oklab,#2ea043 12%,transparent)}
.blm-badge.warn{color:#8a5a00;border-color:color-mix(in oklab,#f0b400 45%,transparent);background:color-mix(in oklab,#f0b400 14%,transparent)}
body[data-ds-dark-theme] .blm-badge.warn{color:#ffd27a}
.blm-menu{position:absolute;right:6px;top:6px;background:rgba(0,0,0,.55);color:#fff;border:0;border-radius:6px;width:24px;height:24px;cursor:pointer;line-height:1}
.blm-menu-box{position:absolute;right:6px;top:34px;z-index:5;background:var(--blm-card);color:var(--blm-text);border:1px solid var(--blm-line);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.18);padding:4px;min-width:92px}
.blm-menu-box button{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;padding:6px 9px;border-radius:5px;font:inherit;cursor:pointer}
.blm-menu-box button:hover{background:var(--blm-btn-hover)}
.blm-menu-box button.danger{color:#e55353}
.blm-detail-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px}
.blm-detail-cover{width:96px;aspect-ratio:5/7;border-radius:8px;overflow:hidden;border:1px solid var(--blm-line);flex:0 0 auto;background:linear-gradient(135deg,#536,#213);display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.8);font-size:24px}
.blm-detail-cover img{width:100%;height:100%;object-fit:cover}
.blm-detail-title{font-size:17px;font-weight:650;margin:0 0 4px;color:var(--blm-text)}
.blm-dim{color:var(--blm-dim)}
.blm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.blm-chapters{border:1px solid var(--blm-line);border-radius:10px;overflow:hidden;margin-top:12px;background:var(--blm-card)}
.blm-parts{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.blm-part{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 10px;border:1px solid var(--blm-line);border-radius:8px;background:color-mix(in oklab,currentColor 3%,transparent)}
.blm-part-main{flex:1;min-width:0}
.blm-chapter{display:grid;grid-template-columns:22px 22px 34px minmax(0,1fr) 52px 52px 56px 88px;gap:8px;align-items:center;padding:7px 10px;border-bottom:1px solid var(--blm-line);font-size:12px;color:var(--blm-text)}
.blm-tree-head{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:6px 10px 8px;font-size:12px;color:var(--blm-dim)}
.blm-single-root{border:1px solid color-mix(in oklab,#f0b400 45%,transparent);background:color-mix(in oklab,#f0b400 10%,transparent);color:#8a5a00;border-radius:8px;padding:8px 10px;margin:8px 10px;font-size:12px;display:flex;flex-direction:column;gap:6px}
body[data-ds-dark-theme] .blm-single-root{color:#ffd27a}
.blm-tree-toggle{appearance:none;border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;line-height:1;padding:0;width:20px;height:20px;border-radius:4px;opacity:.65}
.blm-tree-toggle:hover{background:var(--blm-btn-hover);opacity:1}
.blm-chapter-child{font-size:11.5px;background:color-mix(in oklab,currentColor 2%,transparent)}
.blm-chapter-child .t{color:var(--blm-dim);cursor:default}
.blm-chapters-tree .blm-chapter:last-child{border-bottom:0}
.blm-build{border:1px solid var(--blm-line);border-radius:10px;padding:10px 12px;margin-top:10px;background:color-mix(in oklab,currentColor 3%,transparent)}
.blm-build-advanced{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px}
.blm-build-hint{font-size:11px;margin-top:6px}
.blm-build-preview{max-height:180px;overflow:auto;margin:8px 0 0;padding:8px;border-radius:7px;background:color-mix(in oklab,currentColor 5%,transparent);font:11px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
.blm-build-summary{margin-top:10px;border-top:1px dashed var(--blm-line);padding-top:8px;font-size:12px}
.blm-build-summary-compact{margin-top:10px;border:1px solid var(--blm-line);border-radius:8px;padding:8px 10px;background:var(--blm-card)}
.blm-build-attempts{margin-top:8px;font-size:11px}
.blm-build-attempts summary{cursor:pointer;color:var(--blm-dim)}
.blm-build-attempts div{margin-top:4px}
.blm-btn.on{background:var(--blm-accent);border-color:var(--blm-accent);color:#fff}
.blm-chapter.owns{background:color-mix(in oklab,currentColor 4%,transparent)}
.blm-chapter input[type="checkbox"]{width:14px;height:14px;margin:0;padding:0;accent-color:var(--blm-accent)}
.blm-selectbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;position:sticky;bottom:0;padding:9px 0;margin-top:10px;background:var(--blm-bg);border-top:1px solid var(--blm-line);z-index:3}
.blm-plan{border:1px solid var(--blm-line);border-radius:10px;padding:10px 12px;margin-top:14px;background:color-mix(in oklab,currentColor 3%,transparent)}
.blm-plan-modal{max-height:84vh;overflow:auto;width:100%;max-width:760px;margin:0;z-index:31;background:var(--blm-card)}
.blm-plan-line{margin:6px 0;font-size:12px}
.blm-plan-lectures{display:flex;flex-direction:column;gap:6px;margin:8px 0}
.blm-plan-lec{border-top:1px dashed var(--blm-line);padding-top:6px;font-size:12px}
.blm-series{margin-top:14px;display:flex;flex-direction:column;gap:6px}
.blm-series-row{display:flex;align-items:center;gap:8px;border:1px solid var(--blm-line);border-radius:8px;padding:7px 10px;background:var(--blm-card)}
.blm-series-card{border:1px solid var(--blm-line);border-radius:9px;padding:9px 10px;background:var(--blm-card);display:flex;flex-direction:column;gap:7px}
.blm-series-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.blm-series-lec{display:flex;align-items:center;gap:8px;border-top:1px dashed var(--blm-line);padding-top:6px;font-size:12px}
.blm-series-lec .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.blm-series-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.blm-stitch-table{display:flex;flex-direction:column;gap:5px;margin:8px 0;font-size:12px}
.blm-stitch-metric{display:flex;align-items:center;gap:8px;border-top:1px dashed var(--blm-line);padding-top:4px}
.blm-stitch-metric .grow{flex:1}
.blm-ok{color:#2ea043}
.blm-bad{color:#e55353}
.blm-modal-mask{position:fixed;inset:0;z-index:30;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;padding:18px}
.blm-modal{width:100%;max-width:420px;background:var(--blm-card);color:var(--blm-text);border:1px solid var(--blm-line);border-radius:12px;padding:14px;box-shadow:0 18px 44px rgba(0,0,0,.32)}
.blm-confirm{max-width:420px}
.blm-confirm-title{display:block;font-size:13px;font-weight:650;margin-bottom:6px}
.blm-confirm-text{margin:0;font-size:12px;line-height:1.65;color:var(--blm-dim);white-space:pre-wrap}
.blm-confirm-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.blm-confirm-input{margin-top:10px;width:100%;box-sizing:border-box}
.blm-btn.primary.danger{background:#c62828;border-color:#c62828}
.blm-btn.holding{position:relative;overflow:hidden}
.blm-btn.holdable{min-width:112px}
.blm-hold-count{position:absolute;right:6px;bottom:4px;font-size:9px;line-height:1;color:var(--blm-dim);font-variant-numeric:tabular-nums}
.blm-hold-bar{position:absolute;left:6px;right:6px;bottom:1px;height:2px;border-radius:99px;background:var(--blm-line);overflow:hidden}
.blm-hold-bar i{display:block;height:100%;background:var(--blm-accent);transition:width .06s linear}
.blm-chapter:last-child{border-bottom:0}
.blm-chapter input{width:100%;box-sizing:border-box;border:1px solid var(--blm-line);border-radius:5px;padding:3px 5px;font:inherit;background:var(--blm-card);color:inherit;color-scheme:inherit}
.blm-chapter .t{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:text}
.blm-toast{position:absolute;left:14px;right:14px;bottom:12px;background:#222;color:#fff;border-radius:8px;padding:8px 12px;font-size:12px;z-index:20;box-shadow:0 6px 20px rgba(0,0,0,.25)}
.blm-error{background:color-mix(in oklab,#c62828 10%,transparent);border:1px solid color-mix(in oklab,#c62828 30%,transparent);color:#c62828;border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:12px}
body[data-ds-dark-theme] .blm-error{color:#ff8a80}
.blm-note{background:color-mix(in oklab,currentColor 5%,transparent);border:1px solid var(--blm-line);color:var(--blm-dim);border-radius:8px;padding:8px 10px;margin-top:8px;font-size:12px}
.blm-usage-list{display:flex;flex-direction:column;gap:6px}
.blm-usage-group{display:flex;flex-direction:column;gap:6px}
.blm-usage-group-head{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:8px 10px;border:1px dashed var(--blm-line);border-radius:8px;background:transparent;color:var(--blm-dim);font:inherit;font-size:12px;cursor:pointer;text-align:left}
.blm-usage-group-head:hover{background:var(--blm-btn-hover);color:var(--blm-text)}
.blm-usage-group-head:focus-visible{outline:2px solid var(--blm-accent);outline-offset:-2px}
.blm-usage-group-head[aria-expanded="true"] .blm-usage-caret{transform:rotate(90deg)}
.blm-usage-group-body{display:flex;flex-direction:column;gap:6px}
.blm-usage-group-body[hidden]{display:none}
.blm-usage-group-count{color:var(--blm-dim);font-size:11px}
.blm-usage-group-trunc{color:var(--blm-dim);font-size:11px;padding:2px 4px}
.blm-usage-range-error{color:#c62828;font-size:12px;padding:0 2px 4px}
body[data-ds-dark-theme] .blm-usage-range-error{color:#ff8a80}
.blm-usage-date{flex:0 0 auto;min-width:0;width:132px}
.blm-usage-item{border:1px solid var(--blm-line);border-radius:8px;background:var(--blm-card);color:var(--blm-text);overflow:hidden;transition:border-color .14s ease}
.blm-usage-item:hover{border-color:color-mix(in oklab,var(--blm-accent) 32%,var(--blm-line))}
.blm-usage-item.is-open{border-color:color-mix(in oklab,var(--blm-accent) 48%,var(--blm-line))}
.blm-usage-summary{display:block;width:100%;box-sizing:border-box;text-align:left;padding:8px 10px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;white-space:normal;overflow-wrap:anywhere}
.blm-usage-summary:hover{background:var(--blm-btn-hover)}
.blm-usage-summary:focus-visible{outline:2px solid var(--blm-accent);outline-offset:-2px}
.blm-usage-item.is-open .blm-usage-summary{background:color-mix(in oklab,var(--blm-accent) 4%,transparent)}
.blm-usage-caret{display:inline-block;color:var(--blm-dim);font-size:10px;line-height:1;transform:rotate(0);transition:transform .14s ease}
.blm-usage-item.is-open .blm-usage-caret{transform:rotate(90deg)}
.blm-usage-detail{padding:8px 10px 10px 12px;border-top:1px solid color-mix(in oklab,var(--blm-accent) 30%,var(--blm-line));border-left:3px solid color-mix(in oklab,var(--blm-accent) 55%,transparent);background:color-mix(in oklab,var(--blm-accent) 7%,var(--blm-card));color:var(--blm-text);font-size:11px;overflow-wrap:anywhere}
body[data-ds-dark-theme] .blm-usage-item.is-open .blm-usage-summary{background:color-mix(in oklab,var(--blm-accent) 7%,transparent)}
body[data-ds-dark-theme] .blm-usage-detail{background:color-mix(in oklab,var(--blm-accent) 12%,var(--blm-card))}
.blm-usage-detail[hidden]{display:none}
.blm-usage-detail-head{display:flex;align-items:center;gap:6px;margin-bottom:4px}
.blm-usage-detail-head strong{font-size:12px}
.blm-usage-detail .blm-btn{padding:2px 8px;font-size:11px;line-height:1.5}
.blm-usage-detail .blm-note{margin-top:6px}
.blm-usage-loading{color:var(--blm-dim);padding:2px 0}
.blm-usage-error{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:#c62828}
body[data-ds-dark-theme] .blm-usage-error{color:#ff8a80}
.blm-usage-model{margin-top:2px;font-size:11px;overflow-wrap:anywhere}
@media (prefers-reduced-motion:reduce){.blm-usage-caret{transition:none}}
.blm-progress{height:4px;background:var(--blm-line);border-radius:99px;overflow:hidden;margin:10px 0}
.blm-progress i{display:block;height:100%;background:var(--blm-accent);transition:width .2s}
.blm-select{border:1px solid var(--blm-line);border-radius:6px;padding:5px 8px;font:inherit;background:var(--blm-card);color:var(--blm-text);color-scheme:inherit}
.blm-num{width:86px;border:1px solid var(--blm-line);border-radius:6px;padding:5px 7px;font:inherit;background:var(--blm-card);color:var(--blm-text);color-scheme:inherit}
.blm-trash{position:absolute;inset:0;background:var(--blm-bg);color:var(--blm-text);z-index:10;display:flex;flex-direction:column}
.blm-trash-list{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
.blm-trash-row{border:1px solid var(--blm-line);border-radius:8px;padding:9px 10px;display:flex;align-items:center;gap:8px;background:var(--blm-card)}
.blm-trash-row .grow{flex:1;min-width:0}

/* ---------- M4 播放器 ---------- */
.blm-player{position:absolute;inset:0;background:var(--blm-bg);color:var(--blm-text);z-index:12;display:flex;flex-direction:column;overflow:hidden}
.blm-player-main{flex:1;min-height:0;display:grid;grid-template-columns:var(--blm-split,55%) 6px minmax(0,1fr)}
.blm-pane-source{min-height:0;overflow:auto;padding:10px 12px 18px;border-right:1px solid var(--blm-line);background:var(--blm-bg)}
/* 默认 ppt-left 时原文在右，分隔线挂在原文窗格左侧；pdf-left 时沿用 base 的右侧那条 */
.blm-player-main:not(.pdf-left) .blm-pane-source{border-right:0;border-left:1px solid var(--blm-line)}
.blm-pane-stage{min-height:0;overflow:auto;padding:12px;display:flex;align-items:flex-start;justify-content:center}
.blm-divider{background:var(--blm-line);cursor:col-resize;position:relative;touch-action:none}
.blm-divider::after{content:'';position:absolute;inset:0 -4px}
.blm-divider:hover,.blm-divider:focus-visible{background:var(--blm-accent);outline:none}
.blm-source-top{position:sticky;top:0;z-index:2;background:var(--blm-bg);border-bottom:1px solid var(--blm-line);padding-top:6px;margin-bottom:8px}
.blm-source-sticky{display:flex;align-items:center;gap:8px;padding:6px 0}
.blm-chip{font-size:11px;border:1px solid var(--blm-line);border-radius:99px;padding:1px 8px;color:var(--blm-dim);white-space:nowrap}
.blm-chip.ok{color:#2ea043;border-color:color-mix(in oklab,#2ea043 35%,transparent)}
.blm-source-banner{font-size:11px;color:var(--blm-dim);background:color-mix(in oklab,currentColor 5%,transparent);border-radius:6px;padding:5px 8px;margin-bottom:8px}
.blm-pdf-pages{display:flex;flex-direction:column;gap:10px}
.blm-pdf-page{position:relative;border:1px solid var(--blm-line);border-radius:4px;overflow:hidden;background:#fff;line-height:0}
.blm-pdf-page canvas{width:100%;height:auto;display:block}
.blm-pdf-hl-layer{position:absolute;inset:0;pointer-events:none}
.blm-pdf-hl{position:absolute;background:rgba(255,205,0,.38);border-radius:2px;box-shadow:0 0 0 1px rgba(214,160,0,.35) inset}
.blm-pdf-page-no{position:absolute;right:6px;bottom:4px;font-size:10px;color:rgba(0,0,0,.45);line-height:1.4}
.blm-stage-wrap{width:100%;max-width:520px}
.blm-stage-stack{width:100%;max-width:520px}
.blm-subtitle{margin-top:10px;padding-top:8px;border-top:1px solid var(--blm-line);font-size:14px;line-height:1.7;color:var(--blm-text);white-space:pre-wrap;overflow-wrap:anywhere;text-align:left}
.blm-stage{position:relative;aspect-ratio:16/10;border-radius:8px;padding:26px 28px;display:flex;flex-direction:column;overflow:hidden;background:#f5f0e4;color:#2b2418;box-shadow:0 10px 26px rgba(0,0,0,.18);font-family:"Songti SC","SimSun",serif}
.blm-stage-title{font-size:22px;font-weight:650;line-height:1.35;margin-bottom:12px}
.blm-stage-kicker{font-size:11px;letter-spacing:.24em;color:#8a7b5a;margin-bottom:14px}
.blm-stage-sub{font-size:13px;color:#6b5f47}
.blm-stage-rule{height:1px;background:#c9bda0;margin:16px 0}
.blm-stage-body{flex:1;min-height:0;display:flex;gap:14px}
.blm-stage-copy{flex:1;min-width:0;overflow:hidden}
.blm-stage-bullets{margin:0;padding-left:18px;font-size:13px;line-height:1.75}
.blm-stage-bullets li{margin-bottom:7px}
.blm-stage-quote{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:12px}
.blm-stage-quote blockquote{margin:0;font-size:18px;line-height:1.7;font-weight:600}
.blm-stage-quote cite{font-style:normal;font-size:12px;color:#7a6c50}
.blm-stage-figure{position:relative;flex:0 0 34%;border:1px dashed #c9bda0;border-radius:6px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;font-size:10px;color:#8a7b5a;text-align:center;padding:8px;background:rgba(255,255,255,.35);cursor:pointer}
.blm-stage-figure:hover,.blm-stage-figure:focus-visible{border-color:#a8986f;background:rgba(255,255,255,.62);outline:none}
.blm-stage-figure.prompt-open{align-items:stretch;justify-content:flex-start;text-align:left;cursor:default;background:rgba(255,255,255,.78);overflow:auto}
.blm-stage-figure.has-img{border-style:solid;padding:0;background:transparent;cursor:zoom-in;overflow:hidden}
.blm-stage-figure b{font-size:11px;color:#6b5f47}
.blm-stage-figure-prompt{display:flex;flex-direction:column;gap:6px;width:100%;height:100%}
.blm-stage-figure-prompt-text{flex:1;overflow:auto;font-size:10px;line-height:1.55;color:#4a4030;word-break:break-word}
.blm-stage-figure-prompt-actions{display:flex;gap:4px;flex-wrap:wrap}
.blm-stage-figure-prompt-actions .blm-btn{font-size:10px;padding:2px 6px;color:#4a4030;border-color:#c9bda0}
.blm-stage-foot{position:absolute;right:14px;bottom:10px;font-size:10px;color:#a4977a}
.blm-player-foot{flex:0 0 auto;border-top:1px solid var(--blm-line);padding:8px 12px;display:flex;flex-direction:column;gap:6px;background:var(--blm-bg)}
.blm-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}
.blm-pagebar{width:120px;height:4px;border-radius:99px;background:var(--blm-line);overflow:hidden}
.blm-pagebar i{display:block;height:100%;background:var(--blm-accent)}
.blm-noaudio{font-size:11px;color:#c62828}
.blm-player-alert{display:flex;align-items:flex-start;gap:8px;padding:6px 12px;font-size:12px;color:#8a5a00;background:color-mix(in oklab,#f0b400 14%,transparent);border-bottom:1px solid color-mix(in oklab,#f0b400 32%,transparent)}
.blm-player-alert .grow{flex:1;min-width:0}
body[data-ds-dark-theme] .blm-player-alert{color:#ffd27a}
.blm-stage-figure-tools{position:absolute;right:4px;bottom:4px;display:flex;gap:4px;z-index:2}
.blm-stage-figure-tools .blm-btn{font-size:9px;padding:1px 5px;color:#4a4030;border-color:#c9bda0;background:rgba(255,255,255,.88)}
.blm-thumbs{display:flex;gap:6px;overflow-x:auto;padding:2px 0 4px}
.blm-thumb{flex:0 0 108px;aspect-ratio:16/9;border:1px solid var(--blm-line);border-radius:6px;background:#f5f0e4;color:#2b2418;padding:6px 7px 7px;font:inherit;cursor:pointer;position:relative;overflow:hidden;text-align:left;display:flex;flex-direction:column;gap:3px;font-family:"Songti SC","SimSun",serif;opacity:.76}
.blm-thumb:hover{opacity:1}
.blm-thumb.on{opacity:1;border-color:var(--blm-accent);box-shadow:0 0 0 1px var(--blm-accent)}
.blm-thumb-no{position:absolute;right:4px;bottom:2px;font:10px/1 system-ui,sans-serif;color:#a4977a}
.blm-thumb-kicker{font:7px/1.2 system-ui,sans-serif;letter-spacing:.16em;color:#8a7b5a}
.blm-thumb-title{font-size:9px;line-height:1.3;font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.blm-thumb-sub{font-size:7px;line-height:1.2;color:#6b5f47;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.blm-thumb-lines{display:flex;flex-direction:column;gap:2px;flex:1;min-height:4px;overflow:hidden}
.blm-thumb-line{height:2px;border-radius:1px;background:#c9bda0}
.blm-thumb-line:nth-child(2){width:78%}
.blm-thumb-line:nth-child(3){width:90%}
.blm-thumb-quote-text{flex:1;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;text-align:center;font-style:italic;font-size:8px;line-height:1.4;color:#4a4030;padding:0 2px}
.blm-thumb-cover{background:#efe5d0}
.blm-thumb-cover .blm-thumb-title{font-size:11px;line-height:1.25}
.blm-thumb-quote{background:#f8f2e4}
.blm-transition{position:absolute;inset:0;z-index:15;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:rgba(0,0,0,.72);color:#fff;text-align:center;padding:24px}
.blm-transition h2{margin:0;font-size:20px;font-weight:600}
.blm-transition .count{font-size:12px;opacity:.75}
.blm-drawer-mask{position:absolute;inset:0;z-index:14;background:rgba(0,0,0,.35);display:flex;justify-content:flex-end}
.blm-drawer{width:min(340px,86%);height:100%;background:var(--blm-card);color:var(--blm-text);border-left:1px solid var(--blm-line);display:flex;flex-direction:column;overflow:hidden}
.blm-drawer-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--blm-line)}
.blm-drawer-body{flex:1;overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.blm-drawer-item{display:flex;align-items:center;gap:8px;border:1px solid var(--blm-line);border-radius:8px;padding:7px 9px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.blm-drawer-item.on{border-color:var(--blm-accent)}
.blm-drawer-item:disabled{opacity:.55;cursor:default}
.blm-drawer-item .grow{flex:1;min-width:0}
@media (max-width:1040px){
  .blm-player-main{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) 6px minmax(0,1fr)}
  .blm-pane-stage{order:1}
  .blm-divider{order:2;cursor:row-resize}
  /* 上下堆叠时只留顶部那条分隔线（需要压过 :not(.pdf-left) 的左右边框） */
  .blm-player-main .blm-pane-source,
  .blm-player-main:not(.pdf-left) .blm-pane-source{order:3;border:0;border-top:1px solid var(--blm-line)}
  /* 窄屏是上下堆叠，没有左右可换：入口隐藏，堆叠顺序固定为上幻灯片 / 下原文 */
  .blm-swap{display:none}
  .blm-stage{max-height:100%}
}

/* ---------- M4 设置 ---------- */
/* 2.5：设置页顶栏标签（吸顶、单行横向滚动、共享下划线指示条） */
.blm-tabs-wrap{position:sticky;top:0;z-index:3;background:var(--blm-bg);padding-top:2px;border-bottom:1px solid var(--blm-line);margin-bottom:12px}
.blm-tabs{position:relative;display:flex;align-items:center;gap:2px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;padding:0 2px}
.blm-tabs::-webkit-scrollbar{display:none}
.blm-tab{appearance:none;border:0;background:transparent;color:var(--blm-dim);font:inherit;font-size:12px;line-height:1.4;padding:7px 10px 8px;border-radius:8px 8px 0 0;cursor:pointer;white-space:nowrap;transition:color 120ms ease,background-color 120ms ease}
.blm-tab:hover{background:color-mix(in oklab,var(--blm-accent) 8%,transparent);color:var(--blm-text)}
.blm-tab[aria-selected="true"]{color:var(--blm-text)}
.blm-tab:focus-visible{outline:2px solid color-mix(in oklab,var(--blm-accent) 55%,transparent);outline-offset:-2px}
.blm-tab-ink{position:absolute;left:0;bottom:0;height:2px;border-radius:1px;background:var(--blm-accent);pointer-events:none;transition:transform 200ms cubic-bezier(.2,.7,.2,1),width 200ms cubic-bezier(.2,.7,.2,1)}
.blm-settings{display:flex;flex-direction:column;gap:14px}
.blm-settings>[hidden]{display:none}
.blm-group{border:1px solid var(--blm-line);border-radius:10px;background:var(--blm-card);padding:10px 12px}
.blm-group h3{margin:0 0 8px;font-size:12px;font-weight:650;letter-spacing:.04em;color:var(--blm-dim)}
@media (prefers-reduced-motion:reduce){
  .blm-tab,.blm-tab-ink{transition:none}
}
.blm-field{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0;font-size:12px}
.blm-field > .label{flex:0 0 68px;color:var(--blm-dim)}
.blm-field > .label[title]{cursor:help}
.blm-voice-actions{margin-top:14px;padding-top:10px;border-top:1px solid var(--blm-line);justify-content:flex-end}
.blm-probe-note{display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap}
.blm-probe-text{flex:1;min-width:150px}
.blm-probe-regen{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;padding:0;text-decoration:underline;cursor:pointer;white-space:nowrap}
.blm-probe-regen:disabled{opacity:.55;cursor:default;text-decoration:none}
.blm-input{flex:1;min-width:140px;border:1px solid var(--blm-line);border-radius:6px;padding:5px 8px;font:inherit;background:var(--blm-card);color:var(--blm-text);color-scheme:inherit}
.blm-kv{display:grid;grid-template-columns:92px 1fr;gap:6px 10px;margin:0;font-size:12px}
.blm-kv dt{color:var(--blm-dim)}
.blm-kv dd{margin:0;overflow:hidden;text-overflow:ellipsis;word-break:break-all}
.blm-backup{display:flex;align-items:center;gap:6px;border-top:1px dashed var(--blm-line);padding-top:6px;margin-top:6px;font-size:12px}
.blm-backup .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.blm-note.warn{border-color:color-mix(in oklab,#c62828 30%,transparent);color:#c62828}
body[data-ds-dark-theme] .blm-note.warn{color:#ff8a80}
.blm-note.tip{border-color:color-mix(in oklab,#a86400 35%,transparent);color:#8a5300}
body[data-ds-dark-theme] .blm-note.tip{color:#ffcc80}
.blm-errline{font-size:11px;color:var(--blm-dim)}

/* ---------- M5 练习 / 导出 / 书档 / 配图 ---------- */
.blm-practice{display:flex;flex-direction:column;gap:8px}
.blm-practice-q{border:1px solid var(--blm-line);border-radius:10px;padding:10px 12px;background:var(--blm-card)}
.blm-practice-stem{font-size:13px;font-weight:600;margin-bottom:8px;line-height:1.6}
.blm-option{display:flex;align-items:flex-start;gap:8px;border:1px solid var(--blm-line);border-radius:8px;padding:7px 9px;margin:6px 0;cursor:pointer;background:transparent;color:inherit;font:inherit;text-align:left;width:100%}
.blm-option .key{flex:0 0 20px;font-weight:650;color:var(--blm-dim)}
.blm-option.on{border-color:var(--blm-accent);background:color-mix(in oklab,var(--blm-accent) 8%,transparent)}
.blm-option.right{border-color:#2ea043;background:color-mix(in oklab,#2ea043 10%,transparent)}
.blm-option.wrong{border-color:#e55353;background:color-mix(in oklab,#e55353 10%,transparent)}
.blm-option:disabled{cursor:default}
.blm-practice-feedback{border-top:1px dashed var(--blm-line);margin-top:8px;padding-top:8px;font-size:12px}
.blm-practice-quote{border-left:3px solid var(--blm-line);padding-left:8px;color:var(--blm-dim);margin-top:6px;white-space:pre-wrap}
.blm-cover-thumb{width:100%;border-radius:8px;border:1px solid var(--blm-line);object-fit:contain;max-height:180px}
.blm-stage-figure-img{width:100%;height:100%;object-fit:contain;border-radius:4px;display:block}
.blm-export-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}
.blm-import-items{display:flex;flex-direction:column;gap:5px;margin:8px 0;max-height:220px;overflow:auto}
.blm-import-item{border:1px solid var(--blm-line);border-radius:7px;padding:6px 8px;font-size:12px;display:flex;align-items:center;gap:6px}
.blm-import-item .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;

    async function api(path, options) {
      const res = await fetch(API + path, options);
      const raw = await res.text().catch(() => '');
      let data = null;
      if (raw) {
        try {
          data = JSON.parse(raw);
        } catch {
          data = null;
        }
      }
      if (data === null) {
        const why =
          res.status === 404
            ? '插件可能没加载，重启 DSH 后再试。'
            : res.status === 405
              ? '接口没注册到 DSH，或方法不匹配（插件版本与宿主不一致）。重启无效，请更新或重装插件。'
              : '稍后重试；一直这样就把 DSH 重启一次。';
        const err = new Error('插件服务无响应（HTTP ' + res.status + '）。' + why);
        err.code = 'E_BAD_RESPONSE';
        err.detail = { status: res.status, path: API + path, body: raw.slice(0, 300) };
        throw err;
      }
      if (!data || data.ok !== true) {
        const err = new Error((data && (data.message || data.error)) || '请求失败');
        err.code = data && data.code;
        err.detail = data;
        throw err;
      }
      return data;
    }

    /** 客户端主动 abort 的同步长请求不算失败，不弹错误。 */
    function isAbortError(err) {
      return !!err && (err.name === 'AbortError' || err.code === 'E_ABORTED');
    }

    const PACKAGE_POLICY_KEY = 'book-slides.pkg-policy';

    function readPackagePolicy() {
      try {
        if (typeof localStorage === 'undefined') return 'merge';
        const value = localStorage.getItem(PACKAGE_POLICY_KEY);
        return ['merge', 'skip', 'copy'].includes(value) ? value : 'merge';
      } catch {
        return 'merge';
      }
    }

    function savePackagePolicy(value) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(PACKAGE_POLICY_KEY, String(value || 'merge'));
      } catch {
        /* 隐私模式下 localStorage 会抛，忽略 */
      }
    }

    const VIEW_KEY = 'book-slides.view';
    const ID_SHAPE = /^[a-z0-9]{8,16}$/;

    function readSavedView() {
      try {
        if (typeof sessionStorage === 'undefined') return { name: 'shelf' };
        const raw = sessionStorage.getItem(VIEW_KEY);
        if (!raw) return { name: 'shelf' };
        const value = JSON.parse(raw);
        if (!value || typeof value !== 'object') return { name: 'shelf' };
        const name = String(value.name || '');
        if (name === 'settings') return { name: 'settings' };
        if (name === 'usage') return { name: 'usage' };
        if (name === 'book' && ID_SHAPE.test(String(value.bookId || ''))) {
          return { name: 'book', bookId: String(value.bookId) };
        }
        if (
          name === 'player' &&
          ID_SHAPE.test(String(value.bookId || '')) &&
          ID_SHAPE.test(String(value.seriesId || ''))
        ) {
          return {
            name: 'player',
            bookId: String(value.bookId),
            seriesId: String(value.seriesId),
            lecture: Math.max(0, Number(value.lecture) || 0),
            slide: Math.max(0, Number(value.slide) || 0),
          };
        }
      } catch {
        /* 坏 JSON / 隐私模式都回到书架 */
      }
      return { name: 'shelf' };
    }

    function saveView(view) {
      try {
        if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(VIEW_KEY, JSON.stringify(view || { name: 'shelf' }));
      } catch {
        /* 隐私模式下忽略 */
      }
    }

    function uploadPdf(file, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', API + '/import');
        xhr.setRequestHeader('content-type', 'application/pdf');
        xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
        };
        xhr.onerror = () => reject(new Error('上传失败，检查连接后重试。'));
        xhr.onload = () => {
          let data = null;
          try {
            data = JSON.parse(xhr.responseText || '{}');
          } catch {
            reject(new Error('服务端返回的不是 JSON'));
            return;
          }
          resolve(data);
        };
        xhr.send(file);
      });
    }

    function Toast({ text }) {
      if (!text) return null;
      return h('div', { className: 'blm-toast' }, text);
    }

    /** 书档上传：裸 ZIP + x-file-name；返回 {jobId} 或错误码。 */
    function uploadZip(file, policy, onProgress) {
      return new Promise((resolve, reject) => {
        if (typeof XMLHttpRequest === 'undefined') {
          reject(new Error('当前环境不支持上传'));
          return;
        }
        const xhr = new XMLHttpRequest();
        xhr.open('POST', API + '/import/package?policy=' + encodeURIComponent(policy || 'merge'));
        xhr.setRequestHeader('content-type', 'application/zip');
        xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
        };
        xhr.onerror = () => reject(new Error('上传失败，检查连接后重试。'));
        xhr.onload = () => {
          try {
            resolve(JSON.parse(xhr.responseText || '{}'));
          } catch {
            reject(new Error('服务端返回的不是 JSON'));
          }
        };
        xhr.send(file);
      });
    }

    function downloadUrl(path, fileName) {
      if (typeof document === 'undefined') return;
      const url = API + path;
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = String(fileName || '');
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    }

    /** 导入响应归类：成功 / 重复（已在书架）/ 失败；重复也要拿 bookId 去定位书卡（AC-158）。 */
    function importOutcome(out) {
      if (out && out.ok) {
        return { kind: 'created', bookId: String(out.bookId || ''), title: String((out.book && out.book.title) || '') };
      }
      if (out && out.code === 'E_DUP_BOOK') {
        return { kind: 'duplicate', bookId: String(out.bookId || ''), title: String(out.title || '') };
      }
      return { kind: 'failed', message: String((out && (out.message || out.error)) || '导入失败') };
    }

    /** 书 ID 只允许安全字符；避免把服务端值拼进选择器时改变语义。 */
    const BOOK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

    /**
     * 重复导入后留在书架，把已存在的书卡滚进视野并聚焦（AC-158）。
     * 找不到卡片（200 本上限/列表尚未刷新）或嵌入环境不支持滚动时静默放弃。
     */
    function focusBookCard(root, bookId) {
      if (!root || !bookId || typeof root.querySelector !== 'function') return false;
      const id = String(bookId);
      if (!BOOK_ID_PATTERN.test(id)) return false;
      let node = null;
      try {
        node = root.querySelector('[data-book-id="' + id + '"]');
      } catch {
        return false;
      }
      if (!node) return false;
      if (typeof node.scrollIntoView === 'function') {
        let reduceMotion = false;
        try {
          reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch {
          /* 忽略：取不到媒体查询就按普通滚动 */
        }
        try {
          node.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
        } catch {
          try {
            node.scrollIntoView({ block: 'center' });
          } catch {
            /* 忽略：某些嵌入环境不接受参数 */
          }
        }
      }
      if (typeof node.focus === 'function') {
        try {
          node.focus({ preventScroll: true });
        } catch {
          try {
            node.focus();
          } catch {
            /* 忽略：焦点由浏览器自己决定 */
          }
        }
      }
      return true;
    }

    /** 系统是否要求减少动态效果；取不到媒体查询时按普通滚动处理。 */
    function prefersReducedMotion() {
      try {
        return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch {
        return false;
      }
    }

    /** 居中容差：当前页中心与可视区中心偏差不超过该值时不滚动，避免亚像素抖动。 */
    const THUMB_CENTER_TOLERANCE = 2;

    /**
     * 预览窗格横向滚动目标（不直接操作 DOM，便于单测）：
     * 当前页尽量滚到可视区正中；首末页与内容不足一屏时夹紧到 [0, 最大滚动量]，不制造空白。
     * 已居中（±THUMB_CENTER_TOLERANCE）时返回 null；relativeLeft / relativeRight 是缩略图相对滚动容器左边缘的偏移。
     */
    function thumbScrollLeft(scrollLeft, clientWidth, scrollWidth, relativeLeft, relativeRight) {
      const width = Number(clientWidth) || 0;
      const base = Number(scrollLeft) || 0;
      const max = Math.max(0, (Number(scrollWidth) || 0) - width);
      if (width <= 0 || max <= 0) return null;
      if (!Number.isFinite(relativeLeft) || !Number.isFinite(relativeRight)) return null;
      const center = (relativeLeft + relativeRight) / 2;
      const target = Math.max(0, Math.min(base + center - width / 2, max));
      return Math.abs(target - base) <= THUMB_CENTER_TOLERANCE ? null : target;
    }

    /**
     * 把当前页缩略图滚到预览窗格正中（播放器底部逐页缩略图）。
     * 首末页与内容不足一屏时夹紧到边界，不强制置中；只改 scrollLeft，不带动外层页面纵向滚动。
     */
    function scrollThumbIntoView(container, thumb, behavior) {
      if (!container || !thumb) return false;
      if (typeof container.getBoundingClientRect !== 'function' || typeof thumb.getBoundingClientRect !== 'function') {
        return false;
      }
      let containerRect = null;
      let thumbRect = null;
      try {
        containerRect = container.getBoundingClientRect();
        thumbRect = thumb.getBoundingClientRect();
      } catch {
        return false;
      }
      if (!containerRect || !thumbRect) return false;
      const next = thumbScrollLeft(
        container.scrollLeft,
        container.clientWidth,
        container.scrollWidth,
        thumbRect.left - containerRect.left,
        thumbRect.right - containerRect.left,
      );
      if (next == null) return false;
      const mode = behavior || (prefersReducedMotion() ? 'auto' : 'smooth');
      const assign = () => {
        container.scrollLeft = next;
      };
      try {
        if (typeof container.scrollTo === 'function') container.scrollTo({ left: next, behavior: mode });
        else assign();
      } catch {
        try {
          container.scrollTo({ left: next });
        } catch {
          assign();
        }
      }
      return true;
    }

    /** 预览窗格手动滚动后的让位时长：期间播放翻页不抢滚动，键盘/点击仍立即跟随。 */
    const THUMB_SCROLL_YIELD_MS = 5000;

    /** 这次翻页是否要暂缓滚动：只有播放驱动且仍在让位期内才返回剩余毫秒，否则返回 0。 */
    function thumbScrollDeferMs(source, yieldUntil, now) {
      if (source !== 'playback') return 0;
      return Math.max(0, (Number(yieldUntil) || 0) - (Number(now) || 0));
    }

    /* ------------------------------ M4 纯函数（可单测） ------------------------------ */

    /** 分隔条比例夹紧，与服务端 prefs.clampSplit 保持一致。 */
    function clampSplitValue(value) {
      const ratio = Number(value);
      if (!Number.isFinite(ratio)) return 0.55;
      return Math.round(Math.min(0.75, Math.max(0.25, ratio)) * 1000) / 1000;
    }

    /**
     * 播放布局（FR-18.2）：只认两个方向，缺失/非法回默认 `ppt-left`。
     * `split` 记的是**原文窗格**占比，与方向无关；换位不改宽度。
     */
    const PLAYER_LAYOUTS = ['ppt-left', 'pdf-left'];

    function clampLayout(value) {
      const text = String(value || '');
      return PLAYER_LAYOUTS.includes(text) ? text : 'ppt-left';
    }

    /** 原文窗格占比 → 左栏占比（原文在左时相等，在右时取补；取补后按 3 位小数收敛误差）。 */
    function leftRatioFor(layout, split) {
      const ratio = clampSplitValue(split);
      const left = clampLayout(layout) === 'pdf-left' ? ratio : 1 - ratio;
      return Math.round(left * 1000) / 1000;
    }

    /** 左栏占比 → 原文窗格占比（leftRatioFor 的逆运算）。 */
    function splitForLeftRatio(layout, leftRatio) {
      const ratio = clampSplitValue(leftRatio);
      return clampSplitValue(clampLayout(layout) === 'pdf-left' ? ratio : 1 - ratio);
    }

    function nextLayout(layout) {
      return clampLayout(layout) === 'ppt-left' ? 'pdf-left' : 'ppt-left';
    }

    /** 语速吸附到 0.8/1.0/1.2 三档。 */
    function clampRateValue(value) {
      const rate = Number(value);
      if (!Number.isFinite(rate)) return 1;
      let best = RATE_STEPS[0];
      let distance = Infinity;
      for (const step of RATE_STEPS) {
        const next = Math.abs(step - rate);
        if (next < distance) {
          best = step;
          distance = next;
        }
      }
      return best;
    }

    /**
     * 键盘映射（FR-18）：空格播放/暂停、←/→ 翻页、F 全屏、Esc 退全屏/返回。
     * 表单控件与带修饰键的按键不抢。
     */
    function playerKeyAction(event) {
      if (!event) return null;
      const target = event.target || {};
      const tag = String(target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return null;
      if (event.ctrlKey || event.metaKey || event.altKey) return null;
      // 按钮/链接/role=button（如配图位）自己处理空格：不再让全局快捷键抢一次
      const role = typeof target.getAttribute === 'function' ? String(target.getAttribute('role') || '') : '';
      const buttonish = tag === 'BUTTON' || tag === 'A' || role === 'button';
      if (buttonish && event.code === 'Space') return null;
      if (event.code === 'Space') return 'play';
      if (event.key === 'ArrowRight') return 'next';
      if (event.key === 'ArrowLeft') return 'prev';
      if (event.key === 'f' || event.key === 'F') return 'fullscreen';
      if (event.key === 'Escape') return 'escape';
      return null;
    }

    /** 一页怎么出声：有音频文件 → file；provider=browser 且有朗读稿 → speech；否则 none。 */
    function slideAudioMode(slide) {
      if (!slide) return 'none';
      if (slide.audio_file) return 'file';
      const provider = String(slide.audio_provider || '');
      if ((provider === 'browser' || !provider) && String(slide.audio_script || '').trim()) return 'speech';
      return 'none';
    }

    /**
     * 播放 effect 的稳定输入：只包含“本页音频”相关字段。
     * 配图状态 / 图片种子 / 提示词变化不应改变它，否则换一张会重启当前页播放。
     */
    function playbackKey(slide) {
      if (!slide) return '';
      return [
        slide.audio_file || '',
        slide.audio_provider || '',
        slide.audio_ms || 0,
        slide.audio_script || '',
      ].join('\u0001');
    }

    /**
     * 切回窗口刷新时的裁决。与建源 effect 的依赖保持同一口径：
     * 只有「页数变化 / 当前页音频签名变化 / 当前页不存在」才需要重建音频；
     * 配图、文字排版等变化只换数据，不应打断正在播的声音。
     * @returns {{changed:boolean, rebuild:boolean}}
     */
    function refreshDecision(prevSlides, nextSlides, index) {
      const prev = Array.isArray(prevSlides) ? prevSlides : [];
      const next = Array.isArray(nextSlides) ? nextSlides : [];
      const current = Math.max(0, Math.round(Number(index) || 0));
      return {
        changed: JSON.stringify(prev) !== JSON.stringify(next),
        rebuild:
          prev.length !== next.length ||
          (next.length > 0 && !next[current]) ||
          playbackKey(prev[current]) !== playbackKey(next[current]),
      };
    }

    /**
     * 换图期间的临时显示覆盖：继续显示旧图，等任务结束再以服务端结果为准。
     * 只覆盖图片字段，不动 image_status，避免把“生成中”当成播放输入。
     */
    function slideWithImageOverride(slide, override) {
      if (!slide || !override) return slide;
      return Object.assign({}, slide, {
        image_file: override.file != null ? override.file : slide.image_file,
        image_seed: override.seed != null ? override.seed : slide.image_seed,
      });
    }

    function lectureStatusOf(series, n) {
      const hit = ((series && series.lectures) || []).find((item) => Number(item.n) === Number(n));
      return hit ? String(hit.status || '') : '';
    }

    /**
     * 讲末页之后去哪：优先跳到下一讲已就绪的讲（中间失败的讲记入 skipped 并提示）；
     * 后面一讲都没有就绪 → blocked（提示但不循环）；最后一讲 → end。
     * @returns {{kind:'transition'|'blocked'|'end', n?:number, title?:string, status?:string, skipped?:number[]}}
     */
    function nextLectureAfter(series, fromN) {
      const lectures = ((series && series.lectures) || []).slice().sort((a, b) => Number(a.n) - Number(b.n));
      const index = lectures.findIndex((item) => Number(item.n) === Number(fromN));
      if (index < 0 || index >= lectures.length - 1) return { kind: 'end' };
      const later = lectures.slice(index + 1);
      const ready = later.find((item) => READY_LECTURE.includes(String(item.status || '')));
      if (ready) {
        return {
          kind: 'transition',
          n: Number(ready.n),
          title: String(ready.title || ''),
          skipped: later
            .filter((item) => Number(item.n) < Number(ready.n) && !READY_LECTURE.includes(String(item.status || '')))
            .map((item) => Number(item.n)),
        };
      }
      const next = later[0];
      return {
        kind: 'blocked',
        n: Number(next.n),
        title: String(next.title || ''),
        status: String(next.status || ''),
        skipped: later.map((item) => Number(item.n)),
      };
    }

    /** 顶部/底部进度文案：系列 24/42 页 · 第 2 讲 3/18 页。 */
    function formatSeriesProgress(progress) {
      const value = progress || {};
      const lecture = Number(value.lecture) || 1;
      const slide = Number(value.slide) || 0;
      const lecturePages = Number(value.lecturePages) || 0;
      const heardPages = Number(value.heardPages) || 0;
      const totalPages = Number(value.totalPages) || 0;
      const series = '系列 ' + heardPages + '/' + totalPages + ' 页';
      return series + ' · 第 ' + lecture + ' 讲 ' + slide + '/' + lecturePages + ' 页';
    }

    /** 作业行：第 k/N 讲 · 第 p/P 页（AC-122）。 */
    function formatJobLine(job, fallbackTotal) {
      if (!job) return '';
      const k = Number(job.lecture) || 1;
      const n = Number(job.lecturesTotal) || Number(fallbackTotal) || 1;
      const p = Number(job.current) || 0;
      const total = Number(job.total) || 0;
      return '第 ' + k + '/' + n + ' 讲 · 第 ' + p + '/' + total + ' 页';
    }

    /**
     * 章节勾选态（AC-92 / AC-129）：
     * 已确认 Part 的章 checked + disabled，用预防式禁选从源头避免 Part 冲突；
     * 改归属必须走组头「编辑」，不能让用户在列表里直接反选。
     */
    function chapterSelectionState({ n, front = false, owner = null, selected = [], busy = false }) {
      const num = Number(n);
      const picked = (Array.isArray(selected) ? selected : []).includes(num);
      const owned = owner != null;
      const title = owner && owner.title ? String(owner.title) : '其它 Part';
      return {
        checked: picked || owned,
        disabled: front === true || busy === true || owned,
        title: front === true
          ? '前文不参与 Part'
          : owned
            ? '属于《' + title + '》；不可直接取消勾选，改归属请用「编辑」'
            : '选择这一章',
      };
    }

    /** 系列是否仍基于创建时的 Part 章快照（AC-93）。 */
    function seriesSnapshotVersion(series, part) {
      if (!series || !part) return 0;
      const saved = Number(series.part_version) || 1;
      const current = Number(part.version) || 1;
      return saved < current ? saved : 0;
    }

    /** 从「继续听」的进度找起始页：优先该讲页码，其次第 1 页。 */
    function resolveInitialSlide(slides, wanted) {
      const list = Array.isArray(slides) ? slides : [];
      if (!list.length) return 0;
      if (!Number(wanted)) return 0;
      const byIndex = list.findIndex((item) => Number(item && item.slide_index) === Number(wanted));
      if (byIndex >= 0) return byIndex;
      const clamped = Math.min(list.length, Math.max(1, Math.round(Number(wanted))));
      return clamped - 1;
    }

    /** 页内位置上限：24h；负数/非数字/过小一律 0。 */
    const MAX_RESUME_MS = 24 * 60 * 60 * 1000;
    function normalizeOffsetMs(value) {
      const ms = Math.round(Number(value));
      if (!Number.isFinite(ms) || ms < 0) return 0;
      if (ms < 500) return 0;
      return Math.min(MAX_RESUME_MS, ms);
    }

    /** 毫秒 → mm:ss（超过 1 小时带小时位）。 */
    function formatClock(value) {
      const total = Math.max(0, Math.floor((Number(value) || 0) / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      const pad = (n) => String(n).padStart(2, '0');
      return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
    }

    /**
     * 续播位置裁决：音频签名变了 / 超出新音频时长 / 过小 → 0。
     * 时长未知（0）时保留，等 loadedmetadata 后再夹。
     */
    function resolveResumeOffset({ savedMs, durationMs, audioKey, savedAudioKey } = {}) {
      if (savedAudioKey != null && audioKey != null && String(savedAudioKey) !== String(audioKey)) return 0;
      const ms = normalizeOffsetMs(savedMs);
      if (!ms) return 0;
      const duration = Number(durationMs);
      if (Number.isFinite(duration) && duration > 0 && ms >= duration) return 0;
      return ms;
    }

    /**
     * 恢复挂起位置的裁决。初始 hydration 会先渲染旧 index（第 1 页），
     * 下一帧才切到目标页；这一帧只能“先留着” resume，不能因为页不匹配就丢掉。
     * 返回 `{restoreMs, keyChanged, clear}`。
     */
    function resolvePendingResume({ pending, currentSlide, lecture, slides, audioKey } = {}) {
      if (!pending || !currentSlide) return { restoreMs: 0, keyChanged: false, clear: false };
      const samePage =
        Number(pending.lecture) === Number(lecture) &&
        Number(pending.slide) === Number(currentSlide.slide_index);
      if (samePage && String(pending.audioKey) === String(audioKey)) {
        return { restoreMs: normalizeOffsetMs(pending.offsetMs), keyChanged: false, clear: false };
      }
      if (samePage) return { restoreMs: 0, keyChanged: true, clear: true };
      const list = Array.isArray(slides) ? slides : [];
      const targetExists = list.some((item) => Number(item && item.slide_index) === Number(pending.slide));
      return {
        restoreMs: 0,
        keyChanged: false,
        clear: Number(pending.lecture) !== Number(lecture) || !targetExists,
      };
    }

    /** pdf.js 的 Util.transform，自己实现一份，便于单测与离线计算。 */
    function pdfTransform(m1, m2) {
      return [
        m1[0] * m2[0] + m1[2] * m2[1],
        m1[1] * m2[0] + m1[3] * m2[1],
        m1[0] * m2[2] + m1[2] * m2[3],
        m1[1] * m2[2] + m1[3] * m2[3],
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
      ];
    }

    /** 与 slides.js 的归一化一致：去空白、去标点、全角转半角、小写。 */
    function normalizePdfText(value) {
      return String(value == null ? '' : value)
        .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
        .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
        .replace(/[\s\u3000]+/g, '')
        .replace(/[\p{P}\p{S}]/gu, '')
        .toLowerCase();
    }

    /**
     * 把 source_quote 映射成相对页面的百分比矩形（FR-18 / AC-123）。
     * 整句优先，找不到时用前 14 字兜底；同一基线的碎片合成一行。
     */
    function pdfHighlightRects(items, quote, viewport) {
      const needle = normalizePdfText(quote);
      if (!needle || !Array.isArray(items) || !viewport || !viewport.width || !Array.isArray(viewport.transform)) return [];
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

      const lines = new Map();
      for (const index of used) {
        const item = items[index];
        if (!item || !item.transform) continue;
        const tx = pdfTransform(viewport.transform, item.transform);
        const fontHeight = Math.max(5, Math.hypot(tx[2], tx[3]));
        const width = Math.max(2, (Number(item.width) || 0) * (Number(viewport.scale) || 1));
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

    /** pdf.js 的取消渲染异常属于正常控制流，不当失败。 */
    function isRenderCancelled(err) {
      const name = String((err && err.name) || '');
      const message = String((err && err.message) || err || '').trim();
      return /RenderingCancel/i.test(name) || /^Rendering cancelled/i.test(message);
    }

    function formatSize(bytes) {
      const value = Number(bytes) || 0;
      if (value < 1024) return value + ' B';
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
      if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB';
      return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    /* ------------------------------ FR-27 用量格式化 ------------------------------ */

    function formatTokens(value) {
      const n = Number(value) || 0;
      if (n >= 100000000) return (n / 100000000).toFixed(2) + ' 亿';
      if (n >= 10000) return (n / 10000).toFixed(1) + ' 万';
      return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function formatMoney(value) {
      if (value == null) return '—';
      const n = Number(value);
      if (!Number.isFinite(n)) return '—';
      if (n > 0 && n < 0.01) return '<¥0.01';
      return '¥' + n.toFixed(2);
    }

    function usageKindLabel(job) {
      const kind = String((job && job.kind) || '');
      const phase = String((job && job.phase) || '');
      if (kind === 'lecture') return phase === 'plan' ? '讲纲' : '生成讲义';
      if (kind === 'tts') return '配音';
      if (kind === 'image') return '配图';
      if (phase === 'probe') return '试听/测试';
      if (phase === 'toc') return '分章';
      if (phase === 'practice') return '练习';
      return '其他';
    }

    /** 一条「本次用量」摘要：tokens 与字符/张数分开，金额最后。 */
    function usageSummaryLine(job) {
      if (!job) return '';
      const actual = job.actual || {};
      const parts = [];
      const tokens = actual.tokens || {};
      const tokenTotal = (Number(tokens.input) || 0) + (Number(tokens.output) || 0) + (Number(tokens.cacheRead) || 0);
      if (tokenTotal) {
        const cache = Number(tokens.cacheRead) || 0;
        parts.push(
          '输入 ' + formatTokens(tokens.input) + (cache ? ' + 缓存读 ' + formatTokens(cache) : '') +
            ' / 输出 ' + formatTokens(tokens.output) + ' tokens',
        );
      }
      if (Number(actual.chars)) parts.push(formatTokens(actual.chars) + ' 字符');
      if (Number(actual.images)) parts.push(actual.images + ' 张');
      if (Number(actual.cachedPages)) parts.push('缓存命中 ' + actual.cachedPages + ' 页');
      if (!parts.length && !Number(actual.calls)) parts.push('无计费调用');
      parts.push(formatMoney(actual.cost));
      return parts.join(' · ');
    }

    /** 用量历史时间筛选：日粒度预设 + 自定义起止日期（2.6 / FR-27.6）。 */
    const USAGE_TIME_PRESETS = [
      { id: 'all', label: '全部时间' },
      { id: '7d', label: '近 7 天' },
      { id: '30d', label: '近 30 天' },
      { id: 'month', label: '本月' },
      { id: 'custom', label: '自定义' },
    ];

    function isoLocalDay(date) {
      const p = (n) => String(n).padStart(2, '0');
      return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate());
    }

    function shiftLocalDays(date, days) {
      return new Date(date.getFullYear(), date.getMonth(), date.getDate() + Number(days || 0));
    }

    /** 预设区间在每次加载时按“现在”重算；最小粒度 1 个本地日。 */
    function usageRangeFor(preset, custom, now) {
      const at = now instanceof Date ? now : new Date();
      const pick = custom && typeof custom === 'object' ? custom : {};
      if (preset === '7d') return { from: isoLocalDay(shiftLocalDays(at, -6)), to: isoLocalDay(at) };
      if (preset === '30d') return { from: isoLocalDay(shiftLocalDays(at, -29)), to: isoLocalDay(at) };
      if (preset === 'month') return { from: monthStartIso(at), to: isoLocalDay(at) };
      if (preset === 'custom') return { from: String(pick.from || ''), to: String(pick.to || '') };
      return { from: '', to: '' };
    }

    /** 空串合法（单边/无范围）；非空必须是 YYYY-MM-DD，且 from ≤ to。 */
    function usageRangeError(range) {
      const from = String((range && range.from) || '');
      const to = String((range && range.to) || '');
      const shape = /^\d{4}-\d{2}-\d{2}$/;
      const validDay = (value) => {
        if (!shape.test(value)) return false;
        const date = new Date(value + 'T00:00:00');
        return !Number.isNaN(date.getTime()) && isoLocalDay(date) === value;
      };
      if (from && !validDay(from)) return '开始日期格式应为 YYYY-MM-DD';
      if (to && !validDay(to)) return '结束日期格式应为 YYYY-MM-DD';
      if (from && to && from > to) return '开始日期不能晚于结束日期';
      return '';
    }

    /** 用量接口查询串：kind/from/to/limit 都可选，参数顺序固定，便于源码契约断言。 */
    function usageQuery(params) {
      const opts = params && typeof params === 'object' ? params : {};
      const list = [];
      if (opts.kind) list.push('kind=' + encodeURIComponent(String(opts.kind)));
      if (opts.from) list.push('from=' + encodeURIComponent(String(opts.from)));
      if (opts.to) list.push('to=' + encodeURIComponent(String(opts.to)));
      if (opts.limit) list.push('limit=' + encodeURIComponent(String(opts.limit)));
      return list.length ? '?' + list.join('&') : '';
    }

    /** 时间按本地时区显示到分钟；账本仍存 ISO UTC，不改数据。 */
    function formatUsageTime(iso) {
      if (!iso) return '—';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return String(iso);
      const p = (n) => String(n).padStart(2, '0');
      return isoLocalDay(date) + ' ' + p(date.getHours()) + ':' + p(date.getMinutes());
    }

    /** 主列表与「其他」分组：分组只影响呈现，不改总账与筛选语义。 */
    function splitUsageJobs(jobs) {
      const main = [];
      const other = [];
      for (const job of Array.isArray(jobs) ? jobs : []) {
        if (job && String(job.kind) === 'other') other.push(job);
        else main.push(job);
      }
      return { main, other };
    }

    function monthStartIso(now) {
      const at = now instanceof Date ? now : new Date();
      const start = new Date(at.getFullYear(), at.getMonth(), 1);
      const p = (n) => String(n).padStart(2, '0');
      return start.getFullYear() + '-' + p(start.getMonth() + 1) + '-' + p(start.getDate());
    }

    /**
     * 书架卡片「⋯」菜单 / 播放器配图提示词面板的关闭规则（FR-21.1 / AC-117 / AC-143）：
     * 点内部或再点触发按钮交给元素自己；点其它任何区域、按 Esc 都关闭。
     * 只关面板、不拦这次点击——点卡片/播放按钮照常响应。
     * `stopEscape` 用于「Esc 先收面板」：拦住这次 Esc，别再退全屏/返回。
     * 返回清理函数，反复开关不堆监听。
     */
    function bindMenuDismiss(doc, options) {
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
        if (opts.stopEscape) {
          if (typeof event.stopPropagation === 'function') event.stopPropagation();
          if (typeof event.preventDefault === 'function') event.preventDefault();
        }
        dismiss('escape');
      };
      doc.addEventListener('click', closeIfOutside, true);
      doc.addEventListener('keydown', closeOnEscape, true);
      return () => {
        doc.removeEventListener('click', closeIfOutside, true);
        doc.removeEventListener('keydown', closeOnEscape, true);
      };
    }

    /**
     * 长按（默认 3s）触发强制动作（AC-145/AC-146）：
     * 按住期间给出进度与剩余秒数，触发后把这次点击吃掉，避免又执行一次普通点击。
     */
    function useLongPress(onLongPress, ms = 3000) {
      const [hold, setHold] = useState({ active: false, progress: 0 });
      const timerRef = useRef(null);
      const tickRef = useRef(null);
      const startedAtRef = useRef(0);
      const firedRef = useRef(false);
      const capturedRef = useRef(false);
      const mountedRef = useRef(true);
      const stop = useCallback(() => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        if (tickRef.current) {
          clearInterval(tickRef.current);
          tickRef.current = null;
        }
      }, []);
      const clear = useCallback(() => {
        stop();
        if (!mountedRef.current) return;
        setHold((prev) => (prev.active || prev.progress ? { active: false, progress: 0 } : prev));
      }, [stop]);
      useEffect(
        () => () => {
          mountedRef.current = false;
          stop();
        },
        [stop],
      );
      const start = useCallback(() => {
        firedRef.current = false;
        stop();
        startedAtRef.current = Date.now();
        setHold({ active: true, progress: 0 });
        tickRef.current = setInterval(() => {
          const progress = Math.min(0.985, (Date.now() - startedAtRef.current) / ms);
          if (mountedRef.current) setHold({ active: true, progress });
        }, 60);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          if (tickRef.current) {
            clearInterval(tickRef.current);
            tickRef.current = null;
          }
          firedRef.current = true;
          if (mountedRef.current) setHold({ active: false, progress: 0 });
          if (typeof onLongPress === 'function') onLongPress();
        }, ms);
      }, [ms, onLongPress, stop]);
      return {
        props: {
          onPointerDown: (event) => {
            if (event && event.button != null && event.button !== 0) return;
            const element = event && event.currentTarget;
            capturedRef.current = false;
            if (element && typeof element.setPointerCapture === 'function' && event.pointerId != null) {
              try {
                element.setPointerCapture(event.pointerId);
                capturedRef.current = true;
              } catch {
                /* 捕获失败不影响计时 */
              }
            }
            start();
          },
          onPointerUp: () => {
            capturedRef.current = false;
            clear();
          },
          onPointerLeave: () => {
            // 指针捕获后指针仍算在按钮上，只有没捕获成功时才按“移出即取消”
            if (!capturedRef.current) clear();
          },
          onPointerCancel: () => {
            capturedRef.current = false;
            clear();
          },
          onLostPointerCapture: () => {
            capturedRef.current = false;
            clear();
          },
          onKeyDown: () => {
            firedRef.current = false;
          },
          onContextMenu: (event) => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault();
          },
        },
        active: hold.active,
        progress: hold.progress,
        secondsLeft: Math.max(1, Math.ceil((1 - hold.progress) * (ms / 1000))),
        wasLongPress: () => {
          const hit = firedRef.current;
          firedRef.current = false;
          return hit;
        },
      };
    }

    /**
     * 统一二次确认（AC-145/146 与删除类操作）：不用浏览器原生 confirm，
     * 改由面板内的 ConfirmHost 居中渲染；返回 Promise<boolean>。
     */
    const confirmStore = { current: null, listeners: new Set() };

    function pushDialog(request) {
      const previous = confirmStore.current;
      if (previous && typeof previous.resolve === 'function') {
        previous.resolve(previous.kind === 'prompt' ? null : false);
      }
      confirmStore.current = request;
      for (const listener of confirmStore.listeners) listener(request);
    }

    function confirmAction(message, options = {}) {
      if (typeof window === 'undefined') return Promise.resolve(true);
      return new Promise((resolve) => {
        pushDialog({
          kind: 'confirm',
          message: String(message || ''),
          title: String(options.title || '请确认'),
          okText: String(options.okText || '继续'),
          cancelText: String(options.cancelText || '取消'),
          danger: options.danger === true,
          resolve: (value) => resolve(value === true),
        });
      });
    }

    /** 插件内输入弹窗：返回输入值；取消返回 null。 */
    function promptAction(message, defaultValue, options = {}) {
      if (typeof window === 'undefined') return Promise.resolve(String(defaultValue || ''));
      return new Promise((resolve) => {
        pushDialog({
          kind: 'prompt',
          message: String(message || ''),
          value: String(defaultValue || ''),
          title: String(options.title || '输入'),
          okText: String(options.okText || '保存'),
          cancelText: String(options.cancelText || '取消'),
          danger: false,
          resolve: (value) => resolve(typeof value === 'string' ? value : null),
        });
      });
    }

    function ConfirmHost() {
      const [request, setRequest] = useState(confirmStore.current);
      const [draft, setDraft] = useState(() => {
        const current = confirmStore.current;
        return current && current.kind === 'prompt' ? String(current.value || '') : '';
      });
      useEffect(() => {
        const listener = (next) => setRequest(next);
        confirmStore.listeners.add(listener);
        if (confirmStore.current) setRequest(confirmStore.current);
        return () => confirmStore.listeners.delete(listener);
      }, []);
      useEffect(() => {
        setDraft(request && request.kind === 'prompt' ? String(request.value || '') : '');
      }, [request]);
      useEffect(() => {
        if (!request) return undefined;
        const onKey = (event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          closeConfirm(request, request.kind === 'prompt' ? null : false);
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
      }, [request]);
      if (!request) return null;
      const prompt = request.kind === 'prompt';
      const cancelValue = prompt ? null : false;
      const confirmValue = prompt ? draft : true;
      return h(
        'div',
        {
          className: 'blm-modal-mask',
          style: { zIndex: 60 },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) closeConfirm(request, cancelValue);
          },
        },
        h(
          'div',
          { className: 'blm-modal blm-confirm', role: 'dialog', 'aria-modal': 'true', 'aria-label': request.title },
          h('strong', { className: 'blm-confirm-title' }, request.title),
          h('p', { className: 'blm-confirm-text' }, request.message),
          prompt
            ? h('input', {
                className: 'blm-input blm-confirm-input',
                value: draft,
                autoFocus: true,
                'aria-label': request.title,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  closeConfirm(request, draft);
                },
              })
            : null,
          h(
            'div',
            { className: 'blm-confirm-actions' },
            h(
              'button',
              { className: 'blm-btn', autoFocus: !prompt, onClick: () => closeConfirm(request, cancelValue) },
              request.cancelText,
            ),
            h(
              'button',
              { className: 'blm-btn primary' + (request.danger ? ' danger' : ''), onClick: () => closeConfirm(request, confirmValue) },
              request.okText,
            ),
          ),
        ),
      );
    }

    function closeConfirm(request, value) {
      if (confirmStore.current === request) confirmStore.current = null;
      for (const listener of confirmStore.listeners) listener(null);
      if (request && typeof request.resolve === 'function') request.resolve(value);
    }

    /** 关闭当前未决确认（取消 = false / null）；主要给测试与异常收口用。 */
    function cancelPendingConfirm() {
      const current = confirmStore.current;
      if (!current) return false;
      closeConfirm(current, current.kind === 'prompt' ? null : false);
      return true;
    }

    /* ------------------------------ 浏览器朗读 ------------------------------ */

    function speechSupported() {
      return typeof window !== 'undefined' && !!window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function';
    }

    function speechVoices() {
      if (!speechSupported()) return [];
      try {
        return window.speechSynthesis.getVoices() || [];
      } catch {
        return [];
      }
    }

    function speakText(text, options) {
      if (!speechSupported()) throw new Error('这个浏览器不支持本机朗读');
      const synth = window.speechSynthesis;
      try {
        synth.cancel();
      } catch {
        /* 首次调用可能抛 */
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

    /* ------------------------------ pdf.js ------------------------------ */

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
        disableAutoFetch: true,
        isEvalSupported: false,
      });
      const doc = await task.promise;
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

    function Card({ book, highlight, onOpen, onRename, onDelete, onContinue, onExport }) {
      const [menu, setMenu] = useState(false);
      const moreRef = useRef(null);
      const menuRef = useRef(null);
      // 改名会重写 cover.svg 并 bump coverUpdatedAt：用它换 URL，卡面上半的封面标题立即刷新。
      const coverVersion = book.coverUpdatedAt || book.lastOpenedAt || '';
      const cover = book.cover ? API + '/cover?bookId=' + encodeURIComponent(book.id) + '&v=' + encodeURIComponent(coverVersion) : '';
      const last = book.lastSeries || null;
      const resume = last && ['ready', 'ready_degraded', 'partial'].includes(String(last.status));

      // 菜单开着时挂全局监听：点外部 / Esc 都能关；只关菜单、不吞这次点击（AC-117）
      useEffect(() => {
        if (!menu) return undefined;
        return bindMenuDismiss(typeof document === 'undefined' ? null : document, {
          menu: menuRef.current,
          toggle: moreRef.current,
          onDismiss: (reason) => {
            setMenu(false);
            if (reason === 'escape' && moreRef.current && typeof moreRef.current.focus === 'function') {
              try {
                moreRef.current.focus();
              } catch {
                /* 焦点被别处抢走不影响菜单已关闭 */
              }
            }
          },
        });
      }, [menu]);

      return h(
        'div',
        {
          className: 'blm-card' + (highlight ? ' blm-card-hit' : ''),
          'data-book-id': book.id,
          tabIndex: 0,
          role: 'button',
          'aria-label': book.title,
          title: book.title,
          onClick: onOpen,
          onKeyDown: (event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onOpen();
          },
        },
        h(
          'div',
          { className: 'blm-cover' },
          cover ? h('img', { src: cover, alt: '' }) : h('span', null, String(book.title || '书').slice(0, 1)),
        ),
        h(
          'div',
          { className: 'blm-card-main' },
          h('div', { className: 'blm-title' }, book.title),
          h(
            'div',
            { className: 'blm-meta' },
            h('span', null, (book.chapters || 0) + ' 章'),
            h('span', null, (book.pages || 0) + ' 页'),
            book.seriesCount ? h('span', null, book.seriesCount + ' 个系列') : null,
            h('span', { className: 'blm-badge' + (book.chaptersBuilt ? ' ok' : '') }, book.chaptersBuilt ? '已分章' : '待分章'),
          ),
          resume
            ? h(
                'button',
                {
                  className: 'blm-btn',
                  style: { marginTop: 6, width: '100%' },
                  title: '继续听《' + last.title + '》',
                  onClick: (event) => {
                    event.stopPropagation();
                    if (onContinue) onContinue(book, last);
                  },
                },
                '继续听',
              )
            : null,
        ),
        h(
          'button',
          {
            ref: moreRef,
            className: 'blm-menu',
            title: '更多',
            'aria-expanded': menu ? 'true' : 'false',
            onClick: (event) => {
              event.stopPropagation();
              setMenu((v) => !v);
            },
          },
          '⋯',
        ),
        menu
          ? h(
              'div',
              {
                ref: menuRef,
                className: 'blm-menu-box',
                onClick: (event) => event.stopPropagation(),
              },
              h('button', { onClick: () => { setMenu(false); onRename(); } }, '重命名'),
              h('button', { onClick: () => { setMenu(false); if (onExport) onExport(book); } }, '导出书档'),
              h('button', { className: 'danger', onClick: () => { setMenu(false); onDelete(); } }, '删除'),
            )
          : null,
      );
    }

    function Trash({ onClose, onChanged, notify }) {
      const [items, setItems] = useState([]);
      const [busy, setBusy] = useState(false);
      const load = useCallback(async () => {
        try {
          const data = await api('/trash');
          setItems(data.books || []);
        } catch (err) {
          notify(err.message);
        }
      }, [notify]);
      useEffect(() => {
        load();
      }, [load]);
      const restore = async (item) => {
        setBusy(true);
        try {
          const data = await api('/trash/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bookId: item.bookId }),
          });
          notify('已恢复《' + data.book.title + '》');
          await load();
          onChanged();
        } catch (err) {
          notify(err.code === 'E_BOOK_EXISTS' ? '书架已有同一本书，请先处理已有书。' : err.message);
        } finally {
          setBusy(false);
        }
      };
      const clear = async () => {
        if (!(await confirmAction('清空回收站？此操作不可撤销。', { title: '清空回收站', okText: '清空', danger: true }))) return;
        setBusy(true);
        try {
          const data = await api('/trash/clear', { method: 'POST' });
          notify('已清空回收站（' + data.count + ' 本）');
          await load();
          onChanged();
        } catch (err) {
          notify(err.message);
        } finally {
          setBusy(false);
        }
      };
      return h(
        'div',
        { className: 'blm-trash' },
        h(
          'div',
          { className: 'blm-bar' },
          h('button', { className: 'blm-btn', onClick: onClose }, '← 返回'),
          h('h1', null, '回收站'),
          h('button', { className: 'blm-btn', disabled: busy || !items.length, onClick: clear }, '清空'),
        ),
        h(
          'div',
          { className: 'blm-trash-list' },
          items.length
            ? items.map((item) =>
                h(
                  'div',
                  { className: 'blm-trash-row', key: item.trashId },
                  h(
                    'div',
                    { className: 'grow' },
                    h('div', { className: 'blm-title' }, item.title),
                    h('div', { className: 'blm-meta' }, (item.pages || 0) + ' 页 · ' + item.bookId),
                  ),
                  h('button', { className: 'blm-btn', disabled: busy, onClick: () => restore(item) }, '恢复'),
                ),
              )
            : h('div', { className: 'blm-empty' }, h('strong', null, '回收站是空的'), h('div', null, '删除的书会在这里保留 7 天。')),
        ),
      );
    }

    /** 原文窗格：用 pdf.js 把 source_pages 渲染成 PDF 视觉版式，锚点段落叠加高亮（AC-123）。 */
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
      const statusUnanchored = String((slide && slide.anchor_status) || '').toLowerCase() === 'unanchored';
      const anchor = !statusUnanchored && slide && slide.source_anchor && Number(slide.source_anchor.page) >= 1 ? slide.source_anchor : null;
      const range = (slide && slide.source_pages) || { from: 1, to: 1 };
      const from = Math.max(1, Math.round(Number(range.from) || 1));
      const to = Math.max(from, Math.round(Number(range.to) || from));
      const chipPage = anchor ? Math.max(1, Math.round(Number(anchor.page) || from)) : from;
      const anchorPage = anchor ? Math.max(1, Math.round(Number(anchor.page) || 0)) : 0;
      const slideKey = slide ? slide.slide_index : 0;
      const quote = slide ? slide.source_quote : '';

      // 窗格宽度决定 canvas 分辨率；百分比高亮不依赖具体像素，拖动分隔条不用重算坐标。
      useEffect(() => {
        const element = rootRef.current;
        if (!element) return undefined;
        let timer = null;
        let last = 0;
        const schedule = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            const next = Math.floor(element.clientWidth - 24);
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

        const job = renderChainRef.current.then(async () => {
          if (generation !== renderGenerationRef.current) return;
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
              const rects = pdfHighlightRects(text.items, quote, page.getViewport({ scale: cssScale }));
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
          if (renderGenerationRef.current === generation) renderGenerationRef.current += 1;
          cancelTasks();
        };
      }, [pdfDoc, width, from, to, slideKey, quote, anchorPage]);

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
        body = h('div', { className: 'blm-dim', style: { padding: '22px 4px' } }, '正在渲染 PDF 原文…');
      } else if (pdfError) {
        body = h('div', { className: 'blm-error' }, 'PDF 原文没打开：' + String((pdfError && pdfError.message) || pdfError));
      } else if (!pdfDoc) {
        body = h('div', { className: 'blm-note' }, 'PDF 原文还没有加载好。');
      } else {
        const pageNos = [];
        for (let pageNo = from; pageNo <= to; pageNo += 1) pageNos.push(pageNo);
        body = h(
          'div',
          { className: 'blm-pdf-pages' },
          renderError ? h('div', { className: 'blm-error' }, '这一页 PDF 渲染失败：' + String((renderError && renderError.message) || renderError)) : null,
          pageNos.map((pageNo) =>
            h(
              'section',
              {
                className: 'blm-pdf-page',
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
                { className: 'blm-pdf-hl-layer' },
                (highlights[pageNo] || []).map((rect, index) =>
                  h('i', {
                    key: index,
                    className: 'blm-pdf-hl',
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
              h('div', { className: 'blm-pdf-page-no' }, '第 ' + pageNo + ' 页'),
            ),
          ),
        );
      }

      return h(
        'div',
        { className: 'blm-pane-source', ref: rootRef },
        h(
          'div',
          { className: 'blm-source-top' },
          h(
            'div',
            { className: 'blm-source-sticky' },
            h('span', { className: 'blm-chip ok' }, '第 ' + chipPage + ' 页'),
            h('span', { className: 'blm-dim' }, from === to ? '原文第 ' + from + ' 页' : '原文第 ' + from + '–' + to + ' 页'),
            h('div', { style: { flex: 1 } }),
            h(
              'a',
              {
                className: 'blm-btn',
                href: FILE_API + '?bookId=' + encodeURIComponent(bookId || '') + '#page=' + chipPage,
                target: '_blank',
                rel: 'noreferrer',
              },
              '打开原始 PDF',
            ),
          ),
          !anchor ? h('div', { className: 'blm-source-banner' }, '本页未定位到原句，显示整页 PDF') : null,
          highlightMiss ? h('div', { className: 'blm-source-banner' }, '本页原句没能在 PDF 页面上定位，显示整页') : null,
        ),
        body,
      );
    }

    /**
     * 配图位：默认显示占位，点一下（或 Enter/空格）展开 image_prompt，
     * 再点「收起」/点面板外/按 Esc 回占位（AC-143）；有复制按钮。
     * 有图时右下角给「换一张」/「重试配图」（AC-147）。
     */
    function StageFigure({ prompt, src, open, copied, onToggle, onCopy, rootRef, tools }) {
      const text = String(prompt || '');
      const hasImage = Boolean(src && !open);
      const panel = h(
        'div',
        { className: 'blm-stage-figure-prompt', onClick: (event) => event.stopPropagation() },
        h('div', { className: 'blm-stage-figure-prompt-text' }, text || '（没有配图提示词）'),
        h(
          'div',
          { className: 'blm-stage-figure-prompt-actions' },
          text ? h('button', { className: 'blm-btn', onClick: onCopy }, copied ? '已复制' : '复制提示词') : null,
          h('button', { className: 'blm-btn', onClick: onToggle }, '收起'),
        ),
      );
      return h(
        'div',
        {
          ref: rootRef,
          className: 'blm-stage-figure' + (open ? ' prompt-open' : '') + (hasImage ? ' has-img' : ''),
          role: 'button',
          tabIndex: 0,
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': open ? '收起配图提示词' : hasImage ? '查看配图提示词' : '查看配图提示词',
          title: open ? '点击收起' : hasImage ? '点击查看配图提示词' : '点击查看配图提示词',
          onClick: onToggle,
          onKeyDown: (event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onToggle();
            }
          },
        },
        open
          ? panel
          : hasImage
            ? h('img', { className: 'blm-stage-figure-img', src, alt: '配图' })
            : h(
                React.Fragment,
                null,
                h('b', null, '配图位'),
                h('span', null, text ? '点击查看提示词' : '本页无配图'),
              ),
        !open && tools ? h('div', { className: 'blm-stage-figure-tools' }, tools) : null,
      );
    }

    /** 幻灯片舞台：沿用 1.x 的米色底 / 宋体标题 / 要点 / 引文 / 右下页码。 */
    function SlideStage({ slide, seriesId, lecture, onRegenImage, onCancelImage, imageBusy, imageLocked }) {
      const slideKey = slide ? Number(slide.slide_index) || 0 : 0;
      const [showPrompt, setShowPrompt] = useState(false);
      const [copied, setCopied] = useState(false);
      const figureRef = useRef(null);
      // 翻页后提示词要收起来，否则会把上一页的展开状态带到下一页
      useEffect(() => {
        setShowPrompt(false);
        setCopied(false);
      }, [slideKey]);
      // AC-143：点面板外任意区域 / 按 Esc 收起；Esc 只收面板，不再退全屏/返回
      useEffect(() => {
        if (!showPrompt) return undefined;
        return bindMenuDismiss(typeof document === 'undefined' ? null : document, {
          menu: figureRef.current,
          onDismiss: () => setShowPrompt(false),
          stopEscape: true,
        });
      }, [showPrompt]);
      if (!slide) return null;
      const layout = String(slide.layout || 'content_text');
      // 只要还有 image_file 就显示：失败重绘会保留旧图，不能因为状态是 failed 就白屏
      const imageSrc =
        slide.image_file && seriesId
          ? API + '/image?seriesId=' + encodeURIComponent(seriesId) + '&lecture=' + encodeURIComponent(lecture) + '&i=' + encodeURIComponent(slide.slide_index) + '&v=' + encodeURIComponent(slide.image_seed || '')
          : '';
      const foot = h('div', { className: 'blm-stage-foot' }, '第 ' + slide.slide_index + ' 页');
      const copyPrompt = (event) => {
        if (event && event.stopPropagation) event.stopPropagation();
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
      const regenButton = (label) =>
        h(
          'button',
          {
            className: 'blm-btn',
            disabled: imageBusy === true || imageLocked === true,
            title:
              imageBusy === true
                ? '正在重绘，完成后自动换图'
                : imageLocked === true
                  ? '另一页正在换图，请稍候'
                  : undefined,
            onClick: (event) => {
              if (event && event.stopPropagation) event.stopPropagation();
              if (typeof onRegenImage === 'function') onRegenImage(slide);
            },
          },
          label,
        );
      const cancelButton = h(
        'button',
        {
          className: 'blm-btn',
          onClick: (event) => {
            if (event && event.stopPropagation) event.stopPropagation();
            if (typeof onCancelImage === 'function') onCancelImage();
          },
        },
        '取消换图',
      );
      const figureTools = !onRegenImage
        ? null
        : imageBusy === true || imageLocked === true
          ? h(
              React.Fragment,
              null,
              regenButton(imageBusy === true ? '生成中…' : '换一张'),
              onCancelImage ? cancelButton : null,
            )
          : slide.image_status === 'failed'
            ? regenButton('重试配图')
            : slide.image_file
              ? regenButton('换一张')
              : null;
      if (layout === 'cover') {
        return h(
          'div',
          { className: 'blm-stage-wrap' },
          h(
            'div',
            { className: 'blm-stage' },
            h('div', { className: 'blm-stage-kicker' }, '精讲'),
            h('div', { className: 'blm-stage-title' }, slide.title || ''),
            slide.subtitle ? h('div', { className: 'blm-stage-sub' }, slide.subtitle) : null,
            h('div', { className: 'blm-stage-rule' }),
            foot,
          ),
        );
      }
      if (layout === 'quote') {
        return h(
          'div',
          { className: 'blm-stage-wrap' },
          h(
            'div',
            { className: 'blm-stage' },
            h('div', { className: 'blm-stage-kicker' }, '原文摘引'),
            h(
              'div',
              { className: 'blm-stage-quote' },
              h('blockquote', null, slide.quote_text || ''),
              h('cite', null, '—— ' + (slide.quote_source || '出处未知')),
            ),
            foot,
          ),
        );
      }
      return h(
        'div',
        { className: 'blm-stage-wrap' },
        h(
          'div',
          { className: 'blm-stage' },
          h('div', { className: 'blm-stage-title' }, slide.title || ''),
          h(
            'div',
            { className: 'blm-stage-body' },
            h(
              'div',
              { className: 'blm-stage-copy' },
              h(
                'ul',
                { className: 'blm-stage-bullets' },
                (Array.isArray(slide.bullet_points) ? slide.bullet_points : []).map((bullet, index) =>
                  h('li', { key: index }, bullet),
                ),
              ),
            ),
            h(StageFigure, {
              prompt: slide.image_prompt,
              src: imageSrc,
              open: showPrompt,
              copied: copied,
              onToggle: () => setShowPrompt((value) => !value),
              onCopy: copyPrompt,
              rootRef: figureRef,
              tools: figureTools,
            }),
          ),
          foot,
        ),
      );
    }

    /** 字幕正文只取 audio_script；subtitle 是封面副标题，不能混用（FR-18.1）。 */
    function subtitleText(slide) {
      return String((slide && slide.audio_script) || '');
    }

    /**
     * 播放页字幕：当前页 audio_script 的只读原文，贴在舞台卡下方。
     * 页级静态，不跟音频进度；空稿不渲染（FR-18.1 / AC-167、AC-168）。
     */
    function SubtitlePane({ text }) {
      const value = String(text || '');
      if (!value.trim()) return null;
      return h('div', { className: 'blm-subtitle', role: 'region', 'aria-label': '字幕' }, value);
    }

    /** 底部逐页缩略图：16:9 迷你版式（AC-142），不是纯文字页码条。 */
    function SlideThumb({ slide, index, active, onClick }) {
      const layout = String((slide && slide.layout) || 'content_text');
      const title = (slide && slide.title) || '';
      const bullets = (slide && Array.isArray(slide.bullet_points)) ? slide.bullet_points : [];
      const body =
        layout === 'cover'
          ? h(
              React.Fragment,
              null,
              h('span', { className: 'blm-thumb-kicker' }, '精讲'),
              h('span', { className: 'blm-thumb-title' }, title),
              slide && slide.subtitle ? h('span', { className: 'blm-thumb-sub' }, slide.subtitle) : null,
            )
          : layout === 'quote'
            ? h('span', { className: 'blm-thumb-quote-text' }, (slide && slide.quote_text) || title)
            : h(
                React.Fragment,
                null,
                h('span', { className: 'blm-thumb-title' }, title),
                h(
                  'span',
                  { className: 'blm-thumb-lines', 'aria-hidden': 'true' },
                  bullets.slice(0, 3).map((bullet, i) => h('span', { className: 'blm-thumb-line', key: i })),
                ),
              );
      return h(
        'button',
        {
          type: 'button',
          className: 'blm-thumb blm-thumb-' + layout + (active ? ' on' : ''),
          title,
          'aria-label': '跳到第 ' + (index + 1) + ' 页',
          'aria-current': active ? 'page' : undefined,
          onClick,
        },
        h('span', { className: 'blm-thumb-no' }, index + 1),
        body,
      );
    }

    /** 系列目录抽屉：列出 N 讲（标题、章、页数、已听），点击跳讲。 */
    function SeriesDirectory({ series, current, progress, onPick, onClose }) {
      const lectures = ((series && series.lectures) || []).slice().sort((a, b) => Number(a.n) - Number(b.n));
      const heard = (progress && progress.heard) || {};
      return h(
        'div',
        { className: 'blm-drawer-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h(
          'aside',
          { className: 'blm-drawer', role: 'dialog', 'aria-label': '系列目录' },
          h(
            'div',
            { className: 'blm-drawer-head' },
            h('strong', null, '系列目录'),
            h('span', { className: 'blm-dim' }, lectures.length + ' 讲'),
            h('div', { style: { flex: 1 } }),
            h('button', { className: 'blm-btn', onClick: onClose }, '关闭'),
          ),
          h(
            'div',
            { className: 'blm-drawer-body' },
            lectures.map((item) => {
              const ready = READY_LECTURE.includes(String(item.status));
              const pages = Number(item.actual_pages) || Number(item.pages) || 0;
              const done = Math.max(0, Math.min(pages, Number(heard[item.n]) || 0));
              return h(
                'button',
                {
                  key: item.n,
                  className: 'blm-drawer-item' + (Number(item.n) === Number(current) ? ' on' : ''),
                  disabled: !ready,
                  onClick: () => onPick(Number(item.n)),
                  title: ready ? item.title : '这一讲还没就绪',
                },
                h('b', null, '第 ' + item.n + ' 讲'),
                h('span', { className: 'grow' }, item.title || ''),
                h('span', { className: 'blm-dim' }, pages + ' 页 · 已听 ' + done),
                ready ? null : h('span', { className: 'blm-badge' }, String(item.status || '未就绪')),
              );
            }),
          ),
        ),
      );
    }

    /** 讲间过渡卡（FR-18 / AC-107）：5 秒后进下一讲，点击或空格可跳过。 */
    function TransitionCard({ next, seconds, onSkip }) {
      if (!next) return null;
      return h(
        'div',
        { className: 'blm-transition', role: 'dialog', 'aria-label': '下一讲' },
        h('div', { className: 'blm-chip' }, '第 ' + next.n + ' 讲'),
        h('h2', null, next.title || '下一讲'),
        h('div', { className: 'count' }, seconds + ' 秒后自动进入 · 点击或按空格跳过'),
        h('button', { className: 'blm-btn primary', onClick: onSkip }, '立即进入'),
      );
    }

    /**
     * 系列播放器（M4）：左 PDF 原文 / 右幻灯片，键盘、连播、系列目录、进度与偏好。
     * 音频优先级：audio_file > 浏览器朗读 > 无配音（Qwen 失败不回退浏览器）。
     */
    function Player({ bookId, seriesId, initialLecture, initialSlide, onBack, notify }) {
      const [series, setSeries] = useState(null);
      const [loading, setLoading] = useState(true);
      const [loadError, setLoadError] = useState(null);
      const [lectureN, setLectureN] = useState(Math.max(1, Number(initialLecture) || 1));
      const [slidesByLecture, setSlidesByLecture] = useState({});
      const [index, setIndex] = useState(0);
      const [playing, setPlaying] = useState(false);
      const [progress, setProgress] = useState(null);
      const [pref, setPref] = useState({ split: 0.55, rate: 1, muted: false });
      // FR-18.2：split 记原文窗格占比（与方向无关）；layout 决定两栏左右顺序。
      const [split, setSplit] = useState(0.55);
      const [layout, setLayout] = useState('ppt-left');
      const [dragging, setDragging] = useState(false);
      const [status, setStatus] = useState('点「开始听」从这一页开始朗读');
      const [noAudio, setNoAudio] = useState(false);
      const [bar, setBar] = useState(0);
      const [clock, setClock] = useState({ positionMs: 0, durationMs: 0 });
      const [pdfDoc, setPdfDoc] = useState(null);
      const [pdfLoading, setPdfLoading] = useState(true);
      const [pdfError, setPdfError] = useState(null);
      const [fullscreen, setFullscreen] = useState(false);
      const [directory, setDirectory] = useState(false);
      const [transition, setTransition] = useState(null);
      // C：换图期间的临时覆盖层，按 series:lecture:slide 存；不进入播放数据源
      const [imageOverrides, setImageOverrides] = useState({});
      const [imageBusyKey, setImageBusyKey] = useState('');
      const [seriesImageJob, setSeriesImageJob] = useState(null);
      const [voiceNoticeClosed, setVoiceNoticeClosed] = useState(false);
      const SERIES_IMAGE_ACTIVE = ['queued', 'running', 'cancelling'];
      const seriesImageActive = seriesImageJob != null &&
        SERIES_IMAGE_ACTIVE.includes(String(seriesImageJob.status || '')) &&
        !imageBusyKey;

      const rootRef = useRef(null);
      const mainRef = useRef(null);
      const aliveRef = useRef(true);
      const lastRefreshRef = useRef(0);
      const audioRef = useRef(null);
      const preloadRef = useRef(null);
      const skipTimerRef = useRef(null);
      const tickTimerRef = useRef(null);
      const tokenRef = useRef(0);
      const positionRef = useRef(0);
      const audioMetaRef = useRef(null);
      const resumeRef = useRef(null);
      const pendingRestoreRef = useRef(false);
      const lastPersistRef = useRef(0);
      const firstPlayEffectRef = useRef(true);
      const speechSeqRef = useRef(0);
      const imageBusyRef = useRef('');
      const indexRef = useRef(index);
      const playingRef = useRef(playing);
      const prefRef = useRef(pref);
      const splitRef = useRef(split);
      const layoutRef = useRef(layout);
      const lectureRef = useRef(lectureN);
      const slidesRef = useRef([]);
      const seriesRef = useRef(null);
      const startRef = useRef({ lecture: Math.max(1, Number(initialLecture) || 1), slide: Number(initialSlide) || 0, offsetMs: 0, used: false });
      const actionsRef = useRef({});
      const thumbsRef = useRef(null);
      const thumbYieldRef = useRef(0);
      const thumbScrollTimerRef = useRef(null);
      const indexSourceRef = useRef('user');
      indexRef.current = index;
      playingRef.current = playing;
      prefRef.current = pref;
      splitRef.current = split;
      layoutRef.current = layout;
      lectureRef.current = lectureN;
      seriesRef.current = series;

      const slides = slidesByLecture[lectureN] || [];
      slidesRef.current = slides;
      const rawSlide = slides[index] || null;
      const imageKey = rawSlide ? seriesId + ':' + lectureN + ':' + Number(rawSlide.slide_index || 0) : '';
      const slide = slideWithImageOverride(rawSlide, imageKey ? imageOverrides[imageKey] : null);
      // 只有音频字段变化才需要重建播放；配图/种子变化不参与
      const pageAudioKey = playbackKey(rawSlide);
      const lectures = (series && series.lectures) || [];
      const single = lectures.length <= 1;

      /* 首屏：系列 + 进度 + 偏好 */
      useEffect(() => {
        let alive = true;
        setLoading(true);
        Promise.all([
          api('/series?seriesId=' + encodeURIComponent(seriesId)),
          api('/series/progress?seriesId=' + encodeURIComponent(seriesId)).catch(() => null),
          api('/preference').catch(() => null),
          api('/series/view?seriesId=' + encodeURIComponent(seriesId)).catch(() => null),
        ])
          .then(([seriesOut, progressOut, prefOut, viewOut]) => {
            if (!alive) return;
            const nextSeries = seriesOut.series;
            setSeries(nextSeries);
            const nextProgress = (progressOut && progressOut.progress) || null;
            setProgress(nextProgress);
            const nextPref = (prefOut && prefOut.preference) || {};
            // 布局按系列：view.json 缺失时服务端已把 preference.split 作为初始宽度返回。
            const seedSplit = clampSplitValue(nextPref.split);
            const nextView = (viewOut && viewOut.view) || {};
            const viewSplit =
              nextView.split === undefined || nextView.split === null ? seedSplit : nextView.split;
            setPref({ split: seedSplit, rate: clampRateValue(nextPref.rate), muted: nextPref.muted === true });
            setLayout(clampLayout(nextView.layout));
            setSplit(clampSplitValue(viewSplit));
            const lectureList = (nextSeries.lectures || []).map((item) => Number(item.n));
            const wantedLecture = Number(initialLecture) || (nextProgress && nextProgress.lecture) || lectureList[0] || 1;
            const resolvedLecture = lectureList.includes(Number(wantedLecture)) ? Number(wantedLecture) : lectureList[0] || 1;
            const explicitSlide = Number(initialSlide) || 0;
            const useSavedPosition = !explicitSlide && !!nextProgress && Number(nextProgress.lecture) === resolvedLecture;
            startRef.current = {
              lecture: resolvedLecture,
              slide: explicitSlide || (useSavedPosition ? nextProgress.slide : 0) || 0,
              offsetMs: useSavedPosition ? normalizeOffsetMs(nextProgress.offsetMs) : 0,
              audioFile: useSavedPosition ? String(nextProgress.audioFile || '') : '',
              audioMs: useSavedPosition ? Math.max(0, Math.round(Number(nextProgress.audioMs) || 0)) : 0,
              audioProvider: useSavedPosition ? String(nextProgress.audioProvider || '') : '',
              used: false,
            };
            setLectureN(resolvedLecture);
          })
          .catch((err) => {
            if (alive) setLoadError(err);
          })
          .finally(() => {
            if (alive) setLoading(false);
          });
        return () => {
          alive = false;
        };
      }, [seriesId, initialLecture, initialSlide]);

      /* 重新打开播放器时，系列配图作业可能还在跑：给出进度与取消入口。 */
      useEffect(() => {
        let alive = true;
        api('/image/status?seriesId=' + encodeURIComponent(seriesId))
          .then((out) => {
            if (!alive) return;
            if (out && SERIES_IMAGE_ACTIVE.includes(String(out.status || ''))) setSeriesImageJob(out);
          })
          .catch(() => {});
        return () => {
          alive = false;
        };
      }, [seriesId]);

      useEffect(() => {
        if (!seriesImageActive) return undefined;
        let alive = true;
        const timer = setInterval(async () => {
          try {
            const out = await api('/image/status?seriesId=' + encodeURIComponent(seriesId));
            if (!alive) return;
            if (out && SERIES_IMAGE_ACTIVE.includes(String(out.status || ''))) setSeriesImageJob(out);
            else setSeriesImageJob(null);
          } catch {
            /* 状态接口失败不打断播放 */
          }
        }, 1500);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [seriesImageActive, seriesId]);

      /* 打开整本 PDF；页面渲染由 SourcePane 按 source_pages 做 */
      useEffect(() => {
        let alive = true;
        let handle = null;
        setPdfLoading(true);
        setPdfError(null);
        setPdfDoc(null);
        openPdfDocument(bookId)
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
      }, [bookId]);

      /* 取某讲幻灯片；同一讲只取一次 */
      useEffect(() => {
        if (!series || slidesByLecture[lectureN]) return undefined;
        let alive = true;
        api('/lecture?seriesId=' + encodeURIComponent(seriesId) + '&n=' + lectureN)
          .then((out) => {
            if (!alive) return;
            const list = (out.slides && out.slides.slides) || [];
            setSlidesByLecture((prev) => Object.assign({}, prev, { [lectureN]: list }));
          })
          .catch((err) => {
            if (!alive) return;
            setStatus('第 ' + lectureN + ' 讲取不到内容：' + String(err.message || err));
            setNoAudio(false);
          });
        return () => {
          alive = false;
        };
      }, [series, seriesId, lectureN, slidesByLecture]);

      /**
       * 音频即将被重建时，用媒体元素的真实 currentTime 记位置。
       * positionRef 只在 timeupdate 时更新（约 250ms 一次），拿它当恢复点会回退重播。
       */
      const rememberPlaybackPosition = useCallback(() => {
        const audio = audioRef.current;
        const meta = audioMetaRef.current;
        if (!audio || !meta) return;
        const ms = Math.round(Number(audio.currentTime) * 1000);
        if (!Number.isFinite(ms) || ms <= 0) return;
        resumeRef.current = {
          lecture: meta.lecture,
          slide: meta.slide,
          offsetMs: ms,
          audioKey: meta.audioKey,
          used: false,
        };
      }, []);

      /**
       * 外部改了数据（注入降级态 / 手工编辑）后，回到窗口时刷新当前讲与系列。
       * 先拉后换：不预先清空当前讲缓存——清空会让建源 effect 把正在播的音频
       * 销毁重建，切回窗口时就是「断一下 + 回退重播几个字」。
       * 只有真正影响播放（页数 / 当前页音频签名）时才重建，并用 currentTime 续上。
       */
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
        const refresh = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          // focus 与 visibilitychange 常结伴触发（最小化恢复）：去抖后只刷一次
          const now = Date.now();
          if (now - lastRefreshRef.current < REFRESH_DEBOUNCE_MS) return;
          lastRefreshRef.current = now;
          const lecture = lectureRef.current;
          api('/lecture?seriesId=' + encodeURIComponent(seriesId) + '&n=' + lecture)
            .then((out) => {
              if (!aliveRef.current || Number(lectureRef.current) !== Number(lecture)) return;
              const list = (out.slides && out.slides.slides) || [];
              const plan = refreshDecision(slidesRef.current, list, indexRef.current);
              if (!plan.changed) return;
              if (plan.rebuild) rememberPlaybackPosition();
              setSlidesByLecture((prev) => Object.assign({}, prev, { [lecture]: list }));
              if (list.length && indexRef.current >= list.length) setIndex(list.length - 1);
            })
            .catch(() => {});
          api('/series?seriesId=' + encodeURIComponent(seriesId))
            .then((out) => {
              if (aliveRef.current && out && out.series) setSeries(out.series);
            })
            .catch(() => {});
        };
        window.addEventListener('focus', refresh);
        const hasDocEvents = typeof document !== 'undefined' && typeof document.addEventListener === 'function';
        if (hasDocEvents) document.addEventListener('visibilitychange', refresh);
        return () => {
          window.removeEventListener('focus', refresh);
          if (hasDocEvents) document.removeEventListener('visibilitychange', refresh);
        };
      }, [seriesId, lectureN, rememberPlaybackPosition]);

      /* 换讲/首次加载后决定起始页（同一讲内更新图片不重置页码） */
      const startLectureRef = useRef(0);
      useEffect(() => {
        if (!slides.length) return;
        if (startLectureRef.current === lectureN) return;
        startLectureRef.current = lectureN;
        const start = startRef.current;
        if (!start.used && Number(start.lecture) === Number(lectureN)) {
          const nextIndex = resolveInitialSlide(slides, start.slide);
          const target = slides[nextIndex];
          if (start.offsetMs > 0 && target) {
            const savedFile = String(start.audioFile || '');
            const savedMs = Math.max(0, Math.round(Number(start.audioMs) || 0));
            const savedProvider = String(start.audioProvider || '');
            const hasIdentity = !!(savedFile || savedMs || savedProvider);
            const sameAudio =
              !hasIdentity ||
              (savedFile === String(target.audio_file || '') &&
                savedMs === Math.max(0, Math.round(Number(target.audio_ms) || 0)) &&
                savedProvider === String(target.audio_provider || ''));
            if (sameAudio) {
              resumeRef.current = {
                lecture: lectureN,
                slide: Number(target.slide_index),
                offsetMs: start.offsetMs,
                audioKey: playbackKey(target),
                used: false,
              };
              positionRef.current = start.offsetMs;
              pendingRestoreRef.current = true;
              setClock({ positionMs: start.offsetMs, durationMs: 0 });
            } else {
              start.offsetMs = 0;
              setStatus('配音已更新，从本页开头播放');
            }
          }
          start.used = true;
          setIndex(nextIndex);
          return;
        }
        setIndex(0);
      }, [slides, lectureN]);

      const savePreference = useCallback((patch) => {
        setPref((prev) => Object.assign({}, prev, patch));
        api('/preference', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        }).catch(() => {});
      }, []);

      /** FR-18.2：布局按系列落到 series/<id>/view.json；失败不打断播放。 */
      const saveSeriesView = useCallback(
        (patch) => {
          // 每次带上完整布局，避免「拖完立刻换位」时两次写入按磁盘旧值互相覆盖。
          const body = Object.assign(
            { seriesId, layout: layoutRef.current, split: splitRef.current },
            patch || {},
          );
          api('/series/view', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }).catch(() => {});
        },
        [seriesId],
      );

      const stopAudio = useCallback(() => {
        tokenRef.current += 1;
        speechSeqRef.current += 1;
        pendingRestoreRef.current = false;
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
          audioMetaRef.current = null;
          try {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
          } catch {
            /* 已经停了 */
          }
        }
        stopSpeech();
      }, []);

      const clearTick = useCallback(() => {
        if (tickTimerRef.current) {
          clearInterval(tickTimerRef.current);
          tickTimerRef.current = null;
        }
      }, []);

      /** 进度写入：普通写入读响应；离开/隐藏用 beacon，避免卸载把请求掐断。 */
      const postProgress = useCallback((payload, options = {}) => {
        const url = API + '/series/progress';
        const body = JSON.stringify(payload);
        const beacon = options.beacon === true;
        try {
          if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' && typeof Blob === 'function') {
            if (navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
          }
        } catch {
          /* 回退到 fetch */
        }
        try {
          fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            keepalive: beacon,
          }).catch(() => {});
        } catch {
          /* 浏览器不支持 keepalive 时放弃这次写入，不阻塞播放 */
        }
      }, []);

      /** 保存当前页的页内位置；只有文件音频有媒体时间。 */
      const savePosition = useCallback(
        (offsetMs, options = {}) => {
          const meta = audioMetaRef.current;
          if (!meta || meta.mode !== 'file') return;
          postProgress(
            {
              seriesId,
              lecture: meta.lecture,
              slide: meta.slide,
              offsetMs: normalizeOffsetMs(offsetMs),
              audioFile: meta.audioFile,
              audioMs: meta.audioMs,
              audioProvider: meta.audioProvider,
            },
            options,
          );
        },
        [postProgress, seriesId],
      );

      /** 显式翻页/换讲：新页从 0 开始，并更新「系列已听页数」。 */
      const savePageStart = useCallback(
        (lecture, slide) => {
          api('/series/progress', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ seriesId, lecture, slide, offsetMs: 0 }),
          })
            .then((out) => {
              if (!aliveRef.current) return;
              if (out && out.progress) setProgress(out.progress);
            })
            .catch(() => {});
        },
        [seriesId],
      );

      /* 预加载下一页音频 */
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
            const audio = new Audio(AUDIO_API + '?seriesId=' + encodeURIComponent(seriesId) + '&lecture=' + lectureN + '&i=' + (index + 2));
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
      }, [index, seriesId, lectureN, slides]);

      const startLecture = useCallback((n, { autoplay = false } = {}) => {
        stopAudio();
        const nextN = Number(n);
        resumeRef.current = null;
        pendingRestoreRef.current = false;
        positionRef.current = 0;
        lastPersistRef.current = 0;
        setTransition(null);
        setLectureN(nextN);
        setBar(0);
        setClock({ positionMs: 0, durationMs: 0 });
        setPlaying(autoplay);
        setStatus(autoplay ? '正在继续下一讲…' : '点「开始听」从这一页开始朗读');
        savePageStart(nextN, 1);
      }, [savePageStart, stopAudio]);

      /** 讲末页之后：就绪则过渡卡，未就绪则提示（不循环），最后一讲则收尾。 */
      const finishLecture = useCallback(() => {
        const next = nextLectureAfter(seriesRef.current, lectureRef.current);
        if (next.kind === 'transition') {
          if (next.skipped && next.skipped.length) {
            setStatus('第 ' + next.skipped.join('、') + ' 讲未就绪，已跳到第 ' + next.n + ' 讲');
          }
          setTransition({ n: next.n, title: next.title, count: 5 });
          return;
        }
        setPlaying(false);
        if (next.kind === 'blocked') {
          setStatus('第 ' + (next.skipped && next.skipped.length ? next.skipped.join('、') : next.n) + ' 讲未就绪，连播已停在这里');
          return;
        }
        setStatus('已经读完整个系列');
      }, []);

      const advance = useCallback(() => {
        if (indexRef.current + 1 < slidesRef.current.length) {
          const next = indexRef.current + 1;
          stopAudio();
          indexSourceRef.current = 'playback';
          resumeRef.current = null;
          pendingRestoreRef.current = false;
          positionRef.current = 0;
          lastPersistRef.current = 0;
          setBar(0);
          setClock({ positionMs: 0, durationMs: 0 });
          setStatus('正在播放第 ' + (next + 1) + ' 页');
          setIndex(next);
          savePageStart(lectureRef.current, next + 1);
          return;
        }
        finishLecture();
      }, [finishLecture, savePageStart, stopAudio]);

      /* 过渡卡：5 秒后自动进下一讲；点击/空格可跳过 */
      useEffect(() => {
        if (!transition) return undefined;
        if (transition.count <= 0) {
          startLecture(transition.n, { autoplay: true });
          return undefined;
        }
        const timer = setTimeout(() => {
          setTransition((prev) => (prev ? Object.assign({}, prev, { count: prev.count - 1 }) : prev));
        }, 1000);
        return () => clearTimeout(timer);
      }, [transition, startLecture]);

      const scheduleSkip = useCallback(() => {
        if (skipTimerRef.current) return;
        skipTimerRef.current = setTimeout(() => {
          skipTimerRef.current = null;
          advance();
        }, 1100);
      }, [advance]);

      const startSpeechFor = useCallback(
        (currentSlide, token) => {
          clearTick();
          const seq = (speechSeqRef.current += 1);
          const estimate = Math.max(
            1200,
            Number(currentSlide.audio_ms) || String(currentSlide.audio_script || '').length * 240,
          );
          const startedAt = Date.now();
          tickTimerRef.current = setInterval(() => {
            if (token !== tokenRef.current || seq !== speechSeqRef.current) return;
            const elapsed = Date.now() - startedAt;
            setBar(Math.min(0.98, elapsed / estimate));
            setClock({ positionMs: Math.min(estimate, elapsed), durationMs: estimate });
          }, 250);
          try {
            speakText(currentSlide.audio_script, {
              rate: prefRef.current.rate,
              volume: prefRef.current.muted ? 0 : 1,
              onend: () => {
                if (token !== tokenRef.current || seq !== speechSeqRef.current) return;
                clearTick();
                advance();
              },
              onerror: () => {
                if (token !== tokenRef.current || seq !== speechSeqRef.current) return;
                setNoAudio(true);
                setStatus('本页朗读失败');
                clearTick();
                if (indexRef.current + 1 < slidesRef.current.length) scheduleSkip();
                else finishLecture();
              },
            });
            setStatus('正在播放第 ' + (indexRef.current + 1) + ' 页');
          } catch (err) {
            clearTick();
            setNoAudio(true);
            setStatus('本页朗读失败：' + String((err && err.message) || err));
          }
        },
        [advance, clearTick, finishLecture, scheduleSkip],
      );

      /* 页面隐藏/关闭时把当前位置留在服务端（keepalive，不阻塞退出）。 */
      useEffect(() => {
        if (typeof window === 'undefined') return undefined;
        const save = () => {
          if (positionRef.current > 0) savePosition(positionRef.current, { beacon: true });
        };
        window.addEventListener('pagehide', save);
        const doc = typeof document !== 'undefined' ? document : null;
        const onVisibility = () => {
          if (doc && doc.visibilityState === 'hidden') save();
        };
        if (doc) doc.addEventListener('visibilitychange', onVisibility);
        return () => {
          window.removeEventListener('pagehide', save);
          if (doc) doc.removeEventListener('visibilitychange', onVisibility);
        };
      }, [savePosition]);

      /* 卸载时先保存再停声；声明在“建源” effect 之前，cleanup 先跑。 */
      useEffect(
        () => () => {
          if (positionRef.current > 0) savePosition(positionRef.current, { beacon: true });
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
        [savePosition, stopAudio],
      );

      /* 建立当前页音频；播放/暂停由独立 effect 管，暂停不重建。 */
      useEffect(() => {
        stopAudio();
        const current = indexRef.current;
        const currentSlide = slidesRef.current[current];
        if (!currentSlide) return undefined;
        const token = tokenRef.current;
        const mode = slideAudioMode(currentSlide);
        const audioKey = playbackKey(currentSlide);
        const pending = resumeRef.current;
        const decision = resolvePendingResume({
          pending,
          currentSlide,
          lecture: lectureRef.current,
          slides: slidesRef.current,
          audioKey,
        });
        const restoreMs = decision.restoreMs;
        const keyChanged = decision.keyChanged;
        if (decision.clear) resumeRef.current = null;

        pendingRestoreRef.current = restoreMs > 0;
        positionRef.current = restoreMs;
        lastPersistRef.current = Date.now();
        setBar(0);
        setClock({ positionMs: restoreMs, durationMs: 0 });
        setNoAudio(false);
        if (keyChanged) setStatus('配音已更新，从本页开头播放');
        if (restoreMs > 0) {
          setStatus(
            playingRef.current
              ? '正在从 ' + formatClock(restoreMs) + ' 继续'
              : '上次听到 ' + formatClock(restoreMs) + '，点「继续听」接着听',
          );
        }

        if (mode === 'none') {
          resumeRef.current = null;
          pendingRestoreRef.current = false;
          positionRef.current = 0;
          setBar(0);
          setClock({ positionMs: 0, durationMs: 0 });
          setNoAudio(true);
          const hasNext = current + 1 < slidesRef.current.length;
          setStatus('本页未配音' + (hasNext ? '，即将跳过' : ''));
          if (playingRef.current) {
            if (hasNext) scheduleSkip();
            else finishLecture();
          }
          return () => stopAudio();
        }

        if (mode === 'speech') {
          resumeRef.current = null;
          pendingRestoreRef.current = false;
          positionRef.current = 0;
          const estimate = Math.max(
            1200,
            Number(currentSlide.audio_ms) || String(currentSlide.audio_script || '').length * 240,
          );
          setClock({ positionMs: 0, durationMs: estimate });
          if (playingRef.current) {
            startSpeechFor(currentSlide, token);
          } else {
            setStatus('点「开始听」从这一页开始朗读');
          }
          return () => stopAudio();
        }

        const audio = new Audio(
          AUDIO_API + '?seriesId=' + encodeURIComponent(seriesId) + '&lecture=' + lectureRef.current + '&i=' + (current + 1),
        );
        audio.preload = 'auto';
        audio.volume = prefRef.current.muted ? 0 : 1;
        audio.playbackRate = prefRef.current.rate;
        audioRef.current = audio;
        audioMetaRef.current = {
          lecture: lectureRef.current,
          slide: Number(currentSlide.slide_index),
          audioKey,
          audioFile: String(currentSlide.audio_file || ''),
          audioMs: Math.max(0, Math.round(Number(currentSlide.audio_ms) || 0)),
          audioProvider: String(currentSlide.audio_provider || ''),
          mode: 'file',
        };

        if (restoreMs > 0) {
          const estimate = Number(currentSlide.audio_ms) || 0;
          if (estimate > 0) setBar(Math.min(0.99, restoreMs / estimate));
        }

        let started = false;
        const playNow = () => {
          if (started || token !== tokenRef.current) return;
          started = true;
          const promise = audio.play();
          if (promise && typeof promise.catch === 'function') {
            promise.catch(() => {
              if (token !== tokenRef.current) return;
              setPlaying(false);
              setStatus('浏览器阻止了自动播放，点「开始听」继续');
            });
          }
        };

        const applyRestore = () => {
          if (token !== tokenRef.current) return;
          const durationMs = Number.isFinite(audio.duration) && audio.duration > 0 ? Math.round(audio.duration * 1000) : 0;
          const desired = resolveResumeOffset({
            savedMs: restoreMs,
            durationMs,
            audioKey,
            savedAudioKey: pending ? pending.audioKey : audioKey,
          });
          let applied = desired;
          if (applied > 0) {
            try {
              audio.currentTime = applied / 1000;
            } catch {
              applied = 0;
            }
          }
          if (applied > 0) {
            positionRef.current = applied;
            setClock({ positionMs: applied, durationMs });
            if (durationMs > 0) setBar(Math.min(0.99, applied / durationMs));
            setStatus(
              playingRef.current
                ? '正在从 ' + formatClock(applied) + ' 继续'
                : '上次听到 ' + formatClock(applied) + '，点「继续听」接着听',
            );
          } else {
            positionRef.current = 0;
            setClock({ positionMs: 0, durationMs });
            setStatus(playingRef.current ? '正在播放第 ' + (current + 1) + ' 页' : '点「开始听」从这一页开始朗读');
          }
          pendingRestoreRef.current = false;
          resumeRef.current = null;
          if (pending) pending.used = true;
          if (playingRef.current) playNow();
        };

        const onMeta = () => {
          if (token !== tokenRef.current) return;
          if (restoreMs > 0) {
            applyRestore();
            return;
          }
          const durationMs = Number.isFinite(audio.duration) && audio.duration > 0 ? Math.round(audio.duration * 1000) : 0;
          setClock((prev) => ({ positionMs: prev.positionMs, durationMs: durationMs || prev.durationMs || 0 }));
          if (playingRef.current) playNow();
        };

        audio.ontimeupdate = () => {
          if (token !== tokenRef.current) return;
          const duration = audio.duration;
          if (Number.isFinite(duration) && duration > 0) {
            const ms = Math.round(audio.currentTime * 1000);
            positionRef.current = ms;
            setBar(Math.min(0.99, audio.currentTime / duration));
            setClock({ positionMs: ms, durationMs: Math.round(duration * 1000) });
            if (Date.now() - lastPersistRef.current >= 5000) {
              lastPersistRef.current = Date.now();
              savePosition(ms);
            }
          }
        };
        audio.onended = () => {
          if (token !== tokenRef.current) return;
          positionRef.current = 0;
          if (current + 1 >= slidesRef.current.length) savePosition(0);
          advance();
        };
        audio.onerror = () => {
          if (token !== tokenRef.current) return;
          pendingRestoreRef.current = false;
          resumeRef.current = null;
          positionRef.current = 0;
          if (current + 1 >= slidesRef.current.length) savePosition(0);
          setNoAudio(true);
          setStatus('本页没有音频文件');
          if (current + 1 < slidesRef.current.length) scheduleSkip();
          else finishLecture();
        };

        if (audio.readyState >= 1) onMeta();
        else audio.addEventListener('loadedmetadata', onMeta, { once: true });

        if (!restoreMs) {
          if (!keyChanged) {
            setStatus(playingRef.current ? '正在播放第 ' + (current + 1) + ' 页' : '点「开始听」从这一页开始朗读');
          }
          if (playingRef.current) playNow();
        }

        return () => stopAudio();
      }, [
        index,
        lectureN,
        seriesId,
        slides.length,
        pageAudioKey,
        advance,
        finishLecture,
        savePosition,
        scheduleSkip,
        startSpeechFor,
        stopAudio,
      ]);

      /* 播放/暂停/继续：只动同一个音频元素，不重建。 */
      useEffect(() => {
        if (firstPlayEffectRef.current) {
          firstPlayEffectRef.current = false;
          return;
        }
        const currentSlide = slidesRef.current[indexRef.current];
        if (!currentSlide) return;
        const mode = slideAudioMode(currentSlide);
        const token = tokenRef.current;
        if (playing) {
          if (audioRef.current) {
            if (pendingRestoreRef.current) return;
            const audio = audioRef.current;
            let ms = Math.round(audio.currentTime * 1000);
            if (audio.ended) {
              try {
                audio.currentTime = 0;
                ms = 0;
              } catch {
                /* 不支持 seek 时保持现状 */
              }
            }
            if (audio.paused) {
              const promise = audio.play();
              if (promise && typeof promise.catch === 'function') {
                promise.catch(() => {
                  if (token !== tokenRef.current) return;
                  setPlaying(false);
                  setStatus('浏览器阻止了自动播放，点「开始听」继续');
                });
              }
            }
            setStatus(
              normalizeOffsetMs(ms) > 0
                ? '正在从 ' + formatClock(ms) + ' 继续'
                : '正在播放第 ' + (indexRef.current + 1) + ' 页',
            );
          } else if (mode === 'speech') {
            startSpeechFor(currentSlide, token);
          } else if (mode === 'none') {
            const hasNext = indexRef.current + 1 < slidesRef.current.length;
            setNoAudio(true);
            setStatus('本页未配音' + (hasNext ? '，即将跳过' : ''));
            if (hasNext) scheduleSkip();
            else finishLecture();
          }
        } else if (audioRef.current) {
          const audio = audioRef.current;
          const ended = audio.ended === true;
          const ms = pendingRestoreRef.current ? positionRef.current : ended ? 0 : Math.round(audio.currentTime * 1000);
          audio.pause();
          positionRef.current = ms;
          if (ended) setBar(0);
          setClock({
            positionMs: ms,
            durationMs: Number.isFinite(audio.duration) && audio.duration > 0 ? Math.round(audio.duration * 1000) : 0,
          });
          savePosition(ms);
        } else if (mode === 'speech') {
          speechSeqRef.current += 1;
          stopSpeech();
          clearTick();
        }
      }, [playing, clearTick, finishLecture, savePosition, scheduleSkip, startSpeechFor]);

      /* 语速/静音就地生效，不重建音频、不回页首。 */
      useEffect(() => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.playbackRate = pref.rate;
        audio.volume = pref.muted ? 0 : 1;
      }, [pref.rate, pref.muted]);

      /* 拖动分隔条：拖完才写该系列的布局（内存里始终存原文占比） */
      useEffect(() => {
        if (!dragging) return undefined;
        const move = (event) => {
          const rect = mainRef.current ? mainRef.current.getBoundingClientRect() : null;
          if (!rect || !rect.width) return;
          const leftRatio = (event.clientX - rect.left) / rect.width;
          const value = splitForLeftRatio(layoutRef.current, leftRatio);
          splitRef.current = value;
          setSplit(value);
        };
        const up = () => {
          setDragging(false);
          saveSeriesView({ split: splitRef.current });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up, { once: true });
        return () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
      }, [dragging, saveSeriesView]);

      /** 写一个原文占比：夹紧、更新内存、落该系列 view.json。 */
      const setSplitValue = useCallback(
        (value) => {
          const next = clampSplitValue(value);
          splitRef.current = next;
          setSplit(next);
          saveSeriesView({ split: next });
        },
        [saveSeriesView],
      );

      /** delta 以「分隔条向左/右移动」为准；落盘时换算成原文占比（FR-18.2）。 */
      const adjustSplit = useCallback(
        (delta) => {
          const current = leftRatioFor(layoutRef.current, splitRef.current);
          const nextLeft = Math.min(0.75, Math.max(0.25, current + delta));
          setSplitValue(splitForLeftRatio(layoutRef.current, nextLeft));
        },
        [setSplitValue],
      );

      /** 换位：只改方向，不改宽度；写该系列 view.json，不重建音频。 */
      const toggleLayout = useCallback(() => {
        const next = nextLayout(layoutRef.current);
        layoutRef.current = next;
        setLayout(next);
        saveSeriesView({ layout: next });
      }, [saveSeriesView]);

      const toggleFullscreen = useCallback(async () => {
        const element = rootRef.current;
        if (!element || typeof document === 'undefined') return;
        try {
          if (document.fullscreenElement) await document.exitFullscreen();
          else if (element.requestFullscreen) await element.requestFullscreen();
        } catch {
          setStatus('浏览器不允许进入全屏');
        }
      }, []);

      useEffect(() => {
        if (typeof document === 'undefined') return undefined;
        const onChange = () => setFullscreen(!!document.fullscreenElement);
        document.addEventListener('fullscreenchange', onChange);
        return () => document.removeEventListener('fullscreenchange', onChange);
      }, []);

      const togglePlay = useCallback(() => {
        const next = !playingRef.current;
        if (next) {
          const ms = positionRef.current;
          setStatus(normalizeOffsetMs(ms) > 0 ? '正在从 ' + formatClock(ms) + ' 继续' : '正在开始…');
        } else {
          const audio = audioRef.current;
          const currentSlide = slidesRef.current[indexRef.current];
          const mode = slideAudioMode(currentSlide);
          const ms = pendingRestoreRef.current ? positionRef.current : audio ? Math.round(audio.currentTime * 1000) : positionRef.current;
          if (mode === 'speech') setStatus('已暂停（浏览器朗读不支持精确续播）');
          else setStatus(normalizeOffsetMs(ms) > 0 ? '已暂停 · ' + formatClock(ms) : '已暂停');
        }
        setPlaying(next);
      }, []);

      const goTo = useCallback(
        (target) => {
          const next = Math.max(0, Math.min(slidesRef.current.length - 1, Math.round(Number(target) || 0)));
          if (next === indexRef.current) return;
          stopAudio();
          indexSourceRef.current = 'user';
          thumbYieldRef.current = 0;
          resumeRef.current = null;
          pendingRestoreRef.current = false;
          positionRef.current = 0;
          lastPersistRef.current = 0;
          setBar(0);
          setClock({ positionMs: 0, durationMs: 0 });
          setIndex(next);
          savePageStart(lectureRef.current, next + 1);
        },
        [savePageStart, stopAudio],
      );

      /**
       * 预览窗格跟随当前页（横向滚动，AC-142 底部缩略图）：
       * - 键盘/点击/换讲属于显式翻页，立即滚动并结束让位期；
       * - 播放自动翻页在用户刚刚手动横向滚动后让位 5 秒，让位结束时若当前页仍不可见则补滚一次。
       */
      useEffect(() => {
        const container = thumbsRef.current;
        if (!container) return undefined;
        const clearTimer = () => {
          if (thumbScrollTimerRef.current) {
            clearTimeout(thumbScrollTimerRef.current);
            thumbScrollTimerRef.current = null;
          }
        };
        const reveal = () => {
          const thumb = container.children ? container.children[index] : null;
          return scrollThumbIntoView(container, thumb || null);
        };
        const source = indexSourceRef.current;
        indexSourceRef.current = 'user';
        clearTimer();
        const defer = thumbScrollDeferMs(source, thumbYieldRef.current, Date.now());
        if (defer > 0) {
          const wait = () => {
            const left = thumbScrollDeferMs('playback', thumbYieldRef.current, Date.now());
            if (left > 0) {
              thumbScrollTimerRef.current = setTimeout(wait, left + 20);
              return;
            }
            thumbScrollTimerRef.current = null;
            reveal();
          };
          thumbScrollTimerRef.current = setTimeout(wait, defer + 20);
          return clearTimer;
        }
        thumbYieldRef.current = 0;
        let frame = 0;
        let cancelled = false;
        const apply = () => {
          if (!cancelled) reveal();
        };
        if (typeof requestAnimationFrame === 'function') frame = requestAnimationFrame(apply);
        else apply();
        return () => {
          cancelled = true;
          if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
        };
      }, [index, slides.length]);

      /* 手动横向滚动预览窗格后让位 5 秒；程序滚动不触发，避免自己把自己锁住。 */
      useEffect(() => {
        const container = thumbsRef.current;
        if (!container || typeof container.addEventListener !== 'function') return undefined;
        const markManual = () => {
          thumbYieldRef.current = Date.now() + THUMB_SCROLL_YIELD_MS;
        };
        const onWheel = (event) => {
          const dx = Math.abs(Number(event.deltaX) || 0);
          const dy = Math.abs(Number(event.deltaY) || 0);
          if (event.shiftKey || dx > dy) markManual();
        };
        container.addEventListener('wheel', onWheel, { passive: true });
        container.addEventListener('touchstart', markManual, { passive: true });
        container.addEventListener('pointerdown', markManual);
        return () => {
          container.removeEventListener('wheel', onWheel);
          container.removeEventListener('touchstart', markManual);
          container.removeEventListener('pointerdown', markManual);
        };
      }, [slides.length]);

      /* 窗口缩放 / 侧栏展开改变可视宽度后，当前页可能被裁掉：校正一次（即时滚动）。 */
      useEffect(() => {
        const container = thumbsRef.current;
        if (!container) return undefined;
        const keepVisible = () => {
          const thumb = container.children ? container.children[indexRef.current] : null;
          scrollThumbIntoView(container, thumb || null, 'auto');
        };
        if (typeof ResizeObserver === 'function') {
          const observer = new ResizeObserver(keepVisible);
          observer.observe(container);
          return () => observer.disconnect();
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('resize', keepVisible);
          return () => window.removeEventListener('resize', keepVisible);
        }
        return undefined;
      }, [slides.length]);

      useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
        };
      }, []);

      /**
       * 单页换一张（AC-147）：
       * - 换图期间只写 imageOverrides，不动 slides，因此不会打断播放；
       * - 轮询 job 状态（B2），结束后只拉一次 /lecture；
       * - 失败时保留旧图（服务端已保留 image_file/image_seed）。
       */
      const regenImage = useCallback(
        async (targetSlide) => {
          const slideIndex = Number(targetSlide && targetSlide.slide_index) || 0;
          if (!slideIndex || imageBusyRef.current) return;
          const key = seriesId + ':' + lectureN + ':' + slideIndex;
          const listNow = slidesRef.current || [];
          const rawHit = listNow.find((item) => Number(item.slide_index) === slideIndex) || targetSlide || {};
          const oldFile = rawHit.image_file != null ? String(rawHit.image_file) : '';
          const oldSeed = rawHit.image_seed != null ? rawHit.image_seed : 0;
          imageBusyRef.current = key;
          setImageBusyKey(key);
          setImageOverrides((prev) =>
            Object.assign({}, prev, {
              [key]: { status: 'regenerating', file: oldFile, seed: oldSeed },
            }),
          );
          let job = null;
          let timedOut = false;
          try {
            job = await api('/image/regen', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ seriesId, lecture: lectureN, slide: slideIndex, force: true }),
            });
            if (!aliveRef.current) return;
            setSeriesImageJob(job);
            notify('已开始重出第 ' + slideIndex + ' 页配图');
            const startedAt = Date.now();
            while (Date.now() - startedAt < 180000) {
              await new Promise((resolve) => setTimeout(resolve, 1200));
              if (!aliveRef.current) return;
              try {
                const state = await api('/image/status?seriesId=' + encodeURIComponent(seriesId));
                job = state;
                if (state && state.live === false) break;
              } catch {
                /* 状态接口偶发失败：继续等，别把换图判死 */
              }
            }
            timedOut = !(job && job.live === false);
            if (!aliveRef.current) return;
            let list = null;
            try {
              const doc = await api('/lecture?seriesId=' + encodeURIComponent(seriesId) + '&n=' + lectureN);
              list = (doc.slides && doc.slides.slides) || null;
            } catch {
              list = null;
            }
            if (!aliveRef.current) return;
            if (list) {
              setSlidesByLecture((prev) => Object.assign({}, prev, { [lectureN]: list }));
            }
            const hit = list && list.find((item) => Number(item.slide_index) === slideIndex);
            if (hit && hit.image_status === 'ready') {
              notify('第 ' + slideIndex + ' 页配图已更新');
            } else if (hit && ['queued', 'running', 'pending'].includes(String(hit.image_status || ''))) {
              notify('第 ' + slideIndex + ' 页配图还在生成，先继续用老图');
            } else if (hit && hit.image_file) {
              notify('第 ' + slideIndex + ' 页换图失败，继续用老图' + (hit.image_error ? '：' + hit.image_error : ''));
            } else if (hit) {
              notify('第 ' + slideIndex + ' 页配图失败：' + (hit.image_error || (job && job.code) || 'E_IMG_FAIL'));
            } else if (timedOut) {
              notify('第 ' + slideIndex + ' 页配图超时，继续用老图');
            } else if (job && job.status === 'done') {
              notify('第 ' + slideIndex + ' 页配图已更新');
            } else {
              notify('第 ' + slideIndex + ' 页换图未完成，继续用老图');
            }
          } catch (err) {
            if (!aliveRef.current) return;
            notify(
              err.code === 'E_IMG_DISABLED'
                ? '当前配图策略是「提示词占位」：到设置 → 配图切到「本地 ComfyUI」。'
                : err.message,
            );
          } finally {
            if (imageBusyRef.current === key) imageBusyRef.current = '';
            if (aliveRef.current) {
              setImageBusyKey('');
              if (job && job.live === false) setSeriesImageJob(null);
              setImageOverrides((prev) => {
                if (!prev[key]) return prev;
                const next = Object.assign({}, prev);
                delete next[key];
                return next;
              });
            }
          }
        },
        [lectureN, notify, seriesId],
      );

      const cancelRegenImage = useCallback(async () => {
        if (!imageBusyRef.current) return;
        try {
          const out = await api('/image/cancel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ seriesId }),
          });
          notify(out.cancelled ? '正在取消换图…' : '换图已经结束');
        } catch (err) {
          notify(err.message);
        }
      }, [seriesId, notify]);

      const cancelSeriesImage = useCallback(async () => {
        try {
          const out = await api('/image/cancel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ seriesId }),
          });
          notify(out.cancelled ? '正在取消配图…' : '配图已经结束');
        } catch (err) {
          notify(err.message);
        }
      }, [seriesId, notify]);

      const nextPage = useCallback(() => {
        thumbYieldRef.current = 0;
        if (indexRef.current >= slidesRef.current.length - 1) {
          setPlaying(false);
          setStatus('已经到最后一页');
          savePosition(positionRef.current);
          return;
        }
        const next = indexRef.current + 1;
        stopAudio();
        indexSourceRef.current = 'user';
        resumeRef.current = null;
        pendingRestoreRef.current = false;
        positionRef.current = 0;
        lastPersistRef.current = 0;
        setBar(0);
        setClock({ positionMs: 0, durationMs: 0 });
        setIndex(next);
        savePageStart(lectureRef.current, next + 1);
      }, [savePageStart, savePosition, stopAudio]);

      const prevPage = useCallback(() => {
        thumbYieldRef.current = 0;
        if (indexRef.current <= 0) return;
        const next = indexRef.current - 1;
        stopAudio();
        indexSourceRef.current = 'user';
        resumeRef.current = null;
        pendingRestoreRef.current = false;
        positionRef.current = 0;
        lastPersistRef.current = 0;
        setBar(0);
        setClock({ positionMs: 0, durationMs: 0 });
        setIndex(next);
        savePageStart(lectureRef.current, next + 1);
      }, [savePageStart, stopAudio]);

      const handleBack = useCallback(() => {
        const audio = audioRef.current;
        const ms = pendingRestoreRef.current ? positionRef.current : audio ? Math.round(audio.currentTime * 1000) : positionRef.current;
        if (ms > 0) savePosition(ms, { beacon: true });
        stopAudio();
        if (onBack) onBack();
      }, [onBack, savePosition, stopAudio]);

      actionsRef.current = {
        togglePlay,
        next: nextPage,
        prev: prevPage,
        fullscreen: toggleFullscreen,
        back: handleBack,
        skip: () => {
          if (transition) startLecture(transition.n, { autoplay: true });
        },
        closeDirectory: () => setDirectory(false),
      };

      useEffect(() => {
        const onKey = (event) => {
          const action = playerKeyAction(event);
          if (!action) return;
          if (action === 'escape') {
            if (typeof document !== 'undefined' && document.fullscreenElement) {
              document.exitFullscreen().catch(() => {});
              return;
            }
            event.preventDefault();
            if (directory) {
              setDirectory(false);
              return;
            }
            if (transition) {
              actionsRef.current.skip();
              return;
            }
            actionsRef.current.back();
            return;
          }
          event.preventDefault();
          if (transition && (action === 'play' || action === 'next')) {
            actionsRef.current.skip();
            return;
          }
          if (action === 'play') actionsRef.current.togglePlay();
          else if (action === 'next') actionsRef.current.next();
          else if (action === 'prev') actionsRef.current.prev();
          else if (action === 'fullscreen') actionsRef.current.fullscreen();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [directory, transition]);

      const currentLectureMeta = lectures.find((item) => Number(item.n) === Number(lectureN)) || null;
      const progressLine = formatSeriesProgress({
        lecture: lectureN,
        slide: slides.length ? index + 1 : 0,
        lecturePages: slides.length,
        heardPages: progress ? progress.heardPages : 0,
        totalPages: progress ? progress.totalPages : (series && series.total_pages) || 0,
      });
      const currentAudioMode = slideAudioMode(rawSlide);
      const canResume = currentAudioMode === 'file' && normalizeOffsetMs(clock.positionMs) > 0;
      const playLabel = playing ? '暂停' : canResume ? '继续听' : '开始听';
      // AC-144：配音失败/部分失败必须在播放入口可见，且能一眼看到错误码
      const voiceNotice = (() => {
        if (!series || voiceNoticeClosed) return '';
        const status = String(series.voice_status || 'none');
        const code = series.voice_code ? String(series.voice_code) : '';
        if (status === 'partial') {
          return '系列配音未完成：' + (code || 'E_TTS_FAIL') + (series.voice_error ? ' · ' + series.voice_error : '') + '。到系列卡点「补配音」补齐。';
        }
        if (status === 'failed') {
          return '系列配音失败：' + (code || 'E_TTS_FAIL') + (series.voice_error ? ' · ' + series.voice_error : '') + '。到系列卡点「补配音」重试。';
        }
        if (code) {
          return '系列还没配音：' + code + (series.voice_error ? ' · ' + series.voice_error : '') + '。到系列卡点「生成配音」。';
        }
        return '';
      })();

      if (loadError) {
        return h(
          'div',
          { className: 'blm-player' },
          h('div', { className: 'blm-bar' }, h('button', { className: 'blm-btn', onClick: onBack }, '← 返回'), h('h1', null, '系列')),
          h('div', { className: 'blm-body' }, h('div', { className: 'blm-error' }, String(loadError.message || loadError))),
        );
      }
      if (loading || !series) {
        return h(
          'div',
          { className: 'blm-player' },
          h('div', { className: 'blm-bar' }, h('button', { className: 'blm-btn', onClick: onBack }, '← 返回'), h('h1', null, '系列')),
          h('div', { className: 'blm-body' }, h('div', { className: 'blm-dim' }, '正在打开系列…')),
        );
      }

      // FR-18.2：两栏顺序由该系列的布局决定；宽度只看原文占比，换位不改变它。
      const currentLayout = clampLayout(layout);
      const leftRatio = leftRatioFor(currentLayout, split);
      const sourcePane = h(SourcePane, { key: 'source', pdfDoc, pdfLoading, pdfError, slide, bookId });
      const stagePane = h(
        'div',
        { key: 'stage', className: 'blm-pane-stage' },
        h(
          'div',
          { className: 'blm-stage-stack' },
          h(SlideStage, {
            key: lectureN + '-' + (slide ? slide.slide_index : 0),
            slide,
            seriesId,
            lecture: lectureN,
            onRegenImage: regenImage,
            onCancelImage: cancelRegenImage,
            imageBusy: Boolean(imageKey) && imageBusyKey === imageKey,
            imageLocked: Boolean(imageBusyKey) && imageBusyKey !== imageKey,
          }),
          h(SubtitlePane, { text: subtitleText(slide) }),
        ),
      );

      return h(
        'div',
        {
          className: 'blm-player',
          ref: rootRef,
          style: { '--blm-split': (leftRatio * 100).toFixed(2) + '%', cursor: dragging ? 'col-resize' : undefined },
        },
        h(
          'div',
          { className: 'blm-bar' },
          h('button', { className: 'blm-btn', onClick: handleBack }, '← 返回'),
          h('h1', null, series.title || '精讲'),
          h('span', { className: 'blm-chip' }, progressLine),
          h('div', { style: { flex: 1 } }),
          h(
            'button',
            {
              className: 'blm-btn blm-swap',
              onClick: toggleLayout,
              title: '交换原文与幻灯片的位置（布局按系列记住）',
              'aria-label': '交换原文与幻灯片的位置',
              'aria-pressed': currentLayout === 'pdf-left',
            },
            '⇄ 换位',
          ),
          single ? null : h('button', { className: 'blm-btn', onClick: () => setDirectory(true) }, '系列目录'),
          h('button', { className: 'blm-btn', onClick: toggleFullscreen, title: '全屏（F）' }, fullscreen ? '退出全屏' : '全屏'),
          h(
            'a',
            { className: 'blm-btn', href: FILE_API + '?bookId=' + encodeURIComponent(bookId), target: '_blank', rel: 'noreferrer' },
            '打开 PDF',
          ),
        ),
        voiceNotice
          ? h(
              'div',
              { className: 'blm-player-alert' },
              h('span', { className: 'grow' }, voiceNotice),
              h(
                'button',
                { className: 'blm-btn', onClick: () => setVoiceNoticeClosed(true), 'aria-label': '关闭配音提示' },
                '关闭',
              ),
            )
          : null,
        seriesImageActive
          ? h(
              'div',
              { className: 'blm-player-alert' },
              h('span', { className: 'grow' },
                '本系列配图作业进行中' +
                  (seriesImageJob.lecture ? ' · 第 ' + seriesImageJob.lecture + ' 讲' : '') +
                  (seriesImageJob.message ? ' · ' + seriesImageJob.message : '')),
              h('button', { className: 'blm-btn', onClick: cancelSeriesImage }, '取消配图'),
            )
          : null,
        h(
          'div',
          {
            className: 'blm-player-main' + (currentLayout === 'pdf-left' ? ' pdf-left' : ''),
            ref: mainRef,
          },
          currentLayout === 'pdf-left' ? sourcePane : stagePane,
          h('div', {
            key: 'divider',
            className: 'blm-divider',
            role: 'separator',
            'aria-orientation': 'vertical',
            'aria-label': '拖动调整原文与幻灯片宽度',
            'aria-valuenow': Math.round(leftRatio * 100),
            tabIndex: 0,
            onPointerDown: (event) => {
              event.preventDefault();
              setDragging(true);
            },
            onDoubleClick: () => setSplitValue(0.55),
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
          currentLayout === 'pdf-left' ? stagePane : sourcePane,
        ),
        transition
          ? h(TransitionCard, {
              next: { n: transition.n, title: transition.title },
              seconds: transition.count,
              onSkip: () => startLecture(transition.n, { autoplay: true }),
            })
          : null,
        directory
          ? h(SeriesDirectory, {
              series,
              current: lectureN,
              progress,
              onPick: (n) => {
                setDirectory(false);
                startLecture(n, { autoplay: false });
              },
              onClose: () => setDirectory(false),
            })
          : null,
        h(
          'div',
          { className: 'blm-player-foot' },
          h(
            'div',
            { className: 'blm-controls' },
            h(
              'button',
              { className: 'blm-btn primary', onClick: togglePlay, 'aria-label': playLabel },
              playLabel,
            ),
            h('button', { className: 'blm-btn', onClick: prevPage, disabled: index <= 0, 'aria-label': '上一页' }, '‹'),
            h('button', {
              className: 'blm-btn',
              onClick: nextPage,
              disabled: index >= slides.length - 1,
              'aria-label': '下一页',
            }, '›'),
            h('span', { className: 'blm-dim' }, currentLectureMeta ? '第 ' + lectureN + '/' + lectures.length + ' 讲' : ''),
            h('div', { className: 'blm-pagebar', 'aria-hidden': 'true' }, h('i', { style: { width: Math.round(bar * 100) + '%' } })),
            h(
              'span',
              { className: 'blm-dim', style: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } },
              formatClock(clock.positionMs) + ' / ' + (clock.durationMs > 0 ? formatClock(clock.durationMs) : '--:--'),
            ),
            h(
              'select',
              {
                className: 'blm-select',
                'aria-label': '播放语速',
                value: String(pref.rate),
                onChange: (event) => savePreference({ rate: Number(event.target.value) }),
              },
              RATE_STEPS.map((rate) => h('option', { key: rate, value: String(rate) }, rate.toFixed(1) + '×')),
            ),
            h(
              'button',
              { className: 'blm-btn', onClick: () => savePreference({ muted: !pref.muted }), 'aria-label': pref.muted ? '取消静音' : '静音' },
              pref.muted ? '取消静音' : '静音',
            ),
            series.status === 'ready' || series.status === 'partial'
              ? h('button', { className: 'blm-btn', onClick: onBack, title: '回到系列卡，可练一练或导出（M5）' }, '系列')
              : null,
          ),
          h(
            'div',
            { className: 'blm-controls' },
            noAudio ? h('span', { className: 'blm-noaudio' }, '本页未配音') : null,
            h('span', { className: 'blm-dim' }, status),
            h('div', { style: { flex: 1 } }),
            h('span', { className: 'blm-dim', style: { fontSize: 11 } }, '空格 播放/暂停 · ←/→ 翻页 · F 全屏 · Esc 返回'),
          ),
          h(
            'div',
            { className: 'blm-thumbs', role: 'tablist', 'aria-label': '逐页缩略图', ref: thumbsRef },
            slides.map((item, itemIndex) =>
              h(SlideThumb, {
                key: item.slide_index,
                slide: item,
                index: itemIndex,
                active: itemIndex === index,
                onClick: () => goTo(itemIndex),
              }),
            ),
          ),
        ),
      );
    }

    /* ------------------------------ M5 练习面板 ------------------------------ */

    function PracticePanel({ series, onClose, notify }) {
      const [summary, setSummary] = useState(null);
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState(false);
      const [job, setJob] = useState(null);
      const [session, setSession] = useState(null);
      const [index, setIndex] = useState(0);
      const [picked, setPicked] = useState([]);
      const [feedback, setFeedback] = useState(null);
      const [explainState, setExplainState] = useState({ status: 'idle', text: '' });
      const [finished, setFinished] = useState(null);
      const [mode, setMode] = useState('mixed');
      const [count, setCount] = useState(8);
      const [topupOpen, setTopupOpen] = useState(false);
      const [topupRounds, setTopupRounds] = useState(1);
      const PRACTICE_ACTIVE = ['queued', 'drafting', 'checking', 'anchoring', 'cancelling'];

      const loadSummary = useCallback(async () => {
        setLoading(true);
        try {
          const out = await api('/practice/summary?seriesId=' + encodeURIComponent(series.id));
          setSummary(out);
          // 关闭面板/刷新后 summary 会带回仍在跑的活动作业；据此恢复进度与取消入口。
          if (out.job && PRACTICE_ACTIVE.includes(String(out.job.status || ''))) setJob(out.job);
        } catch (err) {
          notify(err.message);
        } finally {
          setLoading(false);
        }
      }, [series.id, notify]);

      useEffect(() => {
        loadSummary();
      }, [loadSummary]);

      const jobActive = job != null && PRACTICE_ACTIVE.includes(String(job.status || ''));
      useEffect(() => {
        if (!jobActive || !job || !job.jobId) return undefined;
        const timer = setInterval(async () => {
          try {
            const out = await api('/practice/job?jobId=' + encodeURIComponent(job.jobId));
            setJob(out);
            if (!PRACTICE_ACTIVE.includes(String(out.status || ''))) {
              await loadSummary();
            }
          } catch (err) {
            if (err.code === 'E_NOT_FOUND') {
              setJob(null);
              await loadSummary();
              return;
            }
            notify(err.message);
          }
        }, 900);
        return () => clearInterval(timer);
      }, [jobActive, job, notify, loadSummary]);

      const startBank = async (topup, rounds) => {
        setBusy(true);
        try {
          const out = await api('/practice/bank', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ seriesId: series.id, topup: topup === true, rounds: rounds || 1 }),
          });
          if (out.cached) {
            notify('题库已经准备好了');
            await loadSummary();
          } else if (out.ok) {
            setJob(out);
            notify('已开始准备题库');
          } else {
            notify(out.message || '准备题库失败');
          }
        } catch (err) {
          notify(err.message);
        } finally {
          setBusy(false);
          setTopupOpen(false);
        }
      };

      const cancelJob = async () => {
        if (!job || !job.jobId) return;
        try {
          await api('/practice/cancel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId: job.jobId }),
          });
          notify('正在取消…');
        } catch (err) {
          notify(err.message);
        }
      };

      const applySession = (payload) => {
        setSession(payload);
        setFinished(null);
        setFeedback(null);
        setPicked([]);
        setExplainState({ status: 'idle', text: '' });
        const answered = new Set(((payload.session && payload.session.answers) || []).map((answer) => String(answer.qid)));
        const next = (payload.questions || []).findIndex((question) => !answered.has(String(question.qid)));
        setIndex(next < 0 ? 0 : next);
      };

      const begin = async () => {
        setBusy(true);
        try {
          const out = await api('/practice/session', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ seriesId: series.id, mode, count }),
          });
          if (!out.ok) {
            notify(out.code === 'E_BANK_INSUFFICIENT' ? '题库不足：先准备题库或补题。' : out.message || '开场失败');
            return;
          }
          applySession(out);
        } catch (err) {
          notify(err.message);
        } finally {
          setBusy(false);
        }
      };

      const resume = async () => {
        setBusy(true);
        try {
          const out = await api('/practice/session?seriesId=' + encodeURIComponent(series.id));
          if (!out.ok) {
            notify('没有可继续的练习');
            await loadSummary();
            return;
          }
          applySession(out);
        } catch (err) {
          notify(err.message);
        } finally {
          setBusy(false);
        }
      };

      const question = session && session.questions ? session.questions[index] : null;
      const answeredCount = session && session.session && Array.isArray(session.session.answers) ? session.session.answers.length : 0;

      const choose = (key) => {
        if (feedback) return;
        if (String(question.type) === 'multi') {
          setPicked((prev) => (prev.includes(key) ? prev.filter((value) => value !== key) : prev.concat(key)));
          return;
        }
        setPicked([key]);
      };

      const submit = async (empty) => {
        if (!question) return;
        setBusy(true);
        try {
          const out = await api('/practice/answer', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ seriesId: series.id, sessionId: session.sessionId, qid: question.qid, picked: empty ? [] : picked }),
          });
          if (!out.ok) {
            notify(out.message || '提交失败');
            return;
          }
          setFeedback(out);
          setExplainState({ status: out.explanation ? 'ready' : 'idle', text: out.explanation || '' });
          await loadSummary();
        } catch (err) {
          notify(err.message);
        } finally {
          setBusy(false);
        }
      };

      const askExplain = async () => {
        if (!question) return;
        setExplainState({ status: 'loading', text: '' });
        try {
          const out = await api('/practice/explain', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ seriesId: series.id, qid: question.qid, picked: feedback ? [] : picked }),
          });
          if (!out.ok) {
            setExplainState({ status: 'failed', text: out.message || '讲解暂时生成不了，先看原文。' });
            return;
          }
          setExplainState({ status: 'ready', text: out.explanation || '' });
        } catch (err) {
          setExplainState({ status: 'failed', text: err.message });
        }
      };

      const next = () => {
        const total = session && session.questions ? session.questions.length : 0;
        setFeedback(null);
        setPicked([]);
        setExplainState({ status: 'idle', text: '' });
        if (index + 1 >= total) {
          notify('已经是最后一题，可以结束练习查看总结。');
          return;
        }
        setIndex(index + 1);
      };

      const finish = async () => {
        if (!session) return;
        setBusy(true);
        try {
          const out = await api('/practice/finish', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ seriesId: series.id, sessionId: session.sessionId }),
          });
          if (!out.ok) {
            notify(out.message || '结束失败');
            return;
          }
          setFinished(out.summary);
          setSession(null);
          await loadSummary();
        } catch (err) {
          notify(err.message);
        } finally {
          setBusy(false);
        }
      };

      const flag = async () => {
        if (!question) return;
        try {
          await api('/practice/flag', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ seriesId: series.id, qid: question.qid }),
          });
          notify('已标记，这题不再组卷');
        } catch (err) {
          notify(err.message);
        }
      };

      const close = () => {
        if (jobActive) {
          notify('题库还在准备中；关闭面板后可回来查看进度。');
        }
        onClose();
      };

      return h(
        'div',
        { className: 'blm-modal-mask', onClick: (event) => { if (event.target === event.currentTarget) close(); } },
        h(
          'div',
          { className: 'blm-modal blm-plan-modal' },
          h(
            'div',
            { className: 'blm-row' },
            h('strong', null, '练一练 · ' + series.title),
            h('span', { className: 'blm-badge' }, (series.chapters || []).length + ' 章'),
            h('div', { style: { flex: 1 } }),
            h('button', { className: 'blm-btn', onClick: close }, '关闭'),
          ),
          loading
            ? h('div', { className: 'blm-dim', style: { marginTop: 10 } }, '正在读题库…')
            : !summary
              ? h(
                  'div',
                  { className: 'blm-practice' },
                  h('div', { className: 'blm-error' }, '题库状态没读出来，稍后重试。'),
                  h('button', { className: 'blm-btn', onClick: loadSummary }, '重试'),
                )
              : finished
              ? h(
                  'div',
                  { className: 'blm-practice' },
                  h('div', { className: 'blm-note' }, '本场结束：答 ' + finished.answered + '/' + finished.total + ' 题，正确 ' + finished.correct + ' 题（' + Math.round((finished.accuracy || 0) * 100) + '%）'),
                  (finished.wrongQids || []).length ? h('div', { className: 'blm-dim' }, '错题已进入错题本：' + finished.wrongQids.length + ' 题') : null,
                  h(
                    'div',
                    { className: 'blm-row' },
                    h('button', { className: 'blm-btn primary', disabled: busy, onClick: begin }, '再练一场'),
                    h('button', { className: 'blm-btn', disabled: busy, onClick: async () => {
                      setBusy(true);
                      try {
                        const out = await api('/practice/review', {
                          method: 'POST',
                          headers: { 'content-type': 'application/json' },
                          body: JSON.stringify({ seriesId: series.id }),
                        });
                        if (!out.ok) notify(out.message || '没有到期/错题可复习');
                        else applySession(out);
                      } catch (err) {
                        notify(err.message);
                      } finally {
                        setBusy(false);
                      }
                    } }, '复习错题'),
                  ),
                )
              : session && question
                ? h(
                    'div',
                    { className: 'blm-practice' },
                    h(
                      'div',
                      { className: 'blm-row', style: { fontSize: 12 } },
                      h('span', { className: 'blm-dim' }, '第 ' + (index + 1) + '/' + session.questions.length + ' 题 · 已答 ' + answeredCount + ' · ' + String(question.type === 'multi' ? '多选' : question.type === 'judge' ? '判断' : '单选')),
                      h('span', { className: 'blm-badge' }, question.point || '考点'),
                      h('div', { style: { flex: 1 } }),
                      h('button', { className: 'blm-btn', disabled: busy, onClick: flag }, '这题有问题'),
                    ),
                    h('div', { className: 'blm-practice-q' },
                      h('div', { className: 'blm-practice-stem' }, question.stem),
                      (question.options || []).map((option) => {
                        const key = String(option.key);
                        const chosen = picked.includes(key);
                        const isAnswer = feedback && feedback.correct !== undefined && Array.isArray(feedback.answer) && feedback.answer.includes(key);
                        const wrong = feedback && !feedback.correct && chosen;
                        return h(
                          'button',
                          {
                            key,
                            className: 'blm-option' + (isAnswer ? ' right' : wrong ? ' wrong' : chosen ? ' on' : ''),
                            disabled: Boolean(feedback) || busy,
                            onClick: () => choose(key),
                          },
                          h('span', { className: 'key' }, key),
                          h('span', null, option.text),
                        );
                      }),
                      feedback
                        ? h(
                            'div',
                            { className: 'blm-practice-feedback' },
                            h('div', { className: feedback.correct ? 'blm-ok' : 'blm-bad' }, feedback.correct ? '答对了' : '答错了 · 正确答案 ' + (feedback.answer || []).join('、')),
                            feedback.source_quote ? h('div', { className: 'blm-practice-quote' }, '原文：' + feedback.source_quote) : null,
                            h(
                              'div',
                              { className: 'blm-row', style: { marginTop: 6 } },
                              h('button', { className: 'blm-btn', disabled: busy, onClick: askExplain }, explainState.status === 'loading' ? '讲解生成中…' : '查看讲解'),
                              explainState.status === 'failed' ? h('span', { className: 'blm-dim' }, explainState.text) : null,
                            ),
                            explainState.status === 'ready' && explainState.text ? h('div', { className: 'blm-practice-quote' }, explainState.text) : null,
                          )
                        : null,
                    ),
                    h(
                      'div',
                      { className: 'blm-row' },
                      feedback
                        ? h('button', { className: 'blm-btn primary', disabled: busy, onClick: next }, '下一题')
                        : h(
                            React.Fragment,
                            null,
                            h('button', { className: 'blm-btn primary', disabled: busy || !picked.length, onClick: () => submit(false) }, '提交答案'),
                            h('button', { className: 'blm-btn', disabled: busy, onClick: () => submit(true) }, '不会，看答案'),
                          ),
                      h('button', { className: 'blm-btn', disabled: busy, onClick: finish }, '结束练习'),
                    ),
                  )
                : h(
                    'div',
                    { className: 'blm-practice' },
                    h(
                      'div',
                      { className: 'blm-row', style: { fontSize: 12 } },
                      h('span', null, '题库 ' + summary.counts.questions + ' 题'),
                      h('span', { className: 'blm-dim' }, '覆盖 ' + summary.counts.covered + '/' + summary.counts.chapters + ' 章'),
                      h('span', { className: 'blm-dim' }, '待复习 ' + summary.counts.due + ' · 错题 ' + summary.counts.wrong),
                    ),
                    h(
                      'div',
                      { className: 'blm-chapters', style: { marginTop: 0 } },
                      (summary.chapters || []).map((chapter) =>
                        h(
                          'div',
                          { className: 'blm-chapter', key: chapter.n, style: { gridTemplateColumns: '34px 1fr 70px 60px' } },
                          h('span', { className: 'blm-dim' }, '#' + chapter.n),
                          h('span', { className: 't' }, chapter.title),
                          h('span', { className: 'blm-dim' }, chapter.covered ? chapter.count + ' 题' : '未就绪'),
                          h('span', { className: 'blm-badge' + (chapter.count >= 4 ? ' ok' : '') }, chapter.count >= 4 ? '可用' : '待补'),
                        ),
                      ),
                    ),
                    jobActive
                      ? h(
                          'div',
                          null,
                          h('div', { className: 'blm-dim', style: { fontSize: 12 } }, '题库准备中：' + (job.stage || '') + ' · ' + (job.current || 0) + '/' + (job.total || 0)),
                          h('div', { className: 'blm-progress' }, h('i', { style: { width: Math.round((Math.min(1, (job.current || 0) / Math.max(1, job.total || 1))) * 100) + '%' } })),
                          h('button', { className: 'blm-btn', disabled: busy, onClick: cancelJob }, '取消题库作业'),
                        )
                      : null,
                    h(
                      'div',
                      { className: 'blm-row' },
                      h('button', { className: 'blm-btn', disabled: busy || jobActive, onClick: () => startBank(false) }, '准备题库'),
                      h('button', { className: 'blm-btn', disabled: busy || jobActive, onClick: () => setTopupOpen(true) }, '补题'),
                      summary.session
                        ? h('button', { className: 'blm-btn primary', disabled: busy, onClick: resume }, '继续上次练习（已答 ' + ((summary.session.answers || []).length) + ' 题）')
                        : null,
                      h(
                        'button',
                        { className: 'blm-btn primary', disabled: busy || jobActive, onClick: begin },
                        summary.counts.questions ? '开始练习' : '题库不足，先准备',
                      ),
                      h('select', { className: 'blm-select', value: mode, onChange: (event) => setMode(event.target.value), 'aria-label': '练习模式' },
                        h('option', { value: 'mixed' }, '混合（新题 + 到期）'),
                        h('option', { value: 'new' }, '只出新题'),
                        h('option', { value: 'review' }, '只复习到期/错题'),
                      ),
                      h('select', { className: 'blm-select', value: count, onChange: (event) => setCount(Number(event.target.value)), 'aria-label': '题量' },
                        [5, 8, 10, 12, 15, 20].map((value) => h('option', { key: value, value }, value + ' 题')),
                      ),
                    ),
                    h('div', { className: 'blm-dim', style: { fontSize: 11 } }, '准备题库与开始练习是两个动作：开始练习只从已有题库组卷，不触发生成。'),
                    topupOpen
                      ? h(
                          'div',
                          { className: 'blm-note' },
                          h('div', null, '补题计划：每章 +5 题，单次最多 30 题、最多 6 轮；先确认再执行。'),
                          h(
                            'div',
                            { className: 'blm-field' },
                            h('span', { className: 'label' }, '轮数'),
                            h(
                              'select',
                              { className: 'blm-select', value: topupRounds, onChange: (event) => setTopupRounds(Number(event.target.value)) },
                              [1, 2, 3, 4, 5, 6].map((value) => h('option', { key: value, value }, value + ' 轮（每章 +' + value * 5 + ' 题）')),
                            ),
                          ),
                          h('div', { className: 'blm-dim' }, '预计新增约 ' + Math.min(30, topupRounds * 5 * Math.max(1, summary.counts.covered)) + ' 题，单次上限 30 题。'),
                          h(
                            'div',
                            { className: 'blm-row', style: { marginTop: 6 } },
                            h('button', { className: 'blm-btn primary', disabled: busy, onClick: () => startBank(true, topupRounds) }, '确认补题'),
                            h('button', { className: 'blm-btn', onClick: () => setTopupOpen(false) }, '取消'),
                          ),
                        )
                      : null,
                  ),
        ),
      );
    }

    /* ------------------------------ M5 导出对话框 ------------------------------ */

    function ExportDialog({ series, notify, onClose }) {
      const [lecture, setLecture] = useState('all');
      const [includeAudio, setIncludeAudio] = useState(true);
      const [includeImages, setIncludeImages] = useState(true);
      const [includeNotes, setIncludeNotes] = useState(true);
      const [plan, setPlan] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');

      const query = (extra) =>
        '?seriesId=' + encodeURIComponent(series.id) +
        '&lecture=' + encodeURIComponent(lecture) +
        '&audio=' + (includeAudio ? '1' : '0') +
        '&images=' + (includeImages ? '1' : '0') +
        '&notes=' + (includeNotes ? '1' : '0') +
        (extra || '');

      const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
          const out = await api('/export/pptx/plan' + query());
          if (!out.ok) {
            setError(out.message || '这个系列还没有可导出的讲');
            setPlan(null);
          } else {
            setPlan(out.plan);
          }
        } catch (err) {
          setError(err.message);
        } finally {
          setLoading(false);
        }
      }, [series.id, lecture, includeAudio, includeImages, includeNotes]);

      useEffect(() => {
        load();
      }, [load]);

      const download = () => {
        if (!plan) return;
        downloadUrl('/export/pptx' + query(), plan.fileName);
        notify('开始导出：' + plan.fileName);
      };
      const downloadBatch = () => {
        if (!plan) return;
        downloadUrl('/export/pptx/batch?seriesId=' + encodeURIComponent(series.id) + '&lectures=' + (lecture === 'all' ? 'all' : String(lecture)), series.title + '-精讲-合集.zip');
        notify('开始批量导出 ZIP');
      };

      return h(
        'div',
        { className: 'blm-modal-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h(
          'div',
          { className: 'blm-modal blm-plan-modal' },
          h(
            'div',
            { className: 'blm-row' },
            h('strong', null, '导出 PPT · ' + series.title),
            h('div', { style: { flex: 1 } }),
            h('button', { className: 'blm-btn', onClick: onClose }, '关闭'),
          ),
          h(
            'div',
            { className: 'blm-export-row', style: { marginTop: 8 } },
            h('span', { className: 'blm-dim' }, '范围'),
            h('select', { className: 'blm-select', value: lecture, onChange: (event) => setLecture(event.target.value) },
              h('option', { value: 'all' }, '整套合并（' + (series.lectures || []).length + ' 讲）'),
              (series.lectures || []).filter((item) => READY_LECTURE.includes(String(item.status))).map((item) =>
                h('option', { key: item.n, value: String(item.n) }, '第 ' + item.n + ' 讲 · ' + (item.title || '')),
              ),
            ),
          ),
          h(
            'div',
            { className: 'blm-export-row', style: { marginTop: 6 } },
            h('label', { className: 'blm-field' }, h('input', { type: 'checkbox', checked: includeAudio, onChange: (event) => setIncludeAudio(event.target.checked) }), '含音频'),
            h('label', { className: 'blm-field' }, h('input', { type: 'checkbox', checked: includeImages, onChange: (event) => setIncludeImages(event.target.checked) }), '含配图'),
            h('label', { className: 'blm-field' }, h('input', { type: 'checkbox', checked: includeNotes, onChange: (event) => setIncludeNotes(event.target.checked) }), '含备注'),
          ),
          loading ? h('div', { className: 'blm-dim', style: { marginTop: 10 } }, '正在计算页数与体积…') : null,
          error ? h('div', { className: 'blm-error', style: { marginTop: 10 } }, error) : null,
          plan
            ? h(
                'div',
                { style: { marginTop: 10 } },
                h('div', { className: 'blm-kv' },
                  h('dt', null, '讲数'), h('dd', null, plan.lectures.length + ' 讲' + (plan.transitionPages ? ' · 含 ' + plan.transitionPages + ' 个过渡页' : '')),
                  h('dt', null, '页数'), h('dd', null, plan.slides + ' 页'),
                  h('dt', null, '音频'), h('dd', null, plan.includeAudio ? plan.audioPages + ' 页含音频' : '本次不含音频'),
                  h('dt', null, '配图'), h('dd', null, plan.includeImages ? plan.imagePages + ' 页含配图' : '本次不含配图'),
                  h('dt', null, '体积'), h('dd', null, formatSize(plan.bytes)),
                  h('dt', null, '文件名'), h('dd', null, plan.fileName),
                ),
                (plan.warnings || []).length ? h('div', { className: 'blm-note', style: { marginTop: 8 } }, plan.warnings.join(' ')) : null,
                h(
                  'div',
                  { className: 'blm-row', style: { marginTop: 10 } },
                  h('button', { className: 'blm-btn primary', onClick: download }, '下载 PPTX'),
                  plan.mode === 'series' ? h('button', { className: 'blm-btn', onClick: downloadBatch }, '批量导出 ZIP（每讲一份）') : null,
                ),
                h('div', { className: 'blm-dim', style: { fontSize: 11, marginTop: 6 } }, '整套合并按讲序拼接，讲间插入过渡页（讲标题 + 接缝句）；导出不修改任何数据。'),
              )
            : null,
        ),
      );
    }

    /* ------------------------------ M5 书档导入对话框 ------------------------------ */

    function ImportPackageDialog({ file, notify, onClose, onDone, onJobStarted, initialJob }) {
      const [policy, setPolicy] = useState(readPackagePolicy);
      const [progress, setProgress] = useState(0);
      const [job, setJob] = useState(() => initialJob || null);
      const [error, setError] = useState('');
      const [uploading, setUploading] = useState(false);
      const startedRef = useRef(false);

      const start = useCallback(async () => {
        if (!file || startedRef.current) return;
        if (initialJob && initialJob.jobId && !['done', 'failed', 'cancelled'].includes(String(initialJob.status || ''))) {
          // 已有导入在跑：先让用户看/取消当前作业，不重复上传。
          startedRef.current = true;
          return;
        }
        startedRef.current = true;
        setUploading(true);
        setError('');
        try {
          const out = await uploadZip(file, policy, setProgress);
          if (!out.ok) {
            setError(out.message || '导入失败');
            return;
          }
          const next = { jobId: out.jobId, status: out.status || 'queued', current: 0, total: 0, items: [] };
          setJob(next);
          // 对话框可能在上传完成前就被关掉；把 job 交给 Panel 的全局导入条继续跟踪。
          if (onJobStarted) onJobStarted(next);
        } catch (err) {
          setError(err.message);
        } finally {
          setUploading(false);
        }
      }, [file, policy, onJobStarted, initialJob]);

      useEffect(() => {
        start();
      }, [start]);

      useEffect(() => {
        if (!job || !job.jobId) return undefined;
        if (['done', 'failed', 'cancelled'].includes(String(job.status))) {
          if (String(job.status) === 'done' && onDone) onDone(job);
          return undefined;
        }
        const timer = setInterval(async () => {
          try {
            const out = await api('/import/package/job?jobId=' + encodeURIComponent(job.jobId));
            if (!out.ok) {
              setError(out.message || '作业不存在');
              return;
            }
            setJob(out);
            if (['done', 'failed', 'cancelled'].includes(String(out.status)) && onDone) onDone(out);
          } catch (err) {
            setError(err.message);
          }
        }, 700);
        return () => clearInterval(timer);
      }, [job, onDone]);

      const cancel = async () => {
        if (!job || !job.jobId) return;
        try {
          await api('/import/package/cancel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId: job.jobId }),
          });
          notify('正在取消导入…');
        } catch (err) {
          notify(err.message);
        }
      };

      const close = () => {
        const active = job && !['done', 'failed', 'cancelled'].includes(String(job.status || ''));
        if (active) notify('导入继续在后台运行；书架会显示进度，可随时取消。');
        onClose();
      };

      return h(
        'div',
        { className: 'blm-modal-mask', onClick: (event) => { if (event.target === event.currentTarget) close(); } },
        h(
          'div',
          { className: 'blm-modal blm-plan-modal' },
          h(
            'div',
            { className: 'blm-row' },
            h('strong', null, '导入书档'),
            h('span', { className: 'blm-dim' }, (job && job.fileName) || (file ? file.name : '')),
            h('div', { style: { flex: 1 } }),
            h('button', { className: 'blm-btn', onClick: close }, '关闭'),
          ),
          h(
            'div',
            { className: 'blm-export-row', style: { marginTop: 8 } },
            h('span', { className: 'blm-dim' }, '冲突策略'),
            h('select', { className: 'blm-select', value: policy, disabled: uploading || Boolean(job), onChange: (event) => {
              setPolicy(event.target.value);
              savePackagePolicy(event.target.value);
            } },
              h('option', { value: 'merge' }, '并入（默认）'),
              h('option', { value: 'skip' }, '跳过已有'),
              h('option', { value: 'copy' }, '复制一本'),
            ),
          ),
          uploading ? h('div', { className: 'blm-progress' }, h('i', { style: { width: Math.round(progress * 100) + '%' } })) : null,
          error ? h('div', { className: 'blm-error', style: { marginTop: 10 } }, error) : null,
          job
            ? h(
                'div',
                { style: { marginTop: 10 } },
                h('div', { className: 'blm-dim', style: { fontSize: 12 } }, '状态：' + job.status + ' · ' + (job.stage || '') + ' · ' + (job.current || 0) + '/' + (job.total || 0) + (job.message ? ' · ' + job.message : '')),
                h(
                  'div',
                  { className: 'blm-import-items' },
                  (job.items || []).map((item) =>
                    h(
                      'div',
                      { className: 'blm-import-item', key: item.bookId },
                      h('span', { className: 'grow', title: item.title }, item.title || item.bookId),
                      h('span', { className: 'blm-badge' + (item.status === 'ok' ? ' ok' : '') }, item.status),
                      item.code ? h('span', { className: 'blm-bad', style: { fontSize: 11 } }, item.code) : null,
                      item.message ? h('span', { className: 'blm-dim', style: { fontSize: 11 } }, item.message) : null,
                    ),
                  ),
                ),
                !['done', 'failed', 'cancelled'].includes(String(job.status))
                  ? h('button', { className: 'blm-btn', onClick: cancel }, '取消导入')
                  : null,
              )
            : h('div', { className: 'blm-dim', style: { fontSize: 12, marginTop: 8 } }, '上传后逐本校验；失败不影响同包其它本。'),
        ),
      );
    }


    function QualityPanel({ state, onClose }) {
      if (!state) return null;
      const q = state.quality || {};
      const density = q.density || {};
      const fallbackSections = (state.sections || []).filter((section) => section && section.must_keep_fallback);
      const line = (label, value) => h('div', { className: 'blm-plan-line' }, h('strong', null, label + '：'), value);
      const list = (items, format) => (Array.isArray(items) && items.length
        ? h('div', { className: 'blm-plan-line' }, items.map(format).join('；'))
        : null);
      return h(
        'div',
        { className: 'blm-modal-mask', onClick: (event) => { if (event.target === event.currentTarget) onClose(); } },
        h(
          'div',
          { className: 'blm-modal blm-plan-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '质量与密度' },
          h(
            'div',
            { className: 'blm-row' },
            h('strong', null, '质量与密度 · 第 ' + state.n + ' 讲'),
            h('div', { style: { flex: 1 } }),
            h('button', { className: 'blm-btn', onClick: onClose }, '关闭'),
          ),
          state.loading ? h('div', { className: 'blm-dim', style: { marginTop: 10 } }, '加载中…') : null,
          state.error ? h('div', { className: 'blm-note warn', style: { marginTop: 10 } }, state.error) : null,
          !state.loading && !state.error
            ? h(
                'div',
                { style: { marginTop: 8 } },
                line('页数', '计划 ' + (q.planned_pages || 0) + ' / 实际 ' + (q.actual_pages || 0) + (q.over_budget ? '（超预算，仅 warning）' : '')),
                q.plan_pages_stale
                  ? h('div', { className: 'blm-note warn' }, '计划页数可能已被旧版实际页数覆盖；请在系列卡点「计划页数需重规划」重建讲纲。')
                  : null,
                line('内容', q.content_ok ? '通过' : '待核对'),
                line('密度', q.density_ok ? '达标' : '偏低（软目标）'),
                q.content_ok === false && (q.must_keep_real_missing || []).length
                  ? line('真实缺失', list(q.must_keep_real_missing, (item) => (item.section || '') + ' · ' + item.must_keep))
                  : null,
                (q.must_keep_aliases || []).length
                  ? line('别名覆盖', list(q.must_keep_aliases, (item) => (item.section || '') + ' · ' + item.must_keep))
                  : null,
                fallbackSections.length
                  ? line('must_keep 回退', list(fallbackSections, (section) => section.title + ' · ' + (section.must_keep || []).join('/')))
                  : null,
                (q.hard_impersonations || []).length || (q.soft_impersonations || []).length
                  ? line('冒充', '硬 ' + (q.hard_impersonations || []).length + ' / 软 ' + (q.soft_impersonations || []).length)
                  : null,
                (q.placeholders || []).length ? line('占位页', String((q.placeholders || []).length)) : null,
                q.duplicate_pairs ? line('讲内重复', String(q.duplicate_pairs)) : null,
                density.avg_content_chars || density.avg_audio_chars
                  ? line('平均', '内容 ' + (density.avg_content_chars || 0) + ' 字 / 口播 ' + (density.avg_audio_chars || 0) + ' 字')
                  : null,
                (density.audio_short_pages || []).length ? line('口播短页', (density.audio_short_pages || []).join('、')) : null,
                (density.bullet_short_pages || []).length ? line('要点短页', (density.bullet_short_pages || []).join('、')) : null,
                (density.quote_short_pages || []).length ? line('引文短页', (density.quote_short_pages || []).join('、')) : null,
                (density.thin_pages || []).length ? line('薄页', (density.thin_pages || []).join('、')) : null,
                (q.repair && ((q.repair.dropped_pages || []).length || (q.repair.repaired_must_keep || []).length))
                  ? line('修复记录', '删页 ' + ((q.repair.dropped_pages || []).join('、') || '无') + '；补讲 ' + ((q.repair.repaired_must_keep || []).map((item) => item.must_keep).join('、') || '无'))
                  : null,
                h('div', { className: 'blm-dim', style: { marginTop: 8, fontSize: 11 } }, '质量/密度只作审查提示，不阻断播放；不会自动压回计划页数。'),
              )
            : null,
        ),
      );
    }

    function SeriesCard({ series, part, notify, onReload, onPlay }) {
      const [job, setJob] = useState(null);
      const [jobUsage, setJobUsage] = useState(null);
      const [stitch, setStitch] = useState(null);
      const [voiceJob, setVoiceJob] = useState(null);
      const [imageJob, setImageJob] = useState(null);
      const [practiceOpen, setPracticeOpen] = useState(false);
      const [exportOpen, setExportOpen] = useState(false);
      const [qualityState, setQualityState] = useState(null);
      const [busy, setBusy] = useState(false);
      const doneRef = useRef(false);
      const lectures = series.lectures || [];
      const activeStatus = ['queued', 'drafting', 'stitching', 'structuring', 'validate', 'anchor', 'cancelling'];
      const VOICE_ACTIVE = ['queued', 'voicing', 'cancelling'];
      const IMAGE_ACTIVE = ['queued', 'running', 'cancelling'];
      const images = series.images || null;
      const imageStatus = String((images && images.status) || 'none');
      const isActive = job != null && activeStatus.includes(String(job.status || ''));
      const voiceActive = voiceJob != null && VOICE_ACTIVE.includes(String(voiceJob.status || ''));
      // 刷新后本地 imageJob 会丢；series.images.status 仍在 running/queued 时
      // 也要把「配图中… / 取消配图」显示出来，挂载后再由 /image/status 补进度。
      const imageJobActive = imageJob != null && IMAGE_ACTIVE.includes(String(imageJob.status || ''));
      const imageActive = imageJobActive || (imageJob == null && IMAGE_ACTIVE.includes(imageStatus));
      const playable = lectures.filter((lec) => READY_LECTURE.includes(String(lec.status)));
      const qualityWarnings = lectures.filter((lec) => lec.quality_summary
        && (lec.quality_summary.content_ok === false || lec.quality_summary.density_ok === false));
      const overBudgetCount = lectures.filter((lec) => lec.quality_summary && lec.quality_summary.over_budget).length;
      const pagesStale = lectures.filter((lec) => lec.plan_pages_stale || (lec.quality_summary && lec.quality_summary.plan_pages_stale));
      const plannedTotal = Number(series.planned_total_pages)
        || lectures.reduce((sum, lec) => sum + (Number(lec.planned_pages) || Number(lec.pages) || 0), 0);
      const snapshotVersion = seriesSnapshotVersion(series, part);
      const voicePending = playable.filter((lec) => String(lec.voice_status || 'none') !== 'ready');
      const voiceAllReady = playable.length > 0 && voicePending.length === 0;
      const voiceStarted = ['ready', 'partial', 'failed'].includes(String(series.voice_status || ''));
      const voiceState = voiceAllReady ? 'ready' : voiceStarted ? 'partial' : 'none';
      const voiceFailedLectures = playable.filter((lec) => ['failed', 'partial'].includes(String(lec.voice_status || '')));
      const voicePages = playable.reduce((sum, lec) => sum + (Number(lec.actual_pages) || Number(lec.pages) || 0), 0) || Number(series.total_pages) || 0;
      const voiceLabel = voiceState === 'ready' ? '重新配音' : voiceState === 'partial' ? '补配音' : '生成配音';
      const voiceText = (() => {
        const status = String(series.voice_status || 'none');
        if (status === 'ready' || voiceAllReady) return '已配音';
        if (status === 'partial') return '部分配音';
        if (status === 'failed') return '配音失败';
        if (status === 'none' && series.voice_code) return '配音失败';
        return '未配音';
      })();
      const imageAllReady = imageStatus === 'done' && Number(images.failed || 0) === 0;
      const imageState = imageAllReady ? 'done' : ['partial', 'failed', 'interrupted'].includes(imageStatus) ? 'partial' : 'none';
      const imageLabel = imageState === 'done' ? '重新配图' : imageState === 'partial' ? '补配图' : '生成配图';
      const imageText = (() => {
        if (!images || !images.status || images.status === 'none') return '配图占位';
        if (images.status === 'done') return '配图 ' + (images.done || 0) + ' 张';
        if (images.status === 'partial') return '配图 ' + (images.done || 0) + '/' + (images.total || 0);
        if (images.status === 'failed') return '配图失败';
        if (images.status === 'interrupted') return '配图中断';
        return '配图中…';
      })();
      const voiceLongPress = useLongPress(() => {
        void (async () => {
          const ok = await confirmAction(
            '忽略缓存，把 ' + voicePages + ' 页全部重跑并覆盖音频，可能消耗额度。',
            { title: '强制重新配音', okText: '强制重配', danger: true },
          );
          if (ok) revoice({ force: true });
        })();
      }, 3000);
      const imageLongPress = useLongPress(() => {
        void (async () => {
          const ok = await confirmAction(
            '清空图片并重置种子后全量重出（' + (images ? images.total : 0) + ' 页）。',
            { title: '强制重新配图', okText: '强制重配', danger: true },
          );
          if (ok) regenImages({ force: true, reset: true });
        })();
      }, 3000);
      const runVoice = async () => {
        const estimate = await fetchEstimate('tts', { missingOnly: voiceState !== 'ready' });
        const estimateLine = estimateText(estimate);
        if (voiceState === 'ready') {
          const ok = await confirmAction(
            (estimateLine ? estimateLine + ' ' : '') + '会重跑 ' + voicePages + ' 页；命中缓存不产生费用。继续？',
            {
              title: '重新配音',
              okText: '重新配音',
            },
          );
          if (!ok) return;
          revoice({});
          return;
        }
        const ok = await confirmAction(
          (estimateLine ? estimateLine + ' ' : '') + '只补未配音页，命中缓存不产生费用。继续？',
          { title: '补配音', okText: '开始配音' },
        );
        if (!ok) return;
        revoice({ missingOnly: true });
      };
      const openQuality = async (lec) => {
        setQualityState({ n: lec.n, loading: true, error: '', quality: null, sections: lec.sections || [] });
        try {
          const out = await api('/lecture?seriesId=' + encodeURIComponent(series.id) + '&n=' + encodeURIComponent(lec.n));
          const quality = Object.assign(
            {},
            (out && out.slides && out.slides.quality) || (out && out.lecture && out.lecture.quality) || {},
            {
              plan_pages_stale: lec.plan_pages_stale === true
                || (lec.quality_summary && lec.quality_summary.plan_pages_stale === true),
            },
          );
          setQualityState({ n: lec.n, loading: false, error: '', quality, sections: lec.sections || [] });
        } catch (err) {
          setQualityState({ n: lec.n, loading: false, error: String((err && err.message) || err), quality: null, sections: lec.sections || [] });
        }
      };
      const replan = async () => {
        const ok = await confirmAction(
          '重规划会重建讲纲与计划页数；已生成的讲义保留，但需要重新生成才会采用新讲纲。',
          { title: '重规划', okText: '重规划' },
        );
        if (!ok) return;
        setBusy(true);
        try {
          const out = await api('/series/plan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ seriesId: series.id, force: true }),
          });
          if (!out || out.ok !== true) throw new Error((out && (out.error || out.code)) || '重规划失败');
          notify('已重规划，请重新生成讲义');
          await onReload();
        } catch (err) {
          notify(err.message || String(err));
        } finally {
          setBusy(false);
        }
      };
      const runImages = async () => {
        const estimate = await fetchEstimate('image', { force: imageState === 'done' });
        const estimateLine = estimateText(estimate);
        if (imageState === 'done') {
          const ok = await confirmAction(
            (estimateLine ? estimateLine + ' ' : '') + '会把 ' + (images ? images.total : 0) + ' 页全部重出（换种子）。继续？',
            {
              title: '重新配图',
              okText: '重新配图',
            },
          );
          if (!ok) return;
          regenImages({ force: true });
          return;
        }
        if (estimateLine) notify(estimateLine);
        regenImages({});
      };

      // 刷新/重挂载后，服务端作业还在跑，但本地 voiceJob/imageJob 已经归零。
      // 挂载时先查一次活动作业，后面的轮询和取消按钮才有依据。
      useEffect(() => {
        let alive = true;
        api('/revoice/job?seriesId=' + encodeURIComponent(series.id))
          .then((out) => {
            if (!alive) return;
            if (out && out.jobId && VOICE_ACTIVE.includes(String(out.status || ''))) {
              setVoiceJob(out);
            }
          })
          .catch((err) => {
            if (alive && err.code !== 'E_NOT_FOUND') notify(err.message);
          });
        return () => {
          alive = false;
        };
      }, [series.id, notify]);

      useEffect(() => {
        let alive = true;
        const wasActive = IMAGE_ACTIVE.includes(String((series.images && series.images.status) || 'none'));
        api('/image/status?seriesId=' + encodeURIComponent(series.id))
          .then((out) => {
            if (!alive) return;
            if (out && IMAGE_ACTIVE.includes(String(out.status || ''))) {
              setImageJob(out);
              return;
            }
            // 页面数据是在作业结束前取的：状态接口已经给出终态，刷新一次列表。
            if (wasActive) onReload();
          })
          .catch((err) => {
            if (alive && err.code !== 'E_NOT_FOUND') notify(err.message);
          });
        return () => {
          alive = false;
        };
      }, [series.id, notify, onReload]);

      const pollVoice = useCallback(async () => {
        if (!voiceJob || !voiceJob.jobId) return;
        try {
          const out = await api('/revoice/job?jobId=' + encodeURIComponent(voiceJob.jobId));
          setVoiceJob(out);
          if (!VOICE_ACTIVE.includes(String(out.status || ''))) {
            await onReload();
            const usageId = out.usageJobId || out.jobId;
            if (usageId) {
              api('/usage/job?jobId=' + encodeURIComponent(usageId))
                .then((result) => setJobUsage(result.job))
                .catch(() => {});
            }
          }
        } catch (err) {
          if (err.code === 'E_NOT_FOUND') {
            setVoiceJob(null);
            await onReload();
            return;
          }
          notify(err.message);
        }
      }, [voiceJob, notify, onReload]);

      useEffect(() => {
        if (!voiceActive) return undefined;
        const timer = setInterval(pollVoice, 1000);
        return () => clearInterval(timer);
      }, [voiceActive, pollVoice]);

      const pollImage = useCallback(async () => {
        try {
          const out = await api('/image/status?seriesId=' + encodeURIComponent(series.id));
          setImageJob(out);
          if (!IMAGE_ACTIVE.includes(String(out.status || ''))) {
            await onReload();
          }
        } catch (err) {
          if (err.code === 'E_NOT_FOUND') {
            setImageJob(null);
            await onReload();
            return;
          }
          notify(err.message);
        }
      }, [notify, onReload, series.id]);

      useEffect(() => {
        if (!imageActive) return undefined;
        const timer = setInterval(pollImage, 1000);
        return () => clearInterval(timer);
      }, [imageActive, pollImage]);

      /** 配图是独立动作（FR-24）：只补图片字段，不动文字与音频。 */
      const regenImages = async (opts = {}) => {
        setBusy(true);
        try {
          const body = { seriesId: series.id };
          if (opts.force) body.force = true;
          if (opts.reset) body.reset = true;
          if (opts.lecture != null) body.lecture = opts.lecture;
          const out = await api('/image/regen', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          setImageJob(out);
          notify((opts.reset ? '已开始强制重新配图（' : opts.force ? '已开始重新配图（' : '已开始补配图（') + out.total + ' 页）');
        } catch (err) {
          notify(
            err.code === 'E_IMG_DISABLED'
              ? '当前配图策略是「提示词占位」：到设置 → 配图切到「本地 ComfyUI」。'
              : err.message,
          );
        } finally {
          setBusy(false);
        }
      };
      const cancelImages = async () => {
        setBusy(true);
        try {
          const out = await api('/image/cancel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ seriesId: series.id }),
          });
          notify(out.cancelled ? '正在取消配图…' : '配图已经结束');
        } catch (err) {
          notify(err.message);
        } finally {
          setBusy(false);
        }
      };

      const poll = useCallback(async () => {
        try {
          const out = await api('/series/job?seriesId=' + encodeURIComponent(series.id));
          setJob(out);
          if (!activeStatus.includes(String(out.status || '')) && !doneRef.current) {
            doneRef.current = true;
            await onReload();
            const usageId = out.usageJobId || out.jobId;
            if (usageId) {
              api('/usage/job?jobId=' + encodeURIComponent(usageId))
                .then((result) => setJobUsage(result.job))
                .catch(() => {});
            }
          }
        } catch (err) {
          notify(err.message);
        }
      }, [series.id, notify, onReload]);

      useEffect(() => {
        if (!isActive) return undefined;
        const timer = setInterval(poll, 1000);
        return () => clearInterval(timer);
      }, [isActive, poll]);

      useEffect(() => {
        if (['drafting', 'stitching'].includes(String(series.status)) && !doneRef.current) poll();
      }, [series.status, poll]);

      const fetchEstimate = async (kind, extra) => {
        try {
          const out = await api('/usage/estimate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(Object.assign({ kind, seriesId: series.id }, extra || {})),
          });
          return out.estimate || null;
        } catch {
          return null;
        }
      };

      const estimateText = (estimate) => {
        if (!estimate) return '';
        if (estimate.local) return estimate.note || '本地调用，不产生云端费用。';
        const parts = [];
        if (estimate.tokens && (estimate.tokens.input || estimate.tokens.output)) {
          parts.push(
            '输入约 ' + formatTokens(estimate.tokens.input) + ' / 输出约 ' + formatTokens(estimate.tokens.output) + ' tokens',
          );
        }
        if (Number(estimate.chars)) parts.push(formatTokens(estimate.chars) + ' 字符');
        if (Number(estimate.images)) parts.push(estimate.images + ' 张');
        parts.push('预计 ' + formatMoney(estimate.cost));
        return (
          parts.join('，') +
          '（' + (estimate.level === 'rough' ? '粗估 ±50%' : '估算 ±30%') + '）' +
          (estimate.note ? '。' + estimate.note : '')
        );
      };

      const confirmEstimate = async (kind, extra, title, okText) => {
        const estimate = await fetchEstimate(kind, extra);
        const text = estimateText(estimate);
        return confirmAction(text ? text + ' 继续？' : '将开始作业，继续？', { title, okText });
      };

      const startJob = async (path, body) => {
        setBusy(true);
        setJobUsage(null);
        doneRef.current = false;
        try {
          const out = await api(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (out.cached) {
            notify('全部讲已就绪，无需重跑');
            await onReload();
            return;
          }
          setJob({
            status: 'drafting',
            stage: 'queued',
            lecture: 1,
            lecturesTotal: lectures.length,
            current: 0,
            total: 0,
            message: '已开始生成',
          });
          await poll();
        } catch (err) {
          notify(err.message);
        } finally {
          setBusy(false);
        }
      };

      const pendingLectures = lectures
        .filter((lec) => !READY_LECTURE.includes(String(lec.status)))
        .map((lec) => Number(lec.n));
      const start = async () => {
        if (!(await confirmEstimate('lecture', { scope: { lectures: pendingLectures } }, '开始生成讲义', '开始生成'))) return;
        startJob('/series/start', { seriesId: series.id });
      };
      const resume = async () => {
        if (!(await confirmEstimate('lecture', { scope: { lectures: pendingLectures } }, '续跑生成', '续跑'))) return;
        startJob('/series/resume', { seriesId: series.id });
      };
      const retry = async (n) => {
        if (!(await confirmEstimate('lecture', { scope: { lectures: [Number(n)] } }, '重跑第 ' + n + ' 讲', '重跑'))) return;
        startJob('/series/retry', { seriesId: series.id, lecture: n });
      };
      const generateOne = async (n) => {
        if (!(await confirmEstimate('lecture', { scope: { lectures: [Number(n)] } }, '生成本讲', '开始生成'))) return;
        startJob('/series/lecture/generate', { seriesId: series.id, n });
      };

      /** 配音是独立动作（FR-23）：只调 /revoice，等它自己跑完；文本状态不受影响。 */
      const revoice = async (opts = {}) => {
        setBusy(true);
        try {
          const body = { seriesId: series.id };
          if (opts.force) body.force = true;
          if (opts.missingOnly) body.missingOnly = true;
          if (opts.lecture != null) body.lecture = opts.lecture;
          const out = await api('/revoice', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          setVoiceJob({ jobId: out.jobId, status: 'queued', current: 0, total: 0, message: '已排队' });
          setJobUsage(null);
          notify((opts.force ? '已开始强制重新配音' : opts.missingOnly ? '已开始补配音' : '已开始重新配音') + '（' + (out.scope ? out.scope.length : 0) + ' 讲）');
        } catch (err) {
          notify(
            err.code === 'E_TTS_UNCONFIGURED'
              ? '语音没配置好：到设置页填 Qwen Key / 配置 ComfyUI 工作流，或改用浏览器朗读。'
              : (err.code ? err.code + '：' : '') + err.message,
          );
        } finally {
          setBusy(false);
        }
      };
      const cancelVoice = async () => {
        if (!voiceJob || !voiceJob.jobId) return;
        setBusy(true);
        try {
          const out = await api('/revoice/cancel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId: voiceJob.jobId }),
          });
          notify(out.cancelled ? '正在取消配音…' : '配音已经结束');
        } catch (err) {
          notify(err.message);
        } finally {
          setBusy(false);
        }
      };
      /** 删除系列（AC-130）：先取消作业，再删系列目录；书与 Part 保留。 */
      const removeSeries = async () => {
        const confirmed = await confirmAction('删除系列《' + series.title + '》？运行中的作业会先取消，书与 Part 不受影响。', {
          title: '删除系列',
          okText: '删除',
          danger: true,
        });
        if (!confirmed) return;
        setBusy(true);
        try {
          const out = await api('/series?seriesId=' + encodeURIComponent(series.id), { method: 'DELETE' });
          notify(out.cancelledJob ? '已取消作业并删除系列' : '系列已删除');
          setStitch(null);
          await onReload();
        } catch (err) {
          notify(err.message);
        } finally {
          setBusy(false);
        }
      };
      const cancel = async () => {
        setBusy(true);
        try {
          const out = await api('/series/cancel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ seriesId: series.id }),
          });
          notify(out.cancelled ? '正在取消…' : '作业已经结束');
          await poll();
        } catch (err) {
          notify(err.message);
        } finally {
          setBusy(false);
        }
      };
      const openStitch = async () => {
        setBusy(true);
        try {
          const out = await api('/series/stitch?seriesId=' + encodeURIComponent(series.id));
          setStitch(out.stitch);
          await onReload();
        } catch (err) {
          notify(err.message);
        } finally {
          setBusy(false);
        }
      };
      const repairStitch = async () => {
        setBusy(true);
        try {
          const out = await api('/series/stitch/repair', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ seriesId: series.id }),
          });
          setStitch(out.stitch);
          notify(out.unresolved && out.unresolved.length ? '还有 ' + out.unresolved.length + ' 项未修复' : '缝合报告已刷新');
          await onReload();
        } catch (err) {
          notify(err.message);
        } finally {
          setBusy(false);
        }
      };

      const stageText = (() => {
        if (voiceActive && voiceJob) {
          return '配音 · ' + formatJobLine(voiceJob, lectures.length) + (voiceJob.message ? ' · ' + voiceJob.message : '');
        }
        if (isActive && job) {
          if (job.stage === 'stitching') return '正在做后验缝…';
          return formatJobLine(job, lectures.length) + (job.message ? ' · ' + job.message : '');
        }
        if (series.status === 'drafting' || series.status === 'stitching') return '正在生成，请稍候…';
        if (series.status === 'partial') return '部分讲未就绪';
        if (series.status === 'failed') return '生成失败';
        if (series.status === 'cancelled') return '已取消，可续跑';
        if (series.status === 'interrupted') return '上次生成被中断，可续跑';
        return '';
      })();
      const progress = isActive && job && job.total ? Math.min(100, Math.round(((job.current || 0) / job.total) * 100)) : 0;

      return h(
        'div',
        { className: 'blm-series-card' },
        h(
          'div',
          { className: 'blm-series-head' },
          h('strong', null, series.title),
          h('span', { className: 'blm-badge' + (series.status === 'ready' ? ' ok' : '') }, series.status),
          h('span', { className: 'blm-dim' }, lectures.length + ' 讲 · ' + (series.total_pages || 0) + ' 页'
            + (plannedTotal && plannedTotal !== Number(series.total_pages) ? '（计划 ' + plannedTotal + '）' : '')),
          h('div', { style: { flex: 1 } }),
          h(
            'div',
            { className: 'blm-series-actions' },
            playable.length && !isActive
              ? h('button', { className: 'blm-btn primary', disabled: busy, onClick: () => onPlay(series, playable[0].n) }, '继续听')
              : null,
            series.status === 'planned' && !isActive
              ? h('button', { className: 'blm-btn primary', disabled: busy, onClick: start }, '开始生成讲义')
              : null,
            ['partial', 'failed', 'cancelled', 'interrupted'].includes(series.status) && !isActive
              ? h('button', { className: 'blm-btn primary', disabled: busy, onClick: resume }, '续跑')
              : null,
            playable.length
              ? h(
                  'button',
                  Object.assign(
                    {
                      className: 'blm-btn holdable' + (voiceLongPress.active ? ' holding' : ''),
                      disabled: busy || voiceActive || isActive,
                      title: voiceState === 'ready'
                        ? '重新配音（二次确认，命中缓存不产生费用）；长按 3s 强制重配'
                        : voiceState === 'partial'
                          ? '只补缺失页，不改文字；长按 3s 强制重配'
                          : '全部页生成音频；长按 3s 强制重配',
                    },
                    voiceLongPress.props,
                    {
                      onClick: () => {
                        if (voiceLongPress.wasLongPress()) return;
                        runVoice();
                      },
                    },
                  ),
                  h('span', null, voiceActive ? '配音中…' : voiceLabel),
                  voiceLongPress.active
                    ? h('span', { className: 'blm-hold-count' }, voiceLongPress.secondsLeft + 's')
                    : null,
                  voiceLongPress.active
                    ? h(
                        'span',
                        { className: 'blm-hold-bar', 'aria-hidden': 'true' },
                        h('i', { style: { width: Math.round(voiceLongPress.progress * 100) + '%' } }),
                      )
                    : null,
                )
              : null,
            voiceActive
              ? h('button', { className: 'blm-btn', disabled: busy, onClick: cancelVoice }, '取消配音')
              : null,
            playable.length
              ? h('button', { className: 'blm-btn', disabled: busy || isActive, onClick: () => setPracticeOpen(true) }, '练一练')
              : null,
            playable.length
              ? h('button', { className: 'blm-btn', disabled: busy || isActive, onClick: () => setExportOpen(true) }, '导出')
              : null,
            playable.length
              ? h(
                  'button',
                  Object.assign(
                    {
                      className: 'blm-btn holdable' + (imageLongPress.active ? ' holding' : ''),
                      disabled: busy || isActive || imageActive,
                      title: imageState === 'done'
                        ? '重新配图（二次确认，全部换种子）；长按 3s 清空后强制重出'
                        : imageState === 'partial'
                          ? '只补缺失页，不改文字与音频；长按 3s 强制重出'
                          : '生成配图；长按 3s 强制重出',
                    },
                    imageLongPress.props,
                    {
                      onClick: () => {
                        if (imageLongPress.wasLongPress()) return;
                        runImages();
                      },
                    },
                  ),
                  h('span', null, imageActive ? '配图中…' : imageLabel),
                  imageLongPress.active
                    ? h('span', { className: 'blm-hold-count' }, imageLongPress.secondsLeft + 's')
                    : null,
                  imageLongPress.active
                    ? h(
                        'span',
                        { className: 'blm-hold-bar', 'aria-hidden': 'true' },
                        h('i', { style: { width: Math.round(imageLongPress.progress * 100) + '%' } }),
                      )
                    : null,
                )
              : null,
            imageActive ? h('button', { className: 'blm-btn', disabled: busy, onClick: cancelImages }, '取消配图') : null,
            ['ready', 'partial', 'failed'].includes(series.status)
              ? h('button', { className: 'blm-btn', disabled: busy, onClick: openStitch }, '缝合报告')
              : null,
            ['drafting', 'stitching'].includes(series.status) || isActive
              ? h('button', { className: 'blm-btn', disabled: busy, onClick: cancel }, '取消')
              : null,
            h('button', { className: 'blm-btn', disabled: busy, onClick: removeSeries, title: '删除系列；书与 Part 保留' }, '删除'),
          ),
        ),
        h(
          'div',
          { className: 'blm-row', style: { fontSize: 11 } },
          h('span', { className: 'blm-badge' + (series.voice_status === 'ready' ? ' ok' : '') }, voiceText),
          playable.length ? h('span', { className: 'blm-badge' + ((series.images || {}).status === 'done' ? ' ok' : '') }, imageText) : null,
          series.stitch && ['ready', 'partial'].includes(series.status)
            ? h('span', { className: 'blm-badge' + (['stitched', 'verified'].includes(series.stitch) ? ' ok' : '') },
                series.stitch === 'verified' ? '已验收' : series.stitch === 'stitched' ? '已衔接' : '未衔接')
            : null,
          qualityWarnings.length
            ? h('button', {
                className: 'blm-badge warn',
                style: { cursor: 'pointer' },
                title: '点击查看质量与密度明细',
                onClick: () => openQuality(qualityWarnings[0]),
              }, '质量待核对 ' + qualityWarnings.length + ' 讲')
            : null,
          overBudgetCount
            ? h('span', { className: 'blm-badge warn', title: '计划/实际页数差，不自动压页' }, '超预算 ' + overBudgetCount + ' 讲')
            : null,
          pagesStale.length
            ? h('button', {
                className: 'blm-badge warn',
                style: { cursor: 'pointer' },
                title: '旧系列的计划页数可能已被实际页数覆盖；重规划可恢复',
                onClick: replan,
              }, '计划页数需重规划 ' + pagesStale.length + ' 讲')
            : null,
          snapshotVersion
            ? h('span', {
                className: 'blm-badge warn',
                title: 'Part 已更新；本系列仍基于创建时的章快照，内容未变',
              }, '基于旧快照（v' + snapshotVersion + '）')
            : null,
        ),
        series.voice_code || series.voice_error
          ? h(
              'div',
              { className: 'blm-note warn' },
              '配音：' + (series.voice_code || 'E_TTS_FAIL') +
                (voiceFailedLectures.length ? ' · ' + voiceFailedLectures.length + ' 讲未完成' : '') +
                (series.voice_error ? ' · ' + series.voice_error : ''),
            )
          : null,
        images && (images.code || images.error) && !imageActive
          ? h(
              'div',
              { className: 'blm-note warn' },
              '配图：' + (images.code || 'E_IMG_FAIL') + (images.error ? ' · ' + images.error : ''),
            )
          : null,
        stageText ? h('div', { className: 'blm-dim', style: { fontSize: 12 } }, stageText) : null,
        jobUsage
          ? h(
              'div',
              { className: 'blm-note' },
              '本次用量：' +
                usageSummaryLine(jobUsage) +
                (jobUsage.estimate && jobUsage.estimate.cost != null
                  ? '（预估 ' + formatMoney(jobUsage.estimate.cost) + '）'
                  : ''),
            )
          : null,
        job && !isActive && job.usageBilling === 'local'
          ? h('div', { className: 'blm-dim', style: { fontSize: 11 } }, '本地调用，未计入用量与费用')
          : null,
        voiceJob && !voiceActive && voiceJob.usageBilling === 'local'
          ? h('div', { className: 'blm-dim', style: { fontSize: 11 } }, '本地配音，未计入用量与费用')
          : null,
        progress ? h('div', { className: 'blm-progress' }, h('i', { style: { width: progress + '%' } })) : null,
        series.error && ['failed', 'partial'].includes(series.status)
          ? h('div', { className: 'blm-note' }, (series.code ? series.code + '：' : '') + series.error)
          : null,
        lectures.length
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              lectures.map((lec) => {
                const jobLec = isActive && job && Number(job.lecture) === Number(lec.n);
                const actualPages = Number(lec.actual_pages) || Number(lec.pages) || 0;
                const plannedPages = Number(lec.planned_pages) || Number(lec.pages) || 0;
                const text = jobLec
                  ? '第 ' + (job.current || 0) + '/' + (job.total || 0) + ' 页'
                  : actualPages + ' 页' + (plannedPages && plannedPages !== actualPages ? '（计划 ' + plannedPages + '）' : '') + ' · ' + (lec.chars || 0) + ' 字';
                return h(
                  'div',
                  { className: 'blm-series-lec', key: lec.n },
                  h('span', { className: 'blm-dim' }, '第 ' + lec.n + ' 讲'),
                  h('span', { className: 'grow', title: lec.title }, lec.title),
                  h('span', { className: 'blm-badge' + (['ready', 'ready_degraded'].includes(lec.status) ? ' ok' : '') }, lec.status),
                  lec.quality_summary && (lec.quality_summary.content_ok === false || lec.quality_summary.density_ok === false)
                    ? h('button', {
                        className: 'blm-badge warn',
                        style: { cursor: 'pointer' },
                        title: '内容/密度待核对',
                        onClick: () => openQuality(lec),
                      }, lec.quality_summary.content_ok === false ? '内容待核对' : '密度偏低')
                    : null,
                  lec.quality_summary && lec.quality_summary.over_budget
                    ? h('span', { className: 'blm-badge warn', title: '计划/实际页数差；不自动压页' }, '超预算')
                    : null,
                  lec.plan_pages_stale || (lec.quality_summary && lec.quality_summary.plan_pages_stale)
                    ? h('button', {
                        className: 'blm-badge warn',
                        style: { cursor: 'pointer' },
                        title: '计划页数可能已被实际页数覆盖；点击重规划',
                        onClick: replan,
                      }, '计划待重规划')
                    : null,
                  ['failed', 'partial'].includes(String(lec.voice_status || ''))
                    ? h(
                        'span',
                        { className: 'blm-badge blm-bad', title: lec.voice_error || '' },
                        lec.voice_status === 'failed' ? '配音失败' : '部分未配',
                      )
                    : null,
                  h('span', { className: 'blm-dim' }, text),
                  ['failed', 'cancelled', 'interrupted'].includes(lec.status)
                    ? h('button', { className: 'blm-btn', disabled: busy || isActive, onClick: () => retry(lec.n) }, '重试')
                    : null,
                  ['draft', 'planned', 'queued'].includes(lec.status) && !isActive
                    ? h('button', { className: 'blm-btn', disabled: busy, onClick: () => generateOne(lec.n) }, '生成本讲')
                    : null,
                  ['ready', 'ready_degraded'].includes(lec.status) && !isActive
                    ? h('button', { className: 'blm-btn', disabled: busy, onClick: () => generateOne(lec.n) }, '重新生成')
                    : null,
                );
              }),
            )
          : null,
        stitch
          ? h(
              'div',
              { className: 'blm-modal-mask' },
              h(
                'div',
                { className: 'blm-modal blm-plan-modal' },
                h(
                  'div',
                  { className: 'blm-row' },
                  h('strong', null, '后验缝报告'),
                  h('span', { className: 'blm-badge' + (['stitched', 'verified'].includes(stitch.state) ? ' ok' : '') }, stitch.state),
                  h('div', { style: { flex: 1 } }),
                  h('button', { className: 'blm-btn', onClick: () => setStitch(null) }, '关闭'),
                ),
                h(
                  'div',
                  { className: 'blm-stitch-table' },
                  (stitch.metrics || []).map((metric) =>
                    h(
                      'div',
                      { className: 'blm-stitch-metric', key: metric.id },
                      h('span', { className: 'grow' }, metric.label),
                      h('span', { className: metric.ok ? 'blm-ok' : 'blm-bad' },
                        Array.isArray(metric.value)
                          ? metric.value.map((item) => '第 ' + item.n + ' 讲 ρ=' + item.rho).join('；')
                          : String(metric.value)),
                      metric.warn ? h('span', { className: 'blm-bad' }, '密度告警') : null,
                    ),
                  ),
                ),
                (stitch.failures || []).length
                  ? h(
                      'div',
                      null,
                      h('div', { className: 'blm-dim' }, '失败项'),
                      (stitch.failures || []).map((failure, index) =>
                        h('div', { className: 'blm-plan-line', key: index },
                          (failure.lecture ? '第 ' + failure.lecture + ' 讲' : '系列') + ' · ' + failure.message + '（' + failure.action + '）'),
                      ),
                    )
                  : h('div', { className: 'blm-dim' }, '六项指标全部通过。'),
                (stitch.warnings || []).length ? h('div', { className: 'blm-note' }, stitch.warnings.join(' ')) : null,
                h(
                  'div',
                  { className: 'blm-row', style: { marginTop: 8 } },
                  h('button', { className: 'blm-btn primary', disabled: busy, onClick: repairStitch }, '一键修复（接缝/术语/重复页）'),
                  h('span', { className: 'blm-dim' }, '重复页在模型可用时重写该页；不修不影响播放。'),
                ),
              ),
            )
          : null,
        practiceOpen ? h(PracticePanel, { series, notify, onClose: () => setPracticeOpen(false) }) : null,
        exportOpen ? h(ExportDialog, { series, notify, onClose: () => setExportOpen(false) }) : null,
        qualityState ? h(QualityPanel, { state: qualityState, onClose: () => setQualityState(null) }) : null,
      );
    }

    /** Part 编辑弹窗（AC-93）：改名、移出本 Part 的章、加入未归属的章。 */
    function PartEditDialog({ draft, chapters, partOf, busy, error, onTitle, onToggle, onSave, onClose }) {
      const original = Array.isArray(draft.original) ? draft.original.map(Number) : [];
      return h(
        'div',
        {
          className: 'blm-modal-mask',
          onClick: (event) => {
            if (event.target === event.currentTarget && !busy) onClose();
          },
        },
        h(
          'div',
          { className: 'blm-modal blm-plan-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '编辑 Part' },
          h(
            'div',
            { className: 'blm-row' },
            h('strong', null, '编辑 Part'),
            h('div', { style: { flex: 1 } }),
            h('button', { className: 'blm-btn', disabled: busy, onClick: onClose }, '关闭'),
          ),
          h('div', { className: 'blm-dim', style: { marginTop: 6, fontSize: 12 } },
            '改名或增删章后 part_version 递增；其系列会显示「基于旧快照」。'),
          h(
            'label',
            { className: 'blm-row', style: { marginTop: 10 } },
            h('span', { className: 'blm-dim' }, '标题'),
            h('input', {
              className: 'blm-select',
              style: { flex: 1, minWidth: 0 },
              value: draft.title || '',
              placeholder: 'Part 标题',
              disabled: busy,
              onChange: (event) => onTitle(event.target.value),
            }),
          ),
          error ? h('div', { className: 'blm-error', style: { marginTop: 8 } }, error) : null,
          h('div', { className: 'blm-dim', style: { marginTop: 8, fontSize: 11 } },
            '取消勾选 = 从本 Part 移出；勾选 = 加入本 Part。已被其它 Part 占用的章需先在原 Part 移出，再加入本 Part。'),
          h(
            'div',
            { className: 'blm-chapters', style: { maxHeight: '42vh', overflow: 'auto' } },
            chapters.map((c) => {
              const n = Number(c.n);
              const ownedByThis = original.includes(n);
              const other = !ownedByThis && partOf.get(n);
              const remove = (draft.remove || []).map(Number);
              const add = (draft.add || []).map(Number);
              const checked = ownedByThis ? !remove.includes(n) : add.includes(n);
              const status = c.front === true
                ? '前文'
                : ownedByThis
                  ? remove.includes(n) ? '将移出' : '本 Part'
                  : other
                    ? '属于《' + (other.title || '其它 Part') + '》'
                    : add.includes(n) ? '将加入' : '可加入';
              return h(
                'div',
                {
                  className: 'blm-chapter' + (ownedByThis ? ' owns' : ''),
                  key: c.n + '-' + c.from,
                  style: { gridTemplateColumns: '22px 34px 1fr 130px' },
                },
                h('input', {
                  type: 'checkbox',
                  checked,
                  disabled: c.front === true || !!other || busy,
                  onChange: () => onToggle(n, ownedByThis),
                  title: other ? '该章属于《' + (other.title || '其它 Part') + '》，先移出再加入' : ownedByThis ? '取消勾选会从本 Part 移出' : '加入本 Part',
                }),
                h('span', { className: 'blm-dim' }, String(c.n ?? '')),
                h('span', { className: 't', title: c.title }, c.title),
                h('span', { className: 'blm-dim', style: { textAlign: 'right', fontSize: 11 } }, status),
              );
            }),
          ),
          h(
            'div',
            { className: 'blm-row', style: { marginTop: 10, justifyContent: 'flex-end' } },
            h('button', { className: 'blm-btn', disabled: busy, onClick: onClose }, '取消'),
            h('button', { className: 'blm-btn primary', disabled: busy, onClick: onSave }, busy ? '保存中…' : '保存修改'),
          ),
        ),
      );
    }

    /* ------------------------------ 分章面板 ------------------------------ */

    const SOURCE_LABELS = {
      bookmark: '书签',
      printed_toc: '目录',
      mechanical: '机械',
      manual: '手动',
      auto: '机械',
      toc: '目录',
      mech: '机械',
    };
    const ATTEMPT_LABELS = { used: '已用', empty: '无结果', failed: '失败', skipped: '跳过' };

    function sourceLabel(source) {
      return SOURCE_LABELS[String(source || '')] || '';
    }

    function chapterSourceLabel(chapter) {
      if (!chapter) return '';
      if (chapter.front === true) return '前文';
      if (chapter.manual === true) return '手动';
      return sourceLabel(chapter.source);
    }

    /** AC-157：自动/高级两个入口的请求体，纯函数便于静态测试。 */
    function chapterBuildRequest({
      bookId,
      advancedOpen,
      advancedSource,
      tocFrom,
      tocTo,
      force,
      outlineDepth,
      modeOverride,
    }) {
      const mode = modeOverride || (advancedOpen ? advancedSource : 'auto');
      const body = { bookId, mode };
      if (force === true) body.force = true;
      if (Number.isInteger(outlineDepth) && outlineDepth >= 0) body.outlineDepth = outlineDepth;
      if (mode === 'printed_toc') {
        body.range = { from: Number(tocFrom) || 0, to: Number(tocTo) || 0 };
      }
      return body;
    }

    function childNodesAtDepth(nodes, depth, out = []) {
      for (const node of Array.isArray(nodes) ? nodes : []) {
        if (Number(node && node.depth) === depth) out.push(node);
        if (node && Array.isArray(node.children) && node.children.length) {
          childNodesAtDepth(node.children, depth, out);
        }
      }
      return out;
    }

    /** 从 book.bookmarkTree 恢复单根提示所需的 outline 元信息（重开后也能提示）。 */
    function outlineInfo(book) {
      if (!book || book.chapterSource !== 'bookmark') return null;
      if (!Array.isArray(book.bookmarkTree) || !book.bookmarkTree.length) return null;
      const rootDepth = Number.isInteger(book.bookmarkRootDepth) ? book.bookmarkRootDepth : 0;
      const total = Number(book.pages) || 0;
      const valid = (nodes) => {
        const lastByPage = new Map();
        const order = [];
        for (const node of nodes) {
          const page = Number(node && node.page) || 0;
          if (!node || !node.title || page < 1 || page > total) continue;
          if (!lastByPage.has(page)) order.push(page);
          lastByPage.set(page, node);
        }
        const entries = [];
        for (const page of order) {
          const node = lastByPage.get(page);
          if (entries.length && page <= entries[entries.length - 1].page) continue;
          entries.push(node);
        }
        return entries;
      };
      const roots = valid(childNodesAtDepth(book.bookmarkTree, rootDepth));
      const next = valid(childNodesAtDepth(book.bookmarkTree, rootDepth + 1));
      return {
        rootDepth,
        rootCount: roots.length,
        canDescend: next.length > 0,
        nextDepth: rootDepth + 1,
        nextCount: next.length,
      };
    }

    function countDescendants(node) {
      let count = 0;
      for (const child of (node && node.children) || []) {
        count += 1 + countDescendants(child);
      }
      return count;
    }

    /** 书签树：根可勾选/展开，子节点缩进只读；单根提示与回到顶层。 */
    function ChapterTree({
      tree,
      rootDepth,
      chapters,
      partOf,
      selected,
      busy,
      expanded,
      outline,
      onToggleExpand,
      onToggleChapter,
      onDescend,
      onKeep,
      onTop,
    }) {
      const roots = childNodesAtDepth(tree, rootDepth).filter((node) => Number.isInteger(node.n));
      if (!roots.length) return null;
      const chapterOf = (n) => (chapters || []).find((chapter) => Number(chapter.n) === Number(n)) || null;
      const totalChildren = roots.reduce((sum, node) => sum + countDescendants(node), 0);
      const firstChapter = chapterOf(roots[0].n);
      const isOpen = (n) => !!(expanded && typeof expanded.has === 'function' && expanded.has(Number(n)));

      const childRows = (node, level, open) => {
        const rows = [];
        for (const child of node.children || []) {
          rows.push(
            h(
              'div',
              {
                className: 'blm-chapter blm-chapter-child',
                key: 'child-' + node.n + '-' + level + '-' + child.page + '-' + child.title,
                style: { paddingLeft: 10 + level * 18 + 'px' },
              },
              h('span'),
              h('span'),
              h('span'),
              h('span', { className: 't', title: child.title }, child.title),
              h('span', { className: 'blm-dim' }, child.page ? 'p' + child.page : ''),
              h('span'),
              h('span'),
              h('span'),
            ),
          );
          if (open && child.children && child.children.length) {
            rows.push(...childRows(child, level + 1, open));
          }
        }
        return rows;
      };

      const rootRows = [];
      for (const node of roots) {
        const chapter = chapterOf(node.n);
        if (!chapter) continue;
        const owner = partOf && typeof partOf.get === 'function' ? partOf.get(Number(chapter.n)) || null : null;
        const state = chapterSelectionState({
          n: Number(chapter.n),
          front: chapter.front === true,
          owner,
          selected,
          busy,
        });
        const open = isOpen(node.n);
        const canExpand = !!(node.children && node.children.length);
        rootRows.push(
          h(
            'div',
            { className: 'blm-chapter blm-chapter-root' + (owner ? ' owns' : ''), key: 'root-' + node.n },
            canExpand
              ? h(
                  'button',
                  {
                    className: 'blm-tree-toggle',
                    type: 'button',
                    'aria-label': open ? '收起子节' : '展开子节',
                    onClick: () => onToggleExpand && onToggleExpand(Number(node.n)),
                  },
                  open ? '▾' : '▸',
                )
              : h('span'),
            h('input', {
              type: 'checkbox',
              checked: state.checked,
              disabled: state.disabled,
              onChange: () => onToggleChapter && onToggleChapter(Number(chapter.n)),
              title: state.title,
            }),
            h('span', { className: 'blm-dim' }, String(chapter.n)),
            h('span', { className: 't', title: chapter.title }, chapter.title),
            h('span', { className: 'blm-dim' }, 'p' + chapter.from),
            h('span', { className: 'blm-dim' }, 'p' + chapter.to),
            h(ChapterSourceBadge, { chapter }),
            h(
              'span',
              { className: 'blm-dim', style: { fontSize: 10, textAlign: 'right' } },
              owner ? '属于 ' + owner.title : canExpand ? countDescendants(node) + ' 节' : '',
            ),
          ),
        );
        if (open && canExpand) rootRows.push(...childRows(node, 1, true));
      }

      return h(
        'div',
        { className: 'blm-tree' },
        h(
          'div',
          { className: 'blm-tree-head' },
          h('strong', null, roots.length + ' 章 · ' + totalChildren + ' 节'),
          h('span', { className: 'blm-dim', style: { fontSize: 10 } }, '子节页码为书签原页'),
          rootDepth > 0 && onTop
            ? h('button', { className: 'blm-btn', disabled: busy, onClick: onTop }, '回到顶层')
            : null,
        ),
        outline && outline.rootCount === 1
          ? h(
              'div',
              { className: 'blm-single-root' },
              h(
                'div',
                null,
                '书签顶层只有 1 条《' +
                  String((firstChapter && firstChapter.title) || roots[0].title || '') +
                  '》。' +
                  (outline.canDescend
                    ? '是否下移一层（' + outline.nextCount + ' 条）导入？'
                    : '书签只有 1 个根。'),
              ),
              outline.canDescend
                ? h(
                    'div',
                    { className: 'blm-row' },
                    h('button', { className: 'blm-btn primary', disabled: busy, onClick: onDescend }, '下移一层导入'),
                    h('button', { className: 'blm-btn', disabled: busy, onClick: onKeep }, '保持 1 章'),
                  )
                : null,
            )
          : null,
        h('div', { className: 'blm-chapters blm-chapters-tree' }, rootRows),
      );
    }

    function ChapterSourceBadge({ chapter }) {
      const label = chapterSourceLabel(chapter);
      if (!label) return null;
      return h('span', { className: 'blm-badge blm-src' }, label);
    }

    function ChapterBuildPanel({
      built, advancedOpen, advancedSource, tocFrom, tocTo, suggested, tocPreview,
      busy, source, confidence, warnings, attempts, manualCount,
      onToggleAdvanced, onSource, onFrom, onTo, onPreview, onBuild, onClose, onRefreshBookmark,
    }) {
      const bookmarkFileRef = useRef(null);
      const sourceText = sourceLabel(source);
      const confidenceValue =
        confidence === null || confidence === undefined || confidence === '' ? NaN : Number(confidence);
      const confidenceText = Number.isFinite(confidenceValue) ? confidenceValue.toFixed(2) : '';
      const warningList = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
      const attemptList = Array.isArray(attempts) ? attempts.filter(Boolean) : [];
      return h(
        'div',
        { className: 'blm-build' },
        h(
          'div',
          { className: 'blm-row' },
          h(
            'button',
            { className: 'blm-btn primary', disabled: busy, onClick: onBuild },
            busy ? '正在分章…' : advancedOpen ? '按此方式分章' : '自动分章',
          ),
          h('button', { className: 'blm-btn', disabled: busy, onClick: onToggleAdvanced }, advancedOpen ? '收起高级' : '高级'),
          onRefreshBookmark
            ? h('button', {
                className: 'blm-btn',
                disabled: busy,
                title: '只刷新书签树，不改章节/Part；可重抽 PDF outline',
                onClick: () => onRefreshBookmark({ source: 'pdf' }),
              }, '刷新书签')
            : null,
          onRefreshBookmark
            ? h(React.Fragment, null,
                h('button', {
                  className: 'blm-btn',
                  disabled: busy,
                  title: '导入外部书签 XML（如 PDF 阅读器导出）',
                  onClick: () => bookmarkFileRef.current && bookmarkFileRef.current.click(),
                }, '导入 XML'),
                h('input', {
                  type: 'file',
                  accept: '.xml,text/xml,application/xml',
                  ref: bookmarkFileRef,
                  style: { display: 'none' },
                  onChange: (event) => {
                    const file = event.target.files && event.target.files[0];
                    event.target.value = '';
                    if (file) onRefreshBookmark({ source: 'xml', file });
                  },
                }),
              )
            : null,
          advancedOpen
            ? h(
                React.Fragment,
                null,
                h('span', { className: 'blm-dim' }, '强制来源'),
                h(
                  'button',
                  {
                    className: 'blm-btn' + (advancedSource === 'printed_toc' ? ' on' : ''),
                    disabled: busy,
                    onClick: () => onSource('printed_toc'),
                  },
                  '印刷目录',
                ),
                h(
                  'button',
                  {
                    className: 'blm-btn' + (advancedSource === 'mechanical' ? ' on' : ''),
                    disabled: busy,
                    onClick: () => onSource('mechanical'),
                  },
                  '机械切章',
                ),
              )
            : null,
          h('div', { style: { flex: 1 } }),
          built && onClose ? h('button', { className: 'blm-btn', disabled: busy, onClick: onClose }, '收起') : null,
        ),
        advancedOpen && advancedSource === 'printed_toc'
          ? h(
              'div',
              { className: 'blm-build-advanced' },
              h('span', { className: 'blm-dim' }, '目录页'),
              h('input', {
                className: 'blm-num',
                type: 'number',
                min: 1,
                placeholder: '起始页',
                value: tocFrom,
                disabled: busy,
                onChange: (event) => onFrom(event.target.value),
              }),
              h('span', { className: 'blm-dim' }, '–'),
              h('input', {
                className: 'blm-num',
                type: 'number',
                min: 1,
                placeholder: '结束页',
                value: tocTo,
                disabled: busy,
                onChange: (event) => onTo(event.target.value),
              }),
              h('button', { className: 'blm-btn', disabled: busy, onClick: onPreview }, '预览这几页'),
              suggested
                ? h('span', { className: 'blm-dim' }, '建议 ' + suggested.from + '–' + suggested.to + ' 页')
                : h('span', { className: 'blm-dim' }, '没猜出目录页，请手填'),
            )
          : null,
        advancedOpen && advancedSource === 'mechanical'
          ? h('div', { className: 'blm-dim blm-build-hint' }, '机械切章 = 1.x 的页眉/章号行正则；不是按页数/字数切块。')
          : null,
        advancedOpen && tocPreview ? h('pre', { className: 'blm-build-preview' }, tocPreview) : null,
        h('div', { className: 'blm-dim blm-build-hint' }, '自动分章按 书签 → 印刷目录 → 机械切章 依次尝试；无标题长书由讲次规划拆讲。'),
        manualCount > 0
          ? h('div', { className: 'blm-dim blm-build-hint' }, '有 ' + manualCount + ' 个手动修改过的章；重新分章会先确认再覆盖。')
          : null,
        built && (sourceText || confidenceText || warningList.length)
          ? h(
              'div',
              { className: 'blm-build-summary' },
              h(
                'div',
                { className: 'blm-row' },
                h('strong', null, '本次来源：' + (sourceText || '未知')),
                confidenceText ? h('span', { className: 'blm-badge' }, '置信度 ' + confidenceText) : null,
              ),
              warningList.map((warning, index) => h('div', { className: 'blm-note warn', key: index }, warning)),
            )
          : null,
        attemptList.length
          ? h(
              'details',
              { className: 'blm-build-attempts' },
              h('summary', null, '为什么用这个来源'),
              attemptList.map((item, index) =>
                h(
                  'div',
                  { key: index, className: 'blm-dim' },
                  sourceLabel(item.source) +
                    '：' +
                    (ATTEMPT_LABELS[String(item.result || '')] || String(item.result || '')) +
                    (item.reason ? '（' + item.reason + '）' : '') +
                    (item.chapters ? ' · ' + item.chapters + ' 章' : ''),
                ),
              ),
            )
          : null,
      );
    }

    function Detail({ bookId, onBack, onChanged, notify, onPlay }) {
      const [data, setData] = useState(null);
      const [parts, setParts] = useState([]);
      const [series, setSeries] = useState([]);
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState(false);
      const [buildOpen, setBuildOpen] = useState(false);
      const [bookmarkBusy, setBookmarkBusy] = useState(false);
      const [advancedOpen, setAdvancedOpen] = useState(false);
      const [advancedSource, setAdvancedSource] = useState('printed_toc');
      const [tocFrom, setTocFrom] = useState('');
      const [tocTo, setTocTo] = useState('');
      const [tocSuggested, setTocSuggested] = useState(null);
      const [tocPreview, setTocPreview] = useState('');
      const [chapterWarnings, setChapterWarnings] = useState([]);
      const [chapterAttempts, setChapterAttempts] = useState([]);
      const [chapterOutline, setChapterOutline] = useState(null);
      const [treeExpanded, setTreeExpanded] = useState(() => new Set());
      const [draft, setDraft] = useState([]);
      const [editing, setEditing] = useState(false);
      const [selected, setSelected] = useState([]);
      const [plan, setPlan] = useState(null);
      const [planPartId, setPlanPartId] = useState('');
      const [planWarnings, setPlanWarnings] = useState([]);
      const [savingSeries, setSavingSeries] = useState(false);
      const [partEdit, setPartEdit] = useState(null);
      const [flashPartId, setFlashPartId] = useState('');
      const [longOp, setLongOp] = useState('');
      const partRefs = useRef({});
      const longRequestRef = useRef(null);
      const tocBookRef = useRef('');

      const beginLong = (label) => {
        if (longRequestRef.current) {
          try {
            longRequestRef.current.abort();
          } catch {
            /* 已经结束 */
          }
        }
        const controller = new AbortController();
        longRequestRef.current = controller;
        setLongOp(label);
        return controller;
      };

      const endLong = (controller) => {
        if (longRequestRef.current !== controller) return;
        longRequestRef.current = null;
        setLongOp('');
      };

      const abortLong = () => {
        const controller = longRequestRef.current;
        if (!controller) return;
        longRequestRef.current = null;
        try {
          controller.abort();
        } catch {
          /* 已经结束 */
        }
        setLongOp('');
        notify('正在取消…');
      };

      useEffect(
        () => () => {
          const controller = longRequestRef.current;
          longRequestRef.current = null;
          if (!controller) return;
          try {
            controller.abort();
          } catch {
            /* 已经结束 */
          }
        },
        [],
      );

      useEffect(() => {
        if (!flashPartId) return;
        const node = partRefs.current[flashPartId];
        if (node && typeof node.scrollIntoView === 'function') {
          try {
            node.scrollIntoView({ block: 'center' });
          } catch {
            /* 嵌入环境可能不支持参数 */
          }
        }
        setFlashPartId('');
      }, [flashPartId, parts]);

      const load = useCallback(async () => {
        setLoading(true);
        try {
          const [out, partOut, seriesOut] = await Promise.all([
            api('/book?bookId=' + encodeURIComponent(bookId)),
            api('/parts?bookId=' + encodeURIComponent(bookId)),
            api('/series?bookId=' + encodeURIComponent(bookId)),
          ]);
          setData(out);
          setDraft(out.chapters || []);
          setChapterWarnings(
            out.book && Array.isArray(out.book.chapterWarnings) ? out.book.chapterWarnings : [],
          );
          setChapterOutline(outlineInfo(out.book));
          setParts(partOut.parts || []);
          setSeries(seriesOut.series || []);
        } catch (err) {
          notify(err.message);
        } finally {
          setLoading(false);
        }
      }, [bookId, notify]);
      useEffect(() => {
        load();
      }, [load]);

      // 重新进入详情页时恢复上次填写的目录范围；没有上次范围就用建议值预填。
      useEffect(() => {
        let alive = true;
        api('/toc?bookId=' + encodeURIComponent(bookId))
          .then((out) => {
            if (!alive) return;
            tocBookRef.current = bookId;
            const suggested = out && out.suggested;
            if (suggested && Number(suggested.from) >= 1 && Number(suggested.to) >= Number(suggested.from)) {
              setTocSuggested({ from: Number(suggested.from), to: Number(suggested.to) });
            } else {
              setTocSuggested(null);
            }
            const range = out && out.range;
            const from = Number(range && range.from) || 0;
            const to = Number(range && range.to) || 0;
            if (from >= 1 && to >= from) {
              setTocFrom(String(from));
              setTocTo(String(to));
            } else if (suggested && Number(suggested.from) >= 1) {
              setTocFrom(String(suggested.from));
              setTocTo(String(suggested.to));
            }
          })
          .catch(() => {
            if (alive) tocBookRef.current = bookId;
          });
        return () => {
          alive = false;
        };
      }, [bookId]);

      useEffect(() => {
        const from = Number(tocFrom) || 0;
        const to = Number(tocTo) || 0;
        if (tocBookRef.current !== bookId) return undefined;
        if (from < 1 || to < from) return undefined;
        const timer = setTimeout(() => {
          api('/toc/range', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bookId, from, to }),
          }).catch(() => {});
        }, 600);
        return () => clearTimeout(timer);
      }, [bookId, tocFrom, tocTo]);

      const reloadSeries = useCallback(async () => {
        try {
          const out = await api('/series?bookId=' + encodeURIComponent(bookId));
          setSeries(out.series || []);
        } catch (err) {
          notify(err.message);
        }
      }, [bookId, notify]);

      const generateCover = async () => {
        setBusy(true);
        const controller = beginLong('cover');
        try {
          await api('/cover', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bookId }),
            signal: controller.signal,
          });
          notify('封面已生成');
          await load();
          onChanged();
        } catch (err) {
          if (!isAbortError(err)) notify(err.message);
        } finally {
          endLong(controller);
          setBusy(false);
        }
      };

      const refreshBookmark = async ({ source = 'pdf', file = null } = {}) => {
        setBookmarkBusy(true);
        try {
          const body = { bookId, source };
          if (source === 'xml') {
            if (!file) throw new Error('请选择书签 XML 文件');
            body.xml = await file.text();
          }
          const out = await api('/book/outline/refresh', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!out || out.ok !== true) throw new Error((out && (out.error || out.code)) || '书签刷新失败');
          const count = Number(out.rootCount) || 0;
          notify(out.changed ? '书签已刷新：' + count + ' 个根章/节' : '书签无变化');
          await load();
        } catch (err) {
          notify(err.message || String(err));
        } finally {
          setBookmarkBusy(false);
        }
      };

      const build = async (options = {}) => {
        const current = (data && data.chapters) || [];
        const manualCount = current.filter((chapter) => chapter && chapter.manual).length;
        let force = false;
        if (manualCount > 0) {
          const ok = await confirmAction(
            '重新分章会覆盖 ' + manualCount + ' 个手动修改过的章。继续？',
            { title: '重新分章', okText: '覆盖并重分', danger: true },
          );
          if (!ok) return;
          force = true;
        }
        setBusy(true);
        const controller = beginLong('build');
        try {
          const body = chapterBuildRequest({
            bookId,
            advancedOpen,
            advancedSource,
            tocFrom,
            tocTo,
            force,
            outlineDepth: options && options.outlineDepth,
            modeOverride: options && options.mode,
          });
          const out = await api('/chapters/build', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          setSelected([]);
          setChapterWarnings(Array.isArray(out.warnings) ? out.warnings : []);
          setChapterAttempts(Array.isArray(out.attempts) ? out.attempts : []);
          setChapterOutline(out.outline || null);
          setBuildOpen(false);
          setAdvancedOpen(false);
          setTocPreview('');
          notify('已分章：' + (out.chapters || []).length + ' 章');
          await load();
          onChanged();
        } catch (err) {
          if (!isAbortError(err)) {
            notify(err.code === 'E_MANUAL_EDITS' ? '有手动修改过的章；请确认覆盖后重试。' : err.message);
          }
        } finally {
          endLong(controller);
          setBusy(false);
        }
      };

      const toggleAdvanced = () => {
        const next = !advancedOpen;
        setAdvancedOpen(next);
        if (next && advancedSource === 'printed_toc' && !tocFrom && tocSuggested) {
          setTocFrom(String(tocSuggested.from));
          setTocTo(String(tocSuggested.to));
        }
      };

      const selectAdvancedSource = (source) => {
        setAdvancedSource(source);
        if (source === 'printed_toc' && !tocFrom && tocSuggested) {
          setTocFrom(String(tocSuggested.from));
          setTocTo(String(tocSuggested.to));
        }
      };

      const previewToc = async () => {
        const from = Number(tocFrom) || 0;
        const to = Number(tocTo) || 0;
        if (!(from >= 1 && to >= from)) {
          notify('先填目录起止页。');
          return;
        }
        try {
          const out = await api('/toc/preview', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bookId, from, to }),
          });
          setTocPreview(String(out.preview || ''));
        } catch (err) {
          notify(err.message);
        }
      };

      const openBuild = () => {
        setBuildOpen(true);
        setAdvancedOpen(false);
      };

      const toggleTree = (n) => {
        setTreeExpanded((current) => {
          const next = new Set(current);
          if (next.has(Number(n))) next.delete(Number(n));
          else next.add(Number(n));
          return next;
        });
      };

      const descendTree = () => {
        if (!chapterOutline || !chapterOutline.canDescend) return;
        build({ outlineDepth: chapterOutline.nextDepth, mode: 'auto' });
      };

      const keepSingleRoot = () => {
        setChapterOutline(null);
      };

      const topTree = () => {
        build({ outlineDepth: 0, mode: 'auto' });
      };

      const save = async () => {
        setBusy(true);
        try {
          const out = await api('/chapters', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bookId, chapters: draft }),
          });
          setDraft(out.chapters);
          setEditing(false);
          notify('章节已保存');
          await load();
          onChanged();
        } catch (err) {
          notify(err.code === 'E_CHAPTER_OVERLAP' || err.code === 'E_CHAPTER_RANGE' ? '起止页重叠或越界：' + err.message : err.message);
        } finally {
          setBusy(false);
        }
      };

      const postPart = async (chapters, partId = '') => {
        const out = await api('/part', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bookId, chapters, partId, source: 'manual' }),
        });
        notify('已确认 Part《' + out.part.title + '》');
        setSelected([]);
        await load();
        setFlashPartId(out.part.id);
        return out.part;
      };

      const confirmPart = async () => {
        if (!selected.length) return;
        setBusy(true);
        try {
          await postPart(selected);
        } catch (err) {
          // 默认 UI 已禁选，正常操作不会冲突；这里只兜底 API/并发导致的竞态。
          notify(
            err.code === 'E_PART_CONFLICT'
              ? '章节归属冲突：' + err.message + '。请先在该 Part 的「编辑」中移出冲突章。'
              : err.message,
          );
        } finally {
          setBusy(false);
        }
      };

      const previewPlan = async (part) => {
        setBusy(true);
        const controller = beginLong('plan');
        try {
          const body = part
            ? { bookId, partId: part.id }
            : { bookId, chapters: selected };
          const out = await api('/plan/preview', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          setPlan(out.plan);
          setPlanWarnings(out.warnings || []);
          setPlanPartId(part ? part.id : '');
          if (!part) notify('这是草稿讲纲；保存为系列前先确认 Part。');
        } catch (err) {
          if (!isAbortError(err)) notify(err.message);
        } finally {
          endLong(controller);
          setBusy(false);
        }
      };

      const saveSeries = async () => {
        if (!plan || !planPartId) {
          notify('先确认 Part，再从 Part 组预览讲纲。');
          return;
        }
        setSavingSeries(true);
        try {
          const out = await api('/series', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bookId, partId: planPartId, plan }),
          });
          notify('已创建系列（' + out.status + '）');
          setPlan(null);
          setPlanWarnings([]);
          await load();
        } catch (err) {
          notify(err.message);
        } finally {
          setSavingSeries(false);
        }
      };

      const removePart = async (part) => {
        if (!(await confirmAction('删除 Part《' + part.title + '》？系列会保留章快照。', { title: '删除 Part', okText: '删除', danger: true }))) return;
        try {
          await api('/part?bookId=' + encodeURIComponent(bookId) + '&partId=' + encodeURIComponent(part.id), { method: 'DELETE' });
          notify('Part 已删除');
          setSelected([]);
          await load();
        } catch (err) {
          notify(err.message);
        }
      };

      /** AC-93：组头「编辑」打开；改名/增删章都走 /part/update，成功 version+1。 */
      const openPartEdit = (part) => {
        setSelected([]);
        setPartEdit({
          partId: part.id,
          title: part.title || '',
          originalTitle: part.title || '',
          original: (part.chapters || []).map(Number),
          add: [],
          remove: [],
          error: '',
        });
      };

      const togglePartEditChapter = (n, ownedByThis) => {
        setPartEdit((cur) => {
          if (!cur) return cur;
          if (ownedByThis) {
            const remove = cur.remove.map(Number);
            return { ...cur, remove: remove.includes(n) ? remove.filter((x) => x !== n) : remove.concat(n) };
          }
          const add = cur.add.map(Number);
          return { ...cur, add: add.includes(n) ? add.filter((x) => x !== n) : add.concat(n) };
        });
      };

      const savePartEdit = async () => {
        if (!partEdit) return;
        const title = String(partEdit.title || '').trim();
        const originalTitle = String(partEdit.originalTitle || '').trim();
        if (!partEdit.add.length && !partEdit.remove.length && title === originalTitle) {
          setPartEdit(null);
          notify('没有修改');
          return;
        }
        setBusy(true);
        setPartEdit((cur) => (cur ? { ...cur, error: '' } : cur));
        try {
          const out = await api('/part/update', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              bookId,
              partId: partEdit.partId,
              title: partEdit.title,
              addChapters: partEdit.add,
              removeChapters: partEdit.remove,
            }),
          });
          const id = out.part.id;
          notify('Part 已更新（v' + out.part.version + '）');
          setPartEdit(null);
          setSelected([]);
          await load();
          setFlashPartId(id);
        } catch (err) {
          setPartEdit((cur) => (cur ? { ...cur, error: err.code === 'E_PART_EMPTY' ? 'Part 至少要保留 1 章；要解散请用「删除」。' : err.message } : cur));
        } finally {
          setBusy(false);
        }
      };

      if (loading && !data) return h('div', { className: 'blm-body' }, h('div', { className: 'blm-dim' }, '加载中…'));
      if (!data) return h('div', { className: 'blm-body' }, h('button', { className: 'blm-btn', onClick: onBack }, '← 返回'));

      const book = data.book || {};
      const chapters = data.chapters || [];
      const bookmarkTreeReady =
        book.chapterSource === 'bookmark' &&
        Array.isArray(book.bookmarkTree) &&
        book.bookmarkTree.length > 0 &&
        Number.isInteger(book.bookmarkRootDepth);
      const cover = data.cover ? API + '/cover?bookId=' + encodeURIComponent(bookId) + '&v=' + encodeURIComponent(book.coverUpdatedAt || book.lastOpenedAt || '') : '';
      const partOf = new Map();
      for (const part of parts) for (const n of part.chapters || []) partOf.set(Number(n), part);
      const partSeriesCount = (partId) => series.filter((item) => item.part_id === partId).length;
      const partSectionCount = (part) => {
        if (!bookmarkTreeReady) return 0;
        const roots = childNodesAtDepth(book.bookmarkTree, book.bookmarkRootDepth);
        let count = 0;
        for (const n of part.chapters || []) {
          const node = roots.find((item) => Number(item.n) === Number(n));
          if (node) count += countDescendants(node);
        }
        return count;
      };
      const selectedChars = chapters.filter((c) => selected.includes(Number(c.n))).reduce((sum, c) => sum + (Number(c.chars) || 0), 0);
      const longOpLabel = longOp === 'build' ? '分章构建' : longOp === 'plan' ? '讲纲预览' : longOp === 'cover' ? '封面生成' : '长任务';
      const toggleChapter = (n) => {
        if (partOf.has(Number(n))) return;
        setSelected((list) => (list.includes(Number(n)) ? list.filter((x) => x !== Number(n)) : [...list, Number(n)].sort((a, b) => a - b)));
      };
      return h(
        'div',
        { className: 'blm-body' },
        h(
          'div',
          { className: 'blm-row', style: { marginBottom: 10 } },
          h('button', { className: 'blm-btn', onClick: onBack }, '← 书架'),
          h('div', { style: { flex: 1 } }),
          h('button', { className: 'blm-btn', disabled: busy, onClick: generateCover }, data.cover ? '重生成封面' : '生成封面'),
        ),
        longOp
          ? h(
              'div',
              { className: 'blm-note', style: { position: 'sticky', top: 0, zIndex: 4, marginBottom: 10 } },
              h(
                'div',
                { className: 'blm-row' },
                h('span', null, '正在' + longOpLabel + '…'),
                h('div', { style: { flex: 1 } }),
                h('button', { className: 'blm-btn', onClick: abortLong }, '取消'),
              ),
            )
          : null,
        h(
          'div',
          { className: 'blm-detail-head' },
          h('div', { className: 'blm-detail-cover' }, cover ? h('img', { src: cover, alt: '' }) : String(book.title || '书').slice(0, 1)),
          h(
            'div',
            { style: { minWidth: 0 } },
            h('h2', { className: 'blm-detail-title' }, book.title || '未命名'),
            h('div', { className: 'blm-meta' }, (book.author || '未知作者') + ' · ' + (book.pages || 0) + ' 页 · ' + (book.chars || 0) + ' 字'),
            h('div', { className: 'blm-meta' }, data.chaptersBuilt ? chapters.length + ' 章 · ' + parts.length + ' 个 Part · ' + series.length + ' 个系列' : '尚未分章'),
          ),
        ),
        !data.chaptersBuilt || buildOpen
          ? h(ChapterBuildPanel, {
              built: data.chaptersBuilt,
              advancedOpen,
              advancedSource,
              tocFrom,
              tocTo,
              suggested: tocSuggested,
              tocPreview,
              busy,
              source: book.chapterSource,
              confidence: book.chapterConfidence,
              warnings: chapterWarnings,
              attempts: chapterAttempts,
              manualCount: chapters.filter((chapter) => chapter && chapter.manual).length,
              onToggleAdvanced: toggleAdvanced,
              onSource: selectAdvancedSource,
              onFrom: setTocFrom,
              onTo: setTocTo,
              onPreview: previewToc,
              onBuild: build,
              onRefreshBookmark: bookmarkBusy ? null : refreshBookmark,
              onClose: data.chaptersBuilt ? () => setBuildOpen(false) : null,
            })
          : null,
        data.chaptersBuilt
          ? h(
              'div',
              null,
              !buildOpen
                ? h(
                    'div',
                    { className: 'blm-build-summary blm-build-summary-compact' },
                    h(
                      'div',
                      { className: 'blm-row' },
                      h('strong', null, '本次来源：' + (sourceLabel(book.chapterSource) || '未知')),
                      book.chapterConfidence !== null &&
                        book.chapterConfidence !== undefined &&
                        book.chapterConfidence !== '' &&
                        Number.isFinite(Number(book.chapterConfidence))
                        ? h('span', { className: 'blm-badge' }, '置信度 ' + Number(book.chapterConfidence).toFixed(2))
                        : null,
                    ),
                    (chapterWarnings || []).map((warning, index) =>
                      h('div', { className: 'blm-note warn', key: index }, warning),
                    ),
                  )
                : null,
              parts.length
                ? h(
                    'div',
                    { className: 'blm-parts' },
                    parts.map((part) =>
                      h(
                        'div',
                        {
                          className: 'blm-part',
                          key: part.id,
                          ref: (node) => {
                            partRefs.current[part.id] = node;
                          },
                        },
                        h(
                          'div',
                          { className: 'blm-part-main' },
                          h(
                            'div',
                            { className: 'blm-row' },
                            h('div', { className: 'blm-title' }, part.title),
                            h('span', { className: 'blm-badge ok' }, '已确认'),
                          ),
                          h('div', { className: 'blm-meta' },
                            part.chapters.length + ' 章' +
                            (partSectionCount(part) ? ' · ' + partSectionCount(part) + ' 节' : '') +
                            ' · ' + (part.chars || 0) + ' 字 · ' +
                            partSeriesCount(part.id) + ' 个系列 · v' + part.version),
                        ),
                        h('button', { className: 'blm-btn', disabled: busy, onClick: () => previewPlan(part) }, '预览讲纲'),
                        h('button', { className: 'blm-btn', disabled: busy, onClick: () => openPartEdit(part) }, '编辑'),
                        h('button', { className: 'blm-btn', disabled: busy, onClick: () => removePart(part) }, '删除'),
                      ),
                    ),
                  )
                : null,
              h(
                'div',
                { className: 'blm-row', style: { marginTop: 4 } },
                h('button', { className: 'blm-btn', onClick: () => setEditing((v) => !v) }, editing ? '取消编辑' : '校准章节'),
                !buildOpen && !editing
                  ? h('button', { className: 'blm-btn', disabled: busy, onClick: openBuild }, '重新分章')
                  : null,
                !buildOpen && !editing && data.book && data.book.chapterSource === 'bookmark'
                  ? h('button', {
                      className: 'blm-btn',
                      disabled: busy || bookmarkBusy,
                      title: '只刷新书签树，不改章节/Part；XML 请在分章面板导入',
                      onClick: () => refreshBookmark({ source: 'pdf' }),
                    }, bookmarkBusy ? '刷新中…' : '刷新书签')
                  : null,
                editing ? h('button', { className: 'blm-btn primary', disabled: busy, onClick: save }, '保存') : null,
              ),
              bookmarkTreeReady && !editing
                ? h(ChapterTree, {
                    tree: book.bookmarkTree,
                    rootDepth: book.bookmarkRootDepth,
                    chapters,
                    partOf,
                    selected,
                    busy,
                    expanded: treeExpanded,
                    outline: chapterOutline,
                    onToggleExpand: toggleTree,
                    onToggleChapter: toggleChapter,
                    onDescend: descendTree,
                    onKeep: keepSingleRoot,
                    onTop: topTree,
                  })
                : h(
                    React.Fragment,
                    null,
                    bookmarkTreeReady && editing
                      ? h('div', { className: 'blm-dim blm-build-hint' }, '书签子节点只读；编辑时只显示根章。')
                      : null,
                    h(
                      'div',
                      { className: 'blm-chapters' },
                      (editing ? draft : chapters).map((c, i) => {
                        const n = Number(c.n);
                        const owner = partOf.get(n) || null;
                        const state = chapterSelectionState({ n, front: c.front === true, owner, selected, busy });
                        return h(
                          'div',
                          { className: 'blm-chapter' + (owner ? ' owns' : ''), key: c.n + '-' + c.from },
                          h('span'),
                          editing
                            ? h('span', null)
                            : h('input', {
                                type: 'checkbox',
                                checked: state.checked,
                                disabled: state.disabled,
                                onChange: () => toggleChapter(n),
                                title: state.title,
                              }),
                          h('span', { className: 'blm-dim' }, String(c.n ?? i + 1)),
                          editing
                            ? h('input', { value: c.title, onChange: (e) => setDraft((list) => list.map((x) => (x === c ? Object.assign({}, x, { title: e.target.value }) : x))) })
                            : h('span', { className: 't', title: c.title, onClick: () => setEditing(true) }, c.title),
                          editing
                            ? h('input', { type: 'number', value: c.from, onChange: (e) => setDraft((list) => list.map((x) => (x === c ? Object.assign({}, x, { from: Number(e.target.value) }) : x))) })
                            : h('span', { className: 'blm-dim' }, 'p' + c.from),
                          editing
                            ? h('input', { type: 'number', value: c.to, onChange: (e) => setDraft((list) => list.map((x) => (x === c ? Object.assign({}, x, { to: Number(e.target.value) }) : x))) })
                            : h('span', { className: 'blm-dim' }, 'p' + c.to),
                          h(ChapterSourceBadge, { chapter: c }),
                          h('span', { className: 'blm-dim', style: { fontSize: 10, textAlign: 'right' } }, owner ? '属于 ' + owner.title : ''),
                        );
                      }),
                    ),
                  ),
              !editing
                ? h(
                    'div',
                    { className: 'blm-selectbar' },
                    h('div', { className: 'blm-dim' }, '已选 ' + selected.length + ' 章 · ' + selectedChars + ' 字'),
                    h('div', { style: { flex: 1 } }),
                    h('button', { className: 'blm-btn', disabled: !selected.length || busy, onClick: () => previewPlan(null) }, '预览讲纲（草稿）'),
                    h('button', { className: 'blm-btn primary', disabled: !selected.length || busy, onClick: confirmPart }, '确认此部分'),
                    h('button', { className: 'blm-btn', disabled: !selected.length, onClick: () => setSelected([]) }, '清空'),
                  )
                : null,
              plan
                ? h(
                    'div',
                    { className: 'blm-modal-mask' },
                    h(
                    'div',
                    { className: 'blm-plan blm-plan-modal' },
                    h('div', { className: 'blm-row' }, h('strong', null, '讲纲预览'), h('span', { className: 'blm-dim' }, plan.source === 'model' ? '模型' : '规则'), h('div', { style: { flex: 1 } }), h('button', { className: 'blm-btn', onClick: () => setPlan(null) }, '关闭')),
                    plan.throughline ? h('div', { className: 'blm-plan-line' }, plan.throughline) : null,
                    h('div', { className: 'blm-plan-lectures' }, (plan.lectures || []).map((lec) =>
                      h('div', { className: 'blm-plan-lec', key: lec.n },
                        h('strong', null, lec.title || '第 ' + lec.n + ' 讲'),
                        h('div', { className: 'blm-meta' }, '章 ' + (lec.chapters || []).join('、') + ' · ' + lec.pages + ' 页 · ' + lec.chars + ' 字'),
                        lec.goal ? h('div', { className: 'blm-dim' }, lec.goal) : null,
                        (lec.sections || []).length
                          ? h('div', { className: 'blm-plan-line', style: { fontSize: 11 } },
                              '节页分配：' + (lec.sections || []).map((section) =>
                                section.title + '（' + section.pages + ' 页' + ((section.must_keep || []).length ? '；' + (section.must_keep || []).join('/') : '') + '）').join('；'))
                          : null,
                      ),
                    )),
                    (plan.seams || []).length ? h('div', { className: 'blm-plan-line' }, '接缝：' + plan.seams.map((s) => s.sentence).join(' / ')) : h('div', { className: 'blm-dim' }, '规则讲纲未生成接缝（unstitched）。'),
                    planWarnings.length ? h('div', { className: 'blm-note' }, planWarnings.join(' ')) : null,
                    h('div', { className: 'blm-row', style: { marginTop: 8 } },
                      h('button', { className: 'blm-btn primary', disabled: !planPartId || savingSeries, onClick: saveSeries }, savingSeries ? '保存中…' : '保存为系列'),
                      h('span', { className: 'blm-dim' }, planPartId ? '会创建 draft/planned 系列，不启动生成。' : '草稿讲纲需先确认 Part 后才能保存。'),
                    ),
                    ),
                  )
                : null,
              series.length
                ? h(
                    'div',
                    { className: 'blm-series' },
                    h('div', { className: 'blm-dim' }, '系列'),
                    series.map((s) => h(SeriesCard, {
                      key: s.id,
                      series: s,
                      part: parts.find((p) => p.id === s.part_id) || null,
                      notify,
                      onReload: reloadSeries,
                      onPlay: (item, n) => onPlay && onPlay(item, n),
                    })),
                  )
                : null,
            )
          : null,
        partEdit
          ? h(PartEditDialog, {
              draft: partEdit,
              chapters,
              partOf,
              busy,
              error: partEdit.error,
              onTitle: (value) => setPartEdit((cur) => (cur ? { ...cur, title: value } : cur)),
              onToggle: togglePartEditChapter,
              onSave: savePartEdit,
              onClose: () => {
                if (!busy) setPartEdit(null);
              },
            })
          : null,
      );
    }

    /* ------------------------------ 试听状态（UI 单一来源） ------------------------------ */

    const PROBE_IDLE = {
      phase: 'idle',
      startedAt: 0,
      elapsedMs: 0,
      kind: '',
      where: '',
      slow: false,
      note: '',
      tone: '',
      audioMs: 0,
      genMs: 0,
      blocked: false,
      code: '',
    };

    function probeDuration(ms) {
      const value = Number(ms);
      if (!Number.isFinite(value) || value <= 0) return '';
      return (value / 1000).toFixed(1) + 's';
    }

    function probeTiming(state) {
      const parts = [];
      const audio = probeDuration(state && state.audioMs);
      const gen = probeDuration(state && state.genMs);
      if (audio) parts.push('音频 ' + audio);
      if (gen) parts.push('生成 ' + gen);
      return parts.join(' · ');
    }

    /**
     * 参考音频时长提示（AC-154）：
     *   warn = <3s 或 >30s，红色 warning，进 probe warnings；
     *   tip  = 3–5s / 15–30s，在容忍区但超出推荐 5–15s，中性提示，不算 warning。
     * 优先用服务端 duration_level/duration_text（改文案只改一处），缺字段时按同一阈值本地兜底。
     * 返回 { level: 'warn'|'tip', text } 或 null。
     */
    function refDurationNotice(voice) {
      if (!voice || typeof voice !== 'object') return null;
      const ms = Math.max(0, Math.round(Number(voice.duration_ms) || 0));
      if (!ms) return null;
      const level = ms < 3000 || ms > 30000 ? 'warn' : ms < 5000 || ms > 15000 ? 'tip' : '';
      if (!level) return null;
      const text = String(voice.duration_text || '').trim();
      if (text) return { level, text };
      const name = String(voice.name || '').trim();
      const who = name ? '参考「' + name + '」' : '参考音频';
      const seconds = (ms / 1000).toFixed(1) + 's';
      return {
        level,
        text: who + '时长 ' + seconds + (level === 'warn'
          ? '，超出推荐 5–15s（容忍区 3–30s）；可继续使用，建议截短到 5–15s 后重新导入。'
          : '，超出推荐 5–15s，但在容忍区（3–30s）内，不影响配音。'),
      };
    }

    /**
     * 试听按钮/状态行的唯一派生入口：phase 决定文案、禁用与状态行。
     * 返回 { label, disabled, busy, title, tone, note }；tone 为 'progress' | 'ok' | 'warn' | ''。
     */
    function probeView(state, options) {
      const opts = options && typeof options === 'object' ? options : {};
      const baseDisabled = !!opts.baseDisabled;
      const source = state && typeof state === 'object' ? state : PROBE_IDLE;
      const phase = source.phase || 'idle';
      const where = source.where || '当前供应商';
      const seconds = Math.max(0, Math.floor((Number(source.elapsedMs) || 0) / 1000));
      const timing = probeTiming(source);
      if (phase === 'generating') {
        const wait = seconds > 0 ? ' · 已等待 ' + seconds + 's' : '';
        return {
          label: seconds > 0 ? '生成中… ' + seconds + 's' : '生成中…',
          disabled: true,
          busy: true,
          title: '正在生成试听音频；生成结束前不能重复点击',
          tone: 'progress',
          note:
            source.kind === 'browser'
              ? '正在准备本机朗读…'
              : source.kind === 'off'
                ? '正在检查语音配置…'
                : '正在生成试听：' + where + wait + (source.slow ? '。首次加载模型可能要 1–3 分钟，请稍候。' : '…'),
        };
      }
      if (phase === 'playing') {
        return {
          label: '停止试听',
          disabled: false,
          busy: false,
          title: '停止播放试听音频（不会重新生成）',
          tone: 'progress',
          note: '正在播放试听：' + where + (timing ? ' · ' + timing : '') + '。',
        };
      }
      if (phase === 'ready') {
        return {
          label: source.blocked ? '播放试听' : '重听',
          disabled: baseDisabled,
          busy: false,
          title: source.blocked ? '浏览器拦截了自动播放，点这里手动播放' : '重听上次试听；换参考/音色/工作流后会自动重新生成',
          tone: source.blocked ? 'warn' : 'ok',
          note: source.note || '试听完成：' + where + (timing ? ' · ' + timing : '') + '。',
        };
      }
      if (phase === 'error') {
        return {
          label: '重试',
          disabled: baseDisabled,
          busy: false,
          title: '再试一次试听',
          tone: 'warn',
          note: source.note || '试听失败，请重试。',
        };
      }
      return {
        label: '试听',
        disabled: baseDisabled,
        busy: false,
        title: opts.idleTitle || '试听当前供应商的合成效果',
        tone: '',
        note: '',
      };
    }

    /* ------------------------------ M4 设置（FR-21.5） ------------------------------ */

    /* ------------------------------ FR-27 用量历史 ------------------------------ */

    const USAGE_DETAIL_IDLE = { status: 'idle', jobId: '', job: null, error: '' };

    /** 稳定的 DOM id；jobId 只含安全字符时原样使用。 */
    function usageDetailSafeId(jobId) {
      return String(jobId || '').replace(/[^A-Za-z0-9_-]/g, '_') || 'job';
    }

    /** 单开互斥：点当前条返回空（收起），点其它条返回新的 jobId（收旧开新）。 */
    function usageToggleJobId(current, jobId) {
      return current === jobId ? '' : jobId;
    }

    function UsageRow({ job, open, detail, onToggle, onRetry, onCollapse, itemRef }) {
      const summaryRef = useRef(null);
      const summaryId = 'blm-usage-summary-' + usageDetailSafeId(job.jobId);
      const detailId = 'blm-usage-detail-' + usageDetailSafeId(job.jobId);

      const collapse = () => {
        onCollapse();
        if (summaryRef.current && typeof summaryRef.current.focus === 'function') summaryRef.current.focus();
      };

      const onKeyDown = (event) => {
        if (!open || !event || event.key !== 'Escape') return;
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
        collapse();
      };

      const head = (label) =>
        h(
          'div',
          { className: 'blm-usage-detail-head' },
          h('strong', null, '明细'),
          h('span', { className: 'blm-dim' }, label),
          h('div', { style: { flex: 1 } }),
          h('button', { type: 'button', className: 'blm-btn', onClick: collapse }, '收起'),
        );

      let body = null;
      if (open) {
        const state = detail && detail.jobId === job.jobId ? detail : null;
        if (!state || state.status === 'idle' || state.status === 'loading') {
          body = h(
            'div',
            null,
            head(usageKindLabel(job)),
            h('div', { className: 'blm-usage-loading', role: 'status' }, '正在读取明细…'),
          );
        } else if (state.status === 'error') {
          body = h(
            'div',
            null,
            head(usageKindLabel(job)),
            h(
              'div',
              { className: 'blm-usage-error', role: 'alert' },
              h('span', null, '读取明细失败：' + (state.error || '未知错误')),
              h('button', { type: 'button', className: 'blm-btn', onClick: onRetry }, '重试'),
            ),
          );
        } else {
          const current = state.job || {};
          body = h(
            'div',
            null,
            head(usageKindLabel(current)),
            h(
              'div',
              { className: 'blm-dim', style: { fontSize: 11, marginTop: 4 } },
              formatUsageTime(current.startedAt) + ' → ' + formatUsageTime(current.finishedAt) + ' · ' +
                String(current.status || '') + ' · ' + String(current.billing || ''),
            ),
            h('div', { style: { fontSize: 12, marginTop: 4 } }, usageSummaryLine(current)),
            h(
              'div',
              { className: 'blm-dim', style: { fontSize: 11, marginTop: 4 } },
              '价格版本 ' + String(current.priceVersion || '—') +
                (current.actual && current.actual.charsSource === 'text' ? ' · 字符按码点回落' : '') +
                (current.actual && current.actual.charsSource === 'provider' ? ' · 字符口径：云端' : '') +
                (current.actual && current.actual.unknownPrice ? ' · 部分缺价' : '') +
                (current.actual && current.actual.unknownUsage ? ' · 缺模型用量' : ''),
            ),
            (current.billingModel || []).map((item) =>
              h('div', { key: item.provider + '/' + item.model, className: 'blm-usage-model' },
                item.provider + ' / ' + item.model + ' · ' + item.calls + ' 次 · ' +
                formatTokens((item.tokens && item.tokens.input) || 0) + ' 输入 · ' +
                (Number(item.tokens && item.tokens.cacheRead) ? formatTokens(item.tokens.cacheRead) + ' 缓存读 · ' : '') +
                formatTokens((item.tokens && item.tokens.output) || 0) + ' 输出 · ' + formatMoney(item.cost)),
            ),
            Object.keys(current.byStage || {}).length
              ? h('div', { className: 'blm-dim', style: { fontSize: 11, marginTop: 4 } },
                  '分阶段：' + Object.keys(current.byStage).map((key) => key + ' ' + formatMoney(current.byStage[key].cost)).join(' · '))
              : null,
          );
        }
      }

      return h(
        'div',
        { className: 'blm-usage-item' + (open ? ' is-open' : ''), ref: itemRef, onKeyDown },
        h(
          'button',
          {
            ref: summaryRef,
            id: summaryId,
            type: 'button',
            className: 'blm-usage-summary',
            'aria-expanded': open ? 'true' : 'false',
            'aria-controls': detailId,
            onClick: onToggle,
            title: job.jobId,
          },
          h(
            'div',
            { className: 'blm-row' },
            h('strong', null, usageKindLabel(job)),
            h('span', { className: 'blm-dim', style: { fontSize: 11 } }, formatUsageTime(job.startedAt)),
            h('div', { style: { flex: 1 } }),
            h('span', null, formatMoney(job.actual && job.actual.cost)),
            h('span', { className: 'blm-usage-caret', 'aria-hidden': 'true' }, '▸'),
          ),
          h(
            'div',
            { className: 'blm-dim', style: { fontSize: 11, marginTop: 3 } },
            [job.book && job.book.title, job.series && job.series.title].filter(Boolean).join(' · ') || '(未归属)',
          ),
          h('div', { className: 'blm-dim', style: { fontSize: 11, marginTop: 2 } }, usageSummaryLine(job)),
        ),
        h(
          'div',
          {
            id: detailId,
            className: 'blm-usage-detail',
            role: 'region',
            'aria-labelledby': summaryId,
            hidden: !open,
          },
          body,
        ),
      );
    }

    /** 「其他」分组：默认收起，组头显示条数；组内仍是普通 UsageRow（可继续行内展开）。 */
    function UsageOtherGroup({ count, open, shown, onToggle, children }) {
      const total = Number(count) || 0;
      const visible = Number(shown) || 0;
      return h(
        'div',
        { className: 'blm-usage-group' },
        h(
          'button',
          {
            type: 'button',
            className: 'blm-usage-group-head',
            'aria-expanded': open ? 'true' : 'false',
            'aria-controls': 'blm-usage-other-group',
            onClick: onToggle,
          },
          h('span', { className: 'blm-usage-caret', 'aria-hidden': 'true' }, '▸'),
          h('span', null, '其他'),
          h('span', { className: 'blm-usage-group-count' }, '（' + total + ' 条）'),
        ),
        h(
          'div',
          { id: 'blm-usage-other-group', className: 'blm-usage-group-body', hidden: !open },
          children,
          visible < total
            ? h(
                'div',
                { className: 'blm-usage-group-trunc' },
                visible > 0 ? '仅显示最近 ' + visible + ' 条' : '列表已达 500 条上限，请缩小时间范围',
              )
            : null,
        ),
      );
    }

    function UsageView({ onBack, notify }) {
      const [summary, setSummary] = useState(null);
      const [total, setTotal] = useState(null);
      const [jobs, setJobs] = useState([]);
      const [kind, setKind] = useState('');
      const [timePreset, setTimePreset] = useState('all');
      const [customFrom, setCustomFrom] = useState('');
      const [customTo, setCustomTo] = useState('');
      const [otherOpen, setOtherOpen] = useState(false);
      const [otherCount, setOtherCount] = useState(0);
      const [rangeError, setRangeError] = useState('');
      const [openJobId, setOpenJobId] = useState('');
      const [detailState, setDetailState] = useState(USAGE_DETAIL_IDLE);
      const [busy, setBusy] = useState(false);
      const detailSeqRef = useRef(0);
      const loadSeqRef = useRef(0);
      const openJobIdRef = useRef('');
      const openItemRef = useRef(null);
      const headerRef = useRef(null);
      const filterRef = useRef(null);

      const closeDetail = useCallback(() => {
        detailSeqRef.current += 1;
        openJobIdRef.current = '';
        setOpenJobId('');
        setDetailState(USAGE_DETAIL_IDLE);
      }, []);

      const loadDetail = useCallback((jobId) => {
        const seq = ++detailSeqRef.current;
        openJobIdRef.current = jobId;
        setOpenJobId(jobId);
        setDetailState({ status: 'loading', jobId, job: null, error: '' });
        api('/usage/job?jobId=' + encodeURIComponent(jobId))
          .then((out) => {
            if (seq !== detailSeqRef.current) return;
            setDetailState({ status: 'ready', jobId, job: (out && out.job) || null, error: '' });
          })
          .catch((err) => {
            if (seq !== detailSeqRef.current) return;
            setDetailState({ status: 'error', jobId, job: null, error: (err && err.message) || '未知错误' });
          });
      }, []);

      const toggleJob = useCallback((job) => {
        const next = usageToggleJobId(openJobIdRef.current, job.jobId);
        if (!next) {
          closeDetail();
          return;
        }
        loadDetail(next);
      }, [closeDetail, loadDetail]);

      const load = useCallback(async () => {
        const seq = ++loadSeqRef.current;
        const range = usageRangeFor(timePreset, { from: customFrom, to: customTo });
        const rangeErr = usageRangeError(range);
        if (rangeErr) {
          setBusy(false);
          setRangeError(rangeErr);
          return;
        }
        setRangeError('');
        setBusy(true);
        try {
          const kindOnly = usageQuery({ kind });
          const countQuery = usageQuery({ from: range.from, to: range.to });
          const [monthOut, totalOut, countsOut, jobsOut] = await Promise.all([
            api('/usage/summary' + usageQuery({ from: monthStartIso(), kind })).catch(() => null),
            api('/usage/summary' + kindOnly).catch(() => null),
            api('/usage/summary' + countQuery).catch(() => null),
            api('/usage/jobs' + usageQuery({ limit: 500, kind, from: range.from, to: range.to })).catch((err) => {
              if (seq === loadSeqRef.current) notify((err && err.message) || '刷新用量历史失败');
              return null;
            }),
          ]);
          if (seq !== loadSeqRef.current) return;
          if (monthOut) setSummary(monthOut);
          if (totalOut) setTotal(totalOut);
          if (countsOut && Array.isArray(countsOut.byKind)) {
            const otherCountNext = countsOut.byKind
              .filter((item) => String(item.kind) === 'other')
              .reduce((sum, item) => sum + (Number(item.jobs) || 0), 0);
            setOtherCount(otherCountNext);
            if (!otherCountNext) setOtherOpen(false);
          }
          if (jobsOut && Array.isArray(jobsOut.jobs)) {
            const list = jobsOut.jobs;
            setJobs(list);
            const current = openJobIdRef.current;
            if (current) {
              if (list.some((job) => job.jobId === current)) loadDetail(current);
              else closeDetail();
            }
          }
        } catch (err) {
          if (seq === loadSeqRef.current) notify(err.message);
        } finally {
          if (seq === loadSeqRef.current) setBusy(false);
        }
      }, [kind, timePreset, customFrom, customTo, notify, loadDetail, closeDetail]);

      useEffect(() => {
        load();
      }, [load]);

      // 点空白收起；工具栏与确认弹窗除外；点其它条交给该条 onClick 切换。
      useEffect(() => {
        if (!openJobId || typeof document === 'undefined') return undefined;
        const onDocClick = (event) => {
          const target = event && event.target;
          if (!target || !openItemRef.current) return;
          if (openItemRef.current.contains(target)) return;
          if (headerRef.current && headerRef.current.contains(target)) return;
          if (filterRef.current && filterRef.current.contains(target)) return;
          if (typeof target.closest === 'function') {
            if (target.closest('.blm-modal-mask')) return;
            if (target.closest('.blm-usage-item')) return;
          }
          closeDetail();
        };
        document.addEventListener('click', onDocClick, true);
        return () => document.removeEventListener('click', onDocClick, true);
      }, [openJobId, closeDetail]);

      const clearAll = async () => {
        const ok = await confirmAction('清空全部用量历史？只删账本，不影响书、系列与音频。', {
          title: '清空用量历史',
          okText: '清空',
          danger: true,
        });
        if (!ok) return;
        try {
          const out = await api('/usage/jobs', { method: 'DELETE' });
          notify('已清空 ' + (Number(out.removed) || 0) + ' 条记录');
          closeDetail();
          await load();
        } catch (err) {
          notify(err.message);
        }
      };

      const renderRow = (job) =>
        h(UsageRow, {
          key: job.jobId,
          job,
          open: openJobId === job.jobId,
          detail: detailState,
          onToggle: () => toggleJob(job),
          onRetry: () => loadDetail(job.jobId),
          onCollapse: closeDetail,
          itemRef: openJobId === job.jobId ? openItemRef : null,
        });

      const grouped = splitUsageJobs(jobs);
      const groupCount = otherCount > 0 ? otherCount : grouped.other.length;
      const showGroup = !kind && groupCount > 0;
      const visible = kind ? jobs : grouped.main;

      const toggleOther = () => {
        if (otherOpen) {
          const current = openJobIdRef.current;
          if (grouped.other.some((job) => job.jobId === current)) closeDetail();
        }
        setOtherOpen(!otherOpen);
      };

      return h(
        'div',
        { className: 'blm-body' },
        h(
          'div',
          { className: 'blm-row', ref: headerRef, style: { marginBottom: 10 } },
          h('button', { className: 'blm-btn', onClick: onBack }, '← 设置'),
          h('h1', { style: { fontSize: 15, margin: 0 } }, '用量与费用'),
          h('div', { style: { flex: 1 } }),
          h('button', { className: 'blm-btn', disabled: busy, onClick: load }, busy ? '刷新中…' : '刷新'),
        ),
        h(
          'div',
          { className: 'blm-note' },
          '本月 ' + (summary ? formatMoney(summary.totals.cost) + ' · ' + summary.totals.jobs + ' 次' : '—') +
            '；累计 ' + (total ? formatMoney(total.totals.cost) + ' · ' + total.totals.jobs + ' 次' : '—') +
            '。只统计插件发起的云端调用，本地调用不计入。',
        ),
        h(
          'div',
          { className: 'blm-row', ref: filterRef, style: { margin: '8px 0' } },
          h(
            'select',
            {
              className: 'blm-select',
              value: kind,
              onChange: (event) => {
                closeDetail();
                setOtherOpen(false);
                setKind(event.target.value);
              },
              'aria-label': '用量类型筛选',
            },
            h('option', { value: '' }, '全部类型'),
            h('option', { value: 'lecture' }, '讲义'),
            h('option', { value: 'tts' }, '配音'),
            h('option', { value: 'image' }, '配图'),
            h('option', { value: 'other' }, '其他'),
          ),
          h(
            'select',
            {
              className: 'blm-select',
              value: timePreset,
              onChange: (event) => {
                closeDetail();
                setOtherOpen(false);
                setRangeError('');
                setTimePreset(event.target.value);
              },
              'aria-label': '用量时间范围',
            },
            USAGE_TIME_PRESETS.map((item) => h('option', { key: item.id, value: item.id }, item.label)),
          ),
          timePreset === 'custom'
            ? h('input', {
                type: 'date',
                className: 'blm-input blm-usage-date',
                value: customFrom,
                max: customTo || undefined,
                'aria-label': '开始日期',
                onChange: (event) => {
                  closeDetail();
                  setOtherOpen(false);
                  setRangeError('');
                  setCustomFrom(event.target.value);
                },
              })
            : null,
          timePreset === 'custom' ? h('span', { className: 'blm-dim' }, '至') : null,
          timePreset === 'custom'
            ? h('input', {
                type: 'date',
                className: 'blm-input blm-usage-date',
                value: customTo,
                min: customFrom || undefined,
                'aria-label': '结束日期',
                onChange: (event) => {
                  closeDetail();
                  setOtherOpen(false);
                  setRangeError('');
                  setCustomTo(event.target.value);
                },
              })
            : null,
          h('div', { style: { flex: 1 } }),
          h('button', { className: 'blm-btn', disabled: busy || !jobs.length, onClick: clearAll }, '清空历史'),
        ),
        rangeError
          ? h('div', { className: 'blm-usage-range-error', role: 'alert' }, rangeError)
          : null,
        visible.length || showGroup
          ? h(
              'div',
              { className: 'blm-usage-list' },
              visible.map(renderRow),
              showGroup
                ? h(
                    UsageOtherGroup,
                    { count: groupCount, open: otherOpen, shown: grouped.other.length, onToggle: toggleOther },
                    grouped.other.map(renderRow),
                  )
                : null,
            )
          : h(
              'div',
              { className: 'blm-empty' },
              h('strong', null, '还没有用量记录'),
              h('div', null, '生成一次讲义、配音或配图后，这里会出现记录。'),
              h('div', { className: 'blm-dim' }, '本地调用不写入账本。'),
            ),
      );
    }

    /** 2.5 设置页栏目（顺序即标签顺序；id 同时用于 tab/tabpanel 的 DOM id 与持久化）。 */
    const SETTINGS_TABS = [
      { id: 'voice', label: '语音' },
      { id: 'model', label: '模型（只读）' },
      { id: 'image', label: '配图' },
      { id: 'usage', label: '用量与费用' },
      { id: 'storage', label: '存储与回收站' },
      { id: 'diagnostics', label: '诊断' },
    ];
    const SETTINGS_TAB_KEY = 'blm-settings-tab';

    /** 只认白名单里的栏目；sessionStorage 不可用（隐私模式/SSR）时回「语音」。 */
    function readSettingsTab() {
      try {
        if (typeof sessionStorage === 'undefined') return 'voice';
        const value = sessionStorage.getItem(SETTINGS_TAB_KEY);
        return SETTINGS_TABS.some((tab) => tab.id === value) ? value : 'voice';
      } catch {
        return 'voice';
      }
    }

    function saveSettingsTab(id) {
      try {
        if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(SETTINGS_TAB_KEY, String(id || ''));
      } catch {
        /* 隐私模式下 sessionStorage 会抛，忽略 */
      }
    }

    /** 标签键盘导航：←/→ 循环，Home/End 首尾；不认识的键返回 -1（不拦截）。 */
    function settingsTabIndexForKey(index, key) {
      const count = SETTINGS_TABS.length;
      if (key === 'ArrowRight') return (index + 1) % count;
      if (key === 'ArrowLeft') return (index - 1 + count) % count;
      if (key === 'Home') return 0;
      if (key === 'End') return count - 1;
      return -1;
    }

    function Settings({ onBack, notify, initial, onOpenUsage }) {
      const seed = initial && typeof initial === 'object' ? initial : {};
      const [settings, setSettings] = useState(seed.settings || null);
      const [voice, setVoice] = useState(seed.voice || null);
      const [providers, setProviders] = useState(seed.providers || []);
      const [models, setModels] = useState(seed.models || []);
      const [qwenVoices, setQwenVoices] = useState(seed.qwenVoices || []);
      const [ttsWorkflow, setTtsWorkflow] = useState(seed.workflow || null);
      const [ttsTable, setTtsTable] = useState(seed.voiceTable || null);
      const [ttsProbe, setTtsProbe] = useState(null);
      const [ttsMsg, setTtsMsg] = useState('');
      const [ttsBusy, setTtsBusy] = useState(false);
      const [pendingWorkflow, setPendingWorkflow] = useState(null);
      const [pendingTextNode, setPendingTextNode] = useState('');
      const [probe, setProbe] = useState(PROBE_IDLE);
      const probeLockRef = useRef(false);
      const probeAliveRef = useRef(true);
      const probeTokenRef = useRef(0);
      const probeCacheRef = useRef(null);
      const probeAudioRef = useRef(null);
      const [diagnostics, setDiagnostics] = useState(seed.diagnostics || null);
      const [aliasConfig, setAliasConfig] = useState(null);
      const [aliasText, setAliasText] = useState('');
      const [aliasBusy, setAliasBusy] = useState(false);
      const [aliasMsg, setAliasMsg] = useState('');
      const [form, setForm] = useState(() => {
        const saved = seed.voice || null;
        return saved
          ? {
              provider: saved.provider || 'browser',
              model: saved.model || 'qwen3-tts-flash',
              voice: saved.voice || '',
              comfyRefVoice: saved.comfyRefVoice || 'builtin-vivian',
              textNode: saved.textNode || '',
              rate: Number(saved.rate) || 1,
            }
          : {
              provider: 'browser',
              model: 'qwen3-tts-flash',
              voice: '',
              comfyRefVoice: 'builtin-vivian',
              textNode: '',
              rate: 1,
            };
      });
      const [apiKeyInput, setApiKeyInput] = useState('');
      const [editingKey, setEditingKey] = useState(false);
      const [voices, setVoices] = useState([]);
      const [message, setMessage] = useState('');
      const [error, setError] = useState(null);
      const [saving, setSaving] = useState(false);
      const [trashBusy, setTrashBusy] = useState(false);
      const [image, setImage] = useState(null);
      const [imageBusy, setImageBusy] = useState(false);
      const [imageMsg, setImageMsg] = useState('');
      const [imageTestUrl, setImageTestUrl] = useState('');
      const [usageMonth, setUsageMonth] = useState(null);
      const [usageTotal, setUsageTotal] = useState(null);
      const [prices, setPrices] = useState(null);
      const [pricesDraft, setPricesDraft] = useState('');
      const [localProviders, setLocalProviders] = useState('');
      const [usageMsg, setUsageMsg] = useState('');
      const [usageBusy, setUsageBusy] = useState(false);

      /* ---------- 2.5 顶栏标签：状态、指示条与键盘 ---------- */
      const [activeTab, setActiveTab] = useState(readSettingsTab);
      const [ink, setInk] = useState(null);
      const activeTabRef = useRef(activeTab);
      const rootRef = useRef(null);
      const tabsWrapRef = useRef(null);
      const tabsRef = useRef(null);
      const contentRef = useRef(null);
      const tabScrollPendingRef = useRef(false);

      /** 共享指示条：按活动按钮的 offsetLeft/offsetWidth 定位；resize、字体就绪后重测。 */
      const measureSettingsInk = useCallback(() => {
        const bar = tabsRef.current;
        if (!bar) return;
        const active = bar.querySelector('.blm-tab[aria-selected="true"]');
        if (!active) return;
        const left = active.offsetLeft;
        const width = active.offsetWidth;
        setInk((prev) => (prev && prev.left === left && prev.width === width ? prev : { left, width }));
        // 活动标签被挤出可视区（窄屏 / 窗口缩小）时滚回来。
        if (left < bar.scrollLeft) bar.scrollLeft = left;
        else if (left + width > bar.scrollLeft + bar.clientWidth) bar.scrollLeft = left + width - bar.clientWidth;
      }, []);

      useEffect(() => {
        activeTabRef.current = activeTab;
        saveSettingsTab(activeTab);
        measureSettingsInk();
      }, [activeTab, measureSettingsInk]);

      useEffect(() => {
        const bar = tabsRef.current;
        if (!bar) return undefined;
        const remeasure = () => measureSettingsInk();
        let observer = null;
        if (typeof ResizeObserver !== 'undefined') {
          observer = new ResizeObserver(remeasure);
          observer.observe(bar);
        }
        window.addEventListener('resize', remeasure);
        if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
          document.fonts.ready.then(remeasure).catch(() => {});
        }
        return () => {
          if (observer) observer.disconnect();
          window.removeEventListener('resize', remeasure);
        };
      }, [measureSettingsInk]);

      const selectSettingsTab = (id) => {
        if (id === activeTab || !SETTINGS_TABS.some((tab) => tab.id === id)) return;
        tabScrollPendingRef.current = true;
        setActiveTab(id);
      };

      const onSettingsTabKeyDown = (event, index) => {
        const next = settingsTabIndexForKey(index, event.key);
        if (next < 0) return;
        event.preventDefault();
        const target = SETTINGS_TABS[next];
        selectSettingsTab(target.id);
        const bar = tabsRef.current;
        const button = bar && bar.querySelector('[data-settings-tab="' + target.id + '"]');
        if (button && typeof button.focus === 'function') button.focus();
      };

      // 切栏目后把面板顶部滚到标签栏下沿；已经可见就不动，避免标题行无故滚走。
      useEffect(() => {
        if (!tabScrollPendingRef.current) return;
        tabScrollPendingRef.current = false;
        const root = rootRef.current;
        const wrap = tabsWrapRef.current;
        const content = contentRef.current;
        if (!root || !wrap || !content) return;
        const top = root.getBoundingClientRect().top;
        const barHeight = wrap.offsetHeight || 0;
        const contentTop = content.getBoundingClientRect().top;
        if (contentTop >= top + barHeight - 1) return;
        root.scrollTop += contentTop - (top + barHeight);
      }, [activeTab]);

      const loadUsage = useCallback(async () => {
        const [monthOut, totalOut, priceOut] = await Promise.all([
          api('/usage/summary?from=' + encodeURIComponent(monthStartIso())).catch(() => null),
          api('/usage/summary').catch(() => null),
          api('/usage/prices').catch(() => null),
        ]);
        if (monthOut) setUsageMonth(monthOut);
        if (totalOut) setUsageTotal(totalOut);
        if (priceOut && priceOut.prices) {
          setPrices(priceOut.prices);
          setPricesDraft(JSON.stringify(priceOut.prices.prices || [], null, 2));
          setLocalProviders((priceOut.localProviders || []).join(', '));
        }
      }, []);

      const savePrices = async (payload) => {
        setUsageBusy(true);
        setUsageMsg('');
        try {
          const out = await api('/usage/prices', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          });
          setPrices(out.prices);
          setPricesDraft(JSON.stringify(out.prices.prices || [], null, 2));
          setLocalProviders((out.localProviders || []).join(', '));
          setUsageMsg('价格表已保存');
          await loadUsage();
        } catch (err) {
          setUsageMsg(err.message);
        } finally {
          setUsageBusy(false);
        }
      };

      const saveDraftPrices = () => {
        let parsed;
        try {
          parsed = JSON.parse(pricesDraft || '[]');
        } catch {
          setUsageMsg('价格表不是合法 JSON');
          return;
        }
        savePrices({
          prices: parsed,
          priceVersion: (prices && prices.priceVersion) || new Date().toISOString().slice(0, 10),
          localProviders: localProviders
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        });
      };

      const clearUsage = async () => {
        const ok = await confirmAction('清空全部用量历史？只删账本，不影响书、系列与音频。', {
          title: '清空用量历史',
          okText: '清空',
          danger: true,
        });
        if (!ok) return;
        setUsageBusy(true);
        try {
          const out = await api('/usage/jobs', { method: 'DELETE' });
          setUsageMsg('已清空 ' + (Number(out.removed) || 0) + ' 条记录');
          await loadUsage();
        } catch (err) {
          setUsageMsg(err.message);
        } finally {
          setUsageBusy(false);
        }
      };

      const saveAliases = async (reset = false) => {
        setAliasBusy(true);
        setAliasMsg('');
        try {
          let body = { reset };
          if (!reset) {
            let aliases;
            try {
              aliases = JSON.parse(aliasText || '[]');
            } catch {
              throw new Error('别名表不是合法 JSON');
            }
            if (!Array.isArray(aliases)) throw new Error('别名表必须是数组');
            body = { aliases };
          }
          const out = await api('/settings/must-keep-aliases', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!out || out.ok !== true) throw new Error((out && (out.error || out.code)) || '保存失败');
          setAliasConfig(out);
          setAliasText(JSON.stringify(out.custom || [], null, 2));
          setAliasMsg(reset ? '已恢复内置别名表' : '别名表已保存');
          notify(reset ? '已恢复内置别名表' : '别名表已保存');
        } catch (err) {
          setAliasMsg(err.message || String(err));
        } finally {
          setAliasBusy(false);
        }
      };

      const loadSettings = useCallback(async () => {
        const [settingsOut, voiceOut, diagOut, imageOut, aliasOut] = await Promise.all([
          api('/settings'),
          api('/voice'),
          api('/diagnostics').catch(() => null),
          api('/image/config').catch(() => null),
          api('/settings/must-keep-aliases').catch(() => null),
        ]);
        setSettings(settingsOut);
        setVoice(voiceOut.voice || null);
        setProviders(voiceOut.providers || []);
        setModels(voiceOut.models || []);
        setQwenVoices(voiceOut.qwenVoices || []);
        setTtsWorkflow(voiceOut.workflow || null);
        setTtsTable(voiceOut.voiceTable || null);
        setDiagnostics(diagOut);
        setImage(imageOut && imageOut.ok ? imageOut : null);
        if (aliasOut && aliasOut.ok) {
          setAliasConfig(aliasOut);
          setAliasText(JSON.stringify(aliasOut.custom || [], null, 2));
        }
        if (voiceOut.voice) {
          setForm({
            provider: voiceOut.voice.provider || 'browser',
            model: voiceOut.voice.model || 'qwen3-tts-flash',
            voice: voiceOut.voice.voice || '',
            comfyRefVoice: voiceOut.voice.comfyRefVoice || 'builtin-vivian',
            textNode: voiceOut.voice.textNode || '',
            rate: Number(voiceOut.voice.rate) || 1,
          });
        }
        await loadUsage().catch(() => {});
      }, [loadUsage]);

      useEffect(() => {
        let alive = true;
        loadSettings().catch((err) => {
          if (alive) setError(err);
        });
        return () => {
          alive = false;
        };
      }, [loadSettings]);

      // 浏览器音色是异步加载的（Chrome 首次为空数组）
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
            const out = await api('/voice', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(next),
            });
            setVoice(out.voice || null);
            setProviders(out.providers || []);
            setModels(out.models || []);
            setQwenVoices(out.qwenVoices || []);
            setTtsWorkflow(out.workflow || ttsWorkflow);
            setTtsTable(out.voiceTable || ttsTable);
            if (out.voice) {
              setForm({
                provider: out.voice.provider || 'browser',
                model: out.voice.model || 'qwen3-tts-flash',
                voice: out.voice.voice || '',
                comfyRefVoice: out.voice.comfyRefVoice || 'builtin-vivian',
                textNode: out.voice.textNode || '',
                rate: Number(out.voice.rate) || 1,
              });
            }
            setMessage('已保存');
            setError(null);
            return out.voice;
          } catch (err) {
            setError(err);
            return null;
          } finally {
            setSaving(false);
          }
        },
        [form, ttsWorkflow, ttsTable],
      );

      const saveApiKey = async () => {
        const key = String(apiKeyInput || '').trim();
        if (!key) return;
        const saved = await save({ apiKey: key });
        if (saved) {
          setApiKeyInput('');
          setEditingKey(false);
          setMessage('API Key 已保存（面板只显示尾号）');
          await loadSettings().catch(() => {});
        }
      };

      const clearApiKey = async () => {
        const ok = await confirmAction('清除已保存的 Qwen API Key？清除后配音会停用。', {
          title: '清除 API Key',
          okText: '清除',
          danger: true,
        });
        if (!ok) return;
        const saved = await save({ clearApiKey: true });
        if (saved) {
          setApiKeyInput('');
          setEditingKey(false);
          setMessage('API Key 已清除');
        }
      };

      const saveComfyAddress = async (patch) => {
        setTtsBusy(true);
        setTtsMsg('');
        try {
          const out = await api('/image/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch || {}),
          });
          if (out.ok) {
            setImage(out);
            setTtsMsg('ComfyUI 地址已保存（与配图共用）');
          }
        } catch (err) {
          setTtsMsg(String((err && err.message) || err));
        } finally {
          setTtsBusy(false);
        }
      };

      const probeComfyConnection = async () => {
        setTtsBusy(true);
        setMessage('');
        setTtsMsg('正在连接 ComfyUI…');
        try {
          const res = await fetch(API + '/voice/comfy/probe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // 带上当前下拉选中项：导入后尚未保存也能检查“眼前这一项”，而不是 voice.json 里的旧值。
            body: JSON.stringify({ comfyRefVoice: comfyRefVoiceValue }),
          });
          const raw = await res.text();
          let out = null;
          try {
            out = JSON.parse(raw);
          } catch {
            out = null;
          }
          if (!out) {
            const err = new Error('连接测试失败：插件服务无响应（HTTP ' + res.status + '），重启 DSH 后再试');
            err.code = 'E_BAD_RESPONSE';
            throw err;
          }
          if (!out.ok) {
            const err = new Error(out.message || out.error || '连接失败');
            err.code = out.code;
            throw err;
          }
          setTtsProbe(out);
          const missed = out.missing && Array.isArray(out.missing.nodes) ? out.missing.nodes : [];
          const ref = out.refVoice || {};
          const refNotice = refDurationNotice(ref);
          const refFlag = refNotice
            ? '（' + (refNotice.level === 'warn' ? '超出推荐 5–15s，建议截短' : '超出推荐 5–15s，容忍区内') + '）'
            : '';
          setTtsMsg(
            '连接成功（ComfyUI ' + (out.version || '未知版本') + '）' +
              (ref.name ? '；参考：' + ref.name + (ref.duration_ms ? ' ' + (ref.duration_ms / 1000).toFixed(1) + 's' : '') + refFlag : '') +
              (missed.length ? '；缺节点：' + missed.slice(0, 3).join('、') : ''),
          );
        } catch (err) {
          setTtsProbe(null);
          setTtsMsg(((err && err.code) || 'E_TTS_CONNECT') + '：' + String((err && err.message) || err));
        } finally {
          setTtsBusy(false);
        }
      };

      const importVoicePair = async (files) => {
        const list = Array.from(files || []);
        if (!list.length) return;
        setTtsBusy(true);
        setTtsMsg('');
        try {
          const audios = list.filter((file) => /\.(wav|flac|mp3|ogg)$/i.test(file.name));
          const texts = list.filter((file) => /\.txt$/i.test(file.name));
          if (list.length !== 2 || audios.length !== 1 || texts.length !== 1) {
            setTtsMsg('一次选一个参考音频和它的 .txt 逐字转写（共两个文件）。');
            return;
          }
          const audio = audios[0];
          if (audio.size > 32 * 1024 * 1024) {
            setTtsMsg('参考音频超过 32MB，截短后再导入。');
            return;
          }
          const refText = (await texts[0].text()).replace(/^\uFEFF/, '').trim();
          if (!refText) {
            setTtsMsg('参考文本为空：.txt 必须是参考音频的逐字转写。');
            return;
          }
          if (refText.length > 2000) {
            setTtsMsg('参考文本超过 2000 字，截短后再导入。');
            return;
          }
          const form = new FormData();
          form.append('audio', audio, audio.name);
          form.append('ref_text', refText);
          form.append('name', audio.name.replace(/\.[^.]+$/, ''));
          const out = await api('/voice/refvoices/import', { method: 'POST', body: form });
          setTtsTable(out.table || null);
          setTtsProbe(null);
          const entry = out.entry || null;
          if (entry && entry.id) {
            setForm((prev) => Object.assign({}, prev, { comfyRefVoice: entry.id }));
            // 选中项落盘：连接测试/配音读 voice.json；只改本地 state 会继续检查旧参考。
            const saved = await save({ comfyRefVoice: entry.id });
            setTtsMsg(
              '已导入参考 voice「' + (entry.name || audio.name) + '」' +
                (saved ? '' : '（选中项没保存成功，请点「保存」重试）'),
            );
          } else {
            setTtsMsg('已导入参考 voice「' + audio.name + '」');
          }
        } catch (err) {
          const detail = (err && err.detail) || {};
          setTtsMsg((detail.code || err.code || 'E_TTS_VOICE_REF') + '：' + (detail.message || detail.error || err.message));
        } finally {
          setTtsBusy(false);
        }
      };

      const resetVoiceTable = async () => {
        setTtsBusy(true);
        try {
          const out = await api('/voice/refvoices', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reset: true }),
          });
          setTtsTable(out.table || null);
          setTtsProbe(null);
          setForm((prev) => Object.assign({}, prev, { comfyRefVoice: (out.table && out.table.defaultVoice) || prev.comfyRefVoice }));
          setTtsMsg('已恢复默认参考 voice 库（2 项）');
        } catch (err) {
          setTtsMsg(String((err && err.message) || err));
        } finally {
          setTtsBusy(false);
        }
      };

      const importVoiceWorkflow = async (file) => {
        if (!file) return;
        setTtsBusy(true);
        setTtsMsg('');
        try {
          const text = (await file.text()).replace(/^\uFEFF/, '');
          let workflow = null;
          try {
            workflow = JSON.parse(text);
          } catch {
            setTtsMsg('工作流不是合法 JSON');
            return;
          }
          const out = await api('/voice/workflow', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workflow, name: file.name }),
          });
          setTtsWorkflow(out.workflow || null);
          setPendingWorkflow(null);
          setTtsProbe(null);
          if (out.workflow && out.workflow.textNode) setForm((prev) => Object.assign({}, prev, { textNode: out.workflow.textNode }));
          setTtsMsg('配音工作流已导入（' + ((out.workflow && out.workflow.format) || '') + '）');
        } catch (err) {
          const detail = (err && err.detail) || {};
          const candidates = detail.candidates || [];
          if (detail.code === 'E_TTS_WORKFLOW_NODE' && candidates.length) {
            setPendingWorkflow({ workflow, name: file.name, candidates });
            setPendingTextNode(candidates[0].id);
            setTtsMsg('这个工作流有多个朗读稿输入位置，请选择一个后确认导入。');
            return;
          }
          setTtsMsg(
            (detail.code || err.code || 'E_TTS_WORKFLOW') + '：' + (detail.error || err.message) +
              (candidates.length ? '；可选朗读稿位置：' + candidates.map((item) => item.id).join('、') : ''),
          );
        } finally {
          setTtsBusy(false);
        }
      };

      const resetVoiceWorkflow = async () => {
        setTtsBusy(true);
        try {
          const out = await api('/voice/workflow', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reset: true }),
          });
          setTtsWorkflow(out.workflow || null);
          setPendingWorkflow(null);
          setTtsProbe(null);
          if (out.workflow && out.workflow.textNode) setForm((prev) => Object.assign({}, prev, { textNode: out.workflow.textNode }));
          setTtsMsg('已恢复默认配音工作流');
        } catch (err) {
          setTtsMsg(String((err && err.message) || err));
        } finally {
          setTtsBusy(false);
        }
      };

      const selectVoiceTextNode = async (value) => {
        const saved = await save({ textNode: value });
        if (saved) {
          setTtsMsg('朗读稿输入位置已保存');
          setTtsWorkflow((prev) => (prev ? Object.assign({}, prev, { textNode: value }) : prev));
        }
      };

      const confirmPendingWorkflow = async () => {
        if (!pendingWorkflow) return;
        setTtsBusy(true);
        try {
          const out = await api('/voice/workflow', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workflow: pendingWorkflow.workflow, name: pendingWorkflow.name, textNode: pendingTextNode }),
          });
          setTtsWorkflow(out.workflow || null);
          setPendingWorkflow(null);
          setTtsProbe(null);
          if (out.workflow && out.workflow.textNode) setForm((prev) => Object.assign({}, prev, { textNode: out.workflow.textNode }));
          setTtsMsg('配音工作流已导入（已选朗读稿位置）');
        } catch (err) {
          const detail = (err && err.detail) || {};
          setTtsMsg((detail.code || err.code || 'E_TTS_WORKFLOW') + '：' + (detail.error || err.message));
        } finally {
          setTtsBusy(false);
        }
      };

      const clearTrashNow = async () => {
        const ok = await confirmAction('清空回收站？删除的书会真正被删掉，不能再恢复。', {
          title: '清空回收站',
          okText: '清空',
          danger: true,
        });
        if (!ok) return;
        setTrashBusy(true);
        setMessage('');
        try {
          const out = await api('/trash/clear', { method: 'POST' });
          await loadSettings();
          setMessage('已清空 ' + (out.count || 0) + ' 本，释放 ' + formatSize(out.bytes || 0));
        } catch (err) {
          setError(err);
        } finally {
          setTrashBusy(false);
        }
      };

      const removeBackup = async (item) => {
        const ok = await confirmAction('删除备份「' + item.name + '」？删除后旧数据无法恢复。', {
          title: '删除备份',
          okText: '删除',
          danger: true,
        });
        if (!ok) return;
        try {
          await api('/backups/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: item.name }),
          });
          await loadSettings();
          setMessage('备份已删除');
        } catch (err) {
          setError(err);
        }
      };

      const openBackupDir = async (item) => {
        try {
          const out = await api('/backups/open', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: item.name }),
          });
          setMessage(out.opened ? '已在文件管理器打开' : '请手动打开：' + out.path);
        } catch (err) {
          setError(err);
        }
      };

      const providerNote = (providers.find((item) => item.id === form.provider) || {}).note || (voice && voice.note) || '';
      const speechOk = speechSupported();

      /* ------------------------------ 配图（FR-24） ------------------------------ */

      const saveImageConfig = async (patch) => {
        setImageBusy(true);
        setImageMsg('');
        try {
          const out = await api('/image/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch || {}),
          });
          if (out.ok) {
            setImage(out);
            setImageMsg('配图配置已保存');
          } else {
            setImageMsg(out.message || '没保存下来');
          }
        } catch (err) {
          setImageMsg(err.message);
        } finally {
          setImageBusy(false);
        }
      };

      const probeImages = async () => {
        setImageBusy(true);
        setImageMsg('正在连接 ComfyUI…');
        try {
          const out = await api('/image/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
          if (!out.ok) setImageMsg((out.code || '') + '：' + (out.message || '连接失败'));
          else if (out.missing && out.missing.length) setImageMsg('连接成功，但缺模型：' + out.missing.slice(0, 3).join('；'));
          else setImageMsg('连接成功（ComfyUI ' + (out.version || '未知版本') + '）');
        } catch (err) {
          setImageMsg(err.message);
        } finally {
          setImageBusy(false);
        }
      };

      const testImages = async () => {
        setImageBusy(true);
        setImageMsg('正在测试生图…');
        try {
          const res = await fetch(API + '/image/test', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          });
          if (String(res.headers.get('content-type') || '').includes('image/')) {
            const blob = await res.blob();
            if (imageTestUrl) URL.revokeObjectURL(imageTestUrl);
            setImageTestUrl(URL.createObjectURL(blob));
            setImageMsg('测试生图成功（不落盘、不进缓存）');
            return;
          }
          const out = await res.json().catch(() => ({}));
          setImageMsg((out.code || '') + '：' + (out.message || out.error || '测试生图失败'));
        } catch (err) {
          setImageMsg(err.message);
        } finally {
          setImageBusy(false);
        }
      };

      const importWorkflow = async (file) => {
        if (!file) return;
        setImageBusy(true);
        setImageMsg('');
        try {
          const text = (await file.text()).replace(/^\uFEFF/, '');
          let workflow = null;
          try {
            workflow = JSON.parse(text);
          } catch {
            setImageMsg('工作流不是合法 JSON');
            return;
          }
          const out = await api('/image/workflow', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workflow, name: file.name }),
          });
          if (!out.ok) {
            setImageMsg((out.code || '') + '：' + (out.error || '工作流没导入') + (out.candidates && out.candidates.length ? '；可选提示词节点：' + out.candidates.map((item) => item.id).join('、') : ''));
            return;
          }
          setImage(out);
          setImageMsg('工作流已导入');
        } catch (err) {
          setImageMsg(err.message);
        } finally {
          setImageBusy(false);
        }
      };

      const resetWorkflowCfg = async () => {
        setImageBusy(true);
        try {
          const out = await api('/image/workflow', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reset: true }),
          });
          if (out.ok) {
            setImage(out);
            setImageMsg('已恢复默认工作流');
          }
        } catch (err) {
          setImageMsg(err.message);
        } finally {
          setImageBusy(false);
        }
      };

      const imageForm = (image && image.image) || null;
      const workflowInfo = (imageForm && imageForm.workflow) || {};
      const comfyAddress = imageForm || { host: '127.0.0.1', port: 8188, baseUrl: 'http://127.0.0.1:8188' };
      const ttsRefs = (ttsTable && ttsTable.voices) || [];
      const comfyRefVoiceValue = ttsRefs.some((item) => item.id === form.comfyRefVoice)
        ? form.comfyRefVoice
        : (ttsTable && ttsTable.defaultVoice) || '';
      const selectedRef = ttsRefs.find((item) => item.id === comfyRefVoiceValue) || null;
      const selectedRefNotice = refDurationNotice(selectedRef);
      const probeWarnings = ttsProbe && Array.isArray(ttsProbe.warnings)
        ? ttsProbe.warnings.filter((item) => !selectedRefNotice || String(item) !== selectedRefNotice.text)
        : [];

      const removeVoiceRef = async () => {
        if (!selectedRef || selectedRef.source === 'builtin') return;
        const ok = await confirmAction('删除参考 voice「' + selectedRef.name + '」？', {
          title: '删除参考 voice',
          okText: '删除',
          danger: true,
        });
        if (!ok) return;
        setTtsBusy(true);
        try {
          const out = await api('/voice/refvoices', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ remove: selectedRef.id }),
          });
          setTtsTable(out.table || null);
          setTtsProbe(null);
          setForm((prev) => Object.assign({}, prev, { comfyRefVoice: (out.table && out.table.defaultVoice) || '' }));
          setTtsMsg('已删除参考 voice「' + selectedRef.name + '」');
        } catch (err) {
          const detail = (err && err.detail) || {};
          setTtsMsg((detail.code || err.code || 'E_TTS_VOICE_REF') + '：' + (detail.message || detail.error || err.message));
        } finally {
          setTtsBusy(false);
        }
      };

      /* ------------------------------ 试听（FR-23 / AC-149） ------------------------------ */

      /** 任何会改变试听结果的配置变化都让浏览器内存里的试听缓存失效。 */
      const probeSignature = () => {
        const selected = ttsRefs.find((item) => item.id === comfyRefVoiceValue);
        const address =
          comfyAddress.baseUrl || (comfyAddress.host || '') + ':' + (comfyAddress.port || '');
        return [
          form.provider,
          form.model || '',
          form.voice || '',
          String(form.rate || ''),
          form.provider === 'comfyui-tts' ? comfyRefVoiceValue : '',
          form.provider === 'comfyui-tts' && selected ? selected.sha256 || '' : '',
          form.provider === 'comfyui-tts'
            ? ((ttsWorkflow && ttsWorkflow.name) || '') + ':' + (form.textNode || (ttsWorkflow && ttsWorkflow.textNode) || '')
            : '',
          form.provider === 'comfyui-tts' ? address : '',
        ].join('|');
      };

      const probeTarget = () => {
        const kind =
          form.provider === 'comfyui-tts'
            ? 'comfy'
            : form.provider === 'qwen3-tts'
              ? 'qwen'
              : form.provider === 'browser'
                ? 'browser'
                : 'off';
        const selected = ttsRefs.find((item) => item.id === comfyRefVoiceValue);
        const where =
          kind === 'comfy'
            ? 'ComfyUI 配音' + (selected ? '（参考：' + selected.name + '）' : '')
            : kind === 'qwen'
              ? 'Qwen3-TTS' + (form.voice ? '（音色：' + form.voice + '）' : '')
              : kind === 'browser'
                ? '本机朗读'
                : '语音';
        return { kind, where };
      };

      const probeStopAudio = () => {
        const audio = probeAudioRef.current;
        probeAudioRef.current = null;
        if (audio) {
          try {
            audio.onended = null;
            audio.onerror = null;
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
          } catch {
            /* 已结束 */
          }
        }
        stopSpeech();
      };

      const probeDropCache = () => {
        const cache = probeCacheRef.current;
        probeCacheRef.current = null;
        if (cache && cache.url) {
          try {
            URL.revokeObjectURL(cache.url);
          } catch {
            /* 已释放 */
          }
        }
      };

      /** 播放已有缓存：音频走 <audio>，浏览器朗读走 speechSynthesis；结束/失败都落到状态机。 */
      const startProbePlayback = (cache) => {
        const token = ++probeTokenRef.current;
        probeStopAudio();
        const timing = probeTiming(cache);
        const base = cache.where + (timing ? ' · ' + timing : '');
        const finish = (patch) => {
          if (!probeAliveRef.current || token !== probeTokenRef.current) return;
          probeAudioRef.current = null;
          setProbe((prev) =>
            Object.assign({}, prev, { phase: 'ready', elapsedMs: 0, blocked: false, note: '', tone: 'ok' }, patch),
          );
        };
        const fail = (note) => {
          if (!probeAliveRef.current || token !== probeTokenRef.current) return;
          // 播放失败后缓存不可再用；先让这段声音的回调失效，再释放 blob。
          ++probeTokenRef.current;
          probeStopAudio();
          probeDropCache();
          setProbe((prev) =>
            Object.assign({}, prev, { phase: 'error', elapsedMs: 0, blocked: false, note: note, tone: 'warn', code: 'E_TTS_PLAY' }),
          );
        };
        setProbe((prev) =>
          Object.assign({}, prev, {
            phase: 'playing',
            elapsedMs: 0,
            where: cache.where,
            audioMs: cache.audioMs,
            genMs: cache.genMs,
            blocked: false,
            note: '',
            tone: '',
          }),
        );
        let settled = false;
        if (cache.kind === 'browser') {
          try {
            speakText(cache.text, {
              rate: cache.rate,
              voice: cache.voice,
              onend: () => {
                if (settled) return;
                settled = true;
                finish({ note: '试听完成：本机朗读。点「重听」再听一次。' });
              },
              onerror: () => {
                if (settled) return;
                settled = true;
                fail('E_TTS_PLAY：本机朗读被打断或不可用。点「重试」再试一次。');
              },
            });
          } catch (err) {
            fail('本机朗读失败：' + String((err && err.message) || err));
          }
          return;
        }
        const audio = new Audio(cache.url);
        probeAudioRef.current = audio;
        audio.onended = () => {
          if (settled) return;
          settled = true;
          finish({ note: '试听完成：' + base + '。点「重听」重放；换参考/音色后会自动重新生成。' });
        };
        audio.onerror = () => {
          if (settled) return;
          settled = true;
          fail('E_TTS_PLAY：浏览器没能播放这段试听音频（文件可能损坏）。点「重试」重新生成。');
        };
        const promise = audio.play();
        if (promise && typeof promise.catch === 'function') {
          promise.catch(() => {
            if (settled) return;
            settled = true;
            if (!probeAliveRef.current || token !== probeTokenRef.current) return;
            if (probeAudioRef.current === audio) probeAudioRef.current = null;
            try {
              audio.pause();
            } catch {
              /* 忽略 */
            }
            setProbe((prev) =>
              Object.assign({}, prev, {
                phase: 'ready',
                elapsedMs: 0,
                blocked: true,
                note: '试听音频已生成，但浏览器阻止了自动播放；点「播放试听」手动播放。',
                tone: 'warn',
              }),
            );
          });
        }
      };

      /** 试听生成完成时若已离开「语音」标签：只置为可播放，不在后台出声。 */
      const playProbeIfVoice = (cache) => {
        if (activeTabRef.current === 'voice') {
          startProbePlayback(cache);
          return;
        }
        setProbe((prev) =>
          Object.assign({}, prev, {
            phase: 'ready',
            elapsedMs: 0,
            blocked: false,
            tone: '',
            note: '试听已生成：回到「语音」标签后点「播放试听」。',
          }),
        );
      };

      /** 播放中再点「试听」= 停止，不重新生成。 */
      const stopProbe = () => {
        if (probe.phase !== 'playing') return;
        ++probeTokenRef.current;
        const timing = probeTiming(probe);
        probeStopAudio();
        setProbe((prev) =>
          Object.assign({}, prev, {
            phase: 'ready',
            elapsedMs: 0,
            blocked: false,
            tone: '',
            note: '已停止播放：' + (prev.where || '试听') + (timing ? ' · ' + timing : '') + '。点「重听」重放。',
          }),
        );
      };

      // 离开「语音」标签：停止正在播放的试听（缓存保留，切回可直接重播）。
      useEffect(() => {
        if (activeTab === 'voice') return;
        if (probe.phase === 'playing') stopProbe();
      }, [activeTab, probe.phase]);

      /**
       * 试听：先把按钮置为「生成中」再 await；同配置再点走缓存「重听」，不重复跑 ComfyUI。
       * 请求/播放都用 token 防止迟到的回调覆盖新状态。
       */
      const startProbe = async () => {
        if (probeLockRef.current) return;
        const signature = probeSignature();
        const cached = probeCacheRef.current;
        if (cached && cached.signature === signature) {
          startProbePlayback(cached);
          return;
        }
        probeLockRef.current = true;
        const token = ++probeTokenRef.current;
        const target = probeTarget();
        const startedAt = Date.now();
        probeStopAudio();
        probeDropCache();
        setMessage('');
        setError(null);
        setProbe({
          phase: 'generating',
          startedAt,
          elapsedMs: 0,
          kind: target.kind,
          where: target.where,
          slow: target.kind === 'comfy',
          note: '',
          tone: 'progress',
          audioMs: 0,
          genMs: 0,
          blocked: false,
          code: '',
        });
        try {
          const res = await fetch(API + '/voice/probe', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              text: '你好，这是一段试听，用来确认语音能出声。',
              comfyRefVoice: form.provider === 'comfyui-tts' ? comfyRefVoiceValue : '',
              voice: form.provider === 'qwen3-tts' ? form.voice : '',
            }),
          });
          if (!probeAliveRef.current || token !== probeTokenRef.current) return;
          const genMs = Date.now() - startedAt;
          const type = String(res.headers.get('content-type') || '');
          if (type.includes('audio/')) {
            const blob = await res.blob();
            if (!probeAliveRef.current || token !== probeTokenRef.current) return;
            const label = String(res.headers.get('x-tts-voice-label') || '').trim();
            const cache = {
              signature,
              kind: 'audio',
              where: target.kind === 'comfy' && label ? 'ComfyUI 配音（参考：' + label + '）' : target.where,
              url: URL.createObjectURL(blob),
              audioMs: Number(res.headers.get('x-tts-ms')) || 0,
              genMs,
            };
            probeCacheRef.current = cache;
            playProbeIfVoice(cache);
            return;
          }
          const raw = await res.text();
          if (!probeAliveRef.current || token !== probeTokenRef.current) return;
          let result = null;
          try {
            result = JSON.parse(raw);
          } catch {
            result = null;
          }
          if (!result) {
            const err = new Error('试听失败：插件服务无响应（HTTP ' + res.status + '），重启 DSH 后再试');
            err.code = 'E_BAD_RESPONSE';
            throw err;
          }
          if (result.ok === false) {
            const err = new Error(result.error || result.message || result.code || '试听失败');
            err.code = result.code;
            err.hint = result.hint || '';
            throw err;
          }
          if (result.mode === 'browser') {
            const cache = {
              signature,
              kind: 'browser',
              where: '本机朗读',
              url: '',
              audioMs: Number(result.audio_ms) || 0,
              genMs: 0,
              text: result.text,
              rate: result.rate,
              voice: result.voice,
            };
            probeCacheRef.current = cache;
            playProbeIfVoice(cache);
            return;
          }
          setProbe(
            Object.assign({}, PROBE_IDLE, { phase: 'error', note: '试听已提交，但没有可播放的音频返回。', tone: 'warn' }),
          );
        } catch (err) {
          if (!probeAliveRef.current || token !== probeTokenRef.current) return;
          probeDropCache();
          const code = String((err && err.code) || '');
          const detail = String((err && err.message) || err || '试听失败');
          const hint = String((err && err.hint) || '');
          const note =
            code === 'E_TTS_UNCONFIGURED'
              ? '语音没配置好：' + detail + (hint ? ' ' + hint : '')
              : (code ? code + '：' : '') + detail + (hint ? '（' + hint + '）' : '');
          setProbe(Object.assign({}, PROBE_IDLE, { phase: 'error', note: note, tone: 'warn', code: code }));
        } finally {
          probeLockRef.current = false;
        }
      };

      /** 同配置重跑一次（不吃缓存）。 */
      const regenerateProbe = () => {
        probeDropCache();
        setProbe(PROBE_IDLE);
        startProbe();
      };

      // 生成中每 0.5s 刷新“已等待 Ns”，让长耗时可见。
      useEffect(() => {
        if (probe.phase !== 'generating') return undefined;
        const startedAt = Number(probe.startedAt) || Date.now();
        const tick = () => {
          setProbe((prev) =>
            prev.phase === 'generating'
              ? Object.assign({}, prev, { elapsedMs: Math.max(0, Date.now() - startedAt) })
              : prev,
          );
        };
        tick();
        const timer = setInterval(tick, 500);
        return () => clearInterval(timer);
      }, [probe.phase, probe.startedAt]);

      // 配置一变就释放旧缓存；正在播的不打断，等结束后自然回到「试听」。
      useEffect(() => {
        const cache = probeCacheRef.current;
        if (!cache || cache.signature === probeSignature()) return;
        if (probe.phase === 'playing') return;
        probeDropCache();
      }, [form, ttsRefs, comfyRefVoiceValue, ttsWorkflow, comfyAddress, probe.phase]);

      // 离开设置页：停声音、释放 blob、让迟到的响应失效。
      useEffect(() => {
        probeAliveRef.current = true;
        return () => {
          probeAliveRef.current = false;
          ++probeTokenRef.current;
          probeStopAudio();
          probeDropCache();
        };
      }, []);

      const probeCacheValid = Boolean(
        probeCacheRef.current && probeCacheRef.current.signature === probeSignature(),
      );
      const probeVisible = probe.phase === 'ready' && !probeCacheValid ? PROBE_IDLE : probe;
      const probeUi = probeView(probeVisible, {
        baseDisabled: saving || ttsBusy,
        idleTitle:
          form.provider === 'comfyui-tts'
            ? '用当前参考 voice 真跑一次 ComfyUI 克隆工作流；只播放，不落盘、不进音频缓存'
            : '试听当前供应商的合成效果',
      });

      return h(
        'div',
        { className: 'blm-body', ref: rootRef },
        h(
          'div',
          { className: 'blm-row', style: { marginBottom: 10 } },
          h('button', { className: 'blm-btn', onClick: onBack }, '← 书架'),
          h('h1', { style: { fontSize: 15, margin: 0 } }, '设置'),
          h('div', { style: { flex: 1 } }),
          h('button', { className: 'blm-btn', onClick: () => window.location.reload() }, '刷新页面'),
        ),
        error ? h('div', { className: 'blm-error' }, String(error.message || error)) : null,
        h(
          'div',
          { className: 'blm-tabs-wrap', ref: tabsWrapRef },
          h(
            'div',
            { className: 'blm-tabs', role: 'tablist', 'aria-label': '设置栏目', 'aria-orientation': 'horizontal', ref: tabsRef },
            SETTINGS_TABS.map((tab, index) =>
              h(
                'button',
                {
                  key: tab.id,
                  type: 'button',
                  id: 'blm-tab-' + tab.id,
                  className: 'blm-tab',
                  role: 'tab',
                  'data-settings-tab': tab.id,
                  'aria-selected': activeTab === tab.id ? 'true' : 'false',
                  'aria-controls': 'blm-panel-' + tab.id,
                  tabIndex: activeTab === tab.id ? 0 : -1,
                  onClick: () => selectSettingsTab(tab.id),
                  onKeyDown: (event) => onSettingsTabKeyDown(event, index),
                },
                tab.label,
              ),
            ),
            ink
              ? h('span', {
                  className: 'blm-tab-ink',
                  'aria-hidden': 'true',
                  style: { width: ink.width + 'px', transform: 'translateX(' + ink.left + 'px)' },
                })
              : null,
          ),
        ),
        h(
          'div',
          { className: 'blm-settings', ref: contentRef },
          h(
            'section',
            {
              className: 'blm-group',
              id: 'blm-panel-voice',
              role: 'tabpanel',
              'aria-labelledby': 'blm-tab-voice',
              hidden: activeTab !== 'voice',
            },
            h(
              'div',
              { className: 'blm-field' },
              h('span', { className: 'label' }, '供应商'),
              h(
                'select',
                {
                  className: 'blm-select',
                  value: form.provider,
                  disabled: saving,
                  'aria-label': '语音供应商',
                  title: providerNote || '选择配音方式',
                  onChange: (event) => {
                    const provider = event.target.value;
                    const patch = { provider };
                    if (provider === 'qwen3-tts' && !form.voice && qwenVoices.length) patch.voice = qwenVoices[0].id;
                    if (provider === 'browser' && form.provider === 'qwen3-tts') patch.voice = '';
                    if (provider === 'comfyui-tts' && !form.comfyRefVoice) patch.comfyRefVoice = (ttsTable && ttsTable.defaultVoice) || 'builtin-vivian';
                    save(patch);
                  },
                },
                (providers.length ? providers : [{ id: 'browser', label: '浏览器朗读（本机合成）', ready: true }]).map((item) =>
                  h('option', { key: item.id, value: item.id, disabled: !item.ready }, item.label + (item.ready ? '' : '（未接入）')),
                ),
              ),
            ),
            h(
              'div',
              { className: 'blm-field' },
              h('span', { className: 'label' }, 'TTS 模型'),
              h(
                'select',
                {
                  className: 'blm-select',
                  value: form.model,
                  disabled: saving || form.provider !== 'qwen3-tts',
                  'aria-label': '语音合成模型',
                  title: form.provider === 'comfyui-tts' ? 'ComfyUI 的模型由工作流决定' : '只切语音模型；生成文案仍走 DSH 默认模型',
                  onChange: (event) => save({ model: event.target.value }),
                },
                (models.length ? models : [{ id: 'qwen3-tts-flash', label: 'Qwen3-TTS Flash（非实时）', ready: true }]).map((item) =>
                  h('option', { key: item.id, value: item.id, disabled: !item.ready }, item.label + (item.ready ? '' : '（未接入）')),
                ),
              ),
            ),
            form.provider === 'qwen3-tts'
              ? h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'blm-field' },
                    h('span', { className: 'label' }, 'API Key'),
                    voice && voice.hasKey && !editingKey
                      ? h(
                          React.Fragment,
                          null,
                          h('span', { className: 'blm-chip' }, '已保存 · ' + String(voice.apiKeyMask || '')),
                          h('button', { className: 'blm-btn', disabled: saving, onClick: () => setEditingKey(true) }, '更换'),
                          h('button', { className: 'blm-btn', disabled: saving, onClick: clearApiKey }, '清除'),
                        )
                      : h(
                          React.Fragment,
                          null,
                          h('input', {
                            className: 'blm-input',
                            type: 'password',
                            value: apiKeyInput,
                            placeholder: '粘贴 Qwen API Key（只存本机）',
                            autoComplete: 'new-password',
                            'aria-label': 'Qwen API Key',
                            title: 'Key 存 voice.json（0600），面板只显示末 4 位；空输入不覆盖旧 Key',
                            onChange: (event) => setApiKeyInput(event.target.value),
                            onKeyDown: (event) => {
                              if (event.key === 'Enter') saveApiKey();
                            },
                          }),
                          h('button', { className: 'blm-btn primary', disabled: saving || !apiKeyInput.trim(), onClick: saveApiKey, title: '只存本机 voice.json；不写日志、URL 或讲次' }, '保存 Key'),
                          voice && voice.hasKey
                            ? h('button', { className: 'blm-btn', onClick: () => { setEditingKey(false); setApiKeyInput(''); } }, '取消')
                            : null,
                        ),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'blm-field' },
              h('span', { className: 'label' }, '音色'),
              form.provider === 'qwen3-tts'
                ? h(
                    'select',
                    {
                      className: 'blm-select',
                      value: form.voice,
                      disabled: saving,
                      'aria-label': 'Qwen 音色',
                      onChange: (event) => {
                        const value = event.target.value;
                        setForm((prev) => Object.assign({}, prev, { voice: value }));
                        save({ voice: value });
                      },
                    },
                    qwenVoices.map((item) =>
                      h(
                        'option',
                        { key: item.id, value: item.id },
                        item.id + ' · ' + item.desc + '（' + item.gender + (item.dialect ? '，' + item.dialect : '') + '）',
                      ),
                    ),
                  )
                : form.provider === 'comfyui-tts'
                  ? h(
                      'select',
                      {
                        className: 'blm-select',
                        value: comfyRefVoiceValue,
                        disabled: saving || ttsBusy || !ttsRefs.length,
                        'aria-label': 'ComfyUI 参考 voice',
                        onChange: (event) => {
                          const value = event.target.value;
                          setForm((prev) => Object.assign({}, prev, { comfyRefVoice: value }));
                          save({ comfyRefVoice: value });
                        },
                      },
                      ttsRefs.length
                        ? ttsRefs.map((item) =>
                            h(
                              'option',
                              { key: item.id, value: item.id },
                              item.name + (item.duration_ms ? ' · ' + (item.duration_ms / 1000).toFixed(1) + 's' : '') + (item.lang ? ' · ' + item.lang : '') +
                                (item.default ? '（默认）' : ''),
                            ),
                          )
                        : h('option', { value: '' }, '当前参考 voice 库为空'),
                    )
                  : h(
                      'select',
                      {
                        className: 'blm-select',
                        value: form.voice,
                        disabled: saving || form.provider !== 'browser',
                        'aria-label': '朗读音色',
                        onChange: (event) => save({ voice: event.target.value }),
                      },
                      h('option', { value: '' }, '系统默认'),
                      voices.map((item) => h('option', { key: item.voiceURI || item.name, value: item.name }, item.name + ' · ' + item.lang)),
                    ),
              form.provider === 'comfyui-tts'
                ? h('span', { className: 'blm-dim', style: { fontSize: 11 }, title: ttsTable ? ttsTable.name + ' · ' + (ttsTable.model || '未标注模型') : '参考 voice 库未加载' },
                    ttsTable ? (ttsTable.source === 'builtin' ? '内置' : '自定义') + '参考 voice 库 · ' + (ttsTable.count || 0) + ' 项' : '参考 voice 库未加载')
                : null,
            ),
            form.provider === 'browser'
              ? h(
                  'div',
                  { className: 'blm-field' },
                  h('span', { className: 'label', title: '只影响浏览器朗读；Qwen 与 ComfyUI 的语速由模型决定' }, '语速'),
                  h(
                    'select',
                    {
                      className: 'blm-select',
                      value: String(form.rate),
                      disabled: saving,
                      'aria-label': '朗读语速',
                      onChange: (event) => save({ rate: Number(event.target.value) }),
                    },
                    RATE_STEPS.map((rate) => h('option', { key: rate, value: String(rate) }, rate.toFixed(1) + '×')),
                  ),
                )
              : null,
            form.provider === 'comfyui-tts'
              ? h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'blm-field' },
                    h('span', { className: 'label' }, 'ComfyUI 地址'),
                    h('input', {
                      className: 'blm-input',
                      style: { flex: '0 0 140px', minWidth: 100 },
                      defaultValue: comfyAddress.host,
                      placeholder: '127.0.0.1',
                      'aria-label': 'ComfyUI 主机',
                      title: '默认 127.0.0.1；与配图共用这个地址',
                      onBlur: (event) => {
                        const host = String(event.target.value || '').trim();
                        if (host && host !== comfyAddress.host) saveComfyAddress({ host });
                      },
                    }),
                    h('input', {
                      className: 'blm-input',
                      style: { flex: '0 0 90px', minWidth: 70 },
                      type: 'number',
                      defaultValue: comfyAddress.port,
                      'aria-label': 'ComfyUI 端口',
                      title: '默认 8188；与配图共用这个端口',
                      onBlur: (event) => {
                        const port = Number(event.target.value);
                        if (port && port !== comfyAddress.port) saveComfyAddress({ port });
                      },
                    }),
                  ),
                  h(
                    'div',
                    { className: 'blm-field' },
                    h('span', { className: 'label' }, '配音工作流'),
                    h(
                      'span',
                      { className: 'blm-dim', style: { fontSize: 11 }, title: ttsWorkflow ? ttsWorkflow.name + ' · ' + (ttsWorkflow.format || '') + ' · ' + (ttsWorkflow.nodes || 0) + ' 节点' : '' },
                      ttsWorkflow ? (ttsWorkflow.source === 'default' ? '内置' : '自定义') + ' · ' + ttsWorkflow.name : '工作流未加载',
                    ),
                    h('button', {
                      className: 'blm-btn',
                      disabled: saving || ttsBusy,
                      title: '导入 ComfyUI 工作流（API 格式，或带 widgets_values_named 的界面格式）',
                      onClick: () => document.getElementById('blm-tts-workflow-input')?.click(),
                    }, '导入'),
                    h('input', {
                      id: 'blm-tts-workflow-input',
                      type: 'file',
                      accept: '.json,application/json',
                      style: { display: 'none' },
                      onChange: (event) => {
                        const file = event.target.files && event.target.files[0];
                        event.target.value = '';
                        importVoiceWorkflow(file);
                      },
                    }),
                    h('button', { className: 'blm-btn', disabled: saving || ttsBusy, title: '恢复内置默认工作流', onClick: resetVoiceWorkflow }, '恢复默认'),
                  ),
                  ttsWorkflow && (ttsWorkflow.candidates || []).length > 1
                    ? h(
                        'div',
                        { className: 'blm-field' },
                        h('span', { className: 'label', title: '工作流里有多个文本输入，选一个接收朗读稿；默认工作流只有一个，平时不显示这行' }, '朗读稿输入位置'),
                        h(
                          'select',
                          {
                            className: 'blm-select',
                            value: form.textNode || ttsWorkflow.textNode || '',
                            disabled: saving || ttsBusy,
                            'aria-label': '朗读稿输入位置',
                            onChange: (event) => selectVoiceTextNode(event.target.value),
                          },
                          (ttsWorkflow.candidates || []).map((item) =>
                            h('option', { key: item.id, value: item.id }, item.id + ' · ' + (item.class_type || '') + (item.text ? ' · ' + item.text.slice(0, 18) : '')),
                          ),
                        ),
                      )
                    : null,
                  pendingWorkflow
                    ? h(
                        'div',
                        { className: 'blm-field' },
                        h('span', { className: 'label', title: '导入的工作流有多个文本输入，先选一个再确认' }, '朗读稿输入位置'),
                        h(
                          'select',
                          {
                            className: 'blm-select',
                            value: pendingTextNode,
                            disabled: ttsBusy,
                            'aria-label': '选择朗读稿输入位置',
                            onChange: (event) => setPendingTextNode(event.target.value),
                          },
                          (pendingWorkflow.candidates || []).map((item) =>
                            h('option', { key: item.id, value: item.id }, item.id + ' · ' + (item.class_type || '') + (item.text ? ' · ' + item.text.slice(0, 18) : '')),
                          ),
                        ),
                        h('button', { className: 'blm-btn primary', disabled: ttsBusy, onClick: confirmPendingWorkflow }, '确认导入'),
                        h('button', { className: 'blm-btn', disabled: ttsBusy, onClick: () => setPendingWorkflow(null) }, '取消'),
                      )
                    : null,
                  h(
                    'div',
                    { className: 'blm-field' },
                    h('span', { className: 'label' }, '参考 voice 库'),
                    h(
                      'span',
                      { className: 'blm-dim', style: { fontSize: 11 }, title: ttsTable ? ttsTable.name + ' · ' + (ttsTable.model || '未标注模型') + ' · ' + (ttsTable.count || 0) + ' 项' : '参考 voice 库未加载' },
                      ttsTable ? (ttsTable.source === 'builtin' ? '内置' : '自定义') + '参考 voice 库 · ' + (ttsTable.count || 0) + ' 项' : '未加载',
                    ),
                    h('button', {
                      className: 'blm-btn',
                      disabled: saving || ttsBusy,
                      title: '选择一个参考音频（wav/flac/mp3/ogg）和它的逐字转写 .txt；一次选两个文件；音频会复制到数据根 voices/，不要求 ComfyUI 在线',
                      onClick: () => document.getElementById('blm-tts-refvoice-input')?.click(),
                    }, '导入参考 voice'),
                    h('input', {
                      id: 'blm-tts-refvoice-input',
                      type: 'file',
                      multiple: true,
                      accept: '.wav,.flac,.mp3,.ogg,.txt,audio/*,text/plain',
                      style: { display: 'none' },
                      onChange: (event) => {
                        const files = event.target.files ? Array.from(event.target.files) : [];
                        event.target.value = '';
                        importVoicePair(files);
                      },
                    }),
                    h('button', {
                      className: 'blm-btn',
                      disabled: saving || ttsBusy || !selectedRef || selectedRef.source === 'builtin',
                      title: selectedRef && selectedRef.source === 'builtin' ? '内置参考不能删除；用「恢复默认」回到内置 2 项' : '删除当前选中的自定义参考 voice（只删表项，不删原始文件）',
                      onClick: removeVoiceRef,
                    }, '删除'),
                    h('button', { className: 'blm-btn', disabled: saving || ttsBusy, title: '恢复内置参考 voice（Vivian / Uncle_fu）', onClick: resetVoiceTable }, '恢复默认'),
                  ),
                  h(
                    'div',
                    { className: 'blm-dim', style: { fontSize: 11, lineHeight: 1.5 } },
                    '一个参考 voice = 参考音频 + 它的逐字转写（.txt）；一次选两个文件导入，音频会复制到数据根 voices/。',
                  ),
                  selectedRefNotice
                    ? h(
                        'div',
                        {
                          className: 'blm-note ' + (selectedRefNotice.level === 'warn' ? 'warn' : 'tip'),
                          role: 'status',
                          'aria-live': 'polite',
                          'data-ref-duration': selectedRefNotice.level,
                        },
                        selectedRefNotice.text,
                      )
                    : null,
                  ttsMsg ? h('div', { className: 'blm-note' }, ttsMsg) : null,
                  probeWarnings.length
                    ? h(
                        'div',
                        { className: 'blm-note warn', role: 'status', 'aria-live': 'polite' },
                        '连接测试提示：' + probeWarnings.join('；'),
                      )
                    : null,
                  ttsWorkflow && ttsWorkflow.warnings && ttsWorkflow.warnings.length
                    ? h('div', { className: 'blm-note warn' }, ttsWorkflow.warnings.join('；'))
                    : null,
                  ttsTable && ttsTable.warning ? h('div', { className: 'blm-note warn' }, ttsTable.warning) : null,
                )
              : null,
            message ? h('div', { className: 'blm-note' }, message) : null,
            form.provider === 'browser' && !speechOk
              ? h('div', { className: 'blm-note warn' }, '当前浏览器不支持本机朗读；换 Chrome / Edge 最新版。')
              : null,
            h(
              'div',
              { className: 'blm-row blm-voice-actions' },
              form.provider === 'comfyui-tts'
                ? h(
                    'button',
                    {
                      className: 'blm-btn',
                      disabled: saving || ttsBusy,
                      title: '只读检查 ComfyUI 版本、节点与参考 voice，不生成音频',
                      onClick: probeComfyConnection,
                    },
                    ttsBusy ? '测试中…' : '连接测试',
                  )
                : null,
              h(
                'button',
                {
                  className: 'blm-btn',
                  disabled: probeUi.disabled,
                  'aria-busy': probeUi.busy ? 'true' : undefined,
                  title: probeUi.title,
                  onClick: probe.phase === 'playing' ? stopProbe : startProbe,
                },
                probeUi.label,
              ),
              h('div', { style: { flex: 1 } }),
              h(
                'button',
                {
                  className: 'blm-btn primary',
                  style: { minWidth: 92 },
                  disabled: saving,
                  title: '保存语音设置；改下拉时也会自动保存',
                  onClick: () => save({}),
                },
                saving ? '保存中…' : '保存',
              ),
            ),
            probeUi.note
              ? h(
                  'div',
                  {
                    className: 'blm-note blm-probe-note' + (probeUi.tone === 'warn' ? ' warn' : ''),
                    role: 'status',
                    'aria-live': 'polite',
                  },
                  h('span', { className: 'blm-probe-text' }, probeUi.note),
                  probe.phase === 'ready' && probeCacheValid && !probe.blocked
                    ? h(
                        'button',
                        {
                          className: 'blm-probe-regen',
                          type: 'button',
                          disabled: saving || ttsBusy,
                          title: '按当前配置重新生成一次试听（会重新跑一次 ComfyUI）',
                          onClick: regenerateProbe,
                        },
                        '重新生成',
                      )
                    : null,
                )
              : null,
          ),
          h(
            'section',
            {
              className: 'blm-group',
              id: 'blm-panel-model',
              role: 'tabpanel',
              'aria-labelledby': 'blm-tab-model',
              hidden: activeTab !== 'model',
            },
            h(
              'div',
              { className: 'blm-field' },
              h('span', { className: 'label' }, '当前模型'),
              h('span', null, (settings && settings.model && settings.model.label) || 'DSH 还没有选好默认模型'),
            ),
            h('div', { className: 'blm-dim', style: { fontSize: 11 } }, (settings && settings.modelNote) || '2.0 不提供独立模型 Key，统一走 DSH 默认模型。'),
          ),
          h(
            'section',
            {
              className: 'blm-group',
              id: 'blm-panel-image',
              role: 'tabpanel',
              'aria-labelledby': 'blm-tab-image',
              hidden: activeTab !== 'image',
            },
            imageForm
              ? h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'blm-field' },
                    h('span', { className: 'label' }, '策略'),
                    h(
                      'select',
                      {
                        className: 'blm-select',
                        value: imageForm.provider || 'prompt',
                        disabled: imageBusy,
                        'aria-label': '配图策略',
                        onChange: (event) => saveImageConfig({ provider: event.target.value }),
                      },
                      (image.providers || [{ id: 'prompt', label: '提示词占位（默认）' }, { id: 'comfyui', label: '本地 ComfyUI' }]).map((item) =>
                        h('option', { key: item.id, value: item.id }, item.label),
                      ),
                    ),
                    h('span', { className: 'blm-dim', style: { fontSize: 11 } }, imageForm.provider === 'comfyui' ? '逐页异步出图；失败页留白，不阻塞文字与音频' : '只产出提示词，不联网、不产生图片文件'),
                  ),
                  imageForm.provider === 'comfyui'
                    ? h(
                        React.Fragment,
                        null,
                        h(
                          'div',
                          { className: 'blm-field' },
                          h('span', { className: 'label' }, '地址'),
                          h('input', {
                            className: 'blm-input',
                            style: { flex: '0 0 140px', minWidth: 100 },
                            defaultValue: imageForm.host,
                            placeholder: '127.0.0.1',
                            'aria-label': 'ComfyUI 主机',
                            onBlur: (event) => {
                              const host = String(event.target.value || '').trim();
                              if (host && host !== imageForm.host) saveImageConfig({ host });
                            },
                          }),
                          h('input', {
                            className: 'blm-input',
                            style: { flex: '0 0 90px', minWidth: 70 },
                            type: 'number',
                            defaultValue: imageForm.port,
                            'aria-label': 'ComfyUI 端口',
                            onBlur: (event) => {
                              const port = Number(event.target.value);
                              if (port && port !== imageForm.port) saveImageConfig({ port });
                            },
                          }),
                          h('span', { className: 'blm-dim', style: { fontSize: 11 } }, imageForm.baseUrl || ''),
                        ),
                        h(
                          'div',
                          { className: 'blm-field' },
                          h('span', { className: 'label' }, '风格后缀'),
                          h('input', {
                            className: 'blm-input',
                            defaultValue: imageForm.styleSuffix || '',
                            maxLength: 60,
                            placeholder: '拼在每页 image_prompt 后面，≤60 字',
                            'aria-label': '配图风格后缀',
                            onKeyDown: (event) => {
                              if (event.key === 'Enter') saveImageConfig({ styleSuffix: event.target.value });
                            },
                            onBlur: (event) => {
                              const value = String(event.target.value || '').trim();
                              if (value !== String(imageForm.styleSuffix || '')) saveImageConfig({ styleSuffix: value });
                            },
                          }),
                        ),
                        h(
                          'div',
                          { className: 'blm-field' },
                          h('span', { className: 'label' }, '工作流'),
                          h('span', { className: 'blm-dim', style: { fontSize: 11 } }, (workflowInfo.source === 'custom' ? '自定义 · ' : '内置 · ') + (workflowInfo.name || '') + ' · ' + (workflowInfo.nodes || 0) + ' 节点'),
                          h('button', {
                            className: 'blm-btn',
                            disabled: imageBusy,
                            onClick: () => document.getElementById('blm-workflow-input')?.click(),
                          }, '导入 API 工作流'),
                          h('input', {
                            id: 'blm-workflow-input',
                            type: 'file',
                            accept: '.json,application/json',
                            style: { display: 'none' },
                            onChange: (event) => {
                              const file = event.target.files && event.target.files[0];
                              event.target.value = '';
                              importWorkflow(file);
                            },
                          }),
                          h('button', { className: 'blm-btn', disabled: imageBusy, onClick: resetWorkflowCfg }, '恢复默认'),
                        ),
                        h(
                          'div',
                          { className: 'blm-field' },
                          h('span', { className: 'label' }, '提示词节点'),
                          h(
                            'select',
                            {
                              className: 'blm-select',
                              value: workflowInfo.promptNode || '',
                              disabled: imageBusy,
                              'aria-label': '提示词节点',
                              onChange: (event) => saveImageConfig({ promptNode: event.target.value }),
                            },
                            (workflowInfo.candidates || []).map((item) => h('option', { key: item.id, value: item.id }, item.id + ' · ' + (item.title || ''))),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'blm-row' },
                          h('button', { className: 'blm-btn', disabled: imageBusy, onClick: probeImages }, '测试连接'),
                          h('button', { className: 'blm-btn', disabled: imageBusy, onClick: testImages }, '测试生图'),
                          imageForm.provider === 'comfyui' && imageForm.error ? h('span', { className: 'blm-bad', style: { fontSize: 11 } }, imageForm.error) : null,
                        ),
                        imageTestUrl ? h('img', { className: 'blm-cover-thumb', src: imageTestUrl, alt: '测试生图结果' }) : null,
                        h('div', { className: 'blm-dim', style: { fontSize: 11 } }, '配置存 image.json，工作流存 comfy-workflow.json；ComfyUI 只在用户配置后启用。'),
                      )
                    : null,
                  imageMsg ? h('div', { className: 'blm-note' }, imageMsg) : null,
                )
              : h('div', { className: 'blm-dim' }, '正在读配图配置…'),
          ),
          h(
            'section',
            {
              className: 'blm-group',
              id: 'blm-panel-usage',
              role: 'tabpanel',
              'aria-labelledby': 'blm-tab-usage',
              hidden: activeTab !== 'usage',
            },
            h(
              'div',
              { className: 'blm-dim', style: { fontSize: 11 } },
              '只统计插件发起的云端调用；本地配音/配图与标记为「本地」的 LLM provider 不计入。',
            ),
            h(
              'dl',
              { className: 'blm-kv' },
              h('dt', null, '本月'),
              h(
                'dd',
                null,
                usageMonth
                  ? formatMoney(usageMonth.totals.cost) + ' · ' + usageMonth.totals.jobs + ' 次作业'
                  : '—',
              ),
              h('dt', null, '累计'),
              h(
                'dd',
                null,
                usageTotal
                  ? formatMoney(usageTotal.totals.cost) + ' · ' + usageTotal.totals.jobs + ' 次作业'
                  : '—',
              ),
              h('dt', null, '本月 tokens'),
              h(
                'dd',
                null,
                usageMonth
                  ? '输入 ' + formatTokens(usageMonth.totals.tokens.input) +
                    (Number(usageMonth.totals.tokens.cacheRead) ? ' + 缓存读 ' + formatTokens(usageMonth.totals.tokens.cacheRead) : '') +
                    ' / 输出 ' + formatTokens(usageMonth.totals.tokens.output)
                  : '—',
              ),
              h('dt', null, '本月字符 / 图片'),
              h(
                'dd',
                null,
                usageMonth ? formatTokens(usageMonth.totals.chars) + ' 字符 · ' + usageMonth.totals.images + ' 张' : '—',
              ),
            ),
            h(
              'div',
              { className: 'blm-field' },
              h('span', { className: 'label' }, '价格表（JSON）'),
              h('textarea', {
                className: 'blm-select',
                style: { width: '100%', minHeight: 90, fontFamily: 'monospace', fontSize: 11 },
                value: pricesDraft,
                disabled: usageBusy,
                onChange: (event) => setPricesDraft(event.target.value),
                'aria-label': '价格表 JSON',
              }),
            ),
            h(
              'div',
              { className: 'blm-row' },
              h('button', { className: 'blm-btn', disabled: usageBusy, onClick: saveDraftPrices }, usageBusy ? '保存中…' : '保存价格表'),
              h('button', { className: 'blm-btn', disabled: usageBusy, onClick: () => savePrices({ reset: true }) }, '恢复参考价'),
            ),
            h(
              'div',
              { className: 'blm-field' },
              h('span', { className: 'label' }, '本地 LLM provider'),
              h('input', {
                className: 'blm-select',
                style: { width: '100%' },
                value: localProviders,
                placeholder: '逗号分隔，例如 ollama, lmstudio',
                disabled: usageBusy,
                onChange: (event) => setLocalProviders(event.target.value),
                'aria-label': '本地 LLM provider',
              }),
            ),
            h(
              'div',
              { className: 'blm-row', style: { marginTop: 6 } },
              onOpenUsage ? h('button', { className: 'blm-btn', onClick: onOpenUsage }, '查看历史') : null,
              h('button', { className: 'blm-btn', disabled: usageBusy, onClick: clearUsage }, '清空历史'),
              prices && prices.source ? h('span', { className: 'blm-dim', style: { fontSize: 11 } }, prices.source === 'builtin' ? '参考价' : '自定义') : null,
            ),
            usageMsg ? h('div', { className: 'blm-note' }, usageMsg) : null,
          ),
          h(
            'section',
            {
              className: 'blm-group',
              id: 'blm-panel-storage',
              role: 'tabpanel',
              'aria-labelledby': 'blm-tab-storage',
              hidden: activeTab !== 'storage',
            },
            settings
              ? h(
                  'dl',
                  { className: 'blm-kv' },
                  h('dt', null, '数据目录'),
                  h('dd', null, settings.dataRoot),
                  h('dt', null, '占用空间'),
                  h('dd', null, formatSize(settings.bytes)),
                  h('dt', null, '回收站'),
                  h('dd', null, (settings.trashCount || 0) + ' 本 · ' + formatSize(settings.trashBytes || 0)),
                )
              : h('div', { className: 'blm-dim' }, '正在读…'),
            h(
              'div',
              { className: 'blm-row', style: { marginTop: 6 } },
              h(
                'button',
                { className: 'blm-btn', disabled: trashBusy || !(settings && settings.trashCount), onClick: clearTrashNow },
                trashBusy ? '清理中…' : '清空回收站',
              ),
              h('span', { className: 'blm-dim', style: { fontSize: 11 } }, '回收站保留 7 天，不自动清理；清空后不可恢复。'),
            ),
            h(
              'div',
              { className: 'blm-row', style: { marginTop: 6 } },
              h('button', { className: 'blm-btn', onClick: () => downloadUrl('/export?all=true', 'book-slides-书档.zip') }, '导出全部书档'),
              h('span', { className: 'blm-dim', style: { fontSize: 11 } }, '书档含书/章/系列/讲/音频/配图/练习，不含语音 Key、缓存、回收站与临时文件。'),
            ),
            h('div', { className: 'blm-dim', style: { marginTop: 10, fontSize: 12 } }, '升级备份'),
            settings && settings.backups && settings.backups.length
              ? settings.backups.map((item) =>
                  h(
                    'div',
                    { className: 'blm-backup', key: item.name },
                    h('span', { className: 'grow', title: item.path }, item.name),
                    h('span', { className: 'blm-dim' }, formatSize(item.bytes)),
                    h('button', { className: 'blm-btn', onClick: () => openBackupDir(item) }, '打开'),
                    h('button', { className: 'blm-btn', onClick: () => removeBackup(item) }, '删除'),
                  ),
                )
              : h('div', { className: 'blm-dim', style: { fontSize: 11 } }, '没有升级备份（同父目录的 book-slides.backup-* 会列在这里）。'),
          ),
          h(
            'section',
            {
              className: 'blm-group',
              id: 'blm-panel-diagnostics',
              role: 'tabpanel',
              'aria-labelledby': 'blm-tab-diagnostics',
              hidden: activeTab !== 'diagnostics',
            },
            diagnostics
              ? h(
                  'dl',
                  { className: 'blm-kv' },
                  h('dt', null, '插件包版本'),
                  h('dd', null, diagnostics.version || '—'),
                  h('dt', null, '产品版本'),
                  h('dd', null, diagnostics.productVersion || '2.3'),
                  h('dt', null, 'schema'),
                  h('dd', null, String(diagnostics.schema || 2)),
                  h('dt', null, 'DSH 版本'),
                  h('dd', null, diagnostics.dshVersion || '未知'),
                  h('dt', null, 'pdfjs 版本'),
                  h('dd', null, diagnostics.pdfjsVersion || '未知'),
                  h('dt', null, '语音'),
                  h(
                    'dd',
                    null,
                    diagnostics.voice
                      ? diagnostics.voice.provider + ' · 参考 ' + (diagnostics.voice.comfyRefVoice || '—') + ' · 朗读稿位置 ' + (diagnostics.voice.textNode || '自动')
                      : '—',
                  ),
                  h(
                    'dt',
                    null,
                    'ComfyUI',
                  ),
                  h(
                    'dd',
                    null,
                    diagnostics.comfy && diagnostics.comfy.workflow
                      ? (diagnostics.comfy.workflow.name || '—') + ' · ' + (diagnostics.comfy.workflow.format || '') + ' · 参考 voice 库 ' + ((diagnostics.comfy.voiceTable && diagnostics.comfy.voiceTable.name) || '—')
                      : '—',
                  ),
                  h('dt', null, '最近错误'),
                  h(
                    'dd',
                    null,
                    diagnostics.errors && diagnostics.errors.length
                      ? diagnostics.errors.map((item) => item.code + '（' + item.length + ' 字符）').join('；')
                      : '没有错误记录',
                  ),
                )
              : h('div', { className: 'blm-dim' }, '正在读…'),
            h(
              'div',
              { style: { marginTop: 12, borderTop: '1px dashed var(--blm-line)', paddingTop: 10 } },
              h('strong', null, 'must_keep 同义词/别名（3.1）'),
              h('div', { className: 'blm-dim', style: { fontSize: 11, margin: '4px 0' } },
                '内置 ' + ((aliasConfig && aliasConfig.defaults) || []).length + ' 条；自定义 '
                  + ((aliasConfig && aliasConfig.custom) || []).length + ' 条。JSON 数组，每项 {term, any?/all?}。'),
              h('textarea', {
                className: 'blm-input',
                style: { width: '100%', minHeight: 130, font: '11px/1.45 ui-monospace,Consolas,monospace', boxSizing: 'border-box' },
                value: aliasText,
                disabled: aliasBusy,
                onChange: (event) => setAliasText(event.target.value),
                spellCheck: false,
              }),
              h('div', { className: 'blm-row', style: { marginTop: 6 } },
                h('button', { className: 'blm-btn primary', disabled: aliasBusy, onClick: () => saveAliases(false) }, aliasBusy ? '保存中…' : '保存别名表'),
                h('button', { className: 'blm-btn', disabled: aliasBusy, onClick: () => saveAliases(true) }, '恢复内置'),
                h('span', { className: 'blm-dim' }, aliasMsg || ((aliasConfig && aliasConfig.file) || '')),
              ),
            ),
            h('div', { className: 'blm-dim', style: { fontSize: 11, marginTop: 6 } }, '诊断只记录错误码与长度，不含原文或模型输出。'),
          ),
        ),
      );
    }

    function Panel() {
      const [books, setBooks] = useState([]);
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState(false);
      const [progress, setProgress] = useState(0);
      const [toast, setToast] = useState('');
      const [view, setView] = useState(readSavedView);
      const [trash, setTrash] = useState(false);
      const [packageFile, setPackageFile] = useState(null);
      const [importJob, setImportJob] = useState(null);
      const [drag, setDrag] = useState(false);
      /** 重复导入后要定位的已存在书卡：{id, nonce}；nonce 让同一张卡再次导入也重新触发定位。 */
      const [focusBook, setFocusBook] = useState(null);
      const shelfRef = useRef(null);
      const focusTimer = useRef(null);
      const toastTimer = useRef(null);
      const notify = useCallback((text) => {
        setToast(String(text || ''));
        clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(''), 3200);
      }, []);
      const importJobId = importJob && importJob.jobId ? String(importJob.jobId) : '';
      const importJobActive = importJobId !== '' && !['done', 'failed', 'cancelled'].includes(String(importJob.status || ''));

      useEffect(() => {
        saveView(view);
      }, [view]);

      const loadBooks = useCallback(async () => {
        setLoading(true);
        try {
          const data = await api('/books');
          setBooks(data.books || []);
        } catch (err) {
          notify(err.message);
        } finally {
          setLoading(false);
        }
      }, [notify]);
      useEffect(() => {
        loadBooks();
      }, [loadBooks]);

      // 重复导入：留在书架，滚动到并聚焦已存在的书卡；3 秒后收起高亮（AC-158）。
      useEffect(() => {
        if (!focusBook || !focusBook.id) return undefined;
        if (view.name === 'shelf') focusBookCard(shelfRef.current, focusBook.id);
        clearTimeout(focusTimer.current);
        focusTimer.current = setTimeout(() => setFocusBook(null), 3000);
        return () => clearTimeout(focusTimer.current);
      }, [focusBook, view.name, books]);

      // 升级提示（AC-112）：旧根已备份时显示一次，路径来自 /meta.notice。
      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const data = await api('/meta');
            const notice = String((data && data.notice) || '');
            if (!alive || !notice) return;
            if (sessionStorage.getItem('blm-upgrade-notice') === notice) return;
            sessionStorage.setItem('blm-upgrade-notice', notice);
            notify(notice);
          } catch {
            /* 提示失败不影响书架 */
          }
        })();
        return () => {
          alive = false;
        };
      }, [notify]);

      // 书档导入是全局作业：对话框关掉/页面刷新后，书架仍要能看见进度并取消。
      useEffect(() => {
        let alive = true;
        api('/import/package/active')
          .then((out) => {
            if (!alive) return;
            const job = out && out.job;
            if (job && job.jobId && !['done', 'failed', 'cancelled'].includes(String(job.status || ''))) {
              setImportJob(job);
            }
          })
          .catch((err) => {
            if (alive && err.code !== 'E_NOT_FOUND') notify(err.message);
          });
        return () => {
          alive = false;
        };
      }, [notify]);

      useEffect(() => {
        if (!importJobId || packageFile) return undefined;
        if (['done', 'failed', 'cancelled'].includes(String(importJob.status || ''))) return undefined;
        let alive = true;
        let settled = false;
        const finish = (out) => {
          if (!alive || settled) return;
          setImportJob(out);
          if (!['done', 'failed', 'cancelled'].includes(String(out.status || ''))) return;
          settled = true;
          setImportJob(null);
          if (String(out.status) === 'done') {
            const summary = out.summary || {};
            notify(
              '书档导入完成：成功 ' + ((Number(summary.imported) || 0) + (Number(summary.merged) || 0)) +
                ' 本，跳过 ' + (Number(summary.skipped) || 0) + ' 本，失败 ' + (Number(summary.failed) || 0) + ' 本',
            );
          } else if (String(out.status) === 'cancelled') {
            notify('书档导入已取消');
          } else {
            notify('书档导入失败：' + (out.code || out.error || 'E_PKG_FAILED'));
          }
          loadBooks();
        };
        const tick = async () => {
          try {
            finish(await api('/import/package/job?jobId=' + encodeURIComponent(importJobId)));
          } catch (err) {
            if (!alive) return;
            if (err.code === 'E_NOT_FOUND') {
              setImportJob(null);
              return;
            }
            notify(err.message);
          }
        };
        tick();
        const timer = setInterval(tick, 700);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [importJobId, packageFile, notify, loadBooks]);

      const importFile = async (file) => {
        if (!file) return;
        if (!/\.pdf$/i.test(file.name)) {
          notify('只支持 PDF 文件。');
          return;
        }
        setBusy(true);
        setProgress(0);
        try {
          const out = await uploadPdf(file, setProgress);
          const result = importOutcome(out);
          if (result.kind === 'created') {
            notify('已导入《' + (result.title || file.name) + '》，下一步生成章节目录。');
            await loadBooks();
            setView({ name: 'book', bookId: result.bookId });
          } else if (result.kind === 'duplicate') {
            // 不跳详情页：留在/回到书架，定位并高亮已存在的那张书卡（AC-158）。
            notify('这本书已在书架：' + (result.title || ''));
            setView((prev) => (prev.name === 'shelf' ? prev : { name: 'shelf' }));
            // 书卡已在当前列表时不重载书架，避免 loading 把卡片卸掉、定位闪一下。
            if (result.bookId && !books.some((book) => String(book.id) === result.bookId)) await loadBooks();
            if (result.bookId) setFocusBook({ id: result.bookId, nonce: Date.now() });
          } else {
            notify(result.message);
          }
        } catch (err) {
          notify(err.message);
        } finally {
          setBusy(false);
          setProgress(0);
        }
      };

      const rename = async (book) => {
        const next = await promptAction('输入新的书名', book.title, { title: '重命名', okText: '保存' });
        if (next == null) return;
        const title = next.trim();
        if (!title) return;
        try {
          await api('/rename', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bookId: book.id, title }),
          });
          notify('已重命名');
          await loadBooks();
        } catch (err) {
          notify(err.message);
        }
      };

      const remove = async (book) => {
        if (!(await confirmAction('删除《' + book.title + '》？会进回收站，7 天内可恢复。', { title: '删除书籍', okText: '移入回收站' }))) return;
        try {
          await fetch(API + '/book?bookId=' + encodeURIComponent(book.id), { method: 'DELETE' }).then((r) => r.json());
          notify('已移入回收站');
          await loadBooks();
        } catch (err) {
          notify(err.message);
        }
      };

      const openPlayer = useCallback((series, lecture, slide) => {
        setView({
          name: 'player',
          bookId: series.book_id,
          seriesId: series.id,
          lecture: Number(lecture) || 0,
          slide: Number(slide) || 0,
        });
      }, []);

      const continueBook = useCallback((book, last) => {
        // lecture/slide 传 0：播放器按 progress.json 的「上次位置」续播（AC-108）
        setView({ name: 'player', bookId: book.id, seriesId: last.id, lecture: 0, slide: 0 });
      }, []);

      const cancelImport = async () => {
        if (!importJobId) return;
        try {
          await api('/import/package/cancel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jobId: importJobId }),
          });
          notify('正在取消导入…');
        } catch (err) {
          notify(err.message);
        }
      };

      const shelf = view.name === 'shelf';
      return h(
        'div',
        {
          className: 'blm-root',
          onDragOver: (event) => {
            event.preventDefault();
            setDrag(true);
          },
          onDragLeave: () => setDrag(false),
          onDrop: (event) => {
            event.preventDefault();
            setDrag(false);
            const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
            importFile(file);
          },
        },
        shelf
          ? h(
              'div',
              { className: 'blm-bar' },
              h('h1', null, '精讲'),
              h('button', { className: 'blm-btn', onClick: () => setTrash(true) }, '回收站'),
              h('button', { className: 'blm-btn', onClick: () => setView({ name: 'settings' }) }, '设置'),
              h('button', { className: 'blm-btn', onClick: () => document.getElementById('blm-package-input')?.click() }, '导入书档'),
              h('input', {
                id: 'blm-package-input',
                type: 'file',
                accept: '.zip,application/zip',
                style: { display: 'none' },
                onChange: (event) => {
                  const file = event.target.files && event.target.files[0];
                  event.target.value = '';
                  if (!file) return;
                  if (!/\.zip$/i.test(file.name)) {
                    notify('书档是 .zip 文件。');
                    return;
                  }
                  setPackageFile(file);
                },
              }),
              h(
                'button',
                { className: 'blm-btn primary', disabled: busy, onClick: () => document.getElementById('blm-file-input')?.click() },
                busy ? Math.round(progress * 100) + '%' : '导入 PDF',
              ),
              h('input', {
                id: 'blm-file-input',
                type: 'file',
                accept: '.pdf,application/pdf',
                style: { display: 'none' },
                onChange: (event) => {
                  importFile(event.target.files && event.target.files[0]);
                  event.target.value = '';
                },
              }),
            )
          : null,
        importJobActive && !packageFile
          ? h(
              'div',
              { className: 'blm-note', style: { margin: '8px 14px 0', flex: '0 0 auto' } },
              h(
                'div',
                { className: 'blm-row' },
                h('strong', null, '书档导入中'),
                h('span', { className: 'blm-dim' },
                  String(importJob.status || '') + ' · ' + (importJob.stage || '') +
                  ' · ' + (Number(importJob.current) || 0) + '/' + (Number(importJob.total) || 0)),
                h('div', { style: { flex: 1 } }),
                h('button', { className: 'blm-btn', onClick: cancelImport }, '取消导入'),
              ),
              importJob.message ? h('div', { className: 'blm-dim', style: { fontSize: 11, marginTop: 4 } }, importJob.message) : null,
            )
          : null,
        shelf
          ? h(
              'div',
              { className: 'blm-body', ref: shelfRef },
              loading
                ? h('div', { className: 'blm-dim' }, '加载书架…')
                : books.length
                  ? h('div', { className: 'blm-grid' }, books.map((book) =>
                      h(Card, {
                        key: book.id,
                        book,
                        highlight: !!(focusBook && focusBook.id === book.id),
                        onOpen: () => setView({ name: 'book', bookId: book.id }),
                        onRename: () => rename(book),
                        onDelete: () => remove(book),
                        onContinue: continueBook,
                        onExport: (item) => {
                          downloadUrl('/export?bookId=' + encodeURIComponent(item.id), String(item.title || 'book') + '.zip');
                          notify('开始导出《' + item.title + '》的书档');
                        },
                      }),
                    ))
                  : h(
                      'div',
                      { className: 'blm-empty' },
                      h('strong', null, drag ? '松手导入 PDF' : '把 PDF 拖进来'),
                      h('div', null, '导入只入库；随后为每本书生成章节目录。'),
                      h('div', { className: 'blm-dim' }, '单文件 ≤200 MB，需带文字层。'),
                    ),
            )
          : view.name === 'settings'
            ? h(Settings, {
                onBack: () => {
                  setView({ name: 'shelf' });
                  loadBooks();
                },
                notify,
                onOpenUsage: () => setView({ name: 'usage' }),
              })
            : view.name === 'usage'
              ? h(UsageView, {
                  onBack: () => setView({ name: 'settings' }),
                  notify,
                })
            : view.name === 'player'
              ? h(Player, {
                  bookId: view.bookId,
                  seriesId: view.seriesId,
                  initialLecture: view.lecture,
                  initialSlide: view.slide,
                  notify,
                  onBack: () => setView({ name: 'book', bookId: view.bookId }),
                })
              : h(Detail, {
                  bookId: view.bookId,
                  onBack: () => {
                    setView({ name: 'shelf' });
                    loadBooks();
                  },
                  onChanged: loadBooks,
                  notify,
                  onPlay: openPlayer,
                }),
        trash ? h(Trash, { onClose: () => setTrash(false), onChanged: loadBooks, notify }) : null,
        packageFile
          ? h(ImportPackageDialog, {
              file: packageFile,
              initialJob: importJobActive ? importJob : null,
              notify,
              onClose: () => setPackageFile(null),
              onJobStarted: (job) => setImportJob(job),
              onDone: (job) => {
                const status = String((job && job.status) || '');
                const summary = (job && job.summary) || null;
                if (status === 'done') {
                  notify(summary ? '书档导入完成：成功 ' + (summary.imported + summary.merged) + ' 本，跳过 ' + summary.skipped + ' 本，失败 ' + summary.failed + ' 本' : '书档导入完成');
                } else if (status === 'cancelled') {
                  notify('书档导入已取消');
                } else {
                  notify('书档导入失败：' + ((job && (job.code || job.error)) || 'E_PKG_FAILED'));
                }
                setImportJob(null);
                setPackageFile(null);
                loadBooks();
              },
            })
          : null,
        h(Toast, { text: toast }),
        h(ConfirmHost),
        busy && shelf ? h('div', { className: 'blm-progress', style: { position: 'absolute', left: 0, right: 0, bottom: 0, margin: 0 } }, h('i', { style: { width: Math.round(progress * 100) + '%' } })) : null,
      );
    }

    function Icon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M2.5 3.5h4l1.2 1.5h5.8v7.5h-11z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
        h('path', { d: 'M5 8h6M5 10.5h4', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots;
        ctx.effect(() => {
          if (typeof document === 'undefined') return undefined;
          const tag = document.createElement('style');
          tag.setAttribute('data-book-slides-2-style', '1');
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => {
            try {
              tag.remove();
            } catch {
              /* ignore */
            }
          };
        });
        ctx.effect(() =>
          slots.inject('sidebar.panellist', () =>
            slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: '精讲' }, Icon),
          ),
        );
        ctx.effect(() =>
          slots.inject('main', () =>
            slots.register({ name: 'main', key: PANEL_ID }, function BookSlidesRoot() {
              return h(Panel);
            }),
          ),
        );
      },
      __components: {
        Panel,
        Detail,
        Card,
        Trash,
        Player,
        SourcePane,
        SlideStage,
        SubtitlePane,
        StageFigure,
        SlideThumb,
        ConfirmHost,
        TransitionCard,
        SeriesCard,
        SeriesDirectory,
        PartEditDialog,
        ChapterBuildPanel,
        ChapterTree,
        ChapterSourceBadge,
        Settings,
        UsageView,
        UsageRow,
        UsageOtherGroup,
        PracticePanel,
        ExportDialog,
        ImportPackageDialog,
      },
      __helpers: {
        clampSplitValue,
        clampLayout,
        leftRatioFor,
        splitForLeftRatio,
        nextLayout,
        clampRateValue,
        playerKeyAction,
        slideAudioMode,
        playbackKey,
        refreshDecision,
        slideWithImageOverride,
        subtitleText,
        nextLectureAfter,
        formatSeriesProgress,
        formatJobLine,
        probeView,
        probeTiming,
        refDurationNotice,
        chapterSelectionState,
        chapterSourceLabel,
        sourceLabel,
        chapterBuildRequest,
        outlineInfo,
        seriesSnapshotVersion,
        resolveInitialSlide,
        normalizeOffsetMs,
        formatClock,
        resolveResumeOffset,
        resolvePendingResume,
        pdfHighlightRects,
        normalizePdfText,
        pdfTransform,
        isRenderCancelled,
        formatSize,
        formatTokens,
        formatMoney,
        usageKindLabel,
        usageSummaryLine,
        usageDetailSafeId,
        usageToggleJobId,
        monthStartIso,
        usageRangeFor,
        usageRangeError,
        usageQuery,
        formatUsageTime,
        splitUsageJobs,
        USAGE_TIME_PRESETS,
        bindMenuDismiss,
        useLongPress,
        confirmAction,
        promptAction,
        cancelPendingConfirm,
        downloadUrl,
        importOutcome,
        focusBookCard,
        prefersReducedMotion,
        thumbScrollLeft,
        scrollThumbIntoView,
        thumbScrollDeferMs,
        uploadZip,
        readPackagePolicy,
        savePackagePolicy,
        readSavedView,
        saveView,
        settingsTabIndexForKey,
        readSettingsTab,
        saveSettingsTab,
      },
    };
  },
});
