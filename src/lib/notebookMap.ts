/**
 * 笔记本目录映射表。
 *
 * 侧栏、隐私锁、首页快捷入口这些地方一直用「工作/项目」这种给人看的路径；
 * 真正的磁盘目录则尽量换成稳定不变的 `nb-xxxxxxxx`。改名只改映射表里的 name，
 * 一个文件都不用搬，多设备之间也不会因为改名把同一批笔记拆成两个文件夹。
 *
 * - 新笔记本：建目录时直接使用 nb-xxxxxxxx；
 * - 旧笔记本：物理目录名保持原样，映射表里标记 legacy，设置页可手动刷新成 ID；
 * - 映射表放在 .glimnote/notebooks.json，跟着 Git 同步，合并规则是「每条以较新的为准」。
 */
import {
  META_DIR,
  NOTES,
  ensureDir,
  exists,
  listFiles,
  readBinary,
  readText,
  removePath,
  renamePath,
  scanPhysicalDirs,
  writeBinary,
  writeText,
} from './storage';

export interface NotebookEntry {
  id: string;
  name: string;
  parentId: string | null;
  /** 物理目录段名：ID 笔记本就是 id，旧笔记本暂时还是可读名字 */
  seg: string;
  legacy?: boolean;
  updatedAt: string;
  /** 删除墓碑：多设备合并时用它把另一台设备上的旧记录盖掉 */
  deletedAt?: string;
}

interface MapFile {
  schemaVersion?: number;
  updatedAt?: string;
  entries?: unknown;
}

const SCHEMA_VERSION = 1;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_RE = /^nb-[a-z0-9]{8}$/;

let entries: NotebookEntry[] | null = null;
let loading: Promise<void> | null = null;
let writeChain: Promise<void> = Promise.resolve();

function mapFile() {
  return `${META_DIR}/notebooks.json`;
}

const nowIso = () => new Date().toISOString();

function normalizePath(path: string) {
  return String(path || '')
    .split('/')
    .map((seg) => seg.trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80))
    .filter(Boolean)
    .join('/');
}

function isValidEntry(value: unknown): value is NotebookEntry {
  const e = value as NotebookEntry | null;
  return Boolean(
    e &&
      typeof e === 'object' &&
      typeof e.id === 'string' &&
      e.id &&
      typeof e.name === 'string' &&
      typeof e.seg === 'string' &&
      e.seg &&
      typeof e.updatedAt === 'string',
  );
}

function cloneEntry(e: NotebookEntry): NotebookEntry {
  return {
    id: e.id,
    name: e.name,
    parentId: typeof e.parentId === 'string' && e.parentId ? e.parentId : null,
    seg: e.seg,
    legacy: Boolean(e.legacy),
    updatedAt: e.updatedAt,
    ...(e.deletedAt ? { deletedAt: e.deletedAt } : {}),
  };
}

/** 父链（根 → 自己）；parentId 成环时及时截断，坏数据不至于把界面卡死 */
function chainOf(entry: NotebookEntry, list: NotebookEntry[]): NotebookEntry[] {
  const out: NotebookEntry[] = [];
  const byId = new Map(list.map((e) => [e.id, e]));
  let cur: NotebookEntry | undefined = entry;
  let guard = 0;
  while (cur && guard < 64) {
    out.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    guard += 1;
  }
  return out;
}

function displayPathOf(entry: NotebookEntry, list: NotebookEntry[]) {
  return chainOf(entry, list)
    .map((e) => e.name)
    .join('/');
}

function parentDisplayPathOf(entry: NotebookEntry, list: NotebookEntry[]) {
  const chain = chainOf(entry, list);
  return chain
    .slice(0, -1)
    .map((e) => e.name)
    .join('/');
}

function physicalPathOf(entry: NotebookEntry, list: NotebookEntry[]) {
  return chainOf(entry, list)
    .map((e) => e.seg)
    .join('/');
}

function liveEntries(list = entries || []) {
  return list.filter((e) => !e.deletedAt);
}

