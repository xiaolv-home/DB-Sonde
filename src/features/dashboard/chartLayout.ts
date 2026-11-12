/* 实现是 chartLayout.runtime.js —— 写成普通脚本是为了能原样内联进导出的离线网页。
   看板这边 import 它拿副作用，再套一层类型。一份实现，两处用。 */
import "./pieGeometry.runtime.js";
import "./chartLayout.runtime.js";

export interface PieFrameSpec {
  width: number;
  height: number;
  hole?: number;
  outer?: number;
  showLabels?: boolean;
  showLegend?: boolean;
  legendPosition?: "left" | "right" | "bottom";
  manySlices?: boolean;
}

export interface PieFrame {
  mode: "legacy" | "framed";
  radius: [number | string, number | string];
  center: [number | string, number | string];
  label: Record<string, unknown>;
  labelLine: Record<string, unknown>;
  labelLayout: Record<string, unknown>;
  legend: Record<string, unknown>;
}

export interface GridPad { left: number; right: number; top: number; bottom: number }

export interface GridFrame extends GridPad {
  containLabel: true;
  plotWidth: number;
  plotHeight: number;
}

export interface FlowFrame {
  maxWidth: number | null;
  maxHeight: number | null;
  centerX: boolean;
  centerY: boolean;
}

interface LayoutApi {
  MAX_PIE_RADIUS: number;
  MAX_PLOT_W: number;
  MAX_PLOT_H: number;
  MAX_RADAR: number;
  MAX_TREE: number;
  pieFrame(spec: PieFrameSpec): PieFrame;
  cartesianGrid(spec: GridPad & { width?: number; height?: number; maxWidth?: number; maxHeight?: number }): GridFrame;
  cartesianLegend(grid: GridPad, pad: GridPad): { top: number; right: number };
  plotStick(grid: GridPad, pad: GridPad, edge: "bottom" | "right", fallback: number, gap: number): number;
  placeZoom(grid: GridPad, pad: GridPad, axis: "x" | "y"): { right?: number; bottom?: number };
  axisFont(span: number): number;
  categoryAxis(spec: { span: number; count: number }): { interval: number; hideOverlap: boolean; fontSize: number };
  barThickness(span: number, count: number): number;
  radarFrame(spec: { width: number; height: number; hasLegend?: boolean }): {
    radius: number | string;
    center: [number | string, number | string];
    legendTop: number;
    fontSize?: number;
  };
  treemapFrame(spec: { width: number; height: number; breadcrumb?: boolean }): {
    left: number; top: number; right: number; bottom: number; breadcrumbBottom: number;
  };
  flowFrame(spec: { kind: "kpi" | "ranking"; width: number; height: number; count: number }): FlowFrame;
}

const api = () => (globalThis as unknown as { __DASH_LAYOUT__: LayoutApi }).__DASH_LAYOUT__;

export const pieFrame = (spec: PieFrameSpec) => api().pieFrame(spec);
export const cartesianGrid = (spec: GridPad & { width?: number; height?: number }) => api().cartesianGrid(spec);
export const cartesianLegend = (grid: GridPad, pad: GridPad) => api().cartesianLegend(grid, pad);
export const plotStick = (grid: GridPad, pad: GridPad, edge: "bottom" | "right", fallback: number, gap: number) =>
  api().plotStick(grid, pad, edge, fallback, gap);
export const placeZoom = (grid: GridPad, pad: GridPad, axis: "x" | "y") => api().placeZoom(grid, pad, axis);
export const axisFont = (span: number) => api().axisFont(span);
export const categoryAxis = (spec: { span: number; count: number }) => api().categoryAxis(spec);
export const barThickness = (span: number, count: number) => api().barThickness(span, count);
export const radarFrame = (spec: { width: number; height: number; hasLegend?: boolean }) => api().radarFrame(spec);
export const treemapFrame = (spec: { width: number; height: number; breadcrumb?: boolean }) => api().treemapFrame(spec);
export const flowFrame = (spec: { kind: "kpi" | "ranking"; width: number; height: number; count: number }) => api().flowFrame(spec);
