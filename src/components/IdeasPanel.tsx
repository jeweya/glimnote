import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  ArrowUp,
  ArrowUpRight,
  Archive,
  Check,
  FileText,
  Lightbulb,
  ListTodo,
  Search,
  SearchX,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useApp } from '../store/app';
import {
  IDEA_MAX,
  groupIdeas,
  ideaFirstLine,
  ideaTimeText,
  ideaTitle,
  isIdeaOpen,
  matchIdea,
  type Idea,
} from '../lib/ideas';
import { cn } from '../lib/utils';
import { ConfirmDialog } from './Confirm';
import { useT } from '../lib/i18n';

/** 输入框随内容长高，最多 max 像素；超过后内部滚动 */
function useAutoGrow(ref: RefObject<HTMLTextAreaElement>, value: string, max: number) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [ref, value, max]);
}

function clip(text: string, max: number) {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

type Tab = 'open' | 'done';

export function IdeasPanel() {
  const ideas = useApp((s) => s.ideas);
  const loaded = useApp((s) => s.ideasLoaded);
  const loading = useApp((s) => s.ideasLoading);
  const addIdea = useApp((s) => s.addIdea);
  const updateIdea = useApp((s) => s.updateIdea);
  const removeIdeas = useApp((s) => s.removeIdeas);
  const convertIdeasToNote = useApp((s) => s.convertIdeasToNote);
  const convertIdeasToTasks = useApp((s) => s.convertIdeasToTasks);
  const openConverted = useApp((s) => s.openConverted);
  const loadIdeas = useApp((s) => s.loadIdeas);
  const tr = useT();

  const [tab, setTab] = useState<Tab>('open');
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [confirmClear, setConfirmClear] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);

  useAutoGrow(composerRef, draft, 168);
  useAutoGrow(editRef, editing?.text ?? '', 320);

  useEffect(() => {
    void loadIdeas();
  }, [loadIdeas]);

  // 跨零点时「今天 / 昨天」要跟着变
  useEffect(() => {
    const tick = window.setInterval(() => setNow(new Date()), 60000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!flashId) return;
    const t = window.setTimeout(() => setFlashId(null), 900);
    return () => window.clearTimeout(t);
  }, [flashId]);

  // 灵感被转化 / 删除后，选中集合里不该继续留着已经不在「未整理」里的 id
  useEffect(() => {
    setSelected((prev) => {
      if (!prev.size) return prev;
      const open = new Set(ideas.filter(isIdeaOpen).map((i) => i.id));
      const next = new Set<string>();
      prev.forEach((id) => {
        if (open.has(id)) next.add(id);
      });
      return next.size === prev.size ? prev : next;
    });
  }, [ideas]);

  const openIdeas = useMemo(() => ideas.filter(isIdeaOpen), [ideas]);
  const doneIdeas = useMemo(() => ideas.filter((i) => !isIdeaOpen(i)), [ideas]);
  const weekCount = useMemo(
    () => ideas.filter((i) => +new Date(i.created) >= now.getTime() - 7 * 86400000).length,
    [ideas, now],
  );

  const searching = Boolean(q.trim());
  const pool = tab === 'open' ? openIdeas : doneIdeas;
  const filtered = useMemo(() => (searching ? pool.filter((i) => matchIdea(i, q)) : pool), [pool, q, searching]);
  const groups = useMemo(() => groupIdeas(filtered, now), [filtered, now]);
  const visibleOpen = useMemo(
    () => (searching ? openIdeas.filter((i) => matchIdea(i, q)) : openIdeas),
    [openIdeas, q, searching],
  );
  const allSelected = visibleOpen.length > 0 && visibleOpen.every((i) => selected.has(i.id));
  const selectedIdeas = useMemo(() => openIdeas.filter((i) => selected.has(i.id)), [openIdeas, selected]);

  const switchTab = (next: Tab) => {
    setTab(next);
    setSelected(new Set());
    setEditing(null);
  };

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(visibleOpen.map((i) => i.id)));
  };

  const commitDraft = async () => {
    const text = draft;
    if (!text.trim() || saving) return;
    setSaving(true);
    const idea = await addIdea(text);
    setSaving(false);
    if (!idea) return;
    setDraft('');
    setTab('open');
    setQ('');
    setFlashId(idea.id);
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      composerRef.current?.focus();
    });
  };

  const startEdit = (idea: Idea) => {
    if (!isIdeaOpen(idea)) return;
    setEditing({ id: idea.id, text: idea.text });
  };

  const commitEdit = () => {
    if (!editing) return;
    const { id, text } = editing;
    setEditing(null);
    void updateIdea(id, text);
  };

  const convertOne = (idea: Idea, kind: 'note' | 'task') => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(idea.id);
      return next;
    });
    void (kind === 'note' ? convertIdeasToNote([idea.id]) : convertIdeasToTasks([idea.id]));
  };

  const convertSelected = (kind: 'note' | 'task') => {
    const ids = [...selected];
    if (!ids.length) return;
    setSelected(new Set());
    void (kind === 'note' ? convertIdeasToNote(ids) : convertIdeasToTasks(ids));
  };

  const deleteSelected = () => {
    const ids = [...selected];
    if (!ids.length) return;
    setSelected(new Set());
    void removeIdeas(ids);
  };

  // 预览与真正生成时保持同一顺序（按记下的时间从早到晚）
  const selectedByTime = [...selectedIdeas].sort((a, b) => +new Date(a.created) - +new Date(b.created));
  const notePreviewTitle =
    selectedIdeas.length === 1
      ? ideaTitle(selectedIdeas[0].text, 40) || tr('灵感')
      : tr('灵感整理 · {m}月{d}日', { m: now.getMonth() + 1, d: now.getDate() });

  const notePreviewBody =
    selectedIdeas.length === 1
      ? clip(selectedIdeas[0].text, 180)
      : selectedByTime
          .slice(0, 4)
          .map((i) => `· ${ideaTimeText(i.created, now)}  ${clip(ideaFirstLine(i.text), 26)}`)
          .join('\n');

  const taskPreview = selectedByTime.map((i) => ideaTitle(i.text, 80) || tr('未命名灵感'));

  const showEmptyAll = loaded && !loading && ideas.length === 0;
  const showEmptyOpen = loaded && !loading && !showEmptyAll && openIdeas.length === 0 && tab === 'open';
  const showEmptyDone = loaded && !loading && !showEmptyAll && doneIdeas.length === 0 && tab === 'done';

  const renderCard = (idea: Idea) => {
    const done = !isIdeaOpen(idea);
    const active = selected.has(idea.id);
    const isEditing = editing?.id === idea.id;
    return (
      <div
        key={idea.id}
        data-idea-row
        className={cn('idea-card', done && 'converted', active && 'on', flashId === idea.id && 'flash')}
      >
        {done ? (
          <span
            className={cn('idea-kind', idea.convertedType)}
            title={idea.convertedType === 'task' ? tr('已转为待办') : tr('已转为笔记')}
          >
            {idea.convertedType === 'task' ? <ListTodo size={14} /> : <FileText size={14} />}
          </span>
        ) : (
          <button
            className={cn('idea-check', active && 'on')}
            role="checkbox"
            aria-checked={active}
            aria-label={tr('选择这条灵感')}
            onClick={() => toggleSelect(idea.id)}
          >
            {active && <Check size={13} strokeWidth={2.25} />}
          </button>
        )}

        <div className="idea-content">
          {isEditing ? (
            <textarea
              ref={editRef}
              className="idea-edit"
              autoFocus
              value={editing.text}
              maxLength={IDEA_MAX}
              onChange={(e) => setEditing({ id: idea.id, text: e.target.value })}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setEditing(null);
                } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  commitEdit();
                }
              }}
            />
          ) : (
            <div
              className={cn('idea-text', !done && 'editable')}
              onClick={() => startEdit(idea)}
              title={done ? undefined : tr('点击修改')}
            >
              {idea.text}
            </div>
          )}
          <div className="idea-meta">
            <span className="idea-time">{ideaTimeText(idea.created, now)}</span>
            {done ? (
              <>
                <span className="idea-dot">·</span>
                <span className="idea-done-tag">{idea.convertedType === 'task' ? tr('待办') : tr('笔记')}</span>
                {idea.convertedTitle && (
                  <button
                    className="idea-target"
                    title={tr('打开「{title}」', { title: idea.convertedTitle })}
                    onClick={() => openConverted(idea.id)}
                  >
                    {idea.convertedTitle}
                  </button>
                )}
                <button className="idea-open" onClick={() => openConverted(idea.id)}>
                  {tr('打开')}
                  <ArrowUpRight size={12} />
                </button>
              </>
            ) : isEditing ? (
              <span className="idea-hint">{tr('Ctrl / ⌘ + 回车保存 · Esc 取消')}</span>
            ) : null}
          </div>
        </div>

        <div className="idea-actions">
          {done ? (
            <button className="idea-act" title={tr('删除这条转化记录')} onClick={() => void removeIdeas([idea.id])}>
              <Trash2 size={14} />
            </button>
          ) : (
            <>
              <button className="idea-act" title={tr('转为笔记')} onClick={() => convertOne(idea, 'note')}>
                <FileText size={14} />
              </button>
              <button className="idea-act" title={tr('转为待办')} onClick={() => convertOne(idea, 'task')}>
                <ListTodo size={14} />
              </button>
              <button className="idea-act danger" title={tr('删除')} onClick={() => void removeIdeas([idea.id])}>
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <section className="ideas-panel">
      <div className="ideas-main">
        <div className="ideas-inner">
          <div className="list-head ideas-head">
            <div className="list-title-row">
              <div>
                <div className="list-title">{tr('灵感')}</div>
                <div className="list-sub">
                  {loading || !loaded ? tr('正在读取灵感库…') : tr('{n} 条未整理 · 本周记下 {w} 条', { n: openIdeas.length, w: weekCount })}
                </div>
              </div>
              <span className="ideas-mark" title={tr('灵感是写给自己的草稿')}>
                <Lightbulb size={16} strokeWidth={1.75} />
              </span>
            </div>

            <div className="ideas-toolbar">
              <div className="idea-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={tab === 'open'}
                  className={cn('idea-tab', tab === 'open' && 'on')}
                  onClick={() => switchTab('open')}
                >
                  {tr('未整理')}<em>{openIdeas.length}</em>
                </button>
                <button
                  role="tab"
                  aria-selected={tab === 'done'}
                  className={cn('idea-tab', tab === 'done' && 'on')}
                  onClick={() => switchTab('done')}
                >
                  {tr('已转化')}<em>{doneIdeas.length}</em>
                </button>
              </div>

              <div className="ideas-toolbar-right">
                {tab === 'open' && visibleOpen.length > 0 && (
                  <button className="ideas-linkbtn" onClick={toggleAll}>
                    {allSelected ? tr('取消全选') : tr('全选')}
                  </button>
                )}
                {tab === 'done' && doneIdeas.length > 0 && (
                  <button className="ideas-linkbtn danger" onClick={() => setConfirmClear(true)}>
                    {tr('清空')}
                  </button>
                )}
                <div className="search-inline ideas-search">
                  <Search size={14} strokeWidth={1.75} />
                  <input
                    value={q}
                    placeholder={tr('搜索灵感')}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setQ('');
                    }}
                  />
                  {q && (
                    <button
                      className="icon-btn"
                      style={{ width: 18, height: 18 }}
                      onClick={() => setQ('')}
                      title={tr('清除')}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="idea-composer">
            <textarea
              ref={composerRef}
              value={draft}
              placeholder={tr('刚想到什么？写一句就记下…')}
              maxLength={IDEA_MAX}
              onChange={(e) => setDraft(e.target.value)}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void commitDraft();
                } else if (e.key === 'Escape') {
                  setDraft('');
                  e.currentTarget.blur();
                }
              }}
            />
            <div className="idea-composer-foot">
              <span className="idea-composer-hint">
                {tr('回车记下 · Shift + 回车换行')}
                {draft.length > IDEA_MAX * 0.4 && (
                  <em className={cn(draft.length >= IDEA_MAX && 'limit')}>
                    {draft.length} / {IDEA_MAX}
                  </em>
                )}
              </span>
              <button className="idea-send" disabled={!draft.trim() || saving} onClick={() => void commitDraft()}>
                <ArrowUp size={13} strokeWidth={2} />
                {tr('记下')}
              </button>
            </div>
          </div>

          <div className="ideas-scroll" ref={scrollRef}>
            {loading || !loaded ? (
              <div className="ideas-skeleton" aria-hidden>
                {Array.from({ length: 3 }).map((_, i) => (
                  <div className="ideas-skeleton-row" key={i} style={{ opacity: 1 - i * 0.18 }}>
                    <span />
                    <i />
                  </div>
                ))}
              </div>
            ) : showEmptyAll ? (
              <div className="list-empty ideas-empty">
                <Lightbulb size={40} strokeWidth={1.5} />
                <div className="e1">{tr('还没有灵感')}</div>
                <div className="e2">{tr('把刚才冒出来的念头写下来，不用管格式；攒几条再一起整理成笔记或待办')}</div>
                <button onClick={() => composerRef.current?.focus()}>{tr('记下第一条')}</button>
              </div>
            ) : searching && filtered.length === 0 ? (
              <div className="list-empty ideas-empty">
                <SearchX size={40} strokeWidth={1.75} />
                <div className="e1">{tr('没有匹配的灵感')}</div>
                <div className="e2">{tr('试试更短的关键词，或清空搜索')}</div>
                <button onClick={() => setQ('')}>{tr('清空搜索')}</button>
              </div>
            ) : showEmptyOpen ? (
              <div className="list-empty ideas-empty">
                <Sparkles size={40} strokeWidth={1.5} />
                <div className="e1">{tr('都整理好了')}</div>
                <div className="e2">{tr('新的想法随时记，回头在「已转化」里还能找到它们')}</div>
                <button onClick={() => composerRef.current?.focus()}>{tr('再记一条')}</button>
              </div>
            ) : showEmptyDone ? (
              <div className="list-empty ideas-empty">
                <Archive size={40} strokeWidth={1.5} />
                <div className="e1">{tr('还没有转化过')}</div>
                <div className="e2">{tr('勾选几条灵感，合并成笔记或拆成待办，这里会留下记录')}</div>
              </div>
            ) : (
              groups.map((group) => (
                <div className="idea-group" key={group.label}>
                  <div className="idea-group-head">
                    <span>{tr(group.label)}</span>
                    <em>{group.list.length}</em>
                  </div>
                  {group.list.map(renderCard)}
                </div>
              ))
            )}
          </div>
        </div>

        {selectedIdeas.length > 0 && (
          <div className="idea-bar" role="toolbar" aria-label={tr('批量整理')}>
            <span className="idea-bar-count">
              {tr('已选')} <b>{selectedIdeas.length}</b> {tr('条')}
            </span>
            <button className="idea-bar-x" onClick={() => setSelected(new Set())} title={tr('取消选择')}>
              <X size={14} />
            </button>
            <span className="idea-bar-gap" />
            <button className="idea-bar-btn danger" onClick={deleteSelected}>
              <Trash2 size={14} />
              {tr('删除')}
            </button>
            <button className="idea-bar-btn" onClick={() => convertSelected('task')}>
              <ListTodo size={14} />
              {tr('转为待办')}
            </button>
            <button className="idea-bar-btn primary" onClick={() => convertSelected('note')}>
              <FileText size={14} />
              {tr('转为笔记')}
            </button>
          </div>
        )}
      </div>

      <aside className="ideas-desk">
        <div className="desk-head">
          <span className="desk-title">{tr('整理台')}</span>
          {selectedIdeas.length > 0 && <span className="desk-count">{tr('已选 {n}', { n: selectedIdeas.length })}</span>}
        </div>

        {selectedIdeas.length === 0 ? (
          <div className="desk-empty">
            <div className="desk-mark">
              <Sparkles size={17} strokeWidth={1.75} />
            </div>
            <div className="desk-h1">{tr('选中几条，一起整理')}</div>
            <p className="desk-p">
              {tr('勾选左侧的灵感，可以合并成一篇笔记，也可以一条条变成待办。整理完原文仍留在「已转化」。')}
            </p>
            <div className="desk-stats">
              <div>
                <b>{weekCount}</b>
                <span>{tr('本周记下')}</span>
              </div>
              <div>
                <b>{openIdeas.length}</b>
                <span>{tr('待整理')}</span>
              </div>
              <div>
                <b>{doneIdeas.length}</b>
                <span>{tr('已转化')}</span>
              </div>
            </div>
            <ul className="desk-tips">
              <li>{tr('回车记下，Shift + 回车换行')}</li>
              <li>{tr('点击文字就能改，不用打开任何面板')}</li>
              <li>{tr('转化后还能打开原来的笔记或待办')}</li>
            </ul>
          </div>
        ) : (
          <>
            <div className="desk-block">
              <div className="desk-block-head">
                <FileText size={14} strokeWidth={1.75} />
                {tr('将生成一篇笔记')}
              </div>
              <div className="desk-note">
                <div className="desk-note-title">{notePreviewTitle}</div>
                <div className="desk-note-body">{notePreviewBody}</div>
              </div>
              <div className="desk-hint">
                {selectedIdeas.length === 1
                  ? tr('一条灵感 → 一篇笔记，放在 inbox')
                  : tr('{n} 条 → 合并成一篇，按时间排成清单', { n: selectedIdeas.length })}
              </div>
            </div>

            <div className="desk-block">
              <div className="desk-block-head">
                <ListTodo size={14} strokeWidth={1.75} />
                {tr('将生成 {n} 条待办', { n: taskPreview.length })}
              </div>
              <ul className="desk-tasks">
                {taskPreview.slice(0, 5).map((title, i) => (
                  <li key={i}>{title}</li>
                ))}
                {taskPreview.length > 5 && <li className="more">{tr('还有 {n} 条', { n: taskPreview.length - 5 })}</li>}
              </ul>
              <div className="desk-hint">{tr('一条灵感 → 一条待办，先落在「待整理」')}</div>
            </div>

            <p className="desk-foot">{tr('用下方按钮选择整理方式；原文不会消失。')}</p>
          </>
        )}
      </aside>

      {confirmClear && (
        <ConfirmDialog
          title={tr('清空已转化记录？')}
          desc={tr('只删除灵感里的记录，整理出来的笔记和待办都还在。')}
          confirmLabel={tr('清空')}
          danger
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            void removeIdeas(doneIdeas.map((i) => i.id));
          }}
        />
      )}
    </section>
  );
}
