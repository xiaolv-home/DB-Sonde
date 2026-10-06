/* 链路画布编辑器:在血缘里自己画链路。
 *
 * 画布库用 React Flow(拖动、缩放、连线、框选、改大小都现成)。
 * 这里只管:形状长什么样、改动怎么进撤销栈、什么时候算「未保存」、怎么存。
 *
 * 状态以 React Flow 的 nodes/edges 为准(选中、拖动都在它身上),
 * 存盘、撤销时换算成 canvasModel 里的纯数据。 */
import "@xyflow/react/dist/style.css";
import "./canvas.css";
import {
  createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type CSSProperties, type DragEvent as ReactDragEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Handle, Position,
  NodeResizer, MarkerType, ConnectionMode, SelectionMode, applyNodeChanges, applyEdgeChanges, useReactFlow,
  type Node, type Edge, type NodeProps, type NodeChange, type EdgeChange, type Connection,
} from "@xyflow/react";
import {
  ArrowLeft, Bold, Copy, Database, GitFork, Plus, Redo2, Save, Search, Trash2, Undo2, Pencil, Link2,
} from "lucide-react";
import { useApp } from "../../../store/appStore";
import { useConfirm } from "../../../components/useConfirm";
import type { Graph } from "../lineageModel";
import {
  ARROWS, COLORS, COLOR_LABEL, COLOR_VALUE, FONT_SIZES, LINE_TYPES, SHAPES, SHAPE_LABEL,
  contentKey, duplicate, findFreeSpot, fromLineage, newCanvas, newEdge, newNode, nextName,
  type ArrowKind, type CanvasDoc, type CanvasEdge, type CanvasNode, type ColorKey, type LineType, type ShapeKind,
} from "./canvasModel";
import { canvasRepository } from "./canvasRepository";

type ShapeData = CanvasNode & Record<string, unknown>;
type EdgeData = CanvasEdge & Record<string, unknown>;
type FlowNode = Node<ShapeData, "shape">;
type FlowEdge = Edge<EdgeData>;

