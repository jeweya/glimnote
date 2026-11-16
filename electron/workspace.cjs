/**
 * 工作区：一套「本机数据目录 + 同步配置 + 令牌 + 日志 + 界面缓存」。
 *
 * 让同一台电脑可以被多个人用，也可以让同一个人把不同仓库的笔记完全分开：
 * - 默认工作区沿用老版本的「文档/glimnote」，老安装不需要迁移笔记；
 * - 新工作区放在「文档/glimnote-workspaces/<名字>」，互不覆盖；
 * - 配置 / 令牌 / 日志放在 userData/workspaces/<id>/，切换工作区后各用各的；
 * - 只有默认工作区使用默认 Chromium 存储（保留升级前已经存在的界面设置），
 *   其它工作区使用独立 session 分区，localStorage / IndexedDB 互不可见。
 *
 * 这个模块在主进程启动早期同步执行：文件很小，而且必须在打开任何窗口、
 * 初始化日志之前就确定当前工作区。
 */
const fs = require('node:fs');
const path = require('node:path');

const REGISTRY_VERSION = 1;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

const PROVIDER_LABEL = { gitee: 'Gitee', gitcode: 'GitCode', github: 'GitHub' };

/**
 * 仓库身份：只有「同一平台 + 同一账号 + 同一仓库名」才算同一份笔记。
 *
 * 只比 owner/repo 会出两种事故：Gitee 和 GitCode 上都有 alice/notes 时被当成
 * 同一个仓库，换平台连接会把两边的笔记混进同一个目录；或者换账号后同名仓库
 * 被判成重复、直接切到旧账号的工作区。平台缺省的历史记录一律不匹配，
 * 宁可多建一个目录，也不要把两份不同的日志合在一起。
 */
function repoKey(repo) {
  if (!repo || !repo.owner || !repo.repo) return '';
  const provider = String(repo.provider || '')
    .trim()
    .toLowerCase();
  if (!provider) return '';
  const owner = String(repo.owner).trim().toLowerCase();
  const name = String(repo.repo).trim().toLowerCase();
  return owner && name ? `${provider}\n${owner}\n${name}` : '';
}

function sameRepo(a, b) {
  const key = repoKey(a);
  return Boolean(key) && key === repoKey(b);
}

/**
 * 自动建工作区时的展示名：带上平台，跨平台同名仓库一眼能分清。
 * 用下划线连接平台，不再用全角括号——文件夹名里带括号在命令行里不好输入。
 */
function repoWorkspaceName(repo) {
  const raw = String((repo && repo.provider) || '');
  const label = PROVIDER_LABEL[raw.toLowerCase()] || raw;
  const name = `${repo.owner}/${repo.repo}`;
  return label ? `${name}_${label}` : name;
}

