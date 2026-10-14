// 看板这一层:语义数据集编译、看板文档的改写与归一化、导入、运行时合并 / 下钻、取数的并发闸门和缓存。
import assert from "node:assert/strict";
import { loadSrc } from "./lib/load-src.mjs";

const m = loadSrc("dashboard-core", {
  "src/features/dashboard/semantic.ts": "{ semanticDataset, compileSemanticDataset, resolveSemanticDocument }",
  "src/features/dashboard/domain.ts": "{ normalizeDashboard, placeWidgetNear }",
  "src/lib/sql.ts": "{ buildDataQuery }",
  "src/features/dashboard/dashboardService.ts": "* as dash",
  "src/features/dashboard/dataService.ts": "{ matchDimensionValue }",
  "src/features/dashboard/widgets/metricUtils.ts": "{ scaledText }",
  "src/features/dashboard/transfer.ts": "{ parseDashboardFile }",
  "src/features/dashboard/useDashboardRuntime.ts": "{ mergeCanvasRuntime, nextDrillPath }",
  "src/features/dashboard/query.ts": "{ executeDataset, clearQueryCache }",
  "src/lib/api.ts": "{ api }",
});
const { semanticDataset, compileSemanticDataset, resolveSemanticDocument, normalizeDashboard, placeWidgetNear, buildDataQuery, dash, matchDimensionValue, scaledText, parseDashboardFile, mergeCanvasRuntime, nextDrillPath, executeDataset, clearQueryCache } = m;

const plan = {
  kind: "sql", dimensions: { region: { label: "区域", expression: "region" } }, sourceTables: ["orders"],
  template: "SELECT {{select}}SUM(amount) AS value FROM orders WHERE day BETWEEN {{start}} AND {{end}}{{filters}}{{groupBy}}",
};
const metric = { id: "sales", key: "sales", name: "销售额", type: "template", queryPlan: plan, enabled: true, connId: "c", database: "retail", dimensions: ["region"], unit: "元" };
const widget = { id: "w", datasetId: "semantic:w", type: "kpi", bindings: { metricIds: ["sales"], secondaryMetricIds: [], measures: ["sales"] }, options: { metrics: {} } };
const scope = { start: "2026-01-01", end: "2026-01-31" };
const ds = semanticDataset(widget, [metric], scope);
assert.deepEqual(ds.groupBy, []);
assert(!compileSemanticDataset(ds, [metric]).sql.includes("GROUP BY"));
const changed = { ...metric, queryPlan: { ...plan, template: plan.template.replace("SUM(amount)", "SUM(net_amount)") } };
assert(compileSemanticDataset(ds, [changed]).sql.includes("SUM(net_amount)"));
assert.throws(() => compileSemanticDataset(ds, []), /已删除/);
assert.throws(() => compileSemanticDataset(ds, [{ ...metric, enabled: false }]), /已停用/);
const bar = { ...widget, type: "bar", bindings: { ...widget.bindings, dimension: "region" } };
const byRegion = semanticDataset(bar, [metric], scope);
assert(compileSemanticDataset(byRegion, [metric]).sql.includes("GROUP BY region"));
const filtered = compileSemanticDataset(byRegion, [metric], [{ field: "region", kind: "select", value: "O'Reilly" }]).sql;
assert(filtered.includes("region='O''Reilly'"));
assert.equal(resolveSemanticDocument({ widgets: [bar], datasets: [], metrics: [] }, [metric]).metrics[0].id, "sales");
const normalizedTable = normalizeDashboard({ schemaVersion: 3, id: "d", widgets: [{ ...widget, type: "table", bindings: { ...widget.bindings, dimensions: ["day", "region", "store", "channel"], metricIds: Array.from({ length: 13 }, (_, i) => `m${i}`), secondaryMetricIds: ["secondary"] } }] });
assert.deepEqual(normalizedTable.widgets[0].bindings.dimensions, ["day", "region", "store", "channel"]);
assert.equal(normalizedTable.widgets[0].bindings.metricIds.length, 12);
assert.deepEqual(normalizedTable.widgets[0].bindings.secondaryMetricIds, []);
const normalizedLine = normalizeDashboard({ schemaVersion: 3, id: "l", widgets: [{ ...bar, type: "line", bindings: { ...bar.bindings, dimensions: ["day", "region"], seriesDimension: "store" } }] });
assert.deepEqual(normalizedLine.widgets[0].bindings.dimensions, ["day"]);
assert.equal(normalizedLine.widgets[0].bindings.seriesDimension, "store");
/* 组件筛选字段就是数据集里的维度名,名字由建数据集的人定,不再有白名单 ——
   以前写死成大区/主管/网点那几个,别的数据集建出来的组件一存就被清空。
   只挡掉不是字符串和空串的脏数据。 */
