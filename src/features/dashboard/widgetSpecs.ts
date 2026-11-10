/**
 * 每种组件的说明书 —— **只写这一处**。
 *
 * 谁在读它:
 *   - 看板自己:组件目录的名字、存盘时每种组件留几个维度、要不要留「拆分系列」
 *   - 分析里的 AI:它看到的「有哪些组件、每种能放什么数据」就是这里逐条生成的,
 *     它交上来的绑定也拿这里校验(散点少一个数值就画不出来,得让它当场知道)
 *
 * 所以看板加了一种组件,在这里登记一条,AI 就自动知道了;`Record<DashboardWidgetType, …>`
 * 让漏登记直接编译不过。
 *
 * 这里只写**事实**:它画出来是什么、要什么数据。不写「什么时候该用它」——
 * 用哪种、怎么摆,是做看板的人(或 AI)自己的判断。
 */
import type { DashboardWidget, DashboardWidgetType } from "./domain";

export interface WidgetSpec {
  label: string;
  /** 画出来是什么样、数字怎么读。 */
  shows: string;
  /** 主指标个数 [最少, 最多]。 */
  metrics: [number, number];
  /** 分析维度个数 [最少, 最多]。 */
  dimensions: [number, number];
  /** 维度在这种组件里扮演什么。 */
  dimensionRole?: string;
  /** 指标在这种组件里扮演什么。 */
  metricRole?: string;
  /** 支持「拆分系列」(seriesDimension)时它代表什么;不支持就不写。 */
  series?: string;
  /** 「拆分系列」是不是必须的。 */
  seriesRequired?: boolean;
  /** 支持右轴副指标(secondaryMetricIds)。 */
  secondary?: boolean;
  /** 专属样式放在 options 的哪个键下。 */
  optionKey?: keyof DashboardWidget["options"];
  /** 放了维度时只能有一个指标(饼图:按分类分扇区时,扇区只能来自一个指标)。 */
  oneMetricWhenGrouped?: boolean;
  /** 内容只能由用户提供(图片),程序生成不了。 */
  userContent?: string;
}

