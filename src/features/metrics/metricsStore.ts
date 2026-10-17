import { readStoredJson, writeStoredJson } from "../../lib/jsonStorage";
import { create } from "zustand";
import { nanoid } from "nanoid";
import type { QueryPlan } from "./queryPlan";

import type { Metric } from "./metricTypes";
export type { Metric, MetricType } from "./metricTypes";
import { bindCatalogMetrics, mergeCatalogMetrics } from "./catalogModel";
import { compareText } from "../../lib/collate";
const KEY = "sonde.metrics.v1";

/* 维度名必须是裸列名,不能带表别名前缀。

   多单元合并(compileSemanticDataset)时外层长这样:
     WITH q0 AS (SELECT d.outlet_region, SUM(...) AS gmv FROM fact a JOIN dim d ...)
     SELECT d.outlet_region, MAX(gmv) AS gmv FROM (SELECT d.outlet_region ... FROM q0 ...) u
   子查询把 d.outlet_region 投影出来,结果列就叫 outlet_region,外层再写 d.outlet_region
   就是 Unknown column 'd.outlet_region' in 'field list'。
   数据体检拿维度名和结果列名逐字比对,同样对不上(「缺少分组维度 d.outlet_region」)。
   带前缀的维度在任何一条消费路径上都跑不通,所以读进来就剥掉前缀。
   source / expression 里的 a. d. 是子查询内部的,不动。 */
function bareDimension(name: string): string {
  const trimmed = name.trim();
  const qualified = /^[A-Za-z_][A-Za-z0-9_]*\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(trimmed);
  return qualified ? qualified[1] : trimmed;
}
function normalizeDimensions(
  raw: unknown,
  rawLabels: unknown,
): { dimensions: string[]; dimensionLabels?: Record<string, string> } {
  const list = Array.isArray(raw) ? (raw as string[]) : [];
  const labels = (rawLabels && typeof rawLabels === "object" ? rawLabels : {}) as Record<string, string>;
  const dimensions: string[] = [];
  const nextLabels: Record<string, string> = {};
  for (const item of list) {
    if (typeof item !== "string") continue;
    const bare = bareDimension(item);
    // 前缀不同但列名相同的两个维度剥完会撞名,保留先出现的那个。
    if (!bare || dimensions.includes(bare)) continue;
    dimensions.push(bare);
    const label = labels[item] ?? labels[bare];
    if (label) nextLabels[bare] = label;
  }
  // 维度以外的标签(比如已经删掉的维度)不留。
  return {
    dimensions,
    dimensionLabels: Object.keys(nextLabels).length ? nextLabels : undefined,
  };
}

/** Migrate any stored shape (incl. the old full-SQL-only metric) to the current model. */
function migrate(raw: Record<string, unknown>): Metric {
  const dims = normalizeDimensions(raw.dimensions, raw.dimensionLabels);
  const base = {
    id: String(raw.id ?? ""),
    catalogId: typeof raw.catalogId === "string" ? raw.catalogId : undefined,
    catalogName: typeof raw.catalogName === "string" ? raw.catalogName : undefined,
    name: String(raw.name ?? ""),
    key: String(raw.key ?? ""),
    enabled: raw.enabled !== false,
    connId: String(raw.connId ?? ""),
    connName: String(raw.connName ?? ""),
    database: raw.database as string | undefined,
    scale: (raw.scale as number) ?? undefined,
    precision: (raw.precision as number) ?? undefined,
    dimensions: dims.dimensions,
    timeField: (raw.timeField as string) ?? "",
    aliases: Array.isArray(raw.aliases) ? (raw.aliases as string[]) : [],
    caliber: String(raw.caliber ?? raw.description ?? ""),
    unit: String(raw.unit ?? ""),
    rollup: ["sum", "avg", "min", "max", "count_distinct"].includes(String(raw.rollup))
      ? (raw.rollup as Metric["rollup"]) : undefined,
    higherIsBetter: raw.higherIsBetter as boolean | undefined,
    category: String(raw.category ?? "未分类"),
    updatedAt: Number(raw.updatedAt ?? 0),
  };
  if (raw.type) {
    return {
      ...base,
      type: raw.type as Metric["type"],
      queryPlan: raw.queryPlan as QueryPlan | undefined,
      dimensionLabels: dims.dimensionLabels,
      source: (raw.source as string) ?? "",
      expression: (raw.expression as string) ?? "",
      numerator: (raw.numerator as string) ?? "",
      denominator: (raw.denominator as string) ?? "",
      numeratorMetricId: (raw.numeratorMetricId as string) ?? "",
      denominatorMetricId: (raw.denominatorMetricId as string) ?? "",
      sql: (raw.sql as string) ?? "",
    };
  }
  // legacy: full-SQL-only metric
  return { ...base, type: "sql", sql: String(raw.sql ?? ""), source: "", expression: "" };
}

