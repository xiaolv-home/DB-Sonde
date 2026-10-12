/* 编辑器里的「查找 / 替换」条:SQL 编辑器和 Python 编辑器共用。
 *
 * 底层用 CodeMirror 自带的搜索(@codemirror/search:高亮所有匹配、正则 $1 替换、一步撤销),
 * 只把它那个英文面板换成我们自己的:
 *   ⌘F 查找(选中了文字就直接拿来查)· ⌥⌘F 查找并替换
 *   回车 / ⌘G 下一个 · ⇧回车 / ⇧⌘G 上一个 · Esc 关掉
 *   区分大小写 / 全词 / 正则;边打边跳到第一个匹配;显示「第 3 / 12 个」。
 * 只读的编辑器不出现替换。 */
import "./editorSearch.css";
import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView, keymap, runScopeHandlers, type Panel, type ViewUpdate } from "@codemirror/view";
import { EditorSelection, Prec, type EditorState, type Extension } from "@codemirror/state";
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel,
  replaceAll, replaceNext, search, searchPanelOpen, setSearchQuery,
} from "@codemirror/search";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, X } from "lucide-react";

/** 数到这么多就不往下数了(显示「9999+」),大文件里搜一个字母也不卡 */
export const MAX_COUNT = 9999;

/** 一共多少处匹配、当前选中的是第几处(从 1 开始;选中的不是匹配就是 0)。 */
export function countMatches(state: EditorState, query: SearchQuery): { total: number; current: number; capped: boolean } {
  if (!query.valid || !query.search) return { total: 0, current: 0, capped: false };
  const sel = state.selection.main;
  const cursor = query.getCursor(state);
  let total = 0, current = 0;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total += 1;
    if (next.value.from === sel.from && next.value.to === sel.to) current = total;
    if (total >= MAX_COUNT) return { total, current, capped: true };
  }
  return { total, current, capped: false };
}

/** 从 from 开始找第一处匹配(找不到就从头绕一圈)。 */
export function firstMatchFrom(state: EditorState, query: SearchQuery, from: number): { from: number; to: number } | null {
  if (!query.valid || !query.search) return null;
  const after = query.getCursor(state, from).next();
  if (!after.done) return after.value;
  const wrap = query.getCursor(state, 0).next();
  return wrap.done ? null : wrap.value;
}

/* 每个编辑器一个控制器:⌥⌘F 要能把「替换」那一行打开 */
const controllers = new WeakMap<EditorView, { showReplace: () => void }>();
const wantReplace = new WeakSet<EditorView>();

