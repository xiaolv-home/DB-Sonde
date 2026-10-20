/**
 * 把「组件选的全局数据集 + 它选的维度/度量」编译成运行时用的数据集。
 *
 * 取数管线只认一件事:一段 SQL 加一个连接。所以这里把两边合起来算出那段聚合 SQL,
 * 管线不需要知道数据集是写出来的还是关联出来的,也不需要知道组件选了什么。
 *
 * 每个组件编译出一份 —— 两个组件可以引用同一个数据集却选不同的维度,那是两句不同
 * 的 SQL。编译结果的 id 用组件 id,运行时按组件找自己的那份。
 */
import type { DashboardWidget, DashboardDataset } from "./domain";
import { isTimeField, type Dataset } from "../datasets/domain";
import { buildWidgetSql, type AggKind } from "../datasets/widgetQuery";
import type { DbKind } from "../../types";

/** 数据集里的时间列 —— 看板顶上的「数据日期」落在它身上。 */
function dateFieldOf(dataset: Dataset, widget: DashboardWidget): string | undefined {
  // 标成不保留的列不在子查询里,日期条件落在它身上就是一句「没有这一列」。
  const timeNamed = (name: string) => {
    const field = dataset.fields.find((f) => f.name === name);
    return !field?.hidden && isTimeField(field);
  };
  // 组件自己按日期分组的话就用那一列,口径最直观。
  const bound = (widget.bindings.dimensions ?? []).find(timeNamed);
  if (bound) return bound;
  return dataset.fields.find((f) => !f.hidden && isTimeField(f))?.name;
}

export function widgetQueryOf(widget: DashboardWidget, dataset?: Dataset, scope?: { start?: string; end?: string }) {
  const aggregations = widget.bindings.aggregations ?? {};
  const locked = widget.options.lockedScope;
  /* 图例维度也得进 GROUP BY。它本来只写进了 bindings,渲染层按列名去结果里找它,
     可 SQL 从没查过这一列 —— 找不着就退回"只有一条线",看上去就是"图例维度没生效"。 */
  const analysis = widget.bindings.dimensions ?? (widget.bindings.dimension ? [widget.bindings.dimension] : []);
  const series = widget.bindings.seriesDimension;
  /* 数据集建好之后还能改:去掉一列、把它标成「不保留」、改个名。改完那一列就不在子查询
     的 SELECT 里了,而组件还绑着它 —— 编出来的 SQL 引用一个不存在的列,卡片上直接甩一句
     数据库报错。不如当它没绑:组件说「还没选维度/度量」,人一看就知道回去补,
     而不是对着 "Unknown column 'gmv_amt'" 发愣。 */
  const exposed = new Set((dataset?.fields ?? []).filter((f) => !f.hidden).map((f) => f.name));
  const keep = (name: string) => !dataset || exposed.has(name);
  /* 指标卡不分组。带着维度的话查回来是多行,而卡片会把多行再聚合一次 —— 求和还凑合,
     求平均就成了「平均数的平均数」,数字是错的,而且错得看不出来。绑定界面对指标卡
     本来就不给选维度,可 AI 生成的组件和老文档里可能带着。 */
  const dimensions = widget.type === "kpi"
    ? []
    : [...new Set([...analysis, ...(series ? [series] : [])])].filter(keep);
  // 组件锁了自己的日期范围就用它的,否则跟着看板顶上的数据日期。
  const start = locked?.start ?? scope?.start;
  const end = locked?.end ?? scope?.end;
  const dateField = dataset ? dateFieldOf(dataset, widget) : undefined;
  return {
    dimensions,
    grains: widget.bindings.grains,
    measures: (widget.bindings.measures ?? []).filter(keep).map((field) => ({
      field,
      agg: (aggregations[field] ?? "sum") as AggKind,
    })),
    filters: Object.entries(locked?.filters ?? {})
      .filter(([field]) => keep(field))
      .map(([field, values]) => ({ field, values })),
    ...(dateField && start && end ? { dateRange: { field: dateField, start, end } } : {}),
    /* 分了系列就别让 SQL 去 LIMIT:那是按行截断,Top 5 会变成"总共只剩 5 行",
       几条线各被砍掉一截。分系列时的 Top N 是"前 N 个分类",渲染层按分类排完再切。 */
    topN: series || widget.type === "kpi" ? 0 : widget.options.topN,
    orderBy: orderByOf(widget, dimensions, dataset),
  };
}

/**
 * 把组件上设的排序算成 SQL 的 ORDER BY。
 *
 * 必须编进 SQL:取数有行数上限,后端是按 ORDER BY 截前 N 行的。只在前端排的话,
 * 排的是「截回来的那一段」—— 日粒度下几十万行截到五万,再按 GMV 降序,看到的是那五万
 * 行里的最大值,日期还从中间某天开始。用户看到的就是「排完序数据不全」。
 *
 * 时间维度不给按数值排:时间序列不是排行榜,按 GMV 把月份打乱之后,那条折线什么也不
 * 表示了(看上去像一路上涨,其实只是从小到大摞了一遍)。想看排名换条形图。
 */
