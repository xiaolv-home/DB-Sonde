import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/**
 * 一排可切换项背后那块跟着走的玻璃胶囊。
 *
 * 行为:鼠标在这一排上时,胶囊跟到指着的那项;鼠标移开,它回到当前选中的那项。
 * 点了哪项,"选中"就换到哪项,胶囊也就固定到那儿。
 *
 * 用法:容器上摊开 trackProps,每一项加 data-pill="<唯一键>",
 * 再在容器里放一个 <span {...pillProps} />(它 pointer-events:none,不挡点击):
 *
 *     const { trackProps, pillProps } = useGlassPill(activeId);
 *     <div className="tabbar-track" {...trackProps}>
 *       <span {...pillProps} />
 *       {tabs.map(t => <div key={t.id} data-pill={t.id}>…</div>)}
 *     </div>
 *
 * **为什么不在 pointermove 里算几何**:那是每秒上百次的回调,一排标签多起来
 * 就开始掉帧,而掉帧恰恰发生在鼠标划过的时候 —— 最容易被看见。
 * 这儿只做一次 closest() 找出指着哪一项(纯 DOM 查找,不碰布局),
 * 只有**指着的那项变了**才去量一次尺寸。鼠标在同一项里怎么晃都不重算。
 *
 * 位移走 transform:left/width 每帧触发布局,transform 走合成层。宽高确实要变,
 * 但它只影响这一个绝对定位的元素,代价可以忽略。
 */
export interface GlassPill {
  trackProps: {
    ref: (node: HTMLDivElement | null) => void;
    onPointerMove: (event: React.PointerEvent) => void;
    onPointerLeave: () => void;
  };
  pillProps: { className: string; style: CSSProperties; "aria-hidden": true };
}

interface Rect { x: number; y: number; width: number; height: number }

const measure = (track: HTMLElement, key: string): Rect | null => {
  const item = track.querySelector<HTMLElement>(`[data-pill="${CSS.escape(key)}"]`);
  if (!item) return null;
  /* 相对轨道算,不用 getBoundingClientRect 的绝对坐标 —— 这样容器横向滚动时
     胶囊跟着内容一起走,不需要监听滚动。 */
  return { x: item.offsetLeft, y: item.offsetTop, width: item.offsetWidth, height: item.offsetHeight };
};

const same = (a: Rect | null, b: Rect | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

export function useGlassPill(activeKey: string | null | undefined): GlassPill {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  /* 第一次落位别从左上角滑过来 —— 那一下很显眼,而且毫无意义。 */
  const [ready, setReady] = useState(false);

  const target = hoverKey ?? activeKey ?? null;

  const sync = useCallback(() => {
    const track = trackRef.current;
    if (!track || !target) { setRect(null); return; }
    const next = measure(track, target);
    setRect((prev) => (same(prev, next) ? prev : next));
  }, [target]);

  // 布局阶段量,避免先画在旧位置再跳一下
  useLayoutEffect(() => { sync(); }, [sync]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    /* 标签开了关了、窗口宽了窄了、字体加载完了 —— 都会让尺寸变。
       与其逐个监听,不如盯着轨道本身的尺寸变化。 */
    const observer = new ResizeObserver(() => sync());
    observer.observe(track);
    for (const child of Array.from(track.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [sync]);

  // 量到第一个位置之后才允许播放过渡
  useEffect(() => {
    if (rect && !ready) {
      const id = requestAnimationFrame(() => setReady(true));
      return () => cancelAnimationFrame(id);
    }
    if (!rect && ready) setReady(false);
  }, [rect, ready]);

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const item = (event.target as HTMLElement | null)?.closest?.("[data-pill]") as HTMLElement | null;
    const key = item?.dataset.pill ?? null;
    // 只有"指着的那项变了"才 setState —— 同一项里晃鼠标不该引起任何重算
    setHoverKey((prev) => (prev === key ? prev : key));
  }, []);

  const onPointerLeave = useCallback(() => setHoverKey(null), []);

  const setTrack = useCallback((node: HTMLDivElement | null) => { trackRef.current = node; }, []);

  const settled = hoverKey === null || hoverKey === activeKey;
  return {
    trackProps: { ref: setTrack, onPointerMove, onPointerLeave },
    pillProps: {
      className: [
        "pill",
        rect ? "visible" : "",
        ready ? "" : "instant",
        settled ? "settled" : "hovering",
      ].filter(Boolean).join(" "),
      style: rect
        ? { transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`, width: rect.width, height: rect.height }
        : {},
      "aria-hidden": true,
    },
  };
}
