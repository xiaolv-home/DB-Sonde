/**
 * 逐个组件打磨。
 *
 * 版面设计那一步一次要排十来张图,每张的样式只能顺手写两笔 —— 用户的原话是
 * 「每一个组件看板的制作,应该用心,仔细了解透了组件,以及如何使用它呈现自己想要的效果」。
 *
 * 所以排完版之后,每个组件再单独过一遍:只给它看**自己**的组件说明、自己能设的全部样式字段、
 * 它要说的那件事(reason)和它的真实数据形状,让模型专心把这一张调到最能表达那件事。
 * 调出来的东西过不了绑定校验就退回排版时的样子 —— 打磨只能加分,不能把能用的弄坏。
 *
 * 隐私:真实取值(门店名、样例行)只有在用户打开「发送样本数据」时才给;否则只给形状
 * (行数、每个维度几个取值、数值的量级),跟版面设计那一步同一个开关。
 */
import { S, type JsonSchema } from "../jsonSchema";
import { STYLE_PROPERTIES } from "../styleSchema";
import { WIDGET_SPECS } from "../../dashboard/widgetSpecs";
import { componentGuide, validateDesignBindings } from "../designContracts";
import type { LayoutItem, LayoutPlan } from "../layout";
import type { AgentState } from "../state";
import type { PlanReader } from "../planReader";
import type { AiConfig } from "../../ai/aiTypes";
import type { StructuredCaller } from "./ports";
import { observedPlans, planForItem } from "./observations";
import { maxOf } from "../../../lib/numbers";

type StyleKey = keyof typeof STYLE_PROPERTIES;

/** 这种组件用得上的样式字段。通用的 + 它自己的那一组。 */
function keysFor(item: LayoutItem): StyleKey[] {
  const spec = WIDGET_SPECS[item.type];
  const keys = new Set<StyleKey>(["appearance"]);
  if (spec.metrics[1] > 0) ["numberFormat", "decimals", "metrics"].forEach((k) => keys.add(k as StyleKey));
  if (spec.optionKey && spec.optionKey in STYLE_PROPERTIES) keys.add(spec.optionKey as StyleKey);
  if (spec.optionKey === "chart") ["showLegend", "topN"].forEach((k) => keys.add(k as StyleKey));
  if (item.type === "line") keys.add("smooth");
  if (item.type === "pie") keys.add("percentDecimals");
  if (item.type === "table" || item.type === "ranking" || item.type === "bar") keys.add("topN");
  return [...keys];
}

function walk(schema: JsonSchema, path: string): string[] {
  const line = `${path}: ${schema.description ?? schema.type}${schema.enum ? ` [${schema.enum.join(" / ")}]` : ""}${schema.minimum != null ? ` 最小 ${schema.minimum}` : ""}${schema.maximum != null ? ` 最大 ${schema.maximum}` : ""}`;
  return [line, ...Object.entries(schema.properties ?? {}).flatMap(([key, child]) => walk(child, `${path}.${key}`)), ...(schema.items ? walk(schema.items, `${path}[]`) : [])];
}

/** 这张图的数据长什么样。默认只给形状;用户允许时才带真实样例。 */
function dataPicture(item: LayoutItem, state: AgentState, getPlan: PlanReader, includeSamples: boolean) {
  const step = item.view ? state.drillSteps?.find((s) => s.id === item.view && s.planId) : undefined;
  const plan = step ? getPlan(step.planId!) : planForItem(item, observedPlans(state, getPlan));
  const result = plan?.result;
  if (!plan || !result) return { note: "没有找到这张图对应的已取数据" };
  const dims = plan.shape.dimensions.map((id) => {
    const i = result.columns.findIndex((c) => c.name === id);
    const values = i < 0 ? [] : [...new Set(result.rows.map((r) => String(r[i] ?? "")))];
    return { id, distinct: values.length, longestName: maxOf(values.map((v) => v.length)) ?? 0, ...(includeSamples ? { sample: values.slice(0, 12) } : {}) };
  });
  const metrics = plan.shape.metrics.map((m) => {
    const i = result.columns.findIndex((c) => c.name === m.field);
    const nums = i < 0 ? [] : result.rows.map((r) => Number(r[i])).filter(Number.isFinite);
    const maxAbs = maxOf(nums.map(Math.abs)) ?? 0;
    return { field: m.field, name: m.name, unit: m.unit, rollup: m.rollup, magnitude: maxAbs ? `约 10^${Math.floor(Math.log10(maxAbs))}` : "0", hasNegative: nums.some((n) => n < 0) };
  });
  return { rows: result.rows.length, dimensions: dims, metrics, ...(includeSamples ? { sampleRows: result.rows.slice(0, 20) } : {}) };
}

