// 指标:导入提示、语义指标的底表、指标体检、指标目录归一化。
import assert from "node:assert/strict";
import { loadSrc } from "./lib/load-src.mjs";

const m = loadSrc("metrics", {
  "src/features/dashboard/semantic.ts": "{ compileSemanticDataset }",
  "src/features/metrics/metricsStore.ts": "{ useMetrics as metricsStore }",
  "src/features/metrics/MetricsCenter.tsx": "{ importSummary }",
  "src/features/metrics/queryPlan.ts": "{ planSourceTables }",
  "src/features/metrics/metricHealth.ts": "{ checkMetrics, referencedColumns }",
  "src/features/entity/entityPrompt.ts": "{ buildEntityPrompt, collectEntityFacts }",
});
const { compileSemanticDataset, metricsStore, importSummary, planSourceTables, checkMetrics, referencedColumns, buildEntityPrompt, collectEntityFacts } = m;

// ── 导入指标目录:"一个都没导进去"绝不能报绿的 ────────────────────
// 真机踩过:底表从 ads 换到 dws,重新导一份口径,点的是「导入指标目录」(keep),
// 12 个标识全在库里 → 全跳过 → 弹了个绿色的「跳过 12 个同标识的」。
// 人看完以为成了,回头查数还是老表,而且指标编辑器里根本不显示底表,查不出来。
{
  const allSkipped = importSummary({ added: 0, replaced: 0, skipped: 12 });
  assert.equal(allSkipped.kind, "warn", "一个都没变的导入必须是警告色,不能是 success");
  assert.ok(/一个都没导进去/.test(allSkipped.text), allSkipped.text);
  assert.ok(/导入并覆盖同名指标/.test(allSkipped.text),
    "光说「跳过了」没用,得把该点哪个按钮写在脸上:" + allSkipped.text);

  // 反向对照:真覆盖了就该是 success,别把正常结果也吓唬成警告
  const replaced = importSummary({ added: 0, replaced: 12, skipped: 0 });
  assert.equal(replaced.kind, "success");
  assert.ok(/覆盖 12 个/.test(replaced.text), replaced.text);
  // 部分跳过仍是成功 —— 毕竟有东西进去了
  const mixed = importSummary({ added: 3, replaced: 0, skipped: 9 });
  assert.equal(mixed.kind, "success");
  assert.ok(/新增 3 个/.test(mixed.text) && /跳过 9 个/.test(mixed.text), mixed.text);
  // 取消选文件 → 什么都不弹
  assert.equal(importSummary({ added: 0, replaced: 0, skipped: 0 }), null);
}

// 语义指标的底表要能从 queryPlan 里解析出来给界面显示 —— 改没改对得看得见
{
  const ratio = {
    kind: "ratio", scale: 1,
    numerator: { kind: "sql", dimensions: {}, sourceTables: ["shop_dws.dws_user_outlet_behavior_day", "shop_ads.ads_outlet_dim"], template: "SELECT 1" },
    denominator: { kind: "sql", dimensions: {}, sourceTables: ["shop_ads.ads_outlet_dim", "shop_ads.ads_outlet_daily"], template: "SELECT 1" },
  };
  // 分母里既有和分子重复的表(要去重),也有只在分母里的表(不能漏)
  assert.deepEqual(planSourceTables(ratio),
    ["shop_dws.dws_user_outlet_behavior_day", "shop_ads.ads_outlet_dim", "shop_ads.ads_outlet_daily"],
    "比率型要把分子分母的底表并起来去重");
}

