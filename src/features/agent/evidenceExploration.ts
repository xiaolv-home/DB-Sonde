import { S } from "./jsonSchema";
import type { NodeFn } from "./graph";
import type { AgentState } from "./state";
import type { Metric } from "../metrics/metricTypes";
import type { PlanReader } from "./planReader";
import type { StructuredCaller } from "./nodes/ports";
import { allFacts } from "./drillFacts";
import { catalogDimensionLabel } from "./analysisCatalog";

/* 原来这里还有一个「铺面式」补查器(EvidenceExplorer):要求查够各个业务面,补查只能沿用最初的范围。
   用户要的是从大到小一层层钻到根因,已换成 drillInvestigator.ts。这里只留结论复核。 */

export interface EvidencePorts {
  readCatalog(): Metric[];
  callStructured: StructuredCaller;
  getPlan: PlanReader;
}

/* issues 只放**必须改**的。核对过没问题的写进 checked —— 它不回灌给写作节点。
   原来两者混在一条数组里:复核列了八条,六条自己写着「此项可接受」「不构成错误」,
   全被当成「逐项修正」喂回去,写作节点照着改一轮,下一轮复核又列一遍。 */
const REVIEW_SCHEMA = S.obj({
  verdict: S.enumOf(["pass", "revise"]),
  issues: S.arr(S.str(), "只写必须修改的:无证据支持的数字、错误口径、漏答、把猜测说成已证实的因果。核对过没问题的不要写在这里", 8),
  checked: S.arr(S.str(), "核对过、确认没问题的要点(不会要求修改)", 8),
}, ["verdict", "issues"]);

/** Independent review of the written answer against evidence, before dashboard generation. */
/**
 * 独立复核:拿报告和证据逐条对。
 *
 * 给它的上下文里**必须带上数据体检的结论** —— 写报告那个节点被要求「体检有提醒就在
 * 结论里交代」,而这儿原来看不到体检结果,于是报告里那句「数据体检提示 2 处 MANY_NULLS」
 * 在复核眼里成了「无证据支持的说法」。只要体检是 warn,报告就必然被判不通过,
 * 两轮之后整个分析作废 —— 而它交代得完全正确。
 */
export function createConclusionReviewer({ readCatalog, callStructured, getPlan }: EvidencePorts): NodeFn {
  return async (state, context) => {
    context?.signal?.throwIfAborted();
    const catalog = structuredClone(readCatalog()).filter(metric => metric.connId === state.connId);
    const analyze = (value: AgentState) => allFacts(value, getPlan, key => catalogDimensionLabel(catalog, key));
    const result = await callStructured<{ verdict: "pass" | "revise"; issues: string[]; checked?: string[]; }>({
      role: "review", node: "ConclusionReviewer", name: "conclusion_review", schema: REVIEW_SCHEMA, signal: context?.signal,
      system: `核对分析报告是否准确回答了问题。只检查事实质量，不要求固定措辞、条数或文风。
issues 里只写**必须修改**的;核对过没问题的放 checked,不要写进 issues —— 那会被当成返工要求。
verdict 只看 issues:issues 为空就是 pass。
逐项核对数字、比率分母、日期、分组、样本覆盖、因果与相关的区别。报告里的数字必须能从给定证据核对。
允许有明确标记的假设和下一步验证建议；不得把假设说成已证实原因。真实不可用的数据可以如实承认，不要求无依据的因果；目录中可用但未查不等于缺数据，报告应明确这是调查未完成，不能宣称全面。
覆盖计划：${JSON.stringify(state.coveragePlan ?? [])}
调查与取舍：${JSON.stringify(state.investigation ?? [])}
问题：${state.userRequest}\n实际范围：${JSON.stringify(state.scope)}\n证据缺口：${JSON.stringify(state.evidenceGaps ?? [])}
数据体检：${state.validation ? JSON.stringify({ 结论: state.validation.summary, 明细: state.validation.issues.map((i) => `${i.level === "fail" ? "需修正" : "提醒"} ${i.code}：${i.message}`) }) : "没有体检记录"}
证据：\n${analyze(state).map((f) => `[${f.id}] ${f.text}`).join("\n")}`,
      user: state.report ?? state.analysisSummary ?? "没有报告",
    }, context?.modelConfig);
    context?.signal?.throwIfAborted();
    if (!result.ok || !result.data) throw new Error(`结论复核失败：${result.errors?.join("；")}`);
    return { conclusionReview: result.data, usage: [...state.usage, { node: "ConclusionReviewer", ms: result.ms, promptTokens: result.promptTokens, completionTokens: result.completionTokens }] };
  };

}
