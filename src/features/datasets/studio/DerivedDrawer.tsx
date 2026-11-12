/**
 * 计算字段 / 分组字段的编辑抽屉(从右边滑出,不挡住字段表)。
 *
 *   计算  用字段名写行级表达式,点字段 / 运算符插进光标处;「试算」拿几行真数据跑一遍,
 *         直接看到算出来的值对不对,而不是只说一句「没问题」
 *   分组  选依据字段 → 它的取值全列出来 → 点一下归到当前这组。不用再手敲「A, B, C」。
 *
 * 表达式存的是字段名(人看见的那个);换成表里的真实引用是取数时的事(domain.derivedExpr)。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Play, Plus, Search, X } from "lucide-react";
import { api } from "../../../lib/api";
import { useApp } from "../../../store/appStore";
import { CommitInput, Seg } from "../../../components/StudioKit";
import { FieldIcon } from "../FieldIcon";
import { buildDatasetSql, type Dataset, type DatasetField, type DatasetGrouping } from "../domain";
import { datasetDimensionValues } from "../../dashboard/dataService";
import type { DbKind } from "../../../types";

const SNIPPETS = ["+", "-", "*", "/", "(", ")", "ROUND(", "ABS(", "COALESCE(", "CASE WHEN ", " THEN ", " ELSE ", " END"];

export default function DerivedDrawer({ dataset, kind, mode, editing, onSave, onClose }: {
  dataset: Dataset;
  kind: DbKind | undefined;
  mode: "calc" | "group";
  editing?: DatasetField;
  onSave: (field: DatasetField) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(editing?.label ?? editing?.name ?? "");
  const [role, setRole] = useState<DatasetField["role"]>(editing?.role ?? (mode === "calc" ? "measure" : "dimension"));
  const [expr, setExpr] = useState(editing?.expr ?? "");
  const [grouping, setGrouping] = useState<DatasetGrouping>(editing?.grouping ?? {
    source: dataset.fields.find((f) => f.role === "dimension" && !f.hidden && !f.expr && !f.grouping)?.name ?? "",
    buckets: [{ label: "", values: [] }],
    fallback: "",
  });
  const [active, setActive] = useState(0);
  const [search, setSearch] = useState("");
  const [trial, setTrial] = useState<{ loading: boolean; ok?: boolean; text?: string; values?: string[] }>({ loading: false });
  const area = useRef<HTMLTextAreaElement>(null);

  const usable = useMemo(() => dataset.fields.filter((f) => f.name !== editing?.name), [dataset.fields, editing?.name]);
  const fieldName = name.trim();

  const insert = (text: string) => {
    const el = area.current;
    if (!el) { setExpr(expr + text); return; }
    const start = el.selectionStart, end = el.selectionEnd;
    setExpr(expr.slice(0, start) + text + expr.slice(end));
    setTrial({ loading: false });
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + text.length; });
  };

  const draftField = (): DatasetField => ({
    name: fieldName, label: undefined, role,
    ...(mode === "calc" ? { expr: expr.trim() } : { grouping: { ...grouping, buckets: grouping.buckets.filter((b) => b.label.trim() && b.values.length) } }),
  });

  /** 试算:把这个字段塞进数据集跑几行,看算出来的值。 */
  const run = async () => {
    setTrial({ loading: true });
    try {
      const probe: Dataset = { ...dataset, fields: [...usable, { ...draftField(), name: fieldName || "__probe" }] };
      const sql = buildDatasetSql(probe, kind);
      const result = await api.runReadOnlyQuery(dataset.connectionId, dataset.database, sql, 8);
      const index = result.columns.findIndex((c) => c.name === (fieldName || "__probe"));
      const values = index >= 0 ? result.rows.map((r) => (r[index] === null ? "空" : String(r[index]))) : [];
      setTrial({ loading: false, ok: true, text: index >= 0 ? `类型 ${result.columns[index].typeName || "未知"}` : "能跑通", values });
    } catch (error) {
      setTrial({ loading: false, ok: false, text: String(error).replace(/^Error:\s*/, "") });
    }
  };

  // 分组:依据字段的取值
  const connections = useApp((s) => s.connections);
  const [values, setValues] = useState<{ list: string[]; loading: boolean; truncated: boolean }>({ list: [], loading: false, truncated: false });
  useEffect(() => {
    if (mode !== "group" || !grouping.source) return;
    let live = true;
    setValues((v) => ({ ...v, loading: true }));
    const ds = { ...dataset, fields: usable };
    datasetDimensionValues(ds, grouping.source, connections.find((c) => c.id === dataset.connectionId)?.kind, (k) => k, 500)
      .then((got) => { if (live) setValues({ list: got.values, loading: false, truncated: got.truncated }); })
      .catch(() => { if (live) setValues({ list: [], loading: false, truncated: false }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在换依据字段时重查,dataset 每次渲染都是新对象
  }, [mode, grouping.source]);

  const assigned = new Map<string, number>();
  grouping.buckets.forEach((b, i) => b.values.forEach((v) => assigned.set(v, i)));
  const assign = (value: string) => {
    const at = assigned.get(value);
    setGrouping({
      ...grouping,
      buckets: grouping.buckets.map((b, i) => {
        if (i === at) return { ...b, values: b.values.filter((v) => v !== value) };
        if (i === active && at === undefined) return { ...b, values: [...b.values, value] };
        return b;
      }),
    });
  };
  const term = search.trim().toLowerCase();

  const problem = !fieldName ? "先起个名字"
    : usable.some((f) => f.name === fieldName) ? "和已有字段重名了"
      : mode === "calc" ? (expr.trim() ? undefined : "表达式不能为空")
        : !grouping.source ? "选依据哪个字段"
          : grouping.buckets.some((b) => b.label.trim() && b.values.length) ? undefined : "至少要有一组:起个组名,再点几个取值进去";

  return (
    <aside className="dst-drawer" role="dialog" aria-label={mode === "calc" ? "计算字段" : "分组字段"}>
      <header className="dst-drawer-head">
        <b>{editing ? "修改" : "新建"}{mode === "calc" ? "计算字段" : "分组字段"}</b>
        <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}><X size={15} /></button>
      </header>
      <div className="dst-drawer-body">
        <div className="dst-drawer-row">
          <input className="st-input dst-drawer-name" autoFocus value={name} placeholder="字段叫什么" onChange={(e) => setName(e.target.value)} />
          <Seg size="sm" value={role} onChange={setRole} options={[{ value: "dimension", label: "维度" }, { value: "measure", label: "数值" }]} />
        </div>

        {mode === "calc" ? (
          <>
            <textarea ref={area} className="st-textarea dst-expr-input" value={expr} spellCheck={false}
              placeholder="用字段名写,例如:线上金额 + 线下金额" onChange={(e) => { setExpr(e.target.value); setTrial({ loading: false }); }} />
            <div className="dst-snips">{SNIPPETS.map((s) => <button type="button" key={s} onClick={() => insert(s)}>{s.trim()}</button>)}</div>
            <p className="st-hint">每一行算一次。求和、平均是组件里定的,这里不用写。</p>
            <label className="st-search"><Search size={13} /><input value={search} placeholder="点字段插进去" onChange={(e) => setSearch(e.target.value)} /></label>
            <div className="dst-insert">
              {usable.filter((f) => !term || f.name.toLowerCase().includes(term) || (f.label ?? "").toLowerCase().includes(term)).map((f) => (
                <button type="button" key={f.name} onClick={() => insert(f.name)} title={`插入 ${f.name}`}>
                  <FieldIcon field={f} size={12} /><span>{f.label || f.name}</span>{f.label && <small>{f.name}</small>}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <label className="dst-drawer-field"><span>依据</span>
              <select className="st-mini-sel" value={grouping.source} onChange={(e) => setGrouping({ ...grouping, source: e.target.value, buckets: [{ label: "", values: [] }] })}>
                <option value="">选一个字段…</option>
                {usable.filter((f) => !f.expr && !f.grouping).map((f) => <option key={f.name} value={f.name}>{f.label ? `${f.label}(${f.name})` : f.name}</option>)}
              </select>
            </label>
            <div className="dst-buckets">
              {grouping.buckets.map((b, i) => (
                <div key={i} className={`dst-bucket ${i === active ? "on" : ""}`} onClick={() => setActive(i)}>
                  <div className="dst-bucket-head">
                    <CommitInput value={b.label} placeholder={`第 ${i + 1} 组的名字`}
                      onCommit={(label) => setGrouping({ ...grouping, buckets: grouping.buckets.map((x, j) => (j === i ? { ...x, label } : x)) })} />
                    {grouping.buckets.length > 1 && <button type="button" className="icon-btn" aria-label="删掉这组"
                      onClick={(e) => { e.stopPropagation(); setGrouping({ ...grouping, buckets: grouping.buckets.filter((_, j) => j !== i) }); setActive(0); }}><X size={12} /></button>}
                  </div>
                  <div className="dst-bucket-values">
                    {b.values.length ? b.values.map((v) => <button type="button" key={v} onClick={(e) => { e.stopPropagation(); assign(v); }} title="点一下拿出去">{v}<X size={10} /></button>)
                      : <span className="st-hint">{i === active ? "点下面的取值放进来" : "点这组,再点取值"}</span>}
                  </div>
                </div>
              ))}
              <button type="button" className="st-link" onClick={() => { setGrouping({ ...grouping, buckets: [...grouping.buckets, { label: "", values: [] }] }); setActive(grouping.buckets.length); }}><Plus size={12} />加一组</button>
            </div>
            {grouping.source && (
              <div className="dst-pool">
                <div className="dst-pool-head">
                  <span>取值 {values.loading && <Loader2 size={11} className="spin" />}</span>
                  <small>还没归组的 {values.list.filter((v) => !assigned.has(v)).length} 个 · 点一下放进「{grouping.buckets[active]?.label || `第 ${active + 1} 组`}」</small>
                </div>
                <label className="st-search"><Search size={13} /><input value={search} placeholder="搜取值" onChange={(e) => setSearch(e.target.value)} /></label>
                <div className="dst-pool-values">
                  {values.list.filter((v) => !assigned.has(v) && (!term || v.toLowerCase().includes(term))).map((v) => (
                    <button type="button" key={v} onClick={() => assign(v)}>{v || "(空)"}</button>
                  ))}
                </div>
                {values.truncated && <p className="st-hint">取值太多,只列了前 {values.list.length} 个。</p>}
              </div>
            )}
            <label className="dst-drawer-field"><span>其余归到</span>
              <CommitInput value={grouping.fallback ?? ""} placeholder="留空就是空值" onCommit={(fallback) => setGrouping({ ...grouping, fallback: fallback || undefined })} />
            </label>
          </>
        )}

        {trial.text && (
          <div className={`dst-trial ${trial.ok ? "ok" : "bad"}`}>
            <span>{trial.ok ? "算出来了 · " : "算不出来:"}{trial.text}</span>
            {trial.values && trial.values.length > 0 && <div className="dst-trial-values">{trial.values.map((v, i) => <code key={i}>{v}</code>)}</div>}
          </div>
        )}
      </div>
      <footer className="dst-drawer-foot">
        <button className="btn sm" disabled={!!problem || trial.loading} onClick={() => void run()}>
          {trial.loading ? <Loader2 size={13} className="spin" /> : <Play size={13} />}试算几行
        </button>
        <span className="dst-problem">{problem}</span>
        <button className="btn sm" onClick={onClose}>取消</button>
        <button className="btn sm primary" disabled={!!problem} onClick={() => onSave(draftField())}>{editing ? "保存" : "加上"}</button>
      </footer>
    </aside>
  );
}
