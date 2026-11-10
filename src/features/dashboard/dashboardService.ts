import { nanoid } from "nanoid";
import {
  createDashboard,
  createWidget,
  placeWidget,
  placeWidgetNear,
  resolveWidgetLayout,
  type DashboardDocument,
  type DashboardFilter,
  type DashboardWidget,
  type DashboardWidgetType,
  type DashboardProvenance,
} from "./domain";
import type { QueryScope } from "../metrics/queryPlan";

/**
 * 看板文档的改写层 —— 全是 `(doc, input) => doc` 的纯函数。
 *
 * 这些逻辑原来是 DashboardWorkspace 里闭在 useState 上的组件闭包。搬出来有两个原因:
 *  1. 那个组件已经 530 行,撤销/重做、版本、取数运行时、编辑动作全挤在一起;
 *  2. 程序(将来的 AI Agent Tool、脚本、测试)没法调用一个 React 闭包。
 *
 * 纯函数意味着组件那边一行不用改语义:`updateDocument(d => service.addWidget(d, x).doc)`,
 * 撤销/重做照旧;而每个函数都能用一行断言单测。
 *
 * 边界:这里只管文档结构,不碰 i18n、不碰 toast、不碰持久化。标题这类要翻译的文案
 * 由调用方传进来 —— 服务层不该知道 i18n 的存在。
 */

/** 改写结果。需要知道新对象 id 的动作(新增/复制)用它,其余直接返回文档。 */
export interface Created<T = string> {
  doc: DashboardDocument;
  id: T;
}

// ── 新建 ────────────────────────────────────────────────────────

export function create(input: { title: string; description?: string }): DashboardDocument {
  const doc = createDashboard(input.title);
  return input.description ? { ...doc, description: input.description } : doc;
}

export interface AddWidgetInput {
  type: DashboardWidgetType;
  /** 组件标题(已翻译好)。不传用 createWidget 的英文兜底。 */
  title?: string;
  /** 新组件的数据集。不传就是空的,由使用者在检查器里选。 */
  datasetId?: string;
  /** 容器子组件:父容器与所在 tab。 */
  parentId?: string;
  tabId?: string;
}

/** 新建一个绑定好默认指标、已避让放置的组件。 */
export function addWidget(doc: DashboardDocument, input: AddWidgetInput): Created {
  if (input.parentId && input.type === "container") {
    throw new Error("容器里不能再放容器");
  }
  let widget = createWidget(input.type, "", input.title);
  if (input.type === "text") widget.options.content = widget.options.content ?? "";
  /* 新组件不预设数据源:数据集是全局的,该用哪一个只有人知道,猜一个塞进去比空着更
     糟 —— 图上会出现一份对不上的数,而且没人会想到去改它。检查器里选完就有数。 */
  widget.datasetId = input.datasetId ?? "";
  widget.bindings = { measures: [], metricIds: [], secondaryMetricIds: [] };

  if (input.parentId) {
    widget.parentId = input.parentId;
    widget.tabId = input.tabId;
    widget.w = Math.min(widget.w, 6);
  }
  const siblings = doc.widgets.filter(
    (w) => (w.parentId ?? "") === (input.parentId ?? "") && (w.tabId ?? "") === (input.tabId ?? ""),
  );
  widget = placeWidget(widget, input.parentId ? siblings : doc.widgets.filter((w) => !w.parentId));
  return { doc: { ...doc, widgets: [...doc.widgets, widget] }, id: widget.id };
}

/** 整个替换一个组件,并把被它挤到的兄弟重新排好。 */
export function updateWidget(doc: DashboardDocument, widget: DashboardWidget): DashboardDocument {
  return { ...doc, widgets: resolveWidgetLayout(widget, doc.widgets) };
}

/** 局部改一个组件 —— 给 Agent Tool 用:只动传进来的字段,options 深合一层。 */
export function patchWidget(
  doc: DashboardDocument,
  id: string,
  patch: Partial<Omit<DashboardWidget, "id" | "options" | "bindings">> & {
    options?: Partial<DashboardWidget["options"]>;
    bindings?: Partial<DashboardWidget["bindings"]>;
  },
): DashboardDocument {
  const current = doc.widgets.find((w) => w.id === id);
  if (!current) throw new Error(`组件不存在:${id}`);
  const next: DashboardWidget = {
    ...current,
    ...patch,
    id: current.id,
    options: { ...current.options, ...(patch.options ?? {}) },
    bindings: { ...current.bindings, ...(patch.bindings ?? {}) },
  };
  return updateWidget(doc, next);
}

