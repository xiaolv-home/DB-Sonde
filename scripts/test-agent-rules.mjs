// AI 分析里由代码把关的规则:数据体检、可加性、模型路由、排版与评审、溯源、截断、单位换算、评审越权。全程不调模型。
import assert from "node:assert/strict";
import { loadSrc } from "./lib/load-src.mjs";

const m = loadSrc("agent-rules", {
  "src/features/dashboard/domain.ts": "{ normalizeDashboard }",
  "src/features/dashboard/dashboardService.ts": "* as dash",
  "src/features/dashboard/semantic.ts": "{ isAdditiveExpression, metricRollup }",
  "src/features/ai/aiClient.ts": "{ buildChatRequest }",
  "src/features/agent/jsonSchema.ts": "{ validate, S }",
  "src/features/agent/model/structured.ts": "{ providerFor, routingSummary }",
  "src/features/agent/validation/dataChecks.ts": "{ checkDataset, checkTotals, verdict, expectedPoints }",
  "src/features/agent/layout.ts": "{ packLayout, layoutHeight }",
  "src/features/agent/review.ts": "{ reviewLayout, reviewVerdict, applyFixes, applyJudgement }",
});
const { normalizeDashboard, dash, isAdditiveExpression, metricRollup, buildChatRequest, validate, S, providerFor, routingSummary, checkDataset, checkTotals, verdict, expectedPoints, packLayout, layoutHeight, reviewLayout, reviewVerdict, applyFixes, applyJudgement } = m;

const aiBase = {
  builtin: { model: "builtin", baseUrl: "", ready: false },
  local: { model: "qwen3.5-35b-a3b", baseUrl: "http://127.0.0.1:1234/v1" },
  cloud: { model: "cloud", baseUrl: "", apiKey: "" },
  includeSampleRows: false,
};
const directAi = buildChatRequest({ ...aiBase, provider: "local", thinkingEnabled: false }, aiBase.local.model, []);
const thinkingAi = buildChatRequest({ ...aiBase, provider: "local", thinkingEnabled: true }, aiBase.local.model, []);
const cloudAi = buildChatRequest({ ...aiBase, provider: "cloud", thinkingEnabled: true }, aiBase.cloud.model, []);
assert.equal(directAi.chat_template_kwargs.enable_thinking, false);
assert.equal(thinkingAi.chat_template_kwargs.enable_thinking, true);
assert.equal("chat_template_kwargs" in cloudAi, false);

// ── 数据质量体检:整条链路上最重要的一层,零 LLM ──
const col = (...names) => names.map((name) => ({ name }));
const shape = {
  dimensions: ["day", "store"],
  metrics: [{ field: "gmv", name: "销售额", rollup: "sum", unit: "元" },
            { field: "rate", name: "出货率", rollup: "avg", unit: "%" }],
  timeField: "day", dateRange: { start: "2026-08-01", end: "2026-08-03" }, grain: "day",
};
const qr = (rows) => ({ columns: col("day", "store", "gmv", "rate"), rows, truncated: false });

// 空结果不许拿去画图
assert.equal(checkDataset(qr([]), shape)[0].code, "EMPTY");
assert.equal(verdict(checkDataset(qr([]), shape)).status, "fail");

// 维度组合重复 = GROUP BY 没盖住 / JOIN 放大,求和会重复计算
const dupRows = checkDataset(qr([
  ["2026-08-01", "A", 100, 50], ["2026-08-01", "A", 200, 60],
  ["2026-08-02", "B", 300, 70], ["2026-08-03", "C", 400, 80],
]), shape);
const dupIssue = dupRows.find((i) => i.code === "DUPLICATE_DIMENSIONS");
assert(dupIssue && dupIssue.level === "fail", "同维度多行是硬错");
assert.deepEqual(dupIssue.samples, ["2026-08-01 / A"], "要指出是哪个组合重了");

// 日期缺口:3 天的区间只回来 1 天
const gap = checkDataset(qr([["2026-08-01", "A", 100, 50]]), shape).find((i) => i.code === "TIME_GAPS");
assert(gap && gap.level === "fail", "缺超过 20% 算硬错");
assert(gap.message.includes("应有 3 个"), gap.message);

