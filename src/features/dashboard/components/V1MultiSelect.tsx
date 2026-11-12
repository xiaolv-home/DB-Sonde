import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search, X } from "lucide-react";

export interface V1SelectOption { value: string; label: string }

interface Props {
  ariaLabel: string;
  options: V1SelectOption[];
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  searchable?: boolean;
  onOpen?: () => void;
}

export default function V1MultiSelect({ ariaLabel, options, values, onChange, placeholder = "请选择", searchable = false, onOpen }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState({ top: 0, left: 0, width: 220, maxHeight: 360 });
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /* 菜单是 position:fixed 挂在 body 上的,所以得自己算放不放得下。
     以前只写 top = 触发器底边 + 5,触发器要是在窗口下半截(锁定数据范围就在左栏最底下),
     菜单直接垂到窗口外面 —— 列表是能滚,可滚到的部分在屏幕以下,看上去就是"后面几项没了"。
     下面放不下就翻到上面去,高度再按实际空隙收一下。 */
  const place = () => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(220, rect.width);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const gap = 5;
    const margin = 8;
    const below = window.innerHeight - rect.bottom - gap - margin;
    const above = rect.top - gap - margin;
    // 上面明显更宽敞才翻,否则宁可留在下面 —— 菜单老在触发器上下跳更难用。
    const flip = below < 180 && above > below;
    const maxHeight = Math.max(120, Math.min(360, flip ? above : below));
    setPosition({ top: flip ? Math.max(margin, rect.top - gap - maxHeight) : rect.bottom + gap, left, width, maxHeight });
  };
  /* useLayoutEffect:画完再挪的话,菜单会先在左上角闪一帧。 */
  useLayoutEffect(() => {
    if (!open) return;
    place();
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { document.removeEventListener("mousedown", close); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);

  const labels = new Map(options.map((option) => [option.value, option.label]));
  const filtered = options.filter((option) => !query || option.label.toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = (value: string) => onChange(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);
  /* onOpen 会去查候选值(里面 setState),不能放在 setOpen 的 updater 里 ——
     那个函数 React 在渲染期间调,渲染里改别的组件的 state 会报
     "Cannot update a component while rendering a different component"。 */
  const toggleOpen = () => {
    if (!open) onOpen?.();
    setOpen((value) => !value);
  };
  return (
    <div ref={rootRef} className={`dash-v1-multi ${open ? "open" : ""}`}>
      <div className="dash-v1-multi-trigger" role="combobox" aria-label={ariaLabel} aria-expanded={open} tabIndex={0} onClick={toggleOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleOpen(); } }}>
        <div className="dash-v1-multi-values">
          {values.length === 0 && <span className="placeholder">{placeholder}</span>}
          {values.map((value) => <span className="dash-v1-multi-chip" key={value}>{labels.get(value) ?? value}<button title="移除" onClick={(event) => { event.stopPropagation(); toggle(value); }}><X size={11} /></button></span>)}
        </div>
        <ChevronDown className="dash-v1-multi-chevron" size={14} />
      </div>
      {open && createPortal(
        <div ref={menuRef} className="dash-v1-multi-menu" style={position}>
          {searchable && <label className="dash-v1-multi-search"><Search size={13} /><input autoFocus placeholder="搜索选项" value={query} onChange={(event) => setQuery(event.target.value)} /></label>}
          <div className="dash-v1-multi-options">
            {filtered.length === 0 && <div className="dash-v1-multi-empty">无可选项</div>}
            {filtered.map((option) => {
              const selected = values.includes(option.value);
              return <button type="button" className={selected ? "selected" : ""} key={option.value} onClick={() => toggle(option.value)}><span>{option.label}</span>{selected && <Check size={14} />}</button>;
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
