// 数据集认字段:改了来源自动重认时,人调过的东西(显示名、维度度量、保留与否)和自己加的
// 计算 / 分组字段都不能丢 —— 编辑器改一下来源就会自动认一遍,丢了就是悄悄丢、一保存就没了。
import assert from 'node:assert/strict';
import { loadSrc } from './lib/load-src.mjs';

const m = loadSrc('dataset-probe', { 'src/features/datasets/service.ts': '{ probeFields }', 'src/features/datasets/domain.ts': '{ createDataset }' });
const calc = { name: '合计', label: '合计金额', expr: 'amount + quantity', role: 'measure' };
const group = { name: '档位', grouping: { source: 'amount', buckets: [{ label: '大单', values: ['100'] }], fallback: '其他' }, role: 'dimension' };

const join = { ...m.createDataset('t', 'demo'), source: { kind: 'join', base: { table: 'demo_sales', alias: 't1' }, joins: [], columns: [] } };
join.fields = [{ name: 'amount', column: 'amount', from: 't1', label: '销售额', role: 'measure', hidden: false, defaultAgg: 'avg' }, calc, group];
const out = await m.probeFields(join, 'sqlite');
assert.ok(out.find((f) => f.name === '合计' && f.expr === calc.expr && f.label === '合计金额'), '计算字段要原样留着');
assert.ok(out.find((f) => f.name === '档位' && f.grouping), '分组字段要原样留着');
const amount = out.find((f) => f.name === 'amount');
assert.deepEqual([amount.label, amount.defaultAgg], ['销售额', 'avg'], '调过的显示名、默认汇总留着');
assert.ok(out.find((f) => f.name === 'sale_date'), '表里新认出的列补上');

const sql = { ...m.createDataset('s', 'demo'), source: { kind: 'sql', sql: 'SELECT * FROM demo_sales' }, fields: [calc] };
const out2 = await m.probeFields(sql, 'sqlite');
assert.ok(out2.find((f) => f.name === '合计'), 'SQL 数据集重认字段也不能丢计算字段');
console.log('dataset probe: 重认字段保留显示名 / 汇总 / 计算字段 / 分组字段');
