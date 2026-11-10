import { observedPlans, reviewContext } from "./observations";
import { S } from "../jsonSchema";
import { BANDS, resolveLayout, type LayoutPlan } from "../layout";
import { reviewLayout, reviewVerdict, applyFixes, applyJudgement, type Judgement, type ReviewFinding } from "../review";
import type { AgentState } from "../state";
import type { AiConfig } from "../../ai/aiTypes";
import type { NodeFn } from "../graph";
import type { PlanReader } from "../planReader";
import type { StructuredCaller } from "./ports";

const JUDGEMENT_SCHEMA = S.obj(
  {
    verdict: S.enumOf(["pass", "needs_revision"], "整体过不过"),
    findings: S.arr(
      S.obj(
        {
          index: S.int("第几个组件(从 0 数);整体性问题填 -1", -1, 20),
          issue: S.str("一句话说清问题"),
          severity: S.enumOf(["must_fix", "should_fix", "nit"]),
          fix: S.obj(
            {
              title: S.str("改成什么标题"),
              subtitle: S.str("改成什么口径小字"),
              band: S.enumOf(BANDS, "可选;只在需要把某块改成排名(横向+降序)时给"),
              drop: S.bool("这个组件多余,删掉"),
            },
            [],
            "能直接改就给,改不了就别填这个字段",
          ),
        },
        ["index", "issue", "severity"],
      ),
      "最多说 5 条,按重要性排",
      5,
    ),
  },
  ["verdict", "findings"],
);

export function createDashboardReviewer({ callStructured, getPlan }: { callStructured: StructuredCaller; getPlan: PlanReader; }): NodeFn {
  /** 需要判断力的那一半 —— 代码规则管不了的事。跑在代码规则之后。 */
  async function judgeLayout(state: AgentState, items: LayoutPlan["items"], signal?: AbortSignal, modelConfig?: AiConfig): Promise<{
    patched: LayoutPlan["items"]; applied: string[]; remaining: ReviewFinding[];
    usage?: { ms: number; promptTokens: number; completionTokens: number; };
  }> {
    const metrics = new Map((state.validatedMetrics ?? []).map((m) => [m.metricId, m]));
    const listing = items
      .map((item, i) =>
        `${i}. ${item.band ? `[${item.band}] ` : ""}${item.type} 「${item.title}」${item.subtitle ? `(副标题:${item.subtitle})` : ""} ` +
        `指标=${item.metricIds.map((id) => metrics.get(id)?.name ?? id).join("+")} ` +
        `维度=${item.dimensions.join("+") || "无"}${item.topN ? ` 前${item.topN}` : ""}`)
      .join("\n");

    const result = await callStructured<Judgement>({
      signal,
      role: "review",
      node: "DashboardReviewer",
      name: "judgement",
      schema: JUDGEMENT_SCHEMA,
      system: `你是看板验收员。下面这个看板的**技术问题已经由程序检查过并修好了**
(组件要的数据个数够不够、KPI 是否带维度、是否重复、是否越界、数字换算)。
用哪种组件是设计师的决定,不归你管。

**不要再说这些。** 你只看程序判不了的:

1. 标题说不说人话。「图1」「bar chart」「销售额分析」这种要改成一眼能看懂的,
   比如「8月各网点销售额排名」。副标题该写口径的就写口径。
2. 有没有**内容上**重复表达同一件事 —— 类型指标维度不完全相同、程序抓不到,
   但看着就是在说同一句话的两张图。
3. 针对用户的问题,**该有的有没有**。缺了关键的一块要说。

规矩:
- 能直接改的就填 fix(只能改标题/副标题,或者标记 drop 删掉多余的组件)。
  **不要试图改指标绑定** —— 指标是经过验证的,你动不了。
- 没问题就 verdict=pass、findings 空数组。别为了显得有用硬挑毛病。
- 最多 5 条。

用户当初的问题:${state.userRequest}
数据范围:${state.scope?.label ?? "未知"}
已经算出来的结论:
${(state.insights ?? []).map((i) => `  · ${i.headline}`).join("\n") || "  (无)"}`,
      user: `看板「${state.layout?.title}」的组件:\n${listing}`,
    }, modelConfig);

    signal?.throwIfAborted();
    if (!result.ok || !result.data) {
      // 判断层挂了不该拖垮整个流程 —— 代码规则已经把会误导人的问题挡掉了
      return { patched: items, applied: [], remaining: [] };
    }
    const applied = applyJudgement(items, result.data);
    return {
      ...applied, patched: applied.items,
      usage: { ms: result.ms, promptTokens: result.promptTokens, completionTokens: result.completionTokens }
    };
  }

  const dashboardReviewer: NodeFn = async (state, context) => {
    context?.signal?.throwIfAborted();
    const layout = state.layout;
    if (!layout) throw new Error("没有版面可检查");
    const plans = observedPlans(state, getPlan);
    const recheck = (items: LayoutPlan["items"]) =>
      reviewLayout(resolveLayout(items), reviewContext(items, state, plans));
    const findings = recheck(layout.items);
    const { verdict } = reviewVerdict(findings);
    const codePass = verdict === "pass";
    const patched = codePass
      ? { items: layout.items, applied: [] as string[], remaining: [] as ReviewFinding[] }
      : applyFixes(layout.items, findings, recheck);

    // 技术问题处理完了,再让模型看判断层面的事(标题、重复表达、层级、缺没缺东西)
    const judged = await judgeLayout({ ...state, layout: { ...layout, items: patched.items } }, patched.items, context?.signal, context?.modelConfig);
    const applied = [...patched.applied, ...judged.applied];
    // Model edits can remove or rename cards; validate the actual final composition again.
    const remaining = [...recheck(judged.patched), ...judged.remaining];

    return {
      layout: { ...layout, items: judged.patched },
      review: {
        verdict: remaining.some((f) => f.severity === "must_fix") ? "needs_revision" : "pass",
        summary: applied.length
          ? `自动修了 ${applied.length} 处:${[...new Set(applied)].join("、")}`
          : "版面检查通过。",
        findings: remaining,
      },
      usage: judged.usage ? [...state.usage, { node: "DashboardReviewer", ...judged.usage }] : state.usage,
    };
  };


  return dashboardReviewer;
}
