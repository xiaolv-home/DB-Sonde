/* 页面上有哪些 CodeMirror 编辑器、最近聚焦的是哪个。
 * 只记录,不做任何事 —— 谁需要「当前编辑器」(比如光标不在编辑器里时的 ⌘F)来这里问。 */
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

const views = new Set<EditorView>();
let lastFocused: EditorView | null = null;

/** 放进编辑器的 extensions,编辑器就登记在册;销毁时自动注销。 */
export const editorRegistry = ViewPlugin.fromClass(class {
  constructor(readonly view: EditorView) { views.add(view); }
  update(u: ViewUpdate) { if (u.focusChanged && u.view.hasFocus) lastFocused = u.view; }
  destroy() {
    views.delete(this.view);
    if (lastFocused === this.view) lastFocused = null;
  }
});

/** 正显示在屏幕上(切走的标签页是 display:none,不算) */
const shown = (view: EditorView) => view.dom.isConnected && view.dom.getClientRects().length > 0;

/** 当前标签页里的编辑器:优先最近聚焦过且还显示着的,否则第一个显示着的。 */
export function currentEditor(): EditorView | null {
  if (lastFocused && shown(lastFocused)) return lastFocused;
  for (const view of views) if (shown(view)) return view;
  return null;
}
