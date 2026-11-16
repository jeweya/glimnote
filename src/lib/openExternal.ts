import { desktop } from './desktop';
import { normalizeUrl } from './home';
import { t } from './i18n';

/**
 * 打开外部网址：桌面端走主进程 shell.openExternal，网页端才用 window.open。
 * 只放行 http / https；首页入口存的就是规范化后的地址，这里再校验一次。
 */
export async function openExternal(raw: string) {
  const url = normalizeUrl(raw);
  if (!url) throw new Error(t('这个地址不是有效的 http / https 网址'));
  const bridge = desktop();
  if (bridge?.openExternal) {
    const ok = await bridge.openExternal(url);
    if (!ok) throw new Error(t('系统没能打开这个网址（可能没有默认浏览器）'));
    return;
  }
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  if (!win) throw new Error(t('浏览器拦截了新窗口，请允许弹窗后重试'));
}
