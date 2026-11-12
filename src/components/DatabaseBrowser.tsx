import { useWorkspaceReady } from "./WorkspaceOpening";
import { useEffect, useMemo, useState } from "react";
import { Activity, Braces, ChevronDown, ChevronUp, Eye, Loader2, RefreshCw, Search, Table2, Workflow } from "lucide-react";
import { api } from "../lib/api";
import { useApp, type DatabaseTab, type TreeNode } from "../store/appStore";
import type { RoutineInfo, TableInfo } from "../types";
import { useI18n } from "../hooks/useI18n";
import ProcessList from "./ProcessList";
import { compareText } from "../lib/collate";

type Category = "table" | "view" | "procedure" | "function";

const categoryIcons = {
  table: Table2,
  view: Eye,
  procedure: Workflow,
  function: Braces,
};

/** Per-object-type accent color (from the design system) — brings some color
 *  to the otherwise monochrome object list. */
const categoryColor: Record<Category, string> = {
  table: "var(--c-table)",
  view: "var(--c-view)",
  procedure: "var(--c-procedure)",
  function: "var(--c-function)",
};

function isRoutine(item: TableInfo | RoutineInfo): item is RoutineInfo {
  return item.kind === "procedure" || item.kind === "function";
}

type SortKey = "name" | "kind" | "engine" | "rows" | "size";
function sortValue(item: TableInfo | RoutineInfo, key: SortKey): string | number | null {
  const routine = isRoutine(item);
  switch (key) {
    case "name":
      return item.name;
    case "kind":
      return item.kind;
    case "engine":
      return routine ? item.language ?? "" : item.engine ?? "";
    case "rows":
      return routine ? null : item.estimatedRows ?? null;
    case "size":
      return routine ? null : item.dataSize ?? null;
  }
}
function compareValues(a: string | number | null, b: string | number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1; // nulls sort last
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return compareText(String(a), String(b));
}

