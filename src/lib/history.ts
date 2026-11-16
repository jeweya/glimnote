import { buildFile, excerptOf, stripFrontmatter, wordCount, type Note } from './markdown';
import { ROOT, ensureDir, listFiles, readText, removePath, writeText } from './storage';

/**
 * 本地历史版本：每次自动保存后，若距上一份超过 90 秒且内容有变化，
 * 就在 .glimnote/history/<笔记 id>/ 下留一份快照。
 * 不依赖 Git，断网或没接同步仓库时同样可用。
 */
const DIR = `${ROOT}/.glimnote/history`;
const MAX_VERSIONS = 40;
const MIN_GAP_MS = 90 * 1000;

const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})-(\d{3})$/;

function stampOf(d: Date) {
  const p = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

function dateOf(stamp: string): Date | null {
  const m = stamp.match(STAMP_RE);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7]));
}

function dirOf(noteId: string) {
  return `${DIR}/${noteId.replace(/[^a-zA-Z0-9-]/g, '')}`;
}

function nameOf(path: string) {
  return path.split('/').pop()!.replace(/\.md$/, '');
}

export interface VersionInfo {
  id: string;
  at: string;
  words: number;
  preview: string;
}

export async function snapshot(note: Note, opts: { force?: boolean } = {}): Promise<boolean> {
  const body = note.content.trim();
  if (!note.id || !body) return false;
  const dir = dirOf(note.id);
  let files: string[] = [];
  try {
    files = (await listFiles(dir)).sort();
  } catch {
    files = [];
  }
  const latest = files[files.length - 1];
  if (latest && !opts.force) {
    const at = dateOf(nameOf(latest));
    if (at && Date.now() - at.getTime() < MIN_GAP_MS) return false;
    try {
      if (stripFrontmatter(await readText(latest)).trim() === body) return false;
    } catch {
      /* 读不到就当作需要新建 */
    }
  }
  await ensureDir(dir);
  const target = `${dir}/${stampOf(new Date())}.md`;
  await writeText(target, buildFile(note));
  const all = (await listFiles(dir)).sort();
  if (all.length > MAX_VERSIONS) {
    for (const f of all.slice(0, all.length - MAX_VERSIONS)) {
      await removePath(f).catch(() => {});
    }
  }
  return true;
}

export async function listVersions(noteId: string): Promise<VersionInfo[]> {
  let files: string[] = [];
  try {
    files = await listFiles(dirOf(noteId));
  } catch {
    return [];
  }
  const out: VersionInfo[] = [];
  for (const f of files.sort().reverse()) {
    const id = nameOf(f);
    const at = dateOf(id);
    if (!at) continue;
    try {
      const body = stripFrontmatter(await readText(f));
      out.push({ id, at: at.toISOString(), words: wordCount(body), preview: excerptOf(body, 72) });
    } catch {
      /* 跳过损坏文件 */
    }
  }
  return out;
}

export async function readVersion(noteId: string, versionId: string): Promise<string | null> {
  if (!STAMP_RE.test(versionId)) return null;
  try {
    return stripFrontmatter(await readText(`${dirOf(noteId)}/${versionId}.md`));
  } catch {
    return null;
  }
}

export async function removeAll(noteId: string) {
  try {
    await removePath(dirOf(noteId));
  } catch {
    /* 没有历史就忽略 */
  }
}