function findByDisplay(display: string, list = entries || []) {
  const clean = normalizePath(display);
  if (!clean) return null;
  // 同名的旧目录残留优先让位给 ID 目录：后者才是改名 / 移动后的权威记录
  const hits = liveEntries(list).filter((e) => displayPathOf(e, list) === clean);
  return hits.find((e) => !e.legacy) || hits[0] || null;
}

function newId(list: NotebookEntry[]) {
  const taken = new Set(list.flatMap((e) => [e.id, e.seg]));
  for (let tries = 0; tries < 32; tries += 1) {
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);
    const id = `nb-${[...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('')}`;
    if (!taken.has(id)) return id;
  }
  return `nb-${Date.now().toString(36).slice(-8).padStart(8, '0')}`;
}

async function readMap(): Promise<{ entries: NotebookEntry[]; existed: boolean }> {
  try {
    const raw = await readText(mapFile());
    if (!raw.trim()) return { entries: [], existed: true };
    const parsed = JSON.parse(raw) as MapFile;
    const list = Array.isArray(parsed.entries) ? parsed.entries.filter(isValidEntry).map(cloneEntry) : [];
    return { entries: list, existed: true };
  } catch {
    return { entries: [], existed: false };
  }
}

function serialize(list: NotebookEntry[]) {
  const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: nowIso(),
      entries: sorted,
    },
    null,
    2,
  );
}

export async function saveNotebookMap(): Promise<void> {
  const data = serialize(entries || []);
  writeChain = writeChain
    .catch(() => {
      /* 上一次写入失败不阻断这一次 */
    })
    .then(async () => {
      // 先写临时文件再改名：写到一半退出时，Git 侧也不会读到半截 JSON
      const tmp = `${mapFile()}.${Date.now().toString(36)}.tmp`;
      await writeText(tmp, data);
      try {
        await renamePath(tmp, mapFile());
      } catch {
        await writeText(mapFile(), data);
        await removePath(tmp).catch(() => {});
      }
    });
  return writeChain;
}

/**
 * 把磁盘上真实存在、但映射表里没有的目录补登记成 legacy。
 *
 * 旧版本、MCP、手动拷进仓库的笔记都可能是这种情况；补登记之后侧栏看到的是
 * 可读目录名，而不是一串 nb-xxxx。反过来，legacy 目录如果已经从磁盘消失，
 * 说明它在别处被改名或删除，记录也一并丢掉，避免留下空壳笔记本。
 * ID 目录即使暂时不存在也保留：空的 ID 笔记本不会跟着 Git 同步，
 * 另一台设备上还没建目录时也应该照常显示。
 */
function reconcile(list: NotebookEntry[], diskDirs: string[]): { entries: NotebookEntry[]; changed: boolean } {
  const out = list.map(cloneEntry);
  let changed = out.length !== list.length;
  const diskSet = new Set(diskDirs);
  const kept = out.filter((e) => {
    if (e.deletedAt || !e.legacy) return true;
    return diskSet.has(physicalPathOf(e, out));
  });
  if (kept.length !== out.length) changed = true;

  // 映射表比目录晚到（例如首次同步前先扫到了 nb- 目录）时，会先给目录登记一条
  // legacy「未命名」。真正的 ID 记录到达后，同一条物理路径上两条记录会打架：
  // 只保留 ID 记录，否则侧栏会同时出现「未命名」和真名，笔记归到哪边看运气。
  const liveIdPhysical = new Set(
    kept.filter((e) => !e.legacy && !e.deletedAt).map((e) => physicalPathOf(e, kept)),
  );
  const deduped = kept.filter(
    (e) => e.deletedAt || !e.legacy || !liveIdPhysical.has(physicalPathOf(e, kept)),
  );
  if (deduped.length !== kept.length) changed = true;

  const hasPhysical = (dir: string) => liveEntries(deduped).some((e) => physicalPathOf(e, deduped) === dir);
  const sorted = [...diskDirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const dir of sorted) {
    if (hasPhysical(dir)) continue;
    const parentDir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
    const parent = parentDir ? liveEntries(deduped).find((e) => physicalPathOf(e, deduped) === parentDir) : null;
    const rawName = dir.split('/').pop() || dir;
    // 只有 ID 目录却没有映射表（例如映射文件还没同步下来）：先显示成未命名，
    // 等映射表到达后会自动恢复成真正的名字。
    // 带一小段 ID 后缀：同时有多个未登记目录时不至于全都叫同一个名字
    const name = ID_RE.test(rawName) ? `未命名-${rawName.slice(-4)}` : rawName;
    deduped.push({
      id: newId(deduped),
      name,
      parentId: parent ? parent.id : null,
      seg: rawName,
      legacy: true,
      updatedAt: nowIso(),
    });
    changed = true;
  }
  return { entries: deduped, changed };
}

