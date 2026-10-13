/* SQL 编辑器里把代码中敲出的全角标点换成英文的(规则在 lib/sqlPunctuation.ts)。两条路:
 *
 * 1. 直接上屏的标点(句末单敲一个「;」):inputHandler 在字符进文档之前就换掉,
 *    不多一步撤销;换出来的括号交给自动配对(insertBracket),和敲英文括号手感一样。
 * 2. 跟着拼音一起组字的(敲「e。」再回车,输入法把 e。 原样一次上屏):组字过程中不碰,
 *    免得把输入法搅乱;等上屏结束(compositionend)再看刚上屏的那一段,把落在代码里的换掉。 */
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { insertBracket } from "@codemirror/autocomplete";
import type { DbKind } from "../types";
import { asciiPunctuationFor } from "../lib/sqlPunctuation";

function typedInput(kind: DbKind | undefined) {
  return EditorView.inputHandler.of((view, from, to, text) => {
    if (view.composing) return false; // 组字中:交给下面的 composedInput 收尾
    const replacement = asciiPunctuationFor(text, view.state.sliceDoc(0, from), kind);
    if (replacement == null) return false;
    const bracket = (replacement === "(" || replacement === ")") ? insertBracket(view.state, replacement) : null;
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
      const replacement = asciiPunctuationFor(typed, view.state.sliceDoc(0, from), kind);
      // 全角 → 英文都是一个字换一个字,长度不变,光标不用动
      if (replacement == null || replacement.length !== typed.length) return;
      view.dispatch({ changes: { from, to, insert: replacement }, userEvent: "input.type" });
    }
  }, {
    eventHandlers: {
      compositionstart() { this.start = this.view.state.selection.main.from; },
      // CodeMirror 收尾组字是在事件之后,稍等一下再看
      compositionend() { window.setTimeout(() => this.settle(), 30); },
    },
  });
}

/** 放进 SQL 编辑器的 extensions */
export function sqlPunctuationInput(kind: DbKind | undefined): Extension {
  return [typedInput(kind), composedInput(kind)];
}
