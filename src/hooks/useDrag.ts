import { useCallback, useState } from "react";

/**
 * 分隔条拖动。
 *
 * 按下时 `start()` 读一次**当前**尺寸,之后每次移动都用「起点尺寸 + 从按下到现在的总位移」
 * 算新尺寸,交给 `move(startValue, delta)`。
 *
 * 以前是每次移动只给「这一下挪了几像素」,由调用方拿渲染时的高度去减 ——
 * 可回调在按下那一刻就定死了,里面的高度一直是按下时的值,于是每次都是
 * 「起点 − 最近几像素」,结果区只在原地抖,拖不动。现在起点和总位移都由这里管,
 * 调用方拿不到过期的值。
 */
export function useDrag(
  axis: "x" | "y",
  { start, move }: { start: () => number; move: (startValue: number, delta: number) => void },
) {
  const [active, setActive] = useState(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const origin = axis === "x" ? e.clientX : e.clientY;
      const startValue = start();
      setActive(true);

      const onMove = (ev: PointerEvent) => {
        move(startValue, (axis === "x" ? ev.clientX : ev.clientY) - origin);
      };
      const up = () => {
        setActive(false);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    },
    [axis, start, move],
  );

  return { active, onPointerDown };
}
