import type { ReactNode, RefObject } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  ArrowLeftRight,
  Bold,
  BringToFront,
  ClipboardPaste,
  Copy,
  Paintbrush,
  Pencil,
  Scissors,
  SendToBack,
  Spline,
  Split,
  Trash2,
} from "lucide-react";
import {
  ARROWS,
  DRAWN_SHAPES,
  FILLS,
  FILL_LABEL,
  FLOW_LABEL,
  FLOW_SPEEDS,
  FLOW_SPEED_LABEL,
  FLOW_STYLES,
  FONT_SIZES,
  LINE_LABEL,
  LINE_TYPES,
  LINE_WIDTHS,
  SHAPE_LABEL,
  type AlignKind,
  type ArrowKind,
  type CanvasEdge,
  type CanvasNode,
  type FillKind,
  type FlowStyle,
  type Point,
  type ShapeKind,
} from "./canvasModel";
import type { FlowEdge, FlowNode, NodeStyle } from "./canvasFlow";
import { Seg, Swatches, TextColorPicker } from "./CanvasControls";

const ALIGN_ICON: Record<AlignKind, [ReactNode, string]> = {
  left: [<AlignStartVertical size={14} />, "左对齐"],
  hcenter: [<AlignCenterVertical size={14} />, "水平居中"],
  right: [<AlignEndVertical size={14} />, "右对齐"],
  top: [<AlignStartHorizontal size={14} />, "顶对齐"],
  vmiddle: [<AlignCenterHorizontal size={14} />, "垂直居中"],
  bottom: [<AlignEndHorizontal size={14} />, "底对齐"],
};

export interface CanvasPropertyBarProps {
  selNodes: FlowNode[];
  selEdges: FlowEdge[];
  painter: NodeStyle | null;
  lastFlow: Pick<CanvasEdge, "flowStyle" | "flowSpeed" | "flowColor">;
  labelInputRef: RefObject<HTMLInputElement | null>;
  onPatchNodes: (patch: Partial<CanvasNode>) => void;
  onPatchEdges: (patch: Partial<CanvasEdge>) => void;
  onPatchFlow: (patch: Pick<CanvasEdge, "flowStyle" | "flowSpeed" | "flowColor">) => void;
  onStartEdit: (id: string) => void;
  onTogglePainter: () => void;
  onAlign: (mode: AlignKind) => void;
  onDistribute: (axis: "h" | "v") => void;
  onDuplicate: () => void;
  onReverseEdges: () => void;
  onSplitEdge: (edgeId: string, at?: Point) => void;
  onDelete: () => void;
}

