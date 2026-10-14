// AI 分析的执行链路:图运行时报步骤、模型构图的修补、真工具落文档、各执行节点(取数 / 诊断 / 维表探测 / 出看板 / 锁参)、分析表单状态。
// 不调模型 —— 节点要用的工具都换成假的,只验代码那一层。
import assert from "node:assert/strict";
import { loadSrc } from "./lib/load-src.mjs";

const m = loadSrc("agent-pipeline", {
  "src/features/agent/tools/registry.ts": "{ callTool, registerTool, resetTools }",
  "src/features/agent/tools/dashboardTools.ts": "{ getDraft }",
  "src/features/agent/tools/dimensionProbe.ts": "{ tableAliases, selectExpressionFor, fromClause, fastDimensionValues }",
  "src/features/agent/graph.ts": "{ Graph, END }",
  "src/features/agent/state.ts": "{ createState }",
  "src/features/agent/layout.ts": "{ repairLayout, resolveLayout }",
  "src/features/agent/nodes/index.ts": "{ dataExecutor, dashboardExecutor, lockedPlanner }",
  "src/features/agent/workflow.ts": "{ buildLockedGraph }",
  "src/features/agent/analysisStore.ts": "{ useAnalysis }",
});
const { callTool, registerTool, resetTools, getDraft, tableAliases, selectExpressionFor, fromClause, fastDimensionValues, Graph, END, createState, repairLayout, resolveLayout, dataExecutor, dashboardExecutor, lockedPlanner, buildLockedGraph, useAnalysis } = m;

// ── 转圈的那一步必须是真正在跑的那一步 ────────────────────────
// 真机现象:界面一直停在「核对指标中心」转圈。其实核对早就过了 ——
// onStep 只在节点跑完时回调,于是下一步等云模型的那几十秒,
// 界面显示的还是上一步。看着一模一样,判断完全相反。
{
  const g = new Graph();
  let release;
  const gate = new Promise((r) => { release = r; });
  g.addNode("Fast", async () => ({}));
  g.addNode("Slow", async () => { await gate; return {}; });
  g.setEntry("Fast");
  g.addEdge("Fast", "Slow");
  g.addEdge("Slow", END);

  const seen = [];
  const running = g.run(createState({ userRequest: "问题" }), { onStep: (s) => seen.push(s.currentNode) });

  // 让 Fast 跑完、Slow 进场并卡住
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen[seen.length - 1], "Slow",
    "Slow 正在跑的时候,界面拿到的 currentNode 必须已经是 Slow,不能还停在 Fast:" + JSON.stringify(seen));
  assert.ok(seen.includes("Fast"), "Fast 也要报过,否则时间线缺一格:" + JSON.stringify(seen));

  release();
  const done = await running;
  assert.equal(done.status, "done");
  assert.ok(done.nodeStartedAt > 0, "得记下这一步什么时候开始的,界面才能显示「已等 N 秒」");
}

