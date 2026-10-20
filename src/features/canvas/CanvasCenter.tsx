/* 数据资产里的「链路画布」:列出画过的画布,点一张就打开画布窗口并切到它。
 * 桌面版画布是独立窗口(能和数据库并排看);浏览器预览里没有多窗口,就直接盖在上面。 */
import { lazy, Suspense, useEffect, useState } from "react";
import { PenTool, Plus, Workflow } from "lucide-react";
import AssetShell from "../assets/AssetShell";
import { api } from "../../lib/api";
import { inTauri } from "../../lib/mockBackend";
import { useApp } from "../../store/appStore";
import { canvasRepository, requestCanvasFocus } from "./canvasRepository";
import "./canvas.css";
import type { CanvasDoc } from "./canvasModel";
import { useCanvasCenter } from "./canvasCenterStore";

const CanvasOverlay = lazy(() => import("./CanvasEditor"));

const ago = (ts: number) => {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  if (min < 60 * 24) return `${Math.round(min / 60)} 小时前`;
  return new Date(ts).toLocaleDateString();
};

export default function CanvasCenter() {
  const open = useCanvasCenter((s) => s.open);
  const [docs, setDocs] = useState<CanvasDoc[]>([]);
  const [inline, setInline] = useState(false);
  // 每次打开都重新读:画布在另一个窗口里改,这边列表要跟上
  useEffect(() => { if (open) setDocs(canvasRepository.load()); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onStorage = (e: StorageEvent) => { if (e.key === "sonde.lineageCanvases.v1") setDocs(canvasRepository.load()); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [open]);

  /** 打开画布(id 给了就切到那一张;"new" = 新建一张) */
  const launch = (id?: string) => {
    if (id) requestCanvasFocus(id);
    if (!inTauri) { setInline(true); return; }
    api.openCanvasWindow().catch((error) => useApp.getState().showToast({ kind: "error", text: `画布窗口打开失败:${String(error)}` }));
  };

  if (!open) return null;
  return (
    <AssetShell
      title="链路画布"
      sub="自己画数据链路:摆表、连线、分组、流动效果。画布在独立窗口里打开,能和数据库并排看。"
      actions={<button className="btn sm primary" onClick={() => launch()}><PenTool size={14} /> 打开画布</button>}
    >
      <div className="cvc-body">
        {docs.length === 0 ? (
          <div className="cvc-empty">
            <Workflow size={28} />
            <b>还没有画布</b>
            <span>打开画布,从数据库挑几张表摆上去,连上线,就是一张看得懂的链路图。</span>
            <button className="btn primary" onClick={() => launch("new")}><Plus size={14} /> 新建画布</button>
          </div>
        ) : (
          <div className="cvc-grid">
            {docs.map((d) => (
              <button key={d.id} className="cvc-card" onClick={() => launch(d.id)} title="打开这张画布">
                <Workflow size={18} />
                <b>{d.name}</b>
                <small>{d.nodes.length} 个形状 · {d.edges.length} 条线 · {ago(d.updatedAt)}</small>
              </button>
            ))}
            <button className="cvc-card cvc-new" onClick={() => launch("new")}><Plus size={18} /><b>新建画布</b></button>
          </div>
        )}
      </div>
      {inline && (
        <Suspense fallback={null}>
          <CanvasOverlay onClose={() => { setInline(false); setDocs(canvasRepository.load()); }} />
        </Suspense>
      )}
    </AssetShell>
  );
}