export function CanvasPropertyBar({
  selNodes,
  selEdges,
  painter,
  lastFlow,
  labelInputRef,
  onPatchNodes,
  onPatchEdges,
  onPatchFlow,
  onStartEdit,
  onTogglePainter,
  onAlign,
  onDistribute,
  onDuplicate,
  onReverseEdges,
  onSplitEdge,
  onDelete,
}: CanvasPropertyBarProps) {
  const one = selNodes[0]?.data;
  const onlyJunctions = selNodes.length > 0 && selNodes.every((n) => n.data.shape === "junction");
  const oneEdge = selEdges[0]?.data as CanvasEdge | undefined;

  return (
    <div className="cv-props" onMouseDown={(e) => e.stopPropagation()}>
      {onlyJunctions && one && (
        <>
          <span className="cv-props-label">{selNodes.length > 1 ? `${selNodes.length} 个分叉点` : "分叉点"}</span>
          <Swatches value={one.color} onPick={(color) => onPatchNodes({ color })} />
          <span className="cv-props-tip">拖圆点挪位置 · 从四周的小圆圈拖出新分支</span>
        </>
      )}
      {selNodes.length > 0 && one && !onlyJunctions && (
        <>
          <span className="cv-props-label">{selNodes.length > 1 ? `${selNodes.length} 个形状` : SHAPE_LABEL[one.shape]}</span>
          <Swatches value={one.color} onPick={(color) => onPatchNodes({ color })} />
          <span className="cv-sep" />
          <Seg
            value={one.fill ?? "soft"}
            options={FILLS}
            labels={FILL_LABEL}
            onPick={(fill: FillKind) => onPatchNodes({ fill: fill === "soft" ? undefined : fill })}
          />
          <button className={`btn xs ${one.dashed ? "on" : ""}`} onClick={() => onPatchNodes({ dashed: !one.dashed || undefined })} title="边框画成虚线">
            虚线框
          </button>
          <select className="cv-select" value={one.shape} onChange={(e) => onPatchNodes({ shape: e.target.value as ShapeKind })} title="形状">
            {DRAWN_SHAPES.map((s) => (
              <option key={s} value={s}>
                {SHAPE_LABEL[s]}
              </option>
            ))}
          </select>
          <select className="cv-select" value={one.fontSize} onChange={(e) => onPatchNodes({ fontSize: Number(e.target.value) })} title="字号">
            {FONT_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}px
              </option>
            ))}
          </select>
          <button className={`icon-btn ${one.bold ? "on" : ""}`} title="加粗" onClick={() => onPatchNodes({ bold: !one.bold })}>
            <Bold size={14} />
          </button>
          {selNodes.length === 1 && (
            <button className="icon-btn" title="改文字 (回车 / 双击)" onClick={() => onStartEdit(selNodes[0].id)}>
              <Pencil size={14} />
            </button>
          )}
          <button
            className={`icon-btn ${painter ? "on" : ""}`}
            title="格式刷 (⌥⌘C):拿起这个样式,再点别的形状就刷上;Esc 放下"
            onClick={onTogglePainter}
          >
            <Paintbrush size={14} />
          </button>
          {selNodes.length > 1 && (
            <>
              <span className="cv-sep" />
              {(Object.keys(ALIGN_ICON) as AlignKind[]).map((k) => (
                <button key={k} className="icon-btn" title={ALIGN_ICON[k][1]} onClick={() => onAlign(k)}>
                  {ALIGN_ICON[k][0]}
                </button>
              ))}
              <button className="icon-btn" title="横向等距(至少 3 个)" disabled={selNodes.length < 3} onClick={() => onDistribute("h")}>
                <AlignHorizontalDistributeCenter size={14} />
              </button>
              <button className="icon-btn" title="纵向等距(至少 3 个)" disabled={selNodes.length < 3} onClick={() => onDistribute("v")}>
                <AlignVerticalDistributeCenter size={14} />
              </button>
            </>
          )}
          <span className="cv-sep" />
          <button className="icon-btn" title="复制一份 (⌘D)" onClick={onDuplicate}>
            <Copy size={14} />
          </button>
        </>
      )}
      {selNodes.length === 0 && oneEdge && (
        <>
          <span className="cv-props-label">{selEdges.length > 1 ? `${selEdges.length} 条连线` : "连线"}</span>
          <Swatches value={oneEdge.color} onPick={(color) => onPatchEdges({ color })} />
          <span className="cv-sep" />
          <Seg value={oneEdge.line} options={LINE_TYPES} labels={LINE_LABEL} onPick={(line) => onPatchEdges({ line })} />
          <Seg
            value={String(oneEdge.width ?? 1)}
            options={LINE_WIDTHS.map(String)}
            labels={{ 1: "细", 2: "中", 3: "粗" }}
            onPick={(w) => onPatchEdges({ width: Number(w) === 1 ? undefined : Number(w) })}
          />
          <Seg<(typeof ARROWS)[number]>
            value={oneEdge.arrow as (typeof ARROWS)[number]}
            options={ARROWS}
            labels={{ end: "单向", both: "双向", none: "无箭头" }}
            onPick={(arrow: ArrowKind) => onPatchEdges({ arrow })}
          />
          <button className={`btn xs ${oneEdge.dashed ? "on" : ""}`} onClick={() => onPatchEdges({ dashed: !oneEdge.dashed })}>
            虚线
          </button>
          <button
            className={`btn xs ${oneEdge.flow ? "on" : ""}`}
            title="让线动起来,表示数据从这儿流过"
            onClick={() =>
              onPatchEdges(
                oneEdge.flow
                  ? { flow: false }
                  : {
                      flow: true,
                      flowStyle: oneEdge.flowStyle ?? lastFlow.flowStyle,
                      flowSpeed: oneEdge.flowSpeed ?? lastFlow.flowSpeed,
                      flowColor: oneEdge.flowColor ?? lastFlow.flowColor,
                    },
              )
            }
          >
            流动
          </button>
          <button className="icon-btn" title="反转方向" onClick={onReverseEdges}>
            <ArrowLeftRight size={14} />
          </button>
          {selEdges.length === 1 && (
            <button
              className="icon-btn"
              title="分叉:在线中间放一个分叉点,从它拖出更多分支(右键线上某一点 →「在这里分叉」可以指定位置)"
              onClick={() => onSplitEdge(selEdges[0].id)}
            >
              <Split size={14} />
            </button>
          )}
          {selEdges.length === 1 && (
            <input
              key={oneEdge.id}
              ref={labelInputRef}
              className="cv-label-input"
              placeholder="线上的文字(双击线也能改)"
              defaultValue={oneEdge.label}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
              }}
              onBlur={(e) => {
                if (e.target.value !== oneEdge.label) onPatchEdges({ label: e.target.value });
              }}
            />
          )}
        </>
      )}
      <button className="icon-btn danger" title="删除 (Delete)" onClick={onDelete}>
        <Trash2 size={14} />
      </button>
      {selNodes.length === 0 && oneEdge?.flow && (
        <div className="cv-props-row">
          <span className="cv-props-label">流动</span>
          <Seg
            value={oneEdge.flowStyle ?? "dash"}
            options={FLOW_STYLES}
            labels={FLOW_LABEL}
            onPick={(flowStyle: FlowStyle) => onPatchFlow({ flowStyle: flowStyle === "dash" ? undefined : flowStyle })}
          />
          <Seg
            value={String(oneEdge.flowSpeed ?? 2)}
            options={FLOW_SPEEDS.map(String)}
            labels={FLOW_SPEED_LABEL}
            onPick={(v) => onPatchFlow({ flowSpeed: Number(v) === 2 ? undefined : Number(v) })}
          />
          <button className={`btn xs ${oneEdge.flowColor ? "" : "on"}`} title="流动用线本身的颜色" onClick={() => onPatchFlow({ flowColor: undefined })}>
            同线色
          </button>
          <Swatches value={oneEdge.flowColor ?? null} onPick={(flowColor) => onPatchFlow({ flowColor })} />
        </div>
      )}
      {selNodes.length > 0 && one && !onlyJunctions && (
        <div className="cv-props-row">
          <span className="cv-props-label">文字颜色</span>
          <TextColorPicker value={one.textColor} onPick={(textColor) => onPatchNodes({ textColor })} />
        </div>
      )}
    </div>
  );
}

