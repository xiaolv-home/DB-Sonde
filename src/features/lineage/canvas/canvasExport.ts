/* 把画布画成一张独立的 SVG(矢量,插进 PPT / Keynote 不糊,还能拆成形状改),
 * 再按需转成 PNG;动图(GIF)也是逐帧调这里画,见 canvasAnimation。不截屏:截屏拿不到 CSS 变量和箭头定义,导出来常常缺线少色。
 * 导出一律按浅色底画 —— 贴进文档、幻灯片时最常见的就是白底。
 * 线的走法用和画布同一套算法(React Flow 的 getBezierPath 等),导出来和屏幕上一致。 */
import { getBezierPath, getSmoothStepPath, getStraightPath, Position } from "@xyflow/react";
import { COLOR_VALUE, STROKE_PX, hi, lo, markerSize, textColorValue, type Bend, type CanvasEdge, type CanvasNode } from "./canvasModel";

const PAD = 40;
/** 分叉点圆点的直径(节点本身大一圈,多出来的是拖线用的连接点) */
export const JUNCTION_DOT = 10;
const TEXT = "#1f2328";
const FONT = `-apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif`;

/** 量一段文字有多宽(像素)。真实环境用 canvas 量,测试里可以换成假的。 */
export type Measure = (text: string, fontSize: number, bold: boolean) => number;

