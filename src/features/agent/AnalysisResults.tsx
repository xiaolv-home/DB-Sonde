import { useSubmitOnEnter } from "../../hooks/useSubmitOnEnter";
import { previewImages } from "./designLoop";
import { useEffect, useRef, useState } from "react";
import { ANALYSIS_ROLES, PROVIDER_LABELS } from "./model/analysisModels";
import { BarChart3, ArrowUpRight, Check, CircleAlert, FileCheck2, LayoutDashboard, Loader2, Sparkles, Table2, X } from "lucide-react";
import { useApp } from "../../store/appStore";
import type { AgentState } from "./state";
import type { AnalysisDraft } from "./analysisStore";
import { stepState, stepDetail, NODE_LABELS, Elapsed } from "./steps";
import { dimensionLabel } from "./dimensions";
import { explainFailure } from "./workflow";
import type { LockedParams } from "./nodes";
import { compareText } from "../../lib/collate";

const KIND_LABELS = { trend: "趋势", yoy: "同比", mom: "环比", topn: "分组比较", bottomn: "低值观察", contribution: "贡献度", structure_shift: "结构变化", anomaly: "异常观察" };
const ROLE_LABELS = { primary: "本期", mom: "环比期", yoy: "同比期" };
const GRAIN_LABELS: Record<string, string> = { day: "按天", week: "按周", month: "按月", year: "按年" };
const key = (p: LockedParams) => JSON.stringify({
  metricIds: [...p.metricIds].sort(),
  dimensions: [...p.dimensions].sort(),
  dateRange: p.dateRange,
  comparisons: [...p.comparisons].sort(),
  filters: p.filters.map((f) => ({ field: f.field, values: [...f.values].sort() }))
    .sort((a, b) => compareText(a.field, b.field)),
  focus: p.focus,
  wantsDashboard: p.wantsDashboard,
});

