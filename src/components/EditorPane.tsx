import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  Check,
  ChevronRight,
  Copy,
  Download,
  Eye,
  Feather,
  FileCode,
  FolderInput,
  History,
  Link2,
  ListTree,
  Maximize2,
  MoreHorizontal,
  PenLine,
  Printer,
  Redo2,
  RotateCcw,
  Undo2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { redo, undo } from '@codemirror/commands';
import { useApp } from '../store/app';
import { getBacklinks, duplicateNote } from '../lib/repo';
import { wordCount } from '../lib/markdown';
import { highlightTermsOf } from '../lib/search';
import { cn, friendlyTime, fullDate } from '../lib/utils';
import { useT } from '../lib/i18n';
import { exportNoteHtml, exportNoteMarkdown, printNote } from '../lib/export';
import { getActiveView } from '../lib/editorBridge';
import {
  getActiveRichEditor,
  richDocSize,
  richDocText,
  richRedo,
  richReplaceWithText,
  richSelection,
  richUndo,
} from '../lib/rich/bridge';
import { AiChat, type AiApplyMode, type AiApplyResult, type AiEditorState } from './AiChat';
import { Editor } from './Editor';
import { RichEditor } from './RichEditor';
import { EditorContextMenu } from './EditorContextMenu';
import { FormatBar } from './FormatBar';
import { Preview } from './Preview';
import { Menu, type MenuEntry } from './Menu';
import { ConfirmDialog } from './Confirm';
import { useTrashConfirm } from './TrashConfirm';
import { HistoryModal } from './HistoryModal';
import { ImageLightbox } from './ImageLightbox';
import { TocPanel } from './TocPanel';
import { PrivacyGate } from './PrivacyDialog';
import { usePrivacy } from '../store/privacy';
import { noteNeedsPassword } from '../lib/privacy';

/** 点在滚动条上时不能抢：拖动滚动条本身不算「点空白」 */
function hitsScrollbar(el: HTMLElement, clientX: number) {
  if (el.scrollHeight <= el.clientHeight) return false;
  const rect = el.getBoundingClientRect();
  const bar = el.offsetWidth - el.clientWidth;
  // macOS 的覆盖式滚动条不占布局宽度，靠右留一小块死区，别把拖滚动条当成点空白
  const edge = bar > 0 ? rect.left + el.clientWidth : rect.right - 12;
  return clientX >= edge - 1;
}

/** 编辑区里除了正文和浮层之外的区域，才算「空白」 */
const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, label, [role="dialog"], [contenteditable="true"], .rich-find, .rich-suggest, .rich-table-chip, .rich-objbar, .cm-tooltip, .cm-panels';

