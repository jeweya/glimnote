import FS from '@isomorphic-git/lightning-fs';
import { buildFile, excerptOf, parseNote, type Note } from './markdown';
import { parseTask, type Task } from './tasks';
import { parseIdea, type Idea } from './ideas';

export const ROOT = '/repo';
export const NOTES = `${ROOT}/notes`;
export const TASKS = `${ROOT}/tasks`;
/** 灵感库：一条一个文件，同样与笔记分开（docs/14） */
export const IDEAS = `${ROOT}/ideas`;
export const TRASH = `${ROOT}/.trash`;
/** 任务回收站：与笔记回收站分开，避免两类对象混在一起 */
export const TRASH_TASKS = `${TRASH}/tasks`;
export const META_DIR = `${ROOT}/.glimnote`;
export const TEMPLATES = `${META_DIR}/templates`;
export const META = `${META_DIR}/repo.json`;
const WEB_DB = 'glimnote-v1';

/**
 * 桌面端（Electron）通过 preload 注入的 IPC 文件系统读写真实目录；
 * 网页端回退到 LightningFS（OPFS/IndexedDB）。两者接口保持一致。
 */
const nativeBridge = (
  globalThis as unknown as { glimnote?: { fs?: { promises?: Record<string, (...args: any[]) => Promise<any>> } } }
).glimnote?.fs?.promises;

const lightning = nativeBridge ? null : new FS(WEB_DB);
const raw: Record<string, (...args: any[]) => Promise<any>> = nativeBridge || (lightning!.promises as any);

export const isDesktop = Boolean(nativeBridge);

function normalizeStat(st: any) {
  const dir = typeof st.isDirectory === 'function' ? st.isDirectory() : Boolean(st.isDirectory);
  const file = typeof st.isFile === 'function' ? st.isFile() : Boolean(st.isFile);
  return {
    ...st,
    isDirectory: () => dir,
    isFile: () => file,
    isSymbolicLink: () => false,
  };
}

/**
 * 把 IPC 过来的错误还原成 Node 风格。
 *
 * 桌面端的 fs 调用要在主进程和渲染进程之间走一趟，Electron 只把 message 传回来，
 * `code`、`path` 这些自定义属性会丢。而 isomorphic-git 到处用 `err.code === 'ENOENT'`
 * 判断「文件还不存在」（连 `git.init` 第一步都是 `fs.exists('.git/config')`），
 * 属性一丢，一个正常的「首次初始化」就被当成致命错误，整次连接停在网络之前。
 * 这里按 message 把 code / path 还原，并去掉 "Error invoking remote method 'fs:xxx'"
 * 这段对用户毫无意义的包装。
 */
const FS_CODE_RE = /\b(ENOENT|EEXIST|EACCES|EPERM|ENOTDIR|EISDIR|ENOTEMPTY|EBUSY|ENOSPC|EINVAL|EMFILE)\b/;
const FS_CALL_RE = /(?:stat|lstat|open|read|write|mkdir|unlink|rmdir|rename|chmod|access|scandir)\s+'([^']+)'/i;

function normalizeFsError(e: unknown): Error {
  const err = (e || {}) as { name?: string; message?: string; code?: string };
  const rawMessage = typeof err.message === 'string' ? err.message : String(e);
  const message = rawMessage.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
  const next = new Error(message) as Error & { code?: string; path?: string };
  if (err.name && err.name !== 'Error') next.name = err.name;
  if (err.code) next.code = err.code;
  if (!next.code) {
    const code = message.match(FS_CODE_RE);
    if (code) next.code = code[1];
  }
  const where = message.match(FS_CALL_RE);
  if (where) next.path = where[1];
  return next;
}

/** 每个 fs 调用都过一层：出错时补回 code/path，调用方看到的仍是普通 Promise */
function guard<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    try {
      return await fn(...args);
    } catch (e) {
      throw normalizeFsError(e);
    }
  };
}

