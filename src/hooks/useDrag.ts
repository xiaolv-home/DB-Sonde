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

/**
 * 浮在容器角上的小条(比如结果区右下角的求和条)拖到别处,免得挡住数据。
 * 位置按「离容器右边、下边多远」存,本机记住(localStorage 读写失败就用默认);双击把手回到默认。
 * 渲染时用 CSS min() 夹在容器里,容器变小了也不会跑出去。
 */
export function useFloatingCorner(storageKey: string, defaults: { right: number; bottom: number }) {
  const [pos, setPos] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      if (saved && Number.isFinite(saved.right) && Number.isFinite(saved.bottom)) return saved as typeof defaults;
    } catch { /* 读不到就用默认 */ }
    return defaults;
  });
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const panel = e.currentTarget.parentElement;
    const box = panel?.offsetParent?.getBoundingClientRect();
    if (!panel || !box) return;
    const { width, height } = panel.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, ...pos };
    let latest = pos;
    const clamp = (v: number, max: number) => Math.max(4, Math.min(v, max));
    const onMove = (ev: PointerEvent) => {
      latest = {
        right: clamp(start.right - (ev.clientX - start.x), box.width - width - 4),
        bottom: clamp(start.bottom - (ev.clientY - start.y), box.height - height - 4),
      };
      setPos(latest);
    };
    const up = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", up);
      try { localStorage.setItem(storageKey, JSON.stringify(latest)); } catch { /* 记不住就算了 */ }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", up);
  }, [pos, storageKey]);
  const reset = useCallback(() => {
    setPos(defaults);
    try { localStorage.removeItem(storageKey); } catch { /* 无所谓 */ }
  }, [defaults, storageKey]);
  const style = { right: `min(${pos.right}px, calc(100% - 120px))`, bottom: `min(${pos.bottom}px, calc(100% - 40px))` };
  return { style, handleProps: { onPointerDown, onDoubleClick: reset } };
}
