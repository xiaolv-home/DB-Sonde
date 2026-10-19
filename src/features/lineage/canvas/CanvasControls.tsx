/* 编辑器顶栏和属性栏上的小部件:下拉菜单、颜色块、分段按钮,以及「从血缘添加」的选择框。 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { Graph } from "../lineageModel";
import { COLOR_LABEL, COLOR_VALUE, PALETTE_ORDER, TEXT_INKS, TEXT_INK_LABEL, type ColorKey, type TextColor } from "./canvasModel";

/* 顶栏上的下拉菜单 */
export function Menu({ label, icon, title, children }: { label: string; icon: ReactNode; title?: string; children: (close: () => void) => ReactNode }) {
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

export function Swatches({ value, onPick }: { value: string | null; onPick: (c: ColorKey) => void }) {
  return (
    <div className="cv-swatches" role="radiogroup" aria-label="颜色">
      {PALETTE_ORDER.map((c) => (
        <button key={c} className={`cv-swatch ${c === value ? "on" : ""}`} style={{ "--c": COLOR_VALUE[c] } as CSSProperties}
          title={COLOR_LABEL[c]} aria-checked={c === value} role="radio" onClick={() => onPick(c)} />
      ))}
    </div>
  );
}

/* 文字颜色:自动 / 黑 / 白 / 色板上的颜色 */
export function TextColorPicker({ value, onPick }: { value: TextColor | undefined; onPick: (c: TextColor | undefined) => void }) {
  const inks = Object.keys(TEXT_INKS) as (keyof typeof TEXT_INKS)[];
  return (
    <>
      <button className={`btn xs ${value ? "" : "on"}`} title="跟着填充走:实色底白字,分组框用框的颜色,其余深色字" onClick={() => onPick(undefined)}>自动</button>
      <div className="cv-swatches" role="radiogroup" aria-label="文字颜色">
        {inks.map((k) => (
          <button key={k} className={`cv-swatch cv-swatch-ink ${k === value ? "on" : ""}`} style={{ "--c": TEXT_INKS[k] } as CSSProperties}
            title={TEXT_INK_LABEL[k]} aria-checked={k === value} role="radio" onClick={() => onPick(k)} />
        ))}
      </div>
      <Swatches value={value ?? null} onPick={onPick} />
    </>
  );
}

export function Seg<T extends string>({ value, options, labels, onPick }: { value: T; options: readonly T[]; labels: Record<T, string>; onPick: (v: T) => void }) {
  return (
    <div className="cv-seg">
      {options.map((o) => <button key={o} className={o === value ? "on" : ""} onClick={() => onPick(o)}>{labels[o]}</button>)}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { table: "表", file: "文件", metric: "指标", dataset: "数据集", task: "作业", workflow: "工作流" };
export function LineagePicker({ graph, onPick, onClose }: { graph: Graph; onPick: (id: string, withNeighbors: boolean) => void; onClose: () => void }) {
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
