/**
 * 数据集工作台(铺满窗口)。
 *
 *   顶栏   ← · 名字 · 连接 / 库 · 几个看板在用 · 保存状态 · 删除 · 保存(⌘S)
 *   左栏   所有数据集,随时切
 *   正文   数据从哪来(表链 / SQL)
 *          [字段] [数据预览] [SQL] 三个页签 —— 字段表每行带示例值
 *   右侧   计算字段 / 分组字段的抽屉
 *
 * 来源一改,停 0.7 秒自动认字段(保留已经调过的显示名、维度数值、隐藏与否);
 * 预览一直在后台跟着跑,所以字段表里的示例值总是新的。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Boxes, ChevronRight, Copy, Database, Loader2, Plus, RefreshCw, Save, Search, Trash2 } from "lucide-react";
import { useApp } from "../../../store/appStore";
import { useConfirm } from "../../../components/useConfirm";
import type { QueryResult } from "../../../types";
import { useDatasets } from "../datasetsStore";
import { previewDataset, probeFields } from "../service";
import { buildDatasetSql, createDataset, validateDataset, type Dataset, type DatasetField } from "../domain";
import { useDatabases, useTableColumns, useTables } from "../datasetHooks";
import SourceFlow from "./SourceFlow";
import FieldTable from "./FieldTable";
import DerivedDrawer from "./DerivedDrawer";
import { FieldIcon } from "../FieldIcon";
import "../../../components/studio-kit.css";
import "./datasetStudio.css";

const contentOf = (d: Dataset | undefined) => (d ? JSON.stringify({ ...d, updatedAt: "" }) : "");
const sourceKeyOf = (d: Dataset) => JSON.stringify([d.id, d.connectionId, d.database ?? "", d.source]);
const hasSource = (d: Dataset) => (d.source.kind === "sql" ? !!d.source.sql.trim() : !!d.source.base.table);

export function sourceSummary(d: Dataset): string {
  if (d.source.kind === "sql") return "SQL";
  if (!d.source.base.table) return "还没选表";
  return d.source.joins.length ? `${d.source.base.table} + ${d.source.joins.length} 张表` : d.source.base.table;
}

type Tab = "fields" | "preview" | "sql";

export default function DatasetStudio({ startId, usage, onClose }: {
  startId: string;
  usage: Record<string, number>;
  onClose: () => void;
}) {
  const datasets = useDatasets((s) => s.datasets);
  const connections = useApp((s) => s.connections);
  const { askConfirm, confirmDialog } = useConfirm();
  const fresh = useCallback(() => createDataset("未命名数据集", connections[0]?.id ?? "", connections[0]?.database || undefined), [connections]);
  const [draft, setDraft] = useState<Dataset>(() => datasets.find((d) => d.id === startId) ?? fresh());
  const [pristine, setPristine] = useState(() => contentOf(draft));
  const [listQuery, setListQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string>();
  const [tab, setTab] = useState<Tab>("fields");
  const [preview, setPreview] = useState<{ result?: QueryResult; error?: string; loading: boolean }>({ loading: false });
  const [drawer, setDrawer] = useState<{ mode: "calc" | "group"; field?: DatasetField } | null>(null);

  const kind = connections.find((c) => c.id === draft.connectionId)?.kind;
  const databases = useDatabases(draft.connectionId);
  const tables = useTables(draft.connectionId, draft.database);
  const { columns, load } = useTableColumns(draft.connectionId, draft.database);
  const saved = datasets.find((d) => d.id === draft.id);
  const dirty = contentOf(draft) !== (saved ? contentOf(saved) : pristine);
  const problem = validateDataset(draft);
  const patch = (next: Partial<Dataset>) => setDraft((d) => ({ ...d, ...next }));
  const patchSource = (next: Dataset["source"] | ((prev: Dataset["source"]) => Dataset["source"])) =>
    setDraft((d) => ({ ...d, source: typeof next === "function" ? next(d.source) : next }));

  /* 认字段。选表:来源一改就自动认(只读各表的列,不跑查询)。写 SQL:要整段跑一遍,不能边打字边跑,
     离开 SQL 框或点「识别字段」时认。打开已有数据集的那一刻不认(字段本来就有)。 */
  const sourceKey = sourceKeyOf(draft);
  const draftRef = useRef(draft); draftRef.current = draft;
  const probedKey = useRef<string>(draft.fields.length ? sourceKey : "");
  const [probedSource, setProbedSource] = useState(probedKey.current);
  const probe = useCallback((force = false) => {
    const snapshot = draftRef.current;
    const key = sourceKeyOf(snapshot);
    if ((!force && key === probedKey.current) || !hasSource(snapshot) || !snapshot.connectionId) return;
    probedKey.current = key;
    setProbing(true); setProbeError(undefined);
    probeFields(snapshot, kind)
      .then((fields) => { setDraft((d) => (sourceKeyOf(d) === key ? { ...d, fields } : d)); setProbedSource(key); })
      .catch((error) => { if (sourceKeyOf(draftRef.current) === key) setProbeError(`认不出字段:${String(error)}`); })
      .finally(() => setProbing(false));
  }, [kind]);
  const isSql = draft.source.kind === "sql";
  useEffect(() => {
    if (isSql) return;
    const timer = window.setTimeout(() => probe(), 700);
    return () => window.clearTimeout(timer);
  }, [sourceKey, isSql, probe]);

  /* 预览常驻后台:字段表的示例值靠它。来源或保留的字段一变就重查(停 0.8 秒)。 */
  const shape = JSON.stringify(draft.fields.map((f) => [f.name, f.hidden, f.expr, f.grouping]));
  const previewKey = JSON.stringify([isSql ? probedSource : sourceKey, shape]);
  const runPreview = useCallback(() => {
    setPreview((p) => ({ ...p, loading: true }));
    previewDataset(draftRef.current, kind, 50)
      .then((result) => setPreview({ result, loading: false }))
      .catch((error) => setPreview({ error: String(error).replace(/^Error:\s*/, ""), loading: false }));
  }, [kind]);
  useEffect(() => {
    if (problem || !draft.fields.length) return;
    const timer = window.setTimeout(runPreview, 800);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, problem, runPreview]);

  /** 每个字段前几个不重复的非空值。 */
  const samples = useMemo(() => {
    const out: Record<string, string[]> = {};
    const r = preview.result;
    if (!r) return out;
    r.columns.forEach((c, i) => {
      const seen = new Set<string>();
      for (const row of r.rows) {
        const v = row[i];
        if (v === null || v === undefined || v === "") continue;
        seen.add(String(v).slice(0, 40));
        if (seen.size >= 3) break;
      }
      out[c.name] = [...seen];
    });
    return out;
  }, [preview.result]);

  const save = useCallback(async () => {
    const current = draftRef.current;
    const issue = validateDataset(current);
    if (issue) { setFailure(issue); return; }
    setSaving(true);
    try {
      const next = await useDatasets.getState().save(current);
      setDraft(next);
      setFailure(undefined);
    } catch (error) {
      setFailure(`没保存上:${String(error)}`);
    } finally { setSaving(false); }
  }, []);

  const leaveOk = async () => !dirty || askConfirm("这个数据集有改动还没保存,离开的话这些改动就没了。", "还没保存", "不保存,离开");
  const open = (d: Dataset) => {
    probedKey.current = d.fields.length ? sourceKeyOf(d) : "";
    setProbedSource(probedKey.current);
    setDraft(d); setPristine(contentOf(d)); setFailure(undefined); setProbeError(undefined); setPreview({ loading: false }); setDrawer(null);
  };
  const switchTo = async (next: Dataset | "new") => {
    if (next !== "new" && next.id === draft.id) return;
    if (!(await leaveOk())) return;
    open(next === "new" ? fresh() : next);
  };
  const duplicate = async () => {
    if (!(await leaveOk())) return;
    const copy = { ...structuredClone(draft), id: `dataset-${Math.random().toString(36).slice(2, 12)}`, name: `${draft.name} 副本` };
    open(copy);
    setPristine("");
  };
  const close = async () => { if (await leaveOk()) onClose(); };
  const remove = async () => {
    const n = usage[draft.id] ?? 0;
    const warn = n ? `有 ${n} 个看板在用它,删掉后那些组件会取不到数。` : "删掉后找不回来。";
    if (!(await askConfirm(warn, `删除数据集「${draft.name}」?`, "删除"))) return;
    try { await useDatasets.getState().remove(draft.id); } catch (error) { setFailure(`没删掉:${String(error)}`); return; }
    open(useDatasets.getState().datasets[0] ?? fresh());
  };

  // ⌘S 保存(工作台开着时归它)
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); void save(); }
    if (e.key === "Escape" && drawer && !(e.target as HTMLElement).closest?.(".st-pop")) { e.preventDefault(); setDrawer(null); }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const tableTitle = useCallback((alias: string) => {
    if (draft.source.kind !== "join") return alias;
    if (alias === draft.source.base.alias) return draft.source.base.table || alias;
    return draft.source.joins.find((j) => j.alias === alias)?.table ?? alias;
  }, [draft.source]);
  const fieldCount = (alias: string) => {
    const list = draft.fields.filter((f) => f.from === alias && !f.expr && !f.grouping);
    return { kept: list.filter((f) => !f.hidden).length, total: list.length };
  };

  const listed = useMemo(() => {
    const q = listQuery.trim().toLowerCase();
    const all = saved ? datasets : [draft, ...datasets];
    return all.filter((d) => !q || d.name.toLowerCase().includes(q));
  }, [datasets, draft, saved, listQuery]);

  // 新建、还没动过的不算「已保存」—— 它根本还没存过
  const status = saving ? "正在保存…" : failure ?? (!saved ? "新数据集,还没保存" : dirty ? "有改动没保存" : "已保存");
  const kept = draft.fields.filter((f) => !f.hidden).length;
  const sql = (() => { try { return buildDatasetSql(draft, kind); } catch { return ""; } })();

  return createPortal(
    <div className="dst" role="dialog" aria-modal="true" aria-label="数据集工作台">
      <header className="dst-top">
        <button className="icon-btn" title="返回 (Esc)" onClick={() => void close()}><ArrowLeft size={16} /></button>
        <Boxes size={16} className="dst-top-icon" />
        <input className="dst-name" value={draft.name} placeholder="给这个数据集起个名字" onChange={(e) => patch({ name: e.target.value })} />
        <span className="dst-crumbs">
          <Database size={12} />
          <select value={draft.connectionId} onChange={(e) => patch({ connectionId: e.target.value, database: undefined, fields: [] })}>
            <option value="">选连接</option>
            {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {databases.length > 0 && <>
            <ChevronRight size={12} />
            <select value={draft.database ?? ""} onChange={(e) => patch({ database: e.target.value || undefined, fields: [] })}>
              <option value="">选库</option>
              {databases.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </>}
        </span>
        {(usage[draft.id] ?? 0) > 0 && <span className="dst-badge">{usage[draft.id]} 个看板在用</span>}
        <span className="toolbar-spacer" />
        <span className={`dst-status ${failure || dirty || !saved ? "warn" : "ok"}`} title={status}>{status}</span>
        {saved && <button className="btn sm" title="复制一份接着改" onClick={() => void duplicate()}><Copy size={13} />复制</button>}
        {saved && <button className="btn sm danger" title="删除这个数据集" onClick={() => void remove()}><Trash2 size={13} /></button>}
        <button className="btn sm primary" onClick={() => void save()} disabled={saving} title="保存 (⌘S)">
          {saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />}保存
        </button>
      </header>

      <div className="dst-body">
        <aside className="dst-list">
          <label className="st-search"><Search size={13} /><input value={listQuery} placeholder="找数据集" onChange={(e) => setListQuery(e.target.value)} /></label>
          <div className="dst-list-items">
            {listed.map((d) => {
              const cur = d.id === draft.id ? draft : d;
              return (
                <button key={d.id} className={`dst-item ${d.id === draft.id ? "on" : ""}`} onClick={() => void switchTo(d)}>
                  <b>{cur.name || "未命名数据集"}{d.id === draft.id && dirty ? " ·" : ""}</b>
                  <small>{sourceSummary(cur)} · {cur.fields.filter((f) => !f.hidden).length} 列</small>
                </button>
              );
            })}
          </div>
          <button className="dst-new" onClick={() => void switchTo("new")}><Plus size={13} />新建数据集</button>
        </aside>

        <main className="dst-main">
          {problem && hasSource(draft) && <p className="dst-warn">{problem}</p>}
          <SourceFlow dataset={draft} kind={kind} tables={tables} columns={columns} loadColumns={load}
            onChange={patchSource} onSqlDone={() => probe()} onRedetect={() => probe(true)} probing={probing} fieldCount={fieldCount} />

          <div className="dst-work">
            <div className="dst-tabs" role="tablist">
              <button role="tab" aria-selected={tab === "fields"} className={tab === "fields" ? "on" : ""} onClick={() => setTab("fields")}>字段 <small>{kept}/{draft.fields.length}</small></button>
              <button role="tab" aria-selected={tab === "preview"} className={tab === "preview" ? "on" : ""} onClick={() => setTab("preview")}>
                数据预览 {preview.loading ? <Loader2 size={11} className="spin" /> : preview.result ? <small>{preview.result.rows.length} 行</small> : null}
              </button>
              <button role="tab" aria-selected={tab === "sql"} className={tab === "sql" ? "on" : ""} onClick={() => setTab("sql")}>SQL</button>
              <span className="toolbar-spacer" />
              {tab === "preview" && <button className="st-link" disabled={!!problem || preview.loading} onClick={runPreview}><RefreshCw size={12} />刷新</button>}
            </div>

            {tab === "fields" && (
              <FieldTable dataset={draft} tableTitle={tableTitle} samples={samples} samplesReady={!!preview.result && !preview.loading} probing={probing} probeError={probeError}
                onChange={(fields) => patch({ fields })}
                onEditDerived={(field) => setDrawer({ mode: field.grouping ? "group" : "calc", field })}
                onNewDerived={(mode) => setDrawer({ mode })} />
            )}
            {tab === "preview" && (
              preview.error ? <p className="dst-warn">{preview.error}</p>
                : !draft.fields.length ? <div className="dst-fields-empty">先选好数据来源。</div>
                  : !preview.result ? <div className="dst-fields-empty"><Loader2 size={13} className="spin" /> 正在查…</div>
                    : (
                      <div className="dst-preview">
                        <table>
                          <thead><tr>{preview.result.columns.map((c) => {
                            const f = draft.fields.find((x) => x.name === c.name);
                            return <th key={c.name} title={c.name}><span><FieldIcon field={f} size={12} />{f?.label || c.name}</span>{f?.label && <small>{c.name}</small>}</th>;
                          })}</tr></thead>
                          <tbody>{preview.result.rows.map((r, i) => (
                            <tr key={i}>{r.map((cell, j) => <td key={j} className={typeof cell === "number" ? "num" : ""}>{cell === null ? <span className="dst-dim">NULL</span> : String(cell)}</td>)}</tr>
                          ))}</tbody>
                        </table>
                      </div>
                    )
            )}
            {tab === "sql" && (
              <div className="dst-sql">
                <p className="st-hint">看板组件取数时,会把下面这段当子查询,外面再按维度汇总。</p>
                <pre>{sql || "还没有可执行的 SQL"}</pre>
                {sql && <button className="btn sm" onClick={() => { void navigator.clipboard.writeText(sql); useApp.getState().showToast({ kind: "success", text: "SQL 已复制" }); }}><Copy size={13} />复制</button>}
              </div>
            )}
          </div>
        </main>

        {drawer && (
          <DerivedDrawer key={`${drawer.mode}-${drawer.field?.name ?? "new"}`} dataset={draft} kind={kind} mode={drawer.mode} editing={drawer.field}
            onClose={() => setDrawer(null)}
            onSave={(field) => {
              patch({ fields: drawer.field ? draft.fields.map((f) => (f.name === drawer.field!.name ? { ...f, ...field } : f)) : [...draft.fields, field] });
              setDrawer(null);
            }} />
        )}
      </div>
      {confirmDialog}
    </div>,
    document.body,
  );
}
