import { useEffect, useRef } from "react";
import ReactECharts from "echarts-for-react";
import type { QueryResult } from "../../../types";
import { useApp } from "../../../store/appStore";
import { registerChartExporter } from "../chartExport";
import { chartChrome, chartPalette } from "../../../lib/themeColors";
import { type DashboardWidget } from "../domain";
import type { ResolvedDashboardMetric } from "../metrics";
import { moreCharts, type MoreChartInput, type MoreEchartType } from "../moreCharts";
import { useChartBox, usePaintGate } from "../useChartBox";
import { aggregate, metricValue } from "./metricUtils";

/** 把查询结果整理成 moreCharts 要的样子 —— 列下标、取值、格式化、主题色。排行榜也用它。 */
export function moreChartInput(widget: DashboardWidget, result: QueryResult, metrics: ResolvedDashboardMetric[], staticRender?: boolean): MoreChartInput {
  const col = (name?: string) => (name ? result.columns.findIndex((c) => c.name === name) : -1);
  const dimNames = widget.bindings.dimensions?.length ? widget.bindings.dimensions : widget.bindings.dimension ? [widget.bindings.dimension] : [];
  const co = widget.options.chart ?? {};
  const chrome = chartChrome();
  return {
    rows: result.rows,
    dims: dimNames.map(col).filter((i) => i >= 0),
    series: col(widget.bindings.seriesDimension),
    measures: metrics.map((m) => ({ name: m.name })),
    agg: (rows, i) => aggregate(rows, metrics[i]),
    fmt: (i, value) => metricValue(metrics[i], value, widget.options.numberFormat),
    palette: co.palette?.length ? co.palette : chartPalette(),
    colorOf: (name) => co.dimensionColors?.[name],
    theme: { muted: chrome.muted, border: chrome.border, surface: chrome.surface, text: chrome.text, accent: chrome.accent, red: chrome.red },
    opts: widget.options as unknown as MoreChartInput["opts"],
    animation: !staticRender,
  };
}

/** 散点 / 雷达 / 热力 / 矩形树 / 瀑布。配置在 moreCharts.runtime.js,导出的网页用同一份。 */
export default function MoreChartWidget({ widget, result, metrics, staticRender }: {
  widget: DashboardWidget & { type: MoreEchartType };
  result: QueryResult;
  metrics: ResolvedDashboardMetric[];
  staticRender?: boolean;
}) {
  const theme = useApp((s) => s.theme);
  const chartRef = useRef<ReactECharts>(null);
  const { ref: boxRef, box } = useChartBox();
  /* 矩形树的下钻是图内缩放,不另发查询。父组件一下钻整张看板会重渲染,
     这里若照常 notMerge,缩放会被打回根节点,看起来像又刷新了一遍。 */
  const shouldSetOption = usePaintGate([widget, result, metrics, theme, box.width, box.height, !!staticRender]);
  useEffect(() => registerChartExporter(widget.id, () => {
    const inst = chartRef.current?.getEchartsInstance();
    if (!inst) return;
    const bg = chartChrome().surface;
    const a = document.createElement("a");
    a.href = inst.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: bg });
    a.download = `${widget.title || widget.type}.png`;
    a.click();
  }), [widget.id, widget.title, widget.type]);

  const option = moreCharts()[widget.type]({ ...moreChartInput(widget, result, metrics, staticRender), box });
  if (option.empty) return <div className="dash-widget-state">{option.empty}</div>;
  return (
    <div ref={boxRef} className="dash-chart-box">
      <ReactECharts ref={chartRef} option={option} shouldSetOption={shouldSetOption} notMerge lazyUpdate style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
