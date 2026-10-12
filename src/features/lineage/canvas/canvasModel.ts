/* 链路画布的数据模型 —— 纯数据,不依赖画布库,方便测试和以后换实现。
 *
 * 血缘图是「扫出来的」,画布是「人整理的」:把几张表、几个作业、几个指标
 * 摆成一条看得懂的链路,配上说明、分组、颜色。两者互不覆盖 ——
 * 画布里的节点可以引用血缘里的某个节点(ref),但改画布不会改血缘。 */
import { isIdentifiedList, isNonEmptyText, isRecord, isText } from "../../../lib/storedRepository";
import type { Graph, NodeKind } from "../lineageModel";
import { maxOf, minOf } from "../../../lib/numbers";

/** 最小 / 最大值(空数组当 0)。不用 Math.min(...arr):数组一长就爆栈。 */
export const lo = (values: readonly number[]) => minOf(values) ?? 0;
export const hi = (values: readonly number[]) => maxOf(values) ?? 0;

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

/* 前 8 个是最早就有的,存档里认得;后面是加的。顺序就是色板上的顺序(冷暖分开排)。 */
export const COLORS = ["gray", "blue", "green", "yellow", "orange", "red", "purple", "teal", "slate", "indigo", "cyan", "pink"] as const;
export type ColorKey = (typeof COLORS)[number];
export const COLOR_VALUE: Record<ColorKey, string> = {
  gray: "#8a8f98", blue: "#2f8ee6", green: "#2fa86b", yellow: "#d9a514",
  orange: "#e8772e", red: "#e0484e", purple: "#8b5cf6", teal: "#14a3a3",
  slate: "#52627a", indigo: "#5b63e6", cyan: "#0ea5c6", pink: "#e0559b",
};
export const COLOR_LABEL: Record<ColorKey, string> = {
  gray: "灰", blue: "蓝", green: "绿", yellow: "黄", orange: "橙", red: "红", purple: "紫", teal: "青",
  slate: "石板", indigo: "靛", cyan: "天蓝", pink: "粉",
};
export const PALETTE_ORDER: ColorKey[] = ["gray", "slate", "blue", "indigo", "cyan", "teal", "green", "yellow", "orange", "red", "pink", "purple"];

/** 填充:浅色底(默认)/ 实色底白字 / 只有边框 */
export const FILLS = ["soft", "solid", "outline"] as const;
export type FillKind = (typeof FILLS)[number];
export const FILL_LABEL: Record<FillKind, string> = { soft: "浅色", solid: "实色", outline: "线框" };

