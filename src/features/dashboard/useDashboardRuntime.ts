import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { TranslationKey } from "../../i18n";
import type { QueryResult } from "../../types";
import { useApp } from "../../store/appStore";
import { defaultMetricScope, type QueryScope } from "../metrics/queryPlan";
import type { Metric } from "../metrics/metricsStore";
import type { DashboardComponentFilterField, DashboardDataset, DashboardDocument, DashboardDrillFilter, DashboardRuntimeData, DashboardWidget } from "./domain";
import { datasetOf } from "./resolveDatasets";
import { activeDashboardFilters, type DashboardFilterValues } from "./filtering";
import { executeDataset } from "./query";
import { dashboardRepository } from "./repository";
import { dateFilterFieldsOf } from "./componentFilterFields";
import { utcDay } from "../../lib/dates";

type Translate = (key: TranslationKey, variables?: Record<string, string | number>) => string;
/**
 * 看板组件取数的超时。
 *
 * 后端默认 30 秒是按「点一下筛选器该立刻有反应」定的,可**打开一个看板**是另一回事:
 * 用户预期它要加载一会儿。真机上 AI 建的 8 组件看板里,5 个组件卡在
 * 「timed out after 30 seconds」—— 而同样的口径,AI 自己取数(180 秒预算)跑出了 184 行。
 * 同一份数据,换个地方就说查不出来,这只会让人以为看板坏了。
 */
const WIDGET_TIMEOUT_SECS = 120;

type RuntimeMap = Record<string, DashboardRuntimeData>;
type ComparisonMap = Record<string, { period?: QueryResult; year?: QueryResult }>;
export interface ComponentFilterValue {
  start?: string;
  end?: string;
  selections: Record<string, string[]>;
}
export type ComponentFilterValueMap = Record<string, ComponentFilterValue>;

/** 数据集是否可取数(语义数据集或"连接+SQL"就绪)。 */
function datasetReady(dataset: DashboardDocument["datasets"][number]): boolean {
  return Boolean(dataset.metricIds) || Boolean(dataset.connectionId && dataset.sql.trim());
}

/** 重新取数时保留旧结果，同时明确进入 loading；渲染层会像 v1 一样盖加载蒙层。 */
function refetching(prev: DashboardRuntimeData | undefined): DashboardRuntimeData {
  return prev?.result ? { ...prev, loading: true, error: undefined } : { loading: true };
}

/**
 * 依赖签名只取「会改变这次查询」的那几项。
 *
 * 原来是把整份 datasets 序列化。里面现在还带着重编用的原料(整个数据集定义,八十列的
 * 宽表就是八十个字段对象),而且每个组件一份 —— 同一个数据集会被抄二十遍。这个签名
 * 每次渲染都要算一遍,白白把几百 KB 的对象转成字符串。
 * 真正决定要不要重跑的只有:查哪个连接、哪句 SQL、以及那几个会改写 SQL 的旋钮。
 */
function querySignatureOf(datasets: DashboardDataset[] | undefined): string {
  return JSON.stringify((datasets ?? []).map((d) => [
    d.id, d.connectionId, d.database ?? "", d.sql,
    d.metricIds ?? null, d.groupBy ?? null, d.metricScope ?? null,
  ]));
}

const SOH = String.fromCharCode(1);

/** 取数上限:明细表要看全量(自身分页,DOM 不受影响),图表/KPI 维持较小上限。 */
/* 明细表的取数上限。顶到后端允许的最大值(queryRuntime 那儿的钳位就是 20 万)——
   日粒度下几百家店乘一年就是二十万行往上,原来卡在 5 万,截掉的四分之三是悄悄没的:
   界面上只写「536 行」,看着像是全部。现在一是排序编进了 SQL(截的是对的那一段),
   二是真截了会在表格上直说。 */
const TABLE_ROWS = 200_000;
const CHART_ROWS = 5_000;
const rowsFor = (document: DashboardDocument | undefined, datasetId: string) =>
  document?.widgets.some((w) => (w.id === datasetId || w.datasetId === datasetId) && w.type === "table") ? TABLE_ROWS : CHART_ROWS;