export default function AnalysisResults({ state, running, stopping, draft, onFollowUp }: { state: AgentState | null; running: boolean; stopping: boolean; draft: AnalysisDraft; onFollowUp?: (text: string) => void }) {
  const [showPreview, setShowPreview] = useState(false);
  const [reply, setReply] = useState("");
  const submitReply = () => {
    if (running || !onFollowUp || !reply.trim()) return;
    onFollowUp(reply.trim());
    setReply("");
  };
  const replyKeys = useSubmitOnEnter(submitReply);
  const resultRef = useRef<HTMLElement>(null);
  useEffect(() => { resultRef.current?.scrollTo({ top: 0 }); }, [state?.workflowId]);
  const modelChanged = !!state && JSON.stringify(state.modelChoice) !== JSON.stringify(draft.modelChoice);
  const changed = modelChanged || state?.locked !== false && !!state?.lockedParams && key(state.lockedParams) !== key({ metricIds: draft.metricIds, dimensions: [draft.grain, ...draft.dimensions], dateRange: { start: draft.start, end: draft.end }, comparisons: [...(draft.mom ? ["mom" as const] : []), ...(draft.yoy ? ["yoy" as const] : [])], filters: Object.entries(draft.filterValues).filter(([, values]) => values.length).map(([field, values]) => ({ field, values })), focus: draft.focus, wantsDashboard: draft.wantsDashboard });
  const steps = [...(state?.locked === false ? ["QuestionPlanner"] : []), "QueryPlanner", "DataExecutor", "DataValidator", "DrillInvestigator", "AnalysisAgent", "ConclusionReviewer", ...((state?.requirement?.wantsDashboard ?? draft.wantsDashboard) ? ["LayoutDesigner", "DashboardReviewer", "DashboardPreview", "VisualReviewer", "DashboardExecutor"] : [])];
  const status = stopping ? "正在停止" : running ? "正在分析" : state?.status === "needs_input" ? "需要补充一点信息" : state?.status === "failed" ? "分析未完成" : state?.status === "cancelled" ? "已停止" : "分析完成";
  const datasetCount = Object.values(state?.datasets ?? {}).reduce((n, d) => n + d.rowCount, 0);
  return <main ref={resultRef} className="an-result" aria-label="分析结果">
    {!state && !running ? <div className="an-welcome">
      <span className="an-eyebrow">从问题出发 · 用数据回答</span>
      <div className="an-welcome-mark"><BarChart3 size={34} strokeWidth={1.5} /></div>
      <h2>下一次发现，从这里开始</h2>
      <p>直接说出你关心的业务问题，<br />AI 会选择数据、比较变化，并解释它的判断。</p>
      <div className="an-preview-flow">
        <div><span>01</span><FileCheck2 size={20}/><b>核对数据</b><p>检查完整性与统计口径</p></div>
        <div><span>02</span><Sparkles size={20}/><b>发现线索</b><p>趋势、对比与分组表现</p></div>
        <div><span>03</span><LayoutDashboard size={20}/><b>形成看板</b><p>把本次发现留作参考</p></div>
      </div>
      <div className="an-welcome-note"><Check size={13}/> 采用的指标、范围和假设都会公开展示</div>
    </div> : <div className="an-result-content">
      <div className="an-result-heading"><div><span className="an-eyebrow">分析结果</span><h2>{status}</h2></div><span className={`an-run-badge ${state?.status ?? "running"}`}>{running ? <Loader2 size={13} className="spin"/> : state?.status === "done" ? <Check size={13}/> : <CircleAlert size={13}/>} {state ? new Date(state.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "准备中"}</span></div>
      {state?.userRequest && <p className="an-asked">{state.userRequest}</p>}
      {changed && !running && <div className="an-notice" role="status">配置已修改。下方仍是上一次分析结果，重新分析后更新。</div>}
      {stopping && <div className="an-notice" role="status">正在等待已发出的请求结束，之后不再执行后续步骤。</div>}
      {state?.status === "cancelled" && <div className="an-notice">本次分析已停止。已完成的内容保留在下方。</div>}
      {state?.clarification && <div className="an-notice" role="status" style={{whiteSpace:"pre-wrap"}}>{state.clarification}</div>}
      {state?.status === "failed" && <div className="an-failure" role="alert"><CircleAlert size={18}/><div><b>本次分析未能完成</b><p>{state.validation?.status === "fail" ? "请根据上方检查结果调整分析范围，或在指标中心检查数据口径后重新分析。" : explainFailure(state)}</p></div></div>}
      {!!state?.dropped?.length && <div className="an-notice"><b>尚未满足的要求</b><ul>{[...new Set(state.dropped)].map((text) => <li key={text}>{text}</li>)}</ul></div>}
      {state?.status === "failed" && state?.conclusionReview?.verdict === "revise" && (state.analysisSummary || state.insights?.length) &&
        <div className="an-notice" role="status"><b>下面这份结论没有通过证据复核</b><p>保留它是为了让你看到已经查到什么、依据是什么，不代表它已经可信；复核指出的问题见上方红框。</p></div>}
      {state?.analysisSummary && <section className="an-summary"><span className="an-eyebrow">本次发现</span><p>{state.analysisSummary}</p></section>}
      {!!state?.drillSteps?.length && <DrillPath state={state} />}
      {!!state?.insights?.length && <section className="an-findings" aria-label="分析结论">
        <div className="an-section-title"><h3>关键结论</h3><span>{state.insights.length} 条发现 · 可查看依据</span></div>
        {state.insights.map((insight, index) => <article className={`an-finding ${insight.severity}`} key={index}>
          <div className="an-finding-head"><span className="an-finding-number">{String(index + 1).padStart(2, "0")}</span><span>{KIND_LABELS[insight.kind]}</span>{insight.severity !== "info" && <small>值得关注</small>}</div>
          <p>{insight.headline}</p><details className="an-evidence"><summary>查看结论依据 <Table2 size={12}/></summary><EvidenceTable columns={insight.evidence.columns} rows={insight.evidence.rows.slice(0, 50)}/>{insight.evidence.rows.length > 50 && <p>展示前 50 行，共 {insight.evidence.rows.length} 行依据。</p>}</details>
        </article>)}
      </section>}
      {!!state?.evidenceGaps?.length && <div className="an-notice"><b>证据仍有局限</b><ul>{state.evidenceGaps.map((text, i) => <li key={i}>{text}</li>)}</ul></div>}
      {state?.report && !state.analysisSummary && !state.insights?.length && <div className="an-summary">{state.report}</div>}
      {state?.dashboardId && <div className="an-dashboard-card"><LayoutDashboard size={23}/><div><b>{state.review?.verdict === "needs_revision" ? "看板草稿已保存，成品仍需调整" : "分析看板已保存"}</b><p>保留本次指标、日期与筛选条件</p></div><button className="btn primary sm" onClick={() => useApp.getState().openDashboardTab(state.dashboardId)}>打开看板<ArrowUpRight size={14}/></button></div>}
      {state && !running && onFollowUp && <form className="an-follow-up" onSubmit={(e) => { e.preventDefault(); submitReply(); }}>
        <textarea {...replyKeys} className="an-focus" rows={2} aria-label="继续追问" placeholder={state.status === "needs_input" ? "补充这点信息，继续分析…" : "继续追问，例如：把这个分组展开，比较占比和绝对值…"} value={reply} onChange={(e) => setReply(e.target.value)}/>
        <button className="btn primary sm" disabled={!reply.trim()}>{state.status === "needs_input" ? "补充并继续" : "继续分析"}</button>
      </form>}
      {state && <details className="an-context" open={running || state.status === "failed"}>
        <summary><b>范围、数据与分析过程</b><span>{state.scope ? `${state.scope.dateRange.start} — ${state.scope.dateRange.end}` : "正在确定范围"}</span></summary>
      {state?.analysisAngle && <p className="an-notice"><b>这次的分析思路</b><br/>{state.analysisAngle}</p>}
      {!!state?.assumptions?.length && <div className="an-notice"><b>本次采用的默认设置</b><ul>{state.assumptions.map((text, i) => <li key={i}>{text}</li>)}</ul></div>}
      {state?.scope && <section className="an-scope-card">
        <div className="an-card-label">本次实际范围</div><div className="an-scope-date">{state.scope.dateRange.start}<span>至</span>{state.scope.dateRange.end}<small>{GRAIN_LABELS[state.scope.grain ?? ""]}</small></div>
        <div className="an-scope-tags">{state.validatedMetrics?.map((m) => <span key={m.metricId}>{m.name}</span>)}{state.lockedParams?.dimensions.filter((d) => !GRAIN_LABELS[d]).map((d) => <span key={d}>{dimensionLabel(d)}分组</span>)}</div>
        {state.models?.map((m) => <p className="an-scope-filter" key={m.role}>{ANALYSIS_ROLES.find((r) => r.role === m.role)?.label}<b>{PROVIDER_LABELS[m.provider as keyof typeof PROVIDER_LABELS]} · {m.model}</b></p>)}
        {state.scope.filters.map((f) => <p key={f.field} className="an-scope-filter">{dimensionLabel(f.field)}<b>{f.values.join("、")}</b></p>)}
        {state.plans?.filter((p) => p.role !== "primary").map((p) => <p className="an-scope-filter" key={p.planId}>{ROLE_LABELS[p.role]}<b>{p.dateRange.start} 至 {p.dateRange.end}</b></p>)}
      </section>}
      <section className="an-progress-card" aria-label="分析进度"><ol className="an-progress">
        {steps.map((node, i) => { const step = stepState(node, state); return <li key={node} className={step} title={stepDetail(node, state) ?? ""}><span className="an-step-symbol">{step === "done" ? <Check size={12}/> : step === "active" ? <Loader2 size={12} className="spin"/> : step === "failed" ? <X size={12}/> : i + 1}</span><span>{NODE_LABELS[node]}</span></li>; })}
      </ol>{running && state && <div className="an-progress-detail">{NODE_LABELS[state.currentNode] ?? "准备分析"}{state.nodeStartedAt && <Elapsed since={state.nodeStartedAt}/>}</div>}</section>
      {state?.validation && <details className={`an-quality ${state.validation.status}`} open={state.validation.status !== "pass"}>
        <summary><FileCheck2 size={16}/><b>{state.validation.status === "pass" ? "数据检查通过" : state.validation.status === "warn" ? "数据有需要关注的提醒" : "数据检查未通过"}</b><span>{datasetCount.toLocaleString()} 行 · {state.plans?.length ?? 0} 个周期 · {(state.plans?.length ?? 0) + (state.supportingPlans?.length ?? 0)} 个查询视角</span></summary>
        {state.validation.issues.length ? <ul>{state.validation.issues.map((issue, i) => <li key={i}><span>{issue.level === "fail" ? "需修正" : "提醒"}</span>{issue.message}{issue.samples?.length ? <small>样本：{issue.samples.join("、")}</small> : null}</li>)}</ul> : <p>所选周期的数据已检查完整性、指标列与分组汇总一致性。</p>}
      </details>}
      {!!state?.designRounds?.length && <details className="an-quality" open={state.review?.verdict !== "pass"}><summary><b>成品验收与修改</b><span>{state.designRounds.length} 轮 · 采用第 {state.selectedDesignRound ?? state.designRounds.length} 版</span></summary>{state.designRounds.map((round) => <div key={round.round}><h4>第 {round.round} 轮 · {round.score == null ? "未完成视觉验收" : `${round.score}/100`} · {round.status === "pass" ? "通过" : round.status === "revise" ? "需修改" : "未验收"}</h4><p>{round.scores && `审美 ${round.scores.beauty}/20 · 布局 ${round.scores.layout}/20 · 表达 ${round.scores.variety}/20 · 清晰 ${round.scores.clarity}/20 · 深度 ${round.scores.insight}/20`}</p><ul>{[...round.observations, ...round.issues].map((issue, i) => <li key={i}>{issue}</li>)}</ul><small>{round.model}</small></div>)}</details>}
      {!!state?.dashboardId && !!previewImages(state.workflowId).length && <div className="an-quality"><button className="an-text-button" onClick={() => setShowPreview(!showPreview)}>{showPreview ? "收起成品预览" : "查看本次验收的成品预览"}</button>{showPreview && previewImages(state.workflowId).map((src, index) => <img key={index} src={src} alt={`成品预览第 ${index + 1} 部分`} style={{ width: "100%", display: "block", marginTop: 8 }} />)}</div>}
      {!!state?.investigation?.length && <details className="an-quality"><summary><b>分析与验证过程</b><span>{state.investigation.length} 条记录</span></summary><ul>{state.investigation.map((text, i) => <li key={i}>{text}</li>)}</ul></details>}
      {state?.conclusionReview?.verdict === "pass" && <p className="an-notice">结论已完成证据复核。</p>}
      {!!state?.datasets && <details className="an-data-preview"><summary><Table2 size={14}/> 查询数据预览<span>每个查询最多 5 行</span></summary>{[...(state.plans ?? []), ...(state.supportingPlans ?? []).map((p) => ({ ...p, role: "detail" as const }))].map((p) => { const dataset = state.datasets?.[p.planId]; return dataset ? <div key={p.planId}><h4>{p.role === "detail" ? "补充视角" : ROLE_LABELS[p.role]} <span>{dataset.rowCount.toLocaleString()} 行{dataset.truncated ? "（已截断）" : ""}</span></h4><EvidenceTable columns={dataset.columns} rows={dataset.sampleRows.slice(0, 5)}/></div> : null; })}</details>}
      </details>}
    </div>}
  </main>;
}

function EvidenceTable({ columns, rows }: { columns?: string[]; rows: unknown[][] }) {
  if (!rows.length) return <p className="an-dim">没有可展示的样例行</p>;
  const labels = columns ?? rows[0].map((_, i) => `数据 ${i + 1}`);
  return <div className="an-table-scroll"><table><thead><tr>{labels.map((label, i) => <th key={i}>{label}</th>)}</tr></thead><tbody>{rows.map((row, i) => <tr key={i}>{row.map((value, j) => <td key={j}>{value == null ? "—" : typeof value === "number" ? value.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(value)}</td>)}</tr>)}</tbody></table></div>;
}

/** 下钻调查的路径:从整体一层层往下,每一步看了什么、说明了什么。 */
function DrillPath({ state }: { state: AgentState }) {
  const steps = state.drillSteps ?? [];
  const depth = (id?: string): number => { const step = steps.find((s) => s.id === id); return step ? 1 + depth(step.parentId) : 0; };
  return <section className="an-drill" aria-label="调查路径">
    <div className="an-section-title"><h3>调查路径</h3><span>从整体往下钻了 {steps.filter((s) => !s.failed).length} 步</span></div>
    {state.rootCause && <div className="an-drill-root"><b>找到的原因</b><p>{state.rootCause}</p></div>}
    <ol className="an-drill-steps">
      <li className="an-drill-step" style={{ paddingLeft: 0 }}><span className="an-drill-id">整体</span><div><b>{state.scope?.label ?? "整体"}</b>{state.lockedParams?.dimensions?.length ? <small> · 按{state.lockedParams.dimensions.map(dimensionLabel).join("、")}</small> : null}</div></li>
      {steps.map((step) => <li key={step.id} className={`an-drill-step ${step.failed ? "failed" : ""}`} style={{ paddingLeft: depth(step.id) * 18 }}>
        <span className="an-drill-id">{step.id}</span>
        <div>
          <b>{step.label}</b>{step.breakdown && <small> · 按{dimensionLabel(step.breakdown)}拆</small>}{step.compare && <small> · 对比{step.compare === "yoy" ? "去年同期" : "上期"}</small>}
          <p className="an-drill-q">{step.question}</p>
          {step.reading && <p className="an-drill-reading">{step.reading}</p>}
          {step.failed && <p className="an-drill-failed">没取到:{step.failed}</p>}
        </div>
      </li>)}
    </ol>
  </section>;
}