export const canvasMeasure = (): Measure => {
  const ctx = document.createElement("canvas").getContext("2d");
  return (text, fontSize, bold) => {
    if (!ctx) return text.length * fontSize * 0.6;
    ctx.font = `${bold ? 650 : 400} ${fontSize}px ${FONT}`;
    return ctx.measureText(text).width;
  };
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 颜色和白色按比例混(和画布上 color-mix(… 14%, 白) 一样)。 */
export function mixWhite(hex: string, pct: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * pct + 255 * (1 - pct));
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("")}`;
}

/** 按宽度折行:中文按字断,英文尽量按词断;原文里的换行保留。 */
export function wrapText(text: string, maxWidth: number, fontSize: number, bold: boolean, measure: Measure): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    const tokens = para.match(/[A-Za-z0-9_.\-/:]+|\s+|./gu) ?? [""];
    let line = "";
    for (const token of tokens) {
      const next = line + token;
      if (!line || measure(next, fontSize, bold) <= maxWidth) { line = next; continue; }
      lines.push(line.trimEnd());
      line = token.trimStart();
      // 一个词本身就比框宽:按字硬断
      while (line && measure(line, fontSize, bold) > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && measure(line.slice(0, cut), fontSize, bold) > maxWidth) cut -= 1;
        lines.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

const SIDE_POS = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left } as const;
type Side = keyof typeof SIDE_POS;
function anchor(n: CanvasNode, side: Side) {
  // 分叉点:线都接到圆心,几根线在圆点底下汇成一点
  if (n.shape === "junction") return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
  if (side === "top") return { x: n.x + n.w / 2, y: n.y };
  if (side === "bottom") return { x: n.x + n.w / 2, y: n.y + n.h };
  if (side === "left") return { x: n.x, y: n.y + n.h / 2 };
  return { x: n.x + n.w, y: n.y + n.h / 2 };
}
const asSide = (h: string | undefined): Side => (h && h in SIDE_POS ? h as Side : "top");

export interface PathArgs { sourceX: number; sourceY: number; sourcePosition: Position; targetX: number; targetY: number; targetPosition: Position }

/** 拖过的线经过的那个点:两头连接点的中点 + 偏移 */
export const bendPoint = (a: PathArgs, bend: Bend) => ({ x: (a.sourceX + a.targetX) / 2 + bend.x, y: (a.sourceY + a.targetY) / 2 + bend.y });
/** 反过来:线要经过 p,偏移是多少(拖圆点时用) */
export const bendFor = (a: PathArgs, p: { x: number; y: number }): Bend => ({
  x: Math.round(p.x - (a.sourceX + a.targetX) / 2), y: Math.round(p.y - (a.sourceY + a.targetY) / 2),
});

/** 连接点朝外的方向 */
const OUT: Record<Position, [number, number]> = { [Position.Top]: [0, -1], [Position.Right]: [1, 0], [Position.Bottom]: [0, 1], [Position.Left]: [-1, 0] };
const pt = (x: number, y: number) => `${+x.toFixed(1)},${+y.toFixed(1)}`;
/** 经过 p 的曲线:两段三次贝塞尔。两头照样从连接点垂直出去,p 处顺着「起点 → 终点」的方向过,弯得自然、不打结。 */
function curveThrough(a: PathArgs, p: { x: number; y: number }): string {
  const [sx, sy] = OUT[a.sourcePosition], [tx, ty] = OUT[a.targetPosition];
  const l1 = Math.hypot(p.x - a.sourceX, p.y - a.sourceY), l2 = Math.hypot(a.targetX - p.x, a.targetY - p.y);
  const dl = Math.hypot(a.targetX - a.sourceX, a.targetY - a.sourceY) || 1;
  const mx = (a.targetX - a.sourceX) / dl, my = (a.targetY - a.sourceY) / dl;
  // 两头出去多远:那个点正好在连接点朝外的方向上就出去长一点(和默认曲线一样),在侧面、背后就短一点,
  // 不然线会先朝外冲一大截再折回来,绕成一个圈
  const reach = (dx: number, dy: number, vx: number, vy: number, l: number) => l * (0.25 + 0.25 * Math.max(0, (dx * vx + dy * vy) / (l || 1)));
  const k1 = reach(sx, sy, p.x - a.sourceX, p.y - a.sourceY, l1), k2 = reach(tx, ty, p.x - a.targetX, p.y - a.targetY, l2);
  return `M${pt(a.sourceX, a.sourceY)} C${pt(a.sourceX + sx * k1, a.sourceY + sy * k1)} ${pt(p.x - mx * l1 * 0.35, p.y - my * l1 * 0.35)} ${pt(p.x, p.y)}`
    + ` C${pt(p.x + mx * l2 * 0.35, p.y + my * l2 * 0.35)} ${pt(a.targetX + tx * k2, a.targetY + ty * k2)} ${pt(a.targetX, a.targetY)}`;
}

/** 按线型算路径(画布上的线和导出的图片 / 动图 / 视频都用它)。没拖过就和 React Flow 自带的线一模一样;
 *  拖过(bend):曲线 / 直线经过那个点,折线把中间那段挪到那个点。标签放在经过的点上。 */
export function linePath(line: CanvasEdge["line"], args: PathArgs, bend?: Bend): [path: string, labelX: number, labelY: number] {
  if (bend) {
    const p = bendPoint(args, bend);
    if (line === "straight") return [`M${pt(args.sourceX, args.sourceY)} L${pt(p.x, p.y)} L${pt(args.targetX, args.targetY)}`, p.x, p.y];
    if (line === "step" || line === "sharp") {
      const [path] = getSmoothStepPath({ ...args, centerX: p.x, centerY: p.y, ...(line === "sharp" ? { borderRadius: 0 } : {}) });
      return [path, p.x, p.y];
    }
    return [curveThrough(args, p), p.x, p.y];
  }
  const [path, labelX, labelY] =
    line === "straight" ? getStraightPath(args)
    : line === "step" ? getSmoothStepPath(args)
    : line === "sharp" ? getSmoothStepPath({ ...args, borderRadius: 0 })
    : getBezierPath(args);
  return [path, labelX, labelY];
}

/** 一条线的路径和标签位置 —— 和画布上同一套算法。 */
export function edgeGeometry(e: CanvasEdge, from: CanvasNode, to: CanvasNode): { path: string; labelX: number; labelY: number } {
  const fs = asSide(e.fromHandle), ts = asSide(e.toHandle);
  const s = anchor(from, fs), t = anchor(to, ts);
  const [path, labelX, labelY] = linePath(e.line, { sourceX: s.x, sourceY: s.y, sourcePosition: SIDE_POS[fs], targetX: t.x, targetY: t.y, targetPosition: SIDE_POS[ts] }, e.bend);
  return { path, labelX, labelY };
}

function shapeSvg(n: CanvasNode): string {
  const c = COLOR_VALUE[n.color];
  const fillKind = n.fill ?? "soft";
  const isNote = n.shape === "note", isGroup = n.shape === "group", isText = n.shape === "text";
  let fill = fillKind === "solid" ? c : fillKind === "outline" ? "#ffffff" : mixWhite(c, isNote ? 0.3 : 0.14);
  if (isGroup) fill = mixWhite(c, 0.06);
  const stroke = isNote ? mixWhite(c, 0.6) : c;
  const dash = n.dashed || isGroup ? ` stroke-dasharray="6 4"` : "";
  const common = `fill="${fill}" stroke="${stroke}" stroke-width="1.5"${dash}`;
  const { x, y, w, h } = n;
  switch (n.shape) {
    case "text": return "";
    case "rect": return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" ${common}/>`;
    case "rounded": return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" ${common}/>`;
    case "pill": return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${Math.min(w, h) / 2}" ${common}/>`;
    case "ellipse": return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" ${common}/>`;
    case "diamond": return `<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}" ${common}/>`;
    case "note": return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" ${common}/>`;
    case "group": return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" ${common}/>`;
    case "junction": return `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${JUNCTION_DOT / 2}" fill="${c}" stroke="#ffffff" stroke-width="1.5"/>`;
    case "cylinder": {
      const ry = h * 0.115;   // 和画布上的 SVG 一样:上下两个椭圆各占高度的 11.5%
      return `<path d="M${x},${y + ry} A${w / 2},${ry} 0 0 1 ${x + w},${y + ry} V${y + h - ry} A${w / 2},${ry} 0 0 1 ${x},${y + h - ry} Z" ${common}/>`
        + `<path d="M${x},${y + ry} A${w / 2},${ry} 0 0 0 ${x + w},${y + ry}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`;
    }
  }
  void isText;
  return "";
}

