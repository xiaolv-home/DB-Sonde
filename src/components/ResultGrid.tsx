import type { FilterOp, FilterCond, GridSort } from "../lib/queryResultView";
import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
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
import { parseEditedValue } from "../lib/tableEditing";
import CustomFilterDialog from "./CustomFilterDialog";
import { readClipboardText, writeClipboardText } from "../lib/clipboard";
import type { Cell, EditDraft, QueryResult } from "../types";
import { useAi } from "../features/ai/aiStore";
import { useI18n } from "../hooks/useI18n";
import { useViewportFit } from "../hooks/useViewportFit";
import { maxOf, minOf } from "../lib/numbers";

const DEFAULT_W = 168;
const MIN_W = 56;
const ROW_H = 30;

function classify(v: Cell): { cls: string; text: string } {
  if (v === null || v === undefined) return { cls: "null", text: "NULL" };
  if (typeof v === "number") return { cls: "num", text: String(v) };
  if (typeof v === "boolean") return { cls: "bool", text: v ? "true" : "false" };
  if (typeof v === "object") return { cls: "", text: JSON.stringify(v) };
  return { cls: "", text: String(v) };
}

/** Numeric column types are right-aligned; everything else (char/date) is left. */
const NUMERIC_TYPE = /(^|[^a-z])(int|integer|bigint|smallint|tinyint|mediumint|decimal|numeric|number|dec|float|double|real|money|bit)([^a-z]|$)/i;
function isNumericType(typeName?: string): boolean {
  return !!typeName && NUMERIC_TYPE.test(typeName);
}

/** Plain-text form of a cell for clipboard copy (NULL → empty, like DBeaver). */
function cellText(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function cellsEqual(a: Cell, b: Cell): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined);
  }
  if (typeof a === "object" || typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}


export type { FilterOp, FilterCond, GridSort } from "../lib/queryResultView";
/** The operators offered in the column header's filter form. */
export const FILTER_OPS: { op: FilterOp; label: string }[] = [
  { op: "=", label: "=" },
  { op: "<>", label: "≠" },
  { op: ">", label: ">" },
  { op: ">=", label: "≥" },
  { op: "<", label: "<" },
  { op: "<=", label: "≤" },
  { op: "like", label: "包含" },
];
export type AggFn = "sum" | "avg" | "median" | "min" | "max" | "count";

function aggregate(values: number[], fn: AggFn): number {
  const n = values.length;
  if (n === 0) return 0;
  switch (fn) {
    case "count":
      return n;
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / n;
    // 用循环而不是 Math.min(...values):选中一整列可能是几万行,参数展开会直接 RangeError
    case "min":
      return minOf(values) ?? 0;
    case "max":
      return maxOf(values) ?? 0;
    case "median": {
      const s = [...values].sort((a, b) => a - b);
      const m = Math.floor(n / 2);
      return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    }
  }
}