// ── 放开排版:模型自己的构图要留住,只修真冲突 ──────────────────
// 起因是用户的话:「就像有一个模版束缚他一样」。原来模型只能说"占半行、属于趋势区",
// 坐标全由 packLayout 按固定 band 顺序铺 —— 于是每块看板长得一模一样。
{
  const it = (title, x, y, w, h, extra = {}) => ({
    band: "trend", type: "bar", title, metricIds: ["m"], dimensions: ["store"],
    width: "half", reason: "r", x, y, w, h, ...extra,
  });

  // 模型的构图必须原样保留:左窄右宽、明细顶在最上面,都不该被重排
  const asDesigned = repairLayout([
    it("大图", 4, 0, 8, 8),
    it("窄KPI-1", 0, 0, 4, 2, { type: "kpi", band: "kpi", dimensions: [] }),
    it("窄KPI-2", 0, 2, 4, 2, { type: "kpi", band: "kpi", dimensions: [] }),
  ]);
  const big = asDesigned.find((p) => p.title === "大图");
  assert.deepEqual({ x: big.x, y: big.y, w: big.w, h: big.h }, { x: 4, y: 0, w: 8, h: 8 },
    "模型说大图放右边占 8 栏 8 行,就得是这样 —— 不能被重排成「第一行 KPI 第二行图」");
  assert.equal(asDesigned.find((p) => p.title === "窄KPI-2").x, 0, "左侧窄列要保持在左侧");
  // 走真正的入口再验一遍 —— 只测 repairLayout 的话,resolveLayout 退化成"永远兜底排版"
  // (等于这次放开白做了)没有任何测试会挂。踩过:第一版就是这样。
  const viaEntry = resolveLayout([
    it("大图", 4, 0, 8, 8),
    it("窄KPI-1", 0, 0, 4, 2, { type: "kpi", band: "kpi", dimensions: [] }),
    it("窄KPI-2", 0, 2, 4, 2, { type: "kpi", band: "kpi", dimensions: [] }),
  ]);
  const bigEntry = viaEntry.find((p) => p.title === "大图");
  assert.deepEqual({ x: bigEntry.x, y: bigEntry.y, w: bigEntry.w }, { x: 4, y: 0, w: 8 },
    "坐标都给全了就必须用模型的构图,不能退回按 band 铺:" + JSON.stringify(viaEntry.map((p) => ({ t: p.title, x: p.x, y: p.y }))));

  // 出界:夹回网格,不是丢掉
  const clamped = repairLayout([it("超宽", 8, 0, 9, 4)])[0];
  assert.ok(clamped.x + clamped.w <= 12, `夹回网格内,得到 x=${clamped.x} w=${clamped.w}`);

  // 重叠:后来的往下让,不是叠着画
  const split = repairLayout([it("A", 0, 0, 6, 4), it("B", 3, 1, 6, 4)]);
  const [a, b] = ["A", "B"].map((t) => split.find((p) => p.title === t));
  const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert.ok(!hit, "重叠必须拆开:" + JSON.stringify([a, b].map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h }))));

  // 大洞:模型常给 y=0 然后 y=20,要收上来
  const gapped = repairLayout([it("上", 0, 0, 12, 3), it("下", 0, 20, 12, 4)]);
  assert.equal(gapped.find((p) => p.title === "下").y, 3, "中间十几行空白要收掉:" + JSON.stringify(gapped.map((p) => p.y)));

  // 反向对照:模型没给坐标 → 退回按 band 铺,不能排出一堆 (0,0)
  const noCoords = resolveLayout([
    { band: "kpi", type: "kpi", title: "K", metricIds: ["m"], dimensions: [], width: "quarter", reason: "r" },
    { band: "trend", type: "line", title: "L", metricIds: ["m"], dimensions: ["day"], width: "full", reason: "r" },
  ]);
  assert.ok(noCoords.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), "兜底排版要给出完整坐标");
  assert.ok(noCoords.find((p) => p.title === "L").y > 0, "没坐标时仍按 band 分行,别全挤在第 0 行");

  // 反向对照:只有零星一个给了坐标 → 那多半是漏填,不该当构图用
  const mostlyMissing = resolveLayout([
    { band: "kpi", type: "kpi", title: "K1", metricIds: ["m"], dimensions: [], width: "quarter", reason: "r", x: 0, y: 0 },
    { band: "trend", type: "line", title: "L1", metricIds: ["m"], dimensions: ["day"], width: "full", reason: "r" },
    { band: "ranking", type: "bar", title: "B1", metricIds: ["m"], dimensions: ["store"], width: "half", reason: "r" },
  ]);
  assert.ok(mostlyMissing.find((p) => p.title === "L1").y > 0, "三个里只给一个坐标 = 漏填,应退回兜底排版");

  // text 块要能排进来 —— 看板不是图表堆,得能写小标题和结论
  const withText = repairLayout([
    { band: "kpi", type: "text", title: "分区", content: "一、总体", metricIds: [], dimensions: [], width: "full", reason: "r", x: 0, y: 0, w: 12, h: 1 },
    it("图", 0, 1, 6, 4),
  ]);
  assert.equal(withText.length, 2);
  assert.equal(withText.find((p) => p.type === "text").content, "一、总体");
}

