/**
 * 独立窗口（浮窗、单篇、小应用窗口）不经过主窗口 store，
 * 启动时按本机设置把主题套上，保证深色 / 纸质主题一致。
 */
export function applyStoredTheme() {
  const theme = localStorage.getItem('glimnote.theme') || 'paper';
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : theme === 'paper' ? 'paper' : 'light';
}
