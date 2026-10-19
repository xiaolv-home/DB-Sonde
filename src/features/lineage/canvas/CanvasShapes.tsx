/* 画布上画出来的东西:形状节点(含双击改字、改大小)、线(流动效果、拖中间的圆点改弧度)、拖动时的对齐参考线、工具栏里的形状图标。 */
import { memo, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import {
  BaseEdge, EdgeLabelRenderer, EdgeText, Handle, NodeResizer, NodeToolbar, Position, ViewportPortal, useInternalNode, useReactFlow, useViewport,
  type EdgeProps, type NodeProps,
} from "@xyflow/react";
import { Link2, MessageSquarePlus, MessageSquareText, Pencil } from "lucide-react";
import {
  COLOR_VALUE, DASH_PX_PER_S, PULSE_SECONDS, cometLength, dotCount, textColorValue, travelSeconds,
  type CanvasEdge, type FlowStyle, type Guide, type ShapeKind,
} from "./canvasModel";
import { bendFor, linePath, type PathArgs } from "./canvasExport";
import { cometTiming, cometTrip } from "./canvasAnimation";
import { FlowSyncContext, ShapeContext, type FlowEdge, type FlowNode } from "./canvasFlow";

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

const SIDES = ["top", "right", "bottom", "left"] as const;
const SIDE_POSITION = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left } as const;

export const ShapeNode = memo(function ShapeNode({ id, data, selected }: NodeProps<FlowNode>) {
  const ctx = useContext(ShapeContext)!;
  const editing = ctx.editingId === id;
  const [draft, setDraft] = useState(data.text);
  useEffect(() => { if (editing) setDraft(data.text); }, [editing, data.text]);
  // 分叉点:中间一个圆点(拖它挪位置),四周的连接点拖出去就是新分支;没有文字、不能改大小
  if (data.shape === "junction") {
    return (
      <div className={`cv-node cv-junction${selected ? " is-selected" : ""}`} style={{ "--c": COLOR_VALUE[data.color] } as CSSProperties}
        title="分叉点:拖圆点挪位置,从四周的小圆圈拖出新的线就是一个分支">
        {SIDES.map((side) => <Handle key={side} id={side} type="source" className="cv-handle" position={SIDE_POSITION[side]} />)}
      </div>
    );
  }
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
      {SIDES.map((side) => <Handle key={side} id={side} type="source" className="cv-handle" position={SIDE_POSITION[side]} />)}
      {data.ref && <span className="cv-ref" title={`来自血缘:${data.ref}`}><Link2 size={11} /></span>}
      {data.comment && <span className="cv-cmt-badge" title="有注释:点一下形状就能看"><MessageSquareText size={11} /></span>}
      <CommentCard id={id} comment={data.comment} visible={ctx.soloId === id && !editing} />
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

/* 注释卡片:只选中这一个形状时在它下面弹出来。有注释就显示(点「改」或双击文字改),没有就给个「添加注释」。
   卡片不跟着画布缩放,字始终看得清;回车换行,⌘↩ 或点别处保存,Esc 不改。 */
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
function CommentCard({ id, comment, visible }: { id: string; comment?: string; visible: boolean }) {
  const ctx = useContext(ShapeContext)!;
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => { if (!visible) setDraft(null); }, [visible]);
  if (!visible) return null;
  const save = () => { if (draft !== null) ctx.commitComment(id, draft); setDraft(null); };
  return (
    // 卡片是挂在形状下面的浮层,但 React 的事件会顺着组件树冒到画布上:点卡片会被当成「点空白」把形状取消选中、卡片跟着关掉。全拦下
    <NodeToolbar isVisible position={Position.Bottom} offset={10} className="cv-cmt nodrag nopan nowheel"
      onPointerDown={stop} onMouseDown={stop} onClick={stop} onDoubleClick={stop} onContextMenu={stop}>
      {draft !== null ? (
        <textarea
          className="cv-cmt-edit"
          autoFocus
          value={draft}
          placeholder="写点说明:口径、来源、注意事项…"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") setDraft(null);
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
          }}
        />
      ) : comment ? (
        <div className="cv-cmt-view">
          <div className="cv-cmt-text" title="双击修改" onDoubleClick={() => setDraft(comment)}>{comment}</div>
          <button className="icon-btn" title="改注释" onClick={() => setDraft(comment)}><Pencil size={12} /></button>
        </div>
      ) : (
        <button className="cv-cmt-add" onClick={() => setDraft("")}><MessageSquarePlus size={12} /> 添加注释</button>
      )}
    </NodeToolbar>
  );
}

