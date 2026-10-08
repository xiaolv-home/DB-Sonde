import type { StateCreator } from "zustand";
import { type Language } from "../i18n";
import type { CompletionCatalog, ConnectionConfig, ConnectionMeta, EditDraft, QueryExecution, QueryResult, RoutineInfo, TableContext, TableInfo } from "../types";
import type { SyntaxTheme } from "./syntaxThemes";
export type NodeKind = "connection" | "database" | "schema" | "folder" | "table" | "view" | "procedure" | "function" | "column";
export interface TreeNode {
    key: string;
    kind: NodeKind;
    label: string;
    connId: string;
    database?: string;
    schema?: string;
    table?: string;
    detail?: string; // secondary text, e.g. column type
    isPk?: boolean;
    objectInfo?: TableInfo;
    routineInfo?: RoutineInfo;
    folderType?: "tables" | "views" | "procedures" | "functions";
    childKeys: string[];
    hasChildren: boolean;
    loaded: boolean;
    loading: boolean;
    expanded: boolean;
}
export interface QueryTab {
    kind: "query";
    id: string;
    connId: string;
    connName: string;
    database?: string;
    title: string;
    /** When set, this tab is backed by a saved query of that id. */
    savedId?: string;
    sql: string;
    selectedSql?: string;
    running: boolean;
    savingEdits?: boolean;
    /** Automatic result following stops once the user selects a result explicitly. */
    followExecution?: boolean;
    runProgress?: {
        startedAt: number;
        finishedAt?: number;
        currentIndex: number;
        total: number;
    };
    result?: QueryResult;
    error?: string;
    executions: QueryExecution[];
    activeExecutionIndex: number;
    tableContext?: TableContext;
    readOnly?: boolean;
    view: "grid" | "chart" | "structure";
    resultHeight?: number;
    chartX?: string;
    chartY?: string[];
}
export interface DatabaseTab {
    kind: "database";
    id: string;
    connId: string;
    connName: string;
    database: string;
    schema: string;
    title: string;
}
export interface TableTab {
    kind: "table";
    id: string;
    connId: string;
    connName: string;
    database: string;
    schema: string;
    table: string;
    objectKind: "table" | "view";
    objectInfo?: TableInfo;
    title: string;
}
export interface DashboardTab {
    kind: "dashboard";
    id: string;
    connId: string;
    connName: string;
    database?: string;
    documentId?: string;
    title: string;
}
export interface PythonTab {
    kind: "python";
    id: string;
    connId: string; // "" — a python tab has no DB connection; kept for a uniform shape
    connName: string;
    database?: string;
    title: string; // file name
    path: string; // absolute path in the workspace
}
export interface AnalysisTab {
    kind: "analysis";
    id: string;
    connId: string;
    connName: string;
    database?: string;
    title: string;
}
export interface RoutineTab {
    kind: "routine";
    id: string;
    connId: string;
    connName: string;
    database: string;
    schema: string;
    routineName: string;
    routineKind: "procedure" | "function";
    title: string;
    running?: boolean;
}
export type WorkspaceTab = RoutineTab | QueryTab | DatabaseTab | TableTab | DashboardTab | PythonTab | AnalysisTab;
export interface SavedQuery {
    id: string;
    name: string;
    sql: string;
    connId?: string;
    database?: string;
    updatedAt: number;
}
export interface OpenQueryOptions {
    connId: string;
    sql?: string;
    title?: string;
    database?: string;
    tableContext?: TableContext;
    readOnly?: boolean;
}
export interface Toast {
    kind: "info" | "error" | "success" | "warn";
    text: string;
}
export interface AppState {
    theme: "dark" | "light";
    /** 代码配色，与界面明暗互相独立 */
    syntaxTheme: SyntaxTheme;
    language: Language;
    connections: ConnectionConfig[];
    meta: Record<string, ConnectionMeta>;
    databases: Record<string, string[]>;
    autocommit: Record<string, boolean>;
    catalogs: Record<string, CompletionCatalog>;
    catalogLoading: Record<string, boolean>;
    connecting: Record<string, boolean>;
    nodes: Record<string, TreeNode>;
    rootKeys: string[];
    tabs: WorkspaceTab[];
    savedQueries: SavedQuery[];
    dirtyTabs: Record<string, boolean>;
    setTabDirty: (id: string, dirty: boolean) => void;
    hiddenKeys: string[];
    showHidden: boolean;
    nodeOrder: Record<string, string[]>;
    activeTabId?: string;
    selectedKey?: string;
    sidebarWidth: number;
    resultHeight: number;
    /** 底部结果区是否收起(只留标题栏)。 */
    resultCollapsed: boolean;
    /** Python 标签底部输出区的高度与收起状态。 */
    pyOutputHeight: number;
    pyOutputCollapsed: boolean;
    dialogOpen: boolean;
    dialogEditing?: ConnectionConfig;
    passwordPromptId?: string;
    toast?: Toast;
    init: () => Promise<void>;
    setTheme: (t: "dark" | "light") => void;
    setSyntaxTheme: (t: SyntaxTheme) => void;
    setLanguage: (language: Language) => void;
    showToast: (t: Toast) => void;
    openDialog: (editing?: ConnectionConfig) => void;
    closeDialog: () => void;
    refreshConnections: () => Promise<void>;
    deleteConnection: (id: string) => Promise<void>;
    connect: (id: string, password?: string | null) => Promise<void>;
    disconnect: (id: string) => Promise<void>;
    setAutocommit: (connId: string, enabled: boolean, database?: string) => Promise<void>;
    commitSession: (connId: string) => Promise<void>;
    rollbackSession: (connId: string) => Promise<void>;
    rememberSessionPassword: (id: string, password: string) => void;
    closePasswordPrompt: () => void;
    toggleNode: (key: string) => Promise<void>;
    selectNode: (key: string) => void;
    setTabDatabase: (tabId: string, database: string) => void;
    renameTab: (tabId: string, name: string) => void;
    saveTab: (tabId: string, name?: string) => void;
    openSavedQuery: (id: string) => void;
    deleteSavedQuery: (id: string) => void;
    setNodeHidden: (key: string, hidden: boolean) => void;
    toggleShowHidden: () => void;
    reorderTabs: (fromId: string, toId: string) => void;
    reorderConnections: (fromId: string, toId: string) => void;
    reorderChild: (parentKey: string, fromKey: string, toKey: string) => void;
    loadChildren: (key: string) => Promise<void>;
    refreshNode: (key: string) => Promise<void>;
    afterObjectDrop: (node: TreeNode) => Promise<void>;
    loadCatalog: (connId: string, database?: string, force?: boolean) => Promise<void>;
    openQueryTab: (options: OpenQueryOptions) => string;
    openPythonTab: (file: {
        name: string;
        path: string;
    }) => string;
    openDashboardTab: (documentId?: string) => string;
    openAnalysisTab: () => string;
    updateDashboardTab: (tabId: string, patch: Partial<Pick<DashboardTab, "documentId" | "title">>) => void;
    openDatabaseTab: (node: TreeNode) => Promise<void>;
    openTableInspector: (node: TreeNode) => void;
    openRoutineTab: (node: TreeNode) => void;
    openTableTab: (node: TreeNode) => Promise<void>;
    setActiveTab: (id: string) => void;
    closeTab: (id: string, discard?: boolean) => void;
    updateSql: (tabId: string, sql: string) => void;
    updateSelection: (tabId: string, sql: string) => void;
    runTab: (tabId: string) => Promise<void>;
    /** 停止正在跑的查询:能取消的库让数据库取消,其余停止等待;剩下的语句不再执行。 */
    stopTab: (tabId: string) => Promise<void>;
    selectExecution: (tabId: string, index: number) => void;
    saveResultEdits: (tabId: string, edits: EditDraft[]) => Promise<void>;
    setTabView: (tabId: string, view: "grid" | "chart" | "structure") => void;
    setChart: (tabId: string, patch: {
        chartX?: string;
        chartY?: string[];
    }) => void;
    setSidebarWidth: (w: number) => void;
    setResultHeight: (h: number, tabId?: string) => void;
    setResultCollapsed: (collapsed: boolean) => void;
    setPyOutputHeight: (h: number) => void;
    setPyOutputCollapsed: (collapsed: boolean) => void;
    createDemo: () => Promise<void>;
}

/** Each slice declares the state and actions it owns while sharing the workspace contract. */
export type AppSlice<Keys extends keyof AppState> = StateCreator<AppState, [], [], Pick<AppState, Keys>>;
