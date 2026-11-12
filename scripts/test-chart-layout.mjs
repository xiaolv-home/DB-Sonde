// 卡片拉得很宽或很高时，图不该散开：半径、绘图区、图例都按短边封顶并居中。
// 窄卡片和普通卡片必须还是原来的排法 —— 百分比半径、标签贴边、边距不加大。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

new Function(readFileSync('src/features/dashboard/pieGeometry.runtime.js', 'utf8'))();
new Function(readFileSync('src/features/dashboard/chartLayout.runtime.js', 'utf8'))();
new Function(readFileSync('src/features/dashboard/tooltipText.runtime.js', 'utf8'))();
new Function(readFileSync('src/features/dashboard/moreCharts.runtime.js', 'utf8'))();

const layout = globalThis.__DASH_LAYOUT__;
const pie = globalThis.__DASH_PIE__;
const more = globalThis.__DASH_MORE__;

const narrow = { width: 240, height: 200 };
const normal = { width: 420, height: 300 };
const wide = { width: 1280, height: 320 };
const tall = { width: 360, height: 860 };
const huge = { width: 1400, height: 980 };

function pieSpec(size, extra = {}) {
  return { ...size, hole: 42, outer: 75, showLabels: true, showLegend: true, legendPosition: 'bottom', ...extra };
}

// ── 饼图：窄 / 普通保持贴边；超宽标签收回来；超高图例离开底边；巨大时半径封顶 ──
{
  const small = layout.pieFrame(pieSpec(narrow));
  const mid = layout.pieFrame(pieSpec(normal));
  for (const frame of [small, mid]) {
    assert.equal(frame.mode, 'legacy');
    assert.equal(frame.label.alignTo, 'edge');
    assert.equal(frame.label.edgeDistance, 6);
    assert.deepEqual(frame.center, ['50%', '44%']);
    assert.equal(frame.legend.bottom, 0);
    assert.deepEqual(frame.radius, pie.pieRadii(42, 75, true).map((n) => `${n}%`));
  }
  assert.equal(layout.pieFrame(pieSpec({ width: 0, height: 0 })).mode, 'legacy', '还没量到尺寸时按原来的百分比排');

  const widePie = layout.pieFrame(pieSpec(wide));
  const [holePct, outerPct] = pie.pieRadii(42, 75, true);
  const natural = Math.round((outerPct / 100) * (Math.min(wide.width, wide.height) / 2));
  assert.equal(widePie.mode, 'framed');
  assert.equal(widePie.label.alignTo, 'labelLine');
  assert.ok(widePie.labelLine.length <= 14 && widePie.labelLine.length2 <= 14, '引线要有上限');
  assert.equal(widePie.radius[1], Math.min(natural, layout.MAX_PIE_RADIUS));
  assert.ok(Math.abs(widePie.center[0] - wide.width / 2) < 8, '宽卡片里饼要水平居中');
  assert.equal(widePie.legend.bottom, 0, '高度并不多余时，底部图例仍贴着底，避免把饼顶上去');
  assert.notEqual(widePie.legend.right, 0);

  const wideRight = layout.pieFrame(pieSpec(wide, { legendPosition: 'right' }));
  assert.equal(typeof wideRight.legend.left, 'number');
  assert.ok(wideRight.legend.left > wide.width * 0.25, '图例要跟着饼往中间收');
  assert.ok(wideRight.legend.left + wideRight.legend.width < wide.width - 80, '图例不能贴在卡片右缘');
  assert.ok(wideRight.center[0] < wide.width / 2);
  const groupLeft = wideRight.center[0] - wideRight.radius[1] - 92;
  const groupRight = wideRight.legend.left + wideRight.legend.width;
  assert.ok(Math.abs((groupLeft + groupRight) / 2 - wide.width / 2) < 12, '饼和图例要作为一组居中');

  const tallPie = layout.pieFrame(pieSpec(tall));
  assert.equal(tallPie.mode, 'framed');
  assert.equal(tallPie.label.alignTo, 'edge', '宽度还紧的时候标签仍贴边，不比现在差');
  assert.equal(typeof tallPie.legend.top, 'number');
  assert.equal(tallPie.legend.bottom, undefined);
  assert.ok(Math.abs(tallPie.center[1] - tall.height / 2) < tall.height * 0.12, '超高时饼要靠近垂直中央');

  const hugePie = layout.pieFrame(pieSpec(huge));
  assert.equal(hugePie.radius[1], layout.MAX_PIE_RADIUS);
  assert.equal(hugePie.label.alignTo, 'labelLine');
  assert.equal(typeof hugePie.center[0], 'number');
  assert.equal(typeof hugePie.center[1], 'number');
  assert.equal(hugePie.legend.bottom, undefined);
  const inner = Math.round(layout.MAX_PIE_RADIUS * holePct / outerPct);
  assert.ok(Math.abs(hugePie.radius[0] - inner) <= 1, '封顶时内圈按同一比例收，环不能被压成一条线');
  assert.equal(layout.pieFrame(pieSpec(huge, { hole: 0, outer: 75 })).radius[0], 0, '实心饼保持实心');

  const rightNormal = layout.pieFrame(pieSpec(normal, { legendPosition: 'right' }));
  assert.equal(rightNormal.mode, 'legacy');
  assert.equal(rightNormal.legend.right, 0);
  assert.deepEqual(rightNormal.center, ['40%', '50%']);
}

