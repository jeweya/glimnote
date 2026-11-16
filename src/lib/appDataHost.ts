/**
 * 宿主侧的小应用数据桥（docs/15）。
 *
 * 应用 iframe 没有同源权限，所有读写都通过 postMessage 回到宿主：
 *   - 已保存的应用：apps/<id>/data.json，随 Git 同步到云端；
 *   - 还没保存的预览（新建 / 导入）：先放在内存草稿里，保存后自动迁进仓库。
 *
 * 同一个应用可能同时开着多个浮窗 / 独立窗口，写操作按应用串行，
 * 写完再广播给其它窗口，避免两边各自读旧值互相覆盖。
 */
import { useCallback, useEffect, useRef } from 'react';
import { APP_BRIDGE_TAG } from './appBridge';
import { MAX_APP_DATA_BYTES, MAX_APP_DATA_KEYS, MAX_APP_DATA_VALUE_BYTES, readAppData, writeAppData } from './apps';
import { useApp } from '../store/app';
import { desktop } from './desktop';

interface DataRequest {
  __glimnote: string;
  id: string;
  op: 'get' | 'set' | 'remove' | 'all' | 'keys' | 'clear' | 'notify';
  key?: unknown;
  value?: unknown;
  title?: unknown;
  body?: unknown;
}

/** appId（或 draft:<sessionId>）→ 当前指向它的 iframe */
const frames = new Map<string, Set<HTMLIFrameElement>>();
/** 未保存预览的数据：只活在本次运行里，保存应用时迁到 data.json */
const drafts = new Map<string, Map<string, unknown>>();
/** 每个应用一条写入队列，避免多窗口同时读改写丢数据 */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) || Promise.resolve();
  const run = previous.then(task, task);
  const stored = run.catch(() => undefined);
  locks.set(key, stored);
  void stored.finally(() => {
    if (locks.get(key) === stored) locks.delete(key);
  });
  return run;
}

function sizeOf(value: unknown): number {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('这个值不能保存为应用数据');
  return new TextEncoder().encode(text).length;
}

function jsonClone<T>(value: T): T {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('这个值不能保存为应用数据');
  return JSON.parse(text) as T;
}

function cleanKey(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('数据键名必须是字符串');
  const key = raw.trim();
  if (!key) throw new Error('数据键名不能为空');
  if (key.length > 80) throw new Error('数据键名不能超过 80 个字符');
  if (/[\u0000-\u001f]/.test(key)) throw new Error('数据键名里不能有换行等不可见字符');
  return key;
}

function assertValue(value: unknown) {
  const bytes = sizeOf(value);
  if (bytes > MAX_APP_DATA_VALUE_BYTES) {
    throw new Error(`单个数据值 ${Math.round(bytes / 1024)}KB，超过 128KB 上限`);
  }
}

function draftMap(draftKey: string) {
  let map = drafts.get(draftKey);
  if (!map) {
    map = new Map();
    drafts.set(draftKey, map);
  }
  return map;
}

/** 草稿和已保存应用共用同一套操作；写入前统一做体积和键数限制 */
async function mutate<T>(appId: string, draftKey: string, task: (data: Map<string, unknown>) => T): Promise<T> {
  if (!appId) {
    const data = draftMap(draftKey);
    const result = task(data);
    if (sizeOf(Object.fromEntries(data)) > MAX_APP_DATA_BYTES) {
      throw new Error('应用数据超过 512KB 上限，请清理一些旧数据');
    }
    return result;
  }
  return withLock(appId, async () => {
    const stored = await readAppData(appId);
    const data = new Map(Object.entries(stored));
    const result = task(data);
    const next = Object.fromEntries(data);
    if (sizeOf(next) > MAX_APP_DATA_BYTES) {
      throw new Error('应用数据超过 512KB 上限，请清理一些旧数据');
    }
    await writeAppData(appId, next);
    useApp.getState().markPending();
    return result;
  });
}

async function snapshot(appId: string, draftKey: string): Promise<Map<string, unknown>> {
  if (!appId) return new Map(draftMap(draftKey));
  return withLock(appId, async () => new Map(Object.entries(await readAppData(appId))));
}

function post(source: Window | null, payload: Record<string, unknown>) {
  if (!source) return;
  try {
    source.postMessage(payload, '*');
  } catch {
    /* 窗口已经关掉，忽略即可 */
  }
}

/** 通知同一个应用的其它窗口：数据变了，按需重读 */
function broadcast(scope: string, key: string | null, except: Window | null) {
  const targets = frames.get(scope);
  if (!targets) return;
  for (const frame of targets) {
    const win = frame.contentWindow;
    if (!win || win === except) continue;
    post(win, { __glimnote: `${APP_BRIDGE_TAG}-changed`, key });
  }
}

/**
 * 应用发系统通知：桌面端走 Electron 通知，点击后回到主窗口和对应应用；
 * 网页端只在浏览器已授权时用 Notification，否则回落成站内提示，绝不弹权限请求。
 */
function sendAppNotification(title: string, body: string, appId: string): boolean {
  const bridge = desktop();
  if (bridge?.notify) {
    void bridge.notify({
      title,
      body,
      action: appId ? `app:${appId}` : undefined,
    });
    return true;
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      new Notification(title, { body });
      return true;
    } catch {
      /* 浏览器不允许时继续用站内提示 */
    }
  }
  useApp.getState().toast(body ? `${title} · ${body}` : title, 'info');
  return true;
}

