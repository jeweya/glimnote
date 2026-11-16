/**
 * 首页的配置数据（docs/15）。
 *
 * 和笔记、待办、灵感一样，普通入口是仓库里的普通文件：
 *   home/home.json              分组顺序 + 首页设置
 *   home/groups/<id>.json       一个分组一个文件
 *   home/entries/<id>.json      一个入口一个文件
 *
 * 系统应用例外：它记的是「这台电脑上的绝对路径」，换电脑必然失效，
 * 所以入口文件写到 .glimnote/local/home/entries/（不参与 Git 同步），
 * 分组里的摆放位置也单独记在本地 placements.json。同步的分组文件里
 * 只留其它类型的入口，另一台电脑不会看到、也不会覆盖本机的系统应用。
 *
 * 拆开存是为了减少 Git 冲突：两台设备改不同入口时改的是不同文件，
 * 不会因为它们共用一个 JSON 而整文件冲突。
 */
import { ROOT, ensureDir, listFiles, markSeedFiles, readText, removePath, writeText } from './storage';
import { uuid } from './utils';
import { desktop } from './desktop';
import { COMMON_SITES, commonAppRank } from './shortcutPresets';
import { appHtmlPath, appPath, listApps, writeAppHtml, writeAppMeta, type AppMeta } from './apps';
import { MARKET_APPS, STARTER_APP_IDS, buildMarketApp } from '../apps/market/catalog';

export const HOME_DIR = `${ROOT}/home`;
export const HOME_GROUPS = `${HOME_DIR}/groups`;
export const HOME_ENTRIES = `${HOME_DIR}/entries`;
export const HOME_FILE = `${HOME_DIR}/home.json`;

/** 只属于这台电脑的首页数据；.glimnote/local 已在同步层排除 */
const LOCAL_HOME_DIR = `${ROOT}/.glimnote/local/home`;
const LOCAL_HOME_ENTRIES = `${LOCAL_HOME_DIR}/entries`;
const LOCAL_PLACEMENTS = `${LOCAL_HOME_DIR}/placements.json`;

interface LocalPlacement {
  groupId: string;
  index: number;
}

interface PlacementFile {
  v: number;
  placements: Record<string, LocalPlacement>;
}

export type ShortcutType = 'note' | 'notebook' | 'daily' | 'view' | 'url' | 'app' | 'system';

export const SHORTCUT_TYPES: ShortcutType[] = ['note', 'notebook', 'daily', 'view', 'url', 'app', 'system'];
/** 新建入口时可选的类型；daily / view 只保留给旧入口，不再出现在选择器里 */
export const SHORTCUT_PICKER_TYPES: ShortcutType[] = ['system', 'url', 'app', 'note', 'notebook'];
export const LEGACY_SHORTCUT_TYPES: ShortcutType[] = ['daily', 'view'];

export const SHORTCUT_TYPE_LABEL: Record<ShortcutType, string> = {
  note: '笔记',
  notebook: '笔记本',
  daily: '今日日记',
  view: '智能视图',
  url: '网址',
  app: '小应用',
  system: '系统应用',
};

/** 可以在首页入口里选的智能视图；首页自身不在其中，避免套娃 */
export const HOME_VIEWS: { key: string; label: string }[] = [
  { key: 'todo', label: '待办' },
  { key: 'ideas', label: '灵感' },
  { key: 'recent', label: '最近 7 天' },
  { key: 'all', label: '全部笔记' },
  { key: 'pinned', label: '置顶' },
  { key: 'images', label: '含图片' },
  { key: 'calendar', label: '日历' },
  { key: 'timeline', label: '时间轴' },
];

export const HOME_COLORS = ['green', 'blue', 'amber', 'red', 'purple', 'gray'] as const;
export type HomeColor = (typeof HOME_COLORS)[number];

export const HOME_ICON_KEYS = [
  'star',
  'briefcase',
  'book',
  'wrench',
  'globe',
  'calculator',
  'braces',
  'lightbulb',
  'folder',
  'file',
  'link',
  'grid',
  'sparkles',
  'code',
  'clock',
  'calendar',
  'palette',
  'flask',
  'music',
  'heart',
  'house',
  'terminal',
  'database',
  'image',
  'pen',
  'monitor',
] as const;

