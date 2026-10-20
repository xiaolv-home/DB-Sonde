import type { Metric } from "../metrics/metricsStore";
import { compileMetric, metricDateWhere, metricTimeColumn } from "../metrics/metricSql";
import { defaultMetricScope, planTemplates, planIsRatio, type QueryScope } from "../metrics/queryPlan";
import type { DashboardDataset, DashboardDocument, DashboardMetricAggregation, DashboardMetricDefinition, DashboardWidget } from "./domain";
import type { DbKind } from "../../types";
import { sqlLiteral } from "../../lib/sql";

export const metricField = (m: Metric) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(m.key) ? m.key : "value");
export function availableDimensions(metrics: Metric[]): string[] {
  return [...new Set(metrics[0]?.dimensions ?? [])].filter((d) => metrics.every((m) => m.dimensions?.includes(d)));
}
export function semanticDataset(widget: DashboardWidget, metrics: Metric[], scope?: QueryScope): DashboardDataset {
  const ids = [...new Set([...widget.bindings.metricIds, ...widget.bindings.secondaryMetricIds])];
  const selected = ids.map((id) => metrics.find((m) => m.id === id)).filter((m): m is Metric => !!m);
  const dims = availableDimensions(selected);
  const analysisDims = widget.bindings.dimensions?.length
    ? widget.bindings.dimensions
    : [widget.bindings.dimension].filter((d): d is string => !!d);
  const groups =
    widget.type === "kpi"
      ? []
      : [...new Set([...analysisDims, widget.bindings.seriesDimension].filter((d): d is string => !!d))];
  const first = selected[0];
  return {
    id: `semantic:${widget.id}`,
    name: selected.map((m) => m.name).join("、") || "选择指标",
    sourceType: "sql",
    connectionId: first?.connId ?? "",
    database: first?.database,
    sql: "",
    metricIds: ids,
    groupBy: groups,
    dimensionLabels: first?.dimensionLabels,
    metricScope: scope ?? defaultMetricScope(),
    fields: [
      ...dims.map((name) => ({ name, typeName: "", role: "dimension" as const })),
      ...selected.map((m) => ({ name: metricField(m), typeName: "", role: "measure" as const })),
    ],
  };
}
/** 显示层「再聚合」方式 —— 当显示粒度粗于查询粒度时(表格小计/列总计、图表把多行并到一个 x)
 *  用它把已聚合的值再合一次。比率/派生指标绝不能加总(会得到 100%+ 的荒唐值),用平均近似;
 *  measure 沿用自身聚合函数;template/sql 无法内省,按单位兜底(带 % 的用平均)。 */
/**
 * 这个聚合表达式跨行相加有没有意义。
 *
 * 两种不可加的形状:
 *  - **顶层除法**:`SUM(gmv)/NULLIF(SUM(orders),0)` 是比率,31 天的笔均金额加起来
 *    等于 31 倍的笔均金额。注意要判"顶层" —— `SUM(a/b)` 里的除号在括号内,那个是可加的。
 *  - **COUNT(DISTINCT …)**:每天的去重网点数加起来会把同一家店数很多遍。
 */
/**
 * 一个聚合表达式能不能跨行相加,不能的话属于哪一种。
 *
 * 分两种是因为后果不同:COUNT(DISTINCT) 跨组既不能加也不能平均(同一家店在两个组里
 * 出现就会重复计数),只能回数据库重查;比率和均值跨组至少还能按平均粗看一眼。
 */
