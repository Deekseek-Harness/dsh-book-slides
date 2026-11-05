/**
 * 2.0 M1 客户端：书架、导入、分章构建、章校准、封面、回收站。
 * 只调用 /dsh-book-slides 的 2.0 M1 路由；讲次/生成/播放器在后续里程碑接入。
 */
window.__ModuleLoader__.load({
  id: 'dsh-book-slides',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useRef, useState } = React;
    const h = React.createElement;
    const PANEL_ID = 'book-slides';
    const API = '/dsh-book-slides';

    const CSS = `
.blm-root{height:100%;display:flex;flex-direction:column;overflow:hidden;position:relative;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.55;color:inherit}
.blm-bar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--bl-line,#e5e5e5);flex:0 0 auto}
.blm-bar h1{margin:0;font-size:14px;font-weight:600;flex:1;letter-spacing:.02em}
.blm-btn{border:1px solid var(--bl-line,#ddd);background:var(--bl-btn,#fff);color:inherit;border-radius:6px;padding:5px 10px;font:inherit;cursor:pointer;white-space:nowrap}
.blm-btn:hover{background:var(--bl-btn-hover,#f5f5f5)}
.blm-btn.primary{background:var(--bl-accent,#2f6fed);border-color:var(--bl-accent,#2f6fed);color:#fff}
.blm-btn:disabled{opacity:.55;cursor:default}
.blm-body{flex:1;min-height:0;overflow:auto;padding:14px}
.blm-empty{height:100%;min-height:260px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;border:1px dashed var(--bl-line,#ddd);border-radius:12px;color:var(--bl-dim,#777);text-align:center;padding:24px}
.blm-empty strong{font-size:15px;color:inherit;font-weight:600}
.blm-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:14px}
.blm-card{border:1px solid var(--bl-line,#e5e5e5);border-radius:10px;overflow:hidden;background:var(--bl-card,#fff);cursor:pointer;position:relative}
.blm-card:hover{border-color:var(--bl-accent,#2f6fed)}
.blm-cover{aspect-ratio:5/7;background:linear-gradient(135deg,#536,#213);display:flex;align-items:center;justify-content:center;overflow:hidden}
.blm-cover img{width:100%;height:100%;object-fit:cover;display:block}
.blm-cover span{font-size:28px;color:rgba(255,255,255,.8);font-family:serif}
.blm-card-main{padding:8px 10px 10px}
.blm-title{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.blm-meta{color:var(--bl-dim,#888);font-size:11px;margin-top:2px;display:flex;gap:6px;flex-wrap:wrap}
.blm-badge{font-size:10px;border:1px solid var(--bl-line,#ddd);border-radius:99px;padding:0 6px;color:var(--bl-dim,#777)}
.blm-badge.ok{color:#1a7f37;border-color:#1a7f3733;background:#1a7f370d}
.blm-menu{position:absolute;right:6px;top:6px;background:rgba(0,0,0,.55);color:#fff;border:0;border-radius:6px;width:24px;height:24px;cursor:pointer;line-height:1}
.blm-menu-box{position:absolute;right:6px;top:34px;z-index:5;background:var(--bl-card,#fff);border:1px solid var(--bl-line,#ddd);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.14);padding:4px;min-width:92px}
.blm-menu-box button{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;padding:6px 9px;border-radius:5px;font:inherit;cursor:pointer}
.blm-menu-box button:hover{background:var(--bl-btn-hover,#f4f4f4)}
.blm-menu-box button.danger{color:#c62828}
.blm-detail-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px}
.blm-detail-cover{width:96px;aspect-ratio:5/7;border-radius:8px;overflow:hidden;border:1px solid var(--bl-line,#ddd);flex:0 0 auto;background:linear-gradient(135deg,#536,#213);display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.8);font-size:24px}
.blm-detail-cover img{width:100%;height:100%;object-fit:cover}
.blm-detail-title{font-size:17px;font-weight:650;margin:0 0 4px}
.blm-dim{color:var(--bl-dim,#888)}
.blm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.blm-chapters{border:1px solid var(--bl-line,#e5e5e5);border-radius:10px;overflow:hidden;margin-top:12px}
.blm-chapter{display:grid;grid-template-columns:38px 1fr 62px 62px 34px;gap:8px;align-items:center;padding:7px 10px;border-bottom:1px solid var(--bl-line,#eee);font-size:12px}
.blm-chapter:last-child{border-bottom:0}
.blm-chapter input{width:100%;box-sizing:border-box;border:1px solid var(--bl-line,#ddd);border-radius:5px;padding:3px 5px;font:inherit;background:transparent;color:inherit}
.blm-chapter .t{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:text}
.blm-toast{position:absolute;left:14px;right:14px;bottom:12px;background:#222;color:#fff;border-radius:8px;padding:8px 12px;font-size:12px;z-index:20;box-shadow:0 6px 20px rgba(0,0,0,.25)}
.blm-error{background:#c6282810;border:1px solid #c6282840;color:#a11;border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:12px}
.blm-progress{height:4px;background:var(--bl-line,#eee);border-radius:99px;overflow:hidden;margin:10px 0}
.blm-progress i{display:block;height:100%;background:var(--bl-accent,#2f6fed);transition:width .2s}
.blm-select{border:1px solid var(--bl-line,#ddd);border-radius:6px;padding:5px 8px;font:inherit;background:transparent;color:inherit}
.blm-trash{position:absolute;inset:0;background:var(--bl-bg,#fff);z-index:10;display:flex;flex-direction:column}
.blm-trash-list{flex:1;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:8px}
.blm-trash-row{border:1px solid var(--bl-line,#e5e5e5);border-radius:8px;padding:9px 10px;display:flex;align-items:center;gap:8px}
.blm-trash-row .grow{flex:1;min-width:0}
`;

    async function api(path, options) {
      const res = await fetch(API + path, options);
      let data = null;
      try {
        data = await res.json();
      } catch {
        throw new Error('服务端返回的不是 JSON');
      }
      if (!data || data.ok !== true) {
        const err = new Error((data && (data.message || data.error)) || '请求失败');
        err.code = data && data.code;
        err.detail = data;
        throw err;
      }
      return data;
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

    function Card({ book, onOpen, onRename, onDelete }) {
      const [menu, setMenu] = useState(false);
      const cover = book.cover ? API + '/cover?bookId=' + encodeURIComponent(book.id) + '&v=' + encodeURIComponent(book.lastOpenedAt) : '';
      return h(
        'div',
        { className: 'blm-card', onClick: onOpen, title: book.title },
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
            h('span', { className: 'blm-badge' + (book.chaptersBuilt ? ' ok' : '') }, book.chaptersBuilt ? '已分章' : '待分章'),
          ),
        ),
        h(
          'button',
          {
            className: 'blm-menu',
            title: '更多',
            onClick: (event) => {
              event.stopPropagation();
              setMenu((v) => !v);
            },
            onBlur: () => setTimeout(() => setMenu(false), 150),
          },
          '⋯',
        ),
        menu
          ? h(
              'div',
              { className: 'blm-menu-box', onClick: (event) => event.stopPropagation() },
              h('button', { onClick: () => { setMenu(false); onRename(); } }, '重命名'),
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
        if (!window.confirm('清空回收站？此操作不可撤销。')) return;
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

    function Detail({ bookId, onBack, onChanged, notify }) {
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(true);
      const [busy, setBusy] = useState(false);
      const [mode, setMode] = useState('auto');
      const [progress, setProgress] = useState(0);
      const [draft, setDraft] = useState([]);
      const [editing, setEditing] = useState(false);

      const load = useCallback(async () => {
        setLoading(true);
        try {
          const out = await api('/book?bookId=' + encodeURIComponent(bookId));
          setData(out);
          setDraft(out.chapters || []);
        } catch (err) {
          notify(err.message);
        } finally {
          setLoading(false);
        }
      }, [bookId, notify]);
      useEffect(() => {
        load();
      }, [load]);

      const generateCover = async () => {
        setBusy(true);
        try {
          await api('/cover', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bookId }),
          });
          notify('封面已生成');
          await load();
          onChanged();
        } catch (err) {
          notify(err.message);
        } finally {
          setBusy(false);
        }
      };

      const build = async () => {
        setBusy(true);
        setProgress(0);
        const timer = setInterval(() => setProgress((v) => Math.min(0.9, v + 0.06)), 180);
        try {
          const out = await api('/chapters/build', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bookId, mode }),
          });
          setProgress(1);
          const warn = Array.isArray(out.warnings) && out.warnings.length ? '；' + out.warnings.join(' ') : '';
          notify('已生成 ' + out.chapters.length + ' 章' + warn);
          await load();
          onChanged();
        } catch (err) {
          notify(err.code === 'E_MANUAL_EDITS' ? '有手动修改过的章；请确认覆盖后重试。' : err.message);
        } finally {
          clearInterval(timer);
          setBusy(false);
        }
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

      if (loading && !data) return h('div', { className: 'blm-body' }, h('div', { className: 'blm-dim' }, '加载中…'));
      if (!data) return h('div', { className: 'blm-body' }, h('button', { className: 'blm-btn', onClick: onBack }, '← 返回'));

      const book = data.book || {};
      const chapters = data.chapters || [];
      const cover = data.cover ? API + '/cover?bookId=' + encodeURIComponent(bookId) + '&v=' + encodeURIComponent(book.lastOpenedAt || '') : '';
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
        h(
          'div',
          { className: 'blm-detail-head' },
          h('div', { className: 'blm-detail-cover' }, cover ? h('img', { src: cover, alt: '' }) : String(book.title || '书').slice(0, 1)),
          h(
            'div',
            { style: { minWidth: 0 } },
            h('h2', { className: 'blm-detail-title' }, book.title || '未命名'),
            h('div', { className: 'blm-meta' }, (book.author || '未知作者') + ' · ' + (book.pages || 0) + ' 页 · ' + (book.chars || 0) + ' 字'),
            h('div', { className: 'blm-meta' }, data.chaptersBuilt ? chapters.length + ' 章 · 已分章' : '尚未分章'),
          ),
        ),
        h('div', { className: 'blm-error', style: { background: 'transparent', borderColor: 'transparent', padding: 0, color: 'inherit' } },
          h('span', { className: 'blm-dim' }, 'M1 只开放分章与书库；讲次规划、生成与播放器在后续里程碑接入。')),
        !data.chaptersBuilt
          ? h(
              'div',
              { style: { marginTop: 10 } },
              h(
                'div',
                { className: 'blm-row' },
                h('select', { className: 'blm-select', value: mode, onChange: (e) => setMode(e.target.value), disabled: busy },
                  h('option', { value: 'auto' }, '自动（书签/标题/机械）'),
                  h('option', { value: 'toc' }, '目录（PDF 书签）'),
                  h('option', { value: 'mech' }, '机械切分'),
                ),
                h('button', { className: 'blm-btn primary', disabled: busy, onClick: build }, busy ? '正在分章…' : '生成章节目录'),
              ),
              h('div', { className: 'blm-progress' }, h('i', { style: { width: Math.round(progress * 100) + '%' } })),
              h('div', { className: 'blm-dim' }, '导入不再自动分章；目录模式在没有书签时会回退自动分章。'),
            )
          : h(
              'div',
              null,
              h(
                'div',
                { className: 'blm-row', style: { marginTop: 4 } },
                h('button', { className: 'blm-btn', onClick: () => setEditing((v) => !v) }, editing ? '取消编辑' : '校准章节'),
                editing ? h('button', { className: 'blm-btn primary', disabled: busy, onClick: save }, '保存') : null,
              ),
              h(
                'div',
                { className: 'blm-chapters' },
                (editing ? draft : chapters).map((c, i) =>
                  h(
                    'div',
                    { className: 'blm-chapter', key: c.n + '-' + c.from },
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
                    h('span', { className: 'blm-dim', style: { fontSize: 10, textAlign: 'right' } }, c.manual ? '手动' : ''),
                  ),
                ),
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
      const [view, setView] = useState({ name: 'shelf' });
      const [trash, setTrash] = useState(false);
      const [drag, setDrag] = useState(false);
      const toastTimer = useRef(null);
      const notify = useCallback((text) => {
        setToast(String(text || ''));
        clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(''), 3200);
      }, []);

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
          if (out && out.ok) {
            notify('已导入《' + (out.book.title || file.name) + '》，下一步生成章节目录。');
            await loadBooks();
            setView({ name: 'book', bookId: out.bookId });
          } else if (out && out.code === 'E_DUP_BOOK') {
            notify('这本书已在书架：' + (out.title || ''));
          } else {
            notify((out && (out.message || out.error)) || '导入失败');
          }
        } catch (err) {
          notify(err.message);
        } finally {
          setBusy(false);
          setProgress(0);
        }
      };

      const rename = async (book) => {
        const next = window.prompt('新的书名', book.title);
        if (next == null) return;
        try {
          await api('/rename', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ bookId: book.id, title: next }),
          });
          notify('已重命名');
          await loadBooks();
        } catch (err) {
          notify(err.message);
        }
      };

      const remove = async (book) => {
        if (!window.confirm('删除《' + book.title + '》？会进回收站，7 天内可恢复。')) return;
        try {
          await fetch(API + '/book?bookId=' + encodeURIComponent(book.id), { method: 'DELETE' }).then((r) => r.json());
          notify('已移入回收站');
          await loadBooks();
        } catch (err) {
          notify(err.message);
        }
      };

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
        h(
          'div',
          { className: 'blm-bar' },
          view.name === 'shelf' ? h('h1', null, '精讲') : null,
          view.name === 'shelf'
            ? h(
                React.Fragment,
                null,
                h('button', { className: 'blm-btn', onClick: () => setTrash(true) }, '回收站'),
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
        ),
        view.name === 'shelf'
          ? h(
              'div',
              { className: 'blm-body' },
              loading
                ? h('div', { className: 'blm-dim' }, '加载书架…')
                : books.length
                  ? h('div', { className: 'blm-grid' }, books.map((book) =>
                      h(Card, {
                        key: book.id,
                        book,
                        onOpen: () => setView({ name: 'book', bookId: book.id }),
                        onRename: () => rename(book),
                        onDelete: () => remove(book),
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
          : h(Detail, {
              bookId: view.bookId,
              onBack: () => {
                setView({ name: 'shelf' });
                loadBooks();
              },
              onChanged: loadBooks,
              notify,
            }),
        trash ? h(Trash, { onClose: () => setTrash(false), onChanged: loadBooks, notify }) : null,
        h(Toast, { text: toast }),
        busy && view.name === 'shelf' ? h('div', { className: 'blm-progress', style: { position: 'absolute', left: 0, right: 0, bottom: 0, margin: 0 } }, h('i', { style: { width: Math.round(progress * 100) + '%' } })) : null,
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
      __components: { Panel, Detail, Card, Trash },
    };
  },
});