export const WIDGET_SPECS: Record<DashboardWidgetType, WidgetSpec> = {
  kpi: {
    label: "指标卡", shows: "一个或几个大数字,可带同比/环比涨跌", metrics: [1, 6], dimensions: [0, 0],
    metricRole: "每个指标一个数字", optionKey: "kpi",
  },
  gauge: {
    label: "仪表盘", shows: "一个数值落在刻度上的位置;设了目标值就显示完成率,可做半圆或圆环", metrics: [1, 1], dimensions: [0, 0],
    optionKey: "gauge",
  },
  line: {
    label: "折线图", shows: "沿横轴按顺序连成线,可开面积填充、堆叠、右轴", metrics: [1, 6], dimensions: [1, 1],
    dimensionRole: "横轴", series: "按它拆成多条线", secondary: true, optionKey: "chart",
  },
  bar: {
    label: "柱状图", shows: "柱子比高低,可竖可横、可堆叠、可加右轴", metrics: [1, 6], dimensions: [1, 1],
    dimensionRole: "分类轴", series: "按它拆成多组柱", secondary: true, optionKey: "chart",
  },
  ranking: {
    label: "排行榜", shows: "名次列表,每行带一根按数值比例的进度条", metrics: [1, 1], dimensions: [1, 1],
    dimensionRole: "被排名的对象", metricRole: "排名依据", optionKey: "ranking",
  },
  waterfall: {
    label: "瀑布图", shows: "每一步的增减依次累加,末尾可加合计柱", metrics: [1, 1], dimensions: [1, 1],
    dimensionRole: "每一步", metricRole: "这一步的增减值(可正可负)", optionKey: "waterfall",
  },
  pie: {
    label: "饼图", shows: "扇区大小 = 该项占所有项数值之和的比例,可挖成环形", metrics: [1, 6], dimensions: [0, 1],
    dimensionRole: "每个扇区是一个分类(此时只放一个指标)", metricRole: "不放维度时,每个指标是一个扇区", oneMetricWhenGrouped: true, optionKey: "chart",
  },
  treemap: {
    label: "矩形树图", shows: "方块面积 = 份额,可分两层;只能表达正数", metrics: [1, 1], dimensions: [1, 2],
    dimensionRole: "第一层、第二层分类", optionKey: "chart",
  },
  funnel: {
    label: "漏斗图", shows: "一层层的数量,可标出每层占第一层的比例", metrics: [1, 1], dimensions: [1, 1],
    dimensionRole: "每一层", optionKey: "funnel",
  },
  scatter: {
    label: "散点图", shows: "每个对象一个点:第一个指标是横轴,第二个是纵轴,第三个可做气泡大小;可按平均线分四象限", metrics: [2, 3], dimensions: [1, 1],
    dimensionRole: "每个点代表什么", series: "按它给点分组上色", optionKey: "scatter",
  },
  radar: {
    label: "雷达图", shows: "每个指标一条轴,每个对象围成一个形状", metrics: [3, 6], dimensions: [1, 1],
    dimensionRole: "每个形状代表的对象", optionKey: "radar",
  },
  heatmap: {
    label: "热力图", shows: "两个维度交叉成格子,颜色深浅是数值", metrics: [1, 1], dimensions: [1, 1],
    dimensionRole: "横轴", series: "纵轴", seriesRequired: true, optionKey: "heatmap",
  },
  table: {
    label: "表格", shows: "明细或透视表,可合计、小计、排序、冻结列", metrics: [0, 12], dimensions: [0, 4],
    dimensionRole: "行(透视时可放到列)", optionKey: "table",
  },
  text: {
    label: "文本", shows: "一段文字:标题、结论、口径说明", metrics: [0, 0], dimensions: [0, 0], optionKey: "text",
  },
  image: {
    label: "图片", shows: "一张图片", metrics: [0, 0], dimensions: [0, 0], optionKey: "image",
    userContent: "图片要用户自己上传,程序生成不了",
  },
  container: {
    label: "分页容器", shows: "几页内容叠在一格里,点页签切换;里面不能再放容器", metrics: [0, 0], dimensions: [0, 0], optionKey: "container",
  },
};

/** 支持「拆分系列」的组件。存盘时只给这些留着 seriesDimension。 */
export const supportsSeries = (type: DashboardWidgetType) => !!WIDGET_SPECS[type].series;

/**
 * 这样绑能不能画出来。返回问题描述;画得出来返回 undefined。
 * 只看个数这种「画不画得出来」的事,不评判选得好不好。
 */
export function bindingProblem(type: DashboardWidgetType, binding: { metrics: number; dimensions: number; series: boolean }): string | undefined {
  const spec = WIDGET_SPECS[type];
  const [minM, maxM] = spec.metrics;
  const [minD, maxD] = spec.dimensions;
  if (binding.metrics < minM) return `${spec.label}至少要 ${minM} 个指标(${spec.metricRole ?? spec.shows})`;
  if (binding.metrics > maxM) return maxM === 0 ? `${spec.label}不放指标` : `${spec.label}最多 ${maxM} 个指标`;
  if (binding.dimensions < minD) return `${spec.label}要 ${minD} 个维度(${spec.dimensionRole ?? ""})`;
  if (binding.dimensions > maxD) return maxD === 0 ? `${spec.label}不分维度` : `${spec.label}最多 ${maxD} 个维度`;
  if (spec.oneMetricWhenGrouped && binding.dimensions > 0 && binding.metrics > 1) return `${spec.label}按维度分的时候只能放 1 个指标`;
  if (binding.series && !spec.series) return `${spec.label}不支持拆分系列`;
  if (!binding.series && spec.seriesRequired) return `${spec.label}还要一个 seriesDimension(${spec.series})`;
  return undefined;
}