// 整列空 / 空值过多
const allNull = checkDataset(qr([["2026-08-01", "A", null, 1], ["2026-08-02", "B", null, 2], ["2026-08-03", "C", null, 3]]), shape);
assert(allNull.some((i) => i.code === "ALL_NULL" && i.level === "fail"));

// 负值只对金额/数量类报,比率不报
const neg = checkDataset(qr([["2026-08-01", "A", -5, 50], ["2026-08-02", "B", 10, -1], ["2026-08-03", "C", 20, 30]]), shape);
const negs = neg.filter((i) => i.code === "NEGATIVE");
assert.equal(negs.length, 1, "单位是 % 的比率出现负值不该报,只报金额/数量:" + JSON.stringify(negs.map((n) => n.message)));

// 极端值是 warn 不是 fail —— 那是让分析节点去解释的异常点,不是错误
const spike = checkDataset(qr([["2026-08-01", "A", 10, 1], ["2026-08-02", "B", 10, 1], ["2026-08-03", "C", 10, 1],
                               ["2026-08-01", "D", 12, 1], ["2026-08-02", "E", 9999, 1]]), shape)
  .find((i) => i.code === "OUTLIER");
assert(spike && spike.level === "warn");

// 总分对齐 —— 最能抓出 JOIN 放大这类隐蔽错误的一条
const grouped = qr([["2026-08-01", "A", 100, 50], ["2026-08-02", "B", 200, 60], ["2026-08-03", "C", 300, 70]]);
const totalOk = { columns: col("gmv"), rows: [[600]], truncated: false };
assert.deepEqual(checkTotals(grouped, totalOk, shape.metrics), [], "对得上就不报");
const totalBad = { columns: col("gmv"), rows: [[400]], truncated: false };
const mismatch = checkTotals(grouped, totalBad, shape.metrics)[0];
assert.equal(mismatch.code, "TOTAL_MISMATCH");
assert.equal(mismatch.level, "fail");
assert(mismatch.message.includes("JOIN"), "要点出可能的原因,而不是只说对不上");
// 比率型不参与总分对齐 —— 平均值跨行汇总本来就没有唯一答案
assert.deepEqual(checkTotals(grouped, { columns: col("rate"), rows: [[999]], truncated: false },
  [{ field: "rate", name: "出货率", rollup: "avg", unit: "%" }]), []);
// 容差之内不报
assert.deepEqual(checkTotals(grouped, { columns: col("gmv"), rows: [[601]], truncated: false }, shape.metrics), []);

/* 这儿原来测的是 checkRollup(「比率被求和」判硬错)。那个函数删了 —— 它写好之后
   生产代码里一次都没调用过,而且在当前结构下也点不着:查询计划里的 rollup 就是
   metricRollup 算出来的那一个,不存在「请求的聚合方式」跟它不一致的情况。
   跑不到的检查加上绿着的测试,给的是「这条守住了」的错觉。
   这件事真正该守的位置是指标定义那一层,见 test-metric-health 的
   ratio-not-aggregated / suspicious-scale / null-unsafe-sum —— 那儿是人能写错、
   而且写错了在界面上完全看不出来的地方(笔均金额算成 2680 元就是从那儿来的)。 */

// 区间展开
assert.equal(expectedPoints({ start: "2026-08-01", end: "2026-08-31" }, "day"), 31);
assert.equal(expectedPoints({ start: "2026-01-01", end: "2026-06-30" }, "month"), 6);
assert.equal(expectedPoints({ start: "2026-08-31", end: "2026-08-01" }, "day"), 0, "反着的区间返回 0 而不是负数");

// 干净数据要能过
assert.equal(verdict(checkDataset(qr([["2026-08-01", "A", 100, 50], ["2026-08-02", "B", 110, 51],
                                      ["2026-08-03", "C", 120, 52]]), shape)).status, "pass");

