import { useState } from "react";
import { useViewportFit } from "../../hooks/useViewportFit";
import {
  Play,
  Sparkles,
  ChevronRight,
  SearchCheck,
  Gauge,
  AlignLeft,
  MessageCircleQuestion,
  FileCode2,
  CornerDownLeft,
} from "lucide-react";
import type { EditorAiContext } from "../../components/SqlEditor";
import { useAiStrings } from "./strings";
import type { InlineAction } from "./prompt";

interface Props {
  ctx: EditorAiContext;
  /** Run the current selection (or whole statement) in the editor's own tab. */
  onRunSelection: () => void;
  /** Open the AI dialog for a specific action, or "ask" for the free-ask box. */
  onAiAction: (action: InlineAction | "ask") => void;
  onClose: () => void;
}

/** The SQL editor's right-click menu: Run-selected plus an AI submenu that
 *  reveals the inline actions on hover. Picking an AI item opens the existing
 *  AI dialog (AiInline) unchanged. */
export default function EditorContextMenu({ ctx, onRunSelection, onAiAction, onClose }: Props) {
  const t = useAiStrings();
  const hasSelection = !!ctx.selection.trim();
  const fit = useViewportFit(ctx);
  /* AI 子菜单固定往右下飞出,菜单贴近屏幕右边/底边时整块出屏。
     悬停展开那一刻量它的真实位置,放不下就翻到左边 / 往上对齐。 */
  const [subFlip, setSubFlip] = useState({ x: false, y: false });
  const placeSubmenu = (item: HTMLElement) => {
    const sub = item.querySelector<HTMLElement>(".ectx-submenu");
    if (!sub) return;
    const parent = item.getBoundingClientRect();
    const { width, height } = sub.getBoundingClientRect();
    setSubFlip({
      x: parent.right - 6 + width > window.innerWidth - 8,
      y: parent.top - 6 + height > window.innerHeight - 8,
    });
  };

  const aiActions: { id: InlineAction; label: string; icon: typeof SearchCheck }[] = [
    { id: "review", label: t("inlineReview"), icon: SearchCheck },
    { id: "optimize", label: t("inlineOptimize"), icon: Gauge },
    { id: "format", label: t("inlineFormat"), icon: AlignLeft },
    { id: "explain", label: t("inlineExplain"), icon: MessageCircleQuestion },
    { id: "fromComment", label: t("inlineFromComment"), icon: FileCode2 },
  ];

  const pick = (action: InlineAction | "ask") => {
    onAiAction(action);
    onClose();
  };

  return (
    <>
      <div
        className="editor-ctx-backdrop"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div className="editor-ctx" ref={fit.ref} style={fit.style} onMouseDown={(e) => e.stopPropagation()}>
        <button
          className="ectx-item"
          disabled={!hasSelection}
          onClick={() => {
            onRunSelection();
            onClose();
          }}
        >
          <Play size={14} /> {t("runSelection")}
        </button>

        <div className="ectx-sep" />

        <div
          className={`ectx-item has-sub${subFlip.x ? " flip-x" : ""}${subFlip.y ? " flip-y" : ""}`}
          onMouseEnter={(e) => placeSubmenu(e.currentTarget)}
        >
          <Sparkles size={14} style={{ color: "var(--accent)" }} /> AI
          <ChevronRight size={14} className="ectx-caret" />
          <div className="ectx-submenu">
            {aiActions.map((a) => (
              <button key={a.id} className="ectx-item" onClick={() => pick(a.id)}>
                <a.icon size={14} /> {a.label}
              </button>
            ))}
            <div className="ectx-sep" />
            <button className="ectx-item" onClick={() => pick("ask")}>
              <CornerDownLeft size={14} /> {t("askAi")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
