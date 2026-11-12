/* 日期区间选择器的日历。
 *
 * 周一是一周的第一天:表头和 42 格网格必须同一列,周粒度的区间也得是周一到周日,
 * 否则高亮会从上一行的周日扯到这一行的周六。日 / 月 / 年的边界不能跟着变。
 *
 * 计算在 dateRangeCalendar.ts。离线页的 filterControls.runtime.js 不能 import,
 * 这里再跑一遍它导出的同一组函数,两份结果必须一致。
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = resolve(new URL('..', import.meta.url).pathname);
let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

const dir = mkdtempSync(join(tmpdir(), 'sonde-daterange-'));
const outfile = join(dir, 'cal.cjs');
await build({
  stdin: {
    contents: `export * from './src/features/dashboard/components/dateRangeCalendar';`,
    resolveDir: root,
    loader: 'ts',
  },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const cal = createRequire(import.meta.url)(outfile);

/* 离线脚本是个 IIFE。造一个只够把它跑起来的 document,拿出它挂出来的日历函数。 */
function loadRuntimeCalendar() {
  const listeners = [];
  function node(tag) {
    const el = {
      tag,
      children: [],
      attrs: {},
      className: '',
      textContent: '',
      style: {},
      parentNode: null,
      appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
      setAttribute(k, v) { el.attrs[k] = String(v); },
      getAttribute(k) { return el.attrs[k]; },
      remove() {},
      contains() { return false; },
      getBoundingClientRect() { return { top: 0, left: 0, bottom: 20, right: 40, width: 40, height: 20 }; },
    };
    return el;
  }
  const document = {
    createElement: (tag) => node(tag),
    createElementNS: () => node('svg'),
    body: node('body'),
    addEventListener(type, fn) { listeners.push([type, fn]); },
    removeEventListener() {},
  };
  const sandbox = {
    document,
    window: {
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener() {},
      removeEventListener() {},
    },
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.document = document;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(root, 'src/features/dashboard/export/filterControls.runtime.js'), 'utf8'), sandbox);
  return sandbox.window.__DASH_CONTROLS__.calendar;
}