// ── 柱状 / 折线 / 散点 / 热力 / 瀑布：绘图区封顶并居中，窄的边距不动 ──
{
  const pad = { left: 12, right: 16, top: 18, bottom: 8 };
  const snug = layout.cartesianGrid({ ...pad, ...normal });
  assert.equal(snug.left, 12);
  assert.equal(snug.right, 16);
  assert.equal(snug.top, 18);
  assert.equal(snug.bottom, 8);
  assert.deepEqual(layout.cartesianLegend(snug, pad), { top: 0, right: 8 });
  assert.deepEqual(layout.placeZoom(snug, pad, 'x'), { bottom: 4 });

  const wideGrid = layout.cartesianGrid({ ...pad, ...wide });
  assert.ok(Math.abs(wideGrid.plotWidth - layout.MAX_PLOT_W) < 1);
  assert.ok(Math.abs((wideGrid.left - pad.left) - (wideGrid.right - pad.right)) < 1, '左右多出来的边距要一样，图才在正中');
  assert.equal(wideGrid.top, pad.top, '只是变宽时，上下边距不动');
  assert.ok(layout.cartesianLegend(wideGrid, pad).right > 40);

  const tallGrid = layout.cartesianGrid({ ...pad, ...tall });
  assert.ok(Math.abs(tallGrid.plotHeight - layout.MAX_PLOT_H) < 1);
  assert.ok(Math.abs((tallGrid.top - pad.top) - (tallGrid.bottom - pad.bottom)) < 1);
  assert.equal(tallGrid.left, pad.left);
  assert.ok(layout.placeZoom(tallGrid, pad, 'x').bottom > 4, '超高时缩放条跟着绘图区，不留在卡片底边');

  const unknown = layout.cartesianGrid({ ...pad, width: 0, height: 0 });
  assert.equal(unknown.left, 12);
  assert.equal(unknown.plotWidth, 0);
}

// ── 轴标签：窄的不抽稀、字号不放大；宽了才按能放下的个数间隔 ──
{
  assert.deepEqual(layout.categoryAxis({ span: 240, count: 20 }), { interval: 0, hideOverlap: true, fontSize: 10 });
  assert.deepEqual(layout.categoryAxis({ span: 500, count: 30 }), { interval: 0, hideOverlap: true, fontSize: 10 });
  const roomy = layout.categoryAxis({ span: 880, count: 40 });
  assert.equal(roomy.fontSize, 12);
  assert.ok(roomy.interval > 0);
  assert.equal(layout.categoryAxis({ span: 880, count: 6 }).interval, 0, '放得下就别藏标签');
  assert.equal(layout.barThickness(0, 4), 30);
  assert.equal(layout.barThickness(400, 6), 30, '普通宽度的柱宽维持 30');
  const thick = layout.barThickness(880, 4);
  assert.ok(thick > 30 && thick <= 48);
}

// ── 雷达按短边，只有短边大过上限才改成像素；矩形树超宽超高才缩成一块居中 ──
{
  assert.equal(layout.radarFrame({ ...narrow, hasLegend: true }).radius, '58%');
  assert.equal(layout.radarFrame({ ...wide, hasLegend: false }).radius, '58%', '宽但矮时短边没变，百分比半径已经是按短边的');
  const bigRadar = layout.radarFrame({ ...huge, hasLegend: true });
  assert.equal(bigRadar.radius, layout.MAX_RADAR);
  assert.ok(Math.abs(bigRadar.center[0] - huge.width / 2) < 2);
  assert.ok(bigRadar.legendTop > 0, '图例跟着雷达，不贴在超高卡片的顶上');

  assert.deepEqual(
    layout.treemapFrame({ ...normal, breadcrumb: false }),
    { left: 0, top: 0, right: 0, bottom: 0, breadcrumbBottom: 0 },
  );
  assert.deepEqual(
    layout.treemapFrame({ ...narrow, breadcrumb: true }),
    { left: 0, top: 0, right: 0, bottom: 24, breadcrumbBottom: 0 },
  );
  const wideTree = layout.treemapFrame({ ...wide, breadcrumb: false });
  assert.ok(wideTree.left > 40 && Math.abs(wideTree.left - wideTree.right) < 2);
  assert.ok(wide.width - wideTree.left - wideTree.right <= layout.MAX_TREE);
  const tallTree = layout.treemapFrame({ ...tall, breadcrumb: true });
  assert.ok(tallTree.top > 40 && tallTree.bottom > tallTree.top);
  assert.ok(tallTree.breadcrumbBottom > 0, '面包屑跟着矩形树，不掉在卡片底边');
}

