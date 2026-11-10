import { S, type JsonSchema } from "./jsonSchema";
import type {
  DashboardAppearanceOptions, DashboardChartOptions, DashboardContainerOptions, DashboardFunnelOptions, DashboardGaugeOptions,
  DashboardHeatmapOptions, DashboardKpiOptions, DashboardNumberFormat, DashboardRadarOptions, DashboardRankingOptions,
  DashboardScatterOptions, DashboardTableOptions, DashboardTextOptions, DashboardWaterfallOptions, DashboardWidget,
} from "../dashboard/domain";

/**
 * 看板的每个样式字段都得在这里有一条说明 —— AI 只能设它看得到的字段。
 * fieldsOf<T>() 让「看板加了字段、这里没跟上」直接编译不过,AI 不会悄悄落后于看板。
 */
type Fields<T> = { [K in keyof Required<T>]: JsonSchema };
const fieldsOf = <T,>() => <F extends Fields<T>>(fields: F) => fields;

/** The designer and dashboard tools share one contract for persisted visual settings. */
export const APPEARANCE_SCHEMA = S.obj(fieldsOf<DashboardAppearanceOptions>()({
  visualPreset: S.str("视觉预设名,见提示词里给的清单;不确定就别填"),
  background: S.str("卡片背景色 #RRGGBB 或 rgba()"),
  textColor: S.str("正文色，与自定义背景保持足够对比"),
  titleColor: S.str("标题色 #RRGGBB"),
  titleAlign: S.enumOf(["left", "center", "right"]),
  titleSize: S.int("标题字号 px", 11, 28),
  borderColor: S.str("边框色"),
  borderWidth: S.int("边框粗细 px", 0, 8),
  padding: S.int("卡片内边距 px", 0, 64),
  radius: S.int("圆角 px", 0, 24),
  shadow: S.bool("投影"),
  hideTitle: S.bool("不显示标题(文本块当小标题用时常这么做)"),
}), [], "卡片外观,全部可选");

export const CHART_SCHEMA = S.obj(fieldsOf<DashboardChartOptions>()({
  palette: S.arr(S.str("#RRGGBB"), "这张图的配色", 8),
  lineArea: S.bool("折线下方面积填充"),
  dimensionColors: S.record(S.str("颜色"), "按真实系列名或分类值指定颜色"),
  grouping: S.bool("数字千位分隔"), linePoints: S.bool("显示折线的数据点"), lineTimeOrder: S.enumOf(["asc", "desc"], "时间顺序"),
  barShowValues: S.bool("柱形数据值标签"), drillDimensions: S.arr(S.str(), "从当前分组维度再往下钻到哪几层，按顺序；不要重复写当前维度。必须是该数据集的维度字段", 12),
  linkage: S.bool("点图形时联动整个看板;默认关,只在本组件内下钻"),
  secondarySeriesType: S.enumOf(["line", "bar"], "副指标在右轴的图形，适用于不同量纲"),
  displayMode: S.enumOf(["all", "switch", "group_switch"], "全部系列、单指标切换、指标组切换"),
  metricGroups: S.arr(S.obj({ id: S.str(), label: S.str("组的显示名"), metricIds: S.arr(S.str(), "只能引用本组件绑定的指标") }, ["id", "label", "metricIds"]), "指标切换组", 8),
  metricSwitchDefault: S.str("初始指标或组 id"), metricSwitchTitle: S.bool("显示切换器标题"),
  showComparison: S.bool("兼容设置：目前仅 KPI 渲染同比环比，其他图形不会凭此增加趋势"),
  lineWidth: S.int("线宽", 1, 5),
  smooth: S.bool("平滑曲线"),
  barOrientation: S.enumOf(["vertical", "horizontal"], "条形方向;名称长或项数多用 horizontal"),
  barColor: S.str("柱子主色"),
  barEndColor: S.str("柱子渐变终点色"),
  pieIncludeOthers: S.bool("TopN 以外合并为其他，保留完整占比分母"),
  pieShowLabels: S.bool("显示分类名称与占比"),
  pieHole: S.int("内半径百分比，0=实心饼；必须小于外半径。内外半径差越大环越厚，按布局自主决定，不要一律细环", 0, 90),
  pieOuterRadius: S.int("外半径百分比，控制图形占卡片的大小。默认75，默认内半径42；留出标签和图例空间", 20, 95),
  pieLegendPosition: S.enumOf(["bottom", "left", "right"]),
  showLegend: S.bool("显示图例"),
  dataZoom: S.bool("底部缩放滑块;点很多时有用"),
  showLabels: S.bool("数据标签。数据点较多时应关闭"),
  stack: S.bool("堆叠"),
  axis: S.obj({ yMin: { type: "number" }, yMax: { type: "number" }, yTitle: S.str(), xTitle: S.str(), splitLine: S.bool() }),
  tooltip: S.obj({ mode: S.enumOf(["item", "axis"]) }),
  markLine: S.arr(S.obj({ value: { type: "number" }, label: S.str(), color: S.str("参考线颜色") }, ["value"]), "参考线"),
}), [], "图表细节,全部可选");

