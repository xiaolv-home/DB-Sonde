import { repairGeneratedDashboard } from "./generatedAppearance";
import { nanoid } from "nanoid";
import { WIDGET_SPECS, supportsSeries } from "./widgetSpecs";
import type { QueryResult } from "../../types";
import { maxOf } from "../../lib/numbers";
import { chartPalette } from "../../lib/themeColors";


export const DASHBOARD_SCHEMA_VERSION = 3 as const;
/** 看板没单独设配色时的系列色,跟着当前主题。用户设过的 palette 不走这里。 */
export const defaultDashboardPalette = (): string[] => chartPalette();

/* 组件类型的**唯一定义处**。AI 的 schema、画布的下拉、导入时的白名单都从这里取 ——
   以前这串字面量在 4 个文件里各写一遍,加一种类型漏掉任何一处的表现是
   「AI 生成了但渲染不出来」或者反过来,而且不会报错。 */
export const WIDGET_TYPES = [
  "kpi", "gauge", "line", "bar", "waterfall", "ranking", "pie", "funnel", "treemap",
  "scatter", "radar", "heatmap", "table", "text", "image", "container",
] as const;
/** 能放进容器分页的类型 —— 容器不能套娃。 */
export const LEAF_WIDGET_TYPES = WIDGET_TYPES.filter((t) => t !== "container");
export type DashboardWidgetType = (typeof WIDGET_TYPES)[number];
/** 只算一个总数、不分组的组件(指标卡、仪表盘)。带着维度去查会查回多行再被卡片二次聚合,
 *  平均值就成了「平均数的平均数」—— 所以取数时一律不分组。 */
export const isSummaryWidget = (type: DashboardWidgetType) => type === "kpi" || type === "gauge";
/** 不取数的组件:文本、图片、分页容器。 */
export const isStaticWidget = (type: DashboardWidgetType) => type === "text" || type === "image" || type === "container";
export type DashboardSourceType = "sql" | "table" | "service";
export type DashboardFilterKind = "select" | "text" | "in";
export type DashboardDimensionSort = "asc" | "desc" | "group_asc" | "group_desc" | "custom";
export type DashboardMetricAggregation = "sum" | "avg" | "min" | "max" | "count" | "count_distinct";
/** 组件筛选器认的字段。以前写死成大区/主管/网点那几个,那是指标中心时代的口径;
 *  现在组件挑的是数据集里的维度字段,名字由数据集说了算,所以这里只能是字符串。
 *  "date" 仍是保留名 —— 它渲染成日期区间而不是多选。 */
export type DashboardComponentFilterField = string;

export interface DashboardField {
  name: string;
  typeName: string;
  role: "dimension" | "measure";
}

export interface DashboardDataset {
  id: string;
  name: string;
  sourceType: DashboardSourceType;
  connectionId: string;
  database?: string;
  sql: string;
  fields: DashboardField[];
  connectorId?: string;
  metricIds?: string[];
  groupBy?: string[];
  /** 维度字段 → 中文显示名(来自指标中心)。表格/检查器用它显示,底层查询仍用字段名。 */
  dimensionLabels?: Record<string, string>;
  metricScope?: import("../metrics/queryPlan").QueryScope;
  /**
   * 数据集模型下的重编译原料(运行时产物,不落库)。
   *
   * sql 是编好的字符串,改不动。可下钻要换分组列、同环比要换日期窗口、组件筛选器要塞
   * 自己的日期 —— 这些都得重编一遍 SQL。语义数据集本来就每次现编,所以一直是好的;
   * 数据集模型编完就冻住,于是那几个功能界面上都在、点了没反应。留着原料,
   * executeDataset 就能照着重编。
   */
  compiledFrom?: {
    dataset: import("../datasets/domain").Dataset;
    query: import("../datasets/widgetQuery").WidgetQuery;
    kind?: import("../../types").DbKind;
  };
}

export interface DashboardFilter {
  id: string;
  title: string;
  /** scope=global:按 field 联动所有"含该维度字段"的数据集;
   *  scope=dataset(默认,兼容旧):只作用于 datasetId 指定的数据集。 */
  scope?: "global" | "dataset";
  datasetId: string;
  field: string;
  kind: DashboardFilterKind;
  defaultValue?: string;
}

