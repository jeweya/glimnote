import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  AlarmClock,
  Ban,
  Check,
  ChevronDown,
  Download,
  FolderPlus,
  Link2,
  MoreHorizontal,
  Plus,
  Repeat,
  RotateCcw,
  Search,
  SearchX,
  SkipForward,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useApp } from '../store/app';
import * as repo from '../lib/repo';
import {
  DONE_RANGES,
  DONE_RANGE_LABEL,
  OPEN_STATUSES,
  PRIORITY_LABEL,
  STATUS_LABEL,
  TIME_FILTER_LABEL,
  completedTasks,
  doneRangeCounts,
  doneTimeLabel,
  dueLabel,
  exportTasksMarkdown,
  filterTasks,
  groupDoneByDay,
  groupTasks,
  isFilterActive,
  isOpenTask,
  loadDoneRange,
  matchTask,
  overdueCount,
  parseQuickTaskInput,
  repeatSummary,
  saveDoneRange,
  statusFilterCounts,
  taskTitle,
  timeFilterCounts,
  type DoneDayGroup,
  type DoneRange,
  type Task,
  type TaskPriority,
  type TaskStatusFilter,
  type TaskTimeFilter,
} from '../lib/tasks';
import { cn, dateKey, downloadText } from '../lib/utils';
import { Menu, type MenuEntry } from './Menu';
import { DatePicker } from './DatePicker';
import { ConfirmDialog } from './Confirm';
import { TaskTrashModal } from './TaskTrashModal';
import { TaskCategoryModal } from './TaskCategoryModal';
import { TaskReviewModal } from './TaskReviewModal';
import { TaskRemindPopover } from './TaskRemindPopover';
import { categoryColor, TASK_CATEGORY_ALL } from '../lib/taskCategories';
import { useT } from '../lib/i18n';

const GROUP_LABELS: { key: keyof ReturnType<typeof groupTasks>; label: string }[] = [
  { key: 'overdue', label: '已过期' },
  { key: 'today', label: '今天' },
  { key: 'week', label: '7 天内' },
  { key: 'month', label: '1 个月内' },
  { key: 'later', label: '以后' },
  { key: 'someday', label: '无日期' },
  { key: 'inbox', label: '待整理' },
];

const TIME_FILTERS: TaskTimeFilter[] = ['all', 'today', 'week', 'month', 'overdue'];
const STATUS_FILTERS: TaskStatusFilter[] = ['all', ...OPEN_STATUSES];

