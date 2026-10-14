// 指标与血缘:ETL 文件引用 / DataX 解析 / 扫描脚本、列级相关性、360 提示词、摘表摘作业、导入提示、指标体检、指标目录归一化。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { loadSrc } from "./lib/load-src.mjs";

const m = loadSrc("metrics-lineage", {
  "src/features/dashboard/semantic.ts": "{ compileSemanticDataset }",
  "src/features/etl/fileCatalog.ts": "{ resolveReference, enrichTasks }",
  "src/features/etl/adapters/datax.ts": "{ dataxAdapter }",
  "src/features/etl/etlStore.ts": "{ useEtl as etlStore }",
  "src/features/lineage/sqlColumns.ts": "{ outputColumns, sqlVocab }",
  "src/features/lineage/lineageStore.ts": "{ useLineage as lineageStore, tableId }",
  "src/features/lineage/opsStore.ts": "{ useOps as opsStore }",
  "src/features/entity/entityPrompt.ts": "{ buildEntityPrompt }",
  "src/features/metrics/metricsStore.ts": "{ useMetrics as metricsStore }",
  "src/features/metrics/MetricsCenter.tsx": "{ importSummary }",
  "src/features/metrics/queryPlan.ts": "{ planSourceTables }",
  "src/features/metrics/metricHealth.ts": "{ checkMetrics, referencedColumns }",
});
const { compileSemanticDataset, resolveReference, enrichTasks, dataxAdapter, etlStore, outputColumns, sqlVocab, lineageStore, tableId, opsStore, buildEntityPrompt, metricsStore, importSummary, planSourceTables, checkMetrics, referencedColumns } = m;

