import { useLayoutEffect, useRef, useState } from "react";
import { paintChanged } from "./drillView";

export interface ChartBox { width: number; height: number }

/**
 * 量图表容器的宽高。用回调 ref，是因为图表经常在「还没选维度」的空状态之后才挂上，
 * 空依赖的 effect 会在那之前就跑完，之后再也量不到。
 * 用 useLayoutEffect 而不是画完再量:下钻后面包屑一出现高度就变,若等绘制之后
 * 才 setState,ECharts 会先按旧尺寸 setOption,再按新尺寸来一遍,画面闪一下。
 * 提交阶段量完再画,屏幕上只有一帧。
 * 按 4px 取整，拖卡片边的时候不至于每个像素都重算一遍 option。
 */
export function useChartBox<T extends HTMLElement = HTMLDivElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [box, setBox] = useState<ChartBox>({ width: 0, height: 0 });
  useLayoutEffect(() => {
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

/**
 * 绘制输入没变就别 setOption。父组件每次下钻都会重渲染,option 里的 formatter
 * 又是新函数,echarts-for-react 会当成整张图都变了,notMerge 把实例重画一遍。
 */
export function usePaintGate(parts: unknown[]) {
  const ref = useRef<unknown[] | null>(null);
  if (ref.current === null) ref.current = parts;
  return () => {
    if (!paintChanged(ref.current, parts)) return false;
    ref.current = parts;
    return true;
  };
}
