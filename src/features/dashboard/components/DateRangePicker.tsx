import { moveCalendarCursor } from "./calendarKeyboard";
import type { KeyboardEvent } from "react";
import { useId, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";

interface Props {
  start: string;
  end: string;
  onChange: (start: string, end: string) => void;
}

type Mode = "day" | "week" | "month" | "year";

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y || 2000, (m || 1) - 1, d || 1); };
const startOfToday = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const addDays = (base: Date, n: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);
const monthEnd = (y: number, m: number) => new Date(y, m + 1, 0);
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const MONTHS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

function presets(): { label: string; range: () => [string, string] }[] {
  const t = startOfToday();
  return [
    { label: "今天", range: () => [ymd(t), ymd(t)] },
    { label: "昨天", range: () => { const y = addDays(t, -1); return [ymd(y), ymd(y)]; } },
    { label: "近 7 天", range: () => [ymd(addDays(t, -6)), ymd(t)] },
    { label: "近 30 天", range: () => [ymd(addDays(t, -29)), ymd(t)] },
    { label: "本月", range: () => [ymd(new Date(t.getFullYear(), t.getMonth(), 1)), ymd(t)] },
    { label: "上月", range: () => [ymd(new Date(t.getFullYear(), t.getMonth() - 1, 1)), ymd(monthEnd(t.getFullYear(), t.getMonth() - 1))] },
    { label: "今年", range: () => [ymd(new Date(t.getFullYear(), 0, 1)), ymd(t)] },
    { label: "去年", range: () => [ymd(new Date(t.getFullYear() - 1, 0, 1)), ymd(new Date(t.getFullYear() - 1, 11, 31))] },
  ];
}

/**
 * 日期区间选择器 —— 单控件 + 弹层。四种粒度(日/周/月/年)都支持"点起点 → 点终点"选一段区间
 * (如 1 月–8 月、2021–2026 年)。portal 到 body(fixed + translateZ)避免被父容器滚动条穿透。
 */
