/* 导出的离线网页里用的筛选控件 —— 多选框和日期区间选择器。
 *
 * 这是 V1MultiSelect.tsx / DateRangePicker.tsx 的原生 JS 版:离线页面里没有 React,
 * 但用户要的是「和软件里一样」,所以结构、类名、交互都照着那两个来,样式直接共用
 * filterControls.css(那份是从 dashboard.css 里抽出来的,两边引同一个文件)。
 * 改任何一边之前,先看另一边。
 *
 * 图标原来走 lucide-react,这儿改成内联 SVG(同样的线条参数:24 格、stroke 2、圆头)。
 */
(function () {
  var svgNS = "http://www.w3.org/2000/svg";
  function icon(size, paths, cls) {
    var s = document.createElementNS(svgNS, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("width", size); s.setAttribute("height", size);
    s.setAttribute("fill", "none"); s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "2"); s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    if (cls) s.setAttribute("class", cls);
    paths.forEach(function (d) {
      var el = document.createElementNS(svgNS, d.charAt(0) === "c" ? "circle" : "path");
      if (d.charAt(0) === "c") { var p = d.slice(1).split(","); el.setAttribute("cx", p[0]); el.setAttribute("cy", p[1]); el.setAttribute("r", p[2]); }
      else el.setAttribute("d", d);
      s.appendChild(el);
    });
    return s;
  }
  var ICON = {
    chevronDown: ["m6 9 6 6 6-6"],
    chevronLeft: ["m15 18-6-6 6-6"],
    chevronRight: ["m9 18 6-6-6-6"],
    check: ["M20 6 9 17l-5-5"],
    x: ["M18 6 6 18", "M6 6l12 12"],
    search: ["c11,11,8", "m21 21-4.3-4.3"],
    calendar: ["M8 2v4", "M16 2v4", "M3 10h18", "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"],
  };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* 弹层挂在 body 上(position:fixed),所以得自己算放不放得下 —— 跟 V1MultiSelect 里
     同一套:下面不够宽敞而上面更宽敞才翻上去,否则宁可留在下面(老上下跳更难用)。 */
  function placeMenu(trigger, menu, minWidth) {
    var r = trigger.getBoundingClientRect();
    var width = Math.max(minWidth || 220, r.width);
    var left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    var below = window.innerHeight - r.bottom - 13;
    var above = r.top - 13;
    var flip = below < 180 && above > below;
    var maxHeight = Math.max(120, Math.min(360, flip ? above : below));
    menu.style.width = width + "px";
    menu.style.left = left + "px";
    menu.style.maxHeight = maxHeight + "px";
    menu.style.top = (flip ? Math.max(8, r.top - 5 - maxHeight) : r.bottom + 5) + "px";
  }

  /** 点到外面就关。返回拆监听的函数。 */
  function closeOnOutside(nodes, close) {
    var onDoc = function (e) {
      for (var i = 0; i < nodes.length; i++) if (nodes[i] && nodes[i].contains(e.target)) return;
      close();
    };
    document.addEventListener("mousedown", onDoc);
    return function () { document.removeEventListener("mousedown", onDoc); };
  }

  // ---- 多选(对齐 V1MultiSelect.tsx) ----
  function multiSelect(opts) {
    var values = (opts.values || []).slice();
    var root = el("div", "dash-v1-multi");
    var trigger = el("div", "dash-v1-multi-trigger");
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-label", opts.ariaLabel || "");
    trigger.tabIndex = 0;
    var valueBox = el("div", "dash-v1-multi-values");
    trigger.appendChild(valueBox);
    trigger.appendChild(icon(14, ICON.chevronDown, "dash-v1-multi-chevron"));
    root.appendChild(trigger);

    var labelOf = {};
    (opts.options || []).forEach(function (o) { labelOf[o.value] = o.label; });

    var menu = null, detach = null, query = "";
    function emit() { opts.onChange(values.slice()); }
    function toggle(v) {
      var i = values.indexOf(v);
      if (i >= 0) values.splice(i, 1); else values.push(v);
      paintValues(); if (menu) paintOptions(); emit();
    }
    function paintValues() {
      valueBox.innerHTML = "";
      if (!values.length) {
        valueBox.appendChild(el("span", "placeholder", opts.placeholder || "请选择"));
        return;
      }
      values.forEach(function (v) {
        var chip = el("span", "dash-v1-multi-chip", labelOf[v] == null ? v : labelOf[v]);
        var rm = el("button", null); rm.title = "移除"; rm.appendChild(icon(11, ICON.x));
        rm.onclick = function (e) { e.stopPropagation(); toggle(v); };
        chip.appendChild(rm);
        valueBox.appendChild(chip);
      });
    }
    var optionBox = null;
    function paintOptions() {
      optionBox.innerHTML = "";
      var q = query.trim().toLowerCase();
      var list = (opts.options || []).filter(function (o) { return !q || String(o.label).toLowerCase().indexOf(q) >= 0; });
      if (!list.length) { optionBox.appendChild(el("div", "dash-v1-multi-empty", "无可选项")); return; }
      list.forEach(function (o) {
        var b = el("button", values.indexOf(o.value) >= 0 ? "selected" : null);
        b.type = "button";
        b.appendChild(el("span", null, o.label));
        if (values.indexOf(o.value) >= 0) b.appendChild(icon(14, ICON.check));
        b.onclick = function () { toggle(o.value); };
        optionBox.appendChild(b);
      });
    }
    function close() {
      if (!menu) return;
      if (detach) detach();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      menu.remove(); menu = null; detach = null; query = "";
      root.className = "dash-v1-multi";
    }
    function reposition() { if (menu) placeMenu(trigger, menu, 220); }
    function open() {
      if (menu) { close(); return; }
      menu = el("div", "dash-v1-multi-menu");
      if (opts.searchable) {
        var lab = el("label", "dash-v1-multi-search");
        lab.appendChild(icon(13, ICON.search));
        var input = document.createElement("input");
        input.placeholder = "搜索选项";
        input.oninput = function () { query = input.value; paintOptions(); };
        lab.appendChild(input);
        menu.appendChild(lab);
        setTimeout(function () { input.focus(); }, 0);
      }
      optionBox = el("div", "dash-v1-multi-options");
      menu.appendChild(optionBox);
      document.body.appendChild(menu);
      paintOptions();
      placeMenu(trigger, menu, 220);
      root.className = "dash-v1-multi open";
      detach = closeOnOutside([root, menu], close);
      window.addEventListener("resize", reposition);
      window.addEventListener("scroll", reposition, true);
    }
    trigger.onclick = open;
    trigger.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } };
    paintValues();
    return root;
  }

  // ---- 日期区间(对齐 DateRangePicker.tsx) ----
  var WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
  var MONTHS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
  function pad(n) { return String(n).padStart(2, "0"); }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parseYmd(s) { var p = String(s || "").split("-").map(Number); return new Date(p[0] || 2000, (p[1] || 1) - 1, p[2] || 1); }
  function startOfToday() { var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
  function addDays(b, n) { return new Date(b.getFullYear(), b.getMonth(), b.getDate() + n); }
  function monthEnd(y, m) { return new Date(y, m + 1, 0); }
  function presets() {
    var t = startOfToday();
    return [
      { label: "今天", range: function () { return [ymd(t), ymd(t)]; } },
      { label: "昨天", range: function () { var y = addDays(t, -1); return [ymd(y), ymd(y)]; } },
      { label: "近 7 天", range: function () { return [ymd(addDays(t, -6)), ymd(t)]; } },
      { label: "近 30 天", range: function () { return [ymd(addDays(t, -29)), ymd(t)]; } },
      { label: "本月", range: function () { return [ymd(new Date(t.getFullYear(), t.getMonth(), 1)), ymd(t)]; } },
      { label: "上月", range: function () { return [ymd(new Date(t.getFullYear(), t.getMonth() - 1, 1)), ymd(monthEnd(t.getFullYear(), t.getMonth() - 1))]; } },
      { label: "今年", range: function () { return [ymd(new Date(t.getFullYear(), 0, 1)), ymd(t)]; } },
      { label: "去年", range: function () { return [ymd(new Date(t.getFullYear() - 1, 0, 1)), ymd(new Date(t.getFullYear() - 1, 11, 31))]; } },
    ];
  }

  function dateRange(opts) {
    var start = opts.start, end = opts.end;
    var root = el("div", "dash-daterange");
    var trigger = el("button", "dash-daterange-trigger");
    trigger.type = "button";
    var label = el("span", null);
    trigger.appendChild(icon(14, ICON.calendar));
    trigger.appendChild(label);
    root.appendChild(trigger);
    function paintTrigger() { label.textContent = start + " — " + end; }
    paintTrigger();

    var pop = null, detach = null;
    var mode = "day", pending = null, hover = null, view = parseYmd(end || start);

    function close() {
      if (!pop) return;
      if (detach) detach();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      pop.remove(); pop = null; detach = null; pending = null; hover = null;
    }
    function reposition() {
      if (!pop) return;
      var r = trigger.getBoundingClientRect();
      pop.style.top = (r.bottom + 6) + "px";
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 540 - 8)) + "px";
    }
    // 把两个「代表日」按当前粒度展开成完整区间。
    function expand(a, b) {
      var lo = a < b ? a : b, hi = a < b ? b : a;
      var s = parseYmd(lo), e = parseYmd(hi);
      if (mode === "week") return [ymd(addDays(s, -s.getDay())), ymd(addDays(addDays(e, -e.getDay()), 6))];
      if (mode === "month") return [ymd(new Date(s.getFullYear(), s.getMonth(), 1)), ymd(monthEnd(e.getFullYear(), e.getMonth()))];
      if (mode === "year") return [s.getFullYear() + "-01-01", e.getFullYear() + "-12-31"];
      return [lo, hi];
    }
    function highlight() { return pending ? expand(pending, hover || pending) : [start, end]; }
    function pick(rep) {
      if (!pending) { pending = rep; hover = rep; paintBody(); return; }
      var r = expand(pending, rep);
      start = r[0]; end = r[1];
      paintTrigger(); opts.onChange(start, end); close();
    }

    var bodyBox = null, footBox = null;
    /* 悬停预览只改已有按钮的类名,不重画。
       重画会把鼠标正按着的那个按钮换成新节点 —— mousedown 落在旧节点、mouseup 落在新节点,
       浏览器就不算一次 click,于是「点起点再点终点」的第二下永远没反应。
       React 那版靠 diff 复用节点,看不出这个坑;原生这边得自己守住。 */
    var cells = [];   // { key, node, cls } —— key 是这一格的代表日
    function applyHighlight() {
      var hl = highlight();
      cells.forEach(function (c) {
        var on = c.key >= hl[0] && c.key <= hl[1];
        if (c.kind === "day") {
          c.node.className = c.cls
            + (on ? " in" : "")
            + (c.key === hl[0] ? " start" : "") + (c.key === hl[1] ? " end" : "");
        } else {
          c.node.className = "dash-cal-cell" + (on ? " on" : "");
        }
      });
      footBox.textContent = pending ? "再点一个选为终点(可跨月/年)" : (start + " — " + end);
    }
    function paintBody() {
      cells = [];
      bodyBox.innerHTML = "";
      var hl = highlight();
      var head = el("div", "dash-cal-head");
      if (mode === "month" || mode === "year") {
        var step = mode === "month" ? 1 : 12;
        var title = mode === "month" ? view.getFullYear() + " 年" : (Math.floor(view.getFullYear() / 12) * 12) + " – " + (Math.floor(view.getFullYear() / 12) * 12 + 11);
        var prev = el("button", null); prev.type = "button"; prev.appendChild(icon(16, ICON.chevronLeft));
        prev.onclick = function () { view = new Date(view.getFullYear() - step, view.getMonth(), 1); paintBody(); };
        var next = el("button", null); next.type = "button"; next.appendChild(icon(16, ICON.chevronRight));
        next.onclick = function () { view = new Date(view.getFullYear() + step, view.getMonth(), 1); paintBody(); };
        head.appendChild(prev); head.appendChild(el("strong", null, title)); head.appendChild(next);
        bodyBox.appendChild(head);

        var box = el("div", "dash-cal-cells");
        if (mode === "month") {
          var lo = hl[0].slice(0, 7), hi = hl[1].slice(0, 7);
          MONTHS.forEach(function (m, i) {
            var key = view.getFullYear() + "-" + pad(i + 1);
            var b = el("button", "dash-cal-cell" + (key >= lo && key <= hi ? " on" : ""), m);
            b.type = "button";
            var rep = ymd(new Date(view.getFullYear(), i, 1));
            b.onclick = function () { pick(rep); };
            b.onmouseenter = function () { if (pending) { hover = rep; applyHighlight(); } };
            cells.push({ key: rep, node: b, kind: "cell" });
            box.appendChild(b);
          });
        } else {
          var base = Math.floor(view.getFullYear() / 12) * 12;
          var ylo = Number(hl[0].slice(0, 4)), yhi = Number(hl[1].slice(0, 4));
          for (var k = 0; k < 12; k++) (function (y) {
            var b = el("button", "dash-cal-cell" + (y >= ylo && y <= yhi ? " on" : ""), String(y));
            b.type = "button";
            b.onclick = function () { pick(y + "-01-01"); };
            b.onmouseenter = function () { if (pending) { hover = y + "-01-01"; applyHighlight(); } };
            cells.push({ key: y + "-01-01", node: b, kind: "cell" });
            box.appendChild(b);
          })(base + k);
        }
        bodyBox.appendChild(box);
      } else {
        var prevM = el("button", null); prevM.type = "button"; prevM.appendChild(icon(16, ICON.chevronLeft));
        prevM.onclick = function () { view = new Date(view.getFullYear(), view.getMonth() - 1, 1); paintBody(); };
        var nextM = el("button", null); nextM.type = "button"; nextM.appendChild(icon(16, ICON.chevronRight));
        nextM.onclick = function () { view = new Date(view.getFullYear(), view.getMonth() + 1, 1); paintBody(); };
        head.appendChild(prevM);
        head.appendChild(el("strong", null, view.getFullYear() + " 年 " + (view.getMonth() + 1) + " 月"));
        head.appendChild(nextM);
        bodyBox.appendChild(head);

        var wd = el("div", "dash-cal-grid dash-cal-weekdays");
        WEEKDAYS.forEach(function (w) { wd.appendChild(el("span", null, w)); });
        bodyBox.appendChild(wd);

        var grid = el("div", "dash-cal-grid");
        grid.onmouseleave = function () { if (pending) { hover = null; applyHighlight(); } };
        var first = new Date(view.getFullYear(), view.getMonth(), 1);
        var gridStart = new Date(view.getFullYear(), view.getMonth(), 1 - first.getDay());
        var today = ymd(startOfToday());
        for (var i = 0; i < 42; i++) (function (day) {
          var s = ymd(day);
          var inMonth = day.getMonth() === view.getMonth();
          var cls = "dash-cal-day" + (inMonth ? "" : " other") + (s === today ? " today" : "");
          var b = el("button", cls, String(day.getDate()));
          b.type = "button";
          b.onclick = function () { pick(s); };
          b.onmouseenter = function () { if (pending) { hover = s; applyHighlight(); } };
          cells.push({ key: s, node: b, kind: "day", cls: cls });
          grid.appendChild(b);
        })(addDays(gridStart, i));
        bodyBox.appendChild(grid);
      }
      applyHighlight();
    }

    trigger.onclick = function () {
      if (pop) { close(); return; }
      pop = el("div", "dash-daterange-pop");
      var pre = el("div", "dash-daterange-presets");
      var active = null;
      presets().forEach(function (p) {
        var r = p.range();
        if (r[0] === start && r[1] === end) active = p.label;
      });
      presets().forEach(function (p) {
        var b = el("button", active === p.label ? "on" : null, p.label);
        b.type = "button";
        b.onclick = function () { var r = p.range(); start = r[0]; end = r[1]; paintTrigger(); opts.onChange(start, end); close(); };
        pre.appendChild(b);
      });
      pop.appendChild(pre);

      var cal = el("div", "dash-cal");
      var modes = el("div", "dash-cal-modes");
      [["day", "日"], ["week", "周"], ["month", "月"], ["year", "年"]].forEach(function (m) {
        var b = el("button", mode === m[0] ? "on" : null, m[1]);
        b.type = "button";
        b.onclick = function () { mode = m[0]; pending = null; paintModes(); paintBody(); };
        modes.appendChild(b);
      });
      function paintModes() {
        var bs = modes.querySelectorAll("button");
        [["day"], ["week"], ["month"], ["year"]].forEach(function (m, i) { bs[i].className = mode === m[0] ? "on" : ""; });
      }
      cal.appendChild(modes);
      bodyBox = el("div", null);
      cal.appendChild(bodyBox);
      footBox = el("div", "dash-cal-foot");
      cal.appendChild(footBox);
      pop.appendChild(cal);

      document.body.appendChild(pop);
      view = parseYmd(end || start); view = new Date(view.getFullYear(), view.getMonth(), 1);
      pending = null; mode = "day";
      paintBody();
      reposition();
      detach = closeOnOutside([root, pop], close);
      window.addEventListener("resize", reposition);
      window.addEventListener("scroll", reposition, true);
    };
    return root;
  }

  window.__DASH_CONTROLS__ = { multiSelect: multiSelect, dateRange: dateRange };
})();
