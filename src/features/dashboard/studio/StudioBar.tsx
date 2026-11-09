/**
 * 看板工作台的两条横栏。
 *
 *   顶栏    看板(切换/新建/改名)· 撤销 · 添加组件 · 预览 · 更多 · 保存
 *   筛选条  数据日期 · 看板筛选(一个个胶囊,点开挑值)· 联动 · 刷新
 *
 * 原来是两排挤满按钮的工具条,一半时间用不上的(导入导出、自动刷新)收进「更多」。
 */
import { useState } from "react";
import {
  CalendarRange, Check, ChevronDown, Copy, Download, Eye, FileDown, FileUp, Filter, Globe, LayoutDashboard, Link2,
  Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, RotateCcw, Save, Timer, Trash2, Undo2, X,
} from "lucide-react";
import { useI18n } from "../../../hooks/useI18n";
import { useDatasets } from "../../datasets/datasetsStore";
import { isTimeField, type Dataset } from "../../datasets/domain";
import { defaultMetricScope } from "../../metrics/queryPlan";
import DateRangePicker from "../components/DateRangePicker";
import { WIDGET_TYPES, type DashboardDocument, type DashboardDrillFilter, type DashboardFilter, type DashboardWidgetType } from "../domain";
import type { DashboardFilterValues } from "../filtering";
import { useFieldValues } from "../useFieldValues";
import { TYPE_META } from "./Inspector";
import { FieldIcon } from "./Shelf";
import { CommitInput, MenuItem, Pop, Seg, ValuePicker } from "../../../components/StudioKit";

const SOH = String.fromCharCode(1);

/* ── 顶栏 ─────────────────────────────────────────────────────────── */

