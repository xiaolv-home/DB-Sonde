import { PIE_LABEL, pieRadii } from "../pieGeometry";
import { escapeHtml } from "../tooltipText";
import { useCallback, useEffect, useRef } from "react";
import ReactECharts from "echarts-for-react";
import { ChevronLeft } from "lucide-react";
import type { ECharts } from "echarts";
import { useI18n } from "../../../hooks/useI18n";
import type { Cell, QueryResult } from "../../../types";
import { useApp } from "../../../store/appStore";
import { chartChrome, chartPalette, cssSource, readVar } from "../../../lib/themeColors";
import { type DashboardDrillFilter, type DashboardWidget } from "../domain";
import { isTimeField } from "../../datasets/domain";
import type { ResolvedDashboardMetric } from "../metrics";
import { registerChartExporter } from "../chartExport";
import { aggregate, axisUnit, buildMetricChoices, formatNumber, metricLabel, metricValue, numberValue, scaledText } from "./metricUtils";
import { pieComposition } from "./pieComposition";
import { installFreeCrosshair } from "../freeCrosshair";
import { orderLabels, orderSpecOf } from "../labelOrder";

interface Props {
  staticRender?: boolean;
  widget: DashboardWidget;
  result: QueryResult;
  resolvedMetrics: ResolvedDashboardMetric[];
  secondaryMetrics: ResolvedDashboardMetric[];
  dimensionName: string;
  dimensionIndex: number;
  activeMeasure: string;
  onActiveMeasure: (key: string) => void;
  onDrill?: (filter: DashboardDrillFilter) => void;
  drillDimensions?: string[];
  drillPath?: { dimension: string; value: string }[];
  /** 维度字段 → 中文名,面包屑上标「按什么钻的」。 */
  dimensionLabels?: Record<string, string>;
  onDrillDown?: (value: string) => void;
  onDrillTo?: (level: number) => void;
}

