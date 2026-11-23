import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { useT } from '../lib/i18n';

interface Props {
  title: string;
  desc?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /** 底部按钮上方的勾选项，例如「不再提醒」 */
  checkLabel?: string;
  checkDefault?: boolean;
  /** 确认时带上勾选状态，方便调用方决定要不要记住 */
  onCancel: () => void;
  onConfirm: (checked: boolean) => void;
}

export function ConfirmDialog({
  title,
  desc,
  confirmLabel,
  cancelLabel,
  danger = false,
  checkLabel,
  checkDefault = false,
  onCancel,
  onConfirm,
}: Props) {
  const tr = useT();
  const confirmText = confirmLabel ?? tr('确认');
  const cancelText = cancelLabel ?? tr('取消');
  const [checked, setChecked] = useState(checkDefault);
  useEffect(() => {
    // 用捕获阶段拦下 Esc/Enter，避免同时触发下层的弹窗快捷键
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onCancel();
      }
      if (e.key === 'Enter' && !e.isComposing) {
        e.stopPropagation();
        e.preventDefault();
        onConfirm(checked);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel, onConfirm, checked]);

  return createPortal(
    <div className="overlay overlay-confirm" onClick={onCancel}>
      <div
        className="modal"
        role="alertdialog"
        aria-modal="true"
        style={{ width: 420 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              {danger && <AlertTriangle size={16} style={{ color: 'var(--warning)' }} />}
              {title}
            </div>
            {desc && <div className="modal-desc">{desc}</div>}
          </div>
        </div>
        {checkLabel && (
          <div className="modal-check">
            <label className="invite-never">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              <span>{checkLabel}</span>
            </label>
          </div>
        )}
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onCancel}>
            {cancelText}
          </button>
          <button className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={() => onConfirm(checked)}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
