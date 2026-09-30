/* 右键菜单 / 浮层怎么摆,才能整个都看得见。
 *
 * 以前每个菜单各自猜自己多高:表头菜单猜 600、侧边栏猜 360、编辑器猜 130,
 * 单元格菜单干脆不夹纵向。猜小了就出屏 —— 表头菜单带上「剪贴板」「自定义」
 * 两组后将近 750px,屏幕矮一点底下几项就看不到。更糟的是它虽然设了
 * max-height: 100vh - 16px,top 却不是 0,top + 最大高度照样超出屏幕,
 * 连滚动区域的下半截都在屏幕外,滚也滚不到。
 *
 * 所以不猜,量:菜单画出来之后拿真实尺寸算。
 *
 * mode = "anchor"(右键菜单用):**左上角就钉在鼠标点的位置**,放不下不翻、不挪,
 *   只限高出滚动条。用户明确要的是这个 —— 菜单跳到别处去就找不着了。
 *   两个例外,都是为了菜单还能用:
 *     · 鼠标点在离屏幕底很近的地方,限高后只剩一两行,那就往上挪到刚好能露出
 *       MIN_VISIBLE 高;
 *     · 右边真放不下时往左挪刚好够的距离,否则右半截被切掉(横向不滚动)。
 *
 * mode = "clamp"(会边显示边长高的浮层用,AI 回复是流式的):整块放不下
 *   就往上挪够用的距离,比屏幕还高才限高。
 */

export interface Placement {
  left: number;
  top: number;
  /** 需要滚动时的最大高度;不给表示整块放得下。 */
  maxHeight?: number;
}

/** 锚定模式下菜单至少要露出这么高,少于这个就往上挪一点。 */
export const MIN_VISIBLE = 180;

export function fitToViewport(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
  mode: "anchor" | "clamp" = "anchor",
): Placement {
  const bottom = viewport.height - margin;
  const screenH = Math.max(0, viewport.height - margin * 2);

  let top: number;
  let maxHeight: number | undefined;
  if (mode === "anchor") {
    top = Math.max(margin, anchor.y);
    if (size.height > bottom - top) {
      const want = Math.min(size.height, MIN_VISIBLE, screenH);
      if (bottom - top < want) top = Math.max(margin, bottom - want);
      const room = bottom - top;
      if (size.height > room) maxHeight = room;
    }
  } else {
    const h = Math.min(size.height, screenH);
    top = Math.max(margin, Math.min(anchor.y, bottom - h));
    if (size.height > screenH) maxHeight = screenH;
  }

  const w = Math.min(size.width, Math.max(0, viewport.width - margin * 2));
  const left = Math.max(margin, Math.min(anchor.x, viewport.width - margin - w));

  return maxHeight === undefined ? { left, top } : { left, top, maxHeight };
}