/** 并发跑,但别一口气把十几个请求全发出去。 */
async function pool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const at = next++; out[at] = await run(items[at]); }
  }));
  return out;
}

export interface StylistUsage { node: string; ms: number; promptTokens: number; completionTokens: number }

export async function styleEachComponent(
  { callStructured, getPlan }: { callStructured: StructuredCaller; getPlan: PlanReader },
  layout: LayoutPlan, state: AgentState, config: AiConfig | undefined, signal?: AbortSignal,
): Promise<{ layout: LayoutPlan; usage: StylistUsage[]; polished: number }> {
  const includeSamples = config?.includeSampleRows === true;
  const usage: StylistUsage[] = [];
  let polished = 0;
  const guideLines = new Map(componentGuide().split("\n").map((line) => [line.match(/^- (\w+)「/)?.[1] ?? "", line]));

  const polish = async (item: LayoutItem): Promise<LayoutItem> => {
    if (item.type === "container" || item.type === "image") return item.tabs
      ? { ...item, tabs: await Promise.all(item.tabs.map(async (tab) => ({ ...tab, items: await pool(tab.items, 3, polish) }))) }
      : item;
    const keys = keysFor(item);
    const fields = Object.fromEntries(keys.map((k) => [k, STYLE_PROPERTIES[k] as JsonSchema]));
    const schema = S.obj({
      ...fields,
      subtitle: S.str("标题下一行小字:口径、范围"),
      footnote: S.str("卡片底部小字:数据截至、注意事项"),
      note: S.str("一句话:你把这张图调成了什么样、为什么"),
    }, ["note"], "这一个组件的样式");
    signal?.throwIfAborted();
    const current = Object.fromEntries(keys.flatMap((k) => (item[k as keyof LayoutItem] !== undefined ? [[k, item[k as keyof LayoutItem]]] : [])));
    const result = await callStructured<Record<string, unknown>>({
      role: "design", node: "ComponentStylist", name: "component_style", schema, signal,
      system: `你只负责把看板里的**这一个组件**做好。它要表达的事和它的数据都在下面;先弄清这个组件能怎么呈现,
再决定怎么设才最能把这件事说清楚、好读、好看:颜色、标签、排序、数字格式、坐标轴、参考线、图例、高亮……都由你判断。
不需要的字段别填;已经合适的可以不改。不能改数据口径,单位必须是真实单位。只输出 JSON。

组件:${guideLines.get(item.type) ?? item.type}
标题:${item.title}${item.subtitle ? `(${item.subtitle})` : ""}
它要说的事:${item.reason}
在看板里的位置:宽 ${item.w ?? "?"} / 12 栏,高 ${item.h ?? "?"} 行
绑定:指标 ${JSON.stringify(item.metricIds)},维度 ${JSON.stringify(item.dimensions)}${item.seriesDimension ? `,拆分系列 ${item.seriesDimension}` : ""}
数据:${JSON.stringify(dataPicture(item, state, getPlan, includeSamples))}
看板基调:预设 ${layout.preset ?? "editorial"},配色 ${JSON.stringify(layout.palette ?? [])}
排版时已经写下的样式:${JSON.stringify(current)}

可设的字段:
${keys.flatMap((k) => walk(STYLE_PROPERTIES[k] as JsonSchema, k)).join("\n")}`,
      user: `把「${item.title}」调好。`,
    }, config);
    signal?.throwIfAborted();
    usage.push({ node: "ComponentStylist", ms: result.ms, promptTokens: result.promptTokens, completionTokens: result.completionTokens });
    if (!result.ok || !result.data) return item;
    const { note: _note, subtitle, footnote, ...styles } = result.data as Record<string, unknown> & { subtitle?: string; footnote?: string };
    const merged: LayoutItem = { ...item };
    for (const [key, value] of Object.entries(styles)) {
      if (!keys.includes(key as StyleKey) || value === undefined) continue;
      const before = item[key as keyof LayoutItem];
      (merged as unknown as Record<string, unknown>)[key] = value && typeof value === "object" && !Array.isArray(value) && before && typeof before === "object"
        ? { ...(before as object), ...(value as object) }
        : value;
    }
    if (typeof subtitle === "string" && subtitle.trim()) merged.subtitle = subtitle.trim();
    if (typeof footnote === "string" && footnote.trim()) merged.footnote = footnote.trim();
    // 打磨只能加分:过不了校验就用排版时的样子
    if (validateDesignBindings({ ...layout, items: [merged] }, state).length) return item;
    polished += 1;
    return merged;
  };

  const items = await pool(layout.items, 4, polish);
  return { layout: { ...layout, items }, usage, polished };
}
