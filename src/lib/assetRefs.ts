/**
 * 资源引用的同步：把「哪篇笔记还引用着哪个文件」写进登记表。
 *
 * 正文是唯一事实来源，这里只做两件事：
 * 1. 启动（或用户点「重新扫描」）时全量重建一次；
 * 2. 平时监听笔记变化，只对改过的那几篇做增量更新——正文里删掉图片链接，
 *    表里对应的引用记录立刻消失，存储管理不用每次重扫全部文章。
 *
 * 只监听 store 的 notes / trash 数组变化：updateContent 每次都换新数组，
 * 其余状态改动直接跳过，不会因为同步进度、弹窗开合反复扫正文。
 */
import { useApp } from '../store/app';
import { assetLinksOf, refPathOf } from './assetLinks';
import { applyNoteRefsBatch, replaceAllRefs } from './assetIndex';
import type { Note } from './markdown';

let started = false;
let primed = false;
let priming: Promise<void> | null = null;
/** 已经算过链接的笔记：id → 上次的路径与正文，用来做差异 */
const seen = new Map<string, { path: string; content: string }>();
/** 只记「哪几篇笔记变了」，到真正落表时再解析正文，免得每次按键都扫一遍全文 */
let pending = new Set<string>();
let flushTimer: number | null = null;

function linksOf(note: Note) {
  return assetLinksOf(note.content, refPathOf(note));
}

/** 全量校对：只写有变化的记录 */
export async function rebuildAssetRefs() {
  if (flushTimer) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  pending.clear();
  const state = useApp.getState();
  const all = [...state.notes, ...state.trash];
  seen.clear();
  // 一篇笔记会引用多个资源，这里按资源汇总：rel → { 笔记 id: 次数 }，
  // 正好是登记表里每条资源下面的 refs 结构。
  const computed = new Map<string, Record<string, number>>();
  for (const note of all) {
    seen.set(note.id, { path: note.path, content: note.content });
    for (const [rel, count] of linksOf(note)) {
      const refs = computed.get(rel) || {};
      refs[note.id] = count;
      computed.set(rel, refs);
    }
  }
  await replaceAllRefs(computed);
}

function scheduleFlush() {
  if (flushTimer) window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    const ids = [...pending];
    pending = new Set();
    if (!ids.length) return;
    const state = useApp.getState();
    const all = new Map<string, Note>();
    for (const note of [...state.notes, ...state.trash]) all.set(note.id, note);
    const batch: [string, Map<string, number>][] = ids.map((id) => {
      const note = all.get(id);
      return [id, note ? linksOf(note) : new Map()];
    });
    void applyNoteRefsBatch(batch).catch(() => {});
  }, 1200);
}

function diff() {
  const state = useApp.getState();
  if (!state.ready) return;
  const alive = new Set<string>();
  for (const note of [...state.notes, ...state.trash]) {
    alive.add(note.id);
    const prev = seen.get(note.id);
    if (prev && prev.path === note.path && prev.content === note.content) continue;
    seen.set(note.id, { path: note.path, content: note.content });
    pending.add(note.id);
  }
  for (const id of [...seen.keys()]) {
    if (alive.has(id)) continue;
    seen.delete(id);
    pending.add(id);
  }
  if (pending.size) scheduleFlush();
}

function prime() {
  if (priming) return priming;
  priming = rebuildAssetRefs()
    .then(() => {
      primed = true;
      diff();
    })
    .catch(() => {
      primed = true;
    });
  return priming;
}

export function assetRefSyncStarted() {
  return started;
}

export function startAssetRefSync() {
  if (started) return;
  started = true;
  useApp.subscribe((state, prev) => {
    // 笔记还没加载完时什么都不做：空列表会把上一台设备留下的引用全清掉
    if (!state.ready) return;
    if (state.notes === prev.notes && state.trash === prev.trash) return;
    if (!primed) {
      void prime();
      return;
    }
    diff();
  });
  if (useApp.getState().ready) void prime();
}

/** 存储管理打开时等首次校对完成，避免读到上一台设备留下的引用次数 */
export async function ensureAssetRefsReady() {
  if (!started) startAssetRefSync();
  if (priming) {
    await priming;
    return;
  }
  if (useApp.getState().ready && !primed) await prime();
}