const normalizedComponentFilter = normalizeDashboard({ schemaVersion: 3, id: "f", widgets: [{ ...bar, filtersEnabled: true, filterFields: ["date", "region", "war_zone", "store", 7, "", null] }] });
assert.equal(normalizedComponentFilter.widgets[0].filtersEnabled, true);
assert.deepEqual(normalizedComponentFilter.widgets[0].filterFields, ["date", "region", "war_zone", "store"]);
const intersected = compileSemanticDataset(byRegion, [metric], [
  { field: "region", kind: "in", value: `华东${String.fromCharCode(1)}华北` },
  { field: "region", kind: "in", value: "华东" },
]).sql;
assert.equal((intersected.match(/region IN/g) ?? []).length, 2);
const multiPlan = { ...plan, dimensions: Object.fromEntries(["day", "region", "store", "channel"].map((name) => [name, { label: name, expression: name }])) };
const multiMetric = { ...metric, dimensions: ["day", "region", "store", "channel"], queryPlan: multiPlan };
const semanticTable = semanticDataset({ ...normalizedTable.widgets[0], bindings: { ...normalizedTable.widgets[0].bindings, metricIds: ["sales"], measures: ["sales"] } }, [multiMetric], scope);
assert.deepEqual(semanticTable.groupBy, ["day", "region", "store", "channel"]);
assert(compileSemanticDataset(semanticTable, [multiMetric]).sql.includes("GROUP BY day, region, store, channel"));
const origin = { ...normalizedTable.widgets[0], id: "origin", x: 0, y: 0, w: 2, h: 2 };
const rightCopy = placeWidgetNear({ ...origin, id: "copy-1" }, [origin], origin);
assert.deepEqual([rightCopy.x, rightCopy.y], [2, 0]);
const nextCopy = placeWidgetNear({ ...rightCopy, id: "copy-2" }, [origin, rightCopy], rightCopy);
assert.deepEqual([nextCopy.x, nextCopy.y], [4, 0]);
const belowCopy = placeWidgetNear({ ...origin, id: "copy-3" }, [origin, { ...origin, id: "right-blocker", x: 2 }], origin);
assert.deepEqual([belowCopy.x, belowCopy.y], [0, 2]);
const multiSortSql = buildDataQuery("mysql", "shop_ads", undefined, "ads_outlet_daily", {
  orderBy: [{ column: "stat_date", dir: "desc" }, { column: "store_id", dir: "asc" }],
  limit: 200,
  offset: 0,
});
assert(multiSortSql.includes("ORDER BY `stat_date` DESC, `store_id` ASC"));

// 看板改写层 —— 原来闭在 DashboardWorkspace 的 useState 里,搬成纯函数后才测得了。
const gmv = { id: "m1", key: "gmv", name: "销售额", type: "measure", enabled: true, connId: "c",
              database: "d", source: "t", expression: "SUM(amt)", dimensions: ["day", "store"], unit: "元", caliber: "" };
const d0 = dash.create({ title: "测试看板" });
assert.equal(d0.widgets.length, 0);
assert.equal(d0.status, "draft");

