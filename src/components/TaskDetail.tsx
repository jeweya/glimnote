import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Ban, Check, ChevronRight, Clock, Link2, MoreHorizontal, Plus, Repeat, SkipForward, Trash2, X } from 'lucide-react';
import { useApp } from '../store/app';
import {
  NOTIFY_CHANNEL_LABEL,
  OPEN_STATUSES,
  PRIORITY_LABEL,
  STATUS_LABEL,
  TASK_NOTIFY_CHANNELS,
  dueFullLabel,
  parseTagsInput,
  remindBeforeLabel,
  repeatSummary,
  type TaskPriority,
} from '../lib/tasks';
import { notifyConfigured } from '../lib/taskNotify';
import {
  cachedCloudPushConfig,
  readCloudPushConfig,
  type CloudPushConfig,
} from '../lib/cloudPush';
import { cn, fullDate, timeKey } from '../lib/utils';
import { Menu, type MenuEntry } from './Menu';
import { DatePicker } from './DatePicker';
import { TimePicker } from './TimePicker';
import { NotePicker } from './NotePicker';
import { TaskRepeatDialog } from './TaskRepeatDialog';
import { ConfirmDialog } from './Confirm';
import { useT } from '../lib/i18n';

export function TaskDetail() {
  const tasks = useApp((s) => s.tasks);
  const id = useApp((s) => s.currentTaskId);
  const notes = useApp((s) => s.notes);
  const categories = useApp((s) => s.categories);
  const patchTask = useApp((s) => s.patchTask);
  const toggleTask = useApp((s) => s.toggleTask);
  const skipTask = useApp((s) => s.skipTask);
  const endTaskRepeat = useApp((s) => s.endTaskRepeat);
  const removeTask = useApp((s) => s.removeTask);
  const select = useApp((s) => s.select);
  const setView = useApp((s) => s.setView);
  const toast = useApp((s) => s.toast);
  const setSettings = useApp((s) => s.setSettings);
  // 分类弹窗统一由 TaskPanel 渲染（两个面板同时挂载，这里再渲染会出现两份）
  const openCatModal = useApp((s) => s.openTaskCategoryModal);
  const gitCfg = useApp((s) => s.cfg);
  const tr = useT();

  // GitHub 与 GitCode 都有可用的平台定时流水线；其他平台不显示入口，避免配了也不会执行
  const cloudSupported = gitCfg?.provider === 'github' || gitCfg?.provider === 'gitcode';
  const task = tasks.find((t) => t.id === id) || null;
  const [draft, setDraft] = useState('');
  const [tagInput, setTagInput] = useState(false);
  const [tagValue, setTagValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [datePop, setDatePop] = useState<{ x: number; y: number } | null>(null);
  const [timePop, setTimePop] = useState<{ x: number; y: number } | null>(null);
  const [notePop, setNotePop] = useState<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const [cloudWarnOpen, setCloudWarnOpen] = useState(false);
  // Webhook 存在 localStorage，React 感知不到变化；设置里保存后靠这个事件刷新「未配置」标记
  const [, bumpNotifyPref] = useState(0);
  const [cloudCfg, setCloudCfg] = useState<CloudPushConfig>(() => cachedCloudPushConfig());
  const saveTimer = useRef<number>(0);

  useEffect(() => {
    setDraft(task?.title || '');
    setTagInput(false);
    setTagValue('');
  }, [task?.id]);

  useEffect(() => {
    const onPref = () => bumpNotifyPref((v) => v + 1);
    window.addEventListener('glimnote:notify-pref', onPref);
    return () => window.removeEventListener('glimnote:notify-pref', onPref);
  }, []);

  // 云端推送配置写在仓库文件里；设置页保存后靠事件把这里的规则文字一起刷新
  useEffect(() => {
    void readCloudPushConfig();
    const onCfg = () => setCloudCfg(cachedCloudPushConfig());
    window.addEventListener('glimnote:cloud-push-changed', onCfg);
    return () => window.removeEventListener('glimnote:cloud-push-changed', onCfg);
  }, []);

  useEffect(() => () => window.clearTimeout(saveTimer.current), []);

  const markSaving = () => {
    setSaving(true);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => setSaving(false), 520);
  };

  if (!task) {
    return (
      <section className="task-detail">
        <div className="task-detail-empty">
          <div className="td-empty-mark">
            <Check size={20} strokeWidth={1.75} />
          </div>
          <div className="big">{tr('选一条待办')}</div>
          <div className="hint">{tr('或者在上面的输入框里加一条。')}</div>
        </div>
      </section>
    );
  }

  const done = task.status === 'done';
  const linked = task.noteId ? notes.find((n) => n.id === task.noteId) : null;
  const linkedLabel = linked ? linked.title : task.noteTitle || '';

  const commitTitle = () => {
    const clean = draft.trim();
    if (!clean) {
      setDraft(tr('未命名待办'));
      patchTask(task.id, { title: tr('未命名待办') }, true);
      return;
    }
    if (clean !== task.title) patchTask(task.id, { title: clean.slice(0, 200) }, true);
  };

  const addTag = () => {
    const next = parseTagsInput(tagValue);
    if (next.length) {
      patchTask(task.id, { tags: [...new Set([...task.tags, ...next])] });
    }
    setTagValue('');
    setTagInput(false);
  };

  const menuItems: (MenuEntry | 'sep')[] = [
    ...(linked
      ? [
          {
            label: tr('打开关联笔记'),
            icon: <Link2 size={14} />,
            onClick: () => {
              select(linked.id);
              setView({ type: 'notebook', value: linked.notebook });
            },
          },
          'sep' as const,
        ]
      : []),
    ...(task.repeat && !done
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
          'sep' as const,
        ]
      : []),
    {
      label: tr('删除待办'),
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => void removeTask(task.id),
    },
  ];

  return (
    <section className="task-detail">
      <div className="td-inner">
        <div className="td-head">
          <button
            className={cn('task-check big', done && 'on')}
            role="checkbox"
            aria-checked={done}
            aria-label={done ? tr('标记为未完成') : tr('标记为已完成')}
            onClick={() => {
              markSaving();
              void toggleTask(task.id);
            }}
          >
            {done && <Check size={14} strokeWidth={1.75} />}
          </button>
          <input
            className={cn('td-title', done && 'done')}
            value={draft}
            placeholder={tr('未命名待办')}
            onChange={(e) => {
              setDraft(e.target.value);
              patchTask(task.id, { title: e.target.value.slice(0, 200) }, true);
              markSaving();
            }}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <button
            className="icon-btn"
            title={tr('更多')}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.right - 160, y: r.bottom + 6 });
            }}
          >
            <MoreHorizontal size={16} />
          </button>
        </div>

        <div className="td-status">
          {done ? (
            <>
              {task.skippedAt
                ? tr('已跳过 · {date}', { date: fullDate(task.skippedAt) })
                : tr('完成于 {date}', { date: fullDate(task.doneAt || task.updated) })}
              <button
                onClick={() => {
                  markSaving();
                  // 走 toggleTask 才能回到完成前的状态（比如原来在跟进中）
                  void toggleTask(task.id);
                }}
              >
                {tr('取消完成')}
              </button>
            </>
          ) : (
            <>{tr('创建于 {date}', { date: fullDate(task.created) })}</>
          )}
        </div>

        <div className="td-fields">
          <div className="td-field">
            <span className="td-label">{tr('状态')}</span>
            {done ? (
              <span className="td-value-static muted">{tr(STATUS_LABEL.done)}</span>
            ) : (
              <div className="segment td-seg td-seg-status">
                {OPEN_STATUSES.map((st) => (
                  <button
                    key={st}
                    className={cn(task.status === st && 'on', st === 'doing' && 'doing')}
                    onClick={() => {
                      patchTask(task.id, { status: st });
                      markSaving();
                    }}
                  >
                    {tr(STATUS_LABEL[st])}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="td-field">
            <span className="td-label">{tr('分类')}</span>
            <div className="td-cats">
              {categories.map((cat) => {
                const active = task.category === cat.name;
                return (
                  <button
                    key={cat.name}
                    className={cn('td-cat', active && 'on')}
                    style={{ '--cat': cat.color } as CSSProperties}
                    title={active ? tr('再点一次取消分类') : tr('归到「{name}」', { name: cat.name })}
                    onClick={() => {
                      patchTask(task.id, { category: active ? undefined : cat.name });
                      markSaving();
                    }}
                  >
                    <span className="cat-dot" />
                    {cat.name}
                  </button>
                );
              })}
              <button
                className={cn('td-cat', 'none', !task.category && 'on')}
                onClick={() => {
                  patchTask(task.id, { category: undefined });
                  markSaving();
                }}
              >
                {tr('未分类')}
              </button>
              <button className="td-cat add" title={tr('管理分类')} onClick={openCatModal}>
                <Plus size={13} />
              </button>
            </div>
          </div>

          <div className="td-field">
            <span className="td-label">{tr('截止日期')}</span>
            <button
              className="td-value"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setDatePop({ x: r.left, y: r.bottom + 6 });
              }}
            >
              <span className={cn(!task.due && 'muted')}>{dueFullLabel(task.due, task.dueTime)}</span>
              <ChevronRight size={14} />
            </button>
          </div>

          <div className="td-field">
            <span className="td-label">{tr('到点提醒')}</span>
            {task.due ? (
              <div className="td-time">
                <button
                  className={cn('td-time-btn', !task.dueTime && 'muted')}
                  aria-label={tr('到点提醒时间')}
                  title={tr('点开选择时间，也可以直接输入时和分')}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setTimePop({ x: r.left, y: r.bottom + 6 });
                  }}
                >
                  <span>{task.dueTime || tr('选择时间')}</span>
                  <Clock size={14} />
                </button>
                {task.dueTime ? (
                  task.repeat ? (
                    <span className="td-time-hint">{tr('循环任务保留提醒时间')}</span>
                  ) : (
                    <button
                      className="td-time-clear"
                      title={tr('取消提醒时间')}
                      onClick={() => {
                        patchTask(task.id, { dueTime: undefined });
                        markSaving();
                      }}
                    >
                      <X size={13} />
                    </button>
                  )
                ) : (
                  <span className="td-time-hint">{tr('只到日期，不提醒')}</span>
                )}
              </div>
            ) : (
              <span className="td-value-static muted">{tr('先设截止日期')}</span>
            )}
          </div>

          <div className="td-field">
            <span className="td-label">{tr('循环')}</span>
            {done ? (
              <span className={cn('td-value-static', !task.repeat && 'muted')}>
                {task.repeat ? repeatSummary(task) : tr('不循环')}
              </span>
            ) : (
              <button className="td-value" onClick={() => setRepeatOpen(true)} title={tr('设置循环规则与提醒时间')}>
                <span className={cn(!task.repeat && 'muted')}>
                  {task.repeat ? repeatSummary(task) : tr('不循环')}
                </span>
                <Repeat size={14} />
              </button>
            )}
          </div>
          {task.remindBefore?.length ? (
            <div className="td-repeat-hint">
              {tr('提前提醒：{list}', {
                list: task.remindBefore.map((n) => tr('提前 {n}', { n: remindBeforeLabel(n) })).join('、'),
              })}
            </div>
          ) : null}

          <div className="td-field">
            <span className="td-label">{tr('本地通知')}</span>
            <div className="td-notify-wrap">
              <div className="td-notify">
                {TASK_NOTIFY_CHANNELS.map((channel) => {
                  const configured = notifyConfigured(channel);
                  const on = Boolean(task.notify?.includes(channel));
                  return (
                    <button
                      key={channel}
                      className={cn('td-notify-chip', on && 'on', !configured && 'off')}
                      aria-pressed={on}
                      title={
                        !configured
                          ? tr('先到「设置 → 通知」配置{channel} Webhook', { channel: tr(NOTIFY_CHANNEL_LABEL[channel]) })
                          : on
                            ? tr('到点时不再推送到这个群')
                            : tr('到点时把提醒推送到这个群')
                      }
                      onClick={() => {
                        if (!configured) {
                          setSettings(true, 'notify');
                          return;
                        }
                        const current = task.notify || [];
                        const next = on ? current.filter((c) => c !== channel) : [...current, channel];
                        patchTask(task.id, { notify: next.length ? next : undefined });
                        markSaving();
                      }}
                    >
                      <span className={cn('notify-dot', `ch-${channel}`)} />
                      {tr(NOTIFY_CHANNEL_LABEL[channel])}
                      {!configured && <span className="td-notify-tip">{tr('未配置')}</span>}
                    </button>
                  );
                })}
              </div>
              <div className="td-time-hint td-notify-hint">
                {task.dueTime
                  ? tr('到点后发送消息到配置的群；电脑关机或应用没运行时收不到')
                  : tr('先设到点时间，勾选的渠道才会生效；电脑关机或应用没运行时收不到')}
              </div>
            </div>
          </div>

          {cloudSupported && (
          <div className="td-field">
            <span className="td-label">{tr('云端推送')}</span>
            <div className="td-notify-wrap">
              <div className="td-notify">
                <button
                  className={cn('td-notify-chip', task.cloudPush && 'on', !cloudCfg.enabled && 'off')}
                  aria-pressed={Boolean(task.cloudPush)}
                  title={
                    !cloudCfg.enabled
                      ? tr('先到「设置 → 通知 → 云端推送」开启')
                      : task.cloudPush
                        ? tr('不再参与云端推送')
                        : tr('加入每天 {time} 的汇总消息', { time: cloudCfg.time })
                  }
                  onClick={() => {
                    if (!cloudCfg.enabled) {
                      setSettings(true, 'notify');
                      return;
                    }
                    if (!task.cloudPush && !task.due) {
                      toast(tr('先设截止日期，云端推送才有内容可推'), 'warn');
                      return;
                    }
                    if (!task.cloudPush) {
                      // 借用的是平台的免费定时任务，先把「可能延迟 / 失败 / 不是最新」说清楚
                      setCloudWarnOpen(true);
                      return;
                    }
                    patchTask(task.id, { cloudPush: undefined });
                    markSaving();
                  }}
                >
                  <span className="notify-dot ch-cloud" />
                  {tr('加入云端推送')}
                  {!cloudCfg.enabled && <span className="td-notify-tip">{tr('未开启')}</span>}
                </button>
              </div>
              <div className="td-time-hint td-notify-hint">
                {cloudCfg.enabled
                  ? tr('每天 {time} 额外推送一份从该时刻起 {hours} 小时内到期的待办汇总。', {
                      time: cloudCfg.time,
                      hours: cloudCfg.windowHours,
                    })
                  : tr('在「设置 → 通知」开启后，每天固定时间把勾选的待办汇总发到群里。')}
              </div>
            </div>
          </div>
          )}

          <div className="td-field">
            <span className="td-label">{tr('优先级')}</span>
            <div className="segment td-seg">
              {(['high', 'normal', 'low'] as TaskPriority[]).map((p) => (
                <button
                  key={p}
                  className={cn(task.priority === p && 'on')}
                  onClick={() => {
                    patchTask(task.id, { priority: p });
                    markSaving();
                  }}
                >
                  {tr(PRIORITY_LABEL[p])}
                </button>
              ))}
            </div>
          </div>

          <div className="td-field">
            <span className="td-label">{tr('标签')}</span>
            <div className="td-tags">
              {task.tags.map((t) => (
                <span className="tag-chip" key={t}>
                  #{t}
                  <button
                    className="td-tag-x"
                    title={tr('移除标签 #{tag}', { tag: t })}
                    onClick={() => patchTask(task.id, { tags: task.tags.filter((x) => x !== t) })}
                  >
                    <X size={14} />
                  </button>
                </span>
              ))}
              {tagInput ? (
                <input
                  className="td-tag-input"
                  autoFocus
                  value={tagValue}
                  placeholder={tr('标签名')}
                  onChange={(e) => setTagValue(e.target.value)}
                  onBlur={addTag}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addTag();
                    } else if (e.key === 'Escape') {
                      setTagValue('');
                      setTagInput(false);
                    }
                  }}
                />
              ) : (
                <button className="td-add" onClick={() => setTagInput(true)}>
                  <Plus size={14} /> {tr('标签')}
                </button>
              )}
            </div>
          </div>

          <div className="td-field">
            <span className="td-label">{tr('关联笔记')}</span>
            {task.noteId ? (
              <div className="td-linked">
                <span className={cn('td-value-static', !linked && 'muted')}>
                  {linkedLabel || tr('笔记')}
                  {!linked && tr('（已删除）')}
                </span>
                {linked && (
                  <button
                    className="icon-btn"
                    title={tr('打开笔记')}
                    onClick={() => {
                      select(linked.id);
                      setView({ type: 'notebook', value: linked.notebook });
                    }}
                  >
                    <ChevronRight size={14} />
                  </button>
                )}
                <button
                  className="icon-btn"
                  title={tr('解除关联')}
                  onClick={() => patchTask(task.id, { noteId: undefined, noteTitle: undefined })}
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <button
                className="td-value"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setNotePop({ x: r.left, y: r.bottom + 6 });
                }}
              >
                <span className="muted">{tr('关联一篇笔记')}</span>
                <ChevronRight size={14} />
              </button>
            )}
          </div>
        </div>

        <div className="td-notes">
          <div className="td-label">{tr('备注')}</div>
          <textarea
            value={task.notes}
            placeholder={tr('补充细节、链接或下一步…')}
            onChange={(e) => {
              patchTask(task.id, { notes: e.target.value }, true);
              markSaving();
            }}
          />
        </div>
      </div>

      <div className="editor-foot td-foot">
        <span>{tr('创建于 {date}', { date: fullDate(task.created) })}</span>
        <span className="grow" />
        <span className="saved">{saving ? tr('保存中…') : tr('已保存 {time}', { time: timeKey(new Date(task.updated)) })}</span>
        <span className="foot-tip">{tr('Markdown 文件')}</span>
      </div>

      {menu && <Menu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      {datePop && (
        <DatePicker
          value={task.due}
          x={datePop.x}
          y={datePop.y}
          onPick={(next) => {
            patchTask(task.id, { due: next });
            markSaving();
            setDatePop(null);
          }}
          onClose={() => setDatePop(null)}
        />
      )}

      {timePop && (
        <TimePicker
          value={task.dueTime}
          x={timePop.x}
          y={timePop.y}
          onPick={(next) => {
            patchTask(task.id, { dueTime: next });
            markSaving();
          }}
          onClose={() => setTimePop(null)}
        />
      )}

      {notePop && (
        <NotePicker
          notes={notes}
          x={notePop.x}
          y={notePop.y}
          onPick={(note) => {
            patchTask(task.id, { noteId: note.id, noteTitle: note.title });
            markSaving();
            setNotePop(null);
            toast(tr('已关联「{title}」', { title: note.title }), 'success');
          }}
          onClose={() => setNotePop(null)}
        />
      )}

      {cloudSupported && cloudWarnOpen && (
        <ConfirmDialog
          danger
          title={tr('云端推送可能不稳定')}
          desc={tr('它借用 Git 平台的免费定时任务：触发时间可能延迟，仓库长期没有活动时平台还可能暂停定时任务；摘要也只包含最后一次成功同步时的状态，不保证是最新的。请不要把它当作唯一提醒，重要任务仍以本机到点提醒为准。')}
          confirmLabel={tr('仍要加入')}
          onCancel={() => setCloudWarnOpen(false)}
          onConfirm={() => {
            patchTask(task.id, { cloudPush: true });
            markSaving();
            setCloudWarnOpen(false);
          }}
        />
      )}

      {repeatOpen && <TaskRepeatDialog task={task} onClose={() => setRepeatOpen(false)} />}
    </section>
  );
}
