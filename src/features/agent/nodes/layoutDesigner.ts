import { normalizeDesignUnits } from "../designUnits";
import { S } from "../jsonSchema";
import { STYLE_PROPERTIES } from "../styleSchema";
import { BANDS, WIDTHS, type LayoutPlan } from "../layout";
import { WIDGET_TYPES, LEAF_WIDGET_TYPES } from "../../dashboard/domain";
import { designCapabilityGuide, validateDesignBindings } from "../designContracts";
import { refineAnalysisLayout } from "../presentation";
import type { AgentState } from "../state";
import type { NodeFn } from "../graph";
import type { PlanReader } from "../planReader";
import type { StructuredCaller } from "./ports";

/** presets.css 的可用预设；分析默认使用简洁主题。 */
export const VISUAL_PRESETS = [
  "editorial", "aurora", "ocean", "violet", "sunset", "glass", "gold", "jade", "rose",
  "ember", "cyber", "slate", "mint", "amber", "plum", "coral", "indigo",
] as const;

export const LAYOUT_SCHEMA = S.obj(
  {
    title: S.str("看板标题"),
    description: S.str("一句话说明这个看板回答什么问题"),
    theme: S.str("这一版的设计思路 —— 为什么这么排、为什么用这套色。用户会看到"),
    preset: S.enumOf(VISUAL_PRESETS, "视觉基调，分析默认简洁中性色；用图表颜色区分业务系列"),
    palette: S.arr(S.str("#RRGGBB"), "整板默认配色,单个组件可覆盖", 8),
    items: {
      type: "array", minItems: 2, maxItems: 14,
      items: S.obj(
        {
          band: S.enumOf(BANDS, "可选,**不用每块都填**。它只改两件事:填 ranking 时柱形默认横向、并按指标降序排(叫排名就得真排过)。不决定位置,也不是要你凑齐五种角色"),
          type: S.enumOf([...WIDGET_TYPES], "组件类型;text 是纯文字块,用来写小标题、口径注释、结论"),
          title: S.str("组件标题,说人话"),
          subtitle: S.str("标题下的口径小字,可选"),
          footnote: S.str("卡片底部小字:数据截至、注意事项,可选"),
          content: S.str("type=text 时的正文,支持换行"),
          metricIds: S.arr(S.str("必须来自已验证的指标 id"), "绑定的指标;text 块给空数组"),
          dimensions: S.arr(S.str(), "分析维度。KPI 和 text 一定给空数组"),
          x: S.int("左上角横坐标,0-11 栏", 0, 11),
          y: S.int("左上角纵坐标,行号从 0 开始", 0, 60),
          w: S.int("占几栏,1-12", 1, 12),
          h: S.int("占几行", 1, 20),
          width: S.enumOf(WIDTHS, "宽度档(给了 w 就可以不填)"),
          reason: S.str("为什么放它、为什么用这种图 —— 用户会看到"),
          scale: S.enumOf(["none", "wan", "yi", "auto"], "大额金额换算；同一张卡上量级差很远就用 auto"),
          ...STYLE_PROPERTIES,
          secondaryMetricIds: S.arr(S.str(), "副指标，必须已验证"), seriesDimension: S.str("图例维度"),
          visible: S.bool("默认可见"), filtersEnabled: S.bool("单卡筛选器"), filterFields: S.arr(S.str(), "组件筛选字段:数据集里的维度字段名。'date' 是保留名,渲染成日期区间"),
        },
        ["type", "title", "metricIds", "dimensions", "reason"],
      ),
    },
  },
  ["title", "theme", "preset", "items"],
);

// Only one level of containers; a finite schema and a finite render budget.
const childSchema = structuredClone(LAYOUT_SCHEMA.properties!.items.items!);
childSchema.properties!.type = S.enumOf([...LEAF_WIDGET_TYPES]);
LAYOUT_SCHEMA.properties!.items.items!.properties!.tabs = S.arr(S.obj({ title: S.str("分页标题"), items: S.arr(childSchema, "这一页的组件", 12) }, ["title", "items"]), "容器分页，最多六页", 6);

