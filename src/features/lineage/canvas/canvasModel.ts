/* 链路画布的数据模型 —— 纯数据,不依赖画布库,方便测试和以后换实现。
 *
 * 血缘图是「扫出来的」,画布是「人整理的」:把几张表、几个作业、几个指标
 * 摆成一条看得懂的链路,配上说明、分组、颜色。两者互不覆盖 ——
 * 画布里的节点可以引用血缘里的某个节点(ref),但改画布不会改血缘。 */
import { isIdentifiedList, isNonEmptyText, isRecord, isText } from "../../../lib/storedRepository";
import type { Graph, NodeKind } from "../lineageModel";

export const SHAPES = ["rect", "rounded", "pill", "ellipse", "diamond", "cylinder", "note", "text", "group"] as const;
export type ShapeKind = (typeof SHAPES)[number];
export const SHAPE_LABEL: Record<ShapeKind, string> = {
  rect: "方框", rounded: "圆角", pill: "胶囊", ellipse: "椭圆", diamond: "判断",
  cylinder: "数据表", note: "便签", text: "文字", group: "分组框",
};
/** 新建时的默认尺寸 */
export const SHAPE_SIZE: Record<ShapeKind, { w: number; h: number }> = {
  rect: { w: 160, h: 56 }, rounded: { w: 160, h: 56 }, pill: { w: 160, h: 44 },
  ellipse: { w: 140, h: 72 }, diamond: { w: 140, h: 90 }, cylinder: { w: 150, h: 76 },
  note: { w: 180, h: 110 }, text: { w: 160, h: 36 }, group: { w: 420, h: 260 },
};

export const COLORS = ["gray", "blue", "green", "yellow", "orange", "red", "purple", "teal"] as const;
export type ColorKey = (typeof COLORS)[number];
export const COLOR_VALUE: Record<ColorKey, string> = {
  gray: "#8a8f98", blue: "#2f8ee6", green: "#2fa86b", yellow: "#d9a514",
  orange: "#e8772e", red: "#e0484e", purple: "#8b5cf6", teal: "#14a3a3",
};
export const COLOR_LABEL: Record<ColorKey, string> = {
  gray: "灰", blue: "蓝", green: "绿", yellow: "黄", orange: "橙", red: "红", purple: "紫", teal: "青",
};

export const FONT_SIZES = [12, 14, 16, 20, 26] as const;
export const LINE_TYPES = ["smooth", "step", "straight"] as const;
export type LineType = (typeof LINE_TYPES)[number];
export const ARROWS = ["end", "both", "none"] as const;
export type ArrowKind = (typeof ARROWS)[number];

