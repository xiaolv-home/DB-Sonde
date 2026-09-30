import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { fitToViewport, type Placement } from "../lib/fitToViewport";

/**
 * 给右键菜单 / 浮层用:画出来之后量真实尺寸,摆到整块都看得见的位置。
 * 规则见 lib/fitToViewport。
 *
 * - 在 layout 阶段量和摆,首帧就是对的位置,不会先在错的地方闪一下;
 * - 窗口缩放时重摆;
 * - 内容尺寸变了也重摆(表头菜单的「剪贴板」那组是打开后异步读的,
 *   读到之后菜单变高,不重摆的话又会顶出屏幕)。
 *
 * anchor 为 null 表示菜单没开。
 */
export function useViewportFit<T extends HTMLElement = HTMLDivElement>(
  anchor: { x: number; y: number } | null,
  { margin = 8, mode = "flip" }: { margin?: number; mode?: "flip" | "clamp" } = {},
) {
  const ref = useRef<T>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const ax = anchor?.x;
  const ay = anchor?.y;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || ax === undefined || ay === undefined) {
      setPlacement(null);
      return;
    }
    const place = () => {
      // scrollHeight 是内容的完整高度,限高之后也不变;再加上边框。
      const border = el.offsetHeight - el.clientHeight;
      const next = fitToViewport(
        { x: ax, y: ay },
        { width: el.offsetWidth, height: el.scrollHeight + border },
        { width: window.innerWidth, height: window.innerHeight },
        margin,
        mode,
      );
      setPlacement((prev) =>
        prev && prev.left === next.left && prev.top === next.top && prev.maxHeight === next.maxHeight ? prev : next,
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [ax, ay, margin, mode]);

  const style: CSSProperties = placement
    ? {
        left: placement.left,
        top: placement.top,
        ...(placement.maxHeight !== undefined ? { maxHeight: placement.maxHeight, overflowY: "auto" } : {}),
      }
    : { left: ax ?? 0, top: ay ?? 0, visibility: "hidden" };
  return { ref, style };
}
