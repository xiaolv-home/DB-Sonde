import { nanoid } from "nanoid";
import type { DateRange } from "./period";

export interface ValidatedMetric {
  metricId: string;
  name: string;
  unit: string;
  caliber: string;
  /** 显示层再聚合方式。比率型是 avg —— 跨行求和会得到 100%+ 的荒唐值。 */
  rollup: string;
  direction?: "neutral" | "higher" | "lower";
  supportedDimensions: string[];
  dateScoped: boolean;
  sourceTables: string[];
}

import type { ValidationIssue } from "./validation/dataChecks";
import { localDay } from "../../lib/dates";

/**
 * Agent 的单一真相。
 *
 * 三条纪律(设计报告第 6 节):
 *  1. 节点之间**只传 State,不传自然语言**。唯一的长文本是 insight 的 headline,
 *     而它必须挂 evidence。
 *  2. State 可序列化、可 diff —— 「AI 为什么建了这个图」靠 diff 两个 checkpoint 回答。
 *  3. 大结果集不进 State。超过阈值只留 {columns, sampleRows, rowCount},
 *     全量留在 plan 里,否则 checkpoint 文件会爆。
 */

export type WorkflowStatus = "running" | "done" | "failed" | "cancelled" | "needs_input";

export interface AgentError {
  node: string;
  message: string;
  at: string;
}

export interface Requirement {
  goal: string;
  subject: string;
  audience: "management" | "operation" | "analyst";
  comparisons: ("mom" | "yoy")[];
  candidateDimensions: string[];
  candidateMetricTerms: string[];
  /** 用户要的是看板还是一段文字结论。只说「分析一下」就别擅自建看板。 */
  wantsDashboard?: boolean;
  /** 用户明确要了、但现有指标和维度表达不了的东西。
   *  **必须原样告诉用户**,不能默默忽略 —— 默默忽略会给出一张看着对、实际漏了
   *  半个条件的表,那比报错危险得多。 */
  unsupported?: string[];
}

export interface ResolvedScope {
  dateRange: DateRange;
  grain: "day" | "week" | "month" | "year";
  comparisonRanges: { kind: "mom" | "yoy"; start: string; end: string }[];
  filters: { field: string; values: string[]; resolvedFrom: string }[];
  /** 人话描述,给用户确认:「2026年8月」。 */
  label: string;
}

export interface DatasetSummary {
  planId: string;
  rowCount: number;
  truncated: boolean;
  columns: string[];
  /** 只留样例行 —— 全量在 plan 里,不进 State。 */
  sampleRows: unknown[][];
}

export interface Insight {
  kind: "trend" | "yoy" | "mom" | "topn" | "bottomn" | "contribution" | "structure_shift" | "anomaly";
  headline: string;
  /** **没有 evidence 的 insight 一律丢弃。** */
  evidence: {
    planId: string;
    rows: unknown[][];
    columns?: string[];
    /** 哪个分析原语算出来的,便于人工复核。 */
    computedBy: string;
  };
  severity: "info" | "warn" | "critical";
}

/**
 * 下钻调查的一步:在某个范围里按一个维度拆开、配一个对比期。
 * 范围只能比上一层更小(多一个筛选、日期更窄),不能越出用户核对过的范围。
 */
export interface DrillStep {
  id: string;
  parentId?: string;
  /** 为什么钻到这里 —— 用户会看到。 */
  question: string;
  metricIds: string[];
  /** 在用户核对过的范围之上,这一步额外缩小的筛选(含上层带下来的)。 */
  focus: { field: string; values: string[] }[];
  dateRange: DateRange;
  breakdown?: string;
  compare?: "mom" | "yoy";
  compareRange?: DateRange;
  planId?: string;
  comparePlanId?: string;
  /** 人话范围:「外卖 · 2026年10月」。 */
  label: string;
  /** 模型读完这一步的数据后的判断。 */
  reading?: string;
  /** 没取到数 / 没通过检查的原因。 */
  failed?: string;
}

