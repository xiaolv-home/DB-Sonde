import { shiftScope } from "../useDashboardRuntime";
import { defaultMetricScope } from "../../metrics/queryPlan";
import type { Metric } from "../../metrics/metricsStore";
import { executeDataset } from "../query";
import type { Cell } from "../../../types";
import { dateFilterFieldsOf } from "../componentFilterFields";
import { isTimeField } from "../../datasets/domain";
import {
  isStaticWidget,
  type DashboardDataset,
  type DashboardDocument,
  type DashboardMetricAggregation,
  type DashboardMetricDefinition,
  type DashboardWidget,
} from "../domain";
import { datasetOf } from "../resolveDatasets";

/** 离线导出:行数硬顶(Rust 端天花板一致)。锁定范围内的明细一次性烘进 HTML。 */
export const EXPORT_ROW_CAP = 200_000;
/** 软提示阈值:单张烘焙表超过它就提醒作者收紧该组件的锁定范围。 */
const SOFT_ROW_WARN = 50_000;

/** 一张烘焙好的结果表(QueryResult 去掉类型元信息,只留列名 + 行,便于 JSON 内嵌)。 */
export interface BakedTable {
  columns: string[];
  rows: Cell[][];
  /** 命中行数上限、数据被截断。 */
  capped?: boolean;
}

/** 内嵌到 HTML 的指标定义(已并入看板级别名/精度/单位覆盖),运行时按 field 名对每张表定位列。 */
export interface BakedMetricDef {
  key: string;
  field: string;
  name: string;
  aggregation: DashboardMetricAggregation;
  unit: string;
  decimals: number;
  direction: "neutral" | "higher" | "lower";
  dateScoped?: boolean;
}

export interface BakedWidget {
  /** 组件配置原样内嵌(运行时直接读 options.* / bindings.*,与在线渲染保持一致)。 */
  widget: DashboardWidget;
  metrics: { primary: BakedMetricDef[]; secondary: BakedMetricDef[] };
  /** 维度字段 → 中文显示名,导出页的表格列头用它替代英文字段名。 */
  dimensionLabels?: Record<string, string>;
  /* 哪些筛选字段该用日期区间控件。判定在这儿做,用的是跟看板同一个 isTimeField
     (它看得到数据库给的列类型,比在浏览器端猜名字准)—— 两边同一条规则,
     不会出现「软件里是日历、导出的页面里是一串日期的下拉」这种事。 */
  dateFilterFields?: string[];
  /* 哪些字段是时间。判定用跟看板同一个 isTimeField(它看得到数据库给的列类型),
     在这儿定好写进文件 —— 渲染端原来是拿字段名做正则猜的(写死了「日期/周/月/年」
     这些词),换个公司换套命名就全不认识了。 */
  timeFields?: string[];
  /** 下钻维度链(bar/pie);为空表示不下钻。 */
  drillDimensions: string[];
  data: {
    base?: BakedTable; // 非下钻:按分析维度 + 图例维度分组一次
    levels?: BakedTable[]; // 下钻:第 L 层 = GROUP BY drillDimensions[0..L],含所有路径
    comparison?: { period?: BakedTable; year?: BakedTable }; // KPI 同环比:平移周期
  };
  /** 该组件无法烘焙时的友好说明(非语义指标 / 取数报错)。 */
  note?: string;
}

export interface BakedDashboard {
  title: string;
  description: string;
  generatedAt: string;
  scope: { start: string; end: string };
  widgets: BakedWidget[];
}

/** 复刻 resolveMetricIds:把指标定义并入看板级覆盖,产出内嵌用的轻量定义(不含 columnIndex)。 */
/**
 * 组件的主指标。
 *
 * 绑指标中心的走 ids;绑数据集度量的没有 id,得按字段现造一份 —— 跟在线的
 * resolveWidgetMetrics 是同一套(key 是 "field:<字段名>",汇总方式取用户选的那个)。
 * 原来这里只认 ids,于是数据集模型的图导出来 metrics 是空的,离线页面上一片空白。
 */
function primaryDefs(widget: DashboardWidget, defs: DashboardMetricDefinition[], labels?: Record<string, string>): BakedMetricDef[] {
  const byId = resolveDefs(widget, widget.bindings.metricIds, defs);
  if (byId.length) return byId;
  const aggregations = widget.bindings.aggregations ?? {};
  return (widget.bindings.measures ?? []).map((field) => {
    const p = widget.options.metrics[field];
    return {
      key: `field:${field}`,
      field,
      name: p?.alias?.trim() || labels?.[field] || field,
      aggregation: (aggregations[field] ?? "sum") as DashboardMetricAggregation,
      unit: p?.unit ?? "",
      decimals: p?.decimals ?? widget.options.decimals,
      direction: p?.direction ?? "neutral",
    };
  });
}

function resolveDefs(widget: DashboardWidget, ids: string[], defs: DashboardMetricDefinition[]): BakedMetricDef[] {
  return ids
    .map((id) => defs.find((m) => m.id === id && m.datasetId === widget.datasetId))
    .filter((m): m is DashboardMetricDefinition => !!m)
    .map((m) => {
      const p = widget.options.metrics[m.id];
      return {
        key: m.id,
        field: m.field,
        name: p?.alias?.trim() || m.name,
        aggregation: m.aggregation,
        unit: p?.unit ?? m.unit,
        decimals: p?.decimals ?? m.decimals,
        direction: p?.direction ?? m.direction,
        dateScoped: m.dateScoped,
      };
    });
}

/**
 * 把整张看板(已 resolveSemanticDocument)按每个组件的锁定范围烘成自包含数据。
 * 对可下钻组件用「前缀分组」逐层取数(每层都是该层真实聚合、含所有路径),
 * 浏览器端下钻只按路径过滤已烘表 —— 任何聚合口径(含平均/比率)都精确。
 */
