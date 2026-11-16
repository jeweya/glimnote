import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import { HOME_COLORS, type HomeColor, type HomeGroup } from '../lib/home';
import { HOME_ICON_OPTIONS, iconFor } from './homeIcons';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18n';

interface EditProps {
  open: boolean;
  group?: HomeGroup | null;
  onClose: () => void;
  onSave: (input: { name: string; icon?: string; color?: HomeColor }) => Promise<void>;
}

export function HomeGroupDialog({ open, group, onClose, onSave }: EditProps) {
  const tr = useT();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('folder');
  const [color, setColor] = useState<HomeColor>('green');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(group?.name || '');
    setIcon(group?.icon || 'folder');
    setColor(group?.color || 'green');
    setBusy(false);
    setError('');
  }, [open, group]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const submit = async () => {
    if (!name.trim()) {
      setError(tr('分组名称不能为空'));
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSave({ name: name.trim(), icon, color });
      onClose();
    } catch (e) {
      setError((e as Error).message || tr('保存失败'));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="overlay">
      <div className="modal home-dialog" role="dialog" aria-modal="true" aria-label={group ? tr('编辑分组') : tr('新建分组')}>
        <div className="modal-head">
          <div>
            <div className="modal-title">{group ? tr('编辑分组') : tr('新建分组')}</div>
            <div className="modal-desc">{tr('分组只影响首页的摆放，不会改变笔记的笔记本。')}</div>
          </div>
          <button className="icon-btn" onClick={onClose} disabled={busy} aria-label={tr('关闭')}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body home-dialog-body">
          <div className="field">
            <label>{tr('名称')}</label>
            <input
              className="input"
              value={name}
              maxLength={40}
              autoFocus
              placeholder={tr('例如：工作、学习、常用工具')}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit();
              }}
            />
          </div>
          <div className="field">
            <label>{tr('图标')}</label>
            <div className="home-icon-grid">
              {HOME_ICON_OPTIONS.map((key) => {
                const Icon = iconFor(key, 'folder');
                return (
                  <button
                    key={key}
                    type="button"
                    className={cn('home-icon-btn', icon === key && 'on')}
                    title={key}
                    aria-label={key}
                    onClick={() => setIcon(key)}
                  >
                    <Icon size={16} strokeWidth={1.75} />
                  </button>
                );
              })}
            </div>
          </div>
          <div className="field">
            <label>{tr('颜色')}</label>
            <div className="home-color-row">
              {HOME_COLORS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={cn('home-color-dot', `hc-${value}`, color === value && 'on')}
                  title={value}
                  aria-label={value}
                  onClick={() => setColor(value)}
                />
              ))}
            </div>
          </div>
          {error && <div className="home-form-error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {tr('取消')}
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? tr('保存中…') : tr('保存')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface DeleteProps {
  open: boolean;
  group?: HomeGroup | null;
  moveTarget?: string;
  entryCount: number;
  onCancel: () => void;
  onMove: () => Promise<void>;
  onDelete: () => Promise<void>;
}

export function HomeGroupDeleteDialog({
  open,
  group,
  moveTarget,
  entryCount,
  onCancel,
  onMove,
  onDelete,
}: DeleteProps) {
  const tr = useT();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setBusy(false);
  }, [open]);
  if (!open || !group) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="overlay">
      <div
        className="modal home-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={tr('删除分组')}
        style={{ width: 460 }}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <AlertTriangle size={16} style={{ color: 'var(--warning)' }} />
              {tr('删除分组「{name}」', { name: group.name })}
            </div>
            <div className="modal-desc">
              {tr('这个分组里有 {n} 个入口。可以只删除分组、把入口移到「{target}」，也可以连同入口一起删除。', {
                n: entryCount,
                target: moveTarget || tr('第一个分组'),
              })}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            {tr('取消')}
          </button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => void run(onMove)}>
            {tr('移到「{target}」', { target: moveTarget || tr('第一个分组') })}
          </button>
          <button className="btn btn-danger" disabled={busy} onClick={() => void run(onDelete)}>
            {tr('连同入口删除')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
