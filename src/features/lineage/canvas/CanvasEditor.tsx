/* 链路画布编辑器:在血缘里自己画链路。
 *
 * 画布库用 React Flow(拖动、缩放、连线、框选、改大小都现成)。
 * 这里只管:形状长什么样、改动怎么进撤销栈、什么时候算「未保存」、怎么存。
 * 对齐 / 等距 / 自动排版 / 吸附 / 分层上色这些「算位置、算颜色」的事都在 canvasModel 里(纯函数,有测试),
 * 导出图片在 canvasExport 里。
 *
 * 状态以 React Flow 的 nodes/edges 为准(选中、拖动都在它身上),
 * 存盘、撤销时换算成 canvasModel 里的纯数据。 */
import "@xyflow/react/dist/style.css";
import "./canvas.css";
import {
  createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, BaseEdge, Controls, EdgeText, MiniMap, Handle, Position,
  NodeResizer, MarkerType, ConnectionMode, SelectionMode, ViewportPortal, applyNodeChanges, applyEdgeChanges,
  reconnectEdge, useReactFlow, useViewport,
  type Node, type Edge, type EdgeProps, type NodeProps, type NodeChange, type EdgeChange, type Connection, type FinalConnectionState,
} from "@xyflow/react";
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter,
  AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, ArrowLeft, ArrowLeftRight, Bold,
  BringToFront, ChevronDown, ClipboardPaste, Copy, Database, Download, GitFork, ImageDown, Network, Paintbrush,
  Palette, Pencil, Plus, Redo2, Save, Scissors, Search, SendToBack, Trash2, Undo2, Link2,
} from "lucide-react";
import { useApp } from "../../../store/appStore";
import { useConfirm } from "../../../components/useConfirm";
import { api } from "../../../lib/api";
import { inTauri } from "../../../lib/mockBackend";
import type { Graph } from "../lineageModel";
import {
  ARROWS, COLOR_LABEL, COLOR_VALUE, DASH_PX_PER_S, FILLS, FILL_LABEL, FLOW_LABEL, FLOW_SPEEDS, FLOW_SPEED_LABEL, FLOW_STYLES,
  FONT_SIZES, PULSE_SECONDS, cometLength, dotCount, travelSeconds, LAYOUT_DIRS, LAYOUT_LABEL, LINE_LABEL, LINE_TYPES,
  LINE_WIDTHS, PALETTE_ORDER, SHAPES, SHAPE_LABEL, STROKE_PX,
  alignBoxes, autoLayout, contentKey, hi, lo, distributeBoxes, duplicate, facingSides, findFreeSpot, fromLineage, layerColor,
  markerSize, newCanvas, newEdge, newNode, nextName, snapToGuides,
  type AlignKind, type ArrowKind, type Box, type CanvasDoc, type CanvasEdge, type CanvasNode, type ColorKey,
  type FillKind, type FlowStyle, type Guide, type LayoutDir, type LineType, type Pos, type ShapeKind,
} from "./canvasModel";
import { blobToBase64, canvasMeasure, canvasToSvg, linePath, svgToPng } from "./canvasExport";
import { canvasRepository } from "./canvasRepository";

type ShapeData = CanvasNode & Record<string, unknown>;
type EdgeData = CanvasEdge & Record<string, unknown>;
type FlowNode = Node<ShapeData, "shape">;
type FlowEdge = Edge<EdgeData>;
type Side = "top" | "right" | "bottom" | "left";

/* ---------- 纯数据 <-> 画布对象 ---------- */
// 分组框垫在最底下,不挡住框里的东西;其余按叠放次序
const zOf = (n: Pick<CanvasNode, "shape" | "z">) => (n.shape === "group" ? -1000 : 0) + (n.z ?? 0);
const toFlowNode = (n: CanvasNode): FlowNode => ({
  id: n.id, type: "shape", position: { x: n.x, y: n.y }, width: n.w, height: n.h,
  data: { ...n } as ShapeData,
  zIndex: zOf(n),
});
const fromFlowNode = (n: FlowNode): CanvasNode => {
  const { x: _x, y: _y, w: _w, h: _h, ...rest } = n.data;
  void _x; void _y; void _w; void _h;
  return {
    ...(rest as Omit<CanvasNode, "x" | "y" | "w" | "h">),
    x: Math.round(n.position.x), y: Math.round(n.position.y),
    w: Math.round(n.width ?? n.measured?.width ?? 120), h: Math.round(n.height ?? n.measured?.height ?? 48),
  };
};
const boxOf = (n: FlowNode): Box => ({
  id: n.id, x: n.position.x, y: n.position.y,
  w: n.width ?? n.measured?.width ?? 120, h: n.height ?? n.measured?.height ?? 48,
});
const EDGE_TYPE: Record<LineType, string> = { smooth: "default", step: "smoothstep", sharp: "step", straight: "straight" };
const toFlowEdge = (e: CanvasEdge, selected = false): FlowEdge => {
  const color = COLOR_VALUE[e.color];
  const sw = (STROKE_PX[e.width ?? 1] ?? 1.6) + (selected ? 0.8 : 0);
  const size = markerSize(sw);
  const marker = { type: MarkerType.ArrowClosed, color, width: size, height: size };
  return {
    id: e.id, source: e.from, target: e.to, sourceHandle: e.fromHandle, targetHandle: e.toHandle,
    // 流动的线走自己的画法(光点、彗星、呼吸),不流动的用 React Flow 自带的
    type: e.flow ? "flowfx" : EDGE_TYPE[e.line], label: e.label || undefined, selected,
    data: { ...e } as EdgeData,
    style: { stroke: color, strokeWidth: sw, strokeDasharray: e.dashed ? "6 4" : undefined },
    markerEnd: e.arrow === "none" ? undefined : marker,
    markerStart: e.arrow === "both" ? marker : undefined,
    labelStyle: { fill: "var(--text-2)", fontSize: 12, fontWeight: 500 },
    labelBgStyle: { fill: "var(--surface)", stroke: "var(--border-2)", strokeWidth: 1 },
    labelBgPadding: [7, 4],
    labelBgBorderRadius: 5,
  };
};
const fromFlowEdge = (e: FlowEdge): CanvasEdge => ({
  ...(e.data as CanvasEdge), from: e.source, to: e.target,
  fromHandle: e.sourceHandle ?? undefined, toHandle: e.targetHandle ?? undefined,
});

/* 剪贴板放在模块里:在一张画布 ⌘C,换到另一张画布 ⌘V 也能贴 */
let clipboard: { docId: string; nodes: CanvasNode[]; edges: CanvasEdge[]; pastes: number } | null = null;
/* 格式刷带走的样式 */
type NodeStyle = Pick<CanvasNode, "color" | "fill" | "dashed" | "fontSize" | "bold">;
const styleOf = (n: CanvasNode): NodeStyle => ({ color: n.color, fill: n.fill, dashed: n.dashed, fontSize: n.fontSize, bold: n.bold });

/* ---------- 形状节点 ---------- */
interface ShapeCtx {
  editingId: string | null;
  startEdit: (id: string) => void;
  commitText: (id: string, text: string) => void;
  cancelEdit: () => void;
  beginChange: () => void;
}
const Ctx = createContext<ShapeCtx | null>(null);

function ShapeOutline({ shape }: { shape: ShapeKind }) {
  if (shape === "diamond")
    return <svg className="cv-svg" viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points="50,1.5 98.5,50 50,98.5 1.5,50" vectorEffect="non-scaling-stroke" /></svg>;
  if (shape === "cylinder")
    return (
      <svg className="cv-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        <path d="M1.5,13 A48.5,11.5 0 0 1 98.5,13 V87 A48.5,11.5 0 0 1 1.5,87 Z" vectorEffect="non-scaling-stroke" />
        <path className="cv-svg-rim" d="M1.5,13 A48.5,11.5 0 0 0 98.5,13" vectorEffect="non-scaling-stroke" />
      </svg>
    );
  return null;
}