function formatBytes(value?: number | null): string {
  if (value == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

export default function DatabaseBrowser({ tab, active = true }: { tab: DatabaseTab; active?: boolean }) {
  const { t } = useI18n();
  const categoryLabels: Record<Category, string> = {
    table: t("folder.tables"),
    view: t("folder.views"),
    procedure: t("folder.procedures"),
    function: t("folder.functions"),
  };
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [routines, setRoutines] = useState<RoutineInfo[]>([]);
  const [category, setCategory] = useState<Category | "processes">("table");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  const kind = useApp((s) => s.meta[tab.connId]?.kind);
  const canProcesses = kind === "mysql" || kind === "mariadb" || kind === "postgres";
  const [loading, setLoading] = useState(true);
  useWorkspaceReady(!loading);
  const [error, setError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    Promise.all([
      api.listTables(tab.connId, tab.database, tab.schema),
      api.listRoutines(tab.connId, tab.database, tab.schema),
    ])
      .then(([nextTables, nextRoutines]) => {
        if (!cancelled) {
          setTables(nextTables);
          setRoutines(nextRoutines);
        }
      })
      .catch((reason) => !cancelled && setError(String(reason)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [tab.connId, tab.database, tab.schema, reloadKey]);

  const counts: Record<Category, number> = {
    table: tables.filter((item) => item.kind === "table").length,
    view: tables.filter((item) => item.kind === "view").length,
    procedure: routines.filter((item) => item.kind === "procedure").length,
    function: routines.filter((item) => item.kind === "function").length,
  };
  const query = search.trim().toLocaleLowerCase();
  const objects = useMemo(() => {
    const source: (TableInfo | RoutineInfo)[] =
      category === "table" || category === "view"
        ? tables.filter((item) => item.kind === category)
        : routines.filter((item) => item.kind === category);
    const filtered = query
      ? source.filter((item) =>
          [item.name, item.kind, item.comment, isRoutine(item) ? item.language : item.engine]
            .filter(Boolean)
            .some((value) => String(value).toLocaleLowerCase().includes(query)),
        )
      : source;
    const mul = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => compareValues(sortValue(a, sort.key), sortValue(b, sort.key)) * mul);
  }, [tables, routines, category, query, sort]);

  const openObject = (item: TableInfo | RoutineInfo) => {
    if (isRoutine(item)) {
      useApp.getState().openRoutineTab({ key: `${tab.id}:${item.kind}:${item.name}`, label: item.name, kind: item.kind, connId: tab.connId, database: tab.database, schema: tab.schema, childKeys: [], hasChildren: false, loaded: true, loading: false, expanded: false });
      return;
    }
    const node: TreeNode = {
      key: `browser:${tab.id}:${item.kind}:${item.name}`,
      kind: item.kind === "view" ? "view" : "table",
      label: item.name,
      connId: tab.connId,
      database: tab.database,
      schema: tab.schema,
      table: item.name,
      objectInfo: item,
      childKeys: [],
      hasChildren: true,
      loaded: false,
      loading: false,
      expanded: false,
    };
    useApp.getState().openTableInspector(node);
  };

  return (
    <div className="object-workspace">
      <div className="ti-header">
        <div className="ti-title">
          <strong>
            {tab.database}
            {tab.schema && tab.schema !== "main" ? ` / ${tab.schema}` : ""}
          </strong>
          <div className="muted">
            {t("browser.summary", {
              tables: counts.table,
              views: counts.view,
              procedures: counts.procedure,
              functions: counts.function,
            })}
          </div>
        </div>
        <div className="toolbar-spacer" />
        <button className="btn ghost sm" onClick={() => setReloadKey((value) => value + 1)}>
          <RefreshCw size={13} /> {t("action.refresh")}
        </button>
      </div>

      <div className="ti-tabs" aria-label={t("browser.objectTypes")}>
        {(Object.keys(categoryLabels) as Category[]).map((item) => {
          const Icon = categoryIcons[item];
          return (
            <button
              key={item}
              className={category === item ? "on" : ""}
              onClick={() => {
                setCategory(item);
                setSearch("");
              }}
            >
              <Icon size={14} style={{ color: categoryColor[item] }} />
              <span>{categoryLabels[item]}</span>
              <b>{counts[item]}</b>
            </button>
          );
        })}
        {canProcesses && (
          <button
            className={category === "processes" ? "on" : ""}
            onClick={() => {
              setCategory("processes");
              setSearch("");
            }}
          >
            <Activity size={14} style={{ color: "var(--green)" }} />
            <span>进程管理</span>
          </button>
        )}
        {category !== "processes" && (
          <div className="ti-filter">
            <Search size={13} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("browser.search", { category: categoryLabels[category as Category] ?? "" })}
              aria-label={t("browser.searchAria")}
            />
          </div>
        )}
      </div>

      <section className="object-content">
          {category === "processes" ? (
            <ProcessList connId={tab.connId} kind={kind!} active={active} />
          ) : (
          <div className="object-grid-wrap">
            {loading ? (
              <div className="object-state"><Loader2 size={18} className="spin" /> {t("browser.loading")}</div>
            ) : error ? (
              <div className="object-state error">{error}</div>
            ) : objects.length === 0 ? (
              <div className="object-state">{t("browser.empty", { category: categoryLabels[category as Category] ?? "" })}</div>
            ) : (
              <table className="object-grid">
                <thead>
                  <tr>
                    {([
                      ["name", t("column.name"), false],
                      ["kind", t("column.type"), false],
                      ["engine", t("column.engineLanguage"), false],
                      ["rows", t("column.estimatedRows"), true],
                      ["size", t("column.size"), true],
                    ] as [SortKey, string, boolean][]).map(([k, label, numeric]) => (
                      <th
                        key={k}
                        className={`sortable${numeric ? " numeric" : ""}${sort.key === k ? " sorted" : ""}`}
                        onClick={() => toggleSort(k)}
                      >
                        <span className="th-inner">
                          {label}
                          {sort.key === k &&
                            (sort.dir === "asc" ? <ChevronUp size={13} /> : <ChevronDown size={13} />)}
                        </span>
                      </th>
                    ))}
                    <th>{t("column.comment")}</th>
                  </tr>
                </thead>
                <tbody>
                  {objects.map((item) => {
                    const routine = isRoutine(item);
                    const color = categoryColor[item.kind as Category];
                    const RowIcon = categoryIcons[item.kind as Category];
                    return (
                      <tr key={`${item.kind}:${item.name}`} onDoubleClick={() => openObject(item)} className="openable">
                        <td className="object-name">
                          <span className="obj-name-cell">
                            <RowIcon size={13} style={{ color, flex: "0 0 auto" }} /> {item.name}
                          </span>
                        </td>
                        <td><span style={{ color }}>{t(`object.${item.kind}`)}</span></td>
                        <td>{routine ? item.language ?? "—" : item.engine ?? "—"}</td>
                        <td className="numeric" style={!routine && item.estimatedRows != null ? { color: "var(--syn-number)" } : undefined}>{!routine && item.estimatedRows != null ? item.estimatedRows.toLocaleString() : "—"}</td>
                        <td className="numeric" style={!routine ? { color: "var(--syn-number)" } : undefined}>{!routine ? formatBytes(item.dataSize) : "—"}</td>
                        <td>{item.comment || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          )}
      </section>
    </div>
  );
}
