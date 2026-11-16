import { Component } from 'react';
import type { ErrorInfo, KeyboardEvent, ReactNode } from 'react';
import { desktop } from '../lib/desktop';
import { log } from '../lib/log';
import { t } from '../lib/i18n';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** 重置不可撤销，先确认一次，避免在崩溃页上误点 */
  confirmReset: boolean;
  /** 确认后到应用真正重启之间，按钮锁住，防止连点 */
  resetting: boolean;
  /** 主进程没写成重置标记时，在弹窗里说明，而不是静默失败 */
  resetError: string;
}

/**
 * 渲染层最后一道保险：React 组件抛错时，默认会整棵树卸载，用户看到的就是白屏。
 * 这里换成一张能自救的错误页——重新加载、重置应用、打开日志目录。
 * 注意它只能接住渲染 / 生命周期错误；脚本没加载起来的情况由 index.html 的启动兜底负责。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, confirmReset: false, resetting: false, resetError: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const where = (info.componentStack || '').replace(/\s+/g, ' ').slice(0, 600);
    log('app', 'error', `界面崩溃：${error.message}${where ? ` · ${where}` : ''}`);
  }

  private closeConfirm = () => {
    if (this.state.resetting) return;
    this.setState({ confirmReset: false });
  };

  private handleConfirmKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.closeConfirm();
    }
  };

  private handleReset = async () => {
    if (this.state.resetting) return;
    this.setState({ resetting: true, resetError: '' });
    const bridge = desktop();
    try {
      if (bridge?.resetApp) {
        const ok = await bridge.resetApp('error-boundary');
        // 主进程写不进重置标记时会返回 false，别让用户对着「正在重置…」干等
        if (ok === false) {
          this.setState({
            resetting: false,
            resetError: t('没能写入重置标记。可以打开日志目录查看原因，或先重新加载再试。'),
          });
        }
        return;
      }
      // 网页版：只清界面设置，不动 IndexedDB 里的笔记
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('glimnote.')) localStorage.removeItem(key);
      }
    } catch {
      /* 隐私模式下不可写，直接重载 */
    }
    location.reload();
  };

  render() {
    const { error, confirmReset, resetting, resetError } = this.state;
    if (!error) return this.props.children;
    const bridge = desktop();
    return (
      <div className="crash-screen">
        <div className="crash-card">
          <div className="crash-mark">{t('萤')}</div>
          <h1>{t('界面遇到了问题')}</h1>
          <p>
            {t('笔记都保存在「设置 → 常规 → 笔记存储位置」显示的普通 Markdown 文件里，没有丢失。可以先重新加载；如果反复出现，重置本机配置通常就能恢复。')}
          </p>
          <pre className="crash-detail">{error.message || String(error)}</pre>
          <div className="crash-actions">
            <button type="button" className="crash-primary" onClick={() => location.reload()}>
              {t('重新加载')}
            </button>
            <button type="button" onClick={() => this.setState({ confirmReset: true, resetError: '' })}>
              {t('重置应用')}
            </button>
            {bridge?.openLogFolder && (
              <button type="button" onClick={() => void bridge.openLogFolder?.()}>
                {t('打开日志目录')}
              </button>
            )}
          </div>
          <p className="crash-hint">{t('重置只清空同步连接、密码与偏好，不会删除笔记；重置后重新连接 Git 仓库即可。')}</p>
        </div>

        {confirmReset && (
          <div className="crash-confirm-backdrop" onKeyDown={this.handleConfirmKeyDown}>
            <div
              className="crash-confirm"
              role="dialog"
              aria-modal="true"
              aria-labelledby="crash-confirm-title"
              aria-describedby="crash-confirm-desc"
            >
              <h2 id="crash-confirm-title">{t('确定要重置应用吗？')}</h2>
              <p id="crash-confirm-desc">
                {t('会清空本机的同步连接、密码与偏好设置，然后重启应用。笔记文件不会被删除，但这一步无法撤销，重置后需要重新连接 Git 仓库。')}
              </p>
              {resetError && <p className="crash-confirm-error">{resetError}</p>}
              <div className="crash-actions">
                <button type="button" autoFocus disabled={resetting} onClick={this.closeConfirm}>
                  {t('取消')}
                </button>
                <button type="button" className="crash-danger" disabled={resetting} onClick={this.handleReset}>
                  {resetting ? t('正在重置…') : t('确认重置并重启')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }
}
