import { useEffect, useRef, useState } from "react";
import { Loader2, Play, Workflow } from "lucide-react";
import { api } from "../lib/api";
import { useApp, type RoutineTab } from "../store/appStore";
import type { QueryResult, RoutineDetails } from "../types";
import ResultGrid from "./ResultGrid";

export default function RoutineWorkspace({ tab }: { tab: RoutineTab }) {
  const [details, setDetails] = useState<RoutineDetails>();
  const [values, setValues] = useState<(string | null)[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<QueryResult>();
  const [selected, setSelected] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const executing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    api.getRoutineDetails(tab.connId, tab.database, tab.schema, tab.routineName, tab.routineKind)
      .then(d => { if (mounted.current) { setDetails(d); setValues(d.parameters.map(p => p.mode === "OUT" ? null : "")); } })
      .catch(e => mounted.current && setError(String(e)))
      .finally(() => mounted.current && setLoading(false));
    return () => { mounted.current = false; };
    /* tab.id 就是身份:一个标签页盯哪个存储过程是创建时定死的,换一个就是新标签页。
       把 tab.connId/database/schema/routineName 逐个列进去不会更安全,
       只会在重命名之类的场景下重新加载一遍已经加载好的东西。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 标签身份是 tab.id,running 等字段不该重新加载
  }, [tab.id]);
  useEffect(() => {
    if (!tab.running) return;
    const start = Date.now(); setElapsed(0);
    const timer = setInterval(() => setElapsed((Date.now() - start) / 1000), 100);
    return () => clearInterval(timer);
  }, [tab.running]);
  const run = async () => {
    if (!details || executing.current) return;
    executing.current = true; setError(""); setResult(undefined); setSelected(0);
    const running = (value: boolean) => useApp.setState(s => ({ tabs: s.tabs.map(t => t.id === tab.id && t.kind === "routine" ? { ...t, running: value } : t) }));
    running(true);
    try {
      const next = await api.executeRoutine(tab.connId, tab.database, tab.schema, tab.routineName, tab.routineKind, values);
      if (mounted.current) setResult(next);
    } catch (reason) { if (mounted.current) setError(String(reason)); }
    finally { executing.current = false; running(false); }
  };
  const sets = result ? [result, ...(result.additionalResults ?? [])] : [];
  const current = sets[selected];
  return <div className="routine-workspace">
    <header className="routine-heading"><Workflow size={20} /><div><strong>{tab.routineName}</strong><small>{tab.connName} · {tab.database}{tab.schema ? ` / ${tab.schema}` : ""} · {tab.routineKind === "procedure" ? "存储过程" : "函数"}</small></div><button className="btn primary" disabled={loading || !details || tab.running} onClick={() => void run()}>{tab.running ? <Loader2 size={14} className="spin" /> : <Play size={14} />} {tab.running ? "执行中" : "执行"}</button></header>
    {loading && <div className="object-state"><Loader2 className="spin" size={18} /> 正在读取参数…</div>}
    {details && <div className="routine-parameters">
      {details.parameters.length ? <table><thead><tr><th>参数</th><th>方向</th><th>类型</th><th>值</th></tr></thead><tbody>{details.parameters.map((p, i) => <tr key={i}><td>{p.name}</td><td>{p.mode}</td><td>{p.dataType}</td><td>{p.mode === "OUT" ? <span className="muted">执行后返回</span> : <div className="routine-input"><input className="input" aria-label={p.name} disabled={tab.running || values[i] === null} value={values[i] ?? ""} placeholder="输入参数值" onChange={e => setValues(v => v.map((x, n) => n === i ? e.target.value : x))} /><label><input type="checkbox" disabled={tab.running} checked={values[i] === null} onChange={e => setValues(v => v.map((x, n) => n === i ? e.target.checked ? null : "" : x))} />NULL</label></div>}</td></tr>)}</tbody></table> : <p>此{tab.routineKind === "procedure" ? "存储过程" : "函数"}无需输入参数，点击执行即可。</p>}
      <details><summary>查看定义</summary><pre>{details.definition ?? "当前账号无法读取定义。"}</pre></details>
    </div>}
    {error && <div className="routine-error" role="alert">{error}</div>}
    {sets.length > 0 && <div className="routine-results-tabs">{sets.map((s, i) => <button key={i} className={`btn sm ${selected === i ? "primary" : "ghost"}`} onClick={() => setSelected(i)}>结果 {i + 1} · {s.columns.length ? `${s.rows.length} 行` : `影响 ${s.rowsAffected ?? 0} 行`}{s.truncated ? "（已截断）" : ""}</button>)}<span>{result?.elapsedMs} ms</span></div>}
    <div className="routine-result" aria-busy={!!tab.running}>{tab.running ? <div className="routine-running" role="status"><Loader2 size={24} className="spin" /><b>正在执行{tab.routineKind === "procedure" ? "存储过程" : "函数"}</b><span>{elapsed.toFixed(1)} 秒 · 等待数据库返回</span></div> : current ? current.columns.length ? <ResultGrid key={selected} result={current} /> : <div className="object-state">执行完成 · 影响 {current.rowsAffected ?? 0} 行</div> : !loading && !error && <div className="object-state">执行结果将在这里显示</div>}</div>
  </div>;
}
