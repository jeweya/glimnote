/**
 * 系统应用（首页快捷入口用）：只扫描开始菜单快捷方式 / 应用程序目录，
 * 不读注册表、不执行命令，返回名称与可启动的绝对路径。
 *
 * Windows: 开始菜单里的 .lnk（用户 + 全局）
 * macOS:   /Applications、/System/Applications、~/Applications 里的 .app
 * Linux:   暂不支持，返回空列表与说明
 */
const path = require('node:path');
const fsp = require('node:fs/promises');
const os = require('node:os');

const MAX_APPS = 500;
const MAX_ICON_PATHS = 80;
const LIST_TTL = 15000;
const SELF_RE = /glimnote|萤光笔记/i;
/** 开始菜单里常见的「不是应用」的快捷方式 */
const NOISE = [
  /^uninstall\b/i,
  /^卸载/,
  /^read\s?me\b/i,
  /^帮助$/,
  /^help$/i,
  /^documentation\b/i,
  /^manual\b/i,
  /^website\b/i,
  /^homepage\b/i,
  /^官网$/,
  /^更新$/,
  /^update\b/i,
  /^license\b/i,
  /^许可证/,
  /^startup$/i,
  /^启动$/,
];

const OPENABLE = new Set(['.lnk', '.exe', '.app', '.desktop']);

function skipName(name) {
  return !name || SELF_RE.test(name) || NOISE.some((re) => re.test(name));
}

function nameOf(file) {
  return path.basename(file, path.extname(file));
}

/** 快捷方式里可能写了 %SystemRoot% 这类环境变量，取图标前先展开 */
function expandEnv(value) {
  return String(value || '').replace(/%([^%]+)%/g, (all, key) => process.env[key] || all);
}

/** 快捷方式里的路径偶尔带引号，取图标前去掉，否则会当成不存在的文件 */
function unquote(value) {
  return String(value || '')
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim();
}

/**
 * 从 .lnk 里找出比快捷方式本身更可靠的图标来源（目标程序 / 自定义图标）。
 * 必须先试目标程序：Windows 对 .lnk 直接取图标时经常只给一张空白的快捷方式图标，
 * 但它不为空，旧逻辑就会把它当成成功结果缓存下来，导致扫描出来的应用全部没有图标。
 */
function shortcutCandidates(target, shell, platform = process.platform) {
  if (platform !== 'win32' || path.extname(target).toLowerCase() !== '.lnk') return [];
  try {
    const link = shell.readShortcutLink(target);
    if (!link) return [];
    const linkTarget = unquote(expandEnv(link.target));
    const icon = unquote(expandEnv(link.icon)).replace(/,\s*-?\d+$/, '');
    // UWP / Store 应用的快捷方式会指向 explorer.exe，取它只会得到资源管理器图标；
    // 这时交还给 .lnk 自己，让 Shell 按应用标识渲染图标。
    if (!linkTarget || /\\explorer\.exe$/i.test(linkTarget)) {
      return !linkTarget && icon ? [icon] : [];
    }
    const out = [linkTarget];
    if (icon && icon !== linkTarget) out.push(icon);
    return out;
  } catch {
    return [];
  }
}

async function walk(dir, visit, depth = 0) {
  if (depth > 5) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, visit, depth + 1);
    else if (entry.isFile()) await visit(full);
  }
}

async function listWindows() {
  const roots = [];
  if (process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  }
  if (process.env.ProgramData) {
    roots.push(path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
  }
  const found = new Map();
  for (const root of roots) {
    await walk(root, (full) => {
      if (path.extname(full).toLowerCase() !== '.lnk') return;
      const name = nameOf(full);
      if (skipName(name)) return;
      const key = name.toLocaleLowerCase('zh-CN');
      // 用户目录先扫，同名时保留用户自己的快捷方式
      if (!found.has(key)) found.set(key, { id: full, name, path: full });
    });
  }
  return [...found.values()];
}

async function collectMacApps(dir, found) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
    const name = entry.name.slice(0, -4);
    if (skipName(name)) continue;
    const key = name.toLowerCase();
    if (found.has(key)) continue;
    const full = path.join(dir, entry.name);
    found.set(key, { id: full, name, path: full });
  }
}

async function listMac() {
  const found = new Map();
  const roots = ['/Applications', '/System/Applications', path.join(os.homedir(), 'Applications')];
  for (const root of roots) {
    await collectMacApps(root, found);
    await collectMacApps(path.join(root, 'Utilities'), found);
  }
  return [...found.values()];
}

