/* 画布上画出来的东西:形状节点(含双击改字、改大小)、流动的线、拖动时的对齐参考线、工具栏里的形状图标。 */
import { memo, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { BaseEdge, EdgeText, Handle, NodeResizer, Position, ViewportPortal, useViewport, type EdgeProps, type NodeProps } from "@xyflow/react";
import { Link2 } from "lucide-react";
import {
  COLOR_VALUE, DASH_PX_PER_S, PULSE_SECONDS, cometLength, dotCount, textColorValue, travelSeconds,
  type CanvasEdge, type FlowStyle, type Guide, type ShapeKind,
} from "./canvasModel";
import { linePath } from "./canvasExport";
import { ShapeContext, type FlowEdge, type FlowNode } from "./canvasFlow";

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

export const ShapeNode = memo(function ShapeNode({ id, data, selected }: NodeProps<FlowNode>) {
  const ctx = useContext(ShapeContext)!;
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
        <span className="cv-label" style={data.textColor ? { color: textColorValue(data.textColor) } : undefined}>{data.text}</span>
      )}
    </div>
  );
});

/* ---------- 流动的线 ----------
   底下照常是一根线(带箭头、标签、点击区域),上面叠一层动效:
   · 虚线:线本身变成虚线往前走;
   · 光点:几个带光晕的小圆点沿线跑(SVG 的 animateMotion,跟着线的形状拐弯);
   · 彗星:一段亮头 + 渐隐的拖尾沿线划过;
   · 呼吸:整根线外面一圈光,一明一暗。
   动效都按线的实际长度算时长,长线短线看起来流速一样。动效层不接鼠标,点线还是点在底下那根上。 */
export const FlowFxEdge = memo(function FlowFxEdge(props: EdgeProps<FlowEdge>) {
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

/* 拖动时的对齐参考线(画在画布坐标里,线宽按缩放反算,永远是 1 像素) */
export function GuideLines({ guides }: { guides: Guide[] }) {
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
export function ShapeIcon({ shape }: { shape: ShapeKind }) {
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
