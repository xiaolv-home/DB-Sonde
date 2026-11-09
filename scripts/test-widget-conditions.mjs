// 组件「条件」:维度按明细行筛(WHERE),度量带汇总方式按结果筛(HAVING)。
// 没填完的条件不能进 SQL —— 编辑到一半的那一条不该让卡片报错。
import assert from 'node:assert/strict';
import { loadSrc } from './lib/load-src.mjs';

const m = loadSrc('conditions', {
  'src/features/datasets/widgetQuery.ts': '{ buildWidgetSql, conditionSql, conditionReady }',
  'src/features/dashboard/resolveDatasets.ts': '{ widgetQueryOf }',
});

const dataset = {
  schemaVersion: 1, id: 'ds', name: 'sales', connectionId: 'c', source: { kind: 'sql', sql: 'SELECT * FROM sales' },
  fields: [
    { name: 'store', role: 'dimension', type: 'TEXT' },
    { name: 'amount', role: 'measure', type: 'REAL' },
    { name: 'gone', role: 'dimension', type: 'TEXT', hidden: true },
  ],
  updatedAt: '',
};
const q = (conditions) => m.buildWidgetSql(dataset, {
  dimensions: ['store'], measures: [{ field: 'amount', agg: 'sum' }], conditions,
}, 'mysql');

// 维度条件 → WHERE,多值 IN
let sql = q([{ field: 'store', op: 'in', values: ['A', 'B'] }]);
assert.match(sql, /WHERE `store` IN \('A', 'B'\)/);
assert.doesNotMatch(sql, /HAVING/);

// 不是:空值也算「不是」,否则 NULL 那几行静默消失
sql = q([{ field: 'store', op: 'not_in', values: ['A'] }]);
assert.match(sql, /\(`store` NOT IN \('A'\) OR `store` IS NULL\)/);

// 度量带汇总 → HAVING,数字按数字比
sql = q([{ field: 'amount', op: 'gt', values: ['10000'], agg: 'sum' }]);
assert.match(sql, /GROUP BY `store`\nHAVING SUM\(`amount`\) > 10000/);
assert.doesNotMatch(sql, /WHERE/);

// 明细行上的数值比较也写成数字字面量
sql = q([{ field: 'amount', op: 'between', values: ['1', '9'] }]);
assert.match(sql, /WHERE `amount` BETWEEN 1 AND 9/);

// 包含:各方言函数不同,取值仍走转义
assert.equal(m.conditionSql('postgres', '"s"', { field: 's', op: 'contains', values: ["o'k"] }), `POSITION(E'o''k' IN CAST("s" AS TEXT)) > 0`);
assert.equal(m.conditionSql('sqlite', '"s"', { field: 's', op: 'contains', values: ['x'] }), `INSTR("s", 'x') > 0`);

// 注入:取值里的引号被转义,不会断开字符串
sql = q([{ field: 'store', op: 'eq', values: ["x' OR 1=1 --"] }]);
assert.match(sql, /`store` = 'x'' OR 1=1 --'/);

// 没填完的不进 SQL
assert.equal(m.conditionReady({ field: 'store', op: 'in', values: [] }), false);
assert.equal(m.conditionReady({ field: 'store', op: 'between', values: ['1'] }), false);
assert.equal(m.conditionReady({ field: 'store', op: 'null', values: [] }), true);
sql = q([{ field: 'store', op: 'between', values: ['1', ''] }]);
assert.doesNotMatch(sql, /WHERE|HAVING/);

// 组件绑定 → 查询:引用了不保留字段的条件当它不存在
const widget = {
  id: 'w', type: 'bar', datasetId: 'ds', options: { topN: 0 },
  bindings: { dimensions: ['store'], measures: ['amount'], metricIds: [], secondaryMetricIds: [],
    conditions: [{ field: 'store', op: 'eq', values: ['A'] }, { field: 'gone', op: 'eq', values: ['x'] }] },
};
const query = m.widgetQueryOf(widget, dataset);
assert.deepEqual(query.conditions.map((c) => c.field), ['store']);

console.log('widget conditions: ok');