const ShapeNode = memo(function ShapeNode({ id, data, selected }: NodeProps<FlowNode>) {
  const ctx = useContext(Ctx)!;
  const editing = ctx.editingId === id;
  const [draft, setDraft] = useState(data.text);
  useEffect(() => { if (editing) setDraft(data.text); }, [editing, data.text]);
  const style = { "--c": COLOR_VALUE[data.color], fontSize: data.fontSize, fontWeight: data.bold ? 650 : undefined } as CSSProperties;
  const cls = [
    "cv-node", `cv-${data.shape}`, `cv-fill-${data.fill ?? "soft"}`,
    data.dashed ? "cv-dashed" : "", selected ? "is-selected" : "",
  ].filter(Boolean).join(" ");
  return (
    <div className={cls} style={style} onDoubleClick={() => ctx.startEdit(id)}>
      <NodeResizer isVisible={selected && !editing} minWidth={40} minHeight={24} onResizeStart={ctx.beginChange}
        lineClassName="cv-resize-line" handleClassName="cv-resize-handle" />
      <ShapeOutline shape={data.shape} />
      {(["top", "right", "bottom", "left"] as const).map((side) => (
        <Handle key={side} id={side} type="source" className="cv-handle"
          position={{ top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left }[side]} />
      ))}
      {data.ref && <span className="cv-ref" title={`来自血缘:${data.ref}`}><Link2 size={11} /></span>}
      {editing ? (
        <textarea
          className="cv-edit nodrag nowheel nopan"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => ctx.commitText(id, draft)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") ctx.cancelEdit();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); ctx.commitText(id, draft); }
          }}
        />
      ) : (
        <span className="cv-label">{data.text}</span>
      )}
    </div>
  );
});
const nodeTypes = { shape: ShapeNode };

/* ---------- 流动的线 ----------
   底下照常是一根线(带箭头、标签、点击区域),上面叠一层动效:
   · 虚线:线本身变成虚线往前走;
   · 光点:几个带光晕的小圆点沿线跑(SVG 的 animateMotion,跟着线的形状拐弯);
   · 彗星:一段亮头 + 渐隐的拖尾沿线划过;
   · 呼吸:整根线外面一圈光,一明一暗。
   动效都按线的实际长度算时长,长线短线看起来流速一样。动效层不接鼠标,点线还是点在底下那根上。 */
