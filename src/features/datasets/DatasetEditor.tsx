/**
 * 数据集编辑器:铺满整个窗口(不再挤在数据资产的浮层里)。
 *
 *   顶栏   ← 返回 · 名字 · 连接 / 库 · 几个看板在用 · 保存状态 · 删除 · 保存
 *   左边   所有数据集(一直在,随时切)
 *   右边   数据从哪来(关联写成句子 / 写 SQL) → 字段(按表分组的表格) → 预览数据
 *
 * 字段不用再手动「探测」:来源一改,停 0.7 秒自动按来源认一遍(保留已经调过的显示名、
 * 维度度量、保留与否)。⌘S 保存;有没保存的改动时离开会问一句。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ChevronDown, ChevronRight, Database, Loader2, Play, Plus, RefreshCw, Save, Search, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import { useApp } from "../../store/appStore";
import { useConfirm } from "../../components/useConfirm";
import type { QueryResult } from "../../types";
import { useDatasets } from "./datasetsStore";
import { previewDataset, probeFields } from "./service";
import { createDataset, validateDataset, type Dataset } from "./domain";
import { useDatabases, useTableColumns, useTables } from "./datasetHooks";
import DatasetSource, { Pick } from "./DatasetSource";
import DatasetFields from "./DatasetFields";

/** 比较「有没有改」时不看 updatedAt(保存时会变) */
const contentOf = (d: Dataset | undefined) => (d ? JSON.stringify({ ...d, updatedAt: "" }) : "");
const sourceKeyOf = (d: Dataset) => JSON.stringify([d.connectionId, d.database ?? "", d.source]);
const hasSource = (d: Dataset) => (d.source.kind === "sql" ? !!d.source.sql.trim() : !!d.source.base.table);

export function sourceSummary(d: Dataset): string {
  if (d.source.kind === "sql") return "SQL";
  if (!d.source.base.table) return "还没选表";
  return d.source.joins.length ? `${d.source.base.table} + ${d.source.joins.length} 张关联表` : d.source.base.table;
}

