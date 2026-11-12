// 下钻和返回都只发一次查询、只切一次画面,不把图表卸掉再挂上。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

new Function(readFileSync('src/features/dashboard/drillView.runtime.js', 'utf8'))();
const D = globalThis.__DASH_DRILL__;

const pie = {
  id: 'w1', type: 'pie',
  options: { chart: { drillDimensions: ['store', 'shop'] } },
};
const line = {
  id: 'w2', type: 'line',
  options: { chart: { drillDimensions: ['city'] } },
};
const tree = {
  id: 'w3', type: 'treemap',
  options: { chart: { drillDimensions: ['store'] } },
};

assert.deepEqual(D.drillDimensionsOf(pie), ['store', 'shop']);
assert.deepEqual(D.drillDimensionsOf(line), ['city'], '折线也能下钻');
assert.deepEqual(D.drillDimensionsOf(tree), [], '矩形树的下钻是图内缩放,不另发查询');
assert.deepEqual(D.drillDimensionsOf({ type: 'bar', options: { chart: {} } }), []);

const zone = [{ dimension: 'zone', value: '天津战区' }];
const store = [{ dimension: 'zone', value: '天津战区' }, { dimension: 'store', value: '和平路店' }];

// 列还是上一层的时候,画面停住,不能先切到一个不存在的维度。
assert.deepEqual(D.nextShownPath([], zone, ['zone', 'amount'], ['store', 'shop'], 'zone'), []);
assert.deepEqual(
  D.nextShownPath(zone, store, ['store', 'amount'], ['store', 'shop'], 'zone'),
  zone,
  '再钻一层时,店这一列还没到,就继续画战区',
);
// 列到了才切。
assert.deepEqual(D.nextShownPath([], zone, ['store', 'amount'], ['store', 'shop'], 'zone'), zone);
assert.deepEqual(D.nextShownPath(store, zone, ['store', 'amount'], ['store', 'shop'], 'zone'), zone, '返回上一层,列对上就只退一档');
assert.deepEqual(D.nextShownPath(zone, [], ['zone', 'amount'], ['store', 'shop'], 'zone'), [], '回到顶层用基础结果,不再查');

// 键没变就还是原来那张表,避免白渲染一帧。
const kept = { w1: { tag: 'old' } };
assert.equal(D.retainDrillMap(kept, ['w1']), kept);
assert.deepEqual(D.retainDrillMap(kept, []), {});
const empty = {};
assert.equal(D.retainDrillMap(empty, ['w1']), empty, '还没结果时不要换一张空表');

assert.equal(D.paintChanged(['a', 1], ['a', 1]), false);
assert.equal(D.paintChanged(['a', 1], ['a', 2]), true);
assert.equal(D.paintChanged(null, ['a']), true);

// 一次下钻一条查询;回到顶层零条;组件筛选那一路已经会查的,这里不再查第二次。
const one = D.widgetsToFetch([pie, line, tree], { w1: zone }, {});
assert.equal(one.length, 1);
assert.equal(one[0].id, 'w1');
assert.equal(one[0].groupBy, 'store');
assert.equal(one[0].level, 1);
assert.deepEqual(D.widgetsToFetch([pie], { w1: [] }, {}), [], '顶层不发查询');
assert.equal(D.widgetsToFetch([pie], { w1: store }, {}).length, 1);
assert.equal(D.widgetsToFetch([pie], { w1: store }, {})[0].groupBy, 'shop');
assert.deepEqual(D.widgetsToFetch([pie], { w1: zone }, { w1: true }), [], '组件筛选会带上下钻条件,下钻这条别再发');
assert.equal(D.widgetsToFetch([line], { w2: [{ dimension: 'zone', value: '华北' }] }, {})[0].groupBy, 'city');
assert.deepEqual(D.widgetsToFetch([tree], { w3: zone }, {}), []);

