/* 图表 / 看板 / 导出的颜色跟着当前主题,不再各写一套。
 *
 * 锁两件事:
 *   1. 三套主题下取到的系列色、奖牌色各不相同,并且就是 tokens.css 里写的那组;
 *   2. 取色的那几个文件不再残留写死的主题色(白字压在色块上的 #fff 不算)。 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const read = (p) => readFileSync(p, 'utf8');
const tokens = read('src/styles/tokens.css');

function block(selector) {
  const at = tokens.indexOf(`${selector} {`);
  assert.ok(at >= 0, `tokens.css 缺少 ${selector}`);
  const body = tokens.slice(at, tokens.indexOf('\n}', at));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [`--${m[1]}`, m[2].trim()]));
}

const inkBlock = block(':root');
const frostBlock = block(':root[data-theme="light"]');
const paperBlock = block(':root[data-theme="light"][data-palette="paper"]');
const ink = { ...inkBlock };
const frost = { ...ink, ...frostBlock };
const paper = { ...frost, ...paperBlock };
const themes = { 墨: ink, 霜: frost, 纸: paper };
const own = { 墨: inkBlock, 霜: frostBlock, 纸: paperBlock };

const seriesKeys = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-7', '--chart-8'];
const medalKeys = ['--medal-1', '--medal-2', '--medal-3'];
for (const [name, raw] of Object.entries(own)) {
  for (const key of [...seriesKeys, ...medalKeys]) assert.ok(raw[key], `${name} 自己的色板里没有 ${key},会漏出别的主题`);
}
for (const key of [...seriesKeys, ...medalKeys]) {
  const values = [ink[key], frost[key], paper[key]];
  assert.equal(new Set(values).size, 3, `${key} 三套主题应该各不相同,现在是 ${values.join(' / ')}`);
}

const dir = mkdtempSync(join(tmpdir(), 'sonde-theme-'));
try {
  const outfile = join(dir, 'colors.cjs');
  await build({
    entryPoints: [resolve('src/lib/themeColors.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
  });
  const api = createRequire(import.meta.url)(outfile);
  const sourceOf = (map) => ({ getPropertyValue: (name) => map[name] ?? '' });

  const palettes = {};
  for (const [name, map] of Object.entries(themes)) {
    const got = api.chartPalette(sourceOf(map));
    const medals = api.medalColors(sourceOf(map));
    assert.deepEqual(got, seriesKeys.map((key) => map[key]), `${name} 的系列色和 tokens.css 不一致`);
    assert.deepEqual(medals, medalKeys.map((key) => map[key]), `${name} 的奖牌色和 tokens.css 不一致`);
    const declared = api.themeDeclarations(sourceOf(map));
    assert.ok(declared.includes(`--bg: ${map['--bg']};`), `${name} 的导出快照没写进当时的底色`);
    assert.ok(declared.includes(`--chart-1: ${map['--chart-1']};`), `${name} 的导出快照没写进系列色`);
    assert.ok(!declared.includes('var('), '导出快照应该是算好的色值,不能再套一层变量');
    const page = api.applyThemeSnapshot(':root { /*__THEME__*/ } .x { color: var(--text); }', sourceOf(map));
    assert.ok(page.includes(`--text: ${map['--text']};`), `${name} 的页面样式没换成实际色值`);
    assert.ok(!page.includes('/*__THEME__*/'), '占位没被换掉');
    palettes[name] = got;
  }
  assert.notDeepEqual(palettes['墨'], palettes['霜']);
  assert.notDeepEqual(palettes['霜'], palettes['纸']);
  assert.notDeepEqual(palettes['墨'], palettes['纸']);

  const html = read('src/features/dashboard/export/htmlExport.ts');
  assert.match(html, /applyThemeSnapshot\(STANDALONE_CSS/, '离线页面要把导出时的色值写进去');
  assert.ok(html.includes('/*__THEME__*/'), '离线样式要留出填色的位置');
  assert.ok(!html.includes('prefers-color-scheme'), '离线页面不能再跟着系统深浅色变');

  assert.match(read('src/components/ChartView.tsx'), /\[columns, rows, chartX, chartY, theme\]/, '查询图换主题要重画');
  assert.match(read('src/features/dashboard/widgets/ChartWidget.tsx'), /co\.palette && co\.palette\.length \? co\.palette : chartPalette/, '看板上用户设过的配色要留着');
  assert.match(read('src/features/dashboard/widgets/MoreChartWidget.tsx'), /co\.palette\?\.length \? co\.palette : chartPalette/);
  assert.match(read('src/features/dashboard/export/standalone.runtime.js'), /if \(co && co\.palette && co\.palette\.length\) return co\.palette\.slice\(\)/, '导出页和看板用同一条规则:用户色优先');
  assert.match(read('src/features/dashboard/widgets/ChartWidget.tsx'), /useApp\(\(state\) => state\.theme\)/);
  assert.match(read('src/features/dashboard/widgets/GaugeWidget.tsx'), /useApp\(\(state\) => state\.theme\)/);
  assert.match(read('src/features/canvas/canvasExport.ts'), /chartChrome\(\)/);
  assert.match(read('src/features/canvas/canvasHtml.ts'), /pageCss\(chrome\)/);

  const files = [
    'src/components/ChartView.tsx',
    'src/features/dashboard/domain.ts',
    'src/features/dashboard/export/htmlExport.ts',
    'src/features/dashboard/export/standalone.runtime.js',
    'src/features/dashboard/widgets/ChartWidget.tsx',
    'src/features/dashboard/widgets/GaugeWidget.tsx',
    'src/features/dashboard/widgets/MoreChartWidget.tsx',
    'src/features/dashboard/studio/StylePanel.tsx',
    'src/features/dashboard/moreCharts.runtime.js',
    'src/features/dashboard/dashboard.css',
    'src/features/canvas/canvasExport.ts',
    'src/features/canvas/canvasHtml.ts',
    'src/features/canvas/canvasVideo.ts',
  ];
  const allowHex = new Set(['#fff', '#ffffff', '#000', '#000000']);
  for (const file of files) {
    const src = read(file);
    for (const hit of src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []) {
      assert.ok(allowHex.has(hit.toLowerCase()), `${file} 还写死了主题色 ${hit}`);
    }
    for (const hit of src.matchAll(/rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)/g)) {
      const [r, g, b] = [hit[1], hit[2], hit[3]].map(Number);
      assert.ok(r === 0 && g === 0 && b === 0, `${file} 还写死了颜色 ${hit[0]}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('theme colors ok');