function SearchBar({ view, subscribe }: { view: EditorView; subscribe: (fn: () => void) => () => void }) {
  const readOnly = view.state.readOnly;
  const [spec, setSpec] = useState(() => getSearchQuery(view.state));
  const [replaceOpen, setReplaceOpen] = useState(() => !readOnly && wantReplace.has(view));
  const [stats, setStats] = useState(() => countMatches(view.state, getSearchQuery(view.state)));
  const [note, setNote] = useState("");
  // 边打边找从这里开始:打开时光标所在处
  const origin = useRef(view.state.selection.main.from);
  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    wantReplace.delete(view);
    controllers.set(view, { showReplace: () => { if (!readOnly) { setReplaceOpen(true); window.setTimeout(() => replaceRef.current?.focus(), 0); } } });
    return () => { controllers.delete(view); };
  }, [view, readOnly]);
  // 文档变了、选区变了、别处改了查询(比如又按了一次 ⌘F 换成新选中的词):跟着更新
  useEffect(() => subscribe(() => {
    const q = getSearchQuery(view.state);
    setSpec((old) => (old.eq(q) ? old : q));
    setStats(countMatches(view.state, q));
  }), [subscribe, view]);

  const apply = (patch: Partial<{ search: string; replace: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean }>, jump = true) => {
    const q = new SearchQuery({
      search: spec.search, replace: spec.replace, caseSensitive: spec.caseSensitive,
      wholeWord: spec.wholeWord, regexp: spec.regexp, literal: true, ...patch,
    });
    setNote("");
    const effects = [setSearchQuery.of(q)];
    const hit = jump ? firstMatchFrom(view.state, q, origin.current) : null;
    if (hit) view.dispatch({ effects: [...effects, EditorView.scrollIntoView(hit.from, { y: "center" })], selection: EditorSelection.single(hit.from, hit.to) });
    else view.dispatch({ effects });
  };
  const go = (dir: 1 | -1) => {
    if (dir === 1) findNext(view); else findPrevious(view);
    origin.current = view.state.selection.main.from;
  };
  const doReplace = () => { replaceNext(view); origin.current = view.state.selection.main.from; };
  const doReplaceAll = () => {
    const n = countMatches(view.state, getSearchQuery(view.state)).total;
    if (n && replaceAll(view)) setNote(`已替换 ${n} 处`);
  };
  const close = () => { closeSearchPanel(view); view.focus(); };

  const badRegex = spec.regexp && !!spec.search && !spec.valid;
  const count = !spec.search ? "" : badRegex ? "正则写错了" : stats.total === 0 ? "没有结果"
    : `${stats.current ? `第 ${stats.current} / ` : ""}${stats.total}${stats.capped ? "+" : ""}${stats.current ? "" : " 处"}`;

  return (
    <div className="ss-bar" onKeyDown={(e) => {
      // 面板里按的 ⌘G / ⇧⌘G / F3 / ⌘F / ⌥⌘F / Esc 交给 search-panel 范围的快捷键(和 CodeMirror 自带面板一样)
      if (runScopeHandlers(view, e.nativeEvent, "search-panel")) { e.preventDefault(); e.stopPropagation(); }
    }}>
      <div className="ss-row">
        {!readOnly && (
          <button className="ss-icon" title={replaceOpen ? "收起替换" : "展开替换 (⌥⌘F)"} onClick={() => setReplaceOpen((v) => !v)}>
            {replaceOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
        <div className={`ss-field ${badRegex ? "bad" : ""}`}>
          <input ref={findRef} main-field="true" className="ss-input" placeholder="查找" value={spec.search} spellCheck={false}
            onChange={(e) => apply({ search: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); go(e.shiftKey ? -1 : 1); } }} />
          <button className={`ss-opt ${spec.caseSensitive ? "on" : ""}`} title="区分大小写" onClick={() => apply({ caseSensitive: !spec.caseSensitive })}>Aa</button>
          <button className={`ss-opt ${spec.wholeWord ? "on" : ""}`} title="全词匹配" onClick={() => apply({ wholeWord: !spec.wholeWord })}><u>ab</u></button>
          <button className={`ss-opt ${spec.regexp ? "on" : ""}`} title="正则表达式(替换里可以用 $1、$2 引用分组)" onClick={() => apply({ regexp: !spec.regexp })}>.*</button>
        </div>
        <span className={`ss-count ${spec.search && (stats.total === 0 || badRegex) ? "none" : ""}`}>{count}</span>
        <button className="ss-icon" title="上一个 (⇧回车 / ⇧⌘G)" disabled={!stats.total} onClick={() => go(-1)}><ArrowUp size={14} /></button>
        <button className="ss-icon" title="下一个 (回车 / ⌘G)" disabled={!stats.total} onClick={() => go(1)}><ArrowDown size={14} /></button>
        <button className="ss-icon" title="关闭 (Esc)" onClick={close}><X size={14} /></button>
      </div>
      {replaceOpen && !readOnly && (
        <div className="ss-row">
          <span className="ss-indent" />
          <div className="ss-field">
            <input ref={replaceRef} className="ss-input" placeholder="替换为" value={spec.replace} spellCheck={false}
              onChange={(e) => apply({ replace: e.target.value }, false)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (e.metaKey || e.ctrlKey) doReplaceAll(); else doReplace();
              }} />
          </div>
          <button className="ss-btn" title="替换当前这一处,并跳到下一个 (回车)" disabled={!stats.total} onClick={doReplace}>替换</button>
          <button className="ss-btn" title="全部替换 (⌘回车),⌘Z 一步撤销" disabled={!stats.total} onClick={doReplaceAll}>全部替换</button>
          {note && <span className="ss-note">{note}</span>}
        </div>
      )}
    </div>
  );
}

function createPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-search ss-panel";
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
  let root: Root | null = null;
  return {
    dom,
    top: true,
    mount() {
      root = createRoot(dom);
      root.render(<SearchBar view={view} subscribe={subscribe} />);
      // CodeMirror 打开面板后会去找带 main-field 的输入框聚焦;React 渲染是异步的,这里补一下
      window.setTimeout(() => {
        const input = dom.querySelector<HTMLInputElement>("[main-field]");
        if (!input) return;
        input.focus();
        input.select();
        if (wantReplace.has(view)) controllers.get(view)?.showReplace();
      }, 0);
    },
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery))))
        listeners.forEach((fn) => fn());
    },
    destroy() {
      const r = root;
      root = null;
      // 卸载放到下一拍:CodeMirror 正在更新视图时同步卸载 React 会报警
      window.setTimeout(() => r?.unmount(), 0);
    },
  };
}

const openReplace = (view: EditorView) => {
  if (view.state.readOnly) return openSearchPanel(view);
  if (searchPanelOpen(view.state)) {
    openSearchPanel(view); // 换成新选中的词
    controllers.get(view)?.showReplace();
  } else {
    wantReplace.add(view);
    openSearchPanel(view);
  }
  return true;
};

/** 放进编辑器的 extensions 里;basicSetup 里要关掉 searchKeymap,免得冒出 CodeMirror 自带的英文面板。 */
export function editorSearch(): Extension {
  return [
    search({ top: true, literal: true, createPanel }),
    Prec.high(keymap.of([
      { key: "Mod-f", run: openSearchPanel, scope: "editor search-panel", preventDefault: true },
      { key: "Mod-Alt-f", run: openReplace, scope: "editor search-panel", preventDefault: true },
      { key: "Mod-g", run: findNext, shift: findPrevious, scope: "editor search-panel", preventDefault: true },
      { key: "F3", run: findNext, shift: findPrevious, scope: "editor search-panel", preventDefault: true },
      { key: "Escape", run: (view) => { const open = searchPanelOpen(view.state); closeSearchPanel(view); if (open) view.focus(); return open; }, scope: "editor search-panel" },
    ])),
  ];
}