const cols = (...n) => n.map((name) => ({ name }));
// ── 不可加指标的识别(真机上「笔均金额 31 天一加变 31 倍」那个 bug)──
// 顶层除法 = 比率;COUNT(DISTINCT) 每天去重加起来会把同一个对象数很多遍。
assert.equal(isAdditiveExpression("SUM(a.gmv + a.online_gmv) AS value"), true);
assert.equal(isAdditiveExpression("{{select}}SUM(a.gmv)/NULLIF(SUM(a.cnt),0)*1 AS value"), false, "笔均金额:顶层除法");
assert.equal(isAdditiveExpression("SUM(a.gmv)/NULLIF(COUNT(DISTINCT a.store_id),0) AS value"), false, "日店均");
assert.equal(isAdditiveExpression("COUNT(DISTINCT CASE WHEN x>0 THEN a.store_id END) AS value"), false, "网点数");
assert.equal(isAdditiveExpression("SUM(a.amount / a.rate) AS value"), true,
  "除号在括号里是可加的 —— 不能只看有没有斜杠");
assert.equal(isAdditiveExpression("AVG(a.score) AS value"), false);
assert.equal(isAdditiveExpression("COUNT(a.id) AS value"), true, "不去重的 COUNT 是可加的");

// metricRollup:template 型以前只看单位带不带 %,笔均金额单位是「元」所以被判成可加
const tpl = (name, expr, unit) => ({
  id: name, key: name, name, type: "template", enabled: true, connId: "c", database: "d", unit,
  aliases: [], caliber: "", category: "", dimensions: ["day"],
  queryPlan: { kind: "sql", sourceTables: ["t"], dimensions: {},
    template: `SELECT {{select}}${expr} AS value FROM t WHERE d BETWEEN {{start}} AND {{end}}` },
});
assert.equal(metricRollup(tpl("销售额", "SUM(a.gmv)", "元")), "sum");
assert.equal(metricRollup(tpl("笔均金额", "SUM(a.gmv)/NULLIF(SUM(a.cnt),0)", "元")), "avg",
  "单位是元但它是比率 —— 这正是真机上漏掉的那个");
/* 去重计数单独归一类,不再跟比率混在 avg 里。两者都不能跨组相加,但后果不同:
   比率跨组还能按平均粗看一眼,去重计数连这个都不成立(同一家店出现在两个组里会被数两遍)。
   分开之后明细表的列合计显示「—」而不是一个看着像数的平均值。 */
assert.equal(metricRollup(tpl("网点数", "COUNT(DISTINCT a.store_id)", "家")), "count_distinct");
/* 定义指标的人填了就听他的 —— 有些意图从 SQL 里看不出来:
   「有效天数」= COUNT(DISTINCT 日期),按网点分组后各店天数加起来是网点有效天数
   (算日均时的分母),不分组直接查出来是日历天数。两个都对,猜不出要哪个。 */
assert.equal(metricRollup({ ...tpl("有效天数", "COUNT(DISTINCT a.d)", "天"), rollup: "sum" }), "sum",
  "指标上显式声明的合并方式优先于自动判断");
assert.equal(metricRollup(tpl("差评率", "SUM(a.bad)/NULLIF(SUM(a.cnt),0)*100", "%")), "avg");

// 总分对齐的报错要指对方向:倍数和行数对得上 = 不可加,不是 JOIN 放大
const g31 = { columns: cols("day", "aov"), rows: Array.from({ length: 31 }, (_, i) => [`2026-08-${i + 1}`, 26]), truncated: false };
const t1 = { columns: cols("aov"), rows: [[26]], truncated: false };
const nonAdd = checkTotals(g31, t1, [{ field: "aov", name: "笔均金额", rollup: "sum", unit: "元" }])[0];
assert.equal(nonAdd.code, "TOTAL_MISMATCH");
assert(nonAdd.message.includes("不能跨行相加"), "要指出是不可加,别一口咬定 JOIN:" + nonAdd.message);
assert(!nonAdd.message.includes("JOIN"), nonAdd.message);
// 倍数和行数对不上,才该怀疑 JOIN
const blown = checkTotals({ columns: cols("store", "gmv"), rows: [["A", 700], ["B", 700]], truncated: false },
  { columns: cols("gmv"), rows: [[500]], truncated: false }, [{ field: "gmv", name: "销售额", rollup: "sum", unit: "元" }])[0];
assert(blown.message.includes("JOIN"), blown.message);

