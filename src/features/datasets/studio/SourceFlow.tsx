/**
 * 数据集「数据从哪来」:一条从左到右的表链,或者一段 SQL。
 *
 *   [主表 demo_sales] ─ 左连接 · product_id = id ─▶ [demo_products ×]  [+ 关联表]  推荐:…
 *
 * 表是卡片,关联是卡片之间那颗胶囊,点哪个就在原地弹出它的设置。加表时先猜好关联字段
 * (inferJoin),并按已有表里的 xxx_id 推荐下一张 —— 绝大多数时候人只需要看一眼对不对。
 */
import { useEffect, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql as sqlLang } from "@codemirror/lang-sql";
import { syntaxHighlighting } from "@codemirror/language";
import { ArrowRight, Database, Loader2, Plus, ScanSearch, Search, Sparkles, Table2, Trash2, X } from "lucide-react";
import { useConfirm } from "../../../components/useConfirm";
import { editorTheme, highlight } from "../../../components/SqlEditor";
import { MenuItem, Pop, Seg } from "../../../components/StudioKit";
import { JOIN_OPS, buildDatasetSql, type Dataset, type DatasetJoinCond, type DatasetJoinKind, type DatasetJoinNode, type DatasetSourceJoin } from "../domain";
import { guessJoinAcross, recommendTables } from "../inferJoin";
import type { TableItem } from "../datasetHooks";
import type { DbKind } from "../../../types";

type Source = Dataset["source"];

const KIND_LABEL: Record<DatasetJoinKind, string> = { left: "左连接", inner: "内连接" };
const KIND_HINT: Record<DatasetJoinKind, string> = {
  left: "左边的行全留着,右边对不上的填空",
  inner: "只留两边都对得上的行",
};

/** 挑表:搜表名 / 注释,上面一行是推荐。回车选第一个。 */
function TablePicker({ tables, used, recommended, onPick }: {
  tables: TableItem[] | null;
  used: Set<string>;
  recommended: { table: string; via: string }[];
  onPick: (table: string) => void;
}) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const list = (tables ?? []).filter((t) => !term || t.name.toLowerCase().includes(term) || (t.comment ?? "").toLowerCase().includes(term));
  const first = list.find((t) => !used.has(t.name));
  return (
    <div className="dst-tpick">
      <label className="st-search"><Search size={13} />
        <input autoFocus value={q} placeholder="搜表名 / 注释" onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && first) onPick(first.name); }} />
      </label>
      {!term && recommended.length > 0 && (
        <>
          <div className="st-menu-group"><Sparkles size={11} /> 推荐</div>
          {recommended.map((r) => (
            <MenuItem key={r.table} icon={<Table2 size={13} />} hint={`按 ${r.via}`} onClick={() => onPick(r.table)}>{r.table}</MenuItem>
          ))}
          <div className="st-menu-group">全部</div>
        </>
      )}
      <div className="st-menu-scroll">
        {tables === null && <p className="st-empty"><Loader2 size={12} className="spin" /> 正在读表…</p>}
        {tables !== null && list.length === 0 && <p className="st-empty">没有匹配的表</p>}
        {list.slice(0, 300).map((t) => (
          <MenuItem key={t.name} icon={<Table2 size={13} />} disabled={used.has(t.name)} hint={used.has(t.name) ? "已在用" : t.comment}
            onClick={() => onPick(t.name)}>{t.name}</MenuItem>
        ))}
      </div>
    </div>
  );
}

