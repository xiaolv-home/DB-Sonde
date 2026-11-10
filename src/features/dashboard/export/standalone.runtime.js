/**
 * Sonde 离线看板运行时 —— 以 ?inline-min 压缩后内嵌进导出的 HTML
 * (仓库里这份带完整注释,产物里不带;见 vite/exportAssets.mjs)。
 * 读取 window.__DASH__(烘焙数据)+ 全局 echarts,在浏览器里离线渲染并支持
 * 下钻 / 指标切换 / 悬停(含副指标) / KPI 同环比。不联网、不碰数据库。
 * 纯 ES2019 JS(不走 TS 编译),故本文件不参与类型检查。
 */
(function () {
  "use strict";
  var DATA = window.__DASH__ || { widgets: [] };
  /* tooltip 里的外来文本转义 —— 实现在 tooltipText.runtime.js,由 htmlExport
     内联在本脚本之前。和看板共用同一份,免得修了一处漏另一处。 */
  var esc = globalThis.__DASH_TIP__.esc;
  var echarts = window.echarts;
  var PALETTE = ["#4d8dff", "#2ed6a1", "#ffb547", "#a98bff", "#ff6b8a", "#35c6f4", "#ff7a45", "#66e0e5"];
  var ROW = 96; // 每个网格行的像素高度(近似在线画布)
  /* 图表实例不攒在数组里 —— 攒了就永远不释放。
     每次下钻 / 切指标 / 改筛选都会重渲染,老的 DOM 被清掉、实例却还被数组拽着,
     连同它的 canvas 和内部状态一起留在内存里。下钻二十次就是二十份。
     改成用的时候从 DOM 现取(echarts 自己有 dom → 实例的映射),清容器前先 dispose。
     数据量大时这是实打实的占用。 */
  function liveCharts() {
    var out = [];
    var nodes = document.querySelectorAll(".dash-x-chart");
    for (var i = 0; i < nodes.length; i++) {
      var inst = echarts.getInstanceByDom(nodes[i]);
      if (inst) out.push(inst);
    }
    return out;
  }

  /** 清空一个容器:先把里面的图表实例释放掉,再清 DOM。 */
  function clearNode(node) {
    var nodes = node.querySelectorAll ? node.querySelectorAll(".dash-x-chart") : [];
    for (var i = 0; i < nodes.length; i++) {
      var inst = echarts.getInstanceByDom(nodes[i]);
      if (inst) { try { inst.dispose(); } catch (e) {} }
    }
    node.innerHTML = "";
  }

  // ---- 数值 / 指标工具(对齐 metricUtils) ----
  function numberValue(v) {
    if (typeof v === "number") return isFinite(v) ? v : 0;
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }
  function fmt(v, decimals, grouping) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: decimals == null ? 2 : decimals, useGrouping: !!grouping }).format(v);
  }
  function metricLabel(m) { return m.unit && m.unit.trim() ? m.name + " (" + m.unit.trim() + ")" : m.name; }
  // 单位换算 + 前后缀 —— 和在线端 metricUtils.scaledText 保持同一套语义,
  // 否则同一个看板在线看是「1,234.6 万元」,导出后变成「12,345,678 元」。
  var SCALE_DIV = { none: 1, wan: 1e4, yi: 1e8 };
  var SCALE_WORD = { none: "", wan: "万", yi: "亿" };
  function scaled(v, decimals, unit, nf, grouping) {
    nf = nf || {};
    var key = nf.scale || "none";
    // auto:每个数按自己的量级选一档(跟看板同一条规则)
    if (key === "auto") { var size = Math.abs(v); key = size >= 1e8 ? "yi" : size >= 1e4 ? "wan" : "none"; }
    var text = fmt(v / (SCALE_DIV[key] || 1), decimals, grouping);
    var suffix = nf.suffix == null ? (SCALE_WORD[key] || "") + (unit || "") : nf.suffix;
    return (nf.prefix || "") + text + suffix;
  }
  function metricValue(m, v, nf) { return scaled(v, m.decimals, m.unit || "", nf, false); }
  function colIndex(table, field) { return table.columns.indexOf(field); }
  function aggregate(rows, m) {
    var ci = m.ci, vals = [];
    for (var i = 0; i < rows.length; i++) { var c = rows[i][ci]; if (c != null) vals.push(numberValue(c)); }
    if (m.aggregation === "count") return vals.length;
    if (!vals.length) return 0;
    if (m.aggregation === "avg") { var s = 0; for (var j = 0; j < vals.length; j++) s += vals[j]; return s / vals.length; }
    if (m.aggregation === "min") return Math.min.apply(null, vals);
    if (m.aggregation === "max") return Math.max.apply(null, vals);
    var t = 0; for (var k = 0; k < vals.length; k++) t += vals[k]; return t;
  }
  function withCi(defs, table) {
    return defs.map(function (m) { var c = Object.assign({}, m); c.ci = colIndex(table, m.field); return c; }).filter(function (m) { return m.ci >= 0; });
  }
  function axisUnit(metrics) {
    var u = {}; metrics.forEach(function (m) { if (m.unit && m.unit.trim()) u[m.unit.trim()] = 1; });
    var keys = Object.keys(u); return keys.length === 1 ? keys[0] : "";
  }
  function buildMetricChoices(displayMode, groups, metrics) {
    if (displayMode === "group_switch") {
      return (groups || []).map(function (g) {
        return { id: g.id, label: g.label || "指标", metrics: metrics.filter(function (m) { return g.metricIds.indexOf(m.key) >= 0; }) };
      }).filter(function (c) { return c.metrics.length > 0; });
    }
    return metrics.map(function (m) { return { id: m.key, label: metricLabel(m), metrics: [m] }; });
  }
  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  function gradient(from, to, vertical) {
    return { type: "linear", x: 0, y: 0, x2: vertical ? 0 : 1, y2: vertical ? 1 : 0, colorStops: [{ offset: 0, color: from }, { offset: 1, color: to }] };
  }
  /* 哪些字段是时间,由烘焙时用 isTimeField(看数据库列类型)定好写进文件。
     原来这儿是拿字段名做正则猜的,写死了「日期/周/月/年」这些词 —— 换个公司
     换套命名(比如 biz_dt、p_date)就全不认识,时间轴当普通维度处理。
     老文件里没带 timeFields 就退回按名字猜,总比完全不认强。 */
  var isTimeDimOf = function (bw) {
    var list = bw && bw.timeFields;
    if (list && list.length) return function (name) { return list.indexOf(name) >= 0; };
    return function (name) { return /日期|周|月|年|day|week|month|year|date|time|^dt$/i.test(name); };
  };

  /** v1 风格自由准星:画在 zrender 上,跟随鼠标真实位置,不吸附类目刻度(与在线一致)。 */
  function installFreeCrosshair(chart, horizontalValueAxis) {
    var g = echarts.graphic, zr = chart.getZr && chart.getZr();
    if (!g || !g.Group || !g.Line || !g.Text || !zr) return function () {};
    var order = { zlevel: 100, z: 100, z2: 100000 };
    var lineStyle = { stroke: cssVar("--text-3", "#8b96a8"), lineWidth: 1, lineDash: [5, 5], opacity: 0.92 };
    var group = new g.Group(Object.assign({ silent: true, invisible: true }, order));
    var vertical = new g.Line(Object.assign({ silent: true, style: lineStyle }, order));
    var horizontal = new g.Line(Object.assign({ silent: true, style: lineStyle }, order));
    var label = new g.Text(Object.assign({ silent: true, style: {
      fill: cssVar("--text", "#e8edf6"), backgroundColor: cssVar("--surface-3", "#1a2230"),
      borderColor: cssVar("--border-2", "rgba(151,170,203,.24)"), borderWidth: 1, borderRadius: 4,
      padding: [4, 7], font: "600 11px Inter, PingFang SC, sans-serif", align: "left", verticalAlign: "middle",
    } }, order));
    group.add(vertical); group.add(horizontal); group.add(label);
    zr.add(group);
    var latest = null, frame = 0;
    var hide = function () { latest = null; group.attr({ invisible: true }); };
    var paint = function () {
      frame = 0;
      if (!latest || chart.isDisposed()) return;
      var model = chart.getModel && chart.getModel();
      var comp = model && model.getComponent("grid", 0);
      var rect = comp && comp.coordinateSystem && comp.coordinateSystem.getRect && comp.coordinateSystem.getRect();
      if (!rect) return;
      var x = latest.x, y = latest.y;
      if (x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) { hide(); return; }
      var coord = chart.convertFromPixel({ gridIndex: 0 }, [x, y]);
      var value = Number(Array.isArray(coord) ? coord[horizontalValueAxis ? 0 : 1] : coord);
      vertical.setShape({ x1: x, y1: rect.y, x2: x, y2: rect.y + rect.height });
      horizontal.setShape({ x1: rect.x, y1: y, x2: rect.x + rect.width, y2: y });
      label.setStyle({
        text: isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping: false }) : "",
        x: horizontalValueAxis ? x : rect.x + 2,
        y: horizontalValueAxis ? rect.y + rect.height - 2 : y,
        align: horizontalValueAxis ? "center" : "left",
        verticalAlign: horizontalValueAxis ? "bottom" : "middle",
      });
      group.attr({ invisible: false });
    };
    var move = function (e) { latest = { x: e.offsetX, y: e.offsetY }; if (!frame) frame = requestAnimationFrame(paint); };
    zr.on("mousemove", move);
    zr.on("globalout", hide);
    return function () { if (frame) cancelAnimationFrame(frame); zr.off("mousemove", move); zr.off("globalout", hide); zr.remove(group); };
  }

  // ---- 每个组件的 UI 状态(下钻路径 / 切换项) ----
  var STATE = {};
  function stateOf(id) { if (!STATE[id]) STATE[id] = { path: [], active: null }; return STATE[id]; }

  // ---- 计算当前视图:选表 + 过滤路径 + x 维度 + 系列维度 + 显示指标 ----
  function computeChartView(bw) {
    var st = stateOf(bw.widget.id);
    var opt = bw.widget.options || {};
    var chartOpt = opt.chart || {};
    var primary = bw.metrics.primary, secondary = bw.metrics.secondary;
    // 指标切换
    var choices = buildMetricChoices(chartOpt.displayMode, chartOpt.metricGroups, primary);
    var switching = (chartOpt.displayMode === "switch" || chartOpt.displayMode === "group_switch") && choices.length > 1;
    var activeChoice = null;
    if (switching) {
      activeChoice = find(choices, function (c) { return c.id === st.active; })
        || find(choices, function (c) { return c.id === chartOpt.metricSwitchDefault; })
        || choices[0];
    }
    var displayMetrics = activeChoice ? activeChoice.metrics : primary;
    var displaySecondary = switching ? [] : secondary;

    var table, rows, xField, seriesFields = [];
    if (bw.drillDimensions && bw.drillDimensions.length && st.path.length) {
      /* 第 0 层就是组件自己绑的维度,第 k 层才换成链里的第 k-1 个 —— 跟在线一套算法。
         原来是 dims[min(path.length, len-1)],没钻的时候就已经按下一层维度出图了。 */
      var level = Math.min(st.path.length, bw.drillDimensions.length) - 1;
      table = (bw.data.levels || [])[level];
      if (!table) return null;
      xField = bw.drillDimensions[level];
      /* 按已选路径过滤。路径上每一项都得算 —— 原来写的是 i < level,
         而 level = path.length - 1,正好把最后点的那一项漏掉:点进「北京大区」,
         过滤一次都没跑,看到的还是全国的主管。 */
      rows = table.rows.filter(function (r) {
        for (var i = 0; i < st.path.length; i++) {
          var ci = colIndex(table, st.path[i].dimension);
          if (ci < 0) continue;
          if (String(r[ci]) !== String(st.path[i].value)) return false;
        }
        return true;
      });
    } else {
      table = bw.data.base;
      if (!table) return null;
      rows = table.rows;
      var analysisDims = (bw.widget.bindings.dimensions && bw.widget.bindings.dimensions.length)
        ? bw.widget.bindings.dimensions
        : (bw.widget.bindings.dimension ? [bw.widget.bindings.dimension] : []);
      xField = firstOf(analysisDims, isTimeDimOf(bw)) || analysisDims[0] || table.columns[0];
      var extra = analysisDims.filter(function (d) { return d !== xField; });
      if (bw.widget.bindings.seriesDimension && bw.widget.bindings.seriesDimension !== xField) extra.push(bw.widget.bindings.seriesDimension);
      seriesFields = uniq(extra).filter(function (d) { return colIndex(table, d) >= 0; });
    }
    return {
      table: table, rows: rows, xField: xField, seriesFields: seriesFields,
      displayMetrics: withCi(displayMetrics, table), displaySecondary: withCi(displaySecondary, table),
      switching: switching, choices: choices, activeChoice: activeChoice,
      primaryAll: withCi(primary, table),
    };
  }

  function find(arr, fn) { for (var i = 0; i < arr.length; i++) if (fn(arr[i])) return arr[i]; return null; }
  function firstOf(arr, fn) { for (var i = 0; i < arr.length; i++) if (fn(arr[i])) return arr[i]; return null; }
  function uniq(arr) { var o = {}, r = []; arr.forEach(function (x) { if (x != null && !o[x]) { o[x] = 1; r.push(x); } }); return r; }

  // ---- ECharts option 构建(对齐 ChartWidget) ----
  function buildChartOption(bw, view) {
    var w = bw.widget, co = w.options.chart || {}, type = w.type;
    var muted = cssVar("--text-3", "#8b96a8");
    var border = cssVar("--border", "rgba(140,150,170,.2)");
    var surface = cssVar("--surface", "#ffffff");
    var accent = cssVar("--accent", "#4d8dff");
    var palette = (co.palette && co.palette.length) ? co.palette : PALETTE;
    var grouping = co.grouping === true;
    var showValues = co.showLabels === true || co.barShowValues === true;
    var horizontal = type === "bar" && co.barOrientation === "horizontal";
    var colorOf = function (name) { return co.dimensionColors ? co.dimensionColors[name] : undefined; };

    // 分组:x → 行
    /* 列号先查一次。colIndex 是在列名数组上做 indexOf,原来写在按行循环里面 ——
       每行每个字段都要把列名从头扫一遍。 */
    var xi = colIndex(view.table, view.xField);
    var seriesIdx = view.seriesFields.map(function (f) { return colIndex(view.table, f); });
    var seriesKey = function (r) {
      var parts = [];
      for (var i = 0; i < seriesIdx.length; i++) {
        var v = r[seriesIdx[i]];
        parts.push(String(v == null ? "NULL" : v));
      }
      return parts.join(" · ");
    };

    /* 一遍过把行分好三份索引:按 x 轴分组、按系列分组、以及「x 轴 × 系列」。
       下面排序和造系列都直接查表,不再反复 filter 全表。 */
    var grouped = {}; var labelOrder = [];
    var bySeries = {}; var seriesOrder = [];
    var byLabelSeries = {};
    view.rows.forEach(function (r) {
      var label = String(r[xi] == null ? "NULL" : r[xi]);
      if (!grouped[label]) { grouped[label] = []; labelOrder.push(label); byLabelSeries[label] = {}; }
      grouped[label].push(r);
      if (!seriesIdx.length) return;
      var k = seriesKey(r);
      if (!bySeries[k]) { bySeries[k] = []; seriesOrder.push(k); }
      bySeries[k].push(r);
      var cell = byLabelSeries[label];
      if (!cell[k]) cell[k] = [];
      cell[k].push(r);
    });
    var activePie = view.switching ? view.displayMetrics[0] : (find(view.displayMetrics, function (m) { return m.key === stateOf(w.id).active; }) || view.displayMetrics[0]);
    var rankingMetric = type === "pie" || type === "funnel" ? activePie : view.displayMetrics[0];

    var labels;
    if (w.options.topN > 0 && (type === "bar" || type === "pie")) {
      labels = labelOrder.slice().sort(function (a, b) {
        return aggregate(grouped[b] || [], rankingMetric) - aggregate(grouped[a] || [], rankingMetric);
      }).slice(0, w.options.topN);
    } else {
      labels = labelOrder.slice();
    }
    /* 分类轴的顺序跟看板同一份实现(labelOrder.runtime.js),不在这儿另写一套比较函数 ——
       顺序这种东西两边走散了没人会立刻发现,发现了也说不清哪个对。 */
    var order = window.__DASH_ORDER__;
    if (order) {
      var spec = order.orderSpecOf(w, view.xField, view.displayMetrics.map(function (m) { return m.key; }), isTimeDimOf(bw)(view.xField));
      var orderMetric = spec.metricKey ? find(view.displayMetrics, function (m) { return m.key === spec.metricKey; }) : null;
      labels = order.orderLabels(labels, {
        dimension: spec.dimension,
        metric: orderMetric ? { dir: spec.dir, valueOf: function (l) { return aggregate(grouped[l] || [], orderMetric); } } : null,
      });
    }

    var allMetrics = view.displayMetrics.concat(view.displaySecondary);
    var maxSeriesValues = Math.max(1, Math.floor(12 / Math.max(1, allMetrics.length)));
    var seriesValues = [];
    if (view.seriesFields.length) {
      /* 每个系列的总量先各算一次,再照着数排序。原来这两句 filter 是写在比较函数里的,
         每比较一次就把整张表扫两遍 —— 两百个网点排个序就是五千多万次取值,
         一张两万行的折线图光这儿就要一秒多。 */
      var totals = {};
      seriesOrder.forEach(function (k) { totals[k] = aggregate(bySeries[k], rankingMetric); });
      seriesValues = seriesOrder.slice()
        .sort(function (a, b) { return totals[b] - totals[a]; })
        .slice(0, maxSeriesValues);
    }
    var single = view.displayMetrics.length === 1 && seriesValues.length <= 1;
    var displaySecondary = view.displaySecondary;
    // 副指标摘要:并进它所属系列那一行,避免多系列时 tooltip 撑成两倍高。
    var secondarySummary = function (rows, sv, label) {
      if (!displaySecondary.length) return "";
      var scoped = sv ? ((label != null && (byLabelSeries[label] || {})[sv]) || rows.filter(function (r) { return seriesKey(r) === sv; })) : rows;
      // 返回的是**已转义的** HTML 片段,调用方直接拼,不要再 esc 一次。
      return displaySecondary.map(function (sm) { return esc(sm.name) + " " + esc(metricValue(sm, aggregate(scoped, sm))); }).join(" · ");
    };

    if (type === "funnel") {
      /* 漏斗:默认按数值从大到小,「按环节顺序」时跟分类轴排序一致;每层标占第一层的比例。 */
      var fo = w.options.funnel || {};
      var byValue = labelOrder.slice().sort(function (a, b) { return aggregate(grouped[b] || [], activePie) - aggregate(grouped[a] || [], activePie); });
      var names = (fo.order === "category" ? labels : byValue).slice(0, w.options.topN > 0 ? w.options.topN : 20);
      var fData = names.map(function (name, i) {
        return { name: name, value: aggregate(grouped[name] || [], activePie), itemStyle: { color: colorOf(name) || palette[i % palette.length] } };
      });
      var head = fo.order === "category" ? (fData[0] ? fData[0].value : 0) : Math.max.apply(null, [0].concat(fData.map(function (d) { return d.value; })));
      var pdF = w.options.percentDecimals == null ? 1 : w.options.percentDecimals;
      var rate = function (v) { return head > 0 ? (v / head * 100).toFixed(pdF) + "%" : "--"; };
      var nfF = w.options.numberFormat;
      return {
        animation: true, animationDuration: 220, animationEasing: "linear",
        color: palette,
        tooltip: { trigger: "item", formatter: function (p) { return (p.marker || "") + " " + esc(p.name) + ": <b>" + esc(metricValue(activePie, numberValue(p.value), nfF)) + "</b> <span style=\"opacity:.6\">占第一层 " + rate(numberValue(p.value)) + "</span>"; } },
        series: [{
          name: metricLabel(activePie), type: "funnel",
          sort: fo.order === "category" ? "none" : "descending", funnelAlign: fo.align || "center",
          left: "4%", right: "4%", top: 6, bottom: 6, width: "92%", minSize: "8%", maxSize: "100%", gap: 2,
          label: { show: true, position: "inside", color: "#fff", fontSize: 12, overflow: "truncate", textShadowColor: "rgba(0,0,0,.35)", textShadowBlur: 3,
            formatter: function (p) { var v = scaled(numberValue(p.value), activePie.decimals, "", nfF, grouping); return fo.showRate === false ? p.name + "  " + v : p.name + "  " + v + " · " + rate(numberValue(p.value)); } },
          labelLine: { show: false },
          itemStyle: { borderColor: surface, borderWidth: 1 },
          data: fData,
        }],
      };
    }

    if (type === "pie") {
      /* 非正数的分组剔掉 —— 饼图表达不了负数(退款、冲账),留着 ECharts 会画出
         一块说不清的扇形。跟在线一套规则,省得导出的图和看板上不一样。 */
      var pieAll = labels.map(function (label) {
        var c = colorOf(label);
        var d = { name: label, value: aggregate(grouped[label] || [], activePie) };
        if (c) d.itemStyle = { color: c };
        return d;
      });
      var pieData = pieAll.filter(function (d) { return isFinite(d.value) && d.value > 0; });
      view.pieDropped = pieAll.length - pieData.length;
      var legendPos = co.pieLegendPosition;
      /* 半径和标签排版都走 pieGeometry.runtime.js —— 跟看板同一份实现,
         不在这儿另算。以前这儿内联抄了一份,收外圈时不管内圈,环被压成一条线。 */
      var pie = globalThis.__DASH_PIE__;
      var PL = pie.PIE_LABEL;
      var showLabels = co.pieShowLabels === true;
      var radii = pie.pieRadii(co.pieHole, co.pieOuterRadius, showLabels);
      return {
        animationDuration: 220, animationEasing: "linear", color: palette,
        tooltip: { trigger: "item", formatter: function (p) {
          var label = String(p.name == null ? "" : p.name);
          var extra = secondarySummary(grouped[label] || [], "");
          var head = (p.marker || "") + " " + esc(label) + ": <b>" + esc(metricValue(activePie, numberValue(p.value))) + "</b>"
            + (p.percent != null ? " <span style='opacity:.6'>" + esc(p.percent) + "%</span>" : "");
          return extra ? head + "<br/><span style='opacity:.6'>" + extra + "</span>" : head;
        } },
        legend: legendPos === "left" ? { show: w.options.showLegend, left: 0, top: "middle", orient: "vertical", textStyle: { color: muted } }
          : legendPos === "right" ? { show: w.options.showLegend, right: 0, top: "middle", orient: "vertical", textStyle: { color: muted } }
            : { show: w.options.showLegend, bottom: 0, textStyle: { color: muted } },
        series: [{
          name: metricLabel(activePie), type: "pie",
          radius: [radii[0] + "%", radii[1] + "%"],
          center: legendPos === "left" ? ["62%", "50%"] : legendPos === "right" ? ["40%", "50%"] : ["50%", "44%"],
          avoidLabelOverlap: true, percentPrecision: w.options.percentDecimals == null ? 1 : w.options.percentDecimals,
          label: Object.assign({ show: showLabels, color: muted, formatter: "{b}\n{d}%" }, PL.label),
          labelLine: PL.labelLine,
          labelLayout: PL.labelLayout,
          itemStyle: { borderColor: surface, borderWidth: 3, borderRadius: 4 },
          data: pieData,
        }],
      };
    }

    var buildSeries = function (metrics, yAxisIndex, isSingle, seriesType, stackId) {
      var out = [];
      metrics.forEach(function (metric) {
        var cats = seriesValues.length ? seriesValues : [""];
        cats.forEach(function (sv) {
          var custom = colorOf(sv) || colorOf(metricLabel(metric)) || colorOf(metric.name);
          var isBar = seriesType === "bar";
          var data = labels.map(function (label) {
            var rs = sv ? ((byLabelSeries[label] || {})[sv] || []) : (grouped[label] || []);
            return aggregate(rs, metric);
          });
          out.push({
            name: sv ? (metrics.length === 1 ? sv : (metricLabel(metric) + " · " + sv)) : metricLabel(metric),
            type: isBar ? "bar" : "line",
            data: data,
            smooth: w.options.smooth !== false,
            smoothMonotone: !isBar ? "x" : undefined,
            yAxisIndex: yAxisIndex,
            stack: stackId,
            barMaxWidth: 30,
            showSymbol: co.linePoints !== false,
            symbol: (labels.length > 24 || co.linePoints === false) ? "none" : "circle",
            symbolSize: 4,
            label: showValues ? { show: true, position: horizontal ? "right" : "top", color: muted, fontSize: 9, formatter: function (p) { return fmt(numberValue(p.value), metric.decimals, grouping); } } : undefined,
            itemStyle: isBar
              ? Object.assign({ borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] }, (custom || co.barColor) ? { color: custom || gradient(co.barColor, co.barEndColor || co.barColor, false) } : {})
              : (custom ? { color: custom } : undefined),
            lineStyle: !isBar ? Object.assign({ width: co.lineWidth || 2.4 }, custom ? { color: custom } : {}) : undefined,
            // 面积:跟在线一套 —— 没设过只给单条线淡影;「面积图」显式打开时每条都填
            areaStyle: isBar ? undefined
              : co.lineArea === true
                ? (isSingle ? { opacity: 0.32, color: gradient(custom || palette[0] || accent, "rgba(0,0,0,0)", true) } : (custom ? { opacity: 0.28, color: custom } : { opacity: 0.28 }))
                : (isSingle && co.lineArea !== false) ? { opacity: 0.18, color: gradient(custom || palette[0] || accent, "rgba(0,0,0,0)", true) } : undefined,
            tooltip: { valueFormatter: function (v) { return metricValue(metric, numberValue(v), w.options.numberFormat); } },
          });
        });
      });
      return out;
    };
    var primaryType = type === "bar" ? "bar" : "line";
    // v1:只画主指标;副指标不作为系列,仅在悬停 tooltip 中追加显示。
    var series = buildSeries(view.displayMetrics, 0, single, primaryType, co.stack ? "stack-primary" : undefined);
    var seriesCats = seriesValues.length ? seriesValues : [""];
    var seriesMetrics = [], seriesCatOf = [];
    view.displayMetrics.forEach(function (m) { seriesCats.forEach(function (sv) { seriesMetrics.push(m); seriesCatOf.push(sv); }); });
    var tooltipFormatter = function (params) {
      var arr = Array.isArray(params) ? params : [params];
      var x = String(arr[0] && (arr[0].axisValue != null ? arr[0].axisValue : arr[0].name) || "");
      var rows = grouped[x] || [];
      var lines = ["<div style='font-weight:600;margin-bottom:2px'>" + esc(x) + "</div>"];
      arr.forEach(function (p) {
        var m = seriesMetrics[p.seriesIndex];
        var val = m ? metricValue(m, numberValue(p.value)) : fmt(numberValue(p.value), 2, grouping);
        var extra = secondarySummary(rows, seriesCatOf[p.seriesIndex] || "", x);
        lines.push((p.marker || "") + " " + esc(p.seriesName || "") + ": <b>" + esc(val) + "</b>" + (extra ? " <span style='opacity:.6'>· " + extra + "</span>" : ""));
      });
      return lines.join("<br/>");
    };

    var ax = co.axis || {};
    var nf = w.options.numberFormat;
    var scaleDiv = SCALE_DIV[(nf && nf.scale) || "none"] || 1;
    var catAxis = { type: "category", data: labels, name: ax.xTitle || undefined, nameLocation: "middle", nameGap: 26, nameTextStyle: { color: muted, fontSize: 10 }, axisLabel: { color: muted, hideOverlap: true, fontSize: 10 }, axisLine: { lineStyle: { color: border } }, axisTick: { show: false } };
    var valAxis = { type: "value", name: ax.yTitle || axisUnit(view.displayMetrics), axisLabel: { color: muted, fontSize: 10, formatter: function (v) { return fmt(v / scaleDiv, nf && nf.scale && nf.scale !== "none" ? 1 : 0, false); } }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: ax.splitLine === true, lineStyle: { color: border, type: "dashed", opacity: .6 } } };
    if (ax.yMin != null) valAxis.min = ax.yMin;
    if (ax.yMax != null) valAxis.max = ax.yMax;
    var marks = (co.markLine || []).filter(function (m) { return isFinite(m.value); });
    if (marks.length && series.length) {
      series[0].markLine = { silent: true, symbol: "none", data: marks.map(function (m) {
        return { yAxis: m.value, lineStyle: { color: m.color || "#ffb547", type: "dashed", width: 1.5 },
                 label: { show: !!m.label, formatter: m.label || "", color: muted, fontSize: 10, position: "insideEndTop" } };
      }) };
    }
    var dense = co.dataZoom || labels.length > 24;
    return {
      animationDuration: 220, animationDurationUpdate: 220, animationEasing: "linear", animationEasingUpdate: "linear",
      color: palette,
      // 十字线交给 freeCrosshair(跟手、不吸附刻度),这里把 ECharts 自带的隐掉,免得两条。
      tooltip: { trigger: (co.tooltip && co.tooltip.mode === "item") ? "item" : "axis", formatter: tooltipFormatter, axisPointer: { type: "cross", snap: false, lineStyle: { color: "transparent", width: 0, opacity: 0 }, crossStyle: { color: "transparent", width: 0, opacity: 0 }, label: { show: false } } },
      // 窄屏(手机)上图例换行会压进绘图区,用可滚动单行避免。
      legend: (series.length > 1 && w.options.showLegend) ? { show: true, type: "scroll", top: 0, right: 8, left: 8, textStyle: { color: muted }, itemWidth: 10, itemHeight: 6 } : undefined,
      grid: { left: 12, right: 16, top: series.length > 1 ? 34 : 18, bottom: dense ? 34 : 8, containLabel: true },
      xAxis: horizontal ? valAxis : catAxis,
      yAxis: horizontal ? catAxis : valAxis,
      dataZoom: dense ? [Object.assign({ type: "slider", start: 0, end: labels.length > 24 ? Math.max(18, Math.round((24 / labels.length) * 100)) : 100, height: 12, bottom: 4, borderColor: "transparent", fillerColor: "rgba(132,145,255,.18)", backgroundColor: "rgba(255,255,255,.03)", showDetail: false }, horizontal ? { yAxisIndex: 0, width: 10, right: 2 } : { xAxisIndex: 0 })] : undefined,
      series: series,
    };
  }

  // ---- 渲染一个图表组件(含切换器 + 面包屑) ----
  function renderChart(bw, body) {
    clearNode(body);
    var view = computeChartView(bw);
    if (!view || !view.displayMetrics.length) { body.appendChild(stateBox("暂无数据")); return; }
    var st = stateOf(bw.widget.id);

    // 面包屑
    if (st.path.length) {
      var crumbs = el("div", "dash-x-crumbs");
      crumbs.appendChild(btn("全部", function () { st.path = []; renderChart(bw, body); }));
      st.path.forEach(function (item, idx) {
        var sep = document.createElement("span"); sep.className = "sep"; sep.textContent = "›"; crumbs.appendChild(sep);
        crumbs.appendChild(btn(item.value, function () { st.path = st.path.slice(0, idx + 1); renderChart(bw, body); }));
      });
      body.appendChild(crumbs);
    }
    // 切换器
    var chartOpt = bw.widget.options.chart || {};
    if (view.switching) {
      var bar = el("div", "dash-x-switch");
      if (chartOpt.metricSwitchTitle !== false) { var t = document.createElement("span"); t.textContent = "指标"; bar.appendChild(t); }
      var sel = document.createElement("select");
      view.choices.forEach(function (c) { var o = document.createElement("option"); o.value = c.id; o.textContent = c.label; if (view.activeChoice && c.id === view.activeChoice.id) o.selected = true; sel.appendChild(o); });
      sel.onchange = function () { st.active = sel.value; renderChart(bw, body); };
      bar.appendChild(sel); body.appendChild(bar);
    } else if (bw.widget.type === "pie" && bw.metrics.primary.length >= 2) {
      var bar2 = el("div", "dash-x-switch");
      var sel2 = document.createElement("select");
      view.primaryAll.forEach(function (m) { var o = document.createElement("option"); o.value = m.key; o.textContent = metricLabel(m); if (m.key === st.active) o.selected = true; sel2.appendChild(o); });
      sel2.onchange = function () { st.active = sel2.value; renderChart(bw, body); };
      bar2.appendChild(sel2); body.appendChild(bar2);
    }

    var option = buildChartOption(bw, view);
    if (bw.widget.type === "pie" || bw.widget.type === "funnel") {
      /* 一个正数都不剩就别画空饼了,说清是哪种情况 —— 跟在线一套说法。 */
      var slices = ((option.series || [])[0] || {}).data || [];
      if (!slices.length) {
        var dropped = view.pieDropped || 0;
        body.appendChild(stateBox(dropped
          ? dropped + " 个分组都不是正数,饼图表达不了 —— 换条形图看。"
          : "这个范围里没有数据。"));
        return;
      }
    }

    // 下钻深度(点击处理要用,得在 init 之前算好)
    var drillDims = bw.drillDimensions || [];
    var canDeeper = drillDims.length > 0 && st.path.length < drillDims.length;

    var holder = el("div", "dash-x-chart");
    body.appendChild(holder);
    /* **等卡片真的进了文档再初始化。**
       renderWidget 是先把整张卡片在内存里拼好、返回之后才 appendChild 进网格的,
       所以走到这儿时 holder 还是个游离节点,量出来 0×0。以前就在这儿直接 init:
       ECharts 拿到零尺寸,入场动画在一块 0×0 的画布上播完了;下一帧的 resize()
       才拿到真实尺寸,而 resize 是直接画最终状态、不重放入场动画 —— 于是导出的
       网页里图表总是「啪」一下出现,而软件里饼图是从一点展开的。
       下一帧再 init,尺寸已经对了,动画就跟软件里一样(参数本来就是同一组:
       220ms linear),那句补救的 resize 也不需要了。 */
    requestAnimationFrame(function () {
      if (!holder.isConnected) return;   // 这一帧之前就被重渲染掉了,别再建实例
      var inst = echarts.init(holder, null, { renderer: "canvas" });
      inst.setOption(option);
      if (bw.widget.type === "line" || bw.widget.type === "bar") {
        installFreeCrosshair(inst, bw.widget.type === "bar" && (bw.widget.options.chart || {}).barOrientation === "horizontal");
      }
      if (canDeeper) {
        inst.on("click", function (params) {
          if (params.name == null) return;
          st.path = st.path.concat([{ dimension: view.xField, value: params.name }]);
          renderChart(bw, body);
        });
      }
    });
    if (bw.widget.type === "pie" && view.pieDropped) {
      var note = el("div", "dash-x-note");
      note.textContent = "另有 " + view.pieDropped + " 个分组不是正数,未计入占比";
      body.appendChild(note);
    }


  }

  // ---- KPI ----
  function renderKpi(bw, body) {
    clearNode(body);
    var w = bw.widget, ko = w.options.kpi || {};
    var base = bw.data.base;
    if (!base) { body.appendChild(stateBox("暂无数据")); return; }
    var primary = withCi(bw.metrics.primary, base).slice(0, 6);
    var secondary = withCi(bw.metrics.secondary, base);
    if (!primary.length) { body.appendChild(stateBox("未选择指标")); return; }
    var align = ko.contentAlign || "left";
    var pd = w.options.percentDecimals == null ? 1 : w.options.percentDecimals;
    var cmp = bw.data.comparison || {};
    var period = cmp.period ? withCi(bw.metrics.primary, cmp.period) : null;
    var year = cmp.year ? withCi(bw.metrics.primary, cmp.year) : null;

    var changePct = function (m, pastTable, pastResolved) {
      if (!pastTable || m.dateScoped === false) return null;
      var pm = find(pastResolved || [], function (x) { return x.key === m.key; });
      if (!pm) return null;
      var prev = aggregate(pastTable.rows, pm);
      if (prev === 0) return null;
      return ((aggregate(base.rows, m) - prev) / prev) * 100;
    };
    var cmpText = function (v, label) { return v == null ? (label + " --") : (label + " " + (v >= 0 ? "↑" : "↓") + " " + Math.abs(v).toFixed(pd) + "%"); };

    var card = function (m) {
      var c = el("div", "dash-kpi");
      c.style.textAlign = align;
      c.style.alignItems = align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start";
      var label = el("span", "dash-kpi-label"); label.textContent = m.name; if (ko.labelSize) label.style.fontSize = ko.labelSize + "px";
      var strong = document.createElement("strong");
      strong.textContent = scaled(aggregate(base.rows, m), m.decimals, "", w.options.numberFormat, false);
      if (ko.valueColor) strong.style.color = ko.valueColor; if (ko.valueSize) strong.style.fontSize = ko.valueSize + "px";
      if (ko.labelPosition === "above") c.appendChild(label);
      c.appendChild(strong);
      if (ko.labelPosition !== "above") c.appendChild(label);
      if (ko.showComparison) {
        var box = el("div", "dash-kpi-compare layout-" + (ko.comparisonLayout || "inline"));
        box.style.fontSize = (ko.comparisonFontSize || 11) + "px";
        var p = changePct(m, cmp.period, period), y = changePct(m, cmp.year, year);
        var sp = document.createElement("small"); sp.textContent = cmpText(p, "环比"); if ((p || 0) >= 0) sp.className = "up"; box.appendChild(sp);
        var sy = document.createElement("small"); sy.textContent = cmpText(y, "同比"); if ((y || 0) >= 0) sy.className = "up"; box.appendChild(sy);
        c.appendChild(box);
      }
      if (ko.showSecondary && secondary.length) {
        var sec = el("div", "dash-kpi-secondary"); sec.style.fontSize = (ko.secondarySize || 13) + "px";
        secondary.forEach(function (sm) { var s = document.createElement("span"); s.textContent = sm.name + " "; var bold = document.createElement("b"); bold.textContent = scaled(aggregate(base.rows, sm), sm.decimals, "", w.options.numberFormat, false); s.appendChild(bold); sec.appendChild(s); });
        c.appendChild(sec);
      }
      return c;
    };

    var choices = buildMetricChoices(ko.displayMode, ko.metricGroups, primary).map(function (c) {
      return ko.displayMode === "group_switch" ? c : Object.assign({}, c, { label: (c.metrics[0] && c.metrics[0].name) || c.label });
    });
    if ((ko.displayMode === "switch" || ko.displayMode === "group_switch") && choices.length > 1) {
      var st = stateOf(w.id);
      var active = find(choices, function (c) { return c.id === st.active; }) || find(choices, function (c) { return c.id === ko.metricSwitchDefault; }) || choices[0];
      var bar = el("div", "dash-x-switch");
      if (ko.metricSwitchTitle !== false) { var tt = document.createElement("span"); tt.textContent = "指标"; bar.appendChild(tt); }
      var sel = document.createElement("select");
      choices.forEach(function (c) { var o = document.createElement("option"); o.value = c.id; o.textContent = c.label; if (c.id === active.id) o.selected = true; sel.appendChild(o); });
      sel.onchange = function () { st.active = sel.value; renderKpi(bw, body); };
      bar.appendChild(sel); body.appendChild(bar);
      var grid = el("div", "dash-kpi-grid count-" + Math.min(active.metrics.length, 6));
      active.metrics.forEach(function (m) { grid.appendChild(card(m)); }); body.appendChild(grid);
      return;
    }
    var grid2 = el("div", "dash-kpi-grid count-" + Math.min(primary.length, 6));
    primary.forEach(function (m) { grid2.appendChild(card(m)); }); body.appendChild(grid2);
  }

  // ---- 明细表(v1 简版:维度列 + 指标列,数字格式化 + 表头样式) ----
  function renderTable(bw, body) {
    clearNode(body);
    var base = bw.data.base;
    if (!base) { body.appendChild(stateBox("暂无数据")); return; }
    var primary = withCi(bw.metrics.primary, base).concat(withCi(bw.metrics.secondary, base));
    var metricCi = {}; primary.forEach(function (m) { metricCi[m.ci] = m; });
    var to = bw.widget.options.table || {};
    var wrap = el("div", "dash-x-tablewrap");
    var table = document.createElement("table"); table.className = "dash-x-table";
    var thead = document.createElement("thead"); var htr = document.createElement("tr");
    var specs = [];
    // 维度列头显示中文名(烘焙时带下来的),字段名仅作内部键。
    var dimLabels = bw.dimensionLabels || {};
    base.columns.forEach(function (name, i) { if (!metricCi[i]) specs.push({ label: dimLabels[name] || name, field: name, ci: i, metric: null }); });
    primary.forEach(function (m) { specs.push({ label: metricLabel(m), ci: m.ci, metric: m }); });

    var styleTh = function (th, isMetric) {
      if (to.headerBg) th.style.background = to.headerBg;
      if (to.headerText) th.style.color = to.headerText;
      if (to.headerAlign) th.style.textAlign = to.headerAlign;
      if (to.headerFontSize) th.style.fontSize = to.headerFontSize + "px";
      if (to.headerFontWeight) th.style.fontWeight = to.headerFontWeight;
      if (isMetric) th.style.textAlign = to.headerAlign || "right";
      return th;
    };
    var cell = function (value, metric) {
      var td = document.createElement("td");
      if (metric) { td.textContent = fmt(numberValue(value), metric.decimals, to.grouping === true) + (metric.unit || ""); td.className = "num"; }
      else td.textContent = value == null ? "" : String(value);
      return td;
    };

    // 透视(交叉表):列维度取值跨列成上层表头,下层是该组下的各指标 —— 与在线一致。
    var dimSpecs = specs.filter(function (s) { return !s.metric; });
    var colDims = dimSpecs.filter(function (s) { return (to.dimensionPlacements || {})[s.field] === "column"; });
    var pivot = to.layout === "pivot" && colDims.length > 0 && dimSpecs.length > colDims.length;
    var tbody = document.createElement("tbody");
    var totalRows = base.rows.length;
    var pageSize = Math.max(1, to.pageSize || 20);
    /* 点表头排序。离线页面里数据全在文件里,排序就是把行重排一遍再重画 ——
       跟看板上一个操作方式:点一下升序,再点降序,第三下回到原样。 */
    var st2 = stateOf(bw.widget.id);
    if (!st2.sort) st2.sort = null;
    var sortable = function (th, key, compare) {
      th.className = (th.className ? th.className + " " : "") + "sortable";
      if (st2.sort && st2.sort.key === key) {
        var mark = document.createElement("i");
        mark.className = "sortmark";
        mark.textContent = st2.sort.dir === "asc" ? " ↑" : " ↓";
        th.appendChild(mark);
      }
      th.onclick = function () {
        if (!st2.sort || st2.sort.key !== key) st2.sort = { key: key, dir: "asc", compare: compare };
        else if (st2.sort.dir === "asc") st2.sort = { key: key, dir: "desc", compare: compare };
        else st2.sort = null;
        renderTable(bw, body);
      };
      return th;
    };
    /* 数字按大小比,文本按拼音比(numeric 让「2 号店」排在「10 号店」前面)。
       空值永远排最后 —— 不管升序降序,一屏的空格挡在前面没法看。 */
    var compareValues = function (a, b) {
      var ea = a == null || a === "", eb = b == null || b === "";
      if (ea || eb) return ea && eb ? 0 : (ea ? 1 : -1);
      var na = Number(a), nb = Number(b);
      if (isFinite(na) && isFinite(nb)) return na - nb;
      return String(a).localeCompare(String(b), "zh-CN", { numeric: true });
    };
    var applySort = function (list, valueOf) {
      if (!st2.sort) return list;
      var dir = st2.sort.dir === "asc" ? 1 : -1;
      var keyed = list.map(function (item, i) { return { item: item, i: i, v: valueOf(item) }; });
      keyed.sort(function (x, y) {
        var c = compareValues(x.v, y.v);
        // 并列时保持原来的先后,免得每次重排结果都不一样
        return c !== 0 ? c * dir : x.i - y.i;
      });
      return keyed.map(function (k) { return k.item; });
    };
    var paint = function () {};
    /* 导出用的列和行 —— 跟屏幕上看到的一致(透视就导透视,平铺就导平铺)。
       指标列给 decimals,让它在 Excel 里是真数字而不是「1,234.56」这样的文本。 */
    var exportCols = [], exportRows = [];

    if (pivot) {
      var rowDims = dimSpecs.filter(function (s) { return colDims.indexOf(s) < 0; });
      var pivotKeys = [], seenKey = {}, groups = {}, order = [];
      /* 列头按层保留(大区一行、主管一行),不是拼成「北京大区 / 刘海涛」挤进一格。
         用 SOH 连接只是为了当 map 的键,渲染时再拆开。 */
      var keyOf = function (r, list) { return list.map(function (s) { return String(r[s.ci] == null ? "" : r[s.ci]); }).join("\u0001"); };
      base.rows.forEach(function (r) {
        var pk = keyOf(r, colDims);
        if (!seenKey[pk]) { seenKey[pk] = 1; pivotKeys.push(pk); }
        var rk = keyOf(r, rowDims);
        if (!groups[rk]) { groups[rk] = { dims: rowDims.map(function (s) { return r[s.ci]; }), vals: {} }; order.push(rk); }
        primary.forEach(function (m) { groups[rk].vals[pk + "\u0001" + m.key] = r[m.ci]; });
      });
      /* 列维度有几个就有几行表头,每行把「这一层连同它上面所有层」都相同的合并 ——
         只看本层的话,两个不同大区下同名的主管会被并成一格,数字就串了。 */
      pivotKeys.sort();
      var depth = colDims.length;
      var levelRows = [];
      for (var lv = 0; lv < depth; lv += 1) levelRows.push(document.createElement("tr"));
      rowDims.forEach(function (s2, di) {
        var th = styleTh(document.createElement("th"), false);
        th.textContent = s2.label; th.rowSpan = depth + 1;
        // 行维度列也能排(按网点名称、主管排),键用 d<第几个> 跟指标列的键区开
        htr.appendChild(sortable(th, "d" + di, null));
      });
      for (var lv2 = 0; lv2 < depth; lv2 += 1) {
        var row = lv2 === 0 ? htr : levelRows[lv2];
        var i = 0;
        while (i < pivotKeys.length) {
          var parts = pivotKeys[i].split("\u0001");
          var path = parts.slice(0, lv2 + 1).join("\u0001");
          var j = i;
          while (j < pivotKeys.length && pivotKeys[j].split("\u0001").slice(0, lv2 + 1).join("\u0001") === path) j += 1;
          var th2 = styleTh(document.createElement("th"), false);
          th2.textContent = parts[lv2];
          th2.colSpan = (j - i) * primary.length;
          th2.className = "grouphead group-start"; th2.style.textAlign = "center";
          row.appendChild(th2);
          i = j;
        }
      }
      var subRow = document.createElement("tr");
      /* 每一组列的第一格画条分界线 —— 一组(2026-08-01 的十一个指标)紧挨着下一组,
         不画线就看不出哪儿到头,扫一眼分不清这个「总GMV」是哪天的。跟看板上一致。 */
      pivotKeys.forEach(function (pk) {
        primary.forEach(function (m, mi) {
          var sub = styleTh(document.createElement("th"), true);
          sub.textContent = metricLabel(m);
          sub.className = "subhead" + (mi === 0 ? " group-start" : "");
          subRow.appendChild(sortable(sub, pk + "\u0001" + m.key, null));
        });
      });
      thead.appendChild(htr);
      for (var lv3 = 1; lv3 < depth; lv3 += 1) thead.appendChild(levelRows[lv3]);
      thead.appendChild(subRow);
      table.appendChild(thead);
      var sortedOrder = applySort(order, function (rk) {
        var key = String(st2.sort.key);
        // d<n> = 按第 n 个行维度排;否则是某一组下某个指标的值
        if (key.charAt(0) === "d" && key.indexOf("\u0001") < 0) return groups[rk].dims[Number(key.slice(1))];
        return groups[rk].vals[key];
      });
      paint = function (pg) {
        tbody.innerHTML = "";  // 表格的行容器,里面不会有图表实例
        sortedOrder.slice(pg * pageSize, (pg + 1) * pageSize).forEach(function (rk) {
        var g = groups[rk]; var tr = document.createElement("tr");
        g.dims.forEach(function (v) { tr.appendChild(cell(v, null)); });
        pivotKeys.forEach(function (pk) {
          primary.forEach(function (m, mi) {
            var td = cell(g.vals[pk + "\u0001" + m.key], m);
            if (mi === 0) td.className += " group-start";
            tr.appendChild(td);
          });
        });
        tbody.appendChild(tr);
        });
      };
      totalRows = sortedOrder.length;
      exportCols = rowDims.map(function (s2) { return { label: s2.label }; });
      pivotKeys.forEach(function (pk) {
        // 透视列头是分层的,导出是一行,拼回「大区 · 主管 · 指标」。
        var prefix = pk.split("\u0001").join(" · ");
        primary.forEach(function (m) { exportCols.push({ label: prefix + " · " + metricLabel(m), decimals: m.decimals == null ? 2 : m.decimals }); });
      });
      exportRows = sortedOrder.map(function (rk) {
        var g = groups[rk];
        var row = g.dims.slice();
        pivotKeys.forEach(function (pk) { primary.forEach(function (m) { row.push(g.vals[pk + "\u0001" + m.key]); }); });
        return row;
      });
    } else {
      specs.forEach(function (s2) {
        var th = styleTh(document.createElement("th"), !!s2.metric);
        th.textContent = s2.label;
        htr.appendChild(sortable(th, "c" + s2.ci, null));
      });
      thead.appendChild(htr); table.appendChild(thead);
      var flatRows = applySort(base.rows, function (r) {
        var ci = Number(String(st2.sort.key).slice(1));
        return r[ci];
      });
      totalRows = flatRows.length;
      exportCols = specs.map(function (s2) { return s2.metric ? { label: s2.label, decimals: s2.metric.decimals == null ? 2 : s2.metric.decimals } : { label: s2.label }; });
      exportRows = flatRows.map(function (r) { return specs.map(function (s2) { return r[s2.ci]; }); });
      paint = function (page) {
        tbody.innerHTML = "";  // 表格的行容器,里面不会有图表实例
        flatRows.slice(page * pageSize, (page + 1) * pageSize).forEach(function (r) {
          var tr = document.createElement("tr");
          specs.forEach(function (s) { tr.appendChild(cell(r[s.ci], s.metric)); });
          tbody.appendChild(tr);
        });
      };
    }
    /* 工具条:行列数 + 导出 Excel。跟看板上那颗按钮同一份实现(xlsx.runtime.js),
       所以导出来的文件格式、数字格式、冻结表头都一样。 */
    var xlsx = window.__DASH_XLSX__;
    if (xlsx && exportCols.length) {
      var tools = el("div", "dash-x-tabletools");
      var count = el("span", null);
      var btn2 = el("button", null);
      btn2.textContent = "导出 Excel";
      btn2.onclick = function () {
        btn2.disabled = true;
        xlsx.exportTable(bw.widget.title || "明细表", exportCols, exportRows).then(function (r) {
          btn2.disabled = false;
          if (r.format === "csv") count.textContent = "超出 Excel 单表上限,已导出 CSV";
        }, function () { btn2.disabled = false; btn2.textContent = "导出失败"; });
      };
      tools.appendChild(count); tools.appendChild(btn2);
      body.appendChild(tools);
    }
    table.appendChild(tbody); wrap.appendChild(table); body.appendChild(wrap);

    /* 分页。原来是把前五千行一次性建进 DOM —— 一百多列的明细表就是五十多万个单元格,
       打开这个网页要愣好几秒,而且滚动也卡。数据全都在文件里(一行不少),只是一次画一页。 */
    var page = 0;
    var pages = Math.max(1, Math.ceil(totalRows / pageSize));
    paint(0);
    if (pages > 1) {
      var pager = el("div", "dash-x-pager");
      var prev = el("button", null); prev.textContent = "‹";
      var label = el("span", null);
      var next = el("button", null); next.textContent = "›";
      var sync = function () {
        label.textContent = (page + 1) + " / " + pages + " · 共 " + totalRows + " 行";
        prev.disabled = page <= 0;
        next.disabled = page >= pages - 1;
      };
      prev.onclick = function () { if (page > 0) { page -= 1; paint(page); sync(); } };
      next.onclick = function () { if (page < pages - 1) { page += 1; paint(page); sync(); } };
      pager.appendChild(prev); pager.appendChild(label); pager.appendChild(next);
      sync();
      body.appendChild(pager);
    }
    if (base.capped) {
      var note = el("div", "dash-x-note");
      note.textContent = "数据量达到导出上限,只烘进了前 " + totalRows + " 行";
      body.appendChild(note);
    }
  }

  // ---- 文本 ----
  // ---- 散点 / 雷达 / 热力 / 矩形树 / 瀑布 / 排行榜(配置在 moreCharts.runtime.js,跟看板同一份) ----
  var MORE_TYPES = ["scatter", "radar", "heatmap", "treemap", "waterfall", "ranking"];
  function moreInput(bw, base, metrics) {
    var w = bw.widget, co = w.options.chart || {}, nf = w.options.numberFormat;
    var dims = (w.bindings.dimensions && w.bindings.dimensions.length) ? w.bindings.dimensions : (w.bindings.dimension ? [w.bindings.dimension] : []);
    return {
      rows: base.rows,
      dims: dims.map(function (d) { return colIndex(base, d); }).filter(function (i) { return i >= 0; }),
      series: w.bindings.seriesDimension ? colIndex(base, w.bindings.seriesDimension) : -1,
      measures: metrics.map(function (m) { return { name: m.name }; }),
      agg: function (rows, i) { return aggregate(rows, metrics[i]); },
      fmt: function (i, v) { return metricValue(metrics[i], v, nf); },
      palette: (co.palette && co.palette.length) ? co.palette : PALETTE,
      colorOf: function (name) { return co.dimensionColors ? co.dimensionColors[name] : undefined; },
      theme: { muted: cssVar("--text-3", "#8b96a8"), border: cssVar("--border", "rgba(140,150,170,.2)"), surface: cssVar("--surface", "#ffffff"), text: cssVar("--text", "#1c2434"), accent: cssVar("--accent", "#4d8dff") },
      opts: w.options, animation: true,
    };
  }
  function renderMore(bw, body) {
    clearNode(body);
    var w = bw.widget, base = bw.data.base;
    if (!base) { body.appendChild(stateBox("暂无数据")); return; }
    var metrics = withCi(bw.metrics.primary, base);
    if (!metrics.length) { body.appendChild(stateBox("未选择指标")); return; }
    var api = globalThis.__DASH_MORE__, input = moreInput(bw, base, metrics);
    if (w.type === "ranking") {
      var data = api.ranking(input);
      if (data.empty) { body.appendChild(stateBox(data.empty)); return; }
      var list = el("div", null);
      list.style.cssText = "height:100%;overflow:auto;display:flex;flex-direction:column;gap:9px;padding:2px";
      var medal = ["#e5a630", "#9aa4b2", "#c08457"], barColor = (w.options.ranking || {}).barColor || cssVar("--accent", "#4d8dff");
      data.items.forEach(function (it) {
        var row = el("div", null); row.style.cssText = "display:flex;gap:10px;align-items:flex-start";
        var no = el("span", null); no.textContent = it.rank;
        no.style.cssText = "flex:none;width:20px;height:20px;display:grid;place-items:center;border-radius:6px;font-size:11.5px;font-weight:600;" + (it.rank <= 3 ? "color:#fff;background:" + medal[it.rank - 1] : "background:var(--surface-3);color:var(--text-3)");
        var main = el("div", null); main.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column;gap:4px";
        var line = el("div", null); line.style.cssText = "display:flex;gap:8px;align-items:baseline;font-size:13px";
        var name = el("span", null); name.textContent = it.name; name.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
        var val = el("b", null); val.textContent = it.text; val.style.cssText = "flex:none;font-variant-numeric:tabular-nums";
        line.appendChild(name); line.appendChild(val);
        var track = el("div", null); track.style.cssText = "height:6px;border-radius:3px;background:var(--surface-3);overflow:hidden";
        var fill = el("i", null); fill.style.cssText = "display:block;height:100%;border-radius:3px;width:" + Math.round(it.ratio * 100) + "%;background:" + barColor;
        track.appendChild(fill);
        main.appendChild(line); main.appendChild(track);
        if (it.extra) { var ex = el("small", null); ex.textContent = it.extra; ex.style.cssText = "font-size:11px;opacity:.6"; main.appendChild(ex); }
        row.appendChild(no); row.appendChild(main); list.appendChild(row);
      });
      body.appendChild(list);
      return;
    }
    var option = api[w.type](input);
    if (option.empty) { body.appendChild(stateBox(option.empty)); return; }
    var holder = el("div", "dash-x-chart");
    body.appendChild(holder);
    requestAnimationFrame(function () {
      if (!holder.isConnected) return;
      echarts.init(holder, null, { renderer: "canvas" }).setOption(option);
    });
  }

  // ---- 图片 ----
  function renderImage(bw, body) {
    clearNode(body);
    var io = bw.widget.options.image || {};
    if (!io.src) { body.appendChild(stateBox("没有图片")); return; }
    var img = document.createElement("img");
    img.src = io.src; img.alt = io.name || bw.widget.title || "";
    img.style.cssText = "width:100%;height:100%;display:block;object-fit:" + (io.fit || "contain");
    body.appendChild(img);
  }

  // ---- 仪表盘 / 进度环(对齐 GaugeWidget) ----
  function niceMax(v) {
    if (!(v > 0)) return 100;
    var p = Math.pow(10, Math.floor(Math.log10(v))), steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * p >= v * 1.1) return steps[i] * p;
    return 10 * p;
  }
  function renderGauge(bw, body) {
    clearNode(body);
    var w = bw.widget, go = w.options.gauge || {};
    var base = bw.data.base;
    if (!base) { body.appendChild(stateBox("暂无数据")); return; }
    var m = withCi(bw.metrics.primary, base)[0];
    if (!m) { body.appendChild(stateBox("未选择指标")); return; }
    var ring = go.shape === "ring";
    var value = aggregate(base.rows, m);
    var target = go.target > 0 ? go.target : null;
    var max = go.max > 0 ? go.max : (target || niceMax(value));
    var ratio = target ? value / target : value / max;
    var color = go.colorByProgress ? (ratio < 0.6 ? "#ef5d6f" : ratio < 1 ? "#f2a93b" : "#2ebf8a") : (go.color || cssVar("--accent", "#4d8dff"));
    var nf = w.options.numberFormat;
    var pct = (ratio * 100).toFixed(w.options.percentDecimals == null ? 1 : w.options.percentDecimals) + "%";
    var width = ring ? 12 : 14;
    var common = { type: "gauge", min: 0, max: max, radius: ring ? "86%" : "96%", center: ring ? ["50%", "50%"] : ["50%", "62%"],
      startAngle: ring ? 90 : 205, endAngle: ring ? -270 : -25, splitNumber: 1,
      axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false }, anchor: { show: false }, detail: { show: false } };
    var series = [Object.assign({}, common, {
      progress: { show: true, width: width, roundCap: true, itemStyle: { color: color } },
      axisLine: { roundCap: true, lineStyle: { width: width, color: [[1, cssVar("--surface-3", "rgba(127,127,127,.15)")]] } },
      pointer: { show: false }, data: [{ value: Math.max(0, Math.min(value, max)) }],
    })];
    if (target && target < max && !ring) {
      series.push(Object.assign({}, common, { axisLine: { show: false }, progress: { show: false }, silent: true,
        pointer: { show: true, icon: "rect", length: width + 6, width: 3, offsetCenter: [0, "-89%"], itemStyle: { color: cssVar("--text-2", "#888") } },
        data: [{ value: target }] }));
    }
    var wrap = el("div", null);
    wrap.style.cssText = "position:relative;width:100%;height:100%;min-height:0";
    var holder = el("div", "dash-x-chart");
    holder.style.cssText = "position:absolute;inset:0";
    wrap.appendChild(holder);
    var center = el("div", null);
    center.style.cssText = "position:absolute;left:50%;top:" + (ring ? "50%" : "62%") + ";transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:2px;text-align:center;pointer-events:none;max-width:" + (ring ? "62%" : "78%");
    var strong = document.createElement("strong");
    strong.textContent = scaled(value, m.decimals, m.unit || "", nf, false);
    strong.style.cssText = "font-size:26px;font-weight:650;line-height:1.1;white-space:nowrap";
    var label = document.createElement("span");
    label.textContent = m.name;
    label.style.cssText = "font-size:12px;opacity:.6";
    center.appendChild(strong); center.appendChild(label);
    var caption = target ? "目标 " + scaled(target, m.decimals, m.unit || "", nf, false) + " · 完成 " + pct
      : go.max ? "满刻度 " + scaled(max, m.decimals, m.unit || "", nf, false) + " · " + pct : "";
    if (caption) { var c = document.createElement("span"); c.textContent = caption; c.style.cssText = "font-size:11.5px;opacity:.75;white-space:nowrap"; center.appendChild(c); }
    wrap.appendChild(center);
    body.appendChild(wrap);
    requestAnimationFrame(function () {
      if (!holder.isConnected) return;
      echarts.init(holder, null, { renderer: "canvas" }).setOption({ animation: true, animationDuration: 260, animationEasing: "linear", series: series });
    });
  }

  function renderText(bw, body) {
    clearNode(body);
    var tx = bw.widget.options.text || {};
    var d = el("div", "dash-x-text");
    d.textContent = bw.widget.options.content || "文本";
    d.style.fontSize = (tx.fontSize || 20) + "px";
    d.style.fontWeight = tx.fontWeight || 500;
    d.style.lineHeight = (tx.lineHeight || 150) + "%";
    d.style.textAlign = tx.align || "left";
    if (tx.color) d.style.color = tx.color;
    d.style.fontFamily = tx.fontFamily === "serif" ? "Georgia, 'Songti SC', serif" : tx.fontFamily === "mono" ? "ui-monospace, monospace" : "inherit";
    d.style.justifyContent = tx.verticalAlign === "top" ? "flex-start" : tx.verticalAlign === "bottom" ? "flex-end" : "center";
    body.appendChild(d);
  }

  // ---- 小工具 ----
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function btn(text, fn) { var b = document.createElement("button"); b.type = "button"; b.textContent = text; b.onclick = fn; return b; }
  function stateBox(text) { var e = el("div", "dash-x-state"); e.textContent = text; return e; }

  // ---- 卡片外壳 + 网格布局 ----
  /* Tab 容器。导出端原来直接把容器和它的子组件跳过了(见 mount 里的过滤),
     于是一个装着折线图和饼图的 Tab 容器导出来就是一片空白 —— 看板上有的东西,
     导出的页面里得有。这里按 tabId 分组,切页就重挂那一页的子组件。 */
  function renderContainer(bw, body) {
    var w = bw.widget;
    var cont = w.options.container || {};
    var tabs = (w.tabs || []).length ? w.tabs : [{ id: "", label: "Tab 1" }];
    var kids = (DATA.widgets || []).filter(function (x) { return x.widget.parentId === w.id && x.widget.visible; });
    var wrap = el("div", "dash-x-tabs");
    if (cont.tabPosition === "left") wrap.className += " left";

    var bar = el("div", "dash-x-tabbar");
    var pane = el("div", "dash-x-tabpane");
    var active = tabs[0].id;

    function paint() {
      clearNode(pane);
      var mine = kids.filter(function (x) { return (x.widget.tabId || tabs[0].id) === active; })
        .sort(function (a, b) { return (a.widget.y - b.widget.y) || (a.widget.x - b.widget.x); });
      if (!mine.length) { pane.appendChild(stateBox("这一页还没有组件")); return; }
      var grid = el("div", "dash-x-grid");
      mine.forEach(function (x) { grid.appendChild(renderWidget(x)); });
      pane.appendChild(grid);
      // 子组件里的图是新建的,得让它们量一次自己的大小。
      setTimeout(function () { liveCharts().forEach(function (c) { try { c.resize(); } catch (e) {} }); }, 0);
    }

    if (cont.showTabBar !== false && tabs.length) {
      tabs.forEach(function (tab) {
        var b = el("button", tab.id === active ? "on" : null);
        b.textContent = tab.label || "Tab";
        b.onclick = function () {
          active = tab.id;
          Array.prototype.forEach.call(bar.children, function (n) { n.className = ""; });
          b.className = "on";
          paint();
        };
        bar.appendChild(b);
      });
      wrap.appendChild(bar);
    }
    wrap.appendChild(pane);
    body.appendChild(wrap);
    paint();
  }

  /**
   * 组件级筛选器。数据全在这个文件里,所以离线端筛选就是把行过滤一遍再重画 ——
   * 不用回数据库。取值也是从烘进来的数据里现算的。
   *
   * 控件用的是 filterControls.runtime.js 里那两个(V1MultiSelect / DateRangePicker 的
   * 原生 JS 版),结构、类名、样式都跟看板上的一样 —— 用户要的是「和软件里一样」,
   * 不是「差不多」。哪些字段算日期也不在这儿猜,是烘数据时用 isTimeField 定好的。
   *
   * 只对「烘进来的表里真有这一列」的字段给筛选框:组件按大区分组的话,数据里就没有
   * 网点名称那一列,拿它筛是筛不出来的 —— 与其给个点了没反应的框,不如不给。
   */
  function renderFilters(bw, onChange) {
    var w = bw.widget;
    var base = bw.data && bw.data.base;
    var controls = window.__DASH_CONTROLS__;
    if (!w.filtersEnabled || !(w.filterFields || []).length || !base || !controls) return null;
    var labels = bw.dimensionLabels || {};
    var dateFields = bw.dateFilterFields || [];
    var scope = (DATA.scope || {});
    var state = {};
    var bar = el("div", "dash-component-filters");
    var any = false;

    w.filterFields.forEach(function (field) {
      var ci = base.columns.indexOf(field);
      if (ci < 0) return;
      var values = [], seen = {};
      base.rows.forEach(function (r) {
        var v = r[ci] == null ? "" : String(r[ci]);
        if (v && !seen[v]) { seen[v] = 1; values.push(v); }
      });
      if (!values.length) return;
      values.sort(function (a, b) { return a.localeCompare(b, "zh-CN", { numeric: true }); });
      any = true;

      if (dateFields.indexOf(field) >= 0) {
        // 日期:跟看板顶部同一个区间控件(今天/近 7 天/本月这些快捷项都在)。
        var wrapD = el("span", "dash-component-date");
        wrapD.appendChild(controls.dateRange({
          start: scope.start || values[0],
          end: scope.end || values[values.length - 1],
          onChange: function (from, to2) { state[field] = { from: from, to: to2 }; onChange(state); },
        }));
        bar.appendChild(wrapD);
        return;
      }

      var wrapS = el("span", "dash-component-select");
      wrapS.appendChild(controls.multiSelect({
        ariaLabel: labels[field] || field,
        placeholder: labels[field] || field,
        options: values.map(function (v) { return { value: v, label: v }; }),
        values: [],
        searchable: values.length > 12,
        onChange: function (picked) { state[field] = picked; onChange(state); },
      }));
      bar.appendChild(wrapS);
    });

    return any ? bar : null;
  }

  /** 按筛选条件过滤烘进来的行,产出一份「看起来一样、只是少了些行」的组件。 */
  function filtered(bw, state) {
    var base = bw.data && bw.data.base;
    if (!base) return bw;
    var rows = base.rows.filter(function (r) {
      for (var field in state) {
        var ci = base.columns.indexOf(field);
        if (ci < 0) continue;
        var v = r[ci] == null ? "" : String(r[ci]);
        var want = state[field];
        if (!want) continue;
        // 多选:一个没选 = 不筛(跟看板上一样,空表示全部)。
        if (Array.isArray(want)) { if (want.length && want.indexOf(v) < 0) return false; continue; }
        if (want.from && v < want.from) return false;
        if (want.to && v > want.to) return false;
      }
      return true;
    });
    var copy = Object.assign({}, bw);
    copy.data = Object.assign({}, bw.data, { base: Object.assign({}, base, { rows: rows }) });
    return copy;
  }

  function renderWidget(bw) {
    var w = bw.widget;
    var ap = w.options.appearance || {};
    var card = el("div", "dash-x-card");
    card.style.gridColumn = (w.x + 1) + " / span " + w.w;
    card.style.gridRow = (w.y + 1) + " / span " + w.h;
    // 选中视觉预设时,背景/边框/文字色交给 presets.css(data-visual-preset),内联不再覆盖(与在线一致)。
    var preset = ap.visualPreset && ap.visualPreset !== "none" ? ap.visualPreset : null;
    if (preset) card.setAttribute("data-visual-preset", preset);
    else {
      if (ap.background) card.style.background = ap.background;
      if (ap.borderColor) card.style.borderColor = ap.borderColor;
      if (ap.textColor) card.style.color = ap.textColor;
    }
    if (ap.borderWidth != null) card.style.borderWidth = ap.borderWidth + "px";
    if (ap.radius != null) card.style.borderRadius = ap.radius + "px";
    if (ap.shadow) card.style.boxShadow = "0 6px 20px rgba(0,0,0,.12)";

    if (!ap.hideTitle && w.type !== "text") {
      var head = el("div", "dash-x-head");
      var title = el("span", "dash-x-title"); title.textContent = w.title || "";
      if (ap.titleColor) title.style.color = ap.titleColor;
      if (ap.titleSize) title.style.fontSize = ap.titleSize + "px";
      if (ap.titleAlign) head.style.justifyContent = ap.titleAlign === "center" ? "center" : ap.titleAlign === "right" ? "flex-end" : "flex-start";
      head.appendChild(title);
      card.appendChild(head);
    }
    if (w.subtitle) { var sub = el("div", "dash-x-sub"); sub.textContent = w.subtitle; card.appendChild(sub); }
    var body = el("div", "dash-x-body");
    card.appendChild(body);

    if (w.type === "container") { renderContainer(bw, body); if (w.footnote) { var cf = el("div", "dash-x-foot"); cf.textContent = w.footnote; card.appendChild(cf); } return card; }
    if (bw.note) { body.appendChild(stateBox(bw.note)); return card; }
    var draw = function (view) {
      clearNode(body);
      try {
        if (w.type === "text") renderText(view, body);
        else if (w.type === "image") renderImage(view, body);
        else if (w.type === "gauge") renderGauge(view, body);
        else if (MORE_TYPES.indexOf(w.type) >= 0) renderMore(view, body);
        else if (w.type === "kpi") renderKpi(view, body);
        else if (w.type === "table") renderTable(view, body);
        else renderChart(view, body);
      } catch (e) { body.appendChild(stateBox("渲染出错:" + String(e))); }
    };
    var bar = renderFilters(bw, function (state) { draw(filtered(bw, state)); });
    if (bar) card.insertBefore(bar, body);
    draw(bw);
    if (w.footnote) { var foot = el("div", "dash-x-foot"); foot.textContent = w.footnote; card.appendChild(foot); }
    return card;
  }

  function mount() {
    var root = document.getElementById("dash-root");
    if (!root) return;
    // 头部
    var header = el("div", "dash-x-topbar");
    var h = el("div", "dash-x-titlewrap");
    var t1 = el("h1", null); t1.textContent = DATA.title || "看板"; h.appendChild(t1);
    if (DATA.description) { var d = el("p", null); d.textContent = DATA.description; h.appendChild(d); }
    header.appendChild(h);
    var meta = el("div", "dash-x-meta");
    meta.textContent = "数据范围 " + (DATA.scope ? (DATA.scope.start + " — " + DATA.scope.end) : "");
    meta.appendChild(document.createElement("br"));
    var generated = el("span", "gen");
    generated.textContent = "导出于 " + (DATA.generatedAt ? DATA.generatedAt.slice(0, 19).replace("T", " ") : "") + " · 离线快照";
    meta.appendChild(generated);
    header.appendChild(meta);
    root.appendChild(header);

    var grid = el("div", "dash-x-grid");
    // 按视觉位置(先上后左)排序:桌面端用的是显式 grid 定位、顺序无所谓,
    // 但手机上单列顺排时,DOM 顺序就是阅读顺序,必须和看板上看到的一致。
    var ordered = (DATA.widgets || []).slice().sort(function (a, b) {
      return (a.widget.y - b.widget.y) || (a.widget.x - b.widget.x);
    });
    ordered.forEach(function (bw) {
      var w = bw.widget;
      // 子组件由它所属的容器渲染,不再重复摆到顶层网格上;容器本身要渲染。
      if (!w.visible || w.parentId) return;
      grid.appendChild(renderWidget(bw));
    });
    root.appendChild(grid);
  }

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { liveCharts().forEach(function (c) { try { c.resize(); } catch (e) {} }); }, 120);
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
