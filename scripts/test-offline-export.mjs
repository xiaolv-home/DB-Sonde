// 导出的离线网页必须和看板上看到的一致。踩过的:Tab 容器和它里面的图被整个跳过,
// 导出来只剩一张表;数据集模型的度量没带出去,图表拿不到指标定义,画出来一片空白。
// 这两件事在界面上都要点半天才能发现,所以在这儿直接生成 HTML 检查。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { esbuildExportAssets, echartsParts } from '../vite/exportAssets.mjs';

const dir = mkdtempSync(join(tmpdir(), 'sonde-offline-'));
try {
  const stub = join(dir, 'api-stub.ts');
  writeFileSync(stub, `
    export const sqls: string[] = [];
    export const api = {
      runReadOnlyQuery: async (_c: string, _d: string, sql: string) => {
        sqls.push(sql);
        return {
          columns: [{ name: 'product_id' }, { name: 'amount' }],
          rows: [['咖啡', 10], ['轻食', 20]], rowsAffected: null, truncated: false,
        };
      },
      pyWorkspaceDir: async () => '', pyWriteFile: async () => {},
    };
  `);

  const outfile = join(dir, 'tests.cjs');
  await build({
    stdin: {
      contents: `
        export { bakeDashboard } from './src/features/dashboard/export/bake';
        export { buildDashboardHtml } from './src/features/dashboard/export/htmlExport';
        export { resolveWidgetDatasets } from './src/features/dashboard/resolveDatasets';
        export { sqls } from './src/lib/api';
      `,
      resolveDir: resolve('.'), loader: 'ts',
    },
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [esbuildExportAssets(resolve('.')), {
      name: 'stub-api',
      setup(b) {
        let hit = 0;
        b.onResolve({ filter: /lib\/api$/ }, () => { hit += 1; return { path: stub }; });
        b.onEnd(() => { if (!hit) throw new Error('api 没被替换成假货'); });
      },
    }, {
      // Vite 的 ?raw(把文件当字符串引进来)—— esbuild 不认,自己实现一下。
      name: 'raw',
      setup(b) {
        b.onResolve({ filter: /\?raw$/ }, (args) => {
          const bare = args.path.replace(/\?raw$/, '');
          // 相对路径按引用它的文件算,裸包名(echarts/dist/...)去 node_modules 找。
          const path = bare.startsWith('.') ? resolve(args.resolveDir, bare) : resolve('node_modules', bare);
          return { path, namespace: 'raw' };
        });
        b.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({
          contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))};`,
          loader: 'js',
        }));
      },
    }],
  });
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const { bakeDashboard, buildDashboardHtml, resolveWidgetDatasets, sqls } = createRequire(import.meta.url)(outfile);

  const container = {
    id: 'c1', type: 'container', title: 'Tab 容器', datasetId: '', x: 0, y: 0, w: 12, h: 7,
    visible: true, tabs: [{ id: 't1', label: '第一页' }],
    bindings: { measures: [], metricIds: [], secondaryMetricIds: [] },
    options: { decimals: 2, showLegend: true, smooth: true, topN: 0, metrics: {} },
  };
  const pie = {
    id: 'w1', type: 'pie', title: '品类构成', datasetId: 'ds1', x: 0, y: 0, w: 4, h: 4,
    visible: true, parentId: 'c1', tabId: 't1', tabs: [],
    bindings: { dimension: 'product_id', dimensions: ['product_id'], measures: ['amount'], aggregations: { amount: 'sum' }, metricIds: [], secondaryMetricIds: [] },
    options: { decimals: 2, showLegend: true, smooth: true, topN: 0, metrics: {} },
  };
  const dataset = {
    id: 'w1', name: '销售', sourceType: 'sql', connectionId: 'c1', database: 'db',
    sql: 'select 1', fields: [], dimensionLabels: { amount: '销售额', product_id: '品类' },
  };
  const doc = {
    id: 'd1', title: '导出检查', description: '', widgets: [container, pie],
    datasets: [dataset], metrics: [], filters: [],
    metricScope: { start: '2026-01-01', end: '2026-01-31' },
  };

  const { baked } = await bakeDashboard(doc, [], (key) => key);

  // 容器和它的子组件都得在,否则导出的页面上那一整块是空的。
  assert.deepEqual(baked.widgets.map((w) => w.widget.id), ['c1', 'w1'], '容器和子组件都要烘进去');

  // 数据集模型的度量没有指标中心 id,得按字段现造一份 —— 缺了它图表拿不到指标定义。
  const bakedPie = baked.widgets.find((w) => w.widget.id === 'w1');
  assert.deepEqual(bakedPie.metrics.primary.map((m) => m.key), ['field:amount'], '按字段造出指标定义');
  assert.equal(bakedPie.metrics.primary[0].name, '销售额', '用数据集里改过的名字');
  assert.equal(bakedPie.metrics.primary[0].aggregation, 'sum', '带上汇总方式');
  assert(bakedPie.data.base.rows.length, '数据也要烘进去');

  const html = await buildDashboardHtml(baked);
  /* 导出的 HTML 里脚本是**压缩过**的(体积大头,见 vite/exportAssets.mjs),
     函数名和局部变量都被改短了。所以"运行时代码里有没有某段逻辑"这类断言要直接
     读源文件 —— 借 HTML 搜源码标识符只是压缩之前能凑合用。
     搜 CSS 类名、全局名、数据里的文字那些照旧搜 HTML:它们压缩后还在。 */
  const runtimeSource = readFileSync(resolve('src/features/dashboard/export/standalone.runtime.js'), 'utf8');
  /* ── tooltip 转义:导出页和看板必须同一份 ──────────────────────────────
     转义实现本身有真渲染测试(test-chart-quality 里拿真 option 上的 formatter
     跑出字符串来比)。这儿要防的是**两边走散** —— 看板转了、导出页没转,
     那就是同一个洞换个地方开。所以查两件事:
       1. 共用的转义脚本真的被内联进导出页了(没有它,运行时取 esc 会直接报错);
       2. 四个外来文本的落点在运行时源码里都套着 esc。
     第 2 条是源码形状检查,证不了运行时行为 —— 但它能挡住"以后有人加一行
     拼接忘了转义"这类回归,而那正是这个洞第一次出现的方式。 */
  /* 别搜 `__DASH_TIP__` —— 运行时自己那句 `globalThis.__DASH_TIP__.esc` 里也有它,
     脚本没内联照样搜得到(这条断言第一版就是这么废掉的,变异验证抓出来的)。
     搜转义表本身:`&amp;` 只可能来自那份实现。 */
  assert(html.includes('__DASH_TIP__=') || html.includes('__DASH_TIP__ ='),
    '共用的 tooltip 转义脚本要内联进导出页,否则运行时取 esc 直接报错');
  assert(html.includes('&amp;'), '转义表要真的打进页面里');
  for (const [bad, good, what] of [
    [/\+ x \+ "<\/div>"/, /esc\(x\)/, '分类名'],
    [/\+ \(p\.seriesName \|\| ""\) \+/, /esc\(p\.seriesName \|\| ""\)/, '系列名'],
    [/\+ " " \+ label \+/, /esc\(label\)/, '饼图扇区名'],
    [/return sm\.name \+/, /esc\(sm\.name\)/, '副指标名'],
  ]) {
    assert(good.test(runtimeSource), `导出运行时的${what}没走转义`);
    assert(!bad.test(runtimeSource), `导出运行时的${what}还有一处裸拼接`);
  }

  // 运行时里那句「跳过容器和子组件」是这个 bug 的根:它一在,页面上就少半个看板。
  assert(!/w\.type === "container" \|\| w\.parentId/.test(runtimeSource), '导出运行时又把容器跳过了');
  assert(/renderContainer/.test(runtimeSource), '导出运行时要会渲染 Tab 容器');
  assert(/dash-x-tabbar/.test(html), 'Tab 栏的样式要一起打进去');
  assert(html.includes('品类构成'), '子组件的标题要出现在页面里');

  /* ── 配了下钻的图,导出来是空的 ────────────────────────────────────────────
     两处都能让它空:烘数据时 if(有下钻) 只烘层表、不烘 base(而没下钻时渲染端找的
     正是 base);层表只按下钻维度分组、不带组件自己的维度,于是浏览器端没法把行
     过滤到点中的那一格 —— 点进「西北大区」看到的是全国的主管。 */
  const semantic = {
    schemaVersion: 1, id: 'ds2', name: '销售', connectionId: 'c1', database: 'db',
    source: { kind: 'join', base: { table: 'sales', alias: 't1' }, joins: [], columns: [] },
    fields: [
      { name: 'region', column: 'region', from: 't1', role: 'dimension' },
      { name: 'supervisor', column: 'supervisor', from: 't1', role: 'dimension' },
      { name: 'store', column: 'store', from: 't1', role: 'dimension' },
      { name: 'amount', column: 'amount', from: 't1', role: 'measure' },
    ],
    updatedAt: '',
  };
  const drillPie = {
    id: 'w2', type: 'pie', title: '大区构成', datasetId: 'ds2', x: 0, y: 0, w: 4, h: 4,
    visible: true, tabs: [],
    bindings: { dimension: 'region', dimensions: ['region'], measures: ['amount'], aggregations: { amount: 'sum' }, metricIds: [], secondaryMetricIds: [] },
    options: { decimals: 2, showLegend: true, smooth: true, topN: 0, metrics: {}, chart: { drillDimensions: ['supervisor', 'store'] } },
  };
  const scope = { start: '2026-01-01', end: '2026-01-31' };
  const compiled = resolveWidgetDatasets([drillPie], [semantic], () => 'mysql', scope);
  sqls.length = 0;
  const drilled = await bakeDashboard(
    { id: 'd2', title: '下钻', description: '', widgets: [drillPie], datasets: compiled, metrics: [], filters: [], metricScope: scope },
    [], (key) => key,
  );
  const bakedDrill = drilled.baked.widgets.find((w) => w.widget.id === 'w2');
  assert(bakedDrill.data.base && bakedDrill.data.base.rows.length, '配了下钻也得烘 base —— 没下钻时渲染端找的就是它');
  assert.equal(bakedDrill.data.levels.length, 2, '每层一张表');

  const groupByOf = (sql) => (sql.split('\n').find((l) => l.startsWith('GROUP BY')) ?? '');
  const levelSqls = sqls.filter((sql) => /supervisor/.test(groupByOf(sql)));
  assert(levelSqls.length, '层表的 SQL 要按下钻维度分组');
  assert(/region/.test(groupByOf(levelSqls[0])),
    `第一层要连着组件自己的维度一起分组,否则没法过滤到点中的那一格: ${groupByOf(levelSqls[0])}`);

  // 运行时里这几处走散过,都是「看起来能用、数不对」的那种。
  assert(!/i < st\.path\.length && i < level/.test(runtimeSource), '下钻路径的最后一项又被漏掉了');
  assert(/value > 0/.test(runtimeSource), '饼图要剔掉非正数,别让一个退款把整张饼作废');
  assert(!/slice\(0, 5000\)/.test(runtimeSource), '表格要分页,别一次性把几千行建进 DOM');
  assert(/renderFilters/.test(runtimeSource), '组件筛选框要导出来');

  /* 筛选器要跟看板长得一样 —— 共用同一套控件和同一份样式表,而不是在运行时里
     另写一套原生 select。以前那套是两个文本框 + 原生下拉,跟软件里完全不是一回事。 */
  assert(/__DASH_CONTROLS__/.test(html), '筛选控件(多选/日期区间)要打进导出的页面');
  assert(/dash-v1-multi-trigger/.test(html), '多选框的样式要跟看板共用');
  assert(/dash-daterange-presets/.test(html), '日期区间的快捷项样式要在');
  assert(!/<select/.test(html), '别再用原生下拉了,跟看板对不上');
  // 明细表导出 Excel:跟看板同一份实现
  assert(/__DASH_XLSX__/.test(html), '导出 Excel 的实现要打进页面');
  assert(/导出 Excel/.test(html), '表格上要有导出按钮');

  /* 明细表:点表头排序 + 列分组之间要有分界线。透视表里一组列紧挨着下一组,
     不画线看不出哪儿到头,扫一眼分不清这个「总GMV」是哪天的。 */
  assert(/th\.sortable/.test(html), '导出的表格要能点表头排序');
  assert(/sortmark/.test(html), '排序方向要有标记');
  assert(/group-start/.test(html), '列分组之间要有分界线');

  // ── 按需构建的 ECharts:清单不能落下运行时用到的东西 ──────────────────────
  {
    /* 导出页面内联的是**按需构建**的 ECharts(完整版 1096 KB → 597 KB)。
       代价是:运行时以后加一种图或一个组件,而 vite/exportAssets.mjs 的清单
       没跟着加,那个图在导出的网页里就画不出来 —— 而软件里是好的(软件走完整版),
       很难往构建清单上想。这条守卫就是盯这件事。 */
    const SERIES = {
      line: 'LineChart', bar: 'BarChart', pie: 'PieChart', scatter: 'ScatterChart',
      radar: 'RadarChart', map: 'MapChart', tree: 'TreeChart', treemap: 'TreemapChart',
      graph: 'GraphChart', gauge: 'GaugeChart', funnel: 'FunnelChart', sankey: 'SankeyChart',
      boxplot: 'BoxplotChart', candlestick: 'CandlestickChart', heatmap: 'HeatmapChart',
      sunburst: 'SunburstChart', themeRiver: 'ThemeRiverChart', pictorialBar: 'PictorialBarChart',
      effectScatter: 'EffectScatterChart', lines: 'LinesChart', parallel: 'ParallelChart',
      custom: 'CustomChart',
    };
    const COMPONENTS = {
      grid: 'GridComponent', legend: 'LegendComponent', tooltip: 'TooltipComponent',
      dataZoom: 'DataZoomComponent', title: 'TitleComponent', toolbox: 'ToolboxComponent',
      visualMap: 'VisualMapComponent', polar: 'PolarComponent', geo: 'GeoComponent',
      dataset: 'DatasetComponent', brush: 'BrushComponent', timeline: 'TimelineComponent',
      calendar: 'CalendarComponent', graphic: 'GraphicComponent', markLine: 'MarkLineComponent',
      markPoint: 'MarkPointComponent', markArea: 'MarkAreaComponent',
    };
    const declared = new Set([...echartsParts.charts, ...echartsParts.components, ...echartsParts.renderers]);
    /* 散点 / 雷达 / 热力 / 矩形树 / 瀑布的配置在共用的 moreCharts.runtime.js 里,一起扫。 */
    const code = (runtimeSource + '\n' + readFileSync('src/features/dashboard/moreCharts.runtime.js', 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

    const missingSeries = [];
    for (const [type, part] of Object.entries(SERIES)) {
      // series 的 type 是字面量写出来的:type: "pie"、isBar ? "bar" : "line"
      const used = new RegExp('type:\\s*(?:[^,;\\n]*\\?\\s*)?"' + type + '"').test(code)
        || new RegExp(':\\s*"' + type + '"\\s*:\\s*"').test(code);
      if (used && !declared.has(part)) missingSeries.push(type + ' → ' + part);
    }
    assert.deepEqual(missingSeries, [],
      '运行时画了这些图,而按需构建的清单里没有 —— 导出的网页上它们会是空白:\n    ' + missingSeries.join('\n    '));

    const missingComponents = [];
    for (const [key, part] of Object.entries(COMPONENTS)) {
      if (new RegExp('(^|[\\s{,])' + key + ':').test(code) && !declared.has(part)) missingComponents.push(key + ' → ' + part);
    }
    assert.deepEqual(missingComponents, [],
      '运行时的图表配置里用了这些组件,而按需构建的清单里没有:\n    ' + missingComponents.join('\n    '));

    // 反过来:清单里列了运行时根本不用的,白占体积
    assert(declared.has('CanvasRenderer'), '渲染器要在,不然什么都画不出来');
  }

  // ── 内联的脚本要压缩过 ────────────────────────────────────────────────────
  {
    /* 导出的是自包含单文件,内联的东西越小它越小。压缩只影响产物,
       仓库里的源码照旧带完整注释。 */
    /* 每个内联文件各挑一句它自己的注释当哨兵 —— 只盯一句的话,
       换回 ?raw 的是别的文件就照样漏过去(第一版就挑错了文件)。 */
    for (const [sentinel, file] of [
      ['Sonde 离线看板运行时', 'standalone.runtime.js'],
      ['一份实现两处用', 'labelOrder / pieGeometry / xlsx.runtime.js'],
      ['改任何一边之前,先看另一边', 'filterControls.runtime.js'],
    ]) {
      assert(!html.includes(sentinel), `${file} 应该是压缩过再内联的(注释不该出现在产物里)`);
    }
    assert(html.includes('导出 Excel'), '但界面上的中文要原样保留 —— esbuild 默认会把非 ASCII 转成 \\u,那样反而更大');
    // 完整版 echarts 里有一堆离线页面用不到的图,挑一个当哨兵
    assert(!/SunburstView|ThemeRiverView/.test(html), '按需构建里不该有旭日图/主题河流这些用不到的图');
  }

  console.log('offline export: 30 assertions passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
