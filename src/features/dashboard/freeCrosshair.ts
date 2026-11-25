/* 实现在 freeCrosshair.runtime.js,在线看板与导出离线 HTML 共用同一份源码。 */
import * as echarts from "echarts";
import "./freeCrosshair.runtime.js";

export interface FreeCrosshairOptions {
  horizontalValueAxis: boolean;
  formatValue?: (value: number) => string;
  lineColor: string;
  labelColor: string;
  labelBackground: string;
  labelBorder: string;
}

interface CrosshairApi {
  installFreeCrosshair(
    echartsLib: typeof echarts,
    chart: echarts.ECharts,
    options: FreeCrosshairOptions,
  ): () => void;
}

const api = () => (globalThis as unknown as { __DASH_CROSSHAIR__: CrosshairApi }).__DASH_CROSSHAIR__;

/** V1-style free crosshair. Rendered on zrender so guides follow the raw pointer
 *  instead of snapping to category ticks like ECharts axisPointer. */
export function installFreeCrosshair(chart: echarts.ECharts, options: FreeCrosshairOptions): () => void {
  return api().installFreeCrosshair(echarts, chart, options);
}