export async function ensureNotebookMap(force = false): Promise<void> {
  if (!force && entries) return;
  if (loading) {
    await loading.catch(() => {});
    if (!force && entries) return;
  }
  loading = (async () => {
    if (force) await writeChain.catch(() => {});
    const notesDirExists = await exists(NOTES).catch(() => false);
    // notes/ 还没建好时不要凭「磁盘为空」删任何旧记录：bootstrap 之前的一次读取
    // 会把整张映射表清掉，重启后所有旧笔记本都会变成未命名 ID。
    if (!notesDirExists) {
      if (!entries) entries = (await readMap()).entries;
      return;
    }
    const diskDirs = await scanPhysicalDirs(NOTES).catch(() => [] as string[]);
    const local = await readMap();
    const merged = reconcile(local.entries, diskDirs);
    entries = merged.entries;
    if (merged.changed || !local.existed) await saveNotebookMap();
    // ID 笔记本以映射表为准：目录被误删（或旧版本搬目录时清掉了空父目录）时
    // 在本机补回来，本地文件夹和侧栏都应继续看得到这个空笔记本。
    for (const e of liveEntries(entries)) {
      if (e.legacy) continue;
      const dir = `${NOTES}/${physicalPathOf(e, entries)}`;
      if (!(await exists(dir))) await ensureDir(dir).catch(() => {});
    }
  })();
  try {
    await loading;
  } finally {
    loading = null;
  }
}

/** 侧栏用的显示路径列表（含暂时没有目录的空 ID 笔记本，不含删除墓碑） */
export async function listNotebookPaths(): Promise<string[]> {
  await ensureNotebookMap();
  const list = liveEntries();
  return [...new Set(list.map((e) => displayPathOf(e, entries!)).filter(Boolean))];
}

