/**
 * 首页状态：分组、入口、AI 应用索引。
 * 写操作先落盘再改内存，失败时界面保持原样；所有改动都会 markPending，
 * 交给现有的 Git 自动提交逻辑上传。
 */
import { create } from 'zustand';
import * as home from '../lib/home';
import * as apps from '../lib/apps';
import { loadAiConfig } from '../lib/ai';
import type { AppMeta } from '../lib/apps';
import { useApp } from './app';

interface AddEntryInput {
  type: home.ShortcutType;
  title?: string;
  icon?: string;
  color?: home.HomeColor;
  target?: string;
}

interface AppSaveInput {
  meta?: AppMeta;
  name: string;
  description: string;
  icon: string;
  color: apps.AppColor;
  html: string;
  groupId?: string;
  /** 应用市场模板 id：只用于防止同一个模板重复安装 */
  template?: string;
  /** 应用来源：市场安装 / AI 生成 / 外部导入；首页选择器按它分类 */
  source?: apps.AppSource;
}

interface DeletedEntry {
  entry: home.HomeEntry;
  groupId: string;
  index: number;
}

interface HomeState {
  loaded: boolean;
  loading: boolean;
  issues: number;
  data: home.HomeData | null;
  groups: home.HomeGroup[];
  entries: Record<string, home.HomeEntry>;
  apps: AppMeta[];

  load: (force?: boolean) => Promise<void>;
  addGroup: (input: { name: string; icon?: string; color?: home.HomeColor }) => Promise<home.HomeGroup>;
  updateGroup: (id: string, patch: Partial<Pick<home.HomeGroup, 'name' | 'icon' | 'color'>>) => Promise<void>;
  deleteGroup: (id: string, mode: 'move' | 'delete') => Promise<void>;
  moveGroup: (id: string, delta: number) => Promise<void>;

  addEntry: (groupId: string, input: AddEntryInput) => Promise<home.HomeEntry>;
  updateEntry: (
    id: string,
    patch: Partial<Pick<home.HomeEntry, 'type' | 'title' | 'icon' | 'color' | 'target'>>,
  ) => Promise<void>;
  deleteEntry: (id: string) => Promise<DeletedEntry>;
  restoreEntry: (deleted: DeletedEntry) => Promise<void>;
  moveEntry: (id: string, toGroupId: string, index: number) => Promise<void>;
  moveEntryBy: (id: string, delta: number) => Promise<void>;

  saveApp: (input: AppSaveInput) => Promise<AppMeta>;
  updateAppInfo: (
    id: string,
    patch: { name: string; description: string; icon: string; color: apps.AppColor },
  ) => Promise<void>;
  deleteApp: (id: string) => Promise<void>;
}

function pending() {
  useApp.getState().markPending();
}

function sortApps(list: AppMeta[]) {
  return [...list].sort((a, b) => +new Date(b.updated) - +new Date(a.updated));
}

