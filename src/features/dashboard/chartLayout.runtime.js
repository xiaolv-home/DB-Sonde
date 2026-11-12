/* 卡片很宽或很高时，图表不该被拉散。
 *
 * 半径、绘图区、图例位置都按卡片的宽高算，并且封顶。窄卡片和普通卡片
 * 走原来的百分比排法 —— 短边本来就不大，标签贴着边沿刚好，收进来反而挤。
 *
 * 一份实现两处用:看板 import 它，导出的离线网页把同一个文件内联进去。
 * 这里不读颜色。轴、图例、扇区的颜色仍由调用方从 --chart-* / --text-* 取。
 */
(function () {
  /** 饼图外半径的像素上限。再大，标签和引线就又被甩开了。 */
  var MAX_PIE_RADIUS = 168;
  /** 折线 / 柱状 / 散点 / 热力 / 瀑布的绘图区上限，多出来的边距用来居中。 */
  var MAX_PLOT_W = 880;
  var MAX_PLOT_H = 460;
  /** 雷达半径、矩形树边长。都按短边缩放，到这儿就停。 */
  var MAX_RADAR = 200;
  var MAX_TREE = 560;

  function num(value, fallback) {
    return typeof value === "number" && isFinite(value) ? value : fallback;
  }

  /**
   * 外置标签贴着饼，而不是贴着卡片边。
   * length / length2 就是引线的上限:alignTo 用 labelLine，线有多长标签就停在那儿。
   */
  var NEAR_LABEL = {
    label: { alignTo: "labelLine", width: 78, overflow: "break", lineHeight: 15, bleedMargin: 6 },
    labelLine: { length: 12, length2: 10, maxSurfaceAngle: 80 },
    labelLayout: { hideOverlap: true },
  };

  function pieLegacy(spec, pct) {
    var pie = globalThis.__DASH_PIE__;
    var many = !!spec.manySlices;
    var pos = spec.legendPosition;
    var show = spec.showLegend !== false;
    var center = many ? ["36%", "50%"]
      : pos === "left" ? ["62%", "50%"]
      : pos === "right" ? ["40%", "50%"]
      : ["50%", "44%"];
    var legend;
    if (!show) legend = { show: false };
    else if (many) legend = { type: "scroll", orient: "vertical", right: 0, top: 8, bottom: 8, width: "28%" };
    else if (pos === "left") legend = { left: 0, top: "middle", orient: "vertical" };
    else if (pos === "right") legend = { right: 0, top: "middle", orient: "vertical" };
    else legend = { bottom: 0 };
    return {
      mode: "legacy",
      radius: [pct[0] + "%", pct[1] + "%"],
      center: center,
      label: pie.PIE_LABEL.label,
      labelLine: pie.PIE_LABEL.labelLine,
      labelLayout: pie.PIE_LABEL.labelLayout,
      legend: legend,
    };
  }

  /**
   * @param spec.width / height  图表区域的像素。0 表示还没量到，按原来的百分比排。
   * @param spec.hole / outer     用户设的内外半径百分比
   * @param spec.showLabels
   * @param spec.showLegend
   * @param spec.legendPosition   "left" | "right" | "bottom"
   * @param spec.manySlices       扇区多时图例改到右侧可滚动
   */
  function pieFrame(spec) {
    var pie = globalThis.__DASH_PIE__;
    var pct = pie.pieRadii(spec.hole, spec.outer, !!spec.showLabels);
    var legacy = pieLegacy(spec, pct);
    var w = num(spec.width, 0), h = num(spec.height, 0);
    if (!(w > 0 && h > 0)) return legacy;

    /* ECharts 的百分比半径是相对「短边的一半」。先按这个换成像素，再封顶。 */
    var natural = (pct[1] / 100) * (Math.min(w, h) / 2);
    var drawn = Math.round(Math.min(natural, MAX_PIE_RADIUS));
    var show = spec.showLegend !== false;
    var many = !!spec.manySlices;
    var pos = spec.legendPosition;
    var side = show && (many || pos === "left" || pos === "right");
    var onLeft = show && pos === "left" && !many;
    var bottom = show && !side;
    var legendW = !side ? 0 : (many ? Math.min(168, Math.round(w * 0.22)) : 128);
    var hSlack = w / 2 - drawn - (side ? legendW * 0.5 : 0);
    var vSlack = h / 2 - drawn - (bottom ? 28 : 0);
    var wide = hSlack > 168;
    var tall = vSlack > 160;
    var capped = natural > MAX_PIE_RADIUS + 0.5;
    if (!wide && !tall && !capped) return legacy;

    var inner = pct[1] > 0 ? Math.round(drawn * pct[0] / pct[1]) : 0;
    if (inner >= drawn) inner = Math.max(0, drawn - 1);
    var labelBand = spec.showLabels ? 92 : 10;
    var gap = side ? 14 : 0;
    var centerX = legacy.center[0];
    var centerY = legacy.center[1];
    var legend = {};
    var key;
    for (key in legacy.legend) legend[key] = legacy.legend[key];

    if (wide || (capped && side)) {
      var blockW = drawn * 2 + labelBand * 2 + (side ? gap + legendW : 0);
      var left0 = Math.max(4, Math.round((w - blockW) / 2));
      if (!show || bottom) {
        centerX = Math.round(w / 2);
        if (bottom) legend = { left: "center", bottom: 0 };
        if (!show) legend = { show: false };
      } else if (onLeft) {
        centerX = Math.round(left0 + legendW + gap + labelBand + drawn);
        legend = { left: left0, top: "middle", orient: "vertical", width: legendW };
      } else {
        centerX = Math.round(left0 + labelBand + drawn);
        var legendL = Math.round(centerX + drawn + labelBand + gap);
        if (legendL + legendW > w - 4) legendL = Math.max(4, w - legendW - 4);
        legend = many
          ? { type: "scroll", orient: "vertical", left: legendL, top: 8, bottom: 8, width: legendW }
          : { left: legendL, top: "middle", orient: "vertical", width: legendW };
      }
      centerX = Math.max(drawn + 4, Math.min(w - drawn - 4, centerX));
    }

    if (tall) {
      var below = bottom ? (spec.showLabels ? 72 : 12) : 0;
      var blockH = drawn * 2 + below + (bottom ? 24 : 0);
      var top0 = Math.max(4, Math.round((h - blockH) / 2));
      centerY = top0 + drawn;
      if (bottom) {
        legend.left = legend.left || "center";
        legend.top = Math.round(centerY + drawn + below);
        delete legend.bottom;
      } else if (side) {
        if (many) {
          var legendH = Math.round(Math.min(h - 16, Math.max(drawn * 2 + 24, 100)));
          legend.top = Math.max(4, Math.round(centerY - legendH / 2));
          legend.height = legendH;
          delete legend.bottom;
        } else {
          legend.top = "middle";
          delete legend.bottom;
          delete legend.height;
        }
      }
    }

    var near = wide || capped;
    var src = near ? NEAR_LABEL : pie.PIE_LABEL;
    return {
      mode: "framed",
      radius: [inner, drawn],
      center: [centerX, centerY],
      label: src.label,
      labelLine: src.labelLine,
      labelLayout: src.labelLayout,
      legend: legend,
    };
  }

  function cartesianGrid(spec) {
    var left = num(spec.left, 12);
    var right = num(spec.right, 16);
    var top = num(spec.top, 18);
    var bottom = num(spec.bottom, 8);
    var w = num(spec.width, 0), h = num(spec.height, 0);
    var maxW = num(spec.maxWidth, MAX_PLOT_W);
    var maxH = num(spec.maxHeight, MAX_PLOT_H);
    if (!(w > 0 && h > 0)) {
      return { left: left, right: right, top: top, bottom: bottom, containLabel: true, plotWidth: 0, plotHeight: 0 };
    }
    var extraW = Math.max(0, w - left - right - maxW);
    var extraH = Math.max(0, h - top - bottom - maxH);
    var grid = {
      left: left + extraW / 2,
      right: right + extraW / 2,
      top: top + extraH / 2,
      bottom: bottom + extraH / 2,
      containLabel: true,
    };
    grid.plotWidth = w - grid.left - grid.right;
    grid.plotHeight = h - grid.top - grid.bottom;
    return grid;
  }

  /** 图例跟着绘图区走。普通宽度仍是右上角那一点，不往里收。 */
  function cartesianLegend(grid, pad) {
    return {
      top: grid.top > pad.top + 1 ? Math.max(0, Math.round(grid.top - 26)) : 0,
      right: grid.right > pad.right + 1 ? Math.round(grid.right) : 8,
    };
  }

  /**
   * 把贴在卡片边上的控件挪到绘图区旁边。
   * 没有额外留白时原样返回 fallback，窄卡片的缩放条 / 色条位置不变。
   */
  function plotStick(grid, pad, edge, fallback, gap) {
    var padVal = edge === "right" ? pad.right : pad.bottom;
    var gridVal = edge === "right" ? grid.right : grid.bottom;
    if (gridVal > padVal + 1) return Math.max(fallback, Math.round(gridVal - gap));
    return fallback;
  }

  function placeZoom(grid, pad, axis) {
    if (axis === "y") return { right: plotStick(grid, pad, "right", 2, 16) };
    return { bottom: plotStick(grid, pad, "bottom", 4, 16) };
  }

  function axisFont(span) {
    if (span >= 760) return 12;
    if (span >= 640) return 11;
    return 10;
  }

  /**
   * 分类轴标签密度。窄卡片只靠 hideOverlap，不额外抽掉字。
   * 宽了才按能放下的个数设 interval，并略放大字号。
   */
  function categoryAxis(spec) {
    var span = num(spec.span, 0);
    var count = num(spec.count, 0);
    var fontSize = axisFont(span);
    var interval = 0;
    if (span >= 640 && count > 1) {
      var slot = span >= 760 ? 56 : 48;
      var fit = Math.max(2, Math.floor(span / slot));
      if (count > fit) interval = Math.ceil(count / fit) - 1;
    }
    return { interval: interval, hideOverlap: true, fontSize: fontSize };
  }

  /** 类目少、绘图区宽时柱子略加粗。窄的时候维持原来的 30。 */
  function barThickness(span, count) {
    if (!(span > 0) || !(count > 0)) return 30;
    var slot = span / count;
    if (slot < 110) return 30;
    return Math.round(Math.min(48, Math.max(30, slot * 0.38)));
  }

  function radarFrame(spec) {
    var hasLegend = spec.hasLegend !== false;
    var legacy = { radius: "58%", center: ["50%", hasLegend ? "56%" : "52%"], legendTop: 0 };
    var w = num(spec.width, 0), h = num(spec.height, 0);
    if (!(w > 0 && h > 0)) return legacy;
    var short = Math.min(w, h);
    var natural = short * 0.58 / 2;
    /* 百分比半径已经按短边走，也已经居中。只在短边大到封顶时改成像素。 */
    if (natural <= MAX_RADAR + 0.5) return legacy;
    var r = MAX_RADAR;
    var cy = Math.round(h / 2 + (hasLegend ? 8 : 0));
    return {
      radius: r,
      center: [Math.round(w / 2), cy],
      legendTop: Math.max(0, cy - r - 36),
      fontSize: 12,
    };
  }

  function treemapFrame(spec) {
    var crumb = spec.breadcrumb ? 24 : 0;
    var w = num(spec.width, 0), h = num(spec.height, 0);
    if (!(w > 0 && h > 0)) return { left: 0, top: 0, right: 0, bottom: crumb, breadcrumbBottom: 0 };
    var innerH = Math.max(0, h - crumb);
    var side = Math.min(Math.min(w, innerH), MAX_TREE);
    var spareX = w - side;
    var spareY = innerH - side;
    if (spareX < 160 && spareY < 160) return { left: 0, top: 0, right: 0, bottom: crumb, breadcrumbBottom: 0 };
    var left = spareX >= 160 ? Math.round((w - side) / 2) : 0;
    var top = spareY >= 160 ? Math.round((innerH - side) / 2) : 0;
    var right = spareX >= 160 ? w - left - side : 0;
    var bottom = spareY >= 160 ? h - top - side : crumb;
    return {
      left: left, top: top, right: right, bottom: bottom,
      breadcrumbBottom: bottom > crumb + 8 ? Math.round(bottom - 22) : 0,
    };
  }

  /**
   * KPI / 排行榜的内容块。普通卡片返回 null，调用方不设 max-width，铺法和现在一样。
   * 超宽才限制宽度并居中；KPI 超高时再限制高度，避免数字飘在一大片空白中间。
   */
  function flowFrame(spec) {
    var kind = spec.kind;
    var count = Math.max(1, num(spec.count, 1));
    var w = num(spec.width, 0), h = num(spec.height, 0);
    var maxW = kind === "ranking" ? 560 : (count <= 1 ? 440 : count === 2 ? 700 : 960);
    var maxH = kind === "ranking" ? 0 : (count <= 3 ? 220 : 360);
    if (!(w > 0 && h > 0)) return { maxWidth: null, maxHeight: null, centerX: false, centerY: false };
    var centerX = w > maxW + 64;
    var centerY = kind === "kpi" && maxH > 0 && h > maxH + 180;
    return {
      maxWidth: centerX ? maxW : null,
      maxHeight: centerY ? maxH : null,
      centerX: centerX,
      centerY: centerY,
    };
  }

  globalThis.__DASH_LAYOUT__ = {
    MAX_PIE_RADIUS: MAX_PIE_RADIUS,
    MAX_PLOT_W: MAX_PLOT_W,
    MAX_PLOT_H: MAX_PLOT_H,
    MAX_RADAR: MAX_RADAR,
    MAX_TREE: MAX_TREE,
    NEAR_LABEL: NEAR_LABEL,
    pieFrame: pieFrame,
    cartesianGrid: cartesianGrid,
    cartesianLegend: cartesianLegend,
    plotStick: plotStick,
    placeZoom: placeZoom,
    axisFont: axisFont,
    categoryAxis: categoryAxis,
    barThickness: barThickness,
    radarFrame: radarFrame,
    treemapFrame: treemapFrame,
    flowFrame: flowFrame,
  };
})();
