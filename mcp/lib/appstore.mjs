/**
 * AI 小应用与首页入口的读写层。
 *
 * 磁盘规则镜像 src/lib/apps.ts、src/lib/home.ts：
 *   apps/<id>/app.json + index.html + data.json    应用本体，跟 Git 同步
 *   .glimnote/history/apps/<id>/<时间>.html        本机历史快照，不参与同步
 *   home/home.json                                 分组顺序 + 首页设置
 *   home/groups/<id>.json                          一个分组一个文件
 *   home/entries/<id>.json                         一个同步入口一个文件
 *   .glimnote/local/home/entries/<id>.json         系统应用入口，只留本机
 *
 * 生成的 HTML 按不可信代码处理：保存前做与桌面端一致的静态检查，
 * 挡掉本地存储、Cookie、宿主窗口、嵌套页面与自动跳转。
 */

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { StoreError } from './errors.mjs';

export const APPS_DIR = 'apps';
export const APP_HISTORY = '.glimnote/history/apps';
export const MAX_APPS = 50;
export const MAX_HTML_BYTES = 200 * 1024;
export const MAX_VERSIONS = 10;
export const MAX_APP_DATA_BYTES = 512 * 1024;
export const MAX_APP_DATA_VALUE_BYTES = 128 * 1024;
export const MAX_APP_DATA_KEYS = 200;

export const APP_COLORS = ['green', 'blue', 'amber', 'red', 'purple', 'gray'];
export const APP_SOURCES = ['market', 'ai', 'import'];

export const HOME_DIR = 'home';
export const HOME_GROUPS = `${HOME_DIR}/groups`;
export const HOME_ENTRIES = `${HOME_DIR}/entries`;
export const HOME_FILE = `${HOME_DIR}/home.json`;
export const LOCAL_HOME_ENTRIES = '.glimnote/local/home/entries';
export const LOCAL_PLACEMENTS = '.glimnote/local/home/placements.json';

export const HOME_COLORS = ['green', 'blue', 'amber', 'red', 'purple', 'gray'];
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
];

export const SHORTCUT_TYPES = ['note', 'notebook', 'daily', 'view', 'url', 'app', 'system'];
export const SHORTCUT_TYPE_LABEL = {
  note: '笔记',
  notebook: '笔记本',
  daily: '今日日记',
  view: '智能视图',
  url: '网址',
  app: '小应用',
  system: '系统应用',
};
export const HOME_VIEWS = ['todo', 'ideas', 'recent', 'all', 'pinned', 'images', 'calendar', 'timeline'];
export const DEFAULT_GROUP_NAME = '常用';
export const APP_GROUP_NAME = 'AI 小应用';
export const MAX_GROUPS = 20;
export const MAX_ENTRIES = 200;
export const MAX_GROUP_ENTRIES = 30;

const now = () => new Date().toISOString();

function random8() {
  try {
    return randomUUID().replace(/-/g, '').slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  }
}

function newAppId() {
  return `${Date.now().toString(36).slice(-4)}${random8()}`.slice(0, 12);
}

function newGroupId() {
  return `g-${random8()}`;
}

function newEntryId() {
  return `e-${random8()}`;
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cleanName(value, max = 40) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function idText(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9_-]{1,40}$/.test(raw) ? raw : '';
}

function isColor(value) {
  return typeof value === 'string' && APP_COLORS.includes(value);
}

function isHomeColor(value) {
  return typeof value === 'string' && HOME_COLORS.includes(value);
}

function iconName(value) {
  return typeof value === 'string' && HOME_ICON_KEYS.includes(value) ? value : undefined;
}

export function normalizeAppMeta(raw, fallbackId = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw;
  const id = idText(o.id) || idText(fallbackId);
  const name = text(o.name, 40);
  if (!id || !name) return null;
  const template = text(o.template, 40) || undefined;
  const source = template ? 'market' : APP_SOURCES.includes(o.source) ? o.source : 'ai';
  return {
    v: Number(o.v) || 1,
    id,
    name,
    description: text(o.description, 160),
    icon: text(o.icon, 32) || 'sparkles',
    color: isColor(o.color) ? o.color : 'green',
    version: Math.max(1, Number(o.version) || 1),
    model: text(o.model, 80),
    template,
    source,
    created: text(o.created, 40) || now(),
    updated: text(o.updated, 40) || now(),
  };
}

export function normalizeUrl(raw) {
  let value = String(raw ?? '').trim();
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

export function normalizeEntry(raw, fallbackId = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw;
  const type = o.type;
  if (typeof type !== 'string' || !SHORTCUT_TYPES.includes(type)) return null;
  const id = idText(o.id) || idText(fallbackId);
  if (!id) return null;
  let target = text(o.target, 2048);
  if (type === 'url') {
    const normalized = normalizeUrl(target);
    if (!normalized) return null;
    target = normalized;
  } else if (type !== 'daily' && !target) {
    return null;
  }
  if (type === 'view' && !HOME_VIEWS.includes(target)) return null;
  return {
    id,
    type,
    title: text(o.title, 80) || undefined,
    icon: iconName(o.icon),
    color: isHomeColor(o.color) ? o.color : undefined,
    target: type === 'daily' ? undefined : target,
    created: text(o.created, 40) || now(),
    updated: text(o.updated, 40) || now(),
  };
}

export function normalizeGroup(raw, fallbackId = '') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw;
  const id = idText(o.id) || idText(fallbackId);
  const name = text(o.name, 40);
  if (!id || !name) return null;
  const entries = Array.isArray(o.entries)
    ? Array.from(new Set(o.entries.filter((x) => typeof x === 'string' && idText(x))))
    : [];
  return {
    id,
    name,
    icon: iconName(o.icon),
    color: isHomeColor(o.color) ? o.color : undefined,
    entries,
    created: text(o.created, 40) || now(),
    updated: text(o.updated, 40) || now(),
  };
}

