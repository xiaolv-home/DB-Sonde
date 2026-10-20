// 这个产品不该只认我们这套零售词汇。换个金融库(trade_date / account_id / settle_amt)
// 该照常跑:字段角色认得出、时间列认得出、筛选器不挑字段名、AI 也能配上它没见过的维度。
// 每一条都对应过一次真实的"换个库就拉裤":字段全被判成度量、x 轴掉回第一列、
// 筛选字段存下来被清空、模型被 schema 的 enum 挡着发不出 account_type。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'sonde-domain-neutral-'));
try {
  const outfile = join(dir, 'tests.cjs');
  await build({
    stdin: {
      contents: `
        export { inferRole, isTimeField } from './src/features/datasets/domain';
        export { normalizeDashboard } from './src/features/dashboard/domain';
        export { buildEntityPrompt, collectEntityFacts } from './src/features/entity/entityPrompt';
      `,
      resolveDir: resolve('.'), loader: 'ts',
    },
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  });
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const { inferRole, isTimeField, normalizeDashboard, buildEntityPrompt, collectEntityFacts } = createRequire(import.meta.url)(outfile);

  // 一张金融事实表。角色判断只能靠 SQL 类型和 id/date 这种跨行业的命名习惯。
  assert.equal(inferRole('DATE', 'trade_date'), 'dimension');
  assert.equal(inferRole('BIGINT', 'account_id'), 'dimension', '主键是拿来分组的,不是拿来加总的');
  assert.equal(inferRole('VARCHAR', 'instrument_code'), 'dimension');
  assert.equal(inferRole('DECIMAL', 'settle_amt'), 'measure');
  assert.equal(inferRole('DOUBLE', 'coupon_rate'), 'measure');
  assert.equal(inferRole('INT', 'fiscal_year'), 'dimension', '年月日存成整数也还是维度');

  // 时间列只有一个判断口径。以前图表另写了一条正则,`settle_dt` 在一边算时间、
  // 另一边不算,x 轴和日期范围就落到了不同的列上。
  assert.equal(isTimeField({ name: 'settle_dt', type: 'VARCHAR' }), true, '名字带 dt 就算');
  assert.equal(isTimeField({ name: 'value_date', type: 'TEXT' }), true, '日期存成文本也认');
  assert.equal(isTimeField({ name: 'maturity', type: 'DATE' }), true, '名字不像,类型说了算');
  assert.equal(isTimeField({ name: 'account_id', type: 'BIGINT' }), false);

  // 组件筛选字段就是数据集里的维度名,没有白名单 —— 以前写死成大区/主管/网点那几个,
  // 金融库建出来的组件一存就被清空。
  const widget = {
    id: 'w1', type: 'bar', title: '持仓', datasetId: 'ds1', x: 0, y: 0, w: 6, h: 4,
    visible: true, tabs: [], filtersEnabled: true,
    filterFields: ['date', 'account_type', 'instrument_code'],
    bindings: { dimensions: ['instrument_code'], measures: ['settle_amt'], metricIds: [], secondaryMetricIds: [] },
    options: { decimals: 2, showLegend: true, smooth: false, topN: 0, metrics: {} },
  };
  const saved = normalizeDashboard({ schemaVersion: 3, id: 'd', widgets: [widget] });
  assert.deepEqual(saved.widgets[0].filterFields, ['date', 'account_type', 'instrument_code'],
    '存一遍不该把它不认识的字段吃掉');

  // 给模型的 schema 也不能把字段名限死,否则它根本发不出 account_type。
  for (const file of ['src/features/agent/tools/dashboardTools.ts', 'src/features/agent/nodes/layoutDesigner.ts']) {
    const text = readFileSync(resolve(file), 'utf8');
    const line = text.split('\n').find((l) => l.includes('filterFields:'));
    assert(line && !/enumOf/.test(line), `${file} 又把筛选字段限成固定几个了: ${line?.trim()}`);
  }

  // 下钻/筛选/锁定的候选维度必须从数据集自己的字段来。换个行业的库,字段名完全不一样,
  // 任何一处写死的清单都会让那边什么也选不出来 —— 或者更糟,选出一堆不存在的列。
  const dimSources = [
    ['src/features/dashboard/components/WidgetInspector.tsx', /const dimensions = dataset\?\.fields\.filter/],
    ['src/features/dashboard/components/WidgetDataPanel.tsx', /dataset\?\.fields\.filter\(\(f\) => f\.role === "dimension"/],
    ['src/features/dashboard/components/DatasetBindingEditor.tsx', /dataset\?\.fields\.filter\(\(f\) => f\.role === "dimension"/],
  ];
  for (const [file, pattern] of dimSources) {
    assert(pattern.test(readFileSync(resolve(file), 'utf8')), `${file} 的维度候选不再是从数据集字段来的`);
  }

  // 不保留的字段不在子查询的 SELECT 里,却照样出现在下钻候选、锁定范围里的话,
  // 选中就是一句「没有这一列」。编译产物对外只该暴露它真能查的列。
  {
    const text = readFileSync(resolve('src/features/dashboard/resolveDatasets.ts'), 'utf8');
    assert(/fields: dataset\.fields\.filter\(\(field\) => !field\.hidden\)/.test(text),
      '编译产物又把不保留的字段导出去了');
  }

  // 代码里不该再出现行业词汇当数据用(注释和 i18n 文案不算)。
  for (const file of [
    'src/features/dashboard/domain.ts',
    'src/features/dashboard/components/ComponentFilterBar.tsx',
    'src/features/dashboard/components/WidgetInspector.tsx',
    'src/features/dashboard/components/WidgetDataPanel.tsx',
    'src/features/metrics/queryPlan.ts',
  ]) {
    // 看的是代码,不是散文 —— 注释里拿零售举例说明是可以的,写进逻辑里才不行。
    const text = readFileSync(resolve(file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert(!/war_zone|supervisor|大区|主管/.test(text), `${file} 里又写死了业务词汇`);
  }

  /* 表详情给 AI 的提示词。这儿原来写死两份字段名清单:
       byField 里 `["stat_date","store_id"]`、describe 里 `[...,"etl_time"]`。
     意图是对的(日期键/主键每个指标每条作业都用,列出来没有区分度),
     但换成金融库就两头落空:trade_date 剔不掉照样霸榜,
     而人家真有一列叫 store_id 的话反倒被吞掉。改成按占比/交集算。 */
  {
    // 10 个指标,全都读 trade_date 和 account_id,只有少数读各自的业务列
    const metrics = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`, name: `指标${i}`,
      fields: ['trade_date', 'account_id', i < 3 ? 'settle_amt' : 'coupon_rate'],
    }));
    const prompt = buildEntityPrompt({ id: 'fin.trades', metrics }, 'pg');
    assert.match(prompt, /共用键[^\n]*trade_date/, '几乎每个指标都读的键要拎出来单独说 —— 不靠字段名认');
    assert.match(prompt, /共用键[^\n]*account_id/, 'account_id 同理');
    assert.match(prompt, /- settle_amt — 3 个指标/, '有区分度的列照常进清单');
    assert.match(prompt, /- coupon_rate — 7 个指标/);
    const sharedLine = prompt.split('\n').find((l) => l.includes('共用键'));
    assert(!sharedLine.includes('settle_amt'), '只读了 3/10 的列不算共用键');

    // 指标少的时候没有"占比"可言,不能把仅有的两个列都当成共用键吞掉
    const few = [
      { id: 'a', name: 'A', fields: ['settle_amt'] },
      { id: 'b', name: 'B', fields: ['settle_amt'] },
    ];
    const smallPrompt = buildEntityPrompt({ id: 'fin.t', metrics: few }, 'pg');
    assert(!smallPrompt.includes('共用键'), '只有两个指标时不该判定共用键');
    assert.match(smallPrompt, /- settle_amt — 2 个指标/);
  }
  // 这个文件的代码里不许再出现写死的列名清单(注释里复述历史可以)
  {
    const text = readFileSync(resolve('src/features/entity/entityPrompt.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(!/stat_date|store_id|etl_time/.test(text),
      'entityPrompt.ts 又按字段名硬剔了 —— 该按占比/交集从数据里算');
  }

  console.log('domain neutral: 30 assertions passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
