import type { DashboardWidgetType, DashboardChartOptions, DashboardKpiOptions, DashboardWidget, DashboardTextOptions, DashboardAppearanceOptions } from "../dashboard/domain";

/** Model-designed layouts; deterministic code repairs geometry and semantic errors. */

export const BANDS = ["kpi", "trend", "structure", "ranking", "detail"] as const;
export type Band = (typeof BANDS)[number];

export const WIDTHS = ["quarter", "third", "half", "full"] as const;
export type Width = (typeof WIDTHS)[number];

export interface LayoutItem extends Omit<Partial<DashboardWidget["options"]>, "chart" | "text" | "appearance"> {
  /** 可选。**不决定位置**,也不是必须填的角色标签。
   *
   *  以前它是必填的五选一(kpi/trend/structure/ranking/detail)。散文里写着
   *  「没有四个 KPI 或一张表的配额」,schema 却要求每块都挑一个角色 ——
   *  **schema 比散文有力**,于是模型每次都凑齐五个角色,看板千篇一律。
   *
   *  现在只保留它真正驱动的行为:ranking 会让柱形默认横向、并按指标降序排
   *  (真机上出过「副标题写着按销售额降序、柱子却按名称顺排」的事故)。
   *  没给就按组件类型兜底推断,只用于模型没给坐标时的排版回退。 */
  band?: Band;
  /** 引用一个数据视角(下钻步骤 S1/S2…):没给的指标、分组、范围按那一步补上。 */
  view?: string;
  secondaryMetricIds?: string[];
  seriesDimension?: string;
  filtersEnabled?: boolean;
  filterFields?: DashboardWidget["filterFields"];
  visible?: boolean;
  tabs?: { title: string; items: LayoutItem[] }[];
  type: DashboardWidgetType;
  title: string;
  /** 标题下的口径小字。 */
  subtitle?: string;
  metricIds: string[];
  dimensions: string[];
  width: Width;
  /** 为什么放这个、为什么用这种图 —— 进 aiProvenance,用户能查。 */
  reason: string;
  topN?: number;
  /** 大额金额换算,避免摊出八位数。 */
  /** auto:每个数按自己的量级选一档 —— 一张卡上量级跨了档时,定死任何一档都有一半读不出来。 */
  scale?: "none" | "wan" | "yi" | "auto";

  /* ── 以下是「放开给模型」的部分 ──────────────────────────────
     判错了当场就能看见的事,交给模型;判错了下游看不出来的事(指标绑定、
     口径、日期),代码锁死。排版、配色、注释全属于前者 —— 丑一眼就看出来,
     所以没有理由用一个固定模板把它框死。 */

  /** 模型自己排的位置(12 栏网格)。给了就按它的来,只修真冲突;
   *  不给就退回按 band 铺排。 */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** type="text" 时的正文。支持换行。用来写小标题、口径注释、结论。 */
  content?: string;
  /** 卡片底部小字:数据截至、口径说明、注意事项。 */
  footnote?: string;
  /** 卡片外观 —— 背景、边框、标题对齐、视觉预设。 */
  appearance?: LayoutAppearance;
  /** 图表细节 —— 面积填充、环形内径、横竖向、配色…… */
  chart?: LayoutChart;
  /** 文本块排版 */
  text?: LayoutText;
  kpi?: DashboardKpiOptions;
}

/** 卡片外观。字段名和 DashboardAppearanceOptions 对齐,直接透传。 */
export type LayoutAppearance = DashboardAppearanceOptions;
export type LayoutChart = DashboardChartOptions & { showLegend?: boolean; smooth?: boolean };
export type LayoutText = DashboardTextOptions;

export interface LayoutPlan {
  title: string;
  description?: string;
  items: LayoutItem[];
  /** 整板基调 —— 一句话说清这版为什么长这样,进 provenance 给人看。 */
  theme?: string;
  /** 整板默认配色,单个组件可以覆盖。 */
  palette?: string[];
  /** 整板视觉预设(16 选 1)。**一次决定,代码铺到每张卡上** ——
   *  模型只需要为这块板挑一个基调,不必逐个组件配色;
   *  单个组件想不一样,自己给 appearance.visualPreset 就能盖过它。 */
  preset?: string;
}