async function handleRequest(
  request: DataRequest,
  event: MessageEvent,
  appId: string,
  draftKey: string,
): Promise<unknown> {
  const scope = appId || `draft:${draftKey}`;
  switch (request.op) {
    case 'get': {
      const key = cleanKey(request.key);
      const data = await snapshot(appId, draftKey);
      return jsonClone(data.get(key) ?? null);
    }
    case 'keys': {
      const data = await snapshot(appId, draftKey);
      return Array.from(data.keys());
    }
    case 'all': {
      const data = await snapshot(appId, draftKey);
      return jsonClone(Object.fromEntries(data));
    }
    case 'set': {
      const key = cleanKey(request.key);
      assertValue(request.value);
      const value = jsonClone(request.value);
      await mutate(appId, draftKey, (data) => {
        if (!data.has(key) && data.size >= MAX_APP_DATA_KEYS) {
          throw new Error(`最多保存 ${MAX_APP_DATA_KEYS} 个数据键，请先清理旧数据`);
        }
        data.set(key, value);
      });
      broadcast(scope, key, event.source as Window | null);
      return true;
    }
    case 'remove': {
      const key = cleanKey(request.key);
      await mutate(appId, draftKey, (data) => {
        data.delete(key);
      });
      broadcast(scope, key, event.source as Window | null);
      return true;
    }
    case 'clear': {
      await mutate(appId, draftKey, (data) => {
        data.clear();
      });
      broadcast(scope, null, event.source as Window | null);
      return true;
    }
    case 'notify': {
      const title = String(request.title ?? '')
        .trim()
        .slice(0, 80);
      const body = String(request.body ?? '')
        .trim()
        .slice(0, 200);
      if (!title) throw new Error('通知标题不能为空');
      return sendAppNotification(title, body, appId);
    }
    default:
      throw new Error('不支持的数据操作');
  }
}

/**
 * 挂在任何一个渲染应用 iframe 的组件上。
 * 返回的 ref 要交给 iframe；appId 为空表示预览未保存，数据只进内存草稿。
 */
export function useAppDataHost(appId: string, draftKey: string): (element: HTMLIFrameElement | null) => void {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const scopeRef = useRef({ appId, draftKey });
  scopeRef.current = { appId, draftKey };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as DataRequest | null;
      if (!data || data.__glimnote !== APP_BRIDGE_TAG || typeof data.id !== 'string') return;
      const { appId: id, draftKey: key } = scopeRef.current;
      void handleRequest(data, event, id, key)
        .then((value) => {
          post(event.source as Window | null, {
            __glimnote: `${APP_BRIDGE_TAG}-reply`,
            id: data.id,
            ok: true,
            value,
          });
        })
        .catch((e) => {
          post(event.source as Window | null, {
            __glimnote: `${APP_BRIDGE_TAG}-reply`,
            id: data.id,
            ok: false,
            error: (e as Error)?.message || '数据操作失败',
          });
        });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  /** 用 callback ref 注册；iframe 重新挂载（版本切换、重载）也能自动跟上 */
  const attach = useCallback((element: HTMLIFrameElement | null) => {
    const previous = frameRef.current;
    frameRef.current = element;
    if (previous && previous !== element) {
      for (const set of frames.values()) set.delete(previous);
    }
    if (!element) return;
    const { appId: id, draftKey: key } = scopeRef.current;
    const scope = id || `draft:${key}`;
    // 同一个 iframe 只属于一个作用域：换应用 / 草稿转正时先摘掉旧登记
    for (const [name, set] of frames) {
      if (name !== scope) set.delete(element);
    }
    let set = frames.get(scope);
    if (!set) {
      set = new Set();
      frames.set(scope, set);
    }
    set.add(element);
  }, []);

  // 草稿保存成正式应用后 appId 会从空变成 id，这里把同一个 iframe 迁到新作用域，
  // 否则广播（多窗口同步）还会发给旧的草稿集合。
  useEffect(() => {
    scopeRef.current = { appId, draftKey };
    if (frameRef.current) attach(frameRef.current);
  }, [appId, draftKey, attach]);

  // 组件卸载：把 iframe 从所有集合里摘干净，避免地图里留下死引用
  useEffect(
    () => () => {
      const element = frameRef.current;
      if (!element) return;
      for (const set of frames.values()) set.delete(element);
      frameRef.current = null;
    },
    [],
  );

  return attach;
}

/** 新建 / 导入的预览保存成正式应用后，把草稿数据并进 data.json */
export async function migrateDraftData(draftKey: string, appId: string) {
  const draft = drafts.get(draftKey);
  if (!draft || !draft.size) {
    drafts.delete(draftKey);
    return;
  }
  await withLock(appId, async () => {
    const data = await readAppData(appId);
    for (const [key, value] of draft) data[key] = value;
    if (sizeOf(data) > MAX_APP_DATA_BYTES) {
      throw new Error('草稿数据超过 512KB，未能并入应用数据');
    }
    await writeAppData(appId, data);
  });
  drafts.delete(draftKey);
  useApp.getState().markPending();
}

export function dropDraftData(draftKey: string) {
  drafts.delete(draftKey);
}
