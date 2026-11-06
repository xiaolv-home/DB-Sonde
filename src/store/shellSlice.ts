import { getStoredLanguage, translate } from "../i18n";
import { readStoredText, writeStoredText } from "../lib/jsonStorage";
import { acceptsPaneHeight, clampPaneHeight, PY_OUTPUT_MIN_HEIGHT, RESULT_MIN_HEIGHT } from "../lib/paneSizes";
import type { AppSlice } from "./appTypes";
import {
  DEFAULT_SYNTAX_THEME,
  applySyntaxTheme,
  isSyntaxTheme,
  type SyntaxTheme,
} from "./syntaxThemes";
import { applyTheme, isTheme, type Theme } from "./themes";
type ShellSlice = AppSlice<
  | "theme"
  | "syntaxTheme"
  | "language"
  | "sidebarWidth"
  | "resultHeight"
  | "resultCollapsed"
  | "pyOutputHeight"
  | "pyOutputCollapsed"
  | "init"
  | "setTheme"
  | "setSyntaxTheme"
  | "setLanguage"
  | "showToast"
  | "setSidebarWidth"
  | "setResultHeight"
  | "setResultCollapsed"
  | "setPyOutputHeight"
  | "setPyOutputCollapsed"
>;

/** 面板高度上限跟着窗口走,至少给上半部分留 160px,免得拖到编辑器没了。
 *  没有 window 的环境(测试、SSR)只保下限 —— store 不该假定有 DOM。 */

/** 拖分隔条时尺寸一帧变一次,localStorage 是同步写盘的,没必要每帧都写:停下来再存。 */
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
function storeWhenSettled(key: string, value: string, onError: (error: unknown) => void) {
  clearTimeout(pendingWrites.get(key));
  pendingWrites.set(key, setTimeout(() => {
    pendingWrites.delete(key);
    try { writeStoredText(key, value); } catch (error) { onError(error); }
  }, 150));
}

export const createShellSlice: ShellSlice = (set, get) => ({
    theme: readStoredText<Theme>("theme", "dark", isTheme),
    syntaxTheme: readStoredText<SyntaxTheme>("syntaxTheme", DEFAULT_SYNTAX_THEME, isSyntaxTheme),
    language: getStoredLanguage(),
    sidebarWidth: Number(readStoredText("sidebarWidth", "268", value => Number.isFinite(Number(value)) && Number(value) >= 200 && Number(value) <= 520)),
    resultHeight: clampPaneHeight(Number(readStoredText("resultHeight", "320", acceptsPaneHeight(RESULT_MIN_HEIGHT))), RESULT_MIN_HEIGHT),
    resultCollapsed: readStoredText<"0" | "1">("resultCollapsed", "0", v => v === "0" || v === "1") === "1",
    pyOutputHeight: clampPaneHeight(Number(readStoredText("pyOutputHeight", "260", acceptsPaneHeight(PY_OUTPUT_MIN_HEIGHT))), PY_OUTPUT_MIN_HEIGHT),
    pyOutputCollapsed: readStoredText<"0" | "1">("pyOutputCollapsed", "0", v => v === "0" || v === "1") === "1",
    async init() {
        applyTheme(get().theme);
        applySyntaxTheme(get().syntaxTheme);
        document.documentElement.lang = get().language;
        try {
            await get().refreshConnections();
            // Loading saved profiles must never initiate a database connection.
        }
        catch (e) {
            // No backend available (e.g. running the frontend outside Tauri).
            get().showToast({ kind: "error", text: `连接列表加载失败：${String(e)}` });
        }
    },
    setTheme(t) {
        try { writeStoredText("theme", t); }
        catch (error) { get().showToast({ kind: "error", text: String(error) }); return; }
        // 换主题时整屏淡过去,而不是每个控件各闪一下;图表要读新的 CSS 变量,所以 set 放在同一步里。
        const apply = () => { applyTheme(t); set({ theme: t }); };
        if (document.startViewTransition) document.startViewTransition(apply);
        else apply();
    },
    setSyntaxTheme(t) {
        try { writeStoredText("syntaxTheme", t); }
        catch (error) { get().showToast({ kind: "error", text: String(error) }); return; }
        applySyntaxTheme(t);
        set({ syntaxTheme: t });
    },
    setLanguage(language) {
        try { writeStoredText("language", language); }
        catch (error) { get().showToast({ kind: "error", text: String(error) }); return; }
        document.documentElement.lang = language;
        set((state) => {
            const nodes = Object.fromEntries(Object.entries(state.nodes).map(([key, node]) => {
                if (node.kind !== "folder" || !node.folderType)
                    return [key, node];
                return [
                    key,
                    {
                        ...node,
                        label: `${translate(language, `folder.${node.folderType}`)} (${node.childKeys.length})`,
                    },
                ];
            }));
            return { language, nodes };
        });
    },
    showToast(t) {
        set({ toast: t });
        setTimeout(() => {
            if (get().toast === t)
                set({ toast: undefined });
        }, 3200);
    },
    setSidebarWidth(w) {
        if (!Number.isFinite(w)) return;
        const width = Math.max(200, Math.min(520, w));
        storeWhenSettled("sidebarWidth", String(width), (error) => get().showToast({ kind: "error", text: String(error) }));
        set({ sidebarWidth: width });
    },
    setResultHeight(h, tabId = get().activeTabId) {
        if (!Number.isFinite(h)) return;
        const height = clampPaneHeight(h, RESULT_MIN_HEIGHT);
        storeWhenSettled("resultHeight", String(height), (error) => get().showToast({ kind: "error", text: String(error) }));
        // 拖动即展开:收起状态下还按着分隔条拖,显然是想把它拉回来。
        set(s => ({
            resultHeight: height,
            resultCollapsed: false,
            tabs: s.tabs.map(tab => tab.id === tabId && tab.kind === "query" ? { ...tab, resultHeight: height } : tab),
        }));
    },
    setResultCollapsed(collapsed) {
        try { writeStoredText("resultCollapsed", collapsed ? "1" : "0"); } catch { /* 存不上不影响本次会话 */ }
        set({ resultCollapsed: collapsed });
    },
    setPyOutputHeight(h) {
        if (!Number.isFinite(h)) return;
        const height = clampPaneHeight(h, PY_OUTPUT_MIN_HEIGHT);
        storeWhenSettled("pyOutputHeight", String(height), () => { /* 存不上不影响本次会话 */ });
        set({ pyOutputHeight: height, pyOutputCollapsed: false });
    },
    setPyOutputCollapsed(collapsed) {
        try { writeStoredText("pyOutputCollapsed", collapsed ? "1" : "0"); } catch { /* 同上 */ }
        set({ pyOutputCollapsed: collapsed });
    }
});