export default function DatasetEditor({ startId, usage, onClose }: {
  /** 打开哪个;"new" = 新建 */
  startId: string;
  /** 数据集 id → 用到它的看板数 */
  usage: Record<string, number>;
  onClose: () => void;
}) {
  const datasets = useDatasets((s) => s.datasets);
  const connections = useApp((s) => s.connections);
  const { askConfirm, confirmDialog } = useConfirm();
  const fresh = useCallback(() => createDataset("未命名数据集", connections[0]?.id ?? "", connections[0]?.database || undefined), [connections]);
  const [draft, setDraft] = useState<Dataset>(() => datasets.find((d) => d.id === startId) ?? fresh());
  const [listQuery, setListQuery] = useState("");
  const [busy, setBusy] = useState<"save" | null>(null);
  /** 保存失败、不能保存的原因 —— 只放出错的事;「已保存 / 有改动」由 dirty 算 */
  const [failure, setFailure] = useState<string>();
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string>();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<{ result?: QueryResult; error?: string; loading: boolean }>({ loading: false });

  const kind = connections.find((c) => c.id === draft.connectionId)?.kind;
  const databases = useDatabases(draft.connectionId);
  const tables = useTables(draft.connectionId, draft.database);
  const { columns, load } = useTableColumns(draft.connectionId, draft.database);
  const saved = datasets.find((d) => d.id === draft.id);
  const dirty = contentOf(saved) !== contentOf(draft);
  const problem = validateDataset(draft);
  const patch = (next: Partial<Dataset>) => setDraft((d) => ({ ...d, ...next }));

  /* 来源一改就自动认字段。打开一个已有数据集的那一刻不认(字段本来就有,一认就平白多出「未保存」) */
  const sourceKey = sourceKeyOf(draft);
  const draftRef = useRef(draft); draftRef.current = draft;
  const probedKey = useRef<string>(draft.fields.length ? sourceKey : "");
  useEffect(() => {
    if (sourceKey === probedKey.current || !hasSource(draftRef.current) || !draftRef.current.connectionId) return;
    const timer = window.setTimeout(() => {
      const snapshot = draftRef.current;
      probedKey.current = sourceKey;
      setProbing(true); setProbeError(undefined);
      probeFields(snapshot, kind)
        .then((fields) => setDraft((d) => (sourceKeyOf(d) === sourceKey ? { ...d, fields } : d)))
        .catch((error) => { if (sourceKeyOf(draftRef.current) === sourceKey) setProbeError(`认不出字段:${String(error)}`); })
        .finally(() => setProbing(false));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [sourceKey, kind]);

  /* 预览:展开着的时候,来源或字段一改就重查(停 0.8 秒) */
  const previewKey = JSON.stringify([sourceKey, draft.fields]);
  useEffect(() => {
    if (!previewOpen || problem || !draft.fields.length) return;
    const timer = window.setTimeout(() => {
      setPreview((p) => ({ ...p, loading: true }));
      previewDataset(draftRef.current, kind)
        .then((result) => setPreview({ result, loading: false }))
        .catch((error) => setPreview({ error: String(error), loading: false }));
    }, 800);
    return () => window.clearTimeout(timer);
  }, [previewOpen, previewKey, problem, kind, draft.fields.length]);

  const save = useCallback(async () => {
    const current = draftRef.current;
    const issue = validateDataset(current);
    if (issue) { setFailure(issue); return; }
    setBusy("save");
    try {
      const next = await useDatasets.getState().save(current);
      setDraft(next);
      setFailure(undefined);
    } catch (error) {
      setFailure(`没保存上:${String(error)}`);
    } finally { setBusy(null); }
  }, []);

  /** 有没保存的改动时,换数据集 / 返回之前问一句 */
  const leaveOk = async () => !dirty || askConfirm("这个数据集有改动还没保存,离开的话这些改动就没了。", "还没保存", "不保存,离开");
  const switchTo = async (next: Dataset | "new") => {
    if (next !== "new" && next.id === draft.id) return;
    if (!(await leaveOk())) return;
    const d = next === "new" ? fresh() : next;
    probedKey.current = d.fields.length ? sourceKeyOf(d) : "";
    setDraft(d); setFailure(undefined); setProbeError(undefined); setPreview({ loading: false });
  };
  const close = async () => { if (await leaveOk()) onClose(); };
  const remove = async () => {
    const n = usage[draft.id] ?? 0;
    const warn = n ? `有 ${n} 个看板在用它,删掉后那些组件会取不到数。` : "删掉后找不回来。";
    if (!(await askConfirm(warn, `删除数据集「${draft.name}」?`, "删除"))) return;
    await useDatasets.getState().remove(draft.id);
    const rest = useDatasets.getState().datasets;
    const next = rest[0] ?? fresh();
    probedKey.current = next.fields.length ? sourceKeyOf(next) : "";
    setDraft(next); setFailure(undefined);
  };

  // ⌘S 保存(编辑器开着时 ⌘S 归它,不去存 SQL 标签)
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); void save(); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const tableTitle = (alias: string) => {
    if (draft.source.kind !== "join") return alias;
    if (alias === draft.source.base.alias) return draft.source.base.table || alias;
    return draft.source.joins.find((j) => j.alias === alias)?.table ?? alias;
  };

  const listed = useMemo(() => {
    const q = listQuery.trim().toLowerCase();
    const all = saved ? datasets : [draft, ...datasets];
    return all.filter((d) => !q || d.name.toLowerCase().includes(q));
  }, [datasets, draft, saved, listQuery]);

  const status = busy === "save" ? "正在保存…" : failure ?? (dirty ? (saved ? "有改动没保存" : "还没保存") : "已保存");
  const statusTone = failure || dirty ? "warn" : "ok";

  return createPortal(
    <div className="ds-editor" role="dialog" aria-modal="true" aria-label="数据集编辑器">
      <header className="ds-ed-top">
        <button className="icon-btn" title="返回" onClick={() => void close()}><ArrowLeft size={16} /></button>
        <input className="ds-ed-name" value={draft.name} placeholder="给这个数据集起个名字" onChange={(e) => patch({ name: e.target.value })} />
        <span className="ds-ed-crumbs">
          <Database size={12} />
          <Pick value={draft.connectionId} placeholder="选连接" options={connections.map((c) => ({ value: c.id, label: c.name }))}
            onChange={(value) => patch({ connectionId: value, database: undefined, fields: [] })} />
          {databases.length > 0 && <>
            <ChevronRight size={12} />
            <Pick value={draft.database ?? ""} placeholder="选库" options={databases.map((d) => ({ value: d, label: d }))}
              onChange={(value) => patch({ database: value || undefined, fields: [] })} />
          </>}
        </span>
        {(usage[draft.id] ?? 0) > 0 && <span className="ds-badge">{usage[draft.id]} 个看板在用</span>}
        <span className="toolbar-spacer" />
        <span className={`ds-status ${statusTone}`} title={status}>{status}</span>
        {saved && <button className="btn sm danger" title="删除这个数据集" onClick={() => void remove()}><Trash2 size={13} /></button>}
        <button className="btn sm primary" onClick={() => void save()} disabled={busy === "save"} title="保存 (⌘S)">
          {busy === "save" ? <Loader2 size={13} className="spin" /> : <Save size={13} />} 保存
        </button>
      </header>

      <div className="ds-ed-body">
        <aside className="ds-ed-list">
          <label className="ds-search wide"><Search size={12} />
            <input value={listQuery} placeholder="找数据集" onChange={(e) => setListQuery(e.target.value)} />
          </label>
          <div className="ds-ed-items">
            {listed.map((d) => (
              <button key={d.id} className={`ds-ed-item ${d.id === draft.id ? "on" : ""}`} onClick={() => void switchTo(d)}>
                <b>{(d.id === draft.id ? draft.name : d.name) || "未命名数据集"}{d.id === draft.id && dirty ? " ·" : ""}</b>
                <small>{sourceSummary(d.id === draft.id ? draft : d)} · {(d.id === draft.id ? draft : d).fields.filter((f) => !f.hidden).length} 列</small>
              </button>
            ))}
          </div>
          <button className="ds-link strong ds-ed-new" onClick={() => void switchTo("new")}><Plus size={13} /> 新建数据集</button>
        </aside>

        <main className="ds-ed-main">
          {problem && hasSource(draft) && <p className="ds-warn">{problem}</p>}
          <DatasetSource dataset={draft} kind={kind} tables={tables} columns={columns} loadColumns={load}
            onChange={(source) => patch({ source })} />
          <DatasetFields dataset={draft} kind={kind} tableTitle={tableTitle} probing={probing} probeError={probeError}
            onChange={(fields) => patch({ fields })} />
          <section className="ds-card">
            <div className="ds-card-head">
              <button className="ds-group-toggle" onClick={() => setPreviewOpen((v) => !v)}>
                {previewOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<b>预览数据</b>
                <span className="ds-dim">{preview.result ? `前 ${preview.result.rows.length} 行` : "前 50 行"}</span>
              </button>
              {preview.loading && <Loader2 size={13} className="spin" />}
              <span className="toolbar-spacer" />
              {previewOpen && (
                <button className="ds-link" disabled={!!problem || preview.loading} onClick={() => {
                  setPreview((p) => ({ ...p, loading: true }));
                  previewDataset(draftRef.current, kind).then((result) => setPreview({ result, loading: false })).catch((error) => setPreview({ error: String(error), loading: false }));
                }}><RefreshCw size={12} /> 刷新</button>
              )}
            </div>
            {previewOpen && (
              preview.error ? <p className="ds-warn">{preview.error}</p>
              : !draft.fields.length ? <p className="ds-card-tip">先选好数据来源。</p>
              : !preview.result ? <p className="ds-card-tip"><Play size={12} /> 正在查…</p>
              : (
                <div className="ds-preview">
                  <table>
                    <thead><tr>{preview.result.columns.map((c) => <th key={c.name}>{draft.fields.find((f) => f.name === c.name)?.label || c.name}</th>)}</tr></thead>
                    <tbody>
                      {preview.result.rows.slice(0, 50).map((r, i) => (
                        <tr key={i}>{r.map((cell, j) => <td key={j}>{cell === null ? <span className="ds-dim">NULL</span> : String(cell)}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </section>
        </main>
      </div>
      {confirmDialog}
    </div>,
    document.body,
  );
}

/** 每个数据集被几个看板用着(看板里有组件用它取数就算一个) */
export function useDatasetUsage(): Record<string, number> {
  const [usage, setUsage] = useState<Record<string, number>>({});
  useEffect(() => {
    let live = true;
    void api.listDashboards().then((docs) => {
      if (!live) return;
      const out: Record<string, number> = {};
      for (const doc of docs) for (const id of new Set(doc.widgets.map((w) => w.datasetId).filter(Boolean))) out[id] = (out[id] ?? 0) + 1;
      setUsage(out);
    }).catch(() => { /* 读不到看板就不显示用量 */ });
    return () => { live = false; };
  }, []);
  return usage;
}