function normalizeHomeData(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  return {
    v: Number(raw.v) || 1,
    groupOrder: Array.isArray(raw.groupOrder)
      ? Array.from(new Set(raw.groupOrder.filter((x) => typeof x === 'string' && idText(x))))
      : [],
    settings: {
      showRecent: settings.showRecent !== false,
      showStats: settings.showStats !== false,
    },
  };
}

export function makeGroup(patch = {}) {
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

function makeEntry(type, patch = {}) {
  const at = now();
  return {
    id: patch.id || newEntryId(),
    type,
    title: patch.title,
    icon: patch.icon,
    color: patch.color,
    target: patch.target,
    created: patch.created || at,
    updated: patch.updated || at,
  };
}

/** 与 src/lib/apps.ts 的 checkHtml 完全一致：命中任何一条都不允许保存 */
export function checkAppHtml(html) {
  const source = String(html ?? '');
  if (!source.trim()) return ['应用内容为空'];
  const issues = [];
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > MAX_HTML_BYTES) issues.push(`代码体积 ${Math.round(bytes / 1024)}KB，超过 200KB 上限`);
  if (!/<html[\s>]/i.test(source) && !/<!doctype\s+html/i.test(source)) issues.push('缺少完整的 HTML 文档结构');
  const rules = [
    { re: /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i, msg: '包含自动跳转（meta refresh）' },
    { re: /\b(?:localStorage|sessionStorage)\b/i, msg: '尝试读写浏览器本地存储' },
    { re: /\bdocument\.cookie\b/i, msg: '尝试读取 Cookie' },
    { re: /\bwindow\.parent\b|\bparent\.document\b|\bwindow\.top\b|\btop\.location\b/i, msg: '尝试访问宿主窗口' },
    { re: /<base\b/i, msg: '包含 <base> 标签' },
    { re: /<iframe\b|<object\b|<embed\b/i, msg: '包含嵌套页面或插件' },
    { re: /javascript\s*:/i, msg: '包含 javascript: 链接' },
  ];
  for (const rule of rules) if (rule.re.test(source)) issues.push(rule.msg);
  return Array.from(new Set(issues));
}