/** V1 merge semantics: a component date narrows the current date window, while
 * repeated dimension predicates are ANDed by the query compiler (set intersection). */
export function componentQueryDataset(dataset: DashboardDataset, value: ComponentFilterValue | undefined): DashboardDataset {
  if (!value?.start && !value?.end) return dataset;
  const scope = dataset.metricScope ?? defaultMetricScope();
  const start = value.start && value.start > scope.start ? value.start : scope.start;
  const end = value.end && value.end < scope.end ? value.end : scope.end;
  return { ...dataset, metricScope: { ...scope, start, end } };
}

export function componentQueryFilters(widget: DashboardWidget, value: ComponentFilterValue | undefined) {
  if (!widget.filtersEnabled || !value) return [];
  const allowed = new Set(widget.filterFields ?? []);
  return Object.entries(value.selections)
    .filter(([field, values]) => field !== "date" && allowed.has(field as DashboardComponentFilterField) && values.length > 0)
    .map(([field, values]) => ({ field, kind: "in" as const, value: values.join(SOH) }));
}

/**
 * 基础运行时:为每个可取数的数据集执行一次查询(不带看板筛选)。
 * document.datasets 变化、中心指标变化或强制刷新(runtimeRevision)时防抖重跑。
 */
export function useDatasetRuntime(
  document: DashboardDocument | undefined,
  centralMetrics: Metric[],
  runtimeRevision: number,
  t: Translate,
): [RuntimeMap, Dispatch<SetStateAction<RuntimeMap>>] {
  const [runtime, setRuntime] = useState<RuntimeMap>({});
  const querySignature = querySignatureOf(document?.datasets);
  useEffect(() => {
    if (!document) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      for (const dataset of document.datasets) {
        if (!datasetReady(dataset)) continue;
        setRuntime((current) => ({ ...current, [dataset.id]: refetching(current[dataset.id]) }));
        void executeDataset(dataset, t, rowsFor(document, dataset.id), [], WIDGET_TIMEOUT_SECS)
          .then((result) => !cancelled && setRuntime((current) => ({ ...current, [dataset.id]: { loading: false, result } })))
          .catch((error) => !cancelled && setRuntime((current) => ({ ...current, [dataset.id]: { loading: false, error: String(error) } })));
      }
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [querySignature, centralMetrics, runtimeRevision]);
  return [runtime, setRuntime];
}

/**
 * 筛选运行时:仅为"有生效筛选(看板筛选器或下钻)"的数据集重跑带筛选的查询。
 * 无生效筛选的数据集不在此表中,画布回退到基础运行时。
 */
export function useFilteredRuntime(
  document: DashboardDocument | undefined,
  filterValues: DashboardFilterValues,
  drill: DashboardDrillFilter | undefined,
  runtimeRevision: number,
  t: Translate,
): [RuntimeMap, Dispatch<SetStateAction<RuntimeMap>>] {
  const [filteredRuntime, setFilteredRuntime] = useState<RuntimeMap>({});
  const querySignature = querySignatureOf(document?.datasets);
  useEffect(() => {
    if (!document) return;
    const targets = document.datasets
      .map((dataset) => ({ dataset, filters: activeDashboardFilters(dataset, document.filters, filterValues, drill) }))
      .filter((target) => target.filters.length > 0 && datasetReady(target.dataset));
    if (targets.length === 0) {
      setFilteredRuntime({});
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const activeIds = new Set(targets.map((target) => target.dataset.id));
      setFilteredRuntime((current) => Object.fromEntries(Object.entries(current).filter(([id]) => activeIds.has(id))));
      for (const target of targets) {
        const id = target.dataset.id;
        setFilteredRuntime((current) => ({ ...current, [id]: refetching(current[id]) }));
        void executeDataset(target.dataset, t, rowsFor(document, target.dataset.id), target.filters, WIDGET_TIMEOUT_SECS)
          .then((result) => { if (!cancelled) setFilteredRuntime((current) => ({ ...current, [id]: { loading: false, result } })); })
          .catch((error) => { if (!cancelled) setFilteredRuntime((current) => ({ ...current, [id]: { loading: false, error: String(error) } })); });
      }
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [querySignature, document?.filters, filterValues, drill, runtimeRevision, t]);
  return [filteredRuntime, setFilteredRuntime];
}

/** 版本历史:文档切换时加载其发布版本列表。 */
export function useDashboardVersions(
  documentId: string | undefined,
): [DashboardDocument[], Dispatch<SetStateAction<DashboardDocument[]>>] {
  const [versions, setVersions] = useState<DashboardDocument[]>([]);
  useEffect(() => {
    if (!documentId) return;
    let cancelled = false;
    dashboardRepository.listVersions(documentId)
      .then((items) => !cancelled && setVersions(items))
      .catch((error) => useApp.getState().showToast({ kind: "error", text: String(error) }));
    return () => { cancelled = true; };
  }, [documentId]);
  return [versions, setVersions];
}

/** 下钻路径:每层记录"用哪个维度、选了哪个值"。层级 = 路径长度。 */
export type DrillPath = { dimension: string; value: string }[];
export type DrillPathMap = Record<string, DrillPath>; // key = widgetId

/**
 * 多级下钻运行时:为每个"配置了 drillDimensions 的 bar/pie 组件",
 * 按当前层级维度(drillDimensions[path.length])分组、叠加路径值 + 看板筛选,重新取数。
 * 返回按 datasetId 索引的结果,canvasRuntime 用它覆盖这些组件的基础运行时。
 */
export function useDrillRuntime(
  document: DashboardDocument | undefined,
  filterValues: DashboardFilterValues,
  drillPaths: DrillPathMap,
  runtimeRevision: number,
  t: Translate,
): RuntimeMap {
  const [map, setMap] = useState<RuntimeMap>({});
  const targets = document
    ? document.widgets.filter((w) => (w.type === "bar" || w.type === "pie" || w.type === "funnel") && (w.options.chart?.drillDimensions?.length ?? 0) > 0)
    : [];
  const signature = JSON.stringify({
    datasets: querySignatureOf(document?.datasets),
    filters: document?.filters,
    filterValues,
    drillPaths,
    runtimeRevision,
    dims: targets.map((w) => [w.id, w.datasetId, w.options.chart?.drillDimensions]),
  });
  useEffect(() => {
    if (!document || targets.length === 0) { setMap({}); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      /* 只有「真的钻进去了」的组件才有这份数据。回到第 0 层就该从表里去掉 ——
         留着的话画布优先用它(那是按下一层维度分组的),而渲染层已经回到当前维度了,
         两边对不上,组件当场变成「请选择维度和指标」。这就是「下钻能用、一返回就空」。

         结果按组件 id 存(编译产物就是按组件 id 的),剪枝也得按组件 id ——
         拿 datasetId 去对一个也对不上,等于每跑一次就把整张表清空重来。 */
      const drilled = targets.filter((w) => (drillPaths[w.id] ?? []).length > 0);
      const ids = new Set(drilled.map((w) => w.id));
      setMap((current) => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
      for (const widget of drilled) {
        const dataset = datasetOf(widget, document.datasets);
        if (!dataset || !datasetReady(dataset)) continue;
        const dims = widget.options.chart!.drillDimensions!;
        const path = drillPaths[widget.id] ?? [];
        // 第 0 层是组件自己绑的维度(基础运行时那份就是),第 k 层才换成链里的第 k-1 个。
        const level = Math.min(path.length, dims.length);
        const filters = [
          ...activeDashboardFilters(dataset, document.filters, filterValues, undefined),
          ...path.map((p) => ({ field: p.dimension, kind: "select" as const, value: p.value })),
        ];
        const drilled = { ...dataset, groupBy: [dims[level - 1]] };
        setMap((current) => ({ ...current, [dataset.id]: refetching(current[dataset.id]) }));
        void executeDataset(drilled, t, 5_000, filters, WIDGET_TIMEOUT_SECS)
          .then((result) => { if (!cancelled) setMap((current) => ({ ...current, [dataset.id]: { loading: false, result } })); })
          .catch((error) => { if (!cancelled) setMap((current) => ({ ...current, [dataset.id]: { loading: false, error: String(error) } })); });
      }
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, t]);
  return map;
}

/** Component-local filter runtime, keyed by widget id. It layers the V1 local
 * controls over global filters and the current drill path without mutating either. */
export function useComponentRuntime(
  document: DashboardDocument | undefined,
  globalValues: DashboardFilterValues,
  componentValues: ComponentFilterValueMap,
  drillPaths: DrillPathMap,
  runtimeRevision: number,
  t: Translate,
): RuntimeMap {
  const [map, setMap] = useState<RuntimeMap>({});
  const signature = JSON.stringify({
    datasets: querySignatureOf(document?.datasets),
    filters: document?.filters,
    widgets: document?.widgets.map((w) => [w.id, w.datasetId, w.filtersEnabled, w.filterFields, w.options.chart?.drillDimensions]),
    globalValues,
    componentValues,
    drillPaths,
    runtimeRevision,
  });
  useEffect(() => {
    if (!document) return;
    const targets = document.widgets.flatMap((widget) => {
      const value = componentValues[widget.id];
      const local = componentQueryFilters(widget, value);
      const dataset = document.datasets.find((d) => d.id === widget.id);
      /* 日期区间可能挂在保留名 "date" 上,也可能挂在数据集的日期轴字段上(勾了"统计日期"
         这种维度时)。这儿跟画控件用的是同一个判定,否则控件给了日历、选完却不重新取数。 */
      const hasDate = widget.filtersEnabled && dateFilterFieldsOf(widget, dataset).length > 0 && !!(value?.start || value?.end);
      if (!hasDate && local.length === 0) return [];
      if (!dataset || !datasetReady(dataset)) return [];
      const path = drillPaths[widget.id] ?? [];
      const filters = [
        ...activeDashboardFilters(dataset, document.filters, globalValues, undefined),
        ...local,
        ...path.map((p) => ({ field: p.dimension, kind: "select" as const, value: p.value })),
      ];
      let scoped = componentQueryDataset(dataset, value);
      /* 跟下钻运行时同一套层级:第 0 层就是组件自己绑的维度(不改分组),
         第 k 层才换成链里的第 k-1 个。这里原来还是老算法,path 为空时按 dims[0] 分组,
         于是开了组件筛选器的图一进来就按下一层维度出数。 */
      const dims = widget.options.chart?.drillDimensions ?? [];
      const level = Math.min(path.length, dims.length);
      if (level > 0) scoped = { ...scoped, groupBy: [dims[level - 1]] };
      return [{ widget, dataset: scoped, filters }];
    });
    if (targets.length === 0) { setMap({}); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const ids = new Set(targets.map(({ widget }) => widget.id));
      setMap((current) => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
      for (const { widget, dataset, filters } of targets) {
        setMap((current) => ({ ...current, [widget.id]: refetching(current[widget.id]) }));
        void executeDataset(dataset, t, widget.type === "table" ? TABLE_ROWS : CHART_ROWS, filters, WIDGET_TIMEOUT_SECS)
          .then((result) => { if (!cancelled) setMap((current) => ({ ...current, [widget.id]: { loading: false, result } })); })
          .catch((error) => { if (!cancelled) setMap((current) => ({ ...current, [widget.id]: { loading: false, error: String(error) } })); });
      }
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, t]);
  return map;
}

const DAY_MS = 86_400_000;
const parseDay = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1)); };
const fmtDay = utcDay;  // 上面全程 Date.UTC 造日期,UTC 就是它唯一的含义

const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
/** 整自然月选择(1 号 → 当月最后一天)。 */
const isWholeMonth = (s: Date, e: Date) =>
  s.getUTCFullYear() === e.getUTCFullYear() && s.getUTCMonth() === e.getUTCMonth()
  && s.getUTCDate() === 1 && e.getUTCDate() === lastDay(e.getUTCFullYear(), e.getUTCMonth());
/** 整自然年选择(1/1 → 12/31)。 */
const isWholeYear = (s: Date, e: Date) =>
  s.getUTCFullYear() === e.getUTCFullYear()
  && s.getUTCMonth() === 0 && s.getUTCDate() === 1 && e.getUTCMonth() === 11 && e.getUTCDate() === 31;
/** 前移 n 年;2/29 这类目标年不存在的日期钳到当月最后一天(否则会溢出到 3/1)。 */
const shiftYears = (dt: Date, n: number) => {
  const year = dt.getUTCFullYear() + n;
  const month = dt.getUTCMonth();
  return new Date(Date.UTC(year, month, Math.min(dt.getUTCDate(), lastDay(year, month))));
};

/**
 * 把日期范围平移到对比周期:
 * - period(环比):选的是整月/整年时按「上一个自然月/自然年」对齐(符合直觉);
 *   其它区间退回紧邻的等长窗口 —— end 落在原 start 前一天。
 * - year(同比):原窗口整体前移一年(闰日钳到 2/28)。
 */
export function shiftScope(scope: QueryScope, kind: "period" | "year"): QueryScope {
  const start = parseDay(scope.start);
  const end = parseDay(scope.end);
  if (kind === "year") {
    return { ...scope, start: fmtDay(shiftYears(start, -1)), end: fmtDay(shiftYears(end, -1)) };
  }
  // 整月:2026-03 的环比应是 2026-02 整月,而不是「往前推 31 天」倒灌进 1 月。
  if (isWholeMonth(start, end)) {
    const year = start.getUTCMonth() === 0 ? start.getUTCFullYear() - 1 : start.getUTCFullYear();
    const month = start.getUTCMonth() === 0 ? 11 : start.getUTCMonth() - 1;
    return { ...scope, start: fmtDay(new Date(Date.UTC(year, month, 1))), end: fmtDay(new Date(Date.UTC(year, month, lastDay(year, month)))) };
  }
  if (isWholeYear(start, end)) {
    const year = start.getUTCFullYear() - 1;
    return { ...scope, start: `${year}-01-01`, end: `${year}-12-31` };
  }
  const lenDays = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  const newEnd = new Date(start.getTime() - DAY_MS);
  const newStart = new Date(newEnd.getTime() - lenDays * DAY_MS);
  return { ...scope, start: fmtDay(newStart), end: fmtDay(newEnd) };
}

/**
 * 同比/环比运行时:仅为"开启对比的 KPI 组件"所属数据集,按平移后的日期范围
 * 各跑一次(环比 + 同比)取数。KPI 组件据此与当前值算涨跌%。
 */
export function useComparisonRuntime(
  document: DashboardDocument | undefined,
  globalValues: DashboardFilterValues,
  componentValues: ComponentFilterValueMap,
  runtimeRevision: number,
  t: Translate,
): ComparisonMap {
  const [map, setMap] = useState<ComparisonMap>({});
  const targets = document
    ? document.widgets.filter((w) => w.type === "kpi" && w.options.kpi?.showComparison)
    : [];
  const compareSignature = JSON.stringify(targets.map((w) => [w.id, w.datasetId, w.filtersEnabled, w.filterFields, componentValues[w.id]]));
  const querySignature = querySignatureOf(document?.datasets);
  useEffect(() => {
    if (!document || targets.length === 0) { setMap({}); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const ids = new Set(targets.map((w) => w.id));
      setMap((current) => Object.fromEntries(Object.entries(current).filter(([id]) => ids.has(id))));
      for (const widget of targets) {
        /* 编译产物按组件 id 存。这里原来整段按 datasetId 找,数据集模型下一个也找不到,
           于是同环比从来没跑过 —— 开关点得响,数字永远不出来。 */
        const dataset = datasetOf(widget, document.datasets);
        const id = dataset?.id ?? widget.id;
        if (!dataset || !datasetReady(dataset)) continue;
        const scoped = componentQueryDataset(dataset, componentValues[widget.id]);
        const base = scoped.metricScope ?? defaultMetricScope();
        const filters = [
          ...activeDashboardFilters(dataset, document.filters, globalValues, undefined),
          ...componentQueryFilters(widget, componentValues[widget.id]),
        ];
        const run = (kind: "period" | "year") => executeDataset({ ...scoped, metricScope: shiftScope(base, kind) }, t, 5_000, filters, WIDGET_TIMEOUT_SECS);
        void Promise.allSettled([run("period"), run("year")]).then(([period, year]) => {
          if (cancelled) return;
          setMap((current) => ({
            ...current,
            [id]: {
              period: period.status === "fulfilled" ? period.value : undefined,
              year: year.status === "fulfilled" ? year.value : undefined,
            },
          }));
        });
      }
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareSignature, querySignature, globalValues, runtimeRevision, t]);
  return map;
}


/**
 * 把四路运行时合成画布真正要用的那一份。
 *
 * 一个数据集同时可能有:基础取数、带筛选的取数、下钻取数、同环比对比;
 * 组件级筛选还会再产生一份按 widgetId 的。优先级从窄到宽 ——
 * 下钻 > 组件筛选 > 全局筛选 > 基础。
 *
 * 从 DashboardWorkspace 搬出来的纯函数:输入输出都是数据,和 React 无关,
 * 所以能直接断言测。组件那边留一层 useMemo 就行。
 */
export function mergeCanvasRuntime(
  document: DashboardDocument,
  parts: {
    runtime: Record<string, DashboardRuntimeData>;
    filteredRuntime: Record<string, DashboardRuntimeData>;
    drillRuntime: Record<string, DashboardRuntimeData>;
    componentRuntime: Record<string, DashboardRuntimeData>;
    comparisonRuntime: Record<string, DashboardRuntimeData["comparison"]>;
  },
  activeFilters: (dataset: DashboardDataset) => unknown[],
): Record<string, DashboardRuntimeData> {
  const byDataset = Object.fromEntries(document.datasets.map((dataset) => {
    const active = activeFilters(dataset);
    // 下钻组件用 drillRuntime 覆盖基础/筛选运行时;否则按是否有生效筛选二选一。
    const base = parts.drillRuntime[dataset.id]
      ?? (active.length > 0
        ? parts.filteredRuntime[dataset.id] ?? { loading: true }
        : parts.runtime[dataset.id] ?? { loading: Boolean(dataset.metricIds || (dataset.connectionId && dataset.sql.trim())) });
    const comparison = parts.comparisonRuntime[dataset.id];
    return [dataset.id, comparison ? { ...base, comparison } : base];
  }));
  const byWidget = Object.fromEntries(Object.entries(parts.componentRuntime).map(([widgetId, data]) => {
    const widget = document.widgets.find((item) => item.id === widgetId);
    const comparison = widget ? parts.comparisonRuntime[widget.id] ?? parts.comparisonRuntime[widget.datasetId] : undefined;
    return [widgetId, comparison ? { ...data, comparison } : data];
  }));
  return { ...byDataset, ...byWidget };
}

/** 往下钻一层。已经到最深一层时返回 null(调用方据此不动)。纯函数,好测。 */
/**
 * 再钻一层。
 *
 * `dimensions` 是下钻链(往下能钻到哪几层),`current` 是这个组件现在按什么分组 ——
 * 点中的那个值属于 current,不属于链里的任何一层。原来记成 dimensions[path.length],
 * 等于假设链的第一项就是当前维度;界面允许你选别的,一选就错位:筛选条件挂到了
 * 另一个字段上,数字全不对。
 */
export function nextDrillPath(
  dimensions: string[],
  path: { dimension: string; value: string }[],
  value: string,
  current: string,
): { dimension: string; value: string }[] | null {
  if (path.length >= dimensions.length) return null;
  const dimension = path.length === 0 ? current : dimensions[path.length - 1];
  if (!dimension) return null;
  return [...path, { dimension, value }];
}
