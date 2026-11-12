import { useEffect, useState } from "react";

export interface ChartBox { width: number; height: number }

/**
 * 量图表容器的宽高。用回调 ref，是因为图表经常在「还没选维度」的空状态之后才挂上，
 * 空依赖的 effect 会在那之前就跑完，之后再也量不到。
 * 按 4px 取整，拖卡片边的时候不至于每个像素都重算一遍 option。
 */
export function useChartBox<T extends HTMLElement = HTMLDivElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [box, setBox] = useState<ChartBox>({ width: 0, height: 0 });
  useEffect(() => {
    if (!el) return;
    const read = () => {
      const width = Math.round(el.clientWidth / 4) * 4;
      const height = Math.round(el.clientHeight / 4) * 4;
      setBox((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return { ref: setEl, box };
}
