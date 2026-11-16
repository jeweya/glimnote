import { useState } from 'react';
import { RotateCcw, Trash2, X } from 'lucide-react';
import { useApp } from '../store/app';
import { taskTitle } from '../lib/tasks';
import { friendlyTime } from '../lib/utils';
import { ConfirmDialog } from './Confirm';
import { useT } from '../lib/i18n';

/** 任务回收站：与笔记回收站分开，各自的恢复路径清晰 */
export function TaskTrashModal() {
  const open = useApp((s) => s.taskTrashOpen);
  const list = useApp((s) => s.taskTrash);
  const close = () => void useApp.getState().openTaskTrash(false);
  const restoreTask = useApp((s) => s.restoreTask);
  const purgeTask = useApp((s) => s.purgeTask);
  const emptyTaskTrash = useApp((s) => s.emptyTaskTrash);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const tr = useT();

  if (!open) return null;

  return (
    <div className="overlay" onClick={close}>
      <div className="task-trash" onClick={(e) => e.stopPropagation()}>
        <div className="task-trash-head">
          <div>
            <div className="tt-title">{tr('已删除的待办')}</div>
            <div className="tt-sub">{tr('保留 30 天 · {n} 条', { n: list.length })}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {list.length > 0 && (
              <button
                className="btn btn-ghost"
                style={{ height: 28, padding: '0 8px', fontSize: 12 }}
                onClick={() => setConfirmEmpty(true)}
              >
                {tr('清空')}
              </button>
            )}
            <button className="icon-btn" onClick={close} title={tr('关闭')}>
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="task-trash-list">
          {list.length === 0 ? (
            <div className="task-trash-empty">
              <Trash2 size={40} strokeWidth={1.75} />
              <span>{tr('回收站是空的')}</span>
            </div>
          ) : (
            list.map((task) => (
              <div className="task-trash-row" key={task.id}>
                <div className="tt-main">
                  <span className="tt-name">{taskTitle(task)}</span>
                  <span className="tt-time">{tr('删除于 {time}', { time: friendlyTime(task.deletedAt || task.updated) })}</span>
                </div>
                <button className="icon-btn" title={tr('恢复')} onClick={() => void restoreTask(task.id)}>
                  <RotateCcw size={14} />
                </button>
                <button className="icon-btn" title={tr('永久删除')} onClick={() => void purgeTask(task.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {confirmEmpty && (
        <ConfirmDialog
          title={tr('清空任务回收站？')}
          desc={tr('这些待办会从所有设备上永久删除，无法恢复。')}
          confirmLabel={tr('永久删除')}
          danger
          onCancel={() => setConfirmEmpty(false)}
          onConfirm={() => {
            setConfirmEmpty(false);
            void emptyTaskTrash();
          }}
        />
      )}
    </div>
  );
}
