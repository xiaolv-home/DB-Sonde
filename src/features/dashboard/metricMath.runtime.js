/* 一份实现两处用:在线看板组件(metricUtils.ts)与导出离线 HTML(standalone.runtime.js)共用同一套
 * 数值换算、格式化、聚合(含已分组 count 求和、count_distinct 平均、循环极值防爆栈)与指标切换构造。 */
(function (root) {
  "use strict";

  var SCALE_DIV = { none: 1, wan: 1e4, yi: 1e8 };
  var SCALE_WORD = { none: "", wan: "万", yi: "亿" };

  function numberValue(v) {
    if (typeof v === "number") return isFinite(v) ? v : 0;
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function formatNumber(v, decimals, grouping) {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: decimals == null ? 2 : decimals,
      useGrouping: !!grouping,
    }).format(v);
  }

  function scaleFor(v, scale) {
    if (scale !== "auto") return scale || "none";
    var size = Math.abs(v);
    return size >= 1e8 ? "yi" : size >= 1e4 ? "wan" : "none";
  }

  function scaledText(v, decimals, unit, nf, grouping) {
    nf = nf || {};
    var key = scaleFor(v, nf.scale);
    var text = formatNumber(v / (SCALE_DIV[key] || 1), decimals, grouping);
    var suffix = nf.suffix == null ? (SCALE_WORD[key] || "") + (unit || "") : nf.suffix;
    return (nf.prefix || "") + text + suffix;
  }

  function metricLabel(m) {
    var u = m && m.unit ? m.unit.trim() : "";
    return u ? m.name + " (" + u + ")" : m.name;
  }

  function metricValue(m, v, nf) {
    return scaledText(v, m.decimals, m.unit || "", nf, false);
  }

  /** 对已按 SQL 分组后的行按列下标 colIdx 汇总。循环算极值,不在参数列表里展开长数组。 */
  function aggregateColumn(rows, colIdx, aggregation) {
    var vals = [];
    for (var i = 0; i < rows.length; i += 1) {
      var cell = rows[i] ? rows[i][colIdx] : null;
      if (cell != null) vals.push(numberValue(cell));
    }
    if (!vals.length) return 0;
    if (aggregation === "avg" || aggregation === "count_distinct") {
      var sumAvg = 0;
      for (var j = 0; j < vals.length; j += 1) sumAvg += vals[j];
      return sumAvg / vals.length;
    }
    if (aggregation === "min") {
      var minVal = vals[0];
      for (var mi = 1; mi < vals.length; mi += 1) {
        if (vals[mi] < minVal) minVal = vals[mi];
      }
      return minVal;
    }
    if (aggregation === "max") {
      var maxVal = vals[0];
      for (var ma = 1; ma < vals.length; ma += 1) {
        if (vals[ma] > maxVal) maxVal = vals[ma];
      }
      return maxVal;
    }
    // sum / count(SQL 已分组计数,合并时将各组计数相加)
    var total = 0;
    for (var k = 0; k < vals.length; k += 1) total += vals[k];
    return total;
  }

  function axisUnit(metrics) {
    var seen = [];
    for (var i = 0; i < metrics.length; i += 1) {
      var u = metrics[i] && metrics[i].unit ? metrics[i].unit.trim() : "";
      if (u && seen.indexOf(u) < 0) seen.push(u);
    }
    return seen.length === 1 ? seen[0] : "";
  }

  function buildMetricChoices(displayMode, groups, metrics, fallbackLabel) {
    var fallback = fallbackLabel || "指标";
    if (displayMode === "group_switch") {
      var list = groups || [];
      var out = [];
      for (var i = 0; i < list.length; i += 1) {
        var g = list[i];
        var matched = [];
        for (var j = 0; j < metrics.length; j += 1) {
          if (g.metricIds && g.metricIds.indexOf(metrics[j].key) >= 0) matched.push(metrics[j]);
        }
        if (matched.length > 0) {
          out.push({ id: g.id, label: g.label || fallback, metrics: matched });
        }
      }
      return out;
    }
    var singles = [];
    for (var s = 0; s < metrics.length; s += 1) {
      var m = metrics[s];
      singles.push({ id: m.key, label: metricLabel(m), metrics: [m] });
    }
    return singles;
  }

  root.__DASH_MATH__ = {
    SCALE_DIV: SCALE_DIV,
    SCALE_WORD: SCALE_WORD,
    numberValue: numberValue,
    formatNumber: formatNumber,
    scaleFor: scaleFor,
    scaledText: scaledText,
    metricLabel: metricLabel,
    metricValue: metricValue,
    aggregateColumn: aggregateColumn,
    axisUnit: axisUnit,
    buildMetricChoices: buildMetricChoices,
  };
})(globalThis);