// ── 真工具那一层:外观/正文到底有没有写进文档 ─────────────────
// 上面那块打的是假工具,只证明了「executor 把字段传出去了」。
// 传出去 ≠ 写进去 —— 中间还有 add_component / style_component 的真实现。
// 「每块看板长得一样」如果是断在这一层,上面那些断言一个都抓不到。
{
  const dash = await callTool("create_dashboard", { title: "外观验证", description: "" });
  assert.ok(dash.ok, JSON.stringify(dash.error));
  const id = dash.data.dashboardId;

  const text = await callTool("add_component", { dashboardId: id, type: "text", title: "分区", content: "一、总体判断" });
  assert.ok(text.ok, JSON.stringify(text.error));
  const styled = await callTool("style_component", {
    dashboardId: id, widgetId: text.data.widgetId,
    appearance: { visualPreset: "aurora", radius: 12, hideTitle: true },
    text: { fontSize: 18, align: "center" },
    footnote: "数据截至昨日",
  });
  assert.ok(styled.ok, JSON.stringify(styled.error));

  const doc = getDraft(id);
  const w = doc.widgets.find((x) => x.type === "text");
  assert.equal(w.options.content, "一、总体判断", "text 正文没写进文档,页面上就是个空卡");
  assert.equal(w.options.appearance?.visualPreset, "aurora",
    "视觉预设没写进文档 —— 这就是「版式主题始终是那一套」:" + JSON.stringify(w.options.appearance));
  assert.equal(w.options.appearance?.radius, 12);
  assert.equal(w.options.appearance?.hideTitle, true);
  assert.equal(w.options.text?.fontSize, 18);
  assert.equal(w.footnote, "数据截至昨日");

  // 两次 style 要合并而不是互相擦掉 —— executor 分几次配置同一个组件
  await callTool("style_component", { dashboardId: id, widgetId: text.data.widgetId, appearance: { radius: 4 } });
  const after = getDraft(id).widgets.find((x) => x.type === "text");
  assert.equal(after.options.appearance.radius, 4, "新值要生效");
  assert.equal(after.options.appearance.visualPreset, "aurora", "旧值不能被整个对象替换掉抹了");
}

// ── 0 行时当场查清为什么,别留给人猜 ─────────────────────────
// 真机上为一次「共 0 行」来回折腾了四五轮:是日期不对?筛选值对不上?
// 还是指标口径本身就查不出数?每猜一轮都要改代码、装包、让人再跑一遍。
// 这三种可能三次查询就分得开。
{
  const seen = [];
  resetTools(); // 上一段已经清过了;这里只换成本段要用的假工具
  registerTool({ name: "execute_query_plan", description: "", readOnly: true,
    schema: { type: "object", properties: {}, additionalProperties: true },
    run: () => ({ planId: "p", rowCount: 0, truncated: false, columns: ["war_zone"], sampleRows: [] }) });
  registerTool({ name: "diagnose_empty_result", description: "", readOnly: true,
    schema: { type: "object", properties: {}, additionalProperties: true },
    run: (input) => {
      seen.push(`diagnose:${input.planId}`);
      return { verdict: "filters", message: "**是筛选条件筛空的**。去掉筛选后有 812 行。", counts: {} };
    } });

  const state = { workflowId: "w", retry: {}, trace: [], errors: [], usage: [],
    dropped: [],
    plans: [{ role: "primary", planId: "p1", dateRange: { start: "2026-03-01", end: "2026-08-31" } },
            { role: "mom", planId: "p2", dateRange: { start: "2025-09-01", end: "2026-02-28" } }] };
  const out = await dataExecutor(state);
  assert.deepEqual(seen, ["diagnose:p1"], "只诊断主查询,别把对比查询也各查三遍:" + JSON.stringify(seen));
  assert.ok((out.dropped ?? []).some((d) => d.includes("是筛选条件筛空的")),
    "查不到数的原因要摆到界面上:" + JSON.stringify(out.dropped));

  /* 口径跑不起来时,数据库的**原话**必须摆出来。
     「查询直接报错」等于没说:是列名不对、JOIN 写错还是没权限?那一行字能结束整轮排查。 */
  resetTools();
  registerTool({ name: "execute_query_plan", description: "", readOnly: true,
    schema: { type: "object", properties: {}, additionalProperties: true },
    run: () => ({ planId: "p", rowCount: 0, truncated: false, columns: [], sampleRows: [] }) });
  registerTool({ name: "diagnose_empty_result", description: "", readOnly: true,
    schema: { type: "object", properties: {}, additionalProperties: true },
    run: () => ({ verdict: "metric", message: "**指标的 SQL 跑不起来**。数据库说:「Unknown column 'b.deposit_amt'」", counts: {} }) });
  const broken = await dataExecutor(state);
  assert.ok((broken.dropped ?? []).some((d) => d.includes("Unknown column")),
    "数据库的原话必须摆出来 —— 「查询直接报错」等于没说:" + JSON.stringify(broken.dropped));

  // 反向对照:有数据时一次诊断都不该跑(那是三条额外查询,白花时间)
  seen.length = 0;
  resetTools();
  registerTool({ name: "execute_query_plan", description: "", readOnly: true,
    schema: { type: "object", properties: {}, additionalProperties: true },
    run: () => ({ planId: "p", rowCount: 42, truncated: false, columns: [], sampleRows: [] }) });
  registerTool({ name: "diagnose_empty_result", description: "", readOnly: true,
    schema: { type: "object", properties: {}, additionalProperties: true },
    run: () => { seen.push("diagnose"); return { verdict: "not-empty", message: "" }; } });
  const fine = await dataExecutor(state);
  assert.deepEqual(seen, [], "有数据就别做诊断");
  assert.equal(fine.dropped, undefined, "没问题时不要往「没能满足」里塞东西");
  resetTools();
}