// ── 指标体检:底表没了 / 字段不存在,得当场看得出来 ──────────────
// 这条测试对应的真事:ads_outlet_member_day 被删,12 个会员指标的口径还挂在上面,
// 指标中心一切正常,直到有人去查数才发现是空的。
{
  const mk = (id, name, tables, template) => ({
    id, key: id, name, type: "template", enabled: true, connId: "c", database: "d",
    unit: "人", aliases: [], caliber: "", category: "会员", dimensions: ["day"],
    queryPlan: { kind: "sql", scale: 1, dimensions: {}, sourceTables: tables, template },
  });
  // 库里真实存在的列
  const world = {
    "shop_dws.dws_user_outlet_behavior_day": ["stat_date", "user_id", "behavior_outlet_id", "consume_flag", "member_flag", "consume_amt"],
    "shop_dim.dim_outlet_mapping": ["qm_id", "store_id"],
  };
  const lookup = async (_conn, db, table) => world[`${db}.${table}`] ?? null;

  const good = mk("m1", "消费会员数", ["shop_dws.dws_user_outlet_behavior_day", "shop_dim.dim_outlet_mapping"],
    "SELECT {{select}}COUNT(DISTINCT CASE WHEN b.consume_flag=1 AND b.member_flag=1 THEN b.user_id END) AS value"
    + " FROM shop_dws.dws_user_outlet_behavior_day b JOIN shop_dim.dim_outlet_mapping sm ON sm.qm_id=b.behavior_outlet_id"
    + " WHERE b.stat_date BETWEEN {{start}} AND {{end}}");
  const badCol = mk("m2", "预存金额", ["shop_dws.dws_user_outlet_behavior_day"],
    "SELECT {{select}}SUM(b.deposit_amt) AS value FROM shop_dws.dws_user_outlet_behavior_day b WHERE b.stat_date BETWEEN {{start}} AND {{end}}");
  const badTable = mk("m3", "会员消费额", ["shop_ads.ads_outlet_member_day"],
    "SELECT {{select}}SUM(m.member_consume_amt) AS value FROM shop_ads.ads_outlet_member_day m WHERE m.stat_date BETWEEN {{start}} AND {{end}}");

  const r = await checkMetrics([good, badCol, badTable], lookup);
  assert.equal(r.checked, 3);
  assert.equal(r.tables, 3, "同一张底表被多个指标共用时只问一次:" + r.tables);
  const byName = Object.fromEntries(r.unhealthy.map((h) => [h.metricName, h.issues]));

  assert.ok(!byName["消费会员数"], "口径完全对得上的指标不能被报出来 —— 会误报的体检没人看第二次");
  assert.equal(byName["预存金额"][0].kind, "column-missing");
  assert.ok(/deposit_amt/.test(byName["预存金额"][0].text), byName["预存金额"][0].text);
  assert.equal(byName["会员消费额"][0].kind, "table-missing");
  assert.ok(/ads_outlet_member_day/.test(byName["会员消费额"][0].text));
  // 表都没了就别再报它的列 —— 并集缺一块,判出来的"列不存在"全是假的
  assert.equal(byName["会员消费额"].length, 1,
    "底表不存在时不该顺带报一堆列不存在:" + JSON.stringify(byName["会员消费额"]));

  // 反向对照 1:库里啥都有,必须一个问题都不报
  const all = async () => [...new Set(Object.values(world).flat().concat(["deposit_amt", "member_consume_amt"]))];
  const clean = await checkMetrics([good, badCol, badTable], all);
  assert.equal(clean.unhealthy.length, 0, "列全都在时不能还报问题:" + JSON.stringify(clean.unhealthy));

  // 反向对照 2:停用的指标不体检(停用就是不想要了,报它是噪音)
  const off = await checkMetrics([{ ...badTable, enabled: false }], lookup);
  assert.equal(off.checked, 0);

  // 表名本身会被 `库.表` 的写法抓成"列",必须排掉,否则每个指标都误报一次
  assert.ok(referencedColumns("FROM shop_dws.dws_user_outlet_behavior_day b").includes("dws_user_outlet_behavior_day"),
    "抠列的正则确实会把表名抓进来 —— 所以 checkMetrics 里那层排除是必需的,不是多余小心");
}

