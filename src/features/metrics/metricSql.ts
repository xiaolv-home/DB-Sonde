import { isCalendarDay, nextCalendarDay } from "../../lib/dates";
import { paginationClause } from "../../lib/databaseDialect";
import type { DbKind } from "../../types";
import type { Metric } from "./metricsStore";
import { compileQueryPlan, defaultMetricScope, planSourceTables, type QueryScope } from "./queryPlan";

export interface CompileOpts {
  dialect?: DbKind;
  scope?: QueryScope;
  dimension?: string; // single group-by column (preview drill)
  groupBy?: string[]; // multiple group-by columns (dashboard dataset)
  filters?: string; // raw WHERE (without the WHERE keyword)
  limit?: number;
}

const alias = (m: Metric) => (m.key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(m.key) ? m.key : "value");

/** 指标的时间列:显式 timeField 优先,否则从可用维度里认出日期列。
 *  measure/ratio 指标据此把 scope 起止日期下推成 WHERE —— 缺了它就会全表扫描整段历史。 */
export function metricTimeColumn(m: Metric): string | undefined {
  const explicit = m.timeField?.trim();
  if (explicit && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(explicit)) return explicit;
  return (m.dimensions ?? []).find((d) => /^(day|date|dt|ds|stat_date|biz_date|date_id)$/i.test(d.trim()));
}

/** scope 起止日期编译成区间谓词(兼容日期与时间戳，结束日包含全天)。日期已按 YYYY-MM-DD 校验,可安全内联。 */
export function metricDateWhere(m: Metric, scope?: QueryScope): string {
  const col = metricTimeColumn(m);
  if (!col || !scope?.start || !scope?.end) return "";
  if (!isCalendarDay(scope.start) || !isCalendarDay(scope.end) || scope.start > scope.end)
    throw new Error("日期范围无效，未执行查询");
  return `${col} >= '${scope.start}' AND ${col} < '${nextCalendarDay(scope.end)}'`;
}

/** A scalar expression for a metric (no dimension), for use inside derived. */
function scalarSubquery(m: Metric): string | null {
  if (!m.source) return null;
  if (m.type === "measure" && m.expression) return `(SELECT ${m.expression} FROM ${m.source})`;
  if (m.type === "ratio" && m.numerator && m.denominator) {
    const s = m.scale ? `*${m.scale}` : "";
    return `(SELECT (${m.numerator})/NULLIF(${m.denominator},0)${s} FROM ${m.source})`;
  }
  return null;
}

/** Compile a metric (+ optional dimension / filters) into a runnable SELECT. */
export function compileMetric(
  m: Metric,
  opts: CompileOpts = {},
  lookup?: (id: string) => Metric | undefined,
): { sql: string; error?: string } {
  const a = alias(m);
  const dims = (opts.groupBy?.length ? opts.groupBy : opts.dimension ? [opts.dimension] : [])
    .map((d) => d.trim())
    .filter(Boolean);
  // measure/ratio 的 WHERE = 日期区间(下推 scope,避免全表扫描)+ 传入的筛选条件。
  const dateWhere = (m.type === "measure" || m.type === "ratio") ? metricDateWhere(m, opts.scope) : "";
  const whereParts = [dateWhere, opts.filters?.trim() || ""].filter(Boolean);
  const where = whereParts.length ? ` WHERE ${whereParts.join(" AND ")}` : "";
  const limit = opts.limit ? ` ${paginationClause(opts.dialect, opts.limit)}` : "";
  const dimSel = dims.length ? `${dims.join(", ")}, ` : "";
  const dimGrp = dims.length ? ` GROUP BY ${dims.join(", ")}` : "";

  if (m.type === "template") {
    try { return { sql: compileQueryPlan(m.queryPlan!, { ...(opts.scope ?? defaultMetricScope()), dimensions: dims, dialect: opts.dialect }, a) + limit }; }
    catch (e) { return { sql: "", error: String(e).replace(/^Error: /, "") }; }
  }
  if (m.type === "sql") {
    return { sql: (m.sql ?? "").trim() };
  }
  if (m.type === "measure") {
    if (!m.source || !m.expression) return { sql: "", error: "度量指标需要 基表 + 聚合表达式" };
    return { sql: `SELECT ${dimSel}${m.expression} AS ${a} FROM ${m.source}${where}${dimGrp}${limit}` };
  }
  if (m.type === "ratio") {
    if (!m.source || !m.numerator || !m.denominator) return { sql: "", error: "比率指标需要 基表 + 分子 + 分母" };
    const s = m.scale ? `*${m.scale}` : "";
    return {
      sql: `SELECT ${dimSel}(${m.numerator})/NULLIF(${m.denominator},0)${s} AS ${a} FROM ${m.source}${where}${dimGrp}${limit}`,
    };
  }
  // derived: 指标 ÷ 指标 (scalar; dimension not supported for preview)
  if (m.type === "derived") {
    const num = m.numeratorMetricId ? lookup?.(m.numeratorMetricId) : undefined;
    const den = m.denominatorMetricId ? lookup?.(m.denominatorMetricId) : undefined;
    if (!num || !den) return { sql: "", error: "派生指标需要选 分子指标 + 分母指标" };
    const ns = scalarSubquery(num);
    const ds = scalarSubquery(den);
    if (!ns || !ds) return { sql: "", error: "派生指标的分子/分母暂只支持 度量/比率 型" };
    const s = m.scale ? `*${m.scale}` : "";
    return { sql: `SELECT ${ns}/NULLIF(${ds},0)${s} AS ${a}` };
  }
  return { sql: "", error: "未知指标类型" };
}

/** The base tables a metric reads — no SQL parsing needed. */
export function metricSourceTables(m: Metric, lookup?: (id: string) => Metric | undefined): string[] {
  if (m.type === "template") return m.queryPlan ? planSourceTables(m.queryPlan) : [];
  if (m.type === "measure" || m.type === "ratio") return m.source ? [m.source] : [];
  if (m.type === "derived") {
    const out: string[] = [];
    for (const id of [m.numeratorMetricId, m.denominatorMetricId]) {
      const sub = id ? lookup?.(id) : undefined;
      if (sub?.source) out.push(sub.source);
    }
    return out;
  }
  return []; // sql: parse separately with sqlglot
}
