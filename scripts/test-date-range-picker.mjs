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
const runtimeSource = readFileSync(join(root, 'src/features/dashboard/export/filterControls.runtime.js'), 'utf8');

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
  vm.runInContext(runtimeSource, sandbox);
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
    assert.ok(!/1 - first\.getDay\(\)/.test(runtimeSource), '离线网格不能再按周日对齐');
    assert.ok(!/-s\.getDay\(\)/.test(runtimeSource), '离线周选区不能再从周日算');
    ok('离线页的网格和周界与组件同一套');
  }

  {
    const { dateKeyAction } = cal;
    const runtime = loadRuntimeCalendar();
    const copy = (value) => JSON.parse(JSON.stringify(value));
    const same = (key, cursor, year, month) => {
      assert.deepEqual(
        copy(runtime.dateKeyAction(key, cursor, year, month)),
        dateKeyAction(key, cursor, year, month),
        `${key} @ ${cursor}`,
      );
    };
    // 2026-11-12 周四,还在 11 月里。
    assert.deepEqual(dateKeyAction('ArrowLeft', '2026-11-12', 2026, 10), { type: 'move', date: '2026-11-11', year: 2026, month: 10, paged: false });
    assert.deepEqual(dateKeyAction('ArrowRight', '2026-11-12', 2026, 10), { type: 'move', date: '2026-11-13', year: 2026, month: 10, paged: false });
    assert.deepEqual(dateKeyAction('ArrowUp', '2026-11-12', 2026, 10), { type: 'move', date: '2026-11-05', year: 2026, month: 10, paged: false });
    assert.deepEqual(dateKeyAction('ArrowDown', '2026-11-12', 2026, 10), { type: 'move', date: '2026-11-19', year: 2026, month: 10, paged: false });
    // 11 月 1 日是周日,在最后一列。向左走出本月,要翻到 10 月。
    assert.deepEqual(dateKeyAction('ArrowLeft', '2026-11-01', 2026, 10), { type: 'move', date: '2026-10-31', year: 2026, month: 9, paged: true });
    assert.deepEqual(dateKeyAction('ArrowUp', '2026-11-01', 2026, 10), { type: 'move', date: '2026-10-25', year: 2026, month: 9, paged: true });
    // 向右、向下跨进 12 月。
    assert.deepEqual(dateKeyAction('ArrowRight', '2026-11-30', 2026, 10), { type: 'move', date: '2026-12-01', year: 2026, month: 11, paged: true });
    assert.deepEqual(dateKeyAction('ArrowDown', '2026-11-26', 2026, 10), { type: 'move', date: '2026-12-03', year: 2026, month: 11, paged: true });
    // 跨年。
    assert.deepEqual(dateKeyAction('ArrowLeft', '2026-01-01', 2026, 0), { type: 'move', date: '2025-12-31', year: 2025, month: 11, paged: true });
    assert.deepEqual(dateKeyAction('ArrowDown', '2026-12-31', 2026, 11), { type: 'move', date: '2027-01-07', year: 2027, month: 0, paged: true });
    assert.deepEqual(dateKeyAction('Enter', '2026-11-12', 2026, 10), { type: 'select' });
    assert.deepEqual(dateKeyAction(' ', '2026-11-12', 2026, 10), { type: 'select' });
    assert.deepEqual(dateKeyAction('Escape', '2026-11-12', 2026, 10), { type: 'close' });
    assert.deepEqual(dateKeyAction('Tab', '2026-11-12', 2026, 10), { type: 'none' });
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', ' ', 'Escape', 'Tab']) {
      same(key, '2026-11-01', 2026, 10);
      same(key, '2026-01-01', 2026, 0);
    }
    ok('方向键左右一天、上下一周,跨月翻页;Enter/空格选定,Esc 关闭');
  }

  {
    /* 离线页没有 React,但键和弹层语义是在真 DOM 节点上接的。
       这里用一个只够把控件跑起来的 document,按用户的方式点开、按键。 */
    const driver = `
      var active = null;
      function walk(el, visit) {
        visit(el);
        for (var i = 0; i < el.children.length; i++) walk(el.children[i], visit);
      }
      function node(tag) {
        var el = {
          tag: tag, children: [], attrs: {}, className: "", textContent: "", style: {}, id: "", tabIndex: 0,
          parentNode: null, onclick: null, onkeydown: null, onmouseenter: null, onmouseleave: null,
          appendChild: function (child) { child.parentNode = el; el.children.push(child); return child; },
          setAttribute: function (k, v) { el.attrs[k] = String(v); if (k === "id") el.id = String(v); },
          getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null; },
          remove: function () {
            if (!el.parentNode) return;
            el.parentNode.children = el.parentNode.children.filter(function (c) { return c !== el; });
            el.parentNode = null;
          },
          contains: function (target) {
            if (target === el) return true;
            for (var i = 0; i < el.children.length; i++) if (el.children[i].contains(target)) return true;
            return false;
          },
          getBoundingClientRect: function () { return { top: 100, left: 80, bottom: 126, right: 220, width: 140, height: 26 }; },
          querySelectorAll: function (sel) {
            var found = [];
            walk(el, function (n) { if (sel === "button" && n.tag === "button") found.push(n); });
            return found;
          },
          focus: function () { active = el; }
        };
        Object.defineProperty(el, "innerHTML", { set: function (v) { if (v === "") el.children = []; }, get: function () { return ""; } });
        return el;
      }
      var document = {
        createElement: function (tag) { return node(tag); },
        createElementNS: function () { return node("svg"); },
        body: node("body"),
        addEventListener: function () {},
        removeEventListener: function () {}
      };
      var window = {
        innerWidth: 1280, innerHeight: 800,
        addEventListener: function () {}, removeEventListener: function () {},
        document: document
      };
      window.window = window;
      function press(el, key) {
        var e = { key: key, preventDefault: function () {}, target: el };
        var n = el;
        while (n) { if (n.onkeydown) n.onkeydown(e); n = n.parentNode; }
      }
      function focusedDate() { return active && active.getAttribute("data-date"); }
      function title() {
        var text = "";
        walk(document.body, function (n) { if (n.tag === "strong") text = n.textContent; });
        return text;
      }
      function weekdays() {
        var labels = [];
        walk(document.body, function (n) {
          if (n.className === "dash-cal-grid dash-cal-weekdays") {
            for (var i = 0; i < n.children.length; i++) labels.push(n.children[i].textContent);
          }
        });
        return labels;
      }
      function firstDate() {
        var date = "";
        walk(document.body, function (n) {
          if (!date && n.tag === "button" && n.getAttribute("data-date")) date = n.getAttribute("data-date");
        });
        return date;
      }
      function pressUntil(date) {
        for (var i = 0; i < 40 && focusedDate() !== date; i++) press(active, "ArrowLeft");
        if (focusedDate() !== date) throw new Error("没有走到 " + date + ",停在 " + focusedDate());
      }
      var changes = [];
      var root = window.__DASH_CONTROLS__.dateRange({
        start: "2026-11-01", end: "2026-11-12",
        onChange: function (s, e) { changes.push([s, e]); }
      });
      var trigger = root.children[0];
      var before = {
        expanded: trigger.getAttribute("aria-expanded"),
        haspopup: trigger.getAttribute("aria-haspopup")
      };
      trigger.onclick();
      var pop = document.body.children[document.body.children.length - 1];
      var opened = {
        expanded: trigger.getAttribute("aria-expanded"),
        role: pop.getAttribute("role"),
        label: pop.getAttribute("aria-label"),
        controls: trigger.getAttribute("aria-controls") === pop.id,
        weekdays: weekdays(),
        firstDate: firstDate(),
        focus: focusedDate()
      };
      press(active, "ArrowLeft");
      var afterLeft = { focus: focusedDate(), title: title() };
      // 走到 11 月 1 日(周日,最后一列),再向左应该翻到 10 月 31 日。
      pressUntil("2026-11-01");
      press(active, "ArrowLeft");
      var crossed = { focus: focusedDate(), title: title() };
      press(active, "ArrowRight");
      var back = { focus: focusedDate(), title: title() };
      press(active, "ArrowDown");
      press(active, "ArrowDown");
      press(active, "ArrowDown");
      press(active, "ArrowDown");
      var down = { focus: focusedDate(), title: title() };
      // 回到 11 月 12 日再选:第一下只定起点,第二下才提交并关掉。
      pressUntil("2026-11-12");
      press(active, "Enter");
      var pendingFoot = "";
      walk(document.body, function (n) { if (n.className === "dash-cal-foot") pendingFoot = n.textContent; });
      var afterFirstEnter = { changes: changes.length, foot: pendingFoot, expanded: trigger.getAttribute("aria-expanded") };
      press(active, "Enter");
      var afterSecondEnter = {
        changes: changes.slice(),
        expanded: trigger.getAttribute("aria-expanded"),
        focusTrigger: active === trigger,
        popGone: document.body.children.indexOf(pop) < 0
      };
      trigger.onclick();
      var reopened = trigger.getAttribute("aria-expanded");
      press(active, "Escape");
      var afterEsc = {
        expanded: trigger.getAttribute("aria-expanded"),
        focusTrigger: active === trigger,
        changes: changes.length
      };
      output = JSON.stringify({ before: before, opened: opened, afterLeft: afterLeft, crossed: crossed, back: back, down: down, afterFirstEnter: afterFirstEnter, afterSecondEnter: afterSecondEnter, reopened: reopened, afterEsc: afterEsc });
    `;
    const sandbox = { output: "" };
    vm.createContext(sandbox);
    // 先装上 document/window,再跑控件脚本(它立刻要写 window.__DASH_CONTROLS__),最后才点开弹层。
    const setupEnd = driver.indexOf("var changes = [];");
    vm.runInContext(driver.slice(0, setupEnd) + "\n" + runtimeSource + "\n" + driver.slice(setupEnd), sandbox);
    const r = JSON.parse(sandbox.output);
    assert.equal(r.before.expanded, "false");
    assert.equal(r.before.haspopup, "dialog");
    assert.equal(r.opened.expanded, "true");
    assert.equal(r.opened.role, "dialog");
    assert.equal(r.opened.label, "选择日期范围");
    assert.equal(r.opened.controls, true);
    assert.deepEqual(r.opened.weekdays, ["一", "二", "三", "四", "五", "六", "日"]);
    assert.equal(r.opened.firstDate, "2026-10-26", "网格第一格是周一");
    assert.equal(r.opened.focus, "2026-11-12", "打开后焦点在已选的结束日");
    assert.equal(r.afterLeft.focus, "2026-11-11");
    assert.match(r.afterLeft.title, /11 月/);
    assert.equal(r.crossed.focus, "2026-10-31");
    assert.match(r.crossed.title, /10 月/, "向左跨月要翻到 10 月");
    assert.equal(r.back.focus, "2026-11-01");
    assert.match(r.back.title, /11 月/);
    assert.equal(r.down.focus, "2026-11-29");
    assert.match(r.down.title, /11 月/);
    assert.equal(r.afterFirstEnter.changes, 0, "第一下 Enter 只定起点");
    assert.match(r.afterFirstEnter.foot, /终点/);
    assert.equal(r.afterFirstEnter.expanded, "true");
    assert.deepEqual(r.afterSecondEnter.changes, [["2026-11-12", "2026-11-12"]]);
    assert.equal(r.afterSecondEnter.expanded, "false");
    assert.equal(r.afterSecondEnter.focusTrigger, true, "选完把焦点还给触发按钮");
    assert.equal(r.afterSecondEnter.popGone, true);
    assert.equal(r.reopened, "true");
    assert.equal(r.afterEsc.expanded, "false");
    assert.equal(r.afterEsc.focusTrigger, true, "Esc 关闭后焦点回到触发按钮");
    assert.equal(r.afterEsc.changes, 1, "Esc 不改已经选好的区间");
    ok("离线弹层:dialog、aria-expanded、方向键翻页、Enter 选定、Esc 还焦");
  }

  {
    const tsx = readFileSync(join(root, "src/features/dashboard/components/DateRangePicker.tsx"), "utf8");
    assert.match(tsx, /role="dialog"/);
    assert.match(tsx, /aria-label="选择日期范围"/);
    assert.match(tsx, /aria-expanded=\{open\}/);
    assert.match(tsx, /aria-haspopup="dialog"/);
    assert.match(tsx, /dateKeyAction\(/);
    assert.match(tsx, /triggerRef\.current\?\.focus\(\)/);
    assert.match(tsx, /button\[data-date=/);
    ok("组件弹层是 dialog,触发按钮带展开状态,方向键走 dateKeyAction,Esc 还焦");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n日期区间选择器:${passed} 项通过`);