export function createAppStore(io) {
  const { root, abs, assertRel, exists, ensureDir, readText, writeAtomic, findNote, scanNotes } = io;

  function checked(rel, kind) {
    return assertRel(rel, kind).full;
  }

  async function readRaw(rel, kind) {
    try {
      return await readText(checked(rel, kind));
    } catch {
      return null;
    }
  }

  async function readJson(rel, kind) {
    const raw = await readRaw(rel, kind);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function writeJson(rel, kind, value) {
    await writeAtomic(checked(rel, kind), `${JSON.stringify(value, null, 2)}\n`);
  }

  async function fileSize(full) {
    try {
      return (await fs.stat(full)).size;
    } catch {
      return 0;
    }
  }

  async function listFiles(dirRel, ext = '.json') {
    const entries = await fs.readdir(abs(dirRel), { withFileTypes: true }).catch(() => []);
    return entries
      .filter(
        (entry) =>
          entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(ext) && !entry.name.includes('冲突副本'),
      )
      .map((entry) => `${dirRel}/${entry.name}`);
  }

  async function listDirs(dirRel) {
    const entries = await fs.readdir(abs(dirRel), { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name);
  }

  function appDir(id) {
    return `${APPS_DIR}/${id}`;
  }

  function appPath(id) {
    return `${appDir(id)}/app.json`;
  }

  function appHtmlPath(id) {
    return `${appDir(id)}/index.html`;
  }

  function appDataPath(id) {
    return `${appDir(id)}/data.json`;
  }

  async function readAppMeta(id) {
    if (!idText(id)) return null;
    return normalizeAppMeta(await readJson(appPath(id), 'app'), id);
  }

  async function readAppHtml(id) {
    return (await readRaw(appHtmlPath(id), 'app')) ?? '';
  }

  async function appView(meta) {
    return {
      ...meta,
      htmlBytes: await fileSize(abs(appHtmlPath(meta.id))),
      dataBytes: await fileSize(abs(appDataPath(meta.id))),
    };
  }

  async function listApps() {
    const out = [];
    for (const id of await listDirs(APPS_DIR)) {
      const meta = await readAppMeta(id);
      if (meta) out.push(await appView(meta));
    }
    return out.sort((a, b) => +new Date(b.updated) - +new Date(a.updated));
  }

  async function findApp(key) {
    const needle = String(key ?? '').trim();
    if (!needle) throw new StoreError('需要提供应用 id 或名称', 'MISSING_LOCATOR');
    const apps = await listApps();
    const byId = apps.find((app) => app.id === needle);
    if (byId) return byId;
    const byName = apps.filter((app) => app.name === needle);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
      throw new StoreError(
        `名称「${needle}」有 ${byName.length} 个应用，请改用 id：${byName.map((app) => app.id).join('、')}`,
        'AMBIGUOUS',
      );
    }
    throw new StoreError(`找不到应用「${needle}」（id/name 都没匹配上）`, 'NOT_FOUND');
  }

  async function snapshotVersion(id, html) {
    if (!html.trim()) return;
    const stamp = now().replace(/[:.]/g, '-');
    const dir = `${APP_HISTORY}/${id}`;
    await ensureDir(abs(dir));
    const file = `${dir}/${stamp}.html`;
    await writeAtomic(checked(file, 'app'), html);
    const files = (await listFiles(dir, '.html'))
      .map((item) => item.split('/').pop())
      .filter(Boolean)
      .sort();
    for (const old of files.slice(0, Math.max(0, files.length - MAX_VERSIONS))) {
      await fs.rm(abs(`${dir}/${old}`), { force: true }).catch(() => {});
    }
  }

  async function listVersions(id) {
    const dir = `${APP_HISTORY}/${id}`;
    const files = (await listFiles(dir, '.html')).map((item) => item.split('/').pop()).filter(Boolean);
    return files
      .map((name) => {
        const at = name
          .replace(/\.html$/, '')
          .replace(/T/, ' ')
          .replace(/-(\d{2})-(\d{2})-(\d{3})Z?$/, ':$1:$2');
        return { name, path: `${dir}/${name}`, at };
      })
      .sort((a, b) => (a.name < b.name ? 1 : -1));
  }

  function versionName(input) {
    const name = String(input ?? '')
      .trim()
      .replace(/\.html$/i, '');
    if (!name || !/^[A-Za-z0-9_.-]+$/.test(name) || name.includes('..')) {
      throw new StoreError('版本名不合法，请使用 list_app_versions 返回的 name', 'BAD_PATH');
    }
    return name;
  }

  async function readVersion(id, name) {
    const clean = versionName(name);
    const raw = await readRaw(`${APP_HISTORY}/${id}/${clean}.html`, 'app');
    if (raw === null) throw new StoreError(`找不到版本「${clean}」`, 'NOT_FOUND');
    return raw;
  }

  async function createApp(input = {}) {
    const name = cleanName(input.name, 40);
    if (!name) throw new StoreError('应用名称不能为空', 'BAD_TITLE');
    const html = String(input.html ?? '');
    const issues = checkAppHtml(html);
    if (issues.length) throw new StoreError(`应用没有通过安全检查：${issues[0]}`, 'BAD_HTML');

    const apps = await listApps();
    if (apps.length >= MAX_APPS) throw new StoreError(`最多保存 ${MAX_APPS} 个应用，请先删掉不用的`, 'TOO_MANY');
    const template = text(input.template, 40) || undefined;
    if (template) {
      const duplicate = apps.find((app) => app.template === template);
      if (duplicate) throw new StoreError(`「${duplicate.name}」已经安装过了，不用重复添加`, 'DUPLICATE');
    }

    const id = newAppId();
    const at = now();
    const meta = {
      v: 1,
      id,
      name,
      description: text(input.description, 160),
      icon: text(input.icon, 32) || 'sparkles',
      color: isColor(input.color) ? input.color : 'green',
      version: 1,
      model: text(input.model, 80),
      template,
      source: template ? 'market' : APP_SOURCES.includes(input.source) ? input.source : 'ai',
      created: at,
      updated: at,
    };

    try {
      await writeAtomic(checked(appHtmlPath(id), 'app'), html);
      await writeJson(appPath(id), 'app', meta);
    } catch (error) {
      await fs.rm(abs(appDir(id)), { recursive: true, force: true }).catch(() => {});
      throw error;
    }

    let home = null;
    let warning = '';
    if (input.addToHome !== false) {
      let groupId = input.groupId;
      const groupName = input.groupName;
      if (!groupId && !groupName) {
        // 与桌面端 saveApp 一致：优先放进「AI 小应用」分组，没有就建一个
        const state = await readHomeState();
        const appGroup = state.groups.find((group) => group.name === APP_GROUP_NAME);
        if (appGroup) groupId = appGroup.id;
        else if (state.groups.length < MAX_GROUPS) {
          try {
            const created = await createGroupInternal(state, {
              name: APP_GROUP_NAME,
              icon: 'sparkles',
              color: 'purple',
            });
            groupId = created.id;
          } catch {
            /* 建组失败就退回第一个分组 */
          }
        }
      }
      try {
        home = await addHomeEntry({ type: 'app', target: id, groupId, groupName });
      } catch (error) {
        warning = `应用已保存，但没能加到首页：${error.message}`;
      }
    }
    return { app: await appView(meta), home, warning: warning || undefined };
  }

  async function updateApp(key, patch = {}) {
    const existing = await findApp(key);
    const meta = { ...existing };
    delete meta.htmlBytes;
    delete meta.dataBytes;

    if (patch.name !== undefined) {
      const name = cleanName(patch.name, 40);
      if (!name) throw new StoreError('应用名称不能为空', 'BAD_TITLE');
      meta.name = name;
    }
    if (patch.description !== undefined) meta.description = text(patch.description, 160);
    if (patch.icon !== undefined) meta.icon = text(patch.icon, 32) || existing.icon;
    if (patch.color !== undefined) {
      if (!isColor(patch.color))
        throw new StoreError('颜色只能是 green / blue / amber / red / purple / gray', 'BAD_COLOR');
      meta.color = patch.color;
    }
    if (patch.model !== undefined) meta.model = text(patch.model, 80);

    let versionBumped = false;
    if (patch.html !== undefined) {
      const html = String(patch.html ?? '');
      const issues = checkAppHtml(html);
      if (issues.length) throw new StoreError(`应用没有通过安全检查：${issues[0]}`, 'BAD_HTML');
      const oldHtml = await readAppHtml(existing.id);
      if (oldHtml && oldHtml !== html) await snapshotVersion(existing.id, oldHtml);
      await writeAtomic(checked(appHtmlPath(existing.id), 'app'), html);
      if (oldHtml !== html) {
        meta.version = existing.version + 1;
        versionBumped = true;
      }
    }

    meta.updated = now();
    await writeJson(appPath(existing.id), 'app', meta);
    return { app: await appView(meta), versionBumped };
  }

  async function deleteApp(key) {
    const app = await findApp(key);
    await fs.rm(abs(appDir(app.id)), { recursive: true, force: true }).catch(() => {});
    await fs.rm(abs(`${APP_HISTORY}/${app.id}`), { recursive: true, force: true }).catch(() => {});

    const state = await readHomeState();
    const affected = Object.values(state.entries).filter((entry) => entry.type === 'app' && entry.target === app.id);
    for (const entry of affected) {
      for (const group of state.groups) {
        if (!group.entries.includes(entry.id)) continue;
        group.entries = group.entries.filter((id) => id !== entry.id);
        group.updated = now();
        await saveGroup(group);
      }
      await deleteEntryFile(entry.id);
    }
    return { deleted: true, app, removedEntries: affected.length };
  }

  async function getApp(key, opts = {}) {
    const meta = await findApp(key);
    const result = { app: await appView(meta) };
    if (opts.includeHtml !== false) result.html = await readAppHtml(meta.id);
    if (opts.includeData) result.data = await readAppData(meta.id);
    result.versions = await listVersions(meta.id);
    return result;
  }

  async function restoreVersion(key, name) {
    const meta = await findApp(key);
    const html = await readVersion(meta.id, name);
    const result = await updateApp(meta.id, { html });
    return { restored: true, version: versionName(name), app: result.app };
  }

  /* ---------------- 应用数据 ---------------- */

  async function readAppData(id) {
    const parsed = await readJson(appDataPath(id), 'app');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const data = parsed.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return data;
  }

  function validateAppData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new StoreError('应用数据必须是一个 JSON 对象', 'BAD_DATA');
    }
    const keys = Object.keys(data);
    if (keys.length > MAX_APP_DATA_KEYS) {
      throw new StoreError(`应用数据最多 ${MAX_APP_DATA_KEYS} 个键，当前 ${keys.length} 个`, 'TOO_LARGE');
    }
    let total = 0;
    for (const key of keys) {
      if (key.length > 200) throw new StoreError(`数据键名过长：${key.slice(0, 20)}…`, 'TOO_LARGE');
      let value;
      try {
        value = JSON.stringify(data[key]);
      } catch {
        throw new StoreError(`键「${key}」的值不能序列化成 JSON`, 'BAD_DATA');
      }
      if (value === undefined) throw new StoreError(`键「${key}」的值不能序列化成 JSON`, 'BAD_DATA');
      const bytes = Buffer.byteLength(value, 'utf8');
      if (bytes > MAX_APP_DATA_VALUE_BYTES) {
        throw new StoreError(`键「${key}」的值 ${Math.round(bytes / 1024)}KB，超过 128KB 上限`, 'TOO_LARGE');
      }
      total += bytes;
    }
    if (total > MAX_APP_DATA_BYTES) {
      throw new StoreError(`应用数据共 ${Math.round(total / 1024)}KB，超过 512KB 上限`, 'TOO_LARGE');
    }
  }

  async function writeAppData(id, data) {
    validateAppData(data);
    const payload = { v: 1, updated: now(), data };
    await writeJson(appDataPath(id), 'app', payload);
    return { keys: Object.keys(data).length, bytes: Buffer.byteLength(JSON.stringify(payload, null, 2)) };
  }

  async function getAppData(key) {
    const app = await findApp(key);
    const data = await readAppData(app.id);
    return {
      app: { id: app.id, name: app.name },
      keys: Object.keys(data).length,
      bytes: await fileSize(abs(appDataPath(app.id))),
      data,
    };
  }

  async function setAppData(key, payload = {}) {
    const app = await findApp(key);
    const current = await readAppData(app.id);
    let data = payload.replace === true ? {} : { ...current };

    if (payload.data !== undefined) {
      if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
        throw new StoreError('data 必须是一个 JSON 对象', 'BAD_DATA');
      }
      data = payload.replace === true ? { ...payload.data } : { ...data, ...payload.data };
    }
    if (payload.values !== undefined) {
      if (!payload.values || typeof payload.values !== 'object' || Array.isArray(payload.values)) {
        throw new StoreError('values 必须是一个 JSON 对象', 'BAD_DATA');
      }
      data = { ...data, ...payload.values };
    }
    const removeKeys = Array.isArray(payload.removeKeys) ? payload.removeKeys : [];
    for (const item of removeKeys) {
      const name = String(item ?? '').trim();
      if (name) delete data[name];
    }
    if (payload.data === undefined && payload.values === undefined && !removeKeys.length) {
      throw new StoreError('没有要写入的数据（提供 data、values 或 removeKeys）', 'EMPTY_CONTENT');
    }
    const stats = await writeAppData(app.id, data);
    return { updated: true, app: { id: app.id, name: app.name }, ...stats };
  }

  async function clearAppData(key) {
    const app = await findApp(key);
    const stats = await writeAppData(app.id, {});
    return { cleared: true, app: { id: app.id, name: app.name }, ...stats };
  }

  /* ---------------- 首页入口 ---------------- */

  async function ensureHomeDirs() {
    await ensureDir(abs(HOME_GROUPS));
    await ensureDir(abs(HOME_ENTRIES));
    await ensureDir(abs(LOCAL_HOME_ENTRIES));
  }

  async function readPlacements() {
    const raw = await readJson(LOCAL_PLACEMENTS, 'home');
    if (!raw || typeof raw !== 'object' || !raw.placements || typeof raw.placements !== 'object') return {};
    const out = {};
    for (const [id, value] of Object.entries(raw.placements)) {
      const place = value && typeof value === 'object' ? value : {};
      const groupId = typeof place.groupId === 'string' && idText(place.groupId) ? place.groupId : '';
      if (!idText(id) || !groupId) continue;
      out[id] = { groupId, index: Math.max(0, Number(place.index) || 0) };
    }
    return out;
  }

  async function writePlacements(placements) {
    await writeJson(LOCAL_PLACEMENTS, 'home', { v: 1, placements });
  }

  async function localEntryIds() {
    const files = await listFiles(LOCAL_HOME_ENTRIES, '.json');
    return new Set(files.map((file) => (file.split('/').pop() || '').replace(/\.json$/, '')).filter(Boolean));
  }

  async function saveHomeData(data) {
    await writeJson(HOME_FILE, 'home', data);
  }

  async function saveGroup(group) {
    await ensureHomeDirs();
    const localIds = await localEntryIds();
    const synced = { ...group, entries: group.entries.filter((id) => !localIds.has(id)) };
    await writeJson(`${HOME_GROUPS}/${group.id}.json`, 'home', synced);

    const placements = await readPlacements();
    let changed = false;
    for (const id of Object.keys(placements)) {
      if (placements[id].groupId !== group.id) continue;
      delete placements[id];
      changed = true;
    }
    group.entries.forEach((entryId, index) => {
      if (!localIds.has(entryId)) return;
      placements[entryId] = { groupId: group.id, index };
      changed = true;
    });
    if (changed) await writePlacements(placements);
  }

  async function saveEntry(entry) {
    await ensureHomeDirs();
    const syncedPath = `${HOME_ENTRIES}/${entry.id}.json`;
    const localPath = `${LOCAL_HOME_ENTRIES}/${entry.id}.json`;
    if (entry.type === 'system') {
      await writeJson(localPath, 'home', entry);
      await fs.rm(abs(syncedPath), { force: true }).catch(() => {});
    } else {
      await writeJson(syncedPath, 'home', entry);
      await fs.rm(abs(localPath), { force: true }).catch(() => {});
    }
  }

  async function deleteEntryFile(id) {
    await fs.rm(abs(`${HOME_ENTRIES}/${id}.json`), { force: true }).catch(() => {});
    await fs.rm(abs(`${LOCAL_HOME_ENTRIES}/${id}.json`), { force: true }).catch(() => {});
    const placements = await readPlacements();
    if (placements[id]) {
      delete placements[id];
      await writePlacements(placements);
    }
  }

  async function readHomeState() {
    await ensureHomeDirs();
    const groupMap = new Map();
    for (const file of await listFiles(HOME_GROUPS, '.json')) {
      const id = (file.split('/').pop() || '').replace(/\.json$/, '');
      const group = normalizeGroup(await readJson(file, 'home'), id);
      if (group) groupMap.set(group.id, group);
    }

    const entries = {};
    for (const file of await listFiles(LOCAL_HOME_ENTRIES, '.json')) {
      const id = (file.split('/').pop() || '').replace(/\.json$/, '');
      const entry = normalizeEntry(await readJson(file, 'home'), id);
      if (entry) entries[entry.id] = entry;
    }
    for (const file of await listFiles(HOME_ENTRIES, '.json')) {
      const id = (file.split('/').pop() || '').replace(/\.json$/, '');
      const entry = normalizeEntry(await readJson(file, 'home'), id);
      if (entry) entries[entry.id] = entry;
    }

    let data = normalizeHomeData(await readJson(HOME_FILE, 'home'));
    if (!data) {
      data = {
        v: 1,
        groupOrder: Array.from(groupMap.values())
          .sort((a, b) => +new Date(a.created) - +new Date(b.created))
          .map((group) => group.id),
        settings: { showRecent: true, showStats: true },
      };
    }
    const known = new Set(groupMap.keys());
    const order = data.groupOrder.filter((id, index, list) => known.has(id) && list.indexOf(id) === index);
    for (const group of Array.from(groupMap.values()).sort((a, b) => +new Date(a.created) - +new Date(b.created))) {
      if (!order.includes(group.id)) order.push(group.id);
    }
    data.groupOrder = order;
    const groups = order.map((id) => groupMap.get(id)).filter(Boolean);

    const referenced = new Set();
    for (const group of groups) {
      group.entries = group.entries.filter((id) => {
        if (!entries[id] || referenced.has(id)) return false;
        referenced.add(id);
        return true;
      });
    }

    // 系统应用入口只存在本机，按 placements.json 里的位置插回分组（只在内存里，不写回）
    const placements = await readPlacements();
    const pending = new Map();
    for (const entry of Object.values(entries)) {
      if (referenced.has(entry.id)) continue;
      const place = placements[entry.id];
      const group = (place && groups.find((item) => item.id === place.groupId)) || groups[0];
      if (!group) continue;
      const list = pending.get(group.id) || [];
      list.push(entry);
      pending.set(group.id, list);
      referenced.add(entry.id);
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

    return { data, groups, entries, placements };
  }

  function homeEntryView(entry, extra = {}) {
    const view = { ...entry, local: entry.type === 'system' };
    if (entry.type === 'app') {
      const app = extra.apps?.get(entry.target);
      if (app) {
        view.title = entry.title || app.name;
        view.icon = entry.icon || app.icon;
        view.color = entry.color || app.color;
        view.app = { id: app.id, name: app.name };
      }
    } else if (entry.type === 'note' && !entry.title && extra.notes?.has(entry.target)) {
      view.title = extra.notes.get(entry.target).title;
    }
    return view;
  }

  async function listHome() {
    const state = await readHomeState();
    const apps = new Map((await listApps()).map((app) => [app.id, app]));
    const notes = new Map();
    if (typeof scanNotes === 'function') {
      try {
        for (const note of await scanNotes()) notes.set(note.id, note);
      } catch {
        /* 笔记库读不出来不影响首页 */
      }
    }
    const extra = { apps, notes };
    const attached = new Set(state.groups.flatMap((group) => group.entries));
    const ungrouped = Object.values(state.entries)
      .filter((entry) => !attached.has(entry.id))
      .map((entry) => homeEntryView(entry, extra));
    return {
      settings: state.data.settings,
      groupOrder: state.data.groupOrder,
      counts: { groups: state.groups.length, entries: Object.keys(state.entries).length },
      groups: state.groups.map((group) => ({
        id: group.id,
        name: group.name,
        icon: group.icon,
        color: group.color,
        created: group.created,
        updated: group.updated,
        entries: group.entries
          .map((id) => state.entries[id])
          .filter(Boolean)
          .map((entry) => homeEntryView(entry, extra)),
      })),
      ungrouped,
    };
  }

  async function homeCounts() {
    const state = await readHomeState();
    return { groups: state.groups.length, entries: Object.keys(state.entries).length };
  }

  function resolveGroup(state, groupId, groupName) {
    if (groupId) {
      const group = state.groups.find((item) => item.id === groupId);
      if (!group) throw new StoreError(`找不到分组 ${groupId}`, 'NOT_FOUND');
      return group;
    }
    if (groupName) {
      const name = cleanName(groupName, 40);
      const group = state.groups.find((item) => item.name === name);
      if (!group) throw new StoreError(`找不到分组「${name}」`, 'NOT_FOUND');
      return group;
    }
    return state.groups[0] || null;
  }

  async function createGroupInternal(state, patch) {
    const name = cleanName(patch.name, 40);
    if (!name) throw new StoreError('分组名称不能为空', 'BAD_TITLE');
    if (state.groups.some((group) => group.name === name)) {
      throw new StoreError(`分组「${name}」已经存在`, 'DUPLICATE');
    }
    if (state.groups.length >= MAX_GROUPS) throw new StoreError(`最多 ${MAX_GROUPS} 个分组`, 'TOO_MANY');
    const group = makeGroup({
      name,
      icon: iconName(patch.icon) || 'star',
      color: isHomeColor(patch.color) ? patch.color : 'green',
    });
    await saveGroup(group);
    state.groups.push(group);
    state.data.groupOrder.push(group.id);
    await saveHomeData(state.data);
    return group;
  }

  function cleanNotebookTarget(value) {
    const raw = String(value ?? '')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '')
      .trim();
    if (!raw) throw new StoreError('笔记本路径不能为空', 'BAD_TARGET');
    const segs = raw
      .split('/')
      .map((seg) => seg.trim())
      .filter(Boolean);
    if (!segs.length || segs.some((seg) => seg === '.' || seg === '..')) {
      throw new StoreError('笔记本路径不合法', 'BAD_TARGET');
    }
    return segs.join('/').slice(0, 160);
  }

  async function normalizeTarget(type, target) {
    const raw = String(target ?? '').trim();
    if (type === 'daily') return undefined;
    if (type === 'url') {
      const url = normalizeUrl(raw);
      if (!url) throw new StoreError(`网址不合法：${raw}`, 'BAD_TARGET');
      return url;
    }
    if (!raw) throw new StoreError('这个类型的入口需要 target', 'BAD_TARGET');
    if (type === 'app') return (await findApp(raw)).id;
    if (type === 'note') {
      if (typeof findNote !== 'function') return raw;
      const note = await findNote({ id: raw });
      return note.id;
    }
    if (type === 'notebook') return cleanNotebookTarget(raw);
    if (type === 'view') {
      if (!HOME_VIEWS.includes(raw)) throw new StoreError(`智能视图只能是 ${HOME_VIEWS.join(' / ')}`, 'BAD_TARGET');
      return raw;
    }
    if (type === 'system') throw new StoreError('MCP 不支持添加系统应用入口，请在桌面端首页添加', 'UNSUPPORTED');
    throw new StoreError(`不支持的入口类型：${type}`, 'BAD_TYPE');
  }

  async function addHomeEntry(input = {}) {
    const type = typeof input.type === 'string' ? input.type.trim() : '';
    if (!SHORTCUT_TYPES.includes(type) || type === 'system') {
      throw new StoreError('type 只能是 url / app / note / notebook / daily / view', 'BAD_TYPE');
    }
    const state = await readHomeState();
    if (Object.keys(state.entries).length >= MAX_ENTRIES) {
      throw new StoreError(`首页最多 ${MAX_ENTRIES} 个入口`, 'TOO_MANY');
    }

    const target = await normalizeTarget(type, input.target);
    let group = resolveGroup(state, input.groupId, input.groupName);
    if (!group) {
      group = await createGroupInternal(state, { name: DEFAULT_GROUP_NAME, icon: 'star', color: 'green' });
    }
    if (group.entries.length >= MAX_GROUP_ENTRIES) {
      const alternative = state.groups.find((item) => item.entries.length < MAX_GROUP_ENTRIES);
      if (!alternative)
        throw new StoreError(`分组「${group.name}」已满（最多 ${MAX_GROUP_ENTRIES} 个），请先新建分组`, 'TOO_MANY');
      group = alternative;
    }

    const entry = makeEntry(type, { target });
    if (type !== 'app') {
      const title = text(input.title, 80);
      if (title) entry.title = title;
      const icon = iconName(input.icon);
      if (icon) entry.icon = icon;
      entry.color = isHomeColor(input.color) ? input.color : 'green';
    }
    await saveEntry(entry);
    group.entries.push(entry.id);
    group.updated = now();
    await saveGroup(group);
    return {
      entry: homeEntryView(entry),
      group: { id: group.id, name: group.name },
      groupId: group.id,
      entryId: entry.id,
    };
  }

  async function updateHomeEntry(id, patch = {}) {
    const key = idText(id);
    if (!key) throw new StoreError('缺少入口 id', 'MISSING_LOCATOR');
    const state = await readHomeState();
    const existing = state.entries[key];
    if (!existing) throw new StoreError(`找不到首页入口 ${key}`, 'NOT_FOUND');
    if (patch.type !== undefined && patch.type !== existing.type) {
      throw new StoreError('MCP 不支持修改入口类型，请删除后重新添加', 'UNSUPPORTED');
    }

    const entry = { ...existing };
    if (patch.title !== undefined)
      entry.title = patch.title === null || patch.title === '' ? undefined : text(patch.title, 80);
    if (patch.icon !== undefined) {
      if (patch.icon === null || patch.icon === '') entry.icon = undefined;
      else {
        const icon = iconName(patch.icon);
        if (!icon) throw new StoreError('图标名不在可选范围内', 'BAD_ICON');
        entry.icon = icon;
      }
    }
    if (patch.color !== undefined) {
      if (patch.color === null || patch.color === '') entry.color = undefined;
      else if (!isHomeColor(patch.color))
        throw new StoreError('颜色只能是 green / blue / amber / red / purple / gray', 'BAD_COLOR');
      else entry.color = patch.color;
    }
    if (patch.target !== undefined) entry.target = await normalizeTarget(entry.type, patch.target);
    entry.updated = now();
    await saveEntry(entry);

    const currentGroup = state.groups.find((group) => group.entries.includes(entry.id));
    let targetGroup = currentGroup;
    if (patch.groupId !== undefined || patch.groupName !== undefined) {
      targetGroup = resolveGroup(state, patch.groupId, patch.groupName);
      if (!targetGroup) throw new StoreError('目标分组不存在', 'NOT_FOUND');
    }

    if (targetGroup && (!currentGroup || targetGroup.id !== currentGroup.id)) {
      if (targetGroup.entries.length >= MAX_GROUP_ENTRIES) {
        throw new StoreError(`分组「${targetGroup.name}」已满（最多 ${MAX_GROUP_ENTRIES} 个）`, 'TOO_MANY');
      }
      for (const group of state.groups) {
        if (!group.entries.includes(entry.id)) continue;
        group.entries = group.entries.filter((item) => item !== entry.id);
        group.updated = now();
        await saveGroup(group);
      }
      const at = Math.max(0, Math.min(Number(patch.index) || 0, targetGroup.entries.length));
      targetGroup.entries.splice(at, 0, entry.id);
      targetGroup.updated = now();
      await saveGroup(targetGroup);
    } else if (currentGroup && patch.index !== undefined) {
      const from = currentGroup.entries.indexOf(entry.id);
      if (from >= 0) currentGroup.entries.splice(from, 1);
      const at = Math.max(0, Math.min(Number(patch.index) || 0, currentGroup.entries.length));
      currentGroup.entries.splice(at, 0, entry.id);
      currentGroup.updated = now();
      await saveGroup(currentGroup);
    }

    const group = targetGroup || currentGroup;
    return {
      updated: true,
      entry: homeEntryView(entry),
      group: group ? { id: group.id, name: group.name } : undefined,
    };
  }

  async function deleteHomeEntry(id) {
    const key = idText(id);
    if (!key) throw new StoreError('缺少入口 id', 'MISSING_LOCATOR');
    const state = await readHomeState();
    const entry = state.entries[key];
    if (!entry) throw new StoreError(`找不到首页入口 ${key}`, 'NOT_FOUND');
    const groups = [];
    for (const group of state.groups) {
      if (!group.entries.includes(key)) continue;
      group.entries = group.entries.filter((item) => item !== key);
      group.updated = now();
      await saveGroup(group);
      groups.push({ id: group.id, name: group.name });
    }
    await deleteEntryFile(key);
    return { deleted: true, entry: homeEntryView(entry), groups };
  }

  async function addHomeGroup(input = {}) {
    const state = await readHomeState();
    const group = await createGroupInternal(state, {
      name: input.name,
      icon: input.icon,
      color: input.color,
    });
    return { group };
  }

  async function updateHomeGroup(id, patch = {}) {
    const key = idText(id);
    if (!key) throw new StoreError('缺少分组 id', 'MISSING_LOCATOR');
    const state = await readHomeState();
    const group = state.groups.find((item) => item.id === key);
    if (!group) throw new StoreError(`找不到分组 ${key}`, 'NOT_FOUND');
    if (patch.name !== undefined) {
      const name = cleanName(patch.name, 40);
      if (!name) throw new StoreError('分组名称不能为空', 'BAD_TITLE');
      if (state.groups.some((item) => item.id !== key && item.name === name)) {
        throw new StoreError(`分组「${name}」已经存在`, 'DUPLICATE');
      }
      group.name = name;
    }
    if (patch.icon !== undefined) {
      if (patch.icon === null || patch.icon === '') group.icon = undefined;
      else {
        const icon = iconName(patch.icon);
        if (!icon) throw new StoreError('图标名不在可选范围内', 'BAD_ICON');
        group.icon = icon;
      }
    }
    if (patch.color !== undefined) {
      if (patch.color === null || patch.color === '') group.color = undefined;
      else if (!isHomeColor(patch.color))
        throw new StoreError('颜色只能是 green / blue / amber / red / purple / gray', 'BAD_COLOR');
      else group.color = patch.color;
    }
    group.updated = now();
    await saveGroup(group);
    return { updated: true, group };
  }

  async function deleteHomeGroup(id) {
    const key = idText(id);
    if (!key) throw new StoreError('缺少分组 id', 'MISSING_LOCATOR');
    const state = await readHomeState();
    const group = state.groups.find((item) => item.id === key);
    if (!group) throw new StoreError(`找不到分组 ${key}`, 'NOT_FOUND');

    await fs.rm(abs(`${HOME_GROUPS}/${key}.json`), { force: true }).catch(() => {});
    state.data.groupOrder = state.data.groupOrder.filter((item) => item !== key);
    await saveHomeData(state.data);
    state.groups = state.groups.filter((item) => item.id !== key);

    const stillUsed = new Set(state.groups.flatMap((item) => item.entries));
    const removed = [];
    for (const entryId of group.entries) {
      if (stillUsed.has(entryId)) continue;
      const entry = state.entries[entryId];
      if (entry) removed.push(entry);
      await deleteEntryFile(entryId);
    }
    return { deleted: true, group, removedEntries: removed.length };
  }

  return {
    root,
    listApps,
    findApp,
    getApp,
    createApp,
    updateApp,
    deleteApp,
    getAppData,
    setAppData,
    clearAppData,
    listVersions,
    readVersion,
    restoreVersion,
    checkAppHtml,
    listHome,
    homeCounts,
    addHomeEntry,
    updateHomeEntry,
    deleteHomeEntry,
    addHomeGroup,
    updateHomeGroup,
    deleteHomeGroup,
  };
}