// ── 维表直查:从编译好的 SQL 里拆出「这个维度住在哪张表」 ────────
// 八轮没修对的根子:拿完整指标 SQL(事实表 join 维表、扫半年、再 GROUP BY)
// 去问「大区有哪些取值」,45 秒跑不完 → 探测超时 → 「华东」补不成「华东大区」
// → in('华东') 一行都匹配不到 → 0 行。
{
  const sql =
    "SELECT d.outlet_region AS war_zone, COUNT(DISTINCT b.user_id) AS v " +
    "FROM shop_dws.dws_user_outlet_behavior_day b " +
    "JOIN shop_dim.dim_outlet_mapping sm ON sm.qm_id=b.behavior_outlet_id " +
    "JOIN shop_ads.ads_outlet_dim d ON sm.store_id=d.outlet_uuid " +
    "WHERE b.stat_date BETWEEN '2026-03-01' AND '2026-08-31' GROUP BY d.outlet_region";
  const aliases = tableAliases(sql);
  assert.equal(aliases.b, "shop_dws.dws_user_outlet_behavior_day");
  assert.equal(aliases.sm, "shop_dim.dim_outlet_mapping");
  assert.equal(aliases.d, "shop_ads.ads_outlet_dim", "war_zone 住在这张小维表上,不在事实表上");
  assert.equal(selectExpressionFor(sql, "war_zone"), "d.outlet_region");

  /* 不写别名的表:`FROM x WHERE ...` 里正则会把 WHERE 捕成别名。
     上面那条 SQL 每个 JOIN 后面都跟着真别名,**根本走不到这个分支** ——
     测试数据够不着的代码,改坏了也没人知道。 */
  const noAlias = tableAliases("SELECT a FROM shop_ads.ads_outlet_dim WHERE x=1 GROUP BY a");
  assert.equal(noAlias.WHERE, undefined, "WHERE 不是别名:" + JSON.stringify(noAlias));
  assert.equal(noAlias.where, undefined);
  const joinNoAlias = tableAliases("FROM a.b x JOIN c.d ON x.i=1");
  assert.equal(joinNoAlias.ON, undefined, "ON 不是别名:" + JSON.stringify(joinNoAlias));
  // 反向对照:找不到的字段要返回 null,不能瞎给一个表达式
  assert.equal(selectExpressionFor(sql, "supervisor"), null,
    "SQL 里没有这个字段就得说没有 —— 瞎拆出来的表达式会查出一份错的取值清单");
  // 带函数的表达式不认(时间维度本来也不需要探)
  assert.equal(selectExpressionFor("SELECT DATE(b.stat_date) AS day FROM t b", "day"), null);
  // AS 写法也要认
  assert.equal(tableAliases("FROM shop_ads.ads_outlet_dim AS d JOIN x y").d, "shop_ads.ads_outlet_dim");
  /* 维度名**就是列名**时,编译器不写别名:`SELECT outlet_region, COUNT(...) FROM ...`。
     这个探测函数当初是照着旧目录写的(维度一律是 `d.outlet_region`),正则要求带点又带 AS,
     于是裸列名一个都匹配不上 —— 探测一路 return null,任何带筛选值的问题都得到
     「无法核对到真实取值」。不是偶尔失败,是这一整类从来就没成功过。 */
  const bare = "SELECT outlet_region, COUNT(DISTINCT a.stat_date) AS business_days " +
    "FROM shop_ads.ads_outlet_daily a JOIN shop_ads.ads_outlet_dim d ON a.store_id = d.outlet_uuid " +
    "WHERE stat_date >= '2026-09-14' GROUP BY outlet_region";
  assert.equal(selectExpressionFor(bare, "outlet_region"), "outlet_region", "裸列名也要认出来");
  assert.equal(fromClause(bare), "shop_ads.ads_outlet_daily a JOIN shop_ads.ads_outlet_dim d ON a.store_id = d.outlet_uuid",
    "裸列名没法静态判断属于哪张表,只能拿整个 FROM 去查 —— 猜错表会查出一份别的表的清单,那比查不到更糟");

  // 只在 SELECT 列表里找:WHERE / GROUP BY 里的同名词不算"选出来的列"
  assert.equal(selectExpressionFor("SELECT a.x AS x FROM t WHERE outlet_region = '1'", "outlet_region"), null,
    "WHERE 里出现过不等于它被选了出来");
  assert.equal(selectExpressionFor("SELECT a.x FROM t GROUP BY outlet_region", "outlet_region"), null);
  // 带别名的仍然走原来的快路(只扫那一张维表)
  assert.equal(selectExpressionFor("SELECT d.outlet_region AS war_zone FROM x d", "war_zone"), "d.outlet_region");
  // 前缀相同的列名不能误命中
  assert.equal(selectExpressionFor("SELECT outlet_region_name FROM t", "outlet_region"), null,
    "outlet_region_name 不是 outlet_region");

  /* 上面几条只验了两个解析函数,没验探测**真的用了**它们 —— 把实现改成
     "裸列名时随便挑 FROM 里第一张表",那几条照样全绿。测试够不着的代码,改坏了没人知道。
     所以这里直接看它最后发出去的那条 SQL。 */
  {
    const metric = {
      id: "business_days", name: "有效天数", enabled: true, connId: "c", type: "measure",
      dimensions: ["outlet_region"], timeField: "stat_date", unit: "天", aliases: [], caliber: "", category: "营业",
      source: "shop_ads.ads_outlet_daily a JOIN shop_ads.ads_outlet_dim d ON a.store_id = d.outlet_uuid",
      expression: "COUNT(DISTINCT a.stat_date)",
    };
    const dataset = { id: "d", name: "x", sourceType: "sql", connectionId: "c", database: "", sql: "", fields: [],
      metricIds: ["business_days"], metricScope: { start: "2026-09-14", end: "2026-09-20" } };
    let sent = null;
    const values = await fastDimensionValues(dataset, "outlet_region", 301, "华东大区", [metric], {
      dialectFor: () => "mysql",
      readQuery: async (_id, _db, sql) => { sent = sql; return { columns: [{ name: "outlet_region" }], rows: [["华东大区"]] }; },
    });
    assert.deepEqual(values, ["华东大区"], "探测要真能把「华东大区」查回来");
    assert.ok(/FROM shop_ads\.ads_outlet_daily a JOIN shop_ads\.ads_outlet_dim d ON/.test(sent),
      "裸列名要拿**整个 FROM**去查,不许只挑一张表 —— 猜错表会查出一份别的表的清单:" + sent);
    assert.ok(!/stat_date >=|BETWEEN/.test(sent),
      "取值探测不带日期范围 —— 大区有哪些跟这一周有没有生意是两件事:" + sent);
  }

}