// ── 角色路由:想的活走云端,填表的活走本地 ──
const cfg = (over) => ({ provider: "local", builtin: { model: "", baseUrl: "", ready: false },
  local: { baseUrl: "http://127.0.0.1:1234/v1", model: "qwen" },
  cloud: { baseUrl: "https://api.deepseek.com/v1", apiKey: "k", model: "deepseek-chat" },
  thinkingEnabled: false, includeSampleRows: false, ...over });
const full = cfg({});
assert.equal(providerFor("reasoning", full), "cloud", "理解题意/写结论是「想」");
assert.equal(providerFor("design", full), "cloud", "选图表/排版面是「想」");
assert.equal(providerFor("review", full), "cloud");
assert.equal(providerFor("structured", full), "local", "范围解析是「填表」,本地又准又快还省钱");
assert.equal(providerFor("cheap", full), "local");

// 云端没配全 → 整体回落到全局,不能因为"默认想走云端"就跑不起来
const noCloud = cfg({ cloud: { baseUrl: "", apiKey: "", model: "" } });
assert.equal(providerFor("reasoning", noCloud), "local");
assert.equal(providerFor("design", noCloud), "local");
const halfCloud = cfg({ cloud: { baseUrl: "https://x/v1", apiKey: "", model: "m" } });
assert.equal(providerFor("reasoning", halfCloud), "local", "缺 apiKey 也算没配全");

// 用户显式指定的优先级最高
assert.equal(providerFor("reasoning", cfg({ agentRoles: { reasoning: "local" } })), "local");
assert.equal(providerFor("structured", cfg({ agentRoles: { structured: "cloud" } })), "cloud");

// 全局就是云端时,填表的活仍然留本地(本地可用的话)
assert.equal(providerFor("structured", cfg({ provider: "cloud" })), "local");
assert.equal(providerFor("reasoning", cfg({ provider: "cloud" })), "cloud");

const summary = routingSummary(full);
assert.equal(summary.length, 5);
assert.equal(summary.find((r) => r.role === "reasoning").reason, "按角色默认");
assert.equal(routingSummary(cfg({ agentRoles: { reasoning: "local" } })).find((r) => r.role === "reasoning").reason, "你指定的");

// ── 看板排版:模型决定放什么,代码决定摆哪儿 ──
const LI = (o) => ({ band: "trend", type: "bar", title: "图", metricIds: ["m1"], dimensions: ["day"],
  width: "half", reason: "", ...o });
const goodPlan = [
  LI({ band: "kpi", type: "kpi", title: "销售额", dimensions: [], width: "third", metricIds: ["m1"] }),
  LI({ band: "kpi", type: "kpi", title: "订单量", dimensions: [], width: "third", metricIds: ["m2"] }),
  LI({ band: "kpi", type: "kpi", title: "笔均金额", dimensions: [], width: "third", metricIds: ["m3"] }),
  LI({ band: "trend", type: "line", title: "趋势", width: "full" }),
  LI({ band: "structure", type: "pie", title: "渠道", dimensions: ["channel"], width: "half" }),
  LI({ band: "ranking", type: "bar", title: "排名", dimensions: ["store"], width: "half", topN: 10 }),
  LI({ band: "detail", type: "table", title: "明细", dimensions: ["day", "store"], width: "full" }),
];
const packed = packLayout(goodPlan);
// 不重叠、不越界
for (const a of packed) assert(a.x >= 0 && a.x + a.w <= 12, `${a.title} 越界`);
for (let i = 0; i < packed.length; i++) for (let j = i + 1; j < packed.length; j++) {
  const [a, b] = [packed[i], packed[j]];
  assert(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), `${a.title} 和 ${b.title} 重叠`);
}
// KPI 一定在第一行,阅读层级不能乱
assert(packed.filter((p) => p.band === "kpi").every((p) => p.y === 0), "KPI 必须在最上面");
assert(packed.find((p) => p.band === "detail").y > packed.find((p) => p.band === "trend").y, "明细在趋势下面");
// 换 band 一定换行 —— 否则趋势图会和 KPI 挤一行
assert.equal(packed.find((p) => p.title === "趋势").x, 0, "换 band 要换行");
// sourceIndex 要指回原数组 —— 不带它,Reviewer 的修正会改错组件
assert.deepEqual(packed.map((p) => goodPlan[p.sourceIndex].title), packed.map((p) => p.title));
assert.equal(layoutHeight(packed), 21);

