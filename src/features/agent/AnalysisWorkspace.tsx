import { useSubmitOnEnter } from "../../hooks/useSubmitOnEnter";
import { bindingFor } from "./model/modelRouting";
import { useEffect, useMemo, useState } from "react";
import { Loader2, Play, Square, SlidersHorizontal, RotateCcw, Search, X, Check, ChevronRight } from "lucide-react";
import { useMetrics, type Metric } from "../metrics/metricsStore";
import { type AnalysisTab } from "../../store/appStore";
import { availableDimensions } from "../dashboard/semantic";
import { dimensionLabel } from "./dimensions";
import { useAnalysis } from "./analysisStore";
import { analysisProblems, filterContext } from "./analysisDraft";
import { useAi } from "../ai/aiStore";
import AnalysisModelPicker from "./AnalysisModelPicker";
import { analysisModelConfig, analysisModelProblems } from "./model/analysisModels";
import AnalysisResults from "./AnalysisResults";
import { shiftRange } from "./period";
import DateRangePicker from "../dashboard/components/DateRangePicker";
import { fastDimensionValues } from "./tools/dimensionProbe";
import { semanticDataset } from "../dashboard/semantic";
import { createWidget } from "../dashboard/domain";
import "./agent.css";
import "./analysis-workspace.css";

const GRAINS = [
  { value: "day", label: "按天" },
  { value: "week", label: "按周" },
  { value: "month", label: "按月" },
  { value: "year", label: "按年" },
] as const;

const TIME_DIMS = ["day", "week", "month", "year"];

