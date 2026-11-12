// 看板纯图标按钮:读屏名称和 title 是同一句中文,作用在某个对象上时带上对象名。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const files = {
  canvas: 'src/features/dashboard/components/DashboardCanvas.tsx',
  bar: 'src/features/dashboard/studio/StudioBar.tsx',
  fields: 'src/features/dashboard/studio/FieldPanel.tsx',
  inspector: 'src/features/dashboard/studio/Inspector.tsx',
  shelf: 'src/features/dashboard/studio/Shelf.tsx',
  style: 'src/features/dashboard/studio/StylePanel.tsx',
  table: 'src/features/dashboard/components/DashboardTable.tsx',
  dates: 'src/features/dashboard/components/DateRangePicker.tsx',
  multi: 'src/features/dashboard/components/V1MultiSelect.tsx',
  chart: 'src/features/dashboard/widgets/ChartWidget.tsx',
  workspace: 'src/features/dashboard/DashboardWorkspace.tsx',
  banner: 'src/features/dashboard/components/AiProvenanceBanner.tsx',
  kit: 'src/components/StudioKit.tsx',
};
const src = Object.fromEntries(Object.entries(files).map(([key, path]) => [key, readFileSync(path, 'utf8')]));

function buttons(text) {
  return [...text.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => m[0]);
}

