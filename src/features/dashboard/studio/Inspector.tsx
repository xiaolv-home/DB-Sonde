/**
 * 右边的组件设置。一个组件的事都在这儿:
 *
 *   顶上   标题 · 图表类型(随时换,字段跟过去)· 按字段推荐的类型
 *   数据   字段区(横轴/数值/拆分系列/行/列/条件)· 日期范围 · 只看前几名
 *   样式   见 StylePanel
 *   交互   查看者能筛什么 · 下钻 · 点击联动 · 指标切换 · 同环比
 *
 * 原来数据在左、样式在右、筛选又在另一个页签里,改一个组件要来回跑三处。
 */
import { useState } from "react";
import { BarChart3, CalendarRange, Gauge, LineChart, Lightbulb, PanelTop, PieChart, Plus, Table2, Type, X } from "lucide-react";
import { nanoid } from "nanoid";
import { useI18n } from "../../../hooks/useI18n";
import { useDatasets } from "../../datasets/datasetsStore";
import { isTimeField } from "../../datasets/domain";
import { useFieldValues } from "../useFieldValues";
import DateRangePicker from "../components/DateRangePicker";
import type { DashboardKpiOptions, DashboardWidget, DashboardWidgetType } from "../domain";
import Shelf, { FieldIcon, type FieldValuesPort } from "./Shelf";
import StylePanel from "./StylePanel";
import { DATA_TYPES, convertWidget, fieldLabel, recommend, shelvesOf } from "./smart";
import { CommitInput, MenuItem, Pop, Section, Seg, Toggle } from "../../../components/StudioKit";
import type { WidgetCondition } from "../../datasets/widgetQuery";

export const TYPE_META: Record<DashboardWidgetType, { icon: typeof Gauge; label: string }> = {
  kpi: { icon: Gauge, label: "指标卡" },
  line: { icon: LineChart, label: "折线图" },
  bar: { icon: BarChart3, label: "柱状图" },
  pie: { icon: PieChart, label: "饼图" },
  table: { icon: Table2, label: "表格" },
  text: { icon: Type, label: "文本" },
  container: { icon: PanelTop, label: "分页容器" },
};

type Tab = "data" | "style" | "interact";

/**
 * 老看板把「锁定的维度取值」存在 lockedScope.filters 里。现在它们就是「条件」里的「是」,
 * 读的时候并进来,改一下就按新结构存回去 —— 不用两套界面说同一件事。
 */
export function absorbLegacyLocks(widget: DashboardWidget): DashboardWidget {
  const legacy = widget.options.lockedScope?.filters;
  if (!legacy || !Object.keys(legacy).length) return widget;
  const conditions: WidgetCondition[] = [
    ...(widget.bindings.conditions ?? []),
    ...Object.entries(legacy).filter(([, v]) => v.length).map(([field, values]) => ({ field, op: "in" as const, values })),
  ];
  const { filters: _drop, ...rest } = widget.options.lockedScope!;
  const lockedScope = rest.start || rest.end ? rest : undefined;
  return { ...widget, bindings: { ...widget.bindings, conditions }, options: { ...widget.options, lockedScope } };
}