/** 宽度档 → 占几栏。12 栏网格,所以四档都能整除。 */
const SPAN: Record<Width, number> = { quarter: 3, third: 4, half: 6, full: 12 };

/** 组件类型 → 默认高度(网格行)。KPI 矮,明细表高。 */
const HEIGHT: Record<LayoutItem["type"], number> = {
  kpi: 3,
  gauge: 4,
  line: 4,
  bar: 4,
  pie: 4,
  funnel: 4,
  treemap: 5,
  waterfall: 4,
  ranking: 5,
  scatter: 5,
  radar: 5,
  heatmap: 5,
  table: 6,
  text: 2,
  image: 3,
  container: 8,
};

export interface PlacedItem extends LayoutItem {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 在**原始** items 数组里的下标。
   *  排版会按 band 重排,而 Reviewer 的 finding 最终要拿回去改原数组 ——
   *  不带这个下标就会改错组件、删错组件。 */
  sourceIndex: number;
}

/**
 * 按 band 顺序逐行铺排。
 *
 * 规则很简单,但要的就是简单:同一 band 的组件从左往右排,排不下就换行;
 * **换 band 一定换行** —— 否则趋势图会和 KPI 挤在同一行,阅读层次就没了。
 */
/** band 没给时按类型兜底 —— 只在这条回退路径上用,不回写给模型。 */
export function bandOf(item: LayoutItem): Band {
  if (item.band) return item.band;
  if (item.type === "kpi" || item.type === "gauge") return "kpi";
  if (item.type === "line") return "trend";
  if (item.type === "pie" || item.type === "funnel" || item.type === "treemap") return "structure";
  if (item.type === "ranking" || item.type === "waterfall") return "ranking";
  if (item.type === "bar") return "ranking";
  return "detail";
}

export function packLayout(items: LayoutItem[]): PlacedItem[] {
  const ordered = items
    .map((item, sourceIndex) => ({ item, sourceIndex }))
    .sort((a, b) => BANDS.indexOf(bandOf(a.item)) - BANDS.indexOf(bandOf(b.item)));
  const placed: PlacedItem[] = [];
  let y = 0;
  let x = 0;
  let rowHeight = 0;
  let band: Band | null = null;

  const newline = () => {
    if (x > 0) y += rowHeight;
    x = 0;
    rowHeight = 0;
  };

  for (const { item, sourceIndex } of ordered) {
    if (band !== null && bandOf(item) !== band) newline();
    band = bandOf(item);
    const w = Math.min(12, SPAN[item.width] ?? 6);
    const h = HEIGHT[item.type] ?? 4;
    if (x + w > 12) newline();
    placed.push({ ...item, x, y, w, h, sourceIndex });
    x += w;
    rowHeight = Math.max(rowHeight, h);
    if (x >= 12) newline();
  }
  return placed;
}

/** 看板总高度(网格行),Reviewer 用它判断页面是不是太长。 */
export function layoutHeight(placed: PlacedItem[]): number {
  return placed.reduce((max, item) => Math.max(max, item.y + item.h), 0);
}


// ── 放开排版 ────────────────────────────────────────────────────

/**
 * 模型自己排的版 —— 只修真冲突,不改它的构图。
 *
 * 原来是 `packLayout` 一手包办:模型只能说「这块占半行、属于趋势区」,
 * 剩下全是代码按固定顺序铺。结果每块看板长得一模一样 —— 第一行四个 KPI、
 * 然后一张折线、然后一张饼…… 像有个模板锁着它。
 *
 * 可排版错了是**当场就能看见**的事(重叠、出界、留一大片空)。按「判错了当场
 * 就能看见的尽量交给模型」这条规矩,它本来就不该被锁死。所以改成:模型给坐标,
 * 代码只做三件它必须做的事 ——
 *
 *  1. **夹进网格**:w 超过 12 栏、x 是负数这种,直接改对;
 *  2. **拆重叠**:两块压在一起谁都看不清,把后来的往下推;
 *  3. **收缝**:模型常留下 y=0 然后 y=7 这种大洞,把行往上收。
 *
 * 不做的事:不重排顺序、不改宽高比例、不强制 KPI 在第一行。模型想把大 KPI
 * 放右边、想让明细表顶在最上面 —— 那是它的构图,不是错误。
 */