/** 复制一个组件到它旁边最近的空位;容器连带复制子组件。 */
export function duplicateWidget(doc: DashboardDocument, id: string, title?: string): Created {
  const source = doc.widgets.find((w) => w.id === id);
  if (!source) throw new Error(`组件不存在:${id}`);
  let copy: DashboardWidget = structuredClone(source);
  copy.id = `widget-${nanoid(10)}`;
  if (title) copy.title = title;
  const siblings = doc.widgets.filter(
    (w) => (w.parentId ?? "") === (source.parentId ?? "") && (w.tabId ?? "") === (source.tabId ?? ""),
  );
  copy = placeWidgetNear(copy, siblings, source);
  const children =
    source.type === "container"
      ? doc.widgets
          .filter((w) => w.parentId === source.id)
          .map((child) => ({ ...structuredClone(child), id: `widget-${nanoid(10)}`, parentId: copy.id }))
      : [];
  return { doc: { ...doc, widgets: [...doc.widgets, copy, ...children] }, id: copy.id };
}

export function toggleWidget(doc: DashboardDocument, id: string): DashboardDocument {
  return { ...doc, widgets: doc.widgets.map((w) => (w.id === id ? { ...w, visible: !w.visible } : w)) };
}

/** 删除组件;是容器的话连带删掉它的子组件。 */
export function deleteWidget(doc: DashboardDocument, id: string): DashboardDocument {
  return { ...doc, widgets: doc.widgets.filter((w) => w.id !== id && w.parentId !== id) };
}

/** 移动 / 改尺寸。走 resolveWidgetLayout,所以会自动把被挤到的兄弟推开。 */
export function moveWidget(
  doc: DashboardDocument,
  id: string,
  pos: Partial<Pick<DashboardWidget, "x" | "y" | "w" | "h">>,
): DashboardDocument {
  const current = doc.widgets.find((w) => w.id === id);
  if (!current) throw new Error(`组件不存在:${id}`);
  return updateWidget(doc, { ...current, ...pos });
}

// ── 筛选器 ──────────────────────────────────────────────────────

export interface AddFilterInput {
  datasetId?: string;
  /** 不传就取该数据集第一个维度字段。 */
  field?: string;
  title?: string;
  scope?: "global" | "dataset";
}

/** 新建筛选器。默认全局联动 —— 所有含该维度的图一起筛。 */
export function addFilter(doc: DashboardDocument, input: AddFilterInput = {}): Created {
  const dataset = doc.datasets.find((d) => d.id === input.datasetId) ?? doc.datasets[0];
  if (!dataset) throw new Error("看板还没有数据集,先给组件绑定指标");
  const field = input.field ?? dataset.fields.find((f) => f.role === "dimension")?.name;
  if (!field) throw new Error("这个数据集没有可筛选的维度字段");

  const filter: DashboardFilter = {
    id: `filter-${nanoid(10)}`,
    title: input.title ?? field,
    scope: input.scope ?? "global",
    datasetId: dataset.id,
    field,
    kind: "select",
  };
  return { doc: { ...doc, filters: [...doc.filters, filter] }, id: filter.id };
}

export function updateFilter(doc: DashboardDocument, filter: DashboardFilter): DashboardDocument {
  return { ...doc, filters: doc.filters.map((f) => (f.id === filter.id ? filter : f)) };
}

export function deleteFilter(doc: DashboardDocument, id: string): DashboardDocument {
  return { ...doc, filters: doc.filters.filter((f) => f.id !== id) };
}

// ── 文档级 ──────────────────────────────────────────────────────

/** 看板的数据日期范围(全局 scope)。 */
export function setScope(doc: DashboardDocument, scope: QueryScope): DashboardDocument {
  return { ...doc, metricScope: scope };
}

/** 记下 AI 建这个看板的来龙去脉。人工建的看板不会有这个字段。 */
export function setProvenance(doc: DashboardDocument, provenance: DashboardProvenance): DashboardDocument {
  return { ...doc, aiProvenance: provenance };
}

export function setMeta(
  doc: DashboardDocument,
  patch: { title?: string; description?: string; refreshInterval?: number },
): DashboardDocument {
  return { ...doc, ...patch };
}

/** 容器加一个 tab。 */
export function addTab(doc: DashboardDocument, containerId: string, label: string): Created {
  const container = doc.widgets.find((w) => w.id === containerId);
  if (!container || container.type !== "container") throw new Error(`不是容器组件:${containerId}`);
  const tab = { id: `tab-${nanoid(8)}`, label };
  return {
    doc: updateWidget(doc, { ...container, tabs: [...container.tabs, tab] }),
    id: tab.id,
  };
}
