/**
 * 数据集的字段表 —— 建数据集最花时间的地方,所以要快:
 *
 *   · 每行带几个示例值,不用猜「store_flag 到底是什么」
 *   · 显示名直接在格子里改,回车 / ↓ 跳到下一行接着改
 *   · 维度 / 数值一点就切;眼睛一点就隐藏(组件里挑不到它)
 *   · 按来源表分组,每组能一键全留 / 全藏,能折叠
 *   · 上面一排筛:全部 / 维度 / 数值 / 隐藏的
 */
import { Fragment, useMemo, useState, type KeyboardEvent } from "react";
import { ChevronRight, Eye, EyeOff, Loader2, Pencil, Search, Sigma, Shapes, Trash2 } from "lucide-react";
import { Seg } from "../../../components/StudioKit";
import { FieldIcon } from "../FieldIcon";
import { AGG_LABELS, type AggKind } from "../widgetQuery";
import type { Dataset, DatasetField } from "../domain";

type Filter = "all" | "dimension" | "measure" | "hidden";

export default function FieldTable({ dataset, tableTitle, samples, samplesReady, probing, probeError, onChange, onEditDerived, onNewDerived }: {
  dataset: Dataset;
  tableTitle: (alias: string) => string;
  /** 字段名 → 几个示例值(来自预览)。 */
  samples: Record<string, string[]>;
  /** 预览跑完了:这时还没有示例值的列就是真没有,别再显示「…」。 */
  samplesReady: boolean;
  probing: boolean;
  probeError?: string;
  onChange: (fields: DatasetField[]) => void;
  onEditDerived: (field: DatasetField) => void;
  onNewDerived: (mode: "calc" | "group") => void;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const fields = dataset.fields;

  const term = q.trim().toLowerCase();
  const shown = (f: DatasetField) =>
    (filter === "all" || (filter === "hidden" ? f.hidden : !f.hidden && f.role === filter))
    && (!term || f.name.toLowerCase().includes(term) || (f.label ?? "").toLowerCase().includes(term));

  const groups = useMemo(() => {
    const derived = fields.filter((f) => f.expr || f.grouping);
    const byTable = new Map<string, DatasetField[]>();
    for (const f of fields) {
      if (f.expr || f.grouping) continue;
      const key = f.from ?? "";
      const bucket = byTable.get(key);
      if (bucket) bucket.push(f); else byTable.set(key, [f]);
    }
    return [
      ...(derived.length ? [{ key: "__derived", title: "自己算出来的", list: derived, derived: true }] : []),
      ...[...byTable.entries()].map(([alias, list]) => ({ key: alias, title: alias ? tableTitle(alias) : "字段", list, derived: false })),
    ];
  }, [fields, tableTitle]);

  const patch = (name: string, next: Partial<DatasetField>) => onChange(fields.map((f) => (f.name === name ? { ...f, ...next } : f)));
  const setKept = (names: string[], keep: boolean) => {
    const set = new Set(names);
    onChange(fields.map((f) => (set.has(f.name) ? { ...f, hidden: !keep } : f)));
  };
  const counts = {
    all: fields.length,
    dimension: fields.filter((f) => !f.hidden && f.role === "dimension").length,
    measure: fields.filter((f) => !f.hidden && f.role === "measure").length,
    hidden: fields.filter((f) => f.hidden).length,
  };

  /** 回车 / ↓ / ↑ 在显示名格子之间上下跳 —— 一口气给二十个字段起中文名。 */
  const jump = (e: KeyboardEvent<HTMLInputElement>) => {
    const by = e.key === "ArrowDown" || e.key === "Enter" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!by) return;
    e.preventDefault();
    const all = [...document.querySelectorAll<HTMLInputElement>(".dst-label-input")];
    const next = all[all.indexOf(e.currentTarget) + by];
    if (next) { next.focus(); next.select(); } else e.currentTarget.blur();
  };

  return (
    <div className="dst-fields">
      <div className="dst-fields-bar">
        <label className="st-search dst-fields-search"><Search size={13} />
          <input value={q} placeholder="找字段" onChange={(e) => setQ(e.target.value)} />
        </label>
        <Seg size="sm" value={filter} onChange={setFilter} options={[
          { value: "all", label: `全部 ${counts.all}` },
          { value: "dimension", label: `维度 ${counts.dimension}` },
          { value: "measure", label: `数值 ${counts.measure}` },
          { value: "hidden", label: `隐藏 ${counts.hidden}` },
        ]} />
        {probing && <span className="st-hint"><Loader2 size={12} className="spin" /> 正在认字段…</span>}
        <span className="toolbar-spacer" />
        <button className="btn sm" disabled={!fields.length} onClick={() => onNewDerived("calc")} title="用已有的列算出一个新字段,比如 线上 + 线下"><Sigma size={13} />计算字段</button>
        <button className="btn sm" disabled={!fields.length} onClick={() => onNewDerived("group")} title="把一列的取值归成几档,比如把门店类型归成 直营 / 加盟"><Shapes size={13} />分组字段</button>
      </div>
      {probeError && <p className="dst-warn">{probeError}</p>}

      {fields.length === 0 ? (
        <div className="dst-fields-empty">{probing ? "正在按上面的来源认出有哪些列…" : "选好上面的数据来源,这里会列出所有字段。"}</div>
      ) : (
        <div className="dst-ftable-wrap">
          <table className="dst-ftable">
            <thead>
              <tr>
                <th className="c-eye" />
                <th className="c-label">显示名</th>
                <th className="c-name">字段</th>
                <th className="c-role">用途</th>
                <th className="c-agg">默认汇总</th>
                <th className="c-sample">示例值</th>
                <th className="c-act" />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const list = g.list.filter(shown);
                if (!list.length && term) return null;
                const kept = g.list.filter((f) => !f.hidden).length;
                const isFolded = folded[g.key] ?? false;
                return (
                  <Fragment key={g.key}>
                    {(groups.length > 1 || g.derived) && (
                      <tr className="dst-group">
                        <td colSpan={7}>
                          <button type="button" className="dst-group-toggle" onClick={() => setFolded((s) => ({ ...s, [g.key]: !isFolded }))}>
                            <ChevronRight size={13} className={isFolded ? "" : "open"} />
                            {g.derived ? <Sigma size={13} /> : null}<b>{g.title}</b><small>保留 {kept} / {g.list.length}</small>
                          </button>
                          <span className="dst-group-ops">
                            <button type="button" onClick={() => setKept(g.list.map((f) => f.name), true)}>全留</button>
                            <button type="button" onClick={() => setKept(g.list.map((f) => f.name), false)}>全藏</button>
                          </span>
                        </td>
                      </tr>
                    )}
                    {!isFolded && list.map((f) => {
                      const derived = !!(f.expr || f.grouping);
                      const sample = samples[f.name];
                      return (
                        <tr key={f.name} className={f.hidden ? "off" : ""}>
                          <td className="c-eye">
                            <button type="button" className="dst-eye" title={f.hidden ? "隐藏中:组件里挑不到它。点一下保留" : "保留中。点一下隐藏"}
                              onClick={() => patch(f.name, { hidden: !f.hidden })}>{f.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                          </td>
                          <td className="c-label">
                            <span className="dst-label">
                              <FieldIcon field={f} />
                              <input className="dst-label-input" value={f.label ?? ""} placeholder={f.name}
                                onChange={(e) => patch(f.name, { label: e.target.value || undefined })} onKeyDown={jump} />
                            </span>
                          </td>
                          <td className="c-name" title={f.grouping ? `按 ${f.grouping.source} 分组` : f.expr ?? `${f.column ?? f.name}${f.type ? ` · ${f.type}` : ""}`}>
                            {derived
                              ? <button type="button" className="dst-expr" onClick={() => onEditDerived(f)}>{f.grouping ? `按 ${f.grouping.source} 分组` : f.expr}</button>
                              : <><code>{f.name}</code>{f.type && <small>{f.type.toLowerCase()}</small>}</>}
                          </td>
                          <td className="c-role">
                            <Seg size="sm" value={f.role} onChange={(role) => patch(f.name, { role })}
                              options={[{ value: "dimension", label: "维度", title: "拿来分组 / 筛选:门店、日期、品类" }, { value: "measure", label: "数值", title: "拿来汇总:金额、数量" }]} />
                          </td>
                          <td className="c-agg">
                            {f.role === "measure" ? (
                              <select className="dst-agg" value={f.defaultAgg ?? "sum"} title="组件里默认怎么汇总,单个组件仍可改"
                                onChange={(e) => patch(f.name, { defaultAgg: e.target.value as AggKind })}>
                                {(Object.keys(AGG_LABELS) as AggKind[]).map((a) => <option key={a} value={a}>{AGG_LABELS[a]}</option>)}
                              </select>
                            ) : <span className="dst-dim">—</span>}
                          </td>
                          <td className="c-sample">
                            {sample === undefined ? <span className="dst-dim">{samplesReady ? "—" : "…"}</span>
                              : sample.length ? sample.map((v, i) => <span key={i} className="dst-sample">{v}</span>)
                                : <span className="dst-dim">全是空</span>}
                          </td>
                          <td className="c-act">
                            {derived && <>
                              <button type="button" className="icon-btn" title="修改" onClick={() => onEditDerived(f)}><Pencil size={12} /></button>
                              <button type="button" className="icon-btn" title="删掉这个字段" onClick={() => onChange(fields.filter((x) => x.name !== f.name))}><Trash2 size={12} /></button>
                            </>}
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