// 把点击、结果、返回串起来:查询次数和画面切换次数都是一次,宿主不变。
{
  const dims = ['store', 'shop'];
  const bound = 'zone';
  let requested = [];
  let shown = [];
  let columns = ['zone', 'amount'];
  let queries = 0;
  let paints = 0;
  let paintKey = '';
  const host = 'w1';
  let hosts = 1;

  function frame() {
    const next = D.nextShownPath(shown, requested, columns, dims, bound);
    const key = JSON.stringify(next) + '|' + columns.join(',');
    if (key !== paintKey) { paints += 1; paintKey = key; }
    shown = next;
    assert.equal(host, 'w1');
  }
  frame();
  const rest = paints;

  requested = zone.slice();
  frame();
  assert.equal(paints, rest, '点进天津战区时结果还没到,不能先刷一遍');
  const down = D.widgetsToFetch([pie], { w1: requested }, {});
  assert.equal(down.length, 1);
  queries += down.length;
  columns = ['store', 'amount'];
  frame();
  assert.equal(paints, rest + 1, '数据到了只切一次画面');
  assert.equal(queries, 1);

  requested = [];
  columns = ['zone', 'amount'];
  frame();
  assert.equal(paints, rest + 2, '返回顶层只切一次');
  assert.equal(D.widgetsToFetch([pie], { w1: [] }, {}).length, 0, '返回顶层不再查询');
  assert.equal(queries, 1);
  assert.equal(hosts, 1, '图表宿主不重建');

  requested = zone.slice();
  queries += D.widgetsToFetch([pie], { w1: requested }, {}).length;
  columns = ['store', 'amount'];
  frame();
  requested = store.slice();
  frame();
  assert.equal(paints, rest + 3, '第二层的数据没到之前不切');
  queries += D.widgetsToFetch([pie], { w1: requested }, {}).length;
  columns = ['shop', 'amount'];
  frame();
  assert.equal(paints, rest + 4);

  requested = zone.slice();
  frame();
  assert.equal(paints, rest + 4, '返回上一层时,上一层的列还没到,先停在当前层');
  const back = D.widgetsToFetch([pie], { w1: requested }, {});
  assert.equal(back.length, 1);
  assert.equal(back[0].groupBy, 'store');
  queries += 1;
  columns = ['store', 'amount'];
  frame();
  assert.equal(paints, rest + 5, '返回上一层的结果到了只切一次');
  assert.equal(hosts, 1);
}

// 接线:这些函数得真用在运行时和渲染上,不能只躺在测试里。
const runtime = readFileSync('src/features/dashboard/useDashboardRuntime.ts', 'utf8');
const drillFn = runtime.slice(runtime.indexOf('export function useDrillRuntime'), runtime.indexOf('export function useComponentRuntime'));
assert(drillFn.includes('widgetsToFetch'), '下钻查询走 widgetsToFetch');
assert(drillFn.includes('retainDrillMap'));
assert(!drillFn.includes('refetching'), '下钻查询回来之前不能先写成只有 loading 的空结果');
assert(drillFn.includes('w.type === "line"'), '折线在下钻查询的范围内');

const renderer = readFileSync('src/features/dashboard/components/WidgetRenderer.tsx', 'utf8');
assert(renderer.includes('nextShownPath'));
assert(renderer.includes('drillFrozen={drillPending}'));

const chart = readFileSync('src/features/dashboard/widgets/ChartWidget.tsx', 'utf8');
assert(chart.includes('key="chart-host"'), '面包屑开关不能换掉图表节点');
assert(chart.includes('shouldSetOption={shouldSetOption}'));
assert(chart.includes('drillFrozen'));
assert(!chart.includes('if (!drillPath?.length) return content'), '不能按路径有无换根节点');

const box = readFileSync('src/features/dashboard/useChartBox.ts', 'utf8');
assert(box.includes('useLayoutEffect'), '尺寸要在绘制前量,免得 setOption 两次');
assert(!box.includes('useEffect('));

const more = readFileSync('src/features/dashboard/widgets/MoreChartWidget.tsx', 'utf8');
assert(more.includes('shouldSetOption={shouldSetOption}'), '矩形树缩放不被父组件重渲染打回去');

const standalone = readFileSync('src/features/dashboard/export/standalone.runtime.js', 'utf8');
const renderChart = standalone.slice(standalone.indexOf('function renderChart'), standalone.indexOf('function renderKpi'));
assert(renderChart.includes('getInstanceByDom'), '离线下钻复用已有实例');
assert(renderChart.includes('_dashFrame'), '同一帧里多次下钻只提交一次');
assert(renderChart.includes('if (!inst) inst = echarts.init'), '只有还没有实例时才 init');
assert(!renderChart.includes('var inst = echarts.init'), '不要每次下钻都新建实例');

const bake = readFileSync('src/features/dashboard/export/bake.ts', 'utf8');
assert(bake.includes('drillDimensionsOf'), '离线烘焙跟在线同一份下钻类型');

console.log('drill refresh: ok');
