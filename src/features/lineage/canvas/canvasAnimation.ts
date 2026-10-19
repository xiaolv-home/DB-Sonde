/* 把画布导出成动图(GIF):微信里直接发、PPT 放映、Word 里都会动。
 * (SVG 自带的动画在这几个地方都不播,所以只能是 GIF。)
 *
 * 做法:按时间 t 把每根流动线画成那一刻的样子(虚线走到哪、光点 / 彗星在哪、光晕多亮),
 * 一帧一张 SVG,画成像素再编码成 GIF。效果的算法和画布上(CanvasShapes 的 FlowFxEdge)一致。
 *
 * 首尾无缝:整张动图有一个循环长度,每根线的周期微调到正好能整除它 ——
 * 最后一帧接回第一帧时每根线都刚好走完整圈,看不出跳。 */
import { applyPalette, GIFEncoder, quantize } from "gifenc";
import {
  COLOR_VALUE, DASH_PX_PER_S, PULSE_SECONDS, cometLength, dotCount, hi, travelSeconds,
  type CanvasEdge, type CanvasNode, type FlowStyle,
} from "./canvasModel";
import { canvasToSvg, svgToCanvas, type EdgeFx, type Measure } from "./canvasExport";

/** 一帧 60 毫秒(GIF 的时间单位是 1/100 秒,60ms 正好整除,约 16 帧/秒) */
export const FRAME_MS = 60;
/** 循环长度的上下限(秒):太短看着抽搐,太长文件太大 */
export const LOOP_MIN_S = 1.5;
export const LOOP_MAX_S = 6;
/** 两种动图:
 *  · 发微信:宽高都不超过 1000 像素、文件不超过 1MB —— 超了微信就当「文件」发,对方收到的不是会动的图;
 *    文件太大就把帧率减半再来(动作还是那么快,只是没那么顺);
 *  · 高清:给 PPT / Word,最长边 2000 像素。 */
export interface GifTarget { maxSide: number; maxBytes?: number }
export const GIF_TARGETS = {
  wechat: { maxSide: 1000, maxBytes: 1_000_000 },
  hd: { maxSide: 2000 },
} satisfies Record<string, GifTarget>;
/** 太大时依次试的帧间隔(毫秒,都是 10 的倍数) */
const FRAME_STEPS = [FRAME_MS, FRAME_MS * 2, FRAME_MS * 3];

/** 量线长 / 取线上某一点。真实环境用 SVG 量,测试里换成假的。 */
export interface PathProbe {
  length: (d: string) => number;
  point: (d: string, at: number) => { x: number; y: number };
}

const styleOf = (e: CanvasEdge): FlowStyle => e.flowStyle ?? "dash";
const speedOf = (e: CanvasEdge) => e.flowSpeed ?? 2;

/** 一根流动线的自然周期(秒):过这么久画面和开头一模一样。和画布上的动画时长一致。 */
export function naturalPeriod(e: CanvasEdge, len: number): number {
  const speed = speedOf(e);
  switch (styleOf(e)) {
    case "dash": return 11 / DASH_PX_PER_S[speed];   // 虚线一格 11px
    case "dot": return travelSeconds(len, speed) / dotCount(len);   // 几个光点等距,前一个走到后一个的位置就算一圈
    case "comet": return travelSeconds(len + cometLength(len), speed);
    case "pulse": return PULSE_SECONDS[speed];
  }
}

/** 整张动图的帧数:按最长的那个周期定循环长度(夹在上下限之间),再取整到整帧。 */
export function loopFrames(periods: number[], frameMs = FRAME_MS): number {
  const want = Math.min(LOOP_MAX_S, Math.max(LOOP_MIN_S, hi(periods)));
  return Math.max(1, Math.round((want * 1000) / frameMs));
}

/** 把周期微调成循环长度的整数分之一(最多一圈),动图首尾相接时正好走完整圈。 */
export const fitPeriod = (period: number, loop: number) => loop / Math.max(1, Math.round(loop / period));

/** 小数部分,先抹掉浮点误差:t = 一整圈时要正好是 0,不能是 0.9999999 */
const frac = (v: number) => { const r = Math.round(v * 1e6) / 1e6; return r - Math.floor(r); };
const f2 = (v: number) => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2);

