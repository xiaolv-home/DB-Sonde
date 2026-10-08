import { executeQueryScript } from "../lib/queryExecution";
import { translate } from "../i18n";
import { api } from "../lib/api";
import { buildCompletionCatalog } from "../lib/catalog";
import { splitSqlStatements } from "../lib/sql";
import { matchesPreviewExecution, prepareCellUpdate } from "../lib/tableEditing";
import type { EditDraft, QueryResult } from "../types";
import type { AppSlice } from "./appTypes";
import { catalogKey } from "./stateKeys";

/** 编辑器单条查询最多拿回来的行数。
 *  以前不设上限:实测 30 万行×21 列就要 1.5GB 内存、往界面推 71MB;
 *  89 万行×49 列的大表会推约 500MB,界面直接卡死或闪退。超出时后端只读到这里就停,
 *  结果标记为已截断,界面提示「只显示前 N 行」。 */
export const EDITOR_MAX_ROWS = 100_000;
type QuerySlice = AppSlice<
  | "catalogs"
  | "catalogLoading"
  | "loadCatalog"
  | "runTab"
  | "selectExecution"
  | "saveResultEdits"
  | "createDemo"
>;

export const createQuerySlice: QuerySlice = (set, get) => {
  const runs = new Map<string, object>();
  return ({
    catalogs: {},
    catalogLoading: {},
    async loadCatalog(connId, database, force = false) {
      const key = catalogKey(connId, database);
      if ((!force && get().catalogs[key]) || get().catalogLoading[key])
        return;
      const meta = get().meta[connId];
      if (!meta)
        return;
      set((s) => ({ catalogLoading: { ...s.catalogLoading, [key]: true } }));
      try {
        const catalog = await buildCompletionCatalog(connId, meta, database);
        set((s) => ({ catalogs: { ...s.catalogs, [key]: catalog } }));
      }
      catch (error) {
        console.warn("Could not build SQL completion catalog:", error);
      }
      finally {
        set((s) => ({ catalogLoading: { ...s.catalogLoading, [key]: false } }));
      }
    },
    async runTab(tabId) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab || tab.kind !== "query" || tab.running || tab.savingEdits)
        return;
      if (get().dirtyTabs[tabId]) {
        get().showToast({ kind: "warn", text: "请先保存或撤销表格修改，再执行 SQL" });
        return;
      }
      if (!get().meta[tab.connId]) {
        get().showToast({ kind: "error", text: translate(get().language, "query.notConnected") });
        return;
      }
      const connection = get().meta[tab.connId];
      const source = tab.selectedSql?.trim() || tab.sql.trim();
      // 按这个连接的方言拆 —— 反斜杠是不是转义各家不一样,拆错了执行列表就跟实际跑的对不上
      const statements = splitSqlStatements(source, connection?.kind);
      if (statements.length === 0)
        return;
      set((s) => ({
        tabs: s.tabs.map((t) => t.id === tabId && t.kind === "query"
          ? {
            ...t,
            running: true,
            followExecution: true,
            runProgress: { startedAt: Date.now(), currentIndex: 0, total: statements.length },
            result: undefined,
            error: undefined,
            executions: statements.map((sql) => ({ sql })),
            activeExecutionIndex: 0,
          }
          : t),
      }));
      const owner = {};
      runs.set(tabId, owner);
      const isCurrent = () => runs.get(tabId) === owner && get().tabs.some(t => t.id === tabId && t.kind === "query");
      try {
        await executeQueryScript(statements, {
          execute: sql => tab.readOnly
            ? api.runReadOnlyQuery(tab.connId, tab.database, sql, 10_000)
            : api.runQuery(tab.connId, tab.database, sql, EDITOR_MAX_ROWS),
          isCurrent,
          canContinue: () => get().meta[tab.connId] === connection,
          started: index => set(s => ({
            tabs: s.tabs.map(t => t.id === tabId && t.kind === "query" && t.runProgress
              ? { ...t, runProgress: { ...t.runProgress, currentIndex: index } } : t)
          })),
          settled: (index, executions) => set(s => ({
            tabs: s.tabs.map(t => {
              if (t.id !== tabId || t.kind !== "query") return t;
              const selected = t.followExecution === false ? t.activeExecutionIndex : index;
              return { ...t, executions, activeExecutionIndex: selected, result: executions[selected]?.result, error: executions[selected]?.error };
            })
          })),
        });
      } finally {
        if (isCurrent()) set(s => ({
          tabs: s.tabs.map(t => t.id === tabId && t.kind === "query"
            ? { ...t, running: false, runProgress: t.runProgress ? { ...t.runProgress, finishedAt: Date.now() } : undefined }
            : t)
        }));
        if (runs.get(tabId) === owner) runs.delete(tabId);
      }
    },
    selectExecution(tabId, index) {
      const current = get().tabs.find(tab => tab.id === tabId);
      if (current?.kind === "query" && current.activeExecutionIndex !== index && (get().dirtyTabs[tabId] || current.savingEdits)) {
        get().showToast({ kind: "warn", text: "请先保存或撤销表格修改，再切换结果" });
        return;
      }
      set((s) => ({
        tabs: s.tabs.map((tab) => {
          if (tab.id !== tabId || tab.kind !== "query")
            return tab;
          const execution = tab.executions[index];
          if (!execution)
            return tab;
          return {
            ...tab,
            activeExecutionIndex: index,
            followExecution: false,
            result: execution.result,
            error: execution.error,
          };
        }),
      }));
    },
    async saveResultEdits(tabId, edits) {
      const tab = get().tabs.find((item) => item.id === tabId);
      const result = tab?.kind === "query" ? tab.result : undefined;
      const context = tab?.kind === "query" ? tab.tableContext : undefined;
      if (edits.length === 0) return;
      if (!tab || tab.kind !== "query" || !result || !context) throw new Error("原查询结果已不可用，未保存修改");
      if (tab.running || tab.savingEdits) throw new Error("当前结果正在执行或保存，请等待完成");
      const executionIndex = tab.activeExecutionIndex;
      const originalExecution = tab.executions[executionIndex];
      if (!matchesPreviewExecution(originalExecution?.sql, context.previewSql, get().meta[tab.connId]?.kind))
        throw new Error("当前结果不属于可编辑的表预览");
      set(s => ({ tabs: s.tabs.map(t => t.id === tabId && t.kind === "query" ? { ...t, savingEdits: true } : t) }));
      try {
        const requests = edits.map((edit) => prepareCellUpdate(tab.connId, tab.sql, context, result, edit.row, edit.column, edit.newValue)
          .request);
        await api.applyCellEdits(requests);
        const byRow = new Map<number, EditDraft[]>();
        for (const edit of edits) {
          (byRow.get(edit.row) ?? byRow.set(edit.row, []).get(edit.row)!).push(edit);
        }
        const nextRows = result.rows.map((row, r) => {
          const rowEdits = byRow.get(r);
          if (!rowEdits)
            return row;
          const copy = [...row];
          for (const edit of rowEdits)
            copy[edit.column] = edit.newValue;
          return copy;
        });
        const nextResult: QueryResult = { ...result, rows: nextRows };
        set(s => ({
          tabs: s.tabs.map(t => {
            if (t.id !== tabId || t.kind !== "query" || t.executions[executionIndex] !== originalExecution) return t;
            return {
              ...t,
              result: t.result === result ? nextResult : t.result,
              executions: t.executions.map((execution, index) => index === executionIndex ? { ...execution, result: nextResult } : execution),
            };
          }),
        }));
        get().showToast({
          kind: "success",
          text: translate(get().language, "edit.savedChanges", { count: edits.length }),
        });
      }
      catch (error) {
        get().showToast({ kind: "error", text: String(error) });
        throw error;
      }
      finally {
        set(s => ({ tabs: s.tabs.map(t => t.id === tabId && t.kind === "query" && t.savingEdits ? { ...t, savingEdits: false } : t) }));
      }
    },
    async createDemo() {
      try {
        const cfg = await api.createDemo();
        await get().refreshConnections();
        await get().connect(cfg.id);
        const tabId = get().openQueryTab({
          connId: cfg.id,
          database: "main",
          sql: "SELECT sale_date,\n       amount AS total_amount,\n       quantity AS total_quantity\nFROM demo_sales\nORDER BY sale_date;",
          title: "demo_sales",
        });
        await get().runTab(tabId);
        get().showToast({ kind: "success", text: translate(get().language, "demo.created") });
      }
      catch (e) {
        get().showToast({ kind: "error", text: String(e) });
      }
    }
  });
};