export default function SourceFlow({ dataset, kind, tables, columns, loadColumns, onChange, onSqlDone, onRedetect, probing, fieldCount }: {
  dataset: Dataset;
  kind: DbKind | undefined;
  tables: TableItem[] | null;
  columns: Record<string, string[]>;
  loadColumns: (table: string) => Promise<string[]>;
  onChange: (next: Source | ((prev: Source) => Source)) => void;
  onSqlDone: () => void;
  onRedetect: () => void;
  probing: boolean;
  /** 每张表(别名)保留了几列 —— 卡片上显示。 */
  fieldCount: (alias: string) => { kept: number; total: number };
}) {
  const { askConfirm, confirmDialog } = useConfirm();
  const [note, setNote] = useState("");
  const [pop, setPop] = useState<{ kind: "base" | "add" | "join"; id?: string; anchor: HTMLElement } | null>(null);
  const source = dataset.source;
  const generated = (() => { try { return buildDatasetSql(dataset, kind); } catch { return ""; } })();

  // 链上每张表都要有列可选
  useEffect(() => {
    if (source.kind !== "join") return;
    if (source.base.table) void loadColumns(source.base.table);
    for (const join of source.joins) if (join.table) void loadColumns(join.table);
  });

  const switchTo = async (mode: "join" | "sql") => {
    if (mode === source.kind) return;
    // 关联转成 SQL 接着改;还没选表就从空白开始
    if (mode === "sql") { onChange({ kind: "sql", sql: source.kind === "join" && source.base.table ? generated : "" }); return; }
    if (source.kind === "sql" && source.sql.trim()
      && !(await askConfirm("切回「选表」要从头选表,现在这段 SQL 会丢掉(没有撤销)。", "丢掉这段 SQL?", "丢掉,重新选表"))) return;
    onChange({ kind: "join", base: { table: "", alias: "t1" }, joins: [], columns: [] });
  };

  const modeSwitch = (
    <Seg size="sm" value={source.kind} onChange={(v) => void switchTo(v)}
      options={[{ value: "join", label: "选表" }, { value: "sql", label: "写 SQL", title: "把现在的关联转成 SQL 接着改" }]} />
  );

  if (source.kind === "sql") {
    return (
      <section className="dst-source sql">
        <div className="dst-source-head"><b>数据从哪来</b>{modeSwitch}<span className="toolbar-spacer" />
          <span className="st-hint">写一条只读的 SELECT;写完点别处会跑一次认出列</span>
          <button className="btn sm" disabled={probing || !source.sql.trim()} onClick={onRedetect}>
            {probing ? <Loader2 size={13} className="spin" /> : <ScanSearch size={13} />}识别字段
          </button>
        </div>
        <div className="dst-sqleditor">
          <CodeMirror value={source.sql} minHeight="120px" maxHeight="320px" theme={editorTheme}
            extensions={[sqlLang(), syntaxHighlighting(highlight)]}
            onChange={(value) => onChange({ kind: "sql", sql: value })} onBlur={onSqlDone} />
        </div>
        {confirmDialog}
      </section>
    );
  }

  const src = source;
  const used = new Set([src.base.table, ...src.joins.map((j) => j.table)].filter(Boolean));
  const existing = [{ alias: src.base.alias, table: src.base.table }, ...src.joins.map((j) => ({ alias: j.alias, table: j.table }))].filter((t) => t.table);
  const recommended = recommendTables(existing.map((t) => ({ table: t.table, fields: columns[t.table] ?? [] })), (tables ?? []).map((t) => t.name));
  const tableOf = (alias: string) => (alias === src.base.alias ? src.base.table : src.joins.find((j) => j.alias === alias)?.table ?? alias);
  const comment = (table: string) => tables?.find((t) => t.name === table)?.comment;

  const setJoin = (id: string, next: Partial<DatasetJoinNode>) =>
    onChange({ ...src, joins: src.joins.map((j) => (j.id === id ? { ...j, ...next } : j)) });

  const pickBase = (table: string) => {
    setPop(null);
    void loadColumns(table);
    onChange({ ...src, base: { ...src.base, table } });
  };

  /** 加一张表:先猜它挂到哪张已有的表上、按哪两个字段对上。等列读回来再按「那一刻」的来源加。 */
  const addJoin = async (table: string) => {
    setPop(null);
    const fields = await loadColumns(table);
    const known = await Promise.all(existing.map(async (t) => ({ ...t, fields: await loadColumns(t.table) })));
    const guess = guessJoinAcross(table, fields, known);
    let id = "";
    onChange((prev) => {
      if (prev.kind !== "join" || prev.joins.some((j) => j.table === table)) return prev;
      const taken = new Set([prev.base.alias, ...prev.joins.map((j) => j.alias)]);
      let n = prev.joins.length + 2;
      while (taken.has(`t${n}`)) n += 1;
      id = `join-${Math.random().toString(36).slice(2, 8)}`;
      const join: DatasetJoinNode = {
        id, table, alias: `t${n}`, kind: "left",
        on: [{ field: guess?.field ?? "", targetAlias: guess?.targetAlias ?? prev.base.alias, targetField: guess?.targetField ?? "" }],
      };
      return { ...prev, joins: [...prev.joins, join] };
    });
    setNote(guess ? `「${table}」已按 ${guess.reason} 关联 —— 不对就点中间那颗胶囊改` : `「${table}」和已有的表没有看起来能对上的字段,点中间那颗胶囊选一下`);
    // 猜不出来就直接把关联设置打开,省一次点击
    if (!guess) requestAnimationFrame(() => {
      const chip = document.querySelector<HTMLElement>(`[data-join="${id}"]`);
      if (chip) setPop({ kind: "join", id, anchor: chip });
    });
  };

  /** 删一张表:挂在它身上的表也跟着去掉(不然关联条件引用不到) */
  const removeJoin = (id: string) => {
    setPop(null);
    const gone = new Set<string>();
    const target = src.joins.find((j) => j.id === id);
    if (target) gone.add(target.alias);
    let changed = true;
    while (changed) {
      changed = false;
      for (const j of src.joins) if (!gone.has(j.alias) && j.on.some((c) => gone.has(c.targetAlias))) { gone.add(j.alias); changed = true; }
    }
    onChange({ ...src, joins: src.joins.filter((j) => !gone.has(j.alias)) });
    setNote(gone.size > 1 ? `挂在「${target?.table}」上的 ${gone.size - 1} 张表也一起去掉了` : "");
  };

  const card = (alias: string, table: string, base: boolean) => {
    const n = fieldCount(alias);
    return (
      <div className={`dst-table ${base ? "base" : ""} ${table ? "" : "empty"}`}>
        <button type="button" className="dst-table-main" title={comment(table) ?? table}
          onClick={(e) => (base ? setPop({ kind: "base", anchor: e.currentTarget }) : undefined)}>
          {base ? <Database size={13} /> : <Table2 size={13} />}
          <span className="dst-table-name">{table || "选一张主表"}</span>
          {table && <small>{n.kept}/{n.total} 列</small>}
        </button>
        {!base && <button type="button" className="dst-table-x" title={`去掉「${table}」`} onClick={() => removeJoin(src.joins.find((j) => j.alias === alias)!.id)}><X size={12} /></button>}
      </div>
    );
  };

  const joinSummary = (join: DatasetJoinNode) => {
    const ready = join.on.filter((c) => c.field && c.targetField);
    if (!ready.length) return <span className="dst-join-warn">没设关联字段</span>;
    const c = ready[0];
    return <>{c.targetField} {c.op && c.op !== "=" ? c.op : "="} {c.field}{ready.length > 1 ? ` +${ready.length - 1}` : ""}</>;
  };

  const editing = pop?.kind === "join" ? src.joins.find((j) => j.id === pop.id) : undefined;

  return (
    <section className="dst-source">
      <div className="dst-source-head"><b>数据从哪来</b>{modeSwitch}</div>
      <div className="dst-flow">
        {card(src.base.alias, src.base.table, true)}
        {src.joins.map((join) => {
          const from = join.on[0]?.targetAlias;
          const hangs = from && from !== src.base.alias;
          return (
            <div className="dst-link" key={join.id}>
              <button type="button" data-join={join.id} className={`dst-join ${join.kind} ${pop?.id === join.id ? "on" : ""}`} title={KIND_HINT[join.kind]}
                onClick={(e) => setPop(pop?.id === join.id ? null : { kind: "join", id: join.id, anchor: e.currentTarget })}>
                <span className="dst-join-kind">{KIND_LABEL[join.kind]}</span>
                <span className="dst-join-on">{hangs && <em>{tableOf(from)}.</em>}{joinSummary(join)}</span>
                <ArrowRight size={12} />
              </button>
              {card(join.alias, join.table, false)}
            </div>
          );
        })}
        {src.base.table && (
          <button type="button" className={`dst-add ${pop?.kind === "add" ? "on" : ""}`} onClick={(e) => setPop({ kind: "add", anchor: e.currentTarget })}>
            <Plus size={13} />关联表
          </button>
        )}
        {src.base.table && recommended.slice(0, 3).map((r) => (
          <button type="button" key={r.table} className="dst-rec" title={`按 ${r.via} 关联`} onClick={() => void addJoin(r.table)}>
            <Sparkles size={11} />{r.table}
          </button>
        ))}
      </div>
      {note && <p className="dst-note">{note}</p>}

      {pop?.kind === "base" && (
        <Pop anchor={pop.anchor} width={320} onClose={() => setPop(null)}>
          <TablePicker tables={tables} used={new Set(src.joins.map((j) => j.table))} recommended={[]} onPick={pickBase} />
        </Pop>
      )}
      {pop?.kind === "add" && (
        <Pop anchor={pop.anchor} width={320} onClose={() => setPop(null)}>
          <TablePicker tables={tables} used={used} recommended={recommended} onPick={(t) => void addJoin(t)} />
        </Pop>
      )}
      {editing && pop && (
        <Pop anchor={pop.anchor} width={440} onClose={() => setPop(null)}>
          <JoinEditor join={editing} src={src} columns={columns} onChange={(next) => setJoin(editing.id, next)} onRemove={() => removeJoin(editing.id)} />
        </Pop>
      )}
      {confirmDialog}
    </section>
  );
}