export interface CanvasNode {
  id: string;
  shape: ShapeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  color: ColorKey;
  fontSize: number;
  bold?: boolean;
  /** 引用的血缘节点 id(从血缘拉进来的才有) */
  ref?: string;
}
export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  fromHandle?: string;
  toHandle?: string;
  label: string;
  color: ColorKey;
  line: LineType;
  arrow: ArrowKind;
  dashed?: boolean;
  /** 流动的虚线 —— 表示「数据从这儿流过去」 */
  flow?: boolean;
}
export interface CanvasDoc {
  id: string;
  name: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  createdAt: number;
  updatedAt: number;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const oneOf = <T extends readonly string[]>(list: T, v: unknown): v is T[number] => isText(v) && (list as readonly string[]).includes(v);

export function isCanvasNode(v: unknown): v is CanvasNode {
  return isRecord(v) && isNonEmptyText(v.id) && oneOf(SHAPES, v.shape)
    && finite(v.x) && finite(v.y) && finite(v.w) && v.w > 0 && finite(v.h) && v.h > 0
    && isText(v.text) && oneOf(COLORS, v.color) && finite(v.fontSize) && v.fontSize > 0
    && (v.bold === undefined || typeof v.bold === "boolean")
    && (v.ref === undefined || isText(v.ref));
}
export function isCanvasEdge(v: unknown): v is CanvasEdge {
  return isRecord(v) && isNonEmptyText(v.id) && isNonEmptyText(v.from) && isNonEmptyText(v.to)
    && (v.fromHandle === undefined || isText(v.fromHandle)) && (v.toHandle === undefined || isText(v.toHandle))
    && isText(v.label) && oneOf(COLORS, v.color) && oneOf(LINE_TYPES, v.line) && oneOf(ARROWS, v.arrow)
    && (v.dashed === undefined || typeof v.dashed === "boolean")
    && (v.flow === undefined || typeof v.flow === "boolean");
}
export function isCanvasDoc(v: unknown): v is CanvasDoc {
  if (!isRecord(v) || !isNonEmptyText(v.id) || !isText(v.name) || !finite(v.createdAt) || !finite(v.updatedAt)) return false;
  if (!isIdentifiedList(v.nodes, isCanvasNode) || !isIdentifiedList(v.edges, isCanvasEdge)) return false;
  // 连线两头必须是画布里存在的节点 —— 不然打开就是一根悬空的线
  const ids = new Set(v.nodes.map((n) => n.id));
  return v.edges.every((e) => ids.has(e.from) && ids.has(e.to));
}
export const isCanvasList = (v: unknown): v is CanvasDoc[] => isIdentifiedList(v, isCanvasDoc);

let seq = 0;
export const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function newCanvas(name: string, now = Date.now()): CanvasDoc {
  return { id: uid("cv_"), name, nodes: [], edges: [], createdAt: now, updatedAt: now };
}

export function newNode(shape: ShapeKind, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode {
  const size = SHAPE_SIZE[shape];
  return {
    id: uid("n_"), shape, x, y, w: size.w, h: size.h,
    text: shape === "group" ? "分组" : shape === "text" ? "文字" : SHAPE_LABEL[shape],
    color: shape === "note" ? "yellow" : shape === "group" || shape === "text" ? "gray" : "blue",
    fontSize: shape === "text" ? 16 : 14,
    ...extra,
  };
}

export function newEdge(from: string, to: string, extra: Partial<CanvasEdge> = {}): CanvasEdge {
  return { id: uid("e_"), from, to, label: "", color: "gray", line: "smooth", arrow: "end", ...extra };
}

/** 新起一个不重名的名字:未命名画布、未命名画布 2、… */
export function nextName(existing: string[], base = "未命名画布"): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** 复制一组节点(以及它们之间的连线),整体偏移,换新 id。 */
export function duplicate(nodes: CanvasNode[], edges: CanvasEdge[], ids: Set<string>, offset = 32) {
  const map = new Map<string, string>();
  const copiedNodes = nodes.filter((n) => ids.has(n.id)).map((n) => {
    const id = uid("n_");
    map.set(n.id, id);
    return { ...n, id, x: n.x + offset, y: n.y + offset };
  });
  const copiedEdges = edges
    .filter((e) => map.has(e.from) && map.has(e.to))
    .map((e) => ({ ...e, id: uid("e_"), from: map.get(e.from)!, to: map.get(e.to)! }));
  return { nodes: copiedNodes, edges: copiedEdges };
}

const KIND_STYLE: Record<NodeKind, { shape: ShapeKind; color: ColorKey }> = {
  table: { shape: "cylinder", color: "blue" },
  file: { shape: "rect", color: "orange" },
  metric: { shape: "rounded", color: "green" },
  dataset: { shape: "rounded", color: "purple" },
  task: { shape: "pill", color: "yellow" },
  workflow: { shape: "pill", color: "orange" },
};

/**
 * 从血缘里拉节点进画布。withNeighbors 时把它的直接上游、直接下游和连线一起带进来,
 * 按「上游 → 它 → 下游」从左到右排好 —— 整理链路时最常见的起手式。
 * 已经在画布上的(按 ref 认)不重复加,连线照样连到已有的那个。
 */
export function fromLineage(
  graph: Graph, id: string, origin: { x: number; y: number },
  existing: CanvasNode[], withNeighbors: boolean,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const center = byId.get(id);
  if (!center) return { nodes: [], edges: [] };
  const placed = new Map(existing.filter((n) => n.ref).map((n) => [n.ref!, n.id]));
  const nodes: CanvasNode[] = [];
  const place = (refId: string, x: number, y: number) => {
    const hit = placed.get(refId);
    if (hit) return hit;
    const g = byId.get(refId);
    const style = KIND_STYLE[g?.kind ?? "table"];
    const node = newNode(style.shape, x, y, { text: g?.label ?? refId, color: style.color, ref: refId });
    nodes.push(node);
    placed.set(refId, node.id);
    return node.id;
  };
  const centerId = place(id, origin.x, origin.y);
  const edges: CanvasEdge[] = [];
  if (withNeighbors) {
    const ups = graph.up.get(id) ?? [];
    const downs = graph.down.get(id) ?? [];
    const gapX = 240, gapY = 100;
    ups.forEach((e, i) => {
      const from = place(e.from, origin.x - gapX, origin.y + (i - (ups.length - 1) / 2) * gapY);
      edges.push(newEdge(from, centerId, { label: e.kind, fromHandle: "right", toHandle: "left" }));
    });
    downs.forEach((e, i) => {
      const to = place(e.to, origin.x + gapX, origin.y + (i - (downs.length - 1) / 2) * gapY);
      edges.push(newEdge(centerId, to, { label: e.kind, fromHandle: "right", toHandle: "left" }));
    });
  }
  return { nodes, edges };
}

/**
 * 新形状放哪:以画面中心为起点,一圈圈往外找第一个不压住别的形状的空位。
 * 连点几次「方框」就会一个挨一个排开,而不是叠成一摞。分组框不算障碍 —— 东西本来就该放进框里。
 * 返回左上角坐标(对齐 8px 网格)。
 */
export function findFreeSpot(
  nodes: Pick<CanvasNode, "x" | "y" | "w" | "h" | "shape">[],
  w: number, h: number, center: { x: number; y: number }, gap = 24,
): { x: number; y: number } {
  const snap = (v: number) => Math.round(v / 8) * 8;
  const blocks = nodes.filter((n) => n.shape !== "group");
  const free = (x: number, y: number) => blocks.every((n) =>
    x + w + gap <= n.x || n.x + n.w + gap <= x || y + h + gap <= n.y || n.y + n.h + gap <= y);
  const x0 = center.x - w / 2, y0 = center.y - h / 2;
  const stepX = w + gap, stepY = h + gap;
  for (let ring = 0; ring <= 12; ring += 1) {
    // 同一圈里先右、再下、再左、再上 —— 先往右排,符合从左到右画链路的习惯
    const cells: [number, number][] = [];
    for (let i = -ring; i <= ring; i += 1) for (let j = -ring; j <= ring; j += 1)
      if (Math.max(Math.abs(i), Math.abs(j)) === ring) cells.push([i, j]);
    cells.sort((a, b) => Math.abs(a[1]) - Math.abs(b[1]) || Math.abs(a[0]) - Math.abs(b[0]) || b[0] - a[0] || b[1] - a[1]);
    for (const [i, j] of cells) {
      const x = snap(x0 + i * stepX), y = snap(y0 + j * stepY);
      if (free(x, y)) return { x, y };
    }
  }
  return { x: snap(x0), y: snap(y0) };
}

/** 保存前后比较「有没有改动」用:只看内容,不看选中状态这类界面细节。 */
export const contentKey = (doc: Pick<CanvasDoc, "name" | "nodes" | "edges">) =>
  JSON.stringify([doc.name, doc.nodes, doc.edges]);