export interface DashboardDrillFilter {
  datasetId: string;
  field: string;
  value: string;
}

export interface DashboardMetricDefinition {
  id: string;
  name: string;
  description: string;
  datasetId: string;
  field: string;
  aggregation: DashboardMetricAggregation;
  unit: string;
  decimals: number;
  direction: "neutral" | "higher" | "lower";
  /** 该指标是否随日期范围变化(仅 queryPlan 指标套 scope 起止日期)。
   *  false 时同比/环比无意义(平移周期取到同值),KPI 显示 "--" 而非误导的 0%。 */
  dateScoped?: boolean;
}

export interface DashboardMetricPresentation {
  alias: string;
  decimals: number;
  unit: string;
  direction: "neutral" | "higher" | "lower";
}

export type TableDensity = "compact" | "normal" | "relaxed";

/** 明细表(table widget)的全部展示配置 —— 对齐 v1 的表格能力:多维度排序、
 *  行/列合计、按维度小计、合并单元格、透视、冻结列、密度、表头样式、分页、
 *  数字格式(默认去千位符)。全部可选,渲染时给默认值,兼容旧看板。 */
export interface DashboardTableOptions {
  layout?: "flat" | "pivot";
  stripe?: boolean;
  mergeDimensions?: boolean;
  rowTotal?: boolean;
  columnTotal?: boolean;
  subtotalDimension?: string;
  density?: TableDensity;
  pageSize?: number;
  timeOrder?: "asc" | "desc";
  /** 千位分隔符;默认关(对齐 v1 useGrouping:false)。 */
  grouping?: boolean;
  freezeDimensions?: boolean;
  headerBg?: string;
  headerText?: string;
  headerAlign?: "left" | "center" | "right";
  headerFontSize?: number;
  headerFontWeight?: number;
  headerHeight?: number;
  rowHeight?: number;
  dimensionWidth?: number;
  metricWidth?: number;
  columnWidths?: Record<string, number>;
  /** 维度排序。
   *  asc/desc      按这一列自己排,会打散上层分组(想看「全部网点里最高的」用它)
   *  group_asc/desc 先守住上层顺序,再在每个上层分组内部排(想看「每个大区里最高的」用它)
   *  custom        按 dimensionCustomOrders 指定的顺序 */
  dimensionSorts?: Record<string, DashboardDimensionSort>;
  /** 按某个指标排。within=只在最近一层分组内部排。 */
  metricSort?: { key: string; dir: "asc" | "desc"; within?: boolean };
  dimensionCustomOrders?: Record<string, string[]>;
  /** 透视布局:把某些维度放到列方向。 */
  dimensionPlacements?: Record<string, "row" | "column">;
}

/** 数字显示格式 —— 原来只有小数位和千位符,大额金额只能摊成
 *  「12,345,678 元」。加上万/亿换算和前后缀,管理层看板才读得下去。 */
export interface DashboardNumberFormat {
  /** none 原样 / wan 除以一万 / yi 除以一亿 / auto 每个数按自己的量级选。
   *  auto 是给一张卡上量级差很远的一组数用的:销售额 5682 万和笔均金额 26 元放在一起,
   *  定死任何一档都有一半读不出来 —— 26 除以一万就是「0万元」。 */
  scale?: "none" | "wan" | "yi" | "auto";
  prefix?: string;
  suffix?: string;
}

