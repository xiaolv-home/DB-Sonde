#!/usr/bin/env node
/* 霜主题 --text-3 必须在它实际会被画上去的底色上达到 WCAG AA 4.5:1。
 *
 * 这些底色都是 tokens.css 里霜（:root[data-theme="light"]）的变量，
 * 对应样式里 color: var(--text-3) 真正落上去的填充，而不是整张色板：
 *   --bg           主背景、对象工作区
 *   --surface      侧栏、卡片、面板、输入框、结果区
 *   --surface-2    行悬停、表头、次级底、搜索条
 *   --surface-3    侧栏角标、行号悬停、选区 / 编辑浮条（最深的一块，也是最吃紧的）
 *   --header       工具栏、状态栏、标签栏
 *   --popover      菜单
 *   --accent-soft  选中的树行、编辑器列表、画布文档
 *   --sel          选中的空单元格
 *   --dirty        待保存的空单元格
 * 色相保持冷灰，并且要比 --text-2 浅。墨、纸不在这里改。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const tokens = readFileSync('src/styles/tokens.css', 'utf8');

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

const frost = block(':root[data-theme="light"]');
const text3 = frost['text-3'];
const text2 = frost['text-2'];
assert.match(text3, /^#[0-9a-f]{6}$/i, `霜 --text-3 应是 6 位色值，实际是 ${text3}`);
assert.match(text2, /^#[0-9a-f]{6}$/i, `霜 --text-2 应是 6 位色值，实际是 ${text2}`);

const backgrounds = ['bg', 'surface', 'surface-2', 'surface-3', 'header', 'popover', 'accent-soft', 'sel', 'dirty'];
for (const key of backgrounds) {
  const bg = frost[key];
  assert.match(bg, /^#[0-9a-f]{6}$/i, `霜 --${key} 应是 6 位色值，实际是 ${bg}`);
  const ratio = contrast(text3, bg);
  assert.ok(ratio >= 4.5, `霜 --text-3 ${text3} 在 --${key} ${bg} 上对比度 ${ratio.toFixed(2)}:1，低于 4.5:1`);
}

assert.ok(luminance(text3) > luminance(text2), `霜 --text-3 ${text3} 应该比 --text-2 ${text2} 浅`);

console.log('frost text-3 contrast ok');