export function TaskPanel() {
  const tr = useT();
  const tasks = useApp((s) => s.tasks);
  const loaded = useApp((s) => s.tasksLoaded);
  const loading = useApp((s) => s.tasksLoading);
  const currentTaskId = useApp((s) => s.currentTaskId);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const selectTask = useApp((s) => s.selectTask);
  const createTask = useApp((s) => s.createTask);
  const patchTask = useApp((s) => s.patchTask);
  const toggleTask = useApp((s) => s.toggleTask);
  const skipTask = useApp((s) => s.skipTask);
  const endTaskRepeat = useApp((s) => s.endTaskRepeat);
  const removeTask = useApp((s) => s.removeTask);
  const loadTasks = useApp((s) => s.loadTasks);
  const openTaskTrash = useApp((s) => s.openTaskTrash);
  const toast = useApp((s) => s.toast);
  const timeFilter = useApp((s) => s.taskTimeFilter);
  const statusFilter = useApp((s) => s.taskStatusFilter);
  const setTimeFilter = useApp((s) => s.setTaskTimeFilter);
  const setStatusFilter = useApp((s) => s.setTaskStatusFilter);
  const clearFilters = useApp((s) => s.clearTaskFilters);
  const setTaskStatus = useApp((s) => s.setTaskStatus);
  const categories = useApp((s) => s.categories);
  const categoryFilter = useApp((s) => s.taskCategoryFilter);
  const setCategoryFilter = useApp((s) => s.setTaskCategoryFilter);
  const catModal = useApp((s) => s.taskCategoryModalOpen);
  const closeCatModal = useApp((s) => s.closeTaskCategoryModal);

  const [q, setQ] = useState('');
  const [reviewModal, setReviewModal] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [title, setTitle] = useState('');
  // 快速添加默认落在今天：大多数待办是「今天要做的事」，不想排期时再点日期清除
  const [due, setDue] = useState<string | undefined>(() => dateKey());
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [flashId, setFlashId] = useState<string | null>(null);
  const [pendingDone, setPendingDone] = useState<Set<string>>(new Set());
  const [showDone, setShowDone] = useState(false);
  // 完成记录可能上千条：默认只看近 30 天，展开后每次只渲染 40 条，按完成日分组
  const [doneRange, setDoneRange] = useState<DoneRange>(() => loadDoneRange());
  const [doneLimit, setDoneLimit] = useState(40);
  const [menu, setMenu] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const [remindPop, setRemindPop] = useState<{ taskId: string; x: number; y: number } | null>(null);
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number } | null>(null);
  const [datePop, setDatePop] = useState<{ x: number; y: number; taskId?: string } | null>(null);
  const [quickDate, setQuickDate] = useState<{ x: number; y: number } | null>(null);
  const [quickPriority, setQuickPriority] = useState<{ x: number; y: number } | null>(null);
  const [statusMenu, setStatusMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDone, setConfirmDone] = useState(false);
  const addRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const doneGroupRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const autoSelected = useRef(false);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  // 分类在管理弹窗里被删掉或改名后，别让列表停在一个不存在的分类上
  useEffect(() => {
    if (categoryFilter.kind === 'cat' && !categories.some((c) => c.name === categoryFilter.name)) {
      setCategoryFilter(TASK_CATEGORY_ALL);
    }
  }, [categories, categoryFilter, setCategoryFilter]);

  // 进入待办视图时若还没有选中项（比如刚刷新），自动落在第一条未完成的任务上，
  // 免得右栏一直空着；只自动选一次，「Esc 清除选中」之后不再抢焦点
  useEffect(() => {
    if (autoSelected.current || !loaded || loading) return;
    if (currentTaskId) {
      autoSelected.current = true;
      return;
    }
    const first = tasks.find((t) => t.status !== 'done' && !t.deletedAt);
    if (!first) return;
    autoSelected.current = true;
    selectTask(first.id);
  }, [loaded, loading, currentTaskId, tasks, selectTask]);

  // 跨零点重算分组：每分钟看一眼日期有没有变
  useEffect(() => {
    const tick = window.setInterval(() => setNow(new Date()), 60000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    if (!flashId) return;
    const t = window.setTimeout(() => setFlashId(null), 800);
    return () => window.clearTimeout(t);
  }, [flashId]);

  useEffect(() => {
    saveDoneRange(doneRange);
  }, [doneRange]);

  // 换分类等于换了一份列表：行数复位，滚动回到顶部，
  // 否则上一个分类滚到底的位置会落在新列表中间，抬头看不到分组头
  useEffect(() => {
    setDoneLimit(40);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [categoryFilter]);

  const searching = Boolean(q.trim());
  const timeStatusActive = isFilterActive({ time: timeFilter, status: statusFilter });
  const filtering = (timeStatusActive || categoryFilter.kind !== 'all') && !searching;
  // 分类先收窄范围，再看时间/状态；两层筛选中任意一层生效都要显示「已筛选」
  const scope = useMemo(() => {
    if (categoryFilter.kind === 'all') return tasks;
    if (categoryFilter.kind === 'none') return tasks.filter((t) => !t.category);
    return tasks.filter((t) => t.category === categoryFilter.name);
  }, [tasks, categoryFilter]);
  // 筛选只收窄任务集合，分组规则不变——所以选「近7天」还是能看到「今天」「7 天内」两组。
  // 只按分类看时不走 filterTasks：它会剔除已完成，导致分类里的完成记录永远打不开。
  const visible = useMemo(
    () => (timeStatusActive ? filterTasks(scope, { time: timeFilter, status: statusFilter }, now) : scope),
    [scope, timeStatusActive, timeFilter, statusFilter, now],
  );
  const groups = useMemo(() => groupTasks(visible, now), [visible, now]);
  // chip 上的计数跟着分类走，否则在「工作」里看到「今天 5」却只有 2 条，会以为丢了任务
  const timeCounts = useMemo(() => timeFilterCounts(scope, statusFilter, now), [scope, statusFilter, now]);
  const statusCounts = useMemo(() => statusFilterCounts(scope, timeFilter, now), [scope, timeFilter, now]);
  // 只按分类看时 visible 含已完成，底部统计与空态判断只算未完成
  const visibleOpenCount = useMemo(() => visible.filter(isOpenTask).length, [visible]);
  // 「都做完了」空态里的完成数要看全量，不能只看筛选后的集合
  const doneRecent = useMemo(
    () => (timeStatusActive ? groupTasks(tasks, now).doneRecent : groups.doneRecent),
    [timeStatusActive, tasks, now, groups.doneRecent],
  );
  // 完成记录展开后才计算与排序；上千条也只排一次，渲染由 doneLimit 分批
  const doneInRange = useMemo(
    () => (showDone ? completedTasks(visible, doneRange, now) : []),
    [showDone, visible, doneRange, now],
  );
  const doneCounts = useMemo(
    () => (showDone ? doneRangeCounts(visible, now) : { '7d': 0, '30d': 0, all: 0 }),
    [showDone, visible, now],
  );
  const doneDayGroups = useMemo(() => groupDoneByDay(doneInRange, now), [doneInRange, now]);
  const shownDoneGroups = useMemo(() => {
    let left = doneLimit;
    const out: { group: DoneDayGroup; items: Task[] }[] = [];
    for (const group of doneDayGroups) {
      if (left <= 0) break;
      const items = group.items.slice(0, left);
      left -= items.length;
      out.push({ group, items });
    }
    return out;
  }, [doneDayGroups, doneLimit]);
  const found = useMemo(
    () =>
      searching
        ? tasks
            .filter((t) => !t.deletedAt && matchTask(t, q))
            .sort((a, b) => {
              const da = a.due ? Date.parse(a.due) : Infinity;
              const db = b.due ? Date.parse(b.due) : Infinity;
              return da - db;
            })
        : [],
    [tasks, q, searching],
  );

  // 看某个分类时，标题下的统计也只算这一类的，否则「工作 · 5 条未完成」会和下面的 2 条对不上
  const countScope = categoryFilter.kind === 'all' ? tasks : scope;
  const openCount = countScope.filter((t) => t.status !== 'done' && !t.deletedAt).length;
  const scopeOpen = scope.filter((t) => t.status !== 'done' && !t.deletedAt).length;
  const lateCount = overdueCount(countScope, now);
  const doingCount = countScope.filter((t) => t.status === 'doing' && !t.deletedAt).length;
  const sub = loading
    ? tr('正在读取任务库…')
    : [`${tr('{n} 条未完成', { n: openCount })}`, doingCount ? tr('{n} 条跟进中', { n: doingCount }) : '', lateCount ? tr('{n} 条已过期', { n: lateCount }) : '']
        .filter(Boolean)
        .join(' · ');

  const focusAdd = () => addRef.current?.focus();

  const resetFilters = () => {
    clearFilters();
  };

  const commitQuick = async () => {
    const text = title.trim();
    if (!text) return;
    // 结尾带 18:00 就当作今天 18:00 提醒；已经选了别的日期就沿用那个日期
    const quick = parseQuickTaskInput(text);
    const task = await createTask(quick.title, {
      due: due ?? (quick.dueTime ? dateKey(now) : undefined),
      dueTime: quick.dueTime,
      priority,
      // 正在看某个分类时，新条目直接归进去——省掉「先添加再归类」这一步
      category: categoryFilter.kind === 'cat' ? categoryFilter.name : undefined,
    });
    if (!task) return;
    // 新条目若落在当前筛选之外，就先清掉筛选让它现形，否则用户会以为没存上
    if (
      isFilterActive({ time: timeFilter, status: statusFilter }) &&
      filterTasks([task], { time: timeFilter, status: statusFilter }, now).length === 0
    ) {
      clearFilters();
    }
    setTitle('');
    // 日期与优先级只对刚录入的那条生效，否则连续录入会悄悄继承上一条的设置；
    // 日期回到「今天」，保持快速录入的默认预期
    setDue(dateKey());
    setPriority('normal');
    setFlashId(task.id);
    requestAnimationFrame(() => addRef.current?.focus());
  };

  const toggle = (task: Task) => {
    if (task.status === 'done') {
      void toggleTask(task.id);
      return;
    }
    if (pendingDone.has(task.id)) return;
    // 先就地打勾 600ms 再移入「已完成」，避免点一下就不见了
    setPendingDone((prev) => new Set(prev).add(task.id));
    window.setTimeout(() => {
      void toggleTask(task.id).finally(() => {
        setPendingDone((prev) => {
          const next = new Set(prev);
          next.delete(task.id);
          return next;
        });
      });
    }, 600);
  };

  const moveFocus = (dir: 1 | -1) => {
    const rows = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-task-row]') || [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[Math.min(rows.length - 1, Math.max(0, at + dir))];
    next?.focus();
  };

  const rowKey = (e: KeyboardEvent<HTMLDivElement>, task: Task) => {
    if (e.key === ' ') {
      e.preventDefault();
      toggle(task);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectTask(task.id);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      void removeTask(task.id);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocus(-1);
    }
  };

  const rowMenuItems = (task: Task): (MenuEntry | 'sep')[] => {
    // 已完成的行已经有勾和完成时间，改日期、分组、提醒都失去意义；
    // 这里只留「改回待处理」一个出口，菜单短到一眼能读完。
    if (task.status === 'done') {
      return [
        {
          label: tr('改为待处理'),
          icon: <RotateCcw size={14} />,
          onClick: () => void toggleTask(task.id),
        },
      ];
    }
    return [
      // 点行本身就会打开详情，「打开详情」再占第一项是多余的；这里换成真正常用的提醒设置
      {
        label: tr('到点提醒…'),
        icon: <AlarmClock size={14} />,
        onClick: () => setRemindPop({ taskId: task.id, x: menu?.x || 0, y: menu?.y || 0 }),
      },
      {
        label: tr('改日期…'),
        onClick: () => setDatePop({ x: menu?.x || 0, y: menu?.y || 0, taskId: task.id }),
      },
      ...(task.repeat
        ? [
            {
              label: tr('跳过本次'),
              icon: <SkipForward size={14} />,
              onClick: () => void skipTask(task.id),
            },
            {
              label: tr('结束循环'),
              icon: <Ban size={14} />,
              onClick: () => endTaskRepeat(task.id),
            },
          ]
        : []),
      // 状态不放在「打开详情再改」的深路径里：在列表上就能把一条事从待整理挑出来
      'sep',
      ...OPEN_STATUSES.map((status) => ({
        label: tr('设为{status}', { status: tr(STATUS_LABEL[status]) }),
        checked: task.status === status,
        onClick: () => setTaskStatus(task.id, status),
      })),
      'sep',
      ...(['high', 'normal', 'low'] as TaskPriority[]).map((p) => ({
        label: p === 'high' ? tr('高优先级') : p === 'low' ? tr('低优先级') : tr('普通优先级'),
        checked: task.priority === p,
        onClick: () => patchTask(task.id, { priority: p }),
      })),
      'sep',
      // 列表上直接归类，比「打开详情 → 找分类字段」少两步
      {
        label: tr('未分类'),
        checked: !task.category,
        onClick: () => patchTask(task.id, { category: undefined }),
      },
      ...categories.map((cat) => ({
        label: cat.name,
        checked: task.category === cat.name,
        onClick: () => patchTask(task.id, { category: cat.name }),
      })),
      'sep',
      {
        label: tr('删除待办'),
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => void removeTask(task.id),
      },
    ];
  };

  const menuTask = menu ? tasks.find((t) => t.id === menu.taskId) : null;
  const remindTask = remindPop ? tasks.find((t) => t.id === remindPop.taskId) : null;

  const headerItems: (MenuEntry | 'sep')[] = [
    {
      label: tr('导出为 Markdown'),
      icon: <Download size={14} />,
      onClick: () => {
        downloadText(tr('待办清单-{date}.md', { date: new Date().toISOString().slice(0, 10) }), exportTasksMarkdown(tasks, now));
        toast(tr('已导出当前清单'), 'success');
      },
    },
    {
      label: tr('已删除的待办'),
      icon: <Trash2 size={14} />,
      onClick: () => void openTaskTrash(true),
    },
    'sep',
    {
      label: tr('清理已完成'),
      onClick: () => {
        if (!tasks.some((t) => t.status === 'done')) {
          toast(tr('还没有已完成的待办'), 'info');
          return;
        }
        setConfirmDone(true);
      },
    },
  ];

  const clearDone = async () => {
    const done = tasks.filter((t) => t.status === 'done');
    setConfirmDone(false);
    try {
      for (const task of done) await repo.deleteTask(task);
      await loadTasks(true);
      await openTaskTrash(false);
      toast(tr('已把 {n} 条已完成移到回收站', { n: done.length }), 'info', {
        label: tr('查看'),
        run: () => void openTaskTrash(true),
      });
    } catch {
      toast(tr('清理失败'), 'error');
    }
  };

  const renderRow = (task: Task, opts: { done?: boolean; flash?: boolean } = {}) => {
    const active = currentTaskId === task.id;
    const pending = pendingDone.has(task.id);
    const checked = task.status === 'done' || pending;
    const late = !checked && Boolean(task.due) && dueLabel(task.due!, now).startsWith('已过期');
    const subParts: ReactNode[] = [];
    // 分类标签放最前：在侧栏按分类切换时，回来扫一眼就能确认每条属于哪类
    if (task.category) {
      subParts.push(
        <span
          key="cat"
          className="task-tag"
          style={{ '--cat': categoryColor(task.category, categories) } as CSSProperties}
          title={tr('分类：{name}', { name: task.category })}
        >
          <i />
          <span className="task-tag-name">{task.category}</span>
        </span>,
      );
    }
    if (opts.done) {
      // 完成行只留「分类 + 完成时刻」：完成日已经在组头上，再带旧的截止日期只会增加噪音
      if (task.skippedAt) {
        subParts.push(
          <span key="done-at" className="task-done-at skipped">
            {tr('已跳过')}
          </span>,
        );
      } else {
        const doneAt = doneTimeLabel(task);
        if (doneAt) {
          subParts.push(
            <span key="done-at" className="task-done-at">
              完成 {doneAt}
            </span>,
          );
        }
      }
    } else {
      if (!checked && task.status === 'inbox') {
        subParts.push(
          <span key="status" className="task-status inbox">
            {tr(STATUS_LABEL.inbox)}
          </span>,
        );
      } else if (!checked && task.status === 'doing') {
        subParts.push(
          <span key="status" className="task-status doing">
            {tr(STATUS_LABEL.doing)}
          </span>,
        );
      }
      if (task.due) {
        subParts.push(
          <span key="due" className={cn('task-due', late && 'late')}>
            {dueLabel(task.due, now)}
            {task.dueTime ? ` ${task.dueTime}` : ''}
          </span>,
        );
      }
      if (task.repeat) {
        subParts.push(
          <span key="repeat" className="task-repeat" title={tr('循环：{rule}', { rule: repeatSummary(task) })}>
            <Repeat size={12} strokeWidth={1.9} />
            {repeatSummary(task)}
          </span>,
        );
      }
      if (task.noteTitle) {
        subParts.push(
          <span key="note" className="task-note" title={task.noteTitle}>
            <Link2 size={14} />
            {task.noteTitle}
          </span>,
        );
      }
    }
    return (
      <div
        key={task.id}
        data-task-row
        role="button"
        tabIndex={0}
        className={cn(
          'task-row',
          active && 'active',
          task.priority === 'high' && !checked && 'high',
          checked && 'done',
          opts.done && 'no-check',
          opts.flash && 'flash',
        )}
        onClick={() => selectTask(task.id)}
        onKeyDown={(e) => rowKey(e, task)}
        onContextMenu={(e) => {
          e.preventDefault();
          selectTask(task.id);
          setMenu({ taskId: task.id, x: e.clientX, y: e.clientY });
        }}
      >
        {/* 已完成的行不再放勾选框：状态已经由组标题和删除线说明，
            再留一个「已勾选」的方框既占位置，又容易让人误以为还能点回未完成 */}
        {!opts.done && (
          <button
            className={cn('task-check', checked && 'on')}
            role="checkbox"
            aria-checked={checked}
            aria-label={tr('完成待办')}
            onClick={(e) => {
              e.stopPropagation();
              toggle(task);
            }}
          >
            {checked && <Check size={14} strokeWidth={1.75} />}
          </button>
        )}
        <div className="task-main">
          <div className="task-title">
            {taskTitle(task)}
            {task.conflict && <span className="task-flag">{tr('冲突副本')}</span>}
          </div>
          {subParts.length ? (
            <div className="task-sub">
              {subParts.map((part, i) => (
                <Fragment key={i}>
                  {i > 0 && <span className="task-dot">·</span>}
                  {part}
                </Fragment>
              ))}
            </div>
          ) : null}
        </div>
        <button
          className="task-more"
          title={tr('更多')}
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            selectTask(task.id);
            setMenu({ taskId: task.id, x: r.right - 4, y: r.bottom + 4 });
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    );
  };

  // 「已完成」挂在列表最底部：展开后新增内容会顶到可视区外，用户只看到箭头翻面。
  // 等这一帧渲染完，把组头滚到滚动区顶部，让完成记录直接进入视野。
  const revealDone = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const box = doneGroupRef.current;
        const sc = scrollRef.current;
        if (!box || !sc) return;
        const top = box.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 4;
        sc.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      });
    });
  };

  const emptyAll = loaded && !loading && tasks.length === 0;
  // 「已完成」展开时不要再用空态盖住列表，否则「看看已完成」点了没反应
  const onlyCategoryFilter =
    categoryFilter.kind !== 'all' && !isFilterActive({ time: timeFilter, status: statusFilter });
  const allDone = loaded && !emptyAll && scopeOpen === 0 && scope.length > 0 && !showDone;
  const categoryLabel =
    categoryFilter.kind === 'cat' ? categoryFilter.name : categoryFilter.kind === 'none' ? tr('未分类') : '';

  return (
    <section className={cn('notelist task-panel', !sidebarOpen && 'hidden')}>
      <div className="list-head">
        <div className="list-title-row">
          <div className="list-title-text">
            <div className="list-title">{categoryLabel || tr('待办')}</div>
            <div className="list-sub">{categoryLabel ? `${tr('分类')} · ${sub}` : sub}</div>
          </div>
          <div className="list-head-actions">
            <button
              className="task-ai-btn"
              title={tr('AI 总结完成的待办，并写入今天的日记')}
              onClick={() => setReviewModal(true)}
            >
              <Sparkles size={14} />
              {tr('AI 总结')}
            </button>
            <button
              className="icon-btn"
              title={tr('待办操作')}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setHeaderMenu({ x: r.right - 4, y: r.bottom + 4 });
              }}
            >
              <MoreHorizontal size={16} />
            </button>
          </div>
        </div>
        {/* 搜索与状态筛选同一行：状态下拉原来挂在时间 chip 那条，窄栏里会被挤到第二行
            浮在右边，留下一条空带；放到这里后 chip 一条线就能放下，也不再随宽度跳行 */}
        <div className="search-row">
          <div className="search-inline">
            <Search size={14} strokeWidth={1.75} />
            <input
              value={q}
              placeholder={tr('搜索待办')}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQ('');
              }}
            />
            {q && (
              <button className="icon-btn" style={{ width: 18, height: 18 }} onClick={() => setQ('')} title={tr('清除')}>
                <X size={14} />
              </button>
            )}
          </div>
          <button
            className={cn('tf-status', statusFilter !== 'all' && 'on', searching && 'paused')}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setStatusMenu({ x: r.left, y: r.bottom + 4 });
            }}
            title={tr('按状态筛选')}
          >
            {statusFilter === 'all' ? tr('状态') : `${tr(STATUS_LABEL[statusFilter])} ${statusCounts[statusFilter]}`}
            <ChevronDown size={14} />
          </button>
        </div>
      </div>

      <div className="task-quick">
        <Plus size={14} className="task-quick-plus" onClick={focusAdd} />
        <input
          ref={addRef}
          data-quick-add
          value={title}
          placeholder={tr('添加待办，回车保存')}
          aria-label={tr('添加待办')}
          title={tr('输入标题后回车保存；在结尾写日期或 18:00 这样的时间，会自动识别为截止时间')}
          onChange={(e) => setTitle(e.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !composing.current) {
              e.preventDefault();
              void commitQuick();
            } else if (e.key === 'Escape') {
              setTitle('');
              e.currentTarget.blur();
            }
          }}
        />
        <button
          className={cn('quick-chip', due && 'on')}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setQuickDate({ x: r.left, y: r.bottom + 6 });
          }}
          title={tr('设置截止日期')}
        >
          {due ? dueLabel(due, now) : tr('日期')}
        </button>
        <button
          className={cn('quick-chip', priority !== 'normal' && 'on')}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setQuickPriority({ x: r.left - 40, y: r.bottom + 6 });
          }}
          title={tr('设置优先级')}
        >
          {priority === 'normal' ? '•••' : tr(PRIORITY_LABEL[priority])}
        </button>
      </div>

      <div
        className={cn(
          'task-filters',
          filtering && 'on',
          // 搜索时筛选被忽略：淡出并暂时不可点，免得以为是筛选把结果挡住了
          searching && isFilterActive({ time: timeFilter, status: statusFilter }) && 'paused',
        )}
      >
        <div className="tf-chips">
          {TIME_FILTERS.map((f) => {
            const count = timeCounts[f];
            return (
              <button
                key={f}
                className={cn('tf-chip', timeFilter === f && 'on', f !== 'all' && count === 0 && 'zero')}
                onClick={() => setTimeFilter(timeFilter === f ? 'all' : f)}
                title={f === 'overdue' ? tr('截止日期早于今天') : undefined}
              >
                {tr(TIME_FILTER_LABEL[f])}
                {f !== 'all' && <em>{count}</em>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="task-list-scroll list-scroll" ref={scrollRef}>
        {!loaded || loading ? (
          <div className="task-skeleton" aria-hidden>
            {Array.from({ length: 7 }).map((_, i) => (
              <div className="task-skeleton-row" key={i} style={{ opacity: 1 - i * 0.1 }}>
                <span />
                <i />
              </div>
            ))}
          </div>
        ) : searching ? (
          found.length ? (
            <div className="task-group">
              <div className="task-group-head">
                <span>{tr('搜索「{q}」', { q: q.trim() })}</span>
                <em>{found.length}</em>
              </div>
              {found.map((task) => renderRow(task))}
            </div>
          ) : (
            <div className="list-empty">
              <Search size={40} strokeWidth={1.75} />
              <div className="e1">{tr('没有匹配的待办')}</div>
              <div className="e2">{tr('试试更短的关键词')}</div>
            </div>
          )
        ) : emptyAll ? (
          <div className="list-empty">
            <Check size={40} strokeWidth={1.75} />
            <div className="e1">{tr('还没有待办')}</div>
            <div className="e2">{tr('在上面输入框里加一条；待办和笔记分开存，不会混进正文')}</div>
            <button onClick={focusAdd}>{tr('添加第一条待办')}</button>
          </div>
        ) : categoryFilter.kind !== 'all' && scope.length === 0 ? (
          <div className="list-empty">
            <FolderPlus size={40} strokeWidth={1.5} />
            <div className="e1">
              {categoryFilter.kind === 'none' ? tr('没有未分类的待办') : tr('「{name}」还没有待办', { name: categoryFilter.name })}
            </div>
            <div className="e2">{tr('在上面输入框加一条，会自动归到这里')}</div>
            <button onClick={focusAdd}>{tr('添加待办')}</button>
          </div>
        ) : allDone ? (
          <div className="list-empty">
            <Check size={40} strokeWidth={1.75} />
            <div className="e1">{tr('都做完了')}</div>
            <div className="e2">{tr('最近 14 天完成 {n} 条', { n: doneRecent })}</div>
            {groups.doneTotal > 0 && (
              <button
                onClick={() => {
                  setShowDone(true);
                  setDoneLimit(40);
                  revealDone();
                }}
              >
                {tr('看看已完成')}
              </button>
            )}
          </div>
        ) : filtering && visibleOpenCount === 0 ? (
          <div className="list-empty">
            <SearchX size={40} strokeWidth={1.75} />
            <div className="e1">{tr('没有符合条件的待办')}</div>
            <div className="e2">{tr('换一个筛选，或清除筛选')}</div>
            <button onClick={resetFilters}>{tr('清除筛选')}</button>
          </div>
        ) : (
          <>
            {GROUP_LABELS.map((group) => {
              const list = groups[group.key] as Task[];
              if (!list.length) return null;
              return (
                <div className="task-group" key={group.key}>
                  <div className="task-group-head">
                    <span>{tr(group.label)}</span>
                    <em>{list.length}</em>
                  </div>
                  {list.map((task) => renderRow(task, { flash: flashId === task.id }))}
                </div>
              );
            })}
            {(!filtering || onlyCategoryFilter) && groups.doneTotal > 0 && (
              <div className="task-group done-group" ref={doneGroupRef}>
                <button
                  className="task-group-head as-button"
                  onClick={() => {
                    const next = !showDone;
                    setShowDone(next);
                    setDoneLimit(40);
                    if (next) revealDone();
                  }}
                  aria-expanded={showDone}
                >
                  <span>{tr('已完成')}</span>
                  <em>
                    {groups.doneTotal}
                    <span className={cn('done-caret', showDone && 'open')}>⌄</span>
                  </em>
                </button>
                {showDone && (
                  <>
                    <div className="done-toolbar">
                      <div className="done-ranges" role="tablist" aria-label={tr('完成时间范围')}>
                        {DONE_RANGES.map((r) => (
                          <button
                            key={r}
                            role="tab"
                            aria-selected={doneRange === r}
                            className={cn('done-range', doneRange === r && 'on')}
                            onClick={() => {
                              setDoneRange(r);
                              setDoneLimit(40);
                              // 换区间等于换了一份列表，回到组头看最新的一段
                              revealDone();
                            }}
                          >
                            {tr(DONE_RANGE_LABEL[r])}
                            <em>{doneCounts[r]}</em>
                          </button>
                        ))}
                      </div>
                    </div>
                    {doneDayGroups.length === 0 ? (
                      <div className="done-empty">{tr('这个区间还没有完成的待办')}</div>
                    ) : (
                      shownDoneGroups.map(({ group, items }) => (
                        <div className="done-day" key={group.key}>
                          <div className="done-day-head">
                            <span>{tr(group.label)}</span>
                            <em>{group.items.length}</em>
                          </div>
                          {items.map((task) => renderRow(task, { done: true }))}
                        </div>
                      ))
                    )}
                    {doneInRange.length > doneLimit && (
                      <button className="done-more" onClick={() => setDoneLimit((n) => n + 60)}>
                        {tr('显示更多')}
                        <em>{tr('还剩 {n} 条', { n: doneInRange.length - doneLimit })}</em>
                      </button>
                    )}
                    <div className="done-summary">
                      {tr('共 {total} 条 · 已显示 {shown} 条', { total: doneInRange.length, shown: Math.min(doneLimit, doneInRange.length) })}
                      {doneRange !== 'all' && doneCounts.all > doneInRange.length ? tr(' · 更早的记录可切到「全部」') : ''}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <div className={cn('list-foot', filtering && 'filtered')}>
        {searching ? (
          <>
            <span>{tr('按相关度排序')}</span>
            <span>{tr('{n} 条', { n: found.length })}</span>
          </>
        ) : filtering ? (
          <>
            <span>
              {tr('已筛选 · {a} → {b} 条', { a: scopeOpen, b: visibleOpenCount })}
            </span>
            <button className="foot-clear" onClick={resetFilters}>
              {tr('清除筛选')}
            </button>
          </>
        ) : (
          <>
            <span>{tr('按截止日期分组')}</span>
            <span>{tr('{n} 条', { n: openCount })}</span>
          </>
        )}
      </div>

      {menu && menuTask && <Menu x={menu.x} y={menu.y} items={rowMenuItems(menuTask)} onClose={() => setMenu(null)} />}

      {remindPop && remindTask && (
        <TaskRemindPopover task={remindTask} x={remindPop.x} y={remindPop.y} onClose={() => setRemindPop(null)} />
      )}

      {headerMenu && <Menu x={headerMenu.x} y={headerMenu.y} items={headerItems} onClose={() => setHeaderMenu(null)} />}

      {statusMenu && (
        <Menu
          x={statusMenu.x}
          y={statusMenu.y}
          items={STATUS_FILTERS.map((f) => ({
            label: `${f === 'all' ? tr('全部状态') : tr(STATUS_LABEL[f])} ${statusCounts[f]}`,
            checked: statusFilter === f,
            onClick: () => setStatusFilter(f),
          }))}
          onClose={() => setStatusMenu(null)}
        />
      )}

      {quickDate && (
        <DatePicker
          value={due}
          x={quickDate.x}
          y={quickDate.y}
          onPick={(next) => {
            setDue(next);
            setQuickDate(null);
          }}
          onClose={() => setQuickDate(null)}
        />
      )}

      {quickPriority && (
        <Menu
          x={quickPriority.x}
          y={quickPriority.y}
          items={(['high', 'normal', 'low'] as TaskPriority[]).map((p) => ({
            label: p === 'high' ? '高' : p === 'low' ? '低' : '普通',
            checked: priority === p,
            onClick: () => setPriority(p),
          }))}
          onClose={() => setQuickPriority(null)}
        />
      )}

      {datePop && (
        <DatePicker
          value={tasks.find((t) => t.id === datePop.taskId)?.due}
          x={datePop.x}
          y={datePop.y}
          onPick={(next) => {
            if (datePop.taskId) patchTask(datePop.taskId, { due: next });
            setDatePop(null);
          }}
          onClose={() => setDatePop(null)}
        />
      )}

      {confirmDone && (
        <ConfirmDialog
          title={tr('把已完成的待办移到回收站？')}
          desc={tr('回收站保留 30 天，随时可以恢复。')}
          confirmLabel={tr('清理')}
          onCancel={() => setConfirmDone(false)}
          onConfirm={() => void clearDone()}
        />
      )}

      {catModal && <TaskCategoryModal onClose={closeCatModal} />}
      {reviewModal && <TaskReviewModal onClose={() => setReviewModal(false)} />}

      <TaskTrashModal />
    </section>
  );
}
