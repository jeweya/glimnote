import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { clamp01, createShape, drawShapes, type AnnoPoint, type AnnoShape, type AnnoTool } from '../lib/annotate';
import { withCsp } from '../lib/apps';
import { useAppDataHost } from '../lib/appDataHost';
import { useT } from '../lib/i18n';

interface Props {
  code: string;
  /** 已保存应用的 id；新建 / 导入的预览为空，数据先留在内存草稿里 */
  appId?: string;
  /** 草稿身份，用生成会话 id 即可 */
  draftKey: string;
  reloadKey: number;
  annotating: boolean;
  tool: AnnoTool;
  color: string;
  shapes: AnnoShape[];
  onShapesChange: (shapes: AnnoShape[]) => void;
}

/**
 * 预览容器：平时是单纯的 iframe；进入标注模式后盖一层画布，
 * iframe 不再接收鼠标事件，拖动即绘制。标注坐标全部归一化保存。
 */
export function PreviewAnnotator({
  code,
  appId,
  draftKey,
  reloadKey,
  annotating,
  tool,
  color,
  shapes,
  onShapesChange,
}: Props) {
  const tr = useT();
  const wrapRef = useRef<HTMLDivElement>(null);
  const setFrame = useAppDataHost(appId || '', draftKey);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const draftRef = useRef<AnnoShape | null>(null);
  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const colorRef = useRef(color);
  colorRef.current = color;

  const redraw = () => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const rect = wrap.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const draft = draftRef.current;
    drawShapes(ctx, draft ? [...shapesRef.current, draft] : shapesRef.current, width, height);
  };

  useEffect(() => {
    if (!annotating) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    redraw();
    const observer = new ResizeObserver(() => redraw());
    observer.observe(wrap);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotating]);

  useEffect(() => {
    if (annotating) redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapes, annotating]);

  const pointOf = (event: ReactPointerEvent<HTMLCanvasElement>): AnnoPoint => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - rect.left) / Math.max(1, rect.width)),
      y: clamp01((event.clientY - rect.top) / Math.max(1, rect.height)),
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!annotating || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const shape = createShape(toolRef.current, colorRef.current, pointOf(event));
    draftRef.current = shape;
    redraw();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const draft = draftRef.current;
    if (!draft) return;
    event.preventDefault();
    const point = pointOf(event);
    if (draft.tool === 'pen') {
      const last = draft.points[draft.points.length - 1];
      if (!last || Math.hypot(point.x - last.x, point.y - last.y) > 0.0015) {
        draft.points.push(point);
        draft.to = point;
        redraw();
      }
      return;
    }
    draft.to = point;
    redraw();
  };

  const finish = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const draft = draftRef.current;
    const shape = draft;
    draftRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!shape) return;
    const tiny =
      shape.tool === 'pen'
        ? shape.points.length < 2
        : Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) < 0.006;
    if (tiny) {
      redraw();
      return;
    }
    onShapesChange([...shapes, shape]);
  };

  return (
    <div ref={wrapRef} className={`app-stage-wrap${annotating ? ' is-annotating' : ''}`}>
      <iframe
        key={reloadKey}
        ref={setFrame}
        className="app-builder-frame"
        title={tr('应用预览')}
        sandbox="allow-scripts allow-forms"
        allow="clipboard-write"
        referrerPolicy="no-referrer"
        srcDoc={withCsp(code)}
      />
      {annotating && (
        <canvas
          ref={canvasRef}
          className="anno-canvas"
          aria-label={tr('标注画布：在预览上拖动即可画圈或箭头')}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onPointerCancel={finish}
        />
      )}
    </div>
  );
}
