/**
 * 组件目录:「添加组件」菜单和右边的类型切换条都从这里取。
 *
 * 一个条目 = 一种组件类型 + 一组预设样式。面积图就是折线图开了面积,条形图就是柱状图
 * 横过来,环形图就是饼图挖了洞 —— 底下仍是同一种组件,字段、交互、导出一样都不用另写;
 * 换过去以后在样式里还能接着调。
 *
 * matches 用来在切换条上点亮「现在是哪一个」;同一类型里按顺序取第一个匹配的。
 */
import {
  AreaChart, BarChart3, BarChartHorizontal, ChartColumnStacked, CircleGauge, Donut, Funnel, Gauge, Hash,
  Heading, Image, LineChart, PanelTop, PieChart, Table2, Type,
} from "lucide-react";
import type { DashboardWidget, DashboardWidgetType } from "../domain";

type Icon = typeof Gauge;

/** 每种组件类型的默认图标和名字(组件卡头、设置面板标题用)。 */
export const TYPE_META: Record<DashboardWidgetType, { icon: Icon; label: string }> = {
  kpi: { icon: Hash, label: "指标卡" },
  gauge: { icon: Gauge, label: "仪表盘" },
  line: { icon: LineChart, label: "折线图" },
  bar: { icon: BarChart3, label: "柱状图" },
  pie: { icon: PieChart, label: "饼图" },
  funnel: { icon: Funnel, label: "漏斗图" },
  table: { icon: Table2, label: "表格" },
  text: { icon: Type, label: "文本" },
  image: { icon: Image, label: "图片" },
  container: { icon: PanelTop, label: "分页容器" },
};

export interface WidgetPreset {
  id: string;
  type: DashboardWidgetType;
  label: string;
  icon: Icon;
  /** 菜单上的一句话:什么时候用它。 */
  hint: string;
  /** 新建时的标题(不填用 label)。 */
  title?: string;
  /** 套上这个预设:只改样式,不动字段。 */
  apply?: (w: DashboardWidget) => DashboardWidget;
  matches?: (w: DashboardWidget) => boolean;
}

const chart = (w: DashboardWidget, change: NonNullable<DashboardWidget["options"]["chart"]>): DashboardWidget =>
  ({ ...w, options: { ...w.options, chart: { ...(w.options.chart ?? {}), ...change } } });
const gauge = (w: DashboardWidget, change: NonNullable<DashboardWidget["options"]["gauge"]>): DashboardWidget =>
  ({ ...w, options: { ...w.options, gauge: { ...(w.options.gauge ?? {}), ...change } } });

const horizontal = (w: DashboardWidget) => w.options.chart?.barOrientation === "horizontal";
/** 饼图默认就挖了 42% 的洞(见 pieGeometry),所以没设过的老饼图算环形。 */
const holed = (w: DashboardWidget) => (w.options.chart?.pieHole ?? 42) > 0;

export const PRESET_GROUPS: { title: string; presets: WidgetPreset[] }[] = [
  {
    title: "数字",
    presets: [
      { id: "kpi", type: "kpi", label: "指标卡", icon: Hash, hint: "一个或几个大数字,可带同环比" },
      { id: "gauge", type: "gauge", label: "仪表盘", icon: Gauge, hint: "一个数值对着目标看完成度",
        apply: (w) => gauge(w, { shape: "arc" }), matches: (w) => w.options.gauge?.shape !== "ring" },
      { id: "ring", type: "gauge", label: "进度环", icon: CircleGauge, hint: "圆环显示完成率,适合放小格子",
        apply: (w) => gauge(w, { shape: "ring" }), matches: (w) => w.options.gauge?.shape === "ring" },
    ],
  },
  {
    title: "趋势",
    presets: [
      { id: "line", type: "line", label: "折线图", icon: LineChart, hint: "按时间看走势",
        apply: (w) => chart(w, { lineArea: false, stack: false }), matches: (w) => w.options.chart?.lineArea !== true },
      { id: "area", type: "line", label: "面积图", icon: AreaChart, hint: "走势 + 量感,多条会叠起来",
        apply: (w) => chart(w, { lineArea: true, stack: true }), matches: (w) => w.options.chart?.lineArea === true },
    ],
  },
  {
    title: "比较",
    presets: [
      { id: "column", type: "bar", label: "柱状图", icon: BarChart3, hint: "按分类比大小",
        apply: (w) => chart(w, { barOrientation: "vertical", stack: false }), matches: (w) => !horizontal(w) && !w.options.chart?.stack },
      { id: "hbar", type: "bar", label: "条形图", icon: BarChartHorizontal, hint: "分类名字长、个数多时用,适合排名",
        apply: (w) => chart(w, { barOrientation: "horizontal", stack: false }), matches: (w) => horizontal(w) },
      { id: "stack", type: "bar", label: "堆叠柱", icon: ChartColumnStacked, hint: "拆系列后叠在一起,看总量和构成",
        apply: (w) => chart(w, { barOrientation: "vertical", stack: true }), matches: (w) => !horizontal(w) && !!w.options.chart?.stack },
    ],
  },
  {
    title: "占比",
    presets: [
      { id: "pie", type: "pie", label: "饼图", icon: PieChart, hint: "各部分占整体多少",
        apply: (w) => chart(w, { pieHole: 0 }), matches: (w) => !holed(w) },
      { id: "donut", type: "pie", label: "环形图", icon: Donut, hint: "饼图挖空,中间更清爽",
        apply: (w) => chart(w, { pieHole: 55 }), matches: holed },
      { id: "funnel", type: "funnel", label: "漏斗图", icon: Funnel, hint: "一层层往下看转化" },
    ],
  },
  {
    title: "明细",
    presets: [
      { id: "table", type: "table", label: "表格", icon: Table2, hint: "明细、透视、合计都在这里" },
    ],
  },
  {
    title: "版面",
    presets: [
      { id: "heading", type: "text", label: "标题", icon: Heading, hint: "给一块区域起个名字", title: "标题",
        apply: (w) => ({ ...w, options: {
          ...w.options, content: w.options.content || "小标题",
          text: { ...(w.options.text ?? {}), fontSize: 22, fontWeight: 700, verticalAlign: "center" },
          // 标题块自己就是标题,卡头那行「标题」重复了
          appearance: { ...(w.options.appearance ?? {}), hideTitle: true },
        } }),
        matches: (w) => (w.options.text?.fontWeight ?? 500) >= 700 },
      { id: "text", type: "text", label: "文本", icon: Type, hint: "口径说明、结论、备注",
        apply: (w) => ({ ...w, options: { ...w.options, text: { ...(w.options.text ?? {}), fontSize: 15, fontWeight: 400, lineHeight: 160, verticalAlign: "top" } } }) },
      { id: "image", type: "image", label: "图片", icon: Image, hint: "Logo、示意图、截图" },
      { id: "container", type: "container", label: "分页容器", icon: PanelTop, hint: "几页内容叠在一格,点页签切换" },
    ],
  },
];

export const ALL_PRESETS = PRESET_GROUPS.flatMap((g) => g.presets);

/** 这个组件现在算哪一个预设(切换条上点亮它)。 */
export function presetOf(widget: DashboardWidget): WidgetPreset | undefined {
  const same = ALL_PRESETS.filter((p) => p.type === widget.type);
  return same.find((p) => p.matches?.(widget) ?? true) ?? same[0];
}
