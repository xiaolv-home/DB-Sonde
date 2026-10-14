// 结果表格的规则:显示 / 复制、选区、行的显示顺序、求和条、粘贴拆格子、值的类型转换。
// 表格的手感(选中、Shift 扩选、⌘ 多选、粘贴落点)全靠这些,改坏了界面上不一定看得出来。
import assert from "node:assert/strict";
import { loadSrc } from "./lib/load-src.mjs";

const m = loadSrc("result-grid", { "src/components/resultGridModel.ts": "*" });
let n = 0;
const ok = (name) => { n += 1; console.log(`  ✓ ${name}`); };

// ── 单元格显示和复制 ──
assert.deepEqual(m.classify(null), { cls: "null", text: "NULL" });
assert.deepEqual(m.classify(12), { cls: "num", text: "12" });
assert.deepEqual(m.classify(false), { cls: "bool", text: "false" });
assert.deepEqual(m.classify({ a: 1 }), { cls: "", text: '{"a":1}' });
assert.equal(m.cellText(null), "", "复制时 NULL 是空串(和 DBeaver 一样),不是字面的 NULL");
assert.equal(m.cellText({ a: 1 }), '{"a":1}');
assert(m.cellsEqual(null, undefined), "NULL 和没值算同一个");
assert(!m.cellsEqual(null, ""), "NULL 和空串不是一回事 —— 清空格子存 NULL 还是 '' 就靠这个区分");
assert(m.cellsEqual({ a: [1] }, { a: [1] }));
assert(!m.cellsEqual(1, "1"), "类型不同不相等:改了类型要算改动");
ok("单元格的显示文字、复制文字、相等判断");

for (const t of ["INT", "bigint unsigned", "DECIMAL(12,2)", "double precision", "NUMBER(10)", "tinyint(1)"]) assert(m.isNumericType(t), t);
for (const t of ["varchar(20)", "TEXT", "datetime", "point", "interval", undefined]) assert(!m.isNumericType(t), String(t));
ok("数值列(右对齐、求和、粘贴转数)只认数值类型,point / interval 这种名字里带字母片段的不误判");

// ── 新行 / 筛选值的类型转换 ──
assert.equal(m.parseInsertValue("  ", true), null);
assert.equal(m.parseInsertValue("null", false), null);
assert.equal(m.parseInsertValue("42", true), 42);
assert.equal(m.parseInsertValue("9007199254740993", true), "9007199254740993", "超过安全整数的大整数留字符串,不能丢精度");
assert.equal(m.parseInsertValue("42", false), "42", "文本列不转数");
assert.equal(m.parseInsertValue(" a ", false), " a ", "文本原样保留空格");
assert.equal(m.coerceFilterValue("  ", true), "", "筛选框留空是空串,不是 NULL");
assert.equal(m.coerceFilterValue("NULL", true), null);
assert.equal(m.coerceFilterValue("3.5", true), 3.5);
assert.equal(m.coerceFilterValue("3.5", false), "3.5");
assert.equal(m.coerceFilterValue("9007199254740993", true), "9007199254740993", "按大整数 id 筛选也不能丢精度");
assert.equal(m.shortFilterVal("x".repeat(40)), `${"x".repeat(10)} … ${"x".repeat(9)}`);
assert.equal(m.menuValueLabel("y".repeat(30)), `${"y".repeat(18)}…`);
assert.equal(m.menuValueLabel(null), "NULL");
ok("新加行的值、筛选值、菜单里的短显示");

// ── 求和条 ──
assert.equal(m.aggregate([], "sum"), 0);
assert.equal(m.aggregate([3, 1, 2], "median"), 2);
assert.equal(m.aggregate([4, 1, 3, 2], "median"), 2.5);
assert.equal(m.aggregate([2, 4], "avg"), 3);
assert.equal(m.aggregate([5, -1, 3], "min"), -1);
const big = Array.from({ length: 300000 }, (_, i) => i);
assert.equal(m.aggregate(big, "max"), 299999, "选中一整列几十万行也不能炸(不能用 Math.max(...values))");
assert.equal(m.formatAgg(Infinity), "—");
ok("求和 / 平均 / 中位数 / 最值,大列不炸");

