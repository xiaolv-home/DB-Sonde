import { observedPlans, planForItem, observedCounts } from "./observations";
import { STYLE_PROPERTIES } from "../styleSchema";
import { WIDGET_SPECS } from "../../dashboard/widgetSpecs";
import { resolveLayout } from "../layout";
import type { AgentState } from "../state";
import type { NodeFn } from "../graph";
import type { AiConfig } from "../../ai/aiTypes";
import type { PlanReader } from "../planReader";
import type { ToolCaller } from "./ports";

export interface DashboardCompilerPorts {
  callTool: ToolCaller;
  getPlan: PlanReader;
  discardDraft: (dashboardId: string) => void;
  describeModel: (config?: AiConfig) => string;
}

export function createDashboardCompiler({ callTool, getPlan, discardDraft, describeModel }: DashboardCompilerPorts) {
  const dashboardExecutor: NodeFn = (state, context) => compileDashboard(state, context, true);
  async function compileDashboard(state: AgentState, context?: Parameters<NodeFn>[1], save = false): Promise<Partial<AgentState>> {
    const invokeTool = async <T = unknown>(name: string, input: unknown, workflowId: string) => {
      context?.signal?.throwIfAborted();
      const result = await callTool<T>(name, input, workflowId);
      if (!result.ok) throw new Error(result.error?.message ?? `${name} 失败`);
      return result;
    };
    context?.signal?.throwIfAborted();
    const layout = state.layout;
    if (!layout) throw new Error("没有版面可执行");
    if (!state.scope) throw new Error("没有看板数据范围");
    const placed = resolveLayout(layout.items);
    const created = await invokeTool<{ dashboardId: string; }>("create_dashboard",
      { title: layout.title, description: layout.description ?? "" }, state.workflowId);
    const dashboardId = created.data!.dashboardId;
    try {

      const plans = observedPlans(state, getPlan);
      const reasons: Record<string, string> = {};
      const addItems = async (items: ReturnType<typeof resolveLayout>, parentId?: string, tabId?: string) => {
        for (const item of items) {
          const added = await invokeTool<{ widgetId: string; }>("add_component", {
            dashboardId, type: item.type, title: item.title,
            ...(item.subtitle ? { subtitle: item.subtitle } : {}),
            ...(item.content !== undefined ? { content: item.content } : {}),
            metricIds: WIDGET_SPECS[item.type].metrics[1] === 0 ? [] : item.metricIds,
            secondaryMetricIds: item.secondaryMetricIds, seriesDimension: item.seriesDimension,
            parentId, tabId, visible: item.visible, filtersEnabled: item.filtersEnabled, filterFields: item.filterFields,
            ...(item.tabs ? { tabs: item.tabs.map((tab, i) => ({ id: `tab-${i}`, label: tab.title })) } : {}),
            dimensions: WIDGET_SPECS[item.type].dimensions[1] === 0 ? [] : item.dimensions,
          }, state.workflowId);
          const widgetId = added.data!.widgetId;
          reasons[widgetId] = item.reason;

          await invokeTool("move_component", { dashboardId, widgetId, x: item.x, y: item.y, w: item.w, h: item.h }, state.workflowId);
          const style: Record<string, unknown> = {};
          for (const key of Object.keys(STYLE_PROPERTIES)) {
            const value = (item as unknown as Record<string, unknown>)[key];
            if (value !== undefined) style[key] = value;
          }
          if (item.topN) style.topN = item.topN;
          /* 模型自己定的外观/图表细节/脚注原样透传 —— 这些错了都是当场看得见的,
             没有理由代劳。整板 palette 做兜底,单图给了就用单图的。 */
          if (item.footnote) style.footnote = item.footnote;
          /* 整板预设铺到每张卡 —— 模型只为这块板挑一次基调,不必逐个组件配色。
             单卡自己给了 visualPreset 就盖过整板的。
             真机上「版式主题始终是那一套」的真实原因不是被框死,是**没人要求它有主题**:
             appearance 是可选字段,prompt 一长模型就把它省了,于是每张卡都是默认样式。 */
          if (layout.preset || item.appearance) {
            style.appearance = { ...(layout.preset ? { visualPreset: layout.preset } : {}), ...(item.appearance ?? {}) };
          }
          if (item.text) style.text = item.text;
          if (item.kpi) style.kpi = item.kpi;
          if (item.chart || layout.palette) {
            style.chart = { ...(layout.palette ? { palette: layout.palette } : {}), ...(item.chart ?? {}) };
          }
          /* 数据标签:点少才开。十来个柱子标上数值是有用的,三十个点标上去就是一团糊。
             与其事后提醒"你不该开",不如一开始就按点数决定。 */
          const points = observedCounts(item, planForItem(item, plans)).points;
          if (item.type !== "table" && item.type !== "kpi" && item.type !== "text" && points > 0 && points <= 12 && item.chart?.showLabels === undefined) {
            style.chart = { ...(style.chart as object ?? {}), showLabels: true };
          }
          if (!item.numberFormat && item.scale && item.scale !== "none") style.numberFormat = { scale: item.scale };
          /* 排名柱形默认横向,但模型自己指定了方向就听它的 —— 别把它的设计擦掉 */
          if (item.type === "bar" && item.band === "ranking" && !item.chart?.barOrientation) {
            style.chart = { ...(style.chart as object ?? {}), barOrientation: "horizontal" };
          }
          /* 「排名」就得排过。真机上出过一张副标题写着「按销售额降序」、柱子却按大区名
             顺排的图 —— 名字叫排名、看着像排名,读出来的名次全是错的。
             模型自己设了排序就听它的。 */
          if (item.band === "ranking" && item.metricIds.length && !item.table?.metricSort) {
            style.table = { ...(style.table as object ?? {}), metricSort: { key: item.metricIds[0], dir: "desc" } };
          }
          if (item.type === "kpi" && (state.scope?.comparisonRanges.length ?? 0) > 0) style.kpi = { showComparison: true, ...item.kpi };
          if (Object.keys(style).length) {
            await invokeTool("style_component", { dashboardId, widgetId, ...style }, state.workflowId);
          }
          for (const [index, tab] of (item.tabs ?? []).entries()) await addItems(resolveLayout(tab.items), widgetId, `tab-${index}`);
        }
      };
      await addItems(placed);

      await invokeTool("set_dashboard_scope",
        {
          dashboardId, start: state.scope!.dateRange.start, end: state.scope!.dateRange.end,
          filters: (state.scope!.filters ?? []).map(({ field, values }) => ({ field, values }))
        }, state.workflowId);
      /* 来龙去脉要在落盘**之前**写进去 —— 否则存下来的那份没有它,
         用户打开看板看不到任何理由。
         但它只是一条记录:写不进去顶多是看板上少了「为什么这么做」,
         不该让一次跑完的分析(结论复核已过、版面已生成)整个作废。
         真机上就是这么废掉一次的 —— 遗留问题有 22 条,而入参校验封顶 20。 */
      const provenance = await callTool("set_dashboard_provenance", {
        dashboardId,
        workflowId: state.workflowId,
        userRequest: state.userRequest,
        model: describeModel(context?.modelConfig),
        widgetReasons: reasons,
        autoFixed: state.review?.summary ? [state.review.summary] : [],
        openIssues: (state.review?.findings ?? []).map((f) => f.reason),
      }, state.workflowId);
      const provenanceNote = provenance.ok ? undefined
        : `看板已生成,但「为什么这么做」没能写进去:${provenance.error?.message ?? "未知原因"}`;
      context?.signal?.throwIfAborted();
      if (!save) return { candidateDashboardId: dashboardId };
      const noted = provenanceNote ? { dropped: [...new Set([...(state.dropped ?? []), provenanceNote])] } : {};
      // A successful save is a receipt even if cancellation arrived while saving.
      // Do not throw after save and pretend that durable side effects were rolled back.
      await invokeTool<{ dashboardId: string; widgets: number; }>("save_dashboard", { dashboardId }, state.workflowId);

      return { dashboardId, widgetReasons: reasons, ...noted };
    } catch (error) { discardDraft(dashboardId); throw error; }
  };


  return { compileDashboard, dashboardExecutor };
}
