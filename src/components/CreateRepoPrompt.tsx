import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../lib/i18n';
import { AlertTriangle, Cloud, Loader2, Lock, X } from 'lucide-react';
import { PROVIDERS, providerLabel, type Provider } from '../lib/git';

interface Props {
  provider: Provider;
  owner: string;
  repo: string;
  busy: '' | 'create' | 'connect';
  error: string;
  onCancel: () => void;
  onCreate: () => void;
}

/**
 * 校验令牌后发现仓库不存在时的确认弹窗。
 * 创建动作必须在这里完成：用户先看清「会建一个私有仓库」再点，避免校验一下就在账号里多出仓库。
 */
export function CreateRepoPrompt({ provider, owner, repo, busy, error, onCancel, onCreate }: Props) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  const tr = useT();

  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onCancel();
      }
      if (e.key === 'Enter' && !e.isComposing) {
        // 焦点在按钮上时交给按钮自己处理，避免「焦点在返回修改却触发创建」
        if ((document.activeElement as HTMLElement | null)?.tagName === 'BUTTON') return;
        e.stopPropagation();
        e.preventDefault();
        onCreate();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onCancel, onCreate]);

  const info = PROVIDERS[provider];

  return createPortal(
    <div className="overlay overlay-confirm" onClick={() => !busy && onCancel()}>
      <div
        className="modal repo-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="repo-prompt-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <div className="modal-title" id="repo-prompt-title">
              {tr('还没有这个仓库')}
            </div>
            <div className="modal-desc">
              {tr('令牌校验通过，但账号 {owner} 下还没有 {repo}。', { owner, repo })}
            </div>
          </div>
          <button className="icon-btn" onClick={onCancel} disabled={Boolean(busy)} title={tr('关闭')}>
            <X size={16} />
          </button>
        </div>

        <div className="repo-prompt-body">
          <p>{tr('可以直接创建一个私有仓库。笔记只写进你自己的 {provider} 账号，别人看不到，也不经过我们的服务器。', { provider: info.label })}</p>
          <div className="prompt-repo">
            <Lock size={14} />
            <span className="prompt-repo-name">
              {providerLabel(provider)} · {owner}/{repo}
            </span>
            <span className="tag-soft">{tr('私有 · 免费')}</span>
          </div>
          <p className="hint">{tr('创建后会自动初始化并连接，之后的修改几秒内自动同步。')}</p>
          {error && (
            <div className="prompt-error" role="alert">
              <AlertTriangle size={14} />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onCancel} disabled={Boolean(busy)}>
            {tr('返回修改')}
          </button>
          <button ref={primaryRef} className="btn btn-primary" onClick={onCreate} disabled={Boolean(busy)}>
            {busy ? <Loader2 size={14} className="spin" /> : <Cloud size={14} />}
            {busy === 'create' ? tr('正在创建…') : busy === 'connect' ? tr('正在连接…') : tr('创建私有仓库并连接')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
