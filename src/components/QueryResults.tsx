import {
  Braces,
  ChevronDown,
  ChevronUp,
  Columns3,
  Copy,
  Download,
  LineChart,
  Sparkles,
  TableProperties
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useAi } from "../features/ai/aiStore";
import { useI18n } from "../hooks/useI18n";
import { tryWriteClipboardText } from "../lib/clipboard";
import { exportResultFile, serializeResult } from "../lib/export";
import { applySortFilter, EMPTY_RESULT_VIEW, eqCells, reconcileResultView, resultViewKey, type FilterOp, type ResultView } from "../lib/queryResultView";
import { matchesPreviewExecution } from "../lib/tableEditing";
import { useApp } from "../store/appStore";
import type { QueryTab } from "../store/appTypes";
import type { Cell } from "../types";
import ResultGrid from "./ResultGrid";
import SqlRunStatus from "./SqlRunStatus";
import TableStructure from "./TableStructure";

const ChartView = lazy(() => import("./ChartView"));


export default function QueryResults({ tab, height, collapsed = false }: { tab: QueryTab; height: number; collapsed?: boolean; }) {
  const { t } = useI18n();
  const tabId = tab.id;
  const activeTabId = tabId;
  const dirty = useApp(state => !!state.dirtyTabs[tab.id] || !!tab.savingEdits);
  const [views, setViews] = useState<Record<string, ResultView>>({});
  const [selectedSets, setSelectedSets] = useState<Record<string, number>>({});
  const executedSql = tab.executions[tab.activeExecutionIndex]?.sql ?? tab.sql;
  const executionKey = resultViewKey(executedSql, tab.activeExecutionIndex);
  const resultSetIndex = Math.min(selectedSets[executionKey] ?? 0, tab.result?.additionalResults?.length ?? 0);
  const viewKey = resultViewKey(executedSql, tab.activeExecutionIndex, resultSetIndex);
  const rawResult = resultSetIndex === 0 ? tab.result : tab.result?.additionalResults?.[resultSetIndex - 1];
  const storedView = views[viewKey] ?? EMPTY_RESULT_VIEW;
  const view = rawResult ? reconcileResultView(storedView, rawResult) : storedView;
  const resultSort = view.sort;
  const resultFilters = view.filters;
  useEffect(() => {
    if (view !== storedView) setViews(previous => ({ ...previous, [viewKey]: view }));
  }, [view, storedView, viewKey]);
  const changeView = (update: (current: ResultView) => ResultView) =>
    setViews(previous => {
      const current = previous[viewKey] ?? EMPTY_RESULT_VIEW;
      return { ...previous, [viewKey]: update(rawResult ? reconcileResultView(current, rawResult) : current) };
    });
  const setResultSort = (sort: ResultView["sort"]) => changeView(current => ({ ...current, sort }));
  const setResultFilters = (update: ResultView["filters"] | ((current: ResultView["filters"]) => ResultView["filters"])) =>
    changeView(current => ({ ...current, filters: typeof update === "function" ? update(current.filters) : update }));
  const setResultSetIndex = (index: number) => {
    if (dirty) return;
    setSelectedSets(previous => ({ ...previous, [executionKey]: index }));
  };
  // 从表打开的查询标签带着那张表的列信息,表头悬停时显示列注释
  const tableColumns = tab.tableContext?.columns;
  const columnComments = useMemo(() => tableColumns
    ? Object.fromEntries(tableColumns.filter((c) => c.comment?.trim()).map((c) => [c.name, c.comment!.trim()]))
    : undefined, [tableColumns]);
  const reportDirty = useMemo(() => (value: boolean) => useApp.getState().setTabDirty(tabId, value), [tabId]);
  // Editable rows must retain their original indexes and refer to the exact preview SQL.
  const editablePreview = !tab.running && resultSetIndex === 0 && !!tab.tableContext?.editable &&
    tab.sql.trim() === tab.tableContext.previewSql.trim() &&
    matchesPreviewExecution(executedSql, tab.tableContext.previewSql, useApp.getState().meta[tab.connId]?.kind);
  const result = useMemo(() => rawResult && !editablePreview
    ? applySortFilter(rawResult, resultSort, resultFilters) : rawResult,
    [rawResult, editablePreview, resultSort, resultFilters]);
  return (
    <div
      className={`results${collapsed ? " collapsed" : ""}`}
      style={collapsed ? undefined : { height, flex: `0 0 ${height}px` }}
    >
      {tab.executions.length > 1 && (
        <div className="execution-tabs">
          {tab.executions.map((execution, index) => (
            <button
              key={`${index}:${execution.sql.slice(0, 24)}`}
              disabled={dirty && tab.activeExecutionIndex !== index}
              className={tab.activeExecutionIndex === index ? "on" : ""}
              onClick={() => useApp.getState().selectExecution(tab.id, index)}
              title={execution.sql}
            >
              <span className={`execution-dot ${execution.error ? "error" : execution.result ? "ok" : "pending"}`} />
              {t("query.result", { number: index + 1 })}
            </button>
          ))}
        </div>
      )}
      <div className="results-bar">
        <div className="seg">
          <button
            className={tab.view === "grid" ? "on" : ""}
            onClick={() => useApp.getState().setTabView(tab.id, "grid")}
          >
            <TableProperties size={13} /> {t("query.grid")}
          </button>
          <button
            className={tab.view === "chart" ? "on" : ""}
            onClick={() => useApp.getState().setTabView(tab.id, "chart")}
          >
            <LineChart size={13} /> {t("query.chart")}
          </button>
          {tab.tableContext && (
            <button
              className={tab.view === "structure" ? "on" : ""}
              onClick={() => useApp.getState().setTabView(tab.id, "structure")}
            >
              <Columns3 size={13} /> {t("query.structure")}
            </button>
          )}
        </div>

        {result && result.columns.length > 0 && (
          <button
            className="btn ghost sm"
            title={t("query.copyCsvTitle")}
            onClick={async () => {
              const copied = await tryWriteClipboardText(serializeResult(result, "csv"));
              useApp.getState().showToast(copied
                ? { kind: "success", text: t("query.csvCopied") }
                : { kind: "error", text: "复制失败，请检查剪贴板访问权限" });
            }}
          >
            <Copy size={13} /> {t("query.copyCsv")}
          </button>
        )}

        {result && result.columns.length > 0 && (
          <>
            <button
              className="btn ghost sm"
              title={t("query.exportCsv")}
              onClick={async () => {
                try {
                  const path = await exportResultFile(result, "csv", tab.title);
                  useApp.getState().showToast({
                    kind: "success",
                    text: path
                      ? t("query.savedTo", { path })
                      : t("query.downloadStarted", { format: "CSV" }),
                  });
                } catch (error) {
                  useApp.getState().showToast({ kind: "error", text: String(error) });
                }
              }}
            >
              <Download size={13} /> {t("query.exportCsv")}
            </button>
            <button
              className="btn ghost sm"
              title={t("query.exportJson")}
              onClick={async () => {
                try {
                  const path = await exportResultFile(result, "json", tab.title);
                  useApp.getState().showToast({
                    kind: "success",
                    text: path
                      ? t("query.savedTo", { path })
                      : t("query.downloadStarted", { format: "JSON" }),
                  });
                } catch (error) {
                  useApp.getState().showToast({ kind: "error", text: String(error) });
                }
              }}
            >
              <Braces size={13} /> {t("query.exportJson")}
            </button>
          </>
        )}

        <div className="results-meta">
          {result?.message && <span>{result.message}</span>}
          {result && result.columns.length > 0 && (
            <span>
              {t("query.rowCount", { count: result.rows.length.toLocaleString() })}
            </span>
          )}
          {result && <span>{result.elapsedMs} ms</span>}
          {result?.truncated && <span className="warn">{t("query.truncatedAt", { count: result.rows.length.toLocaleString() })}</span>}
        </div>
        <button
          className="icon-btn xs pane-toggle"
          title={collapsed ? "展开结果区" : "收起结果区"}
          aria-expanded={!collapsed}
          onClick={() => useApp.getState().setResultCollapsed(!collapsed)}
        >
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      {tab.result?.additionalResults?.length ? <div className="routine-results-tabs">{[tab.result, ...tab.result.additionalResults].map((_, i) => <button className={`btn sm ${resultSetIndex === i ? "primary" : "ghost"}`} key={i} disabled={dirty && resultSetIndex !== i} onClick={() => setResultSetIndex(i)}>结果 {i + 1}</button>)}</div> : null}
      <div className="results-body" aria-busy={tab.running}>
        <SqlRunStatus tab={tab} />
        {tab.view === "structure" && tab.tableContext ? (
          <TableStructure context={tab.tableContext} />
        ) : tab.error ? (
          <div className="result-error">
            <button
              className="btn sm"
              style={{ marginBottom: 10 }}
              onClick={() =>
                useAi.getState().seedAsk(
                  `下面这条 SQL 执行报错了,帮我分析原因并给出修正后的只读 SQL:\n\`\`\`sql\n${executedSql}\n\`\`\`\n\n报错信息:\n${tab.error}`,
                )
              }
            >
              <Sparkles size={13} /> 让 AI 看这个报错
            </button>
            <div>{tab.error}</div>
          </div>
        ) : !result ? (
          <div className="result-placeholder">
            {!tab.running && t("query.runToSee")}
          </div>
        ) : result.columns.length === 0 ? (
          <div className="result-placeholder">{result.message ?? t("query.statementExecuted")}</div>
        ) : tab.view === "chart" ? (
          <Suspense fallback={<div className="result-placeholder">{t("query.loadingChart")}</div>}>
            <ChartView
              result={result}
              chartX={tab.chartX}
              chartY={tab.chartY}
              onChange={(patch) => useApp.getState().setChart(tab.id, patch)}
            />
          </Suspense>
        ) : (
          <ResultGrid
            key={`${activeTabId}:${viewKey}`}
            result={result}
            columnComments={columnComments}
            editable={editablePreview}
            onDirtyChange={reportDirty}
            onSaveEdits={(edits) => useApp.getState().saveResultEdits(tab.id, edits)}
            onEditError={(text) => useApp.getState().showToast({ kind: "error", text })}
            {...(editablePreview
              ? {}
              : {
                sort: resultSort,
                onSortColumn: (column: string, dir: "asc" | "desc") => setResultSort({ column, dir }),
                onClearSort: () => setResultSort(null),
                onFilterByValue: (column: string, value: Cell, op: FilterOp) =>
                  setResultFilters((f) =>
                    f.some((x) => x.column === column && x.op === op && eqCells(x.value, value))
                      ? f
                      : [...f, { column, op, value }],
                  ),
                onClearFilter: () => setResultFilters([]),
                hasFilter: resultFilters.length > 0,
                filters: resultFilters,
                onRemoveFilter: (i: number) => setResultFilters((f) => f.filter((_, idx) => idx !== i)),
              })}
          />
        )}
      </div>
    </div>
  );
}