/* ---------- 纯数据 <-> 画布对象 ---------- */
const toFlowNode = (n: CanvasNode): FlowNode => ({
  id: n.id, type: "shape", position: { x: n.x, y: n.y }, width: n.w, height: n.h,
  data: { ...n } as ShapeData,
  // 分组框垫在最底下,不挡住框里的东西
  zIndex: n.shape === "group" ? -1 : 0,
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
const EDGE_TYPE: Record<LineType, string> = { smooth: "default", step: "smoothstep", straight: "straight" };
const toFlowEdge = (e: CanvasEdge, selected = false): FlowEdge => {
  const color = COLOR_VALUE[e.color];
  const marker = { type: MarkerType.ArrowClosed, color, width: 18, height: 18 };
  return {
    id: e.id, source: e.from, target: e.to, sourceHandle: e.fromHandle, targetHandle: e.toHandle,
    type: EDGE_TYPE[e.line], label: e.label || undefined, selected,
    animated: !!e.flow,
    data: { ...e } as EdgeData,
    style: { stroke: color, strokeWidth: selected ? 2.4 : 1.6, strokeDasharray: e.dashed && !e.flow ? "6 4" : undefined },
    markerEnd: e.arrow === "none" ? undefined : marker,
    markerStart: e.arrow === "both" ? marker : undefined,
    labelStyle: { fill: "var(--text-2)", fontSize: 12 },
    labelBgStyle: { fill: "var(--surface)" },
    labelBgPadding: [6, 3],
    labelBgBorderRadius: 4,
  };
};
const fromFlowEdge = (e: FlowEdge): CanvasEdge => ({
  ...(e.data as CanvasEdge), from: e.source, to: e.target,
  fromHandle: e.sourceHandle ?? undefined, toHandle: e.targetHandle ?? undefined,
});

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
  return (
    <div className={`cv-node cv-${data.shape}${selected ? " is-selected" : ""}`} style={style} onDoubleClick={() => ctx.startEdit(id)}>
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

/* ---------- 历史(撤销/重做) ---------- */
interface Snapshot { nodes: CanvasNode[]; edges: CanvasEdge[]; }
const HISTORY_LIMIT = 100;

function Editor({ doc, graph, onSave, onDirty }: {
  doc: CanvasDoc;
  graph: Graph;
  onSave: (nodes: CanvasNode[], edges: CanvasEdge[]) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const flow = useReactFlow<FlowNode, FlowEdge>();
  const wrapRef = useRef<HTMLDivElement>(null);
  const theme = useApp((s) => s.theme);
  const [nodes, setNodes] = useState<FlowNode[]>(() => doc.nodes.map(toFlowNode));
  const [edges, setEdges] = useState<FlowEdge[]>(() => doc.edges.map((e) => toFlowEdge(e)));
  const [editingId, setEditingId] = useState<string | null>(null);
  /* 撤销栈放在 ref 里(改动不该触发重渲染),只用一个计数让按钮的可用状态跟着变 */
  const pastRef = useRef<Snapshot[]>([]);
  const futureRef = useRef<Snapshot[]>([]);
  const [, setHistoryTick] = useState(0);
  const bump = () => setHistoryTick((t) => t + 1);
  const [savedKey, setSavedKey] = useState(() => contentKey({ name: "", nodes: doc.nodes, edges: doc.edges }));
  const [lineDefault, setLineDefault] = useState<LineType>("smooth");
  const [picker, setPicker] = useState(false);

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
    setNodes((ns) => applyNodeChanges(changes, ns));
  }, []);
  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => {
    setEdges((es) => {
      const next = applyEdgeChanges(changes, es);
      // 选中的线画粗一点,看得出选的是哪根
      return changes.some((c) => c.type === "select") ? next.map((e) => toFlowEdge(e.data as CanvasEdge, !!e.selected)) : next;
    });
  }, []);
  const onConnect = useCallback((c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    beginChange();
    const edge = newEdge(c.source, c.target, { fromHandle: c.sourceHandle ?? undefined, toHandle: c.targetHandle ?? undefined, line: lineDefault });
    setEdges((es) => [...es, toFlowEdge(edge)]);
  }, [beginChange, lineDefault]);

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
        return [...es, ...addedEdges.filter((e) => !have.has(`${e.from}>${e.to}`)).map((e) => toFlowEdge(e))];
      });
    }
  }, [beginChange]);
  const addShape = useCallback((shape: ShapeKind, at?: { x: number; y: number }) => {
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
      const next = { ...n, data: { ...n.data, ...patch } };
      return patch.shape ? { ...next, zIndex: patch.shape === "group" ? -1 : 0 } : next;
    }));
  };
  const patchEdges = (patch: Partial<CanvasEdge>) => {
    beginChange();
    if (patch.line) setLineDefault(patch.line);
    setEdges((es) => es.map((e) => e.selected ? toFlowEdge({ ...(e.data as CanvasEdge), ...fromFlowEdge(e), ...patch }, true) : e));
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

  /* ---------- 快捷键 ----------
     挂在 window 的捕获阶段并截住:主界面也有 ⌘S(保存 SQL 标签)等快捷键,
     画布开着时这些键归画布。 */
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [contenteditable=true]")) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    let handled = true;
    if (mod && key === "z") { if (e.shiftKey) redo(); else undo(); }
    else if (mod && key === "y") redo();
    else if (mod && key === "s") save();
    else if (mod && key === "d") duplicateSelected();
    else if (mod && key === "a") setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
    else if (e.key === "Enter" && !mod) {
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

  const one = selNodes[0]?.data;
  const oneEdge = selEdges[0]?.data as CanvasEdge | undefined;

  return (
    <Ctx.Provider value={ctx}>
      <div className="cv-editor">
        <div className="cv-topbar">
          <button className="btn sm" onClick={undo} disabled={!pastRef.current.length} title="撤销 (⌘Z)"><Undo2 size={14} /> 撤销</button>
          <button className="btn sm" onClick={redo} disabled={!futureRef.current.length} title="重做 (⇧⌘Z)"><Redo2 size={14} /> 重做</button>
          <span className="cv-sep" />
          <button className="btn sm" onClick={() => setPicker((v) => !v)} title="把血缘里的表 / 指标 / 作业拉进画布">
            <GitFork size={14} /> 从血缘添加
          </button>
          <div className="toolbar-spacer" />
          <span className={`cv-dirty ${dirty ? "on" : ""}`}>{dirty ? "未保存" : "已保存"}</span>
          <button className="btn sm primary" onClick={save} disabled={!dirty} title="保存 (⌘S)"><Save size={14} /> 保存</button>
        </div>

        {(selNodes.length > 0 || selEdges.length > 0) && (
          <div className="cv-props">
            {selNodes.length > 0 && one && (
              <>
                <span className="cv-props-label">{selNodes.length > 1 ? `${selNodes.length} 个形状` : SHAPE_LABEL[one.shape]}</span>
                <Swatches value={one.color} onPick={(color) => patchNodes({ color })} />
                <select className="cv-select" value={one.shape} onChange={(e) => patchNodes({ shape: e.target.value as ShapeKind })} title="形状">
                  {SHAPES.map((s) => <option key={s} value={s}>{SHAPE_LABEL[s]}</option>)}
                </select>
                <select className="cv-select" value={one.fontSize} onChange={(e) => patchNodes({ fontSize: Number(e.target.value) })} title="字号">
                  {FONT_SIZES.map((s) => <option key={s} value={s}>{s}px</option>)}
                </select>
                <button className={`icon-btn ${one.bold ? "on" : ""}`} title="加粗" onClick={() => patchNodes({ bold: !one.bold })}><Bold size={14} /></button>
                {selNodes.length === 1 && <button className="icon-btn" title="改文字 (回车 / 双击)" onClick={() => setEditingId(selNodes[0].id)}><Pencil size={14} /></button>}
                <button className="icon-btn" title="复制 (⌘D)" onClick={duplicateSelected}><Copy size={14} /></button>
              </>
            )}
            {selNodes.length === 0 && oneEdge && (
              <>
                <span className="cv-props-label">{selEdges.length > 1 ? `${selEdges.length} 条连线` : "连线"}</span>
                <Swatches value={oneEdge.color} onPick={(color) => patchEdges({ color })} />
                <Seg value={oneEdge.line} options={LINE_TYPES} labels={{ smooth: "曲线", step: "折线", straight: "直线" }} onPick={(line) => patchEdges({ line })} />
                <Seg value={oneEdge.arrow} options={ARROWS} labels={{ end: "单向", both: "双向", none: "无箭头" }} onPick={(arrow: ArrowKind) => patchEdges({ arrow })} />
                <button className={`btn xs ${oneEdge.dashed ? "on" : ""}`} onClick={() => patchEdges({ dashed: !oneEdge.dashed })}>虚线</button>
                <button className={`btn xs ${oneEdge.flow ? "on" : ""}`} onClick={() => patchEdges({ flow: !oneEdge.flow })} title="让线动起来,表示数据从这儿流过">流动</button>
                {selEdges.length === 1 && (
                  <input key={oneEdge.id} className="cv-label-input" placeholder="线上的文字" defaultValue={oneEdge.label}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); }}
                    onBlur={(e) => { if (e.target.value !== oneEdge.label) patchEdges({ label: e.target.value }); }} />
                )}
              </>
            )}
            <button className="icon-btn danger" title="删除 (Delete)" onClick={deleteSelected}><Trash2 size={14} /></button>
          </div>
        )}

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
          <div className="cv-flow" ref={wrapRef} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }} onDrop={onDrop}>
            <ReactFlow<FlowNode, FlowEdge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              // 按 Delete 删一批东西(形状 + 连着它的线)只记一步撤销
              onBeforeDelete={async () => { beginChange(); return true; }}
              onNodeDragStart={beginChange}
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
            </ReactFlow>
            {nodes.length === 0 && (
              <div className="cv-empty">
                <b>从左边拿一个形状开始</b>
                <span>点一下放到中间,或者直接拖到画布上。形状边上的小圆点拖出去就是连线。</span>
                <span>也可以「从血缘添加」,把已有的表连同上下游一起拉进来。</span>
              </div>
            )}
            {picker && (
              <LineagePicker graph={graph}
                onClose={() => setPicker(false)}
                onPick={(id, withNeighbors) => {
                  const out = fromLineage(graph, id, centerPoint(), nodesRef.current.map(fromFlowNode), withNeighbors);
                  if (!out.nodes.length && !out.edges.length) useApp.getState().showToast({ kind: "info", text: "它已经在画布上了" });
                  addNodes(out.nodes, out.edges);
                  setPicker(false);
                }} />
            )}
          </div>
        </div>
        <div className="cv-hint">
          拖空白处框选 · 右键或中键拖动平移 · 滚轮平移、捏合缩放 · 双击改文字 · ⌘Z 撤销 · ⌘D 复制 · Delete 删除
        </div>
      </div>
    </Ctx.Provider>
  );
}

function Swatches({ value, onPick }: { value: ColorKey; onPick: (c: ColorKey) => void }) {
  return (
    <div className="cv-swatches" role="radiogroup" aria-label="颜色">
      {COLORS.map((c) => (
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
    <div className="cv-overlay" role="dialog" aria-label="链路画布">
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