function orderByOf(widget: DashboardWidget, dimensions: string[], dataset?: Dataset) {
  const to = widget.options.table ?? {};
  const isTime = (name: string) => isTimeField(dataset?.fields.find((f) => f.name === name));
  const out: Array<{ name: string; dir: "asc" | "desc"; measure?: boolean }> = [];

  const ms = to.metricSort;
  const field = ms?.key.startsWith("field:") ? ms.key.slice("field:".length) : undefined;
  /* 图表的分类轴是时间就不认指标排序。表格没这问题:那是一张明细,按金额排很正常。 */
  const xIsTime = widget.type !== "table" && dimensions.some(isTime);
  if (field && ms && !xIsTime && (widget.bindings.measures ?? []).includes(field)) {
    out.push({ name: field, dir: ms.dir, measure: true });
  }
  for (const name of dimensions) {
    const raw = to.dimensionSorts?.[name];
    const dir = raw === "desc" || raw === "group_desc" ? "desc" : raw ? "asc" : undefined;
    if (dir) out.push({ name, dir });
  }
  return out.length ? out : undefined;
}

/** 编译当前看板所有组件的取数。数据集不存在或还没选的组件直接跳过 —— 画布上它会
 *  提示「还没选数据集」,而不是抛一句 SQL 错误。 */
export function resolveWidgetDatasets(
  widgets: DashboardWidget[],
  datasets: Dataset[],
  kindOf: (connectionId: string) => DbKind | undefined,
  /** 看板顶上的数据日期。组件没锁自己的范围时用它收窄。 */
  scope?: { start?: string; end?: string },
  /** 看板文档自带的数据集(导入的 HTML、AI 生成的指标看板)。编译不出来的组件靠它取数,
   *  所以不能直接丢掉 —— 丢了导进来的看板就是一片空白。 */
  existing: DashboardDataset[] = [],
): DashboardDataset[] {
  const resolved: DashboardDataset[] = [];
  for (const widget of widgets) {
    const dataset = datasets.find((item) => item.id === widget.datasetId);
    if (!dataset) continue;
    const kind = kindOf(dataset.connectionId);
    const query = widgetQueryOf(widget, dataset, scope);
    let sql = "";
    try {
      sql = buildWidgetSql(dataset, query, kind);
    } catch {
      continue; // 数据集还没写完,别把画布搞崩
    }
    resolved.push({
      id: widget.id,
      name: dataset.name,
      sourceType: "sql",
      connectionId: dataset.connectionId,
      database: dataset.database,
      sql,
      /* 只导出「保留」的字段。标成不保留的列压根不在子查询的 SELECT 里,可它们照样
         出现在下钻候选、锁定范围这些地方 —— 选中就是一句「没有这一列」。
         这个数据集对外的样子就该是它真能查的那些列。 */
      fields: dataset.fields.filter((field) => !field.hidden).map((field) => ({
        name: field.name,
        typeName: field.type ?? "",
        role: field.role,
      })),
      dimensionLabels: Object.fromEntries(
        dataset.fields.filter((f) => f.label).map((f) => [f.name, f.label!]),
      ),
      // 下钻/同环比/组件日期要换个条件重编一遍,留着原料。
      compiledFrom: { dataset, query, kind },
    });
  }
  // 编译产物优先(它跟着组件当前选的维度/度量走),文档自带的补在后面。
  const compiled = new Set(resolved.map((item) => item.id));
  return [...resolved, ...existing.filter((item) => !compiled.has(item.id))];
}

/**
 * 找组件那份运行时数据集。
 *
 * 编译产物按组件 id 存(同一个数据集、不同维度是两句 SQL),所以先按组件 id 找。
 * 找不到再按 widget.datasetId —— 那是导入的 HTML / AI 生成的看板,它们自带
 * document.datasets,组件靠 datasetId 指过去。两条路都要留,不然导进来的看板取不到数。
 */
export function datasetOf<T extends { id: string }>(
  widget: { id: string; datasetId?: string },
  datasets: T[],
): T | undefined {
  return datasets.find((item) => item.id === widget.id)
    ?? (widget.datasetId ? datasets.find((item) => item.id === widget.datasetId) : undefined);
}


/**
 * 编译结果没变就沿用上一次那个对象。
 *
 * 每改一点东西(动个绑定、保存一下)文档就是个新对象,编译会整份重做,于是每个组件拿到的
 * dimensionLabels、fields 都是新的 —— 下游那些 useMemo 和 React.memo 一个也命中不了,
 * 一张五百行上百列的透视表就要从头算一遍再全量重绘。这就是「选完字段卡一下」
 * 和「保存之后一顿一顿」。
 *
 * 判断只看真正决定这份数据的东西:查哪个连接、哪句 SQL、数据集改没改过。
 */
function signatureOf(item: DashboardDataset): string {
  return [item.id, item.connectionId, item.database ?? "", item.sql, item.compiledFrom?.dataset.updatedAt ?? ""].join("\u0001");
}

export function reuseUnchanged(previous: DashboardDataset[], next: DashboardDataset[]): DashboardDataset[] {
  if (!previous.length) return next;
  const before = new Map(previous.map((item) => [signatureOf(item), item]));
  let same = previous.length === next.length;
  const out = next.map((item, index) => {
    const hit = before.get(signatureOf(item));
    if (!hit) { same = false; return item; }
    if (previous[index] !== hit) same = false;
    return hit;
  });
  // 整份都没变的话连数组本身也沿用,省掉上面一层的重算。
  return same ? previous : out;
}