const p = {
  mkdir: guard((path: string) => raw.mkdir(path)),
  rmdir: guard((path: string) => raw.rmdir(path)),
  readdir: guard((path: string) => raw.readdir(path)),
  readFile: guard((path: string, opts?: unknown) => raw.readFile(path, opts)),
  writeFile: guard((path: string, data: unknown, opts?: unknown) => raw.writeFile(path, data, opts)),
  unlink: guard((path: string) => raw.unlink(path)),
  stat: guard(async (path: string) => normalizeStat(await raw.stat(path))),
  lstat: guard(async (path: string) => normalizeStat(await (raw.lstat ? raw.lstat(path) : raw.stat(path)))),
  rename: guard((from: string, to: string) => raw.rename(from, to)),
  chmod: guard((path: string, mode: unknown) => (raw.chmod ? raw.chmod(path, mode) : Promise.resolve())),
  readlink: guard((path: string) => (raw.readlink ? raw.readlink(path) : Promise.reject(new Error('no readlink')))),
  symlink: guard((target: string, path: string) =>
    raw.symlink ? raw.symlink(target, path) : Promise.reject(new Error('no symlink')),
  ),
};

function callbackFs(api: Record<string, (...args: any[]) => Promise<any>>) {
  const wrap =
    (name: string) =>
    (...args: any[]) => {
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      const promise = api[name](...args);
      if (!cb) return promise;
      promise.then(
        (value) => cb(null, value),
        (err) => cb(err),
      );
      return undefined;
    };
  return {
    promises: api,
    readFile: wrap('readFile'),
    writeFile: wrap('writeFile'),
    unlink: wrap('unlink'),
    readdir: wrap('readdir'),
    mkdir: wrap('mkdir'),
    rmdir: wrap('rmdir'),
    stat: wrap('stat'),
    lstat: wrap('lstat'),
    rename: wrap('rename'),
    chmod: wrap('chmod'),
    readlink: wrap('readlink'),
    symlink: wrap('symlink'),
  };
}

export const fs: any = lightning || callbackFs(p as any);

export async function ensureDir(path: string) {
  const parts = path.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += '/' + part;
    try {
      await p.mkdir(cur);
    } catch {
      /* already exists */
    }
  }
}

