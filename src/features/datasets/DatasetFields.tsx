/**
 * 数据集的字段表:哪些列留下、显示成什么名字、是维度还是度量、度量默认怎么汇总,
 * 以及这个数据集自己算出来的字段(计算字段 / 分组字段)。
 *
 * 一行一个字段、一列一种属性,像表格一样从上往下扫;按来源表分组,每组能折叠、
 * 一键全选 / 清空。几十上百列的宽表,真正要用的往往不到十个 —— 「只看保留的」一点就清爽。
 */
import { Fragment, useState, type ReactNode } from "react";
import { ChevronRight, Loader2, Pencil, Plus, Search, Sigma, X } from "lucide-react";
import type { DbKind } from "../../types";
import FieldEditor from "./FieldEditor";
import { AGG_LABELS, type AggKind } from "./widgetQuery";
import type { Dataset, DatasetField } from "./domain";

export default function DatasetFields({ dataset, kind, tableTitle, probing, probeError, onChange }: {
  dataset: Dataset;
  kind: DbKind | undefined;
  /** 别名 → 表名,分组标题用 */
  tableTitle: (alias: string) => string;
  /** 正在按来源认字段 */
  probing: boolean;
  probeError?: string;
  onChange: (fields: DatasetField[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [keptOnly, setKeptOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editor, setEditor] = useState<{ mode: "calc" | "group"; field?: DatasetField } | null>(null);

  const fields = dataset.fields;
  const term = search.trim().toLowerCase();
  const visible = (f: DatasetField) =>
    (!keptOnly || !f.hidden) && (!term || f.name.toLowerCase().includes(term) || (f.label ?? "").toLowerCase().includes(term));

  // 算出来的字段不属于任何来源表,单独成组放最前面
  const derived = fields.filter((f) => f.expr || f.grouping);
  const byTable = new Map<string, DatasetField[]>();
  for (const field of fields) {
    if (field.expr || field.grouping) continue;
    const key = field.from ?? "";
    const bucket = byTable.get(key);
    if (bucket) bucket.push(field); else byTable.set(key, [field]);
  }
  const groups = [...byTable.entries()].map(([alias, list]) => ({
    alias, title: alias ? tableTitle(alias) : "字段", list, kept: list.filter((f) => !f.hidden).length,
  }));
  const keptCount = fields.filter((f) => !f.hidden).length;

  const patchField = (name: string, next: Partial<DatasetField>) =>
    onChange(fields.map((f) => (f.name === name ? { ...f, ...next } : f)));
  const setKept = (names: string[], keep: boolean) => {
    const set = new Set(names);
    onChange(fields.map((f) => (set.has(f.name) ? { ...f, hidden: !keep } : f)));
  };

  const row = (field: DatasetField, derivedRow = false) => (
    <tr key={field.name} className={`${field.hidden ? "off" : ""}`}>
      <td className="ds-c-keep">
        <input type="checkbox" checked={!field.hidden} title={field.hidden ? "不保留:组件里挑不到它" : "保留"}
          onChange={(e) => patchField(field.name, { hidden: !e.target.checked })} />
      </td>
      <td className="ds-c-name" title={field.grouping ? `按 ${field.grouping.source} 分组` : field.expr ?? field.column ?? field.name}>
        {derivedRow
          ? <button className="ds-link" onClick={() => setEditor({ mode: field.grouping ? "group" : "calc", field })}>{field.grouping ? `按 ${field.grouping.source} 分组` : field.expr}</button>
          : field.name}
      </td>
      <td className="ds-c-label">
        <input value={field.label ?? ""} placeholder={derivedRow ? field.name : "显示名"}
          onChange={(e) => patchField(field.name, { label: e.target.value || undefined })} />
      </td>
      <td className="ds-c-type">{derivedRow ? (field.grouping ? "分组" : "计算") : field.type ?? ""}</td>
      <td className="ds-c-role">
        <button className={`ds-role ${field.role}`} title="点一下切换维度 / 度量"
          onClick={() => patchField(field.name, { role: field.role === "measure" ? "dimension" : "measure" })}>
          {field.role === "measure" ? "度量" : "维度"}
        </button>
      </td>
      <td className="ds-c-agg">
        {field.role === "measure" ? (
          <select value={field.defaultAgg ?? "sum"} title="组件用这个作默认汇总方式,单个组件仍可改"
            onChange={(e) => patchField(field.name, { defaultAgg: e.target.value as AggKind })}>
            {(Object.keys(AGG_LABELS) as AggKind[]).map((agg) => <option key={agg} value={agg}>{AGG_LABELS[agg]}</option>)}
          </select>
        ) : <span className="ds-dim">—</span>}
      </td>
      <td className="ds-c-act">
        {derivedRow && (
          <>
            <button className="ds-x" title="修改" onClick={() => setEditor({ mode: field.grouping ? "group" : "calc", field })}><Pencil size={11} /></button>
            <button className="ds-x" title="删掉这个字段" onClick={() => onChange(fields.filter((f) => f.name !== field.name))}><X size={12} /></button>
          </>
        )}
      </td>
    </tr>
  );

  const groupHead = (key: string, title: string, kept: number, total: number, names: string[], icon?: ReactNode) => {
    const folded = collapsed[key] ?? false;
    return (
      <tr className="ds-group-row">
        <td colSpan={7}>
          <button className="ds-group-toggle" onClick={() => setCollapsed((c) => ({ ...c, [key]: !folded }))}>
            <ChevronRight size={12} className={folded ? "" : "open"} />
            {icon}<b>{title}</b><span className="ds-dim">保留 {kept} / {total}</span>
          </button>
          <span className="ds-group-ops">
            <button className="ds-link" onClick={() => setKept(names, true)}>全选</button>
            <button className="ds-link" onClick={() => setKept(names, false)}>清空</button>
          </span>
        </td>
      </tr>
    );
  };

  return (
    <section className="ds-card ds-fields">
      <div className="ds-card-head">
        <b>字段</b>
        <span className="ds-dim">保留 {keptCount} / {fields.length}</span>
        {probing && <span className="ds-dim"><Loader2 size={12} className="spin" /> 正在认字段…</span>}
        <span className="toolbar-spacer" />
        <label className="ds-search"><Search size={12} />
          <input value={search} placeholder="找字段" onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label className="ds-check"><input type="checkbox" checked={keptOnly} onChange={(e) => setKeptOnly(e.target.checked)} />只看保留的</label>
        <button className="ds-link strong" disabled={!fields.length} onClick={() => setEditor({ mode: "calc" })}><Plus size={12} /> 计算字段</button>
        <button className="ds-link strong" disabled={!fields.length} onClick={() => setEditor({ mode: "group" })}><Plus size={12} /> 分组字段</button>
      </div>

      {probeError && <p className="ds-warn">{probeError}</p>}
      {fields.length === 0 ? (
        <p className="ds-card-tip">{probing ? "正在按上面的来源认出有哪些列…" : "选好上面的数据来源,这里会自动列出所有字段。"}</p>
      ) : (
        <table className="ds-ftable">
          <thead>
            <tr><th className="ds-c-keep" /><th>字段</th><th>显示名</th><th>类型</th><th>用途</th><th>默认汇总</th><th className="ds-c-act" /></tr>
          </thead>
          <tbody>
            {derived.length > 0 && (
              <>
                {groupHead("__derived", "这个数据集自己算出来的", derived.filter((f) => !f.hidden).length, derived.length, derived.map((f) => f.name), <Sigma size={12} />)}
                {!collapsed.__derived && derived.filter(visible).map((f) => row(f, true))}
              </>
            )}
            {groups.map((g) => (
              <Fragment key={g.alias}>
                {groupHead(g.alias, g.title, g.kept, g.list.length, g.list.map((f) => f.name))}
                {!collapsed[g.alias] && g.list.filter(visible).map((f) => row(f))}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      {editor && (
        <FieldEditor
          dataset={dataset}
          kind={kind}
          mode={editor.mode}
          editing={editor.field}
          onClose={() => setEditor(null)}
          onSave={(field) => {
            onChange(editor.field
              ? fields.map((f) => (f.name === editor.field!.name ? { ...f, ...field } : f))
              : [...fields, field]);
            setEditor(null);
          }}
        />
      )}
    </section>
  );
}
