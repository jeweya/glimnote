import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, KeyRound, Lock, LockOpen } from 'lucide-react';
import { useApp } from '../store/app';
import { privacyKeyOf, usePrivacy, type PrivacyRequest } from '../store/privacy';
import { hasPasswordLock, verifyPassword } from '../lib/lock';
import {
  PRIVACY_PASSWORD_MIN,
  hasPrivacyPassword,
  setupPrivacyPassword,
  verifyPrivacyPassword,
} from '../lib/privacyAuth';
import { cn } from '../lib/utils';
import { useT } from '../lib/i18n';

const TITLES: Record<PrivacyRequest['mode'], string> = {
  lock: '开启隐私锁',
  remove: '解除隐私锁',
  open: '解锁查看',
};

/**
 * 隐私锁的密码确认框。
 * 使用独立的隐私密码，不需要先开启应用密码锁；加锁后默认就是锁住的。
 * 打开 / 解除锁需要验证密码，单纯的「开启隐私锁」不再重复输密码。
 * 表单型弹窗，只认 Esc 和 ×，点遮罩不关，避免输到一半被误关。
 */
export function PrivacyDialog() {
  const request = usePrivacy((s) => s.request);
  if (!request) return null;
  return createPortal(<PrivacyDialogBody request={request} />, document.body);
}