export interface HomeEntry {
  id: string;
  type: ShortcutType;
  /** 可留空：笔记 / 应用 / 笔记本跟随目标名称 */
  title?: string;
  icon?: string;
  color?: HomeColor;
  /** 笔记 id、笔记本路径、视图键、网址或应用 id；daily 不需要 */
  target?: string;
  created: string;
  updated: string;
}

export interface HomeGroup {
  id: string;
  name: string;
  icon?: string;
  color?: HomeColor;
  /** 有序的入口 id */
  entries: string[];
  created: string;
  updated: string;
}

export interface HomeSettings {
  showRecent: boolean;
  showStats: boolean;
}

export interface HomeData {
  v: number;
  groupOrder: string[];
  settings: HomeSettings;
}

export interface HomeSnapshot {
  data: HomeData;
  groups: HomeGroup[];
  entries: Record<string, HomeEntry>;
  /** 坏文件 / 无效入口数量，首页顶部提示一次 */
  issues: number;
  /** 本次读取是否刚播种了默认分组（需要提交一次，让配置进云端） */
  seeded?: boolean;
  /** 是否把旧版同步存储里系统应用迁到了本机（需要提交一次，让仓库删掉旧文件） */
  migrated?: boolean;
  /** 是否合并过同名分组（需要提交一次，让仓库删掉多余的分组文件） */
  cleaned?: boolean;
}

export const DEFAULT_GROUP_NAME = '常用';
export const APP_GROUP_NAME = 'AI 小应用';
export const MAX_GROUPS = 20;
export const MAX_ENTRIES = 200;
export const MAX_GROUP_ENTRIES = 30;

const now = () => new Date().toISOString();

function random8() {
  return uuid().replace(/-/g, '').slice(0, 8);
}

export function newGroupId() {
  return `g-${random8()}`;
}

export function newEntryId() {
  return `e-${random8()}`;
}

/**
 * 首次播种用的固定 id。
 *
 * 首页由主窗口和浮窗各自按需播种，启动瞬间可能同时进来两次；以前每次都用
 * 随机 id，两次seed会生成两套「常用」「网站」，系统应用也就一个变两个。
 * 固定 id 让两次写入落在同一批文件上，谁后写谁覆盖，结果始终是一套。
 */
const SEED_GROUP_COMMON = 'g-seed-common';
const SEED_GROUP_SITES = 'g-seed-sites';
const SEED_GROUP_APPS = 'g-seed-apps';

function seedHash(value: string) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function seedEntryId(type: ShortcutType, target?: string) {
  return `e-seed-${type}-${seedHash(`${type}:${target || ''}`)}`;
}

function isColor(value: unknown): value is HomeColor {
  return typeof value === 'string' && (HOME_COLORS as readonly string[]).includes(value);
}

function iconName(value: unknown): string | undefined {
  return typeof value === 'string' && (HOME_ICON_KEYS as readonly string[]).includes(value) ? value : undefined;
}

function text(value: unknown, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** 网址统一成 http/https；没写协议时补 https，非法协议直接拒绝 */
export function normalizeUrl(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.hostname.includes(' ')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function hostOf(url: string | undefined) {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function normalizeEntry(raw: unknown, fallbackId = ''): HomeEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const type = o.type;
  if (typeof type !== 'string' || !SHORTCUT_TYPES.includes(type as ShortcutType)) return null;
  const id = text(o.id, 40) || fallbackId;
  if (!id) return null;
  let target = text(o.target, 2048);
  if (type === 'url') {
    const normalized = normalizeUrl(target);
    if (!normalized) return null;
    target = normalized;
  } else if (type !== 'daily' && !target) {
    return null;
  }
  if (type === 'view' && !HOME_VIEWS.some((v) => v.key === target)) return null;
  return {
    id,
    type: type as ShortcutType,
    title: text(o.title, 80) || undefined,
    icon: iconName(o.icon),
    color: isColor(o.color) ? o.color : undefined,
    target: type === 'daily' ? undefined : target,
    created: text(o.created, 40) || now(),
    updated: text(o.updated, 40) || now(),
  };
}

export function normalizeGroup(raw: unknown, fallbackId = ''): HomeGroup | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = text(o.id, 40) || fallbackId;
  const name = text(o.name, 40);
  if (!id || !name) return null;
  const entries = Array.isArray(o.entries)
    ? Array.from(new Set(o.entries.filter((x): x is string => typeof x === 'string' && Boolean(x))))
    : [];
  return {
    id,
    name,
    icon: iconName(o.icon),
    color: isColor(o.color) ? o.color : undefined,
    entries,
    created: text(o.created, 40) || now(),
    updated: text(o.updated, 40) || now(),
  };
}

function normalizeData(raw: unknown): HomeData | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const settings = o.settings && typeof o.settings === 'object' ? (o.settings as Record<string, unknown>) : {};
  return {
    v: Number(o.v) || 1,
    groupOrder: Array.isArray(o.groupOrder)
      ? Array.from(new Set(o.groupOrder.filter((x): x is string => typeof x === 'string' && Boolean(x))))
      : [],
    settings: {
      showRecent: settings.showRecent !== false,
      showStats: settings.showStats !== false,
    },
  };
}

