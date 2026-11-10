import { repairGeneratedDashboard } from "../../dashboard/generatedAppearance";
import * as service from "../../dashboard/dashboardService";
import { dashboardRepository } from "../../dashboard/repository";
import { useMetrics } from "../../metrics/metricsStore";
import { useDatasets } from "../../datasets/datasetsStore";
import type { DashboardDocument, DashboardWidgetType } from "../../dashboard/domain";
import { fail, registerTool, type ToolDef } from "./registry";
import { S } from "../jsonSchema";
import { STYLE_PROPERTIES } from "../styleSchema";
import { componentGuide } from "../designContracts";
import { WIDGET_SPECS, bindingProblem } from "../../dashboard/widgetSpecs";
import { AGG_LABELS, CONDITION_OPS, type AggKind, type WidgetCondition } from "../../datasets/widgetQuery";

/**
 * 看板工具 —— Agent 唯一能改看板的通道。
 *
 * 边界(设计报告第 4 节第 2 条):**Agent 改不了 DashboardDocument,只能调
 * dashboardService**。schema 校验、网格避让、容器规则全在 service 里,这里只做
 * 两件事:把文档存在草稿区、把 service 的异常转成模型看得懂的错误。
 *
 * 生成的看板一律 status:"draft" —— 由人确认才发布。这是写在 createDashboard 里的,
 * 这里不去覆盖它。
 */

/** Agent 正在攒的看板草稿。一次 workflow 建完再落盘,中途失败就整个丢弃,不留半截。 */
const drafts = new Map<string, DashboardDocument>();

export function getDraft(id: string): DashboardDocument | undefined {
  return drafts.get(id);
}

export function discardDraft(id: string) { drafts.delete(id); }

export function resetDrafts(): void {
  drafts.clear();
}

const need = (id: string): DashboardDocument => {
  const doc = drafts.get(id);
  if (!doc) fail("NOT_FOUND", `没有 id=${id} 的看板草稿。先调 create_dashboard。`);
  return doc!;
};

// 类型清单只在 dashboard/domain.ts 定义一次,见那里的注释。
import { WIDGET_TYPES } from "../../dashboard/domain";

/** 组件摘要 —— 回给模型的,不带整份文档(太大且没用)。 */
const summarize = (doc: DashboardDocument) => ({
  dashboardId: doc.id,
  title: doc.title,
  status: doc.status,
  widgets: doc.widgets.map((w) => ({
    widgetId: w.id, type: w.type, title: w.title,
    metricIds: w.bindings.metricIds, dimensions: w.bindings.dimensions ?? [],
    grid: { x: w.x, y: w.y, w: w.w, h: w.h },
  })),
});

export const createDashboardTool: ToolDef = registerTool({
  name: "create_dashboard",
  description: "新建一个看板草稿,返回 dashboardId。只在内存里,调 save_dashboard 才落盘。",
  readOnly: false,
  schema: S.obj({ title: S.str("看板标题"), description: S.str("一句话说明") }, ["title"]),
  run: (input: { title: string; description?: string }) => {
    const doc = service.create(input);
    drafts.set(doc.id, doc);
    return { dashboardId: doc.id, title: doc.title, status: doc.status };
  },
});

