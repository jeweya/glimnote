import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Eye, EyeOff, KeyRound, ShieldCheck, Sparkles } from 'lucide-react';
import { useApp } from '../store/app';
import { normalizeRecovery, PASSWORD_MIN, resetWithRecovery, verifyPassword } from '../lib/lock';
import { log } from '../lib/log';
import { useT } from '../lib/i18n';

type Stage = 'password' | 'recovery' | 'recovery-done';

export function LockScreen() {
  const tr = useT();
  const unlock = useApp((s) => s.unlock);
  const [stage, setStage] = useState<Stage>('password');
  const [pw, setPw] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [rec, setRec] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [freshRecovery, setFreshRecovery] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fails, setFails] = useState(0);
  const [cooldown, setCooldown] = useState(0);
  const pwRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    pwRef.current?.focus();
  }, [stage]);

  useEffect(() => {
    if (!cooldown) return;
    const t = window.setTimeout(() => setCooldown((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [cooldown]);

  const submitPassword = async () => {
    if (busy || cooldown) return;
    setBusy(true);
    setErr('');
    try {
      if (await verifyPassword(pw)) {
        setFails(0);
        unlock();
        return;
      }
      const n = fails + 1;
      setFails(n);
      setErr(n >= 3 ? tr('密码不对。先深呼吸，再检查大小写和输入法。') : tr('密码不对，再试一次。'));
      if (n >= 3) setCooldown(Math.min(30, (n - 2) * 3));
      setPw('');
      log('app', 'warn', `密码锁：解锁失败（连续第 ${n} 次）`);
    } catch (e) {
      setErr((e as Error).message || tr('解锁失败'));
    } finally {
      setBusy(false);
    }
  };

  const submitRecovery = async () => {
    if (busy) return;
    setErr('');
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
      const res = await resetWithRecovery(rec, next);
      setFreshRecovery(res.recovery);
      setStage('recovery-done');
      log('app', 'info', '密码锁：已用恢复码重设密码');
    } catch (e) {
      setErr((e as Error).message || tr('重设失败'));
    } finally {
      setBusy(false);
    }
  };

  const copyRecovery = async () => {
    try {
      await navigator.clipboard.writeText(freshRecovery);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setErr(tr('复制失败，请手动抄写'));
    }
  };

  return (
    <div className="lock-screen">
      <div className="lock-card" role="dialog" aria-modal="true" aria-labelledby="lock-title">
        <div className="lock-brand">
          <span className="mark-lg">
            <Sparkles size={20} strokeWidth={1.75} />
          </span>
          <div>
            <div className="lock-title" id="lock-title">
              {tr('萤光笔记已锁定')}
            </div>
            <div className="lock-sub">{tr('萤火微光，记录细碎微小的灵感')}</div>
          </div>
        </div>

        {stage === 'password' && (
          <form
            className="lock-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submitPassword();
            }}
          >
            <div className="peek-field">
              <input
                ref={pwRef}
                className="input lock-input"
                type={showPw ? 'text' : 'password'}
                value={pw}
                placeholder={tr('密码')}
                aria-label={tr('密码')}
                autoComplete="current-password"
                onChange={(e) => {
                  setPw(e.target.value);
                  setErr('');
                }}
              />
              <button
                type="button"
                className="peek-btn"
                onClick={() => setShowPw((v) => !v)}
                title={showPw ? tr('隐藏密码') : tr('显示密码')}
                aria-label={showPw ? tr('隐藏密码') : tr('显示密码')}
              >
                {showPw ? <EyeOff size={14} strokeWidth={1.75} /> : <Eye size={14} strokeWidth={1.75} />}
              </button>
            </div>
            {err && <div className="lock-err">{err}</div>}
            <button className="btn btn-primary lock-submit" type="submit" disabled={busy || cooldown > 0 || !pw}>
              <KeyRound size={14} /> {cooldown > 0 ? tr('请稍等 {n} 秒', { n: cooldown }) : busy ? tr('正在校验…') : tr('解锁')}
            </button>
            <button
              type="button"
              className="lock-link"
              onClick={() => {
                setStage('recovery');
                setErr('');
              }}
            >
              {tr('忘记密码？用恢复码重设')}
            </button>
          </form>
        )}

        {stage === 'recovery' && (
          <form
            className="lock-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submitRecovery();
            }}
          >
            <div className="lock-tip">
              <ShieldCheck size={14} strokeWidth={1.75} />
              {tr('输入设置密码时抄下的恢复码（20 位，连字符可省略），再设一个新密码。')}
            </div>
            <input
              ref={pwRef}
              className="input lock-input mono"
              value={rec}
              placeholder={tr('恢复码，例如 K7M2Q-8XPA4-…')}
              aria-label={tr('恢复码')}
              spellCheck={false}
              onChange={(e) => {
                setRec(e.target.value);
                setErr('');
              }}
            />
            <input
              className="input lock-input"
              type="password"
              value={next}
              placeholder={tr('新密码（至少 {n} 位）', { n: PASSWORD_MIN })}
              aria-label={tr('新密码')}
              autoComplete="new-password"
              onChange={(e) => {
                setNext(e.target.value);
                setErr('');
              }}
            />
            <input
              className="input lock-input"
              type="password"
              value={next2}
              placeholder={tr('再输一次新密码')}
              aria-label={tr('确认新密码')}
              autoComplete="new-password"
              onChange={(e) => {
                setNext2(e.target.value);
                setErr('');
              }}
            />
            {err && <div className="lock-err">{err}</div>}
            <button
              className="btn btn-primary lock-submit"
              type="submit"
              disabled={busy || !normalizeRecovery(rec) || !next || !next2}
            >
              {busy ? tr('正在重设…') : tr('重设密码并解锁')}
            </button>
            <button
              type="button"
              className="lock-link"
              onClick={() => {
                setStage('password');
                setErr('');
              }}
            >
              {tr('返回，改用密码解锁')}
            </button>
          </form>
        )}

        {stage === 'recovery-done' && (
          <div className="lock-form">
            <div className="lock-tip ok">
              <Check size={14} strokeWidth={2} />
              {tr('密码已重设。这是新的恢复码，请抄下来保管——它只显示这一次。')}
            </div>
            <div className="lock-recovery">
              <code>{freshRecovery}</code>
              <button type="button" className="btn btn-secondary" onClick={() => void copyRecovery()}>
                {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? tr('已复制') : tr('复制')}
              </button>
            </div>
            <div className="lock-err subtle">{tr('旧恢复码已经作废。恢复码和密码都丢失的话，只能清空本机数据重新开始。')}</div>
            <button className="btn btn-primary lock-submit" type="button" onClick={() => unlock()}>
              {tr('我已保存，进入萤光笔记')}
            </button>
          </div>
        )}

        <div className="lock-foot">{tr('密码只保存在这台设备上，不会上传；恢复码也不要放在同一台电脑的备忘录里。')}</div>
      </div>
    </div>
  );
}