/** 折线 / 条形 / 饼图的精细样式 —— 对齐 v1 ChartRenderer 的能力。全部可选。 */
export interface DashboardChartOptions {
  palette?: string[];
  dimensionColors?: Record<string, string>; // 按序列名/维度值配色
  showLabels?: boolean; // 数据标签
  grouping?: boolean; // 数字千位符,默认关(对齐 v1)
  dataZoom?: boolean; // 数据缩放滑块
  // 折线
  lineWidth?: number;
  linePoints?: boolean; // 显示数据点
  lineArea?: boolean; // 面积填充
  lineTimeOrder?: "asc" | "desc"; // 按维度(时间)排序 x 轴
  // 条形
  barOrientation?: "vertical" | "horizontal";
  barColor?: string;
  barEndColor?: string; // 渐变终点
  barShowValues?: boolean;
  // 饼
  pieIncludeOthers?: boolean; // TopN 后合并剩余分类，保留完整占比分母
  pieHole?: number; // 内半径 %，0=实心饼，必须小于外半径
  pieOuterRadius?: number; // 20-95 外半径 %，与内半径之差决定环宽
  pieShowLabels?: boolean;
  pieLegendPosition?: "bottom" | "left" | "right";
  // 多级下钻(对齐 v1 pie_drill):有序维度链,点一层按下一维度重新分组,面包屑可回退。作用于折线/柱/饼/漏斗。
  drillDimensions?: string[];
  /** 点图形时联动整个看板(按这一格的值筛所有用同一数据集的组件)。默认关 ——
   *  点一下整张看板全变、还找不到怎么变回来,不该是默认行为。 */
  linkage?: boolean;
  // 双轴组合图:副指标用另一种图形(如主柱 + 副线)。默认与主图一致。
  secondarySeriesType?: "line" | "bar";
  // 堆叠:多序列(多指标/图例维度)堆叠显示。主/副指标各自成堆。
  stack?: boolean;
  // 指标显示方式(对齐 v1 metric_display_mode):all=全部系列 / switch=切换单指标 / group_switch=分组切换。
  displayMode?: "all" | "switch" | "group_switch";
  metricGroups?: DashboardMetricGroup[];
  metricSwitchDefault?: string;
  metricSwitchTitle?: boolean;
  /** V1 exposes the comparison switch for every data widget; currently only
   * KPI has a comparison visual, while other chart types retain the setting. */
  showComparison?: boolean;
  /** 坐标轴:留空即自适应。yMin/yMax 用来把多张图对齐到同一量纲,
   *  或者把基线从 0 抬起来看清波动。 */
  axis?: {
    yMin?: number;
    yMax?: number;
    yTitle?: string;
    xTitle?: string;
    /** 横向网格线,默认开。 */
    splitLine?: boolean;
  };
  /** 悬停提示:axis 一次看同一 x 的所有系列(趋势图默认),item 只看当前那根。 */
  tooltip?: { mode?: "item" | "axis" };
  /** 参考线 —— 管理层看板常要一条目标线 / 去年均值线。 */
  markLine?: { value: number; label?: string; color?: string }[];
}

/** 指标组 —— 把多个指标归为一组,配合 displayMode="group_switch" 由查看者切换组。 */
export interface DashboardMetricGroup {
  id: string;
  label: string;
  metricIds: string[]; // 引用 bindings.metricIds(= 指标中心 id)
}

/** KPI 指标卡的展示配置 —— 对齐 v1 的 kpi_* 选项(配色/字号/对齐/副指标/切换)。 */
export interface DashboardKpiOptions {
  displayMode?: "all" | "switch" | "group_switch"; // 全部并排 / 下拉切换单个 / 分组切换
  metricGroups?: DashboardMetricGroup[]; // group_switch 用
  metricSwitchDefault?: string; // 默认选中的指标/组 id
  metricSwitchTitle?: boolean; // 切换器前是否显示"指标"标签(默认显示)
  valueColor?: string;
  valueSize?: number;
  labelSize?: number;
  labelPosition?: "above" | "below";
  contentAlign?: "left" | "center" | "right";
  showAggregation?: boolean; // 兼容旧看板；KPI 正文不再展示技术聚合信息
  showSecondary?: boolean; // 显示副指标
  secondarySize?: number;
  // 同比/环比对比(对齐 v1 show_comparison):相对上一周期(环比)/去年同期(同比)的涨跌%。
  showComparison?: boolean;
  comparisonLayout?: "inline" | "column";
  comparisonFontSize?: number;
}

/** 文本框排版 —— 对齐 v1 的 text_* 选项。 */
export interface DashboardTextOptions {
  fontFamily?: "sans" | "serif" | "mono";
  fontSize?: number;
  fontWeight?: number;
  lineHeight?: number; // 百分比
  align?: "left" | "center" | "right";
  verticalAlign?: "top" | "center" | "bottom";
  color?: string;
}