// ── Reviewer:十条确定性规则 ──
const badPlan = [
  LI({ band: "trend", type: "line", title: "网点对比", dimensions: ["store"] }),      // 折线用在非时间维度
  LI({ band: "structure", type: "pie", title: "网点占比", dimensions: ["store"] }),   // 40 个分类还用饼图
  LI({ band: "ranking", type: "bar", title: "网点排名", dimensions: ["store"] }),     // 排名没 topN
  LI({ band: "kpi", type: "kpi", title: "销售额KPI", dimensions: ["day"], width: "third" }), // KPI 带维度
  LI({ band: "trend", type: "bar", title: "重复图", dimensions: ["channel"] }),
  LI({ band: "trend", type: "bar", title: "重复图2", dimensions: ["channel"] }),      // 和上面一模一样
  LI({ band: "detail", type: "table", title: "假指标表", dimensions: ["day"], metricIds: ["我编的"], width: "full" }),
];
const rvCtx = { categoryCounts: { 0: 40, 1: 40, 2: 40, 3: 1, 4: 6, 5: 6, 6: 30 }, pointCounts: {},
  validatedMetricIds: ["m1"], ratioMetricIds: [], timeDimensions: ["day", "week", "month", "year"] };
const found = reviewLayout(packLayout(badPlan), rvCtx);
const codes = found.map((f) => f.code);
for (const expected of ["WRONG_CHART_TYPE", "KPI_WITH_DIMENSION", "DUPLICATE_WIDGET", "UNVALIDATED_METRIC"]) {
  assert(codes.includes(expected), `应该抓到 ${expected},实际:${codes.join("、")}`);
}
// finding 的 index 必须指回原数组,否则打补丁会改错组件
const kpiFinding = found.find((f) => f.code === "KPI_WITH_DIMENSION");
assert.equal(badPlan[kpiFinding.index].title, "销售额KPI", "index 必须指原数组下标,不是排版后的");
const fakeFinding = found.find((f) => f.code === "UNVALIDATED_METRIC");
assert.equal(badPlan[fakeFinding.index].title, "假指标表");
assert.equal(reviewVerdict(found).verdict, "needs_revision");

// 迭代打补丁要收敛:修完会产生新重复(三张图都被改成 bar 后彼此相同),代码里收掉,
// 不值得为它烧一轮 LLM 重设计
const recheck = (items) => reviewLayout(packLayout(items), rvCtx);
const repaired = applyFixes(badPlan, found, recheck);
assert.equal(reviewVerdict(recheck(repaired.items)).verdict, "pass", "自动修完应该能过:" + JSON.stringify(repaired.remaining));
assert(repaired.items.length < badPlan.length, "重复和空组件要被删掉");
assert(repaired.items.every((i) => i.metricIds.length > 0), "没绑指标的空组件要删,留着比没有更糟");
assert(repaired.items.every((i) => !(i.type === "kpi" && i.dimensions.length)), "KPI 不该带维度");
assert(repaired.applied.includes("DROP_EMPTY"));

// 干净的版面不该被乱改
const cleanFindings = reviewLayout(packLayout(goodPlan), { categoryCounts: { 4: 5, 5: 20 }, pointCounts: {},
  validatedMetricIds: ["m1", "m2", "m3"], ratioMetricIds: [], timeDimensions: ["day", "week", "month", "year"] });
assert(!cleanFindings.some((f) => f.severity === "must_fix"), "正常版面不该报必须修:" + cleanFindings.map((f) => f.code).join("、"));

