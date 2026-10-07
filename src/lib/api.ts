import { invoke } from "@tauri-apps/api/core";
import type {
  ColumnInfo,
  ConnectionConfig,
  ConnectionMeta,
  IndexInfo,
  QueryResult,
  RoutineInfo,
  TableInfo,
  UpdateCellRequest,
} from "../types";
import type { DashboardDocument } from "../features/dashboard/domain";
import type { Dataset } from "../features/datasets/domain";
import type { DatasetQueryFilter } from "../features/dashboard/query";
import { inTauri, mockApi } from "./mockBackend";

export interface MonitorBounds { x: number; y: number; width: number; height: number }

/** Typed wrappers around the Rust command layer.
 *  Outside Tauri (plain browser during UI dev) they fall back to a mock. */
export const api = {
  getRoutineDetails: (connId: string, database: string, schema: string, name: string, kind: string) => invoke<import("../types").RoutineDetails>("get_routine_details", { connId, database, schema, name, kind }),
  executeRoutine: (connId: string, database: string, schema: string, name: string, kind: string, values: (string | null)[]) => invoke<QueryResult>("execute_routine", { connId, database, schema, name, kind, values }),
  inspectEtlFiles: (request: {root:string;host?:string;username?:string;port?:number;password?:string}) => invoke<import("../features/etl/fileCatalog").FileInventory>("inspect_etl_files", { request }),
  // 监控中心:主窗口里的子浏览器视图(见 src-tauri/src/monitor.rs)
  monitorShow: (id: string, url: string, bounds: MonitorBounds) => invoke<void>("monitor_show", { id, url, bounds }),
  monitorBounds: (id: string, bounds: MonitorBounds) => invoke<void>("monitor_bounds", { id, bounds }),
  monitorHideAll: () => inTauri ? invoke<void>("monitor_hide_all") : Promise.resolve(),
  monitorClose: (id: string) => inTauri ? invoke<void>("monitor_close", { id }) : Promise.resolve(),
  monitorNav: (id: string, action: "back" | "forward" | "reload" | "home", home?: string) => invoke<void>("monitor_nav", { id, action, home }),
  monitorCurrentUrl: (id: string) => invoke<string | null>("monitor_current_url", { id }),
  loadSemanticCatalog: () => inTauri ? invoke<unknown>("load_semantic_catalog") : Promise.resolve(null),
  listConnections: () =>
    inTauri ? invoke<ConnectionConfig[]>("list_connections") : mockApi.listConnections(),

  saveConnection: (config: ConnectionConfig) =>
    inTauri
      ? invoke<ConnectionConfig>("save_connection", { config })
      : mockApi.saveConnection(config),

  deleteConnection: (id: string) =>
    inTauri ? invoke<void>("delete_connection", { id }) : mockApi.deleteConnection(id),

  testConnection: (config: ConnectionConfig, password: string | null) =>
    inTauri ? invoke<string>("test_connection", { config, password }) : mockApi.testConnection(),

  connect: (id: string, password: string | null) =>
    inTauri ? invoke<ConnectionMeta>("connect", { id, password }) : mockApi.connect(id),

  disconnect: (id: string) =>
    inTauri ? invoke<void>("disconnect", { id }) : mockApi.disconnect(),

  listDatabases: (connId: string) =>
    inTauri ? invoke<string[]>("list_databases", { connId }) : mockApi.listDatabases(),

  listSchemas: (connId: string, database: string) =>
    inTauri ? invoke<string[]>("list_schemas", { connId, database }) : mockApi.listSchemas(),

  listTables: (connId: string, database: string, schema: string) =>
    inTauri
      ? invoke<TableInfo[]>("list_tables", { connId, database, schema })
      : mockApi.listTables(),

  listColumns: (connId: string, database: string, schema: string, table: string) =>
    inTauri
      ? invoke<ColumnInfo[]>("list_columns", { connId, database, schema, table })
      : mockApi.listColumns(connId, database, schema, table),

  listRoutines: (connId: string, database: string, schema: string) =>
    inTauri
      ? invoke<RoutineInfo[]>("list_routines", { connId, database, schema })
      : mockApi.listRoutines(),

  listIndexes: (connId: string, database: string, schema: string, table: string) =>
    inTauri
      ? invoke<IndexInfo[]>("list_indexes", { connId, database, schema, table })
      : mockApi.listIndexes(table),

  getObjectDdl: (
    connId: string,
    database: string,
    schema: string,
    table: string,
    objectKind: string,
  ) =>
    inTauri
      ? invoke<string>("get_object_ddl", { connId, database, schema, table, objectKind })
      : mockApi.getObjectDdl(table, objectKind),

  runQuery: (connId: string, database: string | undefined, sql: string, maxRows?: number) =>
    inTauri
      ? invoke<QueryResult>("run_query", {
          connId,
          database: database || null,
          sql,
          maxRows: maxRows ?? null,
        })
      : mockApi.runQuery(connId, sql),

  previewDropObject: (request: { connId: string; objectKind: "table" | "database"; database: string; schema?: string; table?: string }) =>
    inTauri ? invoke<string>("preview_drop_object", request) : Promise.reject(new Error("删除对象仅支持桌面端真实连接")),
  dropObject: (request: { connId: string; objectKind: "table" | "database"; database: string; schema?: string; table?: string; confirmation: string }) =>
    inTauri ? invoke<void>("drop_object", request) : Promise.reject(new Error("删除对象仅支持桌面端真实连接")),

  listProcesses: (connId: string) =>
    inTauri ? invoke<QueryResult>("list_processes", { connId }) : Promise.resolve({ columns: [], rows: [], elapsedMs: 0, truncated: false } as QueryResult),

  killProcess: (connId: string, id: number) =>
    inTauri ? invoke<void>("kill_process", { connId, id }) : Promise.resolve(),

  runReadOnlyQuery: (
    connId: string,
    database: string | undefined,
    sql: string,
    maxRows?: number,
    filters: DatasetQueryFilter[] = [],
    /** 超时秒数。不传按后端默认 30 秒(看板交互);AI 分析这类后台活自己传大的。 */
    timeoutSecs?: number,
  ) =>
    inTauri
      ? invoke<QueryResult>("run_read_only_query", {
          connId,
          database: database || null,
          sql,
          maxRows: maxRows ?? null,
          filters,
          timeoutSecs: timeoutSecs ?? null,
        })
      : mockApi.runReadOnlyQuery(connId, sql, filters),

  /** 看板存盘的文件路径(仅桌面端)。界面上用来回答「保存的东西在哪」。 */
  dashboardStoragePath: (): Promise<string> =>
    inTauri ? invoke<string>("dashboard_storage_path") : Promise.resolve("浏览器本地存储(开发模式)"),

  listDashboards: () =>
    inTauri ? invoke<DashboardDocument[]>("list_dashboards") : mockApi.listDashboards(),

  saveDashboard: (document: DashboardDocument) =>
    inTauri
      ? invoke<DashboardDocument>("save_dashboard", { document })
      : mockApi.saveDashboard(document),

  publishDashboard: (document: DashboardDocument) =>
    inTauri
      ? invoke<DashboardDocument>("publish_dashboard", { document })
      : mockApi.publishDashboard(document),

  listDashboardVersions: (id: string) =>
    inTauri
      ? invoke<DashboardDocument[]>("list_dashboard_versions", { id })
      : mockApi.listDashboardVersions(id),

  deleteDashboard: (id: string) =>
    inTauri ? invoke<void>("delete_dashboard", { id }) : mockApi.deleteDashboard(id),

  listDatasets: () =>
    inTauri ? invoke<Dataset[]>("list_datasets") : mockApi.listDatasets(),
  saveDataset: (dataset: Dataset) =>
    inTauri ? invoke<Dataset>("save_dataset", { dataset }) : mockApi.saveDataset(dataset),
  deleteDataset: (id: string) =>
    inTauri ? invoke<void>("delete_dataset", { id }) : mockApi.deleteDataset(id),

  updateCell: (request: UpdateCellRequest) =>
    inTauri
      ? invoke<number>("update_cell", { request })
      : mockApi.updateCell(request),

  /** 一批写语句跑在同一笔事务里 —— 中途失败整笔回滚,不留半拉状态。 */
  runStatements: (connId: string, database: string | undefined, statements: string[]) =>
    inTauri
      ? invoke<number>("run_statements", { connId, database: database || null, statements })
      : mockApi.runStatements(connId, statements),

  applyCellEdits: (edits: UpdateCellRequest[]) =>
    inTauri
      ? invoke<number>("apply_cell_edits", { edits })
      : mockApi.applyCellEdits(edits),

  setAutocommit: (connId: string, enabled: boolean, database?: string) =>
    inTauri ? invoke<void>("set_autocommit", { connId, enabled, database: database ?? null }) : Promise.resolve(),

  commitSession: (connId: string) =>
    inTauri ? invoke<void>("commit_session", { connId }) : Promise.resolve(),

  rollbackSession: (connId: string) =>
    inTauri ? invoke<void>("rollback_session", { connId }) : Promise.resolve(),

  saveExport: (suggestedName: string, format: "csv" | "json", content: string) =>
    invoke<string>("save_export", { suggestedName, format, content }),

  createDemo: () =>
    inTauri ? invoke<ConnectionConfig>("create_demo") : mockApi.createDemo(),

  // ---- Python workbench ----
  pythonStatus: () =>
    inTauri ? invoke<PyStatus>("python_status") : Promise.resolve(NO_PY),
  pythonEnsure: () =>
    inTauri ? invoke<PyStatus>("python_ensure") : Promise.resolve(NO_PY),
  pythonInstall: () =>
    inTauri ? invoke<PyStatus>("python_install") : Promise.resolve(NO_PY),
  pythonRun: (runId: string, path: string) =>
    inTauri ? invoke<void>("python_run", { req: { runId, path } }) : Promise.reject(new Error("需在桌面版运行")),
  pythonStop: (runId: string) =>
    inTauri ? invoke<void>("python_stop", { runId }) : Promise.resolve(),
  pyWorkspaceDir: () =>
    inTauri ? invoke<string>("py_workspace_dir") : Promise.resolve(""),
  pyListFiles: () =>
    inTauri ? invoke<PyFile[]>("py_list_files") : Promise.resolve([] as PyFile[]),
  /** 按扩展名列工作区文件(如导出的看板 .html)。 */
  workspaceListFiles: (ext: string) =>
    inTauri ? invoke<PyFile[]>("workspace_list_files", { ext }) : Promise.resolve([] as PyFile[]),
  pyReadFile: (path: string) =>
    inTauri ? invoke<string>("py_read_file", { path }) : Promise.resolve(""),
  pyWriteFile: (path: string, content: string) =>
    inTauri ? invoke<void>("py_write_file", { path, content }) : Promise.resolve(),
  pyNewFile: (name?: string) =>
    inTauri ? invoke<PyFile>("py_new_file", { name: name ?? null }) : Promise.reject(new Error("需在桌面版运行")),
  pyDeleteFile: (path: string) =>
    inTauri ? invoke<void>("py_delete_file", { path }) : Promise.resolve(),
  pyRenameFile: (path: string, newName: string) =>
    inTauri ? invoke<PyFile>("py_rename_file", { path, newName }) : Promise.reject(new Error("需在桌面版运行")),
  pyPipInstall: (runId: string, packages: string[]) =>
    inTauri ? invoke<void>("py_pip_install", { runId, packages }) : Promise.reject(new Error("需在桌面版运行")),
  pyPlaywrightInstall: (runId: string) =>
    inTauri ? invoke<void>("py_playwright_install", { runId }) : Promise.reject(new Error("需在桌面版运行")),
  pyReadImage: (path: string) =>
    inTauri ? invoke<string>("py_read_image", { path }) : Promise.resolve(""),
  pyLint: (path: string) =>
    inTauri ? invoke<PyLintIssue[]>("py_lint", { path }) : Promise.resolve([] as PyLintIssue[]),
  pyComplete: (source: string, line: number, col: number) =>
    inTauri ? invoke<PyCompletion[]>("py_complete", { source, line, col }) : Promise.resolve([] as PyCompletion[]),
  pySqlLineage: (sql: string, dialect?: string) =>
    inTauri
      ? invoke<PyLineage>("py_sql_lineage", { sql, dialect: dialect ?? null })
      : Promise.resolve({ ok: false, target: null, sources: [], error: "需在桌面版运行" } as PyLineage),

  /** Native folder picker → read every *.json under it. Null if cancelled. */
  importFolder: async (title?: string): Promise<{ dir: string; files: ImportedFile[] } | null> => {
    if (!inTauri) throw new Error("需在桌面版运行");
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, title: title ?? "选择文件夹" });
    if (typeof dir !== "string") return null;
    const files = await invoke<ImportedFile[]>("read_json_dir", { dir });
    return { dir, files };
  },
};

export interface ImportedFile {
  name: string;
  content: string;
}

export interface PyLineage {
  flows?: {sources:string[];targets:string[]}[];
  ok: boolean;
  target: string | null;
  sources: string[];
  error: string | null;
}

export interface PyLintIssue {
  line: number;
  col: number;
  code: string;
  message: string;
}
export interface PyCompletion {
  label: string;
  kind: string;
  apply: string;
}

export interface PyStatus {
  installed: boolean;
  extracting: boolean;
  bundled: boolean;
  /** 没内置时,这个平台能不能一键下载(有预建运行时且校验和已配置)。 */
  downloadable: boolean;
  /** 下载进度 0-100;解压阶段看 extracting。 */
  progress: number;
  version: string;
  python: string | null;
  workspace: string;
  error: string | null;
}
export interface PyFile {
  name: string;
  path: string;
  size: number;
}
const NO_PY: PyStatus = {
  installed: false,
  extracting: false,
  bundled: false,
  downloadable: false,
  progress: 0,
  version: "",
  python: null,
  workspace: "",
  error: "需在桌面版(Tauri)中运行",
};
