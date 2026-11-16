import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import {
  CalendarDays,
  ChevronRight,
  CircleCheck,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Plus,
  House,
  LibraryBig,
  Lightbulb,
  Lock,
  LockOpen,
  Pin,
  Settings2,
  Tag,
  Trash2,
} from 'lucide-react';
import { useApp } from '../store/app';
import { useLang, useT } from '../lib/i18n';
import { buildNotebookTree, type NotebookNode } from '../lib/repo';
import { cn } from '../lib/utils';
import { TASK_CATEGORY_ALL, type TaskCategoryFilter } from '../lib/taskCategories';
import { Menu, type MenuEntry } from './Menu';
import { ConfirmDialog } from './Confirm';
import { usePrivacy } from '../store/privacy';
import { folderHasLock, folderKey, folderLockAt } from '../lib/privacy';
import { canDropFolder, nameOf, parentOf, sortNotebookTree, type NotebookOrder } from '../lib/notebookOrder';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 拖动文件夹时用的自定义 MIME，和笔记拖动的 text/plain 区分开 */
const NOTEBOOK_MIME = 'application/x-glimnote-notebook';
type DropPos = 'before' | 'inside' | 'after';

function mergeCustom(nodes: NotebookNode[], names: string[], order: NotebookOrder): NotebookNode[] {
  // 深拷贝：下面会往任意层级里补空笔记本，不能改到 useMemo 缓存的原始树
  const clone = (list: NotebookNode[]): NotebookNode[] => list.map((n) => ({ ...n, children: clone(n.children) }));
  const out = clone(nodes);
  for (const name of names) {
    const segs = name.split('/').filter(Boolean);
    let list = out;
    let prefix = '';
    for (const seg of segs) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      let node = list.find((n) => n.name === seg);
      if (!node) {
        node = { path: prefix, name: seg, count: 0, children: [] };
        list.push(node);
      }
      list = node.children;
    }
  }
  sortNotebookTree(out, order);
  return out;
}

interface TreeProps {
  node: NotebookNode;
  depth: number;
  activePath: string;
  closed: Set<string>;
  renaming: string | null;
  renameValue: string;
  onOpen: (path: string) => void;
  onToggle: (path: string) => void;
  onMenu: (path: string, x: number, y: number) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  dragging: boolean;
  onDropNote: (noteId: string, path: string) => void;
  draggingFolder: string | null;
  dropHint: { path: string; pos: DropPos } | null;
  onFolderDragStart: (path: string) => void;
  onFolderDragEnd: () => void;
  onFolderHover: (path: string | null, pos?: DropPos) => void;
  onFolderDrop: (path: string, pos: DropPos) => void;
}

/** 鼠标在行的上 1/4 / 中间 / 下 1/4：排序到前面、放进文件夹、排序到后面 */
function dropPosOf(e: DragEvent<HTMLElement>): DropPos {
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = (e.clientY - rect.top) / Math.max(rect.height, 1);
  if (ratio < 0.25) return 'before';
  if (ratio > 0.75) return 'after';
  return 'inside';
}