export default function AnalysisWorkspace({ tab }: { tab: AnalysisTab }) {
  const aiConfig = useAi((s) => s.config);
  const allMetrics = useMetrics((s) => s.metrics);
  const metrics = useMemo(() => allMetrics.filter((m) => m.enabled), [allMetrics]);

  /* 表单、取值缓存、运行状态全在 store 里,不在组件里 ——
     切到别的 tab 组件会被卸载,放在 useState 里回来就是一张白纸;
     跑到一半切走更糟:查询还在跑,setState 却已经没人接。 */
  const d = useAnalysis((s) => s.draft);
  const options = useAnalysis((s) => s.valueOptions);
  const loadingValues = useAnalysis((s) => s.loadingValues);
  const running = useAnalysis((s) => s.running);
  const stopping = useAnalysis((s) => s.stopping);
  const [view, setView] = useState(() => useAnalysis.getState().run ? "results" : "config");
  const [valueSearch, setValueSearch] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  useEffect(() => { const timer = setTimeout(() => setSearchTerm(valueSearch.trim()), 300); return () => clearTimeout(timer); }, [valueSearch]);
  const [valuesError, setValuesError] = useState("");
  const [valuesRevision, setValuesRevision] = useState(0);
  const state = useAnalysis((s) => s.run);
  const patch = useAnalysis((s) => s.patch);
  const storageError = useAnalysis((s) => s.storageError);

  const chosen = useMemo(() => metrics.filter((m) => d.metricIds.includes(m.id)), [metrics, d.metricIds]);
  /* 能分的维度 = 所选指标的**交集**。选了交集为空的组合,后面 build_query_plan 会拒掉 ——
     与其让它跑到那一步才报错,不如这里就只给能选的。 */
  const shared = useMemo(
    () => (chosen.length ? availableDimensions(chosen).filter((d) => !TIME_DIMS.includes(d)) : []),
    [chosen],
  );

  const optionKey = JSON.stringify([d.filterField, chosen, d.start, d.end, searchTerm]);
  const retryValues = () => {
    useAnalysis.getState().clearOptions(optionKey);
    setValuesRevision((v) => v + 1);
  };

  // 候选值按指标定义、筛选维度和搜索词隔离；过期请求不回填当前列表。
  useEffect(() => {
    setValuesError("");
    if (d.mode === "question" || !d.filterField || !chosen.length || !shared.includes(d.filterField) || options[optionKey]) {
      useAnalysis.getState().setLoadingValues(false);
      return;
    }
    const field = d.filterField;
    let cancelled = false;
    const store = useAnalysis.getState();
    store.setLoadingValues(true);
    void (async () => {
      try {
        const widget = { ...createWidget("table", ""), bindings: { dimensions: [field], measures: [], metricIds: d.metricIds, secondaryMetricIds: [] } };
        const dataset = semanticDataset(widget, chosen, { start: d.start, end: d.end });
        const values = await fastDimensionValues(dataset, field, 301, searchTerm);
        if (!cancelled) {
          if (values === null) setValuesError("暂不支持自动读取此维度取值");
          else store.setOptions(optionKey, values);
        }
      } catch (error) {
        if (!cancelled) setValuesError(`读取失败：${String(error).replace(/^Error:\s*/, "")}`);
      } finally {
        if (!cancelled) store.setLoadingValues(false);
      }
    })();
    return () => { cancelled = true; store.setLoadingValues(false); };
    /* optionKey 是由 d.metricIds / d.filterField / d.start / d.end 拼出来的复合键,
       它就是「这次要读哪个维度的取值」的完整身份。那几个再逐个列进去是重复的;
       而 options / shared / chosen / searchTerm 是这个 effect 的结果,
       列进去会自己触发自己。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionKey, valuesRevision, d.mode]);

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const problems = [...(d.mode === "question" ? (d.question.trim() ? [] : ["写下你想了解的问题"]) : analysisProblems(d, allMetrics)), ...analysisModelProblems(aiConfig, d.modelChoice, d.wantsDashboard)];

  const startAnalysis = () => {
    if (running || problems.length) return;
    setView("results");
    void useAnalysis.getState().start(tab.connId);
  };
  const questionKeys = useSubmitOnEnter(startAnalysis);
  const focusKeys = useSubmitOnEnter(startAnalysis);

  const contextChanged = !!d.filterContext && d.filterContext !== filterContext(d.metricIds, allMetrics) && Object.values(d.filterValues).some((v) => v.length);
  const comparisonRange = (kind: "mom" | "yoy") => {
    if (problems.some((p) => /日期/.test(p))) return "请先选择有效日期";
    const range = shiftRange({ start: d.start, end: d.end }, kind);
    return `${range.start} — ${range.end}`;
  };

  return (
    <div className="analysis-workspace" data-view={view}>
      <header className="an-topbar">
        <div className="an-brand-icon"><SlidersHorizontal size={19} /></div>
        <div><h1>分析工作台</h1><p>说出问题，让 AI 查找数据、分析并展示。</p></div>
        <span className={`an-status ${running ? "busy" : ""}`}>{running ? "分析进行中" : "从问题开始"}</span>
      </header>
      <nav className="an-mobile-tabs" aria-label="工作区"><button className={view === "config" ? "on" : ""} onClick={() => setView("config")}>分析配置</button><button className={view === "results" ? "on" : ""} onClick={() => setView("results")}>分析结果</button></nav>
      <div className="an-shell">
      <aside className="an-form">
        <fieldset className="an-fields" disabled={running}>
        {storageError && <div className="an-storage-error" role="alert">{storageError}</div>}
        <div className="an-form-intro"><span>分析配置</span><button className="an-text-button" onClick={() => useAnalysis.getState().reset()}><RotateCcw size={12} />重置</button></div>

        <div className="an-mode-switch" aria-label="分析方式">
          <button className={d.mode === "question" ? "on" : ""} onClick={() => patch({ mode: "question" })}>直接提问</button>
          <button className={d.mode === "manual" ? "on" : ""} onClick={() => patch({ mode: "manual" })}>手动配置</button>
        </div>
        {d.mode === "question" && <Section number="" title="你想了解什么？" hint="">
          <textarea {...questionKeys} className="an-focus an-question" aria-label="分析问题" rows={7} value={d.question} onChange={(e) => patch({ question: e.target.value })}
            placeholder="例如：最近一个月哪些分组在下滑？和上个月比，找出变化最大的几个。" />
          <p className="an-dim">AI 会从当前连接的指标中心选择数据、时间和维度。采用的范围会展示在结果中。</p>
          <label className="an-check an-output-option"><input type="checkbox" checked={d.wantsDashboard} onChange={(e) => patch({ wantsDashboard: e.target.checked })}/>生成分析看板</label>
        </Section>}
        <details className="an-model-details"><summary>分析模型 <span>{bindingFor("reasoning", analysisModelConfig(aiConfig, d.modelChoice)).model || "未配置模型"}</span></summary>
        <Section number="AI" title="分析模型" hint="仅用于本次分析">
          <AnalysisModelPicker choice={d.modelChoice} wantsDashboard={d.wantsDashboard} onChange={(modelChoice) => patch({ modelChoice })}/>
        </Section>

        </details>
        {d.mode === "manual" && <>
        <Section number="01" title="选择指标" hint={`已选 ${d.metricIds.length} 个`}>
          {d.metricIds.filter((id) => !metrics.some((m) => m.id === id)).map((id) => <button className="an-chip" key={id}
            onClick={() => patch({ metricIds: d.metricIds.filter((v) => v !== id) })}>移除失效指标：{allMetrics.find((m) => m.id === id)?.name ?? id}</button>)}
          <MetricPicker metrics={metrics} picked={d.metricIds} onToggle={(id) => patch({ metricIds: toggle(d.metricIds, id) })} />
        </Section>

        <Section number="02" title="日期与对比" hint="">
          <div className="an-row">
            <DateRangePicker start={d.start} end={d.end} onChange={(s, e) => patch({ start: s, end: e })} />
          </div>
          <div className="an-chips">
            {GRAINS.map((g) => (
              <button key={g.value} className={`an-chip ${d.grain === g.value ? "on" : ""}`} disabled={chosen.length > 0 && !availableDimensions(chosen).includes(g.value)} onClick={() => patch({ grain: g.value })}>{g.label}</button>
            ))}
          </div>
          <div className="an-chips">
            <label className="an-check"><input type="checkbox" checked={d.mom} onChange={(e) => patch({ mom: e.target.checked })} />环比<span>前一周期</span></label>
            <label className="an-check"><input type="checkbox" checked={d.yoy} onChange={(e) => patch({ yoy: e.target.checked })} />同比<span>去年同期</span></label>
          </div>
        </Section>

        {(d.mom || d.yoy) && <div className="an-comparisons">{d.mom && <div><span>环比期</span>{comparisonRange("mom")}</div>}{d.yoy && <div><span>同比期</span>{comparisonRange("yoy")}</div>}</div>}

        <Section number="03" title="分组维度" hint={shared.length ? "" : "先选指标"}>
          <div className="an-chips">
            {d.dimensions.filter((dim) => !shared.includes(dim)).map((dim) => <button key={dim} className="an-chip"
              onClick={() => patch({ dimensions: d.dimensions.filter((v) => v !== dim) })}>移除不支持的维度：{dimensionLabel(dim)}</button>)}
            {shared.map((dim) => (
              <button key={dim} className={`an-chip ${d.dimensions.includes(dim) ? "on" : ""}`} onClick={() => patch({ dimensions: toggle(d.dimensions, dim) })}>
                {dimensionLabel(dim)}
              </button>
            ))}
            {chosen.length > 0 && shared.length === 0 && <span className="an-dim">这组指标没有共同的业务维度</span>}
          </div>
        </Section>

        <Section number="04" title="筛选范围" hint="">
          <div className="an-row">
            <select className="input" value={d.filterField} aria-label="筛选维度" onChange={(e) => { setValueSearch(""); setSearchTerm(""); patch({ filterField: e.target.value }); }}>
              <option value="">选一个维度…</option>
              {d.filterField && !shared.includes(d.filterField) && <option value={d.filterField}>{dimensionLabel(d.filterField)}（不再支持）</option>}
              {shared.map((dim) => <option key={dim} value={dim}>{dimensionLabel(dim)}</option>)}
            </select>
          </div>
          {d.filterField && (
            <div className="an-filter-picker"><input className="input" aria-label="搜索筛选取值" placeholder="搜索此维度的取值…" value={valueSearch} onChange={(e) => setValueSearch(e.target.value)} /><div className="an-chips an-values">
              {loadingValues && <span className="an-dim"><Loader2 size={12} className="spin" /> 正在读取值…</span>}
              {(options[optionKey] ?? []).slice(0, 300).map((v) => {
                const on = (d.filterValues[d.filterField] ?? []).includes(v);
                return (
                  <button key={v} className={`an-chip ${on ? "on" : ""}`} disabled={contextChanged}
                    onClick={() => patch({ filterContext: filterContext(d.metricIds, allMetrics), filterValues: { ...d.filterValues, [d.filterField]: toggle(d.filterValues[d.filterField] ?? [], v) } })}>
                    {v}
                  </button>
                );
              })}
              {!loadingValues && (options[optionKey] ?? []).length > 300 &&
                <span className="an-dim">共 {(options[optionKey] ?? []).length} 个,先列出 300 个 —— 其余的用上面的搜索找</span>}
              {!loadingValues && (options[optionKey] ?? []).length === 0 && <span className="an-dim">{valuesError || "没有可用取值"}</span>}
              {!loadingValues && <button className="an-text-button" onClick={retryValues}>重新读取</button>}
            </div>{(options[optionKey]?.length ?? 0) > 300 && <p className="an-dim">当前显示前 300 项，请搜索缩小范围。</p>}</div>
          )}
          {Object.entries(d.filterValues).filter(([, v]) => v.length).map(([f, v]) => (
            <div key={f} className="an-active-filter"><span>{dimensionLabel(f)}<strong>{v.join("、")}</strong></span>
              <button className="an-chip" onClick={() => { const next = { ...d.filterValues }; delete next[f]; patch({ filterValues: next }); }}>清除{dimensionLabel(f)}筛选</button>
            </div>
          ))}
        </Section>

        {contextChanged && <div className="an-problems">指标或来源已变化，请核对筛选范围。<button className="an-text-button" onClick={() => patch({ filterContext: filterContext(d.metricIds, allMetrics) })}>确认沿用这些筛选</button></div>}

        <Section number="05" title="分析重点" hint="选填">
          <textarea {...focusKeys} className="an-focus" rows={4} value={d.focus} onChange={(e) => patch({ focus: e.target.value })}
            placeholder="例如：重点看环比变化，把下滑的单独讲清楚。" aria-label="分析重点" />
          <label className="an-check an-output-option"><input type="checkbox" checked={d.wantsDashboard} onChange={(e) => patch({ wantsDashboard: e.target.checked })} />生成分析看板<span>保留本次指标与筛选范围</span></label>
        </Section>

        </>}
        {problems.length > 0 && <div className="an-problems">{problems.join(" · ")}</div>}
        </fieldset>
        <div className="an-actions"><span>{d.mode === "question" ? "AI 自主规划" : `${d.metricIds.length} 个指标 · ${d.dimensions.length} 个分组`}</span>
          {running ? (
            <button className="btn sm" disabled={stopping} onClick={() => useAnalysis.getState().stop()}><Square size={12} /> {stopping ? "正在停止…" : "停止"}</button>
          ) : (
            <button className="btn primary sm" disabled={problems.length > 0} onClick={startAnalysis}>
              <Play size={14} /> {state ? "重新分析" : "开始分析"}<ChevronRight size={15} />
            </button>
          )}
        </div>
      </aside>

      <AnalysisResults state={state} running={running} stopping={stopping} draft={d} onFollowUp={(text) => { setView("results"); void useAnalysis.getState().start(tab.connId, text); }} />
      </div>
    </div>
  );
}

function Section({ number, title, hint, children }: { number: string; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="an-section">
      <div className="an-section-head"><span><i>{number}</i>{title}</span>{hint && <span className="an-dim">{hint}</span>}</div>
      {children}
    </section>
  );
}

/** 指标选择器 —— 按分类分组,带搜索。指标多了以后不搜是找不到的。 */
function MetricPicker({ metrics, picked, onToggle }: { metrics: Metric[]; picked: string[]; onToggle: (id: string) => void }) {
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const key = q.trim().toLowerCase();
    const hit = key
      ? metrics.filter((m) => m.name.toLowerCase().includes(key) || (m.aliases ?? []).some((a) => a.toLowerCase().includes(key)))
      : metrics;
    const map = new Map<string, Metric[]>();
    for (const m of hit) { const bucket = map.get(m.category || "未分类"); if (bucket) bucket.push(m); else map.set(m.category || "未分类", [m]); };
    return [...map.entries()];
  }, [metrics, q]);

  return (
    <>
      <div className="an-search-wrap"><Search size={14} /><input className="input an-search" aria-label="搜索指标" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索指标名称或别名…" /></div>
      {picked.length > 0 && <div className="an-selected-metrics">{metrics.filter((m) => picked.includes(m.id)).map((m) => <button key={m.id} className="an-chip on" onClick={() => onToggle(m.id)}>{m.name}<X size={11} /></button>)}</div>}
      <div className="an-metrics">
        {!groups.length && <p className="an-dim">没有找到匹配的指标</p>}
        {groups.map(([cat, list]) => (
          <div key={cat}>
            <div className="an-cat">{cat}</div>
            <div className="an-chips">
              {list.map((m) => (
                <button key={m.id} className={`an-metric-row ${picked.includes(m.id) ? "on" : ""}`} aria-pressed={picked.includes(m.id)}
                  title={m.caliber || m.name} onClick={() => onToggle(m.id)}>
                  <span className="an-select-box">{picked.includes(m.id) && <Check size={11} />}</span><span className="an-metric-name">{m.name}</span>{m.unit ? <span className="an-unit">{m.unit}</span> : null}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