function labelSvg(n: CanvasNode, measure: Measure): string {
  if (!n.text) return "";
  const bold = !!n.bold || n.shape === "group";
  const topLeft = n.shape === "note" || n.shape === "group";
  const padX = n.shape === "diamond" ? 26 : n.shape === "ellipse" ? 20 : n.shape === "pill" ? 18 : 12;
  const padY = n.shape === "cylinder" ? 16 : n.shape === "diamond" ? 10 : topLeft ? (n.shape === "note" ? 10 : 8) : 6;
  const lines = wrapText(n.text, Math.max(10, n.w - padX * 2), n.fontSize, bold, measure);
  const lh = n.fontSize * 1.35;
  const color = n.textColor ? textColorValue(n.textColor)
    : n.shape === "group" ? COLOR_VALUE[n.color] : (n.fill === "solid" && n.shape !== "text" ? "#ffffff" : TEXT);
  const weight = bold ? 650 : 400;
  const x = topLeft ? n.x + padX : n.x + n.w / 2;
  const anchorAttr = topLeft ? "start" : "middle";
  const blockTop = topLeft ? n.y + padY : n.y + (n.shape === "cylinder" ? padY / 2 : 0) + (n.h - lines.length * lh) / 2;
  const tspans = lines.map((l, i) => `<tspan x="${x}" y="${(blockTop + lh * i + lh * 0.72).toFixed(1)}">${esc(l)}</tspan>`).join("");
  return `<text font-size="${n.fontSize}" font-weight="${weight}" fill="${color}" text-anchor="${anchorAttr}">${tspans}</text>`;
}

/** 流动线怎么画(导出动图逐帧画、导出网页画成会动的;不给就画成静止的样子)。
 *  dash:替换线本身的虚线属性(比如带上 stroke-dashoffset);stroke:线本身换颜色;
 *  inner:放进线本身里面的东西(比如让虚线走起来的 <animate>);over:叠在线上面的光点 / 彗星 / 光晕。 */
export type EdgeFx = (e: CanvasEdge, path: string, stroke: { color: string; width: number }) =>
  { dash?: string; stroke?: string; inner?: string; over?: string } | null;