function TreeItem(props: TreeProps) {
  const { node, depth, activePath, closed, renaming, renameValue, onOpen, onToggle, onMenu } = props;
  const open = !closed.has(node.path);
  const active = activePath === node.path;
  const hasKids = node.children.length > 0;
  const editing = renaming === node.path;
  const [over, setOver] = useState(false);
  const privacy = usePrivacy();
  const t = useT();
  const lockRoot = folderHasLock(node.path, privacy);
  const directLock = folderLockAt(node.path, privacy);
  const sessionOpen = lockRoot ? privacy.unlocked.includes(folderKey(lockRoot)) : false;
  const folderDragging = props.draggingFolder;
  const hint = props.dropHint?.path === node.path ? props.dropHint.pos : null;
  const targetParentFor = (pos: DropPos) => (pos === 'inside' ? node.path : parentOf(node.path));
  return (
    <>
      <div
        className={cn(
          'side-item tree-item',
          active && 'active',
          editing && 'editing',
          over && props.dragging && 'drop-over',
          folderDragging && hint === 'inside' && 'drop-into',
          folderDragging && hint === 'before' && 'drop-before',
          folderDragging && hint === 'after' && 'drop-after',
        )}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => !editing && onOpen(node.path)}
        role="button"
        tabIndex={0}
        draggable={!editing}
        onKeyDown={(e) => e.key === 'Enter' && !editing && onOpen(node.path)}
        onDragStart={(e) => {
          if (editing) return;
          e.dataTransfer.setData(NOTEBOOK_MIME, node.path);
          e.dataTransfer.effectAllowed = 'move';
          props.onFolderDragStart(node.path);
        }}
        onDragEnd={props.onFolderDragEnd}
        onDragOver={(e) => {
          if (editing) return;
          if (e.dataTransfer.types.includes(NOTEBOOK_MIME)) {
            if (!folderDragging) return;
            const pos = dropPosOf(e);
            // 拖到自己身上不提示；也不能放进自己的子文件夹
            if (pos !== 'inside' && node.path === folderDragging) return;
            if (!canDropFolder(folderDragging, targetParentFor(pos))) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            if (hint !== pos) props.onFolderHover(node.path, pos);
            return;
          }
          if (!props.dragging) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (!over) setOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setOver(false);
          if (hint) props.onFolderHover(null);
        }}
        onDrop={(e) => {
          if (editing) return;
          if (e.dataTransfer.types.includes(NOTEBOOK_MIME)) {
            if (!folderDragging) return;
            const pos = dropPosOf(e);
            if (pos !== 'inside' && node.path === folderDragging) return;
            if (!canDropFolder(folderDragging, targetParentFor(pos))) return;
            e.preventDefault();
            e.stopPropagation();
            props.onFolderDrop(node.path, pos);
            return;
          }
          if (!props.dragging) return;
          e.preventDefault();
          setOver(false);
          const noteId = e.dataTransfer.getData('text/plain');
          if (noteId) props.onDropNote(noteId, node.path);
        }}
      >
        {Array.from({ length: depth }).map((_, i) => (
          <span key={i} className="tree-guide" style={{ left: 16 + i * 16 }} />
        ))}
        {hasKids ? (
          <button
            className="chev"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.path);
            }}
            title={open ? t('折叠') : t('展开')}
          >
            <ChevronRight
              size={14}
              className={cn(open && 'open')}
              style={{ transform: open ? 'rotate(90deg)' : undefined }}
            />
          </button>
        ) : (
          <span className="chev" />
        )}
        {hasKids && open ? <FolderOpen size={16} strokeWidth={1.75} /> : <Folder size={16} strokeWidth={1.75} />}
        {editing ? (
          <input
            className="nb-inline-input"
            autoFocus
            value={renameValue}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => props.onRenameChange(e.target.value)}
            onBlur={props.onRenameCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                props.onRenameCommit();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                props.onRenameCancel();
              }
            }}
          />
        ) : (
          <>
            <span className="label">{node.name}</span>
            {lockRoot && (
              <span
                className={cn('nb-lock', !directLock && 'inherited', sessionOpen && 'unlocked')}
                title={sessionOpen ? t('隐私锁（本次已解锁）') : directLock ? t('已加隐私锁') : t('上级笔记本已加锁')}
              >
                {sessionOpen ? <LockOpen size={12} /> : <Lock size={12} />}
              </span>
            )}
            {node.count > 0 && <span className="count">{node.count}</span>}
            <button
              className="tree-more"
              title={t('笔记本操作')}
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                onMenu(node.path, r.right - 4, r.bottom + 4);
              }}
            >
              <MoreHorizontal size={14} />
            </button>
          </>
        )}
      </div>
      {open && node.children.map((child) => <TreeItem {...props} key={child.path} node={child} depth={depth + 1} />)}
    </>
  );
}