export function TopBar(p: {
  document: DashboardDocument;
  documents: DashboardDocument[];
  dirty: boolean;
  saving: boolean;
  preview: boolean;
  canUndo: boolean;
  exportingHtml: boolean;
  storagePath?: string;
  onTitle: (title: string) => void;
  onSelectDocument: (id: string) => void;
  onNewDocument: () => void;
  onDuplicateDocument: () => void;
  onAddWidget: (type: DashboardWidgetType) => void;
  onPreview: () => void;
  onUndo: () => void;
  onSave: () => void;
  onDelete: () => void;
  onImport: () => void;
  onExportJson: () => void;
  onExportHtml: () => void;
  onRefreshInterval: (seconds: number | undefined) => void;
}) {
  const { t } = useI18n();
  const [pages, setPages] = useState<HTMLElement | null>(null);
  const [add, setAdd] = useState<HTMLElement | null>(null);
  const [more, setMore] = useState<HTMLElement | null>(null);
  const doc = p.document;
  const others = p.documents.filter((d) => d.id !== doc.id);

  return (
    <div className="st-topbar">
      <button type="button" className={`st-pages ${pages ? "on" : ""}`} title="切换看板" onClick={(e) => setPages(pages ? null : e.currentTarget)}>
        <LayoutDashboard size={15} /><ChevronDown size={12} />
      </button>
      <CommitInput className="st-doc-title" value={doc.title} ariaLabel={t("dashboard.name")} onCommit={(v) => p.onTitle(v.trim() || doc.title)} />
      <span className={`st-save-state ${p.dirty ? "dirty" : ""}`}>{p.dirty ? "未保存" : "已保存"}</span>
      {!p.preview && <button type="button" className="icon-btn" disabled={!p.canUndo} title="撤销 (⌘Z)" onClick={p.onUndo}><Undo2 size={15} /></button>}
      {!p.preview && (
        <button type="button" className={`btn sm st-add ${add ? "on" : ""}`} onClick={(e) => setAdd(add ? null : e.currentTarget)}>
          <Plus size={14} />添加组件
        </button>
      )}
      <span className="toolbar-spacer" />
      <button type="button" className={`btn sm ${p.preview ? "primary" : ""}`} onClick={p.onPreview} title="⌘E 切换">
        {p.preview ? <><Pencil size={13} />回到编辑</> : <><Eye size={13} />查看效果</>}
      </button>
      <button type="button" className={`btn sm ${more ? "on" : ""}`} onClick={(e) => setMore(more ? null : e.currentTarget)}><MoreHorizontal size={14} />更多</button>
      {!p.preview && (
        <button type="button" className="btn sm primary" onClick={p.onSave} disabled={p.saving} title={p.storagePath ? `保存到 ${p.storagePath} (⌘S)` : "保存 (⌘S)"}>
          {p.saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />}保存
        </button>
      )}

      {pages && (
        <Pop anchor={pages} width={280} onClose={() => setPages(null)}>
          <div className="st-menu-group">当前</div>
          <MenuItem icon={<LayoutDashboard size={13} />} on onClick={() => setPages(null)}>{doc.title}</MenuItem>
          {others.length > 0 && <div className="st-menu-group">其他看板</div>}
          <div className="st-menu-scroll">
            {others.map((d) => (
              <MenuItem key={d.id} icon={<LayoutDashboard size={13} />} hint={`${d.widgets.length} 个组件`}
                onClick={() => { setPages(null); p.onSelectDocument(d.id); }}>{d.title}</MenuItem>
            ))}
          </div>
          <div className="st-pm-sep" />
          <MenuItem icon={<Plus size={13} />} onClick={() => { setPages(null); p.onNewDocument(); }}>新建看板</MenuItem>
          <MenuItem icon={<Copy size={13} />} onClick={() => { setPages(null); p.onDuplicateDocument(); }}>复制一份当前看板</MenuItem>
        </Pop>
      )}
      {add && (
        <Pop anchor={add} width={300} onClose={() => setAdd(null)}>
          <div className="st-add-grid">
            {WIDGET_TYPES.map((type) => {
              const M = TYPE_META[type];
              const I = M.icon;
              return (
                <button type="button" key={type} onClick={() => { setAdd(null); p.onAddWidget(type); }}>
                  <I size={18} /><span>{M.label}</span>
                </button>
              );
            })}
          </div>
          <p className="st-foot-note">也可以直接从左边把字段拖到画布上。</p>
        </Pop>
      )}
      {more && (
        <Pop anchor={more} width={240} onClose={() => setMore(null)}>
          <div className="st-menu-group">自动刷新</div>
          <div className="st-pop-pad">
            <Seg size="sm" value={doc.refreshInterval ?? 0} onChange={(v) => p.onRefreshInterval(v || undefined)}
              options={[{ value: 0, label: "关" }, { value: 60, label: "1分" }, { value: 300, label: "5分" }, { value: 600, label: "10分" }]} />
          </div>
          <div className="st-pm-sep" />
          <MenuItem icon={p.exportingHtml ? <Loader2 size={13} className="spin" /> : <Globe size={13} />} disabled={p.exportingHtml}
            hint="离线可交互" onClick={() => { setMore(null); p.onExportHtml(); }}>导出网页</MenuItem>
          <MenuItem icon={<FileDown size={13} />} hint="可再导回" onClick={() => { setMore(null); p.onExportJson(); }}>导出 JSON</MenuItem>
          {!p.preview && <MenuItem icon={<FileUp size={13} />} hint="JSON / 网页" onClick={() => { setMore(null); p.onImport(); }}>导入</MenuItem>}
          {!p.preview && <>
            <div className="st-pm-sep" />
            <MenuItem icon={<Trash2 size={13} />} danger onClick={() => { setMore(null); p.onDelete(); }}>删除这个看板</MenuItem>
          </>}
        </Pop>
      )}
    </div>
  );
}

/* ── 筛选条 ───────────────────────────────────────────────────────── */

/** 看板用到的所有数据集里的维度,按字段名合并 —— 全局筛选按字段名联动。 */
function dimensionPool(document: DashboardDocument, datasets: Dataset[]) {
  const used = new Set(document.widgets.map((w) => w.datasetId).filter(Boolean));
  const pool = new Map<string, { name: string; label: string; datasetId: string; field: Dataset["fields"][number]; count: number }>();
  for (const d of datasets) {
    if (!used.has(d.id)) continue;
    for (const f of d.fields) {
      if (f.hidden || f.role !== "dimension" || isTimeField(f)) continue; // 日期有自己的日期控件
      const hit = pool.get(f.name);
      if (hit) hit.count += 1;
      else pool.set(f.name, { name: f.name, label: f.label || f.name, datasetId: d.id, field: f, count: 1 });
    }
  }
  return [...pool.values()];
}

