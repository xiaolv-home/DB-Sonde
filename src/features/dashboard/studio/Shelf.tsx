/**
 * 字段区(横轴 / 数值 / 行 / 列 / 拆分系列 / 条件)和区里的「字段胶囊」。
 *
 * 一个胶囊就是一个字段在这个组件里的全部设定:点开是它的小菜单 —— 汇总方式、时间粒度、
 * 排序、显示名、单位,用不着在三个页签之间找。胶囊能拖:区内调顺序,拖到别的区就换位置,
 * 拖出去就移除;字段面板里的字段直接拖进来。
 */
import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, CircleAlert, Filter, Hash, Plus, X } from "lucide-react";
import { isTimeField, type Dataset, type DatasetField } from "../../datasets/domain";
import { AGG_LABELS, CONDITION_OPS, GRAIN_LABELS, conditionReady, type AggKind, type ConditionOp, type TimeGrain, type WidgetCondition } from "../../datasets/widgetQuery";
import type { DashboardDimensionSort, DashboardWidget } from "../domain";
import { addToShelf, fieldLabel, removeFromShelf, setConditions, setShelf, shelfItems, shelfLimit, shelfTitle, shelvesOf, type ShelfId } from "./smart";
import { MenuItem, Pop, Seg, ValuePicker, CommitInput } from "../../../components/StudioKit";

/* ── 拖拽 ─────────────────────────────────────────────────────────── */

export const FIELD_MIME = "application/x-sonde-field";
export interface DragPayload { name: string; from?: { shelf: ShelfId; index: number } }
/** dragover 时读不到 dataTransfer 里的内容,正在拖的东西记在这儿。 */
let dragging: DragPayload | null = null;
export const currentDrag = () => dragging;

export function startFieldDrag(e: DragEvent, payload: DragPayload) {
  dragging = payload;
  e.dataTransfer.setData(FIELD_MIME, JSON.stringify(payload));
  e.dataTransfer.setData("text/plain", payload.name);
  e.dataTransfer.effectAllowed = "copyMove";
  document.body.classList.add("st-field-dragging");
}
export function endFieldDrag() {
  dragging = null;
  document.body.classList.remove("st-field-dragging");
}
export function readDrag(e: DragEvent): DragPayload | null {
  try { return JSON.parse(e.dataTransfer.getData(FIELD_MIME)) as DragPayload; } catch { return dragging; }
}

export { FieldIcon } from "../../datasets/FieldIcon";
import { FieldIcon } from "../../datasets/FieldIcon";

/* ── 区 ───────────────────────────────────────────────────────────── */

export interface FieldValuesPort {
  valuesOf: (field: string) => { values: string[]; truncated: boolean; loading: boolean };
  load: (field: string) => void;
}

const SHELF_HINT: Partial<Record<ShelfId, string>> = {
  rows: "拖维度到这里,按它分行",
  columns: "放进来就成了交叉表",
  dimensions: "拖一个维度到这里",
  series: "按它拆成多条线 / 多组柱",
  measures: "拖数值到这里",
  conditions: "拖字段到这里,只看符合条件的数据",
};