// 新建组件:数据源留空,由人在检查器里选 —— 数据集是全局的,猜一个塞进去会让图上
// 出现一份对不上的数,而且没人会想到去改它。
const k = dash.addWidget(d0, { type: "kpi", title: "KPI" });
const kpi = k.doc.widgets.find((w) => w.id === k.id);
assert.equal(kpi.datasetId, "", "新组件不预设数据集");
assert.deepEqual(kpi.bindings.measures, [], "也不预设度量");
assert.equal(kpi.bindings.dimension, undefined, "KPI 不该带分析维度");
// 指名数据集时就用它
const bound = dash.addWidget(d0, { type: "bar", title: "柱图", datasetId: "dataset-x" });
assert.equal(bound.doc.widgets.find((w) => w.id === bound.id).datasetId, "dataset-x");
const b = dash.addWidget(k.doc, { type: "bar", title: "柱图" });

// 放置避让:两个组件不能重叠
const [wa, wb] = b.doc.widgets;
assert(!(wa.x < wb.x + wb.w && wb.x < wa.x + wa.w && wa.y < wb.y + wb.h && wb.y < wa.y + wa.h), "新组件必须放到空位");

// 容器:子组件宽度收窄、不许嵌套容器
const c = dash.addWidget(b.doc, { type: "container", title: "Tab 容器" });
const tabId = c.doc.widgets.find((w) => w.id === c.id).tabs[0].id;
const child = dash.addWidget(c.doc, { type: "line", title: "折线", metric: gmv, parentId: c.id, tabId });
const childWidget = child.doc.widgets.find((w) => w.id === child.id);
assert.equal(childWidget.parentId, c.id);
assert(childWidget.w <= 6, "容器里的子组件最宽 6 栏");
assert.throws(() => dash.addWidget(c.doc, { type: "container", parentId: c.id, tabId }), /容器里不能再放容器/);

// 删容器连带删子组件
const afterDelete = dash.deleteWidget(child.doc, c.id);
assert(!afterDelete.widgets.some((w) => w.id === c.id || w.parentId === c.id), "删容器要连子组件一起删");

// 复制容器:子组件跟着复制并改挂到副本上
const dup = dash.duplicateWidget(child.doc, c.id, "副本");
const copies = dup.doc.widgets.filter((w) => w.parentId === dup.id);
assert.equal(copies.length, 1, "容器副本要带上子组件");
assert.notEqual(copies[0].id, child.id, "子组件副本要换新 id");
assert.equal(dup.doc.widgets.find((w) => w.id === dup.id).title, "副本");

// patchWidget:options 深合一层,不整个覆盖
const boundDoc = dash.patchWidget(b.doc, b.id, {
  bindings: { ...b.doc.widgets.find((w) => w.id === b.id).bindings, measures: ["amount"] },
});
const patched = dash.patchWidget(boundDoc, b.id, { title: "改名", options: { topN: 10 } });
const pw = patched.widgets.find((w) => w.id === b.id);
assert.equal(pw.title, "改名");
assert.equal(pw.options.topN, 10);
assert.equal(pw.options.decimals, 2, "没传的 options 字段要保留");
assert.deepEqual(pw.bindings.measures, ["amount"], "没传 bindings 就不动");
assert.throws(() => dash.patchWidget(b.doc, "不存在", {}), /组件不存在/);

// toggle / move
assert.equal(dash.toggleWidget(b.doc, b.id).widgets.find((w) => w.id === b.id).visible, false);
assert.equal(dash.moveWidget(b.doc, b.id, { x: 2 }).widgets.find((w) => w.id === b.id).x, 2);

// 筛选器:没有数据集要明确报错,而不是静默什么都不做
assert.throws(() => dash.addFilter(b.doc), /还没有数据集/);
const withDs = { ...b.doc, datasets: [{ id: "ds1", name: "d", sourceType: "sql", connectionId: "c", sql: "",
  fields: [{ name: "store", typeName: "", role: "dimension" }, { name: "gmv", typeName: "", role: "measure" }] }] };
const f = dash.addFilter(withDs);
const filter = f.doc.filters.find((x) => x.id === f.id);
assert.equal(filter.field, "store", "默认取第一个维度字段");
assert.equal(filter.scope, "global", "默认全局联动");
assert.equal(dash.deleteFilter(f.doc, f.id).filters.length, 0);
const noDim = { ...b.doc, datasets: [{ ...withDs.datasets[0], fields: [{ name: "gmv", typeName: "", role: "measure" }] }] };
assert.throws(() => dash.addFilter(noDim), /没有可筛选的维度/);