// ── 取数超时要给能动手的建议 ─────────────────────────────────
// 真机:「[DataExecutor] 取数失败(primary):Dashboard query timed out after 30 seconds.」
// 甩一句 timed out 出来,用户只能干瞪眼。超时和"写错了"不是一回事:
// 前者是这条查询太重,能靠少要指标/缩短区间/去掉高基数维度自己解决。
{
  resetTools();
  registerTool({ name: "execute_query_plan", description: "", readOnly: true,
    schema: { type: "object", properties: {}, additionalProperties: true },
    run: () => { throw new Error("Dashboard query timed out after 180 seconds."); } });
  const state = { workflowId: "w", retry: {}, trace: [], errors: [], usage: [], dropped: [],
    validatedMetrics: Array.from({ length: 8 }, (_, i) => ({ metricId: `m${i}`, name: `指标${i}`, unit: "元",
      caliber: "", rollup: "sum", supportedDimensions: ["month"], dateScoped: true, sourceTables: ["t"] })),
    scope: { label: "2026-03-01 至 2026-08-31", dateRange: { start: "2026-03-01", end: "2026-08-31" }, comparisonRanges: [], filters: [] },
    plans: [{ role: "primary", planId: "p1", dateRange: { start: "2026-03-01", end: "2026-08-31" } }] };
  await assert.rejects(() => dataExecutor(state), (e) => {
    assert.ok(/太重/.test(e.message), "要说清是太重了,不是写错了:" + e.message);
    assert.ok(/8 个指标/.test(e.message), "要点出是几个指标一起查:" + e.message);
    assert.ok(/2026-03-01 至 2026-08-31/.test(e.message), "要点出时间范围:" + e.message);
    assert.ok(/缩短/.test(e.message), "要给能动手的建议:" + e.message);
    return true;
  });

  // 反向对照:不是超时的失败别硬套这套说辞
  resetTools();
  registerTool({ name: "execute_query_plan", description: "", readOnly: true,
    schema: { type: "object", properties: {}, additionalProperties: true },
    run: () => { throw new Error("Unknown column 'b.deposit_amt' in 'field list'"); } });
  await assert.rejects(() => dataExecutor(state), (e) => {
    assert.ok(!/太重/.test(e.message), "列名写错不是「太重」,别给错的建议:" + e.message);
    assert.ok(/Unknown column/.test(e.message), "数据库原话要留着:" + e.message);
    return true;
  });
  resetTools();
}