function load(): Metric[] {
  return readStoredJson<Record<string, unknown>[]>(KEY, [], value => Array.isArray(value) && value.every(item => item && typeof item === "object" && typeof item.id === "string")).map(migrate);
}
function persist(list: Metric[]): void {
  writeStoredJson(KEY, list);
}

export function newDraft(connId = "", connName = "", database?: string): Metric {
  return {
    id: "",
    name: "",
    key: "",
    enabled: true,
    connId,
    connName,
    database,
    type: "measure",
    source: "",
    expression: "",
    numerator: "",
    denominator: "",
    numeratorMetricId: "",
    denominatorMetricId: "",
    scale: undefined,
    precision: undefined,
    sql: "SELECT ",
    dimensions: [],
    timeField: "",
    aliases: [],
    caliber: "",
    unit: "",
    category: "未分类",
    updatedAt: 0,
  };
}

interface MetricsState {
  /** 从本地存储重新读一遍(别的窗口改过之后) */
  reload: () => void;
  open: boolean;
  metrics: Metric[];
  editing: Metric | null;

  setOpen: (open: boolean) => void;
  edit: (m: Metric) => void;
  startNew: (connId?: string, connName?: string, database?: string) => void;
  cancel: () => void;
  save: (m: Metric) => Metric;
  remove: (id: string) => void;
  /** mode=keep:重复 id 保留原定义(默认);mode=replace:用新的覆盖。
   *  底表换了要重挂口径时必须能覆盖,否则只能先一个个删掉再导。 */
  importMetrics: (metrics: Metric[], mode?: "keep" | "replace") => void;
  bindCatalog: (catalogId: string, connId: string, connName: string) => void;
}

export const useMetrics = create<MetricsState>((set, get) => ({
  open: false,
  metrics: load(),
  reload: () => set({ metrics: load() }),
  editing: null,

  setOpen: (open) => set({ open }),
  edit: (m) => set({ editing: { ...m } }),
  startNew: (connId = "", connName = "", database) => set({ editing: newDraft(connId, connName, database) }),
  cancel: () => set({ editing: null }),

  save: (m) => {
    const id = m.id || nanoid(8);
    const saved: Metric = { ...m, id, updatedAt: Date.now() };
    const list = get().metrics.some((x) => x.id === id)
      ? get().metrics.map((x) => (x.id === id ? saved : x))
      : [...get().metrics, saved];
    list.sort((a, b) => compareText(a.category, b.category) || compareText(a.name, b.name));
    persist(list);
    set({ metrics: list, editing: saved });
    return saved;
  },

  importMetrics: (metrics, mode = "keep") => {
    const incoming = metrics.map((m) => migrate(m as unknown as Record<string, unknown>));
    const list = mergeCatalogMetrics(get().metrics, incoming, mode);
    persist(list);
    set({ metrics: list });
  },
  bindCatalog: (catalogId, connId, connName) => {
    const list = bindCatalogMetrics(get().metrics, catalogId, connId, connName, Date.now());
    persist(list);
    set({ metrics: list, editing: null });
  },
  remove: (id) => {
    const list = get().metrics.filter((m) => m.id !== id);
    persist(list);
    set((s) => ({ metrics: list, editing: s.editing?.id === id ? null : s.editing }));
  },
}));

/** Metrics defined against a given connection (for AI context / pickers). */
export function metricsForConn(connId: string | undefined): Metric[] {
  if (!connId) return [];
  return useMetrics.getState().metrics.filter((m) => m.connId === connId);
}