export function createLayoutDesigner({ callStructured, getPlan }: { callStructured: StructuredCaller; getPlan: PlanReader; }) {
  /**
   * 给设计节点看的数据形状。
   *
   * **默认只给形状,不给内容。** 设置里那个「把样本行发给模型」默认是关的,
   * 可这条路上从来没人读过它 —— `grep includeSampleRows src/features/agent/` 零命中。
   * 于是每次分析都会把每个维度的 8 个真实取值(网点名、**主管姓名**)和 3 行真实数据
   * 发给云端模型,而用户以为自己关掉了。
   *
   * 版面设计需要的是「这个维度有多少个取值、有没有时间列、多少行」——
   * 这些形状信息足够决定用什么图、排几栏。真实取值是**额外的**,
   * 只在用户明确打开开关时才给。
   */
  function designDataViews(state: AgentState, includeSamples: boolean) {
    return [...(state.plans ?? []), ...(state.supportingPlans ?? [])].flatMap((ref) => {
      const plan = getPlan(ref.planId);
      if (!plan?.result) return [];
      return [{
        planId: ref.planId, metricIds: plan.metricIds,
        dimensions: plan.shape.dimensions.map((id) => {
          const index = plan.result!.columns.findIndex((c) => c.name === id);
          const values = index < 0 ? [] : [...new Set(plan.result!.rows.map((row) => String(row[index] ?? "")))];
          return { id, count: values.length, ...(includeSamples ? { sample: values.slice(0, 8) } : {}) };
        }), rowCount: plan.result.rows.length, columns: plan.result.columns.map((c) => c.name),
        ...(includeSamples ? { sampleRows: plan.result.rows.slice(0, 3) } : {})
      }];
    });
  }

  const layoutDesigner: NodeFn = async (state, context) => {
    context?.signal?.throwIfAborted();
    const metrics = state.validatedMetrics ?? [];
    const dims = [...new Set([...(state.plans ?? []), ...(state.supportingPlans ?? [])].flatMap((p) => getPlan(p.planId)?.shape.dimensions ?? []))];
    const facts = (state.insights ?? []).map((i) => `- ${i.headline}`).join("\n");

    const result = await callStructured<LayoutPlan>({
      signal: context?.signal,
      role: "design",
      node: "LayoutDesigner",
      name: "layout",
      schema: LAYOUT_SCHEMA,
      system: `你是 BI 看板设计师。数据已经查好、验过了,现在由你决定这块看板长什么样。

${designCapabilityGuide()}

**目标**:做一块让人看完就明白答案的看板 —— 回答用户的问题,把结论讲清楚,好读、好看。

**你说了算**:用哪些组件、用几个、怎么组合、怎么排、配色、字号、注释、要不要分页。产品有什么都列在上面,
没有固定模板,也没有「某种情况必须用某种图」的规定。程序只修三种硬错:超出网格、两块压在一起、行与行之间留大洞。

**不能动的只有数据的可信度**:只用下面已验证的指标 id;不编造数据;不扩大或替换已核对的数据范围;单位是真实单位。

可用指标(只能用这些 id,一个都不能编):
${metrics.map((m) => `  ${m.metricId} = ${m.name}(${m.unit})；业务方向=${m.direction ?? "neutral"}；跨分组汇总=${m.rollup}${m.caliber ? ` —— ${m.caliber}` : ""}`).join("\n")}

数据里有的维度:${dims.join("、") || "(无,只有总计)"}
数据范围:${state.scope?.label}
已验证的数据视角（planId、指标、维度、实际点数和样例）：
${JSON.stringify(designDataViews(state, context?.modelConfig?.includeSampleRows === true))}
分析报告：${state.report ?? state.analysisSummary ?? ""}
证据缺口：${JSON.stringify(state.evidenceGaps ?? [])}

已经算出来的结论(用图展示、写进 text 块,或两者都有,你定):
${facts || "(无)"}

theme 字段写一句话:这版为什么这么设计。用户会看到。

只输出 JSON。`,
      user: state.designFeedback ? `${state.userRequest}\n上一版设计：${JSON.stringify(state.layout)}\n成品验收意见：${state.designFeedback}\n根据这些具体问题改进，保留正确的数据绑定，返回完整新版。` : state.userRequest,
    }, context?.modelConfig);
    context?.signal?.throwIfAborted();
    if (!result.ok) throw new Error(`设计版面失败:${result.errors?.join(";")}`);
    const layout = normalizeDesignUnits(result.data!, metrics);
    const usage = [...state.usage, { node: "LayoutDesigner", ms: result.ms, promptTokens: result.promptTokens, completionTokens: result.completionTokens }];
    const bindingErrors = validateDesignBindings(layout, state);
    if (bindingErrors.length) return { layout, usage, designBindingErrors: bindingErrors, designFeedback: `修正这些字段或数据边界错误：${bindingErrors.join("；")}` };
    return {
      layout: refineAnalysisLayout(layout, metrics), designBindingErrors: [],
      usage,
    };
  };


  return { layoutDesigner, designDataViews };
}
