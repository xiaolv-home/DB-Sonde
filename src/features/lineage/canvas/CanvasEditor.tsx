/* 链路画布编辑器:在血缘里自己画链路。
 *
 * 画布库用 React Flow(拖动、缩放、连线、框选、改大小都现成)。
 * 这里只管:改动怎么进撤销栈、什么时候算「未保存」、怎么存,以及顶栏 / 属性栏 / 右键菜单。
 * 对齐 / 等距 / 自动排版 / 吸附 / 分层上色这些「算位置、算颜色」的事都在 canvasModel 里(纯函数,有测试),
 * 形状和流动的线怎么画在 CanvasShapes,纯数据和画布对象的换算在 canvasFlow,
 * 顶栏上的小部件在 CanvasControls,导出图片在 canvasExport,导出动图在 canvasAnimation。
 *
 * 状态以 React Flow 的 nodes/edges 为准(选中、拖动都在它身上),
 * 存盘、撤销时换算成 canvasModel 里的纯数据。 */
import "@xyflow/react/dist/style.css";
import "./canvas.css";
import {
  useCallback, useEffect, useMemo, useRef, useState,
  type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap,
  ConnectionMode, SelectionMode, applyNodeChanges, applyEdgeChanges, reconnectEdge, useReactFlow,
  type NodeChange, type EdgeChange, type Connection, type FinalConnectionState,
} from "@xyflow/react";
import {
  AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignHorizontalDistributeCenter,
  AlignStartHorizontal, AlignStartVertical, AlignVerticalDistributeCenter, ArrowLeft, ArrowLeftRight, Bold,
  BringToFront, ClipboardPaste, Copy, Database, Download, Film, GitFork, ImageDown, Loader2, Network, Paintbrush,
  History, Palette, Pencil, Plus, Redo2, Save, Scissors, SendToBack, Trash2, Undo2, X,
} from "lucide-react";
import { useApp } from "../../../store/appStore";
import { useConfirm } from "../../../components/useConfirm";
import { api } from "../../../lib/api";
import { inTauri } from "../../../lib/mockBackend";
import type { Graph } from "../lineageModel";
import {
  ARROWS, COLOR_VALUE, FILLS, FILL_LABEL, FLOW_LABEL, FLOW_SPEEDS, FLOW_SPEED_LABEL, FLOW_STYLES,
  FONT_SIZES, LAYOUT_DIRS, LAYOUT_LABEL, LINE_LABEL, LINE_TYPES, LINE_WIDTHS, SHAPES, SHAPE_LABEL,
  alignBoxes, autoLayout, contentKey, explainCanvasProblem, hi, lo, distributeBoxes, duplicate, facingSides, findFreeSpot, fromLineage, layerColor, repairCanvas,
  newCanvas, newEdge, newNode, nextName, snapToGuides,
  type AlignKind, type ArrowKind, type CanvasDoc, type CanvasEdge, type CanvasNode,
  type FillKind, type FlowStyle, type Guide, type LayoutDir, type Pos, type ShapeKind,
} from "./canvasModel";
import { blobToBase64, bytesToBase64, canvasMeasure, canvasToSvg, svgToPng } from "./canvasExport";
import { animationFrames, encodeGif, svgPathProbe } from "./canvasAnimation";
import { canvasHistoryRepository, canvasRepository, pushVersion, saveDraft, type CanvasHistory, type CanvasVersion } from "./canvasRepository";
import {
  ShapeContext, boxOf, fromFlowEdge, fromFlowNode, styleOf, toFlowEdge, toFlowNode, zOf,
  type FlowEdge, type FlowNode, type NodeStyle, type ShapeCtx, type ShapeData, type Side,
} from "./canvasFlow";
import { FlowFxEdge, GuideLines, ShapeIcon, ShapeNode } from "./CanvasShapes";
import { LineagePicker, Menu, Seg, Swatches, TextColorPicker } from "./CanvasControls";

/* 剪贴板放在模块里:在一张画布 ⌘C,换到另一张画布 ⌘V 也能贴 */
let clipboard: { docId: string; nodes: CanvasNode[]; edges: CanvasEdge[]; pastes: number } | null = null;

const nodeTypes = { shape: ShapeNode };
const edgeTypes = { flowfx: FlowFxEdge };