// ── KPI / 排行榜：普通宽度不设 max-width；超宽才收拢居中 ──
{
  assert.deepEqual(layout.flowFrame({ kind: 'kpi', ...narrow, count: 2 }), { maxWidth: null, maxHeight: null, centerX: false, centerY: false });
  const wideKpi = layout.flowFrame({ kind: 'kpi', ...wide, count: 2 });
  assert.equal(wideKpi.centerX, true);
  assert.equal(wideKpi.maxWidth, 700);
  assert.equal(wideKpi.centerY, false);
  const tallKpi = layout.flowFrame({ kind: 'kpi', width: 400, height: 700, count: 1 });
  assert.equal(tallKpi.centerX, false, '不宽的 KPI 不要左右留白');
  assert.equal(tallKpi.centerY, true);
  assert.equal(tallKpi.maxHeight, 220);
  const wideRank = layout.flowFrame({ kind: 'ranking', ...wide, count: 8 });
  assert.equal(wideRank.centerX, true);
  assert.equal(wideRank.maxWidth, 560);
  assert.equal(wideRank.centerY, false);
  assert.equal(layout.flowFrame({ kind: 'ranking', width: 280, height: 400, count: 8 }).centerX, false);
  assert.deepEqual(layout.flowFrame({ kind: 'kpi', width: 0, height: 0, count: 3 }), { maxWidth: null, maxHeight: null, centerX: false, centerY: false });
}

// ── 散点 / 雷达 / 热力 / 矩形树 / 瀑布读的是同一份布局，颜色仍由调用方传入 ──
{
  const sum = (rows, i) => rows.reduce((s, r) => s + Number(r[2 + i] ?? 0), 0);
  const input = (rows, extra = {}) => ({
    rows, dims: [0], series: -1,
    measures: [{ name: '金额' }, { name: '单量' }, { name: '人数' }],
    agg: sum, fmt: (i, v) => String(v),
    palette: ['#111111', '#222222', '#333333'],
    theme: { muted: '#888', border: '#ddd', surface: '#fff', text: '#111', accent: '#4d8dff' },
    opts: { topN: 0, showLegend: true }, animation: false, ...extra,
  });
  const rows = [['A', null, 10, 1, 5], ['B', null, 20, 3, 20]];
  const plain = more.scatter(input(rows));
  assert.deepEqual(
    { left: plain.grid.left, right: plain.grid.right, top: plain.grid.top, bottom: plain.grid.bottom },
    { left: 16, right: 20, top: 14, bottom: 26 },
    '不传尺寸时散点边距和原来一样',
  );
  const wideScatter = more.scatter(input(rows, { box: wide }));
  assert.ok(wideScatter.grid.left > 16 && Math.abs((wideScatter.grid.left - 16) - (wideScatter.grid.right - 20)) < 1);
  assert.equal(wideScatter.xAxis.axisLabel.fontSize, 12);

  const radarRows = [['A', null, 1000, 0.2, 7], ['B', null, 500, 0.5, 9]];
  assert.equal(more.radar(input(radarRows, { box: narrow })).radar.radius, '58%');
  assert.equal(more.radar(input(radarRows, { box: huge })).radar.radius, layout.MAX_RADAR);

  const heatRows = [['周一', '早', 1], ['周一', '晚', 2], ['周二', '早', 3]];
  const heat = more.heatmap(input(heatRows, { series: 1, measures: [{ name: '单量' }], box: { width: 1400, height: 860 } }));
  assert.ok(heat.grid.left > 8 && heat.grid.top > 8);
  assert.equal(heat.visualMap.bottom > 0, true);

  const tree = more.treemap(input([['华北', '北京', 50], ['华东', '上海', 40]], { dims: [0, 1], measures: [{ name: '金额' }], box: wide }));
  assert.ok(tree.series[0].left > 40 && tree.series[0].right > 40);

  const fall = more.waterfall(input([['收入', null, 100], ['成本', null, -30]], { box: { width: 1400, height: 320 } }));
  assert.ok(fall.grid.left > 12);
  assert.ok(fall.series[0].barMaxWidth >= 36 && fall.series[0].barMaxWidth <= 48);
}

// 布局模块自己不写死颜色。主题色走调用方读到的 --chart-* / --text-*。
{
  const src = readFileSync('src/features/dashboard/chartLayout.runtime.js', 'utf8');
  assert.equal(src.match(/#[0-9a-fA-F]{3,8}\b/g), null, '布局计算里不该出现色值');
  const widget = readFileSync('src/features/dashboard/widgets/ChartWidget.tsx', 'utf8');
  assert.match(widget, /pieFrame\(/);
  assert.match(widget, /cartesianGrid\(/);
  assert.match(widget, /co\.palette && co\.palette\.length \? co\.palette : chartPalette/);
  assert.doesNotMatch(widget, /PIE_LABEL/);
}

console.log('chart layout: ok');
