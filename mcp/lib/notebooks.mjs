/**
 * MCP 侧的笔记本映射表。
 *
 * 和桌面端共用同一个 .glimnote/notebooks.json：界面里看到的「工作/项目」
 * 是显示路径，磁盘上对应的目录可能是 nb-xxxxxxxx。MCP 读写笔记时必须先翻译，
 * 否则会把 ID 目录当成笔记本名返回，甚至重新建出可读名字的旧目录。
 *
 * 每次调用都重新读文件：MCP 是独立进程，桌面端随时可能改名或新建笔记本。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const NOTES_DIR = 'notes';
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_RE = /^nb-[a-z0-9]{8}$/;

const clone = (e) => ({
  id: e.id,
  name: e.name,
  parentId: typeof e.parentId === 'string' && e.parentId ? e.parentId : null,
  seg: e.seg,
  legacy: Boolean(e.legacy),
  updatedAt: e.updatedAt,
  ...(e.deletedAt ? { deletedAt: e.deletedAt } : {}),
});

const valid = (e) =>
  Boolean(e && typeof e.id === 'string' && e.id && typeof e.name === 'string' && typeof e.seg === 'string' && e.seg);

function normalizePath(input) {
  return String(input || '')
    .split('/')
    .map((seg) => seg.trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 80))
    .filter(Boolean)
    .join('/');
}

function nowIso() {
  return new Date().toISOString();
}

function newId(list) {
  const taken = new Set(list.flatMap((e) => [e.id, e.seg]));
  for (let i = 0; i < 32; i += 1) {
    const bytes = randomBytes(8);
    const id = `nb-${[...bytes].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('')}`;
    if (!taken.has(id)) return id;
  }
  return `nb-${Date.now().toString(36).slice(-8).padStart(8, '0')}`;
}

function chainOf(entry, list) {
  const out = [];
  const byId = new Map(list.map((e) => [e.id, e]));
  let cur = entry;
  let guard = 0;
  while (cur && guard < 64) {
    out.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    guard += 1;
  }
  return out;
}

const displayOfEntry = (entry, list) =>
  chainOf(entry, list)
    .map((e) => e.name)
    .join('/');

const physicalOfEntry = (entry, list) =>
  chainOf(entry, list)
    .map((e) => e.seg)
    .join('/');

const live = (list) => list.filter((e) => !e.deletedAt);

export function createNotebookMap(root) {
  const notesAbs = path.join(root, NOTES_DIR);
  const mapAbs = path.join(root, '.glimnote', 'notebooks.json');

  async function exists(full) {
    try {
      await fs.access(full);
      return true;
    } catch {
      return false;
    }
  }

  async function readMap() {
    try {
      const raw = await fs.readFile(mapAbs, 'utf8');
      if (!raw.trim()) return [];
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed?.entries) ? parsed.entries.filter(valid).map(clone) : [];
      return list;
    } catch {
      return [];
    }
  }

  async function saveMap(list) {
    const data = JSON.stringify(
      {
        schemaVersion: 1,
        updatedAt: nowIso(),
        entries: [...list].sort((a, b) => a.id.localeCompare(b.id)),
      },
      null,
      2,
    );
    await fs.mkdir(path.dirname(mapAbs), { recursive: true });
    const tmp = path.join(
      path.dirname(mapAbs),
      `.notebooks.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`,
    );
    await fs.writeFile(tmp, data, 'utf8');
    try {
      await fs.rename(tmp, mapAbs);
    } catch {
      await fs.writeFile(mapAbs, data, 'utf8');
      await fs.unlink(tmp).catch(() => {});
    }
  }

  async function scanDirs(dir = notesAbs, prefix = '', out = []) {
    let list = [];
    try {
      list = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const item of list) {
      const name = item.name;
      if (!name || name.startsWith('.')) continue;
      const full = path.join(dir, name);
      const st = item.isDirectory() ? item : await fs.stat(full).catch(() => null);
      if (!st || !st.isDirectory()) continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      out.push(rel);
      await scanDirs(full, rel, out);
    }
    return out;
  }

  function reconcile(list, diskDirs) {
    const out = list.map(clone);
    let changed = out.length !== list.length;
    const diskSet = new Set(diskDirs);
    const kept = out.filter((e) => {
      if (e.deletedAt || !e.legacy) return true;
      return diskSet.has(physicalOfEntry(e, out));
    });
    if (kept.length !== out.length) changed = true;

    // 映射表比目录晚到时会先登记一条 legacy「未命名」；真名到达后同一物理
    // 路径只保留 ID 记录，避免同一个目录在侧栏出现两次。
    const liveIdPhysical = new Set(
      kept.filter((e) => !e.legacy && !e.deletedAt).map((e) => physicalOfEntry(e, kept)),
    );
    const deduped = kept.filter(
      (e) => e.deletedAt || !e.legacy || !liveIdPhysical.has(physicalOfEntry(e, kept)),
    );
    if (deduped.length !== kept.length) changed = true;

    const hasPhysical = (dir) => live(deduped).some((e) => physicalOfEntry(e, deduped) === dir);
    const sorted = [...diskDirs].sort(
      (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
    );
    for (const dir of sorted) {
      if (hasPhysical(dir)) continue;
      const parentDir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
      const parent = parentDir ? live(deduped).find((e) => physicalOfEntry(e, deduped) === parentDir) : null;
      const rawName = dir.split('/').pop() || dir;
      deduped.push({
        id: newId(deduped),
        name: ID_RE.test(rawName) ? `未命名-${rawName.slice(-4)}` : rawName,
        parentId: parent ? parent.id : null,
        seg: rawName,
        legacy: true,
        updatedAt: nowIso(),
      });
      changed = true;
    }
    return { list: deduped, changed };
  }

  async function load() {
    const existsNotes = await exists(notesAbs);
    const local = await readMap();
    if (!existsNotes) return local;
    const diskDirs = await scanDirs();
    const result = reconcile(local, diskDirs);
    if (result.changed) await saveMap(result.list);
    return result.list;
  }

  function findDisplay(list, display) {
    const clean = normalizePath(display);
    if (!clean) return null;
    const hits = live(list).filter((e) => displayOfEntry(e, list) === clean);
    return hits.find((e) => !e.legacy) || hits[0] || null;
  }

  function ensureChain(list, display) {
    const segs = normalizePath(display).split('/').filter(Boolean);
    let parentId = null;
    let prefix = '';
    let leaf = null;
    let changed = false;
    for (const name of segs) {
      prefix = prefix ? `${prefix}/${name}` : name;
      let hit = findDisplay(list, prefix);
      if (!hit) {
        const id = newId(list);
        hit = { id, name, parentId, seg: id, legacy: false, updatedAt: nowIso() };
        list.push(hit);
        changed = true;
      }
      parentId = hit.id;
      leaf = hit;
    }
    return { entry: leaf, changed };
  }

  let entries = [];

  return {
    async reload() {
      entries = await load();
      return entries;
    },
    /** 扫描笔记前调用：保证 entries 是最新的 */
    get entries() {
      return entries;
    },
    async list() {
      entries = await load();
      return [...new Set(live(entries).map((e) => displayOfEntry(e, entries)).filter(Boolean))];
    },
    /** 显示笔记本名 → 物理目录（相对 notes/）；没有记录就补一条 ID 记录 */
    async physicalDir(notebook) {
      const clean = normalizePath(notebook);
      if (!clean) return '';
      entries = await load();
      const hit = findDisplay(entries, clean);
      if (hit) return physicalOfEntry(hit, entries);
      const created = ensureChain(entries, clean);
      if (!created.entry) return '';
      if (created.changed) await saveMap(entries);
      return physicalOfEntry(created.entry, entries);
    },
    /**
     * 给 scanNotes 用：先 reload，再逐条翻译。
     * 一次扫描里别为每篇笔记重读一遍映射表。
     */
    async translateNotes(notes) {
      entries = await load();
      const cache = new Map();
      for (const note of notes) {
        const rel = String(note.path || '').replace(/^notes\//, '');
        const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        if (!cache.has(dir)) {
          const hit = live(entries).find((e) => physicalOfEntry(e, entries) === dir);
          cache.set(dir, hit ? displayOfEntry(hit, entries) : null);
        }
        const display = cache.get(dir);
        if (display !== null) note.notebook = display;
      }
      return notes;
    },
  };
}
