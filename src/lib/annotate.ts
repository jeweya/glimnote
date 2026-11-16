import { t } from './i18n';

/**
 * 预览标注：在应用预览图上画圈、框、箭头，供 AI 理解「改这里」。
 *
 * 所有坐标都用 0–1 的相对值保存，窗口缩放、侧栏宽度变化后标注仍然对得上；
 * 发给模型时再翻译成「画面左上、横向 12%–48%」这样的中文位置描述。
 */

export type AnnoTool = 'pen' | 'arrow' | 'rect' | 'ellipse';

export interface AnnoPoint {
  x: number;
  y: number;
}

export interface AnnoShape {
  id: string;
  tool: AnnoTool;
  color: string;
  /** 画笔轨迹；其它工具只用首尾两点 */
  points: AnnoPoint[];
  from: AnnoPoint;
  to: AnnoPoint;
}

export const ANNO_COLORS = [
  { id: 'red', value: '#e04b3f', label: '红色' },
  { id: 'blue', value: '#2f6fb3', label: '蓝色' },
  { id: 'amber', value: '#d99a1e', label: '黄色' },
];

export const ANNO_TOOLS: { id: AnnoTool; label: string; hint: string }[] = [
  { id: 'pen', label: '画笔', hint: '按住拖动，画出任意线条' },
  { id: 'arrow', label: '箭头', hint: '从起点拖到终点，指向要改的位置' },
  { id: 'rect', label: '方框', hint: '框出一块区域' },
  { id: 'ellipse', label: '圆圈', hint: '圈出按钮或文字' },
];

export const ANNO_TOOL_LABEL: Record<AnnoTool, string> = {
  pen: '手绘线条',
  arrow: '箭头',
  rect: '方框',
  ellipse: '圆圈',
};

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function newShapeId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function createShape(tool: AnnoTool, color: string, point: AnnoPoint): AnnoShape {
  return {
    id: newShapeId(),
    tool,
    color,
    points: [point],
    from: point,
    to: point,
  };
}

export function shapeBounds(shape: AnnoShape) {
  const points = shape.tool === 'pen' && shape.points.length > 1 ? shape.points : [shape.from, shape.to];
  let x0 = 1;
  let y0 = 1;
  let x1 = 0;
  let y1 = 0;
  for (const point of points) {
    x0 = Math.min(x0, point.x);
    y0 = Math.min(y0, point.y);
    x1 = Math.max(x1, point.x);
    y1 = Math.max(y1, point.y);
  }
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

function tracePath(ctx: CanvasRenderingContext2D, shape: AnnoShape, width: number, height: number) {
  const x0 = shape.from.x * width;
  const y0 = shape.from.y * height;
  const x1 = shape.to.x * width;
  const y1 = shape.to.y * height;

  ctx.beginPath();
  if (shape.tool === 'pen') {
    const points = shape.points.length ? shape.points : [shape.from, shape.to];
    if (points.length === 1) {
      ctx.arc(points[0].x * width, points[0].y * height, 1.5, 0, Math.PI * 2);
      ctx.closePath();
      return;
    }
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x * width, point.y * height);
      else ctx.lineTo(point.x * width, point.y * height);
    });
    return;
  }
  if (shape.tool === 'arrow') {
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    return;
  }
  if (shape.tool === 'rect') {
    roundRectPath(ctx, Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0), 8);
    return;
  }
  const rx = Math.abs(x1 - x0) / 2;
  const ry = Math.abs(y1 - y0) / 2;
  ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.max(rx, 1), Math.max(ry, 1), 0, 0, Math.PI * 2);
}

function paint(ctx: CanvasRenderingContext2D, shape: AnnoShape, width: number, height: number) {
  // 先描一层浅色光晕，深色图上也能看清标注
  tracePath(ctx, shape, width, height);
  ctx.lineWidth = 6.5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.82)';
  ctx.stroke();

  tracePath(ctx, shape, width, height);
  ctx.lineWidth = 3;
  ctx.strokeStyle = shape.color;
  ctx.stroke();

  if (shape.tool !== 'arrow') return;

  const x0 = shape.from.x * width;
  const y0 = shape.from.y * height;
  const x1 = shape.to.x * width;
  const y1 = shape.to.y * height;
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const size = Math.min(18, Math.max(9, Math.hypot(x1 - x0, y1 - y0) * 0.28));
  const drawHead = (color: string, lineWidth: number) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - size * Math.cos(angle - Math.PI / 7), y1 - size * Math.sin(angle - Math.PI / 7));
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - size * Math.cos(angle + Math.PI / 7), y1 - size * Math.sin(angle + Math.PI / 7));
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = color;
    ctx.stroke();
  };
  drawHead('rgba(255, 255, 255, 0.82)', 6.5);
  drawHead(shape.color, 3);
}

