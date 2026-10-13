/* SQL 编辑器接上 lib/sqlPunctuation.ts 的规则。两条路:
 *
 * 1. 直接上屏的标点(句末单敲一个「;」):inputHandler 在字符进文档之前就换掉,
 *    不多一步撤销;换出来的括号、引号交给自动配对(insertBracket),和敲英文的手感一样。
 * 2. 跟着拼音一起组字的(敲「e。」再回车,输入法把 e。 原样一次上屏):组字过程中不碰,
 *    免得把输入法搅乱;等上屏结束(compositionend)再看刚上屏的那一段,把落在代码里的换掉。
 *    被符号顶上屏的(e。 再按 shift+8,输入法上屏「额。」再跟 *)在代码里退回拼音原文
 *    (数字 / 空格选的汉字保留)。 */
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { insertBracket } from "@codemirror/autocomplete";
import type { DbKind } from "../types";
import { asciiPunctuationFor, inCodeAt, revertSymbolCommit } from "../lib/sqlPunctuation";

/** 上屏后等这么久再收尾:CodeMirror 收尾组字在事件之后,顶上屏的那个符号也紧跟着进来 */
const SETTLE_MS = 50;
/** 换出来以后要走自动配对的 */
const PAIRED = new Set(["(", ")", "'", "\""]);

function typedInput(kind: DbKind | undefined) {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (view.composing) return false; // 组字中:交给下面的 composedInput 收尾
    const replacement = asciiPunctuationFor(text, view.state.sliceDoc(0, from), kind);
    if (replacement == null) return false;
    // 单个括号 / 引号交给自动配对:和直接敲英文的一样补右边那个、跳过已经补上的
    const bracket = PAIRED.has(replacement) ? insertBracket(view.state, replacement) : null;
    view.dispatch(bracket ?? {
      changes: { from, to, insert: replacement },
      selection: { anchor: from + replacement.length },
      userEvent: "input.type",
    });
    return true;
  });
}

function composedInput(kind: DbKind | undefined) {
  return ViewPlugin.fromClass(class {
    /** 这次组字从哪儿开始(随文档改动跟着挪) */
    start: number | null = null;
    /** 上屏前组字框里最后的样子(拼音原文,比如「e 。」) */
    marked = "";
    constructor(readonly view: EditorView) {}
    update(u: ViewUpdate) {
      if (this.start != null && u.docChanged) this.start = u.changes.mapPos(this.start, -1);
    }
    /** 上屏结束后:刚上屏的是 start 到光标这一段 */
    settle() {
      const { view } = this;
      if (this.start == null || view.composing) return;
      const from = this.start;
      const to = view.state.selection.main.head;
      this.start = null;
      if (to <= from) return;
      const typed = view.state.sliceDoc(from, to);
      const before = view.state.sliceDoc(0, from);
      // 代码里被符号顶上屏的:退回拼音原文再跟上那个符号
      const reverted = inCodeAt(before, kind) ? revertSymbolCommit(typed, this.marked) : null;
      const base = reverted ?? typed;
      const next = asciiPunctuationFor(base, before, kind) ?? base;
      if (next === typed) return;
      view.dispatch({
        changes: { from, to, insert: next },
        selection: { anchor: from + next.length },
        userEvent: "input.type",
      });
    }
  }, {
    eventHandlers: {
      compositionstart() { this.start = this.view.state.selection.main.from; this.marked = ""; },
      compositionupdate(e: CompositionEvent) { this.marked = e.data ?? ""; },
      compositionend() { window.setTimeout(() => this.settle(), SETTLE_MS); },
    },
  });
}

/** 放进 SQL 编辑器的 extensions */
export function sqlPunctuationInput(kind: DbKind | undefined): Extension {
  return [typedInput(kind), composedInput(kind)];
}
