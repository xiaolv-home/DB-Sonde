/**
 * 下钻调查里「一步」的事实 —— 全是代码算的,模型只读结论、不碰数。
 *
 * 一步 = 在某个范围里(整体,或缩小到「渠道=外卖」「10月第3周」)按一个维度拆开,
 * 配一个对比期。要回答的永远是同一类问题:**变化在哪、集中在哪、有多大**。
 *
 *   有对比期 + 按分组拆   每组变了多少、占总变化的几成(贡献度),按影响排序
 *   按时间拆              逐期走势;按日时找偏离「同星期几均值」最多的天
 *                         (均值去掉的是当前这一行,不是所有相同数值);
 *                         有对比期时按日期键对齐,缺一天或对比期多一天不会把后面错位
 *   没有对比期            各组份额、头尾,和明显偏离平均的组
 *
 * 不可加的指标(比率、均值、去重数)不算贡献度 —— 它们不能拆成各组之和 ——
 * 只比较各组自己前后变了多少。
 */
import type { Cell, QueryResult } from "../../types";
import { compareText } from "../../lib/collate";
import type { ObservedPlan } from "./planReader";
import { columnsOf, computeFacts, fmtNum, overall, pct, total, type Column, type Fact } from "./factCalculator";

export const TIME_DIMENSIONS = ["day", "week", "month", "year"];

export interface DrillFactInput {
  stepId: string;
  /** 这一步的范围说人话:「外卖 · 2026年10月」。 */
  label: string;
  current: ObservedPlan;
  compare?: ObservedPlan;
  compareLabel?: string;
  /** 按哪个维度拆;不拆就只看总量。 */
  breakdown?: string;
  dimensionLabel: (key: string) => string;
}

const additive = (c: Column) => c.rollup === "sum" || c.rollup === "count";
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

import { alignByDateKey, type TimePoint } from "./drillTimeAlignment";

/** 一组行按某一列分组,保持出现顺序。 */
function groupRows(result: QueryResult, index: number): Map<string, Cell[][]> {
  const out = new Map<string, Cell[][]>();
  for (const row of result.rows) {
    const key = String(row[index] ?? "(空)");
    const list = out.get(key);
    if (list) list.push(row); else out.set(key, [row]);
  }
  return out;
}