export default function Shelf({ widget, shelf, dataset, onChange, values }: {
  widget: DashboardWidget;
  shelf: ShelfId;
  dataset?: Dataset;
  onChange: (widget: DashboardWidget) => void;
  values: FieldValuesPort;
}) {
  const items = shelfItems(widget, shelf);
  const limit = shelfLimit(widget.type, shelf);
  const [over, setOver] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ index: number; anchor: HTMLElement } | null>(null);

  const accepts = (payload: DragPayload | null) => {
    if (!payload || !dataset?.fields.some((f) => f.name === payload.name)) return false;
    const field = dataset.fields.find((f) => f.name === payload.name)!;
    // 度量进不了维度区;维度可以进数值(计数),条件区什么都收
    if (field.role === "measure" && shelf !== "measures" && shelf !== "conditions") return false;
    return true;
  };

  /** 鼠标在第几个胶囊前面 —— 按胶囊的中线算。 */
  const indexAt = (e: DragEvent) => {
    const pills = [...(listRef.current?.querySelectorAll<HTMLElement>(".st-pill") ?? [])];
    for (let i = 0; i < pills.length; i += 1) {
      const r = pills[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2 || (e.clientY < r.bottom && e.clientX < r.left + r.width / 2)) return i;
    }
    return pills.length;
  };

  const drop = (e: DragEvent) => {
    e.preventDefault();
    const payload = readDrag(e);
    const at = over ?? items.length;
    setOver(null);
    endFieldDrag();
    if (!payload || !accepts(payload)) return;
    let next = widget;
    // 从别的区(或本区)拖来:先从原处拿走
    if (payload.from && payload.from.shelf !== "conditions") {
      if (payload.from.shelf === shelf) {
        const order = [...items];
        const [moved] = order.splice(payload.from.index, 1);
        order.splice(at > payload.from.index ? at - 1 : at, 0, moved);
        onChange(setShelf(widget, shelf, order, dataset));
        return;
      }
      if (shelf !== "conditions") next = removeFromShelf(next, payload.from.shelf, payload.from.index, dataset);
    }
    next = addToShelf(next, shelf, payload.name, dataset, at);
    onChange(next);
    openNewCondition(next);
  };

  /** 新条件直接打开编辑,不然人还得再找一下它。 */
  const openNewCondition = (next: DashboardWidget) => {
    if (shelf !== "conditions") return;
    requestAnimationFrame(() => {
      const pills = listRef.current?.querySelectorAll<HTMLElement>(".st-pill");
      const last = pills?.[pills.length - 1];
      if (last) setMenu({ index: (next.bindings.conditions?.length ?? 1) - 1, anchor: last });
    });
  };

  const conditions = widget.bindings.conditions ?? [];
  const full = items.length >= limit && limit > 1;

  return (
    <div className={`st-shelf ${over !== null ? "over" : ""}`} data-shelf={shelf}
      onDragOver={(e) => {
        if (!accepts(currentDrag())) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = currentDrag()?.from ? "move" : "copy";
        setOver(indexAt(e));
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
      onDrop={drop}>
      <div className="st-shelf-head">
        <span>{shelfTitle(widget.type, shelf)}</span>
        {limit > 1 && items.length > 0 && shelf !== "conditions" && <small>{items.length}{full ? " · 已满" : ""}</small>}
        <AddFieldButton widget={widget} shelf={shelf} dataset={dataset} onAdd={(name) => {
          const next = addToShelf(widget, shelf, name, dataset);
          onChange(next);
          openNewCondition(next);
        }} />
      </div>
      <div className="st-shelf-list" ref={listRef}>
        {items.length === 0 && <div className="st-shelf-empty">{SHELF_HINT[shelf]}</div>}
        {items.map((name, index) => {
          const field = dataset?.fields.find((f) => f.name === name);
          const cond = shelf === "conditions" ? conditions[index] : undefined;
          return (
            <div key={`${name}-${index}`} className={`st-pill ${shelf === "measures" ? "measure" : shelf === "conditions" ? "cond" : "dim"} ${over === index ? "drop-before" : ""} ${cond && !conditionReady(cond) ? "incomplete" : ""} ${!field ? "missing" : ""}`}
              draggable
              onDragStart={(e) => startFieldDrag(e, { name, from: { shelf, index } })}
              onDragEnd={(e) => {
                // 拖出了所有字段区 = 移除
                if (e.dataTransfer.dropEffect === "none" && !document.elementFromPoint(e.clientX, e.clientY)?.closest(".st-shelf")) {
                  onChange(removeFromShelf(widget, shelf, index, dataset));
                }
                endFieldDrag();
              }}
              onClick={(e) => setMenu({ index, anchor: e.currentTarget })}
              title={field ? undefined : `「${name}」已不在数据集里`}>
              {shelf === "conditions" ? <Filter size={12} className="st-ic cond" /> : <FieldIcon field={field} size={12} />}
              <span className="st-pill-text">{pillText(widget, shelf, name, dataset, cond)}</span>
              {pillBadges(widget, shelf, name, index, dataset)}
              <button type="button" className="st-pill-x" aria-label="移除" onClick={(e) => { e.stopPropagation(); onChange(removeFromShelf(widget, shelf, index, dataset)); }}><X size={11} /></button>
            </div>
          );
        })}
        {over !== null && over >= items.length && items.length > 0 && <div className="st-drop-line" />}
      </div>
      {menu && (
        <Pop anchor={menu.anchor} width={shelf === "conditions" ? 300 : 248} onClose={() => setMenu(null)}>
          {shelf === "conditions"
            ? conditions[menu.index] && <ConditionEditor condition={conditions[menu.index]} dataset={dataset} values={values}
                onChange={(c) => onChange(setConditions(widget, conditions.map((x, i) => (i === menu.index ? c : x))))}
                onRemove={() => { onChange(removeFromShelf(widget, shelf, menu.index, dataset)); setMenu(null); }} />
            : <PillMenu widget={widget} shelf={shelf} index={menu.index} dataset={dataset} onChange={onChange} onClose={() => setMenu(null)} />}
        </Pop>
      )}
    </div>
  );
}

/** 区标题右边的「+」:不想拖的话点它挑。只列这个区收得下的字段。 */
function AddFieldButton({ widget, shelf, dataset, onAdd }: { widget: DashboardWidget; shelf: ShelfId; dataset?: Dataset; onAdd: (name: string) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [q, setQ] = useState("");
  if (!dataset) return null;
  const used = new Set(shelf === "conditions" ? [] : shelfItems(widget, shelf));
  const term = q.trim().toLowerCase();
  const fields = dataset.fields.filter((f) => !f.hidden && !used.has(f.name)
    && (shelf === "measures" || shelf === "conditions" || f.role === "dimension")
    && (!term || f.name.toLowerCase().includes(term) || (f.label ?? "").toLowerCase().includes(term)));
  const dims = fields.filter((f) => f.role === "dimension");
  const measures = fields.filter((f) => f.role === "measure");
  const item = (f: DatasetField) => (
    <MenuItem key={f.name} icon={<FieldIcon field={f} />} hint={f.label && f.label !== f.name ? f.name : undefined}
      onClick={() => { onAdd(f.name); setAnchor(null); setQ(""); }}>{f.label || f.name}</MenuItem>
  );
  return (
    <>
      <button type="button" className={`st-shelf-add ${anchor ? "on" : ""}`} aria-label={`添加到${shelfTitle(widget.type, shelf)}`}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}><Plus size={13} /></button>
      {anchor && (
        <Pop anchor={anchor} width={240} onClose={() => { setAnchor(null); setQ(""); }}>
          <label className="st-search"><input autoFocus value={q} placeholder="搜字段" onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && fields[0]) { onAdd(fields[0].name); setAnchor(null); setQ(""); } }} /></label>
          <div className="st-menu-scroll">
            {shelf === "measures" || shelf === "conditions" ? <>
              {measures.length > 0 && <div className="st-menu-group">数值</div>}
              {measures.map(item)}
              {dims.length > 0 && <div className="st-menu-group">{shelf === "measures" ? "维度(按个数计)" : "维度"}</div>}
              {dims.map(item)}
            </> : dims.map(item)}
            {!fields.length && <p className="st-empty">没有可加的字段</p>}
          </div>
        </Pop>
      )}
    </>
  );
}

