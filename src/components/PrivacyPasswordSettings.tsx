import { useState } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { useApp } from '../store/app';
import { usePrivacy } from '../store/privacy';
import {
  PRIVACY_PASSWORD_MIN,
  changePrivacyPassword,
  hasPrivacyPassword,
  privacyPasswordCreatedAt,
  removePrivacyPassword,
  setupPrivacyPassword,
} from '../lib/privacyAuth';
import { useT } from '../lib/i18n';

type Mode = 'set' | 'change' | 'disable';

/**
 * 设置 → 安全：隐私密码的独立管理。
 * 和应用密码锁互不影响；关闭隐私密码时会把所有隐私锁一并解除，避免留下再也打不开的笔记。
 */
export function PrivacyPasswordSettings() {
  const tr = useT();
  const toast = useApp((s) => s.toast);
  const [enabled, setEnabled] = useState(() => hasPrivacyPassword());
  const [createdAt, setCreatedAt] = useState(() => privacyPasswordCreatedAt());
  const [mode, setMode] = useState<Mode | null>(null);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setMode(null);
    setCur('');
    setNext('');
    setNext2('');
    setErr('');
  };

  const submit = async () => {
    if (busy || !mode) return;
    setErr('');
    setBusy(true);
    try {
      if (mode === 'disable') {
        await removePrivacyPassword(cur);
        usePrivacy.getState().clearAll();
        setEnabled(false);
        setCreatedAt(null);
        reset();
        toast(tr('隐私密码已关闭，所有隐私锁已解除'), 'info');
        return;
      }
      if (next.length < PRIVACY_PASSWORD_MIN) {
        setErr(tr('隐私密码至少 {n} 位', { n: PRIVACY_PASSWORD_MIN }));
        return;
      }
      if (next !== next2) {
        setErr(tr('两次输入的隐私密码不一致'));
        return;
      }
      if (mode === 'change') await changePrivacyPassword(cur, next);
      else await setupPrivacyPassword(next);
      // 改密码后本次会话里的解锁状态全部作废，确保新密码立即生效
      usePrivacy.getState().relockAll();
      setEnabled(true);
      setCreatedAt(privacyPasswordCreatedAt());
      reset();
      toast(mode === 'change' ? tr('隐私密码已修改，已重新上锁') : tr('隐私密码已设置'), 'success');
    } catch (e) {
      setErr((e as Error).message || tr('操作失败'));
    } finally {
      setBusy(false);
    }
  };

  const since = createdAt ? new Date(createdAt).toLocaleDateString('zh-CN') : '';
  const formTitle = mode === 'set' ? tr('设置隐私密码') : mode === 'change' ? tr('修改隐私密码') : tr('关闭隐私密码');

  return (
    <>
      <div className="set-section-title">{tr('隐私锁密码')}</div>
      <div className="set-row">
        <div>
          <div className="set-label">{enabled ? tr('已设置{since}', { since: since ? tr(' · {date} 创建', { date: since }) : '' }) : tr('未设置')}</div>
          <div className="set-desc">
            {tr('用于打开加了隐私锁的笔记和笔记本，和应用密码锁互相独立，不开启应用锁也能使用。')}
            {tr('解锁后切到其他笔记或页面会自动重新锁上。锁列表和密码哈希会随 Git 同步，多台设备使用同一个隐私密码；笔记正文不会因此加密。')}
          </div>
        </div>
        <div className="set-actions">
          <button
            className="btn btn-primary"
            onClick={() => {
              setMode(enabled ? 'change' : 'set');
              setErr('');
            }}
          >
            <KeyRound size={14} /> {enabled ? tr('修改密码') : tr('设置密码')}
          </button>
          {enabled && (
            <button
              className="btn btn-secondary"
              onClick={() => {
                setMode('disable');
                setErr('');
              }}
            >
              {tr('关闭隐私密码')}
            </button>
          )}
        </div>
      </div>

      {mode && (
        <form
          className="lock-setup"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="lock-setup-title">{formTitle}</div>
          {(mode === 'change' || mode === 'disable') && (
            <div className="field">
              <label>{tr('当前隐私密码')}</label>
              <input
                className="input"
                type="password"
                value={cur}
                autoFocus
                autoComplete="current-password"
                placeholder={tr('先验证一下是你本人')}
                onChange={(e) => {
                  setCur(e.target.value);
                  setErr('');
                }}
              />
            </div>
          )}
          {mode !== 'disable' && (
            <>
              <div className="field">
                <label>{tr('新隐私密码（至少 {n} 位）', { n: PRIVACY_PASSWORD_MIN })}</label>
                <input
                  className="input"
                  type="password"
                  value={next}
                  autoFocus={mode === 'set'}
                  autoComplete="new-password"
                  onChange={(e) => {
                    setNext(e.target.value);
                    setErr('');
                  }}
                />
              </div>
              <div className="field">
                <label>{tr('再输一次新隐私密码')}</label>
                <input
                  className="input"
                  type="password"
                  value={next2}
                  autoComplete="new-password"
                  onChange={(e) => {
                    setNext2(e.target.value);
                    setErr('');
                  }}
                />
              </div>
            </>
          )}
          {mode === 'disable' ? (
            <div className="hint">{tr('关闭后，所有隐私锁会一并解除；笔记本身不会被删除。')}</div>
          ) : (
            <div className="hint">
              <ShieldCheck size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
              {tr('请记牢：隐私密码忘记后，应用内将无法打开已锁内容。笔记文件本身不会丢失。')}
            </div>
          )}
          {err && <div className="lock-err">{err}</div>}
          <div className="set-actions">
            <button type="button" className="btn btn-secondary" onClick={reset} disabled={busy}>
              {tr('取消')}
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || (mode === 'disable' ? !cur : !next || !next2)}
            >
              {busy ? tr('处理中…') : mode === 'set' ? tr('设置隐私密码') : mode === 'change' ? tr('保存新密码') : tr('确认关闭')}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