/** 仪表盘:一个数值对着满刻度 / 目标看完成度。 */
export interface DashboardGaugeOptions {
  /** arc=半圆仪表,ring=圆环进度。 */
  shape?: "arc" | "ring";
  /** 满刻度;不填时有目标用目标,没有就按数值往上取个整。 */
  max?: number;
  /** 目标值:在刻度上画一根线,并显示完成率。 */
  target?: number;
  color?: string;
  /** 按完成率变色:<60% 红,<100% 黄,达标绿。 */
  colorByProgress?: boolean;
}

/** 漏斗:按数值从大到小,或保持分类原顺序(转化步骤)。 */
export interface DashboardFunnelOptions {
  order?: "value" | "category";
  /** 每层标签附带「占第一层 %」。 */
  showRate?: boolean;
  align?: "center" | "left";
}

/** 散点:平均线分四象限、点旁标名字。 */
export interface DashboardScatterOptions { quadrant?: boolean; showNames?: boolean }
/** 雷达:多边形 / 圆形,是否填色。 */
export interface DashboardRadarOptions { shape?: "polygon" | "circle"; fill?: boolean }
/** 热力:格子里写数值、主色。 */
export interface DashboardHeatmapOptions { showValues?: boolean; color?: string }
/** 瀑布:末尾的合计柱、增减颜色。 */
export interface DashboardWaterfallOptions {
  total?: boolean;
  totalLabel?: string;
  showValues?: boolean;
  upColor?: string;
  downColor?: string;
  totalColor?: string;
}
/** 排行榜:正序(倒数几名)/ 倒序。 */
export interface DashboardRankingOptions { order?: "desc" | "asc"; barColor?: string }

/** 图片:src 是 data URL(导入时就压过,别存原图)。 */
export interface DashboardImageOptions {
  src?: string;
  fit?: "contain" | "cover";
  /** 图片名,只用来在设置里显示。 */
  name?: string;
}

/** Tab 容器 —— tab 栏位置与显隐。 */
export interface DashboardContainerOptions {
  tabPosition?: "top" | "left";
  showTabBar?: boolean;
}

/** 组件卡片通用外观 —— 对齐 v1「样式 · 通用外观」。全部可选。 */
export interface DashboardAppearanceOptions {
  background?: string;
  textColor?: string;
  titleColor?: string;
  borderColor?: string;
  borderWidth?: number;
  radius?: number;
  padding?: number;
  titleSize?: number;
  titleAlign?: "left" | "center" | "right";
  shadow?: boolean;
  hideTitle?: boolean;
  /** 视觉预设(卡片背景/配色)—— 见 presets.css 的 16 个;选中时覆盖背景/边框/文字色。 */
  visualPreset?: string;
}

