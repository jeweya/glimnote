import MiniSearch from 'minisearch';
import type { Note } from './markdown';

/**
 * MiniSearch 默认按空格 / 标点切词，一整串中文会被当成一个 token，
 * 于是搜「公园」永远匹配不到正文里的「去公园散步」。这里给 CJK 补上
 * 单字 + 相邻双字：既能让任意中文子串命中，又不会把整段话塞进索引。
 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function tokenizeCjk(text: string, bigrams: boolean): string[] {
  const out: string[] = [];
  const parts = String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  for (const part of parts) {
    let latin = '';
    let run = '';
    const flushLatin = () => {
      if (!latin) return;
      out.push(latin);
      latin = '';
    };
    const flushRun = () => {
      if (!run) return;
      for (let i = 0; i < run.length; i++) {
        out.push(run[i]);
        if (bigrams && i + 1 < run.length) out.push(run.slice(i, i + 2));
      }
      run = '';
    };
    for (const ch of part) {
      if (CJK_RE.test(ch)) {
        flushLatin();
        run += ch;
      } else {
        flushRun();
        latin += ch;
      }
    }
    flushLatin();
    flushRun();
  }
  return out;
}

/** 建索引：中文单字 + 相邻双字，双字用来给相邻命中加分 */
export function tokenizeSearch(text: string): string[] {
  return tokenizeCjk(text, true);
}

/** 查询兜底：只按单字切，避免「写代码」被拆成「写/代/码/写代/代码」后
 *  因为原文是「写了点代码」而漏掉——双字只负责提高精度，不能一票否决 */
export function tokenizeSearchLoose(text: string): string[] {
  return tokenizeCjk(text, false);
}

const SEARCH_OPTIONS = {
  boost: { title: 3, tags: 2 },
  fuzzy: (term: string) => (term.length >= 3 ? 0.2 : false),
  prefix: true,
  combineWith: 'AND' as const,
  tokenize: tokenizeSearch,
};

let index = new MiniSearch<{ id: string; title: string; body: string; tags: string }>({
  fields: ['title', 'body', 'tags'],
  storeFields: ['id'],
  tokenize: tokenizeSearch,
  searchOptions: SEARCH_OPTIONS,
});

let cached: Note[] = [];

export function rebuild(notes: Note[]) {
  cached = notes;
  index = new MiniSearch({
    fields: ['title', 'body', 'tags'],
    storeFields: ['id'],
    tokenize: tokenizeSearch,
    searchOptions: SEARCH_OPTIONS,
  });
  index.addAll(
    notes.map((n) => ({
      id: n.id,
      title: n.title,
      body: n.content,
      tags: n.tags.join(' '),
    })),
  );
}

export interface ParsedQuery {
  text: string;
  tags: string[];
  notebooks: string[];
  before?: Date;
  after?: Date;
  title?: string;
  pinned?: boolean;
  image?: boolean;
  todo?: boolean;
}

export function parseQuery(raw: string): ParsedQuery {
  const q: ParsedQuery = { text: '', tags: [], notebooks: [] };
  const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  const words: string[] = [];
  for (const token of tokens) {
    const m = token.match(/^(tag|in|before|after|title|has|is):(.+)$/i);
    if (m) {
      const key = m[1].toLowerCase();
      const value = m[2].replace(/^"|"$/g, '');
      if (key === 'tag') q.tags.push(value);
      else if (key === 'in') q.notebooks.push(value);
      else if (key === 'before') q.before = new Date(value);
      else if (key === 'after') q.after = new Date(value);
      else if (key === 'title') q.title = value.toLowerCase();
      else if (key === 'has' && value === 'image') q.image = true;
      else if (key === 'is' && value === 'pinned') q.pinned = true;
      else if (key === 'is' && value === 'todo') q.todo = true;
      else words.push(token);
      continue;
    }
    words.push(token.replace(/^"|"$/g, ''));
  }
  q.text = words.join(' ').trim();
  return q;
}

/** 搜索框里的正文关键词（去掉 tag: / notebook: / title: 这类过滤词），用于打开笔记后高亮 */
export function highlightTermsOf(raw: string): string[] {
  const q = parseQuery(raw);
  return q.text
    ? [
        ...new Set(
          q.text
            .split(/\s+/)
            .map((w) => w.trim())
            .filter(Boolean),
        ),
      ]
    : [];
}

export function searchNotes(notes: Note[], raw: string): Note[] {
  const q = parseQuery(raw);
  let pool = notes;

  if (q.tags.length) pool = pool.filter((n) => q.tags.every((t) => n.tags.some((nt) => nt.includes(t))));
  if (q.notebooks.length)
    pool = pool.filter((n) => q.notebooks.some((nb) => n.notebook.includes(nb) || n.path.includes(nb)));
  if (q.pinned) pool = pool.filter((n) => n.pinned);
  if (q.image) pool = pool.filter((n) => /!\[[^\]]*\]\([^)]*\)/.test(n.content));
  if (q.todo) pool = pool.filter((n) => /-\s\[ \]/.test(n.content));
  if (q.title) pool = pool.filter((n) => n.title.toLowerCase().includes(q.title!));
  if (q.after) pool = pool.filter((n) => new Date(n.updated) >= q.after!);
  if (q.before) pool = pool.filter((n) => new Date(n.updated) < q.before!);

  if (!q.text) {
    return [...pool].sort((a, b) => +new Date(b.updated) - +new Date(a.updated));
  }

  const ids = new Set(pool.map((n) => n.id));
  // 先按「单字 + 双字」精确搜；一条都没有时退回单字，保证口语化的中文能命中
  let results = index.search(q.text);
  if (!results.length) results = index.search(q.text, { tokenize: tokenizeSearchLoose });
  return results.map((r) => cached.find((n) => n.id === r.id)).filter((n): n is Note => Boolean(n) && ids.has(n!.id));
}

export function highlight(text: string, term: string) {
  if (!term) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const t = term.toLowerCase();
  const out: { text: string; hit: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(t, i);
    if (idx < 0) {
      out.push({ text: text.slice(i), hit: false });
      break;
    }
    if (idx > i) out.push({ text: text.slice(i, idx), hit: false });
    out.push({ text: text.slice(idx, idx + t.length), hit: true });
    i = idx + t.length;
  }
  return out;
}

/** 把 Markdown 压成一行纯文本，取命中词附近的一段，用于搜索结果第二行 */
export function excerptAround(text: string, term: string, radius = 42): string {
  const clean = String(text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const word = (term || '').trim().split(/\s+/)[0] || '';
  const idx = word ? clean.toLowerCase().indexOf(word.toLowerCase()) : -1;
  if (idx < 0) return clean.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(clean.length, idx + word.length + radius);
  return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
}
