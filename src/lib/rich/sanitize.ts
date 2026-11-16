/**
 * 剪贴板清洗：网页、Word、其它编辑器复制过来的文字常夹带当前笔记用不到的字符。
 * 它们大多看不见，但会让排版、搜索、Markdown 解析出问题（例如不换行空格让
 * 行尾空白清不掉，零宽空格让搜索永远匹配不上）。这里只处理会影响显示或
 * 破坏结构的字符，正常文字、全角标点、Emoji 一概不动：
 *
 * - 换行统一成 LF（CRLF / CR、NEL、Unicode 行/段分隔符都收成 LF）
 * - 去掉 NUL、控制符、软连字符、零宽空格、BOM、双向控制符
 * - 不换行空格、窄空格、全角空格统一成普通空格
 * - 保留零宽连接符（ZWJ），否则组合 Emoji 会被拆开
 */

/** 需要直接删掉、不占位置的字符（软连字符、零宽空格、方向控制符等） */
const DROP_CODES = new Set<number>([
  0x00ad, // 软连字符
  0x061c, // 阿拉伯字母标记
  0x180e, // 蒙古文元音分隔符
  0x200b, // 零宽空格
  0x200e, // LRM
  0x200f, // RLM
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // 双向嵌入 / 覆盖
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064, // word joiner 等不可见格式符
  0x2066, 0x2067, 0x2068, 0x2069, // 双向隔离
  0xfeff, // BOM / 零宽不换行空格
]);

/** 控制符：保留制表符与换行，其余（含 DEL）都删掉 */
function isControlCode(cp: number) {
  if (cp === 0x09 || cp === 0x0a) return false;
  return cp <= 0x1f || cp === 0x7f;
}

/** 视觉上是换行、但不是 LF 的字符：NEL 与 Unicode 行 / 段分隔符 */
function isLineBreakCode(cp: number) {
  return cp === 0x85 || cp === 0x2028 || cp === 0x2029;
}

/** 各种「看起来是空格、实际不是普通空格」的字符 */
function isOddSpaceCode(cp: number) {
  return (
    cp === 0x00a0 ||
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

function needsClean(text: string) {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (
      cp === 0x0d ||
      isControlCode(cp) ||
      isLineBreakCode(cp) ||
      isOddSpaceCode(cp) ||
      DROP_CODES.has(cp)
    )
      return true;
  }
  return false;
}

/** 清洗从剪贴板读到的纯文本 */
export function sanitizePastedText(text: string): string {
  if (!text || !needsClean(text)) return text;
  let out = '';
  let afterCr = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x0d) {
      out += '\n';
      afterCr = true;
      continue;
    }
    if (cp === 0x0a) {
      if (!afterCr) out += '\n';
      afterCr = false;
      continue;
    }
    if (isLineBreakCode(cp)) {
      out += '\n';
      afterCr = false;
      continue;
    }
    afterCr = false;
    if (isControlCode(cp) || DROP_CODES.has(cp)) continue;
    if (isOddSpaceCode(cp)) {
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/** 清洗 HTML 片段里的文本节点，标签与属性原样保留 */
export function sanitizePastedHtml(html: string): string {
  if (!html) return html;
  try {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
    let changed = false;
    let node = walker.nextNode();
    while (node) {
      const value = node.nodeValue || '';
      if (needsClean(value)) {
        node.nodeValue = sanitizePastedText(value);
        changed = true;
      }
      node = walker.nextNode();
    }
    return changed ? tpl.innerHTML : html;
  } catch {
    return html;
  }
}
