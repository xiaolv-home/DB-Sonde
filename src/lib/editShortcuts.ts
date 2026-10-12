/* 全选 / 查找这几个快捷键的路由。只管「这一下按键该交给谁」,不认识任何具体的编辑器或面板 ——
 * 真正执行什么由装配的地方传进来(installEditShortcuts 的 deps)。
 *
 * 要管两件事:
 * 1. 光标不在编辑器里(刚点过结果表格、标签栏、左边的树)时按 ⌘F / ⌘G / ⌘A:
 *    交给当前标签页的编辑器。⌘A 尤其要管 —— 落到网页自带的全选,会把界面上看得见的字
 *    (连同编辑器屏幕上那几十行)选成一片,像是「只选中了屏幕上能看到的部分」。
 * 2. macOS 菜单栏「编辑」里的这几项(src-tauri/src/app_menu.rs):系统菜单有时先把按键吃掉,
 *    页面收不到;有时页面收到了、菜单又触发一次。菜单触发时把它当成一次普通按键重新发进页面,
 *    并且同一下按键 400ms 内只算一次。 */

export type EditCommand = "selectAll" | "find" | "replace" | "findNext" | "findPrev";

interface KeyLike { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }

/** ⌘(Windows 上是 Ctrl)组合键 → 命令;不是这几个返回 null。按物理键认(⌥ 会把 f 变成 ƒ)。 */
export function commandOf(e: KeyLike): EditCommand | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  if (e.code === "KeyA" && !e.altKey && !e.shiftKey) return "selectAll";
  if (e.code === "KeyF" && !e.shiftKey) return e.altKey ? "replace" : "find";
  if (e.code === "KeyG" && !e.altKey) return e.shiftKey ? "findPrev" : "findNext";
  return null;
}

/** 菜单项 id(app_menu.rs 里的)→ 命令 */
export const MENU_COMMANDS: Record<string, EditCommand> = {
  "edit.select_all": "selectAll",
  "edit.find": "find",
  "edit.replace": "replace",
  "edit.find_next": "findNext",
  "edit.find_prev": "findPrev",
};

/** 把命令还原成一次按键(重新发进页面用)。key 用不带 ⌥ 变形的字母:合成按键没有 keyCode,
 *  CodeMirror 认不出 ƒ 就是 ⌥F。 */
const KEY_OF: Record<EditCommand, { code: string; key: string; altKey: boolean; shiftKey: boolean }> = {
  selectAll: { code: "KeyA", key: "a", altKey: false, shiftKey: false },
  find: { code: "KeyF", key: "f", altKey: false, shiftKey: false },
  replace: { code: "KeyF", key: "f", altKey: true, shiftKey: false },
  findNext: { code: "KeyG", key: "g", altKey: false, shiftKey: false },
  findPrev: { code: "KeyG", key: "G", altKey: false, shiftKey: true },
};

/** 同一下按键两条路(页面真按键 / 菜单)都到时只算一次。纯逻辑,时间可注入方便测试。 */
export function createDeduper(windowMs = 400, now: () => number = Date.now) {
  let real: { cmd: EditCommand; at: number; handled: () => boolean } | null = null;
  let menu: { cmd: EditCommand; at: number } | null = null;
  return {
    /** 页面收到真按键时问:菜单那条路刚做过这件事吗?做过就该把这一下吞掉。 */
    onRealKey(cmd: EditCommand, handled: () => boolean): "swallow" | "pass" {
      if (menu && menu.cmd === cmd && now() - menu.at < windowMs) { menu = null; return "swallow"; }
      real = { cmd, at: now(), handled };
      return "pass";
    },
    /** 菜单触发时问:该重新发一次按键,还是页面已经收到过(有人处理了就跳过,没人处理只补兜底)? */
    onMenu(cmd: EditCommand): "dispatch" | "skip" | "fallback" {
      if (real && real.cmd === cmd && now() - real.at < windowMs) {
        const wasHandled = real.handled();
        real = null;
        return wasHandled ? "skip" : "fallback";
      }
      menu = { cmd, at: now() };
      return "dispatch";
    },
  };
}

/* 只认标准的 DOM 语义,不认任何具体组件的 class:
 *   可编辑的东西(输入框、编辑器)自己处理这些键;
 *   aria-modal 的浮层(对话框、数据资产、链路画布)开着时快捷键是它的事;
 *   别的可获得焦点的组件(结果表格、树)有自己的键盘逻辑,不替它做主。 */
const EDITABLE = "input, textarea, select, [contenteditable=true], .cm-editor";
const MODAL = '[aria-modal="true"]';

export interface EditShortcutDeps<V> {
  /** 当前标签页里的编辑器 */
  currentEditor: () => V | null;
  /** 对编辑器执行命令(聚焦它再执行) */
  run: (cmd: EditCommand, editor: V) => void;
  /** 订阅菜单栏「编辑」里的菜单项;没有菜单栏(浏览器预览、Windows)就不传 */
  listenMenu?: (onItem: (id: string) => void) => void;
}

/** 输入框里的 ⌘A 没人接时补上全选(系统的「全选」菜单项已经换成我们自己的了) */
function selectAllIn(el: Element) {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
  else if (el instanceof HTMLElement && el.isContentEditable) document.execCommand("selectAll");
}

let installed = false;

/** 装一次就够(重复调用无效)。 */
export function installEditShortcuts<V>(deps: EditShortcutDeps<V>) {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const dedupe = createDeduper();

  // 捕获阶段最先看到真按键:菜单刚做过同一件事就吞掉
  window.addEventListener("keydown", (e) => {
    if (!e.isTrusted) return;
    const cmd = commandOf(e);
    if (cmd && dedupe.onRealKey(cmd, () => e.defaultPrevented) === "swallow") {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  // 冒泡阶段兜底:编辑器、输入框、画布等都没处理时,交给当前标签页的编辑器
  window.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    const cmd = commandOf(e);
    if (!cmd) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(EDITABLE)) return; // 它们自己会处理
    const nothingFocused = !target || target === document.body;
    const modalOpen = !!target?.closest(MODAL) || (nothingFocused && !!document.querySelector(MODAL));
    if (cmd === "selectAll") {
      // 界面上的字永远不该被 ⌘A 选成一片;只有焦点哪儿都不在时才替当前编辑器全选
      e.preventDefault();
      if (modalOpen || !nothingFocused) return;
    } else if (modalOpen) return;
    const editor = deps.currentEditor();
    if (!editor) return;
    e.preventDefault();
    deps.run(cmd, editor);
  });

  deps.listenMenu?.((id) => {
    const cmd = MENU_COMMANDS[id];
    if (!cmd) return;
    const el = document.activeElement ?? document.body;
    const verdict = dedupe.onMenu(cmd);
    if (verdict === "skip") return;
    if (verdict === "fallback") { if (cmd === "selectAll") selectAllIn(el); return; }
    const mac = navigator.platform.startsWith("Mac");
    const ev = new KeyboardEvent("keydown", { ...KEY_OF[cmd], metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    if (!ev.defaultPrevented && cmd === "selectAll") selectAllIn(el);
  });
}