// ── AI 溯源:必须活过存取,且不能泄进导出的离线 HTML ──
const withProv = normalizeDashboard({
  schemaVersion: 3, id: "d-prov", title: "8月经营看板",
  widgets: [{ id: "w1", type: "kpi", datasetId: "ds", title: "销售额",
    bindings: { metricIds: ["m1"], measures: [], secondaryMetricIds: [], dimensions: [] },
    options: { decimals: 2, showLegend: true, smooth: true, topN: 0, metrics: {} } }],
  aiProvenance: {
    workflowId: "wf-1", userRequest: "分析上个月经营情况,做个看板",
    createdAt: "2026-09-11T10:00:00.000Z", model: "cloud · deepseek-chat",
    widgetReasons: { w1: "销售额是核心指标,放在最上面第一眼能看到" },
    autoFixed: ["自动修了 2 处:WRONG_CHART_TYPE、DUPLICATE_WIDGET"],
    openIssues: ["网点排名数据点较多,数据标签可能拥挤"],
  },
});
assert.equal(withProv.aiProvenance.userRequest, "分析上个月经营情况,做个看板",
  "顶层是逐字段列举的,漏了就会在存取之间被静默抹掉 —— refreshInterval 当年就是这么丢的");
assert.equal(withProv.aiProvenance.widgetReasons.w1, "销售额是核心指标,放在最上面第一眼能看到");
assert.deepEqual(withProv.aiProvenance.openIssues, ["网点排名数据点较多,数据标签可能拥挤"]);
// 人工建的看板不该凭空多出这个字段
assert.equal(normalizeDashboard({ schemaVersion: 3, id: "d2", title: "手工", widgets: [] }).aiProvenance, undefined);
// 服务层写入
const marked = dash.setProvenance(dash.create({ title: "T" }),
  { workflowId: "wf", userRequest: "q", createdAt: "t", widgetReasons: { a: "b" } });
assert.equal(marked.aiProvenance.workflowId, "wf");

// 删掉的假警告:数据标签默认就不开,"开了会糊"是在警告不存在的事(真机上一次刷 4 条噪音)。
// 该做的是建组件时按点数决定开不开,而不是事后提醒。
const noisy = reviewLayout(packLayout([LI({ dimensions: ["store"] })]), {
  categoryCounts: { 0: 40 }, pointCounts: { 0: 400 },
  validatedMetricIds: ["m1"], ratioMetricIds: [], timeDimensions: ["day", "week", "month", "year"] });
assert(!noisy.some((f) => f.code === "TOO_MANY_LABELS"), "不该再有这条假警告:" + noisy.map((f) => f.code).join("、"));

// ── 截断:比"数据有问题"更危险,每行都对但加起来少一大截,表面看不出来 ──
const tshape = { dimensions: ["day"], metrics: [{ field: "gmv", name: "销售额", rollup: "sum", unit: "元" }],
  timeField: "day", dateRange: { start: "2026-08-01", end: "2026-08-31" }, grain: "day" };
const cut = { columns: cols("day", "gmv"), rows: Array.from({ length: 20000 }, () => ["2026-08-01", 1]), truncated: true };
const cutIssues = checkDataset(cut, tshape);
assert.equal(verdict(cutIssues).status, "fail", "截断必须硬拦 —— 否则合计、同环比、TopN 全是残缺数据上算的");
assert.equal(cutIssues[0].code, "TRUNCATED");
assert(cutIssues[0].message.includes("减少分组维度"), "要指出该降维重查,而不是提高上限硬扛");
// 截断时总分对齐毫无意义 —— 少的那部分本来就没查回来,报 JOIN 会把人带偏
assert.deepEqual(checkTotals(cut, { columns: cols("gmv"), rows: [[48260000]], truncated: false }, tshape.metrics), [],
  "截断时不该报 TOTAL_MISMATCH");
// 没截断时照常比
const whole = { columns: cols("day", "gmv"), rows: [["2026-08-01", 100], ["2026-08-02", 100]], truncated: false };
assert.equal(checkTotals(whole, { columns: cols("gmv"), rows: [[500]], truncated: false }, tshape.metrics)[0].code, "TOTAL_MISMATCH");

// ── 单位换算要看真实量级,不能一刀切 ──
// 真机教训:第一版对所有 KPI 一律建议「万」,笔均金额 32.60 元被显示成「0万」、
// 日店均 4180 元变成「0.4万」—— 自动修正把能看的数改成了看不懂的数。
const KPI = (title, metricId, scale) => ({ band: "kpi", type: "kpi", title, metricIds: [metricId],
  dimensions: [], width: "third", reason: "", ...(scale ? { scale } : {}) });