export const addComponentTool: ToolDef = registerTool({
  name: "add_component",
  // 组件介绍从看板的组件说明书生成:看板加了组件,这里自动就有
  description: "往看板里加一个组件并绑定数据。会自动避让放置。两种取数方式二选一:datasetId(来自 list_datasets,维度/度量用该数据集的字段),或 metricIds(来自 validate_metrics,指标分析用)。用哪种组件由你决定。\n组件:\n" + componentGuide(),
  readOnly: false,
  schema: S.obj(
    {
      dashboardId: S.str(),
      type: S.enumOf(WIDGET_TYPES, "组件类型"),
      title: S.str("组件标题"),
      subtitle: S.str("标题下的口径小字"),
      datasetId: S.str("取数用的数据集,来自 list_datasets"),
      metricIds: S.arr(S.str(), "改用中心指标取数时绑定的指标,KPI 可多个"),
      measures: S.arr(S.str(), "要汇总的度量字段,必须是该数据集里 role=measure 的字段"),
      aggregations: S.obj({}, [], "度量字段 → 汇总方式(sum/avg/count/count_distinct/min/max),不填按 sum"),
      dimensions: S.arr(S.str(), "分析维度,必须是该数据集里 role=dimension 的字段"),
      conditions: S.arr(S.obj({
        field: S.str("数据集里的字段名"),
        op: S.enumOf(Object.keys(CONDITION_OPS), Object.entries(CONDITION_OPS).map(([k, v]) => `${k}=${v.label}`).join(" ")),
        values: S.arr(S.str(), "取值;为空/不为空不用填,介于填两个"),
        agg: S.enumOf(Object.keys(AGG_LABELS), "填了就按汇总后的结果筛(HAVING),不填按每一行筛"),
      }, ["field", "op", "values"]), "组件自己的条件,只看符合条件的数据(只对 datasetId 取数的组件有效)", 20),
      content: S.str("type=text 时的正文"),
      secondaryMetricIds: S.arr(S.str()), seriesDimension: S.str(), parentId: S.str(), tabId: S.str(),
      visible: S.bool(), filtersEnabled: S.bool(), filterFields: S.arr(S.str(), "组件筛选字段:数据集里的维度字段名。'date' 是保留名,渲染成日期区间"),
      tabs: S.arr(S.obj({ id: S.str(), label: S.str() }, ["id", "label"]), "容器分页", 6),
    },
    ["dashboardId", "type", "title"],
  ),
  run: (input: {
    dashboardId: string; type: DashboardWidgetType; title: string; subtitle?: string;
    datasetId?: string; measures?: string[]; aggregations?: Record<string, string>; metricIds?: string[]; dimensions?: string[];
    content?: string; secondaryMetricIds?: string[]; seriesDimension?: string;
    conditions?: Array<{ field: string; op: string; values: string[]; agg?: AggKind }>;
    parentId?: string; tabId?: string; visible?: boolean; filtersEnabled?: boolean; filterFields?: import("../../dashboard/domain").DashboardComponentFilterField[]; tabs?: { id: string; label: string }[];
  }) => {
    const doc = need(input.dashboardId);
    /* 数据集和字段都当场核对:模型很擅长编一个看起来合理的字段名,放进去要到渲染时
       才炸,那时已经看不出是编的还是写错的。 */
    const datasets = useDatasets.getState().datasets;
    const dataset = input.datasetId ? datasets.find((d) => d.id === input.datasetId) : undefined;
    if (input.datasetId && !dataset) {
      fail("MISSING_DATASET", `数据集 ${input.datasetId} 不存在。datasetId 只能来自 list_datasets。`);
    }
    if (dataset) {
      const byName = new Map(dataset.fields.map((f) => [f.name, f]));
      for (const name of input.measures ?? []) {
        const field = byName.get(name);
        if (!field) fail("MISSING_FIELD", `数据集「${dataset.name}」里没有字段 ${name}。`);
        else if (field.role !== "measure") fail("WRONG_FIELD_ROLE", `${name} 是维度,不能当度量汇总。`);
      }
      for (const name of [...(input.dimensions ?? []), ...(input.seriesDimension ? [input.seriesDimension] : [])]) {
        const field = byName.get(name);
        if (!field) fail("MISSING_FIELD", `数据集「${dataset.name}」里没有字段 ${name}。`);
        else if (field.role !== "dimension") fail("WRONG_FIELD_ROLE", `${name} 是度量,不能当维度分组。`);
      }
      /* 组件筛选字段以前被 schema 的 enum 限成固定几个,换个行业的库就发不出来,所以放开了。
         放开就得在这儿核对 —— 不然模型编一个字段名出来,筛选框照样画,一点就是 SQL 报错。
         "date" 是保留名,渲染成日期区间,不对应具体某一列。 */
      for (const name of input.filterFields ?? []) {
        if (name === "date") continue;
        const field = byName.get(name);
        if (!field) fail("MISSING_FIELD", `数据集「${dataset.name}」里没有字段 ${name},不能当筛选项。`);
        else if (field.role !== "dimension") fail("WRONG_FIELD_ROLE", `${name} 是度量,不能当筛选项。`);
      }
    }
    for (const c of input.conditions ?? []) {
      if (!dataset) fail("UNSUPPORTED", "conditions 只对 datasetId 取数的组件有效。");
      else if (!dataset.fields.some((f) => f.name === c.field)) fail("MISSING_FIELD", `数据集「${dataset.name}」里没有字段 ${c.field},不能当条件。`);
    }
    // 画不画得出来:散点要两个数值、热力要纵轴…… 规则在组件说明书里,这里不另写
    const shape = bindingProblem(input.type, {
      metrics: (input.metricIds?.length ?? 0) || (input.measures?.length ?? 0),
      dimensions: input.dimensions?.length ?? 0,
      series: !!input.seriesDimension,
    });
    if (shape && (input.metricIds?.length || input.measures?.length || input.dimensions?.length)) fail("INVALID_ARGS", shape);
    const all = useMetrics.getState().metrics;
    const ids = input.metricIds ?? [];
    for (const id of [...ids, ...(input.secondaryMetricIds ?? [])]) {
      if (!all.some((m) => m.id === id)) {
        fail("MISSING_METRIC", `指标 ${id} 不存在。metricId 只能来自 validate_metrics,不要自己编。`);
      }
    }
    let next: DashboardDocument;
    let widgetId: string;
    try {
      const created = service.addWidget(doc, { type: input.type, title: input.title, datasetId: input.datasetId, parentId: input.parentId, tabId: input.tabId });
      next = created.doc;
      widgetId = created.id;
    } catch (error) {
      return fail("BACKEND_ERROR", String(error).replace(/^Error:\s*/, ""));
    }
    // 多指标 / 维度 / 副标题走 patch,保持 service 的单一入口
    const patched = service.patchWidget(next, widgetId, {
      ...(input.visible !== undefined ? { visible: input.visible } : {}),
      ...(input.filtersEnabled !== undefined ? { filtersEnabled: input.filtersEnabled, filterFields: input.filterFields ?? [] } : {}),
      ...(input.tabs ? { tabs: input.tabs } : {}),
      ...(input.subtitle ? { subtitle: input.subtitle } : {}),
      ...(input.content !== undefined ? { options: { content: input.content } } : {}),
      ...(ids.length && !input.datasetId ? { datasetId: `semantic:${widgetId}` } : {}),
      bindings: {
        metricIds: ids,
        measures: input.measures ?? [],
        aggregations: input.aggregations as Record<string, import("../../datasets/widgetQuery").AggKind> | undefined,
        secondaryMetricIds: input.secondaryMetricIds ?? [],
        seriesDimension: input.seriesDimension,
        dimensions: WIDGET_SPECS[input.type].dimensions[1] === 0 ? [] : (input.dimensions ?? []),
        dimension: WIDGET_SPECS[input.type].dimensions[1] === 0 ? undefined : input.dimensions?.[0],
        ...(input.conditions?.length ? { conditions: input.conditions as WidgetCondition[] } : {}),
      },
    });
    drafts.set(patched.id, patched);
    return { widgetId, ...summarize(patched) };
  },
});