export interface DashboardWidget {
  id: string;
  type: DashboardWidgetType;
  title: string;
  /** 标题下的一行小字:说清这张图的口径/范围。 */
  subtitle?: string;
  /** 卡片底部的一行小字:数据截至、口径说明、免责。 */
  footnote?: string;
  datasetId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
  /** V1 component-level filters. These are viewer controls rendered inside this
   * widget and only affect this widget's query. */
  filtersEnabled?: boolean;
  filterFields?: DashboardComponentFilterField[];
  parentId?: string;
  tabId?: string;
  tabs: Array<{ id: string; label: string }>;
  bindings: {
    dimension?: string; // 兼容旧看板(单维度);新看板用 dimensions
    dimensions?: string[]; // 分析维度(可多选,对齐 v1)
    seriesDimension?: string; // 图例维度(折线/条形)
    measures: string[];
    /** 度量字段 → 聚合方式(缺省求和)。数据集模型下,组件自己决定怎么汇总。 */
    aggregations?: Record<string, import("../datasets/widgetQuery").AggKind>;
    /** 时间维度 → 粒度(年/季/月/周/日/时/分)。不填按原样。 */
    grains?: Record<string, import("../datasets/widgetQuery").TimeGrain>;
    /** 组件上的条件(设计者定死,查看者改不了):维度按行筛,度量带汇总方式按结果筛。 */
    conditions?: import("../datasets/widgetQuery").WidgetCondition[];
    metricIds: string[];
    secondaryMetricIds: string[];
  };
  options: {
    decimals: number;
    numberFormat?: DashboardNumberFormat;
    percentDecimals?: number; // 百分比小数位(同环比徽标 / 饼图占比),默认 1
    /** 锁定本组件的数据范围(对齐 v1 scope_filters):可锁日期区间 + 各维度固定取值,
     *  设置后不随全局「数据日期」/筛选变化。filters: 维度名 → 锁定的取值列表。 */
    lockedScope?: { start?: string; end?: string; filters?: Record<string, string[]> };
    showLegend: boolean;
    smooth: boolean;
    topN: number;
    content?: string;
    metrics: Record<string, DashboardMetricPresentation>;
    table?: DashboardTableOptions;
    chart?: DashboardChartOptions;
    kpi?: DashboardKpiOptions;
    text?: DashboardTextOptions;
    gauge?: DashboardGaugeOptions;
    funnel?: DashboardFunnelOptions;
    image?: DashboardImageOptions;
    scatter?: DashboardScatterOptions;
    radar?: DashboardRadarOptions;
    heatmap?: DashboardHeatmapOptions;
    waterfall?: DashboardWaterfallOptions;
    ranking?: DashboardRankingOptions;
    container?: DashboardContainerOptions;
    appearance?: DashboardAppearanceOptions;
  };
}

/** AI 建这个看板时的来龙去脉 —— 回答「AI 为什么建了这个图」。
 *  人工建的看板没有这个字段;导出离线 HTML 时会剥掉(那是给别人看的成品)。 */
export interface DashboardProvenance {
  appearanceVersion?: number;
  workflowId: string;
  /** 用户当初说的那句话。 */
  userRequest: string;
  createdAt: string;
  /** 模型实际用的是哪个 provider —— 排查"这版为什么建得差"时要知道。 */
  model?: string;
  /** widgetId → 为什么放它、为什么用这种图。 */
  widgetReasons: Record<string, string>;
  /** 验收时自动修掉了什么。 */
  autoFixed?: string[];
  /** 没能自动修、留给人的问题。 */
  openIssues?: string[];
}

export interface DashboardDocument {
  metricScope?: import("../metrics/queryPlan").QueryScope;
  /** 自动刷新间隔(秒);0/undefined = 关闭。适合常开看板定时拉取最新数据。 */
  refreshInterval?: number;
  schemaVersion: typeof DASHBOARD_SCHEMA_VERSION;
  id: string;
  title: string;
  description: string;
  status: "draft" | "published";
  revision: number;
  datasets: DashboardDataset[];
  metrics: DashboardMetricDefinition[];
  filters: DashboardFilter[];
  widgets: DashboardWidget[];
  updatedAt: string;
  aiProvenance?: DashboardProvenance;
}

export interface DashboardRuntimeData {
  result?: QueryResult;
  loading: boolean;
  error?: string;
  /** 同比/环比对比查询结果(相同数据集、平移日期范围后取数),用于 KPI 涨跌徽标。 */
  comparison?: { period?: QueryResult; year?: QueryResult };
}

export const widgetDefaults: Record<DashboardWidgetType, { w: number; h: number }> = {
  kpi: { w: 4, h: 3 }, // 3 行:容得下 值 + 标签 + 同环比徽标(对齐 v1 较高的 KPI 卡)
  gauge: { w: 4, h: 4 },
  line: { w: 6, h: 4 },
  bar: { w: 6, h: 4 },
  pie: { w: 4, h: 4 },
  funnel: { w: 4, h: 4 },
  treemap: { w: 6, h: 5 },
  waterfall: { w: 6, h: 4 },
  ranking: { w: 4, h: 5 },
  scatter: { w: 6, h: 5 },
  radar: { w: 5, h: 5 },
  heatmap: { w: 8, h: 5 },
  table: { w: 12, h: 4 },
  text: { w: 6, h: 2 },
  image: { w: 4, h: 3 },
  container: { w: 12, h: 7 },
};

