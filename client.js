/**
 * 精讲台 · Client 半体
 *
 * 左侧栏一个「精讲」图标，点开就是书架：
 *   - 拖入 PDF，看得到上传进度与解析等待
 *   - 卡片流看书封、章数、字数
 *   - 点开一本书看章节清单（M2 才给勾选与生成）
 *   - 改名、软删除、打开原始 PDF
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
.bl-row-title{font-size:12.5px;line-height:1.45;word-break:break-word}
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
    function Detail({ bookId, onBack, error, setError }) {
      const [state, setState] = useState({ loading: true, book: null, chapters: [], modules: [] });
      const [refresh, setRefresh] = useState(0);
      const [busy, setBusy] = useState(false);
      const [selected, setSelected] = useState(() => ({}));
      const [menu, setMenu] = useState(0);
      const [edit, setEdit] = useState(null);
      const [askReparse, setAskReparse] = useState(false);
      const [toc, setToc] = useState({ from: '', to: '', suggested: null, total: 0, info: null, preview: '', busy: false, message: '' });

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
              setToc((prev) => ({
                ...prev,
                busy: false,
                message:
                  (data.cached ? '用的是上次结果：' : '') +
                  data.status +
                  ' · 偏移 ' +
                  data.offset +
                  ' 页 · 标题命中率 ' +
                  Math.round((data.hitRate || 0) * 100) +
                  '%',
              }));
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
                : h('div', { className: 'bl-row-title' }, chapter.title),
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
                        book.modules && book.modules.length ? book.modules.length + ' 个精讲模块' : '还没有精讲模块',
                      ),
                    ),
                  ),
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
              disabled: true,
              title: '生成流水线在 M3 接入',
              onClick: () => {},
            },
            '生成精讲',
          ),
        ),
      );
    }

    function Settings({ onBack }) {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);

      useEffect(() => {
        let alive = true;
        getJson(STORAGE_API)
          .then((value) => {
            if (alive) setData(value);
          })
          .catch((err) => {
            if (alive) setError(err);
          });
        return () => {
          alive = false;
        };
      }, []);

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
                h('dt', null, '语音'),
                h('dd', null, 'M3 接入'),
              )
            : h('div', { style: { opacity: 0.7 } }, h('span', { className: 'bl-spin' }), ' 正在读…'),
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

      const body =
        nav === 'detail' && bookId
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
              error: error,
              setError: setError,
            })
          : nav === 'settings'
            ? h(Settings, { onBack: () => setNav('shelf') })
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
      __components: { BookSlidesPanel: BookSlidesPanel, Shelf: Shelf, Detail: Detail, Settings: Settings, BookCard: BookCard, TocBox: TocBox, SourceNote: SourceNote },
    };
  },
});