/** 名字 → 文件夹名：去掉 Windows 不允许的字符，空名有兜底 */
function slugify(name) {
  const s = String(name || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return s || 'workspace';
}

function createWorkspaceManager({ app }) {
  const userData = app.getPath('userData');
  const documents = app.getPath('documents');
  const registryFile = path.join(userData, 'workspaces.json');
  const defaultRoot = path.join(documents, 'glimnote');
  const workspacesRoot = path.join(documents, 'glimnote-workspaces');

  function workspaceDir(id) {
    return path.join(userData, 'workspaces', id);
  }

  function logsDirOf(id) {
    return path.join(workspaceDir(id), 'logs');
  }

  function normalize(reg) {
    if (!reg || !Array.isArray(reg.items)) return null;
    const items = reg.items.filter(
      (it) => it && typeof it.id === 'string' && it.id && typeof it.root === 'string' && path.isAbsolute(it.root),
    );
    if (!items.length) return null;
    const active = items.some((it) => it.id === reg.active) ? reg.active : items[0].id;
    return { v: REGISTRY_VERSION, active, items };
  }

  /** 老安装第一次升级：把原来的配置 / 令牌 / 日志复制进默认工作区，原文件保留以便回退 */
  function migrate() {
    const prefs = readJson(path.join(userData, 'prefs.json')) || {};
    const custom = typeof prefs.repoRoot === 'string' && prefs.repoRoot ? path.resolve(prefs.repoRoot) : '';
    const root = custom || defaultRoot;
    const dir = workspaceDir('default');
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    for (const name of ['git-config.json', 'credentials.bin']) {
      const src = path.join(userData, name);
      const dst = path.join(dir, name);
      try {
        if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
      } catch {
        /* 复制失败也继续，用户最多重新填一次令牌 */
      }
    }
    const oldLogs = path.join(userData, 'logs');
    try {
      if (fs.existsSync(oldLogs)) {
        for (const name of fs.readdirSync(oldLogs)) {
          const src = path.join(oldLogs, name);
          const dst = path.join(dir, 'logs', name);
          try {
            if (fs.statSync(src).isFile() && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
          } catch {
            /* 单个日志复制失败不影响启动 */
          }
        }
      }
    } catch {
      /* 老日志目录不存在是正常情况 */
    }
    const reg = {
      v: REGISTRY_VERSION,
      active: 'default',
      items: [
        {
          id: 'default',
          name: '默认工作区',
          root,
          baseRoot: root,
          repo: null,
          createdAt: new Date().toISOString(),
        },
      ],
    };
    writeJson(registryFile, reg);
    return reg;
  }

  let registry = normalize(readJson(registryFile)) || migrate();

  function save() {
    writeJson(registryFile, registry);
  }

  /**
   * 每个工作区记住「创建时的文件夹」，设置页「恢复默认」按它迁回。
   * 老的注册表没有这个字段：默认工作区按老规则算「文档/glimnote」，
   * 其它工作区就把当前目录当成默认，不诱导用户乱迁。
   */
  let backfilled = false;
  for (const it of registry.items) {
    if (typeof it.baseRoot === 'string' && it.baseRoot) continue;
    it.baseRoot = it.id === 'default' ? defaultRoot : it.root;
    backfilled = true;
  }
  if (backfilled) save();

  function active() {
    return registry.items.find((it) => it.id === registry.active) || registry.items[0];
  }

  function publicItem(it) {
    return {
      id: it.id,
      name: it.name,
      root: it.root,
      baseRoot: it.baseRoot || it.root,
      repo: it.repo || null,
      isDefault: it.id === 'default',
      /** 默认工作区沿用默认 session（升级前的界面设置还在），其它工作区各自隔离 */
      partition: it.id === 'default' ? null : `persist:glimnote-${it.id}`,
    };
  }

  function list() {
    return { active: registry.active, items: registry.items.map(publicItem) };
  }

  function create({ name, root } = {}) {
    const clean =
      String(name || '')
        .trim()
        .slice(0, 40) || '新工作区';
    const slug = slugify(clean);
    let id = slug;
    let n = 2;
    while (registry.items.some((it) => it.id === id)) {
      id = `${slug}-${n}`;
      n += 1;
    }
    let target = '';
    if (root && String(root).trim()) {
      const parent = path.resolve(String(root).trim());
      target = /^glimnote/i.test(path.basename(parent)) ? parent : path.join(parent, `glimnote-${slug}`);
    } else {
      // 自动建的工作区按名字生成目录；名字被截断到相同前缀时也要各占一个目录
      const used = (p) => registry.items.some((it) => path.resolve(it.root) === path.resolve(p));
      target = path.join(workspacesRoot, slug);
      let suffix = 2;
      while (used(target)) {
        target = path.join(workspacesRoot, `${slug}-${suffix}`);
        suffix += 1;
      }
    }
    if (registry.items.some((it) => path.resolve(it.root) === path.resolve(target))) {
      return { ok: false, error: '这个文件夹已经被另一个工作区使用' };
    }
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.mkdirSync(logsDirOf(id), { recursive: true });
    } catch (e) {
      return { ok: false, error: `创建文件夹失败：${(e && e.message) || e}` };
    }
    const item = {
      id,
      name: clean,
      root: target,
      baseRoot: target,
      repo: null,
      createdAt: new Date().toISOString(),
    };
    registry.items.push(item);
    save();
    return { ok: true, item: publicItem(item) };
  }

  function switchTo(id) {
    const item = registry.items.find((it) => it.id === id);
    if (!item) return { ok: false, error: '工作区不存在' };
    if (registry.active === id) return { ok: true, item: publicItem(item), same: true };
    // 目录被手动删掉过也照样能切：重启后按空工作区重建，别让界面直接打不开
    try {
      fs.mkdirSync(item.root, { recursive: true });
      fs.mkdirSync(logsDirOf(id), { recursive: true });
    } catch {
      /* 外接盘没插、权限不足等：切过去后界面会提示，不影响注册表切换 */
    }
    registry.active = id;
    save();
    return { ok: true, item: publicItem(item) };
  }

  function bindRepoTo(item, repo, { force = false } = {}) {
    if (!item) return { ok: false, error: '工作区不存在' };
    const target = repo && repoKey(repo) ? repo : null;
    if (!target) {
      item.repo = null;
      save();
      return { ok: true, item: publicItem(item) };
    }
    const other = registry.items.find((it) => it.id !== item.id && sameRepo(it.repo, target));
    if (other && !force) {
      return {
        ok: false,
        conflict: publicItem(other),
        item: publicItem(item),
      };
    }
    item.repo = {
      provider: String(target.provider).trim().toLowerCase(),
      owner: String(target.owner).trim(),
      repo: String(target.repo).trim(),
      branch: target.branch || 'main',
      at: new Date().toISOString(),
    };
    save();
    return { ok: true, item: publicItem(item), other: other ? publicItem(other) : null };
  }

  /** 记录当前工作区关联的仓库；不阻止两个工作区连同一个仓库，但把冲突信息交回界面 */
  function bindRepo(repo, opts = {}) {
    return bindRepoTo(active(), repo, opts);
  }

  function bindRepoFor(id, repo, opts = {}) {
    return bindRepoTo(
      registry.items.find((it) => it.id === id),
      repo,
      opts,
    );
  }

  function findByRepo(repo) {
    if (!repoKey(repo)) return null;
    const hit = registry.items.find((it) => sameRepo(it.repo, repo));
    return hit ? publicItem(hit) : null;
  }

  /** 迁移 / 更改当前工作区的位置（设置页「更改位置」） */
  function updateRoot(id, root) {
    const item = registry.items.find((it) => it.id === id);
    if (!item) return { ok: false, error: '工作区不存在' };
    item.root = path.resolve(String(root));
    save();
    return { ok: true, item: publicItem(item) };
  }

  function rename(id, name) {
    const item = registry.items.find((it) => it.id === id);
    if (!item) return { ok: false, error: '工作区不存在' };
    const clean = String(name || '')
      .trim()
      .slice(0, 40);
    if (!clean) return { ok: false, error: '名字不能为空' };
    item.name = clean;
    save();
    return { ok: true, item: publicItem(item) };
  }

  fs.mkdirSync(logsDirOf(active().id), { recursive: true });

  return {
    userData,
    registryFile,
    defaultRoot,
    workspacesRoot,
    list,
    active,
    activeItem: () => publicItem(active()),
    root: () => active().root,
    dir: (id) => workspaceDir(id || active().id),
    logsDir: (id) => logsDirOf(id || active().id),
    create,
    switchTo,
    bindRepo,
    bindRepoFor,
    findByRepo,
    updateRoot,
    rename,
  };
}

module.exports = { createWorkspaceManager, slugify, repoKey, sameRepo, repoWorkspaceName };