export function createDashboard(title = "Dashboard"): DashboardDocument {
  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    id: `dashboard-${nanoid(10)}`,
    title,
    description: "",
    status: "draft",
    revision: 1,
    datasets: [],
    metrics: [],
    filters: [],
    widgets: [],
    updatedAt: new Date().toISOString(),
  };
}

export function createWidget(type: DashboardWidgetType, datasetId = "", title?: string): DashboardWidget {
  const size = widgetDefaults[type];
  const names: Record<DashboardWidgetType, string> = {
    kpi: "KPI",
    gauge: "Gauge",
    line: "Line chart",
    bar: "Bar chart",
    pie: "Pie chart",
    funnel: "Funnel",
    treemap: "Treemap",
    waterfall: "Waterfall",
    ranking: "Ranking",
    scatter: "Scatter",
    radar: "Radar",
    heatmap: "Heatmap",
    table: "Table",
    text: "Text",
    image: "Image",
    container: "Tab container",
  };
  return {
    id: `widget-${nanoid(10)}`,
    type,
    title: title ?? names[type],
    datasetId,
    x: 0,
    y: 0,
    w: size.w,
    h: size.h,
    visible: true,
    filtersEnabled: false,
    filterFields: [],
    parentId: undefined,
    tabId: undefined,
    tabs: type === "container" ? [{ id: `tab-${nanoid(8)}`, label: "Tab 1" }] : [],
    bindings: { measures: [], metricIds: [], secondaryMetricIds: [] },
    options: {
      decimals: 2,
      showLegend: true,
      smooth: true,
      // 排行榜默认前 10、雷达默认前 5:「全部」几百家店画进去就没法看了,但查看者仍可在数据页改
      topN: type === "ranking" ? 10 : type === "radar" ? 5 : 0,
      content: undefined,
      metrics: {},
    },
  };
}

function overlaps(a: DashboardWidget, b: DashboardWidget) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function sameLayoutScope(a: DashboardWidget, b: DashboardWidget) {
  return (a.parentId ?? "") === (b.parentId ?? "") && (a.tabId ?? "") === (b.tabId ?? "");
}

function constrainWidget(widget: DashboardWidget): DashboardWidget {
  const w = Math.max(2, Math.min(12, Math.round(widget.w)));
  const h = Math.max(2, Math.min(10, Math.round(widget.h)));
  return {
    ...widget,
    x: Math.max(0, Math.min(12 - w, Math.round(widget.x))),
    y: Math.max(0, Math.round(widget.y)),
    w,
    h,
  };
}

/** Find the first valid 12-column slot without relying on a UI grid library. */
export function placeWidget(widget: DashboardWidget, existing: DashboardWidget[]): DashboardWidget {
  const constrained = constrainWidget(widget);
  for (let y = 0; y < 200; y += 1) {
    for (let x = 0; x <= 12 - constrained.w; x += 1) {
      const candidate = { ...constrained, x, y };
      if (!existing.some((item) => overlaps(candidate, item))) return candidate;
    }
  }
  return { ...constrained, x: 0, y: Math.max(0, ...existing.map((item) => item.y + item.h)) };
}

/** Place a duplicate in the nearest free slot around its source.
 *  Equal-distance slots follow the natural editing order: right, below, left, above. */
