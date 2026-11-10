import { STYLE_PROPERTIES } from './styleSchema';
import { WIDGET_TYPES } from '../dashboard/domain';
import { WIDGET_SPECS, bindingProblem } from '../dashboard/widgetSpecs';
import type { JsonSchema } from './jsonSchema';
import type { LayoutItem, LayoutPlan } from './layout';
import type { AgentState } from './state';


/**
 * 给设计 AI 的「产品里有什么」。**全部从看板自己的定义生成**:
 *   组件 —— dashboard/widgetSpecs.ts 的说明书(画出来是什么、要什么数据)
 *   样式 —— styleSchema.ts 的字段清单(编译期保证跟看板的样式类型一致)
 * 看板加了组件或样式,这里不用改,AI 下一次就能看到。
 *
 * 只讲「有什么」,不讲「什么时候该用什么」—— 用哪个、怎么摆,是 AI 自己的判断。
 * (以前这里有一份「遇到 X 用 Y」的清单,被用户否了:那是替它做决定。)
 */
export function componentGuide(): string {
  return WIDGET_TYPES.map((type) => {
    const spec = WIDGET_SPECS[type];
    const range = ([lo, hi]: [number, number]) => (lo === hi ? `${lo}` : `${lo}–${hi}`);
    const data = spec.userContent
      ? spec.userContent
      : spec.metrics[1] === 0 && spec.dimensions[1] === 0
        ? "不绑数据"
        : [
          `指标 ${range(spec.metrics)} 个${spec.metricRole ? `(${spec.metricRole})` : ""}`,
          `维度 ${range(spec.dimensions)} 个${spec.dimensionRole ? `(${spec.dimensionRole})` : ""}`,
          spec.series ? `seriesDimension:${spec.series}${spec.seriesRequired ? "(必填)" : ""}` : "",
          spec.secondary ? "可放 secondaryMetricIds 做右轴" : "",
        ].filter(Boolean).join(";");
    return `- ${type}「${spec.label}」:${spec.shows}。${data}${spec.optionKey && !spec.userContent ? `。专属样式在 ${spec.optionKey}` : ""}`;
  }).join("\n");
}

/** Descriptions and accepted fields share the tool contract; no second hand-written whitelist. */
export function designCapabilityGuide() {
  const walk = (schema: JsonSchema, path: string): string[] => {
    const line = `${path}: ${schema.description ?? schema.type}${schema.enum ? ` [${schema.enum.join(' / ')}]` : ''}${schema.minimum != null ? ` 最小 ${schema.minimum}` : ''}${schema.maximum != null ? ` 最大 ${schema.maximum}` : ''}`;
    return [line, ...Object.entries(schema.properties ?? {}).flatMap(([key, child]) => walk(child, `${path}.${key}`)), ...(schema.items ? walk(schema.items, `${path}[]`) : [])];
  };
  return `以下是产品现有的组件和能力。用哪些、怎么组合、怎么摆,由你根据问题和数据决定;不认识的字段会报出具体错误。

**组件**(type 取值;括号里是它要的数据,数量不对就画不出来):
${componentGuide()}

布局:12 栏,x/y/w/h 控制位置和大小;container 的 tabs 放子组件,不能套娃。
内容:metricIds 为主指标,secondaryMetricIds 为右轴副指标,seriesDimension 为拆分系列。所有引用来自已验证目录。
交互:filtersEnabled/filterFields 是单卡筛选器,chart.drillDimensions 是点击下钻,chart.linkage 是点击联动整板;visible 决定可见性。这些不能改变既定的数据范围。
数字:metrics 的键必须是当前卡片绑定的完整指标 id;metrics.unit 省略即继承目录真实单位。万/亿显示用 numberFormat.scale,unit 保持真实单位;同一卡片的缩放对所有指标生效。decimals 和 numberFormat 只改显示,不能通过改后缀伪装口径。
配置不写就用产品默认值,不用把字段填一遍。

**样式字段**:
${Object.entries(STYLE_PROPERTIES).flatMap(([key, schema]) => walk(schema, key)).join('\n')}`;
}

export function allLayoutItems(layout: LayoutPlan): LayoutItem[] {
  return layout.items.flatMap((item) => [item, ...(item.tabs ?? []).flatMap((tab) => tab.items)]);
}

