/* 一份实现两处用:在线看板(freeCrosshair.ts)与导出离线 HTML(standalone.runtime.js)共用同一套
 * 基于 zrender 的自由准星,避免两处样式、数值格式化或销毁逻辑走散。 */
(function (root) {
  "use strict";

  function installFreeCrosshair(echartsLib, chart, options) {
    var g = echartsLib && echartsLib.graphic;
    var zr = chart && chart.getZr && chart.getZr();
    if (!g || !g.Group || !g.Line || !g.Text || !zr) {
      return function () {};
    }
    var horizontalValueAxis = !!(options && options.horizontalValueAxis);
    var order = { zlevel: 100, z: 100, z2: 100000 };
    var lineStyle = {
      stroke: (options && options.lineColor) || "#8b96a8",
      lineWidth: 1,
      lineDash: [5, 5],
      opacity: 0.92,
    };
    var group = new g.Group(Object.assign({ silent: true, invisible: true }, order));
    var vertical = new g.Line(Object.assign({ silent: true, style: lineStyle }, order));
    var horizontal = new g.Line(Object.assign({ silent: true, style: lineStyle }, order));
    var label = new g.Text(
      Object.assign(
        {
          silent: true,
          style: {
            fill: (options && options.labelColor) || "#e8edf6",
            backgroundColor: (options && options.labelBackground) || "#1a2230",
            borderColor: (options && options.labelBorder) || "rgba(151,170,203,.24)",
            borderWidth: 1,
            borderRadius: 4,
            padding: [4, 7],
            font: "600 11px Inter, PingFang SC, sans-serif",
            align: "left",
            verticalAlign: "middle",
          },
        },
        order,
      ),
    );
    group.add(vertical);
    group.add(horizontal);
    group.add(label);
    zr.add(group);

    var latest = null;
    var frame = 0;
    var hide = function () {
      latest = null;
      group.attr({ invisible: true });
    };
    var paint = function () {
      frame = 0;
      if (!latest || chart.isDisposed()) return;
      var model = chart.getModel && chart.getModel();
      var comp = model && model.getComponent && model.getComponent("grid", 0);
      var rect =
        comp &&
        comp.coordinateSystem &&
        comp.coordinateSystem.getRect &&
        comp.coordinateSystem.getRect();
      if (!rect) return;
      var x = latest.x;
      var y = latest.y;
      if (x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) {
        hide();
        return;
      }
      var coord = chart.convertFromPixel({ gridIndex: 0 }, [x, y]);
      var value = Number(Array.isArray(coord) ? coord[horizontalValueAxis ? 0 : 1] : coord);
      vertical.setShape({ x1: x, y1: rect.y, x2: x, y2: rect.y + rect.height });
      horizontal.setShape({ x1: rect.x, y1: y, x2: rect.x + rect.width, y2: y });
      var shown = "";
      if (isFinite(value)) {
        shown =
          options && typeof options.formatValue === "function"
            ? options.formatValue(value)
            : value.toLocaleString("en-US", { maximumFractionDigits: 2, useGrouping: false });
      }
      label.setStyle({
        text: shown,
        x: horizontalValueAxis ? x : rect.x + 2,
        y: horizontalValueAxis ? rect.y + rect.height - 2 : y,
        align: horizontalValueAxis ? "center" : "left",
        verticalAlign: horizontalValueAxis ? "bottom" : "middle",
      });
      group.attr({ invisible: false });
    };
    var move = function (e) {
      latest = { x: e.offsetX, y: e.offsetY };
      if (!frame) frame = requestAnimationFrame(paint);
    };
    zr.on("mousemove", move);
    zr.on("globalout", hide);
    return function () {
      if (frame) cancelAnimationFrame(frame);
      zr.off("mousemove", move);
      zr.off("globalout", hide);
      zr.remove(group);
    };
  }

  root.__DASH_CROSSHAIR__ = { installFreeCrosshair: installFreeCrosshair };
})(globalThis);
