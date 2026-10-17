/* 编辑器通用能力的装配处:SQL 编辑器、Python 编辑器都从这里拿,各部件彼此不认识 ——
 *   editorRegistry  记住有哪些编辑器、当前是哪个
 *   editorSearch    查找 / 替换条
 *   editorClickGuard 点回编辑器时别让视图跳走(WebKit)
 *   editShortcuts   光标不在编辑器里 / 菜单栏触发时的 ⌘A ⌘F ⌘G 路由
 * 只有这个文件知道它们怎么接在一起。 */
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { selectAll } from "@codemirror/commands";
import { editorRegistry, currentEditor } from "../lib/editorRegistry";
import { editorClickGuard } from "../lib/editorClickGuard";
import { installEditShortcuts, type EditCommand } from "../lib/editShortcuts";
import { inTauri } from "../lib/mockBackend";
import { editorSearch, searchCommands } from "./editorSearch";

function run(cmd: EditCommand, view: EditorView) {
  view.focus();
  if (cmd === "selectAll") selectAll(view);
  else if (cmd === "find") searchCommands.find(view);
  else if (cmd === "replace") searchCommands.replace(view);
  else if (cmd === "findNext") searchCommands.findNext(view);
  else searchCommands.findPrevious(view);
}

const listenMenu = inTauri
  ? (onItem: (id: string) => void) => {
      void import("@tauri-apps/api/event").then(({ listen }) => listen<string>("menu://edit", (e) => onItem(e.payload)));
    }
  : undefined;

/** 没有代码编辑器的窗口(独立的链路画布窗口)也要接菜单栏转来的 ⌘A 这些,不然会被系统菜单吃掉 */
export function installAppEditKeys(): void {
  installEditShortcuts({ currentEditor, run, listenMenu });
}

/** 放进编辑器 extensions 里。basicSetup 要关掉 searchKeymap(用我们自己的查找条)。 */
export function editorKit(): Extension {
  installEditShortcuts({ currentEditor, run, listenMenu });
  return [editorRegistry, editorClickGuard, editorSearch()];
}