/** 第 t 秒(循环长度 loop 秒)时每根流动线的样子 —— 给 canvasToSvg 的 fx。 */
export function flowFxAt(t: number, loop: number, probe: PathProbe): EdgeFx {
  const lengths = new Map<string, number>();
  const lengthOf = (d: string) => {
    let l = lengths.get(d);
    if (l === undefined) { l = probe.length(d); lengths.set(d, l); }
    return l;
  };
  return (e, path, stroke) => {
    const len = lengthOf(path);
    const kind = styleOf(e);
    const fc = COLOR_VALUE[e.flowColor ?? e.color];
    const sw = stroke.width;
    const period = fitPeriod(naturalPeriod(e, len), loop);
    const u = frac(t / period);
    if (kind === "dash") {
      // 画布上 dashoffset 从 0 匀速走到 -11
      return { dash: ` stroke-dasharray="6 5" stroke-dashoffset="${f2(-11 * u)}"`, stroke: e.flowColor ? fc : undefined };
    }
    if (len <= 1 && kind !== "pulse") return null;
    if (kind === "dot") {
      const n = dotCount(len);
      const r = sw * 0.9 + 1.4;
      const dots = Array.from({ length: n }, (_, i) => {
        // 第 i 个光点比第一个超前 i/n 圈;一个光点走完全程用 n 个周期
        const p = probe.point(path, frac((u + i) / n) * len);
        const cx = f2(p.x), cy = f2(p.y);
        return `<circle cx="${cx}" cy="${cy}" r="${f2(r * 2.6)}" fill="${fc}" opacity="0.22"/>`
          + `<circle cx="${cx}" cy="${cy}" r="${f2(r)}" fill="${fc}"/>`
          + `<circle cx="${cx}" cy="${cy}" r="${f2(r * 0.45)}" fill="#fff" opacity="0.85"/>`;
      });
      return { over: dots.join("") };
    }
    if (kind === "comet") {
      // 和画布上一样:一段长 c 的实线 + 后面空出整根线长,dashoffset 从 from 匀速走到 to
      const c = cometLength(len);
      const head = c * 0.3;
      const seg = (w: number, length: number, opacity: number, from: number, to: number, color = fc) =>
        `<path d="${path}" fill="none" stroke="${color}" stroke-width="${f2(w)}" stroke-linecap="round" opacity="${opacity}" stroke-dasharray="${f2(length)} ${f2(len + c)}" stroke-dashoffset="${f2(from + (to - from) * u)}"/>`;
      return {
        over: seg(sw + 7, c, 0.12, c, -len) + seg(sw + 2.5, c, 0.45, c, -len)
          + seg(sw + 3, head, 0.95, head, -len - (c - head))
          + seg(Math.max(1, sw * 0.6), head * 0.6, 0.9, head * 0.6, -len - (c - head * 0.6), "#fff"),
      };
    }
    // 呼吸:0 → 最亮 → 0,匀速
    const k = 1 - Math.abs(2 * u - 1);
    return {
      over: `<path d="${path}" fill="none" stroke="${fc}" stroke-width="${f2(sw + 8)}" stroke-linecap="round" opacity="${f2(0.28 * k)}"/>`
        + `<path d="${path}" fill="none" stroke="${fc}" stroke-width="${f2(sw + 2.5)}" stroke-linecap="round" opacity="${f2(0.7 * k)}"/>`,
    };
  };
}

/** 动图的每一帧(SVG 文本)。没有形状返回 null;没有流动的线就只有一帧。 */
export function animationFrames(nodes: CanvasNode[], edges: CanvasEdge[], measure: Measure, probe: PathProbe, frameMs = FRAME_MS):
  { frames: string[]; width: number; height: number } | null {
  const still = canvasToSvg(nodes, edges, measure);
  if (!still) return null;
  // 先量出每根流动线的自然周期,定下循环长度
  const periods: number[] = [];
  canvasToSvg(nodes, edges, measure, (e, path) => { periods.push(naturalPeriod(e, probe.length(path))); return null; });
  if (!periods.length) return { frames: [still.svg], width: still.width, height: still.height };
  const count = loopFrames(periods, frameMs);
  const loop = (count * frameMs) / 1000;
  const frames = Array.from({ length: count }, (_, i) => canvasToSvg(nodes, edges, measure, flowFxAt((i * frameMs) / 1000, loop, probe))!.svg);
  return { frames, width: still.width, height: still.height };
}