// ── 模型的设计要真的落到看板上 ────────────────────────────────
// 用户说「版式主题感觉没变化,始终都是这一套,像被你框死了」。
// 我两轮里宣称过两次「放开了排版和配色」,却**从没验证过那些字段真的传下去了**。
// 松开 Reviewer 只是拿掉一个覆盖源,不等于设计就到得了文档。
{
  const seen = { add: [], style: [], move: [] };
  resetTools();
  registerTool({ name: "create_dashboard", description: "", readOnly: false,
    schema: { type: "object", properties: {}, additionalProperties: true },
    run: () => ({ dashboardId: "dash1" }) });
  registerTool({ name: "add_component", description: "", readOnly: false,
    schema: { type: "object", properties: {}, additionalProperties: true },
    run: (i) => { seen.add.push(i); return { widgetId: `w${seen.add.length}` }; } });
  registerTool({ name: "move_component", description: "", readOnly: false,
    schema: { type: "object", properties: {}, additionalProperties: true },
    run: (i) => { seen.move.push(i); return {}; } });
  registerTool({ name: "style_component", description: "", readOnly: false,
    schema: { type: "object", properties: {}, additionalProperties: true },
    run: (i) => { seen.style.push(i); return {}; } });
  for (const n of ["set_dashboard_scope", "set_dashboard_provenance", "save_dashboard"]) {
    registerTool({ name: n, description: "", readOnly: false,
      schema: { type: "object", properties: {}, additionalProperties: true }, run: () => ({ dashboardId: "dash1" }) });
  }

  const state = {
    workflowId: "w", retry: {}, trace: [], errors: [], usage: [], dropped: [],
    scope: { label: "近3月", dateRange: { start: "2026-06-01", end: "2026-08-31" }, comparisonRanges: [] },
    validatedMetrics: [{ metricId: "m1", name: "会员消费额", unit: "元", caliber: "", rollup: "sum",
      supportedDimensions: ["month", "war_zone"], dateScoped: true, sourceTables: ["t"] }],
    layout: {
      title: "会员经营", description: "", theme: "结论先行",
      preset: "violet", palette: ["#5B8FF9", "#5AD8A6"],
      items: [
        { band: "kpi", type: "text", title: "分区", content: "一、总体判断", metricIds: [], dimensions: [],
          width: "full", reason: "r", x: 0, y: 0, w: 12, h: 1,
          appearance: { hideTitle: true, titleAlign: "center" }, text: { fontSize: 18, align: "center" } },
        { band: "trend", type: "line", title: "趋势", metricIds: ["m1"], dimensions: ["month"],
          width: "half", reason: "r", x: 0, y: 1, w: 8, h: 5,
          appearance: { visualPreset: "aurora", radius: 12 },
          chart: { lineArea: true, barOrientation: "vertical" }, footnote: "数据截至昨日" },
      ],
    },
  };
  await dashboardExecutor(state);

  // 文字块的正文要传下去,否则页面上就是个空卡
  const textAdd = seen.add.find((a) => a.type === "text");
  assert.equal(textAdd.content, "一、总体判断", "text 块的正文没传:" + JSON.stringify(textAdd));

  // 模型自己排的坐标要原样落地,不能被兜底排版顶掉
  const lineMove = seen.move[1];
  assert.deepEqual({ x: lineMove.x, y: lineMove.y, w: lineMove.w, h: lineMove.h }, { x: 0, y: 1, w: 8, h: 5 },
    "模型排的位置要原样落地:" + JSON.stringify(lineMove));

  // 外观/图表细节/脚注:这三样是「版式主题」的全部,丢一样看板就长得一样
  // 整板预设要铺到**每一张**卡上 —— 模型只挑一次基调,不必逐卡配色。
  // 「版式主题始终是那一套」的真实原因不是被框死,是 appearance 是可选字段,
  // prompt 一长模型就省了,于是每张卡都是默认样式。
  assert.ok(seen.style.every((x) => x.appearance?.visualPreset),
    "每张卡都该带上整板预设:" + JSON.stringify(seen.style.map((x) => x.appearance)));
  const lineStyle = seen.style.find((x) => x.appearance?.visualPreset === "aurora");
  assert.ok(lineStyle, "外观预设没传下去 —— 这就是「每块看板长得一样」的原因:" + JSON.stringify(seen.style));
  assert.equal(lineStyle.appearance.visualPreset, "aurora", "单卡自己给的预设要盖过整板的");
  const textStylePreset = seen.style.find((x) => x.text);
  assert.equal(textStylePreset.appearance.visualPreset, "violet", "没自己指定的卡,用整板基调");
  assert.equal(lineStyle.appearance.radius, 12);
  assert.equal(lineStyle.footnote, "数据截至昨日");
  assert.equal(lineStyle.chart.lineArea, true);
  // 整板配色要兜底进每张图
  assert.deepEqual(lineStyle.chart.palette, ["#5B8FF9", "#5AD8A6"], "整板 palette 要落到图上");
  // 文本块的排版
  const textStyle = seen.style.find((x) => x.text);
  assert.equal(textStyle.text.fontSize, 18);
  assert.equal(textStyle.appearance.hideTitle, true);
}

