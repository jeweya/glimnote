import { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  ExternalLink,
  FileText,
  FolderInput,
  Lock,
  PenLine,
  Pin,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useApp } from '../store/app';
import type { Note } from '../lib/markdown';
import {
  visibleNotes,
  viewTitle,
  SMART_LABELS,
  groupByTimeline,
  isCalendarView,
  isTimelineView,
  type View,
} from '../lib/view';
import { friendlyTime, cn, dailyTitleOf, dateKey } from '../lib/utils';
import { excerptAround, highlight, highlightTermsOf } from '../lib/search';
import { emptyTrash } from '../lib/repo';
import { openNoteInNewWindow } from '../lib/windowMode';
import { ConfirmDialog } from './Confirm';
import { Menu, type MenuEntry } from './Menu';
import { CalendarPanel } from './CalendarPanel';
import { PastPanel } from './PastPanel';
import { usePrivacy } from '../store/privacy';
import { folderHasLock, noteNeedsPassword } from '../lib/privacy';
import { useT } from '../lib/i18n';

type AllRange = 'all' | 'today' | 'week' | 'month';

const ALL_RANGES: { key: AllRange; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今日' },
  { key: 'week', label: '近 7 天' },
  { key: 'month', label: '近 1 月' },
];

/** 按「最后修改时间」筛选；今日 / 近 7 天 / 近 1 月都从当天零点往前算，避免半天误差 */
function rangeCutoff(range: AllRange): number {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (range === 'today') return today;
  if (range === 'week') return today - 6 * 86400000;
  if (range === 'month') return today - 29 * 86400000;
  return -Infinity;
}

