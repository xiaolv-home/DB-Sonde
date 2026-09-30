/* 右键菜单 / 浮层怎么摆,才能整个都看得见。
 *
 * 以前每个菜单各自猜自己多高:表头菜单猜 600、侧边栏猜 360、编辑器猜 130,
 * 单元格菜单干脆不夹纵向。猜小了就出屏 —— 表头菜单带上「剪贴板」「自定义」
 * 两组后将近 750px,屏幕矮一点底下几项就看不到。更糟的是它虽然设了
 * max-height: 100vh - 16px,top 却不是 0,top + 最大高度照样超出屏幕,
 * 连滚动区域的下半截都在屏幕外,滚也滚不到。
 *
 * 所以不猜,量:菜单画出来之后拿真实尺寸算 ——
 *   下面放得下就从点击处往下开;放不下而上面放得下就往上翻;
 *   上下都放不下就贴着屏幕底,并限高出滚动条(整块一定在屏幕里)。
 *   横向同理:右边放不下往左开,都放不下就贴右边。
 *
 * mode = "clamp" 给会边显示边长高的浮层用(AI 回复是流式的):不整块翻到上面去,
 * 只往上挪够用的距离 —— 否则你正在读,它突然跳走。
 */

export interface Placement {
  left: number;
  top: number;
  /** 只有内容比屏幕还高时才给;此时菜单要能滚动。 */
  maxHeight?: number;
}

export function fitToViewport(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
  mode: "flip" | "clamp" = "flip",
): Placement {
  const maxH = Math.max(0, viewport.height - margin * 2);
  const h = Math.min(size.height, maxH);
  let top: number;
  if (anchor.y + h <= viewport.height - margin) top = anchor.y;
  else if (mode === "flip" && anchor.y - h >= margin) top = anchor.y - h;
  else top = viewport.height - margin - h;
  // 点击处本身就贴着屏幕边(最后几个像素)时,翻过来的那一边也会压进边距,再夹一次
  top = Math.max(margin, Math.min(top, viewport.height - margin - h));

  const maxW = Math.max(0, viewport.width - margin * 2);
  const w = Math.min(size.width, maxW);
  let left: number;
  if (anchor.x + w <= viewport.width - margin) left = anchor.x;
  else if (mode === "flip" && anchor.x - w >= margin) left = anchor.x - w;
  else left = viewport.width - margin - w;
  left = Math.max(margin, Math.min(left, viewport.width - margin - w));

  return size.height > maxH ? { left, top, maxHeight: maxH } : { left, top };
}
