import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const dir = mkdtempSync(join(tmpdir(), 'sonde-design-units-'));
try {
  const output = join(dir, 'tests.cjs');
  buildSync({ stdin: { contents: `export {validate} from './src/features/agent/jsonSchema'; export {bandOf} from './src/features/agent/layout'; export * from './src/features/agent/designUnits'; export * from './src/features/agent/designContracts'; export * from './src/features/agent/nodes/layoutDesigner'; export * from './src/features/agent/nodes/dashboardCompiler'; export {scaledText} from './src/features/dashboard/widgets/metricUtils'; export {WIDGET_TYPES} from './src/features/dashboard/domain'; export {WIDGET_SPECS} from './src/features/dashboard/widgetSpecs';`, loader: 'ts', resolveDir: resolve('.') }, outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const m = createRequire(import.meta.url)(output);
  const definitions = [ ['v1:total_gmv', '元'], ['v1:total_order_cnt', '单'], ['v1:offline_gmv', '元'], ['v1:online_gmv', '元'] ].map(([metricId, unit]) => ({ metricId, name: metricId, unit, rollup: 'sum', supportedDimensions: ['region'], caliber: 'SUM', dateScoped: true, sourceTables: ['sales'] }));
  const card = (metricIds, metrics, extra = {}) => ({ type: 'kpi', band: 'kpi', title: '整体核心指标', metricIds, metrics, dimensions: [], reason: 'Summary', ...extra });
  const ids = definitions.map(metric => metric.metricId);
  const layout = { title: '经营', theme: 'Overview', items: [
    card(ids.slice(0, 2), { [ids[0]]: { unit: '万元', alias: '销售额' }, [ids[1]]: { unit: '万单' } }),
    card([ids[0]], { [ids[0]]: { unit: '万元' } }, { type: 'bar', band: 'ranking', dimensions: ['region'], title: '各大区销售额排名' }),
    card(ids.slice(2), { [ids[2]]: { unit: '万元' }, [ids[3]]: { unit: '万元' } }, { type: 'pie', band: 'structure', chart: { pieHole: 30 }, title: '渠道构成' }),
    card([ids[0], ...ids.slice(2)], Object.fromEntries([ids[0], ...ids.slice(2)].map(id => [id, { unit: '万元' }])), { type: 'table', band: 'detail', title: '大区明细', dimensions: ['region'] }),
  ] };
  const original = structuredClone(layout), state = { validatedMetrics: definitions, usage: [], userRequest: '经营情况', workflowId: 'units', scope: { dateRange: { start: '2026-08-01', end: '2026-08-31' }, filters: [], comparisonRanges: [] } };
  assert(m.validateDesignBindings(layout, state).length > 0);
  const normalized = m.normalizeDesignUnits(layout, definitions);
  assert.deepEqual(m.validateDesignBindings(normalized, state), []); assert.deepEqual(layout, original);
  normalized.items.forEach(item => assert.equal(item.numberFormat.scale, 'wan'));
  assert.equal(normalized.items[0].metrics[ids[0]].unit, '元'); assert.equal(normalized.items[0].metrics[ids[1]].unit, '单');
  assert.equal(m.scaledText(38540000, 2, normalized.items[0].metrics[ids[0]].unit, normalized.items[0].numberFormat), '3854万元');
  assert.equal(m.scaledText(22680000, 2, normalized.items[0].metrics[ids[1]].unit, normalized.items[0].numberFormat), '2268万单');
  assert.equal(normalized.items[2].chart.pieHole, 30);
  const check = item => { const output = m.normalizeDesignUnits({ ...layout, items: [item] }, definitions); return { output, issues: m.validateDesignBindings(output, state) }; };
  const one = layout.items[1];
  for (const unit of ['美元', '笔', '亿元/店']) assert(check({ ...one, metrics: { [ids[0]]: { unit } } }).issues.length);
  assert(check({ ...one, metrics: { other: { unit: '元' } } }).issues.some(error => error.includes('未绑定')));
  assert(check({ ...layout.items[0], metrics: { [ids[0]]: { unit: '亿元' }, [ids[1]]: { unit: '万单' } } }).issues.length, 'mixed scales need an explicit design decision');
  assert(check({ ...one, numberFormat: { scale: 'yi' } }).issues.length, 'do not silently overwrite an explicit conflicting scale');
  assert(check({ ...one, metrics: { [ids[0]]: { unit: '元', direction: 'higher' } } }).issues.length, 'business direction gate remains');
  const billion = check({ ...one, metrics: { [ids[0]]: { unit: ' 亿元 ' } } });
  assert.equal(billion.issues.length, 0); assert.equal(billion.output.items[0].numberFormat.scale, 'yi');
  const suffix = check({ ...one, metrics: {}, numberFormat: { suffix: '万元' } });
  assert.equal(suffix.issues.length, 0); assert.equal(suffix.output.items[0].numberFormat.scale, 'wan');
  const inherited = check({ ...one, metrics: { [ids[0]]: { unit: '' } }, numberFormat: { suffix: '' } });
  assert.equal(inherited.output.items[0].metrics[ids[0]].unit, '元'); assert.equal(inherited.output.items[0].numberFormat.suffix, undefined);
  const scaledSuffix = check({ ...one, metrics: { [ids[0]]: { unit: '元' } }, numberFormat: { scale: 'wan', suffix: '元' } });
  assert.equal(scaledSuffix.issues.length, 0); assert.equal(scaledSuffix.output.items[0].numberFormat.suffix, '万元');
  assert.equal(m.scaledText(10000, 0, '元', scaledSuffix.output.items[0].numberFormat), '1万元');
  assert(m.validateDesignBindings({ ...layout, items: [{ ...one, metrics: {}, numberFormat: { scale: 'wan', suffix: '元' } }] }, state).length);
  const legacy = check({ ...one, scale: 'wan', metrics: { [ids[0]]: { unit: '元' } }, numberFormat: { prefix: '¥' } });
  assert.equal(legacy.output.items[0].numberFormat.scale, 'wan'); assert.equal(legacy.issues.length, 0);
  const nested = check(card([], {}, { type: 'container', tabs: [{ title: '详情', items: [one] }] }));
  assert.equal(nested.issues.length, 0); assert.equal(nested.output.items[0].tabs[0].items[0].numberFormat.scale, 'wan');
  const designer = m.createLayoutDesigner({ getPlan: () => undefined, callStructured: async () => ({ ok: true, data: layout, ms: 4, promptTokens: 20, completionTokens: 30 }) });
  const designed = await designer.layoutDesigner(state);
  assert.equal(designed.designBindingErrors.length, 0); assert.equal(designed.usage[0].completionTokens, 30);
  const badDesigner = m.createLayoutDesigner({ getPlan: () => undefined, callStructured: async () => ({ ok: true, data: { ...layout, items: [{ ...one, metrics: { [ids[0]]: { unit: '美元' } } }] }, ms: 4, promptTokens: 20, completionTokens: 30 }) });
  const bad = await badDesigner.layoutDesigner(state); assert(bad.designBindingErrors.length); assert.equal(bad.usage[0].completionTokens, 30, 'failed design validation still records actual model usage');
  const calls = [];
  const compiler = m.createDashboardCompiler({ getPlan: () => undefined, describeModel: () => 'fixture', discardDraft: () => assert.fail('valid design must not discard'), callTool: async (name, input) => { calls.push({ name, input }); return { ok: true, data: name === 'create_dashboard' ? { dashboardId: 'board' } : name === 'add_component' ? { widgetId: 'widget' + calls.length } : {} }; } });
  await compiler.compileDashboard({ ...state, ...designed }, undefined, true);
  assert(calls.some(call => call.name === 'save_dashboard'));
  const styles = calls.filter(call => call.name === 'style_component');
  assert(styles.every(call => call.input.numberFormat.scale === 'wan'));
  assert.equal(styles[0].input.metrics[ids[0]].unit, '元');
  /* 给设计 AI 的组件介绍从看板的组件说明书生成:看板有几种组件,它就看到几种,
     名字和看板上一致。以前那份「遇到 X 用 Y」的手写清单是替它做决定,已删。 */
  {
    const guide = m.designCapabilityGuide();
    for (const type of m.WIDGET_TYPES) {
      assert(guide.includes(`- ${type}「${m.WIDGET_SPECS[type].label}」`), `组件 ${type} 没出现在给 AI 的介绍里`);
    }
    assert(!/遇到这些情况/.test(guide), '介绍只讲有什么,不讲什么时候该用什么');
  }

  /* band 不再是必填的五选一。
     以前散文里写着「没有四个 KPI 或一张表的配额」,schema 却要求每块都从
     kpi/trend/structure/ranking/detail 里挑一个 —— schema 比散文有力,
     模型每次凑齐五个角色,看板就千篇一律。现在它可选。 */
  {
    const itemSchema = m.LAYOUT_SCHEMA.properties.items.items;
    assert(!itemSchema.required.includes('band'), 'band 不该是必填 —— 那等于要求模型凑角色');
    const noBand = { type: 'bar', title: '各地区销售额', metricIds: ['m1'], dimensions: ['region'], reason: '比较' };
    assert.deepEqual(m.validate(noBand, itemSchema), [], '省略 band 必须能过校验');

    /* 但排序那条安全网不能跟着没:真机上出过「副标题写着按销售额降序、
       柱子却按名称顺排」的图,名字叫排名、读出来的名次全是错的。 */
    assert.equal(m.bandOf(noBand), 'ranking', '没给 band 的柱形图应兜底成 ranking,排序安全网才还在');
    assert.equal(m.bandOf({ type: 'kpi' }), 'kpi');
    assert.equal(m.bandOf({ type: 'table' }), 'detail');
    assert.equal(m.bandOf({ type: 'bar', band: 'structure' }), 'structure', '模型明确给了就听它的');
  }

  console.log('Design unit checks passed: reported KPI/chart/table cases, exact scaled values, nested cards, inherited units, invalid references/currencies/conflicting scales, cost records and compiler output.');
} finally { rmSync(dir, { recursive: true, force: true }); }