function createSystemAppsController({ app, shell, dialog, platform = process.platform }) {
  const iconCache = new Map();
  let cached = null;
  let cachedAt = 0;

  async function list(force = false) {
    if (platform === 'linux') {
      return { platform: 'linux', apps: [], error: 'Linux 暂不支持系统应用，可以改用「网址」入口。' };
    }
    if (platform !== 'win32' && platform !== 'darwin') {
      return { platform, apps: [], error: '当前系统暂不支持系统应用。' };
    }
    if (!force && cached && Date.now() - cachedAt < LIST_TTL) {
      return { platform, apps: cached };
    }
    const apps = platform === 'darwin' ? await listMac() : await listWindows();
    apps.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    // 重新扫描时把之前取失败的图标也一并重试
    if (force) iconCache.clear();
    cached = apps.slice(0, MAX_APPS);
    cachedAt = Date.now();
    return { platform, apps: cached };
  }

  async function iconOf(target) {
    if (iconCache.has(target)) return iconCache.get(target);
    // 顺序很重要：先解析 .lnk 指向的真实程序，最后才退回到 .lnk 本身。
    // Windows 对 .lnk 取图标常返回一张空白的快捷方式图标（非空），若先试 .lnk
    // 就会误判为成功，扫描出来的应用便全部显示空白图标。
    const resolved = shortcutCandidates(target, shell, platform);
    // 解析出了真实目标就只用目标/自定义图标；解析失败才退回 .lnk 本身。
    // 否则目标图标取不到时，会拿到 .lnk 的空白快捷方式图标，看起来像「没有图标」。
    const candidates = (resolved.length ? resolved : [target]).filter(
      (value, index, list) => value && list.indexOf(value) === index,
    );
    for (const candidate of candidates) {
      // 大图标优先；个别程序没有大图标时退回普通尺寸，总比显示占位图好
      for (const size of ['large', 'normal']) {
        try {
          const image = await app.getFileIcon(candidate, { size });
          if (!image || image.isEmpty()) continue;
          const dims = typeof image.getSize === 'function' ? image.getSize() : null;
          if (dims && (dims.width < 8 || dims.height < 8)) continue;
          const url = image.toDataURL();
          if (url) {
            iconCache.set(target, url);
            return url;
          }
        } catch {
          /* 换下一个尺寸 / 来源继续试 */
        }
      }
    }
    return '';
  }

  async function icons(paths) {
    const wanted = Array.isArray(paths)
      ? [...new Set(paths.filter((p) => typeof p === 'string' && p.trim()))].slice(0, MAX_ICON_PATHS)
      : [];
    const out = {};
    // 6 个一批，既不把主进程堵住，也不会同时拉起太多 shell 图标请求
    for (let i = 0; i < wanted.length; i += 6) {
      const batch = wanted.slice(i, i + 6);
      const urls = await Promise.all(batch.map(iconOf));
      batch.forEach((target, index) => {
        if (urls[index]) out[target] = urls[index];
      });
    }
    return out;
  }

  /**
   * 批量确认路径是否还在本机。首页入口会跟着 Git 同步到另一台电脑，
   * 换电脑后绝对路径多半不存在，用它先判断原路径能不能直接用。
   * 只 stat，不启动程序；返回存在的路径数组。
   */
  async function status(paths) {
    const wanted = Array.isArray(paths)
      ? [...new Set(paths.filter((p) => typeof p === 'string' && p.trim()))].slice(0, 200)
      : [];
    const out = [];
    for (let i = 0; i < wanted.length; i += 20) {
      const batch = wanted.slice(i, i + 20);
      const ok = await Promise.all(
        batch.map(async (target) => {
          const full = path.resolve(target);
          if (!OPENABLE.has(path.extname(full).toLowerCase())) return '';
          try {
            const stat = await fsp.stat(full);
            return stat.isFile() || stat.isDirectory() ? target : '';
          } catch {
            return '';
          }
        }),
      );
      out.push(...ok.filter(Boolean));
    }
    return out;
  }

  /** 手动选择扫描不到的程序：交给系统文件选择框，校验后再作为入口返回 */
  async function pick() {
    if (!dialog) return { canceled: true, error: '当前环境不支持手动选择程序。' };
    const filters =
      platform === 'darwin'
        ? [{ name: '应用程序', extensions: ['app'] }]
        : platform === 'win32'
          ? [
              { name: '应用程序', extensions: ['exe', 'lnk'] },
              { name: '所有文件', extensions: ['*'] },
            ]
          : [{ name: '所有文件', extensions: ['*'] }];
    const result = await dialog.showOpenDialog({
      title: '选择要用作快捷入口的程序',
      buttonLabel: '加入快捷入口',
      properties: platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
      filters,
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) return { canceled: true };
    const full = path.resolve(result.filePaths[0]);
    if (!OPENABLE.has(path.extname(full).toLowerCase())) {
      return { canceled: false, error: '请选择 .exe / .lnk / .app / .desktop 程序或快捷方式。' };
    }
    try {
      const stat = await fsp.stat(full);
      if (!stat.isFile() && !stat.isDirectory()) throw new Error('not a file');
    } catch {
      return { canceled: false, error: '这个文件不存在或没有访问权限。' };
    }
    return { canceled: false, app: { id: full, name: nameOf(full), path: full } };
  }

  async function open(target) {
    if (typeof target !== 'string' || !target.trim()) return false;
    const full = path.resolve(target);
    if (!OPENABLE.has(path.extname(full).toLowerCase())) return false;
    try {
      const stat = await fsp.stat(full);
      if (!stat.isFile() && !stat.isDirectory()) return false;
    } catch {
      return false;
    }
    const error = await shell.openPath(full);
    return !error;
  }

  return { list, icons, status, pick, open };
}

module.exports = { createSystemAppsController };