export const useHome = create<HomeState>((set, get) => ({
  loaded: false,
  loading: false,
  issues: 0,
  data: null,
  groups: [],
  entries: {},
  apps: [],

  async load(force = false) {
    if (get().loading) return;
    if (get().loaded && !force) return;
    set({ loading: true });
    try {
      const snap = await home.loadHome();
      const list = await apps.listApps();
      set({
        data: snap.data,
        groups: snap.groups,
        entries: snap.entries,
        apps: list,
        issues: snap.issues,
        loaded: true,
        loading: false,
      });
      // 第一次使用自动播种的默认分组也要进仓库，否则换设备看不到首页；
      // 旧版把系统应用写在同步目录里，迁移后分组文件变了，同样要提交一次；
      // 合并掉同名分组的删除也要提交，否则下次同步又从别的设备拉回来
      if (snap.seeded || snap.migrated || snap.cleaned) pending();
    } catch (e) {
      console.warn('load home failed', e);
      set({ loading: false });
      useApp.getState().toast('首页配置读取失败，笔记本身不受影响', 'error');
    }
  },

  async addGroup(input) {
    const name = input.name.trim().slice(0, 40);
    if (!name) throw new Error('分组名称不能为空');
    const state = get();
    if (state.groups.length >= home.MAX_GROUPS) throw new Error(`最多 ${home.MAX_GROUPS} 个分组`);
    if (state.groups.some((g) => g.name === name)) throw new Error('已经有同名分组了');
    const group = home.makeGroup({ name, icon: input.icon, color: input.color || 'green' });
    await home.saveGroup(group);
    const data = state.data || { v: 1, groupOrder: [], settings: { showRecent: true, showStats: true } };
    const nextData = { ...data, groupOrder: [...data.groupOrder, group.id] };
    await home.saveHomeData(nextData);
    set({ data: nextData, groups: [...state.groups, group] });
    pending();
    return group;
  },

  async updateGroup(id, patch) {
    const state = get();
    const group = state.groups.find((g) => g.id === id);
    if (!group) return;
    const name = patch.name !== undefined ? patch.name.trim().slice(0, 40) : group.name;
    if (!name) throw new Error('分组名称不能为空');
    if (state.groups.some((g) => g.id !== id && g.name === name)) throw new Error('已经有同名分组了');
    const next: home.HomeGroup = {
      ...group,
      ...patch,
      name,
      updated: new Date().toISOString(),
    };
    await home.saveGroup(next);
    set({ groups: state.groups.map((g) => (g.id === id ? next : g)) });
    pending();
  },

  async deleteGroup(id, mode) {
    const state = get();
    if (state.groups.length <= 1) throw new Error('至少保留一个分组');
    const group = state.groups.find((g) => g.id === id);
    if (!group) return;
    const remaining = state.groups.filter((g) => g.id !== id);
    const target = remaining[0];
    if (mode === 'move' && target) {
      const nextTarget: home.HomeGroup = {
        ...target,
        entries: [...target.entries, ...group.entries],
        updated: new Date().toISOString(),
      };
      await home.saveGroup(nextTarget);
      set({ groups: state.groups.map((g) => (g.id === target.id ? nextTarget : g)) });
    }
    if (mode === 'delete') {
      for (const entryId of group.entries) await home.deleteEntryFile(entryId);
      const entries = { ...state.entries };
      for (const entryId of group.entries) delete entries[entryId];
      set({ entries });
    }
    await home.deleteGroupFile(id);
    const data = state.data || { v: 1, groupOrder: [], settings: { showRecent: true, showStats: true } };
    const nextData = { ...data, groupOrder: data.groupOrder.filter((gid) => gid !== id) };
    await home.saveHomeData(nextData);
    set({ data: nextData, groups: get().groups.filter((g) => g.id !== id) });
    pending();
  },

  async moveGroup(id, delta) {
    const state = get();
    const order = [...(state.data?.groupOrder || state.groups.map((g) => g.id))];
    const from = order.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to], order[from]];
    const data = {
      ...(state.data || { v: 1, groupOrder: [], settings: { showRecent: true, showStats: true } }),
      groupOrder: order,
    };
    await home.saveHomeData(data);
    const map = new Map(state.groups.map((g) => [g.id, g]));
    set({ data, groups: order.map((gid) => map.get(gid)!).filter(Boolean) });
    pending();
  },

  async addEntry(groupId, input) {
    const state = get();
    const group = state.groups.find((g) => g.id === groupId);
    if (!group) throw new Error('分组不存在');
    if (Object.keys(state.entries).length >= home.MAX_ENTRIES) throw new Error(`最多 ${home.MAX_ENTRIES} 个入口`);
    if (group.entries.length >= home.MAX_GROUP_ENTRIES)
      throw new Error(`这个分组最多放 ${home.MAX_GROUP_ENTRIES} 个入口`);
    const entry = home.makeEntry(input.type, {
      title: input.title,
      icon: input.icon,
      color: input.color,
      target: input.target,
    });
    if (entry.type === 'url') {
      const url = home.normalizeUrl(entry.target || '');
      if (!url) throw new Error('网址格式不正确，只支持 http / https');
      entry.target = url;
    }
    await home.saveEntry(entry);
    const nextGroup = { ...group, entries: [...group.entries, entry.id], updated: new Date().toISOString() };
    await home.saveGroup(nextGroup);
    set({
      entries: { ...state.entries, [entry.id]: entry },
      groups: state.groups.map((g) => (g.id === groupId ? nextGroup : g)),
    });
    pending();
    return entry;
  },

  async updateEntry(id, patch) {
    const state = get();
    const entry = state.entries[id];
    if (!entry) return;
    const next: home.HomeEntry = { ...entry, ...patch, updated: new Date().toISOString() };
    if (next.type === 'url') {
      const url = home.normalizeUrl(next.target || '');
      if (!url) throw new Error('网址格式不正确，只支持 http / https');
      next.target = url;
    }
    const group = state.groups.find((g) => g.entries.includes(id));
    // 系统应用 ↔ 其它类型：换的是「同步的分组文件里有没有这个入口」，
    // 必须重写分组，否则入口会变成没人引用的孤儿，或被错误地带到别的电脑
    const crossesLocal = (entry.type === 'system') !== (next.type === 'system');
    await home.saveEntry(next);
    let groups = state.groups;
    if (crossesLocal && group) {
      const nextGroup = { ...group, updated: next.updated };
      await home.saveGroup(nextGroup);
      groups = state.groups.map((g) => (g.id === group.id ? nextGroup : g));
    }
    set({ entries: { ...state.entries, [id]: next }, groups });
    // 系统应用的文件只在本机，改标题 / 重新选择程序不需要提交；
    // 涉及类型切换时同步分组变了，才需要交给 Git
    if (entry.type !== 'system' || next.type !== 'system') pending();
  },

  async deleteEntry(id) {
    const state = get();
    const group = state.groups.find((g) => g.entries.includes(id));
    if (!group) throw new Error('入口不存在');
    const index = group.entries.indexOf(id);
    const nextGroup = { ...group, entries: group.entries.filter((x) => x !== id), updated: new Date().toISOString() };
    await home.saveGroup(nextGroup);
    await home.deleteEntryFile(id);
    const entries = { ...state.entries };
    const entry = entries[id];
    delete entries[id];
    set({
      entries,
      groups: state.groups.map((g) => (g.id === group.id ? nextGroup : g)),
    });
    pending();
    return { entry, groupId: group.id, index };
  },

  async restoreEntry(deleted) {
    const state = get();
    const group = state.groups.find((g) => g.id === deleted.groupId);
    if (!group) return;
    const entries = [...group.entries];
    entries.splice(Math.min(deleted.index, entries.length), 0, deleted.entry.id);
    const nextGroup = { ...group, entries, updated: new Date().toISOString() };
    await home.saveEntry(deleted.entry);
    await home.saveGroup(nextGroup);
    set({
      entries: { ...state.entries, [deleted.entry.id]: deleted.entry },
      groups: state.groups.map((g) => (g.id === group.id ? nextGroup : g)),
    });
    pending();
  },

  async moveEntry(id, toGroupId, index) {
    const state = get();
    const from = state.groups.find((g) => g.entries.includes(id));
    const to = state.groups.find((g) => g.id === toGroupId);
    if (!from || !to) return;
    if (from.id !== to.id && to.entries.length >= home.MAX_GROUP_ENTRIES) {
      throw new Error(`「${to.name}」最多放 ${home.MAX_GROUP_ENTRIES} 个入口`);
    }
    if (from.id === to.id) {
      const list = [...from.entries];
      const oldIndex = list.indexOf(id);
      list.splice(oldIndex, 1);
      list.splice(Math.max(0, Math.min(index, list.length)), 0, id);
      if (oldIndex === index) return;
      const next = { ...from, entries: list, updated: new Date().toISOString() };
      await home.saveGroup(next);
      set({ groups: state.groups.map((g) => (g.id === from.id ? next : g)) });
      pending();
      return;
    }
    const fromNext = { ...from, entries: from.entries.filter((x) => x !== id), updated: new Date().toISOString() };
    const toList = [...to.entries];
    toList.splice(Math.max(0, Math.min(index, toList.length)), 0, id);
    const toNext = { ...to, entries: toList, updated: new Date().toISOString() };
    await home.saveGroup(fromNext);
    await home.saveGroup(toNext);
    set({
      groups: state.groups.map((g) => (g.id === from.id ? fromNext : g.id === to.id ? toNext : g)),
    });
    pending();
  },

  async moveEntryBy(id, delta) {
    const state = get();
    const group = state.groups.find((g) => g.entries.includes(id));
    if (!group) return;
    const index = group.entries.indexOf(id);
    await get().moveEntry(id, group.id, index + delta);
  },

  async saveApp(input) {
    const state = get();
    const existing = input.meta ? state.apps.find((a) => a.id === input.meta!.id) : null;
    const issues = apps.checkHtml(input.html);
    if (issues.length) throw new apps.AppError(`应用没有通过安全检查：${issues[0]}`, issues);

    let meta: AppMeta;
    if (existing) {
      const oldHtml = await apps.readAppHtml(existing.id);
      if (oldHtml && oldHtml !== input.html) await apps.snapshotVersion(existing.id, oldHtml);
      meta = {
        ...existing,
        name: input.name.trim().slice(0, 40) || existing.name,
        description: input.description.trim().slice(0, 160),
        icon: input.icon || existing.icon,
        color: input.color,
        version: existing.version + 1,
        model: loadAiConfig().model || existing.model,
        updated: new Date().toISOString(),
      };
      await apps.writeAppMeta(meta);
      await apps.writeAppHtml(meta.id, input.html);
      set({ apps: sortApps(state.apps.map((a) => (a.id === meta.id ? meta : a))) });
      pending();
      return meta;
    }

    if (state.apps.length >= apps.MAX_APPS) throw new Error(`最多保存 ${apps.MAX_APPS} 个应用，请先删掉不用的`);
    // 同一个市场模板只装一份：界面上的 + 已经拦过一次，这里再兜底，
    // 避免连点 / 多窗口同时安装时真的写出两份。
    if (input.template) {
      const duplicate = state.apps.find((a) => a.template === input.template);
      if (duplicate) throw new Error(`「${duplicate.name}」已经安装过了，不用重复添加`);
    }
    const id = apps.newAppId();
    meta = {
      v: 1,
      id,
      name: input.name.trim().slice(0, 40) || 'AI 小应用',
      description: input.description.trim().slice(0, 160),
      icon: input.icon || 'sparkles',
      color: input.color,
      version: 1,
      model: loadAiConfig().model || '',
      template: input.template,
      source: input.template ? 'market' : input.source || 'ai',
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };
    await apps.writeAppMeta(meta);
    await apps.writeAppHtml(meta.id, input.html);

    let groupId = input.groupId;
    let groups = state.groups;
    if (!groupId || !groups.some((g) => g.id === groupId)) {
      const appGroup = groups.find((g) => g.name === home.APP_GROUP_NAME);
      if (appGroup) groupId = appGroup.id;
      else if (groups.length < home.MAX_GROUPS) {
        const created = await get().addGroup({ name: home.APP_GROUP_NAME, icon: 'sparkles', color: 'purple' });
        groupId = created.id;
        groups = get().groups;
      } else {
        groupId = groups[0]?.id;
      }
    }
    if (groupId) {
      // 应用入口不再复制名称 / 图标 / 颜色，展示时直接读应用元数据
      const entry = await get().addEntry(groupId, { type: 'app', target: meta.id });
      void entry;
    }
    set({ apps: sortApps([meta, ...get().apps]) });
    pending();
    return meta;
  },

  async updateAppInfo(id, patch) {
    const state = get();
    const existing = state.apps.find((a) => a.id === id);
    if (!existing) throw new Error('应用不存在，可能已在其他设备删除');
    const name = patch.name.replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!name) throw new Error('应用名称不能为空');
    const description = patch.description.trim().slice(0, 160);
    const icon = patch.icon || existing.icon;
    const color = patch.color || existing.color;
    if (
      name === existing.name &&
      description === existing.description &&
      icon === existing.icon &&
      color === existing.color
    ) {
      return;
    }

    const now = new Date().toISOString();
    const meta: AppMeta = { ...existing, name, description, icon, color, updated: now };
    await apps.writeAppMeta(meta);

    // 应用外观统一由应用信息决定；入口上遗留的标题 / 图标 / 颜色覆盖值顺手清掉，
    // 免得以后出现「应用信息改过了、入口里还留着一份旧数据」。
    const entries = { ...state.entries };
    for (const entry of Object.values(state.entries)) {
      if (entry.type !== 'app' || entry.target !== id) continue;
      if (!entry.title && !entry.icon && !entry.color) continue;
      const next = { ...entry, title: undefined, icon: undefined, color: undefined, updated: now };
      await home.saveEntry(next);
      entries[next.id] = next;
    }

    set({ apps: sortApps(state.apps.map((a) => (a.id === id ? meta : a))), entries });
    pending();
  },

  async deleteApp(id) {
    const state = get();
    await apps.deleteAppFiles(id);
    const affected = Object.values(state.entries).filter((e) => e.type === 'app' && e.target === id);
    let groups = state.groups;
    for (const entry of affected) {
      const group = groups.find((g) => g.entries.includes(entry.id));
      if (!group) continue;
      const next = {
        ...group,
        entries: group.entries.filter((x) => x !== entry.id),
        updated: new Date().toISOString(),
      };
      await home.saveGroup(next);
      await home.deleteEntryFile(entry.id);
      groups = groups.map((g) => (g.id === group.id ? next : g));
    }
    const entries = { ...state.entries };
    for (const entry of affected) delete entries[entry.id];
    set({ groups, entries, apps: state.apps.filter((a) => a.id !== id) });
    pending();
  },
}));
