/* 把画布导出成一个网页(单个 .html 文件):浏览器打开就是画布原样 —— 同样的尺寸、颜色、弧度,
 * 流动的线一直在流(SVG 自带的动画,和画布上同一套画法),能滚轮缩放、拖动平移、一键适应窗口 / 原尺寸。
 * 文件自带所有东西(不联网、不依赖 Sonde),发给别人用浏览器打开就行。
 * 和其它导出一样按浅色底画。 */
import { cometSync, liveFlowFx, type PathProbe } from "./canvasAnimation";
import { canvasToSvg, type Measure } from "./canvasExport";
import type { CanvasEdge, CanvasNode } from "./canvasModel";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* 网页里的平移 / 缩放(原生 JS,不引任何库):滚轮或触控板捏合缩放(以鼠标为中心),拖动平移,
   双指捏合(手机),「适应窗口」「原尺寸」两个按钮;打开时画布比窗口大就适应窗口,否则原尺寸居中。
   点一下带注释的形状弹出注释卡片(和画布里一样,平时不显示)。 */
const VIEWER_JS = `
(() => {
  const stage = document.getElementById("stage"), board = document.getElementById("board"), pct = document.getElementById("pct");
  const card = document.getElementById("cmt");
  const W = +board.dataset.w, H = +board.dataset.h;
  let s = 1, x = 0, y = 0;
  // 注释卡片:点(没拖动)带注释的形状弹出来,再点一下或点别处收起;平移缩放时跟着形状走
  let shown = null;
  const placeCard = () => {
    if (!shown) return;
    const r = shown.getBoundingClientRect(), w = card.offsetWidth, h = card.offsetHeight;
    let top = r.bottom + 10;
    if (top + h > innerHeight - 70) top = Math.max(8, r.top - h - 10);
    card.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
    card.style.top = top + "px";
  };
  const showCard = (g) => {
    shown = g;
    card.hidden = !g;
    if (g) { card.textContent = g.dataset.cmt; placeCard(); }
  };
  const apply = () => {
    board.style.transform = "translate(" + x + "px," + y + "px) scale(" + s + ")";
    pct.textContent = Math.round(s * 100) + "%";
    placeCard();
  };
  const center = (scale) => { s = scale; x = (stage.clientWidth - W * s) / 2; y = (stage.clientHeight - H * s) / 2; apply(); };
  const fitScale = () => Math.min((stage.clientWidth - 48) / W, (stage.clientHeight - 48) / H);
  const zoomAt = (k, cx, cy) => { const n = Math.min(8, Math.max(0.1, s * k)); x = cx - (cx - x) * (n / s); y = cy - (cy - y) * (n / s); s = n; apply(); };
  document.getElementById("fit").onclick = () => center(fitScale());
  document.getElementById("one").onclick = () => center(1);
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  const pts = new Map();
  let last = null, down = null;
  stage.addEventListener("pointerdown", (e) => {
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    last = null;
    down = pts.size === 1 ? [e.clientX, e.clientY] : null;
    stage.classList.add("grab");
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId);
    pts.set(e.pointerId, [e.clientX, e.clientY]);
    if (pts.size === 1) { x += e.clientX - prev[0]; y += e.clientY - prev[1]; apply(); return; }
    const [a, b] = [...pts.values()];
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]), r = stage.getBoundingClientRect();
    if (last) zoomAt(d / last, (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top);
    last = d;
  });
  const up = (e) => {
    // 按下到松开几乎没动 = 点了一下:看点中的是不是带注释的形状
    if (down && pts.size === 1 && Math.hypot(e.clientX - down[0], e.clientY - down[1]) <= 4) {
      const hit = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.closest && el.closest("g.cmt"));
      const g = hit ? hit.closest("g.cmt") : null;
      showCard(g === shown ? null : g);
    }
    pts.delete(e.pointerId);
    last = null;
    down = null;
    if (!pts.size) stage.classList.remove("grab");
  };
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", (e) => { down = null; up(e); });
  addEventListener("resize", () => center(Math.min(1, fitScale())));
  center(Math.min(1, fitScale()));
})();
`;

const PAGE_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif; color: #1f2328; background: #f6f7f9; }
#stage { position: fixed; inset: 0; overflow: hidden; cursor: grab; touch-action: none;
  background-color: #f6f7f9; background-image: radial-gradient(#d3d7de 1px, transparent 1px); background-size: 20px 20px; }
#stage.grab { cursor: grabbing; }
#board { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
#board svg { display: block; overflow: visible; }
.bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px;
  padding: 6px 8px 6px 14px; border-radius: 10px; background: rgba(255,255,255,.94); border: 1px solid #e3e5e8;
  box-shadow: 0 4px 16px rgba(0,0,0,.08); font-size: 13px; white-space: nowrap; max-width: calc(100vw - 32px); }
.bar b { overflow: hidden; text-overflow: ellipsis; }
.bar span { color: #8a8f98; }
.bar button { font: inherit; padding: 4px 10px; border-radius: 7px; border: 1px solid #e3e5e8; background: #fff; color: #1f2328; cursor: pointer; }
.bar button:hover { background: #f0f2f5; }
g.cmt { cursor: pointer; }
.cmt-card { position: fixed; z-index: 5; max-width: min(360px, calc(100vw - 16px)); padding: 9px 12px; border-radius: 9px; background: #fff;
  border: 1px solid #e3e5e8; box-shadow: 0 8px 24px rgba(0,0,0,.14); font-size: 13px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
@media (max-width: 560px) { .bar .tip { display: none; } }
`;

/** 画布 → 完整的 HTML 文本。没有形状时返回 null。 */
export function canvasToHtml(nodes: CanvasNode[], edges: CanvasEdge[], measure: Measure, probe: PathProbe, title: string): string | null {
  const out = canvasToSvg(nodes, edges, measure, liveFlowFx(probe, cometSync(nodes, edges, measure, probe)), { background: null, comments: true });
  const hasComments = nodes.some((n) => n.comment);
  if (!out) return null;
  const name = esc(title || "链路画布");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="DB Sonde">
<title>${name}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div id="stage"><div id="board" data-w="${out.width}" data-h="${out.height}">
${out.svg}
</div></div>
<div id="cmt" class="cmt-card" hidden></div>
<div class="bar"><b>${name}</b><span class="tip">${hasComments ? "点带 ⓘ 的形状看注释 · " : ""}滚轮缩放 · 拖动平移</span><span id="pct">100%</span><button id="fit">适应窗口</button><button id="one">原尺寸</button></div>
<script>${VIEWER_JS}</script>
</body>
</html>
`;
}
