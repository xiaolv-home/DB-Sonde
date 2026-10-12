/* 点回编辑器时别让视图跳走。
 *
 * 现象(macOS 26 的 WebKit):选中一段 SQL、点工具栏执行,再滚下去点别处 ——
 * 第一下视图会跳回原来选中的那段,点也点错了地方,得再滚回来点一次。
 * 原因:编辑器重新拿到焦点时,WebKit 会把「上次的选区」恢复出来并滚到它那里;
 * Safari 26 又坏了 focus({preventScroll}),CodeMirror 只能「先聚焦、再把滚动位置放回去」,
 * 放回去之后选区还是旧的,再写回页面时又滚走一次。
 *
 * 这里在 CodeMirror 自己处理按下鼠标之前(扩展的 handler 先于内置 handler 跑):
 *   1. 先把光标放到点的位置(不滚动)—— 旧选区没了,谁再「滚到选区」都只会滚到点的地方,本来就在眼前;
 *   2. 按下后很短的一段时间里,鼠标没拖、没滚轮、没按键,滚动却突然跳了两行以上 —— 放回去。
 * 按着 Shift / ⌘ / ⌥ / Ctrl(扩选、多光标、矩形选)、在已选中的文字上按下(准备拖动它)都不动。 */
import { EditorView } from "@codemirror/view";

/** 按下之后多久之内的「突然跳走」算误跳(毫秒) */
const GUARD_MS = 400;

function guardScroll(view: EditorView, down: MouseEvent) {
  const sc = view.scrollDOM;
  const top = sc.scrollTop;
  const left = sc.scrollLeft;
  const limit = view.defaultLineHeight * 2;
  const until = Date.now() + GUARD_MS;
  let done = false;
  const onMove = (e: MouseEvent) => {
    // 拖起来了:拖到边上 CodeMirror 会自动滚,那是用户要的
    if (Math.abs(e.clientX - down.clientX) + Math.abs(e.clientY - down.clientY) > 4) stop();
  };
  const onScroll = () => {
    if (Date.now() > until) { stop(); return; }
    if (Math.abs(sc.scrollTop - top) > limit) {
      sc.scrollTop = top;
      sc.scrollLeft = left;
    }
  };
  const stop = () => {
    if (done) return;
    done = true;
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("keydown", stop, true);
    sc.removeEventListener("wheel", stop);
    sc.removeEventListener("scroll", onScroll);
  };
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("keydown", stop, true);
  sc.addEventListener("wheel", stop, { passive: true });
  sc.addEventListener("scroll", onScroll);
  window.setTimeout(stop, GUARD_MS + 50);
}

export const editorClickGuard = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    const sel = view.state.selection;
    const onSelected = sel.ranges.some((r) => !r.empty && pos >= r.from && pos <= r.to);
    const already = sel.ranges.length === 1 && sel.main.empty && sel.main.head === pos;
    if (!onSelected && !already) view.dispatch({ selection: { anchor: pos }, userEvent: "select.pointer" });
    guardScroll(view, event);
    return false; // 接着交给 CodeMirror 自己处理(放光标、拖选、双击选词都照旧)
  },
});
