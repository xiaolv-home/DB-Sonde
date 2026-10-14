/* 结果表格(ResultGrid)里和 React 无关的那部分:单元格怎么显示 / 复制、选区几何、
 * 行的显示顺序(待插入的行穿插在已加载行之间)、求和条取值、粘贴文本拆格子、值的类型转换、撤销记录的形状。
 * 都是纯函数,组件只管状态和事件。 */
import type { FilterOp } from "../lib/queryResultView";
import type { Cell } from "../types";
import { maxOf, minOf } from "../lib/numbers";

export const DEFAULT_W = 168;
export const MIN_W = 56;
export const ROW_H = 30;
/** onSave* 回调用这个字样拒绝 = 用户在确认框里点了取消,不算出错。 */
export const CANCELLED = "__update_cancelled__";

// ---- 单元格 ----

export function classify(v: Cell): { cls: string; text: string } {
  if (v === null || v === undefined) return { cls: "null", text: "NULL" };
  if (typeof v === "number") return { cls: "num", text: String(v) };
  if (typeof v === "boolean") return { cls: "bool", text: v ? "true" : "false" };
  if (typeof v === "object") return { cls: "", text: JSON.stringify(v) };
  return { cls: "", text: String(v) };
}

/** Numeric column types are right-aligned; everything else (char/date) is left. */
const NUMERIC_TYPE = /(^|[^a-z])(int|integer|bigint|smallint|tinyint|mediumint|decimal|numeric|number|dec|float|double|real|money|bit)([^a-z]|$)/i;
export function isNumericType(typeName?: string): boolean {
  return !!typeName && NUMERIC_TYPE.test(typeName);
}

