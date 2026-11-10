// 看板工作台「替人想好」的那层:字段该进哪个区、换类型字段怎么跟过去、推荐什么图。
// 这些规则决定了点一下 / 拖一下的手感,改坏了不会报错,只会让人觉得「怎么又放错地方了」。
import assert from 'node:assert/strict';
import { loadSrc } from './lib/load-src.mjs';

const m = loadSrc('dashboard-smart', {
  'src/features/dashboard/studio/smart.ts': '*',
  'src/features/dashboard/domain.ts': '{ createWidget, isSummaryWidget, normalizeDashboard, WIDGET_TYPES }',
  'src/features/dashboard/widgetSpecs.ts': '{ WIDGET_SPECS, bindingProblem }',
  'src/features/dashboard/studio/catalog.ts': '{ ALL_KINDS, TYPE_META }',
  'src/features/dashboard/resolveDatasets.ts': '{ widgetQueryOf }',
});

const dataset = {
  schemaVersion: 1, id: 'ds', name: '销售', connectionId: 'c', source: { kind: 'sql', sql: 'SELECT 1' }, updatedAt: '',
  fields: [
    { name: 'sale_date', role: 'dimension', type: 'TEXT' },
    { name: 'store', role: 'dimension', type: 'TEXT' },
    { name: 'region', role: 'dimension', type: 'TEXT' },
    { name: 'store_id', role: 'dimension', type: 'INTEGER' },
    { name: 'amount', role: 'measure', type: 'REAL' },
    { name: 'qty', role: 'measure', type: 'INTEGER', defaultAgg: 'avg' },
  ],
};
const w = (type) => ({ ...m.createWidget(type, 'ds'), datasetId: 'ds' });

// 点字段:度量进数值,维度进横轴;横轴满了进拆分系列
let bar = m.toggleField(w('bar'), 'store', dataset);
bar = m.toggleField(bar, 'amount', dataset);
assert.deepEqual(m.shelfItems(bar, 'dimensions'), ['store']);
assert.deepEqual(m.shelfItems(bar, 'measures'), ['amount']);
bar = m.toggleField(bar, 'region', dataset);
assert.deepEqual(m.shelfItems(bar, 'series'), ['region'], '横轴满了,第二个维度该去拆分系列');
// 再点一次 = 拿掉
bar = m.toggleField(bar, 'region', dataset);
assert.deepEqual(m.shelfItems(bar, 'series'), []);

// 默认汇总:数据集里定的优先;维度当数值用默认去重计数
let kpi = m.toggleField(w('kpi'), 'qty', dataset);
assert.equal(kpi.bindings.aggregations.qty, 'avg');
kpi = m.toggleField(kpi, 'store', dataset);
assert.deepEqual(m.shelfItems(kpi, 'measures'), ['qty', 'store'], '指标卡上点维度 → 当计数');
assert.equal(kpi.bindings.aggregations.store, 'count_distinct');

// 时间维度放上去自动按日
const line = m.toggleField(w('line'), 'sale_date', dataset);
assert.equal(line.bindings.grains.sale_date, 'day');

// 表格:行和列互斥,拖进列就从行里拿走,并且变成交叉表
let table = m.addToShelf(w('table'), 'rows', 'store', dataset);
table = m.addToShelf(table, 'rows', 'region', dataset);
table = m.addToShelf(m.removeFromShelf(table, 'rows', 1, dataset), 'columns', 'region', dataset);
assert.deepEqual(m.shelfItems(table, 'rows'), ['store']);
assert.deepEqual(m.shelfItems(table, 'columns'), ['region']);
assert.equal(table.options.table.layout, 'pivot');

