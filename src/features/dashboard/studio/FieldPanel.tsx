/**
 * 左边的字段面板:当前数据集的全部字段,维度 / 数值两组。
 *
 *   单击  加到选中的组件里(自动进对的区),再点一下拿掉
 *   拖    拖进右边任意一个字段区,或者拖到画布空白处直接长出一张图
 *
 * 选中的组件用到的字段会亮起来,一眼看到「这张图用了什么」。
 */
import { useMemo, useState } from "react";
import { Boxes, ChevronDown, PanelLeftClose, Plus, Search, Settings2 } from "lucide-react";
import { isTimeField, type DatasetField } from "../../datasets/domain";
import { useDatasets } from "../../datasets/datasetsStore";
import { openAsset } from "../../assets/AssetShell";
import type { DashboardWidget } from "../domain";
import { FieldIcon, endFieldDrag, startFieldDrag } from "./Shelf";
import { shelfItems, shelvesOf, toggleField } from "./smart";
import { MenuItem, Pop } from "../../../components/StudioKit";

/** 只有图标:title 给鼠标看,aria-label 给读屏,两处同一句。 */
function iconName(label: string) {
  return { title: label, "aria-label": label };
}

export default function FieldPanel({ widget, datasetId, onDataset, onChange, onCollapse }: {
  widget?: DashboardWidget;
  /** 没选组件时浏览的数据集(拖到画布上就用它)。 */
  datasetId?: string;
  onDataset: (id: string) => void;
  onChange: (widget: DashboardWidget) => void;
  onCollapse: () => void;
}) {
  const datasets = useDatasets((s) => s.datasets);
  const loaded = useDatasets((s) => s.loaded);
  const dataWidget = widget && shelvesOf(widget.type).length > 0;
  const activeId = dataWidget && widget.datasetId ? widget.datasetId : datasetId;
  const dataset = datasets.find((d) => d.id === activeId);
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<HTMLElement | null>(null);

  const used = useMemo(() => {
    const out = new Set<string>();
    if (!dataWidget || !widget) return out;
    for (const shelf of shelvesOf(widget.type)) if (shelf !== "conditions") for (const n of shelfItems(widget, shelf)) out.add(n);
    return out;
  }, [widget, dataWidget]);
  const filtered = new Set((widget?.bindings.conditions ?? []).map((c) => c.field));

  const term = q.trim().toLowerCase();
  const fields = (dataset?.fields ?? []).filter((f) => !f.hidden
    && (!term || f.name.toLowerCase().includes(term) || (f.label ?? "").toLowerCase().includes(term)));
  // 时间放最前面:做趋势图第一个要找的就是它
  const dims = fields.filter((f) => f.role === "dimension").sort((a, b) => Number(isTimeField(b)) - Number(isTimeField(a)));
  const measures = fields.filter((f) => f.role === "measure");

  const choose = (id: string) => {
    setPick(null);
    if (dataWidget && widget) {
      if (id === widget.datasetId) return;
      // 换数据集:旧字段多半对不上了,留着只会查出一句报错
      const names = new Set(datasets.find((d) => d.id === id)?.fields.map((f) => f.name) ?? []);
      const keep = (n?: string) => (n && names.has(n) ? n : undefined);
      const dims = (widget.bindings.dimensions ?? []).filter((d) => names.has(d));
      onChange({
        ...widget,
        datasetId: id,
        bindings: {
          ...widget.bindings,
          dimensions: dims, dimension: dims[0],
          seriesDimension: keep(widget.bindings.seriesDimension),
          measures: (widget.bindings.measures ?? []).filter((m) => names.has(m)),
          conditions: (widget.bindings.conditions ?? []).filter((c) => names.has(c.field)),
        },
      });
    }
    onDataset(id);
  };

  const row = (f: DatasetField) => {
    const on = used.has(f.name);
    return (
      <button type="button" key={f.name} className={`st-field ${on ? "on" : ""}`} draggable aria-pressed={on}
        title={`${f.label ? `${f.label}\n` : ""}${f.name}${f.type ? ` · ${f.type}` : ""}\n单击加入选中的组件 · 拖到字段区或画布`}
        onDragStart={(e) => startFieldDrag(e, { name: f.name })}
        onDragEnd={endFieldDrag}
        onClick={() => { if (dataWidget && widget) onChange(toggleField({ ...widget, datasetId: dataset!.id }, f.name, dataset)); }}>
        <FieldIcon field={f} />
        <span className="st-field-name">{f.label || f.name}</span>
        {filtered.has(f.name) && <span className="st-field-flag" title="组件上有按它的条件">筛</span>}
      </button>
    );
  };

  return (
    <aside className="st-fields">
      <div className="st-fields-head">
        <button type="button" className={`st-ds-pick ${dataset ? "" : "empty"}`} aria-haspopup="menu" aria-expanded={!!pick} onClick={(e) => setPick(pick ? null : e.currentTarget)}>
          <Boxes size={14} />
          <span>{dataset?.name || (loaded ? "选数据集" : "正在读…")}</span>
          <ChevronDown size={13} />
        </button>
        <button type="button" className="icon-btn" {...iconName("收起字段面板")} aria-expanded={true} onClick={onCollapse}><PanelLeftClose size={14} /></button>
      </div>
      {pick && (
        <Pop anchor={pick} width={260} onClose={() => setPick(null)}>
          <div className="st-menu-scroll">
            {datasets.map((d) => (
              <MenuItem key={d.id} on={d.id === dataset?.id} icon={<Boxes size={13} />}
                hint={`${d.fields.filter((f) => !f.hidden).length} 列`} onClick={() => choose(d.id)}>{d.name || "未命名数据集"}</MenuItem>
            ))}
            {datasets.length === 0 && <p className="st-empty">还没有数据集</p>}
          </div>
          <div className="st-pm-sep" />
          <MenuItem icon={<Plus size={13} />} onClick={() => { setPick(null); useDatasets.getState().edit("new"); }}>新建数据集</MenuItem>
          <MenuItem icon={<Settings2 size={13} />} onClick={() => { setPick(null); openAsset("datasets"); }}>管理全部数据集</MenuItem>
        </Pop>
      )}

      {!dataset ? (
        <div className="st-fields-empty">
          <Boxes size={22} />
          <p>{datasets.length ? "先选一个数据集,它的字段会列在这里。" : "看板的数从数据集来。先建一个:选几张表,或者写一段 SQL。"}</p>
          {!datasets.length && <button className="btn sm primary" onClick={() => useDatasets.getState().edit("new")}><Plus size={13} />新建数据集</button>}
        </div>
      ) : (
        <>
          <label className="st-search st-fields-search">
            <Search size={13} />
            <input value={q} placeholder="搜字段" onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="st-fields-scroll">
            <div className="st-fields-group"><span>维度</span><small>{dims.length}</small></div>
            {dims.map(row)}
            <div className="st-fields-group"><span>数值</span><small>{measures.length}</small></div>
            {measures.map(row)}
            {!fields.length && <p className="st-empty">{term ? "没有匹配的字段" : "这个数据集还没有字段"}</p>}
          </div>
          <div className="st-fields-foot">
            {dataWidget ? "单击加入 · 拖到右侧字段区" : "拖字段到画布空白处,直接生成图表"}
            <button type="button" className="icon-btn" {...iconName(`编辑数据集 ${dataset.name || "未命名数据集"}`)} onClick={() => useDatasets.getState().edit(dataset.id)}><Settings2 size={13} /></button>
          </div>
        </>
      )}
    </aside>
  );
}
