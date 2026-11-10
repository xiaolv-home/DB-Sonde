import type { PlanReader, DimensionLabel } from "./planReader";
import type { AgentState, Insight } from "./state";
import type { Cell, QueryResult } from "../../types";
import { maxOf, minOf } from "../../lib/numbers";
import { compareText } from "../../lib/collate";

/** Compute reproducible facts from observations. Labels and plan access belong to the caller. */
export interface Fact {
  id: string;
  kind: Insight["kind"];
  /** 给模型看的一句话,已经带好数字。 */
  text: string;
  planId: string;
  /** 支撑这句话的原始行。 */
  rows: unknown[][];
  columns?: string[];
  computedBy: string;
}

export const num = (cell: Cell): number | null => {
  if (cell == null || (typeof cell !== "number" && typeof cell !== "string") || (typeof cell === "string" && !cell.trim())) return null;
  const value = Number(cell);
  return Number.isFinite(value) ? value : null;
};

export const fmtNum = (value: number, unit: string): string => {
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${(value / 1e8).toFixed(2)}亿${unit}`;
  if (abs >= 1e4) return `${(value / 1e4).toFixed(1)}万${unit}`;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit}`;
};

export const pct = (value: number): string => `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

export interface Column {
  field: string;
  name: string;
  unit: string;
  rollup: string;
  index: number;
}

export function columnsOf(result: QueryResult, metrics: { field: string; name: string; unit: string; rollup: string; }[]): Column[] {
  return metrics
    .map((m) => ({ ...m, index: result.columns.findIndex((c) => c.name === m.field) }))
    .filter((m) => m.index >= 0);
}

/**
 * 一组行合成一个数。
 *
 * 算不出来分两种,不能混为一谈:
 *   no_data      这一组没有可用的值(整列是空的)。丢掉这一组,剩下的照常排名。
 *   not_additive 这个指标本来就不能跨行合并(比率、均值)。那整个维度都排不了名。
 * 原来两种都返回 null,上面一句 `some(v => v === null) continue` 一起挡掉 ——
 * 结果是六百家店里有一家当天没数,这个维度的排名、占比、最低项就全都不生成了,
 * 而且不声不响:报告里只剩一个总量,看不出少了什么。
 */
type GroupTotal = { value: number; reason?: undefined } | { value: null; reason: "no_data" | "not_additive" };

export function total(rows: Cell[][], column: Column): GroupTotal {
  const values = rows.map((r) => num(r[column.index])).filter((v): v is number => v !== null);
  if (!values.length) return { value: null, reason: "no_data" };
  /* COUNT(DISTINCT) 跟比率/均值一样不能跨组合并 —— 而且更狠:同一家店出现在两个组里
     就会被重复计数,连"按平均粗看一眼"都不成立。只有一组一行时那一行本身是对的。 */
  if (column.rollup === "avg" || column.rollup === "count_distinct") {
    return rows.length === 1 ? { value: values[0] } : { value: null, reason: "not_additive" };
  }
  // 循环取极值:一个分组可能装着两万行,参数展开到不了那个量
  if (column.rollup === "min") return { value: minOf(values)! };
  if (column.rollup === "max") return { value: maxOf(values)! };
  return { value: values.reduce((a, b) => a + b, 0) };
}

/** 总量用的是哪一路 —— 事实的 computedBy 得如实写,不能算的是一回事、标的是另一回事。 */
function usesExactTotal(column: Column, exact?: QueryResult): boolean {
  return !!exact && column.rollup !== "sum" && column.rollup !== "count";
}

export function overall(result: QueryResult, column: Column, exact?: QueryResult): number | null {
  /* 声明成求和的指标,总量就是各组之和,不能用不分组那次查询的结果。
     「有效天数」不分组查出来是日历天数(31),各店天数加起来是网点有效天数(310);
     要是总量写 31、下面的排名加起来是 310,同一份报告自相矛盾。
     比率、均值、去重计数没有这个问题 —— 它们本来就只能靠不分组的那次查询拿准确值。 */
  if (!usesExactTotal(column, exact)) return total(result.rows, column).value;
  if (exact) {
    const index = exact.columns.findIndex((c) => c.name === column.field);
    return exact.rows.length === 1 && index >= 0 ? num(exact.rows[0][index]) : null;
  }
  return total(result.rows, column).value;
}

/**
 * 从 State 里算出所有事实。
 *
 * 顺序即重要性:总量 → 同环比 → 结构(TopN/BottomN)→ 贡献度 → 异常。
 */
function analyzePrimary(state: AgentState, getPlan: PlanReader, dimensionLabel: DimensionLabel): Fact[] {
  const facts: Fact[] = [];
  const primary = (state.plans ?? []).find((p) => p.role === "primary");
  if (!primary) return facts;
  const plan = getPlan(primary.planId);
  const result = (plan as { result?: QueryResult; } | undefined)?.result;
  if (!plan || !result || result.rows.length === 0) return facts;

  const columns = columnsOf(result, plan.shape.metrics);
  const dims = plan.shape.dimensions;
  const label = state.scope?.label ?? "所选范围";
  let seq = 0;
  const nextId = () => `F${++seq}`;

  // ── 总量 ──
  for (const column of columns) {
    const value = overall(result, column, plan.totalResult);
    if (value === null) continue;
    facts.push({
      id: nextId(), kind: "trend", planId: primary.planId,
      text: `${label}的${column.name}${column.rollup === "sum" || column.rollup === "count" ? "合计" : "整体值"} ${fmtNum(value, column.unit)}(共 ${result.rows.length} 行明细)`,
      rows: [[column.name, value]], columns: ["指标", `本期（${column.unit || "数值"}）`],
      computedBy: usesExactTotal(column, plan.totalResult) ? `ungrouped(${column.field})` : `${column.rollup}(${column.field})`,
    });
  }

  // ── 同比 / 环比 ──
  for (const comparison of state.plans ?? []) {
    if (comparison.role === "primary") continue;
    const other = getPlan(comparison.planId);
    if (!other?.result?.rows.length) continue;
    const otherColumns = columnsOf(other.result, plan.shape.metrics);
    const kindName = comparison.role === "mom" ? "环比" : "同比";
    for (const column of columns) {
      const before = otherColumns.find((c) => c.field === column.field);
      if (!before) continue;
      const now = overall(result, column, plan.totalResult);
      const then = overall(other.result, before, other.totalResult);
      if (now === null || then === null || then === 0) continue; // 除零:不报 0% 那种误导性的数
      const change = ((now - then) / Math.abs(then)) * 100;
      facts.push({
        id: nextId(), kind: comparison.role === "mom" ? "mom" : "yoy", planId: primary.planId,
        text: `${column.name}${kindName} ${pct(change)}(${fmtNum(now, column.unit)} vs ${comparison.dateRange.start}~${comparison.dateRange.end} 的 ${fmtNum(then, column.unit)})`,
        rows: [[column.name, now, then, change]], columns: ["指标", "本期", kindName + "期", "变化（%）"],
        computedBy: `${kindName}((now-then)/|then|)`,
      });
    }
  }

  // Compare every relevant metric and business dimension; no fixed first-metric/top-five template.
  const businessDims = dims.filter((d) => !["day", "week", "month", "year"].includes(d));
  const timeDim = dims.find((d) => ["day", "week", "month", "year"].includes(d));

  /* ── 分组同比 / 环比 ────────────────────────────────────────────────────
     「整体涨了 6%,到底是哪几个分组在涨、有没有在跌的」是最常被追问的一件事,
     而数据本来就在手里 —— 对比期的查询用的是同一组维度,只是以前没人去算。
     真机上模型自己在「证据仍有局限」里写过:「各大区环比未按大区拆分,
     无法判断整体增长具体集中在哪些大区」。那不是数据不够,是这里漏了。 */
  const groupRows = (result: QueryResult, dimension: string) => {
    const index = result.columns.findIndex((c) => c.name === dimension);
    if (index < 0) return null;
    const map = new Map<string, Cell[][]>();
    for (const row of result.rows) {
      const key = String(row[index] ?? "(空)");
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(row);
    }
    return map;
  };
  for (const comparison of state.plans ?? []) {
    if (comparison.role === "primary") continue;
    const other = getPlan(comparison.planId);
    if (!other?.result?.rows.length) continue;
    const kindName = comparison.role === "mom" ? "环比" : "同比";
    for (const groupDim of businessDims) {
      const nowGroups = groupRows(result, groupDim);
      const thenGroups = groupRows(other.result, groupDim);
      if (!nowGroups || !thenGroups || nowGroups.size < 2) continue;
      for (const column of columns) {
        const before = columnsOf(other.result, plan.shape.metrics).find((c) => c.field === column.field);
        if (!before) continue;
        const changes: { key: string; now: number; then: number; change: number }[] = [];
        let notComparable = 0, appeared = 0, disappeared = 0;
        for (const [key, rows] of nowGroups) {
          const nowTotal = total(rows, column);
          if (nowTotal.reason === "not_additive") { notComparable += 1; continue; }
          const thenRows = thenGroups.get(key);
          if (!thenRows) { appeared += 1; continue; }
          const thenTotal = total(thenRows, before);
          if (thenTotal.reason === "not_additive") { notComparable += 1; continue; }
          if (nowTotal.value === null || thenTotal.value === null || thenTotal.value === 0) continue;
          changes.push({ key, now: nowTotal.value, then: thenTotal.value, change: ((nowTotal.value - thenTotal.value) / Math.abs(thenTotal.value)) * 100 });
        }
        for (const key of thenGroups.keys()) if (!nowGroups.has(key)) disappeared += 1;
        // 不可加的指标整个维度都比不了,别拿一半的分组冒充"各分组的变化"
        if (notComparable > 0 || changes.length < 2) continue;
        const ranked = changes.sort((a, b) => b.change - a.change);
        const shown = ranked.slice(0, 30);
        const notes = [
          ranked.length > 30 ? `共 ${ranked.length} 组,上列变化幅度最大和最小的各若干组` : "",
          appeared ? `另有 ${appeared} 个分组本期有、${kindName}期没有(新增)` : "",
          disappeared ? `${disappeared} 个分组${kindName}期有、本期没有(消失)` : "",
        ].filter(Boolean).join(";");
        facts.push({
          id: nextId(), kind: comparison.role === "mom" ? "mom" : "yoy", planId: primary.planId,
          text: `各${dimensionLabel(groupDim)}的${column.name}${kindName}(按变化幅度排序)：`
            + shown.map((r) => `${r.key} ${pct(r.change)}(${fmtNum(r.now, column.unit)} vs ${fmtNum(r.then, column.unit)})`).join("、")
            + (notes ? `。${notes}` : "")
            + `。${kindName}期为 ${comparison.dateRange.start}~${comparison.dateRange.end}。`,
          rows: shown.map((r) => [r.key, r.now, r.then, r.change]),
          columns: [dimensionLabel(groupDim), "本期", kindName + "期", "变化（%）"],
          computedBy: `group_${comparison.role}(${column.field} by ${groupDim})`,
        });
      }
    }
  }
  for (const groupDim of businessDims) {
    const di = result.columns.findIndex((c) => c.name === groupDim);
    if (di < 0) continue;
    const grouped = new Map<string, Cell[][]>();
    for (const row of result.rows) {
      const key = String(row[di] ?? "(空)");
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(row);
    }
    for (const main of columns) {
      if (grouped.size < 2) continue;
      const totals = [...grouped.entries()].map(([key, rows]) => ({ key, total: total(rows, main) }));
      /* 不可加的指标(比率、均值)整个维度都排不了名 —— 混粒度平均不是证据。
         但「某一组没数」只该丢掉那一组,不该让整个维度失声。 */
      if (totals.some((r) => r.total.reason === "not_additive")) continue;
      const ranked = totals.filter((r): r is { key: string; total: { value: number } } => r.total.value !== null)
        .map((r) => ({ key: r.key, value: r.total.value }))
        .sort((a, b) => b.value - a.value);
      const blank = totals.length - ranked.length;
      const blankNote = blank ? `,另有 ${blank} 组没有数据、未计入` : "";
      if (ranked.length < 2) continue;
      const complete = ranked.slice(0, 40);
      const headers = [dimensionLabel(groupDim), `${main.name}（${main.unit || "数值"}）`];
      facts.push({
        id: nextId(), kind: "topn", planId: primary.planId,
        text: `${main.name}按${dimensionLabel(groupDim)}排序（共${ranked.length}组${ranked.length > 40 ? "，下列列出前40组" : "，全部分组"}${blankNote}）：${complete.map((r) => `${r.key} ${fmtNum(r.value, main.unit)}`).join("、")}`,
        rows: complete.map((r) => [r.key, r.value]), columns: headers, computedBy: `ranking(${main.field} by ${groupDim})`
      });
      const smallest = ranked[ranked.length - 1];
      facts.push({
        id: nextId(), kind: "bottomn", planId: primary.planId,
        text: `${main.name}最低的${dimensionLabel(groupDim)}为${smallest.key}，${fmtNum(smallest.value, main.unit)}。高低本身不等于好坏，应结合指标口径判断。`,
        rows: [[smallest.key, smallest.value]], columns: headers, computedBy: `minimum_group(${main.field})`
      });
      if (!["sum", "count"].includes(main.rollup)) continue;
      const sum = ranked.reduce((n, r) => n + r.value, 0);
      if (sum > 0 && ranked.every((r) => r.value >= 0)) {
        facts.push({
          id: nextId(), kind: "contribution", planId: primary.planId,
          text: `${main.name}总量${fmtNum(sum, main.unit)}；各${dimensionLabel(groupDim)}占总量比例（不是各组发生率）：${complete.map((r) => `${r.key} ${(r.value / sum * 100).toFixed(2)}%`).join("、")}`,
          rows: complete.map((r) => [r.key, r.value, r.value / sum * 100]), columns: [...headers, "占总量（%）"], computedBy: `full_group_share(${main.field})`
        });
      }
      if (timeDim) {
        const ti = result.columns.findIndex((c) => c.name === timeDim);
        const times = [...new Set(result.rows.map((row) => String(row[ti] ?? "")))].filter(Boolean).sort();
        if (ti >= 0 && times.length >= 2) {
          const first = times[0], last = times[times.length - 1];
          const changes = [...grouped.entries()].flatMap(([key, rows]) => {
            const before = total(rows.filter((r) => String(r[ti]) === first), main).value;
            const after = total(rows.filter((r) => String(r[ti]) === last), main).value;
            return before === null || after === null ? [] : [{ key, before, after, delta: after - before }];
          }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
          if (changes.length) facts.push({
            id: nextId(), kind: "structure_shift", planId: primary.planId,
            text: `${first}至${last}各${dimensionLabel(groupDim)}的${main.name}变化（按变化绝对值排序）：${changes.slice(0, 20).map((r) => `${r.key} ${fmtNum(r.before, main.unit)}→${fmtNum(r.after, main.unit)}，变化${fmtNum(r.delta, main.unit)}`).join("；")}${changes.length > 20 ? `（共 ${changes.length} 组，上列变化最大的 20 组）` : ""}。仅包含首末期都有观测的分组。`,
            rows: changes.slice(0, 20).map((r) => [r.key, r.before, r.after, r.delta]), columns: [dimensionLabel(groupDim), first, last, "变化量"], computedBy: `group_change(${main.field})`
          });
        }
      }
    }
  }
  if (timeDim) {
    const ti = result.columns.findIndex((c) => c.name === timeDim);
    const byTime = new Map<string, Cell[][]>();
    if (ti >= 0) for (const row of result.rows) {
      const key = String(row[ti] ?? "");
      if (!byTime.has(key)) byTime.set(key, []);
      byTime.get(key)!.push(row);
    }
    for (const main of columns) {
      const totals = [...byTime.entries()].map(([key, rows]) => ({ key, total: total(rows, main) }));
      // 同上:不可加的指标不画趋势;个别时间点没数只丢那个点。
      if (totals.some((t) => t.total.reason === "not_additive")) continue;
      const series = totals.filter((t): t is { key: string; total: { value: number } } => t.total.value !== null)
        .map((t) => ({ key: t.key, value: t.total.value }))
        .sort((a, b) => compareText(a.key, b.key));
      const gaps = totals.length - series.length;
      if (series.length < 2) continue;
      const first = series[0], last = series[series.length - 1];
      facts.push({
        id: nextId(), kind: "trend", planId: primary.planId,
        text: `${main.name}从${first.key}的${fmtNum(first.value, main.unit)}变到${last.key}的${fmtNum(last.value, main.unit)}${first.value === 0 ? "（起点为零，不计算增长率）" : `（${pct((last.value - first.value) / Math.abs(first.value) * 100)}）`}；逐期值：${series.map((r) => `${r.key} ${fmtNum(r.value, main.unit)}`).join("、")}${gaps ? `（另有 ${gaps} 个时间点没有数据）` : ""}`,
        rows: series.map((r) => [r.key, r.value]), columns: [dimensionLabel(timeDim), `${main.name}（${main.unit || "数值"}）`], computedBy: `first_vs_last(${main.field})`
      });
      const peak = series.reduce((a, b) => a.value > b.value ? a : b), trough = series.reduce((a, b) => a.value < b.value ? a : b);
      facts.push({
        id: nextId(), kind: "anomaly", planId: primary.planId,
        text: `${main.name}最高为${peak.key} ${fmtNum(peak.value, main.unit)}，最低为${trough.key} ${fmtNum(trough.value, main.unit)}`,
        rows: [[peak.key, peak.value], [trough.key, trough.value]], columns: [dimensionLabel(timeDim), main.name], computedBy: `peak_trough(${main.field})`
      });
    }
  }

  return facts.map((fact) => ({ ...fact, columns: fact.columns ?? [dimensionLabelForEvidence(dimensionLabel, fact.kind, businessDims[0], timeDim), `${columns.find((c) => c.rollup === "sum" || c.rollup === "count")?.name ?? "数值"}（${columns.find((c) => c.rollup === "sum" || c.rollup === "count")?.unit || "数值"}）`] }));
}

function dimensionLabelForEvidence(dimensionLabel: DimensionLabel, kind: Insight["kind"], group?: string, time?: string): string {
  return ["topn", "bottomn", "contribution"].includes(kind) ? dimensionLabel(group ?? "分组") : dimensionLabel(time ?? group ?? "维度");
}


export function computeFacts(state: AgentState, getPlan: PlanReader, dimensionLabel: DimensionLabel): Fact[] {
  const facts = analyzePrimary(state, getPlan, dimensionLabel);
  for (const [index, view] of (state.supportingPlans ?? []).entries()) {
    if (!state.scope) continue;
    const extra = analyzePrimary({ ...state, supportingPlans: [], plans: [{ planId: view.planId, role: "primary", dateRange: state.scope.dateRange }] }, getPlan, dimensionLabel);
    for (const fact of extra) {
      if (!facts.some((f) => f.computedBy === fact.computedBy && JSON.stringify(f.rows) === JSON.stringify(fact.rows))) facts.push({ ...fact, id: `V${index + 1}-${fact.id}` });
    }
  }
  return facts;
}