export function NoteList() {
  const t = useT();
  const notes = useApp((s) => s.notes);
  const trash = useApp((s) => s.trash);
  const view = useApp((s) => s.view);
  const query = useApp((s) => s.query);
  const current = useApp((s) => s.current);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const select = useApp((s) => s.select);
  const setView = useApp((s) => s.setView);
  const setQuery = useApp((s) => s.setQuery);
  const create = useApp((s) => s.create);
  const openDaily = useApp((s) => s.openDaily);
  const togglePin = useApp((s) => s.togglePin);
  const removeNote = useApp((s) => s.removeNote);
  const restore = useApp((s) => s.restore);
  const purge = useApp((s) => s.purge);
  const refresh = useApp((s) => s.refresh);
  const toast = useApp((s) => s.toast);
  const setMoveNote = useApp((s) => s.setMoveNote);
  const draggingNote = useApp((s) => s.draggingNote);
  const setDraggingNote = useApp((s) => s.setDraggingNote);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmPurge, setConfirmPurge] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [day, setDay] = useState(() => dateKey());
  const [allRange, setAllRange] = useState<AllRange>('all');
  const searchTerms = useMemo(() => highlightTermsOf(query), [query]);
  const privacy = usePrivacy();
  const requestOpenNote = usePrivacy((s) => s.requestOpenNote);
  const requestLockNote = usePrivacy((s) => s.requestLockNote);
  const requestRemoveNoteLock = usePrivacy((s) => s.requestRemoveNoteLock);

  const isTrash = view.type === 'trash';
  const calendar = isCalendarView(view as View);
  const timeline = isTimelineView(view as View);
  const isAllView = view.type === 'smart' && view.value === 'all';
  const baseList = useMemo(() => {
    if (isTrash) {
      return [...trash].sort((a, b) => +new Date(b.deletedAt || b.updated) - +new Date(a.deletedAt || a.updated));
    }
    if (calendar) {
      // 日历里列出所选日期的笔记，日记排在最前
      return notes
        .filter((n) => n.title === day)
        .sort(
          (a, b) =>
            Number(b.notebook === '日记') - Number(a.notebook === '日记') ||
            +new Date(b.updated) - +new Date(a.updated),
        );
    }
    return visibleNotes(notes, view as View, query);
  }, [isTrash, trash, notes, view, query, calendar, day]);

  // 「全部笔记」里的时间筛选和搜索是叠加的：先按关键词搜，再按修改时间收窄
  const list = useMemo(() => {
    if (!isAllView || allRange === 'all') return baseList;
    const cutoff = rangeCutoff(allRange);
    return baseList.filter((n) => +new Date(n.updated) >= cutoff);
  }, [baseList, isAllView, allRange]);

  // 离开「全部笔记」后回到「全部」，下次进来不会莫名只剩几篇
  useEffect(() => {
    if (!isAllView) setAllRange('all');
  }, [isAllView]);

  const rangeLabel = t(ALL_RANGES.find((r) => r.key === allRange)?.label || '全部');

  const title = calendar ? t('日历') : viewTitle(view as View, query);
  const sub = isTrash
    ? t('{n} 篇 · 保留 30 天', { n: list.length })
    : calendar
      ? `${dailyTitleOf(day)} · ${list.length ? t('{n} 篇', { n: list.length }) : t('还没有记录')}`
      : query.trim()
        ? `${t('“{q}” · {n} 篇', { q: query.trim(), n: list.length })}${isAllView && allRange !== 'all' ? ` · ${rangeLabel}` : ''}`
        : isAllView
          ? `${t(allRange === 'all' ? SMART_LABELS.all?.sub || '所有笔记本中的内容' : rangeLabel)} · ${t('{n} 篇', { n: list.length })}`
          : view.type === 'smart'
            ? `${t(SMART_LABELS[view.value]?.sub || '')} · ${t('{n} 篇', { n: list.length })}`
            : t('{n} 篇笔记', { n: list.length });

  // 进入日历时自动打开当天的日记，别让右侧还停在上一次看的笔记
  useEffect(() => {
    if (!calendar) return;
    if (current && list.some((n) => n.id === current.id)) return;
    if (list[0]) select(list[0].id);
  }, [calendar, list, current, select]);

  const pickDay = (key: string) => {
    setDay(key);
    const hits = notes.filter((n) => n.title === key);
    const target = hits.find((n) => n.notebook === '日记') || hits[0];
    if (target && target.id !== current?.id) select(target.id);
  };

  const menuNote = menu ? notes.find((n) => n.id === menu.id) : null;
  const menuFolderLock = menuNote ? folderHasLock(menuNote.notebook || '', privacy) : null;
  const menuDirectLock = menuNote ? privacy.noteIds.includes(menuNote.id) : false;
  const menuItems: (MenuEntry | 'sep')[] = menuNote
    ? [
        {
          label: menuNote.pinned ? t('取消置顶') : t('置顶'),
          icon: <Pin size={14} />,
          onClick: () => togglePin(menuNote.id),
        },
        menuDirectLock && !isTrash
          ? {
              label: t('解除隐私锁'),
              icon: <Lock size={14} />,
              onClick: () => requestRemoveNoteLock(menuNote.id),
            }
          : menuFolderLock && !isTrash
            ? {
                label: t('所在笔记本已加锁'),
                icon: <Lock size={14} />,
                disabled: true,
                onClick: () => {},
              }
            : {
                label: t('开启隐私锁'),
                icon: <Lock size={14} />,
                onClick: () => requestLockNote(menuNote.id, menuNote.title),
              },
        {
          label: t('在新窗口打开'),
          icon: <ExternalLink size={14} />,
          onClick: () => openNoteInNewWindow(menuNote.id),
        },
        {
          label: t('移动到…'),
          icon: <FolderInput size={14} />,
          onClick: () => setMoveNote(menuNote.id),
        },
        'sep',
        {
          label: t('移到回收站'),
          icon: <Trash2 size={14} />,
          danger: true,
          onClick: () => void removeNote(menuNote.id),
        },
      ]
    : [];

  const Hits = ({ text }: { text: string }) => {
    const term = searchTerms[0];
    if (!term) return <>{text}</>;
    return (
      <>
        {highlight(text, term).map((part, i) =>
          part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
        )}
      </>
    );
  };

  const renderRow = (note: Note) => {
    const active = current?.id === note.id;
    const locked = noteNeedsPassword(note, privacy, privacy.unlocked);
    const snippet =
      !locked && query.trim() && searchTerms[0] ? excerptAround(note.content, searchTerms[0], 56) : note.excerpt;
    const open = () => {
      if (locked) requestOpenNote(note.id, note.notebook || '');
      else select(note.id);
    };
    return (
      <div
        key={note.id}
        data-note-id={note.id}
        data-notebook={note.notebook || ''}
        className={cn(
          'note-row',
          active && 'active',
          isTrash && 'trash',
          locked && 'locked',
          draggingNote === note.id && 'dragging',
        )}
        onClick={open}
        onDoubleClick={(e) => {
          if (isTrash) return;
          if (locked) {
            open();
            return;
          }
          // 双击行尾的置顶 / 删除按钮不应该顺手开个窗口
          if ((e.target as HTMLElement).closest('.row-actions')) return;
          openNoteInNewWindow(note.id);
        }}
        role="button"
        tabIndex={0}
        draggable={!isTrash}
        onKeyDown={(e) => e.key === 'Enter' && open()}
        onDragStart={(e) => {
          if (isTrash) return;
          e.dataTransfer.setData('text/plain', note.id);
          e.dataTransfer.effectAllowed = 'move';
          setDraggingNote(note.id);
        }}
        onDragEnd={() => setDraggingNote(null)}
        onContextMenu={(e) => {
          if (isTrash) return;
          e.preventDefault();
          // 锁着的笔记不能先选中再弹菜单，否则正文会绕过密码出现在编辑器里
          if (locked) {
            requestOpenNote(note.id, note.notebook || '');
            return;
          }
          select(note.id);
          setMenu({ id: note.id, x: e.clientX, y: e.clientY });
        }}
      >
        <div className="row-top">
          {locked ? (
            <span className="row-lock" title={t('已加隐私锁')}>
              <Lock size={12} strokeWidth={2} />
            </span>
          ) : (
            note.pinned && !isTrash && <span className="pin-dot" title={t('已置顶')} />
          )}
          <span className="row-title">{locked ? t('隐私笔记') : <Hits text={note.title || t('未命名笔记')} />}</span>
          <span className="row-time">{friendlyTime(isTrash ? note.deletedAt || note.updated : note.updated)}</span>
        </div>
        <div className="row-excerpt">
          {locked ? t('已锁定 · 输入密码后查看') : snippet ? <Hits text={snippet} /> : t('空白笔记')}
        </div>
        {!locked && (note.tags.length > 0 || note.notebook) && (
          <div className="row-tags">
            {note.tags.slice(0, 3).map((t) => (
              <span className="tag-chip" key={t}>
                #{t}
              </span>
            ))}
            {!isTrash && note.notebook && note.tags.length === 0 && (
              <span className="tag-chip" style={{ opacity: 0.75 }}>
                {note.notebook}
              </span>
            )}
          </div>
        )}
        <div className="row-actions" onClick={(e) => e.stopPropagation()}>
          {isTrash ? (
            <>
              <button className="icon-btn" title={t('恢复')} onClick={() => void restore(note.id)}>
                <RotateCcw size={14} />
              </button>
              <button className="icon-btn" title={t('永久删除')} onClick={() => setConfirmPurge(note.id)}>
                <Trash2 size={14} />
              </button>
            </>
          ) : (
            <>
              <button className="icon-btn" title={note.pinned ? t('取消置顶') : t('置顶')} onClick={() => togglePin(note.id)}>
                <Pin size={14} style={note.pinned ? { color: 'var(--accent)' } : undefined} />
              </button>
              <button className="icon-btn" title={t('移到回收站')} onClick={() => void removeNote(note.id)}>
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <section className={cn('notelist', !sidebarOpen && 'hidden')}>
      <div className="list-head">
        <div className="list-title-row">
          <div>
            <div className="list-title">{title}</div>
            <div className="list-sub">{sub}</div>
          </div>
          {isTrash ? (
            list.length > 0 && (
              <button
                className="btn btn-ghost"
                style={{ height: 28, padding: '0 8px', fontSize: 12 }}
                onClick={() => setConfirmEmpty(true)}
              >
                {t('清空')}
              </button>
            )
          ) : calendar ? (
            <button className="list-new" onClick={() => void openDaily(day)} title={t('打开这一天的日记')}>
              <PenLine size={14} strokeWidth={1.75} />
              {t('写日记')}
            </button>
          ) : (
            <button className="list-new" onClick={() => void create()} title={t('新建笔记  Ctrl+N')}>
              <Plus size={14} strokeWidth={1.75} />
              {t('新建')}
            </button>
          )}
        </div>
        {!isTrash && !calendar && (
          <div className="search-inline">
            <Search size={14} strokeWidth={1.75} />
            <input
              value={query}
              placeholder={t('搜索标题、正文或标签')}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('');
              }}
            />
            {query ? (
              <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => setQuery('')} title={t('清除')}>
                <X size={14} />
              </button>
            ) : (
              <kbd>Ctrl K</kbd>
            )}
          </div>
        )}
      </div>

      {isAllView && (
        <div className="list-filter-row" role="tablist" aria-label={t('按修改时间筛选')}>
          {ALL_RANGES.map((range) => (
            <button
              key={range.key}
              type="button"
              role="tab"
              aria-selected={allRange === range.key}
              className={cn('list-filter-chip', allRange === range.key && 'on')}
              onClick={() => setAllRange(range.key)}
            >
              {t(range.label)}
            </button>
          ))}
        </div>
      )}

      {!isTrash && !calendar && !timeline && !query.trim() && !(isAllView && allRange !== 'all') && (
        <PastPanel
          notes={notes}
          onOpen={(note) => {
            setView({ type: 'notebook', value: note.notebook || 'inbox' });
            select(note.id);
          }}
        />
      )}

      {calendar && (
        <CalendarPanel notes={notes} selected={day} onSelect={pickDay} onWrite={(key) => void openDaily(key)} />
      )}

      <div className="list-scroll">
        {list.length === 0 ? (
          <div className="list-empty">
            {isTrash ? (
              <Trash2 size={40} strokeWidth={1.75} />
            ) : calendar ? (
              <CalendarDays size={40} strokeWidth={1.75} />
            ) : query ? (
              <Search size={40} strokeWidth={1.75} />
            ) : (
              <FileText size={40} strokeWidth={1.75} />
            )}
            <div className="e1">
              {t(isTrash ? '回收站是空的' : calendar ? '这一天还没有记录' : query ? '没有找到相关笔记' : '这里还没有笔记')}
            </div>
            <div className="e2">
              {t(
                isTrash
                  ? '删除的笔记会在这里保留 30 天，随时可以恢复。'
                  : calendar
                    ? '写几句当天的事；有记录的日子会在日历上亮一个点。'
                    : query
                      ? '换个关键词试试，或者用 Ctrl+K 打开全局搜索。'
                      : '写下第一个想法，它会立刻保存在本地。',
              )}
            </div>
            {!isTrash && (
              <button
                onClick={() => {
                  if (calendar) void openDaily(day);
                  else if (isAllView && allRange !== 'all') setAllRange('all');
                  else void create();
                }}
              >
                {t(
                  calendar
                    ? '写这一天的日记'
                    : query
                      ? '新建一篇笔记'
                      : isAllView && allRange !== 'all'
                        ? '查看全部'
                        : '新建笔记',
                )}
              </button>
            )}
          </div>
        ) : timeline ? (
          groupByTimeline(list).map((group) => (
            <div className="tl-group" key={group.label}>
              <div className="tl-head">
                <span>{group.label}</span>
                <em>{group.notes.length}</em>
              </div>
              {group.notes.map(renderRow)}
            </div>
          ))
        ) : (
          list.map(renderRow)
        )}
      </div>

      <div className="list-foot">
        <span>
          {t(
            isTrash
              ? '删除后可在回收站找回'
              : calendar
                ? '按月翻看日记'
                : query
                  ? '按相关度排序'
                  : timeline
                    ? '按修改时间分组'
                    : '按更新时间',
          )}
        </span>
        <span>{t('{n} 篇', { n: list.length })}</span>
      </div>

      {menu && menuItems.length > 0 && <Menu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      {confirmEmpty && (
        <ConfirmDialog
          title={t('清空回收站？')}
          desc={t('此操作会从所有设备上永久删除这些笔记，无法恢复。')}
          confirmLabel={t('永久删除')}
          danger
          onCancel={() => setConfirmEmpty(false)}
          onConfirm={async () => {
            setConfirmEmpty(false);
            await emptyTrash();
            await refresh();
            toast(t('回收站已清空'), 'info');
          }}
        />
      )}

      {confirmPurge && (
        <ConfirmDialog
          title={t('永久删除这篇笔记？')}
          desc={t('删除后无法恢复，也不会再出现在其他设备上。')}
          confirmLabel={t('永久删除')}
          danger
          onCancel={() => setConfirmPurge(null)}
          onConfirm={() => {
            void purge(confirmPurge);
            setConfirmPurge(null);
          }}
        />
      )}
    </section>
  );
}