// 文档级
assert.equal(dash.setMeta(d0, { title: "新标题", refreshInterval: 60 }).refreshInterval, 60);
assert.equal(dash.setScope(d0, { start: "2026-08-01", end: "2026-08-31" }).metricScope.end, "2026-08-31");
assert.throws(() => dash.addTab(b.doc, b.id, "Tab 2"), /不是容器组件/);
assert.equal(dash.addTab(c.doc, c.id, "Tab 2").doc.widgets.find((w) => w.id === c.id).tabs.length, 2);

// 纯函数:改写不能动传进去的文档
assert.equal(d0.widgets.length, 0, "addWidget 不能改动传进去的文档");

// 维度取值匹配:命中多个时原样返回候选,绝不替用户挑一个
const zones = ["华东大区", "华东南区", "华北大区", "西北大区"];
assert.deepEqual(matchDimensionValue(zones, "华东大区"), ["华东大区"], "精确优先");
assert.deepEqual(matchDimensionValue(zones, "华东"), ["华东大区", "华东南区"], "前缀命中多个要都返回");
assert.deepEqual(matchDimensionValue(zones, "北大区"), ["华北大区", "西北大区"], "前缀不命中就退到包含匹配");
assert.deepEqual(matchDimensionValue(zones, "不存在"), []);
assert.deepEqual(matchDimensionValue(zones, "  "), []);

// 新增的组件字段必须活过一次存取归一化 —— refreshInterval 当初就是漏在这里,
// 存进文件后每次加载都被抹掉,设置形同虚设。
const rich = normalizeDashboard({
  schemaVersion: 3, id: "d1", title: "t", widgets: [{
    id: "w1", type: "bar", datasetId: "ds", title: "图",
    subtitle: "口径:含税", footnote: "数据截至昨日",
    bindings: { metricIds: ["m1"], measures: [], secondaryMetricIds: [], dimensions: ["day"] },
    options: {
      decimals: 2, showLegend: true, smooth: true, topN: 0, metrics: {},
      numberFormat: { scale: "wan", prefix: "¥", suffix: "万元" },
      chart: { axis: { yMin: 100, yMax: 900, yTitle: "元", xTitle: "日期", splitLine: true },
               tooltip: { mode: "item" }, markLine: [{ value: 500, label: "目标" }] },
    },
  }],
});
const rw = rich.widgets[0];
assert.equal(rw.subtitle, "口径:含税", "副标题要保留");
assert.equal(rw.footnote, "数据截至昨日", "脚注要保留");
assert.equal(rw.options.numberFormat.scale, "wan");
assert.equal(rw.options.numberFormat.prefix, "¥");
assert.equal(rw.options.chart.axis.yMin, 100);
assert.equal(rw.options.chart.axis.splitLine, true);
assert.equal(rw.options.chart.tooltip.mode, "item");
assert.deepEqual(rw.options.chart.markLine, [{ value: 500, label: "目标" }]);
assert.equal(rw.options.decimals, 2, "老字段不能被挤掉");

// 数字显示格式:在线端(scaledText)和离线导出端(standalone.runtime 的 scaled)
// 必须同语义,否则同一个看板在线看是「1,234.6 万元」,导出后变成「12,345,678 元」。
// 离线端是另一份手写实现,这几条断言就是防它漂。
assert.equal(scaledText(12345678, 1, "元", { scale: "wan" }), "1234.6万元");
assert.equal(scaledText(12345678, 2, "元", { scale: "yi" }), "0.12亿元");
assert.equal(scaledText(12345678, 0, "元"), "12345678元", "不配格式就原样");
assert.equal(scaledText(1234, 1, "元", { scale: "wan", suffix: "万" }), "0.1万", "suffix 填了就整个接管");
assert.equal(scaledText(1234, 0, "元", { scale: "none", prefix: "¥" }), "¥1234元");

