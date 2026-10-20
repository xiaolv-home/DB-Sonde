import type { QueryPlan } from "./queryPlan";

/** How a metric is computed. Generic (not tied to any one业务):
 *  - measure  : 一个聚合表达式 over a base table, e.g. sum(amt)
 *  - ratio    : 分子表达式 / 分母表达式 (× scale), over a base table
 *  - derived  : 由另外两个指标相除(指标套指标)
 *  - sql      : 一段完整 SELECT(万能兜底) */
export type MetricType = "measure" | "ratio" | "derived" | "sql" | "template";

/** A reusable metric — the semantic layer that BI / AI both pull from,
 *  so a number like 销售额 means the same thing everywhere. Stored locally. */
export interface Metric {
  id: string;
  catalogId?: string;
  catalogName?: string;
  name: string; // 显示名 / label
  key: string; // english id (optional)
  enabled: boolean;
  connId: string;
  connName: string;
  database?: string;

  type: MetricType;
  queryPlan?: QueryPlan;
  dimensionLabels?: Record<string, string>;
  source?: string; // 基表 (measure/ratio)
  expression?: string; // measure: 聚合表达式
  numerator?: string; // ratio: 分子表达式
  denominator?: string; // ratio: 分母表达式
  numeratorMetricId?: string; // derived: 分子指标
  denominatorMetricId?: string; // derived: 分母指标
  scale?: number; // ratio/derived: ×几 (百分比填 100)
  precision?: number; // 小数位
  sql?: string; // type=sql: 完整 SELECT

  dimensions?: string[]; // 可下钻的维度列(BI/预览按它分组)
  timeField?: string; // 时间列(时间维度)
  aliases?: string[]; // 别名 —— AI 用它匹配自然语言
  caliber: string; // 口径:这个数怎么算、含/不含什么

  /** 跨分组怎么合并成一个数。不填 = 按聚合表达式自动判断。
   *
   *  之所以要能手填:有些指标光看 SQL 判不出来意图。
   *  「有效天数」= COUNT(DISTINCT 日期),按网点分组之后各店的天数**加起来**就是
   *  网点有效天数(算日均时的分母);而不分组直接查出来的是日历天数。两个都对,
   *  是两个不同的量 —— 要哪个只有定义这个指标的人知道。 */
  rollup?: "sum" | "avg" | "min" | "max" | "count_distinct";

  unit: string; // 元 / 单 / % …
  higherIsBetter?: boolean; // 越大越好?(告警/配色方向)
  category: string; // 分类
  updatedAt: number;
}

