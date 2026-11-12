/**
 * 下钻调查:从大到小,一层层找到根因。
 *
 * 用户要的分析思路(2026-11-10):「分析上月天津战区各渠道经营情况」——先看各渠道总的
 * GMV,哪个有异常;再调那个渠道上月按周 / 按日的明细;再往下钻,直到找到根因。
 *
 * 所以这里不是「查够几个业务面」的铺面式补查,而是一棵调查树:
 *   整体(主查询 + 对比期)
 *    └ 一步:缩小到异常的那块(多一个筛选 / 日期更窄),按一个维度拆开,配一个对比期
 *       └ 再下一步……
 *
 * 每一步的事实由代码算(drillFacts:变化在哪、占总变化几成、哪天偏离最多);
 * 模型只做两件事:读懂这一步说明了什么,决定下一步往哪钻 / 是否已经找到根因。
 *
 * 代码守住的边界:范围只能越钻越小(不能越出用户核对过的筛选和日期),指标和维度
 * 必须是目录里真实支持的,同样的一步不重复查,取回来的数先过数据检查。
 */
import { S } from "./jsonSchema";
import type { NodeFn } from "./graph";
import type { AgentState, DatasetSummary, DrillStep } from "./state";
import type { Metric } from "../metrics/metricTypes";
import type { PlanReader } from "./planReader";
import type { StructuredCaller, ToolCaller } from "./nodes/ports";
import { availableDimensions } from "../dashboard/semantic";
import { validatedMetricsFor, catalogDimensionLabel } from "./analysisCatalog";
import { verdict, type ValidationIssue } from "./validation/dataChecks";
import { allFacts, TIME_DIMENSIONS } from "./drillFacts";
import { describeRange, shiftRange, type DateRange } from "./period";

interface DrillRequest {
  from: string;
  question: string;
  metricIds: string[];
  focus: { field: string; values: string[] }[];
  dateRange?: { start: string; end: string };
  breakdown: string;
  compare: "mom" | "yoy" | "none";
}
interface DrillDecision {
  readings: { stepId: string; reading: string }[];
  decision: "drill" | "done";
  thinking: string;
  drills: DrillRequest[];
  rootCause: string;
  gaps: string[];
}

const DECISION_SCHEMA = S.obj({
  readings: S.arr(S.obj({ stepId: S.str("刚取回数据的那一步的 id"), reading: S.str("这一步的数说明了什么:变化集中在哪、有多大。只用事实里的数字") }, ["stepId", "reading"]), "逐个解读还没解读过的步骤", 6),
  thinking: S.str("现在知道了什么、还缺什么,为什么往下一步钻(或为什么到底了)"),
  decision: S.enumOf(["drill", "done"]),
  drills: S.arr(S.obj({
    from: S.str("从哪一步往下钻:overview 或某一步的 id。新的一步会继承它的范围"),
    question: S.str("这一步要回答什么,用户会看到"),
    metricIds: S.arr(S.str("真实指标 id"), "这一步看哪些指标,通常沿用上一步的", 6),
    focus: S.arr(S.obj({ field: S.str("维度 id"), values: S.arr(S.str("真实取值,照事实里出现的原样写"), "", 50) }, ["field", "values"]), "在上一步范围上再缩小:只看哪些分组(如 渠道=外卖)。不缩小就给空数组", 4),
    dateRange: S.obj({ start: S.date(), end: S.date() }, ["start", "end"], "可选:把日期缩到上一步范围里的一段(如异常集中的那一周)"),
    breakdown: S.str("按哪个维度拆开看(维度 id,时间用 day/week/month)"),
    compare: S.enumOf(["mom", "yoy", "none"], "和上一期还是去年同期比;找异常通常要有对比"),
  }, ["from", "question", "metricIds", "focus", "breakdown", "compare"]), "decision=drill 时给 1-2 步", 2),
  rootCause: S.str("decision=done 时:沿调查路径说清根因。已被数据证实的和推测、待验证的分开写"),
  gaps: S.arr(S.str(), "数据到底了还没证实的、查不了的", 6),
}, ["readings", "thinking", "decision", "drills", "rootCause", "gaps"]);

