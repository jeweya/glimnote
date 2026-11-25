/**
 * 资源链接的解析与改写：正文里的 Markdown 链接 → 仓库里的文件。
 *
 * 同一张图片在正文里可能有两种写法：源码编辑器写入的是中文原样，富文本编辑器
 * 序列化成 Markdown 时会把中文转成 %E5… 这样的百分号编码。所以这里一律同时
 * 给出「原样」与「解码后」两个候选路径，凡是比较都按候选集合判断。
 */
import { ROOT } from './storage';
import { resolveAsset } from './assets';

export function assetPathCandidates(notePath: string, src: string): string[] {
  const out: string[] = [];
  const direct = resolveAsset(notePath, src);
  if (direct) out.push(direct);
  try {
    const decoded = decodeURI(src);
    if (decoded !== src) {
      const alt = resolveAsset(notePath, decoded);
      if (alt && alt !== direct) out.push(alt);
    }
  } catch {
    /* 百分号写坏了（比如孤立的 %）就只用原样 */
  }
  return out;
}

/** 这个链接是否指向仓库里的 abs */
export function refersTo(notePath: string, src: string, abs: string) {
  return assetPathCandidates(notePath, src).includes(abs);
}

export const LINK_RE = /(!?\[[^\]]*\]\()([^)]+)(\))/g;

/**
 * 按「原来所在的笔记目录」解析资源链接。
 * 回收站文件的物理路径是 .trash/日期/xxx.md，但正文里的 ../ 是按原位置写的，
 * 直接拿回收站路径解析会对不上，所以用记录下来的 notebook 还原层级。
 */
export function refPathOf(note: { path: string; notebook: string }) {
  if (!note.path.startsWith('.trash/')) return note.path;
  return `notes/${note.notebook || 'inbox'}/x.md`;
}

/** 把一篇笔记里指向 abs 的图片 / 附件链接换成 url */
export function rewriteAssetLinks(content: string, notePath: string, abs: string, url: string) {
  return content.replace(LINK_RE, (whole, open: string, target: string, close: string) => {
    if (!target || /^(https?:|data:|blob:|file:)/i.test(target)) return whole;
    return refersTo(notePath, target.trim(), abs) ? `${open}${url}${close}` : whole;
  });
}

/** 一篇笔记里还剩下多少处指向 abs 的链接 */
export function countAssetLinks(content: string, notePath: string, abs: string) {
  let n = 0;
  content.replace(LINK_RE, (whole, _open: string, target: string) => {
    if (target && !/^(https?:|data:|blob:|file:)/i.test(target) && refersTo(notePath, target.trim(), abs)) {
      n += 1;
    }
    return whole;
  });
  return n;
}

/** 一篇笔记里引用了哪些 assets/ 下的文件：rel → 出现次数（同一条链接只算一次） */
export function assetLinksOf(content: string, notePath: string): Map<string, number> {
  const out = new Map<string, number>();
  const prefix = `${ROOT}/`;
  content.replace(LINK_RE, (whole, _open: string, target: string) => {
    if (!target || /^(https?:|data:|blob:|file:)/i.test(target)) return whole;
    const seen = new Set<string>();
    for (const abs of assetPathCandidates(notePath, target.trim())) {
      if (!abs.startsWith(prefix)) continue;
      const rel = abs.slice(prefix.length);
      if (!rel.startsWith('assets/') || seen.has(rel)) continue;
      seen.add(rel);
      out.set(rel, (out.get(rel) || 0) + 1);
    }
    return whole;
  });
  return out;
}