try {
  const { WEEKDAYS, monthCells, ymd, expandRange, mondayIndex } = cal;

  // 2026-11-12 是周四,所以 11 月 1 日是周日。周一网格要从 10 月 26 日(周一)起。
  assert.equal(new Date(2026, 10, 12).getDay(), 4, '前提:2026-11-12 是周四');
  assert.equal(new Date(2026, 10, 1).getDay(), 0, '前提:2026-11-01 是周日');

  assert.deepEqual([...WEEKDAYS], ['一', '二', '三', '四', '五', '六', '日']);
  ok('表头从周一开始,周日收尾');

  {
    const cells = monthCells(2026, 10);
    assert.equal(cells.length, 42);
    assert.equal(ymd(cells[0]), '2026-10-26');
    assert.equal(ymd(cells[6]), '2026-11-01');
    const columnDay = [1, 2, 3, 4, 5, 6, 0]; // 一 … 日
    for (let i = 0; i < cells.length; i++) {
      assert.equal(cells[i].getDay(), columnDay[i % 7], `${ymd(cells[i])} 应该落在「${WEEKDAYS[i % 7]}」那一列`);
    }
    // 1 号在第几列,必须等于它的周一序号,表头和网格才对齐。
    const first = cells.findIndex((d) => d.getMonth() === 10 && d.getDate() === 1);
    assert.equal(first, mondayIndex(new Date(2026, 10, 1)));
    assert.equal(WEEKDAYS[first], '日');
    ok('2026 年 11 月(1 日是周日)网格从周一排,列和表头对齐');
  }

  {
    // 2026-06-01 是周一:网格就从 1 号开始,前面不该再垫上一周。
    assert.equal(new Date(2026, 5, 1).getDay(), 1);
    const cells = monthCells(2026, 5);
    assert.equal(ymd(cells[0]), '2026-06-01');
    assert.equal(cells[0].getDay(), 1);
    ok('1 号本身是周一时,第一格就是 1 号');
  }

  {
    // 2026-01-01 是周四,网格回到上一年的 12 月 29 日(周一)。
    assert.equal(new Date(2026, 0, 1).getDay(), 4);
    const cells = monthCells(2026, 0);
    assert.equal(ymd(cells[0]), '2025-12-29');
    assert.equal(cells[0].getDay(), 1);
    assert.equal(ymd(cells[3]), '2026-01-01');
    ok('跨年的月份,前导空白补到上一年的周一');
  }

  {
    // 日 / 月 / 年的边界保持原样。2026-11-12 是周四。
    assert.deepEqual(expandRange('day', '2026-11-18', '2026-11-03'), ['2026-11-03', '2026-11-18']);
    assert.deepEqual(expandRange('month', '2026-11-12', '2026-01-05'), ['2026-01-01', '2026-11-30']);
    assert.deepEqual(expandRange('month', '2024-02-10', '2024-02-10'), ['2024-02-01', '2024-02-29'], '闰年 2 月仍到 29 日');
    assert.deepEqual(expandRange('year', '2026-11-12', '2024-02-01'), ['2024-01-01', '2026-12-31']);
    // 同一天点两次,区间不该被排序弄丢。
    assert.deepEqual(expandRange('day', '2026-11-12', '2026-11-12'), ['2026-11-12', '2026-11-12']);
    ok('日 / 月 / 年的选区边界没有变');
  }

  {
    // 2026-11-12 周四 → 这一周是 11-09(周一)到 11-15(周日),不再是周日到周六。
    assert.deepEqual(expandRange('week', '2026-11-12', '2026-11-12'), ['2026-11-09', '2026-11-15']);
    assert.equal(new Date(2026, 10, 9).getDay(), 1);
    assert.equal(new Date(2026, 10, 15).getDay(), 0);
    // 逆序、跨两周:11-03 是周二(周一为 11-02),11-18 是周三(周日为 11-22)。
    assert.deepEqual(expandRange('week', '2026-11-18', '2026-11-03'), ['2026-11-02', '2026-11-22']);
    // 跨月:2026-11-30 是周一,2026-12-02 是周三,这一周收到 12-06(周日)。
    assert.equal(new Date(2026, 10, 30).getDay(), 1);
    assert.deepEqual(expandRange('week', '2026-12-02', '2026-11-30'), ['2026-11-30', '2026-12-06']);
    ok('周选区是周一到周日,和网格的一行对齐');
  }

  {
    const runtime = loadRuntimeCalendar();
    // 运行时跑在 vm 里,它的数组原型和这边不是同一个,先拷出来再比。
    const copy = (value) => JSON.parse(JSON.stringify(value));
    assert.deepEqual(copy(runtime.WEEKDAYS), [...WEEKDAYS]);
    for (const [year, month] of [[2026, 10], [2026, 5], [2026, 0], [2024, 1]]) {
      const a = monthCells(year, month).map(ymd);
      const b = copy(runtime.monthCells(year, month).map((d) => runtime.ymd(d)));
      assert.deepEqual(b, a, `${year}-${month + 1} 离线网格和组件不一致`);
    }
    for (const mode of ['day', 'week', 'month', 'year']) {
      for (const pair of [['2026-11-18', '2026-11-03'], ['2026-11-12', '2026-11-12'], ['2024-02-10', '2026-01-05']]) {
        assert.deepEqual(copy(runtime.expandRange(mode, pair[0], pair[1])), expandRange(mode, pair[0], pair[1]));
      }
    }
    const src = readFileSync(join(root, 'src/features/dashboard/export/filterControls.runtime.js'), 'utf8');
    assert.ok(!/1 - first\.getDay\(\)/.test(src), '离线网格不能再按周日对齐');
    assert.ok(!/-s\.getDay\(\)/.test(src), '离线周选区不能再从周日算');
    ok('离线页的网格和周界与组件同一套');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n日期区间选择器:${passed} 项通过`);
