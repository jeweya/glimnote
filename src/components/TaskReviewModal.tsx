import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Check, Download, FolderOpen, Sparkles, X } from 'lucide-react';
import { useApp } from '../store/app';
import * as repo from '../lib/repo';
import { taskTitle, type Task } from '../lib/tasks';
import { aiReady, summarizeTaskReview } from '../lib/ai';
import {
  REVIEW_RANGES,
  REVIEW_RANGE_LABEL,
  appendToDailyNote,
  buildReviewLocalExport,
  buildReviewMarkdown,
  completedInRange,
  groupReviewByCategory,
  loadExportedKeys,
  reviewDoneAt,
  reviewExportKey,
  saveExportedKeys,
  type ReviewRange,
} from '../lib/taskReview';
import { categoryColor } from '../lib/taskCategories';
import { cn, dateKey, downloadText, pad, dailyTitleOf } from '../lib/utils';
import { ConfirmDialog } from './Confirm';
import { useT } from '../lib/i18n';

interface Props {
  onClose: () => void;
}

/** 把勾选的「已完成」待办追加到当天日记；可选让 AI 写一段小结 */
export function TaskReviewModal({ onClose }: Props) {
  const tasks = useApp((s) => s.tasks);
  const categories = useApp((s) => s.categories);
  const notes = useApp((s) => s.notes);
  const notebooks = useApp((s) => s.notebooks);
  const toast = useApp((s) => s.toast);
  const refresh = useApp((s) => s.refresh);
  const openDaily = useApp((s) => s.openDaily);
  const setSettings = useApp((s) => s.setSettings);
  const tr = useT();

  const [now] = useState(() => new Date());
  const [range, setRange] = useState<ReviewRange>('today');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [exported, setExported] = useState<string[]>(() => loadExportedKeys());
  // 默认不带小结：只有用户主动打开才调模型，避免误触产生费用 / 等待
  const [aiOn, setAiOn] = useState(false);
  const [aiPrompt, setAiPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ path: string; count: number; key: string } | null>(null);

  const aiOk = aiReady();
  const day = dateKey();
  const dailyPath = `notes/日记/${day}.md`;
  const existingDaily = notes.find((n) => n.notebook === '日记' && n.title === day);
  // 用户可能把「日记」笔记本整个删掉；写入时会像「今日日记」一样自动重建，这里提前说明
  const diaryMissing =
    !notes.some((n) => n.notebook === '日记' || n.notebook.startsWith('日记/')) && !notebooks.includes('日记');
  const exportedSet = useMemo(() => new Set(exported), [exported]);
  const candidates = useMemo(() => completedInRange(tasks, range, now), [tasks, range, now]);
  const order = useMemo(() => categories.map((c) => c.name), [categories]);

  // 切区间时默认勾上「还没导出过」的完成项：多数时候用户只是想补记一下，不必逐条点
  useEffect(() => {
    const done = new Set(loadExportedKeys());
    setSelected(new Set(candidates.filter((t) => !done.has(reviewExportKey(t))).map((t) => t.id)));
    // candidates 随区间变化，区间以外的任务更新不该重置用户的手动勾选
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy && !aiPrompt) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, busy, aiPrompt]);

  const selectedTasks = useMemo(() => candidates.filter((t) => selected.has(t.id)), [candidates, selected]);
  // 列表永远展示区间内的全部完成项（否则没勾的条目会凭空消失）；
  // 只有导出时的分组按已勾选的来
  const candidateGroups = useMemo(() => groupReviewByCategory(candidates, order), [candidates, order]);
  const groups = useMemo(() => groupReviewByCategory(selectedTasks, order), [selectedTasks, order]);

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = candidates.length > 0 && selectedTasks.length === candidates.length;
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(candidates.map((t) => t.id)));
  };

  const timeLabel = (task: Task) => {
    const d = new Date(reviewDoneAt(task));
    if (Number.isNaN(d.getTime())) return '';
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return range === 'today' ? hm : `${tr('{m}月{d}日', { m: d.getMonth() + 1, d: d.getDate() })} ${hm}`;
  };

  const runExport = async () => {
    if (!groups.length || busy) return;
    setBusy(true);
    let summary: string | undefined;
    if (aiOn && aiOk) {
      try {
        summary = await summarizeTaskReview({
          rangeLabel: tr(REVIEW_RANGE_LABEL[range]),
          groups: groups.map((g) => ({ name: g.name || tr('未分类'), titles: g.items.map(taskTitle) })),
        });
      } catch (e) {
        toast((e as Error).message || tr('AI 小结没生成，先导出清单'), 'warn');
      }
    }
    try {
      const key = dateKey();
      const note = await repo.ensureDailyNote(key);
      note.content = appendToDailyNote(note.content, buildReviewMarkdown({ groups, range, summary }));
      await repo.saveNote(note);
      await refresh();
      const keys = [...loadExportedKeys(), ...selectedTasks.map(reviewExportKey)];
      saveExportedKeys(keys);
      setExported(keys);
      setBusy(false);
      // 不直接关窗：让用户看清文件到底写到了哪里，再决定要不要打开
      setSaved({ path: note.path, count: selectedTasks.length, key });
    } catch (e) {
      console.warn('export review failed', e);
      toast(tr('写入日记失败，请检查磁盘空间或权限'), 'error');
      setBusy(false);
    }
  };

  /** 只下载，不动日记；勾选几条就带走几条 */
  const exportLocal = () => {
    if (!groups.length || busy) return;
    const text = buildReviewLocalExport({ groups, range, now });
    downloadText(tr('待办导出-{date}.md', { date: dateKey() }), text);
    toast(tr('已导出 {n} 条到本地', { n: selectedTasks.length }), 'success');
  };

  if (saved) {
    return createPortal(
      <div className="overlay">
        <div className="modal rv-saved" role="dialog" aria-modal="true" aria-label={tr('已写入日记')}>
          <div className="modal-head">
            <div className="modal-title">{tr('已写入日记')}</div>
            <button className="icon-btn" onClick={onClose} title={tr('关闭')}>
              <X size={16} />
            </button>
          </div>
          <div className="rv-saved-body">
            <div className="rv-saved-icon">
              <Check size={20} strokeWidth={2.2} />
            </div>
            <div className="rv-saved-headline">
              {tr('已追加 {n} 条到「{title}」', { n: saved.count, title: dailyTitleOf(saved.key) })}
            </div>
            <div className="rv-saved-desc">{tr('文件保存在笔记库的以下位置：')}</div>
            <div className="rv-saved-path">
              <FolderOpen size={14} />
              <code title={saved.path}>{saved.path || dailyPath}</code>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn btn-ghost" onClick={onClose}>
              {tr('关闭')}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => {
                onClose();
                void openDaily(saved.key);
              }}
            >
              {tr('打开日记')}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="overlay">
      <div className="modal rv-modal" role="dialog" aria-modal="true" aria-label={tr('AI 总结待办')}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{tr('AI 总结')}</div>
            <div className="modal-desc">{tr('勾选这段时间完成的待办，整理后追加到今天的日记，也可以让 AI 写一段小结。')}</div>
          </div>
          <button className="icon-btn" onClick={onClose} title={tr('关闭')} disabled={busy}>
            <X size={16} />
          </button>
        </div>

        <div className="rv-body">
          <div className="rv-ranges">
            {REVIEW_RANGES.map((r) => {
              const count = completedInRange(tasks, r, now).length;
              return (
                <button key={r} className={cn('rv-range', range === r && 'on')} onClick={() => setRange(r)}>
                  {tr(REVIEW_RANGE_LABEL[r])}
                  <em>{count}</em>
                </button>
              );
            })}
          </div>

          <div className="rv-toolbar">
            <span>
              {tr('已完成 · 已选')} <strong>{selectedTasks.length}</strong> / {candidates.length}
            </span>
            <button className="rv-all" onClick={toggleAll} disabled={!candidates.length}>
              {allSelected ? tr('取消全选') : tr('全选')}
            </button>
          </div>

          <div className="rv-list">
            {candidates.length === 0 ? (
              <div className="rv-empty">
                <Check size={32} strokeWidth={1.5} />
                <div className="e1">{tr('这段时间还没有完成的待办')}</div>
                <div className="e2">{tr('勾掉几条之后再来回顾，成果会更有分量。')}</div>
              </div>
            ) : (
              candidateGroups.map((group) => (
                <div className="rv-group" key={group.name || '__none'}>
                  <div className="rv-group-head">
                    <span
                      className="cat-dot"
                      style={{ background: group.name ? categoryColor(group.name, categories) : 'var(--text-3)' }}
                    />
                    <span>{group.name || tr('未分类')}</span>
                    <em>{group.items.length}</em>
                  </div>
                  {group.items.map((task) => {
                    const checked = selected.has(task.id);
                    const wasExported = exportedSet.has(reviewExportKey(task));
                    return (
                      <button
                        key={task.id}
                        className={cn('rv-row', checked && 'on')}
                        role="checkbox"
                        aria-checked={checked}
                        onClick={() => toggleOne(task.id)}
                      >
                        <span className={cn('rv-check', checked && 'on')}>
                          {checked && <Check size={12} strokeWidth={2.5} />}
                        </span>
                        <span className="rv-title">{taskTitle(task)}</span>
                        {wasExported && <span className="rv-badge">{tr('已导出')}</span>}
                        <span className="rv-time">{timeLabel(task)}</span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          <div className={cn('rv-ai', !aiOk && 'unset')}>
            <button
              className={cn('rv-switch', aiOn && 'on')}
              role="switch"
              aria-checked={aiOn}
              aria-label={tr('导出时附带 AI 小结')}
              onClick={() => {
                if (aiOn) {
                  setAiOn(false);
                  return;
                }
                if (!aiOk) {
                  setAiPrompt(true);
                  return;
                }
                setAiOn(true);
              }}
            >
              <span />
            </button>
            <div className="rv-ai-main">
              <div className="rv-ai-title">
                <Sparkles size={14} />
                {tr('附带 AI 小结')}
              </div>
              <div className="rv-ai-sub">
                {aiOk
                  ? tr('默认关闭；打开后根据完成的条目写 2–4 句小结，只放在这篇回顾里。')
                  : tr('默认关闭；打开开关时会提醒先配置模型。')}
              </div>
            </div>
            {!aiOk && (
              <button
                className="rv-ai-link"
                onClick={() => {
                  onClose();
                  setSettings(true, 'ai');
                }}
              >
                {tr('去设置')}
                <ArrowUpRight size={12} />
              </button>
            )}
          </div>
        </div>

        <div className="modal-foot rv-foot">
          <div className="rv-dest">
            <FolderOpen size={14} />
            <div className="rv-dest-main">
              <div className="rv-dest-line">
                <span className="rv-dest-label">{tr('保存到')}</span>
                <code className="rv-dest-path" title={tr('笔记库/{path}', { path: dailyPath })}>
                  {dailyPath}
                </code>
              </div>
              <div className="rv-dest-hint">
                {existingDaily ? tr('今天的日记已存在，追加到末尾') : tr('今天还没有日记，会自动新建')}
                {diaryMissing ? tr(' · 「日记」笔记本不存在，写入时会自动重建') : ''}
              </div>
            </div>
          </div>
          <div className="rv-actions">
            <button
              className="btn btn-secondary"
              onClick={exportLocal}
              disabled={busy || !groups.length}
              title={tr('把勾选的待办（含备注）下载为 Markdown，不写入日记')}
            >
              <Download size={14} /> {tr('导出选中')}
            </button>
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
              {tr('取消')}
            </button>
            <button className="btn btn-primary" onClick={() => void runExport()} disabled={busy || !groups.length}>
              {busy
                ? aiOn && aiOk
                  ? tr('生成小结并写入…')
                  : tr('写入日记…')
                : aiOn && aiOk
                  ? tr('AI 总结并写入 · {n} 条', { n: selectedTasks.length })
                  : tr('写入日记 · {n} 条', { n: selectedTasks.length })}
            </button>
          </div>
        </div>
      </div>
      {aiPrompt && (
        <ConfirmDialog
          title={tr('还没有配置 AI 模型')}
          desc={tr('「附带 AI 小结」需要先配置模型服务；不配置也可以正常把待办写入日记。')}
          confirmLabel={tr('去设置')}
          cancelLabel={tr('知道了')}
          onCancel={() => setAiPrompt(false)}
          onConfirm={() => {
            setAiPrompt(false);
            onClose();
            setSettings(true, 'ai');
          }}
        />
      )}
    </div>,
    document.body,
  );
}
