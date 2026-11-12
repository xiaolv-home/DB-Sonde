import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ban, Loader2, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import { useConfirm } from "./useConfirm";
import type { Cell, DbKind, QueryResult } from "../types";

export interface Proc {
  id: number;
  user: string;
  host: string;
  db: string;
  command: string;
  time: number;
  state: string;
  info: string;
}

const colOf = (r: QueryResult, name: string) =>
  r.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
const asStr = (v: Cell) => (v === null || v === undefined ? "" : String(v));
const asNum = (v: Cell) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Turn the raw COMMAND/state into something readable. */
const MYSQL_CMD: Record<string, string> = {
  query: "正在执行查询",
  sleep: "空闲(连着但没干活)",
  connect: "正在连接",
  quit: "正在断开",
  "binlog dump": "推送 binlog(从库同步)",
  "change user": "切换用户",
  "table dump": "导出表",
  daemon: "后台线程",
};
const PG_CMD: Record<string, string> = {
  active: "正在执行",
  idle: "空闲",
  "idle in transaction": "事务中空闲",
  "idle in transaction (aborted)": "事务已中止(未回滚)",
  fastpath: "正在执行",
};
function commandText(cmd: string, kind: DbKind): string {
  const key = cmd.toLowerCase();
  if (kind === "postgres") return PG_CMD[key] ?? (cmd || "—");
  return MYSQL_CMD[key] ?? (cmd || "—");
}
function isActive(cmd: string, kind: DbKind): boolean {
  const key = cmd.toLowerCase();
  return kind === "postgres" ? key === "active" || key === "fastpath" : key === "query";
}
function humanTime(sec: number): string {
  if (sec <= 0) return "刚刚";
  if (sec < 60) return `${sec} 秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  return `${Math.floor(sec / 3600)} 时 ${Math.floor((sec % 3600) / 60)} 分`;
}

/** 会话噪音分类 —— 默认折叠掉「看了也没用」的那些。
 *  system:数据库自带的后台/调度线程;replication:云厂商(PolarDB/Aurora)的复制线程;
 *  idle:连着但没干活的空闲连接;self:本面板自己的轮询查询。
 *  返回 null = 值得你看(正在执行、事务中空闲等)。 */
export type NoiseKind = "system" | "replication" | "idle" | "self" | null;
const NOISE_LABEL: Record<Exclude<NoiseKind, null>, string> = {
  system: "系统线程",
  replication: "复制线程",
  idle: "空闲连接",
  self: "本工具",
};
export function noiseKind(p: Proc, kind: DbKind): NoiseKind {
  const cmd = p.command.toLowerCase();
  const user = p.user.toLowerCase();
  const state = p.state.toLowerCase();
  const info = p.info.toLowerCase();
  // 本面板自己的轮询查询,没必要占一行。
  if (info.includes("information_schema.processlist") || info.includes("pg_stat_activity")) return "self";
  if (kind === "postgres") {
    // 事务中空闲会占锁,必须显示;纯 idle 折叠。
    if (cmd.includes("idle in transaction")) return null;
    if (cmd === "idle" || (!p.info && cmd !== "active" && cmd !== "fastpath")) return "idle";
    return null;
  }
  // MySQL / MariaDB
  // binlog dump 本身就是复制推送线程,归到「复制线程」标签更准确。
  if (cmd.startsWith("binlog dump")) return "replication";
  if (user === "aurora" || user === "replicator" || user === "polardb") return "replication";
  if (cmd === "daemon" || user === "event_scheduler" || user === "system user") return "system";
  if (state.includes("polar log") || state.includes("rds push lsn")
      || state.includes("waiting on empty queue") || state.includes("source has sent all binlog")) return "replication";
  if (cmd === "sleep") return "idle";
  return null;
}

export default function ProcessList({ connId, kind, active = true }: { connId: string; kind: DbKind; active?: boolean }) {
  const [procs, setProcs] = useState<Proc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [auto, setAuto] = useState(false);
  const [killing, setKilling] = useState<number | null>(null);
  const { askConfirm, confirmDialog } = useConfirm();
  const [showAll, setShowAll] = useState(false);
  const supported = ["mysql", "mariadb", "postgres"].includes(kind);
  const sequence = useRef(0);
  const inFlight = useRef<number | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [page, setPage] = useState(0);
  const pageSize = 100;

  const load = useCallback(async () => {
    if (!supported) {
      setLoading(false);
      return;
    }
    if (inFlight.current !== null) return;
    const request = ++sequence.current;
    inFlight.current = request;
    setLoading(true);
    try {
      const r = await api.listProcesses(connId);
      if (sequence.current !== request) return;
      setTruncated(!!r.truncated);
      const ci = {
        id: colOf(r, "ID"),
        user: colOf(r, "USER"),
        host: colOf(r, "HOST"),
        db: colOf(r, "DB"),
        command: colOf(r, "COMMAND"),
        time: colOf(r, "TIME"),
        state: colOf(r, "STATE"),
        info: colOf(r, "INFO"),
      };
      setProcs(
        r.rows.map((row) => ({
          id: asNum(row[ci.id]),
          user: asStr(row[ci.user]),
          host: asStr(row[ci.host]),
          db: ci.db >= 0 ? asStr(row[ci.db]) : "",
          command: asStr(row[ci.command]),
          time: asNum(row[ci.time]),
          state: ci.state >= 0 ? asStr(row[ci.state]) : "",
          info: ci.info >= 0 ? asStr(row[ci.info]) : "",
        })),
      );
      setError(undefined);
    } catch (e) {
      if (sequence.current === request) setError(String(e));
    } finally {
      if (sequence.current === request) {
        inFlight.current = null;
        setLoading(false);
      }
    }
  }, [connId, supported]);

  useEffect(() => {
    setLoading(true);
    setProcs([]);
    setPage(0);
    void load();
    /* 下面这行会被 exhaustive-deps 盯上,它是冲着「ref 指向的 DOM 节点可能已经变了」
       去的;而 sequence 只是个请求序号计数器 —— 在清理里自增正是为了作废还在飞的
       那些响应,这就是它的用法本身。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { sequence.current++; inFlight.current = null; };
  }, [load]);

  useEffect(() => {
    if (!auto || !active) return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [auto, load, active]);

  /**
   * 杀一个会话。**先确认,并且把要杀的那个原原本本摆出来**。
   *
   * 原来是单击即杀。这张表每 3 秒自动刷新一次,而且按"正在执行"和耗时重新排序 ——
   * 鼠标悬在「杀死」上的时候行会在脚下移动,点下去杀的可能不是你看的那个。
   * 杀掉的是别人正在跑的 ETL,没法撤销。
   *
   * 同一个应用里删表、整列赋值、增删行全都要确认,这儿不该是例外。
   * 确认框里连 id、用户、库、耗时、SQL 一起显示,让人能核对是不是自己想杀的那条。
   */
  const kill = async (p: Proc) => {
    const detail = [
      `会话 ${p.id}`,
      p.user ? `用户:${p.user}${p.host ? ` @ ${p.host}` : ""}` : "",
      p.db ? `数据库:${p.db}` : "",
      `已执行:${p.time} 秒`,
      p.info ? `\n${p.info.slice(0, 500)}${p.info.length > 500 ? " …" : ""}` : "",
    ].filter(Boolean).join("\n");
    if (!(await askConfirm(`${detail}\n\n杀掉之后这条语句会立刻中断,无法撤销。`, "杀死会话", "杀死"))) return;

    const request = sequence.current;
    setKilling(p.id);
    try {
      await api.killProcess(connId, p.id);
      if (sequence.current === request) await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setKilling(null);
    }
  };

  // 分类 → 默认只显示值得关注的;正在执行的排前面。
  const classified = useMemo(() => procs
    .map((p) => ({ p, noise: noiseKind(p, kind) }))
    .sort((a, b) => Number(isActive(b.p.command, kind)) - Number(isActive(a.p.command, kind)) || b.p.time - a.p.time), [procs, kind]);
  const visible = showAll ? classified : classified.filter((x) => !x.noise);
  const hidden = classified.length - visible.length;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(visible.length / pageSize) - 1));
  const pageRows = visible.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  if (!supported)
    return <div className="proc-message">SQLite / Oracle 没有可管理的服务端进程。</div>;

  return (
    <div className="proc-panel">
      <div className="proc-bar">
        <span className="proc-count">{visible.length} 个会话</span>
        <span className="proc-hint">
          红色 = 正在跑的查询;想停掉哪个点右侧「杀死」。
          {hidden > 0 && !showAll ? ` 已折叠 ${hidden} 个系统/复制/空闲会话。` : ""}
        </span>
        <div className="toolbar-spacer" />
        {(hidden > 0 || showAll) && (
          <label className="proc-auto" title="系统后台线程、云数据库复制线程、空闲连接,以及本工具自己的轮询查询">
            <input type="checkbox" checked={showAll} onChange={(e) => { setShowAll(e.target.checked); setPage(0); }} /> 显示全部({classified.length})
          </label>
        )}
        <label className="proc-auto">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> 每 3 秒自动刷新
        </label>
        <button className="btn ghost sm" disabled={loading} onClick={() => void load()}>
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      {truncated && <div className="proc-notice">会话过多，仅显示按运行时间排序的前 2000 个；SQL 显示前 2048 个字符。</div>}
      {loading ? (
        <div className="proc-message">
          <Loader2 size={18} className="spin" /> 读取会话…
        </div>
      ) : error ? (
        <div className="proc-message error">{error}</div>
      ) : visible.length === 0 ? (
        <div className="proc-message">{classified.length ? "没有正在活动的会话(其余都是系统/复制/空闲会话,已折叠)。" : "当前没有其它会话。"}</div>
      ) : (
        <div className="object-grid-wrap">
          <table className="object-grid proc-grid">
            <thead>
              <tr>
                <th>会话号</th>
                <th>谁 · 从哪来</th>
                <th>数据库</th>
                <th>在做什么</th>
                <th>已运行</th>
                <th>当前 SQL</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pageRows.map(({ p, noise }) => {
                const active = isActive(p.command, kind);
                const slow = active && p.time >= 30;
                return (
                  <tr key={p.id} className={active ? "proc-active" : ""}>
                    <td className="numeric mono">{p.id}</td>
                    <td>
                      <span className="proc-user">{p.user || "—"}</span>
                      {p.host ? <span className="proc-host">{p.host}</span> : null}
                    </td>
                    <td>{p.db || "—"}</td>
                    <td>
                      <span className={`proc-cmd ${active ? "on" : ""}`}>{commandText(p.command, kind)}</span>
                      {noise ? <span className="proc-noise">{NOISE_LABEL[noise]}</span> : null}
                      {p.state ? <span className="proc-state">{p.state}</span> : null}
                    </td>
                    <td className="numeric" style={slow ? { color: "var(--red)", fontWeight: 600 } : undefined}>
                      {humanTime(p.time)}
                    </td>
                    <td className="proc-sql mono" title={p.info}>
                      {p.info || "—"}
                    </td>
                    <td>
                      <button
                        className="btn danger xs"
                        disabled={killing === p.id}
                        onClick={() => void kill(p)}
                        title="强制断开/杀死这个会话"
                      >
                        {killing === p.id ? <Loader2 size={13} className="spin" /> : <Ban size={13} />} 杀死
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {visible.length > pageSize && !loading && !error && <div className="proc-bar">
        <span>第 {currentPage + 1} / {Math.ceil(visible.length / pageSize)} 页 · 每页 {pageSize} 个会话</span>
        <button className="btn sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
        <button className="btn sm" disabled={(currentPage + 1) * pageSize >= visible.length} onClick={() => setPage(currentPage + 1)}>下一页</button>
      </div>}
      {confirmDialog}
    </div>
  );
}