export const styleComponentTool: ToolDef = registerTool({
  name: "style_component",
  description:
    "一次配完一个组件的视觉:配色、数据标签、图例、TopN、排序、数字格式、坐标轴、参考线。" +
    "刻意做成一个工具而不是十几个 setter —— 一次往返就够,错了也能一次说清哪个字段不合法。",
  readOnly: false,
  schema: S.obj(
    {
      dashboardId: S.str(),
      widgetId: S.str(),
      ...STYLE_PROPERTIES,
      footnote: S.str("卡片底部小字,如数据截至"),
    },
    ["dashboardId", "widgetId"],
  ),
  run: (input: Record<string, unknown> & { dashboardId: string; widgetId: string }) => {
    const doc = need(input.dashboardId);
    const current = doc.widgets.find((w) => w.id === input.widgetId);
    if (!current) fail("NOT_FOUND", `看板里没有 widgetId=${input.widgetId} 的组件。`);
    const { dashboardId, widgetId, footnote, ...rest } = input;
    const options: Record<string, unknown> = {};
    // 子对象和现有配置合并:看板的每个样式组(含新组件的)都是对象,只有这些不是
    // 数字、开关,以及本来就整块替换的(单卡范围、数字格式)不合并
    const SCALAR = new Set(["decimals", "percentDecimals", "showLegend", "smooth", "topN", "lockedScope", "numberFormat"]);
    for (const key of Object.keys(STYLE_PROPERTIES)) {
      if (rest[key] === undefined) continue;
      // 子对象要和现有配置合并而不是整个替换
      const existing = (current!.options as Record<string, unknown>)[key];
      options[key] = !SCALAR.has(key) && rest[key] && typeof rest[key] === "object" && !Array.isArray(rest[key])
        ? { ...(existing && typeof existing === "object" ? existing : {}), ...(rest[key] as object) }
        : rest[key];
    }
    // The renderer reads these switches at the options root, not inside chart.
    // Normalize both direct tool calls and workflow-generated style requests.
    if (rest.chart && typeof rest.chart === "object") {
      const { showLegend, smooth, ...chart } = rest.chart as Record<string, unknown>;
      options.chart = { ...(current!.options.chart ?? {}), ...chart };
      delete (options.chart as Record<string, unknown>).showLegend;
      delete (options.chart as Record<string, unknown>).smooth;
      if (rest.smooth === undefined && typeof smooth === "boolean") options.smooth = smooth;
      if (rest.showLegend === undefined && typeof showLegend === "boolean") options.showLegend = showLegend;
    }
    const next = service.patchWidget(doc, widgetId, { ...(footnote !== undefined ? { footnote: footnote as string } : {}), options });
    drafts.set(next.id, next);
    // applied 要如实反映改了什么 —— 模型靠它确认自己的配置生效了没
    return { widgetId, applied: [...Object.keys(options), ...(footnote !== undefined ? ["footnote"] : [])] };
  },
});