// ── 参数锁死模式:人给的参数,一个字都不许改 ──────────────────
// 十几轮失败里一多半出在「把人话变成参数」:日期解析成 6 天、两个大区被粘成
// 一个不存在的取值、时间维度被漏掉。这类错**判错了下游看不出来**。
// 所以分工换一下:数据是什么人说了算,数据说明什么模型说了算。
{
  const sent = [];
  resetTools();
  registerTool({ name: "build_query_plan", description: "", readOnly: true,
    schema: { type: "object", properties: {}, additionalProperties: true },
    run: (i) => { sent.push(i); return { planId: `p${sent.length}` }; } });

  const params = {
    metricIds: ["m1", "m2"],
    dimensions: ["month", "war_zone", "store"],
    dateRange: { start: "2026-06-01", end: "2026-08-31" },
    comparisons: ["mom"],
    filters: [{ field: "war_zone", values: ["华东大区", "华北大区"] }],
    focus: "重点看预存转化",
    wantsDashboard: true,
  };
  const out = await lockedPlanner({ workflowId: "w", lockedParams: params, retry: {}, trace: [], errors: [], usage: [] });

  assert.equal(sent.length, 2, "主查询 + 一个环比");
  const primary = sent[0];
  assert.deepEqual(primary.dimensions, ["month", "war_zone", "store"],
    "维度是人选的,**一个都不许砍** —— 自然语言那条路上 trimDimensions 会替他做主:" + JSON.stringify(primary.dimensions));
  assert.deepEqual(primary.filters, [{ field: "war_zone", values: ["华东大区", "华北大区"] }],
    "取值是他从真实清单里点的,不该再去库里核一遍");
  assert.deepEqual(primary.dateRange, { start: "2026-06-01", end: "2026-08-31" }, "区间照搬");
  assert.equal(primary.grain, "month", "粒度取维度里的那个时间维度");
  assert.deepEqual(sent[1].dateRange, { start: "2026-03-01", end: "2026-05-31" }, "环比区间要是前三个整月:" + JSON.stringify(sent[1].dateRange));
  assert.deepEqual(out.plans.map((p) => p.role), ["primary", "mom"]);

  // 锁死模式下体检失败**不回头重规划** —— 维度和区间是用户选的,轮不到程序改
  const g = buildLockedGraph();
  const routes = g.validate();
  assert.deepEqual(routes, [], "图配置要合法:" + JSON.stringify(routes));
  resetTools();
}

