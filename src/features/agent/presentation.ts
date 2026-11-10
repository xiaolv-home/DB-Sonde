import { repairGeneratedStyle } from "../dashboard/generatedAppearance";
import { repairLayout, type LayoutItem, type LayoutPlan } from "./layout";

export const ANALYSIS_PALETTE = ["#5797DD", "#55B5A6", "#9B8ED3", "#D7AE67", "#CB8198", "#8C99A8"];
export interface PresentationMetric { metricId: string; name: string; unit?: string; rollup: string; supportedDimensions?: string[] }

/** Keep the designer's selection and composition. Repair only layout errors and fill style defaults. */
export function refineAnalysisLayout(layout: LayoutPlan, metrics: PresentationMetric[]): LayoutPlan {
  const byId = new Map(metrics.map((m) => [m.metricId, m]));
  const normalized = layout.items.map((item) => {
    const selected = item.metricIds.map((id) => byId.get(id));
    const dimensions = item.dimensions.filter((dim) => selected.every((m) => !m?.supportedDimensions || m.supportedDimensions.includes(dim)));
    return { ...item, dimensions };
  });
  const items = normalized.map((original): LayoutItem => {
    /* 用什么图是设计 AI 的决定,这里不再替它换(以前会把饼图换成柱状、折线换成柱状)。
       这一步只补默认样式、修排版硬错。 */
    const item = original;
    return repairGeneratedStyle({ ...item,
      tabs: item.tabs?.map((tab) => ({ ...tab, items: refineAnalysisLayout({ ...layout, items: tab.items }, metrics).items })),
      appearance: { radius: 10, titleSize: 14, ...item.appearance,
        visualPreset: item.appearance?.visualPreset ?? (layout.preset ?? "editorial") },
      text: item.type === "text" ? { ...item.text, fontSize: item.text?.fontSize ?? 15, color: item.text?.color ?? "var(--text)" } : item.text,
      chart: { ...item.chart,
        palette: item.chart?.palette ?? layout.palette ?? ANALYSIS_PALETTE,
        lineArea: item.chart?.lineArea ?? false,
        ...(item.type === "pie" ? { pieHole: item.chart?.pieHole ?? 42, pieOuterRadius: item.chart?.pieOuterRadius ?? 75, pieIncludeOthers: true, pieShowLabels: item.chart?.pieShowLabels ?? true } : {}),
      },
      topN: item.topN ?? 0,
    });
  });
  return { ...layout, preset: layout.preset ?? "editorial", palette: layout.palette ?? ANALYSIS_PALETTE, items: repairLayout(items) };
}
