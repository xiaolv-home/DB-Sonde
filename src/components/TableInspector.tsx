import { useGlassPill } from "../hooks/useGlassPill";
import { explainMetadataFailure } from "../lib/metadataFailure";
import { useUnsavedChanges } from "../hooks/useUnsavedChanges";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  Braces,
  Columns3,
  Database,
  Filter,
  Info,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  TableProperties,
  X,
} from "lucide-react";
import { useAi } from "../features/ai/aiStore";
import { api } from "../lib/api";
import {
  buildColumnUpdate,
  buildCountQuery,
  buildDataQuery,
  buildRowDelete,
  buildRowInsert,
  quoteIdent,
  sqlLiteral,
} from "../lib/sql";
import { buildCellRequest } from "../lib/tableEditing";
import { useConfirm } from "./useConfirm";
import { useApp, type TableTab } from "../store/appStore";
import type {
  Cell,
  ColumnInfo,
  ColumnMeta,
  DbKind,
  EditDraft,
  IndexInfo,
  QueryResult,
  TableInfo,
} from "../types";
import ResultGrid, { type FilterOp, type GridSort } from "./ResultGrid";
import { useI18n } from "../hooks/useI18n";

type Section = "properties" | "columns" | "indexes" | "ddl" | "data";

function formatBytes(value?: number | null): string {
  if (value == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

function containsQuery(query: string, values: unknown[]): boolean {
  return !query || values
    .filter((value) => value != null)
    .some((value) => String(value).toLocaleLowerCase().includes(query));
}

function PropertiesPanel({ tab, info }: { tab: TableTab; info?: TableInfo }) {
  const { t } = useI18n();
  const fields = [
    [t("inspector.objectName"), tab.table],
    [t("inspector.objectType"), t(tab.objectKind === "view" ? "inspector.view" : "inspector.table")],
    [t("inspector.database"), tab.database],
    [t("inspector.schema"), tab.schema || "—"],
    [t("inspector.engine"), info?.engine || "—"],
    [t("inspector.collation"), info?.collation || "—"],
    [t("inspector.estimatedRows"), info?.estimatedRows?.toLocaleString() ?? "—"],
    [t("inspector.totalSize"), formatBytes(info?.dataSize)],
  ];
  return (
    <div className="property-cards">
      {fields.map(([label, value]) => (
        <div key={label}>
          <b>{label}</b>
          <span>{value}</span>
        </div>
      ))}
      <div className="full">
        <b>{t("inspector.comment")}</b>
        <span>{info?.comment || t("inspector.noComment")}</span>
      </div>
    </div>
  );
}

function ColumnsPanel({ columns }: { columns: ColumnInfo[] }) {
  const { t } = useI18n();
  return (
    <table className="object-grid">
      <thead>
        <tr>
          <th>#</th><th>{t("inspector.column")}</th><th>{t("inspector.dataType")}</th>
          <th>{t("inspector.notNull")}</th><th>{t("inspector.auto")}</th>
          <th>{t("inspector.key")}</th><th>{t("inspector.default")}</th>
          <th>{t("inspector.comment")}</th>
        </tr>
      </thead>
      <tbody>
        {columns.map((column, index) => (
          <tr key={column.name}>
            <td className="numeric">{column.ordinalPosition ?? index + 1}</td>
            <td className="object-name">{column.name}</td>
            <td>{column.dataType}</td>
            <td>{column.nullable ? "" : "✓"}</td>
            <td>{column.autoIncrement ? "✓" : column.generated ? t("inspector.generated") : ""}</td>
            <td>{column.isPrimaryKey ? "PRI" : ""}</td>
            <td className="mono">{column.defaultValue ?? "—"}</td>
            <td>{column.comment || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function IndexesPanel({ indexes }: { indexes: IndexInfo[] }) {
  const { t } = useI18n();
  return (
    <table className="object-grid">
      <thead>
        <tr>
          <th>{t("inspector.index")}</th><th>{t("inspector.columnsExpression")}</th>
          <th>{t("inspector.unique")}</th><th>{t("inspector.primary")}</th>
          <th>{t("column.type")}</th>
        </tr>
      </thead>
      <tbody>
        {indexes.map((index) => (
          <tr key={index.name}>
            <td className="object-name">{index.name}</td>
            <td className="mono">{index.columns.join(", ")}</td>
            <td>{index.unique ? "✓" : ""}</td>
            <td>{index.primary ? "PRI" : ""}</td>
            <td>{index.indexType || "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* 格式化 + 高亮在懒加载的 DdlCode 里(CodeMirror 和 sql-formatter 不小,
   没必要让每次启动都下载)。加载那一下先显示原文,不留白屏。 */
const DdlCode = lazy(() => import("./DdlCode"));

function DdlPanel({ ddl, kind }: { ddl: string; kind?: DbKind }) {
  const { t } = useI18n();
  return (
    <Suspense fallback={<div className="ddl-view"><pre>{ddl || t("inspector.noDdl")}</pre></div>}>
      <DdlCode ddl={ddl} kind={kind} />
    </Suspense>
  );
}

interface DataPanelProps {
  tab: TableTab;
  kind?: DbKind;
  columns: ColumnInfo[];
  editable: boolean;
  editHint: string;
  reloadKey: number;
  onDirtyChange: (dirty: boolean) => void;
}

/** Self-contained data browser: server-side WHERE + ORDER BY + keyset paging
 *  with infinite scroll, a DBeaver-style right-click filter menu, and inline
 *  staged editing. */
function DataPanel({ tab, kind, columns, editable, editHint, reloadKey, onDirtyChange }: DataPanelProps) {
  const { t } = useI18n();
  const nullableColumns = useMemo(() => Object.fromEntries(columns.map((c) => [c.name, c.nullable])), [columns]);
  const [pageSize, setPageSize] = useState(() => {
    const stored = Number(localStorage.getItem("dataPageSize"));
    return stored > 0 ? stored : 200;
  });
  const [rows, setRows] = useState<Cell[][]>([]);
  const [cols, setCols] = useState<ColumnMeta[]>([]);
  const [orderBy, setOrderBy] = useState<GridSort[]>([]);
  const [whereApplied, setWhereApplied] = useState("");
  const [whereInput, setWhereInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const { askConfirm, confirmDialog } = useConfirm();
  const rowsRef = useRef<Cell[][]>([]);
  const reqRef = useRef(0);


  const load = useCallback(
    async (mode: "reset" | "more" | "refresh") => {
      const reqId = ++reqRef.current;
      const base = mode === "more" ? rowsRef.current : [];
      const limit = mode === "refresh" ? Math.max(pageSize, rowsRef.current.length) : pageSize;
      const sql = buildDataQuery(kind, tab.database, tab.schema, tab.table, {
        where: whereApplied,
        orderBy,
        limit,
        offset: base.length,
      });
      if (mode !== "more") setLoading(true);
      else setLoadingMore(true);
      setError(undefined);
      try {
        const res = await api.runQuery(tab.connId, tab.database, sql, limit);
        if (reqId !== reqRef.current) return;
        const next = mode !== "more" ? res.rows : [...base, ...res.rows];
        rowsRef.current = next;
        setRows(next);
        setCols(res.columns);
        setHasMore(res.rows.length >= limit);
      } catch (e) {
        if (reqId !== reqRef.current) return;
        setError(String(e));
        setHasMore(false);
      } finally {
        if (reqId === reqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [kind, tab.connId, tab.database, tab.schema, tab.table, whereApplied, orderBy, pageSize],
  );

  useEffect(() => {
    void load("reset");
  }, [load]);

  /* 只认 reloadKey —— 它是外面「请求刷新一次」时自增的计数器。load 的身份会随
     筛选/排序/分页变,列进依赖的话每改一次条件就额外多刷一次(上面那个
     `useEffect(..., [load])` 已经负责那种情况了)。 */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey > 0) void load("refresh"); }, [reloadKey]);

  const result: QueryResult = useMemo(
    () => ({ columns: cols, rows, rowsAffected: null, truncated: false, elapsedMs: 0, message: null }),
    [cols, rows],
  );

  const guardDataShapeChange = (change: () => void) => {
    if (dirty) {
      useApp.getState().showToast({ kind: "error", text: t("edit.saveBeforeDataChange") });
      return;
    }
    change();
  };

  const sortColumn = (column: string, dir: "asc" | "desc") =>
    guardDataShapeChange(() => setOrderBy([{ column, dir }]));

  const addSortColumn = (column: string, dir: "asc" | "desc") =>
    guardDataShapeChange(() => setOrderBy((current) => {
      const index = current.findIndex((item) => item.column === column);
      if (index < 0) return [...current, { column, dir }];
      return current.map((item, itemIndex) => itemIndex === index ? { column, dir } : item);
    }));

  const removeSortColumn = (column: string) =>
    guardDataShapeChange(() => setOrderBy((current) => current.filter((item) => item.column !== column)));

  const applyFilter = (clause: string) => {
    guardDataShapeChange(() => {
      setWhereInput(clause);
      setWhereApplied(clause);
    });
  };

  const clearFilter = () => {
    guardDataShapeChange(() => {
      setWhereInput("");
      setWhereApplied("");
    });
  };

  /** AND a new clause onto the current WHERE (so multiple menu filters stack). */
  const andFilter = (clause: string) => {
    const cur = whereApplied.trim();
    applyFilter(cur ? `${cur} AND ${clause}` : clause);
  };

  const filterByValue = (colName: string, value: Cell, op: FilterOp) => {
    const col = quoteIdent(kind, colName);
    if (value === null || value === undefined) {
      andFilter(op === "<>" ? `${col} IS NOT NULL` : `${col} IS NULL`);
    } else if (op === "like") {
      andFilter(`${col} LIKE ${sqlLiteral(`%${String(value)}%`, kind)}`);
    } else {
      andFilter(`${col} ${op} ${sqlLiteral(value, kind)}`);
    }
  };

  const changePageSize = (size: number) => {
    guardDataShapeChange(() => {
      localStorage.setItem("dataPageSize", String(size));
      setPageSize(size);
    });
  };

  const handleDirtyChange = useCallback((next: boolean) => {
    setDirty(next);
    onDirtyChange(next);
  }, [onDirtyChange]);

  const saveEdits = async (edits: EditDraft[]) => {
    const requests = edits.map((edit) =>
      buildCellRequest(tab.connId, tab.database, tab.schema, tab.table, columns, result, edit.row, edit.column, edit.newValue),
    );
    await api.applyCellEdits(requests);
    const next = rows.map((row, r) => {
      const rowEdits = edits.filter((edit) => edit.row === r);
      if (!rowEdits.length) return row;
      const copy = [...row];
      for (const edit of rowEdits) copy[edit.column] = edit.newValue;
      return copy;
    });
    rowsRef.current = next;
    setRows(next);
    useApp.getState().showToast({ kind: "success", text: t("edit.savedChanges", { count: edits.length }) });
  };

  /** Commit whole-column updates to the ENTIRE filtered table (not just the
   *  loaded page). Confirms with the real affected-row count first, since this
   *  cannot be undone once committed. Rejects on cancel to keep it staged. */
  const saveColumnUpdates = async (ops: { column: number; value: Cell }[]) => {
    const countSql = buildCountQuery(kind, tab.database, tab.schema, tab.table, whereApplied);
    const countRes = await api.runQuery(tab.connId, tab.database, countSql, 1);
    const affected = Number(countRes.rows?.[0]?.[0] ?? 0);

    const sets = ops
      .map((op) => `  • ${cols[op.column].name} = ${op.value == null ? "NULL" : String(op.value)}`)
      .join("\n");
    const scope = whereApplied
      ? t("data.filterWhere", { where: whereApplied })
      : t("data.filterAllRows");
    const message = t("data.confirmColumnUpdate", {
      table: tab.table,
      sets,
      filter: scope,
      rows: affected.toLocaleString(),
    });
    if (!(await askConfirm(message, t("data.confirmColumnUpdateTitle")))) throw new Error("__update_cancelled__");

    /* 一笔事务里跑完 —— 三列赋值,第二条炸了的话前一条已经落库、而界面上
       三列都还显示着旧值,下次再点保存又会把第一条重跑一遍。 */
    await api.runStatements(
      tab.connId,
      tab.database,
      ops.map((op) =>
        buildColumnUpdate(kind, tab.database, tab.schema, tab.table, cols[op.column].name, op.value, whereApplied),
      ),
    );

    // Reflect the change on the loaded page so the grid clears dirty state.
    const next = rows.map((row) => {
      const copy = [...row];
      for (const op of ops) copy[op.column] = op.value;
      return copy;
    });
    rowsRef.current = next;
    setRows(next);
    useApp.getState().showToast({
      kind: "success",
      text: t("data.columnUpdated", { rows: affected.toLocaleString() }),
    });
  };

  /** Commit added / deleted rows (INSERT / DELETE), confirmed first. */
  const saveRowChanges = async ({ inserts, deletes }: { inserts: Cell[][]; deletes: number[] }) => {
    const colNames = cols.map((c) => c.name);
    const insertSqls = inserts
      .map((vals) => buildRowInsert(kind, tab.database, tab.schema, tab.table, colNames, vals))
      .filter((s): s is string => s !== null);

    const pkCols = columns.filter((c) => c.isPrimaryKey);
    const deleteSqls: string[] = [];
    if (deletes.length) {
      if (!pkCols.length) throw new Error(t("edit.primaryKeyRequired"));
      for (const idx of deletes) {
        const rowVals = rows[idx];
        if (!rowVals) continue;
        const pk: Record<string, Cell> = {};
        for (const pkc of pkCols) {
          const ci = cols.findIndex((c) => c.name === pkc.name);
          /* 主键列不在当前结果里(预览 SQL 只选了一部分列)时 findIndex 返回 -1,
             rowVals[-1] 是 undefined,拼出来就成了 `WHERE id IS NULL` ——
             主键不可能是 NULL,所以那条 DELETE 一行都删不掉,可界面上那行已经消失、
             还提示成功。改单元格那条路本来就有这道检查(tableEditing),删除这条漏了。 */
          if (ci < 0) throw new Error(t("edit.primaryKeyMissingFromResult", { column: pkc.name }));
          pk[pkc.name] = rowVals[ci];
        }
        deleteSqls.push(buildRowDelete(kind, tab.database, tab.schema, tab.table, pk));
      }
    }

    // Empty added rows (nothing filled in) are dropped silently.
    if (insertSqls.length === 0 && deleteSqls.length === 0) return;

    const message = t("data.confirmRowChanges", {
      table: tab.table,
      adds: insertSqls.length,
      dels: deleteSqls.length,
    });
    const title = `${t("edit.addRow")} / ${t("edit.deleteRow")}`;
    if (!(await askConfirm(message, title))) throw new Error("__update_cancelled__");

    /* 删和插放进**同一笔事务**。原来是两个 for 一条条发:删到第三条炸了,
       前两条已经生效,而错误往上抛、下面的 setRows 不执行,表格还显示着那两行;
       用户再点一次保存,插入那批就重复插了一遍。
       先删后插的顺序保留 —— 主键冲突的改动(删掉旧行再插同一个主键)靠这个顺序。 */
    await api.runStatements(tab.connId, tab.database, [...deleteSqls, ...insertSqls]);

    const delSet = new Set(deletes);
    const kept = rows.filter((_, i) => !delSet.has(i));
    const appended = inserts.map((vals) => cols.map((_, ci) => vals[ci] ?? null));
    const next = [...kept, ...appended];
    rowsRef.current = next;
    setRows(next);
    useApp.getState().showToast({
      kind: "success",
      text: t("data.rowsChanged", { adds: insertSqls.length, dels: deleteSqls.length }),
    });
  };

  return (
    <div className="data-panel">
      <div className="data-toolbar">
        <div className="data-where">
          <Filter size={13} />
          <input
            value={whereInput}
            onChange={(e) => setWhereInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyFilter(whereInput.trim());
            }}
            placeholder={t("data.wherePlaceholder")}
            spellCheck={false}
          />
          {whereApplied && (
            <span className="icon-btn" onClick={clearFilter} title={t("data.clearFilter")}>
              <X size={13} />
            </span>
          )}
        </div>
        {/* 编辑说明收进一个小图标,鼠标停上去看 —— 这行只留过滤框和分页 */}
        <span className="data-hint-icon" title={editHint} aria-label={editHint}>
          <Info size={14} />
        </span>
        <label className="data-pagesize" title={t("data.perPage")}>
          <select value={pageSize} onChange={(e) => changePageSize(Number(e.target.value))}>
            {[100, 200, 500, 1000].map((n) => (
              <option key={n} value={n}>
                {t("data.perPageOption", { n })}
              </option>
            ))}
          </select>
        </label>
        <span className="muted data-rowcount">
          {t("query.rowCount", { count: `${rows.length.toLocaleString()}${hasMore ? "+" : ""}` })}
        </span>
      </div>

      <div className="data-grid-area">
        {loading && cols.length === 0 ? (
          <div className="object-state"><Loader2 size={18} className="spin" /> {t("inspector.loadingRows")}</div>
        ) : error && cols.length === 0 ? (
          <div className="object-state error">{error}</div>
        ) : (
          <>
            <ResultGrid
              result={result}
              editable={editable}
              onSaveEdits={saveEdits}
              onSaveColumns={saveColumnUpdates}
              onSaveRowChanges={saveRowChanges}
              onEditError={(text) => useApp.getState().showToast({ kind: "error", text })}
              nullableColumns={nullableColumns}
              onDirtyChange={handleDirtyChange}
              sort={orderBy}
              onSortColumn={sortColumn}
              onAddSortColumn={addSortColumn}
              onRemoveSortColumn={removeSortColumn}
              onClearSort={() => guardDataShapeChange(() => setOrderBy([]))}
              onFilterByValue={filterByValue}
              onClearFilter={clearFilter}
              hasFilter={!!whereApplied}
              onLoadMore={hasMore && !loading ? () => void load("more") : undefined}
              loadingMore={loadingMore}
            />
            {loading && (
              <div className="grid-refreshing" role="status">
                <Loader2 size={13} className="spin" /> {t("data.refreshingRows")}
              </div>
            )}
            {error && <div className="grid-refresh-error" role="alert">{error}</div>}
            {loadingMore && (
              <div className="grid-loadmore">
                <Loader2 size={13} className="spin" /> {t("grid.loadingMore")}
              </div>
            )}
          </>
        )}
      </div>

      {confirmDialog}
    </div>
  );
}

export default function TableInspector({ tab }: { tab: TableTab }) {
  const { t } = useI18n();
  const kind = useApp((state) => state.meta[tab.connId]?.kind);
  const [section, setSection] = useState<Section>("columns");
  const { trackProps: tabTrack, pillProps: tabPill } = useGlassPill(section);
  const [search, setSearch] = useState("");
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [ddl, setDdl] = useState("");
  const [info, setInfo] = useState<TableInfo | undefined>(tab.objectInfo);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const [metadataReloadKey, setMetadataReloadKey] = useState(0);
  const [dataVisited, setDataVisited] = useState(false);
  useEffect(() => { if (section === "data") setDataVisited(true); }, [section]);

  /* 切换分区时,下面的内容短暂淡入,而不是「啪」一下整块换掉。
     只动透明度、不滑动 —— 用户嫌的就是「点过去画面变得太快、动得太多」。
     第一次打开不淡入;系统开了「减少动态效果」也不淡入。 */
  const contentRef = useRef<HTMLElement>(null);
  const firstSection = useRef(true);
  useLayoutEffect(() => {
    if (firstSection.current) { firstSection.current = false; return; }
    const el = contentRef.current;
    if (!el || typeof el.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
  }, [section]);
  const [hasUnsavedDataEdits, setHasUnsavedDataEdits] = useState(false);
  useUnsavedChanges(tab.id, hasUnsavedDataEdits);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    /* 四份元数据各取各的,**一份取不到不该连累另外三份**。
       原来是 Promise.all:视图定义自己有毛病时,列查询会失败(MySQL 要先解析视图体),
       于是 DDL、索引、表信息一起被丢掉,整页只剩一行驱动原话。
       而 SHOW CREATE VIEW 根本不执行视图体,本来能正常返回 ——
       用户本该一眼看到 DDL 就认出是自己的视图坏了。 */
    Promise.allSettled([
      api.listColumns(tab.connId, tab.database, tab.schema, tab.table),
      api.listIndexes(tab.connId, tab.database, tab.schema, tab.table),
      api.getObjectDdl(tab.connId, tab.database, tab.schema, tab.table, tab.objectKind),
      api.listTables(tab.connId, tab.database, tab.schema),
    ])
      .then(([columnsResult, indexesResult, ddlResult, tablesResult]) => {
        if (cancelled) return;
        if (columnsResult.status === "fulfilled") setColumns(columnsResult.value);
        if (indexesResult.status === "fulfilled") setIndexes(indexesResult.value);
        if (ddlResult.status === "fulfilled") setDdl(ddlResult.value);
        setInfo((tablesResult.status === "fulfilled"
          ? tablesResult.value.find((item) => item.name === tab.table)
          : undefined) ?? tab.objectInfo);
        const failures = [columnsResult, indexesResult, ddlResult, tablesResult]
          .filter((item): item is PromiseRejectedResult => item.status === "rejected");
        // 全军覆没才算整页失败;只挂了一部分就把能看的照常显示,另外提示哪块没取到
        setError(failures.length === 4 ? String(failures[0].reason) : undefined);
        setNotice(failures.length && failures.length < 4 ? explainMetadataFailure(
          [columnsResult, indexesResult, ddlResult, tablesResult].map((r, i) => r.status === "rejected" ? i : -1).filter((i) => i >= 0),
          String(failures[0].reason), tab.objectKind) : undefined);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [tab.connId, tab.database, tab.schema, tab.table, tab.objectKind, tab.objectInfo, metadataReloadKey]);

  const query = search.trim().toLocaleLowerCase();
  const visibleColumns = useMemo(
    () => columns.filter((column) => containsQuery(
      query,
      [column.name, column.dataType, column.defaultValue, column.comment],
    )),
    [columns, query],
  );
  const visibleIndexes = useMemo(
    () => indexes.filter((index) => containsQuery(
      query,
      [index.name, index.indexType, index.columns.join(", "), index.definition],
    )),
    [indexes, query],
  );
  const hasPrimaryKey = columns.some((column) => column.isPrimaryKey);
  const editable = tab.objectKind === "table" && hasPrimaryKey;
  const editHint = tab.objectKind === "view"
    ? t("edit.viewReadOnly")
    : !hasPrimaryKey
      ? t("edit.primaryKeyRequired")
      : t("edit.hint");

  const sections: { id: Section; label: string; icon: typeof TableProperties; tint: string; count?: number }[] = [
    { id: "properties", label: t("inspector.properties"), icon: TableProperties, tint: "var(--c-schema)" },
    { id: "columns", label: t("inspector.columns"), icon: Columns3, tint: "var(--c-database)", count: columns.length },
    { id: "indexes", label: t("inspector.indexes"), icon: KeyRound, tint: "var(--c-connection)", count: indexes.length },
    { id: "ddl", label: "DDL", icon: Braces, tint: "var(--c-function)" },
    { id: "data", label: t("inspector.data"), icon: Database, tint: "var(--accent)" },
  ];

  const guardUnsavedDataEdits = (change: () => void) => {
    if (hasUnsavedDataEdits) {
      useApp.getState().showToast({ kind: "error", text: t("edit.saveBeforeDataChange") });
      return;
    }
    change();
  };

  const refresh = () => guardUnsavedDataEdits(() => { if (section === "data") setReloadKey(value => value + 1); else setMetadataReloadKey(value => value + 1); });

  const searchable = section === "columns" || section === "indexes";
  const subtitle = [
    `${tab.database}${tab.schema && tab.schema !== "main" ? ` / ${tab.schema}` : ""}`,
    t(tab.objectKind === "view" ? "inspector.view" : "inspector.table"),
    info?.comment,
  ].filter(Boolean).join(" · ");
  const searchPlaceholder = t("inspector.search", {
    section: sections.find((item) => item.id === section)?.label ?? section,
  });

  return (
    <div className="object-workspace table-inspector">
      {/* 标题、分区标签、行数大小、操作压成一行,把高度让给数据。
          引擎 / 排序规则不常看,放进行数那块的提示和「属性」里。 */}
      <div className="ti-bar">
        <div className="table-title-icon">
          {tab.objectKind === "view" ? <Braces size={14} /> : <TableProperties size={14} />}
        </div>
        <div className="ti-bar-title" title={[tab.table, subtitle].join("\n")}>
          <strong>{tab.table}</strong>
          <span className="muted">{subtitle}</span>
        </div>

        {/* 跟工作区标签栏、资产侧栏共用同一块玻璃胶囊。
            这排每一项自带颜色,所以把当前项的 tint 作为 --pill-accent 传给胶囊 ——
            胶囊滑到哪儿就染成哪一项的颜色,而不是全都一个蓝。 */}
        <div
          className="ti-bar-tabs pill-track"
          style={{ "--pill-accent": sections.find((x) => x.id === section)?.tint } as CSSProperties}
          {...tabTrack}
        >
          <span {...tabPill} />
          {sections.map((item) => {
            const Icon = item.icon;
            const on = section === item.id;
            return (
              <button
                key={item.id}
                data-pill={item.id}
                className={on ? "on" : ""}
                title={item.label}
                onClick={() => guardUnsavedDataEdits(() => {
                  setSection(item.id);
                  setSearch("");
                })}
              >
                <Icon size={13} style={{ color: item.tint }} />
                <span>{item.label}</span>
                {item.count != null && <b>{item.count}</b>}
              </button>
            );
          })}
        </div>
        {searchable && (
          <div className="ti-bar-search">
            <Search size={13} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
            />
          </div>
        )}

        <div className="toolbar-spacer" />
        <span
          className="ti-bar-stats"
          title={[
            `${t("inspector.engine")}: ${info?.engine || "—"}`,
            `${t("inspector.rows")}: ${info?.estimatedRows?.toLocaleString() ?? "—"}`,
            `${t("inspector.dataSize")}: ${formatBytes(info?.dataSize)}`,
            `${t("inspector.collation")}: ${info?.collation || "—"}`,
          ].join("\n")}
        >
          {t("inspector.rowsShort", { count: info?.estimatedRows?.toLocaleString() ?? "—" })}
          <i>·</i>
          {formatBytes(info?.dataSize)}
        </span>
        <button
          className="btn ghost sm"
          title={t("inspector.askAi")}
          onClick={() =>
            useAi.getState().seedAsk(
              `解释一下 ${tab.table} 这张表:大致用途、关键字段的含义,并给出一个示例的只读查询。`,
            )
          }
        >
          <Sparkles size={13} /> <span className="ti-bar-ai-label">AI</span>
        </button>
        <button className="icon-btn" title={t("action.refresh")} onClick={refresh}>
          <RefreshCw size={15} />
        </button>
      </div>

      <section className="object-content" ref={contentRef}>
        <div className="inspector-body" style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: section === "data" ? "none" : undefined }}>
          {loading ? (
            <div className="object-state"><Loader2 size={18} className="spin" /> {t("inspector.loadingMetadata")}</div>
          ) : error ? (
            <div className="object-state error">{error}</div>
          ) : (
            <>
            {notice && <div className="object-notice">{notice}</div>}
            {section === "properties" ? (
            <PropertiesPanel tab={tab} info={info} />
            ) : section === "columns" ? (
              <ColumnsPanel columns={visibleColumns} />
            ) : section === "indexes" ? (
              <IndexesPanel indexes={visibleIndexes} />
            ) : section === "ddl" ? (
              <DdlPanel ddl={ddl} kind={kind} />
            ) : null}
            </>
          )}
          </div>
          {(dataVisited || section === "data") && <div style={{ display: section === "data" ? "flex" : "none", flex: 1, minHeight: 0, flexDirection: "column" }}>
            <DataPanel
              tab={tab}
              kind={kind}
              columns={columns}
              editable={editable}
              editHint={editHint}
              reloadKey={reloadKey}
              onDirtyChange={setHasUnsavedDataEdits}
            />
          </div>}
        </div>
      </section>
    </div>
  );
}
