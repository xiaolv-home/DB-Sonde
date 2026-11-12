/* 实现是 moreCharts.runtime.js —— 写成普通脚本是为了能原样内联进导出的离线网页。
   看板这边 import 它拿副作用,再套一层类型。一份实现,两处用。 */
import "./tooltipText.runtime.js";
import "./moreCharts.runtime.js";
import type { Cell } from "../../types";

export interface MoreChartInput {
  rows: Cell[][];
  dims: number[];
  series: number;
  measures: { name: string }[];
  agg: (rows: Cell[][], index: number) => number;
  fmt: (index: number, value: number) => string;
  palette: string[];
  colorOf?: (name: string) => string | undefined;
  theme: { muted: string; border: string; surface: string; text: string; accent: string };
  opts: Record<string, unknown> & { topN: number; showLegend?: boolean; percentDecimals?: number };
  animation?: boolean;
}

export interface RankingItem { rank: number; name: string; text: string; ratio: number; extra: string }

type OptionOrEmpty = Record<string, unknown> & { empty?: string };

interface MoreApi {
  scatter(input: MoreChartInput): OptionOrEmpty;
  radar(input: MoreChartInput): OptionOrEmpty;
  heatmap(input: MoreChartInput): OptionOrEmpty;
  treemap(input: MoreChartInput): OptionOrEmpty;
  waterfall(input: MoreChartInput): OptionOrEmpty;
  ranking(input: MoreChartInput): { empty?: string; items?: RankingItem[] };
}

export const moreCharts = () => (globalThis as unknown as { __DASH_MORE__: MoreApi }).__DASH_MORE__;

/** 用 echarts 画的那几种(排行榜是 HTML 列表)。 */
export const MORE_ECHART_TYPES = ["scatter", "radar", "heatmap", "treemap", "waterfall"] as const;
export type MoreEchartType = (typeof MORE_ECHART_TYPES)[number];