async function readJson(path: string) {
  try {
    return JSON.parse(await readText(path)) as unknown;
  } catch {
    return null;
  }
}

async function writeJson(path: string, value: unknown) {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function ensureHomeDirs() {
  await ensureDir(HOME_DIR);
  await ensureDir(HOME_GROUPS);
  await ensureDir(HOME_ENTRIES);
  await ensureDir(LOCAL_HOME_DIR);
  await ensureDir(LOCAL_HOME_ENTRIES);
}

async function readPlacements(): Promise<Record<string, LocalPlacement>> {
  const raw = (await readJson(LOCAL_PLACEMENTS)) as Partial<PlacementFile> | null;
  if (!raw || typeof raw !== 'object' || !raw.placements || typeof raw.placements !== 'object') return {};
  const out: Record<string, LocalPlacement> = {};
  for (const [id, value] of Object.entries(raw.placements)) {
    const p = value as Partial<LocalPlacement>;
    if (typeof id !== 'string' || !id || typeof p.groupId !== 'string' || !p.groupId) continue;
    out[id] = { groupId: p.groupId, index: Math.max(0, Number(p.index) || 0) };
  }
  return out;
}

async function writePlacements(placements: Record<string, LocalPlacement>) {
  const payload: PlacementFile = { v: 1, placements };
  await writeJson(LOCAL_PLACEMENTS, payload);
}

/** 当前本机存了哪些系统应用入口（按 id） */
async function localEntryIds(): Promise<Set<string>> {
  try {
    const files = await listFiles(LOCAL_HOME_ENTRIES);
    return new Set(
      files
        .filter((file) => file.endsWith('.json') && !file.includes('冲突副本'))
        .map((file) => (file.split('/').pop() || '').replace(/\.json$/, ''))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

export function makeGroup(patch: Partial<HomeGroup> = {}): HomeGroup {
  const at = now();
  return {
    id: patch.id || newGroupId(),
    name: patch.name || '未命名分组',
    icon: patch.icon,
    color: patch.color || 'green',
    entries: patch.entries || [],
    created: patch.created || at,
    updated: patch.updated || at,
  };
}

export function makeEntry(type: ShortcutType, patch: Partial<HomeEntry> = {}): HomeEntry {
  const at = now();
  return {
    id: patch.id || newEntryId(),
    type,
    title: patch.title,
    icon: patch.icon,
    color: patch.color || 'green',
    target: patch.target,
    created: patch.created || at,
    updated: patch.updated || at,
  };
}

/** 新电脑首装时自动带上的网站分组（顺序就是首页上的顺序） */
export const SEED_SITE_NAMES = ['淘宝', '京东', '哔哩哔哩', '微博'] as const;
export const SITE_GROUP_NAME = '网站';
/** 首装时「常用」只放前 4 个本机常用应用，再多会把小应用挤到下一屏 */
const SEED_APP_LIMIT = 4;
const SEED_APP_COLORS: HomeColor[] = ['blue', 'green', 'amber', 'purple', 'red'];

/**
 * 首装时取本机最常用的几个系统应用。
 * 扫描由主进程完成，这里只排序取前 4；网页版没有桥接或扫描失败时返回空，
 * 由调用方退回内置视图入口，避免首页出现一个空分组。
 */
async function seedSystemApps(): Promise<{ name: string; path: string }[]> {
  const bridge = desktop();
  if (!bridge?.listSystemApps) return [];
  try {
    const list = await bridge.listSystemApps();
    if (!list || list.error || !Array.isArray(list.apps)) return [];
    return [...list.apps]
      .filter((app) => app && app.path)
      .sort((a, b) => {
        // 微信、钉钉、浏览器这类天天点的排前面，其余按名称
        const diff = commonAppRank(a) - commonAppRank(b);
        return diff !== 0 ? diff : a.name.localeCompare(b.name, 'zh-CN');
      })
      .slice(0, SEED_APP_LIMIT);
  } catch {
    return [];
  }
}

/**
 * 第一次使用（仓库里还没有 home/）时播种：
 *   常用 —— 本机最常用的 4 个系统应用（网页版退回内置视图）
 *   小应用 —— 随机决定 / 科学计算器 / 课程表，紧跟在「常用」下面
 *   网站 —— 淘宝 / 京东 / 哔哩哔哩 / 微博
 */
async function seedHome(): Promise<HomeSnapshot> {
  await ensureHomeDirs();
  const common = makeGroup({ id: SEED_GROUP_COMMON, name: DEFAULT_GROUP_NAME, icon: 'star', color: 'green' });
  const sites = makeGroup({ id: SEED_GROUP_SITES, name: SITE_GROUP_NAME, icon: 'globe', color: 'blue' });
  const syncEntries: HomeEntry[] = [];
  const localEntries: HomeEntry[] = [];

  const systems = await seedSystemApps();
  if (systems.length) {
    systems.forEach((app, index) => {
      const entry = makeEntry('system', {
        id: seedEntryId('system', app.path),
        title: app.name,
        icon: 'monitor',
        color: SEED_APP_COLORS[index % SEED_APP_COLORS.length],
        target: app.path,
      });
      localEntries.push(entry);
      common.entries.push(entry.id);
    });
  } else {
    // 网页版 / 扫描不可用：保留几条最常用的内置视图，不让「常用」空着
    const fallback = [
      makeEntry('daily', { id: seedEntryId('daily'), title: '今日日记', icon: 'pen', color: 'green' }),
      makeEntry('view', {
        id: seedEntryId('view', 'todo'),
        title: '待办',
        icon: 'clock',
        color: 'amber',
        target: 'todo',
      }),
      makeEntry('view', {
        id: seedEntryId('view', 'ideas'),
        title: '灵感',
        icon: 'lightbulb',
        color: 'purple',
        target: 'ideas',
      }),
      makeEntry('view', {
        id: seedEntryId('view', 'recent'),
        title: '最近 7 天',
        icon: 'calendar',
        color: 'blue',
        target: 'recent',
      }),
    ];
    for (const entry of fallback) {
      syncEntries.push(entry);
      common.entries.push(entry.id);
    }
  }

  for (const name of SEED_SITE_NAMES) {
    const preset = COMMON_SITES.find((site) => site.name === name);
    if (!preset) continue;
    // 角标（知 / B / 微……）在首页按网址匹配 COMMON_SITES 渲染，这里只存网址
    const entry = makeEntry('url', {
      id: seedEntryId('url', preset.url),
      title: preset.name,
      icon: 'globe',
      color: 'gray',
      target: preset.url,
    });
    syncEntries.push(entry);
    sites.entries.push(entry.id);
  }

  // 新仓库默认装上三个随手能用的小应用：随机决定、科学计算器、课程表。
  // 应用 id / 入口 id 都用固定值——主窗口和浮窗可能同时完成首次播种，
  // 随机 id 会写出两份应用、两个图标。
  const appGroup = makeGroup({ id: SEED_GROUP_APPS, name: APP_GROUP_NAME, icon: 'sparkles', color: 'purple' });
  const appEntries: HomeEntry[] = [];
  const appFiles: string[] = [];
  try {
    const installed = new Set((await listApps()).map((item) => item.template).filter(Boolean));
    for (const templateId of STARTER_APP_IDS) {
      if (installed.has(templateId)) continue;
      const market = MARKET_APPS.find((item) => item.id === templateId);
      if (!market) continue;
      try {
        const built = await buildMarketApp(market);
        const at = now();
        const meta: AppMeta = {
          v: 1,
          id: `seed-${market.id}`,
          name: market.name,
          description: market.description,
          icon: market.icon,
          color: market.color,
          version: 1,
          model: '',
          template: market.id,
          source: 'market',
          created: at,
          updated: at,
        };
        await writeAppMeta(meta);
        await writeAppHtml(meta.id, built.html);
        const entry = makeEntry('app', { id: `e-seed-app-${market.id}`, target: meta.id });
        appEntries.push(entry);
        appGroup.entries.push(entry.id);
        appFiles.push(appPath(meta.id), appHtmlPath(meta.id));
      } catch (e) {
        // 单个模板读不出来不影响另外两个，也不影响首页其余部分
        console.warn('seed starter app failed', templateId, e);
      }
    }
  } catch (e) {
    console.warn('seed starter apps failed', e);
  }

  // 先落入口文件：saveGroup 会读本机入口目录，判断哪些 id 只留在本机
  for (const entry of [...localEntries, ...syncEntries, ...appEntries]) await saveEntry(entry);
  await saveGroup(common);
  await saveGroup(sites);
  if (appEntries.length) await saveGroup(appGroup);

  const data: HomeData = {
    v: 1,
    // 默认顺序：常用 → 小应用 → 网站，小应用紧跟在「常用」下方
    groupOrder: appEntries.length ? [common.id, appGroup.id, sites.id] : [common.id, sites.id],
    settings: { showRecent: true, showStats: true },
  };
  await writeJson(HOME_FILE, data);

  const map: Record<string, HomeEntry> = {};
  for (const entry of [...syncEntries, ...localEntries, ...appEntries]) map[entry.id] = entry;
  // 首页是启动后按需播种的，晚于 storage.bootstrap 写示例清单；
  // 把这次生成的同步文件补登记，首次连接仓库时才不会把它们当成用户内容。
  // 默认小应用也属于「安装时原样」，一并登记。
  const seedFiles = [
    HOME_FILE,
    `${HOME_GROUPS}/${common.id}.json`,
    `${HOME_GROUPS}/${sites.id}.json`,
    ...syncEntries.map((entry) => `${HOME_ENTRIES}/${entry.id}.json`),
    ...appFiles,
  ];
  if (appEntries.length) {
    seedFiles.push(`${HOME_GROUPS}/${appGroup.id}.json`);
    seedFiles.push(...appEntries.map((entry) => `${HOME_ENTRIES}/${entry.id}.json`));
  }
  await markSeedFiles(seedFiles);
  return {
    data,
    groups: appEntries.length ? [common, appGroup, sites] : [common, sites],
    entries: map,
    issues: 0,
    seeded: true,
  };
}

/** 两个入口是否指向同一个东西（同步 / 历史恢复后，同一个视图或应用可能出现两份入口） */
function sameEntryTarget(entry: HomeEntry) {
  return entry.type === 'daily' ? 'daily' : `${entry.type}:${entry.target || ''}`;
}

/**
 * 合并同名分组。
 *
 * 界面里本来不允许重名（新建、改名都会被拦住），所以出现两份「常用」
 * 只可能来自同步合并或历史恢复：两台设备各自播种了默认分组，文件 id 不同，
 * 拉下来就并排显示。这里以 home.json 里排在前面的那份为准，把另一份的
 * 入口并进来（指向同一目标的只留一个），再删掉多余的分组文件。
 * 返回是否真的合并过，让上层提交一次。
 */
async function mergeDuplicateGroups(
  groupMap: Map<string, HomeGroup>,
  entries: Record<string, HomeEntry>,
  order: string[],
) {
  const byName = new Map<string, HomeGroup[]>();
  for (const group of groupMap.values()) {
    const key = group.name.trim();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(group);
  }

  const rank = new Map(order.map((id, index) => [id, index]));
  let cleaned = false;

  for (const list of byName.values()) {
    if (list.length < 2) continue;
    // 保留 home.json 顺序里靠前的那份；都不在顺序里就保留较新的
    list.sort((a, b) => {
      const ai = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bi = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      if (ai !== bi) return ai - bi;
      return +new Date(b.created) - +new Date(a.created);
    });
    const keeper = list[0];
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const group of list) {
      for (const entryId of group.entries) {
        const entry = entries[entryId];
        // 入口文件坏掉时先保留 id，后面统一的「清引用」会再过滤一次
        const key = entry ? sameEntryTarget(entry) : `id:${entryId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(entryId);
      }
    }

    const dropped = list.slice(1);
    keeper.entries = merged;
    keeper.updated = now();

    // 本机系统应用的位置原本挂在被删分组上，先挪到保留的那一份
    const placements = await readPlacements();
    let moved = false;
    for (const group of dropped) {
      for (const [id, place] of Object.entries(placements)) {
        if (place.groupId !== group.id) continue;
        placements[id] = { groupId: keeper.id, index: place.index };
        moved = true;
      }
    }
    if (moved) await writePlacements(placements);

    await saveGroup(keeper);
    for (const group of dropped) {
      groupMap.delete(group.id);
      await removePath(`${HOME_GROUPS}/${group.id}.json`).catch(() => {});
    }
    cleaned = true;
  }
  return cleaned;
}

/** 读取整个首页；坏文件不阻塞其它入口 */
export async function loadHome(): Promise<HomeSnapshot> {
  await ensureHomeDirs();
  let issues = 0;
  let migrated = false;

  const groupMap = new Map<string, HomeGroup>();
  for (const file of await listFiles(HOME_GROUPS)) {
    if (!file.endsWith('.json') || file.includes('冲突副本')) continue;
    const id = (file.split('/').pop() || '').replace(/\.json$/, '');
    const group = normalizeGroup(await readJson(file), id);
    if (group) groupMap.set(group.id, group);
    else issues += 1;
  }

  // 本机系统应用入口；先读，后面处理旧版同步文件时以它为准
  const localEntries: Record<string, HomeEntry> = {};
  for (const file of await listFiles(LOCAL_HOME_ENTRIES)) {
    if (!file.endsWith('.json') || file.includes('冲突副本')) continue;
    const id = (file.split('/').pop() || '').replace(/\.json$/, '');
    const entry = normalizeEntry(await readJson(file), id);
    if (!entry) {
      issues += 1;
      continue;
    }
    if (entry.type === 'system') localEntries[entry.id] = entry;
    else {
      // 类型从系统应用改成别的（或旧数据写错位置）：挪回同步入口，避免它跟着本机走
      await writeJson(`${HOME_ENTRIES}/${entry.id}.json`, entry);
      await removePath(`${LOCAL_HOME_ENTRIES}/${entry.id}.json`).catch(() => {});
    }
  }

  const syncEntries: Record<string, HomeEntry> = {};
  const legacySystem: HomeEntry[] = [];
  for (const file of await listFiles(HOME_ENTRIES)) {
    if (!file.endsWith('.json') || file.includes('冲突副本')) continue;
    const id = (file.split('/').pop() || '').replace(/\.json$/, '');
    const entry = normalizeEntry(await readJson(file), id);
    if (!entry) {
      issues += 1;
      continue;
    }
    if (entry.type === 'system') legacySystem.push(entry);
    else syncEntries[entry.id] = entry;
  }

  // 旧版本把系统应用也写进了同步目录。换到本机时先确认原路径在当前电脑上
  // 是否还存在：存在就迁移到本机；不存在（多半是另一台电脑的路径）就直接
  // 从同步配置里移除，让用户在这台电脑重新添加。
  // 只有桌面端能判断路径，网页端一律不迁移、也不删除，避免把别处的入口清掉。
  if (legacySystem.length) {
    const bridge = desktop();
    if (!bridge?.systemAppStatus) {
      for (const entry of legacySystem) syncEntries[entry.id] = entry;
    } else {
      const targets = legacySystem.map((entry) => entry.target || '').filter(Boolean);
      let existing = new Set<string>(targets);
      try {
        existing = new Set(await bridge.systemAppStatus(targets));
      } catch {
        /* 查不了就当路径还在：迁到本机总比丢掉入口好 */
      }
      for (const old of legacySystem) {
        const target = old.target || '';
        const keep = !target || existing.has(target);
        if (keep && !localEntries[old.id]) {
          await writeJson(`${LOCAL_HOME_ENTRIES}/${old.id}.json`, old);
          localEntries[old.id] = old;
        }
        await removePath(`${HOME_ENTRIES}/${old.id}.json`).catch(() => {});
        migrated = true;
      }
    }
  }

  const entryMap: Record<string, HomeEntry> = { ...syncEntries, ...localEntries };

  const rawData = await readJson(HOME_FILE);
  let data = normalizeData(rawData);

  if (!rawData && groupMap.size === 0) return seedHome();

  if (!data) {
    data = {
      v: 1,
      groupOrder: Array.from(groupMap.values())
        .sort((a, b) => +new Date(a.created) - +new Date(b.created))
        .map((g) => g.id),
      settings: { showRecent: true, showStats: true },
    };
    await writeJson(HOME_FILE, data);
  }

  // 同步合并 / 历史恢复可能留下两份同名分组（最常见的是「常用」「AI 小应用」），
  // 按 home.json 的顺序保留一份，把另一份的入口并进来，多余的组文件删掉。
  let cleaned = false;
  if (groupMap.size > 1) {
    cleaned = await mergeDuplicateGroups(groupMap, entryMap, data.groupOrder);
  }

  // 补齐后来新增但没写进 groupOrder 的分组；丢掉已删除的 id
  const known = new Set(groupMap.keys());
  const order = data.groupOrder.filter((id, index, arr) => known.has(id) && arr.indexOf(id) === index);
  for (const group of Array.from(groupMap.values()).sort((a, b) => +new Date(a.created) - +new Date(b.created))) {
    if (!order.includes(group.id)) order.push(group.id);
  }
  data.groupOrder = order;

  // 清理指向不存在入口的引用，以及没有任何分组引用的孤儿入口。
  // 同一个分组里指向同一目标的入口只留一个：两次播种 / 历史恢复最容易留下
  // 「微信两个、钉钉两个」这种重复，分组文件里两条都还在。
  const referenced = new Set<string>();
  const groups: HomeGroup[] = [];
  const dedupedGroups = new Set<string>();
  for (const id of order) {
    const group = groupMap.get(id);
    if (!group) continue;
    const before = group.entries.length;
    const seenTargets = new Set<string>();
    group.entries = group.entries.filter((entryId) => {
      const entry = entryMap[entryId];
      if (!entry || referenced.has(entryId)) return false;
      const key = sameEntryTarget(entry);
      if (seenTargets.has(key)) {
        dedupedGroups.add(group.id);
        return false;
      }
      seenTargets.add(key);
      referenced.add(entryId);
      return true;
    });
    if (group.entries.length !== before) issues += 1;
    groups.push(group);
  }

  // 本机入口不写进同步分组，摆放位置单独记；这里按上次的位置插回分组。
  // 插回前先看看目标分组里是不是已经有指向同一应用的入口：有就把这条本机
  // 入口文件删掉，而不是再插一个，否则每次加载都会多出一个图标。
  if (groups.length) {
    const placements = await readPlacements();
    const pending = new Map<string, HomeEntry[]>();
    const staleLocal: HomeEntry[] = [];
    for (const entry of Object.values(localEntries)) {
      if (referenced.has(entry.id)) continue;
      const place = placements[entry.id];
      const groupId = place && groups.some((group) => group.id === place.groupId) ? place.groupId : groups[0].id;
      const group = groups.find((item) => item.id === groupId);
      if (!group) continue;
      const key = sameEntryTarget(entry);
      const occupied =
        group.entries.some((entryId) => {
          const other = entryMap[entryId];
          return Boolean(other && sameEntryTarget(other) === key);
        }) || (pending.get(groupId) || []).some((item) => sameEntryTarget(item) === key);
      if (occupied) {
        staleLocal.push(entry);
        continue;
      }
      const list = pending.get(groupId) || [];
      list.push(entry);
      pending.set(groupId, list);
      referenced.add(entry.id);
    }
    if (staleLocal.length) {
      let placementsChanged = false;
      for (const entry of staleLocal) {
        await removePath(`${LOCAL_HOME_ENTRIES}/${entry.id}.json`).catch(() => {});
        if (placements[entry.id]) {
          delete placements[entry.id];
          placementsChanged = true;
        }
      }
      if (placementsChanged) await writePlacements(placements);
    }
    for (const [groupId, list] of pending) {
      const group = groups.find((item) => item.id === groupId);
      if (!group) continue;
      list.sort((a, b) => {
        const ai = placements[a.id]?.index ?? Number.MAX_SAFE_INTEGER;
        const bi = placements[b.id]?.index ?? Number.MAX_SAFE_INTEGER;
        return ai - bi;
      });
      for (const entry of list) {
        const place = placements[entry.id];
        const at =
          place && place.groupId === groupId
            ? Math.max(0, Math.min(place.index, group.entries.length))
            : group.entries.length;
        group.entries.splice(at, 0, entry.id);
      }
    }
  }

  // 去重后的分组引用写回仓库，下一次同步其它设备也不会再看到重复图标
  for (const groupId of dedupedGroups) {
    const group = groups.find((item) => item.id === groupId);
    if (group) await saveGroup(group);
  }

  // 迁移过的分组要重写一次：同步文件里去掉系统应用，位置转存到本机。
  if (migrated) {
    for (const group of groups) await saveGroup(group);
  }

  // 合并过同名分组：把清理后的顺序写回 home.json，下次启动不再补回已删的 id
  if (cleaned) await writeJson(HOME_FILE, data);

  return { data, groups, entries: entryMap, issues, migrated, cleaned };
}

export async function saveHomeData(data: HomeData) {
  await writeJson(HOME_FILE, data);
}

/**
 * 保存分组。group.entries 里可能有本机系统应用：同步文件只写其它入口，
 * 同时把系统应用在三栏里的位置记到 .glimnote/local/home/placements.json。
 */
export async function saveGroup(group: HomeGroup) {
  await ensureHomeDirs();
  const localIds = await localEntryIds();
  const synced: HomeGroup = {
    ...group,
    entries: group.entries.filter((entryId) => !localIds.has(entryId)),
  };
  await writeJson(`${HOME_GROUPS}/${group.id}.json`, synced);

  const placements = await readPlacements();
  let changed = false;
  for (const id of Object.keys(placements)) {
    if (placements[id].groupId === group.id) {
      delete placements[id];
      changed = true;
    }
  }
  group.entries.forEach((entryId, index) => {
    if (!localIds.has(entryId)) return;
    placements[entryId] = { groupId: group.id, index };
    changed = true;
  });
  if (changed) await writePlacements(placements);
}

/** 系统应用只写本机目录；其它入口写同步目录，并清掉旧位置的文件 */
export async function saveEntry(entry: HomeEntry) {
  await ensureHomeDirs();
  const syncedPath = `${HOME_ENTRIES}/${entry.id}.json`;
  const localPath = `${LOCAL_HOME_ENTRIES}/${entry.id}.json`;
  if (entry.type === 'system') {
    await writeJson(localPath, entry);
    await removePath(syncedPath).catch(() => {});
  } else {
    await writeJson(syncedPath, entry);
    await removePath(localPath).catch(() => {});
  }
}

export async function deleteEntryFile(id: string) {
  await removePath(`${HOME_ENTRIES}/${id}.json`).catch(() => {});
  await removePath(`${LOCAL_HOME_ENTRIES}/${id}.json`).catch(() => {});
  const placements = await readPlacements();
  if (placements[id]) {
    delete placements[id];
    await writePlacements(placements);
  }
}

export async function deleteGroupFile(id: string) {
  await removePath(`${HOME_GROUPS}/${id}.json`).catch(() => {});
  const placements = await readPlacements();
  let changed = false;
  for (const entryId of Object.keys(placements)) {
    if (placements[entryId].groupId !== id) continue;
    delete placements[entryId];
    changed = true;
  }
  if (changed) await writePlacements(placements);
}