export function Sidebar() {
  const t = useT();
  const lang = useLang();
  const notes = useApp((s) => s.notes);
  const trash = useApp((s) => s.trash);
  const tasks = useApp((s) => s.tasks);
  const tasksLoaded = useApp((s) => s.tasksLoaded);
  const currentTaskId = useApp((s) => s.currentTaskId);
  const selectTask = useApp((s) => s.selectTask);
  const ideas = useApp((s) => s.ideas);
  const ideasLoaded = useApp((s) => s.ideasLoaded);
  const notebooks = useApp((s) => s.notebooks);
  const view = useApp((s) => s.view);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const setView = useApp((s) => s.setView);
  const setQuery = useApp((s) => s.setQuery);
  const openDaily = useApp((s) => s.openDaily);
  const openTrash = useApp((s) => s.openTrash);
  const setSettings = useApp((s) => s.setSettings);
  const addNotebook = useApp((s) => s.addNotebook);
  const renameNotebook = useApp((s) => s.renameNotebook);
  const moveNotebook = useApp((s) => s.moveNotebook);
  const notebookOrder = useApp((s) => s.notebookOrder);
  const deleteNotebook = useApp((s) => s.deleteNotebook);
  const privacy = usePrivacy();
  const requestOpenFolder = usePrivacy((s) => s.requestOpenFolder);
  const requestLockFolder = usePrivacy((s) => s.requestLockFolder);
  const requestRemoveFolderLock = usePrivacy((s) => s.requestRemoveFolderLock);
  const moveTo = useApp((s) => s.moveTo);
  const draggingNote = useApp((s) => s.draggingNote);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addParent, setAddParent] = useState('');
  const [nbName, setNbName] = useState('');
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [draggingFolder, setDraggingFolder] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ path: string; pos: DropPos } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const tree = useMemo(
    () => mergeCustom(buildNotebookTree(notes), notebooks, notebookOrder),
    [notes, notebooks, notebookOrder],
  );
  const [showAllTags, setShowAllTags] = useState(false);
  const tags = useMemo(() => {
    const map = new Map<string, number>();
    notes.forEach((n) => n.tags.forEach((t) => map.set(t, (map.get(t) || 0) + 1)));
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  }, [notes]);

  const categories = useApp((s) => s.categories);
  const taskCategoryFilter = useApp((s) => s.taskCategoryFilter);
  const setTaskCategoryFilter = useApp((s) => s.setTaskCategoryFilter);
  const openTaskCategoryModal = useApp((s) => s.openTaskCategoryModal);

  // 分类子项显示未完成条数；选中的分类高亮。默认展开，收起来的状态记在本机
  const [catsOpen, setCatsOpen] = useState(() => localStorage.getItem('glimnote.todo.catsOpen') !== '0');
  const toggleCats = () => {
    setCatsOpen((open) => {
      const next = !open;
      localStorage.setItem('glimnote.todo.catsOpen', next ? '1' : '0');
      return next;
    });
  };

  const categoryCounts = useMemo(() => {
    const map = new Map<string, number>();
    let none = 0;
    for (const task of tasks) {
      if (task.status === 'done' || task.deletedAt) continue;
      if (task.category) map.set(task.category, (map.get(task.category) || 0) + 1);
      else none += 1;
    }
    return { map, none };
  }, [tasks]);

  const counts = useMemo(
    () => ({
      all: notes.length,
      pinned: notes.filter((n) => n.pinned).length,
      // 任务库 / 灵感库加载完成前显示「–」，0 是一个错误的断言
      todo: tasksLoaded ? tasks.filter((t) => t.status !== 'done' && !t.deletedAt).length : '–',
      ideas: ideasLoaded ? ideas.filter((i) => !i.convertedType).length : '–',
    }),
    [notes, tasks, tasksLoaded, ideas, ideasLoaded],
  );

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  // 打开的是深层笔记本（比如从搜索 / 命令面板进来）时，把它上面的父级展开，
  // 否则左栏看不出这篇笔记到底在哪一层
  useEffect(() => {
    if (view.type !== 'notebook') return;
    const segs = view.value.split('/').filter(Boolean);
    if (segs.length < 2) return;
    setClosed((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (let i = 1; i < segs.length; i++) {
        if (next.delete(segs.slice(0, i).join('/'))) changed = true;
      }
      return changed ? next : prev;
    });
  }, [view]);

  const today = new Date();
  const monthLabel = lang === 'en' ? today.toLocaleString('en-US', { month: 'short' }) : `${today.getMonth() + 1}月`;
  const smartItems = [
    { key: 'home', label: '首页', icon: House, count: undefined },
    { key: 'pinned', label: '置顶', icon: Pin, count: counts.pinned as number | undefined },
    { key: 'ideas', label: '灵感', icon: Lightbulb, count: counts.ideas as number | string | undefined },
    { key: 'todo', label: '待办', icon: CircleCheck, count: counts.todo as number | string | undefined },
    { key: 'calendar', label: '日历', icon: CalendarDays, count: undefined },
    // 「全部笔记」放在视图区最后，今日 / 近 7 天 / 近 1 月改成列表内的筛选
    { key: 'all', label: '全部笔记', icon: LibraryBig, count: counts.all as number | undefined },
  ];

  const pickNotebook = (path: string) => {
    const lockRoot = folderHasLock(path, privacy);
    if (lockRoot && !privacy.unlocked.includes(folderKey(lockRoot))) {
      requestOpenFolder(path);
      return;
    }
    setView({ type: 'notebook', value: path });
    setQuery('');
  };

  const startAdd = (parent = '') => {
    // 在折叠起来的父级下新建时，先把它展开，否则输入框会出现在看不见的地方
    if (parent) {
      setClosed((prev) => {
        if (!prev.has(parent)) return prev;
        const next = new Set(prev);
        next.delete(parent);
        return next;
      });
    }
    setAddParent(parent);
    setNbName('');
    setAdding(true);
  };

  const commitNotebook = () => {
    const name = nbName.trim();
    if (name) addNotebook(addParent ? `${addParent}/${name}` : name);
    setNbName('');
    setAddParent('');
    setAdding(false);
  };

  const nameOfPath = (path: string) => path.split('/').pop() || path;

  const countIn = (path: string) =>
    notes.filter((n) => n.notebook === path || n.notebook.startsWith(`${path}/`)).length;

  /** 某个父级下的可见子项；拖放时用它算出目标位置和兄弟顺序 */
  const siblingsOf = (parent: string): NotebookNode[] => {
    if (!parent) return tree;
    const find = (nodes: NotebookNode[]): NotebookNode[] | null => {
      for (const n of nodes) {
        if (n.path === parent) return n.children;
        const hit = find(n.children);
        if (hit) return hit;
      }
      return null;
    };
    return find(tree) || [];
  };

  const dropFolder = (targetPath: string, pos: DropPos) => {
    const dragged = draggingFolder;
    setDropHint(null);
    setDraggingFolder(null);
    if (!dragged) return;
    if (pos !== 'inside' && targetPath === dragged) return;
    const targetParent = pos === 'inside' ? targetPath : parentOf(targetPath);
    if (!canDropFolder(dragged, targetParent)) return;
    const siblings = siblingsOf(targetParent).filter((n) => n.path !== dragged);
    const names = siblings.map((n) => n.name);
    let index = names.length;
    if (pos !== 'inside') {
      const at = names.indexOf(nameOf(targetPath));
      if (at >= 0) index = pos === 'before' ? at : at + 1;
    }
    void moveNotebook(dragged, targetParent, names, index);
  };

  const menuLockRoot = menu ? folderHasLock(menu.path, privacy) : null;
  const menuDirectLock = menu ? folderLockAt(menu.path, privacy) : false;
  const menuOpenNow = menuDirectLock && menu ? privacy.unlocked.includes(folderKey(menu.path)) : false;
  const privacyItems: (MenuEntry | 'sep')[] = !menu
    ? []
    : menuDirectLock
      ? [
          ...(menuOpenNow
            ? [
                {
                  label: t('立即重新锁定'),
                  icon: <Lock size={14} />,
                  onClick: () => usePrivacy.getState().relockKey(folderKey(menu.path)),
                } as MenuEntry,
              ]
            : []),
          {
            label: t('解除隐私锁'),
            icon: <LockOpen size={14} />,
            onClick: () => requestRemoveFolderLock(menu.path),
          },
        ]
      : menuLockRoot
        ? [
            {
              label: t('上级笔记本已加锁'),
              icon: <Lock size={14} />,
              disabled: true,
              onClick: () => {},
            } as MenuEntry,
          ]
        : [
            {
              label: t('开启隐私锁'),
              icon: <Lock size={14} />,
              onClick: () => requestLockFolder(menu.path),
            } as MenuEntry,
          ];

  const menuItems: (MenuEntry | 'sep')[] = menu
    ? [
        { label: t('新建子笔记本'), icon: <FolderPlus size={14} />, onClick: () => startAdd(menu.path) },
        {
          label: t('重命名'),
          icon: <Pencil size={14} />,
          onClick: () => setRenaming({ path: menu.path, value: nameOfPath(menu.path) }),
        },
        'sep',
        ...privacyItems,
        'sep',
        {
          label: t('删除笔记本'),
          icon: <Trash2 size={14} />,
          danger: true,
          onClick: () => setConfirmDelete(menu.path),
        },
      ]
    : [];

  return (
    <aside className={cn('sidebar', !sidebarOpen && 'hidden')}>
      <button className="today-card" onClick={() => void openDaily()} title={t('打开今日日记  Ctrl+D')}>
        <span className="cal">
          <span className="m">{monthLabel}</span>
          <span className="d">{today.getDate()}</span>
        </span>
        <span>
          <span className="t1">{t('今日日记')}</span>
          <span className="t2">
            {t(WEEKDAYS[today.getDay()])} · {t('写几句今天')}
          </span>
        </span>
      </button>

      <div className="sidebar-scroll">
        <div className="side-section">
          <div className="side-title">{t('快捷访问')}</div>
          {smartItems.map((item) => {
            const todoActive = view.type === 'smart' && view.value === 'todo';
            if (item.key !== 'todo') {
              return (
                <div
                  key={item.key}
                  className={cn('side-item', view.type === 'smart' && view.value === item.key && 'active')}
                  onClick={() => {
                    setView({ type: 'smart', value: item.key });
                    setQuery('');
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setView({ type: 'smart', value: item.key })}
                >
                  <item.icon size={16} strokeWidth={1.75} />
                  <span className="label">{t(item.label)}</span>
                  {item.count !== undefined && <span className="count">{item.count}</span>}
                </div>
              );
            }
            const pickCategory = (filter: TaskCategoryFilter) => {
              setView({ type: 'smart', value: 'todo' });
              setQuery('');
              setTaskCategoryFilter(filter);
              // 切分类后右侧详情要跟着换，否则会停在别的分类的任务上
              const list = tasks.filter(
                (t) =>
                  !t.deletedAt &&
                  (filter.kind === 'all' || (filter.kind === 'none' ? !t.category : t.category === filter.name)),
              );
              if (currentTaskId && list.some((t) => t.id === currentTaskId)) return;
              const first = list.find((t) => t.status !== 'done') || list[0];
              selectTask(first ? first.id : null);
            };
            return (
              <Fragment key="todo">
                <div
                  className={cn('side-item side-todo', todoActive && taskCategoryFilter.kind === 'all' && 'active')}
                  onClick={() => pickCategory(TASK_CATEGORY_ALL)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && pickCategory(TASK_CATEGORY_ALL)}
                >
                  <button
                    className={cn('side-chev', catsOpen && 'open')}
                    title={catsOpen ? t('收起分类') : t('展开分类')}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCats();
                    }}
                  >
                    <ChevronRight size={14} />
                  </button>
                  <item.icon size={16} strokeWidth={1.75} />
                  <span className="label">{t(item.label)}</span>
                  <button
                    className="side-hover-btn"
                    title={t('管理分类')}
                    onClick={(e) => {
                      e.stopPropagation();
                      setView({ type: 'smart', value: 'todo' });
                      setQuery('');
                      openTaskCategoryModal();
                    }}
                  >
                    <FolderPlus size={14} />
                  </button>
                  {item.count !== undefined && <span className="count">{item.count}</span>}
                </div>
                {catsOpen && (
                  <div className="side-cats">
                    {categories.map((cat) => {
                      const active =
                        todoActive && taskCategoryFilter.kind === 'cat' && taskCategoryFilter.name === cat.name;
                      const count = categoryCounts.map.get(cat.name) || 0;
                      return (
                        <div
                          key={cat.name}
                          className={cn('side-sub-item', active && 'active')}
                          style={{ '--cat': cat.color } as CSSProperties}
                          onClick={() => pickCategory({ kind: 'cat', name: cat.name })}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => e.key === 'Enter' && pickCategory({ kind: 'cat', name: cat.name })}
                          title={t('只看「{name}」', { name: cat.name })}
                        >
                          <span className="side-cat-dot" />
                          <span className="label">{cat.name}</span>
                          {count > 0 && <span className="count">{count}</span>}
                        </div>
                      );
                    })}
                    {categoryCounts.none > 0 && (
                      <div
                        className={cn('side-sub-item', todoActive && taskCategoryFilter.kind === 'none' && 'active')}
                        onClick={() => pickCategory({ kind: 'none' })}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => e.key === 'Enter' && pickCategory({ kind: 'none' })}
                        title={t('还没有归类的待办')}
                      >
                        <span className="side-cat-dot none" />
                        <span className="label">{t('未分类')}</span>
                        <span className="count">{categoryCounts.none}</span>
                      </div>
                    )}
                    {categories.length === 0 && categoryCounts.none === 0 && (
                      <div className="side-sub-empty">{t('还没有分类')}</div>
                    )}
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>

        <div className="side-section">
          <div className="side-title">
            <span>{t('笔记本')}</span>
            <button onClick={() => startAdd()} title={t('新建笔记本')}>
              <Plus size={14} />
            </button>
          </div>
          {adding && (
            <div className="nb-input-row">
              <input
                ref={inputRef}
                value={nbName}
                placeholder={
                  addParent ? t('在「{name}」下新建', { name: nameOfPath(addParent) }) : t('笔记本名称，可用 / 分层')
                }
                onChange={(e) => setNbName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitNotebook();
                  if (e.key === 'Escape') {
                    setAdding(false);
                    setNbName('');
                    setAddParent('');
                  }
                }}
                onBlur={commitNotebook}
              />
            </div>
          )}
          {tree.length === 0 && !adding && (
            <div className="hint" style={{ padding: '2px 10px' }}>
              {t('还没有笔记本，点右上角 + 新建')}
            </div>
          )}
          {tree.map((node) => (
            <TreeItem
              key={node.path}
              node={node}
              depth={0}
              activePath={view.type === 'notebook' ? view.value : ''}
              closed={closed}
              renaming={renaming?.path || null}
              renameValue={renaming?.value || ''}
              onOpen={pickNotebook}
              onToggle={(path) =>
                setClosed((prev) => {
                  const next = new Set(prev);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                })
              }
              onMenu={(path, x, y) => setMenu({ path, x, y })}
              onRenameChange={(value) => setRenaming((r) => (r ? { ...r, value } : r))}
              onRenameCommit={() => {
                if (!renaming) return;
                const { path, value } = renaming;
                setRenaming(null);
                void renameNotebook(path, value);
              }}
              onRenameCancel={() => setRenaming(null)}
              dragging={Boolean(draggingNote)}
              onDropNote={(noteId, path) => void moveTo(noteId, path)}
              draggingFolder={draggingFolder}
              dropHint={dropHint}
              onFolderDragStart={(path) => {
                setDraggingFolder(path);
                setDropHint(null);
              }}
              onFolderDragEnd={() => {
                setDraggingFolder(null);
                setDropHint(null);
              }}
              onFolderHover={(path, pos) => setDropHint(path && pos ? { path, pos } : null)}
              onFolderDrop={dropFolder}
            />
          ))}
        </div>

        {tags.length > 0 && (
          <div className="side-section">
            <div className="side-title">
              <span>{t('标签')}</span>
              <Tag size={14} style={{ opacity: 0.6 }} />
            </div>
            <div className={cn('meta-tags', showAllTags && 'expanded')} style={{ padding: '2px 8px', gap: 5 }}>
              {(showAllTags ? tags : tags.slice(0, 6)).map(([tag, count]) => (
                <button
                  key={tag}
                  className="tag-chip"
                  style={{ cursor: 'pointer' }}
                  title={t('筛选标签：{tag}（{n}）', { tag, n: count })}
                  onClick={() => {
                    setView({ type: 'smart', value: 'all' });
                    setQuery(`tag:${tag}`);
                  }}
                >
                  {tag}
                  <span style={{ opacity: 0.55, marginLeft: 3 }}>{count}</span>
                </button>
              ))}
              {tags.length > 6 && (
                <button className="tag-more" onClick={() => setShowAllTags((v) => !v)}>
                  {showAllTags ? t('收起 ↑') : t('全部标签 →')}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        <div
          className={cn('side-item', view.type === 'trash' && 'active')}
          onClick={openTrash}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && openTrash()}
        >
          <Trash2 size={16} strokeWidth={1.75} />
          <span className="label">{t('回收站')}</span>
          {trash.length > 0 && <span className="count">{trash.length}</span>}
        </div>
        <div className="side-item" onClick={() => setSettings(true)} role="button" tabIndex={0}>
          <Settings2 size={16} strokeWidth={1.75} />
          <span className="label">{t('设置')}</span>
          <span className="count">Ctrl+,</span>
        </div>
      </div>

      {menu && menuItems.length > 0 && <Menu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      {confirmDelete && (
        <ConfirmDialog
          title={t('删除笔记本「{name}」？', { name: nameOfPath(confirmDelete) })}
          desc={
            countIn(confirmDelete)
              ? t('其中 {n} 篇笔记会移到回收站，30 天内都可以恢复。', { n: countIn(confirmDelete) })
              : t('这是一个空笔记本，删除后不可恢复。')
          }
          confirmLabel={t('删除笔记本')}
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const path = confirmDelete;
            setConfirmDelete(null);
            void deleteNotebook(path);
          }}
        />
      )}
    </aside>
  );
}