/* ── 胶囊文字和角标 ────────────────────────────────────────────────── */

const AGG_SHORT: Record<AggKind, string> = { sum: "求和", avg: "平均", count: "计数", count_distinct: "去重数", min: "最小", max: "最大" };

function condSummary(cond: WidgetCondition, label: string): string {
  const op = CONDITION_OPS[cond.op]?.label ?? cond.op;
  const vals = cond.values.filter((v) => v !== "");
  const who = cond.agg ? `${AGG_SHORT[cond.agg]}(${label})` : label;
  if (CONDITION_OPS[cond.op]?.arity === 0) return `${who} ${op}`;
  if (!vals.length) return `${who} ${op} …`;
  if (cond.op === "between") return `${who} ${vals[0]} ~ ${vals[1] ?? "…"}`;
  const shown = vals.slice(0, 2).join("、") + (vals.length > 2 ? ` 等${vals.length}个` : "");
  return `${who} ${op} ${shown}`;
}

function pillText(widget: DashboardWidget, shelf: ShelfId, name: string, dataset: Dataset | undefined, cond?: WidgetCondition): ReactNode {
  const label = widget.options.metrics[name]?.alias?.trim() || fieldLabel(dataset, name);
  if (cond) return condSummary(cond, fieldLabel(dataset, name));
  if (shelf === "measures") {
    const agg = widget.bindings.aggregations?.[name] ?? "sum";
    return <><em>{AGG_SHORT[agg]}</em>{label}</>;
  }
  return label;
}

