/* 把画布导出成视频(MP4 / H.264):发微信能全屏、能放大看清字;PPT / WPS 用「插入 → 视频」一定能播。
 * (动图 GIF 发微信要压到 1000 像素以内还不能放大,WPS 里也只有放映时才动。)
 *
 * 帧和动图用同一套(canvasAnimation 的 animationFrames,首尾无缝),按 30 帧/秒生成一圈,
 * 再重复几圈凑够 VIDEO_MIN_S 秒 —— 视频在微信里播完就停,太短看不出在流。
 * 编码用系统自带的 WebCodecs(VideoEncoder,硬件 H.264),封装成 MP4 用 mp4-muxer。 */
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { VIDEO_LOOP_MAX_S, animationFrames, exportScale, yieldToUi, type PathProbe } from "./canvasAnimation";
import { svgImage, type Measure } from "./canvasExport";
import type { CanvasEdge, CanvasNode } from "./canvasModel";

export const VIDEO_FPS = 30;
/** 视频至少多长(秒) */
export const VIDEO_MIN_S = 10;
/** 最长边:1080p 的宽,微信、PPT 都吃得下 */
export const VIDEO_MAX_SIDE = 1920;
/** 每 2 秒一个关键帧:拖进度条不卡 */
const KEYFRAME_EVERY = VIDEO_FPS * 2;
/** 从高到低试的 H.264 档次:High 5.1(放得下 2K)→ High 4.0 → Main → Baseline */
const CODECS = ["avc1.640033", "avc1.640028", "avc1.4d0028", "avc1.42E01F"];

/** 视频的尺寸和总帧数。H.264 要求宽高是偶数;圈数取整,最后一帧正好接回第一帧。 */
export function videoPlan(width: number, height: number, loopFrames: number): { w: number; h: number; total: number } {
  const s = exportScale(width, height, VIDEO_MAX_SIDE);
  const even = (v: number) => Math.max(2, Math.round((v * s) / 2) * 2);
  const loops = Math.max(1, Math.ceil((VIDEO_MIN_S * VIDEO_FPS) / loopFrames));
  return { w: even(width), h: even(height), total: loopFrames * loops };
}

/* 色彩范围:视频里的亮度有两种记法 —— 有限范围(白 = 235)和全范围(白 = 255),文件里标着是哪种,播放器照标的解。
   标的和实际的对不上,白底就发灰(或者过曝)。系统编码器(macOS 的 WebKit)从 canvas 转出来的是有限范围、却标成全范围;
   所以像素自己转成 YUV 再交给它,而且先试一帧,看它标哪种,就按哪种转。 */

/** RGBA 像素 → I420(BT.709):Y 全分辨率,U / V 各取 2×2 的平均。宽高要是偶数。fullRange:白 = 255,否则白 = 235。 */
export function rgbaToI420(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, fullRange: boolean, out = new Uint8Array((w * h * 3) / 2)): Uint8Array {
  const uOff = w * h, vOff = uOff + (w * h) / 4, cw = w / 2;
  const [y0, ys, cs] = fullRange ? [0, 1, 1] : [16, 219 / 255, 224 / 255];
  // 全范围时 128 + 127.5 会进位成 256,写进 Uint8Array 就绕回 0 了,要夹住
  const chroma = (v: number) => Math.min(255, 128 + v * cs + 0.5);
  const luma = (p: number) => y0 + (0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]) * ys + 0.5;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      // 2×2 的四个像素:左上、右上、左下、右下
      const p0 = (y * w + x) * 4, p1 = p0 + 4, p2 = p0 + w * 4, p3 = p2 + 4;
      out[y * w + x] = luma(p0); out[y * w + x + 1] = luma(p1);
      out[(y + 1) * w + x] = luma(p2); out[(y + 1) * w + x + 1] = luma(p3);
      const r = (rgba[p0] + rgba[p1] + rgba[p2] + rgba[p3]) / 4;
      const g = (rgba[p0 + 1] + rgba[p1 + 1] + rgba[p2 + 1] + rgba[p3 + 1]) / 4;
      const b = (rgba[p0 + 2] + rgba[p1 + 2] + rgba[p2 + 2] + rgba[p3 + 2]) / 4;
      const c = (y / 2) * cw + x / 2;
      out[uOff + c] = chroma(-0.1146 * r - 0.3854 * g + 0.5 * b);
      out[vOff + c] = chroma(0.5 * r - 0.4542 * g - 0.0458 * b);
    }
  }
  return out;
}