export default function Inspector({ widget: raw, scope, onChange, onDelete }: {
  widget?: DashboardWidget;
  /** 看板的数据日期 —— 锁定日期时的默认起止。 */
  scope: { start: string; end: string };
  onChange: (widget: DashboardWidget) => void;
  onDelete: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("data");
  const { t } = useI18n();
  const datasets = useDatasets((s) => s.datasets);
  const widget = raw ? absorbLegacyLocks(raw) : undefined;
  const dataset = datasets.find((d) => d.id === widget?.datasetId);
  const fv = useFieldValues(widget?.datasetId, undefined, t);
  const values: FieldValuesPort = { valuesOf: fv.valuesOf, load: (f) => void fv.load(f) };

  if (!widget) {
    return (
      <aside className="st-inspector">
        <div className="st-insp-empty">
          <b>选中一个组件来设置它</b>
          <p>或者从左边把字段拖到画布空白处,直接生成一张图。</p>
          <ul>
            <li><kbd>单击</kbd> 字段 → 加进选中的组件</li>
            <li><kbd>拖</kbd> 字段 → 放进任意字段区</li>
            <li><kbd>⌘Z</kbd> 撤销 · <kbd>⌘S</kbd> 保存</li>
            <li><kbd>⌫</kbd> 删除选中的组件 · <kbd>⌘D</kbd> 复制</li>
          </ul>
        </div>
      </aside>
    );
  }

  const isData = shelvesOf(widget.type).length > 0;
  const patch = (change: Partial<DashboardWidget>) => onChange({ ...widget, ...change });
  const recs = isData ? recommend(widget, dataset).filter((r) => r.type !== widget.type).slice(0, 2) : [];
  const best = isData ? recommend(widget, dataset)[0] : undefined;
  const Icon = TYPE_META[widget.type].icon;

  return (
    <aside className="st-inspector">
      <div className="st-insp-head">
        <Icon size={15} className="st-insp-icon" />
        <CommitInput className="st-insp-title" value={widget.title} ariaLabel="组件标题" onCommit={(title) => patch({ title })} />
        <button type="button" className="icon-btn" title="删除组件 (⌫)" onClick={() => onDelete(widget.id)}><X size={14} /></button>
      </div>
      {isData && (
        <div className="st-types" role="radiogroup" aria-label="图表类型">
          {DATA_TYPES.map((type) => {
            const M = TYPE_META[type];
            const I = M.icon;
            return (
              <button type="button" key={type} role="radio" aria-checked={type === widget.type} className={`${type === widget.type ? "on" : ""} ${best?.type === type && type !== widget.type ? "rec" : ""}`}
                title={M.label} onClick={() => onChange(convertWidget(widget, type, dataset))}>
                <I size={15} /><span>{M.label}</span>
              </button>
            );
          })}
        </div>
      )}
      {recs.length > 0 && best && best.type !== widget.type && (
        <div className="st-rec">
          <Lightbulb size={13} />
          <span>这些字段更适合</span>
          {recs.map((r) => (
            <button type="button" key={r.type} title={r.reason} onClick={() => onChange(convertWidget(widget, r.type, dataset))}>{TYPE_META[r.type].label}</button>
          ))}
        </div>
      )}

      <div className="st-tabs" role="tablist">
        {(isData ? [["data", "数据"], ["style", "样式"], ["interact", "交互"]] : [["style", "设置"]]).map(([id, label]) => (
          <button type="button" role="tab" key={id} aria-selected={(isData ? tab : "style") === id} className={(isData ? tab : "style") === id ? "on" : ""}
            onClick={() => setTab(id as Tab)}>{label}</button>
        ))}
      </div>

      <div className="st-insp-body">
        {isData && tab === "data" && <DataTab widget={widget} dataset={dataset} values={values} scope={scope} onChange={onChange} />}
        {(!isData || tab === "style") && <StylePanel widget={widget} dataset={dataset} onChange={onChange} />}
        {isData && tab === "interact" && <InteractTab widget={widget} dataset={dataset} onChange={onChange} />}
      </div>
    </aside>
  );
}

/* ── 数据 ─────────────────────────────────────────────────────────── */

function DataTab({ widget, dataset, values, scope, onChange }: {
  widget: DashboardWidget;
  dataset?: ReturnType<typeof useDatasets.getState>["datasets"][number];
  values: FieldValuesPort;
  scope: { start: string; end: string };
  onChange: (w: DashboardWidget) => void;
}) {
  if (!dataset) {
    return (
      <div className="st-insp-note">
        <b>{widget.datasetId ? "这个组件用的数据集不在了" : "还没选数据"}</b>
        <p>在左边字段面板顶上选一个数据集,再把字段点进来或拖进来。</p>
      </div>
    );
  }
  const lock = widget.options.lockedScope;
  const dateMode = lock?.start && lock?.end ? "lock" : "follow";
  const hasTime = dataset.fields.some((f) => !f.hidden && isTimeField(f));
  const setLock = (next?: { start?: string; end?: string }) =>
    onChange({ ...widget, options: { ...widget.options, lockedScope: next?.start && next.end ? { start: next.start, end: next.end } : undefined } });
  const topN = widget.options.topN ?? 0;

  return (
    <div className="st-data">
      {shelvesOf(widget.type).map((shelf) => (
        <Shelf key={shelf} widget={widget} shelf={shelf} dataset={dataset} onChange={onChange} values={values} />
      ))}

      {hasTime && (
        <div className="st-block">
          <div className="st-block-head"><CalendarRange size={13} />日期范围</div>
          <Seg size="sm" value={dateMode} onChange={(v) => setLock(v === "lock" ? { start: scope.start, end: scope.end } : undefined)}
            options={[{ value: "follow", label: "跟随看板", title: "随看板顶上的「数据日期」变" }, { value: "lock", label: "固定一段", title: "不随看板日期变,查看者也改不了" }]} />
          {dateMode === "lock" && <div className="st-block-row"><DateRangePicker start={lock!.start!} end={lock!.end!} onChange={(start, end) => setLock({ start, end })} /></div>}
        </div>
      )}

      {(widget.type === "bar" || widget.type === "pie" || widget.type === "line" || widget.type === "table") && (
        <div className="st-block">
          <div className="st-block-head">显示多少</div>
          <Seg size="sm" value={topN} onChange={(v) => onChange({ ...widget, options: { ...widget.options, topN: v } })}
            options={[{ value: 0, label: "全部" }, { value: 5, label: "前 5" }, { value: 10, label: "前 10" }, { value: 20, label: "前 20" }, { value: 50, label: "前 50" }]} />
          {topN > 0 && <small className="st-hint">按第一个数值从大到小取前 {topN}{widget.type === "pie" ? ",其余可在样式里合并成「其他」" : ""}</small>}
        </div>
      )}
    </div>
  );
}

/* ── 交互 ─────────────────────────────────────────────────────────── */

function InteractTab({ widget, dataset, onChange }: {
  widget: DashboardWidget;
  dataset?: ReturnType<typeof useDatasets.getState>["datasets"][number];
  onChange: (w: DashboardWidget) => void;
}) {
  const [addDrill, setAddDrill] = useState<HTMLElement | null>(null);
  const co = widget.options.chart ?? {};
  const ko = widget.options.kpi ?? {};
  const patchChart = (change: Partial<typeof co>) => onChange({ ...widget, options: { ...widget.options, chart: { ...co, ...change } } });
  const patchKpi = (change: Partial<DashboardKpiOptions>) => onChange({ ...widget, options: { ...widget.options, kpi: { ...ko, ...change } } });
  const dims = (dataset?.fields ?? []).filter((f) => !f.hidden && f.role === "dimension");
  const filterFields = widget.filterFields ?? [];
  const toggleViewer = (name: string, on: boolean) => {
    const next = on ? [...filterFields, name] : filterFields.filter((f) => f !== name);
    onChange({ ...widget, filterFields: next, filtersEnabled: next.length > 0 });
  };
  const isChart = widget.type === "line" || widget.type === "bar" || widget.type === "pie";
  const isKpi = widget.type === "kpi";
  const mode = isKpi ? (ko.displayMode ?? "all") : (co.displayMode ?? "all");
  const groups = (isKpi ? ko.metricGroups : co.metricGroups) ?? [];
  const patchMode = (change: { displayMode?: DashboardKpiOptions["displayMode"]; metricGroups?: typeof groups }) => (isKpi ? patchKpi(change) : patchChart(change));
  const measures = (widget.bindings.measures ?? []).map((m) => ({ id: `field:${m}`, name: widget.options.metrics[m]?.alias || fieldLabel(dataset, m) }));
  const drill = co.drillDimensions ?? [];

  return (
    <div className="st-interact">
      <Section id="viewer-filters" title="查看者可以筛" aside={filterFields.length ? `${filterFields.length} 项` : "关"}>
        <p className="st-hint">勾上的字段会在这张卡片顶上出现筛选框,只影响这一张。</p>
        <div className="st-chipset">
          {[{ name: "date", label: "日期", time: true }, ...dims.filter((f) => !isTimeField(f)).map((f) => ({ name: f.name, label: f.label || f.name, time: false }))].map((f) => (
            <button type="button" key={f.name} className={filterFields.includes(f.name) ? "on" : ""} onClick={() => toggleViewer(f.name, !filterFields.includes(f.name))}>
              {f.time ? <CalendarRange size={12} /> : <FieldIcon field={dims.find((d) => d.name === f.name)} size={12} />}{f.label}
            </button>
          ))}
        </div>
      </Section>

      {isChart && (
        <Section id="drill" title="点击下钻" aside={drill.length ? `${drill.length} 层` : "关"}>
          <p className="st-hint">点一根柱子 / 一块扇区,按下一层维度展开;卡片上会出现返回路径。</p>
          <div className="st-drill">
            <span className="st-drill-step base">{fieldLabel(dataset, widget.bindings.dimensions?.[0] ?? "") || "当前分类"}</span>
            {drill.map((d, i) => (
              <span key={d} className="st-drill-step">→ {fieldLabel(dataset, d)}
                <button type="button" aria-label="去掉这一层" onClick={() => patchChart({ drillDimensions: drill.filter((_, j) => j !== i) })}><X size={11} /></button>
              </span>
            ))}
            <button type="button" className="st-drill-add" onClick={(e) => setAddDrill(e.currentTarget)}><Plus size={12} />加一层</button>
          </div>
          {addDrill && (
            <Pop anchor={addDrill} width={220} onClose={() => setAddDrill(null)}>
              <div className="st-menu-scroll">
                {dims.filter((f) => !drill.includes(f.name) && f.name !== widget.bindings.dimensions?.[0]).map((f) => (
                  <MenuItem key={f.name} icon={<FieldIcon field={f} />} onClick={() => { patchChart({ drillDimensions: [...drill, f.name] }); setAddDrill(null); }}>{f.label || f.name}</MenuItem>
                ))}
              </div>
            </Pop>
          )}
          <Toggle checked={co.linkage === true} onChange={(v) => patchChart({ linkage: v })} label="点击联动整张看板" hint="点一格,用同一数据集的组件都按这个值筛" />
        </Section>
      )}

      <Section id="compare" title="同比 / 环比" aside={(isKpi ? ko.showComparison : co.showComparison) ? "开" : "关"}>
        <Toggle checked={isKpi ? !!ko.showComparison : !!co.showComparison}
          onChange={(v) => (isKpi ? patchKpi({ showComparison: v }) : patchChart({ showComparison: v }))}
          label="显示涨跌" hint="对比上一个同长度周期和去年同期" />
      </Section>

      {measures.length > 1 && (
        <Section id="switch" title="指标切换" aside={mode === "all" ? "全部显示" : mode === "switch" ? "单选切换" : "分组切换"}>
          <Seg size="sm" value={mode} onChange={(v) => patchMode({ displayMode: v })}
            options={[{ value: "all", label: "全部显示" }, { value: "switch", label: "查看者切换" }, { value: "group_switch", label: "按组切换" }]} />
          {mode === "group_switch" && (
            <div className="st-groups">
              {groups.map((g) => (
                <div className="st-group" key={g.id}>
                  <div className="st-group-head">
                    <CommitInput value={g.label} onCommit={(label) => patchMode({ metricGroups: groups.map((x) => (x.id === g.id ? { ...x, label } : x)) })} />
                    <button type="button" className="icon-btn" aria-label="删除分组" onClick={() => patchMode({ metricGroups: groups.filter((x) => x.id !== g.id) })}><X size={12} /></button>
                  </div>
                  <div className="st-chipset">
                    {measures.map((m) => (
                      <button type="button" key={m.id} className={g.metricIds.includes(m.id) ? "on" : ""}
                        onClick={() => patchMode({ metricGroups: groups.map((x) => (x.id === g.id ? { ...x, metricIds: x.metricIds.includes(m.id) ? x.metricIds.filter((i) => i !== m.id) : [...x.metricIds, m.id] } : x)) })}>{m.name}</button>
                    ))}
                  </div>
                </div>
              ))}
              <button type="button" className="st-link" onClick={() => patchMode({ metricGroups: [...groups, { id: `grp-${nanoid(6)}`, label: `分组 ${groups.length + 1}`, metricIds: [] }] })}><Plus size={12} />加一组</button>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
