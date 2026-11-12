import { appearanceBackground, readableColor } from "../cardReadability";
import { useI18n } from "../../../hooks/useI18n";
import type { Cell, QueryResult } from "../../../types";
import type { DashboardWidget } from "../domain";
import type { ResolvedDashboardMetric } from "../metrics";
import { aggregate, buildMetricChoices, scaledText } from "./metricUtils";

interface Props {
  widget: DashboardWidget;
  rows: Cell[][];
  resolvedMetrics: ResolvedDashboardMetric[];
  secondaryMetrics: ResolvedDashboardMetric[];
  comparison?: { period?: QueryResult; year?: QueryResult };
  activeMeasure: string;
  onActiveMeasure: (key: string) => void;
}

/** 同比/环比徽标文案(对齐 v1):`环比 ↑ 12.3%` / 缺失时 `环比 --`。 */
function comparisonText(value: number | null, label: string, decimals: number): string {
  if (value == null) return `${label} --`;
  return `${label} ${value >= 0 ? "↑" : "↓"} ${Math.abs(value).toFixed(decimals)}%`;
}

/** 指标卡:一个或多个大数字 + 可选副指标 + 可选同环比;支持"切换"模式在多指标间轮换。 */
export default function KpiWidget({ widget, rows, resolvedMetrics, secondaryMetrics, comparison, activeMeasure, onActiveMeasure }: Props) {
  const { t } = useI18n();
  const ko = widget.options.kpi ?? {};
  const selected = resolvedMetrics.slice(0, 6);
  if (selected.length === 0) return <div className="dash-widget-state">{t("dashboard.chooseDimensionMeasure")}</div>;

  const align = ko.contentAlign ?? "left";
  // 字号:用户显式设了就用固定值;未设则留空,交给 CSS 的响应式 clamp(随卡宽自适应,窄卡不截断)。
  const valueStyle = { color: readableColor(ko.valueColor, appearanceBackground(widget.options.appearance)) || undefined, fontSize: ko.valueSize };
  const labelStyle = { fontSize: ko.labelSize ?? 12 };

  // 涨跌% = (当前 - 对比期) / 对比期 × 100;对比期缺失/为 0、或指标不随日期变化时返回 null(显示 --)。
  const changePct = (metric: ResolvedDashboardMetric, past?: QueryResult): number | null => {
    if (!past || metric.dateScoped === false) return null;
    const prev = aggregate(past.rows, metric);
    if (prev === 0) return null;
    return ((aggregate(rows, metric) - prev) / prev) * 100;
  };

  const card = (metric: ResolvedDashboardMetric) => {
    const label = <span className="dash-kpi-label" style={labelStyle}>{metric.name}</span>;
    /* KPI 是最该做单位换算的地方 —— 一个卡片里摊开八位数根本读不出量级。
       单位也必须带上:原来这里把 unit 写死成空串,于是复购率显示成「26.22」、
       会员消费占比显示成「0.34」。值是对的,可没有那个 % 就没法读 ——
       0.34 到底是 0.34% 还是 34%?用户看一眼就说「数不对」,而问题在显示层。 */
    const value = scaledText(aggregate(rows, metric), metric.decimals, metric.unit, widget.options.numberFormat);
    const period = changePct(metric, comparison?.period);
    const year = changePct(metric, comparison?.year);
    return (
      <div
        className="dash-kpi"
        style={{ textAlign: align, alignItems: align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start" }}
        key={metric.key}
      >
        {ko.labelPosition === "above" && label}
        <strong style={valueStyle} title={value}>{value}</strong>
        {ko.labelPosition !== "above" && label}
        {ko.showComparison && (
          <div className={`dash-kpi-compare layout-${ko.comparisonLayout ?? "inline"}`} style={{ fontSize: ko.comparisonFontSize ?? 11 }}>
            <small className={(period ?? 0) >= 0 ? "up" : ""}>{comparisonText(period, "环比", widget.options.percentDecimals ?? 1)}</small>
            <small className={(year ?? 0) >= 0 ? "up" : ""}>{comparisonText(year, "同比", widget.options.percentDecimals ?? 1)}</small>
          </div>
        )}
        {ko.showSecondary && secondaryMetrics.length > 0 && (
          <div className="dash-kpi-secondary" style={{ fontSize: ko.secondarySize ?? 13 }}>
            {secondaryMetrics.map((sm) => <span key={sm.key}>{sm.name} <b>{scaledText(aggregate(rows, sm), sm.decimals, sm.unit, widget.options.numberFormat)}</b></span>)}
          </div>
        )}
      </div>
    );
  };

  // 切换器选项:group_switch=每个"指标组"一项;switch=每个指标一项。
  const choices = buildMetricChoices(ko.displayMode, ko.metricGroups, selected, t("dashboard.metricSwitch"))
    .map((choice) => ko.displayMode === "group_switch" ? choice : { ...choice, label: choice.metrics[0]?.name ?? choice.label });

  const grid = (metrics: ResolvedDashboardMetric[]) => (
    <div className={`dash-kpi-grid count-${Math.min(metrics.length, 6)}`}>{metrics.map(card)}</div>
  );

  if ((ko.displayMode === "switch" || ko.displayMode === "group_switch") && choices.length > 1) {
    const active = choices.find((c) => c.id === activeMeasure)
      ?? choices.find((c) => c.id === ko.metricSwitchDefault)
      ?? choices[0];
    return (
      <div className="dash-kpi-switch">
        <div className="dash-kpi-switch-bar">
          {ko.metricSwitchTitle !== false && <span className="dash-kpi-switch-title">指标</span>}
          <select aria-label={t("dashboard.metricSwitch")} value={active.id} onChange={(e) => onActiveMeasure(e.target.value)}>
            {choices.map((c) => <option value={c.id} key={c.id}>{c.label}</option>)}
          </select>
        </div>
        {grid(active.metrics)}
      </div>
    );
  }
  return grid(selected);
}
