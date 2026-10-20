import { isCalendarDay, nextCalendarDay } from "../../lib/dates";
/**
 * 组件查询:把「数据集 + 选中的维度/度量」变成一句聚合 SQL。
 *
 * 数据集本身是一张宽表(明细),组件要的是汇总。所以把数据集整段塞进子查询,外面按
 * 维度 GROUP BY、对度量做聚合 —— 数据集怎么写的与这里无关,换 SQL 还是换关联都不
 * 影响这一层。
 */
import { paginationClause } from "../../lib/databaseDialect";
import { dateLiteral, sqlLiteral, quoteIdent } from "../../lib/sql";
import type { DbKind } from "../../types";
import { buildDatasetSql, type Dataset } from "./domain";

export type AggKind = "sum" | "avg" | "count" | "count_distinct" | "min" | "max";

export const AGG_LABELS: Record<AggKind, string> = {
  sum: "求和", avg: "平均", count: "计数", count_distinct: "去重计数", min: "最小", max: "最大",
};

/** 时间维度的粒度。原样 = 不做截断,数据是什么粒度就是什么粒度。 */
export type TimeGrain = "raw" | "year" | "quarter" | "month" | "week" | "day" | "hour" | "minute";

export const GRAIN_LABELS: Record<TimeGrain, string> = {
  raw: "原样", year: "年", quarter: "季", month: "月", week: "周", day: "日", hour: "时", minute: "分",
};

/**
 * 把一列按粒度截断。各家函数不同,所以按引擎分。
 *
 * 一律产出字符串而不是日期类型:图表的 X 轴要的是可读的刻度,而且各引擎对截断后日期的
 * 返回类型不一致,统一成字符串省得下游再判一次。
 */
export function grainExpr(kind: DbKind | undefined, column: string, grain: TimeGrain): string {
  if (grain === "raw") return column;
  const pg = { year: "YYYY", quarter: "YYYY-\"Q\"Q", month: "YYYY-MM", week: "IYYY-\"W\"IW", day: "YYYY-MM-DD", hour: "YYYY-MM-DD HH24:00", minute: "YYYY-MM-DD HH24:MI" };
  const mysql = { year: "%Y", quarter: null, month: "%Y-%m", week: "%x-W%v", day: "%Y-%m-%d", hour: "%Y-%m-%d %H:00", minute: "%Y-%m-%d %H:%i" };
  const sqlite = { year: "%Y", quarter: null, month: "%Y-%m", week: "%Y-W%W", day: "%Y-%m-%d", hour: "%Y-%m-%d %H:00", minute: "%Y-%m-%d %H:%M" };
  switch (kind) {
    case "postgres":
      return `TO_CHAR(${column}, '${pg[grain]}')`;
    case "oracle":
      // Oracle 没有 %x 周格式,季度用 Q。
      return `TO_CHAR(${column}, '${grain === "quarter" ? "YYYY-\"Q\"Q" : grain === "week" ? "IYYY-\"W\"IW" : pg[grain]}')`;
    case "sqlite":
      return grain === "quarter"
        ? `strftime('%Y', ${column}) || '-Q' || ((CAST(strftime('%m', ${column}) AS INTEGER) + 2) / 3)`
        : `strftime('${sqlite[grain]}', ${column})`;
    default:
      return grain === "quarter"
        ? `CONCAT(YEAR(${column}), '-Q', QUARTER(${column}))`
        : `DATE_FORMAT(${column}, '${mysql[grain]}')`;
  }
}

export interface WidgetQuery {
  /** 分组维度,按顺序出现在 SELECT 和 GROUP BY 里。 */
  dimensions: string[];
  /** 维度 → 时间粒度。只对时间字段有意义,不填按原样。 */
  grains?: Record<string, TimeGrain>;
  /** 看板的数据日期,落成 WHERE。不传表示不按日期收窄。 */
  dateRange?: { field: string; start: string; end: string };
  /** 要汇总的度量字段。 */
  measures: Array<{ field: string; agg: AggKind; alias?: string }>;
  /** 维度等值过滤。值为空数组表示不限。 */
  filters?: Array<{ field: string; values: string[] }>;
  /** 按第一个度量降序取前 N 条;0/不传表示不限。 */
  topN?: number;
  limit?: number;
  /* 组件上设的排序。必须编进 SQL,不能只在前端排 ——
     取数是有行数上限的,后端按 ORDER BY 截前 N 行。前端排序只能重排「截回来的那一段」:
     日粒度下几十万行截到五万,再按 GMV 降序排,看到的是那五万行里的最大值,
     而且日期从中间某天开始。用户看到的就是「排完序数据不全」。 */
  orderBy?: Array<{ name: string; dir: "asc" | "desc"; measure?: boolean }>;
}

/* 取值转义走 lib/sql.ts 的 sqlLiteral —— 这儿原来自己写了一个只管单引号的版本。
   维度取值来自使用者的筛选框:MySQL 默认拿反斜杠当转义符,一个以 `\` 结尾的取值
   会把右引号吃掉,后面的 SQL 就接上去了。全项目的取值转义只此一份。 */

