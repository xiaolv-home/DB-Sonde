import { S } from "./jsonSchema";
import type { NodeFn } from "./graph";
import type { LockedParams } from "./analysisTypes";
import type { Metric } from "../metrics/metricTypes";
import type { DashboardDataset } from "../dashboard/domain";
import type { StructuredCaller } from "./nodes/ports";
import { availableDimensions } from "../dashboard/semantic";
import { validatedMetricsFor, catalogDimensionLabel, catalogConnection } from "./analysisCatalog";
import { matchDimensionValue } from "../../lib/dimensionMatching";
import { prepareQueryPlan } from "./queryPlanModel";
import { describeRange, fmt, shiftRange } from "./period";

export interface QuestionPlan {
  metricIds: string[];
  dimensions: string[];
  period: { kind: "explicit" | "last_n_months" | "last_n_days" | "this_month" | "this_year" | "last_year"; start: string; end: string; count: number; };
  comparisons: ("mom" | "yoy")[];
  filters: { field: string; values: string[]; }[];
  angle: string;
  assumptions: string[];
  questions: string[];
  coverage: { area: string; metricIds: string[]; disposition: "selected" | "deferred" | "irrelevant"; reason: string; }[];
}
const SCHEMA = S.obj({
  metricIds: S.arr(S.str(), "第一层看的核心指标 id;更细的在下钻时再加", 8),
  dimensions: S.arr(S.str(), "需要的分组，含适用的时间粒度。不要把指标当维度", 3),
  period: S.obj({ kind: S.enumOf(["explicit", "last_n_months", "last_n_days", "this_month", "this_year", "last_year"]), start: S.str(), end: S.str(), count: S.int("最近几个完整月或天", 1, 366) }, ["kind", "start", "end", "count"]),
  comparisons: S.arr(S.enumOf(["mom", "yoy"]), "对比基准,至少一个(默认 mom)—— 没有对比就判断不了异常", 2),
  filters: S.arr(S.obj({ field: S.str(), values: S.arr(S.str(), "用户提到的分组取值，稍后核对真实清单", 30) }, ["field", "values"]), "不得漏掉用户明确指定的范围", 8),
  coverage: S.arr(S.obj({ area: S.str("从真实目录归纳的业务主题"), metricIds: S.arr(S.str(), "涉及的真实指标 id", 20), disposition: S.enumOf(["selected", "deferred", "irrelevant"]), reason: S.str("为什么选入、后续调查或与本题无关") }, ["area", "metricIds", "disposition", "reason"]), "先审视目录的相关业务面，再决定首批指标；不是固定业务清单", 20),
  angle: S.str("本次要回答的具体问题与分析路径"),
  assumptions: S.arr(S.str(), "采用的默认范围等，必须公开", 5),
  questions: S.arr(S.str(), "仅关键含义无法确定时询问，否则空数组", 2),
}, ["metricIds", "dimensions", "period", "comparisons", "filters", "angle", "assumptions", "questions", "coverage"]);

/** Calendar arithmetic is deterministic; the model chooses the period's meaning. */
export function questionRange(period: QuestionPlan["period"], today: string) {
  const [y, m, d] = today.split("-").map(Number);
  const count = Math.max(1, Math.min(366, period.count));
  switch (period.kind) {
    case "explicit": return { start: period.start, end: period.end };
    case "last_n_months": return { start: fmt(new Date(y, m - 1 - count, 1)), end: fmt(new Date(y, m - 1, 0)) };
    case "last_n_days": return { start: fmt(new Date(y, m - 1, d - count)), end: fmt(new Date(y, m - 1, d - 1)) };
    case "this_month": return { start: fmt(new Date(y, m - 1, 1)), end: today };
    case "this_year": return { start: `${y}-01-01`, end: today };
    case "last_year": return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };
  }
}

