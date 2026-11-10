/* 散点 / 雷达 / 热力 / 矩形树 / 瀑布 / 排行榜 —— 这几种图的 ECharts 配置(排行榜是数据)。
 *
 * 写成普通脚本是为了能原样内联进导出的离线网页:看板和导出页共用这一份,
 * 免得软件里一种画法、导出的网页里另一种。
 *
 * 调用方把自己那边的东西传进来,这里不碰任何框架:
 *   rows       查询结果的行
 *   dims       维度列的下标(按字段区顺序);series 是「拆分系列 / 纵轴」那一列的下标,没有就 -1
 *   measures   [{ name }],与 agg / fmt 的下标一一对应
 *   agg(rows, i)  把一组行合成第 i 个数值(两边各用自己的 aggregate,规则一致)
 *   fmt(i, v)     第 i 个数值的显示文本(单位、万/亿、前后缀)
 *   palette / colorOf(name) / theme { muted, border, surface, text, accent }
 *   opts       widget.options;animation 是否放入场动画
 *
 * 返回 ECharts option;数据不够画的时候返回 { empty: "说清缺什么" }。
 */
(function () {
  function esc(v) {
    var tip = globalThis.__DASH_TIP__;
    return tip ? tip.esc(v) : String(v == null ? "" : v);
  }
  function label(v) { return String(v == null ? "NULL" : v); }

  /** 按若干列分组,保持行出现的顺序(SQL 已经按设置排过)。 */
  function groupBy(rows, cis) {
    var order = [], map = {};
    for (var i = 0; i < rows.length; i++) {
      var parts = [];
      for (var j = 0; j < cis.length; j++) parts.push(label(rows[i][cis[j]]));
      var key = parts.join(" · ");
      if (!map[key]) { map[key] = []; order.push(key); }
      map[key].push(rows[i]);
    }
    return order.map(function (k) { return { name: k, rows: map[k] }; });
  }

  function anim(input) {
    return { animation: input.animation !== false, animationDuration: 220, animationDurationUpdate: 220, animationEasing: "linear", animationEasingUpdate: "linear" };
  }
  function colorAt(input, name, i) {
    return (input.colorOf && input.colorOf(name)) || input.palette[i % input.palette.length];
  }
  /** #rrggbb + 透明度;不是十六进制色就原样返回。 */
  function alpha(hex, a) {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
    var n = Math.round(a * 255).toString(16);
    return hex + (n.length < 2 ? "0" + n : n);
  }
  function valueAxis(input, name) {
    var t = input.theme;
    return {
      type: "value", scale: true, name: name, nameLocation: "middle", nameGap: 30,
      nameTextStyle: { color: t.muted, fontSize: 10 },
      axisLabel: { color: t.muted, fontSize: 10, hideOverlap: true },
      splitNumber: 4,
      axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: t.border, type: "dashed", opacity: 0.6 } },
    };
  }

  // ── 散点:看两个数值的关系(客单价 × 订单量),第三个数值当气泡大小 ──────────
  function scatter(input) {
    var m = input.measures, t = input.theme, so = (input.opts && input.opts.scatter) || {};
    if (m.length < 2) return { empty: "散点图要两个数值:第一个当横轴,第二个当纵轴(第三个可当气泡大小)。" };
    var pointCis = input.dims.length ? [input.dims[0]] : [];
    var groups = input.series >= 0 ? groupBy(input.rows, [input.series]).slice(0, 8) : [{ name: "", rows: input.rows }];
    var sized = m.length >= 3;
    var maxSize = 0, allX = [], allY = [];
    var built = groups.map(function (g) {
      var points = pointCis.length ? groupBy(g.rows, pointCis) : g.rows.map(function (r, i) { return { name: "#" + (i + 1), rows: [r] }; });
      return points.map(function (p) {
        var x = input.agg(p.rows, 0), y = input.agg(p.rows, 1), s = sized ? input.agg(p.rows, 2) : 0;
        if (s > maxSize) maxSize = s;
        allX.push(x); allY.push(y);
        return { name: p.name, value: [x, y, s] };
      });
    });
    if (!allX.length) return { empty: "这个范围里没有数据。" };
    var size = function (v) { return sized && maxSize > 0 ? 6 + Math.sqrt(Math.max(0, v[2]) / maxSize) * 34 : 10; };
    var series = groups.map(function (g, i) {
      var c = colorAt(input, g.name, i);
      return {
        type: "scatter", name: g.name || m[1].name, data: built[i], symbolSize: size,
        itemStyle: { color: alpha(c, 0.72), borderColor: c, borderWidth: 1 },
        emphasis: { focus: "series", label: { show: true, formatter: "{b}", position: "top", color: t.text, fontSize: 11 } },
        label: { show: so.showNames === true, formatter: "{b}", position: "right", color: t.muted, fontSize: 10 },
      };
    });
    /* 四象限:各画一条平均线,右上 = 两项都高于平均。 */
    if (so.quadrant) {
      var avg = function (a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s / a.length; };
      series[0].markLine = {
        silent: true, symbol: "none",
        lineStyle: { color: t.muted, type: "dashed", width: 1 },
        label: { color: t.muted, fontSize: 10, formatter: "平均" },
        data: [{ xAxis: avg(allX) }, { yAxis: avg(allY) }],
      };
    }
    return Object.assign(anim(input), {
      color: input.palette,
      legend: groups.length > 1 && input.opts.showLegend !== false ? { top: 0, right: 8, textStyle: { color: t.muted }, itemWidth: 10, itemHeight: 10 } : undefined,
      grid: { left: 16, right: 20, top: groups.length > 1 ? 30 : 14, bottom: 26, containLabel: true },
      tooltip: {
        trigger: "item",
        formatter: function (p) {
          var v = p.value || [];
          var lines = ["<b>" + esc(p.name) + "</b>" + (p.seriesName && groups.length > 1 ? " <span style=\"opacity:.6\">" + esc(p.seriesName) + "</span>" : "")];
          for (var i = 0; i < Math.min(3, m.length); i++) lines.push(esc(m[i].name) + ": <b>" + esc(input.fmt(i, v[i])) + "</b>");
          return lines.join("<br/>");
        },
      },
      xAxis: valueAxis(input, m[0].name),
      yAxis: Object.assign(valueAxis(input, m[1].name), { nameLocation: "end", nameGap: 8 }),
      series: series,
    });
  }

  // ── 雷达:几个对象在多项指标上的轮廓(门店 A/B 在客单、复购、毛利…上谁强) ──
  function radar(input) {
    var m = input.measures, t = input.theme, ro = (input.opts && input.opts.radar) || {};
    if (m.length < 3) return { empty: "雷达图至少要三个数值,每个数值是一条轴。" };
    var groups = input.dims.length ? groupBy(input.rows, [input.dims[0]]) : [{ name: "合计", rows: input.rows }];
    if (!input.rows.length) return { empty: "这个范围里没有数据。" };
    var limit = input.opts.topN > 0 ? input.opts.topN : groups.length;
    var scored = groups.map(function (g) {
      var vals = m.map(function (_, i) { return input.agg(g.rows, i); });
      return { name: g.name, vals: vals };
    }).sort(function (a, b) { return b.vals[0] - a.vals[0]; }).slice(0, limit);
    /* 每条轴各用自己的满刻度:金额几十万、复购率零点几,放一把尺子上就只剩一条线。 */
    var indicator = m.map(function (mm, i) {
      var max = 0;
      for (var k = 0; k < scored.length; k++) if (scored[k].vals[i] > max) max = scored[k].vals[i];
      return { name: mm.name, max: max > 0 ? max * 1.12 : 1 };
    });
    return Object.assign(anim(input), {
      color: input.palette,
      legend: scored.length > 1 && input.opts.showLegend !== false ? { top: 0, textStyle: { color: t.muted }, itemWidth: 10, itemHeight: 6, type: "scroll" } : undefined,
      tooltip: {
        trigger: "item",
        formatter: function (p) {
          var lines = ["<b>" + esc(p.name) + "</b>"];
          for (var i = 0; i < m.length; i++) lines.push(esc(m[i].name) + ": <b>" + esc(input.fmt(i, (p.value || [])[i])) + "</b>");
          return lines.join("<br/>");
        },
      },
      radar: {
        indicator: indicator, shape: ro.shape === "circle" ? "circle" : "polygon",
        radius: "58%", center: ["50%", scored.length > 1 ? "56%" : "52%"],
        axisName: { color: t.muted, fontSize: 11 },
        splitLine: { lineStyle: { color: t.border } },
        splitArea: { show: false },
        axisLine: { lineStyle: { color: t.border } },
      },
      series: [{
        type: "radar",
        data: scored.map(function (s, i) {
          var c = colorAt(input, s.name, i);
          return { name: s.name, value: s.vals, symbolSize: 4, itemStyle: { color: c }, lineStyle: { color: c, width: 2 }, areaStyle: { color: c, opacity: ro.fill === false ? 0 : 0.12 } };
        }),
      }],
    });
  }

  // ── 热力:两个维度交叉,颜色深浅是数值(星期 × 时段、门店 × 月份) ─────────────
  function heatmap(input) {
    var t = input.theme, ho = (input.opts && input.opts.heatmap) || {};
    if (!input.dims.length || input.series < 0) return { empty: "热力图要两个维度:一个放「横轴」,一个放「纵轴」。" };
    if (!input.measures.length) return { empty: "热力图要一个数值,颜色深浅就是它。" };
    var xi = input.dims[0], yi = input.series;
    var xs = [], ys = [], xIdx = {}, yIdx = {}, cells = {};
    for (var i = 0; i < input.rows.length; i++) {
      var r = input.rows[i], x = label(r[xi]), y = label(r[yi]);
      if (!(x in xIdx)) { xIdx[x] = xs.length; xs.push(x); }
      if (!(y in yIdx)) { yIdx[y] = ys.length; ys.push(y); }
      var key = xIdx[x] + "|" + yIdx[y];
      (cells[key] = cells[key] || []).push(r);
    }
    if (!xs.length) return { empty: "这个范围里没有数据。" };
    var data = [], min = Infinity, max = -Infinity;
    for (var k in cells) {
      var p = k.split("|"), v = input.agg(cells[k], 0);
      if (v < min) min = v;
      if (v > max) max = v;
      data.push([Number(p[0]), Number(p[1]), v]);
    }
    var base = ho.color || input.palette[0] || t.accent;
    /* 格子多了(按天 × 几百天)每格只剩一两个像素,再描 2px 的缝就整片看不见了。 */
    var dense = xs.length > 40 || ys.length > 30;
    var cat = function (list) {
      return { type: "category", data: list, splitArea: { show: false }, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: t.muted, fontSize: 10, hideOverlap: true } };
    };
    return Object.assign(anim(input), {
      tooltip: {
        trigger: "item",
        formatter: function (q) {
          var v = q.value || [];
          return esc(xs[v[0]]) + " · " + esc(ys[v[1]]) + "<br/>" + esc(input.measures[0].name) + ": <b>" + esc(input.fmt(0, v[2])) + "</b>";
        },
      },
      grid: { left: 8, right: 12, top: 8, bottom: 46, containLabel: true },
      xAxis: cat(xs),
      yAxis: Object.assign(cat(ys), { inverse: true }),
      visualMap: {
        min: min === max ? min - 1 : min, max: max, calculable: true, orient: "horizontal", left: "center", bottom: 0,
        itemHeight: 140, itemWidth: 10, textStyle: { color: t.muted, fontSize: 10 },
        formatter: function (v) { return input.fmt(0, v); },
        inRange: { color: [alpha(base, 0.08), alpha(base, 0.55), base] },
      },
      series: [{
        type: "heatmap", data: data,
        label: { show: ho.showValues === true, color: t.text, fontSize: 10, formatter: function (q) { return input.fmt(0, q.value[2]); } },
        itemStyle: dense ? { borderWidth: 0 } : { borderColor: t.surface, borderWidth: 2, borderRadius: 3 },
        emphasis: { itemStyle: { borderColor: t.text, borderWidth: 1 } },
      }],
    });
  }

  // ── 矩形树:面积就是占比,可以两层(大区 → 门店),点进去看下一层 ──────────────
  function treemap(input) {
    var t = input.theme;
    if (!input.dims.length || !input.measures.length) return { empty: "矩形树图要一个维度(可以两个,分两层)和一个数值。" };
    var total = 0;
    var top = groupBy(input.rows, [input.dims[0]]).map(function (g, i) {
      var node = { name: g.name, value: input.agg(g.rows, 0), itemStyle: { color: colorAt(input, g.name, i) } };
      if (input.dims.length > 1) {
        node.children = groupBy(g.rows, [input.dims[1]])
          .map(function (c) { return { name: c.name, value: input.agg(c.rows, 0) }; })
          .filter(function (c) { return c.value > 0; });
      }
      return node;
    }).filter(function (n) { return n.value > 0; });
    for (var i = 0; i < top.length; i++) total += top[i].value;
    if (!top.length) return { empty: "没有正数可以画 —— 矩形树图的面积表达不了 0 和负数。" };
    var nested = input.dims.length > 1;
    var pct = function (v) { return total > 0 ? (v / total * 100).toFixed(input.opts.percentDecimals == null ? 1 : input.opts.percentDecimals) + "%" : ""; };
    return Object.assign(anim(input), {
      tooltip: {
        formatter: function (p) {
          var path = (p.treePathInfo || []).slice(1).map(function (x) { return esc(x.name); }).join(" › ");
          return path + "<br/><b>" + esc(input.fmt(0, p.value)) + "</b> <span style=\"opacity:.6\">占全部 " + pct(p.value) + "</span>";
        },
      },
      series: [{
        type: "treemap", data: top, roam: false, top: 0, left: 0, right: 0, bottom: nested ? 24 : 0,
        nodeClick: nested ? "zoomToNode" : false,
        breadcrumb: { show: nested, bottom: 0, height: 18, itemStyle: { color: t.surface, borderColor: t.border, textStyle: { color: t.muted } } },
        label: { show: true, color: "#fff", fontSize: 12, overflow: "truncate", formatter: function (p) { return p.name + "\n" + input.fmt(0, p.value) + "  " + pct(p.value); } },
        upperLabel: { show: nested, height: 20, color: "#fff", fontSize: 11 },
        levels: [
          { itemStyle: { borderColor: t.surface, borderWidth: 2, gapWidth: 2 } },
          { colorSaturation: [0.35, 0.6], itemStyle: { borderColorSaturation: 0.7, gapWidth: 1, borderWidth: 1 } },
        ],
      }],
    });
  }

  // ── 瀑布:从起点一步步加减到终点(收入 → 各项成本 → 利润) ─────────────────────
  function waterfall(input) {
    var t = input.theme, wo = (input.opts && input.opts.waterfall) || {};
    if (!input.dims.length || !input.measures.length) return { empty: "瀑布图要一个维度(每一步)和一个数值(这一步的增减)。" };
    var steps = groupBy(input.rows, [input.dims[0]]).map(function (g) { return { name: g.name, value: input.agg(g.rows, 0) }; });
    if (!steps.length) return { empty: "这个范围里没有数据。" };
    var up = wo.upColor || input.palette[0] || t.accent, down = wo.downColor || "#ef5d6f", sum = wo.totalColor || "#8c99a8";
    var names = [], base = [], bars = [], cum = 0;
    for (var i = 0; i < steps.length; i++) {
      var d = steps[i].value, next = cum + d;
      names.push(steps[i].name);
      base.push(Math.min(cum, next));
      bars.push({ value: Math.abs(d), delta: d, itemStyle: { color: d >= 0 ? up : down, borderRadius: 3 } });
      cum = next;
    }
    if (wo.total !== false) {
      names.push(wo.totalLabel || "合计");
      base.push(Math.min(0, cum));
      bars.push({ value: Math.abs(cum), delta: cum, total: true, itemStyle: { color: sum, borderRadius: 3 } });
    }
    return Object.assign(anim(input), {
      tooltip: {
        trigger: "axis", axisPointer: { type: "shadow" },
        formatter: function (ps) {
          var p = (ps || []).filter(function (x) { return x.seriesIndex === 1; })[0];
          if (!p) return "";
          var d = p.data.delta;
          return "<b>" + esc(p.name) + "</b><br/>" + (p.data.total ? "合计 " : (d >= 0 ? "增加 " : "减少 ")) + "<b>" + esc(input.fmt(0, p.data.total ? d : Math.abs(d))) + "</b>";
        },
      },
      grid: { left: 12, right: 16, top: 22, bottom: 8, containLabel: true },
      xAxis: { type: "category", data: names, axisLine: { lineStyle: { color: t.border } }, axisTick: { show: false }, axisLabel: { color: t.muted, fontSize: 10, hideOverlap: true } },
      yAxis: Object.assign(valueAxis(input, ""), { scale: false }),
      series: [
        { type: "bar", stack: "w", silent: true, itemStyle: { color: "transparent" }, emphasis: { disabled: true }, data: base, barMaxWidth: 36 },
        {
          type: "bar", stack: "w", data: bars, barMaxWidth: 36,
          labelLayout: { hideOverlap: true },
          label: {
            show: wo.showValues !== false, position: "top", color: t.muted, fontSize: 10,
            formatter: function (p) { var d = p.data.delta; return p.data.total ? input.fmt(0, d) : (d >= 0 ? "+" : "−") + input.fmt(0, Math.abs(d)); },
          },
        },
      ],
    });
  }

  // ── 排行榜:名次 + 名字 + 进度条 + 数值,适合门店 / 商品排名 ─────────────────
  function ranking(input) {
    if (!input.dims.length || !input.measures.length) return { empty: "排行榜要一个维度(排名的对象)和一个数值。" };
    var ro = (input.opts && input.opts.ranking) || {};
    var limit = input.opts.topN > 0 ? input.opts.topN : Infinity;
    var items = groupBy(input.rows, [input.dims[0]]).map(function (g) {
      return { name: g.name, value: input.agg(g.rows, 0), extra: input.measures.length > 1 ? input.agg(g.rows, 1) : null };
    });
    if (!items.length) return { empty: "这个范围里没有数据。" };
    items.sort(function (a, b) { return ro.order === "asc" ? a.value - b.value : b.value - a.value; });
    items = items.slice(0, limit);
    var max = 0;
    for (var i = 0; i < items.length; i++) if (Math.abs(items[i].value) > max) max = Math.abs(items[i].value);
    return {
      items: items.map(function (it, i) {
        return {
          rank: i + 1, name: it.name, text: input.fmt(0, it.value),
          ratio: max > 0 ? Math.max(0, it.value) / max : 0,
          extra: it.extra == null ? "" : input.measures[1].name + " " + input.fmt(1, it.extra),
        };
      }),
    };
  }

  globalThis.__DASH_MORE__ = { scatter: scatter, radar: radar, heatmap: heatmap, treemap: treemap, waterfall: waterfall, ranking: ranking };
})();