// 带表别名前缀的维度:读进来必须剥成裸名,且派生指标带分组要能拼出可用的 SQL。
// 真机上这两条各自炸过一次(Unknown column 'd.outlet_region' / 出货率一分组就没维度列)。
{
  metricsStore.getState().importMetrics([{
    id: "m1", name: "销售额", key: "total_gmv", type: "measure", connId: "c1", enabled: true,
    source: "fact a JOIN dim d ON a.store_id = d.uuid", expression: "SUM(a.gmv)",
    dimensions: ["d.outlet_region", "a.stat_date", "outlet_region"],
    dimensionLabels: { "d.outlet_region": "大区", "a.stat_date": "日期", "已删掉的": "x" },
  }], "replace");
  const gmv = metricsStore.getState().metrics.find((m) => m.id === "m1");
  assert.deepEqual(gmv.dimensions, ["outlet_region", "stat_date"], "维度要剥成裸名并去重");
  assert.deepEqual(gmv.dimensionLabels, { outlet_region: "大区", stat_date: "日期" }, "标签跟着裸名走");

  const num = { ...gmv, id: "m2", name: "出货额", key: "out_amt", source: "supply a JOIN dim d ON a.store_id = d.uuid", expression: "SUM(a.out_amt)" };
  const derived = {
    ...gmv, id: "m3", name: "出货率", key: "shipment_rate", type: "derived", scale: 100,
    numeratorMetricId: "m2", denominatorMetricId: "m1",
  };
  const ds = { id: "d1", metricIds: ["m1", "m3"], groupBy: ["outlet_region"], connectionId: "c1",
    metricScope: { start: "2026-08-01", end: "2026-08-31" } };
  const sql = compileSemanticDataset(ds, [gmv, num, derived], [], "mysql").sql;
  assert(!/\bd\.outlet_region\b/.test(sql), "外层不能再出现带前缀的维度");
  assert(/MAX\(out_amt\)\/NULLIF\(MAX\(total_gmv\),0\)\*100 AS shipment_rate/.test(sql),
    "派生指标要拆成分子/分母再在外层相除");
  assert(!/NULL AS shipment_rate/.test(sql), "派生指标不该再占一个空单元");
  // 拆不开的派生指标 + 分组:要当场报清楚,而不是拼出一条注定 Unknown column 的 SQL
  const opaque = { ...derived, id: "m4", key: "bad", numeratorMetricId: "nope" };
  assert.throws(() => compileSemanticDataset({ ...ds, metricIds: ["m4"] }, [gmv, num, derived, opaque], [], "mysql"),
    /不支持按维度拆分/);
}

// 表详情 / 问 AI:建在这张表上的指标 —— 直接按指标的底表算(不再依赖血缘图),带上读了哪几个字段
{
  const catalog = [
    { id: "a", name: "堂食营业额", type: "measure", source: "dw.ads_store_day", sql: "SELECT SUM(s.dine_gmv_amt) FROM dw.ads_store_day s", caliber: "含储值" },
    { id: "b", name: "门店数", type: "measure", source: "ads_store_day", sql: "SELECT COUNT(DISTINCT store_id) FROM ads_store_day" },
    { id: "c", name: "会员数", type: "measure", source: "dw.member_day", sql: "SELECT COUNT(*) FROM dw.member_day" },
  ];
  const facts = collectEntityFacts({ database: "DW", table: "ADS_STORE_DAY" }, catalog);
  assert.equal(facts.id, "dw.ads_store_day", "库名表名不分大小写");
  assert.deepEqual(facts.metrics.map((x) => x.name).sort(), ["堂食营业额", "门店数"], "底表写成「库.表」或只写表名都算;别的表的指标不算");
  assert.ok(facts.metrics.find((x) => x.name === "堂食营业额").fields.includes("dine_gmv_amt"), "读了哪个字段要认得出来");
  const prompt = buildEntityPrompt(facts, "仓库");
  assert.ok(/共 2 个/.test(prompt) && !/object Object/.test(prompt), prompt);
  assert.ok(/没有指标用到/.test(buildEntityPrompt(collectEntityFacts({ table: "nothing" }, catalog), "x")), "没有指标就直说");
}

console.log("metrics: 导入提示、底表解析、指标体检、维度归一化、表详情的相关指标都对");
