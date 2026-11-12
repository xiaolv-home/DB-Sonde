import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const dir = mkdtempSync(join(tmpdir(), 'sonde-exploration-'));
const later = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const response = data => ({ ok: true, data, ms: 1, promptTokens: 2, completionTokens: 3 });
const ok = data => ({ ok: true, data, audit: { tool: 'fixture', ms: 1 } });
try {
  const outfile = join(dir, 'tests.cjs');
  const build = buildSync({ stdin: { contents: ['questionPlanning', 'evidenceExploration', 'drillInvestigator', 'queryPlanModel', 'analysisCatalog'].map(name => `export * from './src/features/agent/${name}';`).join('\n'), resolveDir: resolve('.'), loader: 'ts' }, outfile,
    bundle: true, platform: 'node', format: 'cjs', metafile: true, logLevel: 'silent' });
  assert(!Object.keys(build.metafile.inputs).some(file => /Store\.ts|\/registry.ts|model\/structured|@tauri|react|zustand/.test(file)));
  const m = createRequire(import.meta.url)(outfile);
  const dateRange = { start: '2026-08-01', end: '2026-08-31' };
  const base = { id: 'sales', key: 'sales', name: 'Sales', connId: 'A', database: 'mart', enabled: true, type: 'measure', aggregation: 'sum', expression: 'amount', source: 'events', unit: '$', caliber: 'SUM(amount)', category: 'Business', aliases: [], dimensions: ['month', 'region'], dimensionLabels: { region: 'Region A' } };
  let catalog = [{ ...base, connId: 'B', id: 'foreign', dimensionLabels: { region: 'Foreign Region' } }, base, { ...base, id: 'stock', key: 'stock', name: 'Inventory' }];
  const state = { workflowId: 'test-run', connId: 'A', today: '2026-09-15', userRequest: 'Analyze business', status: 'running', usage: [], errors: [], trace: [], retry: {},
    requirement: { wantsDashboard: true }, validatedMetrics: m.validatedMetricsFor(['sales'], catalog),
    scope: { dateRange, comparisonRanges: [], grain: 'month', label: 'August', filters: [{ field: 'region', values: ['East'], resolvedFrom: 'East' }] },
    plans: [{ planId: 'primary', role: 'primary', dateRange }], supportingPlans: [] };
  const questionPlan = { metricIds: ['sales'], dimensions: ['month'], period: { kind: 'explicit', ...dateRange, count: 1 }, comparisons: [], filters: [{ field: 'region', values: ['East'] }], angle: 'Inspect', assumptions: [], questions: [], coverage: [] };
  const input = { metricIds: ['sales'], dimensions: ['month'], dateRange, filters: state.scope.filters };
  const originalInput = structuredClone(input), originalCatalog = structuredClone(catalog);
  const prepared = m.prepareQueryPlan(input, catalog);
  assert.equal(prepared.dataset.connectionId, 'A'); assert.equal(prepared.shape.grain, 'month'); assert(!('planId' in prepared));
  assert.deepEqual(input, originalInput); assert.deepEqual(catalog, originalCatalog);
  for (const bad of [{ metricIds: ['foreign', 'sales'] }, { metricIds: [] }, { dimensions: ['missing'] }, { filters: [{ field: 'missing', values: ['x'] }] }, { dateRange: { start: '2026-02-30', end: '2026-03-01' } }]) {
    assert.throws(() => m.prepareQueryPlan({ ...input, ...bad }, catalog));
  }
  assert.throws(() => m.prepareQueryPlan({ ...input, metricIds: ['sales', 'other-db'] }, [...catalog, { ...base, id: 'other-db', database: 'elsewhere' }]));
  const modelCalls = [], probes = [], config = { model: 'chosen' };
  const question = m.createQuestionPlanner({ readCatalog: () => catalog, callStructured: async (call, cfg) => { modelCalls.push({ call, cfg }); return response(questionPlan); },
    dimensionValues: async (dataset, field, limit, search, snapshot) => { probes.push({ dataset, field, limit, search, snapshot }); return ['East']; } });
  const planned = await question(state, { modelConfig: config });
  assert.equal(planned.lockedParams.filters[0].values[0], 'East'); assert.equal(modelCalls[0].cfg, config);
  assert(!modelCalls[0].call.system.includes('Foreign Region')); assert(modelCalls[0].call.system.includes('Region A'));
  assert.equal(probes[0].dataset.connectionId, 'A'); assert.notEqual(probes[0].snapshot, catalog);
  assert.deepEqual(questionPlan.filters, [{ field: 'region', values: ['East'] }]);
  /* 同一个问题不许问第二遍。真机:用户答完了它又原样问一遍,
     再抛回去只会无限循环 —— 用户已经没有别的话可说了。
     schema 里 metricIds/filters/period 都是必填,所以**抛问题时计划其实是完整的**:
     与其空转,不如照这份计划往下走,把没答上的问题如实记进"尚未满足的要求"。 */
  {
    const asking = { ...questionPlan, questions: ['“华东大区”在 outlet_region 下的准确名称是什么？'] };
    const planner = m.createQuestionPlanner({ readCatalog: () => catalog, callStructured: async () => response(asking), dimensionValues: async () => ['East'] });

    // 第一次问:正常抛给用户
    const first = await planner(state, {});
    assert.equal(first.status, 'needs_input');
    assert.equal(first.clarification, asking.questions[0]);
    assert.equal(first.lockedParams, undefined, '第一次要停下来问,不许自作主张往下走');

    // 用户答完之后又原样问一遍 → 不再抛回去,照计划走,并如实记下没问清
    const answered = { ...state, userRequest: 'outlet_region 每个渠道',
      conversation: [{ role: 'user', content: 'Analyze business' }, { role: 'assistant', content: asking.questions[0] }] };
    const second = await planner(answered, {});
    assert.notEqual(second.status, 'needs_input', '同一个问题问第二遍 = 死循环,必须往下走');
    assert.ok(second.lockedParams, '要用它自己给的那份完整计划');
    assert.ok(second.dropped?.some((text) => text.includes('问过一遍没能问清')),
      '擅自往下走了就得说出来,不能装作问清楚了：' + JSON.stringify(second.dropped));

    // 换了个新问题就还是要问 —— 防循环不等于从此不许提问
    const other = { ...asking, questions: ['另一个完全不同的问题？'] };
    const again = m.createQuestionPlanner({ readCatalog: () => catalog, callStructured: async () => response(other), dimensionValues: async () => ['East'] });
    assert.equal((await again(answered, {})).status, 'needs_input', '没问过的问题当然还要问');
  }

  const ambiguous = m.createQuestionPlanner({ readCatalog: () => catalog, callStructured: async () => response(questionPlan), dimensionValues: async () => ['East One', 'East Two'] });
  assert.equal((await ambiguous(state)).status, 'needs_input');
  // A suspended node holds its own catalog, even if a host edits its catalog objects later.
  const waiting = later(), started = later();
  const snapshotQuestion = m.createQuestionPlanner({ readCatalog: () => catalog, callStructured: async () => { started.resolve(); return waiting.promise; },
    dimensionValues: async (_dataset, _field, _limit, _search, snapshot) => { assert.equal(snapshot.find(x => x.id === 'sales').database, 'mart'); return ['East']; } });
  const active = snapshotQuestion(state); await started.promise; base.database = 'changed'; waiting.resolve(response(questionPlan));
  assert.equal((await active).validatedMetrics[0].metricId, 'sales'); base.database = 'mart';
  for (const target of ['model', 'probe']) {
    const wait = later(), start = later(), controller = new AbortController(); let requests = 0;
    const node = m.createQuestionPlanner({ readCatalog: () => catalog,
      callStructured: async () => { requests++; if (target === 'model') { start.resolve(); return wait.promise; } return response(questionPlan); },
      dimensionValues: async () => { start.resolve(); return wait.promise; } });
    const run = node(state, { signal: controller.signal }); await start.promise; controller.abort(); wait.resolve(target === 'model' ? response(questionPlan) : ['East']);
    await assert.rejects(run, error => error.name === 'AbortError'); assert.equal(requests, 1, 'cancellation must not become clarification or start a model repair');
  }
  const observed = (metricIds, dims = []) => ({ metricIds, shape: { dimensions: dims, metrics: metricIds.map(id => ({ field: id, name: id, unit: '$', rollup: 'sum' })) }, result: { columns: [...dims, ...metricIds].map(name => ({ name })), rows: [[...dims.map(() => 'East'), ...metricIds.map(() => 10)]], elapsedMs: 1 } });
  const plans = new Map([['primary', observed(['sales'])]]);
  // 下钻:从整体往下一层,缩小到 region=East(核对过的范围内),按月拆,配环比
  const drill = (patch = {}) => ({ readings: [], thinking: 'Find where it changed', decision: 'drill', rootCause: '', gaps: [],
    drills: [{ from: 'overview', question: 'Inventory by month', metricIds: ['stock'], focus: [{ field: 'region', values: ['East'] }], breakdown: 'month', compare: 'mom', ...patch }] });
  const done = { readings: [{ stepId: 'S1', reading: 'Stock fell in August' }], thinking: 'Enough', decision: 'done', drills: [], rootCause: 'Stock fell', gaps: [] };
  let round = 0, built = 0; const tools = [];
  const investigator = m.createDrillInvestigator({ readCatalog: () => catalog, getPlan: id => plans.get(id),
    callStructured: async () => response(round++ ? done : drill()), callTool: async (name, data, workflowId) => {
      tools.push({ name, data, workflowId });
      if (name === 'build_query_plan') { const id = `p${++built}`; plans.set(id, observed(['stock'], ['month'])); return ok({ planId: id }); }
      if (name === 'execute_query_plan') return ok({ rowCount: 1 });
      return ok({ issues: [{ level: 'warn', code: 'GAP', message: 'One gap' }] });
    } });
  const before = structuredClone(state);
  const evidence = await investigator(state);
  assert.equal(evidence.drillSteps.length, 1); assert.equal(evidence.drillSteps[0].planId, 'p1'); assert.equal(evidence.drillSteps[0].comparePlanId, 'p2', 'Every drill step gets its baseline');
  assert.equal(evidence.drillSteps[0].reading, 'Stock fell in August'); assert.equal(evidence.rootCause, 'Stock fell');
  assert.equal(evidence.validation.status, 'warn'); assert(evidence.validatedMetrics.some(metric => metric.metricId === 'stock'));
  const builds = tools.filter(t => t.name === 'build_query_plan');
  assert.deepEqual(builds[0].data.dateRange, dateRange); assert.deepEqual(builds[0].data.filters, [{ field: 'region', values: ['East'] }]);
  assert.deepEqual(builds[1].data.dateRange, { start: '2026-07-01', end: '2026-07-31' }, 'The baseline is the previous whole month');
  assert(tools.every(tool => tool.workflowId === state.workflowId)); assert.deepEqual(state, before);
  // 范围只能越钻越小:超出核对过的取值、目录外的指标、日期越界 —— 都不取数
  for (const bad of [{ focus: [{ field: 'region', values: ['West'] }] }, { metricIds: ['foreign'] }, { dateRange: { start: '2026-07-01', end: '2026-08-31' } }, { breakdown: 'missing' }]) {
    let calls = 0, asked = 0;
    const node = m.createDrillInvestigator({ readCatalog: () => catalog, getPlan: id => plans.get(id),
      callStructured: async () => response(asked++ ? done : drill(bad)), callTool: async () => { calls++; return ok({}); } });
    const out = await node(state);
    assert.equal(calls, 0, `must not query out of scope: ${JSON.stringify(bad)}`);
    assert(out.investigation.some(line => line.startsWith('没钻')), JSON.stringify(out.investigation));
  }
  await assert.rejects(investigator({ ...state, connId: 'B' }), /连接不一致/);
  // 模型一路说还要下钻、不给根因。最后一轮必须强制收束,把根因写出来,不能空着手结束。
  {
    const localPlans = new Map([['primary', plans.get('primary')]]);
    let asked = 0;
    const node = m.createDrillInvestigator({
      readCatalog: () => catalog, getPlan: id => localPlans.get(id),
      callStructured: async (call) => {
        asked += 1;
        const choices = call.schema?.properties?.decision?.enum ?? [];
        const forced = choices.length === 1 && choices[0] === 'done' && (call.schema?.properties?.rootCause?.minLength ?? 0) >= 1;
        if (forced) {
          return response({ readings: [{ stepId: 'S1', reading: '八月库存下降' }], thinking: '轮数用完,收束', decision: 'done', drills: [], rootCause: '库存下降集中在八月', gaps: [] });
        }
        return response(drill());
      },
      callTool: async (name) => {
        if (name === 'build_query_plan') {
          const id = `gap-${asked}-${localPlans.size}`;
          localPlans.set(id, observed(['stock'], ['month']));
          return ok({ planId: id });
        }
        if (name === 'execute_query_plan') return ok({ rowCount: 1 });
        return ok({ issues: [] });
      },
    });
    const unfinished = await node(state);
    assert.equal(unfinished.rootCause, '库存下降集中在八月', '最后一轮必须写出根因,不能停在未收敛');
    assert.ok(asked >= 2, '前面几轮仍可下钻,只在最后一轮强制收束');
  }
  for (const target of ['model', 'build_query_plan', 'execute_query_plan', 'validate_dataset']) {
    const wait = later(), start = later(), controller = new AbortController(), trace = [];
    const node = m.createDrillInvestigator({ readCatalog: () => catalog, getPlan: id => plans.get(id),
      callStructured: async () => { if (target === 'model') { start.resolve(); return wait.promise; } return response(drill()); },
      callTool: async name => { trace.push(name); if (name === target) { start.resolve(); return wait.promise; } return ok(name === 'build_query_plan' ? { planId: 'p9' } : { rowCount: 1, issues: [] }); } });
    plans.set('p9', observed(['stock'], ['month']));
    const run = node(state, { signal: controller.signal }); await start.promise; controller.abort(); wait.resolve(target === 'model' ? response(done) : ok({ planId: 'late', rowCount: 1, issues: [] }));
    await assert.rejects(run, error => error.name === 'AbortError');
    if (target !== 'model') assert.equal(trace.at(-1), target, 'no tool after cancellation');
  }
  /* 连接是**指标目录的属性**,不是"点「分析」时恰好在看哪个 tab"。
     真机:在别的库的表上点了「分析」,分析 tab 把那个连接焊死(建一次就一直复用),
     153 个指标全被 connId 过滤掉,提示「当前连接没有可用指标」——
     而指标一个没少,只是找错了地方。 */
  {
    const conn = (connId, connName, n) => Array.from({ length: n }, (_, i) => ({ id: `${connId}-${i}`, connId, connName, enabled: true }));
    const only = conn('p86R6lQEkm', '应用库', 3);

    // 当前连接没指标、而全局只有一个连接有 → 那个就是唯一正确答案,直接用
    assert.equal(m.catalogConnection(only, 'xb2be3qh6E').connId, 'p86R6lQEkm',
      '指标只挂在一个连接上时,不该因为用户在看别的库就判"没有可用指标"');
    // 当前连接自己有指标 → 用它(用户可能真有多个连接各带一套口径)
    assert.equal(m.catalogConnection(only, 'p86R6lQEkm').connId, 'p86R6lQEkm');

    // 好几个连接都有指标 → **不猜**,原样返回,让上层摆出候选问人
    const many = [...only, ...conn('other', '原始库', 2)];
    assert.equal(m.catalogConnection(many, 'xb2be3qh6E').connId, 'xb2be3qh6E', '多个候选时不许替用户挑一个连接');
    assert.deepEqual(m.catalogConnection(many, 'x').candidates.map(c => [c.connName, c.count]), [['应用库', 3], ['原始库', 2]], '候选按指标多少排,好让上层报得出去处');

    // 停用的指标不算数 —— 全停用等于这个连接没有可用口径
    const disabled = only.map(metric => ({ ...metric, enabled: false }));
    assert.deepEqual(m.catalogConnection(disabled, 'x'), { connId: 'x', candidates: [] });
  }

  const wait = later(), start = later(), stop = new AbortController();
  const reviewer = m.createConclusionReviewer({ readCatalog: () => catalog, getPlan: id => plans.get(id), callStructured: async () => { start.resolve(); return wait.promise; } });
  const reviewing = reviewer({ ...state, report: '10 total' }, { signal: stop.signal }); await start.promise; stop.abort(); wait.resolve(response({ verdict: 'pass', issues: [] }));
  await assert.rejects(reviewing, error => error.name === 'AbortError');
  console.log('Exploration checks passed: independent catalogs, pure plan validation, resolved scope, model configuration, cancellation at all awaits, top-down drill scope, baselines, data warnings and connection boundaries, catalog-owned connection, no repeated clarification.');
} finally { rmSync(dir, { recursive: true, force: true }); }