/* ---------- 历史(撤销/重做) ---------- */
interface Snapshot { nodes: CanvasNode[]; edges: CanvasEdge[]; }
const HISTORY_LIMIT = 100;
const ALIGN_ICON: Record<AlignKind, [ReactNode, string]> = {
  left: [<AlignStartVertical size={14} />, "左对齐"], hcenter: [<AlignCenterVertical size={14} />, "水平居中"],
  right: [<AlignEndVertical size={14} />, "右对齐"], top: [<AlignStartHorizontal size={14} />, "顶对齐"],
  vmiddle: [<AlignCenterHorizontal size={14} />, "垂直居中"], bottom: [<AlignEndHorizontal size={14} />, "底对齐"],
};

/** 保存的结果:ok=真的写进去了;fixed=存之前自动修掉的问题;error=没写进去的原因(这时已另存了草稿) */
type SaveResult = { ok: boolean; fixed: string[]; error?: string };

function Editor({ doc, graph, versions, onSave, onDirty }: {
  doc: CanvasDoc;
  graph: Graph;
  /** 这张画布的历史版本(旧的在前) */
  versions: CanvasVersion[];
  /** milestone:这次一定新记一份历史(恢复历史版本时),不顶掉前一份 */
  onSave: (docId: string, nodes: CanvasNode[], edges: CanvasEdge[], milestone: boolean) => SaveResult;
  /** dirty:有改动还没写进去;failed:上一次保存失败了(离开要拦一下) */
  onDirty: (state: { dirty: boolean; failed: boolean }) => void;
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
  /** 正在生成动图时的进度(0~1),没在生成是 null */
  const [gifProgress, setGifProgress] = useState<number | null>(null);
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
  /** 恢复到某个历史版本:算一次改动(能 ⌘Z 撤回),随后自动保存,恢复前的样子也会留在历史里 */
  const restoreVersion = (v: CanvasVersion) => {
    milestoneRef.current = true;
    beginChange();
    restore({ nodes: v.nodes, edges: v.edges });
    toast({ kind: "success", text: `已恢复到 ${new Date(v.at).toLocaleTimeString("zh-CN")} 的版本,不满意可以 ⌘Z 撤回` });
  };
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
  /** 上一次保存为什么没写进去(没有就是 null)。一直挂在顶栏上,不是弹一下就没了 */
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => { onDirty({ dirty, failed: !!saveError }); }, [dirty, saveError, onDirty]);

  /* 只有真的写进去了才算「已保存」—— 以前不管写没写进去都标成已保存,
     存储拒收时只弹一下红字,人一退出,画的东西就回退到上一次真正存上的样子。 */
  const milestoneRef = useRef(false);
  const save = useCallback((auto = false) => {
    const snap = snapshot();
    const result = onSave(doc.id, snap.nodes, snap.edges, milestoneRef.current);
    if (result.ok) milestoneRef.current = false;
    if (result.ok) {
      setSavedKey(contentKey({ name: "", ...snap }));
      setSaveError(null);
      if (!auto) toast({ kind: "success", text: result.fixed.length ? `画布已保存(顺手修了 ${result.fixed.length} 处:${result.fixed[0]}…)` : "画布已保存" });
    } else {
      const why = (result.error ?? "保存失败").replace(/^Error:\s*/, "").replace(/[。.]+$/, "");
      setSaveError(why);
      toast({ kind: "error", text: `画布没保存上:${why}。已另存一份草稿,内容不会丢。` });
    }
  }, [doc.id, onSave, snapshot, toast]);

  /* 自动保存:改完停 0.8 秒就存;离开画布(返回血缘、切到别的画布、关掉数据资产)那一刻再存一次。
     存不进去时不会每 0.8 秒刷一遍红字 —— 失败后要等内容再变才会重试。 */
  const saveRef = useRef(save); saveRef.current = save;
  const pendingRef = useRef(false); pendingRef.current = dirty;
  const lastTriedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!dirty || lastTriedRef.current === currentKey) return;
    const timer = window.setTimeout(() => { lastTriedRef.current = currentKey; saveRef.current(true); }, 800);
    return () => window.clearTimeout(timer);
  }, [dirty, currentKey]);
  useEffect(() => {
    const flush = () => { if (pendingRef.current) saveRef.current(true); };
    // 整个窗口关掉 / 应用退出时组件来不及卸载,靠页面卸载事件兜底
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => { window.removeEventListener("pagehide", flush); window.removeEventListener("beforeunload", flush); flush(); };
  }, []);

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
    const n = newNode(shape, 0, 0, { color: base.color, fill: base.fill, dashed: base.dashed, fontSize: base.fontSize, textColor: base.textColor, text: "" });
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

  /* 动图:流动的线在里面真的会动,微信直接发、PPT 放映、Word 里都会播 */
  const exportGif = async () => {
    if (gifProgress !== null) return;
    const snap = snapshot();
    if (!snap.nodes.length) { toast({ kind: "info", text: "画布是空的" }); return; }
    if (!snap.edges.some((e) => e.flow)) {
      toast({ kind: "info", text: "画布上没有流动的线,导出动图也不会动 —— 先给线打开「流动」,或者直接导出 PNG" });
      return;
    }
    if (!inTauri) { toast({ kind: "error", text: "导出失败:浏览器预览里不能存文件,请用桌面版" }); return; }
    const probe = svgPathProbe();
    setGifProgress(0);
    try {
      const anim = animationFrames(snap.nodes, snap.edges, canvasMeasure(), probe)!;
      const bytes = await encodeGif(anim.frames, anim.width, anim.height, setGifProgress);
      const path = await api.saveExport(doc.name || "链路画布", "gif", bytesToBase64(bytes));
      const size = bytes.length >= 1024 * 1024 ? `${(bytes.length / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes.length / 1024)} KB`;
      toast({ kind: "success", text: `已导出动图到 ${path}(${size})。微信直接发,拖进 PPT / Word 都会动` });
    } catch (error) {
      toast({ kind: "error", text: `导出失败:${error instanceof Error ? error.message : String(error)}` });
    } finally {
      probe.dispose();
      setGifProgress(null);
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
    else if (mod && key === "s") save(false);
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
    <ShapeContext.Provider value={ctx}>
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
              <button className="cv-menu-item" disabled={gifProgress !== null} onClick={() => { close(); void exportGif(); }}><Film size={13} /> 导出动图 GIF<small>会动,发微信 / 放 PPT</small></button>
            </>}
          </Menu>
          <Menu label="历史" icon={<History size={14} />} title="自动留的历史版本(每张画布最近 30 份,约每 2 分钟一份),挑一个恢复">
            {(close) => versions.length === 0
              ? <div className="cv-menu-empty">还没有历史版本</div>
              : [...versions].reverse().map((v, i) => (
                <button key={v.at} className="cv-menu-item" onClick={() => { close(); restoreVersion(v); }}>
                  {new Date(v.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  <small>{i === 0 ? "最新 · " : ""}{v.nodes.length} 个形状 · {v.edges.length} 根线</small>
                </button>
              ))}
          </Menu>
          <span className={`cv-dirty ${saveError ? "err" : dirty ? "on" : ""}`} title={saveError ?? undefined}>
            {saveError ? "没保存上" : dirty ? "保存中…" : "已自动保存"}
          </span>
          <button className="btn sm primary" onClick={() => save(false)} title="保存 (⌘S)"><Save size={14} /> 保存</button>
        </div>

        {saveError && (
          <div className="cv-save-error" role="alert">
            画布没保存上:{saveError}。已另存一份草稿;改一下再保存会自动重试,修不好的话把这段话发给我。
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
                    {selNodes.length > 0 && one && (
                      <div className="cv-props-row">
                        <span className="cv-props-label">文字颜色</span>
                        <TextColorPicker value={one.textColor} onPick={(textColor) => patchNodes({ textColor })} />
                      </div>
                    )}
              </div>
            )}
            {painter && <div className="cv-painter-tip"><Paintbrush size={13} /> 格式刷:点形状刷上样式 · 点空白或 Esc 放下</div>}
            {gifProgress !== null && <div className="cv-painter-tip"><Loader2 size={13} className="spin" /> 正在生成动图 {Math.round(gifProgress * 100)}%</div>}

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
    </ShapeContext.Provider>
  );
}

/* ---------- 外层:画布列表 + 编辑器,全屏盖在数据资产上面 ---------- */
export default function CanvasOverlay({ graph, onClose, standalone = false }: {
  graph: Graph;
  onClose: () => void;
  /** 在独立窗口里:左上角是「关闭窗口」,不是「返回血缘」 */
  standalone?: boolean;
}) {
  const { askConfirm, confirmDialog } = useConfirm();
  const [docs, setDocs] = useState<CanvasDoc[]>(() => canvasRepository.load());
  /* 编辑器卸载时(离开画布那一刻)还要存一次,那时这里的 state 可能已经不是最新的 —— 存盘一律从 ref 取 */
  const docsRef = useRef(docs); docsRef.current = docs;
  const [history, setHistory] = useState<CanvasHistory>(() => {
    // 第一次用历史功能时,把每张画布现在的样子先记成第一份
    let h = canvasHistoryRepository.load();
    for (const d of docs) if (!h[d.id]?.length) h = pushVersion(h, d.id, d.nodes, d.edges, d.updatedAt);
    return h;
  });
  const historyRef = useRef(history); historyRef.current = history;
  const [activeId, setActiveId] = useState<string | null>(() => docs[0]?.id ?? null);
  const [dirty, setDirty] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const onEditorState = useCallback((st: { dirty: boolean; failed: boolean }) => { setDirty(st.dirty); setSaveFailed(st.failed); }, []);
  const [renaming, setRenaming] = useState<string | null>(null);
  const active = docs.find((d) => d.id === activeId) ?? null;

  const persist = useCallback((next: CanvasDoc[]) => {
    try {
      canvasRepository.save(next);
      docsRef.current = next;
      setDocs(next);
      return true;
    } catch (error) {
      useApp.getState().showToast({ kind: "error", text: `画布保存失败:${String(error)}` });
      return false;
    }
  }, []);
  const forgetHistory = (id: string) => {
    const { [id]: _gone, ...rest } = historyRef.current;
    void _gone;
    try { canvasHistoryRepository.save(rest); setHistory(rest); } catch { /* 历史写不进去不影响画布本身 */ }
  };
  /* 平时离开画布不用问:编辑器卸载时会把最后的改动存上。只有上一次保存失败了才拦一下 */
  const guard = async (): Promise<boolean> =>
    !saveFailed || askConfirm("这张画布最近的修改没保存上(原因见画布顶上的红条),已经另存了一份草稿。仍要离开吗?", "修改没保存上", "仍要离开");

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
    if (persist(next)) {
      forgetHistory(id);
      if (id === activeId) { setActiveId(next[0]?.id ?? null); setDirty(false); }
    }
  };
  /** 存一张画布。存之前先把能自动修的修掉;还是不合格就原样另存草稿,并说清楚哪里不对 */
  const save = useCallback((docId: string, nodes: CanvasNode[], edges: CanvasEdge[], milestone: boolean): { ok: boolean; fixed: string[]; error?: string } => {
    const current = docsRef.current;
    const old = current.find((d) => d.id === docId);
    if (!old) return { ok: false, fixed: [], error: "这张画布已经被删除了" };
    const repaired = repairCanvas(nodes, edges);
    const doc: CanvasDoc = { ...old, nodes: repaired.nodes, edges: repaired.edges, updatedAt: Date.now() };
    const problem = explainCanvasProblem(doc);
    if (problem) {
      saveDraft({ ...old, nodes, edges, updatedAt: Date.now() });
      return { ok: false, fixed: repaired.fixed, error: problem };
    }
    try {
      canvasRepository.save(current.map((d) => d.id === docId ? doc : d));
    } catch (error) {
      saveDraft(doc);
      return { ok: false, fixed: repaired.fixed, error: String(error) };
    }
    const next = current.map((d) => d.id === docId ? doc : d);
    docsRef.current = next;
    setDocs(next);
    try {
      const h = pushVersion(historyRef.current, docId, doc.nodes, doc.edges, doc.updatedAt, milestone);
      if (h !== historyRef.current) { canvasHistoryRepository.save(h); historyRef.current = h; setHistory(h); }
    } catch { /* 历史写不进去不影响画布本身 */ }
    return { ok: true, fixed: repaired.fixed };
  }, []);
  const close = async () => { if (await guard()) onClose(); };

  return createPortal(
    <div className="cv-overlay" role="dialog" aria-modal="true" aria-label="链路画布">
      <aside className="cv-side">
        <div className="cv-side-head">
          {standalone
            ? <button className="icon-btn" title="关闭画布窗口" onClick={close}><X size={16} /></button>
            : <button className="icon-btn" title="返回血缘" onClick={close}><ArrowLeft size={16} /></button>}
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
            <Editor doc={active} graph={graph} versions={history[active.id] ?? []} onSave={save} onDirty={onEditorState} />
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
