/**
 * 看板工作台的「替人想好」那一层 —— 全是纯函数,界面只管调用。
 *
 *   placeField     点一下 / 拖进来一个字段,它该进哪个区
 *   convertWidget  换图表类型时字段怎么跟过去(不清空,按新类型能放下的放)
 *   recommend      按已选字段推荐图表类型
 *   widgetFromFields  往空白画布拖字段:按字段长出一个合适的组件
 *
 * 目标是新手不懂也能做出好看的:默认值要对,推荐要准,不确定就不猜。
 */

import { isTimeField, type Dataset, type DatasetField } from "../../datasets/domain";
import type { AggKind, TimeGrain, WidgetCondition } from "../../datasets/widgetQuery";
import { LEAF_WIDGET_TYPES, createWidget, type DashboardWidget, type DashboardWidgetType } from "../domain";

/** 每种组件的字段区。顺序就是界面上从上到下的顺序。 */
export type ShelfId = "rows" | "columns" | "dimensions" | "series" | "measures" | "conditions";

/** 取数的组件类型(不含文本和容器),顺序就是类型切换条上的顺序。 */
export const DATA_TYPES: DashboardWidgetType[] = LEAF_WIDGET_TYPES.filter((t) => t !== "text");

export function shelvesOf(type: DashboardWidgetType): ShelfId[] {
  switch (type) {
    case "kpi": return ["measures", "conditions"];
    case "line":
    case "bar": return ["dimensions", "measures", "series", "conditions"];
    case "pie": return ["dimensions", "measures", "conditions"];
    case "table": return ["rows", "columns", "measures", "conditions"];
    default: return [];
  }
}

export function shelfTitle(type: DashboardWidgetType, shelf: ShelfId): string {
  switch (shelf) {
    case "rows": return "行";
    case "columns": return "列";
    case "dimensions": return type === "pie" ? "分类" : type === "bar" ? "分类轴" : "横轴";
    case "series": return "拆分系列";
    case "measures": return type === "kpi" ? "指标" : type === "table" ? "数值" : "数值";
    case "conditions": return "条件";
  }
}

export function shelfLimit(type: DashboardWidgetType, shelf: ShelfId): number {
  if (shelf === "conditions") return 20;
  if (shelf === "series") return 1;
  if (shelf === "dimensions") return type === "pie" ? 1 : 1;
  if (shelf === "rows" || shelf === "columns") return 4;
  if (shelf === "measures") return type === "table" ? 12 : type === "pie" ? 1 : 6;
  return 0;
}

export const visibleFields = (dataset?: Dataset) => (dataset?.fields ?? []).filter((f) => !f.hidden);
export const fieldLabel = (dataset: Dataset | undefined, name: string) =>
  dataset?.fields.find((f) => f.name === name)?.label || name;

// ── 读写组件绑定 ───────────────────────────────────────────────────

export function dimsOf(widget: DashboardWidget): string[] {
  return widget.bindings.dimensions?.length
    ? widget.bindings.dimensions
    : widget.bindings.dimension ? [widget.bindings.dimension] : [];
}

/** 某个区里现在放着哪些字段。 */
export function shelfItems(widget: DashboardWidget, shelf: ShelfId): string[] {
  const placements = widget.options.table?.dimensionPlacements ?? {};
  switch (shelf) {
    case "rows": return dimsOf(widget).filter((d) => placements[d] !== "column");
    case "columns": return dimsOf(widget).filter((d) => placements[d] === "column");
    case "dimensions": return dimsOf(widget);
    case "series": return widget.bindings.seriesDimension ? [widget.bindings.seriesDimension] : [];
    case "measures": return widget.bindings.measures ?? [];
    case "conditions": return (widget.bindings.conditions ?? []).map((c) => c.field);
  }
}