export const FONT_SIZES = [12, 14, 16, 20, 26] as const;
/** step 是圆角折线(最早就叫 step,存档里认得),sharp 是直角折线 */
export const LINE_TYPES = ["smooth", "step", "sharp", "straight"] as const;
export type LineType = (typeof LINE_TYPES)[number];
export const LINE_LABEL: Record<(typeof LINE_TYPES)[number], string> = { smooth: "曲线", step: "圆角折线", sharp: "直角折线", straight: "直线" };
export const ARROWS = ["end", "both", "none"] as const;
export type ArrowKind = (typeof ARROWS)[number];
/** 线宽档位:细 / 中 / 粗 */
export const LINE_WIDTHS = [1, 2, 3] as const;
export const STROKE_PX: Record<number, number> = { 1: 1.6, 2: 2.4, 3: 3.4 };
/** 箭头大小(以线宽为单位)。线越粗箭头按比例收一点,不然粗线的箭头大得吓人。 */
export const markerSize = (strokePx: number) => Math.max(9, 18 - (strokePx - 1.6) * 4);

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
  /** 不写 = 浅色底 */
  fill?: FillKind;
  /** 边框画成虚线 */
  dashed?: boolean;
  /** 叠放次序,大的在上面;不写 = 0 */
  z?: number;
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
  /** 线宽档位 1/2/3,不写 = 1 */
  width?: number;
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
    && (v.fill === undefined || oneOf(FILLS, v.fill))
    && (v.dashed === undefined || typeof v.dashed === "boolean")
    && (v.z === undefined || finite(v.z))
    && (v.ref === undefined || isText(v.ref));
}
export function isCanvasEdge(v: unknown): v is CanvasEdge {
  return isRecord(v) && isNonEmptyText(v.id) && isNonEmptyText(v.from) && isNonEmptyText(v.to)
    && (v.fromHandle === undefined || isText(v.fromHandle)) && (v.toHandle === undefined || isText(v.toHandle))
    && isText(v.label) && oneOf(COLORS, v.color) && oneOf(LINE_TYPES, v.line) && oneOf(ARROWS, v.arrow)
    && (v.dashed === undefined || typeof v.dashed === "boolean")
    && (v.flow === undefined || typeof v.flow === "boolean")
    && (v.width === undefined || (LINE_WIDTHS as readonly number[]).includes(v.width as number));
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

/* ======================================================================
 * 整理画面用的纯计算:对齐、等距、自动排版、拖动吸附、按分层上色。
 * 都只算位置 / 颜色,不改原数组,由编辑器决定怎么落进撤销栈。
 * ====================================================================== */
export interface Box { id: string; x: number; y: number; w: number; h: number }
export type Pos = Map<string, { x: number; y: number }>;

export const ALIGNS = ["left", "hcenter", "right", "top", "vmiddle", "bottom"] as const;
export type AlignKind = (typeof ALIGNS)[number];

/** 对齐到这批形状的外框:左/右/顶/底贴边,居中对齐外框中线。 */
export function alignBoxes(boxes: Box[], mode: AlignKind): Pos {
  const out: Pos = new Map();
  if (boxes.length < 2) return out;
  const left = lo(boxes.map((b) => b.x)), right = hi(boxes.map((b) => b.x + b.w));
  const top = lo(boxes.map((b) => b.y)), bottom = hi(boxes.map((b) => b.y + b.h));
  for (const b of boxes) {
    let { x, y } = b;
    if (mode === "left") x = left;
    if (mode === "right") x = right - b.w;
    if (mode === "hcenter") x = (left + right) / 2 - b.w / 2;
    if (mode === "top") y = top;
    if (mode === "bottom") y = bottom - b.h;
    if (mode === "vmiddle") y = (top + bottom) / 2 - b.h / 2;
    out.set(b.id, { x: Math.round(x), y: Math.round(y) });
  }
  return out;
}

/** 等距分布:两头的不动,中间的按顺序排开,让相邻两个之间的空隙一样大。至少 3 个才有意义。 */
export function distributeBoxes(boxes: Box[], axis: "h" | "v"): Pos {
  const out: Pos = new Map();
  if (boxes.length < 3) return out;
  const start = (b: Box) => axis === "h" ? b.x : b.y;
  const size = (b: Box) => axis === "h" ? b.w : b.h;
  const sorted = [...boxes].sort((a, b) => start(a) + size(a) / 2 - (start(b) + size(b) / 2));
  const first = sorted[0], last = sorted[sorted.length - 1];
  const span = start(last) + size(last) - start(first);
  const gap = (span - sorted.reduce((s, b) => s + size(b), 0)) / (sorted.length - 1);
  let cursor = start(first);
  for (const b of sorted) {
    out.set(b.id, axis === "h" ? { x: Math.round(cursor), y: b.y } : { x: b.x, y: Math.round(cursor) });
    cursor += size(b) + gap;
  }
  return out;
}

/** 数仓分层前缀 → 颜色。认 ods / dim / dwd / dws / ads(大小写都行,后面可以直接跟中文)。 */
const LAYER_COLOR: [RegExp, ColorKey][] = [
  [/^\s*ods(?![a-z])/i, "gray"],
  [/^\s*dim(?![a-z])/i, "purple"],
  [/^\s*dwd(?![a-z])/i, "blue"],
  [/^\s*dws(?![a-z])/i, "green"],
  [/^\s*ads(?![a-z])/i, "orange"],
];
export function layerColor(text: string): ColorKey | null {
  for (const [re, color] of LAYER_COLOR) if (re.test(text)) return color;
  return null;
}

export const LAYOUT_DIRS = ["BT", "TB", "LR"] as const;
export type LayoutDir = (typeof LAYOUT_DIRS)[number];
export const LAYOUT_LABEL: Record<LayoutDir, string> = { BT: "从下往上", TB: "从上往下", LR: "从左往右" };
type Side = "top" | "right" | "bottom" | "left";

/**
 * 自动排版(分层排法):有连线的形状按「上游 → 下游」一层一层排开,
 * 同一层里按邻居的平均位置排序,尽量少交叉。没连线的形状、分组框不动。
 * 排完整体还放回原来那片区域(外框左上角对齐),不会一下子飞到别处。
 * 同时给每条线挑好两头的连接点(朝向对方的那一边),线就顺了。
 */
export function autoLayout(
  nodes: (Pick<CanvasNode, "id" | "x" | "y" | "w" | "h" | "shape"> & { text?: string })[],
  edges: Pick<CanvasEdge, "id" | "from" | "to">[],
  dir: LayoutDir,
  gap = { across: 48, along: 96 },
): { positions: Pos; handles: Map<string, { fromHandle: Side; toHandle: Side }> } {
  const byId = new Map(nodes.filter((n) => n.shape !== "group").map((n) => [n.id, n]));
  const links = edges.filter((e) => e.from !== e.to && byId.has(e.from) && byId.has(e.to));
  const ids = [...new Set(links.flatMap((e) => [e.from, e.to]))];
  const positions: Pos = new Map();
  const handles = new Map<string, { fromHandle: Side; toHandle: Side }>();
  if (ids.length < 2) return { positions, handles };
  const vertical = dir !== "LR";
  // 同一层里先按现在的位置排 —— 尊重原来的大致摆法
  const crossOf = (id: string) => { const n = byId.get(id)!; return vertical ? n.x + n.w / 2 : n.y + n.h / 2; };
  const order0 = [...ids].sort((a, b) => crossOf(a) - crossOf(b));

  // 1. 拆环:深度优先,指回祖先的线不参与分层
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of links) if (!out.get(e.from)!.includes(e.to)) out.get(e.from)!.push(e.to);
  const state = new Map<string, 1 | 2>();
  const dag = new Map<string, string[]>(ids.map((id) => [id, []]));
  const visit = (u: string) => {
    state.set(u, 1);
    for (const v of out.get(u)!) {
      if (state.get(v) === 1) continue;             // 回边:跳过
      dag.get(u)!.push(v);
      if (!state.has(v)) visit(v);
    }
    state.set(u, 2);
  };
  // 先从真正的源头(没有任何线指进来)开始走,这样环会在「最下游绕回来」的那根线上断开
  const hasIn = new Set(links.map((e) => e.to));
  for (const id of [...order0.filter((i) => !hasIn.has(i)), ...order0]) if (!state.has(id)) visit(id);
  const preds = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const [u, vs] of dag) for (const v of vs) preds.get(v)!.push(u);

  // 2. 分层:最长路径;没有上游的往下游靠(紧挨着它最早的下游),免得源头全挤在第 0 层拉出长线
  const layer = new Map<string, number>();
  const indeg = new Map(ids.map((id) => [id, preds.get(id)!.length]));
  const queue = order0.filter((id) => indeg.get(id) === 0);
  for (const id of queue) layer.set(id, 0);
  for (let i = 0; i < queue.length; i += 1) {
    const u = queue[i];
    for (const v of dag.get(u)!) {
      layer.set(v, Math.max(layer.get(v) ?? 0, layer.get(u)! + 1));
      indeg.set(v, indeg.get(v)! - 1);
      if (indeg.get(v) === 0) queue.push(v);
    }
  }
  for (const id of ids) if (!layer.has(id)) layer.set(id, 0);
  // 数仓分层:名字带 ods / dwd / dws / ads 前缀的,同一层排在同一行(dim 位置各不相同,不强求)。
  // 组里互相有线的不强求(否则「同一行」和「下游在上游后面」打架)。
  const tierOf = (id: string) => { const t = byId.get(id)!.text ?? ""; const m = /^\s*(ods|dwd|dws|ads)(?![a-z])/i.exec(t); return m ? m[1].toLowerCase() : null; };
  const tiers = new Map<string, string[]>();
  for (const id of ids) {
    const t = tierOf(id);
    if (!t) continue;
    const list = tiers.get(t);
    if (list) list.push(id); else tiers.set(t, [id]);
  }
  for (const [t, members] of tiers) {
    const set = new Set(members);
    if (members.length < 2 || members.some((u) => dag.get(u)!.some((v) => set.has(v)))) tiers.delete(t);
  }
  const grouped = new Set([...tiers.values()].flat());
  // 没有上游的往下游靠(紧挨着它最早的下游),免得源头全挤在第 0 层拉出长线
  for (const id of ids) {
    const kids = dag.get(id)!;
    if (!grouped.has(id) && preds.get(id)!.length === 0 && kids.length) layer.set(id, Math.max(0, lo(kids.map((k) => layer.get(k)!)) - 1));
  }
  for (let round = 0, changed = true; changed && round < ids.length * 2; round += 1) {
    changed = false;
    for (const members of tiers.values()) {
      const top = hi(members.map((id) => layer.get(id)!));
      for (const id of members) if (layer.get(id) !== top) { layer.set(id, top); changed = true; }
    }
    for (const [u, vs] of dag) for (const v of vs) if (layer.get(v)! <= layer.get(u)!) { layer.set(v, layer.get(u)! + 1); changed = true; }
  }

  // 上面挪来挪去可能空出整层,压紧(顺序不变),免得中间留一大片空行
  const used = [...new Set(ids.map((id) => layer.get(id)!))].sort((x, y) => x - y);
  const dense = new Map(used.map((l, i) => [l, i]));
  for (const id of ids) layer.set(id, dense.get(layer.get(id)!)!);

  // 3. 层内排序:重心法上下来回扫几遍
  const depth = hi(ids.map((id) => layer.get(id)!)) + 1;
  const rows: string[][] = Array.from({ length: depth }, () => []);
  for (const id of order0) rows[layer.get(id)!].push(id);
  const nbrs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of links) { nbrs.get(e.from)!.push(e.to); nbrs.get(e.to)!.push(e.from); }
  const rank = new Map<string, number>();
  const reRank = () => rows.forEach((row) => row.forEach((id, i) => rank.set(id, i / Math.max(1, row.length - 1))));
  reRank();
  for (let pass = 0; pass < 6; pass += 1) {
    const range = pass % 2 === 0 ? [...rows.keys()].slice(1) : [...rows.keys()].reverse().slice(1);
    for (const r of range) {
      const ref = pass % 2 === 0 ? r - 1 : r + 1;
      const bary = (id: string) => {
        const ns = nbrs.get(id)!.filter((n) => layer.get(n) === ref);
        return ns.length ? ns.reduce((s, n) => s + rank.get(n)!, 0) / ns.length : rank.get(id)!;
      };
      rows[r].sort((a, b) => bary(a) - bary(b));
      reRank();
    }
  }

  // 4. 坐标:每层排成一行(竖排)或一列(横排),层与层之间按这层最大的尺寸留空
  const across = (id: string) => vertical ? byId.get(id)!.w : byId.get(id)!.h;
  const along = (id: string) => vertical ? byId.get(id)!.h : byId.get(id)!.w;
  const center = new Map<string, number>();         // 层内方向上的中心
  const widest = hi(rows.map((row) => row.reduce((s, id) => s + across(id), 0) + gap.across * (row.length - 1)));
  rows.forEach((row) => {
    const total = row.reduce((s, id) => s + across(id), 0) + gap.across * (row.length - 1);
    let cursor = (widest - total) / 2;
    for (const id of row) { center.set(id, cursor + across(id) / 2); cursor += across(id) + gap.across; }
  });
  // 往邻居的平均位置挪一挪(保持顺序和最小间距),线会更直
  const settle = (row: string[], ref: number) => {
    const want = row.map((id) => {
      const ns = nbrs.get(id)!.filter((n) => layer.get(n) === ref);
      return ns.length ? ns.reduce((s, n) => s + center.get(n)!, 0) / ns.length : center.get(id)!;
    });
    const pos = [...want];
    for (let i = 1; i < row.length; i += 1) pos[i] = Math.max(pos[i], pos[i - 1] + (across(row[i - 1]) + across(row[i])) / 2 + gap.across);
    for (let i = row.length - 2; i >= 0; i -= 1) pos[i] = Math.min(pos[i], pos[i + 1] - (across(row[i]) + across(row[i + 1])) / 2 - gap.across);
    row.forEach((id, i) => center.set(id, pos[i]));
  };
  for (let pass = 0; pass < 2; pass += 1) {
    for (let r = 1; r < depth; r += 1) settle(rows[r], r - 1);
    for (let r = depth - 2; r >= 0; r -= 1) settle(rows[r], r + 1);
  }
  const thick = rows.map((row) => hi(row.map(along)));
  const offset: number[] = [];
  thick.reduce((acc, t, i) => { offset[i] = acc; return acc + t + gap.along; }, 0);
  const total = offset[depth - 1] + thick[depth - 1];
  for (const id of ids) {
    const r = layer.get(id)!;
    // 层内居中对齐这一层的中线
    let a = offset[r] + (thick[r] - along(id)) / 2;
    if (dir === "BT") a = total - a - along(id);
    const c = center.get(id)! - across(id) / 2;
    positions.set(id, vertical ? { x: c, y: a } : { x: a, y: c });
  }

  // 5. 整体放回原来那片区域
  const minX = (m: Iterable<{ x: number }>) => lo([...m].map((p) => p.x));
  const minY = (m: Iterable<{ y: number }>) => lo([...m].map((p) => p.y));
  const dx = minX(ids.map((id) => byId.get(id)!)) - minX(positions.values());
  const dy = minY(ids.map((id) => byId.get(id)!)) - minY(positions.values());
  const snap = (v: number) => Math.round(v / 8) * 8;
  for (const [id, p] of positions) positions.set(id, { x: snap(p.x + dx), y: snap(p.y + dy) });

  // 6. 连接点:朝向对方的那一边
  for (const e of links) handles.set(e.id, facingSides(
    { ...byId.get(e.from)!, ...positions.get(e.from)! }, { ...byId.get(e.to)!, ...positions.get(e.to)! }, vertical));
  return { positions, handles };
}