const FlowFxEdge = memo(function FlowFxEdge(props: EdgeProps<FlowEdge>) {
  const { id, data, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, markerStart,
    label, labelStyle, labelBgStyle, labelBgPadding, labelBgBorderRadius, interactionWidth } = props;
  const e = data as CanvasEdge;
  const [path, labelX, labelY] = linePath(e.line, { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const measureRef = useRef<SVGPathElement>(null);
  const [len, setLen] = useState(0);
  // 线一变形就重量长度;差得不多就不动,免得拖动时每一帧都重设动画
  useLayoutEffect(() => {
    const l = measureRef.current?.getTotalLength() ?? 0;
    if (Math.abs(l - len) > 6) setLen(l);
  }, [path, len]);
  const kind: FlowStyle = e.flowStyle ?? "dash";
  const speed = e.flowSpeed ?? 2;
  const fc = COLOR_VALUE[e.flowColor ?? e.color];
  const sw = Number((style as CSSProperties | undefined)?.strokeWidth ?? 1.6);
  const base: CSSProperties = { ...style };
  if (kind === "dash") {
    // 虚线一格 11px(6 实 5 空),一秒走 DASH_PX_PER_S 像素
    Object.assign(base, { strokeDasharray: "6 5", animation: `cv-flow-dash ${(11 / DASH_PX_PER_S[speed]).toFixed(3)}s linear infinite` });
    if (e.flowColor) base.stroke = fc;
  }
  const pid = `cvf-${id}`;
  let fx: ReactNode = null;
  if (len > 1 && kind === "dot") {
    const dur = Number(travelSeconds(len, speed).toFixed(3));
    const n = dotCount(len);
    const r = sw * 0.9 + 1.4;
    fx = Array.from({ length: n }, (_, i) => (
      <g key={i}>
        <circle r={r * 2.6} fill={fc} opacity={0.22}>
          <animateMotion dur={`${dur}s`} repeatCount="indefinite" begin={`${(-i * dur / n).toFixed(3)}s`}><mpath href={`#${pid}`} /></animateMotion>
        </circle>
        <circle r={r} fill={fc}>
          <animateMotion dur={`${dur}s`} repeatCount="indefinite" begin={`${(-i * dur / n).toFixed(3)}s`}><mpath href={`#${pid}`} /></animateMotion>
        </circle>
        <circle r={r * 0.45} fill="#fff" opacity={0.85}>
          <animateMotion dur={`${dur}s`} repeatCount="indefinite" begin={`${(-i * dur / n).toFixed(3)}s`}><mpath href={`#${pid}`} /></animateMotion>
        </circle>
      </g>
    ));
  }
  if (len > 1 && kind === "comet") {
    const c = cometLength(len);
    const head = c * 0.3;
    const dur = `${travelSeconds(len + c, speed).toFixed(3)}s`;
    // 一段长 c 的实线、后面空出整根线那么长:一次只露一颗彗星。dashoffset 从 c 走到 -len,正好从起点外划到终点外
    const seg = (w: number, length: number, opacity: number, from: number, to: number, color = fc) => (
      <path d={path} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" opacity={opacity} strokeDasharray={`${length} ${len + c}`}>
        <animate attributeName="stroke-dashoffset" from={from} to={to} dur={dur} repeatCount="indefinite" />
      </path>
    );
    fx = <>
      {seg(sw + 7, c, 0.12, c, -len)}
      {seg(sw + 2.5, c, 0.45, c, -len)}
      {seg(sw + 3, head, 0.95, head, -len - (c - head))}
      {seg(Math.max(1, sw * 0.6), head * 0.6, 0.9, head * 0.6, -len - (c - head * 0.6), "#fff")}
    </>;
  }
  if (kind === "pulse") {
    const dur = `${PULSE_SECONDS[speed]}s`;
    fx = <>
      <path d={path} fill="none" stroke={fc} strokeWidth={sw + 8} strokeLinecap="round" opacity={0}>
        <animate attributeName="opacity" values="0;0.28;0" dur={dur} repeatCount="indefinite" />
      </path>
      <path d={path} fill="none" stroke={fc} strokeWidth={sw + 2.5} strokeLinecap="round" opacity={0}>
        <animate attributeName="opacity" values="0;0.7;0" dur={dur} repeatCount="indefinite" />
      </path>
    </>;
  }
  return (
    <>
      <BaseEdge id={id} path={path} style={base} markerEnd={markerEnd} markerStart={markerStart} interactionWidth={interactionWidth} />
      <path ref={measureRef} id={pid} d={path} fill="none" stroke="none" />
      {fx && <g className="cv-flowfx" pointerEvents="none">{fx}</g>}
      {/* 文字最后画,光点、彗星从底下穿过去,不会盖住字 */}
      {label && <EdgeText x={labelX} y={labelY} label={label} labelStyle={labelStyle} labelBgStyle={labelBgStyle}
        labelBgPadding={labelBgPadding} labelBgBorderRadius={labelBgBorderRadius} />}
    </>
  );
});
const edgeTypes = { flowfx: FlowFxEdge };

/* 拖动时的对齐参考线(画在画布坐标里,线宽按缩放反算,永远是 1 像素) */
function GuideLines({ guides }: { guides: Guide[] }) {
  const { zoom } = useViewport();
  if (!guides.length) return null;
  const t = 1 / zoom;
  return (
    <ViewportPortal>
      {guides.map((g, i) => (
        <div key={i} className="cv-guide" style={g.axis === "x"
          ? { left: g.at - t / 2, top: g.from - 12, width: t, height: g.to - g.from + 24 }
          : { top: g.at - t / 2, left: g.from - 12, height: t, width: g.to - g.from + 24 }} />
      ))}
    </ViewportPortal>
  );
}

/* ---------- 形状图标(左侧工具栏用) ---------- */
function ShapeIcon({ shape }: { shape: ShapeKind }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.6 };
  return (
    <svg width="22" height="16" viewBox="0 0 22 16" aria-hidden>
      {shape === "rect" && <rect x="2" y="2" width="18" height="12" rx="1" {...common} />}
      {shape === "rounded" && <rect x="2" y="2" width="18" height="12" rx="4" {...common} />}
      {shape === "pill" && <rect x="2" y="3" width="18" height="10" rx="5" {...common} />}
      {shape === "ellipse" && <ellipse cx="11" cy="8" rx="9" ry="6" {...common} />}
      {shape === "diamond" && <polygon points="11,1.5 20.5,8 11,14.5 1.5,8" {...common} />}
      {shape === "cylinder" && <><path d="M4,4 A7,2.4 0 0 1 18,4 V12 A7,2.4 0 0 1 4,12 Z" {...common} /><path d="M4,4 A7,2.4 0 0 0 18,4" {...common} /></>}
      {shape === "note" && <path d="M3,2 H19 V10 L15,14 H3 Z M15,14 V10 H19" {...common} />}
      {shape === "text" && <path d="M5,3 H17 M11,3 V13" {...common} />}
      {shape === "group" && <rect x="2" y="2" width="18" height="12" rx="2" strokeDasharray="3 2" {...common} />}
    </svg>
  );
}

/* 顶栏上的下拉菜单 */
function Menu({ label, icon, title, children }: { label: string; icon: ReactNode; title?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as globalThis.Node)) setOpen(false); };
    window.addEventListener("mousedown", off);
    return () => window.removeEventListener("mousedown", off);
  }, [open]);
  return (
    <div className="cv-menu-wrap" ref={ref}>
      <button className={`btn sm ${open ? "on" : ""}`} title={title} onClick={() => setOpen((v) => !v)}>{icon} {label} <ChevronDown size={12} /></button>
      {open && <div className="cv-menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

/* ---------- 历史(撤销/重做) ---------- */
interface Snapshot { nodes: CanvasNode[]; edges: CanvasEdge[]; }
const HISTORY_LIMIT = 100;
const ALIGN_ICON: Record<AlignKind, [ReactNode, string]> = {
  left: [<AlignStartVertical size={14} />, "左对齐"], hcenter: [<AlignCenterVertical size={14} />, "水平居中"],
  right: [<AlignEndVertical size={14} />, "右对齐"], top: [<AlignStartHorizontal size={14} />, "顶对齐"],
  vmiddle: [<AlignCenterHorizontal size={14} />, "垂直居中"], bottom: [<AlignEndHorizontal size={14} />, "底对齐"],
};

function Editor({ doc, graph, onSave, onDirty }: {
  doc: CanvasDoc;
  graph: Graph;
  onSave: (nodes: CanvasNode[], edges: CanvasEdge[]) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const flow = useReactFlow<FlowNode, FlowEdge>();
  const wrapRef = useRef<HTMLDivElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const theme = useApp((s) => s.theme);
  const toast = useApp((s) => s.showToast);
  const [nodes, setNodes] = useState<FlowNode[]>(() => doc.nodes.map(toFlowNode));
  const [edges, setEdges] = useState<FlowEdge[]>(() => doc.edges.map((e) => toFlowEdge(e)));
  const [editingId, setEditingId] = useState<string | null>(null);
  /* 撤销栈放在 ref 里(改动不该触发重渲染),只用一个计数让按钮的可用状态跟着变 */
  const pastRef = useRef<Snapshot[]>([]);
  const futureRef = useRef<Snapshot[]>([]);
  const [, setHistoryTick] = useState(0);
  const bump = () => setHistoryTick((t) => t + 1);
  // 用「换算过一遍」的数据算基准,字段顺序和后面比较时一致,刚打开不会误报「未保存」
  const [savedKey, setSavedKey] = useState(() => contentKey({
    name: "", nodes: doc.nodes.map((n) => fromFlowNode(toFlowNode(n))), edges: doc.edges.map((e) => fromFlowEdge(toFlowEdge(e))),
  }));
  /** 新连线用上一次改过的线型 / 颜色 / 粗细 / 箭头,连一串线不用每根都改 */
  const [edgeStyle, setEdgeStyle] = useState<Pick<CanvasEdge, "line" | "color" | "width" | "arrow">>({ line: "smooth", color: "gray", width: 1, arrow: "end" });
  const [picker, setPicker] = useState(false);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [painter, setPainter] = useState<NodeStyle | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: "node" | "edge" } | null>(null);
  const nudgeAt = useRef(0);
  /** 上一次挑的流动效果:给下一根打开「流动」的线直接用上 */
  const lastFlow = useRef<Pick<CanvasEdge, "flowStyle" | "flowSpeed" | "flowColor">>({});
  /** 正在拖线的一头改连:这时松在空白处什么都不做(React Flow 也会走 onConnectEnd) */
  const reconnecting = useRef(false);

  const nodesRef = useRef(nodes); nodesRef.current = nodes;
  const edgesRef = useRef(edges); edgesRef.current = edges;

  const snapshot = useCallback((): Snapshot => ({
    nodes: nodesRef.current.map(fromFlowNode), edges: edgesRef.current.map(fromFlowEdge),
  }), []);
  /** 改动之前调一次:把「改之前」压进撤销栈,清空重做栈。 */
  const beginChange = useCallback(() => {
    pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), snapshot()];
    futureRef.current = [];
    bump();
  }, [snapshot]);
  const restore = useCallback((snap: Snapshot) => {
    setEditingId(null);
    setNodes(snap.nodes.map(toFlowNode));
    setEdges(snap.edges.map((e) => toFlowEdge(e)));
  }, []);
  const undo = useCallback(() => {
    const prev = pastRef.current[pastRef.current.length - 1];
    if (!prev) return;
    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [...futureRef.current, snapshot()];
    restore(prev);
    bump();
  }, [restore, snapshot]);
  const redo = useCallback(() => {
    const next = futureRef.current[futureRef.current.length - 1];
    if (!next) return;
    futureRef.current = futureRef.current.slice(0, -1);
    pastRef.current = [...pastRef.current, snapshot()];
    restore(next);
    bump();
  }, [restore, snapshot]);

  const currentKey = useMemo(
    () => contentKey({ name: "", nodes: nodes.map(fromFlowNode), edges: edges.map(fromFlowEdge) }),
    [nodes, edges],
  );
  const dirty = currentKey !== savedKey;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);

  const save = useCallback(() => {
    const snap = snapshot();
    onSave(snap.nodes, snap.edges);
    setSavedKey(contentKey({ name: "", ...snap }));
  }, [onSave, snapshot]);

  /* ---------- React Flow 回调 ---------- */
  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    // 只拖一个形状时,靠近别的形状的边 / 中线就吸过去,并画参考线(拖一批时不吸,免得整批乱跳)
    const moving = changes.filter((c): c is NodeChange<FlowNode> & { type: "position" } => c.type === "position" && !!c.dragging && !!c.position);
    if (moving.length === 1) {
      const c = moving[0];
      const me = nodesRef.current.find((n) => n.id === c.id);
      if (me && c.position) {
        const b = boxOf(me);
        const others = nodesRef.current.filter((n) => n.id !== me.id).map(boxOf);
        const r = snapToGuides({ x: c.position.x, y: c.position.y, w: b.w, h: b.h }, others, 6 / flow.getZoom());
        c.position = { x: r.x, y: r.y };
        setGuides(r.guides);
      }
    } else if (changes.some((c) => c.type === "position" && c.dragging === false)) {
      setGuides([]);
    }
    setNodes((ns) => applyNodeChanges(changes, ns));
  }, [flow]);
  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => {
    setEdges((es) => {
      const next = applyEdgeChanges(changes, es);
      // 选中的线画粗一点,看得出选的是哪根
      return changes.some((c) => c.type === "select") ? next.map((e) => toFlowEdge(e.data as CanvasEdge, !!e.selected)) : next;
    });
  }, []);
  const connect = useCallback((from: string, to: string, fromHandle?: string, toHandle?: string) => {
    const edge = newEdge(from, to, { fromHandle, toHandle, ...edgeStyle });
    setEdges((es) => [...es, toFlowEdge(edge)]);
  }, [edgeStyle]);
  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    beginChange();
    connect(c.source, c.target, c.sourceHandle ?? undefined, c.targetHandle ?? undefined);
  }, [beginChange, connect]);
  /* 从连接点拖出去松在空白处:就地长出一个同样式的形状并连上,接着打字;
     松在别的形状身上(没对准小圆点):直接连到它朝向这边的那条边 */
  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || !state.fromNode || reconnecting.current) return;
    const point = "changedTouches" in event ? event.changedTouches[0] : event;
    if (!point) return;
    const at = flow.screenToFlowPosition({ x: point.clientX, y: point.clientY });
    const src = nodesRef.current.find((n) => n.id === state.fromNode!.id);
    if (!src) return;
    const srcBox = boxOf(src);
    // 松在自己身上(只是手抖拖了一下):不算
    if (at.x >= srcBox.x && at.x <= srcBox.x + srcBox.w && at.y >= srcBox.y && at.y <= srcBox.y + srcBox.h) return;
    const hit = [...nodesRef.current].reverse().find((n) => {
      if (n.id === src.id || n.data.shape === "group") return false;
      const b = boxOf(n);
      return at.x >= b.x && at.x <= b.x + b.w && at.y >= b.y && at.y <= b.y + b.h;
    });
    beginChange();
    if (hit) {
      const sides = facingSides(srcBox, boxOf(hit));
      connect(src.id, hit.id, state.fromHandle?.id ?? sides.fromHandle, sides.toHandle);
      return;
    }
    const base = src.data;
    const shape: ShapeKind = base.shape === "group" || base.shape === "text" || base.shape === "note" ? "rounded" : base.shape;
    const n = newNode(shape, 0, 0, { color: base.color, fill: base.fill, dashed: base.dashed, fontSize: base.fontSize, text: "" });
    n.w = Math.round(srcBox.w); n.h = Math.round(srcBox.h);
    n.x = Math.round((at.x - n.w / 2) / 8) * 8; n.y = Math.round((at.y - n.h / 2) / 8) * 8;
    const sides = facingSides(srcBox, n);
    setNodes((ns) => [...ns.map((x) => x.selected ? { ...x, selected: false } : x), { ...toFlowNode(n), selected: true }]);
    connect(src.id, n.id, state.fromHandle?.id ?? sides.fromHandle, sides.toHandle);
    setEditingId(n.id);
  }, [beginChange, connect, flow]);
  /* 把线的一头拖到别的形状上:改连 */
  const onReconnect = useCallback((old: FlowEdge, c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    beginChange();
    setEdges((es) => reconnectEdge(old, c, es, { shouldReplaceId: false }).map((e) => e.id === old.id ? toFlowEdge(fromFlowEdge(e), !!e.selected) : e));
  }, [beginChange]);

  /* ---------- 文字编辑 ---------- */
  const commitText = useCallback((id: string, text: string) => {
    setEditingId(null);
    const node = nodesRef.current.find((n) => n.id === id);
    if (!node || node.data.text === text) return;
    beginChange();
    setNodes((ns) => ns.map((n) => n.id === id ? { ...n, data: { ...n.data, text } } : n));
  }, [beginChange]);
  const ctx = useMemo<ShapeCtx>(() => ({
    editingId, startEdit: setEditingId, commitText, cancelEdit: () => setEditingId(null), beginChange,
  }), [editingId, commitText, beginChange]);

  /* ---------- 加东西 ---------- */
  const centerPoint = useCallback(() => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, [flow]);
  const addNodes = useCallback((added: CanvasNode[], addedEdges: CanvasEdge[] = []) => {
    if (!added.length && !addedEdges.length) return;
    beginChange();
    const fresh = new Set(added.map((n) => n.id));
    setNodes((ns) => [...ns.map((n) => n.selected ? { ...n, selected: false } : n), ...added.map((n) => ({ ...toFlowNode(n), selected: fresh.has(n.id) }))]);
    if (addedEdges.length) {
      setEdges((es) => {
        const have = new Set(es.map((e) => `${e.source}>${e.target}`));
        return [...es.map((e) => e.selected ? toFlowEdge(e.data as CanvasEdge) : e), ...addedEdges.filter((e) => !have.has(`${e.from}>${e.to}`)).map((e) => toFlowEdge(e))];
      });
    }
  }, [beginChange]);
  const addShape = useCallback((shape: ShapeKind, at?: { x: number; y: number }, edit = false) => {
    const n = newNode(shape, 0, 0);
    if (at) {
      // 拖到哪就放哪(以落点为中心)
      n.x = Math.round((at.x - n.w / 2) / 8) * 8;
      n.y = Math.round((at.y - n.h / 2) / 8) * 8;
    } else {
      // 点一下:放在画面中心附近第一个空位,不压住已有的形状
      const spot = findFreeSpot(nodesRef.current.map(fromFlowNode), n.w, n.h, centerPoint());
      n.x = spot.x; n.y = spot.y;
    }
    addNodes([n]);
    if (edit) setEditingId(n.id);
  }, [addNodes, centerPoint]);
  const onDrop = useCallback((e: ReactDragEvent) => {
    const shape = e.dataTransfer.getData("application/x-sonde-shape") as ShapeKind;
    if (!SHAPES.includes(shape)) return;
    e.preventDefault();
    addShape(shape, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  }, [addShape, flow]);

  /* ---------- 选中项 ---------- */
  const selNodes = nodes.filter((n) => n.selected);
  const selEdges = edges.filter((e) => e.selected);
  const patchNodes = (patch: Partial<CanvasNode>) => {
    beginChange();
    setNodes((ns) => ns.map((n) => {
      if (!n.selected) return n;
      const data = { ...n.data, ...patch };
      return { ...n, data, zIndex: zOf(data) };
    }));
  };
  const patchEdges = (patch: Partial<CanvasEdge>) => {
    beginChange();
    const remembered = (["line", "color", "width", "arrow"] as const).filter((k) => k in patch);
    if (remembered.length) setEdgeStyle((s) => ({ ...s, ...Object.fromEntries(remembered.map((k) => [k, patch[k]])) }));
    setEdges((es) => es.map((e) => e.selected ? toFlowEdge({ ...(e.data as CanvasEdge), ...fromFlowEdge(e), ...patch }, true) : e));
  };
  const patchFlow = (patch: Pick<CanvasEdge, "flowStyle" | "flowSpeed" | "flowColor">) => {
    lastFlow.current = { ...lastFlow.current, ...patch };
    patchEdges(patch);
  };
  /** 一批位置改动(对齐、等距、自动排版)只记一步撤销 */
  const moveNodes = useCallback((pos: Pos, handles?: Map<string, { fromHandle: Side; toHandle: Side }>) => {
    if (!pos.size) return;
    beginChange();
    setNodes((ns) => ns.map((n) => pos.has(n.id) ? { ...n, position: pos.get(n.id)! } : n));
    if (handles?.size) setEdges((es) => es.map((e) => {
      const h = handles.get(e.id);
      return h ? toFlowEdge({ ...fromFlowEdge(e), ...h }, !!e.selected) : e;
    }));
  }, [beginChange]);
  const align = (mode: AlignKind) => moveNodes(alignBoxes(nodesRef.current.filter((n) => n.selected).map(boxOf), mode));
  const distribute = (axis: "h" | "v") => moveNodes(distributeBoxes(nodesRef.current.filter((n) => n.selected).map(boxOf), axis));
  const layout = (dir: LayoutDir) => {
    const sel = nodesRef.current.filter((n) => n.selected);
    const scope = sel.length >= 2 ? sel : nodesRef.current;
    const snap = snapshot();
    const ids = new Set(scope.map((n) => n.id));
    const out = autoLayout(snap.nodes.filter((n) => ids.has(n.id)), snap.edges, dir);
    if (!out.positions.size) { toast({ kind: "info", text: "要有连线的形状才能自动排版" }); return; }
    moveNodes(out.positions, out.handles);
    if (sel.length < 2) window.setTimeout(() => flow.fitView({ padding: 0.2, maxZoom: 1, duration: 300 }), 30);
  };
  const colorByLayer = () => {
    const sel = nodesRef.current.filter((n) => n.selected);
    const scope = new Set((sel.length ? sel : nodesRef.current).map((n) => n.id));
    const hits = nodesRef.current.filter((n) => scope.has(n.id) && n.data.shape !== "text" && layerColor(n.data.text));
    if (!hits.length) { toast({ kind: "info", text: "没有找到 ods / dim / dwd / dws / ads 开头的形状" }); return; }
    beginChange();
    const color = new Map(hits.map((n) => [n.id, layerColor(n.data.text)!]));
    setNodes((ns) => ns.map((n) => color.has(n.id) ? { ...n, data: { ...n.data, color: color.get(n.id)! } } : n));
    toast({ kind: "success", text: `按分层给 ${hits.length} 个形状上了色:ods 灰 · dim 紫 · dwd 蓝 · dws 绿 · ads 橙` });
  };
  const restack = (dir: "front" | "back") => {
    const zs = nodesRef.current.filter((n) => !n.selected).map((n) => n.data.z ?? 0);
    const z = dir === "front" ? hi([0, ...zs]) + 1 : lo([0, ...zs]) - 1;
    patchNodes({ z });
  };
  const reverseEdges = () => {
    beginChange();
    setEdges((es) => es.map((e) => {
      if (!e.selected) return e;
      const d = fromFlowEdge(e);
      return toFlowEdge({ ...d, from: d.to, to: d.from, fromHandle: d.toHandle, toHandle: d.fromHandle }, true);
    }));
  };
  const deleteSelected = useCallback(() => {
    const ns = nodesRef.current.filter((n) => n.selected).map((n) => n.id);
    const es = edgesRef.current.filter((e) => e.selected).map((e) => e.id);
    if (!ns.length && !es.length) return;
    beginChange();
    const gone = new Set(ns);
    setNodes((all) => all.filter((n) => !gone.has(n.id)));
    setEdges((all) => all.filter((e) => !e.selected && !gone.has(e.source) && !gone.has(e.target)));
  }, [beginChange]);
  const duplicateSelected = useCallback(() => {
    const ids = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id));
    if (!ids.size) return;
    const snap = snapshot();
    const copy = duplicate(snap.nodes, snap.edges, ids);
    addNodes(copy.nodes, copy.edges);
  }, [addNodes, snapshot]);
  const copySelected = useCallback(() => {
    const ids = new Set(nodesRef.current.filter((n) => n.selected).map((n) => n.id));
    if (!ids.size) return false;
    const snap = snapshot();
    clipboard = {
      docId: doc.id, pastes: 0,
      nodes: snap.nodes.filter((n) => ids.has(n.id)),
      edges: snap.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
    };
    return true;
  }, [doc.id, snapshot]);
  const paste = useCallback(() => {
    if (!clipboard?.nodes.length) return false;
    clipboard.pastes += 1;
    const all = new Set(clipboard.nodes.map((n) => n.id));
    let copy = duplicate(clipboard.nodes, clipboard.edges, all, 24 * clipboard.pastes);
    if (clipboard.docId !== doc.id) {
      // 贴到另一张画布:整批放到画面正中
      copy = duplicate(clipboard.nodes, clipboard.edges, all, 0);
      const c = centerPoint();
      const minX = lo(copy.nodes.map((n) => n.x)), maxX = hi(copy.nodes.map((n) => n.x + n.w));
      const minY = lo(copy.nodes.map((n) => n.y)), maxY = hi(copy.nodes.map((n) => n.y + n.h));
      const dx = Math.round((c.x - (minX + maxX) / 2) / 8) * 8, dy = Math.round((c.y - (minY + maxY) / 2) / 8) * 8;
      copy.nodes = copy.nodes.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy }));
    }
    addNodes(copy.nodes, copy.edges);
    return true;
  }, [addNodes, centerPoint, doc.id]);
  const nudge = useCallback((dx: number, dy: number) => {
    if (!nodesRef.current.some((n) => n.selected)) return false;
    // 连着按方向键只记一步撤销
    const now = Date.now();
    if (now - nudgeAt.current > 600) beginChange();
    nudgeAt.current = now;
    setNodes((ns) => ns.map((n) => n.selected ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } } : n));
    return true;
  }, [beginChange]);

  /* ---------- 格式刷:拿起选中形状的样式,点别的形状就刷上 ---------- */
  const pickStyle = () => { const one = nodesRef.current.find((n) => n.selected); if (one) setPainter(styleOf(one.data)); };
  const onNodeClick = useCallback((_: ReactMouseEvent, node: FlowNode) => {
    if (!painter) return;
    beginChange();
    setNodes((ns) => ns.map((n) => n.id === node.id ? { ...n, data: { ...n.data, ...painter } } : n));
  }, [beginChange, painter]);

  /* ---------- 导出 ---------- */
  const exportImage = async (kind: "png" | "svg" | "clipboard") => {
    const snap = snapshot();
    const out = canvasToSvg(snap.nodes, snap.edges, canvasMeasure());
    if (!out) { toast({ kind: "info", text: "画布是空的" }); return; }
    try {
      if (kind === "clipboard") {
        const png = svgToPng(out.svg, out.width, out.height);
        await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
        toast({ kind: "success", text: "已复制为图片,可以直接粘贴到 PPT / 微信 / 文档里" });
        return;
      }
      if (!inTauri) throw new Error("浏览器预览里不能存文件,请用桌面版");
      const content = kind === "svg" ? out.svg : await blobToBase64(await svgToPng(out.svg, out.width, out.height));
      const path = await api.saveExport(doc.name || "链路画布", kind, content);
      toast({ kind: "success", text: `已导出到 ${path}` });
    } catch (error) {
      toast({ kind: "error", text: `导出失败:${error instanceof Error ? error.message : String(error)}` });
    }
  };

  /* ---------- 快捷键 ----------
     挂在 window 的捕获阶段并截住:主界面也有 ⌘S(保存 SQL 标签)等快捷键,
     画布开着时这些键归画布。 */
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [contenteditable=true]")) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const step = e.shiftKey ? 16 : 1;
    let handled = true;
    if (mod && key === "z") { if (e.shiftKey) redo(); else undo(); }
    else if (mod && key === "y") redo();
    else if (mod && key === "s") save();
    else if (mod && key === "d") duplicateSelected();
    else if (mod && e.altKey && e.code === "KeyC") pickStyle();   // ⌥ 会把 c 变成 ç,按物理键认
    else if (mod && key === "c") handled = copySelected();
    else if (mod && key === "x") { handled = copySelected(); if (handled) deleteSelected(); }
    else if (mod && key === "v") handled = paste();
    else if (mod && key === "a") setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
    else if (e.key === "ArrowUp" && !mod) handled = nudge(0, -step);
    else if (e.key === "ArrowDown" && !mod) handled = nudge(0, step);
    else if (e.key === "ArrowLeft" && !mod) handled = nudge(-step, 0);
    else if (e.key === "ArrowRight" && !mod) handled = nudge(step, 0);
    else if (e.key === "Escape") {
      if (menu) setMenu(null);
      else if (painter) setPainter(null);
      else if (picker) setPicker(false);
      else handled = false;
    } else if (e.key === "Enter" && !mod) {
      const sel = nodesRef.current.filter((n) => n.selected);
      if (sel.length === 1) setEditingId(sel[0].id); else handled = false;
    } else handled = false;
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  /* 右键菜单:右键的东西没选中就先只选它 */
  const openMenu = (e: ReactMouseEvent, kind: "node" | "edge", id: string) => {
    e.preventDefault();
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (kind === "node" && !nodesRef.current.find((n) => n.id === id)?.selected) {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
      setEdges((es) => es.map((x) => x.selected ? toFlowEdge(x.data as CanvasEdge) : x));
    }
    if (kind === "edge" && !edgesRef.current.find((x) => x.id === id)?.selected) {
      setNodes((ns) => ns.map((n) => n.selected ? { ...n, selected: false } : n));
      setEdges((es) => es.map((x) => toFlowEdge(x.data as CanvasEdge, x.id === id)));
    }
    setMenu({ x: Math.min(e.clientX - rect.left, rect.width - 190), y: Math.min(e.clientY - rect.top, rect.height - 300), kind });
  };
  const run = (fn: () => void) => () => { setMenu(null); fn(); };
  const focusLabel = () => window.setTimeout(() => labelInputRef.current?.focus(), 30);

  const one = selNodes[0]?.data;
  const oneEdge = selEdges[0]?.data as CanvasEdge | undefined;

  return (
    <Ctx.Provider value={ctx}>
      <div className="cv-editor">
        <div className="cv-topbar">
          <button className="btn sm" onClick={undo} disabled={!pastRef.current.length} title="撤销 (⌘Z)"><Undo2 size={14} /> 撤销</button>
          <button className="btn sm" onClick={redo} disabled={!futureRef.current.length} title="重做 (⇧⌘Z)"><Redo2 size={14} /> 重做</button>
          <span className="cv-sep" />
          <button className={`btn sm ${picker ? "on" : ""}`} onClick={() => setPicker((v) => !v)} title="把血缘里的表 / 指标 / 作业拉进画布">
            <GitFork size={14} /> 从血缘添加
          </button>
          <Menu label="自动排版" icon={<Network size={14} />} title="按连线把形状一层层排整齐(选中 2 个以上就只排选中的)">
            {(close) => LAYOUT_DIRS.map((d) => (
              <button key={d} className="cv-menu-item" onClick={() => { close(); layout(d); }}>{LAYOUT_LABEL[d]}</button>
            ))}
          </Menu>
          <button className="btn sm" onClick={colorByLayer} title="按名字前缀上色:ods 灰 · dim 紫 · dwd 蓝 · dws 绿 · ads 橙(选中了就只改选中的)">
            <Palette size={14} /> 按分层上色
          </button>
          <div className="toolbar-spacer" />
          <Menu label="导出" icon={<ImageDown size={14} />} title="导出成图片,放进 PPT / 文档">
            {(close) => <>
              <button className="cv-menu-item" onClick={() => { close(); void exportImage("clipboard"); }}><Copy size={13} /> 复制为图片<small>直接粘进 PPT、微信</small></button>
              <button className="cv-menu-item" onClick={() => { close(); void exportImage("png"); }}><Download size={13} /> 导出 PNG<small>存到「下载」</small></button>
              <button className="cv-menu-item" onClick={() => { close(); void exportImage("svg"); }}><Download size={13} /> 导出 SVG<small>矢量,PPT 里放大不糊</small></button>
            </>}
          </Menu>
          <span className={`cv-dirty ${dirty ? "on" : ""}`}>{dirty ? "未保存" : "已保存"}</span>
          <button className="btn sm primary" onClick={save} disabled={!dirty} title="保存 (⌘S)"><Save size={14} /> 保存</button>
        </div>

        <div className="cv-stage">
          <div className="cv-palette" aria-label="形状">
            {SHAPES.map((s) => (
              <button key={s} className="cv-tool" title={`${SHAPE_LABEL[s]}(点一下放到中间,或拖到画布上)`}
                draggable onDragStart={(e) => { e.dataTransfer.setData("application/x-sonde-shape", s); e.dataTransfer.effectAllowed = "copy"; }}
                onClick={() => addShape(s)}>
                <ShapeIcon shape={s} />
                <span>{SHAPE_LABEL[s]}</span>
              </button>
            ))}
          </div>
          <div className={`cv-flow ${painter ? "is-painting" : ""}`} ref={wrapRef}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }} onDrop={onDrop}
            onDoubleClick={(e) => {
              // 双击空白处:就地放一个圆角框,直接打字
              if (!(e.target as HTMLElement).classList.contains("react-flow__pane")) return;
              addShape("rounded", flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }), true);
            }}>
            <ReactFlow<FlowNode, FlowEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onConnectEnd={onConnectEnd}
              onReconnect={onReconnect}
              onReconnectStart={() => { reconnecting.current = true; }}
              onReconnectEnd={() => { reconnecting.current = false; }}
              onNodeClick={onNodeClick}
              onNodeContextMenu={(e, n) => openMenu(e, "node", n.id)}
              onEdgeContextMenu={(e, x) => openMenu(e, "edge", x.id)}
              onEdgeDoubleClick={(_, x) => {
                setNodes((ns) => ns.map((n) => n.selected ? { ...n, selected: false } : n));
                setEdges((es) => es.map((y) => toFlowEdge(y.data as CanvasEdge, y.id === x.id)));
                focusLabel();
              }}
              onPaneClick={() => { setMenu(null); setPainter(null); }}
              onMoveStart={() => setMenu(null)}
              // 按 Delete 删一批东西(形状 + 连着它的线)只记一步撤销
              onBeforeDelete={async () => { beginChange(); return true; }}
              onNodeDragStart={beginChange}
              onNodeDragStop={() => setGuides([])}
              onSelectionDragStart={beginChange}
              connectionMode={ConnectionMode.Loose}
              colorMode={theme}
              snapToGrid
              snapGrid={[8, 8]}
              selectionOnDrag
              selectionMode={SelectionMode.Partial}
              panOnDrag={[1, 2]}
              panOnScroll
              zoomOnPinch
              zoomOnDoubleClick={false}
              deleteKeyCode={["Backspace", "Delete"]}
              multiSelectionKeyCode={["Meta", "Shift", "Control"]}
              fitView
              fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
              minZoom={0.1}
              maxZoom={3}
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{ interactionWidth: 18 }}
              connectionLineStyle={{ stroke: "var(--accent)", strokeWidth: 1.6 }}
            >
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
              <Controls showInteractive={false} position="bottom-right" />
              <MiniMap pannable zoomable position="bottom-left" nodeColor={(n) => COLOR_VALUE[(n.data as ShapeData).color]} />
              <GuideLines guides={guides} />
            </ReactFlow>

            {(selNodes.length > 0 || selEdges.length > 0) && !picker && (
              <div className="cv-props" onMouseDown={(e) => e.stopPropagation()}>
                {selNodes.length > 0 && one && (
                  <>
                    <span className="cv-props-label">{selNodes.length > 1 ? `${selNodes.length} 个形状` : SHAPE_LABEL[one.shape]}</span>
                    <Swatches value={one.color} onPick={(color) => patchNodes({ color })} />
                    <span className="cv-sep" />
                    <Seg value={one.fill ?? "soft"} options={FILLS} labels={FILL_LABEL} onPick={(fill: FillKind) => patchNodes({ fill: fill === "soft" ? undefined : fill })} />
                    <button className={`btn xs ${one.dashed ? "on" : ""}`} onClick={() => patchNodes({ dashed: !one.dashed || undefined })} title="边框画成虚线">虚线框</button>
                    <select className="cv-select" value={one.shape} onChange={(e) => patchNodes({ shape: e.target.value as ShapeKind })} title="形状">
                      {SHAPES.map((s) => <option key={s} value={s}>{SHAPE_LABEL[s]}</option>)}
                    </select>
                    <select className="cv-select" value={one.fontSize} onChange={(e) => patchNodes({ fontSize: Number(e.target.value) })} title="字号">
                      {FONT_SIZES.map((s) => <option key={s} value={s}>{s}px</option>)}
                    </select>
                    <button className={`icon-btn ${one.bold ? "on" : ""}`} title="加粗" onClick={() => patchNodes({ bold: !one.bold })}><Bold size={14} /></button>
                    {selNodes.length === 1 && <button className="icon-btn" title="改文字 (回车 / 双击)" onClick={() => setEditingId(selNodes[0].id)}><Pencil size={14} /></button>}
                    <button className={`icon-btn ${painter ? "on" : ""}`} title="格式刷 (⌥⌘C):拿起这个样式,再点别的形状就刷上;Esc 放下"
                      onClick={() => painter ? setPainter(null) : pickStyle()}><Paintbrush size={14} /></button>
                    {selNodes.length > 1 && (
                      <>
                        <span className="cv-sep" />
                        {(Object.keys(ALIGN_ICON) as AlignKind[]).map((k) => (
                          <button key={k} className="icon-btn" title={ALIGN_ICON[k][1]} onClick={() => align(k)}>{ALIGN_ICON[k][0]}</button>
                        ))}
                        <button className="icon-btn" title="横向等距(至少 3 个)" disabled={selNodes.length < 3} onClick={() => distribute("h")}><AlignHorizontalDistributeCenter size={14} /></button>
                        <button className="icon-btn" title="纵向等距(至少 3 个)" disabled={selNodes.length < 3} onClick={() => distribute("v")}><AlignVerticalDistributeCenter size={14} /></button>
                      </>
                    )}
                    <span className="cv-sep" />
                    <button className="icon-btn" title="复制一份 (⌘D)" onClick={duplicateSelected}><Copy size={14} /></button>
                  </>
                )}
                {selNodes.length === 0 && oneEdge && (
                  <>
                    <span className="cv-props-label">{selEdges.length > 1 ? `${selEdges.length} 条连线` : "连线"}</span>
                    <Swatches value={oneEdge.color} onPick={(color) => patchEdges({ color })} />
                    <span className="cv-sep" />
                    <Seg value={oneEdge.line} options={LINE_TYPES} labels={LINE_LABEL} onPick={(line) => patchEdges({ line })} />
                    <Seg value={String(oneEdge.width ?? 1)} options={LINE_WIDTHS.map(String)} labels={{ 1: "细", 2: "中", 3: "粗" }} onPick={(w) => patchEdges({ width: Number(w) === 1 ? undefined : Number(w) })} />
                    <Seg value={oneEdge.arrow} options={ARROWS} labels={{ end: "单向", both: "双向", none: "无箭头" }} onPick={(arrow: ArrowKind) => patchEdges({ arrow })} />
                    <button className={`btn xs ${oneEdge.dashed ? "on" : ""}`} onClick={() => patchEdges({ dashed: !oneEdge.dashed })}>虚线</button>
                    <button className={`btn xs ${oneEdge.flow ? "on" : ""}`} title="让线动起来,表示数据从这儿流过"
                      onClick={() => patchEdges(oneEdge.flow ? { flow: false } : { flow: true, flowStyle: oneEdge.flowStyle ?? lastFlow.current.flowStyle, flowSpeed: oneEdge.flowSpeed ?? lastFlow.current.flowSpeed, flowColor: oneEdge.flowColor ?? lastFlow.current.flowColor })}>流动</button>
                    <button className="icon-btn" title="反转方向" onClick={reverseEdges}><ArrowLeftRight size={14} /></button>
                    {selEdges.length === 1 && (
                      <input key={oneEdge.id} ref={labelInputRef} className="cv-label-input" placeholder="线上的文字(双击线也能改)" defaultValue={oneEdge.label}
                        onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur(); }}
                        onBlur={(e) => { if (e.target.value !== oneEdge.label) patchEdges({ label: e.target.value }); }} />
                    )}
                  </>
                )}
                <button className="icon-btn danger" title="删除 (Delete)" onClick={deleteSelected}><Trash2 size={14} /></button>
                    {selNodes.length === 0 && oneEdge?.flow && (
                      <div className="cv-props-row">
                        <span className="cv-props-label">流动</span>
                        <Seg value={oneEdge.flowStyle ?? "dash"} options={FLOW_STYLES} labels={FLOW_LABEL} onPick={(flowStyle: FlowStyle) => patchFlow({ flowStyle: flowStyle === "dash" ? undefined : flowStyle })} />
                        <Seg value={String(oneEdge.flowSpeed ?? 2)} options={FLOW_SPEEDS.map(String)} labels={FLOW_SPEED_LABEL} onPick={(v) => patchFlow({ flowSpeed: Number(v) === 2 ? undefined : Number(v) })} />
                        <button className={`btn xs ${oneEdge.flowColor ? "" : "on"}`} title="流动用线本身的颜色" onClick={() => patchFlow({ flowColor: undefined })}>同线色</button>
                        <Swatches value={oneEdge.flowColor ?? null} onPick={(flowColor) => patchFlow({ flowColor })} />
                      </div>
                    )}
              </div>
            )}
            {painter && <div className="cv-painter-tip"><Paintbrush size={13} /> 格式刷:点形状刷上样式 · 点空白或 Esc 放下</div>}

            {menu && (
              <div className="cv-ctx" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
                {menu.kind === "node" ? <>
                  {selNodes.length === 1 && <button onClick={run(() => setEditingId(selNodes[0].id))}><Pencil size={13} /> 改文字<kbd>↩</kbd></button>}
                  <button onClick={run(() => { copySelected(); })}><Copy size={13} /> 复制<kbd>⌘C</kbd></button>
                  <button onClick={run(() => { if (copySelected()) deleteSelected(); })}><Scissors size={13} /> 剪切<kbd>⌘X</kbd></button>
                  <button disabled={!clipboard} onClick={run(() => { paste(); })}><ClipboardPaste size={13} /> 粘贴<kbd>⌘V</kbd></button>
                  <button onClick={run(duplicateSelected)}><Copy size={13} /> 原地复制一份<kbd>⌘D</kbd></button>
                  <hr />
                  <button onClick={run(pickStyle)}><Paintbrush size={13} /> 格式刷<kbd>⌥⌘C</kbd></button>
                  <button onClick={run(() => restack("front"))}><BringToFront size={13} /> 置于顶层</button>
                  <button onClick={run(() => restack("back"))}><SendToBack size={13} /> 置于底层</button>
                  <hr />
                  <button className="danger" onClick={run(deleteSelected)}><Trash2 size={13} /> 删除<kbd>⌫</kbd></button>
                </> : <>
                  <button onClick={run(focusLabel)}><Pencil size={13} /> 改线上的文字</button>
                  <button onClick={run(reverseEdges)}><ArrowLeftRight size={13} /> 反转方向</button>
                  <hr />
                  <button className="danger" onClick={run(deleteSelected)}><Trash2 size={13} /> 删除<kbd>⌫</kbd></button>
                </>}
              </div>
            )}

            {nodes.length === 0 && (
              <div className="cv-empty">
                <b>从左边拿一个形状开始</b>
                <span>点一下放到中间、拖到画布上,或者直接双击空白处。</span>
                <span>形状边上的小圆点拖出去就是连线,松在空白处会接着长出一个新形状。</span>
                <span>也可以「从血缘添加」,把已有的表连同上下游一起拉进来。</span>
              </div>
            )}
            {picker && (
              <LineagePicker graph={graph}
                onClose={() => setPicker(false)}
                onPick={(id, withNeighbors) => {
                  const out = fromLineage(graph, id, centerPoint(), nodesRef.current.map(fromFlowNode), withNeighbors);
                  if (!out.nodes.length && !out.edges.length) toast({ kind: "info", text: "它已经在画布上了" });
                  addNodes(out.nodes, out.edges);
                  setPicker(false);
                }} />
            )}
          </div>
        </div>
        <div className="cv-hint">
          双击空白处加框 · 从小圆点拖出去连线(松在空白处接着长新框) · 拖空白处框选 · 右键菜单 · 方向键微调(⇧ 大步) · ⌘C / ⌘V 复制粘贴 · ⌘Z 撤销 · Delete 删除
        </div>
      </div>
    </Ctx.Provider>
  );
}

