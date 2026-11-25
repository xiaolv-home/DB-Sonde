import { createPortal } from "react-dom";
import type { CSSProperties, HTMLAttributes } from "react";
import {
  ArrowDown,
  ArrowUp,
  ClipboardPaste,
  Copy,
  Loader2,
  Minus,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import CustomFilterDialog from "./CustomFilterDialog";
import { useI18n } from "../hooks/useI18n";
import { useViewportFit } from "../hooks/useViewportFit";
import type { Cell, ColumnMeta } from "../types";
import type { FilterCond, FilterOp, GridSort } from "../lib/queryResultView";
import {
  aggregate,
  cellText,
  coerceFilterValue,
  FILTER_OPS,
  formatAgg,
  menuValueLabel,
  shortFilterVal,
  type AggFn,
  type Pos,
} from "./resultGridModel";

export function GridFilterBar({
  filters,
  onRemoveFilter,
  onClearFilter,
}: {
  filters?: FilterCond[];
  onRemoveFilter?: (index: number) => void;
  onClearFilter?: () => void;
}) {
  const { t } = useI18n();
  if (!filters || filters.length === 0) return null;
  const opSymbol = (op: FilterOp) => FILTER_OPS.find((o) => o.op === op)?.label ?? op;
  return (
    <div className="grid-filter-bar">
      <span className="gfb-label">{t("grid.filterLabel")}</span>
      {filters.map((f, i) => (
        <span className="gfb-chip" key={i} title={`${f.column} ${opSymbol(f.op)} ${f.value ?? "NULL"}`}>
          <b>{f.column}</b> {opSymbol(f.op)} {f.value === null || f.value === undefined ? "NULL" : String(f.value)}
          {onRemoveFilter && (
            <span className="gfb-x" onClick={() => onRemoveFilter(i)} title={t("grid.removeFilter")}>
              <X size={11} />
            </span>
          )}
        </span>
      ))}
      <span className="gfb-and">{t("grid.filterAnd")}</span>
      <div className="toolbar-spacer" style={{ flex: 1 }} />
      {onClearFilter && (
        <span className="gfb-clear" onClick={onClearFilter}>
          {t("data.clearFilter")}
        </span>
      )}
    </div>
  );
}

export interface ResultGridOverlaysProps {
  cols: ColumnMeta[];
  numericCols: boolean[];
  sorts: GridSort[];
  editable: boolean;
  multiCells: boolean;
  editing: boolean;
  bounds: { r0: number; r1: number; c0: number; c1: number } | null;
  columnUpdateActive: boolean;
  aggValues: number[] | null;
  aggFn: AggFn;
  onChangeAggFn: (fn: AggFn) => void;
  aggFloat: { style: CSSProperties; handleProps: HTMLAttributes<HTMLElement> };
  dirtyCount: number;
  colOpsCount: number;
  insertsCount: number;
  deletesCount: number;
  editsCount: number;
  saving: boolean;
  onRevertAll: () => void;
  onSave: () => void;
  headTip: { x: number; y: number; comment?: string; text: string } | null;
  cellMenu: { x: number; y: number; colName: string; value: Cell } | null;
  headerMenu: { x: number; y: number; c: number } | null;
  gutterMenu: { x: number; y: number; vi: number } | null;
  hClip: string;
  active: Pos | null;
  valueAt: (pos: number, c: number) => Cell;
  onCloseMenus: () => void;
  onAddRow: () => void;
  onDeleteRows: (vi: number) => void;
  onCopySelection: () => void;
  onPasteSelection: () => void;
  onAskAi: () => void;
  onFilterByValue?: (columnName: string, value: Cell, op: FilterOp) => void;
  hasFilter?: boolean;
  onClearFilter?: () => void;
  onSortColumn?: (columnName: string, dir: "asc" | "desc") => void;
  onAddSortColumn?: (columnName: string, dir: "asc" | "desc") => void;
  onRemoveSortColumn?: (columnName: string) => void;
  onClearSort?: () => void;
  customFilter: { column: string; op: FilterOp } | null;
  onSetCustomFilter: (next: { column: string; op: FilterOp } | null) => void;
}

export function ResultGridOverlays({
  cols,
  numericCols,
  sorts,
  editable,
  multiCells,
  editing,
  bounds,
  columnUpdateActive,
  aggValues,
  aggFn,
  onChangeAggFn,
  aggFloat,
  dirtyCount,
  colOpsCount,
  insertsCount,
  deletesCount,
  editsCount,
  saving,
  onRevertAll,
  onSave,
  headTip,
  cellMenu,
  headerMenu,
  gutterMenu,
  hClip,
  active,
  valueAt,
  onCloseMenus,
  onAddRow,
  onDeleteRows,
  onCopySelection,
  onPasteSelection,
  onAskAi,
  onFilterByValue,
  hasFilter,
  onClearFilter,
  onSortColumn,
  onAddSortColumn,
  onRemoveSortColumn,
  onClearSort,
  customFilter,
  onSetCustomFilter,
}: ResultGridOverlaysProps) {
  const { t } = useI18n();
  const cellMenuFit = useViewportFit(cellMenu);
  const headerMenuFit = useViewportFit(headerMenu);
  const gutterMenuFit = useViewportFit(gutterMenu);
  const menuValShort = cellMenu ? menuValueLabel(cellMenu.value) : "";

  const filterItems = (colName: string, value: Cell, keyPrefix: string) => {
    const shown = shortFilterVal(value);
    const item = (op: FilterOp, render: string) => (
      <div
        key={keyPrefix + op}
        className="ctx-item mono"
        title={`${colName} ${op} ${cellText(value)}`}
        onClick={() => {
          onFilterByValue?.(colName, value, op);
          onCloseMenus();
        }}
      >
        {render}
      </div>
    );
    return [
      item("=", `${colName} = ${shown}`),
      item("<>", `${colName} ≠ ${shown}`),
      item(">", `${colName} > ${shown}`),
      item("<", `${colName} < ${shown}`),
      item("like", `${colName} LIKE %${shown}%`),
    ];
  };

  return (
    <>
      {multiCells && !editing && bounds && (
        <div className="sel-info">
          <span className="si-count">
            {columnUpdateActive
              ? t("grid.selInfoColumn")
              : t("grid.selInfo", { rows: bounds.r1 - bounds.r0 + 1, cols: bounds.c1 - bounds.c0 + 1 })}
          </span>
          <span className="si-hint">
            {columnUpdateActive
              ? t("grid.selHintColumn")
              : editable
                ? t("grid.selHint")
                : t("grid.selHintReadonly")}
          </span>
        </div>
      )}

      {aggValues && !editing && (
        <div className="agg-info" style={aggFloat.style}>
          <span className="agg-grip" title="拖动换位置 · 双击回到右下角" {...aggFloat.handleProps} />
          <select
            className="agg-fn"
            value={aggFn}
            onChange={(e) => onChangeAggFn(e.target.value as AggFn)}
          >
            <option value="sum">{t("agg.sum")}</option>
            <option value="avg">{t("agg.avg")}</option>
            <option value="median">{t("agg.median")}</option>
            <option value="min">{t("agg.min")}</option>
            <option value="max">{t("agg.max")}</option>
            <option value="count">{t("agg.count")}</option>
          </select>
          <span className="agg-val">{formatAgg(aggregate(aggValues, aggFn))}</span>
          <span className="agg-n">{t("agg.items", { count: aggValues.length })}</span>
        </div>
      )}

      {editable && dirtyCount > 0 && (
        <div className="edit-bar">
          {colOpsCount > 0 && (
            <span className="ec-count col">{t("edit.pendingColumns", { count: colOpsCount })}</span>
          )}
          {insertsCount > 0 && (
            <span className="ec-count add">{t("edit.pendingInserts", { count: insertsCount })}</span>
          )}
          {deletesCount > 0 && (
            <span className="ec-count col">{t("edit.pendingDeletes", { count: deletesCount })}</span>
          )}
          {editsCount > 0 && <span className="ec-count">{t("edit.unsaved", { count: editsCount })}</span>}
          <span className="ec-hint">{t("edit.undoHint")}</span>
          <button className="btn sm" onClick={onRevertAll} disabled={saving}>
            <Undo2 size={14} /> {t("edit.discardAll")}
          </button>
          <button className="btn primary sm" onClick={onSave} disabled={saving}>
            {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
            {t("edit.saveChanges")}
          </button>
        </div>
      )}

      {(cellMenu || headerMenu || gutterMenu) && (
        <div
          className="ctx-backdrop"
          onMouseDown={onCloseMenus}
          onContextMenu={(e) => {
            e.preventDefault();
            onCloseMenus();
          }}
        />
      )}

      {gutterMenu && (
        <div className="ctx-menu" ref={gutterMenuFit.ref} style={gutterMenuFit.style}>
          <div
            className="ctx-item"
            onClick={() => {
              onAddRow();
              onCloseMenus();
            }}
          >
            <Plus size={15} /> {t("edit.addRow")}
          </div>
          <div
            className="ctx-item danger"
            onClick={() => {
              onDeleteRows(gutterMenu.vi);
              onCloseMenus();
            }}
          >
            <Trash2 size={15} /> {t("edit.deleteRow")}
          </div>
        </div>
      )}

      {cellMenu && (
        <div className="ctx-menu" ref={cellMenuFit.ref} style={cellMenuFit.style}>
          <div
            className="ctx-item"
            onClick={() => {
              onCopySelection();
              onCloseMenus();
            }}
          >
            <Copy size={15} /> {t("action.copy")}
          </div>
          {editable && (
            <div
              className="ctx-item"
              onClick={() => {
                onPasteSelection();
                onCloseMenus();
              }}
            >
              <ClipboardPaste size={15} /> {t("action.paste")}
            </div>
          )}
          <div
            className="ctx-item"
            onClick={() => {
              onAskAi();
              onCloseMenus();
            }}
          >
            <Sparkles size={15} /> {t("grid.askAi")}
          </div>
          {onFilterByValue && (
            <>
              <div className="ctx-sep" />
              <div className="ctx-item mono" onClick={() => { onFilterByValue(cellMenu.colName, cellMenu.value, "="); onCloseMenus(); }}>{cellMenu.colName} = {menuValShort}</div>
              <div className="ctx-item mono" onClick={() => { onFilterByValue(cellMenu.colName, cellMenu.value, "<>"); onCloseMenus(); }}>{cellMenu.colName} ≠ {menuValShort}</div>
              <div className="ctx-item mono" onClick={() => { onFilterByValue(cellMenu.colName, cellMenu.value, ">"); onCloseMenus(); }}>{cellMenu.colName} &gt; {menuValShort}</div>
              <div className="ctx-item mono" onClick={() => { onFilterByValue(cellMenu.colName, cellMenu.value, "<"); onCloseMenus(); }}>{cellMenu.colName} &lt; {menuValShort}</div>
              <div className="ctx-item mono" onClick={() => { onFilterByValue(cellMenu.colName, cellMenu.value, "like"); onCloseMenus(); }}>{cellMenu.colName} LIKE %{menuValShort}%</div>
            </>
          )}
          {hasFilter && onClearFilter && (
            <>
              <div className="ctx-sep" />
              <div className="ctx-item" onClick={() => { onClearFilter(); onCloseMenus(); }}>
                <X size={15} /> {t("data.clearFilter")}
              </div>
            </>
          )}
        </div>
      )}

      {headTip &&
        createPortal(
          <div className="gh-tip" style={{ left: headTip.x, top: headTip.y }} role="tooltip">
            {headTip.comment && <div className="gh-tip-comment">{headTip.comment}</div>}
            <div className="gh-tip-meta">{headTip.text}</div>
          </div>,
          document.body,
        )}

      {headerMenu && (
        <div className="ctx-menu wide" ref={headerMenuFit.ref} style={headerMenuFit.style}>
          <div className="ctx-head mono" title={cols[headerMenu.c]?.name}>
            {cols[headerMenu.c]?.name}
          </div>
          <div className="ctx-item" onClick={() => { onSortColumn?.(cols[headerMenu.c].name, "asc"); onCloseMenus(); }}>
            <ArrowUp size={15} /> {t("data.orderAsc")}
          </div>
          <div className="ctx-item" onClick={() => { onSortColumn?.(cols[headerMenu.c].name, "desc"); onCloseMenus(); }}>
            <ArrowDown size={15} /> {t("data.orderDesc")}
          </div>
          {onAddSortColumn && (
            <>
              <div className="ctx-sep" />
              <div className="ctx-item" onClick={() => { onAddSortColumn(cols[headerMenu.c].name, "asc"); onCloseMenus(); }}>
                <ArrowUp size={15} /> {t("data.addOrderAsc")}
              </div>
              <div className="ctx-item" onClick={() => { onAddSortColumn(cols[headerMenu.c].name, "desc"); onCloseMenus(); }}>
                <ArrowDown size={15} /> {t("data.addOrderDesc")}
              </div>
            </>
          )}
          {(onRemoveSortColumn || onClearSort) && <div className="ctx-sep" />}
          {onRemoveSortColumn && sorts.some((item) => item.column === cols[headerMenu.c].name) && (
            <div className="ctx-item" onClick={() => { onRemoveSortColumn(cols[headerMenu.c].name); onCloseMenus(); }}>
              <Minus size={15} /> {t("data.removeColumnSort")}
            </div>
          )}
          {onClearSort && (
            <div className="ctx-item" onClick={() => { onClearSort(); onCloseMenus(); }}>
              <X size={15} /> {onAddSortColumn ? t("data.clearAllSort") : t("data.orderNone")}
            </div>
          )}
          {onFilterByValue && active && (
            <>
              <div className="ctx-sep" />
              <div className="ctx-group">{t("grid.cellValueGroup")}</div>
              {filterItems(cols[headerMenu.c].name, valueAt(active.r, headerMenu.c), "cell-")}
            </>
          )}
          {onFilterByValue && hClip && (
            <>
              <div className="ctx-sep" />
              <div className="ctx-group">{t("grid.clipboardGroup")}</div>
              {filterItems(cols[headerMenu.c].name, coerceFilterValue(hClip, numericCols[headerMenu.c]), "clip-")}
            </>
          )}
          {onFilterByValue && (
            <>
              <div className="ctx-sep" />
              <div className="ctx-group">{t("grid.customGroup")}</div>
              {(["=", "<>", ">", "<", "like"] as FilterOp[]).map((op) => (
                <div
                  key={`custom-${op}`}
                  className="ctx-item mono"
                  onClick={() => {
                    onSetCustomFilter({ column: cols[headerMenu.c].name, op });
                    onCloseMenus();
                  }}
                >
                  {cols[headerMenu.c].name} {op === "like" ? "LIKE" : op} …
                </div>
              ))}
            </>
          )}
          {onFilterByValue && hasFilter && onClearFilter && (
            <>
              <div className="ctx-sep" />
              <div className="ctx-item" onClick={() => { onClearFilter(); onCloseMenus(); }}>
                <X size={15} /> {t("data.clearFilter")}
              </div>
            </>
          )}
        </div>
      )}

      {customFilter && (
        <CustomFilterDialog
          key={`${customFilter.column}:${customFilter.op}`}
          column={customFilter.column}
          op={customFilter.op}
          onClose={() => onSetCustomFilter(null)}
          onApply={(raw) => {
            const column = cols.findIndex((c) => c.name === customFilter.column);
            const number = Number(raw);
            const value =
              customFilter.op !== "like" &&
              numericCols[column] &&
              raw.trim() !== "" &&
              Number.isFinite(number) &&
              (!Number.isInteger(number) || Number.isSafeInteger(number))
                ? number
                : raw;
            onFilterByValue?.(customFilter.column, value, customFilter.op);
            onSetCustomFilter(null);
          }}
        />
      )}
    </>
  );
}