export function additivity(expression: string): "additive" | "count_distinct" | "avg" {
  const body = expression
    .replace(/\{\{[a-zA-Z]+\}\}/g, "")      // 去掉 {{select}} 这类占位
    .replace(/\s+AS\s+\w+\s*$/i, "")        // 去掉尾部的 AS value
    .trim();
  if (/^COUNT\s*\(\s*DISTINCT/i.test(body)) return "count_distinct";
  if (/^(AVG|MIN|MAX)\s*\(/i.test(body)) return "avg";
  let level = 0;
  for (const char of body) {
    if (char === "(") level++;
    else if (char === ")") level--;
    else if (char === "/" && level === 0) return "avg";   // 顶层除法 = 比率
  }
  return "additive";
}

export function isAdditiveExpression(expression: string): boolean {
  const body = expression
    .replace(/\{\{[a-zA-Z]+\}\}/g, "")
    .replace(/\s+AS\s+\w+\s*$/i, "")
    .trim();
  if (/^COUNT\s*\(\s*DISTINCT/i.test(body)) return false;
  if (/^(AVG|MIN|MAX)\s*\(/i.test(body)) return false;
  let depth = 0;
  for (const char of body) {
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (char === "/" && depth === 0) return false; // 顶层除法 = 比率
  }
  return true;
}

/** 从 template 指标的 SQL 模板里取出 value 表达式(SELECT 和 FROM 之间那段)。 */
function templateValueExpression(template: string): string {
  const match = /SELECT([\s\S]*?)\bFROM\b/i.exec(template);
  return (match?.[1] ?? "").trim();
}

/**
 * 这个指标的算式是不是去重计数。
 *
 * 跟 metricRollup 不是一回事:那个说的是「跨组怎么合并」(可以由人声明),
 * 这个说的是「不分组查一次,得到的是不是同一个量」—— 去重计数天然不是:
 * 按网点分组时各店天数加起来是网点有效天数,不分组查出来是日历天数。
 * 所以对它做「总分对齐」体检是拿两个不同的量在比,比出来的差不是错。
 */
export function isDistinctCount(m: Metric): boolean {
  if (m.type === "ratio" || m.type === "derived") return false;
  const expressions = m.type === "measure" ? [m.expression ?? ""]
    : m.type === "template" && m.queryPlan ? planTemplates(m.queryPlan).map(templateValueExpression)
      : [templateValueExpression(m.sql ?? "")];
  const usable = expressions.filter(Boolean);
  return usable.length > 0 && usable.every((e) => additivity(e) === "count_distinct");
}

export function metricRollup(m: Metric): DashboardMetricAggregation {
  /* 定义指标的人填了就听他的。下面那一整套是**猜**,而有些意图从 SQL 里看不出来:
     「有效天数」= COUNT(DISTINCT 日期) 按网点分组后求和是网点有效天数(日均的分母),
     不分组查出来是日历天数 —— 两个都对,猜不出要哪个。 */
  if (m.rollup) return m.rollup;
  if (m.type === "ratio" || m.type === "derived") return "avg";
  if (m.type === "measure") {
    const expression = (m.expression ?? "").trim();
    const head = expression.toUpperCase();
    if (head.startsWith("MIN(")) return "min";
    if (head.startsWith("MAX(")) return "max";
    /* 以前这儿只认 AVG/MIN/MAX 三个前缀,别的一律当可加 —— 于是
       「有效天数」= COUNT(DISTINCT 日期) 被判成求和:按网点分组一加,31 天变成 310,
       真机上是靠「总分对齐」体检拦下来的(而且因为拦在主查询上,整个分析直接停了)。
       下面 template/sql 型走的本来就是 additivity 这一条规则,measure 型也该走同一条,
       不该各认各的。 */
    const kind = additivity(expression);
    return kind === "additive" ? "sum" : kind;
  }
  /* template / sql 型:以前只看单位带不带 %,于是「笔均金额」(单位是元)被当成可加的,
     31 天的笔均金额一加就成了 815 —— 真实值是 26。真机上是靠「总分对齐」体检抓出来的。
     现在直接看它的聚合表达式:顶层有除法、或者是 COUNT(DISTINCT) 就不可加。 */
  if ((m.unit ?? "").includes("%")) return "avg";
  /* ratio 型计划按定义就不可加 —— 别去看它分子分母长什么样。
     踩过:「店均预存金额」= 预存金额 ÷ 营业网点日数,分子是 SUM(...) 看着可加,
     于是整体被判成 sum,跨行一加就成了没有意义的数。 */
  if (m.type === "template" && m.queryPlan && planIsRatio(m.queryPlan)) return "avg";
  const expressions = m.type === "template" && m.queryPlan
    ? planTemplates(m.queryPlan).map(templateValueExpression)
    : [templateValueExpression(m.sql ?? "")];
  const usable = expressions.filter(Boolean);
  if (usable.length && usable.every((e) => additivity(e) !== "additive")) {
    // 全是 COUNT(DISTINCT) 才算 count_distinct;混着比率就按比率看(两者都不可加)
    return usable.every((e) => additivity(e) === "count_distinct") ? "count_distinct" : "avg";
  }
  return "sum";
}
export function semanticDefinitions(ds: DashboardDataset, metrics: Metric[]): DashboardMetricDefinition[] {
  return (ds.metricIds ?? []).flatMap((id) => {
    const m = metrics.find((m) => m.id === id);
    return m
      ? [
          {
            id,
            name: m.name,
            description: m.caliber,
            datasetId: ds.id,
            field: metricField(m),
            aggregation: metricRollup(m),
            unit: m.unit,
            decimals: m.precision ?? 2,
            direction:
              m.higherIsBetter === undefined
                ? ("neutral" as const)
                : m.higherIsBetter
                  ? ("higher" as const)
                  : ("lower" as const),
            // 随日期 scope 变化才谈得上同环比:queryPlan 指标靠模板 {{start}}/{{end}},
            // measure/ratio 指标靠时间列下推(metricTimeColumn)。
            dateScoped: !!m.queryPlan || !!metricTimeColumn(m),
          },
        ]
      : [];
  });
}
/** Rebuild only presentation/query metadata; metric definitions remain in the center. */
export function resolveSemanticDocument(doc: DashboardDocument, metrics: Metric[]): DashboardDocument {
  const semantic = doc.widgets.filter((w) => w.datasetId.startsWith("semantic:") && w.type !== "text" && w.type !== "container");
  // 组件锁定数据范围时,用组件自己的日期覆盖全局,并把维度锁定值作为 IN 筛选烘进 scope。
  const datasets = semantic.map((w) => {
    const lock = w.options.lockedScope;
    if (!lock) return semanticDataset(w, metrics, doc.metricScope);
    const base = doc.metricScope ?? defaultMetricScope();
    const sep = String.fromCharCode(1);
    const lockedFilters = Object.entries(lock.filters ?? {})
      .filter(([, values]) => values.length > 0)
      .map(([field, values]) => ({ field, kind: "in" as const, value: values.join(sep) }));
    const scope = { ...base, start: lock.start ?? base.start, end: lock.end ?? base.end, filters: [...(base.filters ?? []), ...lockedFilters] };
    return semanticDataset(w, metrics, scope);
  });
  const old = doc.datasets.filter((d) => !d.metricIds);
  return {
    ...doc,
    datasets: [...old, ...datasets],
    metrics: [
      ...doc.metrics.filter((m) => !m.datasetId.startsWith("semantic:")),
      ...datasets.flatMap((ds) => semanticDefinitions(ds, metrics)),
    ],
  };
}
/* 取值转义只此一份 —— 这儿原来自己写了一套,跟 lib/sql.ts 那份行为还不一样:
   MySQL 开了 NO_BACKSLASH_ESCAPES 时,自己这套的「反斜杠加倍」会多插一个真反斜杠,
   筛选就匹配不到数据。lib 那份改用 hex(CONVERT(X'..' USING utf8mb4))绕开了整件事。
   同一件事两套写法,迟早走散,而这里处理的是用户在筛选框里输入的值。 */
export { sqlLiteral };

export function compileSemanticDataset(
  ds: DashboardDataset,
  metrics: Metric[],
  filters: QueryScope["filters"] = [],
  dialect?: DbKind,
): { sql: string; connectionId: string; database?: string } {
  const selected = (ds.metricIds ?? []).map((id) => {
    const m = metrics.find((m) => m.id === id);
    if (!m) throw new Error("引用的指标已删除，请重新选择指标");
    if (!m.enabled) throw new Error(`指标「${m.name}」已停用`);
    if (!m.connId) throw new Error(`指标「${m.name}」尚未绑定连接`);
    return m;
  });
  if (!selected.length) throw new Error("请选择指标中心的指标");
  if (selected.some((m) => m.connId !== selected[0].connId || m.database !== selected[0].database))
    throw new Error("同一图表的指标须使用同一数据连接与数据库");
  const dims = ds.groupBy ?? [];
  if (dims.some((d) => !availableDimensions(selected).includes(d)))
    throw new Error("所选维度不适用于当前指标，请重新选择维度");
  // 合并:数据集自带的锁定筛选(ds.metricScope.filters,组件级锁定)+ 传入的看板筛选/下钻。
  const mergedFilters = [...(ds.metricScope?.filters ?? []), ...filters];
  const scope = { ...(ds.metricScope ?? defaultMetricScope()), filters: mergedFilters };
  // 把结构化筛选编译成 raw WHERE 传给普通指标(compileMetric.opts.filters);
  // v1 queryPlan 指标另走 scope.filters。多选(in)的 value 用 SOH 连接多个值。
  const sep = String.fromCharCode(1);
  const lit = (v: string) => sqlLiteral(v, dialect);
  const whereExpr = mergedFilters
    .filter((f) => f.value && /^[A-Za-z_][A-Za-z0-9_]*$/.test(f.field))
    .map((f) => {
      if (f.kind === "in") {
        const vs = f.value.split(sep).filter(Boolean);
        return vs.length ? `${f.field} IN (${vs.map(lit).join(", ")})` : "";
      }
      if (f.kind === "text") return `${f.field} LIKE ${lit("%" + f.value + "%")}`;
      return `${f.field} = ${lit(f.value)}`;
    })
    .filter(Boolean)
    .join(" AND ");
  // 性能优化:把同一基表的 measure/ratio 指标归并成一条 GROUP BY(共享 FROM/WHERE/GROUP BY),
  // 避免"每指标一个 CTE + N 路 NULL 安全自连接"——那是明细表多指标 × 多维度时慢/超时的根因。
  // template(queryPlan)/sql/derived 或异源指标不可合并,各自成条,最后仅在跨单元时按维度 JOIN。
  const mergeExpr = (m: Metric): string | null => {
    if (m.type === "measure" && m.source && m.expression) return m.expression;
    if (m.type === "ratio" && m.source && m.numerator && m.denominator)
      return `(${m.numerator})/NULLIF(${m.denominator},0)${m.scale ? `*${m.scale}` : ""}`;
    return null;
  };
  const dimSel = dims.length ? `${dims.join(", ")}, ` : "";
  const dimGrp = dims.length ? ` GROUP BY ${dims.join(", ")}` : "";
  const units: { sql: string }[] = [];
  const fieldUnit: Record<string, number> = {}; // 指标字段 → 所在单元下标
  /* derived(指标 ÷ 指标)带维度分组时,compileMetric 只能给出一条没有维度的标量查询
     (`SELECT (子查询)/(子查询) AS x`),塞进多单元合并里,外层就找不到维度列 ——
     Unknown column 'outlet_region' in 'field list'。
     所以把它拆回分子/分母两个指标各自入组,比值放到外层用聚合后的两列现算。
     这本来就是它的口径:分子分母各自按自己的事实表汇总,然后相除。
     分子/分母不是 measure/ratio(拆不开)时,退回原来的标量路径。 */
  const expandedDerived: { metric: Metric; num: Metric; den: Metric }[] = [];
  const expanded: Metric[] = [];
  for (const m of selected) {
    const num = m.type === "derived" ? metrics.find((x) => x.id === m.numeratorMetricId) : undefined;
    const den = m.type === "derived" ? metrics.find((x) => x.id === m.denominatorMetricId) : undefined;
    if (m.type === "derived" && num && den && mergeExpr(num) && mergeExpr(den)) {
      expandedDerived.push({ metric: m, num, den });
      expanded.push(num, den);
    } else {
      // 拆不开又要分组:compileMetric 只会给标量,外层必然找不到维度列。
      // 与其拼出一条注定报 Unknown column 的 SQL,不如当场说清楚是哪个指标的问题。
      if (m.type === "derived" && dims.length)
        throw new Error(`派生指标「${m.name}」的分子/分母暂不支持按维度拆分，请去掉分组或改用度量/比率型分子分母`);
      expanded.push(m);
    }
  }
  // 分子/分母可能就是已选指标(出货率的分母就是销售额),按 id 去重,否则同名列会重复投影。
  const byId = new Map<string, Metric>();
  for (const m of expanded) byId.set(m.id, m);
  const parts = [...byId.values()];
  // 唯一性要在展开之后查:分子/分母也会进内层投影,和别的指标撞名一样拼出 Duplicate column。
  if (new Set(parts.map(metricField)).size !== parts.length)
    throw new Error("图表内指标字段标识重复，请在指标中心设置唯一标识");
  // 展开后维度必须对分子/分母也成立 —— 否则会拼出跨表歧义列,报错难懂。
  const partDims = availableDimensions(parts);
  if (dims.some((d) => !partDims.includes(d)))
    throw new Error("所选维度不适用于当前指标，请重新选择维度");
  // 归并键 = 基表 + 日期谓词:同表同日期条件的指标共享 FROM/WHERE/GROUP BY,合成一条。
  const groups = new Map<string, { source: string; dateWhere: string; ms: Metric[] }>();
  const solos: Metric[] = [];
  for (const m of parts) {
    if (mergeExpr(m)) {
      const dateWhere = metricDateWhere(m, scope);
      const key = `${m.source}\u0000${dateWhere}`;
      const g = groups.get(key) ?? { source: m.source!, dateWhere, ms: [] };
      g.ms.push(m);
      groups.set(key, g);
    } else solos.push(m);
  }
  for (const [, g] of groups) {
    const proj = g.ms.map((m) => `${mergeExpr(m)} AS ${metricField(m)}`).join(", ");
    const parts = [g.dateWhere, whereExpr].filter(Boolean);
    const wc = parts.length ? ` WHERE ${parts.join(" AND ")}` : "";
    const idx = units.push({ sql: `SELECT ${dimSel}${proj} FROM ${g.source}${wc}${dimGrp}` }) - 1;
    g.ms.forEach((m) => { fieldUnit[metricField(m)] = idx; });
  }
  for (const m of solos) {
    const compiled = compileMetric(m, { dialect, groupBy: dims, scope, filters: whereExpr || undefined }, (id) => metrics.find((mm) => mm.id === id));
    if (compiled.error || !compiled.sql) throw new Error(compiled.error || "指标缺少查询定义");
    fieldUnit[metricField(m)] = units.push({ sql: compiled.sql }) - 1;
  }
  if (units.length === 1 && !expandedDerived.length)
    return { sql: units[0].sql, connectionId: selected[0].connId, database: selected[0].database };
  // 多单元合并:不用 N 路 NULL 安全 LEFT JOIN —— `ON (k.d=q.d OR (k.d IS NULL AND q.d IS NULL))`
  // 里的 OR 会让优化器放弃哈希连接、退化成嵌套循环,维度一多就直接跑不出来。
  // 改成 UNION ALL 补空列 + 外层按维度聚合:每个单元各扫一次,最后一次哈希聚合,
  // 对 measure/ratio/template 所有指标类型一视同仁(对齐 v1「各指标分别查、再按维度键合并」)。
  // 内层要带上展开出来的分子/分母列,外层只吐用户选的那几个指标。
  const fields = parts.map(metricField);
  const ctes = units.map((u, i) => `q${i} AS (${u.sql})`);
  const branch = (i: number) =>
    `SELECT ${[...dims, ...fields.map((f) => (fieldUnit[f] === i ? f : `NULL AS ${f}`))].join(", ")} FROM q${i}`;
  const union = units.map((_, i) => branch(i)).join(" UNION ALL ");
  const picks = selected.map((m) => {
    const part = expandedDerived.find((d) => d.metric.id === m.id);
    if (!part) return `MAX(${metricField(m)}) AS ${metricField(m)}`;
    const s = part.metric.scale ? `*${part.metric.scale}` : "";
    return `MAX(${metricField(part.num)})/NULLIF(MAX(${metricField(part.den)}),0)${s} AS ${metricField(m)}`;
  });
  const sql = dims.length
    ? `WITH ${ctes.join(", ")} SELECT ${[...dims, ...picks].join(", ")} FROM (${union}) u GROUP BY ${dims.join(", ")}`
    : `WITH ${ctes.join(", ")} SELECT ${picks.join(", ")} FROM (${union}) u`;
  return { sql, connectionId: selected[0].connId, database: selected[0].database };
}
