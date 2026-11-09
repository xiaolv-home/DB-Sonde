// 看板工作台「替人想好」的那层:字段该进哪个区、换类型字段怎么跟过去、推荐什么图。
// 这些规则决定了点一下 / 拖一下的手感,改坏了不会报错,只会让人觉得「怎么又放错地方了」。
import assert from 'node:assert/strict';
import { loadSrc } from './lib/load-src.mjs';

const m = loadSrc('dashboard-smart', {
  'src/features/dashboard/studio/smart.ts': '*',
  'src/features/dashboard/domain.ts': '{ createWidget }',
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

console.log('dashboard smart: ok');
