/**
 * 数据集「数据从哪来」:选表关联,或者写 SQL。
 *
 * 关联不再是画布上拖卡片连线,而是一行行看得懂的句子:
 *   主表   ads_store_day
 *   左连接 dim_store   按 dim_store.id = ads_store_day.store_id   且 …
 * 每一处都是下拉,点一下就改。加表时先猜好关联字段(inferJoin),并按已有表里的
 * xxx_id 推荐「下一张该连哪张」。
 */
import { useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql as sqlLang } from "@codemirror/lang-sql";
import { syntaxHighlighting } from "@codemirror/language";
import { ChevronDown, Loader2, Plus, ScanSearch, Search, Sparkles, Table2, X } from "lucide-react";
import { useConfirm } from "../../components/useConfirm";
import { editorTheme, highlight } from "../../components/SqlEditor";
import {
  JOIN_OPS, buildDatasetSql,
  type Dataset, type DatasetJoinCond, type DatasetJoinKind, type DatasetJoinNode,
} from "./domain";
import { guessJoinAcross, recommendTables } from "./inferJoin";
import type { TableItem } from "./datasetHooks";
import type { DbKind } from "../../types";

const KIND_LABEL: Record<DatasetJoinKind, string> = { left: "左连接", inner: "内连接" };
const KIND_HINT: Record<DatasetJoinKind, string> = {
  left: "主表的行全留着,关联表对不上的填空",
  inner: "只留两边都对得上的行",
};

/** 紧凑下拉:整块可点,值显示在上面 */
export function Pick({ value, options, onChange, placeholder, className, title }: {
  value: string;
  options: Array<{ value: string; label: string; group?: string }>;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  title?: string;
}) {
  const current = options.find((o) => o.value === value);
  const groups = [...new Set(options.map((o) => o.group ?? ""))];
  return (
    <span className={`ds-pick ${className ?? ""} ${value ? "" : "empty"}`} title={title}>
      <span className="ds-pick-text">{current?.label || value || placeholder}</span>
      <ChevronDown size={11} />
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {placeholder && <option value="">{placeholder}</option>}
        {groups.length > 1
          ? groups.map((g) => (
            <optgroup key={g} label={g}>
              {options.filter((o) => (o.group ?? "") === g).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </optgroup>
          ))
          : options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </span>
  );
}

/** 挑表的弹层:搜表名 / 注释,上面一行是推荐 */
function TablePicker({ tables, used, recommended, onPick, onClose }: {
  tables: TableItem[] | null;
  used: Set<string>;
  recommended: { table: string; via: string }[];
  onPick: (table: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener("mousedown", off);
    return () => window.removeEventListener("mousedown", off);
  }, [onClose]);
  const term = q.trim().toLowerCase();
  const list = (tables ?? []).filter((t) => !term || t.name.toLowerCase().includes(term) || (t.comment ?? "").toLowerCase().includes(term));
  return (
    <div className="ds-tpick" ref={ref} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
      <label className="ds-tpick-search"><Search size={13} />
        <input autoFocus value={q} placeholder="搜表名 / 注释" onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && list[0] && !used.has(list[0].name)) onPick(list[0].name); }} />
      </label>
      {!term && recommended.length > 0 && (
        <div className="ds-tpick-rec">
          <span><Sparkles size={12} /> 推荐</span>
          {recommended.map((r) => (
            <button key={r.table} onClick={() => onPick(r.table)} title={`按 ${r.via} 关联`}>
              {r.table} <small>按 {r.via}</small>
            </button>
          ))}
        </div>
      )}
      <div className="ds-tpick-list">
        {tables === null && <p className="ds-tpick-none">正在读表…</p>}
        {tables !== null && list.length === 0 && <p className="ds-tpick-none">没有匹配的表</p>}
        {list.slice(0, 300).map((t) => (
          <button key={t.name} disabled={used.has(t.name)} onClick={() => onPick(t.name)} title={t.comment ?? t.name}>
            <Table2 size={12} />
            <span className="ds-tpick-name">{t.name}</span>
            {t.comment && <small>{t.comment}</small>}
            {used.has(t.name) && <em>已在用</em>}
          </button>
        ))}
      </div>
    </div>
  );
}

