import type { AgentState } from "../state";
import type { LayoutItem } from "../layout";
import type { ObservedPlan, PlanReader } from "../planReader";
import type { ReviewContext } from "../review";
import { maxOf, minOf } from "../../../lib/numbers";

export function observedPlans(state: AgentState, readPlan: PlanReader): ObservedPlan[] {
  return [...(state.plans ?? []), ...(state.supportingPlans ?? [])]
    .flatMap(ref => { const plan = readPlan(ref.planId); return plan?.result ? [plan] : []; });
}

/** Prefer the exact grain and require all bound metrics, including secondary series. */
export function planForItem(item: LayoutItem, plans: ObservedPlan[]): ObservedPlan | undefined {
  const metrics = [...item.metricIds, ...(item.secondaryMetricIds ?? [])];
  if (!metrics.length) return undefined;
  const dimensions = [...new Set([...item.dimensions, ...(item.seriesDimension ? [item.seriesDimension] : [])])];
  const candidates = plans.filter(plan => metrics.every(id => plan.metricIds.includes(id)) &&
    dimensions.every(id => plan.shape.dimensions.includes(id)));
  return candidates.find(plan => plan.shape.dimensions.length === dimensions.length) ?? candidates[0];
}

export function observedCounts(item: LayoutItem, plan?: ObservedPlan): { categories: number; points: number; } {
  const result = plan?.result;
  if (!result || !item.dimensions.length) return { categories: 0, points: 0 };
  const categoryIndex = result.columns.findIndex(column => column.name === item.dimensions[0]);
  if (categoryIndex < 0) return { categories: 0, points: 0 };
  const dimensions = [...new Set([...item.dimensions, ...(item.seriesDimension ? [item.seriesDimension] : [])])];
  const indices = dimensions.map(id => result.columns.findIndex(column => column.name === id));
  if (indices.some(index => index < 0)) return { categories: 0, points: 0 };
  const categories = new Set(result.rows.map(row => JSON.stringify(row[categoryIndex]))).size;
  const groups = new Set(result.rows.map(row => JSON.stringify(indices.map(index => row[index])))).size;
  return { categories, points: groups * Math.max(1, item.metricIds.length + (item.secondaryMetricIds?.length ?? 0)) };
}

/** Rebuild index-based context after every edit; dropped cards must not shift another card's facts. */
export function reviewContext(items: LayoutItem[], state: AgentState, plans: ObservedPlan[]): ReviewContext {
  const pointCounts: Record<number, number> = {};
  const magnitudes: Record<number, number> = {};
  const smallest: Record<number, number> = {};
  items.forEach((item, index) => {
    const plan = planForItem(item, plans);
    if (!plan?.result) return;
    const counts = observedCounts(item, plan);
    pointCounts[index] = counts.points;
    if (item.type !== "kpi") return;
    /* 一张 KPI 卡可以放好几个指标,量级可能差着几个数量级 —— 销售额 5682 万和笔均金额
       26 元并排。只看第一个指标定出来的换算,套到整张卡上就会把 26 元显示成「0万元」。
       所以这儿收的是**卡上每个指标**的量级,由验收去判该不该、该用哪一档。 */
    const source = plan.totalResult ?? plan.result;
    const sizes = item.metricIds.flatMap((metricId) => {
      const definition = plan.shape.metrics[plan.metricIds.indexOf(metricId)];
      if (!definition) return [];
      const ci = source.columns.findIndex(column => column.name === definition.field);
      if (ci < 0) return [];
      const values = source.rows.map(row => row[ci])
        .filter(value => (typeof value === "number" || typeof value === "string") && String(value).trim() !== "")
        .map(Number).filter(Number.isFinite);
      if (!values.length) return [];
      if (plan.totalResult) return source.rows.length === 1 && values.length === 1 ? [Math.abs(values[0])] : [];
      /* 可加的指标(sum/count)按行加起来就是卡上显示的数。
         **不可加的不能丢。** 去重计数、平均这些加不得,但这儿要的是"这个数大概
         几位数",不是精确值 —— 拿行内最大值当下界估计就够判跨档了。
         以前这里 return [],于是「营业额 2000 万 + 门店数 48 家」在验收眼里
         只有营业额一个数,magnitude == smallest,跨档判不出来,门店数照样
         显示成「0万家」。修了消费者没修生产者,漏了很久。 */
      if (["sum", "count"].includes(definition.rollup)) {
        return [Math.abs(values.reduce((a, b) => a + b, 0))];
      }
      return [maxOf(values.map(Math.abs))!];
    });
    if (!sizes.length) return;
    magnitudes[index] = maxOf(sizes)!;
    smallest[index] = minOf(sizes)!;
  });
  return {
    pointCounts, magnitudes, smallest,
    validatedMetricIds: (state.validatedMetrics ?? []).map(metric => metric.metricId),
  };
}
