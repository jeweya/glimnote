import { Annotation, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';

/**
 * 「刚选了字号 / 颜色、还没输入」的样式。以前是往正文里塞一对空
 * <span style="…"></span>，空标签在阅读预览、导出的 HTML、以及粘贴到 Word
 * 之类的富文本编辑器里会被算成一行，字号越大空行越高，看起来像行距忽然变大。
 * 现在样式只挂在这个状态里，第一次输入时再包住文字，正文里不会出现空标签。
 * 删掉最后一个带样式的字时，样式也会交接到这里，下一次输入继续沿用。
 */
export const setPendingStyle = StateEffect.define<string | null>();

const styleWrapped = Annotation.define<boolean>();

export const pendingStyleField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    // 刚用它包住第一段文字，样式已经落到文档里了
    if (tr.annotation(styleWrapped)) return null;
    let explicit = false;
    for (const e of tr.effects) {
      if (e.is(setPendingStyle)) {
        value = e.value;
        explicit = true;
      }
    }
    // 删除最后一个带样式的字时，同一个事务既要删标签，又要交接待用样式；
    // 这种主动设置不能被 docChanged / selection 的默认清理覆盖。
    if (!explicit) {
      // 真的改了文字或移动了光标，待用样式就作废
      if (tr.docChanged) value = null;
      if (tr.selection) value = null;
    }
    return value;
  },
});

/** 第一次输入的文字外面补上待用样式；光标留在文字末尾的闭合标签之前，后续输入继续在样式里 */
function wrapPendingStyle(tr: Transaction) {
  if (!tr.docChanged) return tr;
  const css = tr.startState.field(pendingStyleField, false);
  if (!css) return tr;
  if (!tr.isUserEvent('input')) return tr;
  const sel = tr.startState.selection.main;
  if (!sel.empty) return tr;

  let text = '';
  let ok = true;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (!ok) return;
    if (fromA !== toA || fromA !== sel.from || text) {
      ok = false;
      return;
    }
    text = inserted.toString();
  });
  if (!ok || !text) return tr;
  // 多行、像标签的粘贴不套样式，免得把 span 跨行或重复包起来
  if (text.includes('\n') || text.includes('<') || text.length > 120) return tr;

  const open = `<span style="${css}">`;
  return {
    changes: { from: sel.from, to: sel.to, insert: `${open}${text}</span>` },
    selection: { anchor: sel.from + open.length + text.length },
    annotations: [styleWrapped.of(true)],
    userEvent: tr.annotation(Transaction.userEvent) || undefined,
    scrollIntoView: tr.scrollIntoView,
  };
}

export const pendingStyleExtensions = [pendingStyleField, EditorState.transactionFilter.of(wrapPendingStyle)];