/** 一条关联的设置:连接方式 + 一行行「哪个字段对哪个字段」。 */
function JoinEditor({ join, src, columns, onChange, onRemove }: {
  join: DatasetJoinNode;
  src: DatasetSourceJoin;
  columns: Record<string, string[]>;
  onChange: (next: Partial<DatasetJoinNode>) => void;
  onRemove: () => void;
}) {
  const index = src.joins.findIndex((j) => j.id === join.id);
  // 只能对上它前面的表(主表 + 排在它前面的关联表)
  const before = [{ alias: src.base.alias, table: src.base.table }, ...src.joins.slice(0, index).map((j) => ({ alias: j.alias, table: j.table }))];
  const setCond = (i: number, next: Partial<DatasetJoinCond>) => onChange({ on: join.on.map((c, j) => (j === i ? { ...c, ...next } : c)) });
  return (
    <div className="dst-joined">
      <div className="st-pm-title"><Table2 size={13} />{join.table}</div>
      <Seg size="sm" value={join.kind} onChange={(kind) => onChange({ kind })}
        options={(Object.keys(KIND_LABEL) as DatasetJoinKind[]).map((k) => ({ value: k, label: KIND_LABEL[k], title: KIND_HINT[k] }))} />
      <p className="st-hint">{KIND_HINT[join.kind]}</p>
      <div className="dst-conds">
        {join.on.map((cond, i) => (
          <div className="dst-cond" key={i}>
            {i > 0 ? (
              <select className="st-mini-sel dst-conn" value={cond.connector ?? "and"} onChange={(e) => setCond(i, { connector: e.target.value as "and" | "or" })}>
                <option value="and">并且</option><option value="or">或者</option>
              </select>
            ) : <span className="dst-conn-label">按</span>}
            <select className="st-mini-sel" value={cond.targetField ? `${cond.targetAlias}\u0000${cond.targetField}` : ""}
              onChange={(e) => { const [targetAlias, targetField] = e.target.value.split("\u0000"); setCond(i, { targetAlias, targetField }); }}>
              <option value="">选左边的字段</option>
              {before.map((t) => (
                <optgroup key={t.alias} label={t.table}>
                  {(columns[t.table] ?? []).map((c) => <option key={c} value={`${t.alias}\u0000${c}`}>{c}</option>)}
                </optgroup>
              ))}
            </select>
            <select className="st-mini-sel dst-op" value={cond.op ?? "="} onChange={(e) => setCond(i, { op: e.target.value as DatasetJoinCond["op"] })}>
              {JOIN_OPS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <select className="st-mini-sel" value={cond.field} onChange={(e) => setCond(i, { field: e.target.value })}>
              <option value="">选 {join.table} 的字段</option>
              {(columns[join.table] ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {join.on.length > 1 && <button type="button" className="icon-btn" aria-label="去掉这个条件" onClick={() => onChange({ on: join.on.filter((_, j) => j !== i) })}><X size={12} /></button>}
          </div>
        ))}
      </div>
      <button type="button" className="st-link" title="比如按门店 + 日期一起对"
        onClick={() => onChange({ on: [...join.on, { field: "", targetAlias: join.on[0]?.targetAlias ?? src.base.alias, targetField: "", connector: "and" }] })}>
        <Plus size={12} />再加一个对应条件
      </button>
      <div className="st-pm-sep" />
      <MenuItem icon={<Trash2 size={13} />} danger onClick={onRemove}>去掉这张表</MenuItem>
    </div>
  );
}
