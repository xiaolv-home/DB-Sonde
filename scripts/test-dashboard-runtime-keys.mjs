// A widget's data is stored under the compiled query's id, and compiled queries
// only exist on the compiled document. Merging against the stored document —
// whose datasets are empty under the dataset model — yields an empty table and
// every widget sits on "运行数据集并绑定字段后显示" forever.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'sonde-runtime-keys-'));
try {
  const outfile = join(dir, 'tests.cjs');
  await build({
    stdin: {
      contents: `
        export { resolveWidgetDatasets, widgetQueryOf, datasetOf, reuseUnchanged } from './src/features/dashboard/resolveDatasets';
        export { mergeCanvasRuntime } from './src/features/dashboard/useDashboardRuntime';
        export { resolveWidgetMetrics } from './src/features/dashboard/metrics';
      `,
      resolveDir: resolve('.'), loader: 'ts',
    },
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  });
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const { resolveWidgetDatasets, widgetQueryOf, datasetOf, reuseUnchanged, mergeCanvasRuntime, resolveWidgetMetrics } = createRequire(import.meta.url)(outfile);

  const widget = {
    id: 'w1', type: 'line', title: '折线图', datasetId: 'ds1',
    x: 0, y: 0, w: 6, h: 4, visible: true, tabs: [],
    bindings: { dimensions: ['sale_date'], measures: ['amount'], aggregations: { amount: 'sum' }, metricIds: [], secondaryMetricIds: [] },
    options: { decimals: 2, showLegend: true, smooth: false, topN: 0, metrics: {} },
  };
  const dataset = {
    schemaVersion: 1, id: 'ds1', name: '销售', connectionId: 'c1', database: 'db',
    source: { kind: 'join', base: { table: 'sales', alias: 't1' }, joins: [], columns: [] },
    fields: [
      { name: 'sale_date', column: 'sale_date', from: 't1', role: 'dimension' },
      { name: 'amount', column: 'amount', from: 't1', role: 'measure' },
    ],
    updatedAt: '',
  };

  const compiled = resolveWidgetDatasets([widget], [dataset], () => 'mysql');
  assert.equal(compiled.length, 1, 'the widget compiles to one query');
  assert.equal(compiled[0].id, widget.id, 'stored under the widget id: two widgets can read one dataset differently');
  assert(compiled[0].sql.includes('GROUP BY'), `an aggregate query: ${compiled[0].sql}`);
  assert(compiled[0].connectionId, 'carries the connection, or the runtime skips it as not ready');

  const q = widgetQueryOf(widget);
  assert.deepEqual(q.dimensions, ['sale_date']);
  assert.deepEqual(q.measures, [{ field: 'amount', agg: 'sum' }]);

  const result = { columns: [{ name: 'sale_date' }, { name: 'amount' }], rows: [['2026-01-01', 10]] };
  const parts = {
    runtime: { [widget.id]: { loading: false, result } },
    filteredRuntime: {}, drillRuntime: {}, componentRuntime: {}, comparisonRuntime: {},
  };

  // Merging against the compiled document is what makes the data reachable.
  const merged = mergeCanvasRuntime({ widgets: [widget], datasets: compiled, filters: [] }, parts, () => []);
  assert(merged[widget.id]?.result, 'the widget finds its data');
  assert.equal(merged[widget.id].result.rows.length, 1);

  // The stored document carries no datasets under this model — merging against
  // it is the bug this test exists for.
  const empty = mergeCanvasRuntime({ widgets: [widget], datasets: [], filters: [] }, parts, () => []);
  assert.equal(empty[widget.id], undefined, 'the stored document cannot resolve a widget to its data');

  // datasetOf is the lookup every consumer shares. Getting it wrong is silent:
  // the canvas, the inspector and the export each fall back to "no dataset" and
  // the widget just looks unconfigured.
  assert.equal(datasetOf(widget, compiled)?.id, widget.id, 'a compiled query is found by the widget id');
  assert.equal(datasetOf(widget, []), undefined, 'nothing to find is not a crash');

  // An imported HTML dashboard carries its own datasets and points at them with
  // datasetId. Those documents have no global dataset to compile from, so the
  // datasetId path has to keep working or importing a dashboard shows nothing.
  const imported = [{ id: 'ds1', name: '导入的', sourceType: 'sql', connectionId: 'c1', database: 'db', sql: 'select 1', fields: [] }];
  assert.equal(datasetOf(widget, imported)?.name, '导入的', 'falls back to datasetId for imported documents');
  assert.equal(datasetOf(widget, [...compiled, ...imported])?.id, widget.id, 'the compiled query wins over the document copy');

  // Compiling must not throw the document's own datasets away — that is what an
  // imported or AI-generated dashboard runs on.
  const kept = resolveWidgetDatasets([widget], [], () => 'mysql', undefined, imported);
  assert.deepEqual(kept.map((d) => d.id), ['ds1'], 'uncompilable widgets keep the document dataset');
  const both = resolveWidgetDatasets([widget], [dataset], () => 'mysql', undefined, imported);
  assert.deepEqual(both.map((d) => d.id), ['w1', 'ds1'], 'compiled first, document copy behind it');

  // 图例和表头上写的名字得是数据集里改过的那个。数据集支持给字段改名,改完却只在
  // 数据集面板里生效,图上还是 amount —— 等于没改。
  const labelled = { ...dataset, fields: [dataset.fields[0], { ...dataset.fields[1], label: '销售额' }] };
  const withLabels = resolveWidgetDatasets([widget], [labelled], () => 'mysql');
  assert.equal(withLabels[0].dimensionLabels.amount, '销售额', 'the compiled query carries the renamed field');
  const named = resolveWidgetMetrics(widget, [], result.columns, withLabels[0].dimensionLabels);
  assert.equal(named[0].name, '销售额', 'the chart shows the renamed field, not the raw column');
  assert.equal(resolveWidgetMetrics(widget, [], result.columns)[0].name, 'amount', 'no rename falls back to the column name');

  // 图例维度只写进 bindings 是不够的:渲染层按列名去结果里找它,SQL 没查过这一列
  // 就找不着,退回"只有一条线" —— 界面上选了却没反应,还查不出哪儿错了。
  const withSeries = { ...widget, bindings: { ...widget.bindings, seriesDimension: 'war_zone' } };
  const seriesQuery = widgetQueryOf(withSeries);
  assert.deepEqual(seriesQuery.dimensions, ['sale_date', 'war_zone'], '图例维度要进 GROUP BY');
  const seriesDataset = { ...dataset, fields: [...dataset.fields, { name: 'war_zone', column: 'war_zone', from: 't1', role: 'dimension' }] };
  const seriesSql = resolveWidgetDatasets([withSeries], [seriesDataset], () => 'mysql')[0].sql;
  assert(/war_zone/.test(seriesSql), `编出来的 SQL 得真有这一列: ${seriesSql}`);

  // 分系列时别让 SQL 去 LIMIT:那是按行截断,Top 5 会变成"总共只剩 5 行",
  // 几条线各被砍掉一截。分类的 Top N 由渲染层按分类排完再切。
  const topWidget = { ...withSeries, type: 'bar', options: { ...widget.options, topN: 5 } };
  assert.equal(widgetQueryOf(topWidget).topN, 0, '分了系列就不按行截断');
  assert.equal(widgetQueryOf({ ...topWidget, bindings: { ...widget.bindings } }).topN, 5, '没分系列照常 Top N');

  // 数据集建好之后还能改:去掉一列、标成「不保留」。改完那列就不在子查询的 SELECT 里,
  // 而组件还绑着它 —— 编出来的 SQL 引用一个不存在的列,卡片上甩一句数据库报错。
  // 当它没绑更好:组件说「还没选维度/度量」,人一看就知道回去补。
  const trimmed = { ...dataset, fields: [dataset.fields[0], { ...dataset.fields[1], hidden: true }] };
  const trimmedQuery = widgetQueryOf(widget, trimmed);
  assert.deepEqual(trimmedQuery.measures, [], '数据集里不保留的列,绑定当它不存在');
  assert.deepEqual(trimmedQuery.dimensions, ['sale_date'], '还在的维度照常留着');
  const stale = resolveWidgetDatasets([widget], [trimmed], () => 'mysql')[0].sql;
  assert(!/SUM/i.test(stale), `别去 SUM 一个已经没有的列: ${stale}`);

  // 看板日期也一样:组件按 sale_date 分组,可它被标成不保留了 —— 日期条件得落在还在的那根时间列上。
  const hiddenDate = { ...dataset, fields: [{ ...dataset.fields[0], hidden: true }, dataset.fields[1], { name: 'biz_day', column: 'biz_day', from: 't1', role: 'dimension' }] };
  assert.equal(widgetQueryOf(widget, hiddenDate, { start: '2026-10-01', end: '2026-10-07' }).dateRange?.field, 'biz_day',
    '日期条件别落在不保留的列上,那是一句「没有这一列」');

  // 锁定范围也一样 —— 锁在一个已经没有的列上会让整个组件查不出来。
  const lockedWidget = { ...widget, options: { ...widget.options, lockedScope: { filters: { amount: ['1'] } } } };
  assert.deepEqual(widgetQueryOf(lockedWidget, trimmed).filters, [], '锁在没有的列上就忽略,别让整张卡片报错');

  // 指标卡带着维度查回来是多行,而卡片会把多行再聚合一次:求和还凑合,求平均就成了
  // 「平均数的平均数」—— 数字是错的,而且错得看不出来。
  const kpi = { ...widget, type: 'kpi', bindings: { ...widget.bindings, aggregations: { amount: 'avg' } } };
  assert.deepEqual(widgetQueryOf(kpi, dataset).dimensions, [], '指标卡不分组');
  const kpiSql = resolveWidgetDatasets([kpi], [dataset], () => 'mysql')[0].sql;
  assert(!/GROUP BY/i.test(kpiSql), `指标卡查回来就该是一行: ${kpiSql}`);
  assert(/AVG/i.test(kpiSql), '平均由数据库一次算完,不是前端拿分组结果再平均一遍');

  // 标成「不保留」的列不在子查询的 SELECT 里。编译产物要是照样把它列出来,
  // 它就会出现在下钻候选和锁定范围里 —— 选中就是一句「没有这一列」。
  const withHidden = { ...dataset, fields: [dataset.fields[0], { ...dataset.fields[1], hidden: true }] };
  const surface = resolveWidgetDatasets([widget], [withHidden], () => 'mysql')[0];
  assert.deepEqual(surface.fields.map((f) => f.name), ['sale_date'], '对外只暴露真能查的列');

  /* 下钻的结果按组件 id 覆盖基础运行时。回到第 0 层之后这份必须消失 ——
     留着的话画布优先用它(那是按下一层维度分组的),而渲染层已经回到当前维度,
     两边对不上,组件当场变成「请选择维度和指标」。「能钻下去、一返回就空」就是这么来的。 */
  const drilledResult = { columns: [{ name: 'region' }, { name: 'amount' }], rows: [['华东', 7]] };
  const atLevel1 = mergeCanvasRuntime({ widgets: [widget], datasets: compiled, filters: [] }, {
    ...parts, drillRuntime: { [widget.id]: { loading: false, result: drilledResult } },
  }, () => []);
  assert.equal(atLevel1[widget.id].result.columns[0].name, 'region', '钻进去时用下钻那份');

  const backToTop = mergeCanvasRuntime({ widgets: [widget], datasets: compiled, filters: [] }, {
    ...parts, drillRuntime: {},
  }, () => []);
  assert.equal(backToTop[widget.id].result.columns[0].name, 'sale_date', '返回之后回到基础那份,而不是空');

  // ── 变异测试补的:编译结果的复用、日期列的选择、时间轴上的指标排序 ──
  {
    const a = { id: 'w1', connectionId: 'c', database: 'db', sql: 'SELECT 1' };
    const b = { id: 'w2', connectionId: 'c', database: 'db', sql: 'SELECT 2' };
    const prev = [a, b];
    assert.strictEqual(reuseUnchanged(prev, [{ ...a }, { ...b }]), prev, '什么都没变:连数组都沿用');
    const changed = reuseUnchanged(prev, [{ ...a }, { ...b, sql: 'SELECT 3' }]);
    assert.notStrictEqual(changed, prev, 'SQL 变了就不能把旧的那份交回去 —— 那是一张不会更新的卡片');
    assert.strictEqual(changed[0], a, '没变的那个照旧沿用(下游的 memo 才命中)');
    assert.equal(changed[1].sql, 'SELECT 3');
    const fewer = reuseUnchanged(prev, [{ ...a }]);
    assert.notStrictEqual(fewer, prev, '少了一个组件也是变了');
    assert.deepEqual(fewer, [a]);
    const fresh = [{ ...a }];
    assert.strictEqual(reuseUnchanged([], fresh), fresh, '第一次没有可沿用的');
    const reordered = reuseUnchanged(prev, [{ ...b }, { ...a }]);
    assert.notStrictEqual(reordered, prev, '顺序换了也是新数组');
    assert.strictEqual(reordered[0], b);

    // 组件自己按某根时间列分组,数据日期就落在那根上(而不是数据集里排第一的时间列)
    const twoDates = { ...dataset, fields: [{ name: 'created_at', column: 'created_at', from: 't1', role: 'dimension' }, ...dataset.fields] };
    assert.equal(widgetQueryOf(widget, twoDates, { start: '2026-10-01', end: '2026-10-07' }).dateRange?.field, 'sale_date');
    // 组件按一个非时间的维度分组:日期条件不能落在这个维度上,要落在数据集的时间列上
    const byRegion = { ...widget, bindings: { ...widget.bindings, dimensions: ['region'] } };
    const regionDs = { ...dataset, fields: [...dataset.fields, { name: 'region', column: 'region', from: 't1', role: 'dimension' }] };
    assert.equal(widgetQueryOf(byRegion, regionDs, { start: '2026-10-01', end: '2026-10-07' }).dateRange?.field, 'sale_date');

    // 图表只要有一个维度是时间,就不按指标值排(会把时间轴打乱)
    const mixed = { ...widget, type: 'bar', bindings: { ...widget.bindings, dimensions: ['sale_date'], seriesDimension: 'region' },
      options: { ...widget.options, table: { metricSort: { key: 'field:amount', dir: 'desc' } } } };
    const withRegion = { ...dataset, fields: [...dataset.fields, { name: 'region', column: 'region', from: 't1', role: 'dimension' }] };
    assert.equal(widgetQueryOf(mixed, withRegion).orderBy, undefined, '时间轴 + 系列维度也不按指标排');
    assert.deepEqual(widgetQueryOf({ ...mixed, bindings: { ...mixed.bindings, dimensions: ['region'], seriesDimension: undefined } }, withRegion).orderBy,
      [{ name: 'amount', dir: 'desc', measure: true }], '分类轴不是时间就照排');
  }

  console.log('dashboard runtime keys: 33 assertions passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