/** Presentation freedom never permits changing metric semantics or broadening data scope. */
export function validateDesignBindings(layout: LayoutPlan, state: AgentState): string[] {
  const known = new Map((state.validatedMetrics ?? []).map((m) => [m.metricId, m]));
  const errors: string[] = [];
  const items = allLayoutItems(layout);
  if (items.length > 30) errors.push('整板含分页最多30个组件，请精简重复表达');
  for (const item of items) {
    if (item.type === 'pie' && (item.chart?.pieHole ?? 42) >= (item.chart?.pieOuterRadius ?? 75)) errors.push(`「${item.title}」环形内半径必须小于外半径`);
    const ids = [...item.metricIds, ...(item.secondaryMetricIds ?? [])];
    const label = `「${item.title}」`;
    for (const id of ids) if (!known.has(id)) errors.push(`${label}引用未验证指标 ${id}`);
    const dimensions = new Set(ids.flatMap((id) => known.get(id)?.supportedDimensions ?? []));
    for (const dim of [...item.dimensions, ...(item.seriesDimension ? [item.seriesDimension] : []), ...(item.chart?.drillDimensions ?? []), ...(item.filterFields ?? []).filter((d) => d !== 'date')]) {
      if (!dimensions.has(dim) || ids.some((id) => !known.get(id)?.supportedDimensions.includes(dim))) errors.push(`${label}指标不共同支持维度 ${dim}`);
    }
    for (const options of [item.chart, item.kpi]) {
      for (const group of options?.metricGroups ?? []) if (group.metricIds.some((id) => !ids.includes(id))) errors.push(`${label}切换组包含未绑定指标`);
    }
    for (const [id, value] of Object.entries(item.metrics ?? {})) {
      if (!ids.includes(id)) errors.push(`${label}展示配置 metrics["${id}"] 未绑定；只为 metricIds / secondaryMetricIds 中的指标设置展示配置`);
      else if (value.unit && value.unit !== known.get(id)?.unit) errors.push(`${label}指标 ${id} 的真实单位是“${known.get(id)?.unit ?? ""}”，收到“${value.unit}”；删除 metrics["${id}"].unit 即可继承真实单位。万/亿显示用 numberFormat.scale=wan/yi，同一卡片使用统一缩放，不要改写单位或混用缩放`);
      // Business direction belongs to the metric center; it is not an aesthetic choice.
      if (value.direction && value.direction !== (known.get(id)?.direction ?? 'neutral')) errors.push(`${label}请沿用指标中心的好坏方向，不在设计中改写`);
    }
    const suffix = item.numberFormat?.suffix?.trim();
    if (suffix && ids.some((id) => { const unit = known.get(id)?.unit ?? ''; const scale = (item.numberFormat?.scale ?? item.scale) === 'wan' ? '万' : (item.numberFormat?.scale ?? item.scale) === 'yi' ? '亿' : ''; return suffix !== scale + unit; })) errors.push(`${label}数字后缀与真实指标单位不一致`);
    const lock = item.lockedScope;
    if (lock && state.scope) {
      if (lock.start && lock.start < state.scope.dateRange.start || lock.end && lock.end > state.scope.dateRange.end || lock.start && lock.end && lock.start > lock.end) errors.push(`${label}单卡日期超出已核对范围`);
      for (const [field, values] of Object.entries(lock.filters ?? {})) {
        const allowed = state.scope.filters.find((f) => f.field === field)?.values;
        if (!allowed || values.some((v) => !allowed.includes(v))) errors.push(`${label}锁定筛选必须是已核对取值的子集：${field}`);
      }
    }
    // 组件要的数据个数(散点要两个指标、热力要纵轴…)—— 画不画得出来,不是选得好不好
    const shape = bindingProblem(item.type, { metrics: item.metricIds.length, dimensions: item.dimensions.length, series: !!item.seriesDimension });
    if (shape) errors.push(`${label}${shape}`);
    if (item.secondaryMetricIds?.length && !WIDGET_SPECS[item.type].secondary) errors.push(`${label}${WIDGET_SPECS[item.type].label}没有右轴,secondaryMetricIds 放不上去`);
    if (item.chart?.drillDimensions?.includes(item.dimensions[0])) errors.push(`${label}下钻链是「再往下钻到哪几层」,不该再写一遍当前的分组维度`);
    const tableDims = [...Object.keys(item.table?.dimensionPlacements ?? {}), ...Object.keys(item.table?.dimensionSorts ?? {}), ...Object.keys(item.table?.dimensionCustomOrders ?? {}), ...(item.table?.subtotalDimension ? [item.table.subtotalDimension] : [])];
    if (tableDims.some((dim) => !item.dimensions.includes(dim))) errors.push(`${label}表格设置引用了未绑定维度`);
    if (item.type !== 'container' && item.tabs?.length) errors.push(`${label}只有容器可以分页`);
    if (item.tabs?.some((tab) => tab.items.some((child) => child.type === 'container' || child.tabs?.length))) errors.push(`${label}容器不能嵌套`);
  }
  return errors;
}