export function FilterRail(p: {
  document: DashboardDocument;
  preview: boolean;
  values: DashboardFilterValues;
  drill?: DashboardDrillFilter;
  refreshing: boolean;
  onScope: (start: string, end: string) => void;
  onClearScope: () => void;
  onAddFilter: (filter: DashboardFilter) => void;
  onChangeFilter: (filter: DashboardFilter) => void;
  onRemoveFilter: (id: string) => void;
  onValue: (id: string, value: string) => void;
  onClearDrill: () => void;
  onRefresh: () => void;
}) {
  const datasets = useDatasets((s) => s.datasets);
  const scope = p.document.metricScope ?? defaultMetricScope();
  const pool = dimensionPool(p.document, datasets);
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const taken = new Set(p.document.filters.map((f) => f.field));
  const term = q.trim().toLowerCase();
  const candidates = pool.filter((f) => !taken.has(f.name) && (!term || f.label.toLowerCase().includes(term) || f.name.toLowerCase().includes(term)));
  const labelOf = (name: string) => pool.find((f) => f.name === name)?.label ?? name;

  return (
    <div className="st-filterrail">
      {p.document.metricScope ? (
        <span className="st-rail-date" title="看板的数据日期:没固定日期的组件都跟着它">
          <CalendarRange size={14} />
          <DateRangePicker start={scope.start} end={scope.end} onChange={p.onScope} />
          {!p.preview && <button type="button" className="icon-btn" title="不按日期筛(看全部)" onClick={p.onClearScope}><X size={12} /></button>}
        </span>
      ) : (
        <button type="button" className="st-chip st-rail-all" disabled={p.preview} title="现在不按日期筛。点一下按日期范围看" onClick={() => p.onScope(scope.start, scope.end)}>
          <CalendarRange size={13} /><span className="st-chip-value">全部日期</span>
        </button>
      )}
      {p.document.filters.map((filter) => (
        <FilterChip key={filter.id} filter={filter} pool={pool} preview={p.preview} value={p.values[filter.id] ?? filter.defaultValue ?? ""}
          autoOpen={openId === filter.id} onOpened={() => setOpenId(null)}
          onChange={p.onChangeFilter} onRemove={() => p.onRemoveFilter(filter.id)} onValue={(v) => p.onValue(filter.id, v)} />
      ))}
      {p.drill && (
        <button type="button" className="st-chip linked" onClick={p.onClearDrill} title="点击取消联动">
          <Link2 size={12} />{labelOf(p.drill.field)} = {p.drill.value}<RotateCcw size={11} />
        </button>
      )}
      {!p.preview && (
        <button type="button" className={`st-add-filter ${adding ? "on" : ""}`} onClick={(e) => setAdding(adding ? null : e.currentTarget)} title="加一个看板筛选:所有含这个字段的组件一起筛">
          <Filter size={13} />{p.document.filters.length ? "" : "加筛选"}<Plus size={12} />
        </button>
      )}
      {adding && (
        <Pop anchor={adding} width={250} onClose={() => { setAdding(null); setQ(""); }}>
          <label className="st-search"><input autoFocus value={q} placeholder="按哪个字段筛" onChange={(e) => setQ(e.target.value)} /></label>
          <div className="st-menu-scroll">
            {candidates.map((f) => (
              <MenuItem key={f.name} icon={<FieldIcon field={f.field} />} hint={f.count > 1 ? `${f.count} 个数据集` : undefined}
                onClick={() => {
                  const id = `filter-${Math.random().toString(36).slice(2, 12)}`;
                  p.onAddFilter({ id, title: f.label, scope: "global", datasetId: f.datasetId, field: f.name, kind: "in" });
                  setOpenId(id);
                  setAdding(null); setQ("");
                }}>{f.label}</MenuItem>
            ))}
            {!candidates.length && <p className="st-empty">{pool.length ? "没有可加的字段" : "先给组件选上数据集"}</p>}
          </div>
        </Pop>
      )}
      <span className="toolbar-spacer" />
      {p.document.refreshInterval ? <span className="st-auto" title="自动刷新"><Timer size={12} />{p.document.refreshInterval >= 60 ? `${p.document.refreshInterval / 60} 分` : `${p.document.refreshInterval} 秒`}</span> : null}
      <button type="button" className="icon-btn" title="重新取数" onClick={p.onRefresh}><RefreshCw size={14} className={p.refreshing ? "spin" : ""} /></button>
    </div>
  );
}

