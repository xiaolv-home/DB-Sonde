import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useI18n } from "../../../hooks/useI18n";
import type { DashboardDrillFilter, DashboardMetricDefinition, DashboardRuntimeData, DashboardWidget } from "../domain";
import { resolveMetricIds, resolveWidgetMetrics } from "../metrics";
import TextWidget from "../widgets/TextWidget";
import ImageWidget from "../widgets/ImageWidget";
import GaugeWidget from "../widgets/GaugeWidget";
import MoreChartWidget from "../widgets/MoreChartWidget";
import RankingWidget from "../widgets/RankingWidget";
import { MORE_ECHART_TYPES, type MoreEchartType } from "../moreCharts";
import KpiWidget from "../widgets/KpiWidget";
import TableWidget from "../widgets/TableWidget";
import ChartWidget from "../widgets/ChartWidget";

interface Props {
  staticRender?: boolean;
  widget: DashboardWidget;
  runtime?: DashboardRuntimeData;
  metrics: DashboardMetricDefinition[];
  /** 维度字段 → 中文名(来自数据集),表格列头用它替代英文字段名。 */
  dimensionLabels?: Record<string, string>;
  onDrill?: (filter: DashboardDrillFilter) => void;
  drillPath?: { dimension: string; value: string }[];
  onDrillDown?: (value: string) => void;
  onDrillTo?: (level: number) => void;
}

/**
 * 组件渲染分发器:只负责运行时状态(加载/报错/空)与指标解析,
 * 再按 widget.type 交给对应的 widget 组件渲染。具体渲染逻辑见 ../widgets/*。
 */