/** Plain-text form of a cell for clipboard copy (NULL → empty, like DBeaver). */
export function cellText(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function cellsEqual(a: Cell, b: Cell): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a === null || a === undefined) && (b === null || b === undefined);
  }
  if (typeof a === "object" || typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/** 新加的行里输入的值:空 / NULL → NULL;数值列转成数(超出安全整数范围的大整数留字符串,免得丢精度)。 */
export function parseInsertValue(raw: string, numeric: boolean): Cell {
  const s = raw.trim();
  if (s === "" || s.toUpperCase() === "NULL") return null;
  if (numeric) {
    const n = Number(s);
    if (Number.isFinite(n)) return Number.isInteger(n) && !Number.isSafeInteger(n) ? s : n;
  }
  return raw;
}

/** 筛选框里输入的值:数值列给真正的数(服务端那条路就不加引号,本地比较也按数比)。空串保持空串。 */
export function coerceFilterValue(raw: string, numeric: boolean): Cell {
  const s = raw.trim();
  if (s === "") return "";
  if (s.toUpperCase() === "NULL") return null;
  if (numeric && Number.isFinite(Number(s))) {
    const n = Number(s);
    return Number.isInteger(n) && !Number.isSafeInteger(n) ? s : n;
  }
  return raw;
}

/** 值的短显示:太长就中间省略,避免菜单被撑爆。 */
export function shortFilterVal(value: Cell): string {
  if (value == null) return "NULL";
  const text = cellText(value);
  return text.length > 22 ? `${text.slice(0, 10)} … ${text.slice(-9)}` : text;
}

/** 右键菜单标题里的值:NULL 照写,长了截到 18 个字。 */
export function menuValueLabel(value: Cell): string {
  if (value == null) return "NULL";
  const text = cellText(value);
  return text.length > 18 ? `${text.slice(0, 18)}…` : text;
}

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

// ---- 求和条 ----

export type AggFn = "sum" | "avg" | "median" | "min" | "max" | "count";

export function aggregate(values: number[], fn: AggFn): number {
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
export function formatAgg(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

// ---- 选区 ----

export interface Pos {
  r: number;
  c: number;
}

/** A rectangular selection area. Several make up a discontinuous selection. */
export interface Rect {
  a: Pos;
  b: Pos;
  full?: boolean;
}

export interface Bounds {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

export const cellKey = (r: number, c: number) => `${r}:${c}`;
export const rectBounds = (r: Rect): Bounds => ({
  r0: Math.min(r.a.r, r.b.r),
  r1: Math.max(r.a.r, r.b.r),
  c0: Math.min(r.a.c, r.b.c),
  c1: Math.max(r.a.c, r.b.c),
});

export function inRanges(ranges: Rect[], r: number, c: number): boolean {
  return ranges.some((rect) => {
    const b = rectBounds(rect);
    return r >= b.r0 && r <= b.r1 && c >= b.c0 && c <= b.c1;
  });
}

/** 所有选区合起来的外接矩形;没选东西是 null。 */
export function selectionBounds(ranges: Rect[]): Bounds | null {
  if (!ranges.length) return null;
  let r0 = Infinity, r1 = -Infinity, c0 = Infinity, c1 = -Infinity;
  for (const rect of ranges) {
    const b = rectBounds(rect);
    r0 = Math.min(r0, b.r0); r1 = Math.max(r1, b.r1);
    c0 = Math.min(c0, b.c0); c1 = Math.max(c1, b.c1);
  }
  return { r0, r1, c0, c1 };
}

/** 整列选中(点表头)里有没有第 i 列。 */
export function columnInRanges(ranges: Rect[], i: number): boolean {
  return ranges.some((rect) => {
    if (!rect.full) return false;
    const b = rectBounds(rect);
    return i >= b.c0 && i <= b.c1;
  });
}

/** Numeric values under a single-line selection (1×n or n×1) drive the
 *  aggregation footer. Any non-line or non-numeric selection yields nothing. */
export function lineAggregateValues(ranges: Rect[], numericCols: boolean[], valueAt: (r: number, c: number) => Cell): number[] | null {
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
}

// ---- 复制 / 粘贴 ----

/** 选区外接矩形里第 r0..r1 行,一行一串制表符分隔;不在选区里的格子(不连续选区的空洞)留空。 */
export function selectionTsvLines(b: Bounds, r1: number, inSel: (r: number, c: number) => boolean, valueAt: (r: number, c: number) => Cell): string[] {
  const lines: string[] = [];
  for (let r = b.r0; r <= r1; r++) {
    const cells: string[] = [];
    for (let c = b.c0; c <= b.c1; c++) cells.push(inSel(r, c) ? cellText(valueAt(r, c)) : "");
    lines.push(cells.join("\t"));
  }
  return lines;
}

/** 剪贴板文本 → 格子矩阵:换行统一成 \n,末尾那个换行不算一行(从表格软件复制来的都带)。 */
export function parsePasteMatrix(text: string): string[][] {
  const grid = text.replace(/\r\n?/g, "\n").split("\n");
  if (grid.length > 1 && grid[grid.length - 1] === "") grid.pop();
  return grid.map((line) => line.split("\t"));
}

// ---- 行的显示顺序 ----

export interface InsertRow {
  key: string;
  /** 显示在第几条已加载行下面(-1 = 第一行上面);只影响显示,INSERT 本身和顺序无关。 */
  after: number;
  values: Cell[];
}

export type DisplayItem = { kind: "row"; row: number } | { kind: "ins"; ins: number };

/** Interleave added rows at their anchor to build the visible row order.
 *  Each item is a loaded row (`row`) or a pending insert (`ins`, index into
 *  `inserts`). Loaded-row edits/deletes stay keyed by loaded index. */
export function buildDisplayList(inserts: InsertRow[], rowCount: number): DisplayItem[] {
  const list: DisplayItem[] = [];
  const after = new Map<number, number[]>();
  inserts.forEach((ins, i) => {
    const a = ins.after < 0 || rowCount === 0 ? -1 : Math.min(ins.after, rowCount - 1);
    const at = after.get(a); if (at) at.push(i); else after.set(a, [i]);
  });
  for (const i of after.get(-1) ?? []) list.push({ kind: "ins", ins: i });
  for (let r = 0; r < rowCount; r++) {
    list.push({ kind: "row", row: r });
    for (const i of after.get(r) ?? []) list.push({ kind: "ins", ins: i });
  }
  return list;
}

// ---- 撤销 ----

export interface UndoItem {
  key: string;
  had: boolean;
  value: Cell;
}

/** One undoable step. */
export type UndoEntry =
  | { kind: "cells"; items: UndoItem[] }
  | { kind: "col"; column: number; had: boolean; value: Cell; clearedCells: [string, Cell][] }
  | { kind: "addRow"; key: string }
  | { kind: "removeInsert"; row: InsertRow }
  | { kind: "insertCell"; key: string; c: number; prev: Cell }
  | { kind: "markDelete"; indexes: number[] }
  | { kind: "unmarkDelete"; indexes: number[] };
