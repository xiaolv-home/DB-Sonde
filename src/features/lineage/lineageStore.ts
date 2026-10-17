import { lineageEdges } from "./edgeRepository";
import { buildLineageGraph, dedup, mergeScannedEdges } from "./graphModel";
import { create } from "zustand";
import { api } from "../../lib/api";
import { useEtl } from "../etl/etlStore";
import { useMetrics } from "../metrics/metricsStore";
import { metricSourceTables } from "../metrics/metricSql";
import { useApp } from "../../store/appStore";
import { useOps } from "./opsStore";
import type { Endpoint } from "../etl/types";

export type { EdgeSource, GEdge, GNode, NodeKind, Graph } from "./lineageModel";
export { tableId, nodeKindOf, taskNodeId, workflowNodeId } from "./lineageModel";
import { norm, tableId, endpointId, labelForNode, type GEdge, type Graph } from "./lineageModel";

export function nodeLabelOf(id: string): string {
  return labelForNode(id, useMetrics.getState().metrics, useEtl.getState().sources.flatMap(source => source.jobs));
}

/** DB kind → sqlglot dialect. */
export function sqlglotDialect(kind?: string): string | undefined {
  switch (kind) {
    case "mysql":
    case "mariadb":
      return "mysql";
    case "postgres":
      return "postgres";
    case "oracle":
      return "oracle";
    case "sqlite":
      return "sqlite";
    default:
      return undefined;
  }
}

const usable = (e: Endpoint) => !!(e.table || e.path);

function endpointDialect(e: Endpoint): string | undefined {
  const s = (e.system ?? "").toLowerCase();
  if (s.includes("oracle")) return "oracle";
  if (s.includes("postgre")) return "postgres";
  if (s.includes("sqlite")) return "sqlite";
  return "mysql";
}

/** Compatibility facade: only this integration layer reads live feature state. */
export function buildGraph(scanned: GEdge[]): Graph {
  return buildLineageGraph(scanned, useEtl.getState().sources, useMetrics.getState().metrics);
}

interface LineageState {
  open: boolean;
  scanned: GEdge[];
  busy: string | null;
  lastMsg: string | null;
  selected: string | null;

  setOpen: (open: boolean) => void;
  /** 从本地存储重新读一遍扫描出的边(别的窗口重新扫描之后) */
  reload: () => void;
  select: (id: string | null) => void;
  clearScanned: () => void;
  /** 把一个节点从血缘里摘掉(表删了、作业下线了)。
   *  比「清空扫描结果」准得多 —— 那个会把视图血缘、SQL 解析血缘一起清掉,
   *  然后你得全部重扫一遍。 */
  forgetNode: (id: string) => void;
  scanEtl: () => Promise<void>;
  scanMetrics: () => Promise<void>;
  scanViews: (connId: string, database: string, schema: string) => Promise<void>;
  addSqlEdges: (sql: string, dialect: string | undefined, targetId: string | null) => Promise<{ target: string | null; sources: string[]; error?: string; }>;
  /** Register a BI dashboard dataset as a downstream node fed by the tables its
   *  SQL reads, then open lineage focused on it. Drives the BI → 血缘 drill. */
  focusDataset: (name: string, sql: string, dialect?: string) => Promise<{ sources: string[]; error?: string; }>;
}