function FilterChip({ filter, pool, preview, value, autoOpen, onOpened, onChange, onRemove, onValue }: {
  filter: DashboardFilter;
  pool: ReturnType<typeof dimensionPool>;
  preview: boolean;
  value: string;
  autoOpen: boolean;
  onOpened: () => void;
  onChange: (f: DashboardFilter) => void;
  onRemove: () => void;
  onValue: (v: string) => void;
}) {
  const { t } = useI18n();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const entry = pool.find((f) => f.name === filter.field);
  const datasetId = entry?.datasetId ?? filter.datasetId;
  const fv = useFieldValues(datasetId, undefined, t);
  const selected = filter.kind === "in" ? value.split(SOH).filter(Boolean) : value ? [value] : [];
  const summary = !selected.length ? "全部" : filter.kind === "text" ? `含「${value}」`
    : selected.length <= 2 ? selected.join("、") : `${selected[0]} 等 ${selected.length} 个`;
  const got = fv.valuesOf(filter.field);
  const open = (el: HTMLElement) => { setAnchor(el); if (filter.kind !== "text") void fv.load(filter.field); };
  const isDefault = value === (filter.defaultValue ?? "");

  return (
    <>
      <button type="button" ref={(el) => { if (autoOpen && el && !anchor) { open(el); onOpened(); } }}
        className={`st-chip ${selected.length ? "active" : ""} ${anchor ? "on" : ""} ${entry ? "" : "orphan"}`}
        title={entry ? `${filter.title}:${summary}` : `看板里已经没有组件用「${filter.field}」了`}
        onClick={(e) => (anchor ? setAnchor(null) : open(e.currentTarget))}>
        <span className="st-chip-label">{filter.title || entry?.label || filter.field}</span>
        <span className="st-chip-value">{summary}</span>
        <ChevronDown size={12} />
      </button>
      {anchor && (
        <Pop anchor={anchor} width={290} onClose={() => setAnchor(null)}>
          {!preview && (
            <div className="st-filter-edit">
              <CommitInput value={filter.title} placeholder="筛选名称" onCommit={(title) => onChange({ ...filter, title: title || entry?.label || filter.field })} />
              <Seg size="sm" value={filter.kind} onChange={(kind) => { onChange({ ...filter, kind, defaultValue: undefined }); onValue(""); if (kind !== "text") void fv.load(filter.field); }}
                options={[{ value: "in", label: "多选" }, { value: "select", label: "单选" }, { value: "text", label: "包含文字" }]} />
            </div>
          )}
          {filter.kind === "text" ? (
            <div className="st-pop-pad">
              <input className="st-input" autoFocus value={value} placeholder="输入要包含的文字" onChange={(e) => onValue(e.target.value)} />
            </div>
          ) : (
            <ValuePicker options={got.values} selected={selected} loading={got.loading} truncated={got.truncated} multi={filter.kind === "in"}
              onChange={(next) => { onValue(filter.kind === "in" ? next.join(SOH) : next[0] ?? ""); if (filter.kind === "select") setAnchor(null); }} />
          )}
          {!preview && (
            <>
              <div className="st-pm-sep" />
              <MenuItem icon={isDefault ? <Check size={13} /> : <Download size={13} />} disabled={isDefault}
                hint={filter.defaultValue ? "打开看板时就是这些" : undefined}
                onClick={() => onChange({ ...filter, defaultValue: value || undefined })}>{isDefault ? "当前就是默认值" : "把现在的选择设为默认"}</MenuItem>
              <MenuItem icon={<Trash2 size={13} />} danger onClick={() => { setAnchor(null); onRemove(); }}>删除这个筛选</MenuItem>
            </>
          )}
          {preview && selected.length > 0 && (
            <>
              <div className="st-pm-sep" />
              <MenuItem icon={<X size={13} />} onClick={() => { onValue(""); setAnchor(null); }}>清除</MenuItem>
            </>
          )}
        </Pop>
      )}
    </>
  );
}
