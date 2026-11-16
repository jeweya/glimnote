import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { useT } from '../lib/i18n';

interface Props {
  title: string;
  desc?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  title,
  desc,
  confirmLabel,
  cancelLabel,
  danger = false,
  onCancel,
  onConfirm,
}: Props) {
  const tr = useT();
  const confirmText = confirmLabel ?? tr('确认');
  const cancelText = cancelLabel ?? tr('取消');
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
        onConfirm();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel, onConfirm]);

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
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onCancel}>
            {cancelText}
          </button>
          <button className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
