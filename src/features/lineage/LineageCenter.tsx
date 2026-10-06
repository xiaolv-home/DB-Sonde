import { useScheduler } from "../scheduler/schedulerStore";
import { useEffect, useMemo, useState } from "react";
import {
  GitBranch,
  Loader2,
  Search,
  Table2,
  FileText,
  Gauge,
  LayoutDashboard,
  ArrowUp,
  ArrowDown,
  Eraser,
  ScanLine,
  Braces,
  RefreshCw,
  Activity,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  Trash2,
  PenTool,
} from "lucide-react";
import { useLineage, buildGraph, nodeLabelOf, tableId, type Graph, type NodeKind } from "./lineageStore";
import { useOps, type HealthState, type NodeHealth } from "./opsStore";
import { useAi } from "../ai/aiStore";
import { buildInspectionBriefing } from "../ai/context";
import LineageGraph from "./LineageGraph";
import { useMetrics } from "../metrics/metricsStore";
import { useEtl } from "../etl/etlStore";
import { useApp } from "../../store/appStore";
import { relevantUpstream } from "./columnFocus";
import AssetShell from "../assets/AssetShell";
import "./lineage.css";

const KIND_ICON: Record<NodeKind, typeof Table2> = { table: Table2, file: FileText, metric: Gauge, dataset: LayoutDashboard, task: Activity, workflow: GitBranch };

/** 资产类型分组 —— 默认只看业务对象。作业/脚本是实现细节,要看再打开。 */
const KIND_GROUPS: { kind: NodeKind; label: string; business: boolean }[] = [
  { kind: "table", label: "表", business: true },
  { kind: "metric", label: "指标", business: true },
  { kind: "dataset", label: "看板", business: true },
  { kind: "task", label: "作业", business: false },
  { kind: "workflow", label: "工作流", business: false },
  { kind: "file", label: "脚本文件", business: false },
];
const DEFAULT_KINDS = Object.fromEntries(KIND_GROUPS.map((g) => [g.kind, g.business])) as Record<NodeKind, boolean>;

/** 表节点显示成「表名 + 小字库名」,别把 db.table 整串糊在一起。 */
function NodeLabel({ node }: { node: { id: string; label: string; kind: NodeKind } }) {
  if (node.kind !== "table") return <span className="lin-node-lbl">{node.label}</span>;
  const dot = node.label.indexOf(".");
  if (dot < 0) return <span className="lin-node-lbl">{node.label}</span>;
  return (
    <span className="lin-node-lbl">
      {node.label.slice(dot + 1)}<small className="lin-node-db">{node.label.slice(0, dot)}</small>
    </span>
  );
}

/**
 * 直接邻居(一跳)。原来是无限递归展开成一棵树 —— 深了以后缩进爆炸、文字被截断,
 * 根本没法读。血缘该是「一次看一跳,点着往下走」,而不是一屏塞下整条链路。
 */
