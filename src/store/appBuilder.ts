/**
 * AI 小应用生成器的多会话状态。
 *
 * 生成一个应用可能要几十秒到几分钟，所以生成器不能和首页绑在一起：
 * 会话放在全局 store 里，宿主组件常驻在主窗口根部，最小化、切换页面、
 * 锁屏都不会打断正在进行的请求。同一时间只有一个会话在前台，其余沉到
 * 底部任务坞继续跑。
 */
import { create } from 'zustand';
import type { AppMeta } from '../lib/apps';
import type { ImportedApp } from '../lib/importApp';

export type BuilderPhase = 'idle' | 'generating' | 'done' | 'error' | 'unsaved';

export interface BuilderSession {
  id: string;
  /** 编辑已有应用时带上原元数据与当前代码 */
  initial: { meta: AppMeta; html: string } | null;
  /** 从首页导入的应用，保存时才落盘 */
  incoming: ImportedApp | null;
  /** 收进底部任务坞，生成继续 */
  minimized: boolean;
  createdAt: number;
  /** 任务坞里显示的名字，生成成功后换成模型给的应用名 */
  label: string;
  busy: boolean;
  phase: BuilderPhase;
  startedAt: number;
}

export interface BuilderOpenInput {
  initial?: { meta: AppMeta; html: string } | null;
  incoming?: ImportedApp | null;
}

interface BuilderState {
  sessions: BuilderSession[];
  /** 正在等待用户决定「继续等待 / 停止关闭 / 最小化」的会话 */
  confirming: string | null;
  open: (input?: BuilderOpenInput) => string;
  restore: (id: string) => void;
  minimize: (id: string) => void;
  patch: (id: string, partial: Partial<BuilderSession>) => void;
  close: (id: string) => void;
  /** 关闭入口：生成中先问一句，空闲时直接关 */
  requestClose: (id: string) => void;
  cancelClose: () => void;
  /** 最小化后继续跑，并收起确认框 */
  keepInBackground: (id: string) => void;
  /** 真正中断请求并关掉会话 */
  stopAndClose: (id: string) => void;
  stop: (id: string) => void;
}

/** 每个会话注册一个「中断当前请求」的函数，任务坞的停止按钮靠它 */
const stoppers = new Map<string, () => void>();

export function registerBuilderStop(id: string, stop: (() => void) | null) {
  if (stop) stoppers.set(id, stop);
  else stoppers.delete(id);
}

function stopBuilder(id: string) {
  const stop = stoppers.get(id);
  if (!stop) return;
  stoppers.delete(id);
  try {
    stop();
  } catch {
    /* 中断失败也不该挡住关闭 */
  }
}

let seq = 0;
function nextId() {
  seq += 1;
  return `builder-${Date.now().toString(36)}-${seq}`;
}

function initialLabel(input: BuilderOpenInput) {
  if (input.initial) return input.initial.meta.name;
  if (input.incoming) return input.incoming.name;
  return '新的小工具';
}

export const useAppBuilder = create<BuilderState>((set, get) => ({
  sessions: [],
  confirming: null,

  open: (input = {}) => {
    const initial = input.initial || null;
    const incoming = input.incoming || null;

    // 编辑同一个应用：已经有草稿就还原它，避免两份会话互相覆盖
    const reusable = initial
      ? get().sessions.find((s) => s.initial?.meta.id === initial.meta.id)
      : !incoming
        ? // 连点「AI 小应用」不该叠出一堆空白窗口；只要还没开始生成就复用
          get().sessions.find((s) => !s.initial && !s.incoming && s.phase === 'idle' && !s.busy)
        : undefined;
    if (reusable) {
      set((state) => ({
        confirming: null,
        sessions: state.sessions.map((s) => ({ ...s, minimized: s.id !== reusable.id })),
      }));
      return reusable.id;
    }

    const id = nextId();
    const session: BuilderSession = {
      id,
      initial,
      incoming,
      minimized: false,
      createdAt: Date.now(),
      label: initialLabel(input),
      busy: false,
      phase: 'idle',
      startedAt: 0,
    };
    // 只留一个前台：打开新任务时把其它生成器收进任务坞，它们的请求不会断
    set((state) => ({
      confirming: null,
      sessions: [...state.sessions.map((s) => ({ ...s, minimized: true })), session],
    }));
    return id;
  },

  restore: (id) =>
    set((state) => {
      if (!state.sessions.some((s) => s.id === id)) return state;
      return {
        confirming: null,
        sessions: state.sessions.map((s) => ({ ...s, minimized: s.id !== id })),
      };
    }),

  minimize: (id) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, minimized: true } : s)),
    })),

  patch: (id, partial) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, ...partial } : s)),
    })),

  close: (id) => {
    stoppers.delete(id);
    set((state) => ({
      confirming: state.confirming === id ? null : state.confirming,
      sessions: state.sessions.filter((s) => s.id !== id),
    }));
  },

  requestClose: (id) => {
    const session = get().sessions.find((s) => s.id === id);
    if (!session) return;
    if (session.busy) {
      set({ confirming: id });
      return;
    }
    get().close(id);
  },

  cancelClose: () => set({ confirming: null }),

  keepInBackground: (id) => {
    set({
      confirming: null,
      sessions: get().sessions.map((s) => (s.id === id ? { ...s, minimized: true } : s)),
    });
  },

  stopAndClose: (id) => {
    stopBuilder(id);
    get().close(id);
  },

  stop: (id) => stopBuilder(id),
}));
