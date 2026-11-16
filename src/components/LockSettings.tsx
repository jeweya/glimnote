import { useState } from 'react';
import { Check, Copy, Lock, ShieldCheck } from 'lucide-react';
import { useApp } from '../store/app';
import { changePassword, hasPasswordLock, lockCreatedAt, PASSWORD_MIN, removeLock, setupLock } from '../lib/lock';
import { log } from '../lib/log';
import { usePrivacy } from '../store/privacy';
import { hasPrivacyPassword } from '../lib/privacyAuth';
import { PrivacyPasswordSettings } from './PrivacyPasswordSettings';
import { useT } from '../lib/i18n';

type Mode = 'set' | 'change' | 'disable';

/**
 * 设置 → 安全：密码锁的开关与表单。
 * 表单是就地展开的，不放第二个弹窗——设置本身已经在弹窗里了。
 */
export function LockSettings() {
  const tr = useT();
  const lockNow = useApp((s) => s.lockNow);
  const toast = useApp((s) => s.toast);
  const [enabled, setEnabled] = useState(() => hasPasswordLock());
  const [createdAt, setCreatedAt] = useState(() => lockCreatedAt());
  const [mode, setMode] = useState<Mode | null>(null);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState('');
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setMode(null);
    setCur('');
    setNext('');
    setNext2('');
    setErr('');
  };

  const submit = async () => {
    if (busy) return;
    setErr('');
    if (mode === 'disable') {
      setBusy(true);
      try {
        // 旧版本的隐私锁借用应用密码；关闭应用锁时把这类锁一起撤掉。
        // 已经设置独立隐私密码的锁不受影响，仍然可以正常使用。
        const legacyPrivacy = !hasPrivacyPassword();
        await removeLock(cur);
        if (legacyPrivacy) usePrivacy.getState().clearAll();
        setEnabled(false);
        setCreatedAt(null);
        reset();
        toast(legacyPrivacy ? tr('密码锁已关闭，旧版隐私锁也一并解除') : tr('密码锁已关闭'), 'info');
        log('app', 'info', '密码锁：已关闭');
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (next.length < PASSWORD_MIN) {
      setErr(tr('新密码至少 {n} 位', { n: PASSWORD_MIN }));
      return;
    }
    if (next !== next2) {
      setErr(tr('两次输入的新密码不一致'));
      return;
    }
    setBusy(true);
    try {
      const res = mode === 'change' ? await changePassword(cur, next) : await setupLock(next);
      setEnabled(true);
      setCreatedAt(lockCreatedAt());
      setRecovery(res.recovery);
      setSaved(false);
      setCopied(false);
      reset();
      toast(mode === 'change' ? tr('密码已修改，旧恢复码已作废') : tr('密码锁已开启'), 'success');
      log('app', 'info', mode === 'change' ? '密码锁：已修改密码' : '密码锁：已开启');
    } catch (e) {
      setErr((e as Error).message || tr('操作失败'));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recovery);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setErr(tr('复制失败，请手动抄写'));
    }
  };

  const since = createdAt ? new Date(createdAt).toLocaleDateString('zh-CN') : '';

  return (
    <>
      <div className="set-section-title">{tr('密码锁')}</div>
      <div className="set-row">
        <div>
          <div className="set-label">{enabled ? tr('已开启{since}', { since: since ? tr(' · {date} 设置', { date: since }) : '' }) : tr('未开启')}</div>
          <div className="set-desc">
            {tr('开启后，每次启动、以及关闭窗口后从托盘重新打开，都要先输入密码；点「立即锁定」可以随时锁上。')}
            {tr('锁定状态下也不能打开待办浮窗，需要回到这里解锁。密码只保存在这台设备上，不会同步到仓库。')}
          </div>
        </div>
        <div className="set-actions">
          {enabled && (
            <button className="btn btn-secondary" onClick={() => lockNow()}>
              <Lock size={14} /> {tr('立即锁定')}
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={() => {
              setMode(enabled ? 'change' : 'set');
              setErr('');
            }}
          >
            {enabled ? tr('修改密码') : tr('设置密码')}
          </button>
          {enabled && (
            <button
              className="btn btn-secondary"
              onClick={() => {
                setMode('disable');
                setErr('');
              }}
            >
              {tr('关闭密码锁')}
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
          <div className="lock-setup-title">
            {mode === 'set' ? tr('设置密码') : mode === 'change' ? tr('修改密码') : tr('关闭密码锁')}
          </div>
          {(mode === 'change' || mode === 'disable') && (
            <div className="field">
              <label>{tr('当前密码')}</label>
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
                <label>{tr('新密码（至少 {n} 位）', { n: PASSWORD_MIN })}</label>
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
                <label>{tr('再输一次新密码')}</label>
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
          {mode === 'disable' && (
            <div className="hint">{tr('关闭后启动、关窗重开都不再要密码；已设置的恢复码也随之作废。')}</div>
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
              {busy ? tr('处理中…') : mode === 'set' ? tr('开启密码锁') : mode === 'change' ? tr('保存新密码') : tr('确认关闭')}
            </button>
          </div>
        </form>
      )}

      {recovery && (
        <div className="lock-recovery-panel">
          <div className="lock-recovery-head">
            <ShieldCheck size={15} strokeWidth={1.75} />
            {tr('这串恢复码只显示这一次，请抄到纸上或密码管理器里')}
          </div>
          <div className="lock-recovery">
            <code>{recovery}</code>
            <button type="button" className="btn btn-secondary" onClick={() => void copy()}>
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? tr('已复制') : tr('复制')}
            </button>
          </div>
          <div className="hint">
            {tr('忘记密码时，在锁屏页点「忘记密码？用恢复码重设」。恢复码和密码都丢失的话，只能清空本机数据重新开始。')}
          </div>
          <label className="lock-saved">
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            {tr('我已经抄下恢复码')}
          </label>
          <div className="set-actions">
            <button className="btn btn-primary" disabled={!saved} onClick={() => setRecovery('')}>
              {tr('完成')}
            </button>
          </div>
        </div>
      )}

      <PrivacyPasswordSettings />

      <div className="set-row">
        <div>
          <div className="set-label">{tr('它能防什么、不能防什么')}</div>
          <div className="set-desc">
            {tr('这是界面锁：别人打开你的电脑、或从托盘点开萤光笔记，都要先输密码才能看到内容。')}
            {tr('它不是加密——笔记文件在磁盘和仓库里仍是明文，能直接翻到文件的人可以绕过锁。')}
            {tr('快速捕获小窗不受影响，它只能新增内容，看不到已有笔记。')}
          </div>
        </div>
      </div>
    </>
  );
}