function aggExpr(kind: DbKind | undefined, agg: AggKind, field: string): string {
  const col = quoteIdent(kind, field);
  switch (agg) {
    case "count": return `COUNT(${col})`;
    case "count_distinct": return `COUNT(DISTINCT ${col})`;
    case "avg": return `AVG(${col})`;
    case "min": return `MIN(${col})`;
    case "max": return `MAX(${col})`;
    default: return `SUM(${col})`;
  }
}

/**
 * 生成组件的取数 SQL。
 *
 * 没有维度就是一个总计(KPI 卡的常态);没有度量则退化成按维度去重,让人至少能看到
 * 维度有哪些取值,而不是拿到一句报错。
 */
export function buildWidgetSql(dataset: Dataset, query: WidgetQuery, kind: DbKind | undefined): string {
  const inner = buildDatasetSql(dataset, kind);
  if (!inner.trim()) throw new Error("数据集还没有可执行的 SQL");

  const dims = query.dimensions.filter(Boolean);
  const measures = query.measures.filter((m) => m.field);
  const q = (name: string) => quoteIdent(kind, name);

  // 维度可能带时间粒度,分组和取值都得用截断后的表达式,不能一个用原列一个用表达式。
  const dimExpr = (name: string) => grainExpr(kind, q(name), query.grains?.[name] ?? "raw");

  const selected = [
    ...dims.map((d) => {
      const expr = dimExpr(d);
      return expr === q(d) ? expr : `${expr} AS ${q(d)}`;
    }),
    ...measures.map((m) => `${aggExpr(kind, m.agg, m.field)} AS ${q(m.alias || m.field)}`),
  ];

  const where = (query.filters ?? [])
    .filter((f) => f.field && f.values.length > 0)
    .map((f) => f.values.length === 1
      ? `${q(f.field)} = ${sqlLiteral(f.values[0], kind)}`
      : `${q(f.field)} IN (${f.values.map((v) => sqlLiteral(v, kind)).join(", ")})`);

  // 看板顶上的数据日期:落在原始日期列上,而不是截断后的表达式,这样索引还用得上。
  const range = query.dateRange;
  if (range?.field && range.start && range.end) {
    if (!isCalendarDay(range.start) || !isCalendarDay(range.end) || range.start > range.end)
      throw new Error("日期范围无效，未执行查询");
    const text = /char|text|string|clob/i.test(dataset.fields.find((f) => f.name === range.field)?.type ?? "");
    const day = (value: string) => dateLiteral(value, kind, text);
    where.push(`${q(range.field)} >= ${day(range.start)} AND ${q(range.field)} < ${day(nextCalendarDay(range.end))}`);
  }

  const lines = [
    `SELECT ${selected.length ? selected.join(", ") : "*"}`,
    `FROM (${inner}) ${q("t")}`,
  ];
  if (where.length) lines.push(`WHERE ${where.join(" AND ")}`);
  if (dims.length) lines.push(`GROUP BY ${dims.map(dimExpr).join(", ")}`);

  /* 排序。优先用组件上设的那份(orderBy),其次是「前 N 名」,都没有就按维度升序。
     默认按维度而不是按度量,是因为反过来会让时间轴乱掉 —— 折线图的 X 轴变成按数值
     从大到小排,看上去像一条一路下滑的曲线,其实只是把日期打乱了。 */
  const orderParts: string[] = [];
  for (const item of query.orderBy ?? []) {
    const measure = item.measure ? measures.find((m) => (m.alias || m.field) === item.name) : undefined;
    if (item.measure && !measure) continue;              // 排序指着的度量已经不在了
    if (!item.measure && !dims.includes(item.name)) continue; // 维度也一样
    const expr = item.measure ? q(measure!.alias || measure!.field) : dimExpr(item.name);
    orderParts.push(`${expr}${item.dir === "desc" ? " DESC" : ""}`);
  }
  /* 维度补在后面当并列时的次序 —— 少了它,值相同的行顺序由数据库随便定,
     翻页和「取前 N 行」就不稳定(同一份数据两次打开不一样)。 */
  for (const name of dims) {
    const expr = dimExpr(name);
    if (!orderParts.some((part) => part === expr || part === `${expr} DESC`)) orderParts.push(expr);
  }
  if (orderParts.length && (query.orderBy?.length || !(query.topN && query.topN > 0))) {
    lines.push(`ORDER BY ${orderParts.join(", ")}`);
  } else if (query.topN && query.topN > 0 && measures.length) {
    lines.push(`ORDER BY ${q(measures[0].alias || measures[0].field)} DESC`);
  }
  const rows = query.topN && query.topN > 0 ? query.topN : query.limit;
  if (rows && rows > 0) lines.push(paginationClause(kind, rows));
  return lines.join("\n");
}
