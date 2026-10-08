import { nanoid } from "nanoid";
import { translate } from "../i18n";
import { api } from "../lib/api";
import { selectPreview } from "../lib/sql";
import { isUnsavedTab } from "../lib/workspaceSession";
import type { TableContext } from "../types";
import type { AnalysisTab, AppSlice, DashboardTab, DatabaseTab, PythonTab, QueryTab, RoutineTab, TableTab } from "./appTypes";
import { initialSavedQueries, initialWorkspace, persistSavedQueries } from "./workspacePersistence";
type WorkspaceSlice = AppSlice<
  | "tabs"
  | "savedQueries"
  | "dirtyTabs"
  | "setTabDirty"
  | "activeTabId"
  | "setTabDatabase"
  | "renameTab"
  | "saveTab"
  | "openSavedQuery"
  | "deleteSavedQuery"
  | "reorderTabs"
  | "openPythonTab"
  | "openQueryTab"
  | "openDashboardTab"
  | "openAnalysisTab"
  | "updateDashboardTab"
  | "openDatabaseTab"
  | "openRoutineTab"
  | "openTableInspector"
  | "openTableTab"
  | "setActiveTab"
  | "closeTab"
  | "updateSql"
  | "updateSelection"
  | "setTabView"
  | "setChart"
>;

