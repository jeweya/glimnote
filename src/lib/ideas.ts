import { parseFrontmatter, stripFrontmatter } from './markdown';
import { t } from './i18n';

/**
 * 灵感 = 一条随手记下的碎片，一个文件只放一段文字（docs/14）。
 * 与笔记的区别：没有标题、没有笔记本、没有富文本，写下来就是全部；
 * 与待办的区别：灵感不承诺「要做」，整理时才决定变成笔记还是待办。
 */
export type IdeaKind = 'note' | 'task';

export interface Idea {
  id: string;
  text: string;
  created: string;
  updated: string;
  /** 整理去向：笔记或待办；未整理时为空 */
  convertedType?: IdeaKind;
  /** 笔记 id / 待办 id，用来打开结果（笔记改名也不受影响） */
  convertedId?: string;
  /** 结果标题，用于「已转化」列表里显示；目标改名后这里保持历史值 */
  convertedTitle?: string;
  convertedAt?: string;
  /** 运行时字段：仓库内相对路径，不写回文件 */
  path: string;
  size: number;
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
/** 单条灵感的上限：记的是念头，不是文章 */
export const IDEA_MAX = 2000;

function pad2(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

/** 12 位 base36：前 8 位是时间前缀，后 4 位随机（与待办同一套规则） */
export function newIdeaId() {
  const time = Date.now().toString(36).padStart(8, '0').slice(-8);
  let rand = '';
  for (let i = 0; i < 4; i += 1) rand += ID_ALPHABET[Math.floor(Math.random() * 36)];
  return `${time}${rand}`;
}

export function ideaDirOf(created: string) {
  const d = new Date(created);
  const date = Number.isNaN(d.getTime()) ? new Date() : d;
  return `ideas/${date.getFullYear()}/${pad2(date.getMonth() + 1)}`;
}

export function ideaPathOf(created: string, id: string) {
  return `${ideaDirOf(created)}/${id}.md`;
}

/** 去掉首尾空行与行尾空格；换行原样保留（灵感可以是几行） */
export function cleanIdeaText(text: string) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+/, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
    .slice(0, IDEA_MAX);
}

/** 第一行有效文字（去掉 Markdown 记号），用来当笔记/待办的标题 */
export function ideaFirstLine(text: string) {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return '';
  return line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '')
    .replace(/^>\s?/, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function ideaTitle(text: string, len = 40) {
  const line = ideaFirstLine(text);
  if (!line) return '';
  return line.length > len ? `${line.slice(0, len)}…` : line;
}

export function isIdeaOpen(idea: Idea) {
  return !idea.convertedType;
}

/** 解析一个灵感文件；缺字段时尽量兜底，单个文件坏了不影响整个列表 */
export function parseIdea(path: string, raw: string, fallbackTime = new Date().toISOString()): Idea {
  const fm = parseFrontmatter(raw);
  const body = cleanIdeaText(stripFrontmatter(raw));
  const fileName = (path.split('/').pop() || '').replace(/\.md$/, '');
  const created = typeof fm.created === 'string' && fm.created ? fm.created : fallbackTime;
  const updated = typeof fm.updated === 'string' && fm.updated ? fm.updated : created;
  const kind = fm.convertedType === 'note' || fm.convertedType === 'task' ? (fm.convertedType as IdeaKind) : undefined;
  return {
    id: typeof fm.id === 'string' && fm.id.trim() ? fm.id.trim() : fileName,
    text: body,
    created,
    updated,
    convertedType: kind,
    convertedId: kind && typeof fm.convertedId === 'string' && fm.convertedId ? fm.convertedId : undefined,
    convertedTitle: kind && typeof fm.convertedTitle === 'string' && fm.convertedTitle ? fm.convertedTitle : undefined,
    convertedAt: kind && typeof fm.convertedAt === 'string' && fm.convertedAt ? fm.convertedAt : undefined,
    path,
    size: raw.length,
  };
}

/** 序列化：frontmatter 字段顺序固定，diff 才稳定 */
export function buildIdeaFile(idea: Idea) {
  const meta = ['---', `id: ${idea.id}`, `created: ${idea.created}`, `updated: ${idea.updated}`];
  if (idea.convertedType) {
    meta.push(`convertedType: ${idea.convertedType}`);
    if (idea.convertedId) meta.push(`convertedId: ${idea.convertedId}`);
    if (idea.convertedTitle) meta.push(`convertedTitle: ${cleanIdeaText(idea.convertedTitle).replace(/\n/g, ' ')}`);
    if (idea.convertedAt) meta.push(`convertedAt: ${idea.convertedAt}`);
  }
  meta.push('---', '');
  return meta.join('\n') + cleanIdeaText(idea.text);
}

export function newIdea(text: string, created = new Date().toISOString()): Idea {
  const id = newIdeaId();
  return {
    id,
    text: cleanIdeaText(text),
    created,
    updated: created,
    path: ideaPathOf(created, id),
    size: 0,
  };
}

export function matchIdea(idea: Idea, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return idea.text.toLowerCase().includes(q);
}

export interface IdeaGroup {
  label: string;
  list: Idea[];
}

/** 按记录时间倒序分三组；组的顺序固定，位置不会随条数跳动 */
export function groupIdeas(ideas: Idea[], now = new Date()): IdeaGroup[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;
  const groups: IdeaGroup[] = [
    { label: t('今天'), list: [] },
    { label: t('昨天'), list: [] },
    { label: t('更早'), list: [] },
  ];
  const sorted = [...ideas].sort((a, b) => +new Date(b.created) - +new Date(a.created));
  for (const idea of sorted) {
    const ts = +new Date(idea.created);
    if (Number.isFinite(ts) && ts >= today) groups[0].list.push(idea);
    else if (Number.isFinite(ts) && ts >= yesterday) groups[1].list.push(idea);
    else groups[2].list.push(idea);
  }
  return groups.filter((g) => g.list.length);
}

/** 「14:03」；不是今天就带上日期「10月28日 09:12」 */
export function ideaTimeText(iso: string, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return time;
  return `${t('{m}月{d}日', { m: d.getMonth() + 1, d: d.getDate() })} ${time}`;
}

/** 合并笔记里用的短时间戳：今天只写时分，跨天补月日 */
export function ideaStamp(iso: string, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}
