/**
 * 精讲台 · Client 半体
 *
 * 左侧栏一个「精讲」图标，点开就是书架：
 *   - 拖入 PDF，看得到上传进度与解析等待
 *   - 卡片流看书封、章数、字数、模块数
 *   - 点开一本书：目录切章、勾选章节、生成精讲（M3：进度/取消/重试）
 *   - 生成完进模块预览：逐页文字 + 配音稿 + 配图提示词，本机朗读试听
 *   - 设置页：语音供应商/音色/语速、试听、存储概况
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
.bl-job{border:1px solid var(--bl-line);border-radius:9px;padding:9px 11px;margin:10px 0;font-size:12px;background:color-mix(in oklab,currentColor 4%,transparent)}
.bl-job-head{display:flex;align-items:center;gap:8px}
.bl-job-stage{font-weight:600}
.bl-job .bl-progress{margin-top:7px}
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
.bl-voice-row{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin:8px 0}
.bl-select{font:inherit;color:var(--dsw-alias-label-primary,CanvasText);background:var(--dsw-alias-bg-layer-2,Canvas);border:1px solid var(--bl-line);border-radius:7px;padding:4px 7px;max-width:100%;color-scheme:light}
body[data-ds-dark-theme] .bl-select{color-scheme:dark}
.bl-select option{background-color:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText)}
.bl-select option:disabled{color:var(--dsw-alias-label-tertiary,GrayText)}
.bl-select:focus-visible{outline:2px solid color-mix(in oklab,currentColor 45%,transparent);outline-offset:1px}
.bl-kv{margin-bottom:14px}
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

    function BookCard({ book, onOpen, onRename, onDelete }) {
      const [menu, setMenu] = useState(false);
      const [renaming, setRenaming] = useState(false);
      const [draft, setDraft] = useState(book.title);
      const [armed, setArmed] = useState(false);
      const inputRef = useRef(null);

      useEffect(() => {
        if (renaming && inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, [renaming]);

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
          className: 'bl-card bl-line',
          tabIndex: 0,
          role: 'button',
          'aria-label': book.title,
          onClick: () => {
            if (menu || renaming) return;
            onOpen(book.id);
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              onOpen(book.id);
            }
          },
        },
        h('img', { className: 'bl-cover', src: COVER_API + '?bookId=' + encodeURIComponent(book.id), alt: '', loading: 'lazy' }),
        h(
          'button',
          {
            className: 'bl-more',
            'aria-label': '更多操作',
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
              { className: 'bl-menu bl-line', onClick: (event) => event.stopPropagation() },
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
      );
    }

    function Shelf({ books, loading, onOpen, onRename, onDelete, onImport, error, onDismissError }) {
      const [dragging, setDragging] = useState(false);
      const dragDepth = useRef(0);

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
    /** 生成进度条：四阶段名 + 当前批/页 + 取消（AC-13 / AC-14）。 */
    function JobBox({ job, onCancel }) {
      const stage = STAGE_LABELS[job.stage] || statusLabel(job.status);
      const total = Number(job.total) || 0;
      const current = Number(job.current) || 0;
      const pct = total > 0 ? Math.max(4, Math.min(100, Math.round((current / total) * 100))) : 6;
      const cancelling = job.status === 'cancelling';
      return h(
        'div',
        { className: 'bl-job', role: 'status', 'aria-live': 'polite' },
        h(
          'div',
          { className: 'bl-job-head' },
          h('span', { className: 'bl-job-stage' }, (cancelling ? '正在取消' : '生成中') + ' · ' + stage),
          h('span', { className: 'bl-grow' }),
          total > 0 ? h('span', { className: 'bl-hint' }, current + '/' + total) : null,
          h(
            'button',
            { className: 'bl-btn', disabled: cancelling || !onCancel, onClick: onCancel, 'aria-label': '取消生成' },
            cancelling ? '取消中…' : '取消',
          ),
        ),
        h('div', { className: 'bl-progress' }, h('i', { style: { width: pct + '%' } })),
        h('div', { className: 'bl-job-msg' }, job.message || '正在排队…'),
      );
    }

    /** 详情页的模块列表：打开 / 重试 / 重新生成 / 删除。 */
    function ModuleList({ modules, busy, onOpen, onRetry, onDelete, onRegenerate }) {
      const list = Array.isArray(modules) ? modules : [];
      return h(
        'div',
        { className: 'bl-mods' },
        h(
          'div',
          { className: 'bl-mods-head' },
          h('span', null, '精讲模块'),
          h('span', { className: 'bl-grow' }),
          h('span', { className: 'bl-hint' }, list.length ? list.length + ' 个' : '还没有'),
        ),
        list.length === 0
          ? h('div', { className: 'bl-mod' }, h('div', { className: 'bl-mod-main bl-hint' }, '勾选章节后点底部的「生成精讲」，生成完在这里打开。'))
          : list.map((item) => {
              const ready = isReady(item.status);
              const bad = item.status === 'failed' || item.status === 'interrupted' || item.status === 'cancelled';
              const chip = ready ? 'bl-chip-ok' : bad ? 'bl-chip-bad' : 'bl-chip-run';
              return h(
                'div',
                { className: 'bl-mod', key: item.id },
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
                      (item.status === 'ready_degraded' ? ' · 仅文字' : ''),
                  ),
                  item.code && item.error && !ready ? h('div', { className: 'bl-mod-err' }, item.code + '：' + item.error) : null,
                ),
                h(
                  'div',
                  { className: 'bl-mod-actions' },
                  ready ? h('button', { className: 'bl-btn', disabled: busy, onClick: () => onOpen(item.id) }, '打开') : null,
                  bad ? h('button', { className: 'bl-btn', disabled: busy, onClick: () => onRetry(item) }, '重试') : null,
                  ready ? h('button', { className: 'bl-btn', disabled: busy, title: '重新生成会覆盖这一份', onClick: () => onRegenerate(item) }, '重生成') : null,
                  h('button', { className: 'bl-btn', disabled: busy, onClick: () => onDelete(item) }, '删除'),
                ),
              );
            }),
      );
    }

    /** 一页幻灯片：封面/要点/引文 + 配音稿 + 配图提示词（M3 先做文字预览，M4 接播放器）。 */
    function SlidePreview({ slide, voice, onSpeak, speaking }) {
      const [copied, setCopied] = useState(false);
      const layout = String(slide.layout || 'content_text');
      const label = layout === 'cover' ? '封面' : layout === 'quote' ? '引文' : '内容';
      const anchor = slide.source_anchor;
      const canSpeak = !!onSpeak && speechSupported() && (voice.provider === 'browser');
      const copy = () => {
        const text = String(slide.image_prompt || '');
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }
        } catch {
          setCopied(false);
        }
      };
      return h(
        'div',
        { className: 'bl-slide' + (layout === 'cover' ? ' bl-slide-cover' : '') },
        h(
          'div',
          { className: 'bl-slide-head' },
          h('span', null, '第 ' + slide.slide_index + ' 页'),
          h('span', { className: 'bl-chip' }, label),
          h('span', { className: 'bl-grow' }),
          anchor
            ? h('span', null, '锚定 · 第 ' + anchor.page + ' 页第 ' + (Number(anchor.para_index) + 1) + ' 段')
            : h('span', { className: 'bl-source-warn' }, '未定位到原句'),
        ),
        h('div', { className: 'bl-slide-title' }, slide.title || '（无标题）'),
        slide.subtitle ? h('div', { className: 'bl-slide-sub' }, slide.subtitle) : null,
        layout === 'content_text' && Array.isArray(slide.bullet_points)
          ? h('ul', null, slide.bullet_points.map((bullet, index) => h('li', { key: index }, bullet)))
          : null,
        layout === 'quote' && slide.quote_text
          ? h('blockquote', { className: 'bl-slide-quote' }, slide.quote_text, h('small', null, '—— ' + (slide.quote_source || '出处未知')))
          : null,
        slide.audio_script ? h('div', { className: 'bl-slide-script' }, slide.audio_script) : null,
        slide.image_prompt
          ? h(
              'div',
              { className: 'bl-img-hint' },
              h('span', null, '配图位'),
              h('code', null, slide.image_prompt),
              h('button', { className: 'bl-btn', onClick: copy }, copied ? '已复制' : '复制'),
            )
          : null,
        h(
          'div',
          { className: 'bl-slide-foot' },
          h('span', null, '原文第 ' + (slide.source_pages ? slide.source_pages.from : '?') + (slide.source_pages && slide.source_pages.to !== slide.source_pages.from ? '–' + slide.source_pages.to : '') + ' 页'),
          h(
            'span',
            null,
            voice.provider === 'browser'
              ? '· 朗读约 ' + Math.max(1, Math.round((Number(slide.audio_ms) || 0) / 1000)) + ' 秒'
              : voice.provider === 'off'
                ? '· 仅文字'
                : '· 语音降级',
          ),
          canSpeak
            ? h('button', { className: 'bl-btn', 'aria-label': '朗读第 ' + slide.slide_index + ' 页', onClick: () => onSpeak(slide) }, speaking ? '停止' : '朗读本页')
            : null,
          slide.anchor_status !== 'anchored' ? h('span', { className: 'bl-source-warn' }, '播放时按页定位，不高亮') : null,
        ),
      );
    }

    /** 模块预览：M3 只做到「看文字 + 听本页」，分屏播放器在 M4。 */
    function ModuleView({ moduleId, onBack, error, setError }) {
      const [state, setState] = useState({ loading: true, module: null, slides: null, book: null });
      const [speaking, setSpeaking] = useState(0);
      const [stopAll, setStopAll] = useState(false);

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

      const module = state.module;
      const voice = (module && module.voice) || { provider: 'browser', rate: 1, voice: '' };
      const slides = state.slides && Array.isArray(state.slides.slides) ? state.slides.slides : [];
      const ready = module && isReady(module.status);

      const speakOne = useCallback(
        (slide) => {
          if (speaking === slide.slide_index) {
            stopSpeech();
            setSpeaking(0);
            return;
          }
          try {
            setSpeaking(slide.slide_index);
            speakText(slide.audio_script, {
              rate: voice.rate,
              voice: voice.voice,
              onend: () => setSpeaking(0),
              onerror: () => setSpeaking(0),
            });
          } catch (err) {
            setSpeaking(0);
            setError(err);
          }
        },
        [speaking, voice.rate, voice.voice, setError],
      );

      /** 从第 1 页连着念到最后一页；页与页之间靠 utterance 的 onend 接力。 */
      const speakAll = useCallback(() => {
        if (stopAll || speaking) {
          stopSpeech();
          setSpeaking(0);
          setStopAll(false);
          return;
        }
        const scripts = slides.map((slide) => slide.audio_script).filter(Boolean);
        if (!scripts.length) return;
        let index = 0;
        setStopAll(true);
        setSpeaking(-1);
        const next = () => {
          if (index >= scripts.length) {
            setSpeaking(0);
            setStopAll(false);
            return;
          }
          const current = index;
          index += 1;
          speakText(scripts[current], {
            rate: voice.rate,
            voice: voice.voice,
            onend: next,
            onerror: () => {
              setSpeaking(0);
              setStopAll(false);
            },
          });
        };
        next();
      }, [slides, speaking, stopAll, voice.rate, voice.voice]);

      let body = null;
      if (state.loading) {
        body = h('div', { style: { padding: '26px 4px', opacity: 0.7 } }, h('span', { className: 'bl-spin' }), ' 正在打开模块…');
      } else if (!module) {
        body = h('div', { style: { opacity: 0.7 } }, '这个模块打不开了。');
      } else if (!ready) {
        body = h(
          'div',
          { className: 'bl-note' },
          '这个模块还没就绪（' + statusLabel(module.status) + '）。' +
            (module.code ? '错误码 ' + module.code + '：' + (module.error || '') : '回书籍详情重新生成。'),
        );
      } else if (!slides.length) {
        body = h('div', { className: 'bl-note' }, '模块里没有幻灯片数据。');
      } else {
        body = h(
          'div',
          null,
          h(
            'div',
            { className: 'bl-note' },
            '本页文字与配音稿已就绪，语音由浏览器本机朗读。分屏播放器在 M4 接入；这里先逐页核对内容，点「朗读本页」能直接试听。',
          ),
          slides.map((slide) =>
            h(SlidePreview, {
              key: slide.slide_index,
              slide: slide,
              voice: voice,
              speaking: speaking === slide.slide_index,
              onSpeak: voice.provider === 'browser' ? speakOne : null,
            }),
          ),
        );
      }

      return h(
        'div',
        { className: 'bl-root bl-line' },
        h(
          'div',
          { className: 'bl-bar' },
          h('button', { className: 'bl-back', onClick: onBack }, '\u2039 返回书籍'),
          h('div', { className: 'bl-grow' }),
          module && ready && slides.length
            ? h('button', { className: 'bl-btn', onClick: speakAll, 'aria-label': '连续朗读整个模块' }, stopAll ? '停止朗读' : '连续朗读')
            : null,
          module && state.book
            ? h(
                'a',
                {
                  className: 'bl-btn',
                  href: FILE_API + '?bookId=' + encodeURIComponent(state.book.id),
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
          { className: 'bl-body' },
          h(ErrorBanner, { error: error, onClose: () => setError(null) }),
          module
            ? h(
                'div',
                { className: 'bl-book-info', style: { marginBottom: 10 } },
                h('div', { className: 'bl-book-title' }, module.title || '精讲'),
                h(
                  'div',
                  { className: 'bl-book-meta' },
                  '第 ' + (module.chapters || []).join('、') + ' 章 · ' + slides.length + ' 页 · 锚定 ' +
                    Math.round((Number(module.anchorHitRate) || 0) * 100) + '% · ' +
                    (voice.provider === 'browser' ? '浏览器朗读' : voice.provider === 'off' ? '仅文字' : '语音降级'),
                ),
                module.status === 'ready_degraded'
                  ? h('div', { className: 'bl-voice-note bl-source-warn' }, '部分音频不可用：本次只有文字，播放器会按页翻。')
                  : null,
              )
            : null,
          body,
        ),
      );
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
      const [genBusy, setGenBusy] = useState(false);

      useEffect(() => {
        let alive = true;
        setState((prev) => ({ ...prev, loading: true }));
        getJson(BOOK_API + '?bookId=' + encodeURIComponent(bookId))
          .then((data) => {
            if (!alive) return;
            setState({ loading: false, book: data.book, chapters: data.chapters || [], modules: data.modules || [] });
          })
          .catch((err) => {
            if (!alive) return;
            setState({ loading: false, book: null, chapters: [], modules: [] });
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

      const removeModule = useCallback(
        async (item) => {
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
          { className: 'bl-body' },
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
                  job ? h(JobBox, { job: job, onCancel: cancelGenerate }) : null,
                  h(ModuleList, {
                    modules: state.modules,
                    busy: busy || genBusy,
                    onOpen: (id) => onOpenModule && onOpenModule(id),
                    onRetry: retryModule,
                    onDelete: removeModule,
                    onRegenerate: regenerateModule,
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
      );
    }

    function Settings({ onBack }) {
      const [data, setData] = useState(null);
      const [voice, setVoice] = useState(null);
      const [providers, setProviders] = useState([]);
      const [form, setForm] = useState({ provider: 'browser', voice: '', rate: 1 });
      const [voices, setVoices] = useState([]);
      const [message, setMessage] = useState('');
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState(null);

      useEffect(() => {
        let alive = true;
        Promise.all([getJson(STORAGE_API), getJson(VOICE_API)])
          .then(([storage, config]) => {
            if (!alive) return;
            setData(storage);
            setVoice(config.voice || null);
            setProviders(config.providers || []);
            if (config.voice) {
              setForm({ provider: config.voice.provider || 'browser', voice: config.voice.voice || '', rate: Number(config.voice.rate) || 1 });
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
          setForm(next);
          setSaving(true);
          setMessage('');
          try {
            const result = await postJson(VOICE_API, next);
            setVoice(result.voice || null);
            if (result.providers) setProviders(result.providers);
            setMessage('已保存');
            setError(null);
          } catch (err) {
            setError(err);
          } finally {
            setSaving(false);
          }
        },
        [form],
      );

      /** 试听：浏览器朗读返回合成参数，面板自己出声；关闭/未接入时明确提示去改设置。 */
      const probe = useCallback(async () => {
        setMessage('');
        setError(null);
        try {
          const result = await postJson(VOICE_PROBE_API, { text: '这是一段试听，用来确认本机朗读能出声。' });
          if (result.mode === 'browser') {
            speakText(result.text, { rate: result.rate, voice: result.voice });
            setMessage('正在用本机声音试听…');
          } else {
            setMessage('试听已交给语音服务。');
          }
        } catch (err) {
          if (err && err.code === 'E_TTS_UNCONFIGURED') {
            setMessage('语音没开：把供应商改成「浏览器朗读」，保存后再试听。');
          } else {
            setMessage(String((err && err.message) || err));
          }
        }
      }, []);

      const speechOk = speechSupported();
      const providerNote = (providers.find((item) => item.id === form.provider) || {}).note || (voice && voice.note) || '';

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
                h('dd', null, (data.trashCount || 0) + ' 本'),
                h('dt', null, '插件版本'),
                h('dd', null, data.pluginVersion || '—'),
              )
            : h('div', { style: { opacity: 0.7 } }, h('span', { className: 'bl-spin' }), ' 正在读…'),
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
                  onChange: (event) => save({ provider: event.target.value }),
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
              h('span', { className: 'bl-hint' }, '音色'),
              h(
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
            h(
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
                [0.8, 1, 1.2].map((rate) => h('option', { key: rate, value: String(rate) }, rate.toFixed(1) + '×')),
              ),
              h('button', { className: 'bl-btn', disabled: saving, onClick: probe }, '试听'),
              h('button', { className: 'bl-btn', disabled: saving, onClick: () => save({}) }, saving ? '保存中…' : '保存'),
            ),
            message ? h('div', { className: 'bl-voice-note bl-toc-msg' }, message) : null,
            providerNote ? h('div', { className: 'bl-voice-note' }, providerNote) : null,
            !speechOk ? h('div', { className: 'bl-voice-note bl-source-warn' }, '当前浏览器不支持本机朗读；换 Chrome / Edge 最新版。') : null,
            h('div', { className: 'bl-voice-note' }, '本版只接浏览器本机朗读：不联网、不产生音频文件；豆包字段先预留，未接入合成。'),
          ),
        ),
      );
    }

    /* ------------------------------ 面板根 ------------------------------ */

    function BookSlidesPanel() {
      const [nav, setNav] = useState('shelf');
      const [books, setBooks] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [bookId, setBookId] = useState('');
      const [moduleId, setModuleId] = useState('');
      const [upload, setUpload] = useState(null);
      const fileInputRef = useRef(null);

      const load = useCallback(() => {
        setLoading(true);
        getJson(BOOKS_API)
          .then((data) => {
            setBooks(data.books || []);
            setError(null);
          })
          .catch((err) => setError(err))
          .finally(() => setLoading(false));
      }, []);

      useEffect(() => {
        load();
      }, [load]);

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

      const openModule = useCallback((id) => {
        setModuleId(id);
        setError(null);
        setNav('module');
      }, []);

      const body =
        nav === 'module' && moduleId
          ? h(ModuleView, {
              moduleId: moduleId,
              onBack: () => setNav(bookId ? 'detail' : 'shelf'),
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
                  error: error,
                  onDismissError: () => setError(null),
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
        BookCard: BookCard,
        TocBox: TocBox,
        SourceNote: SourceNote,
        JobBox: JobBox,
        ModuleList: ModuleList,
        SlidePreview: SlidePreview,
        ModuleView: ModuleView,
      },
    };
  },
});