const kpis = [KPI("销售额", "m1"), KPI("订单量", "m2"), KPI("笔均金额", "m3", "wan"), KPI("日店均", "m4", "wan")];
const mags = { 0: 48260000, 1: 1806400, 2: 32.60, 3: 4180.00 };   // 千万级/百万级/几十元/几千元各一个
const scaleCtx = { categoryCounts: {}, pointCounts: {}, magnitudes: mags,
  validatedMetricIds: ["m1", "m2", "m3", "m4"], ratioMetricIds: [], timeDimensions: ["day"] };
const scaleFindings = reviewLayout(packLayout(kpis), scaleCtx);
const wanted = Object.fromEntries(scaleFindings.filter((f) => f.fix?.scale != null).map((f) => [kpis[f.index].title, f.fix.scale]));
assert.equal(wanted["销售额"], "wan", "4826 万该换算");
assert.equal(wanted["订单量"], "wan");
assert.equal(wanted["笔均金额"], "none", "32.60 元换成万就是 0,必须撤掉");
assert.equal(wanted["日店均"], "none", "4180 元换成万是 0.4,反而看不懂");
const scaled = applyFixes(kpis, scaleFindings, (n) => reviewLayout(packLayout(n), scaleCtx));
assert.equal(scaled.items.find((i) => i.title === "笔均金额").scale, "none");
assert.equal(scaled.items.find((i) => i.title === "销售额").scale, "wan");
assert.equal(scaled.items.length, 4, "四个不同指标的 KPI 不是重复图");
// 亿级走亿
assert.equal(reviewLayout(packLayout([KPI("全年GMV", "m1")]), { ...scaleCtx, magnitudes: { 0: 3.2e8 } })
  .find((f) => f.fix?.scale).fix.scale, "yi");
// 拿不到量级时不瞎猜
assert(!reviewLayout(packLayout([KPI("未知", "m1")]), { ...scaleCtx, magnitudes: {} })
  .some((f) => f.code === "NO_SCALE" || f.code === "WRONG_SCALE"), "算不出量级就别动它");

// ── 数组 schema 必须带上限 ──
// 不带上限时模型会陷入重复循环,把同一项吐十几遍直到撞 max_tokens 被截断,
// 最后得到一段断在半截的 JSON —— 真机上就是这么挂的。
assert.equal(S.arr(S.str()).maxItems, 20, "S.arr 默认就要有上限");
assert.equal(S.arr(S.str(), "x", 4).maxItems, 4);
assert(validate(["a", "b", "c"], S.arr(S.str(), "x", 2))[0].includes("最多 2 项"));

// ── Reviewer 的判断层:只能改标题/层级,绝不能绕过指标验证 ──
const JI = (o) => ({ band: "trend", type: "bar", title: "图1", metricIds: ["m1"],
  dimensions: ["store"], width: "half", reason: "", ...o });
const judgeItems = [JI({ title: "图1" }), JI({ title: "bar chart", band: "detail", type: "kpi", dimensions: [] }), JI({ title: "多余的" })];
const judged = applyJudgement(judgeItems, { verdict: "needs_revision", findings: [
  { index: 0, issue: "标题看不出在说什么", severity: "should_fix", fix: { title: "8月各网点销售额排名", subtitle: "按网点汇总,单位元" } },
  { index: 1, issue: "核心数字被放到明细区", severity: "must_fix", fix: { band: "kpi" } },
  { index: 2, issue: "和第0个是同一件事", severity: "should_fix", fix: { drop: true } },
  { index: 0, issue: "应该换个指标", severity: "must_fix", fix: { metricIds: ["我偷偷塞的"] } },
  { index: 0, issue: "应该换成饼图", severity: "must_fix", fix: { type: "pie" } },
  { index: -1, issue: "整体缺一张趋势图", severity: "should_fix" },
] });
/* 审查层**只报不动手**。真机上一块 8 组件的看板被自动修了 9 处,
   一多半是标题重写和「这个组件多余」—— 用户原话:「版式主题感觉没变化,
   像是被你框死了」。设计是模型做的,端上来的却是被我改过一遍的版本。
   会让人**读错数**的硬伤由代码规则管(那些有客观标准);
   标题好不好、哪个组件多余,没有客观标准,交回给设计者。 */