/** 码率:画面大部分是静止的图,按像素给足一点,字边缘才不糊 */
export const videoBitrate = (w: number, h: number) => Math.min(12_000_000, Math.max(2_000_000, Math.round(w * h * 2)));

/** 先编一帧,看编码器在文件里标的是不是全范围(没说就当有限范围,这是视频的默认)。 */
async function encoderFullRange(codec: string, w: number, h: number, bitrate: number): Promise<boolean> {
  let full: boolean | undefined;
  const probe = new VideoEncoder({ output: (_, meta) => { full ??= meta?.decoderConfig?.colorSpace?.fullRange ?? undefined; }, error: () => {} });
  try {
    probe.configure({ codec, width: w, height: h, bitrate, framerate: VIDEO_FPS });
    const frame = new VideoFrame(new Uint8Array((w * h * 3) / 2), { format: "I420", codedWidth: w, codedHeight: h, timestamp: 0 });
    probe.encode(frame, { keyFrame: true });
    frame.close();
    await probe.flush();
  } finally {
    if (probe.state !== "closed") probe.close();
  }
  return full ?? false;
}

async function pickCodec(w: number, h: number, bitrate: number): Promise<string> {
  for (const codec of CODECS) {
    const { supported } = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate, framerate: VIDEO_FPS });
    if (supported) return codec;
  }
  throw new Error(`这台电脑编码不了 ${w}×${h} 的视频,请改用导出动图 GIF`);
}

/** 画布 → MP4。onProgress 收到 0~1。 */
export async function encodeMp4(nodes: CanvasNode[], edges: CanvasEdge[], measure: Measure, probe: PathProbe,
  onProgress?: (done: number) => void): Promise<Uint8Array> {
  if (typeof VideoEncoder === "undefined") throw new Error("这个系统版本不支持导出视频,请改用导出动图 GIF");
  const anim = animationFrames(nodes, edges, measure, probe, 1000 / VIDEO_FPS, VIDEO_LOOP_MAX_S);
  if (!anim) throw new Error("画布是空的");
  const { w, h, total } = videoPlan(anim.width, anim.height, anim.frames.length);
  const bitrate = videoBitrate(w, h);
  const codec = await pickCodec(w, h, bitrate);
  const fullRange = await encoderFullRange(codec, w, h, bitrate);
  const colorSpace: VideoColorSpaceInit = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange };

  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width: w, height: h, frameRate: VIDEO_FPS }, fastStart: "in-memory" });
  let failure = null as Error | null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { failure = e; },
  });
  encoder.configure({ codec, width: w, height: h, bitrate, framerate: VIDEO_FPS, latencyMode: "quality" });

  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("视频生成失败");
  const yuv = new Uint8Array((w * h * 3) / 2);
  // 一圈里的每帧只加载一次(SVG 图片很小),重复的圈直接再画
  const images: Awaited<ReturnType<typeof svgImage>>[] = [];
  try {
    for (let i = 0; i < total; i++) {
      if (failure) throw failure;
      const k = i % anim.frames.length;
      images[k] ??= await svgImage(anim.frames[k]);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(images[k].img, 0, 0, w, h);
      rgbaToI420(ctx.getImageData(0, 0, w, h).data, w, h, fullRange, yuv);
      const frame = new VideoFrame(yuv, {
        format: "I420", codedWidth: w, codedHeight: h, colorSpace,
        timestamp: Math.round((i * 1e6) / VIDEO_FPS), duration: Math.round(1e6 / VIDEO_FPS),
      });
      encoder.encode(frame, { keyFrame: i % KEYFRAME_EVERY === 0 });
      frame.close();
      // 编码跟不上就等一等,别把几百帧都堆在内存里
      while (encoder.encodeQueueSize > 4) await yieldToUi();
      onProgress?.((i + 1) / total);
      if (i % 8 === 0) await yieldToUi();
    }
    await encoder.flush();
    if (failure) throw failure;
  } finally {
    if (encoder.state !== "closed") encoder.close();
    images.forEach((im) => im?.dispose());
  }
  muxer.finalize();
  return new Uint8Array(muxer.target.buffer);
}