/** 维度列表写回去:dimension(单数)是渲染层还在读的老字段,跟着首个走。 */
function withDims(widget: DashboardWidget, dims: string[], placements?: Record<string, "row" | "column">): DashboardWidget {
  const unique = [...new Set(dims)];
  const next: DashboardWidget = { ...widget, bindings: { ...widget.bindings, dimensions: unique, dimension: unique[0] } };
  if (placements) {
    const kept = Object.fromEntries(Object.entries(placements).filter(([k]) => unique.includes(k)));
    next.options = {
      ...widget.options,
      table: {
        ...(widget.options.table ?? {}),
        dimensionPlacements: kept,
        layout: Object.values(kept).includes("column") ? "pivot" : "flat",
      },
    };
  }
  return next;
}

/** 把某个区整个换成这一串字段(拖动排序、移除、从别的区拖进来都落到这里)。 */
export function setShelf(widget: DashboardWidget, shelf: ShelfId, names: string[], dataset?: Dataset): DashboardWidget {
  const limit = shelfLimit(widget.type, shelf);
  const list = [...new Set(names)].slice(0, limit);
  const placements = { ...(widget.options.table?.dimensionPlacements ?? {}) };
  switch (shelf) {
    case "rows":
    case "columns": {
      const other = shelfItems(widget, shelf === "rows" ? "columns" : "rows").filter((d) => !list.includes(d));
      for (const d of list) placements[d] = shelf === "rows" ? "row" : "column";
      const rows = shelf === "rows" ? list : other;
      const cols = shelf === "rows" ? other : list;
      return withDims(widget, [...rows, ...cols], placements);
    }
    case "dimensions": {
      const series = widget.bindings.seriesDimension;
      const next = withDims(widget, list);
      return series && list.includes(series) ? { ...next, bindings: { ...next.bindings, seriesDimension: undefined } } : next;
    }
    case "series": {
      const name = list[0];
      return { ...widget, bindings: { ...widget.bindings, seriesDimension: name || undefined } };
    }
    case "measures": {
      const before = widget.bindings.measures ?? [];
      const aggregations = { ...(widget.bindings.aggregations ?? {}) };
      for (const gone of before.filter((n) => !list.includes(n))) delete aggregations[gone];
      // 新加进来的度量按数据集里定的默认汇总走 —— 那是建数据集的人想清楚过的。
      for (const added of list.filter((n) => !before.includes(n))) {
        const preset = dataset?.fields.find((f) => f.name === added)?.defaultAgg;
        aggregations[added] = preset ?? defaultAggFor(dataset?.fields.find((f) => f.name === added));
      }
      return { ...widget, bindings: { ...widget.bindings, measures: list, aggregations } };
    }
    case "conditions":
      return widget; // 条件有自己的结构,走 setConditions
  }
}

export function setConditions(widget: DashboardWidget, conditions: WidgetCondition[]): DashboardWidget {
  return { ...widget, bindings: { ...widget.bindings, conditions } };
}

/** 维度当度量用(拖一个维度进「数值」):默认是去重计数 —— 「多少家店」。 */
export function defaultAggFor(field: DatasetField | undefined): AggKind {
  if (!field) return "sum";
  return field.role === "dimension" ? "count_distinct" : "sum";
}

/** 时间维度刚放上去时给个合适的粒度:日期列按月看最常见,带时分的按日。 */
export function defaultGrainFor(field: DatasetField | undefined): TimeGrain | undefined {
  if (!isTimeField(field)) return undefined;
  if (/year|年/i.test(field!.name)) return "raw";
  if (/month|月/i.test(field!.name) && !/date|day|日/i.test(field!.name)) return "raw";
  return "day";
}

// ── 点一下 / 拖进来 ────────────────────────────────────────────────

/**
 * 一个字段该进哪个区。规则跟人的直觉一致:
 *   度量 → 数值;
 *   维度 → 图表进横轴(横轴满了且能拆系列就进系列),表格进行;
 *   指标卡上点维度 → 当成「计数」放进指标(多少家店)。
 */