export const TEXT_SCHEMA = S.obj(fieldsOf<DashboardTextOptions>()({
  fontFamily: S.enumOf(["sans", "serif", "mono"], "无衬线、衬线、等宽字体"),
  lineHeight: S.int("行高百分比", 100, 240), verticalAlign: S.enumOf(["top", "center", "bottom"]),
  fontSize: S.int("字号 px", 11, 40),
  fontWeight: S.int("字重", 300, 800),
  align: S.enumOf(["left", "center", "right"]),
  color: S.str(),
}), [], "文本块排版");

/** Expose existing renderer typography, without prescribing a fixed KPI composition. */
export const KPI_SCHEMA = S.obj(fieldsOf<DashboardKpiOptions>()({
  displayMode: CHART_SCHEMA.properties!.displayMode, metricGroups: CHART_SCHEMA.properties!.metricGroups,
  metricSwitchDefault: CHART_SCHEMA.properties!.metricSwitchDefault, metricSwitchTitle: CHART_SCHEMA.properties!.metricSwitchTitle,
  showAggregation: S.bool("兼容字段，当前正文不再显示技术聚合信息"), showSecondary: S.bool("显示副指标"), secondarySize: S.int("副指标字号 px", 10, 36),
  valueColor: S.str("数字强调色"), valueSize: S.int("数字字号 px", 16, 64), labelSize: S.int("指标名字号 px", 11, 24),
  labelPosition: S.enumOf(["above", "below"]), contentAlign: S.enumOf(["left", "center", "right"]),
  showComparison: S.bool("显示同比/环比涨跌"), comparisonLayout: S.enumOf(["inline", "column"]), comparisonFontSize: S.int("对比字号 px", 10, 20),
}), [], "指标卡的文字层次和对齐方式，全部可选");

export const TABLE_SCHEMA = S.obj(fieldsOf<DashboardTableOptions>()({
  layout: S.enumOf(["flat", "pivot"], "普通明细或透视表"), stripe: S.bool("交替底色"), mergeDimensions: S.bool("合并相同维度单元格"),
  rowTotal: S.bool("行合计"), columnTotal: S.bool("列合计；非可加指标由语义规则限制"), subtotalDimension: S.str("按哪个绑定维度小计"),
  density: S.enumOf(["compact", "normal", "relaxed"]), pageSize: S.int("每页行数", 5, 200), timeOrder: S.enumOf(["asc", "desc"]),
  grouping: S.bool("千位分隔"), freezeDimensions: S.bool("冻结维度列"), headerBg: S.str("表头底色"), headerText: S.str("表头文字色"),
  headerAlign: S.enumOf(["left", "center", "right"]), headerFontSize: S.int("表头字号 px", 10, 28), headerFontWeight: S.int("表头字重", 300, 800),
  headerHeight: S.int("表头高度 px", 20, 100), rowHeight: S.int("数据行高 px", 20, 100), dimensionWidth: S.int("默认维度列宽 px", 40, 800), metricWidth: S.int("默认数值列宽 px", 40, 800),
  columnWidths: S.record(S.int("列宽 px", 40, 800), "真实字段名到列宽"), dimensionSorts: S.record(S.enumOf(["asc", "desc", "group_asc", "group_desc", "custom"]), "绑定维度的排序方式。group_* 是组内排序:先守住上层维度的顺序,只在每个上层分组内部排"),
  dimensionCustomOrders: S.record(S.arr(S.str(), "真实分类值的排列", 100), "自定义维度顺序"), dimensionPlacements: S.record(S.enumOf(["row", "column"]), "透视维度放置位置"),
  metricSort: S.obj({ key: S.str("指标列 key,数据集度量是 field:<字段名>"), dir: S.enumOf(["asc", "desc"]), within: S.bool("只在最近一层分组内部排") }, ["key", "dir"], "按某个指标给行排序"),
}), [], "明细表外观、排序、透视与阅读方式");

