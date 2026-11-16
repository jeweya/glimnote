/**
 * 底部最小化小条的公共容器。
 *
 * 「AI 后台任务」和「小应用」两个小条来自不同组件，过去各自 position:fixed
 * 贴在底部，同时出现时就上下叠在一起。这里让它们共同挂到同一个 flex 层里，
 * 谁先出现谁在左，后面的依次向右排，窗口太窄时各自内部横向滚动。
 */
let layer: HTMLElement | null = null;

export function dockLayer(): HTMLElement {
  if (layer && layer.isConnected) return layer;
  const el = document.createElement('div');
  el.className = 'bottom-dock-layer';
  document.body.appendChild(el);
  layer = el;
  return el;
}