function pillBadges(widget: DashboardWidget, shelf: ShelfId, name: string, _index: number, dataset?: Dataset): ReactNode {
  if (shelf === "conditions") return null;
  const table = widget.options.table ?? {};
  const out: ReactNode[] = [];
  const grain = widget.bindings.grains?.[name];
  if (shelf !== "measures" && grain && grain !== "raw" && isTimeField(dataset?.fields.find((f) => f.name === name))) {
    out.push(<span key="g" className="st-badge">{GRAIN_LABELS[grain]}</span>);
  }
  const sort = shelf === "measures"
    ? (table.metricSort?.key === `field:${name}` ? table.metricSort.dir : undefined)
    : table.dimensionSorts?.[name];
  if (sort) {
    const up = sort.endsWith("asc");
    out.push(<span key="s" className="st-badge sort">{up ? <ArrowUp size={10} /> : <ArrowDown size={10} />}</span>);
  }
  if (!dataset?.fields.some((f) => f.name === name)) out.push(<CircleAlert key="m" size={12} className="st-ic warn" />);
  return out;
}

/* ── 胶囊菜单 ─────────────────────────────────────────────────────── */

function PillMenu({ widget, shelf, index, dataset, onChange, onClose }: {
  widget: DashboardWidget; shelf: ShelfId; index: number; dataset?: Dataset;
  onChange: (w: DashboardWidget) => void; onClose: () => void;
}) {
  const items = shelfItems(widget, shelf);
  const name = items[index];
  if (!name) return null;
  const field = dataset?.fields.find((f) => f.name === name);
  const table = widget.options.table ?? {};
  const patchTable = (change: Partial<typeof table>) => onChange({ ...widget, options: { ...widget.options, table: { ...table, ...change } } });
  const isTable = widget.type === "table";
  const shelves = shelvesOf(widget.type);

  if (shelf === "measures") {
    const agg = widget.bindings.aggregations?.[name] ?? "sum";
    const pres = widget.options.metrics[name];
    const sortKey = `field:${name}`;
    const sort = table.metricSort?.key === sortKey ? `${table.metricSort.dir}${table.metricSort.within ? "_within" : ""}` : "";
    const setPres = (change: Partial<NonNullable<typeof pres>>) => onChange({
      ...widget,
      options: {
        ...widget.options,
        metrics: { ...widget.options.metrics, [name]: { ...{ alias: "", unit: "", decimals: widget.options.decimals, direction: "neutral" as const }, ...pres, ...change } },
      },
    });
    return (
      <div className="st-pillmenu">
        <div className="st-pm-title"><FieldIcon field={field} />{field?.label || name}{field?.label && <small>{name}</small>}</div>
        <div className="st-pm-label">汇总方式</div>
        <div className="st-agg-grid">
          {(Object.keys(AGG_LABELS) as AggKind[]).map((a) => (
            <button type="button" key={a} className={a === agg ? "on" : ""}
              onClick={() => onChange({ ...widget, bindings: { ...widget.bindings, aggregations: { ...(widget.bindings.aggregations ?? {}), [name]: a } } })}>{AGG_LABELS[a]}</button>
          ))}
        </div>
        {widget.type !== "kpi" && <>
          <div className="st-pm-label">排序</div>
          <Seg size="sm" value={sort.replace("_within", "")} onChange={(v) => patchTable({ metricSort: v ? { key: sortKey, dir: v as "asc" | "desc", within: false } : undefined })}
            options={[{ value: "", label: "不排" }, { value: "desc", label: "从大到小" }, { value: "asc", label: "从小到大" }]} />
          {isTable && shelfItems(widget, "rows").length > 1 && sort && (
            <label className="st-pm-check"><input type="checkbox" checked={!!table.metricSort?.within}
              onChange={(e) => patchTable({ metricSort: { key: sortKey, dir: table.metricSort!.dir, within: e.target.checked } })} />只在上一层分组内部排</label>
          )}
        </>}
        <div className="st-pm-label">显示名</div>
        <CommitInput value={pres?.alias ?? ""} placeholder={field?.label || name} onCommit={(alias) => setPres({ alias })} />
        <div className="st-pm-pair">
          <label><span>单位</span><CommitInput value={pres?.unit ?? ""} placeholder="如 元" onCommit={(unit) => setPres({ unit })} /></label>
          <label><span>小数位</span>
            <input className="st-input" type="number" min={0} max={6} value={pres?.decimals ?? widget.options.decimals}
              onChange={(e) => setPres({ decimals: Math.max(0, Math.min(6, Number(e.target.value) || 0)) })} /></label>
        </div>
        <div className="st-pm-sep" />
        <MenuItem icon={<X size={13} />} danger onClick={() => { onChange(removeFromShelf(widget, shelf, index, dataset)); onClose(); }}>移除</MenuItem>
      </div>
    );
  }

  const sort = table.dimensionSorts?.[name] ?? "";
  const setSort = (v: string) => {
    const next = { ...(table.dimensionSorts ?? {}) };
    if (v) next[name] = v as DashboardDimensionSort; else delete next[name];
    patchTable({ dimensionSorts: next });
  };
  const moveTo = (target: ShelfId) => {
    onChange(addToShelf(removeFromShelf(widget, shelf, index, dataset), target, name, dataset));
    onClose();
  };
  const time = isTimeField(field);
  const grain = widget.bindings.grains?.[name] ?? "raw";
  return (
    <div className="st-pillmenu">
      <div className="st-pm-title"><FieldIcon field={field} />{field?.label || name}{field?.label && <small>{name}</small>}</div>
      {time && <>
        <div className="st-pm-label">时间粒度</div>
        <div className="st-agg-grid">
          {(["raw", "year", "quarter", "month", "week", "day"] as TimeGrain[]).map((g) => (
            <button type="button" key={g} className={g === grain ? "on" : ""}
              onClick={() => onChange({ ...widget, bindings: { ...widget.bindings, grains: { ...(widget.bindings.grains ?? {}), [name]: g } } })}>{GRAIN_LABELS[g]}</button>
          ))}
        </div>
      </>}
      <div className="st-pm-label">排序</div>
      <Seg size="sm" value={sort.replace("group_", "")} onChange={(v) => setSort(v && isTable && shelf === "rows" && index > 0 && sort.startsWith("group_") ? `group_${v}` : v)}
        options={[{ value: "", label: <ArrowUpDown size={12} />, title: "默认" }, { value: "asc", label: "升序" }, { value: "desc", label: "降序" }]} />
      {isTable && shelf === "rows" && index > 0 && sort && (
        <label className="st-pm-check"><input type="checkbox" checked={sort.startsWith("group_")}
          onChange={(e) => setSort(e.target.checked ? `group_${sort.replace("group_", "")}` : sort.replace("group_", ""))} />只在上一层分组内部排</label>
      )}
      <div className="st-pm-sep" />
      {shelves.filter((s) => s !== shelf && s !== "conditions" && s !== "measures").map((s) => (
        <MenuItem key={s} icon={<ArrowUpDown size={13} />} onClick={() => moveTo(s)}>移到「{shelfTitle(widget.type, s)}」</MenuItem>
      ))}
      {shelves.includes("measures") && (
        <MenuItem icon={<Hash size={13} />} onClick={() => moveTo("measures")}>改成计数(放进数值)</MenuItem>
      )}
      <MenuItem icon={<Filter size={13} />} onClick={() => { onChange(addToShelf(widget, "conditions", name, dataset)); onClose(); }}>按它加条件</MenuItem>
      <MenuItem icon={<X size={13} />} danger onClick={() => { onChange(removeFromShelf(widget, shelf, index, dataset)); onClose(); }}>移除</MenuItem>
    </div>
  );
}