/** Explicit group counts are scope constraints, not permission to take an arbitrary TopN. */
export function requestedGroupCounts(question: string, dimensions: { id: string; label: string; }[]) {
  const digit = (text: string): number => {
    if (/^\d+$/.test(text)) return Number(text);
    const numbers: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (!text.includes("十")) return numbers[text] ?? 0;
    const [tens, ones] = text.split("十");
    return (tens ? numbers[tens] ?? 0 : 1) * 10 + (numbers[ones] ?? 0);
  };
  return dimensions.flatMap(({ id, label }) => {
    if (["day", "week", "month", "year"].includes(id)) return [];
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`([0-9]+|[一二两三四五六七八九十]+)\\s*(?:大|个|家|位)?\\s*${escaped}`).exec(question);
    // Rankings are analytical choices, not an explicitly named business population.
    if (!match || /(?:前|后|第|top)\s*$/i.test(question.slice(0, match.index))) return [];
    const count = digit(match[1]);
    return count > 0 ? [{ field: id, label, count }] : [];
  });
}

export interface QuestionPlannerPorts {
  readCatalog(): Metric[];
  callStructured: StructuredCaller;
  dimensionValues(dataset: DashboardDataset, field: string, limit: number, search: string, catalog: Metric[]): Promise<string[] | null>;
}
export function createQuestionPlanner({ readCatalog, callStructured, dimensionValues }: QuestionPlannerPorts): NodeFn {
  return async (state, context) => {
    context?.signal?.throwIfAborted();
    const all = structuredClone(readCatalog());
    const catalog = all.filter((m) => m.enabled && m.connId === state.connId);
    if (!catalog.length) {
      /* 指标一个没少、只是挂在别的连接上时,不能只说"没有可用指标" ——
         那会让人以为指标中心是空的,跑去重配一遍。把真实去处说出来。
         这条也不该走 needs_input:让用户在输入框里补什么都改不了连接,
         给一个填不出答案的框比直接报错更糟。 */
      const elsewhere = catalogConnection(all, state.connId ?? "").candidates;
      return {
        status: "failed" as const,
        errors: [...state.errors, {
          node: "QuestionPlanner",
          message: elsewhere.length
            ? `当前连接上没有启用的指标。你的指标在${elsewhere.map((c) => `「${c.connName || c.connId}」(${c.count} 个)`).join("、")}上 —— ` +
              `在左边把连接切过去,或者到指标中心把口径挂到当前连接。`
            : "指标中心里还没有启用的指标,先去配一个口径再来分析。",
          at: new Date().toISOString(),
        }],
      };
    }
    const menu = catalog.map((m) => ({
      id: m.id, name: m.name, aliases: m.aliases, database: m.database,
      category: m.category, unit: m.unit, caliber: m.caliber, dimensions: availableDimensions([m]).map((id) => ({ id, name: catalogDimensionLabel([m], id) }))
    }));
    let feedback = "";
    const usage = [...state.usage];
    for (let attempt = 0; attempt < 2; attempt++) {
      context?.signal?.throwIfAborted();
      const result = await callStructured<QuestionPlan>({
        role: "reasoning", node: "QuestionPlanner", name: "question_plan", schema: SCHEMA,
        signal: context?.signal, system: `你是数据库业务分析师。根据用户的问题自主选择指标、日期、分组、筛选和对比，不要求用户填写配置表。
只使用以下当前连接的真实指标清单，不编 id，不写 SQL，不跨数据库拼指标。
明确的日期、指标、地区、人员范围必须遵守；有些要求不支持或关键含义有歧义时 questions 写出具体问题，不要静默忽略。
没有说日期且没有可继承的上下文，默认最近 3 个完整自然月（last_n_months, count=3），在 assumptions 中说明。
中文“6-8月”表示完整的三个月，不是6月8日；没说年份时结合今天采用最近已结束的对应区间并说明年份。日期运算交给程序。
这是一次「从大到小」调查的第一层:先看全局,找出哪块异常,后面会一层层往下钻(按周/日、按更细的分组),直到找到原因。
所以这一层选能直接回答问题的核心指标(比如经营情况先看 GMV、单量、客单价这类),按用户关心的分组拆开(「各渠道」就按渠道),
并且一定要有对比基准(默认环比;问题涉及同期、季节性就加同比)—— 没有对比就看不出谁异常。不用在这一步把所有指标、所有维度都查上。
coverage 记录相关的业务主题:这一层就看的标 selected,留给后面下钻时再看的标 deferred。
用户指定“六大/6个”等分组数量时，不能默认当作全部分组，更不能擅自猜哪几个或排除哪些；无可验证的名单/上下文时提出具体歧义。
选择能回答问题的维度，不是每个维度都选。问题关心谁、哪里就选择对应的业务维度。要比较变化才加入时间粒度。
分析范围已经明确时不要问“要哪些指标、用什么图、前几名”。这些是你的工作。除非用户明确要求，图表不要固定前5名。
绝不要问取值的准确名称（“××在该维度下叫什么”）。把用户的原话原样填进 filters.values 就行，程序会去库里核对并自动补全（“华东大区”→ 真实取值）；真核不上时程序会带着库里的实际取值去问，不用你代劳。
“各××/每个××/分××看”就是按这个维度分组展开，不要再问“要明细还是汇总”。
追问应继承上一轮已确定的范围，按新问题增减指标或分组；新问题明确覆盖的部分优先。
今天：${state.today}
真实指标：${JSON.stringify(menu)}
上一轮已核对的范围：${JSON.stringify(state.previousParams ?? null)}
此前对话：${JSON.stringify(state.conversation ?? [])}
${feedback ? `上次计划无法执行，请修正；若无法确定则提出具体问题：${feedback}` : ""}`,
        user: state.userRequest,
      }, context?.modelConfig);
      context?.signal?.throwIfAborted();
      usage.push({ node: "QuestionPlanner", ms: result.ms, promptTokens: result.promptTokens, completionTokens: result.completionTokens });
      if (!result.ok || !result.data) throw new Error(`理解问题失败：${result.errors?.join("；")}`);
      const plan = result.data;
      /* 同一个问题不许问第二遍。用户答完了它又原样问一遍 —— 这时再抛回去只会无限循环,
         而且用户已经没有别的话可说了。schema 里 metricIds/filters/period 都是必填,
         所以**抛问题的同时计划其实是完整的**:与其空转,不如照这份计划往下走,
         把没答上的问题如实记进"尚未满足的要求"。真有硬伤,后面核对筛选值那步会拦住。 */
      const askedBefore = (state.conversation ?? []).filter((m) => m.role === "assistant").map((m) => m.content);
      const repeated = plan.questions.length > 0 && askedBefore.includes(plan.questions.join("\n"));
      if (plan.questions.length && !repeated) return { status: "needs_input", clarification: plan.questions.join("\n"), usage };
      const unanswered = repeated ? plan.questions.map((q) => `这个问题我问过一遍没能问清,先按自己的理解做了:${q}`) : [];
      try {
        if (!plan.metricIds.length || plan.metricIds.some((id) => !catalog.some((m) => m.id === id))) throw new Error("必须从当前连接的指标清单选择有效指标");
        if (plan.coverage.some((entry) => entry.metricIds.some((id) => !catalog.some((m) => m.id === id)))) throw new Error("分析覆盖计划引用了目录外指标");
        const dateRange = questionRange(plan.period, state.today);
        const params: LockedParams = {
          metricIds: [...new Set(plan.metricIds)], dimensions: [...new Set(plan.dimensions)], dateRange,
          // 没有对比期就判断不了哪块异常 —— 模型漏了就补环比
          comparisons: plan.comparisons.length ? [...new Set(plan.comparisons)] : ["mom"], filters: structuredClone(plan.filters), focus: state.userRequest, wantsDashboard: state.requirement?.wantsDashboard ?? true
        };
        // Semantic compiler validates connection, database, dimensions, filters and calendar before any query.
        const { dataset } = prepareQueryPlan(params, all);
        const metrics = catalog.filter((m) => params.metricIds.includes(m.id));
        const dimensionLabel = (key: string) => catalogDimensionLabel(metrics, key);
        const filters: LockedParams["filters"] = [];
        for (const filter of params.filters) {
          const values: string[] = [];
          for (const text of filter.values) {
            context?.signal?.throwIfAborted();
            const candidates = await dimensionValues(dataset, filter.field, 301, text, all);
            context?.signal?.throwIfAborted();
            const matches = candidates ? matchDimensionValue(candidates, text) : [];
            if (matches.length !== 1 || (candidates!.length >= 301 && matches[0] !== text)) {
              return {
                status: "needs_input", usage, clarification: matches.length > 1
                  ? `“${text}”对应多个${dimensionLabel(filter.field)}：${matches.slice(0, 8).join("、")}。你指的是哪一个？`
                  : `暂时无法把“${text}”核对到${dimensionLabel(filter.field)}的真实取值。请补充准确名称，或明确取消这个筛选。`
              };
            }
            values.push(matches[0]);
          }
          if (values.length) filters.push({ field: filter.field, values: [...new Set(values)] });
        }
        // Verify explicit population counts against resolved filters or the real dimension menu.
        const scopeCounts = requestedGroupCounts(state.userRequest, availableDimensions(metrics).map((id) => ({ id, label: metrics.find((m) => m.dimensionLabels?.[id])?.dimensionLabels?.[id] ?? dimensionLabel(id) })));
        for (const expected of scopeCounts) {
          const explicit = filters.find((f) => f.field === expected.field)?.values;
          const values = explicit ?? await dimensionValues(dataset, expected.field, 301, "", all);
          context?.signal?.throwIfAborted();
          if (!values || values.length !== expected.count || values.length >= 301) {
            return { status: "needs_input", usage, clarification: `你指定了${expected.count}个${expected.label}，${values ? `当前可核对到${values.length}个：${values.slice(0, 20).join("、")}` : "但当前无法核对完整名单"}。请说明具体包含哪些，不能默认扩大为全部或任取前${expected.count}个。` };
          }
          if (!explicit) filters.push({ field: expected.field, values });
        }
        params.filters = filters;
        const label = describeRange(dateRange);
        return {
          lockedParams: params, validatedMetrics: validatedMetricsFor(params.metricIds, all),
          coveragePlan: plan.coverage, analysisAngle: plan.angle, assumptions: plan.assumptions, usage, clarification: undefined,
          ...(unanswered.length ? { dropped: [...new Set([...(state.dropped ?? []), ...unanswered])] } : {}),
          investigation: plan.coverage.map((entry) => `分析覆盖 · ${entry.area}（${{ selected: "首批", deferred: "待调查", irrelevant: "本题不展开" }[entry.disposition]}）：${entry.reason}`),
          requirement: { goal: state.userRequest, subject: label, audience: "analyst", candidateMetricTerms: [], candidateDimensions: params.dimensions, comparisons: params.comparisons, wantsDashboard: params.wantsDashboard },
          scope: {
            dateRange, grain: (params.dimensions.find((d) => ["day", "week", "month", "year"].includes(d)) ?? "day") as "day", label,
            filters: filters.map((f) => ({ ...f, resolvedFrom: f.values.join("、") })), comparisonRanges: params.comparisons.map((kind) => ({ kind, ...shiftRange(dateRange, kind) }))
          },
        };
      } catch (error) { context?.signal?.throwIfAborted(); feedback = String(error).replace(/^Error:\s*/, ""); }
    }
    return { status: "needs_input", clarification: `这个问题目前还不能直接执行：${feedback}。请补充你希望分析的具体业务对象。`, usage };
  };

}