export const createWorkspaceSlice: WorkspaceSlice = (set, get) => ({
    tabs: initialWorkspace.tabs,
    savedQueries: initialSavedQueries,
    dirtyTabs: {},
    setTabDirty(id, dirty) {
        if (!!get().dirtyTabs[id] === dirty)
            return;
        const dirtyTabs = { ...get().dirtyTabs };
        if (dirty)
            dirtyTabs[id] = true;
        else
            delete dirtyTabs[id];
        set({ dirtyTabs });
    },
    activeTabId: initialWorkspace.activeTabId,
    setTabDatabase(tabId, database) {
        set((s) => ({
            tabs: s.tabs.map((t) => (t.id === tabId && t.kind === "query" ? { ...t, database } : t)),
        }));
        const tab = get().tabs.find((t) => t.id === tabId);
        if (tab && "connId" in tab)
            void get().loadCatalog(tab.connId, database);
    },
    renameTab(tabId, name) {
        const finalName = name.trim();
        if (!finalName)
            return;
        const tab = get().tabs.find((t) => t.id === tabId);
        if (!tab) return;
        const list = tab.kind === "query" && tab.savedId
            ? get().savedQueries.map(q => q.id === tab.savedId ? { ...q, name: finalName } : q)
            : get().savedQueries;
        try {
            if (list !== get().savedQueries) persistSavedQueries(list);
        } catch (error) {
            get().showToast({ kind: "error", text: `重命名失败：${String(error)}` });
            return;
        }
        set(s => ({ savedQueries: list, tabs: s.tabs.map(t => t.id === tabId ? { ...t, title: finalName } : t) }));
    },
    saveTab(tabId, name) {
        const tab = get().tabs.find((t) => t.id === tabId);
        if (!tab || tab.kind !== "query")
            return;
        const finalName = (name ?? tab.title).trim() || translate(get().language, "query.title");
        const now = Date.now();
        let savedId = tab.savedId;
        let list = get().savedQueries;
        if (savedId && list.some((q) => q.id === savedId)) {
            list = list.map((q) => q.id === savedId
                ? { ...q, name: finalName, sql: tab.sql, connId: tab.connId, database: tab.database, updatedAt: now }
                : q);
        }
        else {
            savedId = nanoid(8);
            list = [
                ...list,
                { id: savedId, name: finalName, sql: tab.sql, connId: tab.connId, database: tab.database, updatedAt: now },
            ];
        }
        try {
            persistSavedQueries(list);
        }
        catch (error) {
            get().showToast({ kind: "error", text: `脚本保存失败：${String(error)}` });
            return;
        }
        set((s) => ({
            savedQueries: list,
            tabs: s.tabs.map((t) => (t.id === tabId && t.kind === "query" ? { ...t, savedId, title: finalName } : t)),
        }));
        get().showToast({ kind: "success", text: `已保存「${finalName}」` });
    },
    openSavedQuery(id) {
        const q = get().savedQueries.find((x) => x.id === id);
        if (!q)
            return;
        const existing = get().tabs.find((t) => t.kind === "query" && t.savedId === id);
        if (existing) {
            set({ activeTabId: existing.id });
            return;
        }
        const connId = q.connId || Object.keys(get().meta)[0] || get().connections[0]?.id || "";
        const tabId = get().openQueryTab({ connId, database: q.database, sql: q.sql, title: q.name });
        set((s) => ({
            tabs: s.tabs.map((t) => (t.id === tabId && t.kind === "query" ? { ...t, savedId: id } : t)),
        }));
    },
    deleteSavedQuery(id) {
        const list = get().savedQueries.filter((q) => q.id !== id);
        try {
            persistSavedQueries(list);
        } catch (error) {
            get().showToast({ kind: "error", text: `删除脚本失败：${String(error)}` });
            return;
        }
        set((s) => ({
            savedQueries: list,
            tabs: s.tabs.map((t) => (t.kind === "query" && t.savedId === id ? { ...t, savedId: undefined } : t)),
        }));
    },
    reorderTabs(fromId, toId) {
        if (fromId === toId)
            return;
        const tabs = [...get().tabs];
        const from = tabs.findIndex((t) => t.id === fromId);
        const to = tabs.findIndex((t) => t.id === toId);
        if (from < 0 || to < 0)
            return;
        const [moved] = tabs.splice(from, 1);
        tabs.splice(to, 0, moved);
        set({ tabs });
    },
    openPythonTab(file) {
        const existing = get().tabs.find((t) => t.kind === "python" && t.path === file.path);
        if (existing) {
            set({ activeTabId: existing.id });
            return existing.id;
        }
        const tab: PythonTab = {
            kind: "python",
            id: nanoid(8),
            connId: "",
            connName: "",
            title: file.name.replace(/\.py$/i, ""),
            path: file.path,
        };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
        return tab.id;
    },
    openQueryTab(options) {
        const { connId, sql = "", title, database, tableContext, readOnly } = options;
        const conn = get().connections.find((c) => c.id === connId);
        const tab: QueryTab = {
            kind: "query",
            id: nanoid(8),
            connId,
            connName: conn?.name ?? connId,
            database,
            title: title ?? translate(get().language, "query.title"),
            sql,
            running: false,
            executions: [],
            activeExecutionIndex: 0,
            tableContext,
            readOnly,
            view: "grid",
        };
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
        void get().loadCatalog(connId, database);
        return tab.id;
    },
    openDashboardTab(documentId) {
        /* 指名了 documentId 就复用"正在显示它"的那个 tab;没指名表示要一张新看板,
           这时必须新开 —— 复用随便一个已开的看板 tab,等于把人又丢回上一张板子上,
           跟「打开看板设计却总是 AI 那张」是同一个毛病。 */
        const existing = documentId
            ? get().tabs.find((tab) => tab.kind === "dashboard" && tab.documentId === documentId)
            : undefined;
        if (existing) {
            set({ activeTabId: existing.id });
            return existing.id;
        }
        const active = get().tabs.find((tab) => tab.id === get().activeTabId);
        const connId = active?.connId || Object.keys(get().meta)[0] || get().connections[0]?.id || "";
        const connection = get().connections.find((item) => item.id === connId);
        const tab: DashboardTab = {
            kind: "dashboard",
            id: nanoid(8),
            connId,
            connName: connection?.name ?? "",
            database: active?.database ?? get().meta[connId]?.currentDatabase,
            documentId,
            title: translate(get().language, "dashboard.title"),
        };
        set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
        return tab.id;
    },
    openAnalysisTab() {
        const existing = get().tabs.find((tab) => tab.kind === "analysis");
        if (existing) {
            set({ activeTabId: existing.id });
            return existing.id;
        }
        const active = get().tabs.find((tab) => tab.id === get().activeTabId);
        /* 这里只给一个兜底连接,**不负责挑对** —— store 不该依赖 features(架构守卫拦着,
           这条边界是对的)。真正用哪个连接由 analysisRuntime 按指标目录定:
           指标编译出来的 SQL 认死它自己的库,连接是目录的属性,
           不是"点「分析」时恰好在看哪个 tab"。 */
        const connId = active?.connId || Object.keys(get().meta)[0] || get().connections[0]?.id || "";
        const tab: AnalysisTab = {
            kind: "analysis",
            id: nanoid(8),
            connId,
            connName: get().connections.find((c) => c.id === connId)?.name ?? "",
            database: active?.database ?? get().meta[connId]?.currentDatabase,
            title: "分析",
        };
        set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
        return tab.id;
    },
    updateDashboardTab(tabId, patch) {
        set((state) => ({
            tabs: state.tabs.map((tab) => tab.id === tabId && tab.kind === "dashboard" ? { ...tab, ...patch } : tab),
        }));
    },
    async openDatabaseTab(node) {
        const database = node.database ?? get().meta[node.connId]?.currentDatabase ?? "main";
        let schema = node.schema ?? "";
        if (!schema && get().meta[node.connId]?.hasSchemas) {
            try {
                const schemas = await api.listSchemas(node.connId, database);
                schema = schemas.includes("public") ? "public" : (schemas[0] ?? "");
            }
            catch (error) {
                get().showToast({ kind: "error", text: String(error) });
                return;
            }
        }
        if (get().meta[node.connId]?.kind === "sqlite")
            schema = "main";
        const existing = get().tabs.find((tab) => tab.kind === "database" &&
            tab.connId === node.connId &&
            tab.database === database &&
            tab.schema === schema);
        if (existing) {
            set({ activeTabId: existing.id });
            return;
        }
        const conn = get().connections.find((item) => item.id === node.connId);
        const tab: DatabaseTab = {
            kind: "database",
            id: nanoid(8),
            connId: node.connId,
            connName: conn?.name ?? node.connId,
            database,
            schema,
            title: schema && schema !== "main" ? `${database}.${schema}` : database,
        };
        set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
    },
    openRoutineTab(node) {
        const database = node.database ?? get().meta[node.connId]?.currentDatabase ?? "";
        const schema = node.schema ?? "";
        const routineKind = node.kind === "function" ? "function" : "procedure";
        const existing = get().tabs.find(t => t.kind === "routine" && t.connId === node.connId && t.database === database && t.schema === schema && t.routineName === node.label && t.routineKind === routineKind);
        if (existing) {
            set({ activeTabId: existing.id });
            return;
        }
        const tab: RoutineTab = { kind: "routine", id: nanoid(8), connId: node.connId, connName: get().connections.find(c => c.id === node.connId)?.name ?? node.connId, database, schema, routineName: node.label, routineKind, title: node.label };
        set(s => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    },
    openTableInspector(node) {
        const database = node.database ?? get().meta[node.connId]?.currentDatabase ?? "main";
        const schema = node.schema ?? (get().meta[node.connId]?.kind === "sqlite" ? "main" : "");
        const table = node.table ?? node.label;
        const existing = get().tabs.find((tab) => tab.kind === "table" &&
            tab.connId === node.connId &&
            tab.database === database &&
            tab.schema === schema &&
            tab.table === table);
        if (existing) {
            set({ activeTabId: existing.id });
            return;
        }
        const conn = get().connections.find((item) => item.id === node.connId);
        const tab: TableTab = {
            kind: "table",
            id: nanoid(8),
            connId: node.connId,
            connName: conn?.name ?? node.connId,
            database,
            schema,
            table,
            objectKind: node.kind === "view" ? "view" : "table",
            objectInfo: node.objectInfo,
            title: table,
        };
        set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
    },
    async openTableTab(node) {
        const kind = get().meta[node.connId]?.kind;
        const database = node.database ?? get().meta[node.connId]?.currentDatabase ?? "";
        const schema = node.schema ?? "";
        const table = node.table ?? node.label;
        const sql = selectPreview(kind, database, schema, table);
        try {
            const columns = await api.listColumns(node.connId, database, schema, table);
            const hasPrimaryKey = columns.some((column) => column.isPrimaryKey);
            const isTable = node.kind === "table";
            const tableContext: TableContext = {
                database,
                schema,
                table,
                columns,
                previewSql: sql,
                editable: isTable && hasPrimaryKey,
                editDisabledReason: !isTable
                    ? translate(get().language, "edit.viewReadOnly")
                    : hasPrimaryKey
                        ? undefined
                        : translate(get().language, "edit.primaryKeyRequired"),
            };
            const id = get().openQueryTab({
                connId: node.connId,
                database,
                sql,
                title: table,
                tableContext,
            });
            await get().runTab(id);
        }
        catch (error) {
            get().showToast({ kind: "error", text: String(error) });
        }
    },
    setActiveTab(id) {
        set({ activeTabId: id });
    },
    closeTab(id, discard = false) {
        const runningRoutine = get().tabs.find(t => t.id === id && t.kind === "routine" && t.running);
        if (runningRoutine) {
            get().showToast({ kind: "error", text: "存储过程正在执行，请等待完成后关闭此页" });
            return;
        }
        const tab = get().tabs.find(t => t.id === id);
        if (tab?.kind === "query" && tab.savingEdits) {
            get().showToast({ kind: "warn", text: "表格修改正在保存，请等待完成后关闭" });
            return;
        }
        if (!discard && tab && isUnsavedTab(tab, get()) && !window.confirm(`「${tab.title}」有未保存内容，是否丢弃并关闭？`))
            return;
        // 关掉正在跑的查询标签:顺手让数据库取消那条语句,不然它关了还在服务器上跑、占着连接
        if (tab?.kind === "query" && tab.running) void get().stopTab(id);
        set((s) => {
            const idx = s.tabs.findIndex((t) => t.id === id);
            const tabs = s.tabs.filter((t) => t.id !== id);
            let activeTabId = s.activeTabId;
            if (activeTabId === id) {
                activeTabId = tabs[Math.max(0, idx - 1)]?.id;
            }
            return { tabs, activeTabId };
        });
    },
    updateSql(tabId, sql) {
        const tab = get().tabs.find((t) => t.id === tabId);
        if (!tab || tab.kind !== "query" || tab.sql === sql) return;
        set((s) => ({
            tabs: s.tabs.map((t) => (t.id === tabId && t.kind === "query" ? { ...t, sql } : t)),
        }));
    },
    /* 值没变就什么都不做。
       编辑器每挪一下光标都会调它,而**没有选中文字时传的都是空串** ——
       原来照样重建整个 tabs 数组,于是每一次光标移动都会让订阅了 tabs 的组件
       (标签栏、工作区)全部重渲染;工作区重渲染又会造出新的内联回调,
       进而让 SqlEditor 的 extensions 重新计算、整个 CodeMirror 被重新配置一遍。
       在长文件里这条链每次按方向键都要跑一遍。 */
    updateSelection(tabId, selectedSql) {
        const tab = get().tabs.find((t) => t.id === tabId);
        if (!tab || tab.kind !== "query" || tab.selectedSql === selectedSql) return;
        set((s) => ({
            tabs: s.tabs.map((t) => (t.id === tabId && t.kind === "query" ? { ...t, selectedSql } : t)),
        }));
    },
    setTabView(tabId, view) {
        const tab = get().tabs.find(t => t.id === tabId);
        if (tab?.kind === "query" && tab.view !== view && (get().dirtyTabs[tabId] || tab.savingEdits)) {
            get().showToast({ kind: "warn", text: "请先保存或撤销表格修改，再切换视图" });
            return;
        }
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId && t.kind === "query" ? { ...t, view } : t)) }));
    },
    setChart(tabId, patch) {
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === tabId && t.kind === "query" ? { ...t, ...patch } : t)) }));
    }
});