export function CanvasContextMenu({
  menu,
  selNodesCount,
  selEdges,
  hasClipboard,
  onClose,
  onEditNode,
  onCopy,
  onCut,
  onPaste,
  onDuplicate,
  onPickStyle,
  onRestack,
  onFocusEdgeLabel,
  onSplitEdgeAt,
  onReverseEdges,
  onResetBend,
  onDelete,
}: {
  menu: { x: number; y: number; kind: "node" | "edge"; at: Point };
  selNodesCount: number;
  selEdges: FlowEdge[];
  hasClipboard: boolean;
  onClose: () => void;
  onEditNode: () => void;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onDuplicate: () => void;
  onPickStyle: () => void;
  onRestack: (dir: "front" | "back") => void;
  onFocusEdgeLabel: () => void;
  onSplitEdgeAt: () => void;
  onReverseEdges: () => void;
  onResetBend: () => void;
  onDelete: () => void;
}) {
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <div
      className="cv-ctx"
      style={{ left: menu.x, top: menu.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.kind === "node" ? (
        <>
          {selNodesCount === 1 && (
            <button onClick={run(onEditNode)}>
              <Pencil size={13} /> 改文字<kbd>↩</kbd>
            </button>
          )}
          <button onClick={run(onCopy)}>
            <Copy size={13} /> 复制<kbd>⌘C</kbd>
          </button>
          <button onClick={run(onCut)}>
            <Scissors size={13} /> 剪切<kbd>⌘X</kbd>
          </button>
          <button disabled={!hasClipboard} onClick={run(onPaste)}>
            <ClipboardPaste size={13} /> 粘贴<kbd>⌘V</kbd>
          </button>
          <button onClick={run(onDuplicate)}>
            <Copy size={13} /> 原地复制一份<kbd>⌘D</kbd>
          </button>
          <hr />
          <button onClick={run(onPickStyle)}>
            <Paintbrush size={13} /> 格式刷<kbd>⌥⌘C</kbd>
          </button>
          <button onClick={run(() => onRestack("front"))}>
            <BringToFront size={13} /> 置于顶层
          </button>
          <button onClick={run(() => onRestack("back"))}>
            <SendToBack size={13} /> 置于底层
          </button>
          <hr />
          <button className="danger" onClick={run(onDelete)}>
            <Trash2 size={13} /> 删除<kbd>⌫</kbd>
          </button>
        </>
      ) : (
        <>
          <button onClick={run(onFocusEdgeLabel)}>
            <Pencil size={13} /> 改线上的文字
          </button>
          {selEdges.length === 1 && (
            <button onClick={run(onSplitEdgeAt)}>
              <Split size={13} /> 在这里分叉
            </button>
          )}
          <button onClick={run(onReverseEdges)}>
            <ArrowLeftRight size={13} /> 反转方向
          </button>
          {selEdges.some((e) => e.data?.bend) && (
            <button onClick={run(onResetBend)}>
              <Spline size={13} /> 恢复默认弧度
            </button>
          )}
          <hr />
          <button className="danger" onClick={run(onDelete)}>
            <Trash2 size={13} /> 删除<kbd>⌫</kbd>
          </button>
        </>
      )}
    </div>
  );
}
