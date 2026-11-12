/* 实现是 drillView.runtime.js。看板和测试共用这一份。 */
import "./drillView.runtime.js";

export interface DrillStep { dimension: string; value: string }
export interface DrillFetch { id: string; groupBy: string; level: number }

interface DrillApi {
  drillDimensionsOf(widget: { type?: string; options?: { chart?: { drillDimensions?: string[] } } }): string[];
  nextShownPath(prev: DrillStep[], requested: DrillStep[], columnNames: string[], drillDims: string[], bound: string): DrillStep[];
  widgetsToFetch(widgets: { id: string; type?: string; options?: { chart?: { drillDimensions?: string[] } } }[], paths: Record<string, DrillStep[]>, owned: Record<string, boolean>): DrillFetch[];
  retainDrillMap<T>(current: Record<string, T>, ids: string[]): Record<string, T>;
  paintChanged(prev: unknown[] | null, next: unknown[]): boolean;
}

const api = () => (globalThis as unknown as { __DASH_DRILL__: DrillApi }).__DASH_DRILL__;

export const drillDimensionsOf = (widget: { type?: string; options?: { chart?: { drillDimensions?: string[] } } }) => api().drillDimensionsOf(widget);
export const nextShownPath = (prev: DrillStep[], requested: DrillStep[], columnNames: string[], drillDims: string[], bound: string) =>
  api().nextShownPath(prev, requested, columnNames, drillDims, bound);
export const widgetsToFetch = (widgets: { id: string; type?: string; options?: { chart?: { drillDimensions?: string[] } } }[], paths: Record<string, DrillStep[]>, owned: Record<string, boolean>) =>
  api().widgetsToFetch(widgets, paths, owned);
export const retainDrillMap = <T,>(current: Record<string, T>, ids: string[]) => api().retainDrillMap(current, ids);
export const paintChanged = (prev: unknown[] | null, next: unknown[]) => api().paintChanged(prev, next);
