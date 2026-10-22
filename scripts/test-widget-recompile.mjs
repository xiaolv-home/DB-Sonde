// 下钻、同环比、组件筛选器的日期,这三个功能界面上都在,在数据集模型下却一直是死的:
// 它们的做法都是改 dataset 上的 groupBy / metricScope 再跑一次,而数据集模型编译出来的
// sql 是个固定字符串 —— 不重编就完全没反应。开关点得响,数字永远不变。
// 这里盯住 executeDataset 会照着原料重编。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'sonde-recompile-'));
try {
  const outfile = join(dir, 'tests.cjs');
  await build({
    stdin: {
      contents: `
        export { createDatasetQueryRuntime } from './src/features/dashboard/queryRuntime';
        export { resolveWidgetDatasets } from './src/features/dashboard/resolveDatasets';
      `,
      resolveDir: resolve('.'), loader: 'ts',
    },
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  });
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const { createDatasetQueryRuntime, resolveWidgetDatasets } = createRequire(import.meta.url)(outfile);

  const sqls = [];
  const runtime = createDatasetQueryRuntime({
    readCatalog: () => [],
    dialectFor: () => 'mysql',
    readQuery: async (_id, _db, sql) => {
      sqls.push(sql);
      return { columns: [{ name: 'region', typeName: 'TEXT' }], rows: [['华东']], rowsAffected: null, truncated: false };
    },
  });
  const t = (key) => key;

  const dataset = {
    schemaVersion: 1, id: 'ds1', name: '销售', connectionId: 'c1', database: 'db',
    source: { kind: 'join', base: { table: 'sales', alias: 't1' }, joins: [], columns: [] },
    fields: [
      { name: 'sale_date', column: 'sale_date', from: 't1', role: 'dimension', type: 'DATE' },
      { name: 'region', column: 'region', from: 't1', role: 'dimension' },
      { name: 'store', column: 'store', from: 't1', role: 'dimension' },
      { name: 'amount', column: 'amount', from: 't1', role: 'measure' },
    ],
    updatedAt: '',
  };
  const widget = {
    id: 'w1', type: 'bar', title: '销售', datasetId: 'ds1', x: 0, y: 0, w: 6, h: 4, visible: true, tabs: [],
    bindings: { dimensions: ['sale_date'], grains: { sale_date: 'month' }, measures: ['amount'], aggregations: { amount: 'sum' }, metricIds: [], secondaryMetricIds: [] },
    options: { decimals: 2, showLegend: true, smooth: false, topN: 0, metrics: {}, chart: { drillDimensions: ['region', 'store'] } },
  };

  const [compiled] = resolveWidgetDatasets([widget], [dataset], () => 'mysql', { start: '2026-01-01', end: '2026-03-31' });
  assert(compiled.compiledFrom, '编译产物要带着重编的原料,否则下面几个功能没法换条件');
  // 只看 GROUP BY 那一行:内层子查询本来就把保留的列都 SELECT 出来了,
  // 拿整段 SQL 去匹配列名会一直命中,断言等于没写。
  const groupBy = (sql) => sql.split('\n').find((line) => line.startsWith('GROUP BY')) ?? '';
  assert(/sale_date/.test(groupBy(compiled.sql)), '基础查询按绑定的维度分组');
  assert(!/region/.test(groupBy(compiled.sql)), '下钻维度不该出现在基础查询的分组里');

  // 下钻:换一列分组。不重编的话跑的还是原来那句,图上找不到 region 这一列。
  await runtime.executeDataset({ ...compiled, groupBy: ['region'] }, t, 5000);
  const drilled = sqls.at(-1);
  assert(/region/.test(groupBy(drilled)), `下钻要按下钻维度分组: ${groupBy(drilled)}`);
  assert(!/sale_date/.test(groupBy(drilled)), '换了分组列,原来那列不该还在 GROUP BY 里');
  // 月粒度是给 sale_date 配的,换成 region 分组后不该把它套上去。
  assert(!/DATE_FORMAT/i.test(groupBy(drilled)), `换了分组列就别带着上一列的时间粒度: ${groupBy(drilled)}`);

  // 同环比 / 组件筛选器的日期:换一个日期窗口,而且要落在原始日期列上(索引还用得上)。
  await runtime.executeDataset({ ...compiled, metricScope: { start: '2025-01-01', end: '2025-03-31' } }, t, 5000);
  const shifted = sqls.at(-1);
  assert(/2025-01-01/.test(shifted) && /2025-04-01/.test(shifted), `日期窗口要换过去: ${shifted}`);
  assert(!/2026-01-01/.test(shifted), '别把原来的窗口留在里面');
  assert(/sale_date.*>=/is.test(shifted), '条件落在原始日期列上');

  // 每种条件是不同的一句 SQL,缓存不能把它们混成一份 —— 混了就是"同环比和本期一样"。
  assert.notEqual(drilled, shifted);
  assert.notEqual(drilled, compiled.sql);

  // 没有原料的(导入的 HTML、手写 SQL)照旧跑原来那句,别把它编崩。
  sqls.length = 0;
  const imported = { id: 'w9', name: '导入的', sourceType: 'sql', connectionId: 'c1', database: 'db', sql: 'SELECT region FROM baked', fields: [] };
  await runtime.executeDataset({ ...imported, groupBy: ['store'] }, t, 5000);
  assert.equal(sqls.at(-1), 'SELECT region FROM baked', '没有原料就原样跑,不是报错也不是空');

  // 下钻到第二层时,第一层选中的值是一个筛选条件。后端的做法是把它包在外面
  // (SELECT * FROM (你这句) WHERE product_id=...),可钻进去之后按日期分组,
  // product_id 根本不在输出里 —— 真库上报"没有这一列",mock 里静默不过滤。
  // 所以等值条件要编进 SQL 里面,过滤的是子查询,那儿所有保留的列都在。
  sqls.length = 0;
  const seen = [];
  const runtime2 = createDatasetQueryRuntime({
    readCatalog: () => [],
    dialectFor: () => 'mysql',
    readQuery: async (_id, _db, sql, _rows, filters) => {
      sqls.push(sql);
      seen.push(filters);
      return { columns: [{ name: 'sale_date', typeName: 'TEXT' }], rows: [], rowsAffected: null, truncated: false };
    },
  });
  await runtime2.executeDataset({ ...compiled, groupBy: ['sale_date'] }, t, 5000, [
    { field: 'region', kind: 'select', value: '华东' },
    { field: 'store', kind: 'in', value: `A${String.fromCharCode(1)}B` },
    { field: 'region', kind: 'text', value: '华' },
  ]);
  const inner = sqls.at(-1);
  assert(/WHERE[\s\S]*region/i.test(inner), `等值条件要落进 SQL: ${inner}`);
  assert(/'A', 'B'/.test(inner), `多选要展开成 IN: ${inner}`);
  assert.deepEqual(seen.at(-1).map((f) => f.kind), ['text'],
    '只有"包含"留给后端包在外面,等值的已经编进去了,再包一次就是双重条件');
  assert(!/'华'(?!东)/.test(inner), `"包含"不能被编成等值条件(那样只剩名字正好叫「华」的行): ${inner}`);

  // 存下来的下钻链可能指向一个后来被删掉、或者标成「不保留」的字段。按它编 SQL 就是
  // 引用一个不存在的列,整张卡片报错 —— 不如当没配这一层,照原来的维度出图。
  sqls.length = 0;
  const shrunk = { ...compiled, compiledFrom: { ...compiled.compiledFrom, dataset: { ...dataset, fields: dataset.fields.filter((f) => f.name !== 'region') } } };
  await runtime.executeDataset({ ...shrunk, groupBy: ['region'] }, t, 5000);
  const fallback = sqls.at(-1);
  assert(!/GROUP BY[\s\S]*region/i.test(fallback), `钻的那一列没了就别按它分组: ${fallback}`);
  assert(/sale_date/.test(fallback), '退回原来的维度,而不是报错或者空表');

  console.log('widget recompile: 18 assertions passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
