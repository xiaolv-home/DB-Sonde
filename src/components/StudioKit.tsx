/**
 * 看板 / 数据集工作台共用的小部件:浮层、分段按钮、开关、表单行、可折叠分组、取值挑选器。
 *
 * 都很小,放一个文件里 —— 拆成十个文件只会让人在目录里翻。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronRight, Loader2, Plus, Search } from "lucide-react";
import "./studio-kit.css";

/* ── 浮层 ─────────────────────────────────────────────────────────── */

/**
 * 贴着某个元素弹出的浮层。挂在 body 上(不被面板的 overflow 裁掉),
 * 下面放不下就翻到上面,左右不出窗口;点外面、按 Esc 关。
 */
export function Pop({ anchor, onClose, width = 260, children, className = "" }: {
  anchor: HTMLElement | null;
  onClose: () => void;
  width?: number;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor?.getBoundingClientRect();
      if (!rect) return;
      const gap = 6, margin = 10;
      const below = window.innerHeight - rect.bottom - gap - margin;
      const above = rect.top - gap - margin;
      const height = ref.current?.scrollHeight ?? 300;
      const flip = below < Math.min(height, 260) && above > below;
      const maxHeight = Math.max(140, flip ? above : below);
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
      setPos({ top: flip ? Math.max(margin, rect.top - gap - Math.min(height, maxHeight)) : rect.bottom + gap, left, maxHeight });
    };
    place();
    // 内容后到(候选值查回来了)会把浮层撑高,得重新量一次,不然下半截跑到窗口外
    const grow = new ResizeObserver(() => place());
    if (ref.current) grow.observe(ref.current.firstElementChild ?? ref.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { grow.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchor, width]);

  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      // 浮层里再弹出的浮层(取值列表里的颜色选择等)也挂在 body 上,点它不算点外面
      if ((t as HTMLElement).closest?.(".st-pop")) return;
      closeRef.current();
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); closeRef.current(); } };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key, true); };
  }, [anchor]);

  return createPortal(
    <div ref={ref} className={`st-pop ${className}`} style={{ width, top: pos?.top ?? -9999, left: pos?.left ?? -9999, maxHeight: pos?.maxHeight }}
      onMouseDown={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

/** 一个按钮 + 它的浮层。最常见的用法,省得每处都管 anchor 和 open。 */
export function PopButton({ label, className = "", title, width, children, disabled }: {
  label: ReactNode;
  className?: string;
  title?: string;
  width?: number;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button type="button" className={`${className} ${anchor ? "on" : ""}`} title={title} disabled={disabled}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>{label}</button>
      {anchor && <Pop anchor={anchor} width={width} onClose={() => setAnchor(null)}>{children(() => setAnchor(null))}</Pop>}
    </>
  );
}

/** 浮层里的一行菜单项。 */
export function MenuItem({ icon, children, hint, onClick, danger, on, disabled }: {
  icon?: ReactNode; children: ReactNode; hint?: ReactNode; onClick: () => void; danger?: boolean; on?: boolean; disabled?: boolean;
}) {
  return (
    <button type="button" className={`st-menu-item ${danger ? "danger" : ""} ${on ? "on" : ""}`} onClick={onClick} disabled={disabled}>
      {icon}<span>{children}</span>{hint && <small>{hint}</small>}{on && <Check size={13} className="st-menu-check" />}
    </button>
  );
}

/* ── 表单 ─────────────────────────────────────────────────────────── */

export function Seg<T extends string | number>({ value, options, onChange, size }: {
  value: T;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  onChange: (value: T) => void;
  size?: "sm";
}) {
  return (
    <div className={`st-seg ${size ?? ""}`} role="radiogroup">
      {options.map((o) => (
        <button type="button" key={String(o.value)} role="radio" aria-checked={o.value === value} title={o.title}
          className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="st-toggle">
      <span className="st-toggle-text"><span>{label}</span>{hint && <small>{hint}</small>}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <i aria-hidden />
    </label>
  );
}

export function Row({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="st-row">
      <span className="st-row-label">{label}{hint && <small>{hint}</small>}</span>
      <div className="st-row-ctl">{children}</div>
    </div>
  );
}

export function Num({ value, onChange, min, max, step, placeholder, suffix }: {
  value: number | undefined; onChange: (v: number | undefined) => void;
  min?: number; max?: number; step?: number; placeholder?: string; suffix?: string;
}) {
  return (
    <span className="st-num">
      <input type="number" value={value ?? ""} min={min} max={max} step={step} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />
      {suffix && <em>{suffix}</em>}
    </span>
  );
}

export function Text({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input className="st-input" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

export function Color({ value, onChange, fallback }: { value: string | undefined; onChange: (v: string | undefined) => void; fallback: string }) {
  return (
    <span className={`st-color ${value ? "" : "unset"}`}>
      <input type="color" value={value ?? fallback} onChange={(e) => onChange(e.target.value)} />
      {value && <button type="button" title="恢复默认" onClick={() => onChange(undefined)}>×</button>}
    </span>
  );
}

export function Sel<T extends string | number>({ value, options, onChange }: {
  value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void;
}) {
  return (
    <span className="st-sel">
      <select value={String(value)} onChange={(e) => {
        const hit = options.find((o) => String(o.value) === e.target.value);
        if (hit) onChange(hit.value);
      }}>
        {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
      <ChevronDown size={12} />
    </span>
  );
}

/** 可折叠的一组设置。标题右边可以放一个小摘要,折起来也看得到当前状态。 */
export function Section({ title, children, defaultOpen = true, aside, id }: {
  title: ReactNode; children: ReactNode; defaultOpen?: boolean; aside?: ReactNode; id?: string;
}) {
  const key = id ? `sonde.studio.section.${id}` : undefined;
  const [open, setOpen] = useState(() => {
    if (!key) return defaultOpen;
    try { const v = localStorage.getItem(key); return v == null ? defaultOpen : v === "1"; } catch { return defaultOpen; }
  });
  const toggle = () => {
    setOpen((v) => {
      try { if (key) localStorage.setItem(key, v ? "0" : "1"); } catch { /* 存不了就只在这次生效 */ }
      return !v;
    });
  };
  return (
    <section className={`st-section ${open ? "open" : ""}`}>
      <button type="button" className="st-section-head" onClick={toggle}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<b>{title}</b>
        {aside && <span className="st-section-aside">{aside}</span>}
      </button>
      {open && <div className="st-section-body">{children}</div>}
    </section>
  );
}

/* ── 取值挑选 ───────────────────────────────────────────────────────── */

/**
 * 挑取值:搜索 + 勾选。候选从数据库里来,也能直接敲一个不在列表里的值回车加上
 * (候选只列了前几百个,长尾的值得能手输)。
 */
export function ValuePicker({ options, selected, onChange, loading, truncated, multi = true, autoFocus = true }: {
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
  loading?: boolean;
  truncated?: boolean;
  multi?: boolean;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const list = term ? options.filter((v) => v.toLowerCase().includes(term)) : options;
  const toggle = (v: string) => {
    if (!multi) return onChange(selected[0] === v ? [] : [v]);
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  };
  const addTyped = () => {
    const v = q.trim();
    if (!v) return;
    if (!selected.includes(v)) onChange(multi ? [...selected, v] : [v]);
    setQ("");
  };
  const extra = selected.filter((v) => !options.includes(v));
  return (
    <div className="st-values">
      <label className="st-search">
        <Search size={13} />
        <input autoFocus={autoFocus} value={q} placeholder="搜索,或输入后回车" onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (list.length === 1 && !term.includes(",")) toggle(list[0]); else addTyped(); } }} />
        {loading && <Loader2 size={13} className="spin" />}
      </label>
      {multi && options.length > 0 && (
        <div className="st-values-bar">
          <button type="button" onClick={() => onChange([...new Set([...selected, ...list])])}>全选{term ? "结果" : ""}</button>
          <button type="button" onClick={() => onChange([])} disabled={!selected.length}>清空</button>
          <span>{selected.length ? `已选 ${selected.length}` : ""}</span>
        </div>
      )}
      <div className="st-values-list">
        {[...extra, ...list].slice(0, 500).map((v) => (
          <button type="button" key={v} className={selected.includes(v) ? "on" : ""} onClick={() => toggle(v)}>
            <span className="st-check">{selected.includes(v) && <Check size={11} />}</span>
            <span className="st-values-text">{v === "" ? "(空字符串)" : v}</span>
          </button>
        ))}
        {!loading && !list.length && !extra.length && (
          term ? <button type="button" className="st-values-add" onClick={addTyped}><Plus size={12} />用「{q.trim()}」</button>
            : <p className="st-empty">没有候选值,直接输入</p>
        )}
      </div>
      {truncated && <p className="st-foot-note">取值太多,只列出前 {options.length} 个;别的可以直接输入。</p>}
    </div>
  );
}

/** 输入框失焦或回车才提交 —— 标题这类边打边存会把每个字都记进撤销历史。 */
export function CommitInput({ value, onCommit, className = "st-input", placeholder, ariaLabel }: {
  value: string; onCommit: (v: string) => void; className?: string; placeholder?: string; ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input className={className} value={draft} placeholder={placeholder} aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (draft !== value) onCommit(draft); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") { setDraft(value); requestAnimationFrame(() => (e.target as HTMLInputElement).blur()); }
      }} />
  );
}
