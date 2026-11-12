// 侧栏纯图标按钮:读屏名称和 title 是同一句中文,作用在某个对象上时带上对象名。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sidebar = readFileSync('src/components/Sidebar.tsx', 'utf8');
const tree = readFileSync('src/components/TreeRow.tsx', 'utf8');
const i18n = readFileSync('src/i18n.ts', 'utf8');

function buttons(src) {
  return [...src.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => m[0]);
}

function hasName(block) {
  if (/\{\.\.\.iconName\(/.test(block) || /\baria-label=/.test(block)) return true;
  const inner = block.replace(/^<button\b[\s\S]*?>/, '').replace(/<\/button>$/, '');
  return /\{t\(/.test(inner) || /\{s\.label\}/.test(inner) || />[^<{]*\S[^<]*</.test(inner);
}

const iconNameFn = /function iconName\(label: string\) \{\s*return \{ title: label, "aria-label": label \};/;
assert.match(sidebar, iconNameFn);
assert.match(tree, iconNameFn);

const sidebarButtons = buttons(sidebar);
assert.equal(sidebarButtons.length, 13, '侧栏增减了按钮,名称清单要一起改');
for (const block of sidebarButtons) assert.ok(hasName(block), `侧栏按钮没有名称:\n${block}`);

function one(list, re) {
  const hit = list.filter((block) => re.test(block));
  assert.equal(hit.length, 1, `${re} 应恰好命中一个按钮,实际 ${hit.length}`);
  return hit[0];
}

function locksIcon(block, labelExpr) {
  assert.match(block, new RegExp(`\\{\\.\\.\\.iconName\\(${labelExpr}\\)\\}`));
  assert.doesNotMatch(block, /\btitle=/);
  assert.doesNotMatch(block, /\baria-label=/);
}

locksIcon(one(sidebarButtons, /className="el-close"/), '`关闭 \\$\\{tab\\.title\\}`');
locksIcon(one(sidebarButtons, /deleteSavedQuery/), '`删除脚本 \\$\\{q\\.name\\}`');
locksIcon(one(sidebarButtons, /deleteBoard/), '`删除这个导出文件 \\$\\{f\\.name\\}`');
locksIcon(one(sidebarButtons, /FolderOpen/), 'pyDir \\? `打开脚本目录:\\$\\{pyDir\\}` : "打开脚本目录"');
locksIcon(one(sidebarButtons, /新建 Python 脚本/), '"新建 Python 脚本"');
locksIcon(one(sidebarButtons, /className="sq-act"/), '`重命名 \\$\\{f\\.name\\}`');
locksIcon(one(sidebarButtons, /deletePy/), '`删除脚本 \\$\\{f\\.name\\}`');
locksIcon(one(sidebarButtons, /关闭全部编辑器/), '"关闭全部编辑器"');
locksIcon(one(sidebarButtons, /iconName\(t\("toolbar\.newConnection"\)\)/), 't\\("toolbar\\.newConnection"\\)');

const hidden = one(sidebarButtons, /toggleShowHidden/);
locksIcon(hidden, 'showHidden \\? "隐藏已隐藏项" : `显示 \\$\\{hiddenCount\\} 个已隐藏项`');
assert.match(hidden, /aria-pressed=\{showHidden\}/);

const section = one(sidebarButtons, /className=\{`side-tab/);
assert.match(section, /<span className="st-label">\{s\.label\}<\/span>/);
assert.match(section, /title=\{s\.label\}/);
assert.match(section, /aria-pressed=\{section === s\.key\}/);
assert.doesNotMatch(section, /aria-label/);

const emptyNew = one(sidebarButtons, /className="btn primary"/);
assert.match(emptyNew, /\{t\("toolbar\.newConnection"\)\}/);
const demo = one(sidebarButtons, /createDemo/);
assert.match(demo, /\{t\("sidebar\.tryDemo"\)\}/);

assert.match(sidebar, /aria-label=\{`重命名 \$\{f\.name\}`\}/);

const treeButtons = buttons(tree);
assert.equal(treeButtons.length, 2, '对象树增减了按钮,名称清单要一起改');
for (const block of treeButtons) assert.ok(hasName(block), `对象树按钮没有名称:\n${block}`);

const twisty = one(treeButtons, /className=\{`twisty/);
locksIcon(twisty, 'twistLabel');
assert.match(twisty, /aria-expanded=\{node\.expanded\}/);
assert.match(tree, /const twistLabel = node\.expanded \? `收起 \$\{node\.label\}` : `展开 \$\{node\.label\}`;/);
assert.doesNotMatch(tree, /<span[^>]*twisty[^>]*onClick/);

const newQuery = one(treeButtons, /className="row-action"/);
locksIcon(newQuery, 't\\("action\\.newQuery"\\)');

assert.match(i18n, /"toolbar\.newConnection": "新建连接"/);
assert.match(i18n, /"action\.newQuery": "新建查询"/);

console.log('sidebar names: 纯图标按钮的中文名称 / 对象名 / 开关状态 全部锁住');