export function placeWidgetNear(widget: DashboardWidget, existing: DashboardWidget[], source: DashboardWidget): DashboardWidget {
  const constrained = constrainWidget(widget);
  const anchor = constrainWidget(source);
  const occupied = existing.filter((item) => sameLayoutScope(item, constrained));
  const maxY = Math.max(anchor.y + anchor.h, ...occupied.map((item) => item.y + item.h)) + constrained.h + 12;
  const score = (candidate: DashboardWidget): number[] => {
    const right = candidate.x >= anchor.x + anchor.w;
    const below = candidate.y >= anchor.y + anchor.h;
    const left = candidate.x + candidate.w <= anchor.x;
    const above = candidate.y + candidate.h <= anchor.y;
    const edgeX = right ? candidate.x - (anchor.x + anchor.w) : left ? anchor.x - (candidate.x + candidate.w) : 0;
    const edgeY = below ? candidate.y - (anchor.y + anchor.h) : above ? anchor.y - (candidate.y + candidate.h) : 0;
    const direction = right && candidate.y === anchor.y ? 0
      : below && candidate.x === anchor.x ? 1
        : left && candidate.y === anchor.y ? 2
          : above && candidate.x === anchor.x ? 3
            : 4;
    return [edgeX * edgeX + edgeY * edgeY, direction, Math.abs(candidate.x - anchor.x) + Math.abs(candidate.y - anchor.y), candidate.y, candidate.x];
  };
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  };
  let best: DashboardWidget | undefined;
  let bestScore: number[] | undefined;
  for (let y = 0; y <= maxY; y += 1) {
    for (let x = 0; x <= 12 - constrained.w; x += 1) {
      const candidate = { ...constrained, x, y };
      if (occupied.some((item) => overlaps(candidate, item))) continue;
      const candidateScore = score(candidate);
      if (!bestScore || compare(candidateScore, bestScore) < 0) {
        best = candidate;
        bestScore = candidateScore;
      }
    }
  }
  return best ?? placeWidget(constrained, occupied);
}

/** Keep the edited widget in place and push any collided widgets downward. */
export function resolveWidgetLayout(edited: DashboardWidget, widgets: DashboardWidget[]): DashboardWidget[] {
  const result: DashboardWidget[] = [constrainWidget(edited)];
  for (const widget of widgets) {
    if (widget.id === edited.id) continue;
    if (!sameLayoutScope(widget, edited)) continue;
    let candidate = constrainWidget(widget);
    while (true) {
      const collisions = result.filter((item) => overlaps(candidate, item));
      if (collisions.length === 0) break;
      candidate = {
        ...candidate,
        y: maxOf(collisions.map((item) => item.y + item.h))!,
      };
    }
    result.push(candidate);
  }
  const byId = new Map(result.map((widget) => [widget.id, widget]));
  return widgets.map((widget) => byId.get(widget.id) ?? widget);
}

export function inferFields(result: QueryResult): DashboardField[] {
  return result.columns.map((column, index) => {
    const type = column.typeName.toLocaleLowerCase();
    const numericType = /(int|decimal|numeric|real|double|float|number|money)/.test(type);
    const numericValues = result.rows
      .slice(0, 30)
      .map((row) => row[index])
      .filter((value) => value != null)
      .every((value) => typeof value === "number");
    return {
      name: column.name,
      typeName: column.typeName,
      role: numericType || numericValues ? "measure" : "dimension",
    };
  });
}