export function targetShelf(widget: DashboardWidget, field: DatasetField): ShelfId | undefined {
  const shelves = shelvesOf(widget.type);
  if (!shelves.length) return undefined;
  if (field.role === "measure") return "measures";
  if (widget.type === "kpi") return "measures";
  if (widget.type === "table") return "rows";
  const dims = dimsOf(widget);
  if (dims.length < shelfLimit(widget.type, "dimensions") || dims.includes(field.name)) return "dimensions";
  if (shelves.includes("series") && !widget.bindings.seriesDimension) return "series";
  return "dimensions"; // 替换掉原来那个
}

export function addToShelf(widget: DashboardWidget, shelf: ShelfId, name: string, dataset?: Dataset, index?: number): DashboardWidget {
  const field = dataset?.fields.find((f) => f.name === name);
  if (shelf === "conditions") {
    const conditions = [...(widget.bindings.conditions ?? [])];
    const measure = field?.role === "measure";
    conditions.push({
      field: name,
      op: measure ? "gt" : "in",
      values: [],
      ...(measure ? { agg: widget.bindings.aggregations?.[name] ?? field?.defaultAgg ?? "sum" } : {}),
    });
    return setConditions(widget, conditions);
  }
  const current = shelfItems(widget, shelf).filter((n) => n !== name);
  const limit = shelfLimit(widget.type, shelf);
  let next: string[];
  if (limit === 1) next = [name];
  else {
    next = [...current];
    next.splice(index ?? next.length, 0, name);
    next = next.slice(-limit);
  }
  let out = setShelf(widget, shelf, next, dataset);
  // 一个字段只在一个维度区里出现:拖进列就从行里拿走,反之亦然;拆系列和横轴也一样。
  if (shelf === "series") out = setShelf(out, "dimensions", dimsOf(out).filter((d) => d !== name), dataset);
  if (shelf !== "measures" && shelf !== "series" && out.bindings.seriesDimension === name) {
    out = { ...out, bindings: { ...out.bindings, seriesDimension: undefined } };
  }
  const grain = shelf !== "measures" ? defaultGrainFor(field) : undefined;
  if (grain && !out.bindings.grains?.[name]) {
    out = { ...out, bindings: { ...out.bindings, grains: { ...(out.bindings.grains ?? {}), [name]: grain } } };
  }
  return out;
}

export function removeFromShelf(widget: DashboardWidget, shelf: ShelfId, index: number, dataset?: Dataset): DashboardWidget {
  if (shelf === "conditions") {
    return setConditions(widget, (widget.bindings.conditions ?? []).filter((_, i) => i !== index));
  }
  const items = shelfItems(widget, shelf);
  return setShelf(widget, shelf, items.filter((_, i) => i !== index), dataset);
}

/** 点字段面板里的一个字段:自动放到对的区,再点一次就拿掉。 */
export function toggleField(widget: DashboardWidget, name: string, dataset?: Dataset): DashboardWidget {
  const field = dataset?.fields.find((f) => f.name === name);
  if (!field) return widget;
  for (const shelf of shelvesOf(widget.type)) {
    if (shelf === "conditions") continue;
    const items = shelfItems(widget, shelf);
    const at = items.indexOf(name);
    if (at >= 0) return removeFromShelf(widget, shelf, at, dataset);
  }
  const shelf = targetShelf(widget, field);
  return shelf ? addToShelf(widget, shelf, name, dataset) : widget;
}

// ── 换类型 ────────────────────────────────────────────────────────

/**
 * 换图表类型:字段尽量跟过去。条形图换折线图什么都不丢;换成指标卡丢掉维度
 * (指标卡不分组);换成饼图只留一个分类、一个数值。
 */