export function repairLayout(items: LayoutItem[]): PlacedItem[] {
  const withIndex = items.map((item, sourceIndex) => ({ item, sourceIndex }));

  // 1. 夹进网格。没给坐标的先记成 null,第 3 步再安置。
  const sized = withIndex.map(({ item, sourceIndex }) => {
    const w = clamp(item.w ?? SPAN[item.width] ?? 6, 1, 12);
    const h = clamp(item.h ?? HEIGHT[item.type] ?? 4, 1, 24);
    const hasPos = Number.isFinite(item.x) && Number.isFinite(item.y);
    return {
      item, sourceIndex, w, h,
      x: hasPos ? clamp(Math.round(item.x!), 0, 12 - w) : null,
      y: hasPos ? Math.max(0, Math.round(item.y!)) : null,
    };
  });

  // 2. 有坐标的按 (y, x) 先来后到铺,重叠就往下推
  const placed: PlacedItem[] = [];
  const positioned = sized.filter((s) => s.x !== null).sort((a, b) => a.y! - b.y! || a.x! - b.x!);
  for (const s of positioned) {
    let y = s.y!;
    // 往下找到第一个不压别人的位置
    for (;;) {
      const hit = placed.find((p) => overlaps(p, { x: s.x!, y, w: s.w, h: s.h }));
      if (!hit) break;
      y = hit.y + hit.h;
    }
    placed.push({ ...s.item, x: s.x!, y, w: s.w, h: s.h, sourceIndex: s.sourceIndex });
  }

  // 3. 没给坐标的补在最底下 —— 模型漏了几个,不该因此把整版打乱
  let bottom = placed.reduce((m, p) => Math.max(m, p.y + p.h), 0);
  let cursorX = 0;
  let rowH = 0;
  for (const s of sized.filter((s) => s.x === null)) {
    if (cursorX + s.w > 12) { bottom += rowH; cursorX = 0; rowH = 0; }
    placed.push({ ...s.item, x: cursorX, y: bottom, w: s.w, h: s.h, sourceIndex: s.sourceIndex });
    cursorX += s.w;
    rowH = Math.max(rowH, s.h);
  }

  return compact(placed);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));

interface Box { x: number; y: number; w: number; h: number }
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * 把整块往上收 —— 模型给的 y 常常是"大概第几屏"而不是精确行号,
 * 照搬会留下一行行空白。逐个往上挪到不能再挪为止。
 *
 * 只收缝,不改左右和大小 —— 那是构图。
 */
function compact(placed: PlacedItem[]): PlacedItem[] {
  const sorted = [...placed].sort((a, b) => a.y - b.y || a.x - b.x);
  const settled: PlacedItem[] = [];
  for (const item of sorted) {
    let y = item.y;
    while (y > 0 && !settled.some((s) => overlaps(s, { ...item, y: y - 1 }))) y--;
    settled.push({ ...item, y });
  }
  return settled;
}

/**
 * 用模型排的版,还是退回按 band 铺?
 *
 * 判据很朴素:**模型认真给坐标了就用它的**。半数以上的组件带坐标就算认真 ——
 * 零星给一两个多半是漏填,那种情况下拿它当构图会排出个四不像。
 */
export function resolveLayout(items: LayoutItem[]): PlacedItem[] {
  const positioned = items.filter((i) => Number.isFinite(i.x) && Number.isFinite(i.y)).length;
  return positioned * 2 >= items.length && positioned > 0 ? repairLayout(items) : packLayout(items);
}