export function EditorPane() {
  const t = useT();
  const notes = useApp((s) => s.notes);
  const setMoveNote = useApp((s) => s.setMoveNote);
  const current = useApp((s) => s.current);
  const diskEpoch = useApp((s) => s.diskEpoch);
  const view = useApp((s) => s.view);
  const query = useApp((s) => s.query);
  const searchHit = useApp((s) => s.searchHit);
  const updateContent = useApp((s) => s.updateContent);
  const setTitle = useApp((s) => s.setTitle);
  const setTags = useApp((s) => s.setTags);
  const { request: requestTrash, dialog: trashDialog } = useTrashConfirm();
  const restore = useApp((s) => s.restore);
  const purge = useApp((s) => s.purge);
  const refresh = useApp((s) => s.refresh);
  const select = useApp((s) => s.select);
  const setView = useApp((s) => s.setView);
  const setQuery = useApp((s) => s.setQuery);
  const toggleFocus = useApp((s) => s.toggleFocus);
  const focusMode = useApp((s) => s.focusMode);
  const typewriter = useApp((s) => s.typewriter);
  const tocOpen = useApp((s) => s.tocOpen);
  const toggleToc = useApp((s) => s.toggleToc);
  const create = useApp((s) => s.create);
  const openDaily = useApp((s) => s.openDaily);
  const toast = useApp((s) => s.toast);
  const setSettings = useApp((s) => s.setSettings);
  const focusNoteId = useApp((s) => s.focusNoteId);

  const note = current;
  const isTrash = view.type === 'trash';
  const noteLocked = usePrivacy((s) => (note ? noteNeedsPassword(note, s, s.unlocked) : false));
  const [preview, setPreview] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [tagInput, setTagInput] = useState(false);
  const [tagValue, setTagValue] = useState('');
  const [tagIdx, setTagIdx] = useState(-1);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [linksOpen, setLinksOpen] = useState(true);
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiPolishSeq, setAiPolishSeq] = useState(0);
  const [imageViewer, setImageViewer] = useState<{ url: string; alt: string } | null>(null);
  // 从搜索结果打开时，正文里的关键词用浏览器高亮标出来；清空搜索即消失
  // 全局搜索（Ctrl K）不改左侧筛选条件，所以把当次搜索词单独记下来，按笔记 id 生效
  const highlightTerms = useMemo(() => {
    if (query.trim()) return highlightTermsOf(query);
    return searchHit && note && searchHit.id === note.id ? highlightTermsOf(searchHit.query) : [];
  }, [query, searchHit, note?.id]);
  /** 打开预览前记下光标位置，切回编辑时放回原处 */
  const editorPos = useRef(0);
  const focusEditor = useRef(false);
  // 换笔记时立即清掉上一次的光标位置，别把新笔记的光标带到旧位置
  const lastNoteId = useRef(note?.id);
  if (lastNoteId.current !== note?.id) {
    lastNoteId.current = note?.id;
    editorPos.current = 0;
    focusEditor.current = false;
  }
  /** 默认所见即所得；关掉后显示原始 Markdown，给进阶用户用 */
  const [live, setLive] = useState(() => localStorage.getItem('glimnote.live') !== '0');

  const toggleLive = () => {
    setLive((on) => {
      const next = !on;
      localStorage.setItem('glimnote.live', next ? '1' : '0');
      return next;
    });
  };

  useEffect(() => {
    setPreview(false);
    setTagInput(false);
    setTagValue('');
    setLinksOpen(true);
    setHistoryOpen(false);
    setAiPanelOpen(false);
    setImageViewer(null);
    editorPos.current = 0;
    focusEditor.current = false;
  }, [note?.id]);

  // 富文本编辑器里双击 / 点击放大图片时发事件，这里统一弹出大图
  useEffect(() => {
    const onPreview = (event: Event) => {
      const detail = (event as CustomEvent<{ url?: string; alt?: string }>).detail;
      if (!detail?.url) return;
      setImageViewer({ url: detail.url, alt: detail.alt || t('图片') });
    };
    window.addEventListener('glimnote:image-preview', onPreview);
    return () => window.removeEventListener('glimnote:image-preview', onPreview);
  }, []);

  useEffect(() => {
    setTitleDraft(note?.title || '');
  }, [note?.id, note?.title]);

  // 新建笔记请求的那一次聚焦：编辑器挂载时已经读到了，这里把请求清掉，之后重挂载不再抢焦点
  useEffect(() => {
    if (focusNoteId && focusNoteId === note?.id) useApp.getState().clearFocusNote();
  }, [focusNoteId, note?.id]);

  const backlinks = useMemo(() => (note && !isTrash ? getBacklinks(notes, note) : []), [notes, note, isTrash]);

  const tagSuggestions = useMemo(() => {
    if (!note) return [] as [string, number][];
    const map = new Map<string, number>();
    notes.forEach((n) => n.tags.forEach((t) => map.set(t, (map.get(t) || 0) + 1)));
    const term = tagValue.trim().replace(/^#/, '').toLowerCase();
    return [...map.entries()]
      .filter(([t]) => !note.tags.includes(t))
      .filter(([t]) => !term || t.toLowerCase().includes(term))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
  }, [notes, note, tagValue]);

  if (!note) {
    return (
      <section className="editor-pane">
        {isTrash ? (
          <div className="editor-empty">
            <Trash2 size={24} strokeWidth={1.75} />
            <div className="big">{t('回收站')}</div>
            <div className="hint">
              {t('从左侧选择一篇笔记查看内容。')}
              <br />
              {t('恢复后会回到原来的笔记本。')}
            </div>
          </div>
        ) : (
          <div className="editor-empty">
            <div
              style={{
                width: 54,
                height: 54,
                borderRadius: 16,
                background: 'var(--accent-soft)',
                color: 'var(--accent)',
                display: 'grid',
                placeItems: 'center',
                marginBottom: 2,
              }}
            >
              <Feather size={24} strokeWidth={1.75} />
            </div>
            <div className="big">{t('选一篇笔记，或者开始新的')}</div>
            <div className="hint">
              {t('新建')} <kbd>Ctrl N</kbd> · {t('搜索')} <kbd>Ctrl K</kbd> · {t('今日日记')} <kbd>Ctrl D</kbd>
              <br />
              {t('所有内容都保存在本地，断网也能继续写。')}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-primary" onClick={() => void create()}>
                {t('新建笔记')}
              </button>
              <button className="btn btn-secondary" onClick={() => void openDaily()}>
                {t('今日日记')}
              </button>
            </div>
          </div>
        )}
      </section>
    );
  }

  if (noteLocked) {
    return (
      <section className="editor-pane">
        <PrivacyGate
          onBack={() => {
            setView({ type: 'notebook', value: note.notebook || '' });
          }}
        />
      </section>
    );
  }

  const words = wordCount(note.content);
  const minutes = Math.max(1, Math.round(words / 400));
  const segments = note.notebook ? note.notebook.split('/') : [];

  const commitTitle = () => {
    const clean = titleDraft.trim();
    if (!clean) {
      setTitleDraft(note.title);
      return;
    }
    if (clean !== note.title) void setTitle(note.id, clean.slice(0, 80));
  };

  const addTagValue = (raw: string) => {
    const t = raw.trim().replace(/^#/, '').slice(0, 20);
    if (t && !note.tags.includes(t)) setTags(note.id, [...note.tags, t]);
    setTagValue('');
    setTagInput(false);
    setTagIdx(-1);
  };

  const addTag = () => addTagValue(tagValue);

  const openMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.right - 180, y: r.bottom + 6 });
  };

  /** 阅读预览只留在「更多」菜单里，工具栏不再占一个按钮 */
  const togglePreview = () => {
    if (preview) {
      focusEditor.current = true;
    } else {
      const rich = live ? getActiveRichEditor() : null;
      if (rich) editorPos.current = rich.state.selection.head;
      else {
        const v = getActiveView();
        editorPos.current = v ? v.state.selection.main.head : 0;
      }
    }
    setPreview((p) => !p);
  };

  const menuItems: (MenuEntry | 'sep')[] = [
    {
      label: t('撤销'),
      icon: <Undo2 size={14} />,
      kbd: 'Ctrl Z',
      disabled: preview,
      onClick: () => {
        if (live && getActiveRichEditor()) {
          richUndo();
          return;
        }
        const v = getActiveView();
        if (v) undo(v);
      },
    },
    {
      label: t('重做'),
      icon: <Redo2 size={14} />,
      kbd: 'Ctrl Y',
      disabled: preview,
      onClick: () => {
        if (live && getActiveRichEditor()) {
          richRedo();
          return;
        }
        const v = getActiveView();
        if (v) redo(v);
      },
    },
    'sep',
    { label: t('导出 Markdown'), icon: <Download size={14} />, onClick: () => exportNoteMarkdown(note) },
    {
      label: t('导出 HTML'),
      icon: <FileCode size={14} />,
      onClick: async () => {
        await exportNoteHtml(note);
        toast(t('已导出 HTML（图片已内嵌）'), 'success');
      },
    },
    { label: t('打印 / 保存 PDF'), icon: <Printer size={14} />, onClick: () => void printNote(note) },
    {
      label: preview ? t('切回编辑') : t('阅读预览'),
      icon: preview ? <PenLine size={14} /> : <Eye size={14} />,
      onClick: togglePreview,
    },
    {
      label: t('创建副本'),
      icon: <Copy size={14} />,
      onClick: async () => {
        const copy = await duplicateNote(note);
        await refresh();
        select(copy.id);
        toast(t('已创建副本'), 'success');
      },
    },
    { label: t('移动到…'), icon: <FolderInput size={14} />, onClick: () => setMoveNote(note.id) },
    { label: t('历史版本…'), icon: <History size={14} />, onClick: () => setHistoryOpen(true) },
    'sep',
    { label: t('移到回收站'), icon: <Trash2 size={14} />, danger: true, onClick: () => requestTrash(note.id) },
  ];

  /** 聊天窗读取正文与选区：两种编辑器各用各的坐标系，外面只拿统一快照 */
  const readAiEditor = (): AiEditorState | null => {
    const rich = live ? getActiveRichEditor() : null;
    if (rich) {
      const { from, to } = rich.state.selection;
      return {
        docLength: richDocSize(),
        selection: { from, to, text: richSelection()?.text || '' },
        cursor: to,
        noteText: richDocText(),
      };
    }
    const view = getActiveView();
    if (!view) return null;
    const { from, to } = view.state.selection.main;
    const doc = view.state.doc.toString();
    return {
      docLength: doc.length,
      selection: { from, to, text: doc.slice(from, to) },
      cursor: to,
      noteText: doc,
    };
  };

  /**
   * 把 AI 回复写回正文。
   * 位置记的是发起对话时的快照；生成期间文档长度变了，替换就退回当前选区，
   * 选区也丢了则让用户重新选，宁可多一步，也不要覆盖错段落。
   */
  const applyAiText = (text: string, mode: AiApplyMode, anchor: { from: number; to: number; at: number; docLength: number }): AiApplyResult => {
    const rich = live ? getActiveRichEditor() : null;
    if (rich) {
      const lengthSame = richDocSize() === anchor.docLength;
      if (mode === 'replace') {
        const current = richSelection();
        if (!lengthSame && !(current && current.text.trim())) return 'stale';
        const from = lengthSame ? anchor.from : current?.from || 0;
        const to = lengthSame ? anchor.to : current?.to || 0;
        richReplaceWithText(from, to, text, 'replace');
      } else {
        const at = Math.min(lengthSame ? anchor.at : rich.state.selection.to, rich.state.doc.content.size);
        richReplaceWithText(at, at, text, 'append');
      }
      return 'ok';
    }

    const view = getActiveView();
    if (!view) return 'no-editor';
    const lengthSame = view.state.doc.length === anchor.docLength;
    const sel = view.state.selection.main;
    if (mode === 'replace') {
      if (!lengthSame && sel.from === sel.to) return 'stale';
      const from = lengthSame ? anchor.from : sel.from;
      const to = lengthSame ? anchor.to : sel.to;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      });
    } else {
      const at = Math.min(lengthSame ? anchor.at : sel.head, view.state.doc.length);
      const before = view.state.sliceDoc(Math.max(0, at - 2), at);
      const lead = at > 0 && !before.endsWith('\n\n') ? '\n\n' : '';
      const insert = `${lead}${text}\n`;
      view.dispatch({ changes: { from: at, to: at, insert }, selection: { anchor: at + insert.length } });
    }
    view.focus();
    return 'ok';
  };

  const noteActions = (
    <>
      <button
        className={cn('icon-btn', tocOpen && 'on')}
        onClick={toggleToc}
        title={t('目录  Ctrl+Shift+O')}
        aria-pressed={tocOpen}
      >
        <ListTree size={16} strokeWidth={1.75} />
      </button>
      <button
        className={cn('icon-btn', aiPanelOpen && 'on')}
        onClick={() => setAiPanelOpen((v) => !v)}
        title={t('AI 写作助手：对话、润色选中文字、接着续写')}
        aria-haspopup="dialog"
        aria-expanded={aiPanelOpen}
      >
        <Sparkles size={16} strokeWidth={1.75} />
      </button>
      <button className="icon-btn" onClick={toggleFocus} title={t('专注模式  Ctrl+Shift+F')}>
        <Maximize2 size={16} strokeWidth={1.75} />
      </button>
      <button className="icon-btn" onClick={openMenu} title={t('更多')}>
        <MoreHorizontal size={16} strokeWidth={1.75} />
      </button>
    </>
  );

  /**
   * 点正文两侧或下方的空白时，浏览器会把焦点从可编辑区拿走，光标就「不见了」。
   * 这里接住空白处的点击，按点击高度落到最近的一行；正文内部仍交给编辑器自己处理。
   */
  const focusEditorFromBlank = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || isTrash || preview) return;
    const target = event.target as HTMLElement;
    if (target.closest(INTERACTIVE_SELECTOR)) return;

    if (live) {
      const rich = getActiveRichEditor();
      if (!rich || rich.view.dom.contains(target)) return;
      const scroller = rich.view.dom.closest('.rich-scroll') as HTMLElement | null;
      if (scroller && hitsScrollbar(scroller, event.clientX)) return;
      event.preventDefault();
      const rect = rich.view.dom.getBoundingClientRect();
      // 点在正文上方 / 下方：直接去文首 / 文末，别按坐标算出个奇怪的位置
      if (event.clientY <= rect.top) {
        rich.chain().focus('start').run();
        return;
      }
      if (event.clientY >= rect.bottom) {
        rich.chain().focus('end').run();
        return;
      }
      const hit = rich.view.posAtCoords({
        left: Math.min(Math.max(event.clientX, rect.left + 2), rect.right - 2),
        top: event.clientY,
      });
      // 坐标落不到文字上时保留原光标，别把长文档的读者一下甩到末尾
      const pos = hit ? Math.max(1, Math.min(hit.pos, rich.state.doc.content.size)) : rich.state.selection.from;
      rich.chain().setTextSelection(pos).focus().run();
      return;
    }

    const view = getActiveView();
    if (!view || view.contentDOM.contains(target)) return;
    if (hitsScrollbar(view.scrollDOM, event.clientX)) return;
    event.preventDefault();
    const rect = view.contentDOM.getBoundingClientRect();
    // 源码模式：同上，上方落文首、下方落文末，中间按坐标找最近一行
    let pos: number | null =
      event.clientY <= rect.top ? 0 : event.clientY >= rect.bottom ? view.state.doc.length : null;
    if (pos == null) {
      const hit = view.posAtCoords({
        x: Math.min(Math.max(event.clientX, rect.left + 2), rect.right - 2),
        y: event.clientY,
      });
      // 同上：找不到具体位置就保留原光标，不强行跳到文末
      pos = hit == null ? view.state.selection.main.head : hit;
    }
    const at = Math.max(0, Math.min(pos, view.state.doc.length));
    view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
    view.focus();
  };

  return (
    <section className="editor-pane">
      <div className="editor-head">
        <div className="crumb">
          <button
            onClick={() => {
              setView({ type: 'notebook', value: 'all' });
              setQuery('');
            }}
          >
            {t('全部笔记')}
          </button>
          {segments.map((seg, i) => (
            <span key={seg + i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ChevronRight size={14} />
              <button onClick={() => setView({ type: 'notebook', value: segments.slice(0, i + 1).join('/') })}>
                {seg}
              </button>
            </span>
          ))}
          {isTrash && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ChevronRight size={14} />
              <span style={{ color: 'var(--danger)' }}>{t('回收站')}</span>
            </span>
          )}
        </div>

        {isTrash ? (
          <h1 className="editor-title" style={{ opacity: 0.92 }}>
            {note.title}
          </h1>
        ) : (
          <input
            className="editor-title"
            value={titleDraft}
            placeholder={t('未命名笔记')}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        )}

        <div className="meta-row">
          <span className="meta-date">
            {isTrash ? t('删除于 {date}', { date: fullDate(note.deletedAt || note.updated) }) : fullDate(note.created)}
          </span>
          <span className="meta-sep" />
          <span className="meta-date">{t('{n} 字', { n: words })}</span>
          <span className="meta-sep" />
          <div className="meta-tags">
            {note.tags.map((tag) => (
              <span
                key={tag}
                className={cn('tag-chip', !isTrash && 'editable')}
                title={isTrash ? `#${tag}` : t('点击移除标签 #{tag}', { tag })}
                onClick={() => {
                  if (!isTrash)
                    setTags(
                      note.id,
                      note.tags.filter((x) => x !== tag),
                    );
                }}
              >
                {tag}
                {!isTrash && <X size={14} style={{ opacity: 0.55 }} />}
              </span>
            ))}
            {!isTrash &&
              (tagInput ? (
                <span className="tag-input-wrap">
                  <input
                    className="tag-input"
                    autoFocus
                    value={tagValue}
                    placeholder={t('标签名')}
                    onChange={(e) => {
                      setTagValue(e.target.value);
                      setTagIdx(-1);
                    }}
                    onBlur={addTag}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowDown' && tagSuggestions.length) {
                        e.preventDefault();
                        setTagIdx((i) => (i + 1) % tagSuggestions.length);
                      } else if (e.key === 'ArrowUp' && tagSuggestions.length) {
                        e.preventDefault();
                        setTagIdx((i) => (i - 1 + tagSuggestions.length) % tagSuggestions.length);
                      } else if (e.key === 'Enter') {
                        e.preventDefault();
                        if (tagIdx >= 0 && tagSuggestions[tagIdx]) addTagValue(tagSuggestions[tagIdx][0]);
                        else addTag();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setTagValue('');
                        setTagInput(false);
                        setTagIdx(-1);
                      }
                    }}
                  />
                  {tagSuggestions.length > 0 && (
                    <span className="tag-suggest">
                      {tagSuggestions.map(([t, c], i) => (
                        <button
                          key={t}
                          type="button"
                          className={cn('tag-suggest-item', i === tagIdx && 'on')}
                          onMouseDown={(e) => e.preventDefault()}
                          onMouseEnter={() => setTagIdx(i)}
                          onClick={() => addTagValue(t)}
                        >
                          <span>{t}</span>
                          <em>{c}</em>
                        </button>
                      ))}
                    </span>
                  )}
                </span>
              ) : (
                <button className="tag-add" onClick={() => setTagInput(true)}>
                  + {t('标签')}
                </button>
              ))}
          </div>

          {isTrash && (
            <div className="editor-actions">
              <button className="btn btn-secondary" style={{ height: 28 }} onClick={() => void restore(note.id)}>
                <RotateCcw size={14} strokeWidth={1.75} /> {t('恢复')}
              </button>
              <button className="btn btn-danger" style={{ height: 28 }} onClick={() => setConfirmPurge(true)}>
                <Trash2 size={14} strokeWidth={1.75} /> {t('永久删除')}
              </button>
            </div>
          )}
        </div>
      </div>

      {!isTrash &&
        (preview ? (
          /* 阅读预览只留笔记级操作：切回编辑、目录、导出与打印都在这里，不能把用户困在预览里 */
          <div className="format-bar fmt-preview-bar">
            <span className="fmt-actions">{noteActions}</span>
          </div>
        ) : (
          <FormatBar
            notePath={note.path}
            live={live}
            onToggleLive={toggleLive}
            onNotice={(text) => toast(text, 'success')}
            actions={noteActions}
          />
        ))}

      <div className="editor-body">
        <div className="editor-main" onMouseDown={focusEditorFromBlank}>
          {isTrash || preview ? (
            <Preview
              content={note.content}
              notePath={note.path}
              onNotice={(text) => toast(text, 'success')}
              onWiki={(title) => {
                const target = notes.find((n) => n.title === title);
                if (!target) {
                  toast(t('找不到笔记「{title}」', { title }), 'warn');
                  return;
                }
                select(target.id);
                setView({ type: 'notebook', value: target.notebook });
              }}
            />
          ) : live ? (
            <RichEditor
              key={`${note.id}:${epoch}:${diskEpoch}`}
              note={note}
              onChange={(content) => updateContent(note.id, content)}
              onNotice={(text) => toast(text, 'success')}
              typewriter={typewriter && focusMode}
              initialPos={editorPos.current}
              focusOnMount={focusEditor.current || focusNoteId === note.id}
              highlightTerms={highlightTerms}
              onWiki={(title) => {
                const target = notes.find((n) => n.title === title);
                if (!target) {
                  toast(t('找不到笔记「{title}」', { title }), 'warn');
                  return;
                }
                select(target.id);
                setView({ type: 'notebook', value: target.notebook });
              }}
            />
          ) : (
            <Editor
              key={`${note.id}:${epoch}:${diskEpoch}`}
              note={note}
              onChange={(content) => updateContent(note.id, content)}
              onNotice={(text) => toast(text, 'success')}
              typewriter={typewriter && focusMode}
              initialPos={editorPos.current}
              focusOnMount={focusEditor.current || focusNoteId === note.id}
              highlightTerms={highlightTerms}
            />
          )}
        </div>
        {!isTrash && tocOpen && <TocPanel key={note.id} content={note.content} preview={preview} onClose={toggleToc} />}
        {!isTrash && !preview && (
          <AiChat
            noteId={note.id}
            title={note.title}
            open={aiPanelOpen}
            onOpenChange={setAiPanelOpen}
            polishSeq={aiPolishSeq}
            readEditor={readAiEditor}
            applyText={applyAiText}
            onOpenSettings={() => setSettings(true, 'ai')}
            tocOpen={tocOpen}
          />
        )}
      </div>

      {!isTrash && backlinks.length > 0 && (
        <div className="backlinks">
          <div className="backlinks-head" onClick={() => setLinksOpen((v) => !v)}>
            <Link2 size={14} />
            {t('其他笔记提到了它 · {n}', { n: backlinks.length })}
            <ChevronRight
              size={14}
              style={{ transform: linksOpen ? 'rotate(90deg)' : undefined, transition: 'transform 160ms' }}
            />
          </div>
          {linksOpen && (
            <div className="backlinks-list">
              {backlinks.map((n) => (
                <button
                  key={n.id}
                  className="backlink-item"
                  onClick={() => {
                    select(n.id);
                    setView({ type: 'notebook', value: n.notebook });
                  }}
                >
                  <span className="bl-title">{n.title}</span>
                  <span style={{ opacity: 0.6 }}>· {n.notebook}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="editor-foot">
        <span>{t('{n} 字', { n: words })}</span>
        <span>{t('约 {n} 分钟阅读', { n: minutes })}</span>
        <span className="grow" />
        {isTrash ? (
          <span style={{ color: 'var(--danger)' }}>{t('位于回收站')}</span>
        ) : (
          <span className="saved" title={t('纯 Markdown 文件 · {path}', { path: note.path })}>
            <Check size={14} /> {t('已保存本地 · {time}', { time: friendlyTime(note.updated) })}
          </span>
        )}
        <span className="foot-tip">{t('纯 Markdown 文件')}</span>
      </div>

      {!isTrash && !preview && (
        <EditorContextMenu
          onPolish={() => {
            setAiPanelOpen(true);
            setAiPolishSeq((seq) => seq + 1);
          }}
          onNotice={toast}
        />
      )}

      {menu && <Menu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      {trashDialog}

      {historyOpen && (
        <HistoryModal
          note={note}
          onClose={() => setHistoryOpen(false)}
          onRestore={(content) => {
            const previous = note.content;
            updateContent(note.id, content);
            setEpoch((v) => v + 1);
            setHistoryOpen(false);
            toast(t('已恢复到选中的版本'), 'success', {
              label: t('撤销'),
              run: () => {
                updateContent(note.id, previous);
                setEpoch((v) => v + 1);
              },
            });
          }}
        />
      )}

      {confirmPurge && (
        <ConfirmDialog
          title={t('永久删除这篇笔记？')}
          desc={t('删除后无法恢复，也不会再出现在其他设备上。')}
          confirmLabel={t('永久删除')}
          danger
          onCancel={() => setConfirmPurge(false)}
          onConfirm={() => {
            void purge(note.id);
            setConfirmPurge(false);
          }}
        />
      )}

      {imageViewer && (
        <ImageLightbox url={imageViewer.url} alt={imageViewer.alt} onClose={() => setImageViewer(null)} />
      )}
    </section>
  );
}