assert.equal(resolveReference("/worker/jobs/a.json", ["/local/jobs/a.json"], [{ from: "/worker", to: "/local" }]), "/local/jobs/a.json");
assert.equal(resolveReference("a.json", ["/one/a.json", "/two/a.json"]), undefined);
const file = { id: "f", references: ["/local/jobs/a.json"], flows: [{ sources: [{ kind: "db", table: "raw" }], targets: [{ kind: "db", table: "fact" }] }] };
const task = { id: "t", references: ["/worker/jobs/a.json"], sources: [], targets: [] };
assert.equal(enrichTasks([task], [file], [{ from: "/worker", to: "/local" }])[0].targets[0].table, "fact");
const parsed = dataxAdapter.parse(JSON.stringify({ job: { content: [{ reader: { name: "mysqlreader", parameter: { connection: [{ jdbcUrl: ["jdbc:mysql://host/db"], querySql: ["select * from a", "select * from b"] }] } }, writer: { name: "mysqlwriter", parameter: { connection: [{ jdbcUrl: "jdbc:mysql://host/db", table: ["target"] }] } } }] } }));
assert.equal(parsed[0].sources.length, 2);
const scanner = spawnSync("python3", ["-c", `
import importlib.util, pathlib, tempfile
spec = importlib.util.spec_from_file_location("inspect_etl", "src-tauri/resources/inspect_etl.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as folder:
    root = pathlib.Path(folder)
    (root / "job.py").write_text('sql = "INSERT INTO mart.target SELECT * FROM raw.source"\\ndynamic = f"SELECT * FROM {table}"\\n')
    (root / "snapshot.before.sql").write_text("INSERT INTO backup VALUES (1)")
    (root / ".private.sql").write_text("SELECT * FROM secrets")
    result = module.inspect(root)
    assert len(result["files"]) == 1, result
    assert result["files"][0]["sql"] == ["INSERT INTO mart.target SELECT * FROM raw.source"], result
    assert len(result["warnings"]) == 1, result
`], { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
assert.equal(scanner.status, 0, scanner.stderr);
// 列级相关性:灌宽表的每条入口都在 SELECT 里写明它产出哪几列。
// 指标只读其中几列,靠这个把不相干的入口(供应链 / 会员 / 巡检)剪掉。
const wmSql = "SELECT stat_date, store_id, SUM(order_cnt - refund_cnt) AS wm_order_cnt, ROUND(SUM(paid_amount), 2) AS online_gmv_amt FROM shop_dws.dws_online_channel_day GROUP BY stat_date, store_id";
const wmCols = outputColumns(wmSql);
assert(wmCols.has("online_gmv_amt") && wmCols.has("wm_order_cnt"), "别名列要认出来");
assert(wmCols.has("stat_date") && wmCols.has("store_id"), "裸列也要认出来");
assert(!wmCols.has("paid_amount"), "函数里的参数不是产出列");
const vocab = sqlVocab("SELECT SUM(a.offline_gmv_amt + a.online_gmv_amt) FROM shop_ads.ads_outlet_daily a");
assert(vocab.has("online_gmv_amt") && vocab.has("offline_gmv_amt"), "口径里读到的列要进词表");
assert(!vocab.has("sum") && !vocab.has("select"), "SQL 关键字不算列");
assert([...wmCols].some((c) => vocab.has(c)), "线上入口应命中销售额口径");
const scCols = outputColumns("SELECT stat_date, store_id, SUM(delivery_amount) AS shipment_amt FROM shop_dws.dws_inventory_trade_day GROUP BY stat_date, store_id");
assert(!vocab.has("shipment_amt"), "供应链入口不该命中销售额口径");
assert(scCols.has("shipment_amt"));

// 360 全景「问 AI」的提示词:同名作业要能区分,指标不能变成 [object Object]。
const facts = {
  id: "shop_ads.ads_outlet_daily",
  up: ["shop_dws.dws_online_channel_day"],
  downTables: [],
  metrics: [
    { id: "v1:total_gmv", name: "销售额", fields: ["offline_gmv_amt", "online_gmv_amt", "stat_date"] },
    { id: "v1:online_gmv", name: "线上销售额", fields: ["online_gmv_amt", "stat_date"] },
    /* 再凑几个指标:共用键是按**占比**认的(几乎每个指标都读),不再按字段名硬剔。
       指标太少时没有占比可言,那时候 stat_date 就该当成普通列照常列出来 ——
       它确实只有那么几个指标读。 */
    ...Array.from({ length: 8 }, (_, i) => (
      { id: `v1:m${i}`, name: `指标${i}`, fields: ["stat_date", `col_${i}_amt`] })),
    { id: "v1:x", name: "解析不出的指标", fields: [] },
  ],
  producedBy: [
    { src: "datax_jobs", job: { id: "a", name: "ads_outlet_daily" }, from: ["shop_dws.dws_online_channel_day"], cols: ["online_gmv_amt"] },
    { src: "datax_jobs", job: { id: "b", name: "ads_outlet_daily" }, from: ["shop_dws.dws_inventory_trade_day"], cols: ["shipment_amt"] },
  ],
};
const prompt = buildEntityPrompt(facts, "应用库");
assert(!prompt.includes("[object Object]"), "指标必须是名字,不能是对象");
assert(prompt.includes("销售额") && prompt.includes("线上销售额"));
// 两条同名作业靠「从哪读 / 灌哪几列」区分开
assert(prompt.includes("ads_outlet_daily ← shop_dws.dws_online_channel_day,灌 online_gmv_amt"));
assert(prompt.includes("ads_outlet_daily ← shop_dws.dws_inventory_trade_day,灌 shipment_amt"));
assert(prompt.includes("online_gmv_amt — 2 个指标"), "指标按字段聚合");
/* 几乎每个指标都读的键(这儿 10/10)拎到「共用键」那一行,不占用下面的清单 ——
   否则它永远排第一,把真正有区分度的列挤到 25 行开外看不见。
   注意它不是被扔掉:改这种字段波及面最大,得让模型知道。 */
assert(!prompt.split("\n").some((l) => l.startsWith("- stat_date —")), "共用键不占清单里的位置");
assert(prompt.split("\n").some((l) => l.includes("共用键") && l.includes("stat_date")), "共用键要单独说,不能悄悄扔掉");
assert(prompt.includes("另有 1 个指标没解析出具体字段"));

// ── 把一张已经删掉的表从血缘里摘干净 ────────────────────────────
// 真机场景:线上把 ads_outlet_member_day 和它的 DataX 作业都删了,可 Sonde 里
// 还留着 3 条边 + 一条 ops 记录,巡检天天报警、图上画着通往空气的线。
{
  const gone = "shop_ads.ads_outlet_member_day";
  const keep = "shop_ads.ads_outlet_daily";
  lineageStore.setState({ scanned: [
    { from: "shop_dws.dws_user_outlet_behavior_day", to: gone, source: "etl", kind: "写入" },
    { from: "shop_dim.dim_outlet_mapping", to: gone, source: "etl", kind: "写入" },
    { from: gone, to: "metric:m1", source: "metric", kind: "用于" },
    { from: "shop_dwd.dwd_a", to: keep, source: "etl", kind: "写入" },   // 无关的边,必须活下来
  ] });
  opsStore.setState({
    ops: { [gone]: { origin: "etl", schedule: "0 0 8 * * ? *" }, [keep]: { origin: "etl", schedule: "0 0 9 * * ? *" } },
    health: { [gone]: { state: "error", checkedAt: 1 } },
  });

  lineageStore.getState().forgetNode(gone);
  const left = lineageStore.getState().scanned;
  assert.equal(left.length, 1, "指向它的三条边(不论来源)都该清掉,得到:" + JSON.stringify(left));
  assert.equal(left[0].to, keep, "别的表的血缘不能受牵连");
  assert.equal(opsStore.getState().ops[gone], undefined, "运行状态也要一起忘掉,否则巡检还会报它");
  assert.equal(opsStore.getState().health[gone], undefined);
  assert.ok(opsStore.getState().ops[keep], "只忘掉这一个节点");
  assert.ok(/已摘掉/.test(lineageStore.getState().lastMsg ?? ""), lineageStore.getState().lastMsg);

  // 反向对照:换个不存在的节点 id,必须什么都不删,并且明说"没找到"
  lineageStore.getState().forgetNode("shop_ads.不存在的表");
  assert.equal(lineageStore.getState().scanned.length, 1, "摘一个血缘里没有的节点不该误伤任何边");
  assert.ok(/没有指向/.test(lineageStore.getState().lastMsg ?? ""),
    "没删到东西就得说没删到,不能也报「已摘掉」:" + lineageStore.getState().lastMsg);

  // 作业不删,下次扫描会把边画回来 —— 所以要能单独摘作业
  etlStore.setState({ sources: [{ id: "s1", name: "[datax_jobs]", kind: "datax", updatedAt: 0, jobs: [
    { id: "j1", name: "ads_outlet_member_day", kind: "datax", sources: [], targets: [{ kind: "db", database: "shop_ads", table: "ads_outlet_member_day" }] },
    { id: "j2", name: "ads_outlet_daily", kind: "datax", sources: [], targets: [{ kind: "db", database: "shop_ads", table: "ads_outlet_daily" }] },
  ] }] });
  etlStore.getState().removeJob("s1", "j1");
  const jobs = etlStore.getState().sources[0].jobs;
  assert.deepEqual(jobs.map((j) => j.id), ["j2"], "只摘掉点名的那个作业,同源的其余 60 个作业不能跟着没");
  // 反向对照:作业 id 打错时不能静默清空整个源
  etlStore.getState().removeJob("s1", "j-typo");
  assert.equal(etlStore.getState().sources[0].jobs.length, 1);
  assert.equal(tableId("shop_ads", "ads_outlet_member_day"), gone);

  lineageStore.setState({ scanned: [] });
  opsStore.setState({ ops: {}, health: {} });
  etlStore.setState({ sources: [] });
}

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

console.log("metrics & lineage: ETL 解析、列级相关性、360 提示词、摘表、导入提示、指标体检、维度归一化都对");