/** 两个形状之间的线该从哪边出、从哪边进。preferVertical 时只要上下错开就走上下边。 */
export function facingSides(a: Omit<Box, "id">, b: Omit<Box, "id">, preferVertical = true): { fromHandle: Side; toHandle: Side } {
  const dx = b.x + b.w / 2 - (a.x + a.w / 2);
  const dy = b.y + b.h / 2 - (a.y + a.h / 2);
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  const vertical = preferVertical ? gapY > 0 || Math.abs(dy) >= Math.abs(dx) : !(gapX > 0 || Math.abs(dx) >= Math.abs(dy));
  if (vertical) return dy >= 0 ? { fromHandle: "bottom", toHandle: "top" } : { fromHandle: "top", toHandle: "bottom" };
  return dx >= 0 ? { fromHandle: "right", toHandle: "left" } : { fromHandle: "left", toHandle: "right" };
}

export interface Guide { axis: "x" | "y"; at: number; from: number; to: number }
/**
 * 拖动吸附:拖着的形状的左/中/右(上/中/下)离别的形状的某条边或中线不到 threshold 时吸过去,
 * 并给出要画的参考线。横竖各自独立吸。
 */
export function snapToGuides(moving: Omit<Box, "id">, others: Omit<Box, "id">[], threshold: number): { x: number; y: number; guides: Guide[] } {
  let best: { axis: "x" | "y"; delta: number; at: number; other: Omit<Box, "id"> }[] = [];
  const consider = (axis: "x" | "y") => {
    const mine = axis === "x" ? [moving.x, moving.x + moving.w / 2, moving.x + moving.w] : [moving.y, moving.y + moving.h / 2, moving.y + moving.h];
    let hit: { delta: number; at: number; other: Omit<Box, "id"> } | null = null;
    for (const o of others) {
      const theirs = axis === "x" ? [o.x, o.x + o.w / 2, o.x + o.w] : [o.y, o.y + o.h / 2, o.y + o.h];
      for (const m of mine) for (const t of theirs) {
        const d = t - m;
        if (Math.abs(d) <= threshold && (!hit || Math.abs(d) < Math.abs(hit.delta))) hit = { delta: d, at: t, other: o };
      }
    }
    if (hit) best = [...best, { axis, ...hit }];
  };
  consider("x"); consider("y");
  const dx = best.find((b) => b.axis === "x")?.delta ?? 0;
  const dy = best.find((b) => b.axis === "y")?.delta ?? 0;
  const x = moving.x + dx, y = moving.y + dy;
  const guides = best.map((b): Guide => b.axis === "x"
    ? { axis: "x", at: b.at, from: Math.min(y, b.other.y), to: Math.max(y + moving.h, b.other.y + b.other.h) }
    : { axis: "y", at: b.at, from: Math.min(x, b.other.x), to: Math.max(x + moving.w, b.other.x + b.other.w) });
  return { x, y, guides };
}