export const moveComponentTool: ToolDef = registerTool({
  name: "move_component",
  description: "挪动或改变组件大小。12 栏网格,x+w 不能超过 12。被挤到的兄弟会自动下移。",
  readOnly: false,
  schema: S.obj(
    { dashboardId: S.str(), widgetId: S.str(), x: S.int("左边距", 0, 11), y: S.int("第几行", 0, 200), w: S.int("占几栏", 1, 12), h: S.int("占几行", 1, 40) },
    ["dashboardId", "widgetId"],
  ),
  run: (input: { dashboardId: string; widgetId: string; x?: number; y?: number; w?: number; h?: number }) => {
    const doc = need(input.dashboardId);
    const { dashboardId, widgetId, ...pos } = input;
    const next = service.moveWidget(doc, widgetId, pos);
    drafts.set(next.id, next);
    const placed = next.widgets.find((w) => w.id === widgetId)!;
    /* 网格会夹取越界的位置:x=11,w=6 会变成 x=6,w=6(保住宽度、左移),
       不是错误但和请求不一样。如实告诉模型被夹了,否则它以为自己摆成功了。 */
    const clamped = placed.x !== (pos.x ?? placed.x) || placed.w !== (pos.w ?? placed.w) || placed.h !== (pos.h ?? placed.h);
    return { ...summarize(next), clamped, actual: { x: placed.x, y: placed.y, w: placed.w, h: placed.h } };
  },
});

export const setScopeTool: ToolDef = registerTool({
  name: "set_dashboard_scope",
  description: "设置看板的全局日期范围和维度筛选条件。",
  readOnly: false,
  schema: S.obj({ dashboardId: S.str(), start: S.date(), end: S.date(),
    // 同上:锁定范围里的取值列表是用户选出来的,二三十家网点很常见
    filters: S.arr(S.obj({ field: S.str(), values: S.arr(S.str(), undefined, 1000) }, ["field", "values"]), undefined, 50) }, ["dashboardId", "start", "end"]),
  run: (input: { dashboardId: string; start: string; end: string; filters?: { field: string; values: string[] }[] }) => {
    const doc = need(input.dashboardId);
    const filters = input.filters?.filter((f) => f.values.length).map((f) => ({ field: f.field, kind: "in" as const, value: f.values.join(String.fromCharCode(1)) }));
    const next = service.setScope(doc, { start: input.start, end: input.end, filters: filters ?? doc.metricScope?.filters });
    drafts.set(next.id, next);
    return { dashboardId: next.id, scope: next.metricScope };
  },
});