/** Compact, locale-aware number for the aggregation footer. */
function formatAgg(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

interface Props {
  result: QueryResult;
  editable?: boolean;
  /** Persist all staged cell edits. */
  onSaveEdits?: (edits: EditDraft[]) => Promise<void>;
  /** Persist whole-column updates (every filtered row). Reject to keep staged. */
  onSaveColumns?: (ops: { column: number; value: Cell }[]) => Promise<void>;
  /** Persist added / deleted rows. `deletes` are loaded-row indexes. Reject
   *  (e.g. cancelled confirm) to keep the changes staged. */
  onSaveRowChanges?: (payload: { inserts: Cell[][]; deletes: number[] }) => Promise<void>;
  onEditError?: (message: string) => void;
  /** 按列名给出能否为 NULL(来自表元数据)。决定清空单元格存 NULL 还是 ''。 */
  nullableColumns?: Record<string, boolean>;
  /** 列注释(表定义里的 COMMENT)。有的话,鼠标停在表头上第一行就显示它。 */
  columnComments?: Record<string, string>;
  onDirtyChange?: (dirty: boolean) => void;
  /** Current sort keys. An array preserves SQL precedence; a singleton remains
   *  accepted for query-result grids that sort locally. */
  sort?: GridSort | GridSort[] | null;
  /** Sort a column (from the header right-click menu). */
  onSortColumn?: (columnName: string, dir: "asc" | "desc") => void;
  /** Add or update one key without discarding the existing sort chain. */
  onAddSortColumn?: (columnName: string, dir: "asc" | "desc") => void;
  /** Remove only one key from a multi-column sort chain. */
  onRemoveSortColumn?: (columnName: string) => void;
  /** Clear the current sort ("no sort"). */
  onClearSort?: () => void;
  /** Add a filter condition (AND-combined with any existing ones). */
  onFilterByValue?: (columnName: string, value: Cell, op: FilterOp) => void;
  onClearFilter?: () => void;
  hasFilter?: boolean;
  /** Active filter conditions, shown as removable chips above the grid. */
  filters?: FilterCond[];
  onRemoveFilter?: (index: number) => void;
  /** Called when scrolled near the bottom, to fetch the next page. */
  onLoadMore?: () => void;
  loadingMore?: boolean;
}

interface UndoItem {
  key: string;
  had: boolean;
  value: Cell;
}

/** One undoable step. */
type UndoEntry =
  | { kind: "cells"; items: UndoItem[] }
  | { kind: "col"; column: number; had: boolean; value: Cell; clearedCells: [string, Cell][] }
  | { kind: "addRow"; key: string }
  | { kind: "removeInsert"; row: { key: string; after: number; values: Cell[] } }
  | { kind: "insertCell"; key: string; c: number; prev: Cell }
  | { kind: "markDelete"; indexes: number[] }
  | { kind: "unmarkDelete"; indexes: number[] };

interface Pos {
  r: number;
  c: number;
}

/** A rectangular selection area. Several make up a discontinuous selection. */
interface Rect {
  a: Pos;
  b: Pos;
  full?: boolean;
}

const CANCELLED = "__update_cancelled__";
const cellKey = (r: number, c: number) => `${r}:${c}`;
const rectBounds = (r: Rect) => ({
  r0: Math.min(r.a.r, r.b.r),
  r1: Math.max(r.a.r, r.b.r),
  c0: Math.min(r.a.c, r.b.c),
  c1: Math.max(r.a.c, r.b.c),
});

export default function ResultGrid({
  result,
  editable = false,
  onSaveEdits,
  onSaveColumns,
  onSaveRowChanges,
  onEditError,
  nullableColumns,
  columnComments,
  onDirtyChange,
  sort,
  onSortColumn,
  onAddSortColumn,
  onRemoveSortColumn,
  onClearSort,
  onFilterByValue,
  onClearFilter,
  hasFilter,
  filters,
  onRemoveFilter,
  onLoadMore,
  loadingMore,
}: Props) {
  const { t } = useI18n();
  const parentRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [ranges, setRanges] = useState<Rect[]>([]);
  const [active, setActive] = useState<Pos | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null);
  const [edits, setEdits] = useState<Map<string, Cell>>(new Map());
  const [colOps, setColOps] = useState<Map<number, Cell>>(new Map());
  const [cellMenu, setCellMenu] = useState<{ x: number; y: number; colName: string; value: Cell } | null>(null);
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number; c: number } | null>(null);
  // 表头菜单打开时读一次剪贴板,用来渲染「剪贴板」那组筛选项(对齐 DBeaver)。
  const [customFilter, setCustomFilter] = useState<{ column: string; op: FilterOp } | null>(null);
  const [hClip, setHClip] = useState("");
  const [gutterMenu, setGutterMenu] = useState<{ x: number; y: number; vi: number } | null>(null);
  // 三个右键菜单都按真实尺寸摆位,见 hooks/useViewportFit
  const cellMenuFit = useViewportFit(cellMenu);
  const headerMenuFit = useViewportFit(headerMenu);
  const gutterMenuFit = useViewportFit(gutterMenu);
  const sorts = !sort ? [] : Array.isArray(sort) ? sort : [sort];
  /** Newly-added rows awaiting INSERT. `after` is the loaded-row index they
   *  render below (-1 = above the first loaded row); order is display-only. */
  const [inserts, setInserts] = useState<{ key: string; after: number; values: Cell[] }[]>([]);
  /** Loaded-row indexes marked for DELETE. */
  const [deletes, setDeletes] = useState<Set<number>>(new Set());
  const insertSeq = useRef(0);
  const scrollToKeyRef = useRef<string | null>(null);
  const undoRef = useRef<UndoEntry[]>([]);
  const dragRef = useRef<null | "cell" | "col">(null);
  const anchorRef = useRef<Pos | null>(null);
  const anchorColRef = useRef<number | null>(null);
  const commitGuardRef = useRef(false);
  const suppressLoadRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [aggFn, setAggFn] = useState<AggFn>(() => {
    const stored = localStorage.getItem("aggFn") as AggFn | null;
    return stored ?? "sum";
  });

  const dirtyCount = edits.size + colOps.size + inserts.length + deletes.size;
  useEffect(() => {
    onDirtyChange?.(dirtyCount > 0 || editing !== null);
  }, [dirtyCount, editing, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const cols = result.columns;
  const rows = result.rows;

  useEffect(() => setEditing(null), [rows]);

  // A drag-select ends whenever the mouse is released anywhere.
  useEffect(() => {
    const up = () => {
      dragRef.current = null;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  // Interleave added rows at their anchor to build the visible row order.
  // Each item is a loaded row (`row`) or a pending insert (`ins`, index into
  // `inserts`). Loaded-row edits/deletes stay keyed by loaded index.
  const displayList = useMemo(() => {
    const list: ({ kind: "row"; row: number } | { kind: "ins"; ins: number })[] = [];
    const after = new Map<number, number[]>();
    inserts.forEach((ins, i) => {
      const a = ins.after < 0 || rows.length === 0 ? -1 : Math.min(ins.after, rows.length - 1);
      const at = after.get(a); if (at) at.push(i); else after.set(a, [i]);
    });
    for (const i of after.get(-1) ?? []) list.push({ kind: "ins", ins: i });
    for (let r = 0; r < rows.length; r++) {
      list.push({ kind: "row", row: r });
      for (const i of after.get(r) ?? []) list.push({ kind: "ins", ins: i });
    }
    return list;
  }, [inserts, rows.length]);

  const totalRows = displayList.length;
  /** Loaded-row index for a display position, or -1 for an insert row. */
  const loadedAt = useCallback(
    (pos: number) => {
      const item = displayList[pos];
      return item && item.kind === "row" ? item.row : -1;
    },
    [displayList],
  );
  const insertAt = useCallback(
    (pos: number) => {
      const item = displayList[pos];
      return item && item.kind === "ins" ? item.ins : -1;
    },
    [displayList],
  );

  const virtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 16,
  });

  const gutterW = useMemo(() => {
    const digits = String(totalRows).length;
    return Math.max(46, 22 + digits * 8);
  }, [totalRows]);

  // After adding a row, focus it and bring it into view (without tripping
  // infinite-scroll), once the display list reflects the new insert.
  useEffect(() => {
    const key = scrollToKeyRef.current;
    if (!key) return;
    const pos = displayList.findIndex((it) => it.kind === "ins" && inserts[it.ins]?.key === key);
    if (pos < 0) return;
    scrollToKeyRef.current = null;
    setActive({ r: pos, c: 0 });
    setRanges([{ a: { r: pos, c: 0 }, b: { r: pos, c: 0 } }]);
    suppressLoadRef.current = true;
    requestAnimationFrame(() => {
      virtualizer.scrollToIndex(pos);
      parentRef.current?.focus();
      window.setTimeout(() => {
        suppressLoadRef.current = false;
      }, 300);
    });
  }, [displayList, inserts, virtualizer]);

  const widthOf = useCallback((c: number) => widths[c] ?? DEFAULT_W, [widths]);
  const contentWidth = useMemo(
    () => gutterW + cols.reduce((sum, _c, i) => sum + widthOf(i), 0),
    [cols, gutterW, widthOf],
  );
  // Alignment follows the column's declared type, not each value's runtime type
  // (so a DECIMAL returned as a string still right-aligns).
  const numericCols = useMemo(() => cols.map((c) => isNumericType(c.typeName)), [cols]);
  const nullableCols = useMemo(() => cols.map((c) => nullableColumns?.[c.name]), [cols, nullableColumns]);

  const valueAt = useCallback(
    (pos: number, c: number): Cell => {
      const item = displayList[pos];
      if (!item) return null;
      if (item.kind === "ins") return inserts[item.ins]?.values[c] ?? null;
      const r = item.row;
      if (colOps.has(c)) return colOps.get(c) as Cell;
      const key = cellKey(r, c);
      return edits.has(key) ? (edits.get(key) as Cell) : rows[r]?.[c];
    },
    [displayList, colOps, edits, rows, inserts],
  );
  const isInsertRow = useCallback((pos: number) => insertAt(pos) >= 0, [insertAt]);

  // ---- selection geometry ----
  const inSel = useCallback(
    (r: number, c: number) =>
      ranges.some((rect) => {
        const b = rectBounds(rect);
        return r >= b.r0 && r <= b.r1 && c >= b.c0 && c <= b.c1;
      }),
    [ranges],
  );
  const bounds = useMemo(() => {
    if (!ranges.length) return null;
    let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
    for (const rect of ranges) {
      const b = rectBounds(rect);
      r0 = Math.min(r0, b.r0); r1 = Math.max(r1, b.r1);
      c0 = Math.min(c0, b.c0); c1 = Math.max(c1, b.c1);
    }
    return { r0, r1, c0, c1 };
  }, [ranges]);
  const multiCells =
    !!bounds && (bounds.r0 !== bounds.r1 || bounds.c0 !== bounds.c1 || ranges.length > 1);
  const columnUpdateActive = useMemo(() => {
    if (!onSaveColumns || ranges.length !== 1 || !ranges[0].full) return false;
    const b = rectBounds(ranges[0]);
    return b.c0 === b.c1;
  }, [ranges, onSaveColumns]);
  const colSelected = useCallback(
    (i: number) =>
      ranges.some((rect) => {
        if (!rect.full) return false;
        const b = rectBounds(rect);
        return i >= b.c0 && i <= b.c1;
      }),
    [ranges],
  );

  // Numeric values under a single-line selection (1×n or n×1) drive the
  // aggregation footer. Any non-line or non-numeric selection yields nothing.
  const aggValues = useMemo(() => {
    if (ranges.length !== 1) return null;
    const b = rectBounds(ranges[0]);
    const isLine = b.r0 === b.r1 || b.c0 === b.c1;
    if (!isLine) return null;
    const vals: number[] = [];
    for (let r = b.r0; r <= b.r1; r++) {
      for (let c = b.c0; c <= b.c1; c++) {
        if (!numericCols[c]) continue;
        const v = valueAt(r, c);
        const n = typeof v === "number" ? v : v == null ? NaN : Number(v);
        if (Number.isFinite(n)) vals.push(n);
      }
    }
    return vals.length ? vals : null;
  }, [ranges, numericCols, valueAt]);

  const startResize = (c: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(c);
    const move = (ev: PointerEvent) =>
      setWidths((w) => ({ ...w, [c]: Math.max(MIN_W, startW + (ev.clientX - startX)) }));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const firstVisibleRow = () => virtualizer.getVirtualItems()[0]?.index ?? 0;
  const lastRow = () => Math.max(0, rows.length - 1);

  // ---- cell selection gestures (single, range via shift, discontinuous via ⌘) ----
  const onCellMouseDown = (r: number, c: number, e: React.MouseEvent) => {
    if (e.button === 2) return;
    if (e.shiftKey && anchorRef.current) {
      setRanges([{ a: anchorRef.current, b: { r, c } }]);
      setActive({ r, c });
      dragRef.current = "cell";
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      setRanges((prev) => [...prev, { a: { r, c }, b: { r, c } }]);
    } else {
      setRanges([{ a: { r, c }, b: { r, c } }]);
    }
    anchorRef.current = { r, c };
    setActive({ r, c });
    dragRef.current = "cell";
  };
  const onCellMouseEnter = (r: number, c: number) => {
    if (dragRef.current !== "cell") return;
    setRanges((prev) =>
      prev.length ? [...prev.slice(0, -1), { a: prev[prev.length - 1].a, b: { r, c } }] : prev,
    );
  };

  // Select a whole row by clicking its row-number gutter.
  const selectRow = (r: number) => {
    setRanges([{ a: { r, c: 0 }, b: { r, c: Math.max(0, cols.length - 1) } }]);
    anchorRef.current = { r, c: 0 };
    setActive({ r, c: 0 });
    parentRef.current?.focus();
  };

  // ---- column selection via the header (click = select, no sort) ----
  const columnRect = (c: number): Rect => ({ a: { r: 0, c }, b: { r: lastRow(), c }, full: true });
  const onHeaderMouseDown = (i: number, e: React.MouseEvent) => {
    if (e.button === 2) return;
    if (e.shiftKey && anchorColRef.current != null) {
      setRanges([{ a: { r: 0, c: anchorColRef.current }, b: { r: lastRow(), c: i }, full: true }]);
    } else if (e.metaKey || e.ctrlKey) {
      setRanges((prev) => [...prev, columnRect(i)]);
      anchorColRef.current = i;
    } else {
      setRanges([columnRect(i)]);
      anchorColRef.current = i;
    }
    setActive({ r: firstVisibleRow(), c: i });
    dragRef.current = "col";
    parentRef.current?.focus();
  };
  /* 表头悬停提示:鼠标一进来就出(系统 title 要等一秒多)。按着鼠标(拖选列、拖列宽)时不出。 */
  const [headTip, setHeadTip] = useState<{ x: number; y: number; comment?: string; text: string } | null>(null);
  const showHeadTip = (i: number, e: React.MouseEvent<HTMLDivElement>) => {
    if (e.buttons) { setHeadTip(null); return; }
    const col = cols[i];
    if (!col) return;
    const r = e.currentTarget.getBoundingClientRect();
    const sortIndex = sorts.findIndex((item) => item.column === col.name);
    const text = `${col.name} · ${col.typeName}${sortIndex >= 0 ? ` · ${t("data.sortPriority", { number: sortIndex + 1 })}` : ""}`;
    setHeadTip({ x: Math.max(8, Math.min(r.left, window.innerWidth - 328)), y: r.bottom + 4, comment: columnComments?.[col.name], text });
  };

  const onHeaderMouseEnter = (i: number) => {
    if (dragRef.current !== "col" || anchorColRef.current == null) return;
    setRanges([{ a: { r: 0, c: anchorColRef.current }, b: { r: lastRow(), c: i }, full: true }]);
  };

  // ---- staged cell edits (grouped so one ⌘Z reverts a whole bulk action) ----
  const applyStaged = useCallback(
    (cells: { r: number; c: number; raw: string }[]): boolean => {
      if (!editable || cells.length === 0) return false;
      const parsed: { key: string; value: Cell; orig: Cell }[] = [];
      for (const { r, c, raw } of cells) {
        const orig = rows[r]?.[c];
        let value: Cell;
        try {
          value = parseEditedValue(raw, orig, { number: t("edit.validNumber"), boolean: t("edit.validBoolean") }, numericCols[c], nullableCols[c]);
        } catch (error) {
          onEditError?.(String(error));
          return false;
        }
        parsed.push({ key: cellKey(r, c), value, orig });
      }
      const items: UndoItem[] = parsed.map(({ key, orig }) => ({
        key,
        had: edits.has(key),
        value: edits.has(key) ? (edits.get(key) as Cell) : orig,
      }));
      undoRef.current.push({ kind: "cells", items });
      setEdits((prev) => {
        const next = new Map(prev);
        for (const { key, value, orig } of parsed) {
          if (cellsEqual(value, orig)) next.delete(key);
          else next.set(key, value);
        }
        return next;
      });
      return true;
    },
    [editable, edits, rows, onEditError, t, numericCols, nullableCols],
  );

  const columnSample = useCallback(
    (c: number): Cell => rows.find((row) => row[c] != null)?.[c] ?? rows[0]?.[c] ?? null,
    [rows],
  );

  const setColumnValue = (c: number, raw: string): boolean => {
    let value: Cell;
    try {
      value = parseEditedValue(raw, columnSample(c), { number: t("edit.validNumber"), boolean: t("edit.validBoolean") }, numericCols[c], nullableCols[c]);
    } catch (error) {
      onEditError?.(String(error));
      return false;
    }
    const clearedCells = [...edits].filter(([key]) => Number(key.split(":")[1]) === c);
    undoRef.current.push({
      kind: "col",
      column: c,
      had: colOps.has(c),
      value: colOps.has(c) ? (colOps.get(c) as Cell) : null,
      clearedCells,
    });
    setColOps((prev) => new Map(prev).set(c, value));
    if (clearedCells.length) {
      setEdits((prev) => {
        const next = new Map(prev);
        for (const [key] of clearedCells) next.delete(key);
        return next;
      });
    }
    return true;
  };

  /** All selected LOADED cells, addressed by loaded-row index (insert rows edit
   *  their own value store, so they are skipped here). */
  const selectedTargets = (raw: string) => {
    const out: { r: number; c: number; raw: string }[] = [];
    if (!bounds) return out;
    for (let pos = bounds.r0; pos <= bounds.r1; pos++) {
      const loaded = loadedAt(pos);
      if (loaded < 0) continue;
      for (let c = bounds.c0; c <= bounds.c1; c++) if (inSel(pos, c)) out.push({ r: loaded, c, raw });
    }
    return out;
  };

  // ---- added / deleted rows ----
  const parseForColumn = (raw: string, c: number): Cell => {
    const s = raw.trim();
    if (s === "" || s.toUpperCase() === "NULL") return null;
    if (numericCols[c]) {
      const n = Number(s);
      if (Number.isFinite(n)) return Number.isInteger(n) && !Number.isSafeInteger(n) ? s : n;
    }
    return raw;
  };
  const setInsertCell = (pos: number, c: number, raw: string) => {
    const row = inserts[insertAt(pos)];
    if (!row) return;
    undoRef.current.push({ kind: "insertCell", key: row.key, c, prev: row.values[c] });
    setInserts((prev) =>
      prev.map((rw) =>
        rw.key === row.key ? { ...rw, values: rw.values.map((v, ci) => (ci === c ? parseForColumn(raw, c) : v)) } : rw,
      ),
    );
  };
  /** Add a blank row right below the active/first-visible loaded row. Display
   *  order only — the eventual INSERT is order-independent. */
  const addRow = () => {
    const key = `ins-${insertSeq.current++}`;
    let after = active ? loadedAt(active.r) : -1;
    if (after < 0) {
      const firstVisible = virtualizer.getVirtualItems()[0]?.index ?? 0;
      const loaded = loadedAt(firstVisible);
      after = loaded >= 0 ? loaded : rows.length - 1;
    }
    undoRef.current.push({ kind: "addRow", key });
    setInserts((prev) => [...prev, { key, after, values: cols.map(() => null) }]);
    scrollToKeyRef.current = key;
  };
  const deleteRows = (pos: number) => {
    if (isInsertRow(pos)) {
      const row = inserts[insertAt(pos)];
      if (!row) return;
      undoRef.current.push({ kind: "removeInsert", row });
      setInserts((prev) => prev.filter((r) => r.key !== row.key));
      return;
    }
    const targets = new Set<number>();
    if (bounds) {
      for (let p = bounds.r0; p <= bounds.r1; p++) {
        const loaded = loadedAt(p);
        if (loaded < 0) continue;
        for (let c = bounds.c0; c <= bounds.c1; c++) {
          if (inSel(p, c)) {
            targets.add(loaded);
            break;
          }
        }
      }
    }
    const clicked = loadedAt(pos);
    if (clicked >= 0 && !targets.has(clicked)) targets.add(clicked);
    const indexes = [...targets];
    if (!indexes.length) return;
    const allMarked = indexes.every((r) => deletes.has(r));
    undoRef.current.push({ kind: allMarked ? "unmarkDelete" : "markDelete", indexes });
    setDeletes((prev) => {
      const next = new Set(prev);
      for (const r of indexes) {
        if (allMarked) next.delete(r);
        else next.add(r);
      }
      return next;
    });
  };

  const stageEdit = (pos: number, c: number, raw: string, fillSelection = false) => {
    if (isInsertRow(pos)) {
      setInsertCell(pos, c, raw);
      setEditing(null);
      return;
    }
    if (fillSelection && columnUpdateActive && bounds) {
      setColumnValue(bounds.c0, raw);
      setEditing(null);
      return;
    }
    const loaded = loadedAt(pos);
    applyStaged(fillSelection ? selectedTargets(raw) : loaded >= 0 ? [{ r: loaded, c, raw }] : []);
    setEditing(null);
  };

  const clearSelection = () => {
    if (!editable || !bounds) return;
    if (columnUpdateActive) {
      setColumnValue(bounds.c0, "NULL");
      return;
    }
    applyStaged(selectedTargets("NULL"));
  };

  const undo = useCallback(() => {
    const entry = undoRef.current.pop();
    if (!entry) return;
    switch (entry.kind) {
      case "cells":
        setEdits((prev) => {
          const next = new Map(prev);
          for (const item of entry.items) {
            if (item.had) next.set(item.key, item.value);
            else next.delete(item.key);
          }
          return next;
        });
        return;
      case "col":
        setColOps((prev) => {
          const next = new Map(prev);
          if (entry.had) next.set(entry.column, entry.value);
          else next.delete(entry.column);
          return next;
        });
        if (entry.clearedCells.length) {
          setEdits((prev) => {
            const next = new Map(prev);
            for (const [key, value] of entry.clearedCells) next.set(key, value);
            return next;
          });
        }
        return;
      case "addRow":
        setInserts((prev) => prev.filter((r) => r.key !== entry.key));
        return;
      case "removeInsert":
        setInserts((prev) => [...prev, entry.row]);
        return;
      case "insertCell":
        setInserts((prev) =>
          prev.map((r) =>
            r.key === entry.key ? { ...r, values: r.values.map((v, ci) => (ci === entry.c ? entry.prev : v)) } : r,
          ),
        );
        return;
      case "markDelete":
        setDeletes((prev) => {
          const next = new Set(prev);
          for (const i of entry.indexes) next.delete(i);
          return next;
        });
        return;
      case "unmarkDelete":
        setDeletes((prev) => {
          const next = new Set(prev);
          for (const i of entry.indexes) next.add(i);
          return next;
        });
        return;
    }
  }, []);

  const revertAll = () => {
    undoRef.current = [];
    setEdits(new Map());
    setColOps(new Map());
    setInserts([]);
    setDeletes(new Set());
  };

  // ---- clipboard ----
  const copySelection = useCallback(() => {
    if (!bounds) return;
    const lines: string[] = [];
    for (let r = bounds.r0; r <= bounds.r1; r++) {
      const cells: string[] = [];
      for (let c = bounds.c0; c <= bounds.c1; c++) cells.push(inSel(r, c) ? cellText(valueAt(r, c)) : "");
      lines.push(cells.join("\t"));
    }
    void writeClipboardText(lines.join("\n"));
  }, [bounds, inSel, valueAt]);

  // Serialize the selection (header + up to 50 rows) to hand to the AI for a
  // read-only interpretation of the numbers.
  const askAiAboutSelection = () => {
    if (!bounds) return;
    const header: string[] = [];
    for (let c = bounds.c0; c <= bounds.c1; c++) header.push(cols[c]?.name ?? `col${c}`);
    const rows: string[] = [header.join("\t")];
    for (let r = bounds.r0; r <= Math.min(bounds.r1, bounds.r0 + 49); r++) {
      const cells: string[] = [];
      for (let c = bounds.c0; c <= bounds.c1; c++) cells.push(inSel(r, c) ? cellText(valueAt(r, c)) : "");
      rows.push(cells.join("\t"));
    }
    useAi.getState().seedAsk(
      `请解读下面这组查询结果(只读分析,不要改数据),用中文总结规律、异常或值得注意的点:\n\`\`\`\n${rows.join("\n")}\n\`\`\``,
    );
  };

  const pasteSelection = useCallback(async () => {
    if (!editable || !active) return;
    const text = await readClipboardText();
    if (text === "") return;
    const grid = text.replace(/\r\n?/g, "\n").split("\n");
    if (grid.length > 1 && grid[grid.length - 1] === "") grid.pop();
    const matrix = grid.map((line) => line.split("\t"));
    const single = matrix.length === 1 && matrix[0].length === 1;

    if (single && columnUpdateActive && bounds) {
      setColumnValue(bounds.c0, matrix[0][0]);
      return;
    }
    if (single && multiCells) {
      applyStaged(selectedTargets(matrix[0][0]));
      return;
    }
    const targets: { r: number; c: number; raw: string }[] = [];
    /* 落不下的格子要**数出来告诉用户**。粘 100 行只落了 40 行、剩下的悄悄丢掉,
       界面上看可见的那部分是好的 —— 人就以为整块都贴进去了。
       两种落不下:超出表格边界(行数/列数不够),以及那一行还没加载进来。 */
    let outside = 0;
    let unloaded = 0;
    for (let i = 0; i < matrix.length; i++)
      for (let j = 0; j < matrix[i].length; j++) {
        const pos = active.r + i;
        const c = active.c + j;
        if (pos >= totalRows || c >= cols.length) { outside += 1; continue; }
        const loaded = loadedAt(pos);
        if (loaded < 0) { unloaded += 1; continue; }
        targets.push({ r: loaded, c, raw: matrix[i][j] });
      }
    if (outside || unloaded) {
      const why = [
        outside ? `${outside} 个超出了表格范围(行数或列数不够)` : "",
        unloaded ? `${unloaded} 个所在的行还没加载进来(往下滚动把它们读出来再贴)` : "",
      ].filter(Boolean).join(";");
      onEditError?.(`粘贴的 ${matrix.length}×${matrix[0].length} 里有 ${outside + unloaded} 个格子没贴上:${why}。`);
    }
    const lastR = Math.min(active.r + matrix.length - 1, totalRows - 1);
    const lastC = Math.min(active.c + matrix[0].length - 1, cols.length - 1);
    if (targets.length) setRanges([{ a: { r: active.r, c: active.c }, b: { r: lastR, c: lastC } }]);
    applyStaged(targets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, active, bounds, multiCells, columnUpdateActive, totalRows, cols.length, applyStaged, onEditError]);

  const save = useCallback(async () => {
    if (saving || dirtyCount === 0) return;
    setSaving(true);
    try {
      if (colOps.size > 0 && onSaveColumns) {
        await onSaveColumns([...colOps].map(([column, value]) => ({ column, value })));
      }
      if (edits.size > 0 && onSaveEdits) {
        const drafts: EditDraft[] = [];
        for (const [key, newValue] of edits) {
          const [r, c] = key.split(":").map(Number);
          drafts.push({ row: r, column: c, oldValue: rows[r]?.[c], newValue });
        }
        await onSaveEdits(drafts);
      }
      if ((inserts.length > 0 || deletes.size > 0) && onSaveRowChanges) {
        await onSaveRowChanges({ inserts: inserts.map((row) => row.values), deletes: [...deletes] });
      }
      setEdits(new Map());
      setColOps(new Map());
      setInserts([]);
      setDeletes(new Set());
      undoRef.current = [];
    } catch (error) {
      if (!String(error).includes(CANCELLED)) onEditError?.(String(error));
    } finally {
      setSaving(false);
    }
  }, [saving, dirtyCount, edits, colOps, inserts, deletes, onSaveEdits, onSaveColumns, onSaveRowChanges, rows, onEditError]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "c") {
      copySelection();
      e.preventDefault();
      return;
    }
    if (editable && mod && e.key.toLowerCase() === "v") {
      void pasteSelection();
      e.preventDefault();
      return;
    }
    if (editable && mod && e.key.toLowerCase() === "z") {
      undo();
      e.preventDefault();
      return;
    }
    if (editable && mod && e.key.toLowerCase() === "s") {
      void save();
      e.preventDefault();
      return;
    }
    if (!active) return;
    if (editable && (e.key === "Delete" || e.key === "Backspace") && bounds) {
      clearSelection();
      e.preventDefault();
      return;
    }
    if (editable && e.key === "Enter") {
      const { text } = classify(valueAt(active.r, active.c));
      setEditing({ r: active.r, c: active.c, value: text === "NULL" ? "" : text });
      e.preventDefault();
      return;
    }
    if (editable && !mod && !e.altKey && e.key.length === 1) {
      setEditing({ r: active.r, c: active.c, value: e.key });
      e.preventDefault();
    }
  };

  const handleScroll = () => {
    const el = parentRef.current;
    if (!el || !onLoadMore || loadingMore || suppressLoadRef.current) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 320) onLoadMore();
  };

  const openCellMenu = (r: number, c: number, e: React.MouseEvent) => {
    e.preventDefault();
    if (!inSel(r, c)) {
      setRanges([{ a: { r, c }, b: { r, c } }]);
      anchorRef.current = { r, c };
      setActive({ r, c });
    }
    setCellMenu({ x: e.clientX, y: e.clientY, colName: cols[c].name, value: valueAt(r, c) });
  };

  const menuVal = cellMenu ? cellText(cellMenu.value) : "";
  const menuValShort = cellMenu
    ? cellMenu.value == null
      ? "NULL"
      : menuVal.length > 18
        ? `${menuVal.slice(0, 18)}…`
        : menuVal
    : "";

  // Coerce a typed filter value: numeric columns get a real number (so the
  // server-side path stays unquoted and client-side compares numerically).
  const coerceFilterValue = (raw: string, c: number): Cell => {
    const s = raw.trim();
    if (s === "") return "";
    if (s.toUpperCase() === "NULL") return null;
    if (numericCols[c] && Number.isFinite(Number(s))) {
      const n = Number(s);
      return Number.isInteger(n) && !Number.isSafeInteger(n) ? s : n;
    }
    return raw;
  };
  /** 值的短显示:太长就中间省略,避免菜单被撑爆。 */
  const shortFilterVal = (value: Cell) => {
    if (value == null) return "NULL";
    const text = cellText(value);
    return text.length > 22 ? `${text.slice(0, 10)} … ${text.slice(-9)}` : text;
  };
  /** DBeaver 风格的筛选项:点一下直接生效,不用再选操作符、也没有「添加」按钮。 */
  const filterItems = (colName: string, value: Cell, keyPrefix: string) => {
    const shown = shortFilterVal(value);
    const item = (op: FilterOp, render: string) => (
      <div
        key={keyPrefix + op}
        className="ctx-item mono"
        title={`${colName} ${op} ${cellText(value)}`}
        onClick={() => { onFilterByValue?.(colName, value, op); setHeaderMenu(null); }}
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

  const opSymbol = (op: FilterOp) => FILTER_OPS.find((o) => o.op === op)?.label ?? op;

  const items = virtualizer.getVirtualItems();

  return (
    <div className="grid-wrap" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
    {filters && filters.length > 0 && (
      <div className="grid-filter-bar">
        <span className="gfb-label">筛选</span>
        {filters.map((f, i) => (
          <span className="gfb-chip" key={i} title={`${f.column} ${opSymbol(f.op)} ${f.value ?? "NULL"}`}>
            <b>{f.column}</b> {opSymbol(f.op)} {f.value === null || f.value === undefined ? "NULL" : String(f.value)}
            {onRemoveFilter && (
              <span className="gfb-x" onClick={() => onRemoveFilter(i)} title="移除这一条">
                <X size={11} />
              </span>
            )}
          </span>
        ))}
        <span className="gfb-and">AND 连接</span>
        <div className="toolbar-spacer" style={{ flex: 1 }} />
        {onClearFilter && (
          <span className="gfb-clear" onClick={onClearFilter}>
            清除全部
          </span>
        )}
      </div>
    )}
    <div
      className={`grid ${editable ? "editable" : ""}`}
      ref={parentRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onScroll={() => { if (headTip) setHeadTip(null); handleScroll(); }}
      style={{ position: "relative", inset: "auto", flex: 1, minHeight: 0 }}
    >
      <div className="grid-inner" style={{ width: contentWidth }}>
        <div className="grid-head">
          <div className="gh-gutter" style={{ width: gutterW }}>
            #
          </div>
          {cols.map((col, i) => {
            const sortIndex = sorts.findIndex((item) => item.column === col.name);
            const sorted = sortIndex >= 0 ? sorts[sortIndex].dir : null;
            return (
              <div
                className={`gh-cell selectable ${sorted ? "sorted" : ""} ${colSelected(i) ? "colsel" : ""}`}
                key={i}
                style={{ width: widthOf(i) }}
                onMouseDown={(e) => { setHeadTip(null); onHeaderMouseDown(i, e); }}
                onMouseEnter={(e) => { onHeaderMouseEnter(i); showHeadTip(i, e); }}
                onMouseLeave={() => setHeadTip(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setHeadTip(null);
                  setHeaderMenu({ x: e.clientX, y: e.clientY, c: i });
                  setHClip("");
                  void readClipboardText().then((text) => setHClip(text.trim()));
                }}
              >
                <span className="gh-name">{col.name}</span>
                <span className="gh-type">{col.typeName}</span>
                {sorted && <span className="gh-sort">{sorted === "asc" ? <ChevronUp size={13} /> : <ChevronDown size={13} />}<b>{sortIndex + 1}</b></span>}
                <div
                  className="col-resizer"
                  onPointerDown={(e) => startResize(i, e)}
                  onMouseDown={(e) => e.stopPropagation()}
                />
              </div>
            );
          })}
        </div>

        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {items.map((vr) => {
            const loaded = loadedAt(vr.index);
            const inserted = loaded < 0;
            const deleted = loaded >= 0 && deletes.has(loaded);
            return (
            <div
              className={`g-row ${inserted ? "insert" : ""} ${deleted ? "delete" : ""}`}
              key={vr.key}
              style={{ position: "absolute", top: vr.start, left: 0, height: ROW_H, width: contentWidth }}
            >
              <div
                className="g-gutter"
                style={{ width: gutterW }}
                title={inserted ? "" : String(loaded + 1)}
                onMouseDown={(e) => {
                  if (e.button === 2) return;
                  selectRow(vr.index);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!inSel(vr.index, 0)) selectRow(vr.index);
                  setGutterMenu({ x: e.clientX, y: e.clientY, vi: vr.index });
                }}
              >
                {inserted ? "＋" : loaded + 1}
              </div>
              {cols.map((_c, ci) => {
                const dirty = loaded >= 0 && (colOps.has(ci) || edits.has(cellKey(loaded, ci)));
                const { cls, text } = classify(valueAt(vr.index, ci));
                const selected = inSel(vr.index, ci);
                const isFocus = active?.r === vr.index && active?.c === ci;
                const isEditing = editing?.r === vr.index && editing.c === ci;
                return (
                  <div
                    key={ci}
                    className={`g-cell ${cls} ${numericCols[ci] ? "right" : ""} ${selected ? "selected" : ""} ${isFocus ? "focus" : ""} ${dirty ? "dirty" : ""}`}
                    style={{ width: widthOf(ci) }}
                    title={!isEditing && text.length > 40 ? text : undefined}
                    onMouseDown={(e) => onCellMouseDown(vr.index, ci, e)}
                    onMouseEnter={() => onCellMouseEnter(vr.index, ci)}
                    onDoubleClick={() => {
                      if (editable) {
                        setActive({ r: vr.index, c: ci });
                        setEditing({ r: vr.index, c: ci, value: text === "NULL" ? "" : text });
                      }
                    }}
                    onContextMenu={(e) => openCellMenu(vr.index, ci, e)}
                  >
                    {isEditing ? (
                      <input
                        className="cell-editor"
                        value={editing.value}
                        autoFocus
                        onChange={(event) => setEditing({ ...editing, value: event.target.value })}
                        onBlur={() => {
                          if (commitGuardRef.current) {
                            commitGuardRef.current = false;
                            return;
                          }
                          stageEdit(vr.index, ci, editing.value, multiCells);
                        }}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === "Enter") {
                            commitGuardRef.current = true;
                            stageEdit(vr.index, ci, editing.value, multiCells);
                          }
                          if (event.key === "Escape") {
                            commitGuardRef.current = true;
                            setEditing(null);
                          }
                        }}
                      />
                    ) : (
                      text
                    )}
                  </div>
                );
              })}
            </div>
            );
          })}
        </div>
      </div>
      </div>

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
        <div className="agg-info">
          <select
            className="agg-fn"
            value={aggFn}
            onChange={(e) => {
              const fn = e.target.value as AggFn;
              setAggFn(fn);
              localStorage.setItem("aggFn", fn);
            }}
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
          {colOps.size > 0 && (
            <span className="ec-count col">{t("edit.pendingColumns", { count: colOps.size })}</span>
          )}
          {inserts.length > 0 && <span className="ec-count add">{t("edit.pendingInserts", { count: inserts.length })}</span>}
          {deletes.size > 0 && <span className="ec-count col">{t("edit.pendingDeletes", { count: deletes.size })}</span>}
          {edits.size > 0 && <span className="ec-count">{t("edit.unsaved", { count: edits.size })}</span>}
          <span className="ec-hint">{t("edit.undoHint")}</span>
          <button className="btn sm" onClick={revertAll} disabled={saving}>
            <Undo2 size={14} /> {t("edit.discardAll")}
          </button>
          <button className="btn primary sm" onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
            {t("edit.saveChanges")}
          </button>
        </div>
      )}

      {(cellMenu || headerMenu || gutterMenu) && (
        <div
          className="ctx-backdrop"
          onMouseDown={() => {
            setCellMenu(null);
            setHeaderMenu(null);
            setGutterMenu(null);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setCellMenu(null);
            setHeaderMenu(null);
            setGutterMenu(null);
          }}
        />
      )}

      {gutterMenu && (
        <div className="ctx-menu" ref={gutterMenuFit.ref} style={gutterMenuFit.style}>
          <div className="ctx-item" onClick={() => { addRow(); setGutterMenu(null); }}>
            <Plus size={15} /> {t("edit.addRow")}
          </div>
          <div className="ctx-item danger" onClick={() => { deleteRows(gutterMenu.vi); setGutterMenu(null); }}>
            <Trash2 size={15} /> {t("edit.deleteRow")}
          </div>
        </div>
      )}

      {cellMenu && (
        <div className="ctx-menu" ref={cellMenuFit.ref} style={cellMenuFit.style}>
          <div className="ctx-item" onClick={() => { copySelection(); setCellMenu(null); }}>
            <Copy size={15} /> {t("action.copy")}
          </div>
          {editable && (
            <div className="ctx-item" onClick={() => { void pasteSelection(); setCellMenu(null); }}>
              <ClipboardPaste size={15} /> {t("action.paste")}
            </div>
          )}
          <div className="ctx-item" onClick={() => { askAiAboutSelection(); setCellMenu(null); }}>
            <Sparkles size={15} /> AI 解读
          </div>
          {onFilterByValue && (
            <>
              <div className="ctx-sep" />
              <div className="ctx-item mono" onClick={() => { onFilterByValue(cellMenu.colName, cellMenu.value, "="); setCellMenu(null); }}>{cellMenu.colName} = {menuValShort}</div>
              <div className="ctx-item mono" onClick={() => { onFilterByValue(cellMenu.colName, cellMenu.value, "<>"); setCellMenu(null); }}>{cellMenu.colName} ≠ {menuValShort}</div>
              <div className="ctx-item mono" onClick={() => { onFilterByValue(cellMenu.colName, cellMenu.value, ">"); setCellMenu(null); }}>{cellMenu.colName} &gt; {menuValShort}</div>
              <div className="ctx-item mono" onClick={() => { onFilterByValue(cellMenu.colName, cellMenu.value, "<"); setCellMenu(null); }}>{cellMenu.colName} &lt; {menuValShort}</div>
              <div className="ctx-item mono" onClick={() => { onFilterByValue(cellMenu.colName, cellMenu.value, "like"); setCellMenu(null); }}>{cellMenu.colName} LIKE %{menuValShort}%</div>
            </>
          )}
          {hasFilter && onClearFilter && (
            <>
              <div className="ctx-sep" />
              <div className="ctx-item" onClick={() => { onClearFilter(); setCellMenu(null); }}>
                <X size={15} /> {t("data.clearFilter")}
              </div>
            </>
          )}
        </div>
      )}

      {headTip && createPortal(
        <div className="gh-tip" style={{ left: headTip.x, top: headTip.y }} role="tooltip">
          {headTip.comment && <div className="gh-tip-comment">{headTip.comment}</div>}
          <div className="gh-tip-meta">{headTip.text}</div>
        </div>,
        document.body,
      )}
      {headerMenu && (
        <div className="ctx-menu wide" ref={headerMenuFit.ref} style={headerMenuFit.style}>
          <div className="ctx-head mono" title={cols[headerMenu.c]?.name}>{cols[headerMenu.c]?.name}</div>
          <div className="ctx-item" onClick={() => { onSortColumn?.(cols[headerMenu.c].name, "asc"); setHeaderMenu(null); }}>
            <ArrowUp size={15} /> {t("data.orderAsc")}
          </div>
          <div className="ctx-item" onClick={() => { onSortColumn?.(cols[headerMenu.c].name, "desc"); setHeaderMenu(null); }}>
            <ArrowDown size={15} /> {t("data.orderDesc")}
          </div>
          {onAddSortColumn && <>
            <div className="ctx-sep" />
            <div className="ctx-item" onClick={() => { onAddSortColumn(cols[headerMenu.c].name, "asc"); setHeaderMenu(null); }}>
              <ArrowUp size={15} /> {t("data.addOrderAsc")}
            </div>
            <div className="ctx-item" onClick={() => { onAddSortColumn(cols[headerMenu.c].name, "desc"); setHeaderMenu(null); }}>
              <ArrowDown size={15} /> {t("data.addOrderDesc")}
            </div>
          </>}
          {(onRemoveSortColumn || onClearSort) && <div className="ctx-sep" />}
          {onRemoveSortColumn && sorts.some((item) => item.column === cols[headerMenu.c].name) && (
            <div className="ctx-item" onClick={() => { onRemoveSortColumn(cols[headerMenu.c].name); setHeaderMenu(null); }}>
              <Minus size={15} /> {t("data.removeColumnSort")}
            </div>
          )}
          {onClearSort && <div className="ctx-item" onClick={() => { onClearSort(); setHeaderMenu(null); }}>
            <X size={15} /> {onAddSortColumn ? t("data.clearAllSort") : t("data.orderNone")}
          </div>}
          {onFilterByValue && active && (
            <>
              <div className="ctx-sep" />
              <div className="ctx-group">单元格的值</div>
              {filterItems(cols[headerMenu.c].name, valueAt(active.r, headerMenu.c), "cell-")}
            </>
          )}
          {onFilterByValue && hClip && (
            <>
              <div className="ctx-sep" />
              <div className="ctx-group">剪贴板</div>
              {filterItems(cols[headerMenu.c].name, coerceFilterValue(hClip, headerMenu.c), "clip-")}
            </>
          )}
          {onFilterByValue && <>
            <div className="ctx-sep"/><div className="ctx-group">自定义</div>
            {(["=", "<>", ">", "<", "like"] as FilterOp[]).map(op=><div key={`custom-${op}`} className="ctx-item mono" onClick={()=>{setCustomFilter({column:cols[headerMenu.c].name,op});setHeaderMenu(null);}}>{cols[headerMenu.c].name} {op === "like" ? "LIKE" : op} …</div>)}
          </>}
          {onFilterByValue && hasFilter && onClearFilter && (
            <>
              <div className="ctx-sep" />
              <div className="ctx-item" onClick={() => { onClearFilter(); setHeaderMenu(null); }}>
                <X size={15} /> 清除全部筛选
              </div>
            </>
          )}
        </div>
      )}
      {customFilter && <CustomFilterDialog key={`${customFilter.column}:${customFilter.op}`} column={customFilter.column} op={customFilter.op} onClose={()=>setCustomFilter(null)} onApply={raw=>{
        const column=cols.findIndex(c=>c.name===customFilter.column);
        const number=Number(raw);
        const value=customFilter.op!=="like" && numericCols[column] && raw.trim()!=="" && Number.isFinite(number) && (!Number.isInteger(number)||Number.isSafeInteger(number)) ? number : raw;
        onFilterByValue?.(customFilter.column,value,customFilter.op);setCustomFilter(null);
      }}/>}
    </div>
  );
}