export const useLineage = create<LineageState>((set, get) => ({
  open: false,
  scanned: lineageEdges.load(),
  busy: null,
  lastMsg: null,
  selected: null,

  setOpen: (open) => set({ open }),
  reload: () => set({ scanned: lineageEdges.load() }),
  select: (id) => set({ selected: id }),

  clearScanned: () => {
    try { lineageEdges.save([]); }
    catch (error) { set({ lastMsg: String(error) }); return; }
    set({ scanned: [], lastMsg: "已清空扫描出的边(ETL 边会自动保留)" });
  },

  forgetNode: (id) => {
    const before = get().scanned.length;
    const kept = get().scanned.filter((e) => e.from !== id && e.to !== id);
    try { lineageEdges.save(kept); }
    catch (error) { set({ lastMsg: String(error) }); return; }
    /* 运行状态/健康也要一起忘掉,否则巡检会一直把这个节点当成"该跑成功但没跑" */
    if (!useOps.getState().clearNode(id)) {
      set({ scanned: kept, lastMsg: `扫描血缘已移除，但运行记录清理失败：${useOps.getState().syncMsg}。请重试清理。` });
      return;
    }
    set({
      scanned: kept,
      selected: get().selected === id ? null : get().selected,
      lastMsg: before === kept.length
        ? `血缘里没有指向 ${nodeLabelOf(id)} 的扫描边(可能它的边来自 ETL 作业 —— 作业清掉后会自动消失)`
        : `已摘掉 ${nodeLabelOf(id)}:清掉 ${before - kept.length} 条扫描边和它的运行状态`,
    });
  },

  async scanEtl() {
    set({ busy: "etl", lastMsg: null });
    const sources = useEtl.getState().sources;
    const fresh: GEdge[] = [];
    let resolved = 0;
    let failed = 0;
    for (const src of sources) {
      for (const job of src.jobs) {
        const targets = job.targets.filter(usable).map(endpointId);
        if (targets.length === 0) continue;
        const srcIds: string[] = [];
        for (const s of job.sources) {
          if (usable(s)) {
            srcIds.push(endpointId(s));
          } else if (s.querySql) {
            try {
              const r = await api.pySqlLineage(s.querySql, endpointDialect(s));
              if (r.ok) {
                resolved++;
                for (const t of r.sources) srcIds.push(norm(t));
              } else { failed++; }
            } catch {
              failed++;
            }
          }
        }
        for (const from of new Set(srcIds)) for (const to of targets) fresh.push({ from, to, kind: "写入", source: "etl" });
      }
    }
    const next = mergeScannedEdges(get().scanned, fresh, "etl", failed === 0);
    try { lineageEdges.save(next); }
    catch (error) { set({ busy: null, lastMsg: String(error) }); return; }
    set({ scanned: next, busy: null, lastMsg: `ETL 血缘:解析 ${resolved} 段 querySql,得到 ${fresh.length} 条边${failed ? `；${failed} 段解析失败，保留上次血缘` : ""}` });
  },

  async scanMetrics() {
    set({ busy: "metric", lastMsg: null });
    const metrics = useMetrics.getState().metrics;
    const meta = useApp.getState().meta;
    const lookup = (id: string) => metrics.find((x) => x.id === id);
    const fresh: GEdge[] = [];
    let failed = 0;
    for (const m of metrics) {
      const to = `metric:${m.id}`;
      // typed metrics (measure/ratio/derived) declare their base table(s) — no parse needed
      const direct = metricSourceTables(m, lookup);
      for (const s of direct) fresh.push({ from: tableId(m.database, s), to, kind: "用于", source: "metric" });
      // full-SQL metrics still need sqlglot
      if (m.type === "sql" && m.sql) {
        try {
          const r = await api.pySqlLineage(m.sql, sqlglotDialect(meta[m.connId]?.kind));
          if (!r.ok) failed++;
          if (r.ok) for (const s of r.sources) fresh.push({ from: tableId(m.database, s), to, kind: "用于", source: "metric" });
        } catch {
          failed++;
        }
      }
    }
    const next = mergeScannedEdges(get().scanned, fresh, "metric", failed === 0);
    try { lineageEdges.save(next); }
    catch (error) { set({ busy: null, lastMsg: String(error) }); return; }
    set({ scanned: next, busy: null, lastMsg: `指标血缘:解析 ${metrics.length} 个指标,得到 ${fresh.length} 条边${failed ? `；${failed} 个指标解析失败，保留上次血缘` : ""}` });
  },

  async scanViews(connId, database, schema) {
    set({ busy: "view", lastMsg: null });
    const meta = useApp.getState().meta;
    const dialect = sqlglotDialect(meta[connId]?.kind);
    const fresh: GEdge[] = [];
    let views = 0;
    /* 解析不了的视图要数出来报给用户 —— 上面 scanMetrics 就是这么做的,这儿原来
       是 `catch { skip this view }` 一声不吭。血缘少一条边不是小事:用户看这张表
       没人用就把它下了,其实是解析失败没连上。宁可说"有 3 个没解析出来"。 */
    const skipped: string[] = [];
    try {
      const objs = await api.listTables(connId, database, schema);
      for (const o of objs) {
        if (o.kind !== "view") continue;
        views++;
        try {
          const ddl = await api.getObjectDdl(connId, database, schema, o.name, "view");
          const r = await api.pySqlLineage(ddl, dialect);
          if (!r.ok) { skipped.push(o.name); continue; }
          const viewId = tableId(database, o.name);
          for (const s of r.sources) fresh.push({ from: norm(s), to: viewId, kind: "派生", source: "view" });
        } catch {
          skipped.push(o.name);
        }
      }
    } catch (e) {
      set({ busy: null, lastMsg: `扫描失败:${String(e)}` });
      return;
    }
    const next = dedup([...get().scanned, ...fresh]);
    try { lineageEdges.save(next); }
    catch (error) { set({ busy: null, lastMsg: String(error) }); return; }
    const missed = skipped.length
      ? `；${skipped.length} 个没能解析(${skipped.slice(0, 3).join("、")}${skipped.length > 3 ? " 等" : ""}),它们的上游没有连上`
      : "";
    set({ scanned: next, busy: null, lastMsg: `视图血缘:扫描 ${views} 个视图,新增 ${fresh.length} 条边${missed}` });
  },

  async addSqlEdges(sql, dialect, targetId) {
    const r = await api.pySqlLineage(sql, dialect).catch(error => ({ ok: false, sources: [] as string[], target: null, error: String(error) }));
    if (!r.ok) return { target: null, sources: [], error: r.error ?? "解析失败" };
    const target = targetId || (r.target ? norm(r.target) : null);
    if (target) {
      const fresh = r.sources.map((s): GEdge => ({ from: norm(s), to: target, kind: "派生", source: "sql" }));
      const next = dedup([...get().scanned, ...fresh]);
      try { lineageEdges.save(next); }
      catch (error) { set({ lastMsg: String(error) }); return { target, sources: r.sources, error: String(error) }; }
      set({ scanned: next });
    }
    return { target, sources: r.sources };
  },

  async focusDataset(name, sql, dialect) {
    const to = `bi:${norm(name) || "dataset"}`;
    const r = await api.pySqlLineage(sql, dialect).catch(error => ({ ok: false, sources: [] as string[], target: null, error: String(error) }));
    if (!r.ok) {
      set({ open: true, selected: to, lastMsg: `解析数据集 SQL 失败:${r.error ?? "未知错误"}` });
      return { sources: [], error: r.error ?? "解析失败" };
    }
    const fresh = r.sources.map((s): GEdge => ({ from: norm(s), to, kind: "看板", source: "sql" }));
    const next = dedup([...get().scanned, ...fresh]);
    try { lineageEdges.save(next); }
    catch (error) { set({ lastMsg: String(error) }); return { sources: r.sources, error: String(error) }; }
    set({
      scanned: next,
      open: true,
      selected: to,
      lastMsg: `数据集「${name}」← ${r.sources.length ? r.sources.join("、") : "(未解析到源表)"}`,
    });
    return { sources: r.sources };
  },
}));