export const listDatasetsTool: ToolDef = registerTool({
  name: "list_datasets",
  description: "列出可用的数据集及其字段。建组件前必须先调它:datasetId 和字段名只能从这里取,不能自己编。",
  readOnly: true,
  schema: S.obj({}, []),
  run: () => ({
    datasets: useDatasets.getState().datasets.map((dataset) => ({
      id: dataset.id,
      name: dataset.name,
      // 维度用来分组、度量用来汇总,分开列出来,省得模型把两者搞混。
      dimensions: dataset.fields.filter((f) => f.role === "dimension").map((f) => ({ name: f.name, label: f.label, type: f.type })),
      measures: dataset.fields.filter((f) => f.role === "measure").map((f) => ({ name: f.name, label: f.label, type: f.type })),
    })),
  }),
});

export const getDashboardTool: ToolDef = registerTool({
  name: "get_dashboard",
  description: "看当前草稿的结构:有哪些组件、绑了什么数据、摆在哪。Reviewer 用它检查布局。",
  readOnly: true,
  schema: S.obj({ dashboardId: S.str() }, ["dashboardId"]),
  run: (input: { dashboardId: string }) => summarize(need(input.dashboardId)),
});

export const setProvenanceTool: ToolDef = registerTool({
  name: "set_dashboard_provenance",
  description: "记下这个看板是怎么来的:用户原话、每个组件为什么这么建、验收自动修了什么。用户能在看板里查到。",
  readOnly: false,
  schema: S.obj(
    {
      dashboardId: S.str(),
      workflowId: S.str(),
      userRequest: S.str("用户当初说的那句话"),
      model: S.str("实际用的模型/端点"),
      widgetReasons: { type: "object", description: "widgetId → 为什么放它" },
      /* 这两个是**我们自己的代码**填的(验收结果原样抄进来),不是模型吐的。
         S.arr 默认封顶 20 是为了挡住模型在 json_schema 模式下重复吐同一项的解码循环
         —— 那个理由对代码填的数据不成立。真机上验收一次列出 22 条遗留问题,
         整个跑完的分析(结论复核已通过、看板也设计出来了)就死在这最后一步的入参校验上。
         留个大得多的上限只为兜住真正异常的情况。 */
      autoFixed: S.arr(S.str(), "验收自动修掉的问题", 500),
      openIssues: S.arr(S.str(), "没能自动修、留给人的问题", 500),
    },
    ["dashboardId", "workflowId", "userRequest"],
  ),
  run: (input: {
    dashboardId: string; workflowId: string; userRequest: string; model?: string;
    widgetReasons?: Record<string, string>; autoFixed?: string[]; openIssues?: string[];
  }) => {
    const doc = need(input.dashboardId);
    const next = service.setProvenance(doc, {
      appearanceVersion: doc.aiProvenance?.appearanceVersion,
      workflowId: input.workflowId,
      userRequest: input.userRequest,
      createdAt: new Date().toISOString(),
      model: input.model,
      widgetReasons: input.widgetReasons ?? {},
      autoFixed: input.autoFixed,
      openIssues: input.openIssues,
    });
    drafts.set(next.id, repairGeneratedDashboard(next));
    return { dashboardId: next.id, reasons: Object.keys(next.aiProvenance?.widgetReasons ?? {}).length };
  },
});

export const saveDashboardTool: ToolDef = registerTool({
  name: "save_dashboard",
  description: "把草稿落盘。一次建完再存,中途失败就整个丢弃,不留半截看板。存下来仍是草稿状态,要人确认才发布。",
  readOnly: false,
  schema: S.obj({ dashboardId: S.str() }, ["dashboardId"]),
  run: async (input: { dashboardId: string }) => {
    const doc = need(input.dashboardId);
    if (doc.widgets.length === 0) fail("INVALID_ARGS", "看板一个组件都没有,不要存。");
    const saved = await dashboardRepository.save({ ...doc, updatedAt: new Date().toISOString() });
    drafts.set(saved.id, saved);
    return { dashboardId: saved.id, title: saved.title, status: saved.status, widgets: saved.widgets.length };
  },
});
