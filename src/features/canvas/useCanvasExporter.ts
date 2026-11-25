import { useState } from "react";
import { api } from "../../lib/api";
import { inTauri } from "../../lib/mockBackend";
import { useApp } from "../../store/appStore";
import type { CanvasEdge, CanvasNode } from "./canvasModel";
import { blobToBase64, bytesToBase64, canvasMeasure, canvasToSvg, svgToPng } from "./canvasExport";
import { animationFrames, encodeGif, svgPathProbe } from "./canvasAnimation";
import { encodeMp4 } from "./canvasVideo";
import { canvasToHtml } from "./canvasHtml";

export function useCanvasExporter(
  docName: string,
  snapshot: () => { nodes: CanvasNode[]; edges: CanvasEdge[] },
) {
  const toast = useApp((s) => s.showToast);
  const [animProgress, setAnimProgress] = useState<{ kind: "gif" | "mp4"; done: number } | null>(null);

  const exportImage = async (kind: "png" | "svg" | "clipboard") => {
    const snap = snapshot();
    const out = canvasToSvg(snap.nodes, snap.edges, canvasMeasure());
    if (!out) {
      toast({ kind: "info", text: "画布是空的" });
      return;
    }
    try {
      if (kind === "clipboard") {
        const png = svgToPng(out.svg, out.width, out.height);
        await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
        toast({ kind: "success", text: "已复制为图片,可以直接粘贴到 PPT / 微信 / 文档里" });
        return;
      }
      if (!inTauri) throw new Error("浏览器预览里不能存文件,请用桌面版");
      const content = kind === "svg" ? out.svg : await blobToBase64(await svgToPng(out.svg, out.width, out.height));
      const path = await api.saveExport(docName || "链路画布", kind, content);
      toast({ kind: "success", text: `已导出到 ${path}` });
    } catch (error) {
      toast({ kind: "error", text: `导出失败:${error instanceof Error ? error.message : String(error)}` });
    }
  };

  const exportHtml = async () => {
    const snap = snapshot();
    if (!snap.nodes.length) {
      toast({ kind: "info", text: "画布是空的" });
      return;
    }
    if (!inTauri) {
      toast({ kind: "error", text: "导出失败:浏览器预览里不能存文件,请用桌面版" });
      return;
    }
    const probe = svgPathProbe();
    try {
      const html = canvasToHtml(snap.nodes, snap.edges, canvasMeasure(), probe, docName)!;
      const path = await api.saveExport(docName || "链路画布", "html", html);
      toast({
        kind: "success",
        text: `已导出到 ${path}。双击用浏览器打开就是画布原样:线在流,滚轮缩放、拖动平移;发给别人也一样能看`,
      });
    } catch (error) {
      toast({ kind: "error", text: `导出失败:${error instanceof Error ? error.message : String(error)}` });
    } finally {
      probe.dispose();
    }
  };

  const exportAnimated = async (kind: "gif" | "mp4") => {
    if (animProgress !== null) return;
    const snap = snapshot();
    if (!snap.nodes.length) {
      toast({ kind: "info", text: "画布是空的" });
      return;
    }
    if (!snap.edges.some((e) => e.flow)) {
      toast({ kind: "info", text: "画布上没有流动的线,导出了也不会动 —— 先给线打开「流动」,或者直接导出 PNG" });
      return;
    }
    if (!inTauri) {
      toast({ kind: "error", text: "导出失败:浏览器预览里不能存文件,请用桌面版" });
      return;
    }
    const probe = svgPathProbe();
    setAnimProgress({ kind, done: 0 });
    const onProgress = (done: number) => setAnimProgress({ kind, done });
    try {
      const measure = canvasMeasure();
      let bytes: Uint8Array;
      if (kind === "mp4") {
        bytes = await encodeMp4(snap.nodes, snap.edges, measure, probe, onProgress);
      } else {
        const anim = animationFrames(snap.nodes, snap.edges, measure, probe)!;
        bytes = await encodeGif(anim.frames, anim.width, anim.height, onProgress);
      }
      const path = await api.saveExport(docName || "链路画布", kind, bytesToBase64(bytes));
      const size =
        bytes.length >= 1024 * 1024
          ? `${(bytes.length / 1024 / 1024).toFixed(1)} MB`
          : `${Math.ceil(bytes.length / 1024)} KB`;
      const tip =
        kind === "mp4"
          ? "微信里当视频发(能全屏放大);PPT / WPS 用「插入 → 视频」,在视频选项里勾上「循环播放」"
          : "Keynote / Word 里会动;WPS 要放映时才动;Mac 的「预览」不播动图,按空格快速查看才会动";
      toast({ kind: "success", text: `已导出到 ${path}(${size})。${tip}` });
    } catch (error) {
      toast({ kind: "error", text: `导出失败:${error instanceof Error ? error.message : String(error)}` });
    } finally {
      probe.dispose();
      setAnimProgress(null);
    }
  };

  return { animProgress, exportImage, exportHtml, exportAnimated };
}