export function convertWidget(widget: DashboardWidget, type: DashboardWidgetType, dataset?: Dataset): DashboardWidget {
  if (widget.type === type) return widget;
  const dims = dimsOf(widget);
  const series = widget.bindings.seriesDimension;
  const measures = widget.bindings.measures ?? [];
  let allDims = [...dims, ...(series && !dims.includes(series) ? [series] : [])];
  // 折线图的横轴是时间:有时间维度就让它当横轴,别的去拆系列
  if (type === "line") {
    const isTime = (n: string) => isTimeField(dataset?.fields.find((f) => f.name === n));
    allDims = [...allDims.filter(isTime), ...allDims.filter((n) => !isTime(n))];
  }
  let next: DashboardWidget = { ...widget, type };
  const placements: Record<string, "row" | "column"> = {};
  switch (type) {
    case "kpi":
      next = withDims(next, []);
      next.bindings = { ...next.bindings, seriesDimension: undefined, measures: measures.slice(0, 6) };
      break;
    case "pie":
      next = withDims(next, allDims.slice(0, 1));
      next.bindings = { ...next.bindings, seriesDimension: undefined, measures: measures.slice(0, 1) };
      break;
    case "line":
    case "bar":
      next = withDims(next, allDims.slice(0, 1));
      next.bindings = { ...next.bindings, seriesDimension: allDims[1], measures: measures.slice(0, 6) };
      break;
    case "table":
      for (const d of allDims) placements[d] = widget.options.table?.dimensionPlacements?.[d] ?? "row";
      next = withDims(next, allDims.slice(0, 4), placements);
      next.bindings = { ...next.bindings, seriesDimension: undefined };
      break;
  }
  return next;
}

// ── 推荐 ──────────────────────────────────────────────────────────

export interface Recommendation { type: DashboardWidgetType; reason: string }

/** 按组件现在放着的字段推荐图表类型。第一个是最推荐的。 */
export function recommend(widget: DashboardWidget, dataset?: Dataset): Recommendation[] {
  const dims = [...dimsOf(widget), ...(widget.bindings.seriesDimension ? [widget.bindings.seriesDimension] : [])];
  const measures = widget.bindings.measures ?? [];
  const isTime = (n: string) => isTimeField(dataset?.fields.find((f) => f.name === n));
  const out: Recommendation[] = [];
  if (!measures.length && !dims.length) return out;
  if (dims.length === 0) out.push({ type: "kpi", reason: "只有数值,适合做成大数字" });
  if (dims.some(isTime)) out.push({ type: "line", reason: "有时间,看趋势" });
  if (dims.length >= 1 && measures.length >= 1) out.push({ type: "bar", reason: "按分类比大小" });
  if (dims.length === 1 && measures.length === 1 && !dims.some(isTime)) out.push({ type: "pie", reason: "看占比" });
  if (dims.length >= 2 || measures.length >= 4) out.push({ type: "table", reason: "字段多,用表格看全" });
  if (!out.some((r) => r.type === "table")) out.push({ type: "table", reason: "看明细" });
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(r.type) ? false : (seen.add(r.type), true)));
}

/** 往空白画布上拖一个字段:按字段长出组件。 */
export function widgetFromField(dataset: Dataset, name: string, title?: string): DashboardWidget | undefined {
  const field = dataset.fields.find((f) => f.name === name);
  if (!field) return undefined;
  const measure = visibleFields(dataset).find((f) => f.role === "measure");
  let widget: DashboardWidget;
  if (field.role === "measure") {
    widget = createWidget("kpi", dataset.id, title ?? (field.label || field.name));
    widget = addToShelf(widget, "measures", name, dataset);
  } else {
    const type: DashboardWidgetType = isTimeField(field) ? "line" : "bar";
    widget = createWidget(type, dataset.id, title ?? `按${field.label || field.name}`);
    widget = addToShelf(widget, "dimensions", name, dataset);
    if (measure) widget = addToShelf(widget, "measures", measure.name, dataset);
  }
  return { ...widget, datasetId: dataset.id };
}
