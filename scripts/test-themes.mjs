#!/usr/bin/env node
/* 三套主题的硬指标 + 手感相关的几条底线。
 *
 * 配色好不好看测不出来,但「眼睛累」的成因是能量的:深色主题字太亮、线太亮;
 * 「廉价」的成因也能查:回弹曲线、毛玻璃、辉光又被加回来。 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const read = (p) => readFileSync(p, 'utf8');
const tokens = read('src/styles/tokens.css');

function block(selector) {
  const at = tokens.indexOf(`${selector} {`);
  assert.ok(at >= 0, `tokens.css 缺少 ${selector}`);
  const body = tokens.slice(at, tokens.indexOf('\n}', at));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
const saturation = (hex) => {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const max = Math.max(...v);
  return max === 0 ? 0 : (max - Math.min(...v)) / max;
};

const dark = block(':root');
const frost = block(':root[data-theme="light"]');
const paper = block(':root[data-theme="light"][data-palette="paper"]');
const palettes = { 墨: dark, 霜: frost, 纸: paper };

// 每套都要把会变的颜色定义全,漏一个就会露出别的主题的色
const required = ['bg', 'surface', 'surface-2', 'surface-3', 'header', 'popover', 'border', 'border-2', 'grid-line', 'scrim',
  'text', 'text-2', 'text-3', 'accent', 'accent-2', 'accent-ink', 'accent-soft', 'accent-border',
  'green', 'red', 'red-ink', 'amber', 'sel', 'dirty', 'shadow', 'shadow-sm',
  'c-connection', 'c-database', 'c-table', 'c-schema', 'c-view', 'c-procedure', 'c-function',
  'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6', 'chart-7', 'chart-8',
  'medal-1', 'medal-2', 'medal-3'];
for (const [name, p] of Object.entries(palettes)) {
  for (const key of required) assert.ok(p[key], `${name} 缺 --${key}`);
  // 看得清
  for (const bg of [p.bg, p.surface]) {
    assert.ok(contrast(p.text, bg) >= 9, `${name} 正文对比度不够`);
    assert.ok(contrast(p['text-2'], bg) >= 4.5, `${name} 次要文字对比度不够`);
    assert.ok(contrast(p['text-3'], bg) >= 3.8, `${name} 弱文字对比度不够`);
  }
  assert.ok(contrast(p['accent-ink'], p.accent) >= 4.5, `${name} 主按钮文字看不清`);
  assert.ok(contrast(p['red-ink'], p.red) >= 4.5, `${name} 危险按钮文字看不清`);
  // 表格线必须比边框更不显眼,否则满屏都是网
  assert.ok(contrast(p['grid-line'], p.bg) < contrast(p.border, p.bg), `${name} 网格线不能比边框亮`);
}

// 深色不刺眼:这几条就是之前眼睛累的原因,放回去要报错
assert.ok(contrast(dark.text, dark.bg) <= 12, '深色正文对比度太高,会刺眼');
assert.ok(luminance(dark.bg) >= 0.008, '深色底太接近纯黑');
assert.ok(contrast(dark.border, dark.bg) <= 1.3, '深色边框太亮');
for (const key of ['accent', 'green', 'red', 'amber', 'c-table', 'c-database', 'c-procedure']) {
  assert.ok(saturation(dark[key]) <= 0.55, `深色 --${key} 太艳`);
}
// 纸是暖色:红通道要明显高于蓝通道
const warm = (hex) => parseInt(hex.slice(1, 3), 16) - parseInt(hex.slice(5, 7), 16);
assert.ok(warm(paper.bg) >= 6 && warm(paper.surface) >= 6, '「纸」应该是暖色');
assert.ok(warm(frost.bg) <= 0, '「霜」应该是冷色');

// 主题机制:DOM 只暴露明暗 + 调色板,所有「亮暗不同」的规则不用改
const src = read('src/store/themes.ts');
assert.ok(/id: "dark"/.test(src) && /id: "light"/.test(src) && /id: "paper"/.test(src), '要有三套主题');
assert.match(src, /root\.removeAttribute\("data-palette"\)/, '切回其他主题要清掉 data-palette');
assert.match(read('src/features/canvas/CanvasEditor.tsx'), /colorMode=\{themeBase\(theme\)\}/, '画布只认 dark/light,不能把 paper 传进去');
assert.match(read('src/features/canvas/CanvasWindow.tsx'), /isTheme\(e\.newValue\)/, '画布窗口要能跟上第三套主题');
assert.match(read('src/store/shellSlice.ts'), /readStoredText<Theme>\("theme", "dark", isTheme\)/, '存下来的主题要按三套校验');

// 手感底线
function* cssFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* cssFiles(p);
    else if (name.endsWith('.css')) yield p;
  }
}
for (const file of cssFiles('src')) {
  const css = read(file);
  assert.ok(!/cubic-bezier\([^)]*,\s*1\.\d+/.test(css), `${file} 有过冲回弹曲线`);
  // 看板预设里的毛玻璃是用户可选的部件样式,不算界面本身
  if (!file.endsWith('presets.css')) assert.ok(!/(^|[\s;{-])backdrop-filter:/.test(css), `${file} 又用了毛玻璃`);
}
const results = read('src/styles/results.css');
for (const rule of ['.g-row {', '.g-cell {']) {
  const at = results.indexOf(rule);
  assert.ok(!results.slice(at, results.indexOf('}', at)).includes('transition'), `${rule} 不能有过渡,扫过去会拖尾`);
}
assert.ok(!/\.toast \{[^}]*transform:\s*translateX/.test(read('src/styles/shell.css')), '提示条不能靠 translateX 居中,进场动画也要动 transform');

// 拖动:一帧只处理一次、松手落在最后的位置、localStorage 不逐帧写
const { perFrame } = await (async () => {
  const code = read('src/hooks/useDrag.ts');
  const at = code.indexOf('export function perFrame');
  const fn = code.slice(at, code.indexOf('\n}\n', at) + 3).replace('export function', 'function')
    .replace('<A extends unknown[]>', '').replace('(fn: (...args: A) => void)', '(fn)')
    .replace('let latest: A | null = null', 'let latest = null').replace('(...args: A)', '(...args)');
  return { perFrame: new Function('requestAnimationFrame', `${fn}; return perFrame;`) };
})();
{
  const queue = [];
  const apply = [];
  const f = perFrame((cb) => (queue.push(cb), queue.length))((v) => apply.push(v));
  f(1); f(2); f(3);
  assert.deepEqual(apply, [], '要等到下一帧');
  queue.splice(0).forEach((cb) => cb?.());
  assert.deepEqual(apply, [3], '一帧只处理最新的');
  f(4); f(5);
  f.flush();
  assert.deepEqual(apply, [3, 5], '松手要落在最后的位置');
  queue.splice(0).forEach((cb) => cb?.());
  assert.deepEqual(apply, [3, 5], 'flush 之后不能再触发一次');
}
const shell = read('src/store/shellSlice.ts');
assert.ok(!/writeStoredText\("(sidebarWidth|resultHeight|pyOutputHeight)"/.test(shell), '拖分隔条不能逐帧写 localStorage');

console.log('themes ok');
