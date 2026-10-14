/* 链路画布的纯数据(canvasModel)和 React Flow 画布对象之间的换算,以及形状节点要用的编辑上下文。
 * 存盘、撤销时从画布对象换回纯数据 —— 字段一个都不能丢,有往返测试守着(test-lineage-canvas)。 */
import { createContext } from "react";
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import { COLOR_VALUE, STROKE_PX, markerSize, type Box, type CanvasEdge, type CanvasNode, type LineType } from "./canvasModel";

export type ShapeData = CanvasNode & Record<string, unknown>;
export type EdgeData = CanvasEdge & Record<string, unknown>;
export type FlowNode = Node<ShapeData, "shape">;
export type FlowEdge = Edge<EdgeData>;
export type Side = "top" | "right" | "bottom" | "left";

// 分组框垫在最底下,不挡住框里的东西;其余按叠放次序
export const zOf = (n: Pick<CanvasNode, "shape" | "z">) => (n.shape === "group" ? -1000 : 0) + (n.z ?? 0);
export const toFlowNode = (n: CanvasNode): FlowNode => ({
  id: n.id, type: "shape", position: { x: n.x, y: n.y }, width: n.w, height: n.h,
  data: { ...n } as ShapeData,
  zIndex: zOf(n),
});
export const fromFlowNode = (n: FlowNode): CanvasNode => {
  const { x: _x, y: _y, w: _w, h: _h, ...rest } = n.data;
  void _x; void _y; void _w; void _h;
  return {
    ...(rest as Omit<CanvasNode, "x" | "y" | "w" | "h">),
    x: Math.round(n.position.x), y: Math.round(n.position.y),
    w: Math.round(n.width ?? n.measured?.width ?? 120), h: Math.round(n.height ?? n.measured?.height ?? 48),
  };
};
export const boxOf = (n: FlowNode): Box => ({
  id: n.id, x: n.position.x, y: n.position.y,
  w: n.width ?? n.measured?.width ?? 120, h: n.height ?? n.measured?.height ?? 48,
});
const EDGE_TYPE: Record<LineType, string> = { smooth: "default", step: "smoothstep", sharp: "step", straight: "straight" };
export const toFlowEdge = (e: CanvasEdge, selected = false): FlowEdge => {
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
export const fromFlowEdge = (e: FlowEdge): CanvasEdge => ({
  ...(e.data as CanvasEdge), from: e.source, to: e.target,
  fromHandle: e.sourceHandle ?? undefined, toHandle: e.targetHandle ?? undefined,
});

/* 格式刷带走的样式 */
export type NodeStyle = Pick<CanvasNode, "color" | "fill" | "dashed" | "fontSize" | "bold">;
export const styleOf = (n: CanvasNode): NodeStyle => ({ color: n.color, fill: n.fill, dashed: n.dashed, fontSize: n.fontSize, bold: n.bold });

/* 形状节点双击改字、改大小前记撤销,都走编辑器;节点组件从这里拿 */
export interface ShapeCtx {
  editingId: string | null;
  startEdit: (id: string) => void;
  commitText: (id: string, text: string) => void;
  cancelEdit: () => void;
  beginChange: () => void;
}
export const ShapeContext = createContext<ShapeCtx | null>(null);