export const CONTAINER_SCHEMA = S.obj(fieldsOf<DashboardContainerOptions>()({ tabPosition: S.enumOf(["top", "left"]), showTabBar: S.bool("是否显示切换栏，隐藏时只能看到当前页") }));
export const NUMBER_SCHEMA = S.obj(fieldsOf<DashboardNumberFormat>()({ scale: S.enumOf(["none", "wan", "yi", "auto"], "按万/亿换算；不是修改数据。一张卡上放了量级差很远的几个指标用 auto，让每个数各自选一档"), prefix: S.str(), suffix: S.str("留空沿用指标单位，禁止伪造单位") }));
export const GAUGE_SCHEMA = S.obj(fieldsOf<DashboardGaugeOptions>()({
  shape: S.enumOf(["arc", "ring"], "arc=半圆仪表,ring=圆环进度"),
  max: { type: "number", description: "满刻度;不填时有目标用目标,没有就按数值往上取整" },
  target: { type: "number", description: "目标值:刻度上画一根线并显示完成率" },
  color: S.str("指针/进度主色"),
  colorByProgress: S.bool("按完成率变色:<60% 红,<100% 黄,达标绿"),
}), [], "仪表盘,全部可选");
export const FUNNEL_SCHEMA = S.obj(fieldsOf<DashboardFunnelOptions>()({
  order: S.enumOf(["value", "category"], "按数值从大到小,或保持分类原顺序"),
  showRate: S.bool("每层标签附带占第一层的比例"),
  align: S.enumOf(["center", "left"]),
}), [], "漏斗图,全部可选");
export const SCATTER_SCHEMA = S.obj(fieldsOf<DashboardScatterOptions>()({
  quadrant: S.bool("按横纵平均线分四象限"), showNames: S.bool("点旁边标名字"),
}), [], "散点图,全部可选");
export const RADAR_SCHEMA = S.obj(fieldsOf<DashboardRadarOptions>()({
  shape: S.enumOf(["polygon", "circle"]), fill: S.bool("形状填色"),
}), [], "雷达图,全部可选");
export const HEATMAP_SCHEMA = S.obj(fieldsOf<DashboardHeatmapOptions>()({
  showValues: S.bool("格子里写数值"), color: S.str("主色,颜色深浅由它渐变"),
}), [], "热力图,全部可选");
export const WATERFALL_SCHEMA = S.obj(fieldsOf<DashboardWaterfallOptions>()({
  total: S.bool("末尾加一根合计柱"), totalLabel: S.str("合计柱的名字"), showValues: S.bool("柱上写数值"),
  upColor: S.str("增加的颜色"), downColor: S.str("减少的颜色"), totalColor: S.str("合计柱颜色"),
}), [], "瀑布图,全部可选");
export const RANKING_SCHEMA = S.obj(fieldsOf<DashboardRankingOptions>()({
  order: S.enumOf(["desc", "asc"], "从高到低或从低到高"), barColor: S.str("进度条颜色"),
}), [], "排行榜,全部可选");

export const STYLE_PROPERTIES = {
  gauge: GAUGE_SCHEMA, funnel: FUNNEL_SCHEMA, scatter: SCATTER_SCHEMA, radar: RADAR_SCHEMA,
  heatmap: HEATMAP_SCHEMA, waterfall: WATERFALL_SCHEMA, ranking: RANKING_SCHEMA,
  chart: CHART_SCHEMA, kpi: KPI_SCHEMA, table: TABLE_SCHEMA, appearance: APPEARANCE_SCHEMA, text: TEXT_SCHEMA, container: CONTAINER_SCHEMA,
  numberFormat: NUMBER_SCHEMA, decimals: S.int("数值小数位", 0, 6), percentDecimals: S.int("占比小数位", 0, 6),
  showLegend: S.bool("图例开关"), smooth: S.bool("曲线平滑，数据点本身不变"), topN: S.int("0=完整分类；截取须说明范围", 0, 100),
  metrics: S.record(S.obj({ alias: S.str("显示别名"), decimals: S.int("小数位", 0, 6), unit: S.str("通常省略以继承真实单位；万元/亿元等显示缩放设置 numberFormat.scale，不能写在这里"), direction: S.enumOf(["neutral", "higher", "lower"], "仅遵循指标中心业务方向") }), "当前组件指标 id 到展示别名/精度，不可修改口径"),
  lockedScope: S.obj({ start: S.date(), end: S.date(), filters: S.record(S.arr(S.str(), "真实取值")) }, [], "单卡可缩小已核对范围，不能扩大或替换全局范围"),
};

/**
 * 看板组件的每一组样式 AI 都得够得着。图片的内容只能用户上传、正文走 content 字段,
 * 其余漏一组就编译不过 —— 看板加了新组件的样式,AI 这边会被逼着跟上。
 */
type StyleGroups = Exclude<keyof DashboardWidget["options"], "image" | "content">;
const STYLE_COVERS_EVERY_GROUP: Record<StyleGroups, JsonSchema> = STYLE_PROPERTIES;
void STYLE_COVERS_EVERY_GROUP;