/** 折线 / 柱状 / 饼图:分组取数 → 构建系列 → 生成 ECharts option,支持双轴、TopN、系列维度、多级下钻。 */
export default function ChartWidget(props: Props) {
  const { widget, result, resolvedMetrics, secondaryMetrics, dimensionName, dimensionIndex, activeMeasure, onActiveMeasure, onDrill, drillDimensions, drillPath, onDrillDown, onDrillTo } = props;
  const { t } = useI18n();
  // 订阅主题:切换深浅色时强制重渲,让 getComputedStyle 读到新的 CSS 变量。
  const theme = useApp((state) => state.theme);

  // 导出 PNG:把本组件的 ECharts 实例导出函数注册到全局表,供画布头部按钮调用。
  const chartRef = useRef<ReactECharts>(null);
  const crosshairChartRef = useRef<ECharts | null>(null);
  const crosshairCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => registerChartExporter(widget.id, () => {
    const inst = chartRef.current?.getEchartsInstance();
    if (!inst) return;
    const bg = readVar("--surface");
    const url = inst.getDataURL({ type: "png", pixelRatio: 2, backgroundColor: bg });
    const a = document.createElement("a");
    a.href = url;
    a.download = `${widget.title || "chart"}.png`;
    a.click();
  }), [widget.id, widget.title]);

  // 必须等 echarts-for-react 完成异步初始化并 setOption 后再挂载。仅靠父组件
  // useEffect 会偶发早于 onChartReady，导致线图根本没有注册 mousemove。
  const attachCrosshair = useCallback((chart: ECharts) => {
    crosshairChartRef.current = chart;
    crosshairCleanupRef.current?.();
    crosshairCleanupRef.current = null;
    if (widget.type !== "line" && widget.type !== "bar") return;
    const chrome = chartChrome(cssSource(chart.getDom().closest(".dash-widget")));
    crosshairCleanupRef.current = installFreeCrosshair(chart, {
      formatValue: (value) => {
        const nf = widget.options.numberFormat;
        return scaledText(value, widget.options.decimals, "", nf, widget.options.chart?.grouping === true);
      },
      horizontalValueAxis: widget.type === "bar" && widget.options.chart?.barOrientation === "horizontal",
      lineColor: chrome.muted,
      labelColor: chrome.text,
      labelBackground: chrome.surface3,
      labelBorder: chrome.border2,
    });
  /* theme 不是多余依赖:这个回调用 getPropertyValue 现读 CSS 变量的值,换主题时
     那些值会变,而 eslint 看不出来。去掉它,换主题图表就不重画。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 换主题会改 CSS 变量,回调用 getPropertyValue 现读,静态分析看不到 theme
  }, [theme, widget.type, widget.options.chart?.barOrientation, widget.options.chart?.grouping, widget.options.numberFormat, widget.options.decimals]);
  useEffect(() => {
    const chart = crosshairChartRef.current;
    if (chart && !chart.isDisposed()) attachCrosshair(chart);
  }, [attachCrosshair]);
  useEffect(() => () => {
    crosshairCleanupRef.current?.();
    crosshairCleanupRef.current = null;
    crosshairChartRef.current = null;
  }, []);

  if (dimensionIndex < 0 || resolvedMetrics.length === 0) {
    return <div className="dash-widget-state">{t("dashboard.chooseDimensionMeasure")}</div>;
  }

  // 指标切换 / 分组切换:决定实际绘制的指标集合。'all' 或未开时保持原多系列行为。
  const chartOpt = widget.options.chart ?? {};
  const choices = buildMetricChoices(chartOpt.displayMode, chartOpt.metricGroups, resolvedMetrics, t("dashboard.metricSwitch"));
  const switching = (chartOpt.displayMode === "switch" || chartOpt.displayMode === "group_switch") && choices.length > 1;
  const activeChoice = switching
    ? (choices.find((c) => c.id === activeMeasure) ?? choices.find((c) => c.id === chartOpt.metricSwitchDefault) ?? choices[0])
    : undefined;
  const displayMetrics = activeChoice ? activeChoice.metrics : resolvedMetrics;
  const displaySecondary = switching ? [] : secondaryMetrics;

  // 多分析维度:时间维度做 x 轴,其余维度(+ 图例维度)组合成系列 —— 每个组合一条线/一组柱。
  /* 哪一列当 x 轴,用数据集那个同一个判断,别在这儿另写一条正则:两条规则会分家 ——
     `settle_dt` 在一边算时间、另一边不算,x 轴和日期范围就落到了不同的列上。
     而且这里能拿到数据库给的列类型,比只看名字准。 */
  const isTimeDim = (name: string) =>
    isTimeField({ name, type: result.columns.find((column) => column.name === name)?.typeName });
  const analysisDims = widget.bindings.dimensions?.length ? widget.bindings.dimensions : (widget.bindings.dimension ? [widget.bindings.dimension] : []);
  const xDimName = analysisDims.find(isTimeDim) ?? analysisDims[0] ?? dimensionName;
  const xFound = result.columns.findIndex((c) => c.name === xDimName);
  const xi = analysisDims.length ? (xFound >= 0 ? xFound : dimensionIndex) : -1;
  const seriesDimNames = [...new Set([...analysisDims.filter((d) => d !== xDimName), widget.bindings.seriesDimension].filter((d): d is string => !!d && d !== xDimName))];
  const seriesDimIdx = seriesDimNames.map((n) => result.columns.findIndex((c) => c.name === n)).filter((i) => i >= 0);
  const seriesKey = (row: Cell[]) => seriesDimIdx.map((i) => String(row[i] ?? "NULL")).join(" · ");

  /* 一遍过把行分好三份索引:按 x 轴、按图例维度、以及「x 轴 × 图例维度」。
     下面排图例和造系列都直接查表。三件事原来都是现算的,数据一多就卡到打字都跟不上:
     - 这个循环原来是 set(label, [...已有的, row]) —— 每加一行都把该组已有的行整体复制
       一遍,一个组两万行就是两亿次复制;
     - 图例排序在比较函数里 filter 全表(见下面);
     - 每个系列的每个点又把该组的行 filter 一遍(buildSeries)。 */
  const groupedRows = new Map<string, Cell[][]>();
  const rowsBySeries = new Map<string, Cell[][]>();
  const rowsByLabelSeries = new Map<string, Map<string, Cell[][]>>();
  for (const row of result.rows) {
    const label = xi < 0 ? "合计" : String(row[xi] ?? "NULL");
    let bucket = groupedRows.get(label);
    if (!bucket) { bucket = []; groupedRows.set(label, bucket); rowsByLabelSeries.set(label, new Map()); }
    bucket.push(row);
    if (!seriesDimIdx.length) continue;
    const key = seriesKey(row);
    let series = rowsBySeries.get(key);
    if (!series) { series = []; rowsBySeries.set(key, series); }
    series.push(row);
    const cell = rowsByLabelSeries.get(label)!;
    let inner = cell.get(key);
    if (!inner) { inner = []; cell.set(key, inner); }
    inner.push(row);
  }
  const rowsOf = (label: string, seriesValue: string) =>
    (seriesValue ? rowsByLabelSeries.get(label)?.get(seriesValue) : groupedRows.get(label)) ?? [];
  /* 多个指标、没有维度时,**指标名就是分类** —— 而不是一个叫"合计"的空分组。
     原来只有饼图这么做,柱形图落到 `label = "合计"`:五个渠道全挤进一组,
     名字被塞进图例(而图例常常没显示),图上一个渠道名都看不到。
     真机上「线下各渠道销售额排名」就是这样 —— 渠道在这个目录里是**各自独立的指标**
     (不是某个维度的取值),用户要的正是各渠道,结果一个都没露出来。

     护栏照搬饼图那套,并且是必要的:单位不同的指标(销售额 元 / 订单量 单)
     并排放在同一根轴上,那根轴没有意义 —— 这条旧规矩("指标值不能当分类")的
     用意是对的,这里只是把它收窄到"单位相同、可加"之外。 */
  const composable = !analysisDims.length && !switching && displayMetrics.length > 1
    && displayMetrics.every(m => ["sum","count"].includes(m.aggregation) && m.unit === displayMetrics[0].unit);
  const metricComposition = widget.type === "pie" && composable;
  const metricBars = widget.type === "bar" && composable;
  const activePieMetric = switching ? displayMetrics[0] : (displayMetrics.find((metric) => metric.key === activeMeasure) ?? displayMetrics[0]);
  const rankingMetric = widget.type === "pie" || widget.type === "funnel" ? activePieMetric : displayMetrics[0];
  const rankedLabels = [...groupedRows.keys()].sort((a, b) => aggregate(groupedRows.get(b) ?? [], rankingMetric) - aggregate(groupedRows.get(a) ?? [], rankingMetric));
  const picked = widget.options.topN > 0 && (widget.type === "bar" || widget.type === "pie")
    ? rankedLabels.slice(0, widget.options.topN)
    : [...groupedRows.keys()];
  /* 分类轴的顺序。以前只有折线图能排(而且是在样式面板里的「时间顺序」),表格另有一套,
     换个图表类型排序就没了 —— 现在三种图和表格读同一处设置、同一套规则
     (labelOrder.runtime.js,导出的页面也用它)。 */
  const orderSpec = orderSpecOf(widget, xDimName, displayMetrics.map((m) => m.key), isTimeDim(xDimName));
  const orderMetric = orderSpec.metricKey ? displayMetrics.find((m) => m.key === orderSpec.metricKey) : undefined;
  /* 指标当分类时,分类轴就是指标名,按值从大到小 —— 这类图本来就是"排名"。
     topN 照样生效(要前三个渠道就给前三个)。 */
  const metricBarRanked = metricBars
    ? displayMetrics.map((m) => ({ label: metricLabel(m), metric: m, value: aggregate(result.rows, m) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, widget.options.topN > 0 ? widget.options.topN : undefined)
    : [];
  /* 量级差太远的小项不画。真机:示例POS 98 万 / 地图团购 726.76 元 / 快手 0 ——
     后两根柱子在 98 万的轴上根本不占像素,既看不出大小也读不出数,
     却把图例和轴挤满。差三个数量级以上(和 0)就不画。
     **但一定要说出来**:下面那行注脚点名列出没画的是谁、各是多少 ——
     从图里拿掉可以,悄悄拿掉不行,那是"看起来正常"的那类错。
     注脚**不跟卡片的换算走**:这行字存在的意义就是给出真实数值,
     726.76 元按「万」显示成「0.1万元」,等于把要说清的东西又糊掉一次。 */
  const metricBarMax = metricBarRanked[0]?.value ?? 0;
  const metricBarTiny = metricBarMax > 0 ? metricBarRanked.filter((e) => e.value <= 0 || e.value / metricBarMax < 1e-3) : [];
  const metricBarTotals = metricBarRanked.length - metricBarTiny.length >= 2
    ? metricBarRanked.filter((e) => !metricBarTiny.includes(e))
    : metricBarRanked;
  const droppedBars = metricBarRanked.filter((e) => !metricBarTotals.includes(e));
  const labels = metricBars
    ? metricBarTotals.map((entry) => entry.label)
    : orderLabels(picked, orderSpec, (label) =>
      orderMetric ? aggregate(groupedRows.get(label) ?? [], orderMetric) : Number.NaN);
  const maxSeriesValues = Math.max(1, Math.floor(12 / Math.max(1, displayMetrics.length)));
  /* 每个图例值的总量先各算一次再排序。原来那两句 filter 写在比较函数里,
     每比较一次就把整张表扫两遍 —— 两百个网点排序就是五千多万次取值。 */
  const seriesTotals = new Map<string, number>();
  for (const [key, rows] of rowsBySeries) seriesTotals.set(key, aggregate(rows, rankingMetric));
  const seriesValues = seriesDimIdx.length === 0 ? [] : [...rowsBySeries.keys()]
    .sort((a, b) => (seriesTotals.get(b) ?? 0) - (seriesTotals.get(a) ?? 0))
    .slice(0, maxSeriesValues);
  const co = widget.options.chart ?? {};
  // Always give ECharts a concrete palette. Passing an explicit undefined
  // color/style suppresses series painting in the Tauri WebView even though
  // axes and legends still render.
  const style = cssSource(chartRef.current?.getEchartsInstance()?.getDom().closest(".dash-widget"));
  const chrome = chartChrome(style);
  // 用户在这张图上设过的配色原样用;没设过才跟当前主题的系列色。
  const palette = co.palette && co.palette.length ? co.palette : chartPalette(style);
  const colorOf = (name: string) => co.dimensionColors?.[name];
  const grouping = co.grouping === true;
  // 数字显示格式(万/亿换算 + 前后缀):轴刻度、数据标签、tooltip 都要跟着走,
  // 否则轴上写「12,345,678」而标签写「1,234.6 万」,同一张图两套读数。
  const nf = widget.options.numberFormat;
  const scaleDiv = nf?.scale === "wan" ? 1e4 : nf?.scale === "yi" ? 1e8 : 1;
  const showValues = co.showLabels === true || co.barShowValues === true;
  const horizontal = widget.type === "bar" && co.barOrientation === "horizontal";
  const muted = chrome.muted;
  const border = chrome.border;
  const surface = chrome.surface;
  const accent = chrome.accent;
  const tip = { backgroundColor: chrome.surface3, borderColor: chrome.border2, textStyle: { color: chrome.text } };
  const gradient = (from: string, to: string, vertical: boolean) => ({ type: "linear" as const, x: 0, y: 0, x2: vertical ? 0 : 1, y2: vertical ? 1 : 0, colorStops: [{ offset: 0, color: from }, { offset: 1, color: to }] });

  const buildSeries = (selected: ResolvedDashboardMetric[], yAxisIndex: number, single: boolean, seriesType: "bar" | "line", stackId?: string) => selected.flatMap((metric) => {
    const categories = seriesValues.length ? seriesValues : [""];
    return categories.map((seriesValue) => {
      const custom = colorOf(seriesValue) || colorOf(metricLabel(metric)) || colorOf(metric.name);
      const isBar = seriesType === "bar";
      const data = labels.map((label) => aggregate(rowsOf(label, seriesValue), metric));
      return {
        // 单指标 + 图例维度:系列名只留维度值(如“山东大区”,像饼图那样),不带指标前缀;
        // 多指标时才用“指标 · 维度值”区分。
        name: seriesValue ? (selected.length === 1 ? seriesValue : `${metricLabel(metric)} · ${seriesValue}`) : metricLabel(metric),
        type: isBar ? "bar" : "line",
        data,
        smooth: widget.options.smooth !== false,
        smoothMonotone: !isBar ? ("x" as const) : undefined,
        yAxisIndex,
        stack: stackId,
        barMaxWidth: 30,
        showSymbol: co.linePoints !== false,
        symbol: labels.length > 24 || co.linePoints === false ? "none" : "circle",
        symbolSize: 4,
        label: showValues ? { show: true, position: (horizontal ? "right" : "top") as "right" | "top", color: muted, fontSize: 9, formatter: (p: { value: number }) => scaledText(numberValue(p.value), metric.decimals, "", yAxisIndex === 1 ? undefined : nf, grouping) } : undefined,
        itemStyle: isBar
          ? {
              borderRadius: (horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]) as [number, number, number, number],
              ...(custom || co.barColor ? { color: custom ?? gradient(co.barColor!, co.barEndColor || co.barColor!, false) } : {}),
            }
          : (custom ? { color: custom } : undefined),
        lineStyle: !isBar ? { width: co.lineWidth ?? 2.4, ...(custom ? { color: custom } : {}) } : undefined,
        /* 面积:没设过时只有单条线带一层淡影(老样子);在「面积图」里显式打开时每条都填,
           多条的颜色交给 ECharts 跟线走。 */
        areaStyle: isBar ? undefined
          : co.lineArea === true
            ? (single ? { opacity: 0.32, color: gradient(custom || palette?.[0] || accent, "transparent", true) } : { opacity: 0.28, ...(custom ? { color: custom } : {}) })
            : single && co.lineArea !== false ? { opacity: 0.18, color: gradient(custom || palette?.[0] || accent, "transparent", true) } : undefined,
        tooltip: { valueFormatter: (value: number) => metricValue(metric, numberValue(value), yAxisIndex === 1 ? undefined : nf) },
      };
    });
  });
  const single = displayMetrics.length === 1 && seriesValues.length <= 1;
  // Explicit secondarySeriesType enables an independently scaled axis; old tooltip-only cards remain unchanged.
  const dualAxis = !!co.secondarySeriesType && displaySecondary.length > 0 && !horizontal;
  const primaryType = widget.type === "bar" ? "bar" : "line";
  /* 指标当分类时只画**一条**系列,每个指标是它的一个点。借第一个指标跑一遍 buildSeries
     拿到全套样式(圆角、渐变、数据标签、tooltip 格式),再把 data 换成各指标的值 ——
     单位和聚合方式都相同(上面的护栏保证了),所以用哪个指标格式化都一样。 */
  const series = metricBars
    ? [{ ...buildSeries([displayMetrics[0]], 0, true, "bar")[0], name: "", data: metricBarTotals.map((entry) => entry.value) }]
    : [...buildSeries(displayMetrics, 0, single && !dualAxis, primaryType, co.stack ? "stack-primary" : undefined), ...(dualAxis ? buildSeries(displaySecondary, 1, false, co.secondarySeriesType!, undefined) : [])];
  // 系列 → 指标/维度值 的对齐表(buildSeries 顺序 = 每指标 × 每系列值)。
  const seriesCats = seriesValues.length ? seriesValues : [""];
  const seriesMetrics = [...displayMetrics, ...(dualAxis ? displaySecondary : [])].flatMap((m) => seriesCats.map(() => m));
  const seriesCatOf = [...displayMetrics, ...(dualAxis ? displaySecondary : [])].flatMap(() => seriesCats);
  /** 某个系列值下的副指标摘要:`订单量 18,164单`,多个副指标用 · 连接。空则返回 ""。
   *  **返回的是已转义的 HTML 片段**,调用方直接拼,不要再 escapeHtml 一次。 */
  const secondarySummary = (label: string, seriesValue: string) => {
    if (!displaySecondary.length) return "";
    const scoped = rowsOf(label, seriesValue);
    return displaySecondary.map((sm) => `${escapeHtml(sm.name)} ${escapeHtml(metricValue(sm, aggregate(scoped, sm)))}`).join(" · ");
  };
  type TipParam = { axisValue?: string; name?: string; marker?: string; seriesName?: string; seriesIndex: number; value: number; percent?: number };
  // 紧凑排版:副指标并进它所属系列那一行,不再另起一整段(否则 9 条线会撑成 18 行)。
  const tooltipFormatter = (params: TipParam | TipParam[]) => {
    const arr = Array.isArray(params) ? params : [params];
    const x = String(arr[0]?.axisValue ?? arr[0]?.name ?? "");
    const lines = [`<div style="font-weight:600;margin-bottom:2px">${escapeHtml(x)}</div>`];
    arr.forEach((p) => {
      const m = seriesMetrics[p.seriesIndex];
      const val = m ? metricValue(m, numberValue(p.value), dualAxis && p.seriesIndex >= displayMetrics.length * seriesCats.length ? undefined : nf) : formatNumber(numberValue(p.value), 2, grouping);
      const extra = dualAxis ? "" : secondarySummary(x, seriesCatOf[p.seriesIndex] ?? "");
      lines.push(`${p.marker ?? ""} ${escapeHtml(p.seriesName ?? "")}: <b>${escapeHtml(val)}</b>${extra ? ` <span style="opacity:.6">· ${extra}</span>` : ""}`);
    });
    return lines.join("<br/>");
  };
  // 饼图逐扇区:主值 + 占比 + 该扇区的副指标(与折线/条形口径一致)。
  const pieData = widget.type === "pie" ? pieComposition(
    metricComposition ? displayMetrics.map(m => ({name: metricLabel(m), value: aggregate(result.rows,m)})) : [...groupedRows.keys()].map((name) => ({ name, value: aggregate(groupedRows.get(name) ?? [], activePieMetric) })),
    widget.options.topN, co.pieIncludeOthers !== false,
  ) : [];
  /* 被剔掉的分组数。占比的分母跟着变了,得说一声 —— 不然人看到的百分比是按剩下的
     那些算的,自己却不知道少了谁。 */
  const pieDropped = widget.type === "pie"
    ? (metricComposition ? displayMetrics.length : groupedRows.size) - pieData.filter((d) => !d.isOther).length
    : 0;
  const coloredPieData = pieData.map((slice, index) => {
    const metric = metricComposition ? displayMetrics.find(m => metricLabel(m) === slice.name) : undefined;
    const color = slice.isOther ? muted : colorOf(slice.name) || (metric && (colorOf(metric.key) || colorOf(metric.name))) || palette[index % palette.length];
    return { ...slice, itemStyle: { color } };
  });
  const pieLegendData = coloredPieData.map(slice => ({ name: slice.name, itemStyle: { color: slice.itemStyle.color } }));
  const manySlices = pieData.length > 8;
  const showPieLabels = co.pieShowLabels === true && !manySlices;
  const pieTooltipFormatter = (p: TipParam) => {
    const label = String(p.name ?? "");
    const extra = metricComposition ? "" : pieData.some((slice) => slice.name === label && slice.isOther) ? "包含其余全部分组" : secondarySummary(label, "");
    const head = `${p.marker ?? ""} ${escapeHtml(label)}: <b>${escapeHtml(metricValue(activePieMetric, numberValue(p.value)))}</b>${p.percent != null ? ` <span style="opacity:.6">${escapeHtml(p.percent)}%</span>` : ""}`;
    return extra ? `${head}<br/><span style="opacity:.6">${extra}</span>` : head;
  };

  const ax = co.axis ?? {};
  const catAxis = {
    type: "category" as const, data: labels,
    name: ax.xTitle || undefined, nameLocation: "middle" as const, nameGap: 26,
    nameTextStyle: { color: muted, fontSize: 10 },
    axisLabel: { color: muted, hideOverlap: true, fontSize: 10 },
    axisLine: { lineStyle: { color: border } }, axisTick: { show: false },
  };
  /* 数值轴:默认无网格线(用户当初要求去掉密集横线),但现在可以按需打开;
     min/max 留空即自适应 —— 填上是为了把多张图对齐到同一量纲,或把基线从 0
     抬起来看清小幅波动。轴名优先用自定义标题,否则回落到共享单位。 */
  const valAxis = {
    type: "value" as const,
    name: ax.yTitle || axisUnit(displayMetrics),
    ...(ax.yMin != null ? { min: ax.yMin } : {}),
    ...(ax.yMax != null ? { max: ax.yMax } : {}),
    axisLabel: { color: muted, fontSize: 10, formatter: (v: number) => formatNumber(v / scaleDiv, nf?.scale && nf.scale !== "none" ? 1 : 0, grouping) },
    axisLine: { show: false }, axisTick: { show: false },
    splitLine: { show: ax.splitLine === true, lineStyle: { color: border, type: "dashed" as const, opacity: .6 } },
  };
  /* 参考线:管理层看板常要一条目标线 / 去年均值线。挂在第一个系列上,
     ECharts 的 markLine 是系列级的。 */
  const markLine = (co.markLine ?? []).filter((m) => Number.isFinite(m.value));
  if (markLine.length && series.length) {
    (series[0] as Record<string, unknown>).markLine = {
      silent: true, symbol: "none" as const,
      data: markLine.map((m) => ({
        yAxis: m.value,
        lineStyle: { color: m.color ?? chrome.amber, type: "dashed" as const, width: 1.5 },
        label: { show: !!m.label, formatter: m.label ?? "", color: muted, fontSize: 10, position: "insideEndTop" as const },
      })),
    };
  }
  // 克制的动画:短时长 + 线性,不做"画线/长柱/转盘"那种夸张入场,更专业。
  const anim = { animation: !props.staticRender, animationDuration: 220, animationDurationUpdate: 220, animationEasing: "linear" as const, animationEasingUpdate: "linear" as const };
  /* 漏斗:默认按数值从大到小;转化步骤(浏览→加购→下单)要按分类原顺序排,在样式里切。
     每层标上占第一层的百分比 —— 漏斗要看的就是这个。 */
  const fo = widget.options.funnel ?? {};
  const funnelNames = widget.type === "funnel"
    ? (fo.order === "category" ? labels : rankedLabels).slice(0, widget.options.topN > 0 ? widget.options.topN : 20)
    : [];
  const funnelData = funnelNames.map((name, index) => ({
    name,
    value: aggregate(groupedRows.get(name) ?? [], activePieMetric),
    itemStyle: { color: colorOf(name) || palette[index % palette.length] },
  }));
  const funnelHead = (fo.order === "category" ? funnelData[0]?.value : Math.max(0, ...funnelData.map((d) => d.value))) || 0;
  const funnelRate = (v: number) => (funnelHead > 0 ? `${((v / funnelHead) * 100).toFixed(widget.options.percentDecimals ?? 1)}%` : "--");
  const funnelOption = {
    ...anim,
    color: palette,
    tooltip: {
      ...tip,
      trigger: "item",
      formatter: (p: TipParam) => `${p.marker ?? ""} ${escapeHtml(String(p.name ?? ""))}: <b>${escapeHtml(metricValue(activePieMetric, numberValue(p.value), nf))}</b> <span style="opacity:.6">占第一层 ${funnelRate(numberValue(p.value))}</span>`,
    },
    series: [{
      name: metricLabel(activePieMetric),
      type: "funnel",
      sort: fo.order === "category" ? "none" : "descending",
      funnelAlign: fo.align ?? "center",
      left: "4%", right: "4%", top: 6, bottom: 6, width: "92%",
      minSize: "8%", maxSize: "100%", gap: 2,
      label: {
        show: true, position: "inside", color: "#fff", fontSize: 12, overflow: "truncate",
        textShadowColor: "rgba(0,0,0,.35)", textShadowBlur: 3,
        formatter: (p: { name: string; value: number }) => {
          const v = scaledText(numberValue(p.value), activePieMetric.decimals, "", nf, grouping);
          return fo.showRate === false ? `${p.name}  ${v}` : `${p.name}  ${v} · ${funnelRate(numberValue(p.value))}`;
        },
      },
      labelLine: { show: false },
      itemStyle: { borderColor: surface, borderWidth: 1 },
      data: funnelData,
    }],
  };
  const option = widget.type === "funnel" ? funnelOption : widget.type === "pie"
    ? {
        ...anim,
        color: palette,
        tooltip: { ...tip, trigger: "item", formatter: pieTooltipFormatter },
        legend: manySlices ? { data: pieLegendData, show: widget.options.showLegend, type: "scroll" as const, orient: "vertical" as const, right: 0, top: 8, bottom: 8, width: "28%", textStyle: { color: muted, width: 100, overflow: "truncate" }, pageTextStyle: { color: muted } } : co.pieLegendPosition === "left"
          ? { data: pieLegendData, show: widget.options.showLegend, left: 0, top: "middle", orient: "vertical" as const, textStyle: { color: muted } }
          : co.pieLegendPosition === "right"
            ? { data: pieLegendData, show: widget.options.showLegend, right: 0, top: "middle", orient: "vertical" as const, textStyle: { color: muted } }
            : { data: pieLegendData, show: widget.options.showLegend, bottom: 0, textStyle: { color: muted } },
        series: [{
          name: metricLabel(activePieMetric),
          type: "pie",
          radius: pieRadii(co.pieHole, co.pieOuterRadius, showPieLabels).map(n => `${n}%`),
          center: manySlices ? ["36%", "50%"] : co.pieLegendPosition === "left" ? ["62%", "50%"] : co.pieLegendPosition === "right" ? ["40%", "50%"] : ["50%", "44%"],
          avoidLabelOverlap: true,
          percentPrecision: widget.options.percentDecimals ?? 1,
          label: { show: showPieLabels, color: muted, formatter: "{b}\n{d}%", ...PIE_LABEL.label },
          labelLine: PIE_LABEL.labelLine,
          labelLayout: PIE_LABEL.labelLayout,
          itemStyle: { borderColor: surface, borderWidth: 3, borderRadius: 4 },
          data: coloredPieData,
        }],
      }
    : {
        ...anim,
        color: palette,
        tooltip: {
          ...tip,
          // 趋势图默认一次看同一 x 的所有系列;改成 item 就只看当前那根。
          trigger: co.tooltip?.mode === "item" ? "item" : "axis",
          formatter: tooltipFormatter,
          axisPointer: {
            type: "cross",
            snap: false,
            lineStyle: { color: "transparent", width: 0, opacity: 0 },
            crossStyle: { color: "transparent", width: 0, opacity: 0 },
            label: { show: false },
          },
        },
        legend: series.length > 1 && widget.options.showLegend ? { show: true, top: 0, right: 8, textStyle: { color: muted }, itemWidth: 10, itemHeight: 6 } : undefined,
        grid: { left: 12, right: 16, top: series.length > 1 ? 34 : 18, bottom: (co.dataZoom || labels.length > 24) ? 34 : 8, containLabel: true },
        xAxis: horizontal ? valAxis : catAxis,
        yAxis: horizontal ? { ...catAxis, inverse: true } : dualAxis ? [valAxis, {
          ...valAxis, name: axisUnit(displaySecondary), min: undefined, max: undefined, position: "right",
          axisLabel: { color: muted, fontSize: 10, formatter: (v: number) => formatNumber(v, displaySecondary[0]?.decimals ?? 0, grouping) },
          splitLine: { show: false },
        }] : valAxis,
        dataZoom: (co.dataZoom || labels.length > 24) ? [{ type: "slider" as const, start: 0, end: labels.length > 24 ? Math.max(18, Math.round((24 / labels.length) * 100)) : 100, height: 12, bottom: 4, borderColor: "transparent", fillerColor: chrome.accentSoft, backgroundColor: chrome.surface2, showDetail: false, ...(horizontal ? { yAxisIndex: 0, width: 10, right: 2 } : { xAxisIndex: 0 }) }] : undefined,
        series,
      };
  // 点击行为:配了下钻维度且未到最深 → 下钻;否则回退到普通点击(联动全局筛选)。
  const drillConfigured = (drillDimensions?.length ?? 0) > 0;
  // 链里有几层就能钻几层(第 0 层是当前维度,不占链里的位置)。
  const canDrillDeeper = drillConfigured && (drillPath?.length ?? 0) < drillDimensions!.length;
  const onEvents = (onDrill || onDrillDown) ? {
    click: (params: { name?: string; dataIndex?: number }) => {
      if (metricComposition) return;
      if (widget.type === "pie" && params.dataIndex != null && pieData[params.dataIndex]?.isOther) return;
      if (params.name == null) return;
      if (drillConfigured) {
        if (canDrillDeeper) onDrillDown?.(params.name);
      } else if (widget.options.chart?.linkage) {
        /* 联动是可选的。默认点一下只在本组件里下钻(配了层级的话),没配就什么也不做 ——
           而不是把整张看板都筛掉:那样一点就全变,还得去顶上找那个小标签才能变回来。 */
        onDrill?.({ datasetId: widget.datasetId, field: xDimName, value: params.name });
      }
    },
  } : undefined;
  if (widget.type === "funnel" && !funnelData.length) {
    return <div className="dash-widget-state">这个范围里没有数据。</div>;
  }
  if (widget.type === "pie" && result.truncated) {
    return <div className="dash-widget-state">数据未完整返回，暂不能计算全部分组的占比。请缩小范围后重试。</div>;
  }
  if (widget.type === "pie" && !["sum", "count"].includes(activePieMetric.aggregation)) {
    return <div className="dash-widget-state">比率或均值不能组成整体，请改用条形图比较。</div>;
  }
  if (widget.type === "pie" && !pieData.length) {
    /* 说清是哪种情况:一行都没有,还是有数但全是 0 / 负数。原来这三种混成一句
       「数据含负值或没有可用总量」,看了也不知道该去查什么。 */
    const groups = metricComposition ? displayMetrics.length : groupedRows.size;
    return (
      <div className="dash-widget-state">
        {groups === 0
          ? "这个范围里没有数据。"
          : `${groups} 个分组的${metricLabel(activePieMetric)}都不是正数,饼图表达不了 —— 换条形图看。`}
      </div>
    );
  }
  const echart = <ReactECharts ref={chartRef} option={option} onEvents={onEvents} onChartReady={attachCrosshair} notMerge lazyUpdate style={{ width: "100%", height: "100%" }} />;
  const chart = pieDropped > 0
    ? (
      <div className="dash-pie-with-note">
        {echart}
        <span className="dash-pie-note" title="饼图表达不了负数,占比按剩下的分组算">
          {pieDropped} 个分组不是正数,没算进占比
        </span>
      </div>
    )
    : droppedBars.length > 0
      ? (
        <div className="dash-pie-with-note">
          {echart}
          <span className="dash-pie-note" title="它们在这根轴上不占像素,画出来也读不出数">
            未画出:{droppedBars.map((e) => `${e.label.replace(/\s*\(.*\)$/, "")} ${metricValue(e.metric, e.value)}`).join("、")}
          </span>
        </div>
      )
      : echart;

  // 切换器:显式 switch/group_switch 用组/指标选项;否则饼图多指标仍保留原有的指标下拉。
  const content = switching
    ? (
      <div className="dash-chart-with-switch">
        {chartOpt.metricSwitchTitle !== false && <span className="dash-kpi-switch-title">指标</span>}
        <select aria-label={t("dashboard.metricSwitch")} value={activeChoice!.id} onChange={(event) => onActiveMeasure(event.target.value)}>
          {choices.map((choice) => <option value={choice.id} key={choice.id}>{choice.label}</option>)}
        </select>
        {chart}
      </div>
    )
    : (widget.type === "pie" && resolvedMetrics.length >= 2 && !metricComposition)
      ? (
        <div className="dash-chart-with-switch">
          <select aria-label={t("dashboard.metricSwitch")} value={activePieMetric.key} onChange={(event) => onActiveMeasure(event.target.value)}>
            {resolvedMetrics.map((metric) => <option value={metric.key} key={metric.key}>{metricLabel(metric)}</option>)}
          </select>
          {chart}
        </div>
      )
      : chart;

  if (!drillPath?.length) return content;
  /* 面包屑:返回上一层 + 全部 › 各层选中值,点任意一层回到那一层。
     原来只有一排没有图标的小方块,钻进去之后第一反应是「怎么出去」—— 所以补一个
     明确的返回箭头,每一层也标上它是哪个维度(光一个「咖啡」看不出是按什么钻的)。 */
  const dimLabelOf = (name: string) => props.dimensionLabels?.[name] || name;
  return (
    <div className="dash-chart-drill">
      <div className="dash-drill-crumbs">
        <button className="back" title="返回上一层" onClick={() => onDrillTo?.(drillPath.length - 1)}>
          <ChevronLeft size={12} />返回
        </button>
        <button onClick={() => onDrillTo?.(0)}>全部</button>
        {drillPath.map((item, index) => (
          <span key={`${item.dimension}-${index}`}>
            <span className="sep">›</span>
            <button onClick={() => onDrillTo?.(index + 1)} title={`${dimLabelOf(item.dimension)}:${item.value}`}>
              <small>{dimLabelOf(item.dimension)}</small>{item.value}
            </button>
          </span>
        ))}
      </div>
      <div className="dash-drill-body">{content}</div>
    </div>
  );
}