// 换类型:字段跟过去;折线图让时间当横轴
let mixed = m.addToShelf(m.addToShelf(w('bar'), 'dimensions', 'store', dataset), 'series', 'sale_date', dataset);
mixed = m.addToShelf(mixed, 'measures', 'amount', dataset);
const asLine = m.convertWidget(mixed, 'line', dataset);
assert.deepEqual(m.shelfItems(asLine, 'dimensions'), ['sale_date'], '折线图的横轴该是时间');
assert.deepEqual(m.shelfItems(asLine, 'series'), ['store']);
const asKpi = m.convertWidget(mixed, 'kpi', dataset);
assert.deepEqual(m.dimsOf(asKpi), [], '指标卡不分组');
assert.deepEqual(asKpi.bindings.measures, ['amount'], '换成指标卡数值不能丢');
const asPie = m.convertWidget(mixed, 'pie', dataset);
assert.equal(m.dimsOf(asPie).length, 1);

// 推荐:有时间先推折线;只有数值推指标卡
assert.equal(m.recommend(mixed, dataset)[0].type, 'line');
assert.equal(m.recommend(m.addToShelf(w('table'), 'measures', 'amount', dataset), dataset)[0].type, 'kpi');

// 往空白画布拖字段:数值 → 指标卡,时间 → 折线,其它维度 → 柱状(配上第一个数值)
assert.equal(m.widgetFromField(dataset, 'amount').type, 'kpi');
assert.equal(m.widgetFromField(dataset, 'sale_date').type, 'line');
const fromDim = m.widgetFromField(dataset, 'store');
assert.equal(fromDim.type, 'bar');
assert.deepEqual(fromDim.bindings.measures, ['amount']);

// 条件区:维度默认「是」,数值默认「大于」并按汇总后筛
let cond = m.addToShelf(w('bar'), 'conditions', 'store', dataset);
cond = m.addToShelf(cond, 'conditions', 'amount', dataset);
assert.deepEqual(cond.bindings.conditions.map((c) => [c.field, c.op, c.agg]), [['store', 'in', undefined], ['amount', 'gt', 'sum']]);

// 仪表盘 = 一个数值,不分组:点维度也只当计数放进数值;换过来时只留第一个数值
let gauge = m.toggleField(w('gauge'), 'amount', dataset);
gauge = m.toggleField(gauge, 'qty', dataset);
assert.deepEqual(m.shelfItems(gauge, 'measures'), ['qty'], '仪表盘只放一个数值,后点的替换前一个');
const fromBar = m.convertWidget(m.toggleField(m.toggleField(m.toggleField(w('bar'), 'store', dataset), 'amount', dataset), 'qty', dataset), 'gauge', dataset);
assert.deepEqual(m.dimsOf(fromBar), [], '换成仪表盘丢掉维度');
assert.deepEqual(fromBar.bindings.measures, ['amount']);
// 取数时仪表盘不分组 —— 哪怕老文档里带着维度
const legacy = { ...fromBar, bindings: { ...fromBar.bindings, dimensions: ['store'], dimension: 'store' } };
assert.deepEqual(m.widgetQueryOf(legacy, dataset).dimensions, [], '仪表盘取数不该分组');
assert.ok(m.isSummaryWidget('gauge') && !m.isSummaryWidget('funnel'));

// 漏斗跟饼图一样:一个环节维度 + 一个数值
const funnel = m.convertWidget(m.toggleField(m.toggleField(w('bar'), 'store', dataset), 'amount', dataset), 'funnel', dataset);
assert.deepEqual(m.shelvesOf('funnel'), ['dimensions', 'measures', 'conditions']);
assert.deepEqual(m.dimsOf(funnel), ['store']);
assert.equal(m.shelfTitle('funnel', 'dimensions'), '环节');

// 目录:一种类型只出现一次 —— 样式变体(面积、环形、条形…)不许再冒充新组件
assert.deepEqual([...m.ALL_KINDS.map((k) => k.type)].sort(), [...m.WIDGET_TYPES].sort(), '目录要恰好覆盖每种组件类型各一次');
for (const t of m.WIDGET_TYPES) assert.ok(m.TYPE_META[t]?.label, `${t} 没有名字`);