/* ---------- 线 ----------
   画布上所有的线都走这里。选中时中间有个圆点:拖它决定线从哪儿过(两头不动),双击圆点恢复默认弧度。
   流动的线在底下那根线(带箭头、标签、点击区域)上面再叠一层动效:
   · 虚线:线本身变成虚线往前走;
   · 光点:几个带光晕的小圆点沿线跑(SVG 的 animateMotion,跟着线的形状拐弯);
   · 彗星:一段亮头 + 渐隐的拖尾沿线划过;
   · 呼吸:整根线外面一圈光,一明一暗。
   动效都按线的实际长度算时长,长线短线看起来流速一样。动效层不接鼠标,点线还是点在底下那根上。 */
export const LineEdge = memo(function LineEdge(props: EdgeProps<FlowEdge>) {
  const { id, data, selected, source, target, sourcePosition, targetPosition, style, markerEnd, markerStart,
    label, labelStyle, labelBgStyle, labelBgPadding, labelBgBorderRadius, interactionWidth } = props;
  const e = data as CanvasEdge;
  // 接在分叉点上的一头改接到圆心(和导出图片里一样),几根线在圆点底下汇成一点
  const from = junctionCenter(useInternalNode(source)) ?? { x: props.sourceX, y: props.sourceY };
  const to = junctionCenter(useInternalNode(target)) ?? { x: props.targetX, y: props.targetY };
  const args: PathArgs = { sourceX: from.x, sourceY: from.y, sourcePosition, targetX: to.x, targetY: to.y, targetPosition };
  const [path, labelX, labelY] = linePath(e.line, args, e.bend);
  const measureRef = useRef<SVGPathElement>(null);
  const [len, setLen] = useState(0);
  // 线一变形就重量长度(动效按长度算时长);差得不多就不动,免得拖动时每一帧都重设动画
  useLayoutEffect(() => {
    if (!e.flow) return;
    const l = measureRef.current?.getTotalLength() ?? 0;
    if (Math.abs(l - len) > 6) setLen(l);
  }, [path, len, e.flow]);
  const kind: FlowStyle = e.flowStyle ?? "dash";
  const speed = e.flowSpeed ?? 2;
  // 彗星:报上自己跑一趟要多久,拿回自己在这一组里的时间表(过分叉点接力、同一处出发同步)
  const sync = useContext(FlowSyncContext);
  const report = sync?.report;
  const own = e.flow && kind === "comet" && len > 1 ? cometTrip(len, speed) : null;
  useEffect(() => { if (own) report?.(id, own); }, [own?.trip, own?.arrive, id, report]); // eslint-disable-line react-hooks/exhaustive-deps -- 按数值比,own 每次都是新对象
  const fc = COLOR_VALUE[e.flowColor ?? e.color];
  const sw = Number((style as CSSProperties | undefined)?.strokeWidth ?? 1.6);
  const base: CSSProperties = { ...style };
  if (e.flow && kind === "dash") {
    // 虚线一格 11px(6 实 5 空),一秒走 DASH_PX_PER_S 像素
    Object.assign(base, { strokeDasharray: "6 5", animation: `cv-flow-dash ${(11 / DASH_PX_PER_S[speed]).toFixed(3)}s linear infinite` });
    if (e.flowColor) base.stroke = fc;
  }
  const pid = `cvf-${id}`;
  let fx: ReactNode = null;
  if (e.flow && len > 1 && kind === "dot") {
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
  if (e.flow && len > 1 && kind === "comet") {
    const c = cometLength(len);
    const head = c * 0.3;
    const timing = cometTiming(own!.trip, sync?.slotOf(id));
    const { values, keyTimes } = timing;
    const dur = `${timing.dur.toFixed(3)}s`;
    // 一段长 c 的实线、后面空出整根线那么长:一次只露一颗彗星。dashoffset 从 c 走到 -len,正好从起点外划到终点外;
    // 没轮到(接力还没传到这根)就停在起点外面,跑完了停在终点外面,等这一轮结束
    const seg = (w: number, length: number, opacity: number, from: number, to: number, color = fc) => (
      <path d={path} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" opacity={opacity} strokeDasharray={`${length} ${len + c}`}>
        <animate attributeName="stroke-dashoffset" values={values(from, to)} keyTimes={keyTimes} dur={dur} repeatCount="indefinite" />
      </path>
    );
    fx = <>
      {seg(sw + 7, c, 0.12, c, -len)}
      {seg(sw + 2.5, c, 0.45, c, -len)}
      {seg(sw + 3, head, 0.95, head, -len - (c - head))}
      {seg(Math.max(1, sw * 0.6), head * 0.6, 0.9, head * 0.6, -len - (c - head * 0.6), "#fff")}
    </>;
  }
  if (e.flow && kind === "pulse") {
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
      {e.flow && <path ref={measureRef} id={pid} d={path} fill="none" stroke="none" />}
      {fx && <g className="cv-flowfx" pointerEvents="none">{fx}</g>}
      {/* 文字最后画,光点、彗星从底下穿过去,不会盖住字 */}
      {label && <EdgeText x={labelX} y={labelY} label={label} labelStyle={labelStyle} labelBgStyle={labelBgStyle}
        labelBgPadding={labelBgPadding} labelBgBorderRadius={labelBgBorderRadius} />}
      {selected && <BendHandle id={id} args={args} x={labelX} y={labelY} below={label ? 20 : 0} bent={!!e.bend} />}
    </>
  );
});

function junctionCenter(n: ReturnType<typeof useInternalNode>): { x: number; y: number } | null {
  if (!n || (n.data as { shape?: string } | undefined)?.shape !== "junction") return null;
  const { x, y } = n.internals.positionAbsolute;
  return { x: x + (n.measured.width ?? n.width ?? 0) / 2, y: y + (n.measured.height ?? n.height ?? 0) / 2 };
}

/* 线中间的圆点:拖它,线就从这儿过;双击恢复默认弧度。线上有字时圆点放在字下面,不挡字。 */
function BendHandle({ id, args, x, y, below, bent }: { id: string; args: PathArgs; x: number; y: number; below: number; bent: boolean }) {
  const ctx = useContext(ShapeContext)!;
  const flow = useReactFlow();
  const drag = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  const move = (ev: PointerEvent) => {
    if (!drag.current) return;
    // 真动了才记撤销:只是点一下不算一步
    if (!drag.current.moved) { drag.current.moved = true; ctx.beginChange(); }
    const p = flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
    ctx.bendEdge(id, bendFor(args, { x: p.x - drag.current.dx, y: p.y - drag.current.dy }));
  };
  return (
    <EdgeLabelRenderer>
      <div
        className={`cv-bend nodrag nopan${bent ? " is-bent" : ""}`}
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y + below}px)` }}
        title="拖动改变线从哪儿过 · 双击恢复默认弧度"
        onPointerDown={(ev) => {
          if (ev.button !== 0) return;
          ev.stopPropagation();
          ev.currentTarget.setPointerCapture(ev.pointerId);
          // 记住按下的地方离线上那个点多远,拖的时候线不会「跳」到鼠标上
          const p = flow.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
          drag.current = { dx: p.x - x, dy: p.y - y, moved: false };
        }}
        onPointerMove={move}
        onPointerUp={(ev) => { drag.current = null; ev.currentTarget.releasePointerCapture(ev.pointerId); }}
        onDoubleClick={(ev) => { ev.stopPropagation(); if (bent) { ctx.beginChange(); ctx.bendEdge(id, undefined); } }}
      />
    </EdgeLabelRenderer>
  );
}

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