function Neighbors({
  id, graph, dir, onPick,
}: { id: string; graph: Graph; dir: "up" | "down"; onPick: (id: string) => void }) {
  const edges = (dir === "up" ? graph.up.get(id) : graph.down.get(id)) ?? [];
  const ids = [...new Set(edges.map((e) => (dir === "up" ? e.from : e.to)))];
  const nodes = ids.map((n) => graph.nodes.find((x) => x.id === n) ?? { id: n, label: nodeLabelOf(n), kind: "table" as NodeKind });
  const business = nodes.filter((n) => n.kind === "table" || n.kind === "metric" || n.kind === "dataset");
  const technical = nodes.filter((n) => !business.includes(n));
  if (nodes.length === 0) return <div className="lin-none">{dir === "up" ? "没有上游(源头 / 未扫描到)。" : "没有下游(末端 / 未扫描到)。"}</div>;
  return (
    <div className="lin-neighbors">
      {business.map((n) => {
        const Icon = KIND_ICON[n.kind];
        return (
          <button key={n.id} className="lin-nb" title={n.id} onClick={() => onPick(n.id)}>
            <Icon size={12} className={`lin-ic ${n.kind}`} />
            <NodeLabel node={n} />
          </button>
        );
      })}
      {technical.length > 0 && (
        <details className="lin-tech">
          <summary>作业 / 脚本 {technical.length}</summary>
          <div className="lin-neighbors">
            {technical.map((n) => {
              const Icon = KIND_ICON[n.kind];
              return (
                <button key={n.id} className="lin-nb tech" title={n.id} onClick={() => onPick(n.id)}>
                  <Icon size={12} className={`lin-ic ${n.kind}`} />
                  <span className="lin-node-lbl">{n.label}</span>
                </button>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}

const HSTATE: Record<HealthState, { label: string; cls: string }> = {
  ok: { label: "成功", cls: "ok" },
  error: { label: "失败", cls: "err" },
  running: { label: "运行中", cls: "run" },
  warn: { label: "暂停/停止", cls: "warn" },
  unknown: { label: "未知", cls: "unk" },
};

function HealthDot({ h }: { h?: NodeHealth }) {
  if (!h || h.state === "unknown") return null;
  return <span className={`lin-hdot ${HSTATE[h.state].cls}`} title={`状态:${HSTATE[h.state].label}${h.lastRun ? " · " + h.lastRun : ""}`} />;
}

/** 运行 & 巡检 card in the node detail. */
/**
 * 「这张表已经没了」—— 把一个节点从血缘里摘干净。
 *
 * 场景:线上把某张表和它的 ETL 作业下线了,可血缘里还挂着它 —— 巡检天天报
 * 「有上下游却缺少调度信息」,图上还画着一条通往空气的线。
 *
 * 为什么不用「清空扫描结果」:那是把视图血缘、SQL 解析血缘、指标血缘一起清掉,
 * 然后你得连上服务器重扫一遍。这里只摘一个节点。
 *
 * 顺序有讲究:**作业不删,血缘边删了也会长回来** —— 下次扫描 ETL 又会照着作业
 * 清单把这条边画回去。所以先列出还在产它的作业,让用户一并摘掉。
 */
function GoneCard({ id, label, graph }: { id: string; label: string; graph: Graph }) {
  const sources = useEtl((s) => s.sources);
  const [open, setOpen] = useState(false);

  // 还有哪些 ETL 作业声称在产这张表 —— 它们是"删了又长回来"的根
  const producers = useMemo(
    () =>
      sources.flatMap((src) =>
        src.jobs
          .filter((job) => job.targets.some((t) => tableId(t.database, t.table) === id))
          .map((job) => ({ srcId: src.id, srcName: src.name, job })),
      ),
    [sources, id],
  );
  // 指标口径里写着这张表的,改不了 —— 只能提醒人去指标中心改 SQL
  const metricRefs = (graph.down.get(id) ?? []).filter((e) => e.to.startsWith("metric:"));

  if (!open) {
    return (
      <div className="lin-gone-toggle">
        <button className="btn sm ghost" onClick={() => setOpen(true)}>
          <Trash2 size={13} /> 这张表已经不存在了?
        </button>
      </div>
    );
  }

  return (
    <div className="lin-gone">
      <div className="lin-gone-head">
        <AlertTriangle size={13} /> 把「{label}」从血缘里摘掉
      </div>
      {producers.length > 0 && (
        <div className="lin-gone-block">
          <div className="lin-gone-label">
            先删作业 —— 否则下次「从 ETL 作业扫描」会把这条边画回来:
          </div>
          {producers.map(({ srcId, srcName, job }) => (
            <div key={`${srcId}:${job.id}`} className="lin-gone-job">
              <span className="lin-gone-jobname">{srcName} / {job.name}</span>
              <button
                className="btn xs danger"
                onClick={() => useEtl.getState().removeJob(srcId, job.id)}
                title="只从 Sonde 的作业清单里移除,不碰服务器上的任何文件"
              >
                移除作业
              </button>
            </div>
          ))}
        </div>
      )}
      {metricRefs.length > 0 && (
        <div className="lin-gone-warn">
          还有 {metricRefs.length} 个指标的口径写着这张表({metricRefs.slice(0, 3).map((e) => nodeLabelOf(e.to)).join("、")}
          {metricRefs.length > 3 ? " 等" : ""})。这里摘不掉 —— 得去指标中心把它们改挂到新表上,
          否则指标查出来是空的。
        </div>
      )}
      <div className="lin-gone-actions">
        <button
          className="btn sm danger"
          onClick={() => { useLineage.getState().forgetNode(id); }}
        >
          <Trash2 size={13} /> 摘掉这个节点
        </button>
        <button className="btn sm ghost" onClick={() => setOpen(false)}>取消</button>
      </div>
      <div className="lin-gone-hint">
        只清掉扫描出来的边和它的运行状态,别的血缘不动。误删了重扫一次就回来。
      </div>
    </div>
  );
}

function RunCard({ nodeId, label }: { nodeId: string; label: string }) {
  const ops = useOps((s) => s.ops[nodeId]);
  const health = useOps((s) => s.health[nodeId]);
  const setManual = useOps((s) => s.setManual);
  const clearNode = useOps((s) => s.clearNode);
  const originLabel = ops ? { scheduler: "调度中心", etl: "ETL 推断", manual: "手工" }[ops.origin] : null;
  return (
    <div className="lin-runcard">
      <div className="lin-runcard-head">
        <Activity size={13} /> 运行 & 巡检
        {originLabel && <span className="lin-origin">{originLabel}</span>}
        <button
          className="btn sm lin-ask"
          title="把这张表的血缘/调度/巡检/口径打包问 AI"
          onClick={() => useAi.getState().seedAsk(`${label} 这张表几点跑?最近跑成没成?上游有没有问题?谁在用它?口径是什么?`, nodeId)}
        >
          <Sparkles size={12} /> 问 AI
        </button>
      </div>
      <div className="lin-run-grid">
        <div className="lin-run-k"><Clock size={12} /> 几点跑</div>
        <div className="lin-run-v">
          {ops?.scheduleHuman || ops?.schedule ? (
            <>
              <b>{ops.scheduleHuman ?? ops.schedule}</b>
              {ops.scheduleHuman && ops.schedule && <code className="lin-cron">{ops.schedule}</code>}
              {ops.scheduled === false && <span className="lin-flag off">未启用</span>}
              {ops.online === false && <span className="lin-flag off">下线</span>}
            </>
          ) : (
            <span className="lin-dim">未知(同步调度 / ETL,或手工填写)</span>
          )}
        </div>

        <div className="lin-run-k">上次运行</div>
        <div className="lin-run-v">
          {health ? (
            <>
              <span className={`lin-hstate ${HSTATE[health.state].cls}`}>{HSTATE[health.state].label}</span>
              {health.lastRun && <span className="lin-dim">{health.lastRun}</span>}
              {health.duration && <span className="lin-dim">· {health.duration}</span>}
            </>
          ) : (
            <span className="lin-dim">无运行记录</span>
          )}
        </div>

        <div className="lin-run-k">是否重跑</div>
        <div className="lin-run-v">
          {health ? (
            health.rerun ? <span className="lin-flag warn">是(补数 / 重跑{health.retries ? ` · ${health.retries} 次` : ""})</span> : <span className="lin-dim">否</span>
          ) : (
            <span className="lin-dim">—</span>
          )}
        </div>
      </div>

      <div className="lin-run-manual">
        <label>负责人<input value={ops?.owner ?? ""} placeholder="谁维护这张表" onChange={(e) => setManual(nodeId, { owner: e.target.value })} /></label>
        <label>SLA<input value={ops?.sla ?? ""} placeholder="如 每日 10:00 前产出" onChange={(e) => setManual(nodeId, { sla: e.target.value })} /></label>
        <label className="lin-run-wide">手工「几点跑」<input value={ops?.origin === "manual" ? ops?.schedule ?? "" : ""} placeholder="cron 或人话,覆盖同步值" onChange={(e) => setManual(nodeId, { schedule: e.target.value })} /></label>
        <label className="lin-run-wide">运行记录最长间隔（小时，可选）
          <input type="number" min="1" step="1" value={ops?.freshnessHours ?? ""} placeholder="留空不按运行间隔告警"
            onChange={(e) => {
              const value = e.target.value;
              if (!value || Number(value) > 0) setManual(nodeId, { freshnessHours: value ? Number(value) : undefined });
            }} />
        </label>
        <label className="lin-run-wide">备注<input value={ops?.note ?? ""} placeholder="重跑策略 / 巡检约定…" onChange={(e) => setManual(nodeId, { note: e.target.value })} /></label>
      </div>
      {ops && (
        <button className="btn sm" title="清除这张表的运行/巡检信息" onClick={() => clearNode(nodeId)}>
          <Eraser size={12} /> 清除 {label} 的运行信息
        </button>
      )}
    </div>
  );
}

function InspectPanel({ onPick }: { onPick: (id: string) => void }) {
  const findings = useOps((s) => s.findings);
  const LEVEL = { error: { cls: "err", ic: AlertTriangle }, warn: { cls: "warn", ic: AlertTriangle }, info: { cls: "unk", ic: CheckCircle2 } } as const;
  return (
    <div className="lin-form lin-inspect">
      <div className="lin-inspect-head">
        <span>巡检发现 {findings.length ? `· ${findings.length} 条` : ""}</span>
        <button
          className="btn sm primary lin-ai-diag"
          title="把巡检结果 + 受影响表的血缘/调度/口径打包给 AI,出「今日异常摘要 + 补数顺序建议」"
          onClick={() => { useAi.getState().setFocusEntity(null); useAi.getState().seedAsk(buildInspectionBriefing()); }}
        >
          <Sparkles size={13} /> AI 诊断
        </button>
      </div>
      {findings.length === 0 ? (
        <div className="lin-inspect-ok"><CheckCircle2 size={14} /> 当前没有巡检发现。检查项：运行失败、上游失败、缺少调度，以及已设置的运行间隔阈值。</div>
      ) : (
        <div className="lin-inspect-list">
          {findings.map((f, i) => {
            const L = LEVEL[f.level];
            const I = L.ic;
            return (
              <div key={i} className={`lin-finding ${L.cls}`} onClick={() => onPick(f.nodeId)} title={f.nodeId}>
                <I size={13} />
                <span className="lin-finding-text">{f.text}</span>
                <span className="lin-finding-node">{nodeLabelOf(f.nodeId)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Recursive upstream/downstream tree with a cycle guard. */
function ViewScanForm({ onClose }: { onClose: () => void }) {
  const connections = useApp((s) => s.connections);
  const meta = useApp((s) => s.meta);
  const connected = connections.filter((c) => meta[c.id]);
  const [connId, setConnId] = useState(connected[0]?.id ?? "");
  const kind = meta[connId]?.kind;
  const [database, setDatabase] = useState(meta[connId]?.currentDatabase ?? "");
  const defSchema = kind === "postgres" ? "public" : kind === "sqlite" ? "main" : "";
  const [schema, setSchema] = useState(defSchema);
  const busy = useLineage((s) => s.busy === "view");
  return (
    <div className="lin-form">
      <div className="lin-form-row">
        <select className="input" value={connId} onChange={(e) => { setConnId(e.target.value); setDatabase(meta[e.target.value]?.currentDatabase ?? ""); }}>
          {connected.length === 0 && <option value="">没有已连接的连接</option>}
          {connected.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input className="input" value={database} placeholder="库" onChange={(e) => setDatabase(e.target.value)} />
        <input className="input" value={schema} placeholder="schema(可空)" onChange={(e) => setSchema(e.target.value)} />
        <button
          className="btn sm primary"
          disabled={!connId || busy}
          onClick={async () => { await useLineage.getState().scanViews(connId, database, schema); onClose(); }}
        >
          {busy ? <Loader2 size={13} className="spin" /> : <ScanLine size={13} />} 扫描视图
        </button>
      </div>
      <div className="lin-form-hint">解析该库所有视图的定义(sqlglot),得到 源表 → 视图 的血缘。</div>
    </div>
  );
}

function SqlScanForm({ onClose }: { onClose: () => void }) {
  const [sql, setSql] = useState("");
  const [dialect, setDialect] = useState("");
  const [target, setTarget] = useState("");
  const [result, setResult] = useState<{ target: string | null; sources: string[]; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="lin-form">
      <textarea className="input lin-sql" value={sql} spellCheck={false} placeholder="粘一段 SQL(视图定义 / INSERT…SELECT / 任意查询)" onChange={(e) => setSql(e.target.value)} />
      <div className="lin-form-row">
        <select className="input" value={dialect} onChange={(e) => setDialect(e.target.value)}>
          <option value="">方言自动</option>
          <option value="mysql">MySQL</option>
          <option value="postgres">PostgreSQL</option>
          <option value="oracle">Oracle</option>
          <option value="sqlite">SQLite</option>
          <option value="tsql">SQL Server</option>
          <option value="clickhouse">ClickHouse</option>
        </select>
        <input className="input" value={target} placeholder="目标表(可空,自动识别 CREATE/INSERT)" onChange={(e) => setTarget(e.target.value)} />
        <button
          className="btn sm primary"
          disabled={!sql.trim() || busy}
          onClick={async () => {
            setBusy(true);
            const r = await useLineage.getState().addSqlEdges(sql, dialect || undefined, target.trim() ? target.trim().toLowerCase() : null);
            setResult(r);
            setBusy(false);
          }}
        >
          {busy ? <Loader2 size={13} className="spin" /> : <Braces size={13} />} 解析
        </button>
      </div>
      {result && (
        <div className="lin-sql-result">
          {result.error ? (
            <span className="lin-err">{result.error}</span>
          ) : (
            <>
              <div>目标:<b>{result.target ?? "(未识别,填目标表后可入图)"}</b></div>
              <div>依赖源表:{result.sources.length ? result.sources.join("、") : "(无)"}</div>
              {result.target && <div className="lin-ok">已加入血缘图 ✓</div>}
            </>
          )}
        </div>
      )}
      <div className="lin-form-row" style={{ justifyContent: "flex-end" }}>
        <button className="btn sm" onClick={onClose}>关闭</button>
      </div>
    </div>
  );
}

/* 链路画布单独打包(画布库不小),打开血缘时在后台先加载好,点「画布」不用等。 */
type CanvasModule = typeof import("./canvas/CanvasEditor");
let canvasModule: CanvasModule | null = null;
let canvasLoading: Promise<CanvasModule> | null = null;
function preloadCanvas(): Promise<CanvasModule> {
  canvasLoading ??= import("./canvas/CanvasEditor").then((m) => (canvasModule = m));
  return canvasLoading;
}

export default function LineageCenter() {
  const open = useLineage((s) => s.open);
  const scanned = useLineage((s) => s.scanned);
  const etlSources = useEtl((s) => s.sources);
  const metrics = useMetrics(s=>s.metrics);
  const workflows=useScheduler(s=>s.workflows);
  const instances=useScheduler(s=>s.instances);
  const tasks=useScheduler(s=>s.recentTasks);
  const selected = useLineage((s) => s.selected);
  const busy = useLineage((s) => s.busy);
  const lastMsg = useLineage((s) => s.lastMsg);
  const [q, setQ] = useState("");
  const [kinds, setKinds] = useState<Record<NodeKind, boolean>>(DEFAULT_KINDS);
  const [panel, setPanel] = useState<"none" | "view" | "sql" | "inspect" | "tools">("none");
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [canvasMod, setCanvasMod] = useState<CanvasModule | null>(canvasModule);
  useEffect(() => { void preloadCanvas().then(setCanvasMod).catch(() => { canvasLoading = null; }); }, []);
  const openCanvas = () => {
    if (canvasMod) { setCanvasOpen(true); return; }
    void preloadCanvas().then((m) => { setCanvasMod(m); setCanvasOpen(true); })
      .catch((error) => { canvasLoading = null; useApp.getState().showToast({ kind: "error", text: `画布加载失败:${String(error)}` }); });
  };
  const [view, setView] = useState<"list" | "graph">("list");
  const [onlyRelevant, setOnlyRelevant] = useState(true);
  const health = useOps((s) => s.health);
  const findings = useOps((s) => s.findings);
  const syncMsg = useOps((s) => s.syncMsg);

  // graph rebuilds when scanned or ETL sources change
  /* 同 Entity360:buildGraph 内部走 useEtl / useMetrics 的 getState(),
     这两个依赖是有意的重算触发器,不是多余的。 */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const graph = useMemo(() => buildGraph(scanned), [scanned, etlSources, metrics]);
  // 「图」标签用同一套类型过滤:默认只画业务层(表/指标/看板)。
  // 安全性依据:etlEdges 除了 源表→作业→目标表,还额外加了 源表→目标表 的直连边,
  // 所以隐掉作业节点不会把表之间的链路切断。
  /* 指标聚焦时,ads 宽表的上游会把供应链 / 会员 / 巡检这些不相干的分支全拖进来 ——
     它们只是恰好写了同一张表的别的列。按列把上游收窄一下。 */
  const relevant = useMemo(
    () => (onlyRelevant && view === "graph" && selected ? relevantUpstream(graph, selected) : null),
    /* relevantUpstream 同样走 getState() 读 ETL 和指标。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, selected, onlyRelevant, view, etlSources, metrics],
  );
  const viewGraph = useMemo(() => {
    const keep = new Set(
      graph.nodes.filter((n) => kinds[n.kind] && (!relevant || relevant.has(n.id))).map((n) => n.id),
    );
    const edges = graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
    const up = new Map<string, typeof edges>();
    const down = new Map<string, typeof edges>();
    for (const e of edges) {
      /* push,别 set(k, [...已有的, e]) —— 那是每加一条边就把该节点已有的边整份抄一遍。
         血缘图里像维表这种中心节点度数很高,建邻接表就成了平方级,而这段每次渲染都跑。 */
      const into = up.get(e.to); if (into) into.push(e); else up.set(e.to, [e]);
      const from = down.get(e.from); if (from) from.push(e); else down.set(e.from, [e]);
    }
    return { nodes: graph.nodes.filter((n) => keep.has(n.id)), edges, up, down };
  }, [graph, kinds, relevant]);
  const schedulerId = useScheduler(s => s.activeId);
  const projectCode = useScheduler(s => s.projectCode);
  const dataLoading = useScheduler(s => s.dataLoading);
  const dataError = useScheduler(s => s.dataError);
  const schedulerStatus = useScheduler(s => s.activeId ? s.status[s.activeId] : undefined);
  useEffect(() => {
    if (!open) return;
    useOps.getState().syncFromEtl(graph);
    if (schedulerStatus === "connected" && projectCode && !dataLoading && !dataError) {
      useOps.getState().syncFromScheduler(graph);
    }
  }, [open, graph, workflows, instances, tasks, schedulerId, projectCode, schedulerStatus, dataLoading, dataError]);
  if (!open) return null;

  // 先按类型过滤(默认只留业务对象),再按搜索词过滤 —— 否则 1030 个节点里
  // 绝大多数是 .sh / .json / task,人根本找不到自己要的表。
  const term = q.trim().toLowerCase();
  const filtered = graph.nodes
    .filter((n) => kinds[n.kind])
    .filter((n) => !term || n.label.toLowerCase().includes(term));
  const kindCounts = graph.nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.kind] = (acc[n.kind] ?? 0) + 1;
    return acc;
  }, {});
  const sel = selected ? graph.nodes.find((n) => n.id === selected) : null;
  const upCount = selected ? (graph.up.get(selected)?.length ?? 0) : 0;
  const downCount = selected ? (graph.down.get(selected)?.length ?? 0) : 0;

  return (
    <AssetShell title="血缘" sub={`${graph.nodes.length} 个节点 · ${graph.edges.length} 条链路`}>

        {/* 工具条只留「每天真会用」的:巡检回答"今天什么坏了"。
            其余全是维护动作(扫描/解析/同步/清空),收进折叠面板,不占视觉。 */}
        <div className="lin-toolbar">
          <button className={`btn sm ${panel === "inspect" ? "primary" : ""}`} onClick={() => { useOps.getState().inspect(graph); setPanel(panel === "inspect" ? "none" : "inspect"); }}>
            <Activity size={13} /> 巡检{findings.length ? `(${findings.length})` : ""}
          </button>
          <button className={`btn sm ${panel === "tools" ? "on" : ""}`} onClick={() => setPanel(panel === "tools" ? "none" : "tools")} title="扫描血缘、同步运行状态等维护动作">
            <ScanLine size={13} /> 扫描 · 维护
          </button>
          <button className="btn sm" onClick={openCanvas} title="自己画链路:摆表、作业、指标,连线、分组、配颜色">
            <PenTool size={13} /> 链路画布
          </button>
          <div className="toolbar-spacer" />
          {(syncMsg || lastMsg) && <span className="lin-msg">{syncMsg ?? lastMsg}</span>}
        </div>
        {panel === "tools" && (
          <div className="lin-form lin-tools">
            <div className="lin-form-hint">这些是「把血缘建起来 / 刷新状态」的维护动作,平时不用天天点。</div>
            <div className="lin-form-row">
              <button className="btn sm" disabled={busy === "etl"} onClick={() => useLineage.getState().scanEtl()} title="解析 ETL 作业里 querySql 的真实源表">
                {busy === "etl" ? <Loader2 size={13} className="spin" /> : <ScanLine size={13} />} 从 ETL 作业扫描
              </button>
              <button className="btn sm" disabled={busy === "metric"} onClick={() => useLineage.getState().scanMetrics()} title="从指标中心的口径解析出「表 → 指标」">
                {busy === "metric" ? <Loader2 size={13} className="spin" /> : <Gauge size={13} />} 从指标扫描
              </button>
              <button className="btn sm" onClick={() => setPanel("view")} title="解析库里所有视图定义,得到 源表 → 视图">
                <ScanLine size={13} /> 从视图扫描
              </button>
              <button className="btn sm" onClick={() => setPanel("sql")} title="粘一段 SQL,解析出它读了谁、写了谁">
                <Braces size={13} /> 解析一段 SQL
              </button>
              <button className="btn sm" title="把调度里的「几点跑 / 上次运行成功没」贴到表上" onClick={() => { useOps.getState().syncFromScheduler(graph); useOps.getState().syncFromEtl(graph); }}>
                <RefreshCw size={13} /> 同步运行状态
              </button>
              <div className="toolbar-spacer" />
              <button className="btn sm" title="清空扫描出的边(ETL 边保留)" onClick={() => useLineage.getState().clearScanned()}>
                <Eraser size={13} /> 清空扫描结果
              </button>
            </div>
          </div>
        )}
        {panel === "view" && <ViewScanForm onClose={() => setPanel("none")} />}
        {panel === "sql" && <SqlScanForm onClose={() => setPanel("none")} />}
        {panel === "inspect" && <InspectPanel onPick={(id) => useLineage.getState().select(id)} />}
        {canvasOpen && canvasMod && <canvasMod.default graph={graph} onClose={() => setCanvasOpen(false)} />}

        <div className="lin-body">
          <aside className="lin-rail">
            <div className="lin-search">
              <Search size={13} />
              <input value={q} placeholder="搜索表 / 视图 / 指标…" onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="lin-kinds">
              {KIND_GROUPS.filter((g) => (kindCounts[g.kind] ?? 0) > 0).map((g) => (
                <button
                  key={g.kind}
                  className={`lin-kind ${kinds[g.kind] ? "on" : ""}`}
                  title={g.business ? "业务对象" : "实现细节,默认不显示"}
                  onClick={() => setKinds((c) => ({ ...c, [g.kind]: !c[g.kind] }))}
                >
                  {g.label}<small>{kindCounts[g.kind]}</small>
                </button>
              ))}
            </div>
            <div className="lin-nodes">
              {graph.nodes.length === 0 ? (
                <div className="lin-empty">还没有血缘。先在 ETL 中心接入 DataX,或点上面「扫描视图 / 指标血缘」。</div>
              ) : filtered.length === 0 ? (
                <div className="lin-empty">这些类型下没有匹配的资产。换个词,或在上面打开「作业 / 脚本文件」。</div>
              ) : (
                filtered.map((n) => {
                  const Icon = KIND_ICON[n.kind];
                  return (
                    <div
                      key={n.id}
                      className={`lin-node-item ${selected === n.id ? "on" : ""}`}
                      onClick={() => useLineage.getState().select(n.id)}
                      title={n.id}
                    >
                      <Icon size={13} className={`lin-ic ${n.kind}`} />
                      <NodeLabel node={n} />
                      <HealthDot h={health[n.id]} />
                    </div>
                  );
                })
              )}
            </div>
          </aside>

          <main className="lin-main">
            <div className="lin-viewtabs">
              <button className={view === "list" ? "on" : ""} onClick={() => setView("list")}>列表</button>
              <button className={view === "graph" ? "on" : ""} onClick={() => setView("graph")}>图</button>
              <div className="toolbar-spacer" />
              {view === "graph" && selected?.startsWith("metric:") && (
                <label className="lin-relevant" title="ads 宽表由十几个作业各灌几列。只留这个指标真正读到的那几列的上游,其余分支(供应链 / 会员 / 巡检…)收起来。">
                  <input type="checkbox" checked={onlyRelevant} onChange={(e) => setOnlyRelevant(e.target.checked)} />
                  只看这个指标用到的链路
                </label>
              )}
            </div>
            {view === "graph" ? (
              <LineageGraph graph={viewGraph} focusId={selected} onSelect={(id) => useLineage.getState().select(id)} health={health} />
            ) : !sel ? (
              <div className="lin-hint">
                <GitBranch size={30} />
                <p>左边选一个节点,看它的上游依赖和下游影响。「图」标签看整张血缘图。</p>
                <p className="dim">节点/边来自:ETL 中心(源→目标)、视图定义、指标口径、你粘的 SQL —— sqlglot 解析。</p>
              </div>
            ) : (
              <div className="lin-detail">
                <div className="lin-detail-head">
                  {(() => { const I = KIND_ICON[sel.kind]; return <I size={16} className={`lin-ic ${sel.kind}`} />; })()}
                  <span className="lin-detail-name">{sel.label}</span>
                  <span className="lin-detail-meta">上游 {upCount} · 下游 {downCount}</span>
                </div>
                <div className="lin-cols">
                  <section>
                    <div className="lin-col-head"><ArrowUp size={13} /> 上游(它依赖谁)</div>
                    {upCount === 0 ? <div className="lin-none">没有上游(源头 / 未扫描到)。</div> : (
                      <Neighbors id={sel.id} graph={graph} dir="up" onPick={(id) => useLineage.getState().select(id)} />
                    )}
                  </section>
                  <section>
                    <div className="lin-col-head"><ArrowDown size={13} /> 下游 / 影响(谁依赖它)</div>
                    {downCount === 0 ? <div className="lin-none">没有下游(末端 / 未扫描到)。</div> : (
                      <Neighbors id={sel.id} graph={graph} dir="down" onPick={(id) => useLineage.getState().select(id)} />
                    )}
                  </section>
                </div>
                {["table", "task", "workflow"].includes(sel.kind) && <RunCard nodeId={sel.id} label={sel.label} />}
                {sel.kind === "table" && <GoneCard id={sel.id} label={sel.label} graph={graph} />}
              </div>
            )}
          </main>
        </div>
    </AssetShell>
  );
}