assert.equal(judged.items[0].title, "图1", "标题是设计者的决定,评审只能提意见,不能改");
assert.equal(judged.items[0].subtitle, undefined, "副标题同理");
assert.equal(judged.items[1].band, "kpi", "层级还可以改 —— 它影响的是兜底排版的顺序,不是审美");
assert.equal(judged.items.length, 3, "评审说「多余」不算数,不能替设计者删组件");
const dropped = judged.remaining.map((r) => r.reason);
assert.ok(dropped.includes("标题看不出在说什么") && dropped.includes("和第0个是同一件事"),
  "不动手,但意见要如实留给人看:" + JSON.stringify(dropped));
// 越权必须挡住:指标绑定是过了验证闸门的,评审动不了
assert.deepEqual(judged.items.map((i) => i.metricIds), [["m1"], ["m1"], ["m1"]], "绝不允许评审改指标绑定");
assert.deepEqual(judged.items.map((i) => i.type), ["bar", "kpi", "bar"], "图表类型由代码规则管,评审改不了");
// 改不动的要如实留给人,不能吞掉
const left = judged.remaining.map((r) => r.reason);
assert(left.includes("应该换个指标") && left.includes("应该换成饼图") && left.includes("整体缺一张趋势图"),
  "越权和没给 fix 的意见都要留下来给人看:" + JSON.stringify(left));
// pass 时不该动任何东西
const untouched = applyJudgement(judgeItems, { verdict: "pass", findings: [] });
assert.deepEqual(untouched.items, judgeItems);
assert.deepEqual(untouched.applied, []);
// 空 fix 不算修改
const emptyFix = applyJudgement(judgeItems, { verdict: "needs_revision",
  findings: [{ index: 0, issue: "说不清", severity: "nit", fix: { title: "   " } }] });
assert.deepEqual(emptyFix.items[0].title, "图1", "空白标题不算修改");
assert.equal(emptyFix.remaining.length, 1, "改不动就留给人");

// ── ratio 型计划按定义不可加,别看它分子长什么样 ──
// 踩过:「店均预存金额」= 预存金额 ÷ 营业网点日数,分子 SUM(...) 看着可加,
// 于是整体被判成 sum,明细表开行合计就把一堆"店均"加起来了。
const ratioPlan = {
  id: "r1", key: "r1", name: "店均预存金额", type: "template", enabled: true, connId: "c", database: "d",
  unit: "元", aliases: [], caliber: "", category: "", dimensions: ["day"],
  queryPlan: {
    kind: "ratio", scale: 1,
    numerator: { kind: "sql", sourceTables: ["t"], dimensions: {},
      template: "SELECT {{select}}COALESCE(SUM(b.deposit_amt),0) AS value FROM t WHERE d BETWEEN {{start}} AND {{end}}" },
    denominator: { kind: "sql", sourceTables: ["t"], dimensions: {},
      template: "SELECT {{select}}COUNT(DISTINCT CONCAT(a.store_id,'#',a.stat_date)) AS value FROM t WHERE d BETWEEN {{start}} AND {{end}}" },
  },
};
assert.equal(metricRollup(ratioPlan), "avg", "比率型跨行相加没有意义,和分子是不是 SUM 无关");
// 可加的仍然是 sum,别矫枉过正
assert.equal(metricRollup({ ...ratioPlan, queryPlan: ratioPlan.queryPlan.numerator }), "sum");

// 周期内真去重的人数指标,显示层绝不能求和
const distinctMetric = { ...ratioPlan, id: "r2", name: "消费会员数", unit: "人",
  queryPlan: { kind: "sql", sourceTables: ["t"], dimensions: {},
    template: "SELECT {{select}}COUNT(DISTINCT CASE WHEN b.consume_flag=1 AND b.member_flag=1 THEN b.user_id END) AS value FROM t WHERE d BETWEEN {{start}} AND {{end}}" } };
assert.equal(metricRollup(distinctMetric), "count_distinct", "按天的去重人数加起来会把同一个人数很多遍");

console.log("agent rules: 数据体检、可加性、路由、排版评审、溯源、截断、单位换算、评审越权都对");
