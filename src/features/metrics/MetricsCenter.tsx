import { catalogIdOf, metricCatalogs } from "./catalogModel";
import { importCatalogFile, type ImportOutcome } from "./importCatalog";
import { checkMetrics, type HealthReport } from "./metricHealth";
import { useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { sql } from "@codemirror/lang-sql";
import { syntaxHighlighting } from "@codemirror/language";
import {
  Plus,
  Gauge,
  Play,
  Save,
  Trash2,
  Loader2,
  SquareTerminal,
  Copy,
  Sparkles,
} from "lucide-react";
import { useMetrics, type Metric, type MetricType } from "./metricsStore";
import { defaultMetricScope, planSourceTables } from "./queryPlan";
import { compileMetric } from "./metricSql";
import { editorTheme, highlight } from "../../components/SqlEditor";
import { useApp } from "../../store/appStore";
import { useAi } from "../ai/aiStore";
import { api } from "../../lib/api";
import type { QueryResult } from "../../types";
import AssetShell from "../assets/AssetShell";
import "./metrics.css";

const TYPES: { v: MetricType; label: string; hint: string }[] = [
  { v: "template", label: "语义查询", hint: "导入的计算定义，按日期及维度查询" },
  { v: "measure", label: "度量", hint: "基表上的一个聚合,如 sum(amount)" },
  { v: "ratio", label: "比率", hint: "分子 ÷ 分母,如 好评率" },
  { v: "derived", label: "派生", hint: "由另外两个指标相除" },
  { v: "sql", label: "SQL", hint: "一段完整 SELECT(兜底)" },
];

const splitList = (s: string) => s.split(/[,,、\s]+/).map((x) => x.trim()).filter(Boolean);

function MetricEditor({ metric }: { metric: Metric }) {
  const connections = useApp((s) => s.connections);
  const meta = useApp((s) => s.meta);
  const allMetrics = useMetrics((s) => s.metrics);
  const [m, setM] = useState<Metric>(metric);
  const [preview, setPreview] = useState<{ loading: boolean; error?: string; result?: QueryResult } | null>(null);
  const [prevDim, setPrevDim] = useState("");
  const [scope, setScope] = useState(defaultMetricScope);
  const set = (patch: Partial<Metric>) => setM((prev) => ({ ...prev, ...patch }));

  // reset local state when a different metric is opened
  const key = metric.id || "new";
  const [seenKey, setSeenKey] = useState(key);
  if (seenKey !== key) {
    setSeenKey(key);
    setM(metric);
    setPreview(null);
    setPrevDim("");
  }

  const connected = !!meta[m.connId];
  const extensions = useMemo(() => [sql(), editorTheme, syntaxHighlighting(highlight)], []);
  const lookup = (id: string) => allMetrics.find((x) => x.id === id);
  const compiled = compileMetric(m, { dimension: prevDim || undefined, limit: 50, scope, dialect: connections.find(c => c.id === m.connId)?.kind }, lookup);
  const typeValid =
    m.type === "template" ? !!m.queryPlan : m.type === "sql"
      ? !!m.sql?.trim()
      : m.type === "measure"
        ? !!(m.source && m.expression)
        : m.type === "ratio"
          ? !!(m.source && m.numerator && m.denominator)
          : !!(m.numeratorMetricId && m.denominatorMetricId);
  const canSave = !!m.name.trim() && !!m.connId && typeValid;
  const dimOptions = m.dimensions ?? [];
  // metrics usable as derived num/den (same conn, not self, not derived)
  const refMetrics = allMetrics.filter((x) => x.connId === m.connId && x.id !== m.id && x.type !== "derived");

  const run = async () => {
    if (!m.connId) return setPreview({ loading: false, error: "先选一个连接" });
    if (!connected) return setPreview({ loading: false, error: "该连接还没连上,先在左侧连接它再试运行" });
    if (compiled.error) return setPreview({ loading: false, error: compiled.error });
    setPreview({ loading: true });
    try {
      const result = await api.runReadOnlyQuery(m.connId, m.database || undefined, compiled.sql, 50, []);
      setPreview({ loading: false, result });
    } catch (e) {
      setPreview({ loading: false, error: String(e) });
    }
  };

  const save = () => {
    if (!canSave) return;
    useMetrics.getState().save(m);
    useApp.getState().showToast({ kind: "success", text: `指标「${m.name}」已保存` });
  };

  const useInQuery = () => {
    if (compiled.error) return;
    useApp.getState().openQueryTab({ connId: m.connId, database: m.database, sql: compiled.sql, title: m.name || "查询" });
    useMetrics.getState().setOpen(false);
  };

  const askAi = () => {
    const aliasStr = (m.aliases ?? []).length ? `(别名:${(m.aliases ?? []).join("、")})` : "";
    useAi.getState().seedAsk(
      `这是我的指标「${m.name}」${aliasStr},口径:${m.caliber || "(未填)"}。它编译成的 SQL:\n\`\`\`sql\n${compiled.sql || "(无法编译)"}\n\`\`\`\n基于这个口径,帮我分析最近的变化趋势并给出可执行的只读 SQL。`,
    );
    useMetrics.getState().setOpen(false);
  };

  const single = preview?.result && preview.result.columns.length === 1 && preview.result.rows.length === 1;
  const inp = (label: string, val: string, on: (v: string) => void, ph = "", mono = false) => (
    <label className="mc-field grow">
      <span>{label}</span>
      <input className={`input ${mono ? "mono" : ""}`} value={val} placeholder={ph} spellCheck={false} onChange={(e) => on(e.target.value)} />
    </label>
  );

  return (
    <div className="mc-editor">
      <div className="mc-form">
        <div className="mc-row2">
          {inp("指标名称", m.name, (v) => set({ name: v }), "如 销售额")}
          <label className="mc-field" style={{ maxWidth: 110 }}>
            <span>单位</span>
            <input className="input" value={m.unit} placeholder="元/单/%" onChange={(e) => set({ unit: e.target.value })} />
          </label>
        </div>

        <div className="mc-field">
          <span>类型</span>
          <div className="mc-type-tabs">
            {TYPES.filter(t => m.queryPlan ? t.v === "template" : t.v !== "template").map((t) => (
              <button key={t.v} className={m.type === t.v ? "on" : ""} onClick={() => set({ type: t.v })} title={t.hint}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="mc-type-hint">{TYPES.find((t) => t.v === m.type)?.hint}</div>
        </div>

        {/* 语义指标的口径藏在 queryPlan 的模板 SQL 里,界面上原来一个字都不露 ——
            于是「底表换没换成功」只能靠查数猜。把它摊开。 */}
        {m.type === "template" && m.queryPlan && (
          <div className="mc-field">
            <span>底表(从计算定义里解析)</span>
            <div className="mc-tables">
              {planSourceTables(m.queryPlan).map((t) => <code key={t}>{t}</code>)}
            </div>
          </div>
        )}
        {m.type === "template" && <div className="mc-row2">
          <label className="mc-field grow">开始日期<input className="input" type="date" value={scope.start} onChange={e => setScope({ ...scope, start: e.target.value })} /></label>
          <label className="mc-field grow">结束日期<input className="input" type="date" value={scope.end} onChange={e => setScope({ ...scope, end: e.target.value })} /></label>
        </div>}
        {/* type-specific fields */}
        {m.type === "measure" && (
          <div className="mc-row2">
            {inp("基表", m.source ?? "", (v) => set({ source: v }), "如 sales.orders", true)}
            {inp("聚合表达式", m.expression ?? "", (v) => set({ expression: v }), "sum(amount) / count(distinct id)", true)}
          </div>
        )}
        {m.type === "ratio" && (
          <>
            <div className="mc-row2">
              {inp("基表", m.source ?? "", (v) => set({ source: v }), "如 ads_outlet_daily", true)}
              <label className="mc-field" style={{ maxWidth: 110 }}>
                <span>×倍数</span>
                <input className="input" type="number" value={m.scale ?? ""} placeholder="100" onChange={(e) => set({ scale: e.target.value ? Number(e.target.value) : undefined })} />
              </label>
            </div>
            <div className="mc-row2">
              {inp("分子", m.numerator ?? "", (v) => set({ numerator: v }), "sum(good_cnt)", true)}
              {inp("分母", m.denominator ?? "", (v) => set({ denominator: v }), "sum(order_cnt)", true)}
            </div>
          </>
        )}
        {m.type === "derived" && (
          <div className="mc-row2">
            <label className="mc-field grow">
              <span>分子指标</span>
              <select className="input" value={m.numeratorMetricId ?? ""} onChange={(e) => set({ numeratorMetricId: e.target.value })}>
                <option value="">选指标…</option>
                {refMetrics.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
            <label className="mc-field grow">
              <span>分母指标</span>
              <select className="input" value={m.denominatorMetricId ?? ""} onChange={(e) => set({ denominatorMetricId: e.target.value })}>
                <option value="">选指标…</option>
                {refMetrics.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>
            </label>
            <label className="mc-field" style={{ maxWidth: 90 }}>
              <span>×倍数</span>
              <input className="input" type="number" value={m.scale ?? ""} placeholder="100" onChange={(e) => set({ scale: e.target.value ? Number(e.target.value) : undefined })} />
            </label>
          </div>
        )}
        {m.type === "sql" && (
          <div className="mc-field">
            <span>口径 SQL(完整 SELECT)</span>
            <div className="mc-sql">
              <CodeMirror value={m.sql ?? ""} theme="none" height="150px" extensions={extensions} onChange={(v) => set({ sql: v })} basicSetup={{ lineNumbers: true, foldGutter: false, autocompletion: false }} />
            </div>
          </div>
        )}

        <div className="mc-row2">
          <label className="mc-field grow">
            <span>连接</span>
            <select className="input" value={m.connId} onChange={(e) => { const c = connections.find((x) => x.id === e.target.value); set({ connId: e.target.value, connName: c?.name ?? "" }); }}>
              <option value="">选择连接…</option>
              {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {inp("数据库(可选)", m.database ?? "", (v) => set({ database: v }), "默认库")}
          {inp("分类", m.category, (v) => set({ category: v }), "销售/会员")}
        </div>

        {m.type !== "sql" && m.type !== "derived" && (
          <div className="mc-row2">
            {inp("维度(逗号分隔,可下钻/分组)", (m.dimensions ?? []).join(", "), (v) => set({ dimensions: splitList(v) }), "city, outlet_name, stat_date", true)}
            {inp("时间字段", m.timeField ?? "", (v) => set({ timeField: v }), "stat_date", true)}
          </div>
        )}
        <div className="mc-row2">
          {inp("标识 key", m.key, (v) => set({ key: v }), "gmv", true)}
          {inp("别名(AI 匹配用,逗号分隔)", (m.aliases ?? []).join(", "), (v) => set({ aliases: splitList(v) }), "销售额、GMV、流水")}
        </div>
        <label className="mc-field">
          <span>跨分组怎么合并<small>不填就按聚合表达式自动判断</small></span>
          <select className="input" value={m.rollup ?? ""} onChange={(e) => set({ rollup: (e.target.value || undefined) as typeof m.rollup })}>
            <option value="">自动判断</option>
            <option value="sum">求和 —— 各组加起来就是整体(金额、单量、网点有效天数)</option>
            <option value="avg">平均 —— 各组不能相加(比率、均价、达成率)</option>
            <option value="count_distinct">去重计数 —— 各组加起来会把同一个对象数好几遍</option>
            <option value="min">取最小</option>
            <option value="max">取最大</option>
          </select>
          <small className="mc-hint">
            「有效天数」这类要留意:按网点分组后各店天数<b>加起来</b>是网点有效天数(算日均时的分母),
            而不分组直接查出来的是日历天数 —— 两个都对,是两个不同的量,只有你知道要哪个。
          </small>
        </label>
        <label className="mc-field">
          <span>口径(这个数怎么算、含/不含什么 —— AI 会读)</span>
          <textarea className="input mc-desc" value={m.caliber} placeholder="所选周期内销售额大于 0 的去重自然日数量…" onChange={(e) => set({ caliber: e.target.value })} />
        </label>
      </div>

      <div className="mc-actions">
        <button className="btn primary" onClick={save} disabled={!canSave}><Save size={14} /> 保存</button>
        <button className="btn" onClick={run} disabled={!!compiled.error && m.type !== "sql"}>
          {preview?.loading ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 试运行
        </button>
        {dimOptions.length > 0 && (
          <select className="input mc-dimpick" value={prevDim} onChange={(e) => setPrevDim(e.target.value)} title="预览时按此维度分组">
            <option value="">不分组</option>
            {dimOptions.map((d) => <option key={d} value={d}>按 {d}</option>)}
          </select>
        )}
        <button className="btn" onClick={useInQuery} disabled={!m.connId || !!compiled.error}><SquareTerminal size={14} /> 用于查询</button>
        <button className="btn" onClick={() => navigator.clipboard?.writeText(compiled.sql)} title="复制编译出的 SQL"><Copy size={14} /> 复制 SQL</button>
        <button className="btn" onClick={askAi}><Sparkles size={14} /> 问 AI</button>
        <div className="toolbar-spacer" />
        {m.id && <button className="btn danger" onClick={() => useMetrics.getState().remove(m.id)}><Trash2 size={14} /> 删除</button>}
      </div>

      {compiled.sql && !compiled.error && (
        <div className="mc-compiled"><span className="cc-lbl">编译</span><code>{compiled.sql}</code></div>
      )}
      {compiled.error && <div className="mc-prev-state err">{compiled.error}</div>}

      {preview && (
        <div className="mc-preview">
          {preview.loading ? (
            <div className="mc-prev-state"><Loader2 size={15} className="spin" /> 运行中…</div>
          ) : preview.error ? (
            <div className="mc-prev-state err">{preview.error}</div>
          ) : single ? (
            <div className="mc-bignum">
              <span className="bn-val">{String(preview.result!.rows[0][0] ?? "—")}</span>
              {m.unit && <span className="bn-unit">{m.unit}</span>}
              <span className="bn-cap">{preview.result!.columns[0].name}</span>
            </div>
          ) : preview.result && preview.result.columns.length > 0 ? (
            <div className="mc-tablewrap">
              <table className="mc-table">
                <thead>
                  <tr>{preview.result.columns.map((c, i) => <th key={i}>{c.name}</th>)}</tr>
                </thead>
                <tbody>
                  {preview.result.rows.slice(0, 20).map((r, ri) => (
                    <tr key={ri}>{r.map((v, ci) => <td key={ci}>{v === null ? "NULL" : String(v)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              <div className="mc-prev-foot">{preview.result.rows.length} 行(最多显示 20)</div>
            </div>
          ) : (
            <div className="mc-prev-state">{preview.result?.message ?? "执行完成"}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** 导入结果 → 给用户看的一句话。
 *
 *  「一个没导进去」必须说成失败,不能报绿的。踩过:底表换了以后重新导一份口径,
 *  点的是「导入指标目录」(keep),12 个全是同标识的,于是全被跳过 —— 弹了个
 *  绿色的「跳过 12 个同标识的」,人看完以为导进去了,回头查数还是老表。
 *  真正没变的时候,得直接把该点哪个按钮写在脸上。 */
export function importSummary(outcome: ImportOutcome): { kind: "success" | "warn"; text: string } | null {
  const { added, replaced, skipped } = outcome;
  if (added + replaced + skipped === 0) return null; // 取消了选文件
  if (added === 0 && replaced === 0) {
    return {
      kind: "warn",
      text: `一个都没导进去 —— ${skipped} 个指标的标识在库里已经有了,按「保留原有」的规则全跳过了。`
        + `要用文件里的新口径顶掉它们(比如底表换了),请改点「导入并覆盖同名指标」。`,
    };
  }
  const parts = [added ? `新增 ${added} 个` : "", replaced ? `覆盖 ${replaced} 个` : "", skipped ? `跳过 ${skipped} 个同标识的` : ""];
  return { kind: "success", text: parts.filter(Boolean).join(",") };
}

/** 导入指标目录并如实汇报「新增 / 覆盖 / 跳过」各几个。 */
async function runImport(mode: "keep" | "replace") {
  try {
    const summary = importSummary(await importCatalogFile(mode));
    if (summary) useApp.getState().showToast(summary);
  } catch (e) {
    useApp.getState().showToast({ kind: "error", text: String(e) });
  }
}

/**
 * 「体检」按钮 + 结果面板。
 *
 * 底表没了,最先受害的是指标 —— 指标查出来是空的,人只会以为"这天没生意"。
 */
function MetricHealthButton({ metrics }: { metrics: Metric[] }) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<HealthReport | null>(null);

  const run = async () => {
    setBusy(true);
    try {
      setReport(await checkMetrics(metrics));
    } catch (e) {
      useApp.getState().showToast({ kind: "error", text: `体检失败:${String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="btn sm mc-new" disabled={busy} onClick={() => void run()}
              title="去库里逐张核对:口径写的底表还在不在、用到的字段还有没有">
        {busy ? "体检中…" : "指标体检"}
      </button>
      {report && (
        <div className={`mc-health ${report.unhealthy.length ? "bad" : "ok"}`}>
          <div className="mc-health-head">
            <span>
              查了 {report.checked} 个语义指标 · {report.tables} 张底表 ——{" "}
              {report.unhealthy.length ? `${report.unhealthy.length} 个有问题` : "全部正常"}
            </span>
            <button className="btn xs ghost" onClick={() => setReport(null)}>收起</button>
          </div>
          {report.unhealthy.map((h) => (
            <div key={h.metricId} className="mc-health-item">
              <b>{h.metricName}</b>
              {h.issues.map((i, n) => <div key={n} className="mc-health-issue">· {i.text}</div>)}
            </div>
          ))}
          {report.errors.map((e, n) => <div key={n} className="mc-health-err">查不动:{e}</div>)}
          {report.unhealthy.length > 0 && (
            <div className="mc-health-hint">
              「字段找不到」只比对了该指标自己声明的底表 —— 报出来的一定有问题,
              没报的不代表口径就对(列存在但含义变了,这里看不出来)。
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default function MetricsCenter() {
  const open = useMetrics((s) => s.open);
  const metrics = useMetrics((s) => s.metrics);
  const editing = useMetrics((s) => s.editing);
  const connections = useApp((s) => s.connections);
  const [selectedCatalogId, setSelectedCatalogId] = useState("");
  const catalogs = metricCatalogs(metrics);
  const catalogId = catalogs.some(catalog => catalog.id === selectedCatalogId) ? selectedCatalogId : catalogs[0]?.id ?? "";
  const catalogMetrics = metrics.filter(metric => catalogIdOf(metric) === catalogId);
  const boundConnections = new Set(catalogMetrics.map(metric => metric.connId));
  const boundConnection = boundConnections.size === 1 ? catalogMetrics[0]?.connId ?? "" : "";
  if (!open) return null;

  const groups = new Map<string, Metric[]>();
  for (const m of catalogMetrics) {
    const g = m.category || "未分类";
    { const bucket = groups.get(g); if (bucket) bucket.push(m); else groups.set(g, [m]); };
  }

  return (
    <AssetShell title="指标" sub="统一口径的指标库 · 看板、查询、AI 都能用">
        <div className="mc-row2" style={{ padding: "8px 16px" }}>
          <label>指标目录 <select className="input" value={catalogId} onChange={e => { setSelectedCatalogId(e.target.value); useMetrics.getState().cancel(); }}>
            {!catalogs.length && <option value="">暂无目录</option>}
            {catalogs.map(catalog => <option key={catalog.id} value={catalog.id}>{catalog.name}</option>)}
          </select></label>
          <label>此目录连接 <select className="input" disabled={!catalogMetrics.length} value={boundConnection} onChange={e => { const connection = connections.find(c => c.id === e.target.value); if (connection) useMetrics.getState().bindCatalog(catalogId, connection.id, connection.name); }}>
            <option value="">{boundConnections.size > 1 ? "多个连接（各指标独立绑定）" : "选择数据连接"}</option>{connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>
          <span className="dim">当前目录 {catalogMetrics.length} 个指标 · SQL 需适用于所选数据库</span>
        </div>
        <div className="mc-body">
          <aside className="mc-rail">
            <button className="btn primary sm mc-new" onClick={() => { const state = useMetrics.getState(); state.startNew(); const draft = useMetrics.getState().editing; if (draft && catalogId) state.edit({ ...draft, catalogId, catalogName: catalogs.find(c => c.id === catalogId)?.name }); }}>
              <Plus size={14} /> 新建指标
            </button>
            <button className="btn sm mc-new" onClick={()=>void runImport("keep")}>导入指标目录</button>
          {/* 底表换了要重挂口径时,得能用新定义顶掉同 id 的旧指标 —— 否则只能一个个删了再导 */}
          <button className="btn sm mc-new" title="同标识的指标用新定义覆盖,常用于底表变更后重挂口径" onClick={()=>void runImport("replace")}>导入并覆盖同名指标</button>
          {/* 底表被删、列改名这类事,指标定义本身语法照样正确,只有真去库里问一次才知道 */}
          <MetricHealthButton metrics={catalogMetrics} />
            <div className="mc-list">
              {metrics.length === 0 && <div className="mc-empty">还没有指标。点上面「新建指标」定义第一个口径。</div>}
              {[...groups.entries()].map(([cat, list]) => (
                <div className="mc-group" key={cat}>
                  <div className="mc-group-head">{cat}</div>
                  {list.map((m) => (
                    <div
                      key={m.id}
                      className={`mc-item ${editing?.id === m.id ? "on" : ""}`}
                      onClick={() => useMetrics.getState().edit(m)}
                    >
                      <span className="mc-item-name">{m.name}</span>
                      {m.unit && <span className="mc-item-unit">{m.unit}</span>}
                      <span className="mc-item-conn">{m.connName}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </aside>
          <main className="mc-main">
            {editing ? (
              <MetricEditor metric={editing} />
            ) : (
              <div className="mc-hint">
                <Gauge size={30} />
                <p>左侧选一个指标编辑,或「新建指标」。</p>
                <p className="dim">指标 = 一段有名字、有说明的口径 SQL。定义一次,看板 / 查询 / AI 都按同一口径来。</p>
              </div>
            )}
          </main>
        </div>
    </AssetShell>
  );
}