// ── 「分析」的表单要活过切 tab ────────────────────────────────
// 真机:选好指标维度日期,切去看一眼表再切回来,全没了 —— 一张白纸。
// 根因是状态放在组件的 useState 里,而 QueryPanel 只渲染当前 tab,
// 切走组件就被卸载。跑到一半切走更糟:查询还在跑,setState 已经没人接。
{
  const store = useAnalysis.getState();
  store.reset();
  store.patch({ metricIds: ["m1", "m2"], dimensions: ["war_zone"], grain: "week", focus: "重点看预存" });
  store.patch({ filterValues: { war_zone: ["华东大区"] } });

  // 组件卸载重挂 = 重新从 store 读;这里直接验落盘的那份
  const saved = JSON.parse(localStorage.getItem("sonde.analysis.v1"));
  assert.deepEqual(saved.metricIds, ["m1", "m2"], "指标要留住 —— 选指标是有成本的,不该因为看一眼别的表就重来");
  assert.equal(saved.grain, "week");
  assert.equal(saved.focus, "重点看预存");
  assert.deepEqual(saved.filterValues, { war_zone: ["华东大区"] }, "筛选取值也要留");
  // patch 是合并不是覆盖 —— 改一个字段不能把别的清掉
  assert.deepEqual(saved.dimensions, ["war_zone"], "第二次 patch 不能把第一次的维度冲掉");

  // 运行状态放内存(带样例行,存盘既大又没必要),但要能跨卸载读到
  useAnalysis.setState({ run: { status: "done", trace: ["DataExecutor"], errors: [] } });
  assert.equal(useAnalysis.getState().run.status, "done", "跑到一半切走再回来,进度要接得上");
  // 结果不该落盘
  const saved2 = JSON.parse(localStorage.getItem("sonde.analysis.v1"));
  assert.equal(saved2.run, undefined, "运行结果别写进 localStorage");

  store.reset();
  assert.deepEqual(JSON.parse(localStorage.getItem("sonde.analysis.v1")), { modelChoiceMigration: 1 });
}

console.log("agent pipeline: 步骤上报、构图修补、真工具落文档、执行节点、分析表单都对");