export interface AgentState {
  // ── 身份与控制 ─────────────────────────────
  workflowId: string;
  createdAt: string;
  status: WorkflowStatus;
  currentNode: string;
  /** 「你想看什么 / 重点是什么」—— 参数锁死模式下,用户唯一说的那句话。
   *  它只喂给**分析和设计**,绝不参与取参:抽参错了看不出来,分析写偏了一眼就看见。 */
  focus?: string;
  analysisAngle?: string;
  designFeedback?: string;
  designBindingErrors?: string[];
  selectedDesignRound?: number;
  candidateDashboardId?: string;
  designPreview?: { imageCount: number; width: number; height: number; complete: boolean; issues: string[]; text: string };
  designRounds?: { round: number; score?: number; scores?: Record<string, number>; status: "pass" | "revise" | "unavailable"; observations: string[]; issues: string[]; model: string }[];
  investigation?: string[];
  /** 下钻调查的路径(从整体到根因)。 */
  drillSteps?: DrillStep[];
  /** 调查收尾时模型给出的根因判断(事实 / 待验证分开写)。 */
  rootCause?: string;
  evidenceGaps?: string[];
  coveragePlan?: { area: string; metricIds: string[]; disposition: "selected" | "deferred" | "irrelevant"; reason: string }[];
  conclusionReview?: { verdict: "pass" | "revise"; issues: string[] };
  assumptions?: string[];
  clarification?: string;
  previousParams?: import("./analysisTypes").LockedParams;
  previousSummary?: string;
  conversation?: { role: "user" | "assistant"; content: string }[];
  modelChoice?: import("./model/analysisModels").AnalysisModelChoice;
  models?: { role: string; provider: string; model: string }[];
  /** 参数由人锁死(走「分析」入口),还是从自然语言里抽出来的。
   *  锁死时体检失败不该回头重规划 —— 维度和区间是用户选的,轮不到程序改。 */
  locked?: boolean;
  /** 锁死模式下人填的那份参数。 */
  lockedParams?: import("./analysisTypes").LockedParams;
  /** 当前节点是什么时候开始跑的 —— 界面拿它显示「已经等了 N 秒」。
   *  一步要跑一分钟不是问题,看不出它在跑才是问题。 */
  nodeStartedAt?: number;
  /** nodeId → 已重试次数 */
  retry: Record<string, number>;
  /** 真正执行过的节点(按顺序,可能重复)。UI 靠它区分「跑过」和「没轮到」——
   *  只看 status 会把没跑到的步骤也画成绿勾。 */
  trace: string[];
  errors: AgentError[];
  /** 整条链路上被迫放弃的要求(维度不存在、筛选没法表达…)。最终报告里要如实列出。 */
  dropped?: string[];

  // ── 输入 ──────────────────────────────────
  userRequest: string;
  /** 锁定在一个连接上,不跨库。 */
  connId?: string;
  /** 注入的"今天",便于测试和复现历史 workflow。 */
  today: string;

  // ── 各节点产出 ─────────────────────────────
  requirement?: Requirement;
  scope?: ResolvedScope;
  validatedMetrics?: ValidatedMetric[];
  /** 主查询 + 各对比周期的查询。 */
  plans?: { role: "primary" | "mom" | "yoy"; planId: string; dateRange: DateRange }[];
  supportingPlans?: { planId: string; dimensions: string[] }[];
  datasets?: Record<string, DatasetSummary>;
  validation?: { status: "pass" | "warn" | "fail"; summary: string; issues: ValidationIssue[] };
  insights?: Insight[];
  /** 最终给用户的文字结论。 */
  report?: string;
  analysisSummary?: string;

  // ── 建看板(Phase 3)─────────────────────────
  layout?: import("./layout").LayoutPlan;
  review?: { verdict: "pass" | "needs_revision"; summary: string; findings: import("./review").ReviewFinding[] };
  dashboardId?: string;
  /** widgetId → 为什么放它。进 aiProvenance,用户能查「AI 为什么建了这个图」。 */
  widgetReasons?: Record<string, string>;

  // ── 审计 ──────────────────────────────────
  usage: { node: string; ms: number; promptTokens: number; completionTokens: number }[];
}

export function createState(input: { userRequest: string; connId?: string; today?: string; workflowId?: string }): AgentState {
  return {
    workflowId: input.workflowId ?? `wf-${nanoid(12)}`,
    createdAt: new Date().toISOString(),
    status: "running",
    currentNode: "",
    nodeStartedAt: undefined,
    retry: {},
    trace: [],
    errors: [],
    userRequest: input.userRequest,
    connId: input.connId,
    today: input.today ?? localDay(),
    usage: [],
  };
}