export async function exists(path: string) {
  try {
    await p.stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries: any[] = [];
  try {
    entries = (await p.readdir(dir)) as any[];
  } catch {
    return out;
  }
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name;
    if (!name || name === 'node_modules') continue;
    const full = `${dir}/${name}`;
    let st;
    try {
      st = await p.stat(full);
    } catch {
      // 扫描时文件刚好被删除 / 改名：跳过它，不让整次判断失败
      continue;
    }
    if (st.isDirectory()) await walk(full, out);
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * 扫描 notes/ 下真实存在的文件夹，返回相对 notes/ 的路径。
 *
 * 侧栏的笔记本列表原本只来自「有笔记的目录 + 本机记录」，文件夹里的笔记删完以后，
 * 空目录还在磁盘上，但侧栏会把它当成不存在——日记这类固定文件夹看起来就“消失了”。
 * 启动和刷新时把磁盘上的目录并进来，空文件夹才能一直留着。
 */
export async function scanNotebookDirs(
  dir: string = NOTES,
  prefix = '',
  out: string[] = [],
): Promise<string[]> {
  let entries: any[] = [];
  try {
    entries = (await p.readdir(dir)) as any[];
  } catch {
    return out;
  }
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name;
    if (!name || name.startsWith('.')) continue;
    const full = `${dir}/${name}`;
    let st;
    try {
      st = await p.stat(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    out.push(rel);
    await scanNotebookDirs(full, rel, out);
  }
  return out;
}

export async function readText(path: string) {
  const data = await p.readFile(path, 'utf8');
  return typeof data === 'string' ? data : new TextDecoder().decode(data as any);
}

export async function writeText(path: string, text: string) {
  await ensureDir(path.slice(0, path.lastIndexOf('/')));
  await p.writeFile(path, text, 'utf8');
}

export async function writeBinary(path: string, data: Uint8Array) {
  await ensureDir(path.slice(0, path.lastIndexOf('/')));
  await p.writeFile(path, data);
}

export async function readBinary(path: string): Promise<Uint8Array> {
  const data = await p.readFile(path);
  return data instanceof Uint8Array ? data : new Uint8Array(data as any);
}

export async function listFiles(dir: string, out: string[] = []) {
  let entries: any[] = [];
  try {
    entries = (await p.readdir(dir)) as any[];
  } catch {
    return out;
  }
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name;
    if (!name) continue;
    const full = `${dir}/${name}`;
    try {
      const st = await p.stat(full);
      if (st.isDirectory()) await listFiles(full, out);
      else out.push(full);
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function renamePath(from: string, to: string) {
  await p.rename(from, to);
}

/** 统计一个目录（或文件）的总大小，用于设置页里的仓库体检 */
export async function pathSize(path: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const visit = async (target: string) => {
    let st: any;
    try {
      st = await p.stat(target);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let entries: any[] = [];
      try {
        entries = (await p.readdir(target)) as any[];
      } catch {
        return;
      }
      for (const e of entries) {
        const name = typeof e === 'string' ? e : e.name;
        await visit(`${target}/${name}`);
      }
      return;
    }
    bytes += Number(st.size) || 0;
    files += 1;
  };
  await visit(path);
  return { bytes, files };
}

export async function removePath(path: string) {
  const st = await p.stat(path);
  if (st.isDirectory()) {
    const entries = (await p.readdir(path)) as any[];
    for (const e of entries) {
      const name = typeof e === 'string' ? e : e.name;
      await removePath(`${path}/${name}`);
    }
    await p.rmdir(path);
  } else {
    await p.unlink(path);
  }
}

export async function scanNotes(): Promise<Note[]> {
  const files = await walk(NOTES);
  const notes: Note[] = [];
  for (const f of files) {
    try {
      const raw = await readText(f);
      notes.push(parseNote(f.replace(`${ROOT}/`, ''), raw));
    } catch (e) {
      console.warn('skip note', f, e);
    }
  }
  return notes;
}

export async function scanTrash(): Promise<Note[]> {
  // 任务回收站在 .trash/tasks 下，不属于笔记；不排除的话会冒出「标题是 id」的假笔记
  const files = (await walk(TRASH)).filter((f) => !f.startsWith(`${TRASH_TASKS}/`));
  const notes: Note[] = [];
  for (const f of files) {
    try {
      const raw = await readText(f);
      notes.push(parseNote(f.replace(`${ROOT}/`, ''), raw));
    } catch {
      /* skip */
    }
  }
  return notes;
}

async function mtimeOf(path: string) {
  try {
    const st = await p.stat(path);
    const t = st.mtime instanceof Date ? st.mtime.getTime() : Number(st.mtime);
    return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/** 一条任务一个文件；单个文件解析失败不影响整个任务库 */
export async function scanTasks(dir = TASKS): Promise<Task[]> {
  const files = await walk(dir);
  const tasks: Task[] = [];
  for (const f of files) {
    try {
      const raw = await readText(f);
      const rel = f.replace(`${ROOT}/`, '');
      tasks.push(parseTask(rel, raw, await mtimeOf(f)));
    } catch (e) {
      console.warn('skip task', f, e);
    }
  }
  return tasks;
}

export async function writeNote(note: Note) {
  await writeText(`${ROOT}/${note.path}`, buildFile(note));
}

/** 灵感同样一个文件一条；坏掉的文件跳过，不让整个列表打不开 */
export async function scanIdeas(): Promise<Idea[]> {
  const files = await walk(IDEAS);
  const ideas: Idea[] = [];
  for (const f of files) {
    try {
      const raw = await readText(f);
      ideas.push(parseIdea(f.replace(`${ROOT}/`, ''), raw, await mtimeOf(f)));
    } catch (e) {
      console.warn('skip idea', f, e);
    }
  }
  return ideas;
}

let bootstrapped = false;

export async function bootstrap() {
  if (bootstrapped) return;
  bootstrapped = true;
  await ensureDir(NOTES);
  await ensureDir(TASKS);
  await ensureDir(IDEAS);
  await ensureDir(TRASH);
  await ensureDir(TRASH_TASKS);
  await ensureDir(`${ROOT}/assets`);
  await ensureDir(TEMPLATES);
  const marker = await exists(META);
  if (!marker) {
    const seeded = await seed();
    await writeText(
      META,
      JSON.stringify(
        {
          schemaVersion: 1,
          app: 'glimnote',
          createdAt: new Date().toISOString(),
          // 记下初始化时写了哪些示例文件、内容指纹是多少。首次连接别人的仓库时，
          // 只有「文件还是原样、没有用户自己的东西」才会被识别成可安全替换的示例数据。
          seed: { at: new Date().toISOString(), files: seeded },
        },
        null,
        2,
      ),
    );
  }
}

const now = () => new Date().toISOString();

const SEED_TEMPLATES: Record<string, string> = {
  '日记.md': `# {{title}}\n\n今天发生了什么？\n\n## 三件小事\n\n- \n- \n- \n\n## 想法\n\n`,
  '周报.md': `# {{title}}\n\n## 本周进展\n\n- \n\n## 遇到的问题\n\n- \n\n## 下周计划\n\n- \n`,
  '会议纪要.md': `# {{title}}\n\n**时间**：{{date}} {{time}}\n**参会**：\n\n## 议题\n\n1. \n\n## 结论\n\n- \n\n## 待办\n\n- [ ] \n`,
  '读书笔记.md': `# {{title}}\n\n**作者**：\n**读完时间**：{{date}}\n\n## 一句话总结\n\n\n## 摘录\n\n> \n\n## 我的想法\n\n\n`,
};

function seedNote(notebook: string, title: string, content: string, tags: string[] = [], daysAgo = 0): Note {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const iso = d.toISOString();
  const file = title.replace(/[\\/:*?"<>|]/g, '-');
  return {
    id: crypto.randomUUID(),
    title,
    notebook,
    path: `notes/${notebook ? notebook + '/' : ''}${file}.md`,
    tags,
    created: iso,
    updated: iso,
    pinned: false,
    size: content.length,
    excerpt: '',
    content,
  };
}

/** 示例文件的内容指纹：只用来判断「还是不是安装时那几篇」，不需要抗碰撞 */
export function contentHash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${(h >>> 0).toString(36)}-${text.length}`;
}

/** 用户内容所在目录：判断本机有没有「自己的东西」，以及首次接管时备份 / 清理的范围 */
const USER_DIRS = ['notes', 'tasks', 'ideas', 'home', 'apps', 'assets'];

async function listUserFiles(): Promise<string[]> {
  const out: string[] = [];
  for (const dir of USER_DIRS) {
    // 这里不能用 walk()：它只收 .md，会把首页 JSON、小应用 HTML、图片资源
    // 全部漏掉。首次连接时这些文件就既备不了份、也判断不出是不是示例数据。
    const files = await listFiles(`${ROOT}/${dir}`);
    out.push(...files);
  }
  return out;
}

export interface LocalContentState {
  /** 安装时是否留下了示例文件清单；旧版本没有这份清单，不能擅自判断 */
  known: boolean;
  /** 本机除了原样的示例文件之外，没有任何用户内容 */
  pristine: boolean;
  /** 仍然是安装时原样的示例文件（相对路径） */
  seedFiles: string[];
  /** 用户自己的文件（相对路径） */
  userFiles: string[];
}

/**
 * 首次连接前判断本机内容。目标：新电脑上的示例笔记不能混进已有仓库，
 * 但用户真正写过的东西也绝不能被当成示例清掉。
 */
export async function localContentState(): Promise<LocalContentState> {
  let seedMap: Record<string, string> | null = null;
  try {
    const raw = await readText(META);
    const meta = JSON.parse(raw);
    const files = meta?.seed?.files;
    if (files && typeof files === 'object') seedMap = files as Record<string, string>;
  } catch {
    /* 没有元数据就按「不认识」处理 */
  }
  const all = await listUserFiles();
  if (!seedMap) {
    return {
      known: false,
      pristine: false,
      seedFiles: [],
      userFiles: all.map((f) => f.replace(`${ROOT}/`, '')),
    };
  }
  const seedFiles: string[] = [];
  const userFiles: string[] = [];
  for (const abs of all) {
    const rel = abs.replace(`${ROOT}/`, '');
    const expected = seedMap[rel];
    if (expected) {
      try {
        const actual = contentHash(await readText(abs));
        if (actual === expected) {
          seedFiles.push(rel);
          continue;
        }
      } catch {
        /* 读不出来就当作需要保留的用户文件，宁可多备份 */
      }
    }
    userFiles.push(rel);
  }
  return { known: true, pristine: userFiles.length === 0, seedFiles, userFiles };
}

/**
 * 补回被旧版首次同步误删的默认笔记。
 *
 * 旧逻辑把新仓库（平台 auto_init 只有 README）当成「远端有内容」，
 * 首次同步先清掉安装示例再检出，结果笔记本一片空白；repo.json 还在，
 * bootstrap 不会再播种。这里只在这种「远端是空仓库且 notes/ 一篇都没有」
 * 的情况下按示例补一次，并在 repo.json 记 starterRestoredAt，之后不再重复。
 */
export async function ensureStarterContent(): Promise<boolean> {
  try {
    const raw = await readText(META);
    if (!raw) return false;
    const meta = JSON.parse(raw);
    const seed = meta?.seed && typeof meta.seed === 'object' ? meta.seed : null;
    if (!seed || typeof seed.files !== 'object' || !seed.files) return false;
    if (meta.starterRestoredAt) return false;
    const seededNotes = Object.keys(seed.files as Record<string, string>).filter((rel) => rel.startsWith('notes/'));
    if (!seededNotes.length) return false;
    if ((await listFiles(NOTES)).length) return false;
    const restored = await seed();
    meta.seed = { ...seed, at: new Date().toISOString(), files: { ...seed.files, ...restored } };
    meta.starterRestoredAt = new Date().toISOString();
    await writeText(META, JSON.stringify(meta, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * 补充登记「安装时自动生成」的文件（首页分组与入口就是启动后按需播种的）。
 * 只追加 seed 清单，不覆盖已登记的指纹：用户后来改过的文件会因此比对失败，
 * 在首次连接时按用户内容处理，不会被误删。
 */
export async function markSeedFiles(paths: string[]) {
  if (!paths.length) return;
  try {
    const raw = await readText(META);
    const meta = JSON.parse(raw);
    const seed = meta?.seed && typeof meta.seed === 'object' ? meta.seed : { at: new Date().toISOString(), files: {} };
    const files = seed.files && typeof seed.files === 'object' ? (seed.files as Record<string, string>) : {};
    let changed = false;
    for (const abs of paths) {
      const rel = abs.startsWith(`${ROOT}/`) ? abs.slice(ROOT.length + 1) : abs;
      if (!rel || files[rel]) continue;
      try {
        files[rel] = contentHash(await readText(`${ROOT}/${rel}`));
        changed = true;
      } catch {
        /* 文件没写成就不登记 */
      }
    }
    if (!changed) return;
    meta.seed = { ...seed, files };
    await writeText(META, JSON.stringify(meta, null, 2));
  } catch {
    /* 没有 repo.json 或写不进去时不影响正常使用 */
  }
}

/** 把指定文件复制到 .glimnote/local/backup-<时间>-<原因>/，返回备份目录（相对路径） */
export async function backupUserFiles(files: string[], reason: string): Promise<string> {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const dir = `${META_DIR}/local/backup-${stamp}-${reason}`;
  await ensureDir(dir);
  for (const rel of files) {
    const from = `${ROOT}/${rel}`;
    try {
      const data = await readBinary(from);
      await writeBinary(`${dir}/${rel}`, data);
    } catch {
      /* 单个文件复制失败不阻断其它文件 */
    }
  }
  await writeText(
    `${dir}/README.txt`,
    `这是 ${d.toLocaleString('zh-CN', { hour12: false })} 首次连接仓库前的自动备份。\n` +
      `原因：${reason === 'seed' ? '本机只有安装时的示例数据，将改用远端仓库内容' : '选择用远端仓库覆盖本机'}。\n` +
      `共 ${files.length} 个文件。把需要的文件复制回笔记目录即可恢复。\n`,
  );
  return dir;
}

/** 删除指定文件；目录留着，checkout 会自己补齐 */
export async function removeUserFiles(files: string[]) {
  for (const rel of files) {
    try {
      await p.unlink(`${ROOT}/${rel}`);
    } catch {
      /* 已经不在了就算完成 */
    }
  }
}

async function seed(): Promise<Record<string, string>> {
  for (const [name, text] of Object.entries(SEED_TEMPLATES)) {
    await writeText(`${TEMPLATES}/${name}`, text);
  }
  const today = new Date();
  const todayTitle = `${today.getMonth() + 1}月${today.getDate()}日`;
  const notes: Note[] = [
    seedNote(
      '工作',
      '周报 2026-W44',
      `## 本周进展

- 完成同步引擎的设计评审
- 打通 GitHub 私有仓库的首次克隆
- 调整了三栏布局的留白，阅读区宽度收敛到 42em

## 遇到的问题

> 两台设备同时改同一篇笔记时，合并结果不够直观。
> 现在的处理是保留一份「冲突副本」，让人来决定。

## 下周计划

- [ ] 接入 Gitee
- [ ] 补全搜索语法
- [ ] 把启动时间压到 1.5 秒以内
`,
      ['工作', '周报'],
      0,
    ),
    seedNote(
      '工作',
      '产品想法：把笔记放回自己手里',
      `## 一句话

笔记应该像纸质笔记本一样属于你：随时能翻、随时能带走。

## 为什么不用现成的

1. 订阅制把数据锁在云端
2. 导出格式难以复用
3. 离线体验普遍很差

## 做法

用 Git 仓库当作同步通道，本地文件才是真源。断网也能写，联网自动补齐。
`,
      ['产品'],
      1,
    ),
    seedNote(
      '阅读笔记',
      '《深度工作》',
      `## 一句话总结

高质量产出 = 时间 × 专注强度，而不是时间本身。

## 摘录

> 注意力残留会持续影响下一项任务的表现。

## 我的想法

把手机放到另一个房间，比任何番茄钟都有效。
`,
      ['读书'],
      2,
    ),
    seedNote(
      '生活',
      '周末清单',
      `- [x] 去菜市场买桂花
- [ ] 修好阳台那盏灯
- [ ] 把冬天的衣服翻出来
- [ ] 给妈妈打电话

顺便记一句：楼下的桂花开了，很香。
`,
      ['生活'],
      3,
    ),
    seedNote(
      'inbox',
      '随手记',
      `刚才想到：写作最难的部分不是表达，而是决定「先写哪一句」。

先写最想说的那句，其他交给修改。
`,
      [],
      0,
    ),
    seedNote(
      '日记',
      `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`,
      `# ${todayTitle}\n\n早上下了点雨，路上有桂花的味道。\n\n## 三件小事\n\n- 把同步引擎的冲突逻辑想明白了\n- 午后读完了《深度工作》第三章\n- 晚饭做了番茄牛腩\n\n## 想法\n\n慢一点没关系，别停。\n`,
      ['日记'],
      0,
    ),
  ];
  const seeded: Record<string, string> = {};
  for (const n of notes) {
    n.excerpt = excerptOf(n.content);
    await writeNote(n);
    seeded[n.path] = contentHash(await readText(`${ROOT}/${n.path}`));
  }
  return seeded;
}

export { now };