export async function bakeDashboard(
  document: DashboardDocument,
  centralMetrics: Metric[],
  translateError: Parameters<typeof executeDataset>[1],
): Promise<{ baked: BakedDashboard; warnings: string[] }> {
  const warnings: string[] = [];

  /* 取数一律走 executeDataset。这里本来自己写了一套「数据集怎么变成 SQL」:语义的过
     编译器,别的直接用 ds.sql —— 于是 groupBy 和 metricScope 在这条路上没有效果,
     导出的页面里下钻是平的、同环比跟本期一模一样。同一件事不该有两套写法,那一套
     迟早跟另一套走散,而且走散了也不报错,只是数不对。 */
  const run = async (ds: DashboardDataset): Promise<BakedTable> => {
    const res = await executeDataset(ds, translateError, EXPORT_ROW_CAP, [], undefined, centralMetrics);
    return { columns: res.columns.map((c) => c.name), rows: res.rows, capped: res.rows.length >= EXPORT_ROW_CAP };
  };
  const warnRows = (title: string, table: BakedTable, suffix = "") => {
    if (table.capped) warnings.push(`「${title}」${suffix}数据达到 ${EXPORT_ROW_CAP} 行上限,已截断 —— 请收紧该组件的锁定范围`);
    else if (table.rows.length >= SOFT_ROW_WARN) warnings.push(`「${title}」${suffix}约 ${table.rows.length} 行,文件会偏大 —— 可考虑收紧锁定范围`);
  };

  const widgets: BakedWidget[] = [];
  for (const widget of document.widgets) {
    if (isStaticWidget(widget.type)) {
      widgets.push({ widget, metrics: { primary: [], secondary: [] }, drillDimensions: [], data: {} });
      continue;
    }
    /* 数据集组件编译后按组件 id 存放(同一数据集不同维度是不同查询);指标看板仍按
       组件的 datasetId 找自己的语义数据集。 */
    const ds = datasetOf(widget, document.datasets);
    const primary = primaryDefs(widget, document.metrics, ds?.dimensionLabels);
    const secondaryRaw = resolveDefs(widget, widget.bindings.secondaryMetricIds, document.metrics);
    const secondary = secondaryRaw.filter((s) => !primary.some((p) => p.key === s.key));
    if (!ds) {
      widgets.push({ widget, metrics: { primary, secondary }, drillDimensions: [], data: {}, note: "此组件还没选数据集,无数据可导出" });
      continue;
    }
    if (ds.metricIds && primary.length === 0) {
      widgets.push({ widget, metrics: { primary, secondary }, dimensionLabels: ds.dimensionLabels, drillDimensions: [], data: {}, note: "此组件未绑定指标中心指标,暂不支持离线导出" });
      continue;
    }

    /* 下钻靠改写 groupBy 逐层重跑。两种模型现在都支持(数据集模型带着重编的原料),
       所以导出的页面里下钻也照样能用。 */
    const drillDimensions = widget.type === "bar" || widget.type === "pie" || widget.type === "funnel"
      ? (widget.options.chart?.drillDimensions ?? [])
      : [];
    const data: BakedWidget["data"] = {};
    let note: string | undefined;
    try {
      /* base 一定要烘。原来这儿是 if(有下钻) 烘层表 else 烘 base —— 配了下钻的组件
         就一张 base 都没有,而没下钻时(path 为空)渲染端找的正是 base,于是一张配了
         下钻的饼图导出来永远是「暂无数据」。层表是下钻之后才用的,替代不了它。 */
      const table = await run(ds);
      warnRows(widget.title, table);
      data.base = table;

      if (drillDimensions.length > 0) {
        /* 层表要连着组件自己的维度一起分组。groupBy 是「替换」掉维度而不是追加,
           只传下钻维度的话,第 0 层就只按主管分组、没有大区那一列 —— 浏览器端想把
           行过滤到「北京大区」都无从下手,钻进去看到的是全国的主管。 */
        const baseDims = widget.bindings.dimensions?.length
          ? widget.bindings.dimensions
          : (widget.bindings.dimension ? [widget.bindings.dimension] : []);
        const levels: BakedTable[] = [];
        for (let level = 0; level < drillDimensions.length; level += 1) {
          const groupBy = [...baseDims, ...drillDimensions.slice(0, level + 1)]
            .filter((d, i, all) => all.indexOf(d) === i);
          const levelTable = await run({ ...ds, groupBy });
          warnRows(widget.title, levelTable, `第 ${level + 1} 层`);
          levels.push(levelTable);
        }
        data.levels = levels;
      }
      if (widget.type === "kpi" && widget.options.kpi?.showComparison) {
        const base = ds.metricScope ?? defaultMetricScope();
        const [period, year] = await Promise.all([
          run({ ...ds, metricScope: shiftScope(base, "period") }).catch(() => undefined),
          run({ ...ds, metricScope: shiftScope(base, "year") }).catch(() => undefined),
        ]);
        data.comparison = { period, year };
      }
    } catch (error) {
      note = `取数失败:${String(error)}`;
    }
    widgets.push({
      widget, metrics: { primary, secondary }, dimensionLabels: ds.dimensionLabels,
      dateFilterFields: dateFilterFieldsOf(widget, ds),
      timeFields: (ds.fields ?? []).filter((f) => isTimeField({ name: f.name, type: f.typeName })).map((f) => f.name),
      drillDimensions, data, note,
    });
  }

  const scope = document.metricScope ?? defaultMetricScope();
  return {
    baked: {
      title: document.title || "未命名看板",
      description: document.description || "",
      generatedAt: new Date().toISOString(),
      scope: { start: scope.start, end: scope.end },
      widgets,
    },
    warnings,
  };
}