/** 有中文(或插值出来的文字)就算看得见的名称;纯图标必须走 iconName / aria-label。 */
function hasName(block) {
  if (/\{\.\.\.iconName\(/.test(block) || /\baria-label=/.test(block)) return true;
  const inner = block.replace(/^<button\b[\s\S]*?>/, '').replace(/<\/button>$/, '');
  const noIcons = inner.replace(/<[A-Z][\w.]*\b[^>]*\/>/g, '');
  if (/[\p{Script=Han}]/u.test(noIcons)) return true;
  if (/\{[A-Za-z_{]/.test(noIcons)) return true;
  return false;
}

const iconNameFn = /function iconName\(label: string\) \{\s*return \{ title: label, "aria-label": label \};/;
for (const key of ['canvas', 'bar', 'fields', 'inspector', 'shelf', 'style', 'table', 'dates', 'multi', 'chart', 'kit']) {
  assert.match(src[key], iconNameFn, `${files[key]} 的 iconName 应同时给出 title 和 aria-label`);
}

const counts = {
  canvas: 9, bar: 13, fields: 5, inspector: 10, shelf: 5, style: 15,
  table: 3, dates: 12, multi: 2, chart: 3, workspace: 1, banner: 1, kit: 9,
};
const lists = {};
for (const [key, text] of Object.entries(src)) {
  lists[key] = buttons(text);
  assert.equal(lists[key].length, counts[key], `${files[key]} 增减了按钮,名称清单要一起改`);
  for (const block of lists[key]) assert.ok(hasName(block), `${files[key]} 按钮没有名称:\n${block}`);
}

function one(list, re) {
  const hit = list.filter((block) => re.test(block));
  assert.equal(hit.length, 1, `${re} 应恰好命中一个按钮,实际 ${hit.length}`);
  return hit[0];
}

function many(list, re, n) {
  const hit = list.filter((block) => re.test(block));
  assert.equal(hit.length, n, `${re} 应命中 ${n} 个按钮,实际 ${hit.length}`);
  return hit;
}

function locksIcon(block, labelExpr) {
  assert.match(block, new RegExp(`\\{\\.\\.\\.iconName\\(${labelExpr}\\)\\}`));
  assert.doesNotMatch(block, /\btitle=/);
  assert.doesNotMatch(block, /\baria-label=/);
}

// 组件卡片:拖动 / 调整大小 / 复制 / 显隐 / 删除 / 导出
for (const block of many(lists.canvas, /className="dash-drag"/, 2)) locksIcon(block, '`拖动组件 \\$\\{widget\\.title\\}`');
for (const block of many(lists.canvas, /className="dash-resize"/, 2)) locksIcon(block, '`调整组件 \\$\\{widget\\.title\\} 的大小`');
locksIcon(one(lists.canvas, /exportChartPng/), '`导出组件 \\$\\{widget\\.title\\} 为 PNG`');
locksIcon(one(lists.canvas, /onDuplicate/), '`复制组件 \\$\\{widget\\.title\\}`');
locksIcon(one(lists.canvas, /onDelete\(widget\.id\)/), '`删除组件 \\$\\{widget\\.title\\}`');
const hide = one(lists.canvas, /onToggle/);
locksIcon(hide, 'widget\\.visible \\? `隐藏组件 \\$\\{widget\\.title\\}` : `显示组件 \\$\\{widget\\.title\\}`');
assert.match(hide, /aria-pressed=\{widget\.visible\}/);
const tab = one(lists.canvas, /tab\.label/);
assert.match(tab, /aria-pressed=\{tab\.id === activeTab\}/);
assert.match(tab, />\{tab\.label\}<\/button>/);

// 看板工具条
const pages = one(lists.bar, /className=\{`st-pages/);
locksIcon(pages, '`切换看板 \\$\\{doc\\.title\\}`');
assert.match(pages, /aria-haspopup="menu"/);
assert.match(pages, /aria-expanded=\{!!pages\}/);
locksIcon(one(lists.bar, /onUndo/), '"撤销 \\(⌘Z\\)"');
locksIcon(one(lists.bar, /onClearScope/), '"不按日期筛\\(看全部\\)"');
locksIcon(one(lists.bar, /onRefresh/), '"重新取数"');
const addFilter = one(lists.bar, /st-add-filter/);
locksIcon(addFilter, '"加一个看板筛选:所有含这个字段的组件一起筛"');
assert.match(addFilter, /aria-haspopup="menu"/);
assert.match(addFilter, /aria-expanded=\{!!adding\}/);
const addWidget = one(lists.bar, /st-add /);
assert.match(addWidget, /aria-haspopup="menu"/);
assert.match(addWidget, /aria-expanded=\{!!add\}/);
assert.match(addWidget, /添加组件/);
const more = one(lists.bar, /MoreHorizontal/);
assert.match(more, /aria-haspopup="menu"/);
assert.match(more, /aria-expanded=\{!!more\}/);
assert.match(more, /更多/);
const preview = one(lists.bar, /onPreview/);
assert.match(preview, /aria-pressed=\{p\.preview\}/);
assert.match(preview, /查看效果/);
assert.match(preview, /回到编辑/);
const chip = one(lists.bar, /st-chip-label/);
assert.match(chip, /aria-haspopup="menu"/);
assert.match(chip, /aria-expanded=\{!!anchor\}/);

// 字段面板:展开 / 收起是一对
const rail = one(lists.workspace, /st-fields-rail/);
assert.match(rail, /title="展开字段面板"/);
assert.match(rail, /aria-label="展开字段面板"/);
assert.match(rail, /aria-expanded=\{false\}/);
const collapse = one(lists.fields, /onCollapse/);
locksIcon(collapse, '"收起字段面板"');
assert.match(collapse, /aria-expanded=\{true\}/);
const pick = one(lists.fields, /st-ds-pick/);
assert.match(pick, /aria-haspopup="menu"/);
assert.match(pick, /aria-expanded=\{!!pick\}/);
locksIcon(one(lists.fields, /edit\(dataset\.id\)/), '`编辑数据集 \\$\\{dataset\\.name \\|\\| "未命名数据集"\\}`');
assert.match(one(lists.fields, /st-field /), /aria-pressed=\{on\}/);

// 检查器 / 字段区 / 样式
locksIcon(one(lists.inspector, /onDelete\(widget\.id\)/), '`删除组件 \\$\\{widget\\.title\\}`');
locksIcon(one(lists.inspector, /drillDimensions/), '`去掉下钻层 \\$\\{fieldLabel\\(dataset, d\\)\\}`');
locksIcon(one(lists.inspector, /删除分组/), '`删除分组 \\$\\{g\\.label\\}`');
const addDrill = one(lists.inspector, /st-drill-add/);
assert.match(addDrill, /aria-haspopup="menu"/);
assert.match(addDrill, /aria-expanded=\{!!addDrill\}/);
assert.match(one(lists.inspector, /toggleViewer/), /aria-pressed=\{filterFields\.includes\(f\.name\)\}/);
assert.match(one(lists.inspector, /metricIds\.includes/), /aria-pressed=\{g\.metricIds\.includes\(m\.id\)\}/);
locksIcon(one(lists.shelf, /st-pill-x/), '`移除 \\$\\{fieldLabel\\(dataset, name\\)\\}`');
const addField = one(lists.shelf, /st-shelf-add/);
locksIcon(addField, '`添加到\\$\\{shelfTitle\\(widget\\.type, shelf\\)\\}`');
assert.match(addField, /aria-haspopup="menu"/);
assert.match(addField, /aria-expanded=\{!!anchor\}/);
assert.match(one(lists.shelf, /AGG_LABELS/), /aria-pressed=\{a === agg\}/);
assert.match(one(lists.shelf, /GRAIN_LABELS/), /aria-pressed=\{g === grain\}/);
assert.match(one(lists.shelf, /CONDITION_OPS\[op\]/), /aria-pressed=\{op === condition\.op\}/);
locksIcon(one(lists.style, /删除分页/), '`删除分页 \\$\\{tab\\.label\\}`');
locksIcon(one(lists.style, /line\.label\?\.trim/), 'line\\.label\\?\\.trim\\(\\) \\? `删除参考线 \\$\\{line\\.label\\.trim\\(\\)\\}` : `删除第 \\$\\{i \\+ 1\\} 条参考线`');
locksIcon(one(lists.style, /删除第 \$\{i \+ 1\} 种颜色/), '`删除第 \\$\\{i \\+ 1\\} 种颜色`');
locksIcon(one(lists.style, /st-swatch-add/), '"加一种颜色"');
assert.match(one(lists.style, /st-preset none/), /aria-pressed=\{!ap\.visualPreset \|\| ap\.visualPreset === "none"\}/);
assert.match(one(lists.style, /data-visual-preset/), /aria-pressed=\{ap\.visualPreset === p\.id\}/);

// 表格、日期、多选、下钻、配色
locksIcon(one(lists.table, /dash-dt-csv/), '"导出 Excel"');
locksIcon(one(lists.table, /curPage - 1/), '"上一页"');
locksIcon(one(lists.table, /curPage \+ 1/), '"下一页"');
for (const label of ['"上一年"', '"下一年"', '"往前 12 年"', '"往后 12 年"', '"上个月"', '"下个月"']) {
  locksIcon(one(lists.dates, new RegExp(`iconName\\(${label}\\)`)), label);
}
assert.match(one(lists.dates, /p\.label/), /aria-pressed=\{activePreset\?\.label === p\.label\}/);
assert.match(one(lists.dates, /setMode\(m\)/), /aria-pressed=\{mode === m\}/);
assert.match(src.dates, /aria-label="选择日期范围"/);
assert.match(src.dates, /aria-expanded=\{open\}/);
assert.match(src.dates, /aria-haspopup="dialog"/);
locksIcon(one(lists.multi, /<X size=\{11\}/), '`移除 \\$\\{labels\\.get\\(value\\) \\?\\? value\\}`');
assert.match(one(lists.multi, /option\.label/), /aria-pressed=\{selected\}/);
assert.match(src.multi, /aria-haspopup="listbox"/);
locksIcon(one(lists.chart, /className="back"/), '"返回上一层"');
locksIcon(one(lists.kit, /恢复默认/), '"恢复默认"');
assert.match(src.kit, /aria-expanded=\{open\}/);
assert.match(src.kit, /aria-label=\{typeof o\.label === "string" \? undefined : o\.title\}/);
assert.match(src.kit, /aria-pressed=\{selected\.includes\(v\)\}/);
assert.match(src.shelf, /label: <ArrowUpDown size=\{12\} \/>, title: "默认"/);

console.log('dashboard names: 纯图标按钮的中文名称 / 对象名 / 开关·展开·菜单状态 全部锁住');