/** 扫描笔记时把物理路径翻译成显示笔记本；找不到映射返回 null，由调用方保留原值 */
export function notebookOfNotePath(noteRelPath: string): string | null {
  if (!entries) return null;
  const rel = noteRelPath.replace(/^notes\//, '');
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  if (!dir) return '';
  const hit = liveEntries().find((e) => physicalPathOf(e, entries!) === dir);
  return hit ? displayPathOf(hit, entries!) : null;
}

function ensureChain(display: string, list: NotebookEntry[]) {
  const segs = normalizePath(display).split('/').filter(Boolean);
  let parentId: string | null = null;
  let prefix = '';
  let leaf: NotebookEntry | null = null;
  let changed = false;
  for (const name of segs) {
    prefix = prefix ? `${prefix}/${name}` : name;
    let hit = findByDisplay(prefix, list);
    if (!hit) {
      const id = newId(list);
      hit = {
        id,
        name,
        parentId,
        seg: id,
        legacy: false,
        updatedAt: nowIso(),
      };
      list.push(hit);
      changed = true;
    }
    parentId = hit.id;
    leaf = hit;
  }
  return { entry: leaf, changed };
}

/** 把显示路径翻译成物理目录（不含 notes/ 前缀）；没有记录就新建一条 ID 记录 */
export async function physicalNotebookDir(displayPath: string): Promise<string> {
  const clean = normalizePath(displayPath);
  if (!clean) return '';
  await ensureNotebookMap();
  const hit = findByDisplay(clean);
  if (hit) return physicalPathOf(hit, entries!);
  const created = ensureChain(clean, entries!);
  if (created.entry) {
    if (created.changed) await saveNotebookMap();
    return physicalPathOf(created.entry, entries!);
  }
  return '';
}

/** 新建（或补建）笔记本：映射表和磁盘目录都要落地，空笔记本刷新后才不会消失 */
export async function ensureNotebook(displayPath: string): Promise<void> {
  const clean = normalizePath(displayPath);
  if (!clean) return;
  // 改映射前先从磁盘重读：MCP 可能刚加了笔记本，直接覆盖会把它的记录抹掉
  await ensureNotebookMap(true);
  const created = ensureChain(clean, entries!);
  if (created.changed) await saveNotebookMap();
  if (created.entry) {
    await ensureDir(`${NOTES}/${physicalPathOf(created.entry, entries!)}`).catch(() => {});
  }
}

/** 物理目录改名；目标已经存在时退化成逐个文件搬运，宁可慢也不覆盖 */
async function relocateDir(fromRel: string, toRel: string) {
  if (!fromRel || !toRel || fromRel === toRel) return;
  const from = `${NOTES}/${fromRel}`;
  const to = `${NOTES}/${toRel}`;
  const had = await exists(from);
  await ensureDir(to.slice(0, to.lastIndexOf('/')));
  if (!had) {
    await ensureDir(to);
    return;
  }
  const moveFiles = async () => {
    const files = await listFiles(from);
    let failed = false;
    for (const file of files) {
      const rel = file.slice(from.length + 1);
      const slash = rel.lastIndexOf('/');
      const dirPart = slash >= 0 ? rel.slice(0, slash + 1) : '';
      const name = slash >= 0 ? rel.slice(slash + 1) : rel;
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let target = `${to}/${rel}`;
      let i = 2;
      // 目标已有同名文件时另起名字，绝不覆盖、也绝不把源文件直接删掉
      while (await exists(target)) {
        target = `${to}/${dirPart}${stem} (${i})${ext}`;
        i += 1;
      }
      await ensureDir(target.slice(0, target.lastIndexOf('/')));
      try {
        await renamePath(file, target);
      } catch {
        try {
          await writeBinary(target, await readBinary(file));
        } catch {
          failed = true;
        }
      }
    }
    // 有文件没搬成功就保留原目录，宁可留下重复也不能丢数据
    if (!failed) await removePath(from).catch(() => {});
  };
  if (await exists(to)) {
    await moveFiles();
  } else {
    try {
      await renamePath(from, to);
    } catch {
      await moveFiles();
    }
  }
  // 不清理旧父目录：父目录本身是一个笔记本，空着也要留在磁盘和侧栏里。
  // （原先这里会删空目录，把子笔记本移走后父笔记本会整个消失。）
}

/** 旧目录升级成 ID 目录：只改自己这一层，子目录跟着父目录一起搬走 */
async function promoteEntry(entry: NotebookEntry) {
  if (!entry.legacy) return;
  const oldPhysical = physicalPathOf(entry, entries!);
  entry.seg = entry.id;
  entry.legacy = false;
  const newPhysical = physicalPathOf(entry, entries!);
  await relocateDir(oldPhysical, newPhysical);
}

/**
 * 改名或移动笔记本。ID 笔记本只改映射表；旧笔记本会顺手升级成 ID 目录，
 * 这样从这一次改名开始就再也不会因为改名字而搬动文件。
 */
export async function renameNotebookPath(oldPath: string, newPath: string): Promise<void> {
  await ensureNotebookMap(true);
  const from = normalizePath(oldPath);
  const to = normalizePath(newPath);
  if (!from || !to || from === to || to.startsWith(`${from}/`)) return;
  const entry = findByDisplay(from);
  if (!entry) {
    await ensureNotebook(to);
    return;
  }
  const targetParent = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
  const targetName = to.split('/').pop() || '';
  if (!targetName) return;
  const currentParent = parentDisplayPathOf(entry, entries!);
  let changed = false;
  if (entry.legacy) {
    await promoteEntry(entry);
    changed = true;
  }
  const currentPhysical = physicalPathOf(entry, entries!);
  if (targetParent !== currentParent) {
    const parent = targetParent ? ensureChain(targetParent, entries!).entry : null;
    entry.parentId = parent ? parent.id : null;
    changed = true;
  }
  if (entry.name !== targetName) {
    entry.name = targetName;
    changed = true;
  }
  if (!changed) return;
  entry.updatedAt = nowIso();
  await relocateDir(currentPhysical, physicalPathOf(entry, entries!));
  await saveNotebookMap();
}

/** 删除笔记本：自身和子树都留删除墓碑，物理目录一并清掉 */
export async function deleteNotebookPath(displayPath: string): Promise<void> {
  await ensureNotebookMap(true);
  const root = findByDisplay(displayPath);
  if (!root) return;
  const ids = new Set([root.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of entries!) {
      if (e.parentId && ids.has(e.parentId) && !ids.has(e.id)) {
        ids.add(e.id);
        grew = true;
      }
    }
  }
  const dirs = entries!
    .filter((e) => ids.has(e.id))
    .map((e) => physicalPathOf(e, entries!))
    .sort((a, b) => b.split('/').length - a.split('/').length);
  const at = nowIso();
  for (const e of entries!) {
    if (!ids.has(e.id)) continue;
    e.deletedAt = at;
    e.updatedAt = at;
  }
  await saveNotebookMap();
  for (const dir of dirs) {
    const abs = `${NOTES}/${dir}`;
    if (await exists(abs)) {
      await removePath(abs).catch(() => {});
      // 同样不动父目录：删除子笔记本不应连带删掉空的父笔记本
    }
  }
}

/** 设置页的「刷新笔记本索引」：把所有旧目录一次性升级成 ID 目录 */
export async function migrateLegacyNotebooks(): Promise<number> {
  await ensureNotebookMap(true);
  const list = entries!
    .filter((e) => e.legacy && !e.deletedAt)
    .slice()
    .sort((a, b) => displayPathOf(a, entries!).split('/').length - displayPathOf(b, entries!).split('/').length);
  let count = 0;
  for (const entry of list) {
    if (!entry.legacy || entry.deletedAt) continue;
    await promoteEntry(entry);
    entry.updatedAt = nowIso();
    // 每升级一个就落盘：中途退出时磁盘和映射表不会错位
    await saveNotebookMap();
    count += 1;
  }
  return count;
}

function parseMapText(raw: string): NotebookEntry[] | null {
  try {
    const parsed = JSON.parse(raw) as MapFile;
    if (!Array.isArray(parsed.entries)) return null;
    return parsed.entries.filter(isValidEntry).map(cloneEntry);
  } catch {
    return null;
  }
}

/** 两边都有的记录以 updatedAt 较新的为准；时间相同用内容做稳定兜底，保证各设备收敛 */
export function mergeNotebookJson(ours: string, theirs: string): string | null {
  const a = parseMapText(ours);
  const b = parseMapText(theirs);
  if (!a || !b) return null;
  const map = new Map<string, NotebookEntry>();
  for (const entry of a) map.set(entry.id, entry);
  for (const entry of b) {
    const prev = map.get(entry.id);
    if (!prev) {
      map.set(entry.id, entry);
      continue;
    }
    if ((entry.updatedAt || '') !== (prev.updatedAt || '')) {
      map.set(entry.id, (entry.updatedAt || '') > (prev.updatedAt || '') ? entry : prev);
      continue;
    }
    const ea = JSON.stringify(entry);
    const pb = JSON.stringify(prev);
    map.set(entry.id, ea >= pb ? entry : prev);
  }
  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: nowIso(),
      entries: [...map.values()].sort((x, y) => x.id.localeCompare(y.id)),
    },
    null,
    2,
  );
}