// ── 选区 ──
const R = (r0, c0, r1, c1, full) => ({ a: { r: r0, c: c0 }, b: { r: r1, c: c1 }, ...(full ? { full } : {}) });
const sel = [R(3, 2, 1, 0), R(6, 5, 6, 5)]; // 第一块是反着拖出来的
assert.deepEqual(m.rectBounds(sel[0]), { r0: 1, r1: 3, c0: 0, c1: 2 }, "从右下往左上拖也要算对");
assert(m.inRanges(sel, 2, 1) && m.inRanges(sel, 6, 5));
assert(!m.inRanges(sel, 4, 4), "两块之间的空洞不算选中(⌘ 多选)");
assert(!m.inRanges(sel, 2, 4), "行在选区里、列不在,也不算选中");
assert.deepEqual(m.selectionBounds(sel), { r0: 1, r1: 6, c0: 0, c1: 5 });
assert.equal(m.selectionBounds([]), null);
assert(m.columnInRanges([R(0, 2, 9, 3, true)], 3) && !m.columnInRanges([R(0, 2, 9, 3)], 3), "只有点表头的整列选中才算列选中");
ok("选区:反向拖、不连续多选、外接矩形、整列");

// ── 求和条取哪些值 ──
const cells = { "0:0": 1, "1:0": "2", "2:0": null, "3:0": "x", "0:1": 9 };
const at = (r, c) => cells[`${r}:${c}`] ?? null;
assert.deepEqual(m.lineAggregateValues([R(0, 0, 3, 0)], [true, true], at), [1, 2], "数字字符串算数(DECIMAL 常以字符串返回),NULL 和非数字跳过");
assert.equal(m.lineAggregateValues([R(0, 0, 1, 1)], [true, true], at), null, "不是一行或一列就不出求和条");
assert.equal(m.lineAggregateValues([R(0, 0, 0, 0), R(1, 0, 1, 0)], [true], at), null, "多块选区不出求和条");
assert.equal(m.lineAggregateValues([R(0, 1, 0, 1)], [true, false], at), null, "文本列不参与求和");
ok("求和条只认单行 / 单列里的数值");

// ── 复制成 TSV、粘贴拆格子 ──
const grid = { "0:0": "a", "0:1": null, "1:0": 2, "1:1": { k: 1 } };
const v = (r, c) => grid[`${r}:${c}`] ?? null;
const b = { r0: 0, r1: 1, c0: 0, c1: 1 };
assert.deepEqual(m.selectionTsvLines(b, 1, () => true, v), ["a\t", '2\t{"k":1}']);
assert.deepEqual(m.selectionTsvLines(b, 1, (r, c) => r === c, v), ["a\t", '\t{"k":1}'], "不连续选区的空洞复制成空格子,位置不错开");
assert.deepEqual(m.selectionTsvLines(b, 0, () => true, v), ["a\t"], "只取到指定的那一行(给 AI 的最多 50 行)");
assert.deepEqual(m.parsePasteMatrix("a\tb\r\nc\td\r\n"), [["a", "b"], ["c", "d"]], "Excel 复制来的 CRLF 和末尾换行");
assert.deepEqual(m.parsePasteMatrix("x"), [["x"]]);
assert.deepEqual(m.parsePasteMatrix("a\n\nb"), [["a"], [""], ["b"]], "中间的空行是一行空值,不能吞掉");
assert.deepEqual(m.parsePasteMatrix("\n"), [[""]], "只有一个换行 = 一个空格子");
ok("复制成 TSV、粘贴文本拆成格子");

// ── 待插入的行穿插显示 ──
const ins = (after) => ({ key: `k${after}`, after, values: [] });
const show = (list) => list.map((it) => (it.kind === "row" ? `r${it.row}` : `i${it.ins}`)).join(" ");
assert.equal(show(m.buildDisplayList([], 3)), "r0 r1 r2");
assert.equal(show(m.buildDisplayList([ins(0), ins(-1), ins(0)], 2)), "i1 r0 i0 i2 r1", "同一行下面加的多行按添加先后排");
assert.equal(show(m.buildDisplayList([ins(9)], 2)), "r0 r1 i0", "锚点超出(结果被刷新变短了)就挂到最后一行下面");
assert.equal(show(m.buildDisplayList([ins(5)], 0)), "i0", "空结果里加的行照样显示");
ok("新加的行插在锚点行下面,锚点越界不丢行");

console.log(`result grid: ${n} 项通过`);
