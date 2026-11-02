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
    const FILE_API = '/dsh-book-slides/file';
    const COVER_API = '/dsh-book-slides/cover';
    const STORAGE_API = '/dsh-book-slides/storage';
    const PANEL_ID = 'book-slides';

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

    function Detail({ bookId, onBack, onDeleted, error, setError }) {
      const [state, setState] = useState({ loading: true, book: null, chapters: [], modules: [] });
      const [refresh, setRefresh] = useState(0);
      const [busy, setBusy] = useState(false);

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
        return () => {
          alive = false;
        };
      }, [bookId, setError, refresh]);

      /** 解析规则改了以后，旧书按新规则重切一遍，不用重传 PDF。 */
      const doReparse = useCallback(async () => {
        setBusy(true);
        try {
          await postJson(REPARSE_API, { bookId: bookId });
          setRefresh((v) => v + 1);
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }, [bookId, setError]);

      const book = state.book;
      const chapters = state.chapters || [];
      const selectable = useMemo(() => chapters.filter((c) => !c.front), [chapters]);

      return h(
        'div',
        { className: 'bl-root bl-line' },
        h(
          'div',
          { className: 'bl-bar' },
          h(
            'button',
            { className: 'bl-back', onClick: onBack },
            '\u2039 书架',
          ),
          h('div', { className: 'bl-grow' }),
          book
            ? h(
                'button',
                {
                  className: 'bl-btn',
                  disabled: busy,
                  title: '按当前的切章规则重切一遍，不用重传 PDF',
                  onClick: doReparse,
                },
                busy ? '重解析中…' : '重新解析',
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
          state.loading
            ? h('div', { style: { padding: '26px 4px', opacity: 0.7 } }, h('span', { className: 'bl-spin' }), ' 正在打开…')
            : book
              ? h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'bl-book' },
                    h(
                      'div',
                      { className: 'bl-book-cover' },
                      h('img', {
                        src: COVER_API + '?bookId=' + encodeURIComponent(bookId),
                        alt: '',
                      }),
                    ),
                    h(
                      'div',
                      { className: 'bl-book-info' },
                      h('div', { className: 'bl-book-title' }, book.title),
                      h('div', { className: 'bl-book-meta' }, book.author ? book.author : '作者未知'),
                      h(
                        'div',
                        { className: 'bl-book-meta' },
                        (book.pages || 0) + ' 页 · ' + (book.chapterCount || 0) + ' 章 · ' + formatChars(book.chars),
                      ),
                      h(
                        'div',
                        { className: 'bl-book-meta' },
                        book.modules && book.modules.length
                          ? book.modules.length + ' 个精讲模块'
                          : '还没有精讲模块',
                      ),
                    ),
                  ),
                  h('div', { className: 'bl-note' }, 'M1 预览：导入、切章、书架已完成。勾选章节生成精讲在 M3，分屏播放器在 M4。'),
                  h(
                    'div',
                    { className: 'bl-list' },
                    selectable.length === 0
                      ? h('div', { className: 'bl-row' }, h('div', { className: 'bl-row-main' }, h('div', { className: 'bl-row-title' }, '没有切出章节')))
                      : selectable.map((chapter) =>
                          h(
                            'div',
                            {
                              key: chapter.n,
                              className: 'bl-row' + (chapter.chars < 50 ? ' blank' : ''),
                            },
                            h('input', {
                              type: 'checkbox',
                              disabled: true,
                              title: 'M2 才开放勾选',
                              'aria-label': '选择 ' + chapter.title,
                            }),
                            h(
                              'div',
                              { className: 'bl-row-main' },
                              h('div', { className: 'bl-row-title' }, chapter.title),
                              h(
                                'div',
                                { className: 'bl-row-sub' },
                                '第 ' + chapter.from + (chapter.to !== chapter.from ? '–' + chapter.to : '') + ' 页 · ' + formatChars(chapter.chars),
                              ),
                            ),
                          ),
                        ),
                  ),
                )
              : h('div', { style: { opacity: 0.7 } }, '这本书打不开了。'),
        ),
        h(
          'div',
          { className: 'bl-foot' },
          h(
            'div',
            { className: 'bl-grow', style: { fontSize: 11.5, opacity: 0.55 } },
            book ? '共 ' + (book.chapters || 0) + ' 章' : '',
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
    };
  },
});
