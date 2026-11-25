import { ArrowLeft, Copy, Pencil, Plus, Trash2, X } from "lucide-react";
import type { CanvasDoc } from "./canvasModel";

export function CanvasSidebar({
  standalone,
  docs,
  activeId,
  dirty,
  renaming,
  onClose,
  onCreate,
  onOpen,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onCopyDoc,
  onRemoveDoc,
}: {
  standalone: boolean;
  docs: CanvasDoc[];
  activeId: string | null;
  dirty: boolean;
  renaming: string | null;
  onClose: () => void;
  onCreate: () => void;
  onOpen: (id: string) => void;
  onStartRename: (id: string) => void;
  onCancelRename: () => void;
  onCommitRename: (id: string, name: string) => void;
  onCopyDoc: (id: string) => void;
  onRemoveDoc: (id: string) => void;
}) {
  return (
    <aside className="cv-side">
      <div className="cv-side-head">
        {standalone ? (
          <button className="icon-btn" title="关闭画布窗口" onClick={onClose}>
            <X size={16} />
          </button>
        ) : (
          <button className="icon-btn" title="返回" onClick={onClose}>
            <ArrowLeft size={16} />
          </button>
        )}
        <b>链路画布</b>
        <div className="toolbar-spacer" />
        <button className="icon-btn" title="新建画布" onClick={onCreate}>
          <Plus size={16} />
        </button>
      </div>
      <div className="cv-side-list">
        {docs.length === 0 && <div className="cv-side-none">还没有画布。点右上角 + 新建一张。</div>}
        {docs.map((d) => (
          <div
            key={d.id}
            className={`cv-doc ${d.id === activeId ? "on" : ""}`}
            onClick={() => onOpen(d.id)}
            onDoubleClick={() => onStartRename(d.id)}
          >
            {renaming === d.id ? (
              <input
                className="cv-doc-input"
                autoFocus
                defaultValue={d.name}
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => onCommitRename(d.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") onCancelRename();
                }}
              />
            ) : (
              <div className="cv-doc-main">
                <span className="cv-doc-name">
                  {d.name}
                  {d.id === activeId && dirty ? " ·" : ""}
                </span>
                <span className="cv-doc-meta">
                  {d.nodes.length} 个形状 ·{" "}
                  {new Date(d.updatedAt).toLocaleString("zh-CN", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            )}
            <div className="cv-doc-acts" onClick={(e) => e.stopPropagation()}>
              <button className="icon-btn" title="重命名" onClick={() => onStartRename(d.id)}>
                <Pencil size={13} />
              </button>
              <button className="icon-btn" title="复制一份" onClick={() => onCopyDoc(d.id)}>
                <Copy size={13} />
              </button>
              <button className="icon-btn danger" title="删除" onClick={() => onRemoveDoc(d.id)}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
