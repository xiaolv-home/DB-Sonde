/* 下钻该画哪一层、该发哪几次查询。
 *
 * 点下去的瞬间路径先变、查询还没回来。要是马上按新维度去旧结果里找列,
 * 列不存在,组件被换成空状态;查询回来再挂上图表,尺寸从 0 量起,ECharts
 * 再 setOption 一遍 —— 看起来就是「进去之后自己又刷新了一次」。
 * 所以:列还对不上的时候,画面停在上一层;对上了才切。查询按最终路径发一次。
 *
 * 一份实现两处用:看板 import 它,测试直接加载这份脚本。这里不读颜色。
 */
(function () {
  /** 折线 / 柱 / 饼 / 漏斗走多级下钻查询。矩形树的下钻是图内缩放,不另发查询。 */
  var DRILL_TYPES = { line: 1, bar: 1, pie: 1, funnel: 1 };

  function drillDimensionsOf(widget) {
    if (!widget || !DRILL_TYPES[widget.type]) return [];
    var dims = widget.options && widget.options.chart && widget.options.chart.drillDimensions;
    return dims && dims.length ? dims.slice() : [];
  }

  /**
   * 画面上该显示的路径。requested 是用户点到的那条,columnNames 是当前这份结果的列。
   * 目标层的维度列还没到,就维持 prev,别拿旧数据套新维度。
   */
  function nextShownPath(prev, requested, columnNames, drillDims, bound) {
    var dims = drillDims || [];
    var path = requested || [];
    var level = path.length > dims.length ? dims.length : path.length;
    var dim = level > 0 ? dims[level - 1] : (bound || "");
    var names = columnNames || [];
    var ok = !dim;
    for (var i = 0; !ok && i < names.length; i++) if (names[i] === dim) ok = true;
    if (!ok) return prev || [];
    return path.slice(0, level);
  }

  /**
   * 这一轮真正要发的下钻查询。路径为空的不发(回到顶层用基础那份)。
   * owned[id] 为真的组件交给组件筛选那一路,这里不再发第二次。
   */
  function widgetsToFetch(widgets, paths, owned) {
    var out = [];
    var list = widgets || [];
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      var dims = drillDimensionsOf(w);
      if (!dims.length) continue;
      if (owned && owned[w.id]) continue;
      var path = (paths && paths[w.id]) || [];
      if (!path.length) continue;
      var level = path.length > dims.length ? dims.length : path.length;
      out.push({ id: w.id, groupBy: dims[level - 1], level: level });
    }
    return out;
  }

  /** 键集合没变就交回原来的表,避免一次下钻先白渲染一帧。 */
  function retainDrillMap(current, ids) {
    var map = current || {};
    var keys = Object.keys(map);
    var keep = {};
    for (var i = 0; i < ids.length; i++) keep[ids[i]] = 1;
    var dropped = false;
    for (var j = 0; j < keys.length; j++) if (!keep[keys[j]]) dropped = true;
    if (!dropped) return current;
    var next = {};
    for (var k = 0; k < keys.length; k++) if (keep[keys[k]]) next[keys[k]] = map[keys[k]];
    return next;
  }

  /** 前后两帧的绘制输入是否变了。没变就不要 setOption,实例留着。 */
  function paintChanged(prev, next) {
    if (!prev || !next || prev.length !== next.length) return true;
    for (var i = 0; i < prev.length; i++) if (prev[i] !== next[i]) return true;
    return false;
  }

  globalThis.__DASH_DRILL__ = {
    DRILL_TYPES: DRILL_TYPES,
    drillDimensionsOf: drillDimensionsOf,
    nextShownPath: nextShownPath,
    widgetsToFetch: widgetsToFetch,
    retainDrillMap: retainDrillMap,
    paintChanged: paintChanged,
  };
})();