/** 真实环境的量线工具:用一个不显示的 SVG path 量 */
export function svgPathProbe(): PathProbe & { dispose: () => void } {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden");
  const el = document.createElementNS(ns, "path");
  svg.appendChild(el);
  document.body.appendChild(svg);
  const pathOf = (d: string) => { if (el.getAttribute("d") !== d) el.setAttribute("d", d); return el; };
  return {
    length: (d) => pathOf(d).getTotalLength(),
    point: (d, at) => { const p = pathOf(d).getPointAtLength(at); return { x: p.x, y: p.y }; },
    dispose: () => svg.remove(),
  };
}

/** 动图的放大倍数:小图放大一点更清楚,大图缩到最长边不超过 maxSide(总像素也不超过 maxSide² 的 5/8,免得太大) */
export function gifScale(width: number, height: number, maxSide: number): number {
  return Math.min(1.5, maxSide / Math.max(width, height), Math.sqrt((maxSide * maxSide * 0.625) / (width * height)));
}

/** 逐帧画成像素、编码成 GIF。onProgress 收到 0~1。
 *  所有帧共用一套 255 色调色板(从开头、三分之一、三分之二几帧里取色,光点彗星的颜色都在里面);
 *  第二帧起和上一帧一样的像素记成透明 —— 画面大部分不动,文件能小很多。 */
export async function encodeGif(frames: string[], width: number, height: number, opts: { maxSide: number; frameMs?: number; onProgress?: (done: number) => void }): Promise<Uint8Array> {
  const { maxSide, frameMs = FRAME_MS, onProgress } = opts;
  const scale = gifScale(width, height, maxSide);
  const raster = async (svg: string) => {
    const { canvas, ctx } = await svgToCanvas(svg, width, height, scale);
    return { w: canvas.width, h: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
  };
  const first = await raster(frames[0]);
  const samples = [...new Set([0, Math.floor(frames.length / 3), Math.floor((frames.length * 2) / 3)])];
  const pool = new Uint8ClampedArray(first.data.length * samples.length);
  for (const [i, k] of samples.entries()) pool.set(k === 0 ? first.data : (await raster(frames[k])).data, i * first.data.length);
  const palette = quantize(pool, 255);
  const clear = palette.length;   // 透明色的序号:调色板最后再加一格
  const gif = GIFEncoder();
  let prev: Uint8Array | null = null;
  for (let i = 0; i < frames.length; i++) {
    const { w, h, data } = i === 0 ? first : await raster(frames[i]);
    const index = applyPalette(data, palette);
    const delay = frames.length > 1 ? frameMs : 0;
    if (!prev) {
      gif.writeFrame(index, w, h, { palette: [...palette, [255, 0, 255]], delay, repeat: 0 });
    } else {
      const diff = new Uint8Array(index.length);
      for (let p = 0; p < index.length; p++) diff[p] = index[p] === prev[p] ? clear : index[p];
      // dispose 1 = 这一帧留在原地,下一帧透明的地方透出它
      gif.writeFrame(diff, w, h, { delay, transparent: true, transparentIndex: clear, dispose: 1 });
    }
    prev = index;
    onProgress?.((i + 1) / frames.length);
    // 让一下界面,进度能刷出来
    await new Promise((r) => setTimeout(r, 0));
  }
  gif.finish();
  return gif.bytes();
}

/** 按目标导出整张动图:生成帧 → 编码;有大小上限而超了,就加大帧间隔重来。
 *  onProgress(进度 0~1, 第几次试 从 0 起)。试到最后还超就照样返回,tooBig 标出来由调用方提示。 */
export async function exportGif(nodes: CanvasNode[], edges: CanvasEdge[], measure: Measure, probe: PathProbe, target: GifTarget,
  onProgress?: (done: number, attempt: number) => void): Promise<{ bytes: Uint8Array; frameMs: number; tooBig: boolean }> {
  const steps = target.maxBytes ? FRAME_STEPS : [FRAME_MS];
  let bytes = new Uint8Array();
  for (const [attempt, frameMs] of steps.entries()) {
    const anim = animationFrames(nodes, edges, measure, probe, frameMs);
    if (!anim) throw new Error("画布是空的");
    bytes = await encodeGif(anim.frames, anim.width, anim.height, { maxSide: target.maxSide, frameMs, onProgress: (d) => onProgress?.(d, attempt) });
    if (!target.maxBytes || bytes.length <= target.maxBytes) return { bytes, frameMs, tooBig: false };
  }
  return { bytes, frameMs: steps[steps.length - 1], tooBig: true };
}