export interface DrillPorts {
  readCatalog(): Metric[];
  callStructured: StructuredCaller;
  callTool: ToolCaller;
  getPlan: PlanReader;
}

const ROUNDS = 6;

const within = (inner: DateRange, outer: DateRange) => inner.start >= outer.start && inner.end <= outer.end && inner.start <= inner.end;

export function createDrillInvestigator({ readCatalog, callStructured, callTool, getPlan }: DrillPorts): NodeFn {
  return async (initial, context) => {
    context?.signal?.throwIfAborted();
    const state: AgentState = structuredClone(initial);
    const all = structuredClone(readCatalog());
    const anchor = all.find((m) => m.id === state.validatedMetrics?.[0]?.metricId);
    if (!anchor || !state.scope) throw new Error("缺少已核对的分析范围");
    if (state.connId && anchor.connId !== state.connId) throw new Error("分析指标与当前连接不一致，请重新规划");
    const catalog = all.filter((m) => m.enabled && m.connId === anchor.connId && m.database === anchor.database);
    const label = (key: string) => catalogDimensionLabel(catalog, key);
    const scope = state.scope;
    const steps: DrillStep[] = [...(state.drillSteps ?? [])];
    const log = [...(state.investigation ?? [])];
    const overviewMetrics = state.lockedParams?.metricIds ?? (state.validatedMetrics ?? []).map((m) => m.metricId);
    const overviewDims = state.lockedParams?.dimensions ?? [];
    let gaps: string[] = state.evidenceGaps ?? [];
    let rootCause = state.rootCause;

    const scopeOf = (id: string): { focus: DrillStep["focus"]; dateRange: DateRange; metricIds: string[] } => {
      const step = steps.find((s) => s.id === id);
      return step ? { focus: step.focus, dateRange: step.dateRange, metricIds: step.metricIds } : { focus: [], dateRange: scope.dateRange, metricIds: overviewMetrics };
    };
    const describeFocus = (focus: DrillStep["focus"]) => focus.map((f) => `${label(f.field)}=${f.values.join("/")}`).join(" · ");

    /** 校验一步、并把它的范围算出来。不合格返回原因。 */
    const prepare = (req: DrillRequest): DrillStep | string => {
      if (req.from !== "overview" && !steps.some((s) => s.id === req.from && !s.failed)) return `没有可以接着钻的那一步 ${req.from}`;
      const parent = scopeOf(req.from);
      const metricIds = [...new Set(req.metricIds.length ? req.metricIds : parent.metricIds)];
      const metrics = metricIds.map((id) => catalog.find((m) => m.id === id));
      if (metrics.some((m) => !m)) return `指标不在当前连接的目录里:${metricIds.filter((id) => !catalog.some((m) => m.id === id)).join("、")}`;
      const supported = availableDimensions(metrics as Metric[]);
      const breakdown = req.breakdown?.trim() || undefined;
      if (breakdown && !TIME_DIMENSIONS.includes(breakdown) && !supported.includes(breakdown)) return `这些指标不能按「${label(breakdown)}」拆`;
      // 范围:用户核对过的筛选 + 上一步带下来的 + 这一步新加的。只能越来越小。
      const focus = structuredClone(parent.focus);
      for (const f of req.focus) {
        const values = [...new Set(f.values.filter(Boolean))];
        if (!values.length) continue;
        if (!supported.includes(f.field)) return `这些指标不能按「${label(f.field)}」筛`;
        const fromScope = scope.filters.find((s) => s.field === f.field)?.values;
        if (fromScope && values.some((v) => !fromScope.includes(v))) return `「${label(f.field)}」超出了核对过的范围(${fromScope.join("、")})`;
        const inherited = focus.find((x) => x.field === f.field);
        if (inherited) {
          if (values.some((v) => !inherited.values.includes(v))) return `「${label(f.field)}」只能在上一步的 ${inherited.values.join("、")} 里再缩小`;
          inherited.values = values;
        } else focus.push({ field: f.field, values });
      }
      const dateRange = req.dateRange?.start && req.dateRange?.end ? { start: req.dateRange.start, end: req.dateRange.end } : parent.dateRange;
      if (!within(dateRange, parent.dateRange)) return `日期只能在上一步的 ${parent.dateRange.start}~${parent.dateRange.end} 里缩小`;
      const compare = req.compare === "none" ? undefined : req.compare;
      const key = JSON.stringify([metricIds.slice().sort(), focus, dateRange, breakdown ?? "", compare ?? ""]);
      if (steps.some((s) => JSON.stringify([s.metricIds.slice().sort(), s.focus, s.dateRange, s.breakdown ?? "", s.compare ?? ""]) === key)) return "这一步已经查过了";
      const id = `S${steps.length + 1}`;
      const where = [describeFocus(focus), describeRange(dateRange)].filter(Boolean).join(" · ");
      return {
        id, parentId: req.from === "overview" ? undefined : req.from, question: req.question, metricIds, focus, dateRange,
        breakdown, compare, compareRange: compare ? shiftRange(dateRange, compare) : undefined,
        label: where,
      };
    };

    /** 取数 + 体检。范围 = 用户核对过的筛选,叠上这一步的缩小。 */
    const fetch = async (metricIds: string[], focus: DrillStep["focus"], dateRange: DateRange, breakdown?: string): Promise<{ planId: string } | string> => {
      const filters = [...scope.filters.map(({ field, values }) => ({ field, values }))];
      for (const f of focus) {
        const at = filters.findIndex((x) => x.field === f.field);
        if (at >= 0) filters[at] = { field: f.field, values: f.values }; else filters.push({ field: f.field, values: f.values });
      }
      const grain = breakdown && TIME_DIMENSIONS.includes(breakdown) ? breakdown as "day" : scope.grain;
      const built = await callTool<{ planId: string }>("build_query_plan", { metricIds, dimensions: breakdown ? [breakdown] : [], dateRange, filters, grain }, state.workflowId);
      context?.signal?.throwIfAborted();
      if (!built.ok) return built.error?.message ?? "没建成查询";
      const planId = built.data!.planId;
      const data = await callTool<DatasetSummary>("execute_query_plan", { planId, maxRows: 20000, preview: 5 }, state.workflowId);
      context?.signal?.throwIfAborted();
      if (!data.ok) return data.error?.message ?? "取数失败";
      const checked = await callTool<{ issues: ValidationIssue[] }>("validate_dataset", { planId, checkTotals: true }, state.workflowId);
      context?.signal?.throwIfAborted();
      if (!checked.ok || checked.data!.issues.some((i) => i.level === "fail")) {
        return `数据检查没通过:${(checked.data?.issues ?? []).filter((i) => i.level === "fail").map((i) => i.message).join(";") || checked.error?.message}`;
      }
      const warnings = checked.data!.issues.filter((i) => i.level !== "fail");
      if (warnings.length) {
        const issues = [...(state.validation?.issues ?? []), ...warnings];
        state.validation = { ...verdict(issues), issues };
      }
      state.datasets = { ...state.datasets, [planId]: data.data! };
      return { planId };
    };

    for (let round = 0; round < ROUNDS; round++) {
      context?.signal?.throwIfAborted();
      state.drillSteps = steps;
      const facts = allFacts(state, getPlan, label);
      const tree = steps.map((s) => ({
        id: s.id, from: s.parentId ?? "overview", question: s.question, scope: s.label, breakdown: s.breakdown ? label(s.breakdown) : "不拆",
        compare: s.compare ?? "none", metrics: s.metricIds, reading: s.reading ?? "(待你解读)", failed: s.failed,
        facts: facts.filter((f) => f.id.startsWith(`${s.id}-`)).map((f) => f.text),
      }));
      const result = await callStructured<DrillDecision>({
        role: "reasoning", node: "DrillInvestigator", name: "drill_decision", schema: DECISION_SCHEMA, signal: context?.signal,
        system: `你是经营分析师,在做一次从大到小的下钻调查。

思路:先看整体和各分组跟对比期比变了多少,找出变化最大、最反常的那一块;然后缩小到那一块,
按时间(周 / 日)或更细的维度拆开,看问题集中在哪几天、哪几家、哪个品类;一层层往下,
直到能说清根因,或者数据已经拆不动了。每一步都要说明为什么往这里钻。
不要横向铺开去看一堆无关指标;也不要只看一层就下结论。没有异常就如实说没有。

怎么读:事实都是程序从真实数据算出来的,只能引用里面的数字。「占总变化 x%」说明这块贡献了多少变化;
「偏离同星期几均值」说明那天比平常的同一天反常。
可钻的维度:每个指标支持的维度见目录;时间用 day/week/month。只能在上一步的范围里再缩小,
筛选取值要照事实里出现的原样写。同一步不要重复。

还剩 ${ROUNDS - round} 轮(每轮最多 2 步)。最后一轮必须 done。
用户问题:${state.userRequest}
用户核对过的范围:${JSON.stringify({ 日期: scope.dateRange, 筛选: scope.filters.map((f) => `${label(f.field)}=${f.values.join("/")}`), 对比: scope.comparisonRanges })}
整体那一层(overview):指标 ${JSON.stringify(overviewMetrics)},按 ${overviewDims.map(label).join("、") || "不拆"}
指标目录:${JSON.stringify(catalog.map((m) => ({ id: m.id, name: m.name, unit: m.unit, caliber: m.caliber, dimensions: availableDimensions([m]).map((d) => ({ id: d, name: label(d) })) })))}
整体那一层的事实:
${facts.filter((f) => !/^S\d+-/.test(f.id)).map((f) => `[${f.id}] ${f.text}`).join("\n") || "(无)"}
已经走过的步骤:${JSON.stringify(tree)}`,
        user: "读完已有的数据,决定下一步往哪钻,或者给出根因。",
      }, context?.modelConfig);
      context?.signal?.throwIfAborted();
      state.usage = [...state.usage, { node: "DrillInvestigator", ms: result.ms, promptTokens: result.promptTokens, completionTokens: result.completionTokens }];
      if (!result.ok || !result.data) throw new Error(`下钻调查失败:${result.errors?.join(";")}`);
      const decision = result.data;
      for (const r of decision.readings) {
        const step = steps.find((s) => s.id === r.stepId);
        if (step && r.reading.trim()) step.reading = r.reading.trim();
      }
      log.push(`思路:${decision.thinking}`);
      gaps = decision.gaps;
      if (decision.decision === "done" || round === ROUNDS - 1) {
        rootCause = decision.rootCause?.trim() || rootCause;
        if (decision.decision !== "done") gaps = [...gaps, "调查轮数用完了,最后一步还没来得及解读。"];
        break;
      }
      let progressed = false;
      for (const req of decision.drills.slice(0, 2)) {
        context?.signal?.throwIfAborted();
        const prepared = prepare(req);
        if (typeof prepared === "string") { log.push(`没钻「${req.question}」:${prepared}`); continue; }
        const main = await fetch(prepared.metricIds, prepared.focus, prepared.dateRange, prepared.breakdown);
        context?.signal?.throwIfAborted();
        if (typeof main === "string") {
          steps.push({ ...prepared, failed: main });
          log.push(`下钻 ${prepared.id}「${prepared.question}」没取到数:${main}`);
          continue;
        }
        prepared.planId = main.planId;
        if (prepared.compare && prepared.compareRange) {
          const base = await fetch(prepared.metricIds, prepared.focus, prepared.compareRange, prepared.breakdown);
          if (typeof base === "string") log.push(`${prepared.id} 的对比期没取到:${base}`);
          else prepared.comparePlanId = base.planId;
        }
        const known = new Map((state.validatedMetrics ?? []).map((m) => [m.metricId, m]));
        validatedMetricsFor(prepared.metricIds, all).forEach((m) => known.set(m.metricId, m));
        state.validatedMetrics = [...known.values()];
        steps.push(prepared);
        log.push(`下钻 ${prepared.id}${prepared.parentId ? `(接 ${prepared.parentId})` : ""}:${prepared.label}${prepared.breakdown ? `,按${label(prepared.breakdown)}拆` : ""} —— ${prepared.question}`);
        progressed = true;
      }
      if (!progressed) log.push("这一轮没有取到新数据,换个方向或者收尾。");
    }

    return {
      ...state, drillSteps: steps, investigation: log, evidenceGaps: gaps, rootCause,
      analysisAngle: rootCause ? `${state.analysisAngle ?? ""}\n调查结论:${rootCause}`.trim() : state.analysisAngle,
    };
  };
}