// ── Phase 0:从 DashboardWorkspace 搬出来的三块,搬完得还能用 ──────
{
  // 导入一律当新草稿:换 id、标题加后缀、revision 归 1。
  // 不换 id 会让「导入」变成「覆盖同 id 的现有看板」—— 而且是静默覆盖。
  const src = { id: "dashboard-old", title: "经营日报", status: "published", revision: 7,
    widgets: [{ id: "w1" }], datasets: [], filters: [], metrics: [] };
  const { doc, from } = parseDashboardFile(JSON.stringify(src), "x.json");
  assert.equal(from, "json");
  assert.notEqual(doc.id, "dashboard-old", "导入必须换新 id,否则会静默覆盖同 id 的看板");
  assert.equal(doc.revision, 1);
  assert.equal(doc.status, "draft");
  assert.ok(doc.title.includes("导入"), doc.title);
  assert.equal(doc.widgets.length, 1, "组件不能在搬运途中丢");
  // 反向对照:不是看板的 JSON 要报错,不能生成一个空看板让人以为导成功了
  assert.throws(() => parseDashboardFile('{"foo":1}', "x.json"), /不是有效的看板/);

  // 运行时合并的优先级:下钻 > 筛选 > 基础
  const docRt = { datasets: [{ id: "d1", metricIds: ["m"], connectionId: "c", sql: "" }], widgets: [{ id: "w1", datasetId: "d1" }] };
  const merged = mergeCanvasRuntime(docRt, {
    runtime: { d1: { loading: false, tag: "base" } },
    filteredRuntime: { d1: { loading: false, tag: "filtered" } },
    drillRuntime: { d1: { loading: false, tag: "drill" } },
    componentRuntime: {},
    comparisonRuntime: {},
  }, () => ["有筛选"]);
  assert.equal(merged.d1.tag, "drill", "下钻的运行时要盖过筛选和基础");
  const noDrill = mergeCanvasRuntime(docRt, {
    runtime: { d1: { loading: false, tag: "base" } },
    filteredRuntime: { d1: { loading: false, tag: "filtered" } },
    drillRuntime: {}, componentRuntime: {}, comparisonRuntime: {},
  }, () => ["有筛选"]);
  assert.equal(noDrill.d1.tag, "filtered", "有生效筛选时不能拿没筛过的数据画图");
  const noFilter = mergeCanvasRuntime(docRt, {
    runtime: { d1: { loading: false, tag: "base" } },
    filteredRuntime: { d1: { loading: false, tag: "filtered" } },
    drillRuntime: {}, componentRuntime: {}, comparisonRuntime: {},
  }, () => []);
  assert.equal(noFilter.d1.tag, "base");
  // 组件级运行时要能盖住数据集级的
  const byWidget = mergeCanvasRuntime(docRt, {
    runtime: { d1: { loading: false, tag: "base" } }, filteredRuntime: {}, drillRuntime: {},
    componentRuntime: { w1: { loading: false, tag: "component" } }, comparisonRuntime: {},
  }, () => []);
  assert.equal(byWidget.w1.tag, "component");

  /* 下钻链是「从当前维度再往下钻到哪几层」,不包含当前这层。
     点中的那个值属于组件现在按什么分组(这里是 zone),不属于链里的任何一层 ——
     记错了的话筛选条件会挂到另一个字段上,数字全不对,而且不报错。 */
  assert.deepEqual(nextDrillPath(["a", "b"], [], "x", "zone"), [{ dimension: "zone", value: "x" }],
    "第一次点,筛的是当前分组维度");
  assert.deepEqual(nextDrillPath(["a", "b"], [{ dimension: "zone", value: "x" }], "y", "zone"),
    [{ dimension: "zone", value: "x" }, { dimension: "a", value: "y" }],
    "第二次点,筛的是链里的第一层");
  assert.equal(nextDrillPath(["a", "b"], [{ dimension: "zone", value: "x" }, { dimension: "a", value: "y" }], "z", "zone"), null,
    "两层链钻两次就到底了");
  assert.equal(nextDrillPath([], [], "x", "zone"), null, "没配下钻维度时点一下不该有反应");
}