function Swatches({ value, onPick }: { value: ColorKey | null; onPick: (c: ColorKey) => void }) {
  return (
    <div className="cv-swatches" role="radiogroup" aria-label="颜色">
      {PALETTE_ORDER.map((c) => (
        <button key={c} className={`cv-swatch ${c === value ? "on" : ""}`} style={{ "--c": COLOR_VALUE[c] } as CSSProperties}
          title={COLOR_LABEL[c]} aria-checked={c === value} role="radio" onClick={() => onPick(c)} />
      ))}
    </div>
  );
}

function Seg<T extends string>({ value, options, labels, onPick }: { value: T; options: readonly T[]; labels: Record<T, string>; onPick: (v: T) => void }) {
  return (
    <div className="cv-seg">
      {options.map((o) => <button key={o} className={o === value ? "on" : ""} onClick={() => onPick(o)}>{labels[o]}</button>)}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { table: "表", file: "文件", metric: "指标", dataset: "数据集", task: "作业", workflow: "工作流" };
function LineagePicker({ graph, onPick, onClose }: { graph: Graph; onPick: (id: string, withNeighbors: boolean) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const list = graph.nodes
    .filter((n) => n.kind !== "file")
    .filter((n) => !term || n.label.toLowerCase().includes(term) || n.id.toLowerCase().includes(term))
    .slice(0, 200);
  return (
    <div className="cv-picker" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div className="cv-picker-search">
        <Search size={13} />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜表 / 指标 / 作业…" />
      </div>
      <div className="cv-picker-list">
        {list.length === 0 && <div className="cv-picker-none">{graph.nodes.length ? "没有匹配的节点" : "血缘里还没有节点,先去「扫描 · 维护」扫一下"}</div>}
        {list.map((n) => {
          const up = graph.up.get(n.id)?.length ?? 0;
          const down = graph.down.get(n.id)?.length ?? 0;
          return (
            <div key={n.id} className="cv-picker-row">
              <span className="cv-picker-kind">{KIND_LABEL[n.kind] ?? n.kind}</span>
              <span className="cv-picker-name" title={n.id}>{n.label}</span>
              <button className="btn xs" onClick={() => onPick(n.id, false)}>加入</button>
              <button className="btn xs" disabled={!up && !down} onClick={() => onPick(n.id, true)} title={`上游 ${up} 个 · 下游 ${down} 个`}>
                连同上下游
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------- 外层:画布列表 + 编辑器,全屏盖在数据资产上面 ---------- */
export default function CanvasOverlay({ graph, onClose }: { graph: Graph; onClose: () => void }) {
  const { askConfirm, confirmDialog } = useConfirm();
  const [docs, setDocs] = useState<CanvasDoc[]>(() => canvasRepository.load());
  const [activeId, setActiveId] = useState<string | null>(() => docs[0]?.id ?? null);
  const [dirty, setDirty] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const active = docs.find((d) => d.id === activeId) ?? null;

  const persist = useCallback((next: CanvasDoc[]) => {
    try {
      canvasRepository.save(next);
      setDocs(next);
      return true;
    } catch (error) {
      useApp.getState().showToast({ kind: "error", text: `画布保存失败:${String(error)}` });
      return false;
    }
  }, []);
  const guard = async (): Promise<boolean> =>
    !dirty || askConfirm("当前画布有没保存的修改,离开后这些修改会丢掉。", "放弃未保存的修改?", "放弃修改");

  const create = async () => {
    if (!(await guard())) return;
    const doc = newCanvas(nextName(docs.map((d) => d.name)));
    if (persist([doc, ...docs])) { setActiveId(doc.id); setDirty(false); setRenaming(doc.id); }
  };
  const open = async (id: string) => {
    if (id === activeId || !(await guard())) return;
    setActiveId(id); setDirty(false);
  };
  const rename = (id: string, name: string) => {
    setRenaming(null);
    const clean = name.trim();
    if (!clean) return;
    persist(docs.map((d) => d.id === id ? { ...d, name: clean, updatedAt: Date.now() } : d));
  };
  const copyDoc = (id: string) => {
    const src = docs.find((d) => d.id === id);
    if (!src) return;
    const now = Date.now();
    const copy = { ...newCanvas(nextName(docs.map((d) => d.name), `${src.name} 副本`), now), nodes: src.nodes, edges: src.edges };
    persist([copy, ...docs]);
  };
  const remove = async (id: string) => {
    const doc = docs.find((d) => d.id === id);
    if (!doc || !(await askConfirm(`「${doc.name}」会被删除,删除后找不回来。`, "删除这张画布?", "删除"))) return;
    const next = docs.filter((d) => d.id !== id);
    if (persist(next) && id === activeId) { setActiveId(next[0]?.id ?? null); setDirty(false); }
  };
  const save = useCallback((nodes: CanvasNode[], edges: CanvasEdge[]) => {
    if (!activeId) return;
    if (persist(docs.map((d) => d.id === activeId ? { ...d, nodes, edges, updatedAt: Date.now() } : d)))
      useApp.getState().showToast({ kind: "success", text: "画布已保存" });
  }, [activeId, docs, persist]);
  const close = async () => { if (await guard()) onClose(); };

  return createPortal(
    <div className="cv-overlay" role="dialog" aria-modal="true" aria-label="链路画布">
      <aside className="cv-side">
        <div className="cv-side-head">
          <button className="icon-btn" title="返回血缘" onClick={close}><ArrowLeft size={16} /></button>
          <b>链路画布</b>
          <div className="toolbar-spacer" />
          <button className="icon-btn" title="新建画布" onClick={create}><Plus size={16} /></button>
        </div>
        <div className="cv-side-list">
          {docs.length === 0 && <div className="cv-side-none">还没有画布。点右上角 + 新建一张。</div>}
          {docs.map((d) => (
            <div key={d.id} className={`cv-doc ${d.id === activeId ? "on" : ""}`} onClick={() => open(d.id)}
              onDoubleClick={() => setRenaming(d.id)}>
              {renaming === d.id ? (
                <input className="cv-doc-input" autoFocus defaultValue={d.name}
                  onFocus={(e) => e.currentTarget.select()}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => rename(d.id, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setRenaming(null); }} />
              ) : (
                <div className="cv-doc-main">
                  <span className="cv-doc-name">{d.name}{d.id === activeId && dirty ? " ·" : ""}</span>
                  <span className="cv-doc-meta">{d.nodes.length} 个形状 · {new Date(d.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                </div>
              )}
              <div className="cv-doc-acts" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn" title="重命名" onClick={() => setRenaming(d.id)}><Pencil size={13} /></button>
                <button className="icon-btn" title="复制一份" onClick={() => copyDoc(d.id)}><Copy size={13} /></button>
                <button className="icon-btn danger" title="删除" onClick={() => remove(d.id)}><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      </aside>
      <main className="cv-main">
        {active ? (
          <ReactFlowProvider key={active.id}>
            <Editor doc={active} graph={graph} onSave={save} onDirty={setDirty} />
          </ReactFlowProvider>
        ) : (
          <div className="cv-blank">
            <Database size={28} />
            <b>把链路画下来</b>
            <span>血缘图是扫出来的,画布是你自己整理的:摆几张表、几个作业,连上线、配上说明。</span>
            <button className="btn primary" onClick={create}><Plus size={14} /> 新建画布</button>
          </div>
        )}
      </main>
      {confirmDialog}
    </div>,
    document.body,
  );
}
