import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CalendarDays,
  CircleCheck,
  FileText,
  Maximize2,
  Package,
  RefreshCw,
  Search,
  SearchX,
  Settings2,
  SquarePen,
  SunMoon,
  Trash2,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import { useApp } from '../store/app';
import { excerptAround, highlight, parseQuery, searchNotes } from '../lib/search';
import { sortNotes } from '../lib/view';
import { cn, friendlyTime } from '../lib/utils';
import { exportAllZip } from '../lib/export';
import { importMarkdownFiles } from '../lib/importer';
import { desktop } from '../lib/desktop';
import { usePrivacy } from '../store/privacy';
import { noteNeedsPassword } from '../lib/privacy';
import type { Note } from '../lib/markdown';
import { useT } from '../lib/i18n';

interface PaletteItem {
  key: string;
  group: string;
  title: string;
  /** 命令下方的一句话说明 */
  sub?: string;
  /** 命令右侧的快捷键 / 提示 */
  hint?: string;
  icon: ReactNode;
  run: () => void;
  note?: Note;
  snippet?: string;
}

function Hits({ text, term }: { text: string; term: string }) {
  if (!term) return <>{text}</>;
  return (
    <>
      {highlight(text, term).map((part, i) =>
        part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
      )}
    </>
  );
}

export function Palette() {
  const t = useT();
  const open = useApp((s) => s.paletteOpen);
  const mode = useApp((s) => s.paletteMode);
  const setPalette = useApp((s) => s.setPalette);
  const notes = useApp((s) => s.notes);
  const current = useApp((s) => s.current);
  const view = useApp((s) => s.view);
  const select = useApp((s) => s.select);
  const setView = useApp((s) => s.setView);
  const setSearchHit = useApp((s) => s.setSearchHit);
  const create = useApp((s) => s.create);
  const openDaily = useApp((s) => s.openDaily);
  const openTrash = useApp((s) => s.openTrash);
  const setSettings = useApp((s) => s.setSettings);
  const cycleTheme = useApp((s) => s.cycleTheme);
  const toggleFocus = useApp((s) => s.toggleFocus);
  const syncNow = useApp((s) => s.syncNow);
  const cfg = useApp((s) => s.cfg);
  const refresh = useApp((s) => s.refresh);
  const toast = useApp((s) => s.toast);
  const privacy = usePrivacy();
  const requestOpenNote = usePrivacy((s) => s.requestOpenNote);

  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setIdx(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open, mode]);

  const commands = useMemo<PaletteItem[]>(
    () => [
      {
        key: 'cmd:new',
        group: '命令',
        title: '新建笔记',
        icon: <SquarePen size={16} />,
        hint: 'Ctrl N',
        run: () => void create(),
      },
      {
        key: 'cmd:daily',
        group: '命令',
        title: '打开今日日记',
        icon: <CalendarDays size={16} />,
        hint: 'Ctrl D',
        run: () => void openDaily(),
      },
      ...(desktop()
        ? [
            {
              key: 'cmd:capture',
              group: '命令',
              title: '快速捕获',
              icon: <Zap size={16} />,
              hint: 'Alt Space',
              run: () => void desktop()?.openCapture(),
            },
          ]
        : []),
      {
        key: 'cmd:todo',
        group: '命令',
        title: '新建待办',
        sub: '打开待办页',
        icon: <CircleCheck size={16} />,
        run: () => {
          setView({ type: 'smart', value: 'todo' });
          window.setTimeout(() => {
            document.querySelector<HTMLInputElement>('[data-quick-add]')?.focus();
          }, 90);
        },
      },
      {
        key: 'cmd:trash',
        group: '命令',
        title: '打开回收站',
        icon: <Trash2 size={16} />,
        run: openTrash,
      },
      {
        key: 'cmd:settings',
        group: '命令',
        title: '设置',
        icon: <Settings2 size={16} />,
        hint: 'Ctrl ,',
        run: () => setSettings(true),
      },
      {
        key: 'cmd:theme',
        group: '命令',
        title: '切换主题（浅色 / 暖白 / 深色 / 跟随系统）',
        icon: <SunMoon size={16} />,
        run: cycleTheme,
      },
      {
        key: 'cmd:focus',
        group: '命令',
        title: '进入 / 退出专注模式',
        icon: <Maximize2 size={16} />,
        hint: 'Ctrl Shift F',
        run: toggleFocus,
      },
      ...(cfg
        ? [
            {
              key: 'cmd:sync',
              group: '命令',
              title: '立即同步',
              icon: <RefreshCw size={16} />,
              run: () => void syncNow(true),
            },
          ]
        : []),
      {
        key: 'cmd:export-all',
        group: '命令',
        title: '导出全部笔记（ZIP）',
        icon: <Package size={16} />,
        run: () => {
          void exportAllZip(notes).then(() => toast('已导出全部笔记', 'success'));
        },
      },
      {
        key: 'cmd:import',
        group: '命令',
        title: '导入 Markdown 文件',
        icon: <Upload size={16} />,
        run: () => fileRef.current?.click(),
      },
    ],
    [cfg, notes, create, openDaily, openTrash, setSettings, setView, cycleTheme, toggleFocus, syncNow, toast],
  );

  // 加锁的笔记不进搜索结果：否则标题、摘要和正文片段都会绕过密码漏出来
  const visibleNotes = useMemo(
    () => notes.filter((n) => !noteNeedsPassword(n, privacy, privacy.unlocked)),
    [notes, privacy],
  );
  const hiddenLocked = notes.length - visibleNotes.length;

  const qClean = q.trim();
  const term = parseQuery(qClean).text;
  const noteItems = useMemo<PaletteItem[]>(() => {
    const pool = qClean ? searchNotes(visibleNotes, qClean) : sortNotes(visibleNotes);
    return pool.slice(0, 30).map((n) => ({
      key: `note:${n.id}`,
      group: qClean || mode === 'switch' ? '笔记' : '最近编辑',
      title: n.title || '未命名笔记',
      snippet: qClean ? excerptAround(n.content, term) : n.excerpt,
      icon: <FileText size={16} />,
      note: n,
      run: () => {
        // 记住这次搜索词：打开详情后正文里的命中词要亮起来，但不改左侧列表的筛选
        setSearchHit(qClean ? { id: n.id, query: qClean } : null);
        if (noteNeedsPassword(n, usePrivacy.getState(), usePrivacy.getState().unlocked)) {
          requestOpenNote(n.id, n.notebook || '');
          return;
        }
        select(n.id);
        setView({ type: 'notebook', value: n.notebook });
      },
    }));
  }, [visibleNotes, qClean, term, mode, select, setView, setSearchHit, requestOpenNote]);

  const commandOnly = qClean.startsWith('>');
  const commandQuery = commandOnly ? qClean.slice(1).trim().toLowerCase() : qClean.toLowerCase();
  const filteredCommands = commands.filter((c) => {
    if (mode === 'switch') return false;
    if (commandOnly) return !commandQuery || c.title.toLowerCase().includes(commandQuery);
    // 输入正文关键词时，命令只在真的匹配时才出现，不能把搜索结果挤到折叠线以下
    if (!commandQuery) return true;
    return c.title.toLowerCase().includes(commandQuery);
  });
  const items = useMemo(() => {
    if (mode === 'switch') return commandOnly ? [] : noteItems;
    if (commandOnly) return filteredCommands;
    // 内容优先：打开就列最近笔记，命令整组排在后面（输入 > 可以直接只看命令）
    return [...noteItems, ...filteredCommands];
  }, [mode, commandOnly, qClean, filteredCommands, noteItems]);

  useEffect(() => {
    setIdx(0);
  }, [q, mode]);

  useEffect(() => {
    const el = listRef.current?.querySelector('.palette-item.on') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  if (!open) return null;

  const close = () => setPalette(false);
  const run = (item: PaletteItem) => {
    if (item.key === 'cmd:import') {
      item.run();
      return;
    }
    close();
    item.run();
  };

  let lastGroup = '';

  return (
    <div className="overlay palette-wrap" onClick={close}>
      <div
        className="palette"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t('全局搜索')}
      >
        <div className="palette-head">
          <Search size={18} strokeWidth={1.9} className="palette-search-icon" />
          <input
            ref={inputRef}
            value={q}
            placeholder={mode === 'switch' ? t('输入标题，快速切换笔记…') : t('搜索笔记内容、标题或命令…')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                close();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIdx((i) => (items.length ? (i + 1) % items.length : 0));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIdx((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const item = items[idx];
                if (item) run(item);
              }
            }}
          />
          {q ? (
            <button className="palette-clear" title={t('清空')} aria-label={t('清空搜索')} onClick={() => setQ('')}>
              <X size={14} />
            </button>
          ) : null}
        </div>

        <div className="palette-list" ref={listRef}>
          {items.length === 0 && (
            <div className="palette-empty">
              <span className="palette-empty-icon">
                <SearchX size={22} />
              </span>
              <strong>{qClean ? t('没有找到「{q}」', { q: parseQuery(qClean).text || qClean }) : t('还没有笔记')}</strong>
              <span>{t('换个关键词试试，也可以先用下面的语法缩小范围')}</span>
              <span className="palette-syntax">
                <kbd>{t('tag:灵感')}</kbd>
                <kbd>{t('in:日记')}</kbd>
                <kbd>has:image</kbd>
                <kbd>before:2026-11-01</kbd>
              </span>
            </div>
          )}
          {items.map((item, i) => {
            const showGroup = item.group !== lastGroup;
            lastGroup = item.group;
            return (
              <div key={item.key}>
                {showGroup && <div className="palette-group">{t(item.group)}</div>}
                <button
                  className={cn('palette-item', i === idx && 'on')}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => run(item)}
                >
                  <span className={cn('p-icon', item.note ? 'is-note' : 'is-cmd')}>{item.icon}</span>
                  <span className="p-main">
                    <span className="p-title">
                      {item.note && term ? <Hits text={item.title} term={term} /> : t(item.title)}
                    </span>
                    {item.note && item.snippet ? (
                      <span className="p-snippet">
                        <Hits text={item.snippet} term={term} />
                      </span>
                    ) : null}
                    {!item.note && item.sub ? <span className="p-sub">{t(item.sub)}</span> : null}
                  </span>
                  {item.note ? (
                    <span className="p-side">
                      <span className="p-time">{friendlyTime(item.note.updated)}</span>
                      {item.note.notebook ? <span className="p-nb">{item.note.notebook}</span> : null}
                    </span>
                  ) : item.hint ? (
                    <span className="p-kbd">{item.hint}</span>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>

        <div className="palette-foot">
          <span className="p-keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd>
            <span>{t('选择')}</span>
            <kbd>↵</kbd>
            <span>{t('打开')}</span>
            <kbd>esc</kbd>
            <span>{t('关闭')}</span>
          </span>
          <span className="p-count">
            {mode === 'switch' ? t('{n} 篇笔记', { n: visibleNotes.length }) : t('找到 {n} 项', { n: items.length })}
            {hiddenLocked > 0 && <em>{t(' · 已隐藏 {n} 篇加锁笔记', { n: hiddenLocked })}</em>}
          </span>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".md,.markdown,.txt,text/markdown"
        multiple
        hidden
        onChange={async (e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          if (!files.length) return;
          const target = current?.notebook || (view.type === 'notebook' ? view.value : '') || 'inbox';
          const count = await importMarkdownFiles(files, target);
          await refresh();
          close();
          toast(
            count ? t('已导入 {n} 篇笔记到「{target}」', { n: count, target }) : t('没有可导入的 Markdown 文件'),
            count ? 'success' : 'warn',
          );
        }}
      />
    </div>
  );
}
