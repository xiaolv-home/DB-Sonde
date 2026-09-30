import { isRecord, optionalString } from "./storageValidation";
import { RESULT_MIN_HEIGHT } from "./paneSizes";
import type { SavedQuery, WorkspaceTab } from "../store/appTypes";

export const WORKSPACE_KEY = "sonde.workspace.v1";
export interface SessionState {
  tabs: WorkspaceTab[];
  activeTabId?: string;
  savedQueries: SavedQuery[];
  dirtyTabs: Record<string, boolean>;
}
export function hasRunningTask(tab: WorkspaceTab): boolean {
  return tab.kind === "query" ? !!(tab.running || tab.savingEdits) : tab.kind === "routine" && !!tab.running;
}
export function isUnsavedTab(tab: WorkspaceTab, state: Pick<SessionState, "savedQueries" | "dirtyTabs">): boolean {
  if (state.dirtyTabs[tab.id]) return true;
  if (tab.kind !== "query") return false;
  const saved = state.savedQueries.find(q => q.id === tab.savedId);
  return saved ? saved.sql !== tab.sql : !!tab.sql.trim();
}

/** Keep references and navigation only: never results, passwords or pending edits. */
export function workspaceSnapshot(state: SessionState) {
  const tabs = state.tabs.filter(tab => !isUnsavedTab(tab, state)).map(tab => {
    const base = { id: tab.id, kind: tab.kind, title: tab.title, connId: tab.connId, connName: tab.connName, database: tab.database };
    switch (tab.kind) {
      case "query": return { ...base, savedId: tab.savedId, readOnly: tab.readOnly, view: tab.view, resultHeight: tab.resultHeight };
      case "routine": return { ...base, schema: tab.schema, routineName: tab.routineName, routineKind: tab.routineKind };
      case "table": return { ...base, schema: tab.schema, table: tab.table, objectKind: tab.objectKind };
      case "database": return { ...base, schema: tab.schema };
      case "dashboard": return { ...base, documentId: tab.documentId };
      case "python": return { ...base, path: tab.path };
      case "analysis": return base;
    }
  });
  const activeTabId = tabs.some(t => t.id === state.activeTabId) ? state.activeTabId : tabs[0]?.id;
  return { version: 1, tabs, activeTabId };
}

/** Reject unsupported versions and malformed identities before touching saved state. */
export function isWorkspaceSnapshot(value: unknown): boolean {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.tabs) || !optionalString(value.activeTabId)) return false;
  const ids = new Set<string>();
  return value.tabs.every(item => {
    if (!isRecord(item) || !["id", "kind", "title", "connId", "connName"].every(key => typeof item[key] === "string") ||
        !item.id || ids.has(item.id as string) || !optionalString(item.database)) return false;
    ids.add(item.id as string);
    switch (item.kind) {
      case "query": return (item.readOnly === undefined || typeof item.readOnly === "boolean") && optionalString(item.savedId) && (item.view === undefined || item.view === "grid" || item.view === "chart" || item.view === "structure") &&
        (item.resultHeight === undefined || typeof item.resultHeight === "number" && Number.isFinite(item.resultHeight));
      case "database": return typeof item.database === "string" && typeof item.schema === "string";
      case "table": return typeof item.database === "string" && typeof item.schema === "string" && typeof item.table === "string" &&
        (item.objectKind === undefined || item.objectKind === "table" || item.objectKind === "view");
      case "routine": return typeof item.database === "string" && typeof item.schema === "string" && typeof item.routineName === "string" &&
        (item.routineKind === "procedure" || item.routineKind === "function");
      case "python": return typeof item.path === "string";
      case "dashboard": return optionalString(item.documentId);
      case "analysis": return true;
      default: return false;
    }
  });
}

export function restoreWorkspace(raw: string | null, savedQueries: SavedQuery[]): { tabs: WorkspaceTab[]; activeTabId?: string } {
  try {
    const data = JSON.parse(raw ?? "null");
    if (data?.version !== 1 || !Array.isArray(data.tabs)) return { tabs: [] };
    const tabs: WorkspaceTab[] = [];
    for (const item of data.tabs) {
      if (!item || !["id", "kind", "title", "connId", "connName"].every(k => typeof item[k] === "string") || tabs.some(t => t.id === item.id)) continue;
      const base = { id: item.id, kind: item.kind, title: item.title, connId: item.connId, connName: item.connName,
        database: typeof item.database === "string" ? item.database : undefined };
      switch (item.kind) {
        case "query": {
          const saved = savedQueries.find(q => q.id === item.savedId);
          if (item.savedId && !saved) continue;
          tabs.push({ ...base, kind: "query", savedId: saved?.id, readOnly: item.readOnly === true, sql: saved?.sql ?? "", running: false,
            executions: [], activeExecutionIndex: 0, resultHeight: Number.isFinite(item.resultHeight) ? Math.max(RESULT_MIN_HEIGHT, item.resultHeight) : undefined, view: item.view === "chart" ? "chart" : "grid" });
          break;
        }
        case "database":
          if (base.database !== undefined && typeof item.schema === "string") tabs.push({ ...base, kind: "database", database: base.database, schema: item.schema });
          break;
        case "routine":
          if (base.database !== undefined && typeof item.schema === "string" && typeof item.routineName === "string" && ["procedure", "function"].includes(item.routineKind)) tabs.push({ ...base, kind: "routine", database: base.database, schema: item.schema, routineName: item.routineName, routineKind: item.routineKind, running: false });
          break;
        case "table":
          if (base.database !== undefined && typeof item.schema === "string" && typeof item.table === "string") tabs.push({ ...base, kind: "table", database: base.database, schema: item.schema, table: item.table, objectKind: item.objectKind === "view" ? "view" : "table" });
          break;
        case "python":
          if (typeof item.path === "string") tabs.push({ ...base, kind: "python", path: item.path });
          break;
        case "dashboard": tabs.push({ ...base, kind: "dashboard", documentId: typeof item.documentId === "string" ? item.documentId : undefined }); break;
        case "analysis": tabs.push({ ...base, kind: "analysis" }); break;
      }
    }
    return { tabs, activeTabId: tabs.some(t => t.id === data.activeTabId) ? data.activeTabId : tabs[0]?.id };
  } catch { return { tabs: [] }; }
}