export default function DateRangePicker({ start, end, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("day");
  const [pending, setPending] = useState<string | null>(null); // 已点起点、待点终点(代表日:日/周=当天,月=月首,年=年首)
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState(() => parse(end || start));
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight?: number }>({ top: 0, left: 0 });
  const dialogId = useId();
  const [cursor, setCursor] = useState(end || start);
  const focusPending = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  /* 按弹层**实际**大小放:下面放得下就往下,放不下翻到按钮上面,上下都不够就贴住窗口、
     弹层里面滚。原来一律往下放,按钮在窗口下半截时下面几行月份直接被窗口截掉,点不到。
     高度跟粒度变(日历 6 行比月份 4 行高),所以换粒度也要重新放。 */
  const place = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const gap = 6, margin = 8;
    const vw = window.innerWidth, vh = window.innerHeight;
    const width = popRef.current?.offsetWidth ?? 540;
    const height = popRef.current?.scrollHeight ?? 0;
    const left = Math.max(margin, Math.min(r.left, vw - width - margin));
    if (r.bottom + gap + height <= vh - margin) return setPos({ top: r.bottom + gap, left });
    if (r.top - gap - height >= margin) return setPos({ top: r.top - gap - height, left });
    const maxHeight = vh - margin * 2;
    setPos({ top: Math.max(margin, Math.min(r.bottom + gap, vh - margin - height)), left, maxHeight: height > maxHeight ? maxHeight : undefined });
  };
  // 弹层画出来、尺寸确定之后再量一次(第一次 place 时还没有弹层,量不到高度)。
  useLayoutEffect(() => { if (open) place(); }, [open, mode]);
  const openPop = () => { place(); const d = parse(end || start || ymd(startOfToday())); setView(new Date(d.getFullYear(), d.getMonth(), 1)); setPending(null); setMode("day"); setCursor(end || start || ymd(startOfToday())); focusPending.current = true; setOpen(true); };
  const close = () => { setOpen(false); setPending(null); };
  const returnFocus = () => { close(); triggerRef.current?.focus(); };
  useLayoutEffect(() => {
    if (!open || !focusPending.current) return;
    const cell = Array.from(popRef.current?.querySelectorAll<HTMLButtonElement>("[data-date]") ?? [])
      .find(button => button.dataset.date === cursor);
    const target = cell ?? popRef.current?.querySelector<HTMLButtonElement>("[data-date]");
    if (target) { target.focus(); focusPending.current = false; }
  }, [open, cursor, mode, view]);
  const onCalendarKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); returnFocus(); return; }
    const cell = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-date]");
    if (!cell?.dataset.date) return;
    const moved = moveCalendarCursor(mode, parse(cell.dataset.date), event.key);
    if (!moved) return; // Enter/Space retain the native button click behavior.
    event.preventDefault();
    const date = ymd(moved);
    setCursor(date); setHover(date); focusPending.current = true;
    setView(new Date(moved.getFullYear(), moved.getMonth(), 1));
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { const t = e.target as Node; if (!triggerRef.current?.contains(t) && !popRef.current?.contains(t)) close(); };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { document.removeEventListener("mousedown", onDoc); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);

  const cells = useMemo(() => {
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const gridStart = new Date(view.getFullYear(), view.getMonth(), 1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  }, [view]);

  const activePreset = presets().find((p) => { const [s, e] = p.range(); return s === start && e === end; });
  const todayStr = ymd(startOfToday());
  const yearBase = Math.floor(view.getFullYear() / 12) * 12;

  // 把两个"代表日"按当前粒度展开成完整区间。
  const expand = (a: string, b: string): [string, string] => {
    const [lo, hi] = [a, b].sort();
    const s = parse(lo), e = parse(hi);
    if (mode === "week") return [ymd(addDays(s, -s.getDay())), ymd(addDays(addDays(e, -e.getDay()), 6))];
    if (mode === "month") return [ymd(new Date(s.getFullYear(), s.getMonth(), 1)), ymd(monthEnd(e.getFullYear(), e.getMonth()))];
    if (mode === "year") return [`${s.getFullYear()}-01-01`, `${e.getFullYear()}-12-31`];
    return [lo, hi];
  };
  // 当前高亮区间:待选终点时用 起点↔悬停;否则用 已选 start↔end。
  const hl = pending ? expand(pending, hover ?? pending) : [start, end];

  const pick = (repDate: string) => {
    if (!pending) { setPending(repDate); setHover(repDate); return; }
    const [s, e] = expand(pending, repDate);
    onChange(s, e);
    returnFocus();
  };

  const grid = () => {
    if (mode === "month") {
      const y = view.getFullYear();
      const hlLo = hl[0].slice(0, 7), hlHi = hl[1].slice(0, 7);
      return (
        <>
          <div className="dash-cal-head">
            <button type="button" aria-label="上一年" onClick={() => setView(new Date(y - 1, 0, 1))}><ChevronLeft size={15} /></button>
            <strong>{y} 年</strong>
            <button type="button" aria-label="下一年" onClick={() => setView(new Date(y + 1, 0, 1))}><ChevronRight size={15} /></button>
          </div>
          <div className="dash-cal-cells">
            {MONTHS.map((label, m) => {
              const key = `${y}-${pad(m + 1)}`;
              return <button key={m} type="button" data-date={ymd(new Date(y, m, 1))} tabIndex={cursor.slice(0, 7) === key ? 0 : -1} aria-label={`${y} 年 ${label}`} onFocus={() => setCursor(ymd(new Date(y, m, 1)))} className={`dash-cal-cell${key >= hlLo && key <= hlHi ? " on" : ""}`} onClick={() => pick(ymd(new Date(y, m, 1)))} onMouseEnter={() => pending && setHover(ymd(new Date(y, m, 1)))}>{label}</button>;
            })}
          </div>
        </>
      );
    }
    if (mode === "year") {
      const hlLo = Number(hl[0].slice(0, 4)), hlHi = Number(hl[1].slice(0, 4));
      return (
        <>
          <div className="dash-cal-head">
            <button type="button" aria-label="前十二年" onClick={() => setView(new Date(yearBase - 12, 0, 1))}><ChevronLeft size={15} /></button>
            <strong>{yearBase} - {yearBase + 11}</strong>
            <button type="button" aria-label="后十二年" onClick={() => setView(new Date(yearBase + 12, 0, 1))}><ChevronRight size={15} /></button>
          </div>
          <div className="dash-cal-cells">
            {Array.from({ length: 12 }, (_, i) => yearBase + i).map((y) => (
              <button key={y} type="button" data-date={`${y}-01-01`} tabIndex={Number(cursor.slice(0, 4)) === y ? 0 : -1} aria-label={`${y} 年`} onFocus={() => setCursor(`${y}-01-01`)} className={`dash-cal-cell${y >= hlLo && y <= hlHi ? " on" : ""}`} onClick={() => pick(`${y}-01-01`)} onMouseEnter={() => pending && setHover(`${y}-01-01`)}>{y}</button>
            ))}
          </div>
        </>
      );
    }
    // day / week
    return (
      <>
        <div className="dash-cal-head">
          <button type="button" aria-label="上个月" onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}><ChevronLeft size={15} /></button>
          <strong>{view.getFullYear()} 年 {view.getMonth() + 1} 月</strong>
          <button type="button" aria-label="下个月" onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}><ChevronRight size={15} /></button>
        </div>
        <div className="dash-cal-grid dash-cal-weekdays">{WEEKDAYS.map((w) => <span key={w}>{w}</span>)}</div>
        <div className="dash-cal-grid" onMouseLeave={() => setHover(null)}>
          {cells.map((d) => {
            const s = ymd(d);
            const inMonth = d.getMonth() === view.getMonth();
            const inRange = s >= hl[0] && s <= hl[1];
            return (
              <button
                key={s}
                data-date={s}
                tabIndex={(s === cursor || (!cells.some(cell => ymd(cell) === cursor) && d.getDate() === 1 && inMonth)) ? 0 : -1}
                aria-label={`${s}${inRange ? "，已在选择范围内" : ""}`}
                aria-current={s === todayStr ? "date" : undefined}
                onFocus={() => setCursor(s)}
                type="button"
                className={`dash-cal-day${inMonth ? "" : " other"}${inRange ? " in" : ""}${s === hl[0] ? " start" : ""}${s === hl[1] ? " end" : ""}${s === todayStr ? " today" : ""}`}
                onClick={() => pick(s)}
                onMouseEnter={() => setHover(s)}
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>
      </>
    );
  };

  return (
    <div className="dash-daterange">
      <button ref={triggerRef} type="button" className="dash-daterange-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? dialogId : undefined} onClick={() => (open ? close() : openPop())}>
        <Calendar size={13} />
        <span>{activePreset ? activePreset.label : `${start} — ${end}`}</span>
      </button>
      {open && createPortal(
        <div id={dialogId} role="dialog" aria-label="选择日期区间" className="dash-daterange-pop" ref={popRef} onKeyDown={onCalendarKey} style={{ top: pos.top, left: pos.left, maxHeight: pos.maxHeight, overflowY: pos.maxHeight ? "auto" : undefined }}>
          <div className="dash-daterange-presets">
            {presets().map((p) => (
              <button key={p.label} type="button" className={activePreset?.label === p.label ? "on" : ""} onClick={() => { const [s, e] = p.range(); onChange(s, e); returnFocus(); }}>{p.label}</button>
            ))}
          </div>
          <div className="dash-cal">
            <div className="dash-cal-modes">
              {(["day", "week", "month", "year"] as Mode[]).map((m) => (
                <button key={m} type="button" className={mode === m ? "on" : ""} onClick={() => { setMode(m); setPending(null); focusPending.current = true; setCursor(m === "year" ? `${view.getFullYear()}-01-01` : m === "month" ? ymd(new Date(view.getFullYear(), view.getMonth(), 1)) : ymd(new Date(view.getFullYear(), view.getMonth(), Math.min(parse(cursor).getDate(), monthEnd(view.getFullYear(), view.getMonth()).getDate())))); }}>{{ day: "日", week: "周", month: "月", year: "年" }[m]}</button>
              ))}
            </div>
            {grid()}
            <div className="dash-cal-foot" role="status" aria-live="polite">{pending ? "再点一个选为终点(可跨月/年)" : `${start} — ${end}`}</div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