/* ── 条件编辑 ─────────────────────────────────────────────────────── */

const DIM_OPS: ConditionOp[] = ["in", "not_in", "contains", "not_contains", "null", "not_null"];
const TIME_OPS: ConditionOp[] = ["between", "gte", "lte", "in", "null", "not_null"];
const NUM_OPS: ConditionOp[] = ["gt", "gte", "lt", "lte", "between", "eq", "neq", "null", "not_null"];

export function ConditionEditor({ condition, dataset, values, onChange, onRemove, allowAgg = true }: {
  condition: WidgetCondition;
  dataset?: Dataset;
  values: FieldValuesPort;
  onChange: (c: WidgetCondition) => void;
  onRemove?: () => void;
  allowAgg?: boolean;
}) {
  const field = dataset?.fields.find((f) => f.name === condition.field);
  const measure = field?.role === "measure";
  const time = isTimeField(field);
  const numeric = measure || !!condition.agg;
  const ops = numeric ? NUM_OPS : time ? TIME_OPS : DIM_OPS;
  const arity = CONDITION_OPS[condition.op]?.arity;
  const vals = condition.values;
  const setVal = (i: number, v: string) => { const next = [...vals]; next[i] = v; onChange({ ...condition, values: next }); };
  const got = values.valuesOf(condition.field);

  return (
    <div className="st-cond">
      <div className="st-pm-title"><FieldIcon field={field} />{field?.label || condition.field}</div>
      {measure && allowAgg && (
        <Seg size="sm" value={condition.agg ? "agg" : "row"}
          onChange={(v) => onChange({ ...condition, agg: v === "agg" ? (condition.agg ?? field?.defaultAgg ?? "sum") : undefined })}
          options={[{ value: "agg", label: "按汇总后", title: "先按组件的维度汇总,再筛结果(如:总额过万的门店)" }, { value: "row", label: "按每一行", title: "汇总之前先筛明细行" }]} />
      )}
      <div className="st-cond-line">
        {condition.agg && (
          <select className="st-mini-sel" value={condition.agg} onChange={(e) => onChange({ ...condition, agg: e.target.value as AggKind })}>
            {(Object.keys(AGG_LABELS) as AggKind[]).map((a) => <option key={a} value={a}>{AGG_LABELS[a]}</option>)}
          </select>
        )}
        <div className="st-op-list">
          {ops.map((op) => (
            <button type="button" key={op} className={op === condition.op ? "on" : ""}
              onClick={() => {
                const nextArity = CONDITION_OPS[op].arity;
                const keep = nextArity === "n" ? vals : nextArity === 0 ? [] : vals.slice(0, nextArity);
                onChange({ ...condition, op, values: keep });
                if (nextArity === "n") values.load(condition.field);
              }}>{CONDITION_OPS[op].label}</button>
          ))}
        </div>
      </div>
      {arity === "n" && (
        <ValueLoader field={condition.field} values={values}>
          <ValuePicker options={got.values} selected={vals} loading={got.loading} truncated={got.truncated}
            onChange={(next) => onChange({ ...condition, values: next })} />
        </ValueLoader>
      )}
      {arity === 1 && (
        <input className="st-input" autoFocus type={numeric ? "number" : time ? "date" : "text"} value={vals[0] ?? ""}
          placeholder={numeric ? "输入数字" : "输入值"} onChange={(e) => setVal(0, e.target.value)} />
      )}
      {arity === 2 && (
        <div className="st-pm-pair">
          <input className="st-input" autoFocus type={numeric ? "number" : time ? "date" : "text"} value={vals[0] ?? ""} placeholder="从" onChange={(e) => setVal(0, e.target.value)} />
          <input className="st-input" type={numeric ? "number" : time ? "date" : "text"} value={vals[1] ?? ""} placeholder="到" onChange={(e) => setVal(1, e.target.value)} />
        </div>
      )}
      {onRemove && <>
        <div className="st-pm-sep" />
        <MenuItem icon={<X size={13} />} danger onClick={onRemove}>删除这个条件</MenuItem>
      </>}
    </div>
  );
}

/** 挂上就去取候选值 —— 打开条件时要立刻看到能选什么。 */
function ValueLoader({ field, values, children }: { field: string; values: FieldValuesPort; children: ReactNode }) {
  const asked = useRef("");
  if (asked.current !== field) {
    asked.current = field;
    queueMicrotask(() => values.load(field));
  }
  return <>{children}</>;
}