// ── 8 个组件一起开火,别把连接池抽干 ──────────────────────────
// 真机:AI 建了个 8 组件的看板,一打开 8 条查询同时发。连接池 max=5,
// 5 条抢到连接(各自超时),剩下 3 条报「pool timed out while waiting for
// an open connection」—— 一个看着像数据库坏了、其实是我们自己挤死自己的错。
{
  let inFlight = 0;
  let peak = 0;
  const calls = [];
  const realInvoke = globalThis.__TAURI_INTERNALS__;
  // executeDataset 最终走 api.runReadOnlyQuery;非 Tauri 环境下它走 mock,
  // 这里直接替掉 mock 的底层实现来数并发。
  const { api } = m;
  const original = api.runReadOnlyQuery;
  api.runReadOnlyQuery = async (...args) => {
    inFlight++; peak = Math.max(peak, inFlight);
    calls.push(args[2]);
    await new Promise((r) => setTimeout(r, 25));
    inFlight--;
    return { columns: [{ name: "v" }], rows: [[1]], truncated: false };
  };
  const ds = (i) => ({ id: `d${i}`, name: "x", sourceType: "sql", connectionId: "c", sql: `SELECT ${i}`, fields: [] });
  await Promise.all(Array.from({ length: 8 }, (_, i) => executeDataset(ds(i), (k) => k, 100)));
  assert.equal(calls.length, 8, "八条都要跑到,不能被挡掉");
  assert.ok(peak <= 3, `同时在跑的最多 3 条,实测峰值 ${peak} —— 再多就会把 max=5 的连接池抽干`);
  assert.ok(peak > 1, `也别退化成一条条排队(那样 8 个组件要等 8 倍),实测峰值 ${peak}`);
  api.runReadOnlyQuery = original;
  void realInvoke;
}

// ── 同一条查询只跑一次 + 结果缓存 ───────────────────────────
// 真机:打开一个 8 组件看板要跑 8 条重查询;切一下筛选器再 8 条;开了同环比再翻倍;
// 而这之前 AI 刚把同样的数查过一遍。同一份数据来回查十几次,每次几十秒 —— 就是「慢」。
{
  const { api } = m;
  const original = api.runReadOnlyQuery;
  let hits = 0;
  api.runReadOnlyQuery = async () => {
    hits++;
    await new Promise((r) => setTimeout(r, 20));
    return { columns: [{ name: "v" }], rows: [[1]], truncated: false };
  };
  clearQueryCache();
  const ds = { id: "d1", name: "x", sourceType: "sql", connectionId: "c", sql: "SELECT 1", fields: [] };

  // 同时来 5 个一模一样的请求 → 只该发一次(看板打开时就是这种情形)
  await Promise.all(Array.from({ length: 5 }, () => executeDataset(ds, (k) => k, 100)));
  assert.equal(hits, 1, `在飞的同一条查询要合并,实测发了 ${hits} 次`);

  // 跑完之后再要,走缓存
  await executeDataset(ds, (k) => k, 100);
  assert.equal(hits, 1, "跑完的结果要缓存,不该再发请求");

  // 换个参数就是另一条查询,不能串味
  await executeDataset({ ...ds, sql: "SELECT 2" }, (k) => k, 100);
  assert.equal(hits, 2, "不同 SQL 必须各查各的");
  await executeDataset(ds, (k) => k, 200);
  assert.equal(hits, 3, "行数上限不同也是另一条查询");

  // 点「刷新」= 明确要最新的数,缓存必须让路
  clearQueryCache();
  await executeDataset(ds, (k) => k, 100);
  assert.equal(hits, 4, "清了缓存就得真去查 —— 否则点刷新等于没点");

  // 失败不缓存:一次超时不该让接下来五分钟全是同一个错
  clearQueryCache();
  api.runReadOnlyQuery = async () => { hits++; throw new Error("timed out"); };
  await assert.rejects(() => executeDataset(ds, (k) => k, 100));
  await assert.rejects(() => executeDataset(ds, (k) => k, 100));
  assert.equal(hits, 6, "两次失败要真的发两次请求");
  api.runReadOnlyQuery = original;
  clearQueryCache();
}

console.log("dashboard core: 语义编译、文档改写 / 归一化、导入、运行时合并与下钻、取数并发与缓存都对");