type Source = Dataset["source"];

export default function DatasetSource({ dataset, kind, tables, columns, loadColumns, onChange, onSqlDone, onRedetect, probing }: {
  dataset: Dataset;
  kind: DbKind | undefined;
  tables: TableItem[] | null;
  columns: Record<string, string[]>;
  loadColumns: (table: string) => Promise<string[]>;
  /** 传函数 = 按改的那一刻的来源算(加表要先等列读回来,不能拿等之前的旧来源覆盖) */
  onChange: (next: Source | ((prev: Source) => Source)) => void;
  /** 写完 SQL(离开 SQL 框):有改动就按它认字段 */
  onSqlDone: () => void;
  /** 「识别字段」:不管改没改,重新按 SQL 认一遍 */
  onRedetect: () => void;
  probing: boolean;
}) {
  const { askConfirm, confirmDialog } = useConfirm();
  /* 卡片里的一行提示(猜的关联、连带删掉了哪些表)。不定时消失:自己消失会让下面整块往上一跳,
     手正要点下面的字段,一跳就点到别的行上了。只在下一次加表 / 删表时换掉 */
  const [note, onMessage] = useState("");
  const [picking, setPicking] = useState<"base" | "join" | null>(null);
  const [showSql, setShowSql] = useState(false);
  const source = dataset.source;
  const generated = (() => { try { return buildDatasetSql(dataset, kind); } catch { return ""; } })();

  // 句子里出现的每张表都要有列可选,进来就把它们的列拉回来
  useEffect(() => {
    if (source.kind !== "join") return;
    if (source.base.table) void loadColumns(source.base.table);
    for (const join of source.joins) if (join.table) void loadColumns(join.table);
  });

  const switchTo = async (mode: "join" | "sql") => {
    if (mode === source.kind) return;
    // 关联转成 SQL 接着改;还没选表就从空白开始(不然是一句 FROM "" 的废 SQL)
    if (mode === "sql") { onChange({ kind: "sql", sql: source.kind === "join" && source.base.table ? generated : "" }); return; }
    // SQL 转不回关联:切回去等于从头选表,写好的 SQL 就没了
    if (source.kind === "sql" && source.sql.trim()
      && !(await askConfirm("切回「选表关联」要从头选表,现在这段 SQL 会丢掉(没有撤销)。", "丢掉这段 SQL?", "丢掉,重新选表"))) return;
    onChange({ kind: "join", base: { table: "", alias: "t1" }, joins: [], columns: [] });
  };

  const modeSwitch = (
    <div className="ds-seg" role="tablist">
      <button className={source.kind === "join" ? "on" : ""} onClick={() => void switchTo("join")}>选表关联</button>
      <button className={source.kind === "sql" ? "on" : ""} onClick={() => void switchTo("sql")} title="把现在的关联转成 SQL 接着改">写 SQL</button>
    </div>
  );

  if (source.kind === "sql") {
    return (
      <section className="ds-card">
        <div className="ds-card-head"><b>数据从哪来</b>{modeSwitch}</div>
        <div className="ds-sqleditor">
          <CodeMirror value={source.sql} minHeight="140px" maxHeight="360px" theme={editorTheme}
            extensions={[sqlLang(), syntaxHighlighting(highlight)]}
            onChange={(value) => onChange({ kind: "sql", sql: value })} onBlur={onSqlDone} />
        </div>
        <div className="ds-card-foot">
          <p className="ds-card-tip">写一条只读的 SELECT。写完点别处(或点「识别字段」),会把它跑一次认出有哪些列。</p>
          <button className="btn sm" disabled={probing || !source.sql.trim()} onClick={onRedetect}>
            {probing ? <Loader2 size={13} className="spin" /> : <ScanSearch size={13} />} 识别字段
          </button>
        </div>
        {confirmDialog}
      </section>
    );
  }

  const src = source;
  const aliasTable = (alias: string) => (alias === src.base.alias ? src.base.table : src.joins.find((j) => j.alias === alias)?.table ?? alias);
  const used = new Set([src.base.table, ...src.joins.map((j) => j.table)].filter(Boolean));
  const existing = [{ alias: src.base.alias, table: src.base.table }, ...src.joins.map((j) => ({ alias: j.alias, table: j.table }))]
    .filter((t) => t.table);
  const recommended = recommendTables(existing.map((t) => ({ table: t.table, fields: columns[t.table] ?? [] })), (tables ?? []).map((t) => t.name));

  const setJoin = (id: string, next: Partial<DatasetJoinNode>) =>
    onChange({ ...src, joins: src.joins.map((j) => (j.id === id ? { ...j, ...next } : j)) });
  const setCond = (join: DatasetJoinNode, index: number, next: Partial<DatasetJoinCond>) =>
    setJoin(join.id, { on: join.on.map((c, i) => (i === index ? { ...c, ...next } : c)) });

  const pickBase = (table: string) => {
    setPicking(null);
    void loadColumns(table);
    onChange({ ...src, base: { ...src.base, table } });
  };

  /** 加一张表:先猜它该挂到哪张已有的表上、按哪两个字段对上。
   *  要等列读回来 —— 等的时候可能又加了别的表,所以最后按「那一刻」的来源加,别名也那时再定 */
  const addJoin = async (table: string) => {
    setPicking(null);
    const fields = await loadColumns(table);
    const known = await Promise.all(existing.map(async (t) => ({ ...t, fields: await loadColumns(t.table) })));
    const guess = guessJoinAcross(table, fields, known);
    onChange((prev) => {
      if (prev.kind !== "join" || prev.joins.some((j) => j.table === table)) return prev;
      const taken = new Set([prev.base.alias, ...prev.joins.map((j) => j.alias)]);
      let n = prev.joins.length + 2;
      while (taken.has(`t${n}`)) n += 1;
      const join: DatasetJoinNode = {
        id: `join-${Math.random().toString(36).slice(2, 8)}`,
        table, alias: `t${n}`, kind: "left",
        on: [{ field: guess?.field ?? "", targetAlias: guess?.targetAlias ?? prev.base.alias, targetField: guess?.targetField ?? "" }],
      };
      return { ...prev, joins: [...prev.joins, join] };
    });
    onMessage(guess ? `「${table}」已按 ${guess.reason} 关联,不对的话点下拉改` : `「${table}」和已有的表没有看起来能对上的字段,在下拉里选一下`);
  };

  /** 删一张关联表:挂在它身上的表也跟着去掉(不然关联条件引用不到) */
  const removeJoin = (id: string) => {
    const gone = new Set<string>();
    const target = src.joins.find((j) => j.id === id);
    if (target) gone.add(target.alias);
    let changed = true;
    while (changed) {
      changed = false;
      for (const j of src.joins) if (!gone.has(j.alias) && j.on.some((c) => gone.has(c.targetAlias))) { gone.add(j.alias); changed = true; }
    }
    const keep = src.joins.filter((j) => !gone.has(j.alias));
    onChange({ ...src, joins: keep });
    if (gone.size > 1) onMessage(`挂在「${target?.table}」上的 ${gone.size - 1} 张表也一起去掉了`);
  };

  return (
    <section className="ds-card">
      <div className="ds-card-head"><b>数据从哪来</b>{modeSwitch}</div>
      <div className="ds-sentences">
        <div className="ds-sentence">
          <span className="ds-verb">主表</span>
          <span className="ds-anchor">
            <button className={`ds-tablebtn ${src.base.table ? "" : "empty"}`} onClick={() => setPicking(picking === "base" ? null : "base")}>
              <Table2 size={12} />{src.base.table || "选一张表"}<ChevronDown size={11} />
            </button>
            {picking === "base" && <TablePicker tables={tables} used={new Set()} recommended={[]} onPick={pickBase} onClose={() => setPicking(null)} />}
          </span>
          {src.base.table && <small className="ds-dim">{tables?.find((t) => t.name === src.base.table)?.comment}</small>}
        </div>

        {src.joins.map((join, index) => {
          // 关联条件只能指向它前面的表(主表 + 排在它前面的关联表)
          const before = [{ alias: src.base.alias, table: src.base.table }, ...src.joins.slice(0, index).map((j) => ({ alias: j.alias, table: j.table }))];
          const targetOptions = before.flatMap((t) => (columns[t.table] ?? []).map((c) => ({ value: `${t.alias}\u0000${c}`, label: `${t.table}.${c}`, group: t.table })));
          const ownOptions = (columns[join.table] ?? []).map((c) => ({ value: c, label: c }));
          return (
            <div className="ds-sentence" key={join.id}>
              <Pick className="ds-verb-pick" value={join.kind} title={KIND_HINT[join.kind]}
                options={(Object.keys(KIND_LABEL) as DatasetJoinKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
                onChange={(v) => setJoin(join.id, { kind: v as DatasetJoinKind })} />
              <span className="ds-table-name"><Table2 size={12} />{join.table}</span>
              <span className="ds-dim">按</span>
              {join.on.map((cond, ci) => (
                <span className="ds-cond" key={ci}>
                  {ci > 0 && (
                    <Pick className="ds-conn" value={cond.connector ?? "and"}
                      options={[{ value: "and", label: "且" }, { value: "or", label: "或" }]}
                      onChange={(v) => setCond(join, ci, { connector: v as "and" | "or" })} />
                  )}
                  <Pick className="mono" value={cond.field} placeholder={`${join.table} 的字段`}
                    options={ownOptions.map((o) => ({ ...o, label: `${join.table}.${o.label}` }))}
                    onChange={(v) => setCond(join, ci, { field: v })} />
                  <Pick className="ds-op" value={cond.op ?? "="} options={JOIN_OPS.map((o) => ({ value: o, label: o }))}
                    onChange={(v) => setCond(join, ci, { op: v as DatasetJoinCond["op"] })} />
                  <Pick className="mono" value={cond.targetField ? `${cond.targetAlias}\u0000${cond.targetField}` : ""} placeholder="对上哪张表的哪个字段"
                    options={targetOptions}
                    onChange={(v) => { const [targetAlias, targetField] = v.split("\u0000"); setCond(join, ci, { targetAlias, targetField }); }} />
                  {join.on.length > 1 && (
                    <button className="ds-x" title="去掉这个条件" onClick={() => setJoin(join.id, { on: join.on.filter((_, i) => i !== ci) })}><X size={11} /></button>
                  )}
                </span>
              ))}
              <button className="ds-link" title="再加一个条件(比如按门店 + 日期一起对)"
                onClick={() => setJoin(join.id, { on: [...join.on, { field: "", targetAlias: join.on[0]?.targetAlias ?? src.base.alias, targetField: "", connector: "and" }] })}>
                + 条件
              </button>
              <button className="ds-x ds-x-row" title={`去掉「${join.table}」`} onClick={() => removeJoin(join.id)}><X size={13} /></button>
              {join.on.some((c) => c.targetAlias !== src.base.alias) && (
                <small className="ds-dim ds-via">挂在 {join.on.map((c) => aliasTable(c.targetAlias)).filter((v, i, a) => a.indexOf(v) === i).join("、")} 上</small>
              )}
            </div>
          );
        })}

        {src.base.table && (
          <div className="ds-sentence ds-add">
            <span className="ds-anchor">
              <button className="ds-link strong" onClick={() => setPicking(picking === "join" ? null : "join")}><Plus size={13} /> 关联一张表</button>
              {picking === "join" && <TablePicker tables={tables} used={used} recommended={recommended} onPick={(t) => void addJoin(t)} onClose={() => setPicking(null)} />}
            </span>
            {recommended.length > 0 && (
              <span className="ds-dim">推荐:{recommended.slice(0, 3).map((r) => (
                <button key={r.table} className="ds-link" onClick={() => void addJoin(r.table)} title={`按 ${r.via} 关联`}>{r.table}</button>
              ))}</span>
            )}
          </div>
        )}
      </div>
      {note && <p className="ds-note">{note}</p>}
      {src.base.table && generated && (
        <div className="ds-sqlpeek">
          <button className="ds-link" onClick={() => setShowSql((v) => !v)}>{showSql ? "收起 SQL" : "看生成的 SQL"}</button>
          {showSql && <pre>{generated}</pre>}
        </div>
      )}
    </section>
  );
}