// 热力图:第二个维度去「纵轴」(series);矩形树图能放两层;散点最多三个数值
let heat = m.toggleField(m.toggleField(w('heatmap'), 'store', dataset), 'region', dataset);
assert.deepEqual(m.shelfItems(heat, 'dimensions'), ['store']);
assert.deepEqual(m.shelfItems(heat, 'series'), ['region'], '热力图第二个维度该进纵轴');
assert.equal(m.shelfTitle('heatmap', 'series'), '纵轴');
let tree = m.toggleField(m.toggleField(w('treemap'), 'region', dataset), 'store', dataset);
assert.deepEqual(m.shelfItems(tree, 'dimensions'), ['region', 'store'], '矩形树图两层');
assert.deepEqual(m.widgetQueryOf({ ...tree, bindings: { ...tree.bindings, measures: ['amount'] } }, dataset).dimensions, ['region', 'store']);
let sc = w('scatter');
for (const f of ['amount', 'qty', 'store_id']) sc = m.addToShelf(sc, 'measures', f, dataset);
assert.equal(m.shelfItems(sc, 'measures').length, 3);
// 换类型:柱状图(分类 + 系列)→ 热力图,系列变纵轴;→ 雷达图,只留一个维度
const barTwo = m.toggleField(m.toggleField(m.toggleField(w('bar'), 'store', dataset), 'region', dataset), 'amount', dataset);
const asHeat = m.convertWidget(barTwo, 'heatmap', dataset);
assert.deepEqual([m.dimsOf(asHeat), asHeat.bindings.seriesDimension], [['store'], 'region']);
assert.deepEqual(m.dimsOf(m.convertWidget(barTwo, 'radar', dataset)), ['store']);
// 排行榜默认前 10、雷达默认前 5
assert.equal(w('ranking').options.topN, 10);
assert.equal(w('radar').options.topN, 5);

// 组件说明书:每种组件都登记了;存盘按它留维度和拆分系列(热力图的纵轴存一次不能丢)
for (const type of m.WIDGET_TYPES) assert(m.WIDGET_SPECS[type]?.label, `${type} 没登记说明书`);
const saved = m.normalizeDashboard({ schemaVersion: 3, id: 'd', title: 't', widgets: [
  { id: 'h', type: 'heatmap', datasetId: 'ds', bindings: { dimensions: ['store'], seriesDimension: 'region', measures: ['amount'], metricIds: [], secondaryMetricIds: [] }, options: {} },
  { id: 's', type: 'scatter', datasetId: 'ds', bindings: { dimensions: ['store'], seriesDimension: 'region', measures: ['amount', 'qty'], metricIds: [], secondaryMetricIds: [] }, options: {} },
  { id: 'g', type: 'gauge', datasetId: 'ds', bindings: { dimensions: ['store'], seriesDimension: 'region', measures: ['amount'], metricIds: [], secondaryMetricIds: [] }, options: {} },
] });
assert.equal(saved.widgets[0].bindings.seriesDimension, 'region', '热力图的纵轴存一次就丢了');
assert.equal(saved.widgets[1].bindings.seriesDimension, 'region');
assert.equal(saved.widgets[2].bindings.seriesDimension, undefined, '仪表盘没有拆分系列');
assert.deepEqual(saved.widgets[2].bindings.dimensions, [], '仪表盘不分维度');
// 画不画得出来
assert.match(m.bindingProblem('scatter', { metrics: 1, dimensions: 1, series: false }), /散点图至少要 2 个指标/);
assert.match(m.bindingProblem('heatmap', { metrics: 1, dimensions: 1, series: false }), /seriesDimension/);
assert.match(m.bindingProblem('pie', { metrics: 2, dimensions: 1, series: false }), /只能放 1 个指标/);
assert.equal(m.bindingProblem('pie', { metrics: 3, dimensions: 0, series: false }), undefined, '不分维度时几个指标各占一块');
assert.equal(m.bindingProblem('line', { metrics: 2, dimensions: 1, series: true }), undefined);

console.log('dashboard smart: ok');
