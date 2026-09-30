/* 可拖动分区的最小高度。保存和读取必须用同一个下限 ——
 * 以前拖动时允许拖到 120,启动读取却要求 ≥140,拖到 120~139 之间存下的值
 * 下次启动就被当成「无法读取的配置」弹提示。 */
export const RESULT_MIN_HEIGHT = 120;
export const PY_OUTPUT_MIN_HEIGHT = 80;

/** 夹到 [min, 窗口高 - 160] 之间;窗口高未知时只管下限。 */
export function clampPaneHeight(h: number, min: number): number {
  const viewport = typeof window === "undefined" ? 0 : window.innerHeight;
  const max = viewport ? Math.max(min, viewport - 160) : Infinity;
  return Math.round(Math.min(max, Math.max(min, h)));
}

/** 读取时:是有限数且不低于下限就认。 */
export const acceptsPaneHeight = (min: number) => (value: string) =>
  value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= min;
