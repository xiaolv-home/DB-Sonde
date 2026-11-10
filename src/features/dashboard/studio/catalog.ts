/**
 * 组件目录:「添加组件」菜单和右边的类型切换条都从这里取。
 *
 * **一项就是一种真正不同的图。** 面积图是折线图开了填充、环形图是饼图挖了洞、
 * 条形图是柱状图横过来 —— 这些是样式,在「样式」里切,不在这儿冒充新组件。
 */
import {
  BarChart3, ChartColumnDecreasing, ChartScatter, Funnel, Gauge, Grid3x3, Hash, Hexagon, Image,
  LayoutGrid, LineChart, ListOrdered, PanelTop, PieChart, Table2, Type,
} from "lucide-react";
import type { DashboardWidgetType } from "../domain";
import { WIDGET_SPECS } from "../widgetSpecs";

type Icon = typeof Gauge;

export interface WidgetKind {
  type: DashboardWidgetType;
  label: string;
  icon: Icon;
  /** 菜单上的一句话:什么时候用它。 */
  hint: string;
  /** 右侧切换条一格只有三十来像素宽,名字长的给个短的。 */
  short?: string;
}

const GROUPS: { title: string; kinds: Omit<WidgetKind, "label">[] }[] = [
  {
    title: "数字",
    kinds: [
      { type: "kpi", icon: Hash, hint: "一个或几个大数字,可带同环比" },
      { type: "gauge", icon: Gauge, hint: "一个数值对着目标看完成度(半圆或圆环)" },
    ],
  },
  {
    title: "趋势与比较",
    kinds: [
      { type: "line", icon: LineChart, hint: "按时间看走势,样式里可开面积、堆叠" },
      { type: "bar", icon: BarChart3, hint: "按分类比大小,样式里可横放、堆叠" },
      { type: "ranking", icon: ListOrdered, hint: "名次 + 进度条,门店 / 商品排名" },
      { type: "waterfall", icon: ChartColumnDecreasing, hint: "一步步加减到结果:收入 → 成本 → 利润" },
    ],
  },
  {
    title: "构成",
    kinds: [
      { type: "pie", icon: PieChart, hint: "各部分占整体多少,样式里可挖成环形" },
      { type: "treemap", short: "矩形树", icon: LayoutGrid, hint: "面积即占比,分类多也看得清,可两层下钻" },
      { type: "funnel", icon: Funnel, hint: "一层层往下看转化" },
    ],
  },
  {
    title: "关系与分布",
    kinds: [
      { type: "scatter", icon: ChartScatter, hint: "两个数值的关系,第三个当气泡大小,可分四象限" },
      { type: "radar", icon: Hexagon, hint: "几个对象在多项指标上的强弱轮廓" },
      { type: "heatmap", icon: Grid3x3, hint: "两个维度交叉,颜色深浅看高低(星期 × 时段)" },
    ],
  },
  {
    title: "明细与版面",
    kinds: [
      { type: "table", icon: Table2, hint: "明细、透视、合计都在这里" },
      { type: "text", icon: Type, hint: "标题、口径说明、结论,样式里一键切标题" },
      { type: "image", icon: Image, hint: "Logo、示意图、截图" },
      { type: "container", icon: PanelTop, hint: "几页内容叠在一格,点页签切换" },
    ],
  },
];

/** 名字从组件说明书(widgetSpecs)来 —— 看板和分析里的 AI 叫同一个名字。 */
export const KIND_GROUPS: { title: string; kinds: WidgetKind[] }[] = GROUPS.map((g) => ({
  ...g,
  kinds: g.kinds.map((k) => ({ ...k, label: WIDGET_SPECS[k.type].label })),
}));

export const ALL_KINDS = KIND_GROUPS.flatMap((g) => g.kinds);

/** 每种组件类型的图标和名字(组件卡头、设置面板标题用)。 */
export const TYPE_META = Object.fromEntries(ALL_KINDS.map((k) => [k.type, k])) as Record<DashboardWidgetType, WidgetKind>;