export function normalizeDashboard(value: unknown): DashboardDocument {
  if (!value || typeof value !== "object") return createDashboard();
  const item = value as Partial<DashboardDocument>;
  const schemaVersion = Number(item.schemaVersion);
  if (![1, 2, DASHBOARD_SCHEMA_VERSION].includes(schemaVersion) || typeof item.id !== "string") {
    return createDashboard();
  }
  return repairGeneratedDashboard({
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    id: item.id,
    title: typeof item.title === "string" ? item.title : "Dashboard",
    description: typeof item.description === "string" ? item.description : "",
    status: item.status === "published" ? "published" : "draft",
    revision: typeof item.revision === "number" ? item.revision : 1,
    metricScope: item.metricScope,
    // 自动刷新间隔:此前漏在归一化里,导致存进文件后每次加载都被抹掉(设置形同虚设)。
    refreshInterval: typeof item.refreshInterval === "number" && item.refreshInterval > 0
      ? item.refreshInterval
      : undefined,
    datasets: Array.isArray(item.datasets) ? item.datasets : [],
    metrics: Array.isArray(item.metrics)
      ? item.metrics.flatMap((metric) => {
          const raw = metric as Partial<DashboardMetricDefinition>;
          if (typeof raw.id !== "string" || typeof raw.datasetId !== "string" || typeof raw.field !== "string") return [];
          const aggregation: DashboardMetricAggregation = ["sum", "avg", "min", "max", "count", "count_distinct"].includes(String(raw.aggregation))
            ? raw.aggregation as DashboardMetricAggregation
            : "sum";
          return [{
            id: raw.id,
            name: typeof raw.name === "string" && raw.name.trim() ? raw.name : raw.field,
            description: typeof raw.description === "string" ? raw.description : "",
            datasetId: raw.datasetId,
            field: raw.field,
            aggregation,
            unit: typeof raw.unit === "string" ? raw.unit : "",
            decimals: typeof raw.decimals === "number" ? Math.max(0, Math.min(6, raw.decimals)) : 2,
            direction: raw.direction === "higher" || raw.direction === "lower" ? raw.direction : "neutral",
          }];
        })
      : [],
    filters: Array.isArray(item.filters) ? item.filters : [],
    widgets: Array.isArray(item.widgets)
      ? item.widgets.map((widget) => {
          const raw = widget as Partial<DashboardWidget>;
          const type: DashboardWidgetType = (WIDGET_TYPES as readonly string[]).includes(String(raw.type))
            ? raw.type as DashboardWidgetType
            : "text";
          const fallback = createWidget(type, typeof raw.datasetId === "string" ? raw.datasetId : "");
          // 每种组件留几个维度、留不留拆分系列,看说明书 —— 别在这儿另写一份
          const dimensionLimit = WIDGET_SPECS[type].dimensions[1];
          const dimensions = (Array.isArray(raw.bindings?.dimensions)
            ? raw.bindings.dimensions.filter((name): name is string => typeof name === "string" && !!name)
            : [raw.bindings?.dimension].filter((name): name is string => typeof name === "string" && !!name)
          ).slice(0, dimensionLimit);
          const metricLimit = type === "table" ? 12 : 6;
          return {
            ...fallback,
            ...raw,
            visible: raw.visible !== false,
            filtersEnabled: raw.filtersEnabled === true,
            filterFields: Array.isArray(raw.filterFields)
              ? raw.filterFields.filter((field): field is DashboardComponentFilterField => typeof field === "string" && !!field)
              : [],
            parentId: typeof raw.parentId === "string" && raw.parentId ? raw.parentId : undefined,
            tabId: typeof raw.tabId === "string" && raw.tabId ? raw.tabId : undefined,
            tabs: Array.isArray(raw.tabs) && raw.tabs.length ? raw.tabs : fallback.tabs,
            /* 先把读到的原样带过来,再覆盖需要校验/收口的那几个。
               原来这里是逐字段列举的白名单 —— 没列到的字段在「存 → 读」之间被静默抹掉:
               界面上点得动、当场也生效,一重开就回到默认值,还不报错。时间粒度(月/日)、
               每个指标的汇总方式都这么丢过。上面 widget 自己用的就是 ...raw,这里跟它一致。 */
            bindings: {
              ...(raw.bindings ?? {}),
              dimension: dimensions[0],
              dimensions,
              // 图例维度:折线拆成多条线,柱状拆成多组柱 —— 两种都能设,别只给折线留。
              seriesDimension: supportsSeries(type) && typeof raw.bindings?.seriesDimension === "string"
                ? raw.bindings.seriesDimension
                : undefined,
              measures: Array.isArray(raw.bindings?.measures) ? raw.bindings.measures.filter((name): name is string => typeof name === "string") : [],
              metricIds: Array.isArray(raw.bindings?.metricIds) ? raw.bindings.metricIds.filter((id): id is string => typeof id === "string").slice(0, metricLimit) : [],
              secondaryMetricIds: type !== "table" && Array.isArray(raw.bindings?.secondaryMetricIds) ? raw.bindings.secondaryMetricIds.filter((id): id is string => typeof id === "string").slice(0, 6) : [],
            },
            options: {
              ...fallback.options,
              ...(raw.options ?? {}),
              metrics: { ...fallback.options.metrics, ...(raw.options?.metrics ?? {}) },
            },
          };
        })
      : [],
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
    /* 顶层是逐字段列举的,漏了就会在存取之间被静默抹掉 —— refreshInterval 当年
       就是这么丢的。新增顶层字段必须同时加在这里。 */
    aiProvenance: item.aiProvenance && typeof item.aiProvenance === "object"
      ? item.aiProvenance
      : undefined,
  });
}