export function drawShapes(
  ctx: CanvasRenderingContext2D,
  shapes: AnnoShape[],
  width: number,
  height: number,
  opts: { clear?: boolean } = {},
) {
  if (opts.clear !== false) ctx.clearRect(0, 0, width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const shape of shapes) paint(ctx, shape, width, height);
}

/** 聊天里显示的缩略图：画出预览底色和标注，不截 iframe（跨域沙箱拿不到画面） */
export function renderThumbnail(shapes: AnnoShape[], aspect = 1.5): string {
  if (!shapes.length || typeof document === 'undefined') return '';
  const width = 300;
  const height = Math.max(120, Math.round(width / Math.max(0.6, aspect)));
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.scale(scale, scale);

  ctx.fillStyle = '#fffdf8';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(26, 25, 22, 0.045)';
  for (let x = 12; x < width; x += 16) {
    for (let y = 26; y < height; y += 16) {
      ctx.beginPath();
      ctx.arc(x, y, 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 顶部一条模拟应用标题栏
  ctx.fillStyle = 'rgba(26, 25, 22, 0.06)';
  ctx.fillRect(0, 0, width, 18);
  ctx.fillStyle = 'rgba(26, 25, 22, 0.16)';
  [9, 17, 25].forEach((x) => {
    ctx.beginPath();
    ctx.arc(x, 9, 2.2, 0, Math.PI * 2);
    ctx.fill();
  });

  drawShapes(ctx, shapes, width, height, { clear: false });
  return canvas.toDataURL('image/png');
}

function zoneName(cx: number, cy: number) {
  const horizontal = cx < 0.35 ? '左' : cx > 0.65 ? '右' : '中';
  const vertical = cy < 0.35 ? '上' : cy > 0.65 ? '下' : '中';
  if (horizontal === '中' && vertical === '中') return '画面中央';
  if (horizontal === '中') return `画面${vertical}方中间`;
  if (vertical === '中') return `画面${horizontal}侧中部`;
  return `画面${horizontal}${vertical}角`;
}

const pct = (value: number) => Math.round(value * 100);

function colorLabel(value: string) {
  return t(ANNO_COLORS.find((color) => color.value === value)?.label || '彩色');
}

/**
 * 把标注翻译成模型能理解的空间描述。
 * 只给相对百分比而不给像素，模型不需要知道预览的实际尺寸。
 */
export function describeShapes(shapes: AnnoShape[]): string {
  if (!shapes.length) return '';
  const lines = shapes.map((shape, index) => {
    const bounds = shapeBounds(shape);
    const color = colorLabel(shape.color);
    const tool = ANNO_TOOL_LABEL[shape.tool];
    const place = zoneName(bounds.cx, bounds.cy);
    if (shape.tool === 'arrow') {
      return `${index + 1}. ${color}箭头：从${zoneName(shape.from.x, shape.from.y)}指向${zoneName(shape.to.x, shape.to.y)}（起点横向 ${pct(shape.from.x)}%、纵向 ${pct(shape.from.y)}%；终点横向 ${pct(shape.to.x)}%、纵向 ${pct(shape.to.y)}%）`;
    }
    const size = `横向 ${pct(bounds.x0)}%–${pct(bounds.x1)}%，纵向 ${pct(bounds.y0)}%–${pct(bounds.y1)}%`;
    if (shape.tool === 'pen') {
      return `${index + 1}. ${color}手绘线条：位于${place}（${size}）`;
    }
    return `${index + 1}. ${color}${tool}：${place}（${size}）`;
  });
  return `【预览标注】用户在应用预览图上标出了 ${shapes.length} 处需要调整的位置：\n${lines.join('\n')}\n请优先修改被标注或被箭头指向的区域，未被标注的部分尽量保持原样；如果和文字要求冲突，以文字要求为准。`;
}

/** 聊天里的一行摘要，例如「2 处标注 · 红色圆圈、蓝色箭头」 */
export function annotationSummary(shapes: AnnoShape[]): string {
  const names = shapes.map((shape) => `${t(colorLabel(shape.color))}${t(ANNO_TOOL_LABEL[shape.tool])}`);
  return `${t('{n} 处标注', { n: shapes.length })}${names.length ? ` · ${Array.from(new Set(names)).join(t('、'))}` : ''}`;
}
