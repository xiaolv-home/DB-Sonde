/* 核心换算与聚合实现在 metricMath.runtime.js,与离线看板导出页共用同一份源码,避免双轨走散。 */
import "../metricMath.runtime.js";
import type { Cell } from "../../../types";
import type { ResolvedDashboardMetric } from "../metrics";
import type { DashboardNumberFormat } from "../domain";

export interface MetricChoice {
  id: string;
  label: string;
  metrics: ResolvedDashboardMetric[];
}

interface MetricMathApi {
  numberValue(value: unknown): number;
  formatNumber(value: number, decimals: number, grouping?: boolean): string;
  scaleFor(value: number, scale: DashboardNumberFormat["scale"]): "none" | "wan" | "yi";
  scaledText(
    value: number,
    decimals: number,
    unit: string,
    fmt?: DashboardNumberFormat,
    grouping?: boolean,
  ): string;
  metricLabel(metric: ResolvedDashboardMetric): string;
  metricValue(metric: ResolvedDashboardMetric, value: number, fmt?: DashboardNumberFormat): string;
  aggregateColumn(rows: Cell[][], colIndex: number, aggregation: string): number;
  axisUnit(metrics: ResolvedDashboardMetric[]): string;
  buildMetricChoices(
    displayMode: string | undefined,
    metricGroups: { id: string; label: string; metricIds: string[] }[] | undefined,
    metrics: ResolvedDashboardMetric[],
    groupFallbackLabel: string,
  ): MetricChoice[];
}

const math = () => (globalThis as unknown as { __DASH_MATH__: MetricMathApi }).__DASH_MATH__;

export const numberValue = (value: Cell): number => math().numberValue(value);

export const formatNumber = (value: number, decimals: number, grouping = false): string =>
  math().formatNumber(value, decimals, grouping);

export const scaleFor = (
  value: number,
  scale: DashboardNumberFormat["scale"],
): "none" | "wan" | "yi" => math().scaleFor(value, scale);

export const scaledText = (
  value: number,
  decimals: number,
  unit: string,
  fmt?: DashboardNumberFormat,
  grouping = false,
): string => math().scaledText(value, decimals, unit, fmt, grouping);

export const metricLabel = (metric: ResolvedDashboardMetric): string =>
  math().metricLabel(metric);

export const metricValue = (
  metric: ResolvedDashboardMetric,
  value: number,
  fmt?: DashboardNumberFormat,
): string => math().metricValue(metric, value, fmt);

export const aggregate = (rows: Cell[][], metric: ResolvedDashboardMetric): number =>
  math().aggregateColumn(rows, metric.columnIndex, metric.aggregation);

export const axisUnit = (metrics: ResolvedDashboardMetric[]): string =>
  math().axisUnit(metrics);

export const buildMetricChoices = (
  displayMode: string | undefined,
  metricGroups: { id: string; label: string; metricIds: string[] }[] | undefined,
  metrics: ResolvedDashboardMetric[],
  groupFallbackLabel: string,
): MetricChoice[] => math().buildMetricChoices(displayMode, metricGroups, metrics, groupFallbackLabel);
