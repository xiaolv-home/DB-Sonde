import { executeDataset } from "./query";
import type { DashboardDataset } from "./domain";
import type { Dataset } from "../datasets/domain";
import { buildWidgetSql } from "../datasets/widgetQuery";
import type { DbKind } from "../../types";
import { compareText } from "../../lib/collate";
/**
 * 取数侧的 headless 接口 —— 和 dashboardService 一样,是为了让程序(AI Agent 的
 * Tool、脚本、测试)能调到这些能力,而不是只有 React 组件能调。
 */

export interface DimensionValues {
  values: string[];
  /** 取到上限了 —— 后面还有,只是没拿回来。界面得说出来,不能装作就这些。 */
  truncated: boolean;
}

/* 去重和排序都在这儿做:SQL 已经 GROUP BY 过一遍,但各家数据库的排序规则不一样,
   中文要按拼音排只能在前端排。取数一律走 executeDataset —— 那里有全应用唯一的
   查询缓存(5 分钟、并发去重、跟着「刷新」按钮作废),别再另起一套。 */
async function distinctOf(
  dataset: DashboardDataset,
  field: string,
  translateError: Parameters<typeof executeDataset>[1],
  limit: number,
): Promise<DimensionValues> {
  const result = await executeDataset(dataset, translateError, limit);
  const index = result.columns.findIndex((column) => column.name === field);
  return {
    values: index < 0 ? [] : [...new Set(result.rows.map((row) => String(row[index] ?? "")).filter(Boolean))]
      .sort(compareText),
    truncated: result.rows.length >= limit,
  };
}

/** 枚举某个维度在**组件编译好的数据集**里的取值。
 *
 *  复用数据集本身、只把 groupBy 换成这一个维度,所以取值天然和该组件的口径/日期范围
 *  一致。导入的 HTML 和 AI 生成的指标看板没有全局数据集可查,只能走这条。 */
export function dimensionValues(
  dataset: DashboardDataset,
  field: string,
  translateError: Parameters<typeof executeDataset>[1],
  limit = 1000,
): Promise<DimensionValues> {
  /* 组件自己的「前 N 名」和排序不能带过来:那是按度量截前 N 行,列取值时就只剩 N 个,
     而且行数没到上限,还会说成「就这些」。 */
  const from = dataset.compiledFrom;
  const listing = from ? { ...from, query: { ...from.query, topN: 0, orderBy: undefined } } : undefined;
  return distinctOf({ ...dataset, groupBy: [field], compiledFrom: listing }, field, translateError, limit);
}

/** 枚举某个维度在**全局数据集**里的取值。
 *
 *  组件编译出来的 SQL 只 SELECT 了它自己用到的几列,想筛/锁一个它没展示的维度,
 *  问它是问不出来的 —— 所以这里从数据集本身现编一句 GROUP BY。 */
export function datasetDimensionValues(
  dataset: Dataset,
  field: string,
  kind: DbKind | undefined,
  translateError: Parameters<typeof executeDataset>[1],
  limit = 1000,
): Promise<DimensionValues> {
  return distinctOf({
    // id 只用来做缓存键之外的标识;真正决定缓存命中的是下面那句 SQL。
    id: `dataset:${dataset.id}:${field}`,
    name: dataset.name,
    sourceType: "sql",
    connectionId: dataset.connectionId,
    database: dataset.database,
    sql: buildWidgetSql(dataset, { dimensions: [field], measures: [] }, kind),
    fields: [],
  }, field, translateError, limit);
}

/** 把一个自然语言说法落到确定的维度取值上。
 *
 *  三级匹配:精确 → 前缀 → 包含。命中多个时**原样返回候选,绝不自己挑** ——
 *  上层(将来是 Agent 的 ScopeResolver)据此决定是直接用还是停下来问人。
 *  「华东」在只有「华东大区」一个候选时可以直接用;要是还有「华东南」就必须问。 */
export { matchDimensionValue } from "../../lib/dimensionMatching";
