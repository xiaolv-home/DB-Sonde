import { useEffect, useRef } from "react";
import ReactECharts from "echarts-for-react";
import { useI18n } from "../../../hooks/useI18n";
import type { Cell } from "../../../types";
import { useApp } from "../../../store/appStore";
import { appearanceBackground, readableColor } from "../cardReadability";
import { registerChartExporter } from "../chartExport";
import type { DashboardWidget } from "../domain";
import type { ResolvedDashboardMetric } from "../metrics";
import { aggregate, scaledText } from "./metricUtils";

/** 没给满刻度也没给目标时,按数值往上取一个好读的整数(1 / 1.2 / 1.5 / 2 / 2.5 …× 10ⁿ)。 */
export function niceMax(value: number): number {
  if (!(value > 0)) return 100;
  const p = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= value * 1.1) return m * p;
  return 10 * p;
}

/** 完成率配色:不到六成红、不到十成黄、达标绿。 */
const progressColor = (ratio: number) => (ratio < 0.6 ? "#ef5d6f" : ratio < 1 ? "#f2a93b" : "#2ebf8a");

/**
 * 仪表盘 / 进度环:一个数值对着满刻度或目标看完成度。
 * 弧线交给 ECharts 画,中间的数字用 HTML 叠上去 —— 字号、主题色、换算单位跟指标卡一套。
 */
export default function GaugeWidget({ widget, rows, metric, staticRender }: {
  widget: DashboardWidget;
  rows: Cell[][];
  metric?: ResolvedDashboardMetric;
  staticRender?: boolean;
}) {
  const { t } = useI18n();
  const theme = useApp((state) => state.theme);
  const chartRef = useRef<ReactECharts>(null);
  useEffect(() => registerChartExporter(widget.id, () => {
    const inst = chartRef.current?.getEchartsInstance();
    if (!inst) return;
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() || "#ffffff";
    const a = document.createElement("a");
    a.href = inst.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: bg });
    a.download = `${widget.title || "gauge"}.png`;
    a.click();
  }), [widget.id, widget.title]);

  if (!metric) return <div className="dash-widget-state">{t("dashboard.chooseDimensionMeasure")}</div>;

  const go = widget.options.gauge ?? {};
  const ring = go.shape === "ring";
  const value = aggregate(rows, metric);
  const target = go.target != null && Number.isFinite(go.target) && go.target > 0 ? go.target : undefined;
  const max = go.max != null && go.max > 0 ? go.max : target ?? niceMax(value);
  const ratio = target ? value / target : value / max;
  const style = getComputedStyle(document.documentElement);
  void theme; // 换主题时重读 CSS 变量
  const accent = style.getPropertyValue("--accent").trim() || "#4d8dff";
  const track = style.getPropertyValue("--surface-3").trim() || "rgba(127,127,127,.15)";
  const color = go.colorByProgress ? progressColor(ratio) : go.color || accent;
  const nf = widget.options.numberFormat;
  const text = scaledText(value, metric.decimals, metric.unit, nf);
  const pct = `${(ratio * 100).toFixed(widget.options.percentDecimals ?? 1)}%`;
  const caption = target
    ? `目标 ${scaledText(target, metric.decimals, metric.unit, nf)} · 完成 ${pct}`
    : go.max ? `满刻度 ${scaledText(max, metric.decimals, metric.unit, nf)} · ${pct}` : "";

  const width = ring ? 12 : 14;
  const base = {
    type: "gauge" as const,
    min: 0,
    max,
    radius: ring ? "86%" : "96%",
    center: ring ? ["50%", "50%"] : ["50%", "62%"],
    startAngle: ring ? 90 : 205,
    endAngle: ring ? -270 : -25,
    splitNumber: 1,
    axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
    anchor: { show: false }, title: { show: false }, detail: { show: false },
  };
  const series: Record<string, unknown>[] = [{
    ...base,
    progress: { show: true, width, roundCap: true, itemStyle: { color } },
    axisLine: { roundCap: true, lineStyle: { width, color: [[1, track]] } },
    pointer: { show: false },
    data: [{ value: Math.max(0, Math.min(value, max)), name: metric.name }],
  }];
  /* 目标刻度:同一套角度再叠一层,只画一根短指针落在目标值上。 */
  if (target && target < max && !ring) {
    series.push({
      ...base,
      axisLine: { show: false },
      progress: { show: false },
      pointer: { show: true, icon: "rect", length: width + 6, width: 3, offsetCenter: [0, "-89%"], itemStyle: { color: style.getPropertyValue("--text-2").trim() || "#888" } },
      data: [{ value: target }],
      silent: true,
    });
  }
  const option = {
    animation: !staticRender, animationDuration: 260, animationEasing: "linear" as const,
    series,
  };
  /* 数字用卡片文字色,在自定义卡片底色上也读得清。 */
  const valueColor = readableColor(undefined, appearanceBackground(widget.options.appearance)) || undefined;

  return (
    <div className={`dash-gauge ${ring ? "ring" : "arc"}`}>
      <ReactECharts ref={chartRef} option={option} notMerge lazyUpdate style={{ width: "100%", height: "100%" }} />
      <div className="dash-gauge-center">
        <strong style={{ color: valueColor }} title={text}>{text}</strong>
        <span className="dash-gauge-label">{metric.name}</span>
        {caption && <span className="dash-gauge-caption">{caption}</span>}
      </div>
    </div>
  );
}
