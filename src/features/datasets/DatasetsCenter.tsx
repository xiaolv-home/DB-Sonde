/**
 * 数据资产里的「数据集」一面:所有数据集一览(来源、几列、几个看板在用),点一个进铺满窗口的
 * 数据集工作台(DatasetStudio)。看板那边也能直接跳进某一个(useDatasets.edit)。
 *
 * 一个数据集回答的是「这个组件的数拿哪张表算」:选一张主表再关联几张表,或者直接写 SQL。
 */
import { useEffect, useState } from "react";
import { Boxes, Plus } from "lucide-react";
import AssetShell from "../assets/AssetShell";
import { api } from "../../lib/api";
import { useDatasets } from "./datasetsStore";
import DatasetStudio, { sourceSummary } from "./studio/DatasetStudio";
import { FieldIcon } from "./FieldIcon";
import "./datasets.css";

export default function DatasetsCenter() {
  const open = useDatasets((s) => s.open);
  const usage = useDatasetUsage(open);
  if (!open) return null;
  return <DatasetsList usage={usage} />;
}

/**
 * 数据集工作台的宿主。它不投进「数据资产」的外壳 —— 自己铺满窗口 —— 所以不跟着列表的开关走:
 * 看板里点「编辑数据集」能直接打开它,不用先经过数据资产浮层。
 */
export function DatasetStudioHost() {
  const editing = useDatasets((s) => s.editing);
  const usage = useDatasetUsage(!!editing);
  if (!editing) return null;
  return <DatasetStudio startId={editing} usage={usage} onClose={() => useDatasets.getState().edit(null)} />;
}

function DatasetsList({ usage }: { usage: Record<string, number> }) {
  const datasets = useDatasets((s) => s.datasets);
  const loading = useDatasets((s) => s.loading && !s.loaded);
  const edit = useDatasets((s) => s.edit);
  return (
    <AssetShell
      title="数据集"
      sub="看板组件的取数来源:选一张主表再关联几张表,或者直接写 SQL。"
      actions={<button className="btn sm primary" onClick={() => edit("new")}><Plus size={14} /> 新建数据集</button>}
    >
      <div className="ds-home">
        {datasets.length === 0 ? (
          <div className="ds-home-empty">
            <Boxes size={28} />
            <b>{loading ? "正在读数据集…" : "还没有数据集"}</b>
            {!loading && <span>数据集就是一张给看板用的宽表:选一张主表、关联几张表、挑要用的字段。</span>}
            {!loading && <button className="btn primary" onClick={() => edit("new")}><Plus size={14} /> 新建数据集</button>}
          </div>
        ) : (
          <div className="ds-home-grid">
            {datasets.map((d) => {
              const kept = d.fields.filter((f) => !f.hidden);
              return (
                <button key={d.id} className="ds-home-card" onClick={() => edit(d.id)} title="打开编辑">
                  <Boxes size={18} />
                  <b>{d.name || "未命名数据集"}</b>
                  <small>{sourceSummary(d)} · {kept.length} 列</small>
                  <span className="ds-home-fields">
                    {kept.slice(0, 6).map((f) => <span key={f.name}><FieldIcon field={f} size={11} />{f.label || f.name}</span>)}
                    {kept.length > 6 && <span>+{kept.length - 6}</span>}
                  </span>
                  {(usage[d.id] ?? 0) > 0 && <span className="ds-badge">{usage[d.id]} 个看板在用</span>}
                </button>
              );
            })}
            <button className="ds-home-card ds-home-new" onClick={() => edit("new")}><Plus size={18} /><b>新建数据集</b></button>
          </div>
        )}
      </div>
    </AssetShell>
  );
}

/** 每个数据集被几个看板用着(看板里有组件用它取数就算一个) */
function useDatasetUsage(active: boolean): Record<string, number> {
  const [usage, setUsage] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!active) return;
    let live = true;
    void api.listDashboards().then((docs) => {
      if (!live) return;
      const out: Record<string, number> = {};
      for (const doc of docs) for (const id of new Set(doc.widgets.map((w) => w.datasetId).filter(Boolean))) out[id] = (out[id] ?? 0) + 1;
      setUsage(out);
    }).catch(() => { /* 读不到看板就不显示用量 */ });
    return () => { live = false; };
  }, [active]);
  return usage;
}