export function drillFacts(input: DrillFactInput): Fact[] {
  const { current, compare, breakdown, stepId, label, dimensionLabel } = input;
  const result = current.result;
  if (!result?.rows.length) return [];
  const planId = (current as { planId?: string }).planId ?? stepId;
  const columns = columnsOf(result, current.shape.metrics);
  const compareColumns = compare?.result ? columnsOf(compare.result, compare.shape.metrics) : [];
  const facts: Fact[] = [];
  let seq = 0;
  const add = (fact: Omit<Fact, "id" | "planId">) => facts.push({ ...fact, id: `${stepId}-${++seq}`, planId });
  const vs = input.compareLabel ?? "对比期";

  // ── 这一步范围里的总量,以及对比期 ──
  for (const column of columns) {
    const now = overall(result, column, current.totalResult);
    if (now === null) continue;
    const before = compareColumns.find((c) => c.field === column.field);
    const then = before && compare?.result ? overall(compare.result, before, compare.totalResult) : null;
    const change = then !== null && then !== 0 ? ((now - then) / Math.abs(then)) * 100 : null;
    add({
      kind: change === null ? "trend" : "mom",
      text: `${label}:${column.name} ${fmtNum(now, column.unit)}${then !== null ? `,${vs} ${fmtNum(then, column.unit)}${change !== null ? `(${pct(change)},${now - then >= 0 ? "+" : ""}${fmtNum(now - then, column.unit)})` : ""}` : ""}`,
      rows: [[column.name, now, then]], columns: ["指标", "本期", vs], computedBy: `drill_total(${column.field})`,
    });
  }
  if (!breakdown) return facts;

  const bi = result.columns.findIndex((c) => c.name === breakdown);
  if (bi < 0) return facts;
  const dimName = dimensionLabel(breakdown);
  const isTime = TIME_DIMENSIONS.includes(breakdown);
  const groups = groupRows(result, bi);
  const compareGroups = compare?.result ? (() => {
    const ci = compare.result!.columns.findIndex((c) => c.name === breakdown);
    return ci < 0 ? undefined : groupRows(compare.result!, ci);
  })() : undefined;

  for (const column of columns.slice(0, 3)) {
    const valueOf = (rows: Cell[][] | undefined) => (rows ? total(rows, column).value : null);
    const cmpColumn = compareColumns.find((c) => c.field === column.field);
    const cmpValueOf = (rows: Cell[][] | undefined) => (rows && cmpColumn ? total(rows, cmpColumn).value : null);

    if (isTime) {
      const series = [...groups.entries()]
        .map(([key, rows]) => ({ key, value: valueOf(rows) }))
        .filter((p): p is { key: string; value: number } => p.value !== null)
        .sort((a, b) => compareText(a.key, b.key));
      if (series.length < 2) continue;
      add({
        kind: "trend",
        text: `${label}按${dimName}看${column.name}:${series.map((p) => `${p.key} ${fmtNum(p.value, column.unit)}`).join("、")}`,
        rows: series.map((p) => [p.key, p.value]), columns: [dimName, column.name], computedBy: `drill_series(${column.field} by ${breakdown})`,
      });
      // 按日:跟「同星期几」的平均比 —— 周末本来就高,直接跟全月平均比会把每个周末都标成异常。
      // 只摘掉当前这一行。按值摘会把「恰好同值」的其他天也丢掉,两天一样反常时均值就算偏了。
      if (breakdown === "day" && series.length >= 10) {
        const weekday = (key: string) => new Date(`${key.slice(0, 10)}T00:00:00`).getDay();
        const byWeekday = new Map<number, { index: number; value: number }[]>();
        for (const [index, point] of series.entries()) {
          const w = weekday(point.key);
          if (Number.isNaN(w)) continue;
          const bucket = byWeekday.get(w);
          const item = { index, value: point.value };
          if (bucket) bucket.push(item); else byWeekday.set(w, [item]);
        }
        const deviations = series.flatMap((point, index) => {
          const w = weekday(point.key);
          const peers = (byWeekday.get(w) ?? []).filter((item) => item.index !== index).map((item) => item.value);
          if (peers.length < 2) return [];
          const mean = peers.reduce((sum, value) => sum + value, 0) / peers.length;
          return mean ? [{ ...point, w, mean, dev: ((point.value - mean) / Math.abs(mean)) * 100 }] : [];
        }).sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev)).filter((d) => Math.abs(d.dev) >= 15).slice(0, 5);
        if (deviations.length) {
          add({
            kind: "anomaly",
            text: `${label}${column.name}偏离同星期几均值最多的几天:${deviations.map((d) => `${d.key}(${WEEKDAYS[d.w]})${fmtNum(d.value, column.unit)},比其他${WEEKDAYS[d.w]}均值 ${pct(d.dev)}`).join(";")}`,
            rows: deviations.map((d) => [d.key, WEEKDAYS[d.w], d.value, d.mean, d.dev]), columns: ["日期", "星期", column.name, "同星期几均值", "偏离%"],
            computedBy: `weekday_deviation(${column.field})`,
          });
        }
      }
      // 有对比期:按日期键对齐(不是第 n 行对第 n 行),找掉得 / 涨得最多的。
      // 无法识别的时间键不参与比较，不能按结果行号猜对应期。
      if (compareGroups && cmpColumn) {
        const before = [...compareGroups.entries()].map(([key, rows]) => ({ key, value: cmpValueOf(rows) }))
          .filter((p): p is TimePoint => p.value !== null).sort((a, b) => compareText(a.key, b.key));
        const keyed = alignByDateKey(series, before, breakdown, current.shape.dateRange, compare?.shape.dateRange);
        const pairs = keyed ?? [];
        if (pairs.length >= 2) {
          const ranked = [...pairs].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 4);
          add({
            kind: "anomaly",
            text: `${label}${column.name}逐期对比${vs}(按日期对齐),变化最大的:${ranked.map((p) => `${p.now.key} ${fmtNum(p.now.value, column.unit)} vs ${p.then.key} ${fmtNum(p.then.value, column.unit)}(${p.delta >= 0 ? "+" : ""}${fmtNum(p.delta, column.unit)}${p.then.value ? `,${pct((p.delta / Math.abs(p.then.value)) * 100)}` : ""})`).join(";")}`,
            rows: ranked.map((p) => [p.now.key, p.now.value, p.then.key, p.then.value, p.delta]), columns: [dimName, "本期", `${vs}对应期`, "对比期值", "差值"],
            computedBy: `aligned_periods(${column.field} by ${breakdown})`,
          });
        }
      }
      continue;
    }

    // ── 按分组拆 ──
    const rows = [...groups.entries()].map(([key, list]) => {
      const now = valueOf(list);
      const then = compareGroups ? cmpValueOf(compareGroups.get(key)) ?? (additive(column) ? 0 : null) : null;
      return { key, now, then };
    }).filter((r): r is { key: string; now: number; then: number | null } => r.now !== null);
    // 对比期里有、本期没了的组(停业、下架)—— 这种消失本身就是变化
    if (compareGroups && additive(column)) {
      for (const [key, list] of compareGroups) {
        if (groups.has(key)) continue;
        const then = cmpValueOf(list);
        if (then !== null) rows.push({ key, now: 0, then });
      }
    }
    if (rows.length < 2) continue;

    if (compareGroups && additive(column) && rows.every((r) => r.then !== null)) {
      const totalDelta = rows.reduce((a, r) => a + (r.now - (r.then ?? 0)), 0);
      const ranked = rows.map((r) => ({ ...r, delta: r.now - (r.then ?? 0) }))
        .sort((a, b) => (totalDelta < 0 ? a.delta - b.delta : b.delta - a.delta));
      const head = ranked.slice(0, 5);
      const opposite = ranked.filter((r) => totalDelta !== 0 && Math.sign(r.delta) === -Math.sign(totalDelta)).slice(-2);
      const share = (d: number) => (totalDelta ? ` 占总变化 ${((d / totalDelta) * 100).toFixed(0)}%` : "");
      add({
        kind: "contribution",
        text: `${label}按${dimName}拆${column.name}的变化(合计 ${totalDelta >= 0 ? "+" : ""}${fmtNum(totalDelta, column.unit)}):` +
          head.map((r) => `${r.key} ${r.delta >= 0 ? "+" : ""}${fmtNum(r.delta, column.unit)}${share(r.delta)}${r.then ? `(自身 ${pct((r.delta / Math.abs(r.then)) * 100)})` : r.then === 0 ? "(新出现)" : ""}`).join(";") +
          (opposite.length ? `。反方向:${opposite.map((r) => `${r.key} ${r.delta >= 0 ? "+" : ""}${fmtNum(r.delta, column.unit)}`).join("、")}` : "") +
          (ranked.length > head.length ? `(共 ${ranked.length} 组)` : ""),
        rows: ranked.map((r) => [r.key, r.now, r.then, r.delta, totalDelta ? r.delta / totalDelta : null]),
        columns: [dimName, "本期", vs, "变化", "占总变化"], computedBy: `contribution(${column.field} by ${breakdown})`,
      });
      continue;
    }

    if (compareGroups && rows.some((r) => r.then !== null)) {
      // 不可加:只看各组自己的变化幅度
      const movers = rows.filter((r) => r.then !== null && r.then !== 0)
        .map((r) => ({ ...r, change: ((r.now - r.then!) / Math.abs(r.then!)) * 100 }))
        .sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, 5);
      if (movers.length) {
        add({
          kind: "mom",
          text: `${label}按${dimName}看${column.name}变化最大的:${movers.map((r) => `${r.key} ${fmtNum(r.then!, column.unit)}→${fmtNum(r.now, column.unit)}(${pct(r.change)})`).join(";")}`,
          rows: movers.map((r) => [r.key, r.now, r.then, r.change]), columns: [dimName, "本期", vs, "变化%"],
          computedBy: `group_change(${column.field} by ${breakdown})`,
        });
      }
      continue;
    }

    // 没有对比期:份额、头尾、明显偏离平均的组
    const sorted = [...rows].sort((a, b) => b.now - a.now);
    const sum = additive(column) ? sorted.reduce((a, r) => a + r.now, 0) : 0;
    const mean = sorted.reduce((a, r) => a + r.now, 0) / sorted.length;
    const sd = Math.sqrt(sorted.reduce((a, r) => a + (r.now - mean) ** 2, 0) / sorted.length);
    const outliers = sd ? sorted.filter((r) => Math.abs(r.now - mean) / sd >= 2) : [];
    add({
      kind: "topn",
      text: `${label}按${dimName}看${column.name}(${sorted.length} 组):最高 ${sorted.slice(0, 3).map((r) => `${r.key} ${fmtNum(r.now, column.unit)}${sum ? `(${((r.now / sum) * 100).toFixed(1)}%)` : ""}`).join("、")};最低 ${sorted.slice(-3).reverse().map((r) => `${r.key} ${fmtNum(r.now, column.unit)}`).join("、")}` +
        (outliers.length ? `。明显偏离平均(${fmtNum(mean, column.unit)})的:${outliers.slice(0, 4).map((r) => `${r.key} ${fmtNum(r.now, column.unit)}`).join("、")}` : ""),
      rows: sorted.map((r) => [r.key, r.now, sum ? r.now / sum : null]), columns: [dimName, column.name, "占比"],
      computedBy: `ranking(${column.field} by ${breakdown})`,
    });
  }
  return facts;
}


/**
 * 全部事实:整体(主查询 + 同环比 + 旧式补充查询)再加上下钻路径上每一步的。
 * 写结论、复核结论、调查下一步都用这一份 —— 谁看到的证据都一样。
 */
export function allFacts(
  state: import("./state").AgentState,
  getPlan: import("./planReader").PlanReader,
  dimensionLabel: (key: string) => string,
): Fact[] {
  const facts = computeFacts(state, getPlan, dimensionLabel);
  for (const step of state.drillSteps ?? []) {
    if (step.failed || !step.planId) continue;
    const current = getPlan(step.planId);
    if (!current) continue;
    facts.push(...drillFacts({
      stepId: step.id, label: step.label, current: { ...current, planId: step.planId } as ObservedPlan,
      compare: step.comparePlanId ? getPlan(step.comparePlanId) : undefined,
      compareLabel: step.compare === "yoy" ? "去年同期" : step.compare === "mom" ? "上期" : undefined,
      breakdown: step.breakdown, dimensionLabel,
    }));
  }
  return facts;
}
