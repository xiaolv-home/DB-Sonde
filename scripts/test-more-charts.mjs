// 散点 / 雷达 / 热力 / 矩形树 / 瀑布 / 排行榜的配置(moreCharts.runtime.js,看板和导出的网页共用)。
// 这些图算错了不会报错,只会画出一张「看起来正常」的错图 —— 所以把数算对这件事钉住。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

new Function(readFileSync('src/features/dashboard/tooltipText.runtime.js', 'utf8'))();
new Function(readFileSync('src/features/dashboard/moreCharts.runtime.js', 'utf8'))();
const api = globalThis.__DASH_MORE__;

const sum = (rows, i) => rows.reduce((s, r) => s + Number(r[2 + i] ?? 0), 0);
const input = (rows, extra = {}) => ({
  rows, dims: [0], series: -1, measures: [{ name: '金额' }, { name: '单量' }, { name: '人数' }],
  agg: sum, fmt: (i, v) => String(Math.round(v * 100) / 100), palette: ['#111111', '#222222', '#333333'],
  theme: { muted: '#888', border: '#ddd', surface: '#fff', text: '#000', accent: '#4d8dff' },
  opts: { topN: 0, showLegend: true }, animation: false, ...extra,
});

// 瀑布:透明垫底 + 增减,末尾合计 = 累计;减少的那步垫底是减完后的位置
{
  const rows = [['收入', null, 100], ['成本', null, -30], ['费用', null, -20], ['其他', null, 5]];
  const o = api.waterfall(input(rows));
  const [base, bars] = o.series;
  assert.deepEqual(base.data, [0, 70, 50, 50, 0]);
  assert.deepEqual(bars.data.map((b) => b.value), [100, 30, 20, 5, 55]);
  assert.deepEqual(o.xAxis.data, ['收入', '成本', '费用', '其他', '合计']);
  assert.equal(bars.data[4].total, true);
  const off = api.waterfall(input(rows, { opts: { topN: 0, waterfall: { total: false } } }));
  assert.equal(off.xAxis.data.length, 4, '关掉合计就不该有合计柱');
}

// 排行榜:按第一个数值从高到低,topN 截断,倒序看倒数;进度条按最大值算
{
  const rows = [['A', null, 30, 3], ['B', null, 90, 9], ['C', null, 60, 6], ['B', null, 10, 1]];
  const r = api.ranking(input(rows, { opts: { topN: 2 } }));
  assert.deepEqual(r.items.map((x) => [x.rank, x.name, x.text]), [[1, 'B', '100'], [2, 'C', '60']], '同名分组要先合并再排');
  assert.equal(r.items[1].ratio, 0.6);
  assert.equal(r.items[0].extra, '单量 10');
  const asc = api.ranking(input(rows, { opts: { topN: 0, ranking: { order: 'asc' } } }));
  assert.deepEqual(asc.items.map((x) => x.name), ['A', 'C', 'B']);
}

// 热力:横轴 × 纵轴的格子,同一格多行要合并;缺纵轴维度要说清楚
{
  const rows = [['周一', '早', 1], ['周一', '晚', 2], ['周二', '早', 3], ['周二', '早', 4]];
  const o = api.heatmap(input(rows, { series: 1, measures: [{ name: '单量' }] }));
  assert.deepEqual(o.xAxis.data, ['周一', '周二']);
  assert.deepEqual(o.yAxis.data, ['早', '晚']);
  const cell = (x, y) => o.series[0].data.find((d) => d[0] === x && d[1] === y)?.[2];
  assert.equal(cell(1, 0), 7, '周二早两行要合在一格');
  assert.deepEqual([o.visualMap.min, o.visualMap.max], [1, 7]);
  assert.match(api.heatmap(input(rows)).empty, /纵轴/);
}

// 散点:一个分类一个点,[横, 纵, 大小];只有一个数值时说清楚要两个;四象限画平均线
{
  const rows = [['A', null, 10, 1, 5], ['B', null, 20, 3, 20], ['A', null, 10, 1, 5]];
  const o = api.scatter(input(rows, { opts: { topN: 0, scatter: { quadrant: true } } }));
  assert.deepEqual(o.series[0].data.map((p) => [p.name, ...p.value]), [['A', 20, 2, 10], ['B', 20, 3, 20]]);
  assert.deepEqual(o.series[0].markLine.data, [{ xAxis: 20 }, { yAxis: 2.5 }]);
  assert.match(api.scatter(input(rows, { measures: [{ name: '金额' }] })).empty, /两个数值/);
}

// 雷达:每条轴各自的满刻度(不然量级小的那项缩成一个点);少于三个数值不画
{
  const rows = [['A', null, 1000, 0.2, 7], ['B', null, 500, 0.5, 9]];
  const o = api.radar(input(rows));
  assert.deepEqual(o.radar.indicator.map((x) => Math.round(x.max * 100) / 100), [1120, 0.56, 10.08]);
  assert.deepEqual(o.series[0].data.map((d) => d.name), ['A', 'B']);
  assert.match(api.radar(input(rows, { measures: [{ name: 'a' }, { name: 'b' }] })).empty, /三个/);
}

// 矩形树:两层,父节点 = 子节点之和;非正数剔掉
{
  const rows = [['华北', '北京', 50], ['华北', '天津', 30], ['华东', '上海', 40], ['华东', '杭州', -5]];
  const o = api.treemap(input(rows, { dims: [0, 1], measures: [{ name: '金额' }] }));
  const data = o.series[0].data;
  assert.deepEqual(data.map((n) => [n.name, n.value, n.children.map((c) => c.name)]), [['华北', 80, ['北京', '天津']], ['华东', 35, ['上海']]]);
}

console.log('more charts: ok');