export default function WidgetRenderer({ staticRender, widget, runtime, metrics, dimensionLabels, onDrill, drillPath, onDrillDown, onDrillTo }: Props) {
  const { t } = useI18n();
  const metricKeys = widget.bindings.metricIds.length ? widget.bindings.metricIds : widget.bindings.measures.map((name) => `field:${name}`);
  // 分组切换时,切换器的可选 id 是"组 id"而非指标 id —— 校验集合要用组 id(KPI 与图表通用),
  // 否则下面的重置逻辑会把选中的组 id 当成失效指标清掉。
  const groupSwitch = widget.type === "kpi"
    ? (widget.options.kpi?.displayMode === "group_switch" ? widget.options.kpi.metricGroups : undefined)
    : (widget.options.chart?.displayMode === "group_switch" ? widget.options.chart.metricGroups : undefined);
  const validMeasureKeys = groupSwitch?.length ? groupSwitch.map((g) => g.id) : metricKeys;
  // 初始/兜底选中项:优先用户配置的"默认显示"(metricSwitchDefault),否则第一个。
  const switchDefault = widget.type === "kpi" ? widget.options.kpi?.metricSwitchDefault : widget.options.chart?.metricSwitchDefault;
  const defaultMeasure = (switchDefault && validMeasureKeys.includes(switchDefault)) ? switchDefault : (validMeasureKeys[0] ?? "");
  const [activeMeasure, setActiveMeasure] = useState(defaultMeasure);
  // 默认项变化(作者改了"默认显示",或指标集变化)→ 跟随默认。手动切换不改 defaultMeasure,故不受影响。
  useEffect(() => { setActiveMeasure(defaultMeasure); }, [defaultMeasure]);
  // 兜底:当前选中项失效(指标被删等)时回落到默认。
  useEffect(() => {
    if (!validMeasureKeys.includes(activeMeasure)) setActiveMeasure(defaultMeasure);
  }, [activeMeasure, validMeasureKeys, defaultMeasure]);

  /* 这两个数组是表格列清单的输入,每次渲染都新建的话,表格里那些 useMemo 一次也命中不了
     —— 五百行上百列会跟着每一次无关的重渲染重算一遍。
     必须放在所有提前 return 之前:hooks 的调用顺序每次渲染都得一样,放后面的话
     文本组件那一支少调两个 hook,React 直接报「Rendered more hooks than during the
     previous render」整块白屏。 */
  const columns = runtime?.result?.columns;
  const resolvedMetrics = useMemo(
    () => (columns ? resolveWidgetMetrics(widget, metrics, columns, dimensionLabels) : []),
    [widget, metrics, columns, dimensionLabels],
  );
  const secondaryMetrics = useMemo(
    () => (columns
      ? resolveMetricIds(widget, widget.bindings.secondaryMetricIds, metrics, columns)
        .filter((metric) => !resolvedMetrics.some((primary) => primary.key === metric.key))
      : []),
    [widget, metrics, columns, resolvedMetrics],
  );

  // 文本组件不取数,先行返回。
  if (widget.type === "text") return <TextWidget widget={widget} />;
  if (widget.type === "image") return <ImageWidget widget={widget} />;

  const loadingLayer = <div className="dash-widget-loading" role="status" aria-live="polite"><Loader2 size={19} className="spin" /><span>{t("dashboard.loadingData")}</span><i /><i /><i /></div>;
  const withLoading = (content: ReactNode) => <div className="dash-widget-runtime">{content}{runtime?.loading ? loadingLayer : null}</div>;
  if (runtime?.loading && !runtime.result) return loadingLayer;
  if (runtime?.error) {
    const friendly = /no active connection/i.test(runtime.error)
      ? "数据来源连接未连接 —— 请先在左侧「连接」面板连上该数据集绑定的数据库,看板才能取数。"
      : runtime.error;
    return <div className="dash-widget-state error"><AlertTriangle size={15} />{friendly}</div>;
  }
  const result = runtime?.result;
  if (!result || result.columns.length === 0) {
    return <div className="dash-widget-state">{t("dashboard.runAndBind")}</div>;
  }

  // 下钻生效时,当前层级的维度 = drillDimensions[已钻层数];否则用绑定维度。
  const drillDims = widget.options.chart?.drillDimensions;
  const drillLevel = drillPath?.length ?? 0;
  /* 下钻链是「从当前维度再往下钻到哪几层」,不包含当前这层。
     原来把链的第一项当成当前分组维度,于是要求它必须等于组件绑的那个维度 —— 可界面
     让你随便选。选了别的(比如图按大区分组、链却从主管开始),渲染层就去结果里找一个
     查询压根没分组的列,饼图直接报「没有可用总量」,而且是一进来就报,还没点过。 */
  const effectiveDrillDim = drillLevel > 0 ? drillDims?.[drillLevel - 1] : undefined;
  const dimensionName = effectiveDrillDim ?? widget.bindings.dimensions?.[0] ?? widget.bindings.dimension ?? result.columns[0]?.name;
  const dimensionIndex = result.columns.findIndex((column) => column.name === dimensionName);
  if (widget.type === "kpi") {
    return withLoading(
      <KpiWidget
        widget={widget}
        rows={result.rows}
        resolvedMetrics={resolvedMetrics}
        secondaryMetrics={secondaryMetrics}
        comparison={runtime?.comparison}
        activeMeasure={activeMeasure}
        onActiveMeasure={setActiveMeasure}
      />,
    );
  }

  if (widget.type === "gauge") {
    return withLoading(<GaugeWidget widget={widget} rows={result.rows} metric={resolvedMetrics[0]} staticRender={staticRender} />);
  }

  if (widget.type === "ranking") {
    return withLoading(<RankingWidget widget={widget} result={result} metrics={resolvedMetrics} />);
  }
  if ((MORE_ECHART_TYPES as readonly string[]).includes(widget.type)) {
    return withLoading(<MoreChartWidget widget={widget as DashboardWidget & { type: MoreEchartType }} result={result} metrics={resolvedMetrics} staticRender={staticRender} />);
  }

  if (widget.type === "table") {
    return withLoading(
      <TableWidget
        widget={widget}
        result={result}
        resolvedMetrics={resolvedMetrics}
        secondaryMetrics={secondaryMetrics}
        dimensionLabels={dimensionLabels}
        onDrill={onDrill}
      />,
    );
  }

  return withLoading(
    <ChartWidget
      staticRender={staticRender}
      widget={widget}
      result={result}
      resolvedMetrics={resolvedMetrics}
      secondaryMetrics={secondaryMetrics}
      dimensionName={dimensionName}
      dimensionIndex={dimensionIndex}
      activeMeasure={activeMeasure}
      onActiveMeasure={setActiveMeasure}
      onDrill={onDrill}
      drillDimensions={drillDims}
      drillPath={drillPath}
      dimensionLabels={dimensionLabels}
      onDrillDown={onDrillDown}
      onDrillTo={onDrillTo}
    />,
  );
}
