/**
 * 浮窗的位置计算：还原时收回屏幕、拖动结束时保证还够得着。
 *
 * 拖动本身完全跟手，不做贴边吸附；这里的约束只负责「别让窗口跑到找不回来」。
 * 单独拆出来（不依赖 Electron）是为了能直接在 Node 里跑测试。
 */
/** 收成一条时也要放得下日期、数量和两个按钮，所以比展开态的下限 300 更小 */
const CARD_MIN_W = 260;
const CARD_MAX_W = 760;
const CARD_MIN_H = 56;
const CARD_MAX_H = 1000;

/** 允许半收在边上，但至少要留这么宽的标题栏在屏内，还能抓回来 */
const REACHABLE_X = 140;
/** 竖直方向至少留一条标题栏（含拖动把手）可见 */
const REACHABLE_Y = 48;

function normalizeSize(width, height) {
  return {
    width: Math.max(CARD_MIN_W, Math.min(CARD_MAX_W, Math.round(width))),
    height: Math.max(CARD_MIN_H, Math.min(CARD_MAX_H, Math.round(height))),
  };
}

/**
 * 把矩形完整收进工作区：启动还原、副屏拔掉、任务栏改高度都走这里。
 * 屏幕比窗口还小时不再保留原来尺寸，至少保证左上角可见。
 */
function fitRect(rect, area) {
  const width = Math.min(rect.width, area.width);
  const height = Math.min(rect.height, area.height);
  const minX = area.x;
  const minY = area.y;
  const maxX = Math.max(minX, area.x + area.width - width);
  const maxY = Math.max(minY, area.y + area.height - height);
  return {
    x: Math.round(Math.min(Math.max(rect.x, minX), maxX)),
    y: Math.round(Math.min(Math.max(rect.y, minY), maxY)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * 拖动时用：不强行把窗口整个塞回屏内（允许故意半收在边上），
 * 只保证还留得下一块能抓的标题栏。
 */
function keepReachable(rect, area) {
  const minX = area.x - rect.width + REACHABLE_X;
  const maxX = area.x + area.width - REACHABLE_X;
  const minY = area.y;
  const maxY = Math.max(minY, area.y + area.height - REACHABLE_Y);
  return {
    ...rect,
    x: Math.round(Math.min(Math.max(rect.x, minX), maxX)),
    y: Math.round(Math.min(Math.max(rect.y, minY), maxY)),
  };
}

module.exports = {
  CARD_MIN_W,
  CARD_MAX_W,
  CARD_MIN_H,
  CARD_MAX_H,
  normalizeSize,
  fitRect,
  keepReachable,
};
