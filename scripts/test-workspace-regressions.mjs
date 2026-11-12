import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'sonde-workspace-regressions-'));
try {
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, [
    ['src/features/agent/analysisDraft.ts', '*'],
    ['src/features/agent/presentation.ts', '*'],
    ['src/features/agent/questionPlanner.ts', '*'],
    ['src/features/agent/evidenceLoop.ts', '*'],
    ['src/features/agent/workflow.ts', '{ runQuestionAnalysis }'],
    ['src/features/agent/model/analysisModels.ts', '*'],
    ['src/features/agent/model/structured.ts', '{ bindingFor, callStructured }'],
    ['src/features/ai/aiStore.ts', '{ useAi }'],
    ['src/features/dashboard/refineAnalysisDashboard.ts', '*'],
    ['src/features/dashboard/widgets/pieComposition.ts', '*'],
    ['src/features/agent/review.ts', '{ reviewLayout, applyFixes }'],
    ['src/features/agent/layout.ts', '{ packLayout }'],
    ['src/features/agent/factCalculator.ts', '*'],
    ['src/features/agent/dimensions.ts', '{ dimensionLabel }'],
    ['src/features/agent/period.ts', '*'],
    ['src/features/agent/validation/dataChecks.ts', '*'],
    ['src/features/agent/tools/dataTools.ts', '*'],
    ['src/features/agent/tools/dimensionProbe.ts', '*'],
    ['src/lib/api.ts', '{ api }'],
    ['src/store/appStore.ts', '{ useApp }'],
    ['src/features/agent/analysisStore.ts', '*'],
    ['src/features/agent/graph.ts', '*'],
    ['src/features/agent/state.ts', '*'],
    ['src/features/agent/nodes/index.ts', '*'],
    ['src/features/agent/tools/registry.ts', '*'],
    ['src/features/agent/tools/dashboardTools.ts', '*'],
    ['src/features/dashboard/semantic.ts', '*'],
    ['src/features/metrics/metricsStore.ts', '{ useMetrics }'],
  ].map(([file, names]) => `export ${names} from ${JSON.stringify(resolve(file))};`).join('\n'));
  const bundle = join(dir, 'tests.cjs');
  buildSync({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const storage = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k),
  } });
  const { requestedGroupCounts, designDataViews, layoutDesigner, evidenceExplorer, conclusionReviewer, questionRange, questionPlanner, runQuestionAnalysis, refineAnalysisLayout, refineAnalysisDashboard, pieComposition, analysisModelConfig, analysisModelProblems, bindingFor, callStructured, useAi, reviewLayout, applyFixes, packLayout, analysisProblems, normalizeAnalysisDraft, useAnalysis, useMetrics, Graph, END, createState,
    dashboardExecutor, dataValidator, getDraft, resolveSemanticDocument, compileSemanticDataset, resetTools, registerTool, callTool, computeFacts, dimensionLabel, buildQueryPlan, getPlan, checkDataset, expectedPoints, shiftRange, filterContext, api, useApp, fastDimensionValues } = createRequire(import.meta.url)(bundle);
  const analyze = state => computeFacts(state, getPlan, dimensionLabel);
  const metric = {
    id: 'sales', key: 'sales', name: '销售额', enabled: true, type: 'template', connId: 'fixture', database: 'retail', unit: '元',
    dimensions: ['day', 'region'], queryPlan: {
      kind: 'sql', dimensions: { day: { label: '日期', expression: 's.day' }, region: { label: '区域', expression: 's.region' } },
      sourceTables: ['orders'], template: 'SELECT {{select}}SUM(s.amount) AS value FROM orders s WHERE s.day BETWEEN {{start}} AND {{end}}{{filters}}{{groupBy}}',
    },
  };
  useMetrics.setState({ metrics: [metric] });
  const draft = { ...useAnalysis.getState().draft, metricIds: ['sales'], grain: 'day', dimensions: ['region'],
    start: '2026-08-01', end: '2026-08-31', filterValues: { region: ['华东', "O'Reilly"] } };
  assert.deepEqual(analysisProblems(draft, [metric]), []);
  for (const patch of [{ grain: 'week' }, { metricIds: ['deleted'] }, { start: '2026-02-30' },
    { filterValues: { old_region: ['华东'] } }, { dimensions: ['missing'] }]) {
    assert(analysisProblems({ ...draft, ...patch }, [metric]).length > 0, JSON.stringify(patch));
  }
  assert(analysisProblems({ ...draft, metricIds: ['sales', 'foreign'] }, [metric, { ...metric, id: 'foreign', connId: 'other' }]).length);
  const repaired = normalizeAnalysisDraft({ metricIds: null, dimensions: 'wrong', filterValues: { region: 'bad' }, wantsDashboard: 'false' }, draft);
  assert.deepEqual(repaired.metricIds, []);
  assert.deepEqual(repaired.dimensions, []);
  assert.deepEqual(repaired.filterValues, { region: [] });
  assert.equal(typeof repaired.wantsDashboard, 'boolean');

  // Use the real dashboard tools and semantic compiler: selecting two regions must survive save and SQL compilation.
  const designChart = {
    palette: ['#336699', '#66CC99'], lineArea: false, lineWidth: 4, smooth: false,
    barOrientation: 'vertical', barColor: '#336699', barEndColor: '#66CC99',
    pieHole: 42, pieLegendPosition: 'right', showLegend: false, dataZoom: true,
  };
  const result = await dashboardExecutor({ ...createState({ userRequest: '按区域分析', connId: 'fixture' }),
    scope: { dateRange: { start: draft.start, end: draft.end }, comparisonRanges: [], label: '8月', grain: 'day',
      filters: [{ field: 'region', values: draft.filterValues.region, resolvedFrom: '' }] },
    layout: { title: '筛选回归', palette: ['#123456', '#ABCDEF'], preset: 'ocean', items: [{ band: 'ranking', type: 'bar', title: '销售额', metricIds: ['sales'], dimensions: ['region'],
      x: 0, y: 0, w: 6, h: 4, reason: 'fixture', chart: designChart },
      { band: 'trend', type: 'line', title: '趋势', metricIds: ['sales'], dimensions: ['day'], x: 6, y: 0, w: 6, h: 4, reason: 'fixture' },
      { band: 'detail', type: 'text', title: '说明', metricIds: [], dimensions: [], content: '业务说明',
        x: 0, y: 4, w: 12, h: 2, reason: 'fixture', text: { fontSize: 18, fontWeight: 600, align: 'center', color: '#336699' } },
    ] },
  });
  const document = getDraft(result.dashboardId);
  assert.deepEqual(document.metricScope.filters, [{ field: 'region', kind: 'in', value: "华东\x01O'Reilly" }]);
  const styledBar = document.widgets.find(w => w.type === 'bar');
  const { showLegend, smooth, ...storedChart } = designChart;
  for (const [field, value] of Object.entries(storedChart)) assert.deepEqual(styledBar.options.chart[field], value, field);
  assert.equal(styledBar.options.showLegend, false, 'Renderer reads the legend switch from widget options');
  assert.equal(styledBar.options.smooth, false, 'Renderer reads smoothing from widget options');
  assert(!Object.hasOwn(styledBar.options.chart, 'smooth'));
  assert(!Object.hasOwn(styledBar.options.chart, 'showLegend'), 'Do not store an ignored chart-level switch');
  assert.deepEqual(document.widgets.find(w => w.type === 'line').options.chart.palette, ['#123456', '#ABCDEF']);
  assert.equal(document.widgets.find(w => w.type === 'text').options.text.fontSize, 18);
  assert.equal(styledBar.options.appearance.visualPreset, 'ocean');
  const savedDesign = (await api.listDashboards()).find(doc => doc.id === document.id);
  assert(savedDesign, 'The real executor must reach repository save');
  assert.deepEqual(savedDesign.widgets.find(w => w.type === 'bar').options.chart.palette, designChart.palette);
  const rejectedStyle = await callTool('style_component', { dashboardId: document.id, widgetId: styledBar.id, chart: { unknownStyle: true } });
  assert.equal(rejectedStyle.ok, false, 'Unknown fields must remain rejected');
  const legendOverride = await callTool('style_component', { dashboardId: document.id, widgetId: styledBar.id, showLegend: true, smooth: true, chart: { showLegend: false, smooth: false } });
  assert.equal(legendOverride.ok, true);
  assert.equal(getDraft(document.id).widgets.find(w => w.id === styledBar.id).options.showLegend, true, 'Explicit top-level legend setting wins');
  assert.equal(getDraft(document.id).widgets.find(w => w.id === styledBar.id).options.smooth, true);
  /* 组件现在从数据集取数,AI 不再预绑指标 —— 语义编译器本身还要单测,所以这里显式
     造一份指标绑定喂给它,而不是指望建组件时顺带产生。 */
  const semanticDoc = {
    ...document,
    widgets: document.widgets.map((w) => ({
      ...w,
      datasetId: `semantic:${w.id}`,
      bindings: { ...w.bindings, metricIds: [metric.id] },
    })),
  };
  const resolved = resolveSemanticDocument(semanticDoc, [metric]);
  const sql = compileSemanticDataset(resolved.datasets[0], [metric], [], 'mysql').sql;
  assert(sql.includes('华东') && sql.includes("O''Reilly"), sql);

  // Neutral composition layouts retain semantic bindings and the full pie denominator.
  const oldDocument = JSON.stringify(document);
  const sourceWithPie = { ...document, widgets: [...document.widgets, { ...styledBar, id: "saved-pie", datasetId: "semantic:saved-pie", type: "pie", options: { ...styledBar.options, topN: 5 } }] };
  const upgraded = refineAnalysisDashboard(sourceWithPie, [metric]);
  assert.equal(JSON.stringify(document), oldDocument, 'Optimizing is immutable and can be undone');
  assert.deepEqual(upgraded.metricScope, document.metricScope);
  assert(upgraded.widgets.some(w => w.id === styledBar.id && w.type === 'bar'), 'Original ranking keeps its ID');
  const composition = upgraded.widgets.find(w => w.type === 'pie');
  assert(composition && composition.id !== styledBar.id);
  assert.deepEqual(composition.bindings, styledBar.bindings);
  assert.equal(composition.options.chart.pieIncludeOthers, true);
  assert.equal(composition.options.topN, 0, 'Old pie optimization restores all groups');
  assert.equal(upgraded.widgets.length, sourceWithPie.widgets.length, 'No forced composition chart is added');
  assert.equal(upgraded.widgets.find(w => w.id === styledBar.id).options.appearance.visualPreset, 'ocean', 'Optimization must preserve the chosen design');
  assert.equal(upgraded.widgets.find(w => w.id === styledBar.id).options.chart.barEndColor, designChart.barEndColor);
  assert.equal(upgraded.widgets.find(w => w.id === styledBar.id).options.chart.barColor, designChart.barColor);
  assert(upgraded.widgets.some(w => w.type === 'text' && w.options.content === '业务说明'));
  const secondUpgrade = refineAnalysisDashboard(upgraded, [metric]);
  assert.deepEqual(secondUpgrade.widgets.map(w => w.id), upgraded.widgets.map(w => w.id), 'Repeated optimization creates no extra pie');
  const optimizedResolved = resolveSemanticDocument(upgraded, [metric]);
  const pieDataset = optimizedResolved.datasets.find(ds => ds.id === composition.datasetId);
  assert(pieDataset, 'The added pie must resolve to a semantic dataset');
  assert(compileSemanticDataset(pieDataset, [metric], [], 'mysql').sql.includes('华东'));
  for (let i = 0; i < upgraded.widgets.length; i++) for (const b of upgraded.widgets.slice(i + 1)) {
    const a = upgraded.widgets[i];
    assert(!(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y), 'No overlapping cards');
  }
  const values = [307, 284, 245, 240, 221, 1000, 900, 657].map((value, i) => ({ name: i === 0 ? '其他' : `主管${i}`, value }));
  const slices = pieComposition(values, 5);
  assert.equal(slices.length, 6);
  assert.equal(slices.reduce((sum, v) => sum + v.value, 0), 3854);
  assert.equal(slices.filter(v => v.isOther).length, 1);
  assert.equal(new Set(slices.map(v => v.name)).size, slices.length);
  /* 负数和缺失的分组剔掉,别让一个退款把整张饼作废 —— 原来是「有一个负的就整体返回空」,
     真实 GMV 里出现一两个负数太正常了,于是整张图变成一句看不懂的报错。 */
  assert.deepEqual(pieComposition([{ name: '负数', value: -1 }], 5), [], '全是负的就没得画');
  assert.deepEqual(pieComposition([{ name: '缺失', value: NaN }], 5), []);
  assert.deepEqual(
    pieComposition([{ name: '正常', value: 10 }, { name: '退款店', value: -3 }, { name: '零', value: 0 }], 5),
    [{ name: '正常', value: 10 }],
    '只剔掉不能画的那几个,能画的照画');
  const item = (patch = {}) => ({ type: 'bar', title: '测试', metricIds: ['sales'], dimensions: ['region'], band: 'ranking', reason: '测试', ...patch });
  const presentation = refineAnalysisLayout({ title: '测试', items: [item({ type: 'kpi', dimensions: [] }), item({ dimensions: [] }), item(), item({ type: 'pie', metricIds: ['rate'] }), item({ type: 'text', metricIds: [], dimensions: [], content: '结论' })] }, [{ metricId: 'sales', name: '销售额', rollup: 'sum' }, { metricId: 'rate', name: '差评率', rollup: 'avg' }]);
  assert(presentation.items.some(i => i.type === 'bar' && !i.dimensions.length), 'Let the critic judge the purpose of comparisons instead of silently removing them');
  // 用哪种图是设计 AI 的决定(它在提示词里看得到每个指标怎么汇总),后处理不再替它把饼图换成柱状
  assert(presentation.items.some(i => i.type === 'pie' && i.metricIds.includes('rate')), "The designer's chart choice is kept");
  const authoredDesign = { title: '业务概览', preset: 'slate', palette: ['#406C9E', '#4C9F8B'], items: [
    item({ type: 'kpi', dimensions: [], x: 0, y: 0, w: 4, h: 2, kpi: { valueSize: 44, labelPosition: 'above', contentAlign: 'center', showComparison: false }, appearance: { background: '#182837', borderColor: '#497586', shadow: true, titleColor: '#ACD7E2' } }),
    item({ type: 'line', dimensions: ['day'], x: 4, y: 0, w: 8, h: 4, chart: { lineArea: true, showLabels: false } }),
    item({ type: 'pie', x: 0, y: 2, w: 4, h: 4, chart: { pieHole: 62, pieShowLabels: false } }),
    item({ type: 'table', x: 4, y: 4, w: 4, h: 3 }), item({ type: 'table', x: 8, y: 4, w: 4, h: 3, title: '渠道明细' }),
  ] };
  const freeDesign = refineAnalysisLayout(authoredDesign, [{ metricId: 'sales', name: '销售额', rollup: 'sum' }]);
  assert.equal(freeDesign.preset, 'slate');
  const freeKpi = freeDesign.items.find(i => i.type === 'kpi');
  for (const [key, value] of Object.entries(authoredDesign.items[0].appearance)) assert.equal(freeKpi.appearance[key], value, key);
  assert.equal(freeDesign.items.filter(i => i.type === 'kpi').length, 1);
  assert.equal(freeDesign.items.filter(i => i.type === 'table').length, 2);
  assert.equal(freeDesign.items.find(i => i.type === 'line').chart.showLabels, false);
  const persistedDesign = await dashboardExecutor({ ...createState({ userRequest: '概览', connId: 'fixture' }), scope: { dateRange: { start: draft.start, end: draft.end }, comparisonRanges: [], filters: [], grain: 'day', label: '8月' }, layout: freeDesign });
  const authoredSaved = getDraft(persistedDesign.dashboardId);
  assert.equal(authoredSaved.widgets.filter(w => w.type === 'table').length, 2);
  assert.equal(authoredSaved.widgets.find(w => w.type === 'kpi').options.appearance.background, '#182837');
  assert.equal(authoredSaved.widgets.find(w => w.type === 'pie').options.chart.pieShowLabels, false);
  assert.equal(authoredSaved.widgets.find(w => w.type === 'kpi').options.kpi.valueSize, 44);
  assert.equal(authoredSaved.widgets.find(w => w.type === 'kpi').options.kpi.showComparison, false);
  const reviewContext = { validatedMetricIds: ['sales', 'rate'], ratioMetricIds: ['rate'], categoryCounts: { 0: 30 }, pointCounts: {}, timeDimensions: ['month'] };
  assert(!reviewLayout(packLayout([item({ type: 'pie', metricIds: ['rate'] })]), reviewContext).some(f => f.fix?.type), 'Review does not change chart types');
  const textItems = [item({ type: 'text', metricIds: [], dimensions: [], content: '结论一' }), item({ type: 'text', metricIds: [], dimensions: [], content: '结论二' })];
  const textFindings = reviewLayout(packLayout(textItems), reviewContext);
  const fixedTexts = applyFixes(textItems, textFindings, next => reviewLayout(packLayout(next), reviewContext));
  assert.equal(fixedTexts.items.filter(i => i.type === 'text').length, 2, 'Explanatory text must survive review');

  // Every AI step receives the chosen endpoint/model snapshot; checkpoints contain no credentials.
  const config = structuredClone(useAi.getState().config);
  config.cloud = { baseUrl: 'https://fixture.invalid/v1', model: 'cloud-default', apiKey: 'fixture-secret' };
  const frozen = analysisModelConfig(config, { provider: 'local', model: ' chosen-local ' });
  assert.equal(config.local.model, useAi.getState().config.local.model, 'Global preferences are unchanged');
  assert.deepEqual(analysisModelProblems(config, { provider: 'local', model: '' }, true).length, 3);
  assert.deepEqual(analysisModelProblems(config, { provider: 'local', model: 'chosen-local' }, true), []);
  assert.equal(normalizeAnalysisDraft({ modelChoice: { provider: 'invalid', model: 'x' } }, draft).modelChoice, undefined);
  config.local.model = 'changed-after-start';
  const originalFetch = globalThis.fetch;
  const modelRequests = [], checkpoints = [];
  globalThis.fetch = async (url, options) => {
    modelRequests.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
  };
  try {
    const graph = new Graph();
    const roles = ['reasoning', 'design', 'review'];
    roles.forEach((role, i) => {
      assert.equal(bindingFor(role, frozen).model, 'chosen-local');
      graph.addNode(role, async (_state, context) => {
        const response = await callStructured({ role, node: role, name: 'fixture', system: 'fixture', user: 'fixture', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }, context.modelConfig);
        assert.equal(response.ok, true);
        return {};
      }).addEdge(role, roles[i + 1] ?? END);
    });
    graph.setEntry(roles[0]);
    await graph.run(createState({ userRequest: 'fixture' }), { modelConfig: frozen, onCheckpoint: state => checkpoints.push(JSON.stringify(state)) });
    assert.equal(modelRequests.length, 3);
    assert(modelRequests.every(r => r.body.model === 'chosen-local' && r.url === `${frozen.local.baseUrl}/chat/completions` && !r.headers.Authorization));
    assert(checkpoints.length && checkpoints.every(s => !s.includes('fixture-secret') && !s.includes('apiKey')));
  } finally { globalThis.fetch = originalFetch; }

  // Exact ratio totals must come from the ungrouped metric query, not an average of group ratios.
  const ratio = { ...metric, id: 'ratio', key: 'ratio', name: '笔均金额', queryPlan: { ...metric.queryPlan,
    template: metric.queryPlan.template.replace('SUM(s.amount)', 'SUM(s.amount) / COUNT(s.amount)') } };
  useMetrics.setState({ metrics: [metric, ratio] });
  useApp.setState({ connections: [{ id: 'fixture', kind: 'mysql' }] });
  const range = { start: '2026-08-01', end: '2026-08-31' };
  const beforeRange = { start: '2026-07-01', end: '2026-07-31' };
  const primary = buildQueryPlan({ metricIds: ['ratio'], dimensions: ['region'], dateRange: range });
  const comparison = buildQueryPlan({ metricIds: ['ratio'], dimensions: ['region'], dateRange: beforeRange });
  const ratioField = primary.metrics[0].field;
  const qr = (names, rows, truncated = false) => ({ columns: names.map(name => ({ name, typeName: 'NUMBER' })), rows, truncated, elapsedMs: 0 });
  getPlan(primary.planId).result = qr(['region', ratioField], [['A', 100], ['B', 10]]);
  getPlan(comparison.planId).result = qr(['region', ratioField], [['A', 5], ['B', 5]]);
  const ratioState = { ...createState({ userRequest: 'test' }), plans: [
    { planId: primary.planId, role: 'primary', dateRange: range }, { planId: comparison.planId, role: 'mom', dateRange: beforeRange }] };
  /* 比率指标:**整体**结论必须来自不分组的那次查询(各组比率没法加权平均回去),
     但**分组**的值是 SQL 各自算准的,拿来互相比、比今昔都成立。
     所以这条按 computedBy 判而不是按 kind —— 分组同环比也是 mom kind,
     它属于「分组的精确值仍可用」那一类,不该被一起挡掉。 */
  const ratioFactsNoTotal = analyze(ratioState);
  assert(!ratioFactsNoTotal.some(f => /^(sum|count|avg|环比|同比|full_group_share)/.test(f.computedBy)),
    'Ungrouped ratio totals are required for overall claims');
  assert(ratioFactsNoTotal.some(f => f.computedBy === 'group_mom(' + ratioField + ' by region)'),
    'Per-group comparison stays available: each group ratio is exact');
  assert(ratioFactsNoTotal.some(f => f.kind === 'topn'), 'Exact group values remain usable');
  const totalQueries = [];
  api.runReadOnlyQuery = async (_conn, _db, sql) => {
    totalQueries.push(sql);
    return qr([ratioField], [[sql.includes('2026-07-01') ? 5 : 19]]);
  };
  const checkedRatios = await dataValidator(ratioState);
  assert.equal(checkedRatios.validation.status, 'pass');
  assert.equal(totalQueries.length, 2, 'Both primary and comparison totals must be queried');
  assert(totalQueries.every(sql => !/GROUP BY/i.test(sql)), totalQueries.join('\n'));
  const ratioFacts = analyze(ratioState);
  assert.equal(ratioFacts[0].rows[0][1], 19, 'Weighted overall ratio is 19, not the unweighted 55');
  assert.equal(ratioFacts.find(f => f.kind === 'mom').rows[0][3], 280);
  assert(!ratioFacts.some(f => f.kind === 'contribution'));
  assert(ratioFacts.some(f => f.kind === 'topn'), 'Exact SQL group ratios can be compared as values');
  /* 对比期的数据有问题 = 这一条对比不能用,不等于整件事不做。
     原来这儿断言的是整体 fail —— 于是一家去年还没开的店问「今年怎么样、跟去年比」,
     同比期查出来是空的,本期数据明明好好的,整个分析却停在「数据检查没有通过」。
     现在把这条对比摘掉、留个提醒、写进结论,剩下的照做。
     要守住的是「不能拿有问题的对比期算同环比」,不是「必须整个停掉」。 */
  getPlan(comparison.planId).result.truncated = true;
  const badComparison = await dataValidator(ratioState);
  assert.equal(badComparison.validation.status, 'warn', 'Only the comparison is unusable; the primary period is fine');
  assert(badComparison.validation.issues.some(i => i.message.startsWith('环比期：') && i.code === 'PLAN_DROPPED'));
  assert(badComparison.validation.issues.some(i => i.samples?.some(m => /TRUNCATED|截断/.test(m))), 'The original reason must survive');
  assert(!badComparison.plans.some(p => p.planId === comparison.planId), 'The bad comparison must not stay in play');
  assert(badComparison.dropped?.some(d => /环比期/.test(d)), 'What was dropped has to reach the report');
  // 摘掉之后就不该再算出环比 —— 否则等于拿残缺数据下结论
  assert(!analyze({ ...ratioState, plans: badComparison.plans }).some(f => f.kind === 'mom'),
    'A dropped comparison must not produce a comparison fact');
  const countPlan = buildQueryPlan({ metricIds: ['sales'], dimensions: [], dateRange: range });
  const countStored = getPlan(countPlan.planId);
  countStored.shape.metrics[0].rollup = 'count';
  countStored.result = qr([countPlan.metrics[0].field], [[4], [8]]);
  const countFacts = analyze({ ...createState({ userRequest: 'test' }), plans: [{ planId: countPlan.planId, role: 'primary', dateRange: range }] });
  assert.equal(countFacts[0].rows[0][1], 12, 'Counts already aggregated by SQL must be summed, not counted again');
  const shape = { dimensions: ['a', 'b'], metrics: [{ field: 'value', name: '测试', unit: '', rollup: 'sum' }] };
  assert(!checkDataset(qr(['a','b','value'], [['A / B','C',1],['A','B / C',2]]), shape).some(i => i.code === 'DUPLICATE_DIMENSIONS'));
  assert(checkDataset(qr(['a','value'], [['A',1]]), shape).some(i => i.code === 'MISSING_DIMENSION'));
  assert(checkDataset(qr(['a','b','value'], [['A','B',' '],['A','C',null]]), shape).some(i => i.code === 'ALL_NULL'));
  assert.equal(expectedPoints({ start: '2026-08-02', end: '2026-08-03' }, 'week'), 2);
  assert.deepEqual(shiftRange({ start: '2024-02-29', end: '2024-02-29' }, 'yoy'), { start: '2023-02-28', end: '2023-02-28' });
  // Same calendar result in a negative-offset zone and across a DST transition.
  const timezone = spawnSync(process.execPath, ['-e', `Object.defineProperty(globalThis,'localStorage',{value:{getItem:()=>null}});const assert=require('node:assert/strict');const{shiftRange}=require(${JSON.stringify(bundle)});assert.deepEqual(shiftRange({start:'2024-03-01',end:'2024-03-31'},'mom'),{start:'2024-02-01',end:'2024-02-29'});`], { env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8' });
  assert.equal(timezone.status, 0, timezone.stderr);
  assert(analysisProblems({ ...draft, filterContext: filterContext(['sales'], [metric]), metricIds: ['ratio'] }, [metric, ratio]).some(p => p.includes('来源已变化')));
  assert.throws(() => buildQueryPlan({ metricIds: ['sales'], dimensions: [], dateRange: range, filters: [{ field: 'missing', values: ['A'] }] }));
  let probeSql = '';
  api.runReadOnlyQuery = async (_conn, _db, sql) => { probeSql = sql; return qr(['region'], [["O'Reilly_100%"]]); };
  await fastDimensionValues(countStored.dataset, 'region', 301, "O'Reilly_100%");
  assert(probeSql.includes("O''Reilly!_100!%") && probeSql.includes("ESCAPE '!'"), probeSql);
  assert(probeSql.includes('LIMIT 301'));
  useMetrics.setState({ metrics: [metric] });

  // Cancellation during the final node must not become a successful result.
  const controller = new AbortController();
  let release;
  const graph = new Graph().addNode('Last', () => new Promise((resolve) => { release = resolve; })).setEntry('Last').addEdge('Last', END);
  const completion = graph.run(createState({ userRequest: 'test' }), { signal: controller.signal });
  controller.abort(); release({ report: 'stale' });
  const stopped = await completion;
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.report, undefined);

  // Natural language planning runs against the real catalog/compiler, with fixture model/data responses.
  const previousApi = api.runReadOnlyQuery, previousFetch = globalThis.fetch;
  const questionConfig = analysisModelConfig(useAi.getState().config, { provider: 'local', model: 'question-model' });
  const planFixture = { metricIds: ['sales'], dimensions: ['day', 'region'], period: { kind: 'last_n_days', count: 2, start: '', end: '' }, comparisons: [], filters: [], angle: '比较区域变化及整体趋势', assumptions: ['默认最近两个完整日'], questions: [], coverage: [{ area: '销售', metricIds: ['sales'], disposition: 'selected', reason: '本题关注销售变化' }] };
  const questionCalls = [], dataCalls = [];
  let planned = planFixture, investigationRound = 0, reviewRound = 0, qualityScenario = false, forceReject = false;
  useMetrics.setState({ metrics: [metric] });
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body); questionCalls.push(body);
    const name = body.response_format?.json_schema?.name;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(name === 'question_plan' ? planned : name === 'drill_decision' ? (qualityScenario && investigationRound++ === 0 ? { readings: [], thinking: '销售增加了,往下看笔均金额是否也变了', decision: 'drill', drills: [{ from: 'overview', question: '核对各区域笔均金额', metricIds: ['ratio'], focus: [{ field: 'region', values: ['A'] }], breakdown: 'region', compare: 'none' }], rootCause: '', gaps: ['还需要核对笔均金额'] } : { readings: [{ stepId: 'S1', reading: '笔均金额 19 元' }], thinking: '证据充分', decision: 'done', drills: [], rootCause: '销售增加主要来自单量', gaps: [] }) : name === 'conclusion_review' ? (forceReject || qualityScenario && reviewRound++ === 0 ? { verdict: 'revise', issues: ['说明比率口径，删除无依据的因果'] } : { verdict: 'pass', issues: [] }) : { summary: '根据本次问题重新分析', findings: [{ headline: '销售额合计 60 元', factId: 'F1', severity: 'info' }] }) } }] }), { status: 200 });
  };
  const salesField = buildQueryPlan({ metricIds: ['sales'], dimensions: [], dateRange: range }).metrics[0].field;
  api.runReadOnlyQuery = async (_conn, _db, sql) => {
    dataCalls.push(sql);
    if (sql.includes('SELECT DISTINCT')) return qr(['region'], [['华东大区'], ['华东南大区']]);
    const hasDay = /AS [`"]?day\b/i.test(sql), hasRegion = /AS [`"]?region\b/i.test(sql);
    return hasDay && hasRegion ? qr(['day', 'region', salesField], [['2026-09-12', 'A', 10], ['2026-09-13', 'A', 20], ['2026-09-12', 'B', 15], ['2026-09-13', 'B', 15]])
      : hasDay ? qr(['day', salesField], [['2026-09-12', 25], ['2026-09-13', 35]])
      : hasRegion ? qr(['region', salesField], [['A', 30], ['B', 30]]) : qr([salesField], [[60]]);
  };
  try {
    assert.deepEqual(questionRange({ kind: 'last_n_months', count: 3 }, '2026-09-14'), { start: '2026-06-01', end: '2026-08-31' });
    assert.deepEqual(questionRange({ kind: 'last_n_days', count: 2 }, '2024-03-01'), { start: '2024-02-28', end: '2024-02-29' });
    const auto = await runQuestionAnalysis('最近销售怎么样，看看区域变化', { connId: 'fixture', today: '2026-09-14', wantsDashboard: false, modelConfig: questionConfig });
    assert.equal(auto.status, 'done', JSON.stringify(auto.errors));
    assert.equal(auto.locked, false);
    assert.deepEqual(auto.lockedParams.dateRange, { start: '2026-09-12', end: '2026-09-13' });
    assert.equal(auto.supportingPlans.length, 2, 'Each axis receives its own exact SQL rollup');
    assert(auto.trace.includes('QuestionPlanner') && auto.trace.includes('AnalysisAgent'));
    assert(questionCalls.find(c => c.response_format?.json_schema?.name === 'analysis').messages[1].content.includes('按变化绝对值排序'), 'Analysis receives who changed, not only overall totals');
    assert(auto.plans.every(p => !getPlan(p.planId)), 'Workflow plans never enter the legacy global registry');
    assert(questionCalls.every(c => c.model === 'question-model'));
    const snapshotReads = dataCalls.length;
    let editedCatalog = false;
    const snapshotRun = await runQuestionAnalysis('核对运行期间目录修改', { connId: 'fixture', today: '2026-09-14', wantsDashboard: false, modelConfig: questionConfig,
      onStep: state => { if (!editedCatalog && state.currentNode === 'DataExecutor') { editedCatalog = true; useMetrics.setState({ metrics: [{ ...metric, expression: 'SUM(changed_during_analysis)' }] }); } } });
    assert.equal(snapshotRun.status, 'done', JSON.stringify(snapshotRun.errors));
    assert(editedCatalog); assert(dataCalls.slice(snapshotReads).every(sql => !sql.includes('changed_during_analysis')));
    useMetrics.setState({ metrics: [metric] });
    const readsBefore = dataCalls.length;
    await runQuestionAnalysis('这次重点看看区域差异', { connId: 'fixture', today: '2026-09-14', wantsDashboard: false, modelConfig: questionConfig, previous: auto });
    assert(dataCalls.length > readsBefore, 'Each new question refreshes actual queries instead of reusing last run cache');
    const followUpRequest = questionCalls.filter(c => c.response_format?.json_schema?.name === 'question_plan').pop();
    assert(followUpRequest.messages[0].content.includes('2026-09-12') && followUpRequest.messages[0].content.includes('最近销售怎么样'), 'Follow-up carries resolved scope and conversational context');
    planned = { ...planFixture, filters: [{ field: 'region', values: ['华东'] }] };
    const beforeAmbiguous = dataCalls.length;
    const ambiguous = await runQuestionAnalysis('华东的销售', { connId: 'fixture', today: '2026-09-14', wantsDashboard: false, modelConfig: questionConfig });
    assert.equal(ambiguous.status, 'needs_input');
    assert(ambiguous.clarification.includes('华东南大区'));
    assert(dataCalls.slice(beforeAmbiguous).every(sql => sql.includes('SELECT DISTINCT')), 'Ambiguity must stop before fact queries');
    assert.deepEqual(requestedGroupCounts('分析6大区域的经营', [{ id: 'region', label: '区域' }]), [{ field: 'region', label: '区域', count: 6 }]);
    assert.deepEqual(requestedGroupCounts('前5个区域排名', [{ id: 'region', label: '区域' }]), []);
    assert.equal(requestedGroupCounts('十二个区域', [{ id: 'region', label: '区域' }])[0].count, 12);
    planned = planFixture;
    const beforeCount = dataCalls.length;
    const mismatchedCount = await runQuestionAnalysis('6大区域经营分析', { connId: 'fixture', today: '2026-09-14', wantsDashboard: false, modelConfig: questionConfig });
    assert.equal(mismatchedCount.status, 'needs_input');
    assert(mismatchedCount.clarification.includes('当前可核对到2个'));
    assert(dataCalls.slice(beforeCount).every(sql => sql.includes('SELECT DISTINCT')), 'Explicit group count mismatch stops before business queries');
    const matchedCount = await runQuestionAnalysis('2个区域经营分析', { connId: 'fixture', today: '2026-09-14', wantsDashboard: false, modelConfig: questionConfig });
    assert.deepEqual(matchedCount.lockedParams.filters[0].values, ['华东大区', '华东南大区']);
    assert(Object.values(auto.datasets).some(d => d.columns.includes('day') && d.rowCount === 2));
    assert(Object.values(auto.datasets).some(d => d.columns.includes('region') && !d.columns.includes('day')));
    planned = { ...planFixture, metricIds: ['invented-id'] };
    const beforeInvalid = dataCalls.length;
    const invalid = await runQuestionAnalysis('不存在的指标', { connId: 'fixture', today: '2026-09-14', wantsDashboard: false, modelConfig: questionConfig });
    assert.equal(invalid.status, 'needs_input');
    assert.equal(dataCalls.length, beforeInvalid, 'Unknown IDs cannot reach the database');
    planned = { ...planFixture, filters: [{ field: 'region', values: ['A'] }] };
    qualityScenario = true;
    useMetrics.setState({ metrics: [metric, ratio] });
    api.runReadOnlyQuery = async (_conn, _db, sql) => {
      dataCalls.push(sql);
      if (sql.includes('SELECT DISTINCT')) return qr(['region'], [['A']]);
      const hasDay = /AS [`"]?day\b/i.test(sql), hasRegion = /AS [`"]?region\b/i.test(sql);
      const isRatio = sql.includes('COUNT(s.amount)'), field = isRatio ? ratioField : salesField;
      return hasDay && hasRegion ? qr(['day', 'region', field], [['2026-09-12', 'A', 25], ['2026-09-13', 'A', 35]])
        : hasDay ? qr(['day', field], [['2026-09-12', 25], ['2026-09-13', 35]])
        : hasRegion ? qr(['region', field], [['A', isRatio ? 19 : 60]]) : qr([field], [[isRatio ? 19 : 60]]);
    };
    const qualityReads = dataCalls.length;
    const investigated = await runQuestionAnalysis('只看A区域，销售增加是否笔均金额也变了', { connId: 'fixture', today: '2026-09-14', wantsDashboard: false, modelConfig: questionConfig });
    assert.equal(investigated.status, 'done', JSON.stringify(investigated.errors));
    assert(investigated.validatedMetrics.some(m => m.metricId === 'ratio'), 'The model can obtain new relevant evidence');
    assert(investigated.investigation.some(text => text.includes('下钻 S1')), JSON.stringify(investigated.investigation));
    assert.equal(investigated.drillSteps[0].reading, '笔均金额 19 元', 'The investigator reads each step before concluding');
    assert.equal(investigated.rootCause, '销售增加主要来自单量');
    assert.equal(investigated.trace.filter(n => n === 'AnalysisAgent').length, 2, 'A failed independent review returns to the writer');
    assert.equal(investigated.conclusionReview.verdict, 'pass');
    assert(dataCalls.slice(qualityReads).filter(sql => !sql.includes('SELECT DISTINCT')).every(sql => sql.includes("'A'")), 'Supplementary evidence inherits the verified filter');
    forceReject = true; qualityScenario = false;
    const rejected = await runQuestionAnalysis('同一范围再分析', { connId: 'fixture', today: '2026-09-14', wantsDashboard: false, modelConfig: questionConfig, previous: investigated });
    /* 复核没过要守住的是两件事:标成未完成、不许生成看板。
       草稿本身留着 —— 原来这儿把 analysisSummary/insights 全清空,于是跑了几分钟、
       烧了一堆 token 之后界面上只剩一行「结论复核仍未通过」,连查到了什么都看不到。
       那些 insight 每条都带 factId、数字是代码算的;复核意见在界面上就压在结论正上方。 */
    assert.equal(rejected.status, 'failed');
    assert.equal(rejected.dashboardId, undefined, 'Unreviewed claims cannot create a dashboard');
    assert.equal(rejected.conclusionReview.verdict, 'revise', 'The verdict has to stay on the state so the UI can caveat the draft');
    assert(rejected.analysisSummary, 'The draft survives so the run is not a total loss');
    assert(rejected.errors.some(e => e.node === 'ConclusionReviewer'), 'Why it was rejected must be recorded');
    forceReject = false;
    const originalDesign = { title: '按问题设计', palette: ['#234567', '#456789'], items: [item({ type: 'pie', topN: 0, x: 0, y: 0, w: 8, h: 7 }), item({ type: 'kpi', dimensions: [], x: 8, y: 0, w: 4, h: 3 })] };
    const preserved = refineAnalysisLayout(originalDesign, [{ metricId: 'sales', name: '销售额', rollup: 'sum' }]);
    assert.equal(preserved.items[0].type, 'pie'); assert.equal(preserved.items[0].w, 8); assert.equal(preserved.items[0].topN, 0);
    assert.deepEqual(preserved.palette, originalDesign.palette);
    assert.equal(pieComposition(values, 0).length, values.length, 'All categories remain separate unless N was requested');
    const explicitN = refineAnalysisLayout({ ...originalDesign, items: [item({ type: 'pie', topN: 12 })] }, [{ metricId: 'sales', name: '销售额', rollup: 'sum' }]);
    assert.equal(explicitN.items[0].topN, 12, 'An explicit N is never clamped to five or seven');
  } finally { api.runReadOnlyQuery = previousApi; globalThis.fetch = previousFetch; }

  // A stop while awaiting the database retains the busy guard until the old request settles.
  resetTools();
  let starts = 0, releaseQuery, queryStarted;
  const started = new Promise((resolve) => { queryStarted = resolve; });
  const stoppedApi = api.runReadOnlyQuery;
  api.runReadOnlyQuery = async () => { starts++; queryStarted(); return new Promise(resolve => { releaseQuery = resolve; }); };
  useAnalysis.getState().patch({ ...draft, mode: "manual", wantsDashboard: false, mom: false, yoy: false });
  useAi.setState({ config: { ...useAi.getState().config, provider: 'local', local: { baseUrl: 'http://fixture.invalid/v1', model: 'fixture-model' } } });
  const running = useAnalysis.getState().start('fixture');
  await Promise.race([started, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Fixture query did not start')), 5000); timer.unref(); })]);
  useAnalysis.getState().stop();
  assert.equal(useAnalysis.getState().running, true);
  assert.equal(useAnalysis.getState().stopping, true);
  useAnalysis.getState().patch({ focus: 'must not change a running request' });
  assert.equal(useAnalysis.getState().draft.focus, draft.focus);
  await useAnalysis.getState().start('fixture');
  assert.equal(starts, 1);
  releaseQuery(qr(['value'], [[1]]));
  await running;
  api.runReadOnlyQuery = stoppedApi;
  assert.equal(useAnalysis.getState().run.status, 'cancelled');
  assert.equal(useAnalysis.getState().running, false);
  assert.equal(useAnalysis.getState().stopping, false);

  // The installer is a zsh script. Without zsh, spawnSync('/bin/zsh') returns status null
  // and the assertions below cannot run. Skip that block instead of failing the suite.
  const zshOnPath = () => {
    const found = spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' });
    const path = (found.stdout || '').trim();
    return path && existsSync(path) ? path : null;
  };
  const zsh = ['/bin/zsh', '/usr/bin/zsh'].find((path) => existsSync(path)) ?? zshOnPath();
  if (!zsh) console.log('skipped: zsh not found');
  else {
    // Run the actual installer with harmless command doubles, blocking both before build and before installation.
    const project = join(dir, 'project'), bin = join(dir, 'bin');
    mkdirSync(join(project, 'scripts'), { recursive: true });
    mkdirSync(join(project, 'src-tauri/target/release/bundle/macos/DB Sonde.app'), { recursive: true });
    mkdirSync(bin);
    const script = join(project, 'scripts/install-local.zsh');
    writeFileSync(script, readFileSync('scripts/install-local.zsh'));
    for (const name of ['cargo', 'npm', 'codesign', 'ditto', 'mv', 'osascript', 'killall']) {
      writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> "$TEST_LOG"\n`, { mode: 0o755 });
    }
    writeFileSync(join(bin, 'security'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(bin, 'pgrep'), '#!/bin/sh\nn=0; [ ! -f "$TEST_COUNT" ] || n=$(cat "$TEST_COUNT"); n=$((n+1)); echo "$n" > "$TEST_COUNT"; [ "$n" -ge "$TEST_BLOCK_AT" ]\n', { mode: 0o755 });
    for (const blockAt of [1, 2, 3]) {
      const log = join(dir, `commands-${blockAt}`), count = join(dir, `count-${blockAt}`);
      writeFileSync(log, '');
      const check = spawnSync(zsh, [script], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
        TEST_LOG: log, TEST_COUNT: count, TEST_BLOCK_AT: String(blockAt) } });
      assert.equal(check.status, 1, check.stderr);
      assert(check.stderr.includes('Save your work and quit'));
      const commands = readFileSync(log, 'utf8');
      assert(!/ditto|mv|osascript|killall/.test(commands), commands);
      assert.equal(commands.includes('cargo'), blockAt > 1);
    }
  }
  console.log('Workspace regressions passed: autonomous planning and follow-up, evidence supplementation within scope, independent conclusion review with bounded rewriting and rejection, full-category charts without forced Top5, model-designed layout preserved; explicit AI model selection for all three steps, immutable run configuration and credential-free checkpoints, neutral layouts, additive pie composition with full denominator, old board optimization preserving IDs and scope; complete design styles through real tool validation and repository save, palette fallback, legend and smoothing normalization, unknown style rejection; exact ratio totals, aggregated counts, comparison validation, calendar weeks and leap days across time zones, dimension collision checks, null handling, filter provenance and search escaping; invalid selections/dates, stored draft types, dashboard filter preservation through SQL, cancellation without stale completion, no overlapping analysis, installer refuses live apps before build and before replacement.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
