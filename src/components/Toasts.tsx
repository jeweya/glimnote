import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import { useApp } from '../store/app';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18n';

export function Toasts() {
  const tr = useT();
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  if (!toasts.length) return null;

  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={cn('toast', t.kind)} role="status">
          {t.busy ? (
            <Loader2 size={16} className="spin" style={{ color: 'var(--text-3)' }} />
          ) : t.kind === 'success' ? (
            <CheckCircle2 size={16} style={{ color: 'var(--success)' }} />
          ) : t.kind === 'warn' || t.kind === 'error' ? (
            <AlertTriangle size={16} style={{ color: t.kind === 'error' ? 'var(--danger)' : 'var(--warning)' }} />
          ) : (
            <Info size={16} style={{ color: 'var(--info)' }} />
          )}
          <span className="t-text">{t.text}</span>
          {t.action && (
            <button
              className="t-action"
              onClick={() => {
                t.action?.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          {t.alt && (
            <button
              className="t-action t-alt"
              onClick={() => {
                t.alt?.run();
                dismiss(t.id);
              }}
            >
              {t.alt.label}
            </button>
          )}
          <button className="icon-btn" style={{ width: 20, height: 20 }} onClick={() => dismiss(t.id)} title={tr('关闭')}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
