/* 编辑器顶栏和属性栏上的小部件:下拉菜单、颜色块、分段按钮,以及「从数据库添加表」的选择框。 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronDown, Search } from "lucide-react";
import { api } from "../../lib/api";
import type { ConnectionConfig, TableInfo } from "../../types";
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

/* 从数据库添加表:选连接、选库,搜表、勾几张,一次加进画布(每张一个「数据表」形状) */
export function TablePicker({ onPick, onClose }: { onPick: (tables: { ref: string; label: string }[]) => void; onClose: () => void }) {
  const [conns, setConns] = useState<ConnectionConfig[]>([]);
  const [connId, setConnId] = useState("");
  const [dbs, setDbs] = useState<string[]>([]);
  const [db, setDb] = useState("");
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    void api.listConnections().then((list) => { setConns(list); setConnId((id) => id || list[0]?.id || ""); }).catch((e) => setError(String(e)));
  }, []);
  const conn = conns.find((c) => c.id === connId);
  useEffect(() => {
    if (!connId) return;
    setDbs([]); setTables(null); setPicked(new Set()); setError("");
    let live = true;
    void api.listDatabases(connId)
      .then((list) => { if (!live) return; setDbs(list); setDb(list.includes(conn?.database ?? "") ? conn!.database : list[0] ?? ""); })
      .catch((e) => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [connId]); // eslint-disable-line react-hooks/exhaustive-deps -- 换连接才重读库,conn 跟着 connId 走
  useEffect(() => {
    if (!connId) return;
    setTables(null); setPicked(new Set());
    let live = true;
    void api.listTables(connId, db, "").then((list) => { if (live) setTables(list); }).catch((e) => { if (live) { setTables([]); setError(String(e)); } });
    return () => { live = false; };
  }, [connId, db]);
  const term = q.trim().toLowerCase();
  const list = (tables ?? []).filter((t) => !term || t.name.toLowerCase().includes(term) || (t.comment ?? "").toLowerCase().includes(term)).slice(0, 300);
  const refOf = (t: string) => `${conn?.name ?? connId} · ${db ? `${db}.` : ""}${t}`;
  const toggle = (name: string) => setPicked((p) => { const n = new Set(p); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  return (
    <div className="cv-picker" onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <div className="cv-picker-src">
        <select className="cv-select" value={connId} onChange={(e) => setConnId(e.target.value)} title="连接">
          {conns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {dbs.length > 1 && (
          <select className="cv-select" value={db} onChange={(e) => setDb(e.target.value)} title="库">
            {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
      </div>
      <div className="cv-picker-search">
        <Search size={13} />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜表名 / 注释…" />
      </div>
      <div className="cv-picker-list">
        {error && <div className="cv-picker-none">读不到表:{error}</div>}
        {!error && tables === null && <div className="cv-picker-none">正在读表…</div>}
        {!error && tables !== null && list.length === 0 && <div className="cv-picker-none">{conns.length ? "没有匹配的表" : "还没有数据库连接"}</div>}
        {list.map((t) => (
          <label key={t.name} className={`cv-picker-row ${picked.has(t.name) ? "on" : ""}`} title={t.comment ?? t.name}>
            <input type="checkbox" checked={picked.has(t.name)} onChange={() => toggle(t.name)} />
            <span className="cv-picker-name">{t.name}</span>
            {t.comment && <span className="cv-picker-kind">{t.comment}</span>}
          </label>
        ))}
      </div>
      <div className="cv-picker-foot">
        <button className="btn xs" onClick={onClose}>取消</button>
        <button className="btn xs primary" disabled={!picked.size}
          onClick={() => onPick([...picked].map((name) => ({ ref: refOf(name), label: name })))}>
          {picked.size ? `加入 ${picked.size} 张表` : "勾选要加入的表"}
        </button>
      </div>
    </div>
  );
}
