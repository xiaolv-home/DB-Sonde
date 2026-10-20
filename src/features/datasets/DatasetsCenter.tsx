/**
 * 数据资产里的「数据集」一面:列出所有数据集(来源、几列、几个看板在用),点一个就打开
 * 铺满窗口的数据集编辑器(DatasetEditor)。编辑器不挤在这个浮层里 —— 选表、关联、
 * 几十列字段都要地方。
 *
 * 一个数据集回答的是「这个组件的数拿哪张表算」:要么选主表再关联几张表,要么直接写 SQL。
 */
import { useState } from "react";
import { Boxes, Plus } from "lucide-react";
import AssetShell from "../assets/AssetShell";
import { useDatasets } from "./datasetsStore";
import DatasetEditor, { sourceSummary, useDatasetUsage } from "./DatasetEditor";
import "./datasets.css";

export default function DatasetsCenter() {
  const open = useDatasets((s) => s.open);
  if (!open) return null;
  return <DatasetsList />;
}

function DatasetsList() {
  const datasets = useDatasets((s) => s.datasets);
  const loading = useDatasets((s) => s.loading && !s.loaded);
  const usage = useDatasetUsage();
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <AssetShell
      title="数据集"
      sub="看板组件的取数来源:选一张主表再关联几张表,或者直接写 SQL。"
      actions={<button className="btn sm primary" onClick={() => setEditing("new")}><Plus size={14} /> 新建数据集</button>}
    >
      <div className="ds-home">
        {datasets.length === 0 ? (
          <div className="ds-home-empty">
            <Boxes size={28} />
            <b>{loading ? "正在读数据集…" : "还没有数据集"}</b>
            {!loading && <span>数据集就是一张给看板用的宽表:选一张主表、关联几张表、挑要用的字段。</span>}
            {!loading && <button className="btn primary" onClick={() => setEditing("new")}><Plus size={14} /> 新建数据集</button>}
          </div>
        ) : (
          <div className="ds-home-grid">
            {datasets.map((d) => (
              <button key={d.id} className="ds-home-card" onClick={() => setEditing(d.id)} title="打开编辑">
                <Boxes size={18} />
                <b>{d.name || "未命名数据集"}</b>
                <small>{sourceSummary(d)} · 保留 {d.fields.filter((f) => !f.hidden).length} / {d.fields.length} 列</small>
                {(usage[d.id] ?? 0) > 0 && <span className="ds-badge">{usage[d.id]} 个看板在用</span>}
              </button>
            ))}
            <button className="ds-home-card ds-home-new" onClick={() => setEditing("new")}><Plus size={18} /><b>新建数据集</b></button>
          </div>
        )}
      </div>
      {editing && <DatasetEditor startId={editing} usage={usage} onClose={() => setEditing(null)} />}
    </AssetShell>
  );
}
