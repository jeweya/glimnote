import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Download, Loader2, RefreshCw, ShieldAlert, Sparkles, X } from 'lucide-react';
import { desktop } from '../lib/desktop';
import { useT } from '../lib/i18n';

type Phase = 'available' | 'downloading' | 'ready' | 'installing' | 'error';

/**
 * 自动更新弹窗：启动检查发现新版本时直接弹出来，让用户选择安装或忽略。
 * 下载完成后倒计时自动重启安装；如果安全软件拦截，界面里会提前说明该选什么。
 *
 * 只挂在主窗口上；下载进度由主进程只推给主窗口，独立小应用 / 单篇窗口不会弹。
 */
export function UpdateDialog() {
  const t = useT();
  const bridge = desktop();
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState('');
  const [phase, setPhase] = useState<Phase>('available');
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState('');
  const [countdown, setCountdown] = useState(0);
  /** 下载完成后是否自动倒计时安装；用户点「取消自动安装」后改为手动 */
  const [autoInstall, setAutoInstall] = useState(false);
  /** 只有用户在弹窗里点了「立即更新」，才接管进度并自动安装 */
  const engaged = useRef(false);

  useEffect(() => {
    if (!bridge?.onUpdateAvailable) return;
    return bridge.onUpdateAvailable((info) => {
      const next = String(info?.version || '');
      engaged.current = false;
      setVersion(next);
      setPhase('available');
      setPercent(0);
      setError('');
      setCountdown(0);
      setAutoInstall(false);
      setOpen(true);
    });
  }, [bridge]);

  useEffect(() => {
    if (!bridge?.onUpdateProgress) return;
    return bridge.onUpdateProgress((progress) => {
      if (!engaged.current) return;
      if (progress.state === 'downloading') {
        setPhase('downloading');
        setPercent(Math.max(0, Math.min(100, progress.percent || 0)));
      } else if (progress.state === 'downloaded') {
        setPhase('ready');
        setPercent(100);
        setAutoInstall(true);
        setCountdown(6);
      } else if (progress.state === 'error') {
        setPhase('error');
        setError(progress.message || t('下载失败，请稍后重试。'));
      }
    });
  }, [bridge, t]);

  // 下载完成后倒计时自动重启安装：不会让用户再点一次
  useEffect(() => {
    if (!autoInstall || phase !== 'ready' || countdown <= 0) return;
    const timer = window.setTimeout(() => {
      if (countdown <= 1) {
        setCountdown(0);
        setPhase('installing');
        void bridge?.installUpdate?.();
      } else {
        setCountdown(countdown - 1);
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [autoInstall, phase, countdown, bridge]);

  if (!open) return null;

  const startDownload = async () => {
    if (!bridge?.downloadUpdate) return;
    engaged.current = true;
    setPhase('downloading');
    setPercent(0);
    setError('');
    try {
      const result = await bridge.downloadUpdate();
      if (!result.ok) {
        engaged.current = false;
        setPhase('error');
        setError(result.message || t('下载失败，请稍后重试。'));
      } else {
        // 事件通常已经先到；这里兜底，避免界面停在下载中
        setPhase('ready');
        setPercent(100);
        setAutoInstall(true);
        setCountdown(6);
      }
    } catch (e) {
      engaged.current = false;
      setPhase('error');
      setError((e as Error)?.message || t('下载失败，请稍后重试。'));
    }
  };

  const ignore = async () => {
    try {
      if (version && bridge?.ignoreUpdate) await bridge.ignoreUpdate(version);
    } catch {
      /* 记不住忽略版本也不阻塞关闭，下次最多再提醒一次 */
    }
    setOpen(false);
  };

  const dismiss = () => {
    // 收起来就停止自动重启，避免用户看不到倒计时却被退出；之后可在设置里安装
    engaged.current = false;
    setAutoInstall(false);
    setCountdown(0);
    setOpen(false);
  };

  const installNow = async () => {
    if (!bridge?.installUpdate) return;
    setAutoInstall(false);
    setCountdown(0);
    setPhase('installing');
    const result = await bridge.installUpdate();
    if (result && result.ok === false) {
      setPhase('ready');
      setError(result.message || t('现在还不能安装更新。'));
    }
  };

  const downloading = phase === 'downloading';
  const ready = phase === 'ready';
  const installing = phase === 'installing';

  return createPortal(
    <div className="overlay overlay-update">
      <div className="modal update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title">
        <div className="modal-head">
          <div>
            <div className="modal-title update-dialog-title" id="update-dialog-title">
              {phase === 'error' ? (
                <RefreshCw size={16} />
              ) : ready || installing ? (
                <CheckCircle2 size={16} />
              ) : (
                <Sparkles size={16} />
              )}
              {version ? t('发现新版本 {v}', { v: version }) : t('发现新版本')}
            </div>
            <div className="modal-desc">
              {ready || installing
                ? t('更新已下载完成。')
                : t('新版本包含功能改进与问题修复，更新不会影响本地笔记。')}
            </div>
          </div>
          {!downloading && !installing && (
            <button className="icon-btn" onClick={dismiss} title={t('稍后再说')} aria-label={t('关闭')}>
              <X size={15} />
            </button>
          )}
        </div>

        <div className="update-dialog-body">
          {downloading && (
            <div className="update-dialog-progress">
              <div className="update-dialog-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                <i style={{ width: `${percent}%` }} />
              </div>
              <span>{percent}%</span>
            </div>
          )}

          {ready && (
            <div className="update-dialog-ready">
              <div className="update-dialog-count">
                {autoInstall && countdown > 0
                  ? t('{n} 秒后自动重启安装', { n: countdown })
                  : t('更新已下载，可以立即重启安装')}
              </div>
              <div className="update-dialog-sub">{t('需要先保存并同步笔记，完成后会自动关闭旧版本。')}</div>
            </div>
          )}

          {installing && (
            <div className="update-dialog-ready">
              <Loader2 size={16} className="spin" />
              <div className="update-dialog-sub">{t('正在保存笔记并重启安装…')}</div>
            </div>
          )}

          {phase === 'error' && <div className="prompt-error">{error || t('下载失败，请稍后重试。')}</div>}
          {phase === 'ready' && error && <div className="prompt-error">{error}</div>}

          {!installing && (
            <div className="update-av-hint">
              <ShieldAlert size={15} strokeWidth={1.9} />
              <span>
                {t(
                  '安装时如果 360 安全卫士 / 电脑管家提示「修改文件」，请选择「允许」，否则更新会中断。建议更新期间暂时退出这类软件。',
                )}
              </span>
            </div>
          )}
        </div>

        <div className="modal-foot update-dialog-actions">
          {phase === 'available' && (
            <>
              <button className="btn btn-ghost" onClick={ignore}>
                {t('忽略此版本')}
              </button>
              <button className="btn btn-ghost" onClick={dismiss}>
                {t('稍后提醒')}
              </button>
              <button className="btn btn-primary" onClick={() => void startDownload()}>
                <Download size={14} /> {t('立即更新')}
              </button>
            </>
          )}
          {downloading && (
            <>
              <button className="btn btn-ghost" onClick={dismiss}>
                {t('后台下载')}
              </button>
              <span className="update-dialog-downloading">
                <Loader2 size={14} className="spin" /> {t('正在下载安装包…')}
              </span>
            </>
          )}
          {ready && (
            <>
              {autoInstall && countdown > 0 && (
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setAutoInstall(false);
                    setCountdown(0);
                  }}
                >
                  {t('取消自动安装')}
                </button>
              )}
              <button className="btn btn-primary" onClick={() => void installNow()}>
                <RefreshCw size={14} /> {t('立即重启安装')}
              </button>
            </>
          )}
          {phase === 'error' && (
            <>
              <button className="btn btn-ghost" onClick={dismiss}>
                {t('关闭')}
              </button>
              <button className="btn btn-primary" onClick={() => void startDownload()}>
                <RefreshCw size={14} /> {t('重试')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