/** 整张画布 → SVG 文本。没有形状时返回 null。 */
export function canvasToSvg(nodes: CanvasNode[], edges: CanvasEdge[], measure: Measure, fx?: EdgeFx,
  opts: { background?: string | null; comments?: boolean } = {}): { svg: string; width: number; height: number } | null {
  const background = opts.background === undefined ? "#ffffff" : opts.background;
  if (!nodes.length) return null;
  const minX = lo(nodes.map((n) => n.x)) - PAD, minY = lo(nodes.map((n) => n.y)) - PAD;
  const width = Math.ceil(hi(nodes.map((n) => n.x + n.w)) + PAD - minX);
  const height = Math.ceil(hi(nodes.map((n) => n.y + n.h)) + PAD - minY);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const markers = new Map<string, string>();
  const marker = (color: string, sw: number) => {
    const size = markerSize(sw);
    const id = `a${color.slice(1)}-${Math.round(size * 10)}`;
    if (!markers.has(id)) markers.set(id, `<marker id="${id}" viewBox="-10 -10 20 20" markerWidth="${size}" markerHeight="${size}" markerUnits="strokeWidth" orient="auto-start-reverse" refX="0" refY="0"><polyline points="-5,-4 0,0 -5,4 -5,-4" fill="${color}" stroke="${color}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></marker>`);
    return id;
  };
  // 分组框垫底,其余按叠放次序
  const order = [...nodes].sort((a, b) => (a.shape === "group" ? -1e6 : 0) + (a.z ?? 0) - ((b.shape === "group" ? -1e6 : 0) + (b.z ?? 0)));
  const groups = order.filter((n) => n.shape === "group");
  const rest = order.filter((n) => n.shape !== "group");
  const edgeParts: string[] = [];
  const labelParts: string[] = [];
  for (const e of edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const g = edgeGeometry(e, a, b);
    const color = COLOR_VALUE[e.color];
    const sw = STROKE_PX[e.width ?? 1] ?? 1.5;
    const m = e.arrow === "none" ? "" : ` marker-end="url(#${marker(color, sw)})"`;
    const ms = e.arrow === "both" ? ` marker-start="url(#${marker(color, sw)})"` : "";
    // 图片是静止的:虚线流动画成虚线,光点 / 彗星 / 呼吸就画成线本身(用户设了虚线就虚线)
    const flowDash = e.flow && (e.flowStyle ?? "dash") === "dash";
    const still = flowDash ? ` stroke-dasharray="6 5"` : e.dashed ? ` stroke-dasharray="6 4"` : "";
    const live = e.flow ? fx?.(e, g.path, { color, width: sw }) : null;
    const dash = live?.dash ?? still;
    const attrs = `d="${g.path}" fill="none" stroke="${live?.stroke ?? color}" stroke-width="${sw}"${dash}${m}${ms}`;
    edgeParts.push(live?.inner ? `<path ${attrs}>${live.inner}</path>` : `<path ${attrs}/>`);
    if (live?.over) edgeParts.push(live.over);
    if (e.label) {
      const w = measure(e.label, 12, false) + 12;
      labelParts.push(`<rect x="${(g.labelX - w / 2).toFixed(1)}" y="${(g.labelY - 10).toFixed(1)}" width="${w.toFixed(1)}" height="20" rx="4" fill="#ffffff" stroke="#e3e5e8"/>`
        + `<text x="${g.labelX.toFixed(1)}" y="${(g.labelY + 4).toFixed(1)}" font-size="12" fill="#57606a" text-anchor="middle">${esc(e.label)}</text>`);
    }
  }
  // 导出网页时(comments):有注释的形状包一层带注释的 <g>(点它弹出注释),右上角画个 i 标记;图片里不带注释
  const nodeSvg = (n: CanvasNode) => {
    const drawn = shapeSvg(n) + labelSvg(n, measure);
    if (!opts.comments || !n.comment) return drawn;
    const bx = n.x + n.w - 2, by = n.y + 2;
    const badge = `<circle cx="${bx}" cy="${by}" r="7" fill="#ffffff" stroke="${COLOR_VALUE[n.color]}" stroke-width="1.5"/>`
      + `<text x="${bx}" y="${by + 3.5}" font-size="10" font-weight="700" fill="${COLOR_VALUE[n.color]}" text-anchor="middle">i</text>`;
    return `<g class="cmt" data-cmt="${esc(n.comment)}">${drawn}${badge}</g>`;
  };
  const body = [
    ...groups.map(nodeSvg),
    ...edgeParts,
    ...rest.map(nodeSvg),
    ...labelParts,
  ].join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}" font-family='${FONT}'>
<defs>${[...markers.values()].join("")}</defs>
${background ? `<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${background}"/>` : ""}
${body}
</svg>`;
  return { svg, width, height };
}

/** SVG 文本 → 加载好的图片(可以反复画到 canvas 上)。用完调 dispose。 */
export async function svgImage(svg: string): Promise<{ img: HTMLImageElement; dispose: () => void }> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  const img = new Image();
  try {
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error("图片生成失败")); img.src = url; });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  return { img, dispose: () => URL.revokeObjectURL(url) };
}

/** SVG 画到一块 canvas 上(放大 scale 倍)。画布太大时降低倍数,别超过浏览器能画的上限。 */
export async function svgToCanvas(svg: string, width: number, height: number, scale: number): Promise<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D }> {
  const { img, dispose } = await svgImage(svg);
  try {
    const canvas = document.createElement("canvas");
    const s = Math.min(scale, 16000 / Math.max(width, height));
    canvas.width = Math.round(width * s); canvas.height = Math.round(height * s);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("图片生成失败");
    ctx.scale(s, s);
    ctx.drawImage(img, 0, 0, width, height);
    return { canvas, ctx };
  } finally {
    dispose();
  }
}

/** SVG → PNG(放大 scale 倍,贴进幻灯片也清楚)。 */
export async function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  const { canvas } = await svgToCanvas(svg, width, height, scale);
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("图片生成失败")), "image/png"));
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

export function bytesToBase64(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