function PrivacyDialogBody({ request }: { request: PrivacyRequest }) {
  const tr = useT();
  const close = usePrivacy((s) => s.close);
  const unlockKey = usePrivacy((s) => s.unlockKey);
  const addNoteLock = usePrivacy((s) => s.addNoteLock);
  const removeNoteLock = usePrivacy((s) => s.removeNoteLock);
  const addFolderLock = usePrivacy((s) => s.addFolderLock);
  const removeFolderLock = usePrivacy((s) => s.removeFolderLock);
  const select = useApp((s) => s.select);
  const setView = useApp((s) => s.setView);
  const toast = useApp((s) => s.toast);

  const [enabled, setEnabled] = useState(() => hasPrivacyPassword());
  const needSetup = request.mode === 'lock' && !enabled;
  // 旧版本把应用密码当作隐私密码；这里保留一次兼容，避免升级后旧锁打不开
  const canLegacy = !enabled && request.mode !== 'lock' && hasPasswordLock();
  // 仓库里带着锁、但密码没同步过来（手改文件 / 更早的仓库）时给一句明确提示，不要让人反复输密码
  const noPassword = !enabled && !canLegacy && request.mode !== 'lock';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [show, setShow] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);

  const finishLock = () => {
    if (request.kind === 'note') {
      addNoteLock(request.target);
      select(request.target);
      toast(tr('已给这篇笔记加锁，离开后会自动重新上锁'), 'success');
    } else {
      addFolderLock(request.target);
      setView({ type: 'notebook', value: request.target });
      const state = useApp.getState();
      const cur = state.current;
      const inside = (path: string) => path === request.target || path.startsWith(`${request.target}/`);
      if (!cur || !inside(cur.notebook || '')) {
        const first = state.notes.find((n) => inside(n.notebook || ''));
        if (first) select(first.id);
      }
      toast(tr('已给这个笔记本加锁，离开后会自动重新上锁'), 'success');
    }
    close();
  };

  const finishRemove = () => {
    if (request.kind === 'note') removeNoteLock(request.target);
    else removeFolderLock(request.target);
    toast(tr('隐私锁已解除'), 'info');
    close();
  };

  const finishOpen = () => {
    unlockKey(privacyKeyOf(request));
    if (request.kind === 'note') {
      select(request.target);
      // 从回收站里解锁时留在回收站，别把用户甩到笔记本视图
      const inTrash = useApp.getState().trash.some((n) => n.id === request.target);
      if (!inTrash && request.notebook) setView({ type: 'notebook', value: request.notebook });
    } else {
      setView({ type: 'notebook', value: request.target });
    }
    close();
  };

  const submit = async () => {
    if (busy) return;
    setErr('');
    if (request.mode === 'lock' && !needSetup) {
      finishLock();
      return;
    }
    if (needSetup) {
      if (pw.length < PRIVACY_PASSWORD_MIN) {
        setErr(tr('隐私密码至少 {n} 位', { n: PRIVACY_PASSWORD_MIN }));
        inputRef.current?.focus();
        return;
      }
      if (pw !== pw2) {
        setErr(tr('两次输入的隐私密码不一致'));
        inputRef.current?.focus();
        return;
      }
      setBusy(true);
      try {
        await setupPrivacyPassword(pw);
        setEnabled(true);
        toast(tr('隐私密码已设置'), 'success');
        finishLock();
      } catch (e) {
        setErr((e as Error)?.message || tr('设置失败'));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!pw) {
      setErr(tr('请输入隐私密码'));
      inputRef.current?.focus();
      return;
    }
    if (noPassword) {
      setErr(tr('这台设备还没有隐私密码，无法验证这把锁。请先在「设置 → 安全」里设置隐私密码，或者连接仓库同步一次。'));
      return;
    }
    setBusy(true);
    try {
      let ok = await verifyPrivacyPassword(pw);
      if (!ok && canLegacy) ok = await verifyPassword(pw);
      if (!ok) {
        setErr(tr('隐私密码不对，再试一次'));
        setPw('');
        inputRef.current?.focus();
        return;
      }
      if (request.mode === 'remove') finishRemove();
      else finishOpen();
    } catch (e) {
      setErr((e as Error)?.message || tr('操作失败'));
    } finally {
      setBusy(false);
    }
  };

  const title = needSetup ? tr('设置隐私密码') : tr(TITLES[request.mode]);
  const target = request.label || tr('这篇笔记');
  const setupSuffix = tr(
    '先设置一个隐私密码，它独立于应用密码锁，不用开启应用锁。设置后立即锁定，离开当前笔记或页面会自动重新上锁。密码的盐和哈希会随 Git 同步，多台设备使用同一个隐私密码。',
  );
  const desc = noPassword
    ? tr('这台设备还没有隐私密码，无法验证这把锁。请先在「设置 → 安全」里设置隐私密码，或者连接仓库同步一次。')
    : needSetup
    ? (request.kind === 'note'
        ? tr('将给「{name}」加锁。', { name: target })
        : tr('将给笔记本「{name}」加锁。', { name: target })) + setupSuffix
    : request.mode === 'lock'
      ? request.kind === 'note'
        ? tr('将给「{name}」加锁。加锁后默认就是锁住的，解锁一次只在当前笔记有效，切走会自动重新上锁。', { name: target })
        : tr('将给笔记本「{name}」加锁，里面的笔记默认都需要隐私密码；离开这个笔记本后会自动重新上锁。', { name: target })
      : request.mode === 'remove'
        ? request.kind === 'note'
          ? tr('解除后，这篇笔记不再需要隐私密码。')
          : tr('解除后，笔记本「{name}」里的笔记不再需要隐私密码。', { name: target })
        : tr('输入隐私密码后查看。离开当前笔记或页面会自动重新上锁。');
  const confirmLabel =
    request.mode === 'lock' ? (needSetup ? tr('设置并锁定') : tr('开启')) : request.mode === 'remove' ? tr('解除') : tr('解锁');

  return (
    <div className="overlay overlay-confirm privacy-overlay">
      <div className="modal privacy-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="privacy-head">
          <span className={cn('privacy-emblem', request.mode === 'remove' ? 'is-open' : '')}>
            {request.mode === 'remove' ? <LockOpen size={20} /> : <Lock size={20} />}
          </span>
          <div>
            <div className="privacy-title">{title}</div>
            <div className="privacy-desc">{desc}</div>
          </div>
          <button className="privacy-x" aria-label={tr('关闭')} onClick={close}>
            ×
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {needSetup && (
            <>
              <div className="privacy-field">
                <KeyRound size={15} strokeWidth={1.8} />
                <input
                  ref={inputRef}
                  type={show ? 'text' : 'password'}
                  value={pw}
                  placeholder={tr('设置隐私密码（至少 {n} 位）', { n: PRIVACY_PASSWORD_MIN })}
                  autoComplete="new-password"
                  onChange={(e) => {
                    setPw(e.target.value);
                    if (err) setErr('');
                  }}
                />
                <button
                  type="button"
                  className="privacy-eye"
                  aria-label={show ? tr('隐藏密码') : tr('显示密码')}
                  onClick={() => setShow((v) => !v)}
                >
                  {show ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <div className="privacy-field">
                <KeyRound size={15} strokeWidth={1.8} />
                <input
                  type={show ? 'text' : 'password'}
                  value={pw2}
                  placeholder={tr('再输一次隐私密码')}
                  autoComplete="new-password"
                  onChange={(e) => {
                    setPw2(e.target.value);
                    if (err) setErr('');
                  }}
                />
              </div>
            </>
          )}

          {!needSetup && request.mode !== 'lock' && (
            <div className="privacy-field">
              <KeyRound size={15} strokeWidth={1.8} />
              <input
                ref={inputRef}
                type={show ? 'text' : 'password'}
                value={pw}
                placeholder={tr('输入隐私密码')}
                autoComplete="current-password"
                onChange={(e) => {
                  setPw(e.target.value);
                  if (err) setErr('');
                }}
              />
              <button
                type="button"
                className="privacy-eye"
                aria-label={show ? tr('隐藏密码') : tr('显示密码')}
                onClick={() => setShow((v) => !v)}
              >
                {show ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          )}

          {err && <div className="privacy-err">{err}</div>}
          <div className="privacy-note">
            <Lock size={12} strokeWidth={1.8} />
            {canLegacy
              ? tr('旧版隐私锁也可以用应用密码解锁；本机设置，不写进笔记文件。')
              : tr('锁列表和密码哈希会随 Git 同步到其他设备；笔记正文仍是明文。')}
          </div>
          <div className="privacy-actions">
            <button type="button" className="btn btn-ghost" onClick={close}>
              {tr('取消')}
            </button>
            <button
              type="submit"
              className={cn('btn', request.mode === 'remove' ? 'btn-danger' : 'btn-primary')}
              disabled={busy}
            >
              {busy ? tr('验证中…') : confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** 编辑器里的遮罩：锁着的时候不挂载任何正文组件，避免内容出现在 DOM 里 */
export function PrivacyGate({ onBack }: { onBack: () => void }) {
  const tr = useT();
  const requestOpenNote = usePrivacy((s) => s.requestOpenNote);
  return (
    <div className="privacy-gate">
      <span className="privacy-emblem">
        <Lock size={22} />
      </span>
      <h2>{tr('这篇笔记已锁定')}</h2>
      <p>{tr('输入隐私密码后显示内容。离开这篇笔记或当前页面后会自动重新锁上。')}</p>
      <div className="privacy-gate-actions">
        <button className="btn btn-ghost" onClick={onBack}>
          {tr('返回列表')}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => {
            const id = useApp.getState().current?.id;
            if (id) requestOpenNote(id, useApp.getState().current?.notebook || '');
          }}
        >
          <LockOpen size={14} /> {tr('解锁查看')}
        </button>
      </div>
    </div>
  );
}
