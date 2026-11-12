import { useEffect, useMemo } from "react";
import ReactEChartsCore from "echarts-for-react/lib/core";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import type { Cell, QueryResult } from "../types";
import { useApp } from "../store/appStore";

echarts.use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

const PALETTE = ["#7c9cff", "#4ec9a5", "#f7b267", "#c586c0", "#56b6c2", "#ff8fa3", "#e5c07b"];

function toNum(v: Cell): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))) return Number(v);
  return null;
}

function isNumericColumn(rows: Cell[][], c: number): boolean {
  let seen = 0;
  let numeric = 0;
  for (let i = 0; i < rows.length && seen < 40; i++) {
    const v = rows[i][c];
    if (v === null || v === undefined) continue;
    seen++;
    if (toNum(v) !== null) numeric++;
  }
  return seen > 0 && numeric / seen > 0.7;
}

interface Props {
  result: QueryResult;
  chartX?: string;
  chartY?: string[];
  onChange: (patch: { chartX?: string; chartY?: string[] }) => void;
}

export default function ChartView({ result, chartX, chartY, onChange }: Props) {
  const theme = useApp((s) => s.theme);
  const { columns, rows } = result;

  const numericCols = useMemo(
    () => columns.map((_c, i) => isNumericColumn(rows, i)),
    [columns, rows],
  );

  // Establish sensible defaults the first time.
  useEffect(() => {
    if (chartX !== undefined || columns.length === 0) return;
    const firstNonNumeric = columns.findIndex((_c, i) => !numericCols[i]);
    const x = columns[firstNonNumeric >= 0 ? firstNonNumeric : 0].name;
    const y = columns
      .filter((_c, i) => numericCols[i] && columns[i].name !== x)
      .slice(0, 3)
      .map((c) => c.name);
    onChange({ chartX: x, chartY: y.length ? y : [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, numericCols]);

  const css = (name: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;

  const option = useMemo(() => {
    const xIdx = columns.findIndex((c) => c.name === chartX);
    const xData = rows.map((r) => {
      const v = xIdx >= 0 ? r[xIdx] : "";
      return v === null || v === undefined ? "" : String(v);
    });
    const yNames = chartY ?? [];
    const series = yNames.map((name, si) => {
      const ci = columns.findIndex((c) => c.name === name);
      const color = PALETTE[si % PALETTE.length];
      return {
        name,
        type: "line",
        smooth: 0.35,
        showSymbol: rows.length <= 48,
        symbolSize: 5,
        lineStyle: { width: 2.2, color },
        itemStyle: { color },
        emphasis: { focus: "series" },
        areaStyle: si === 0 ? { color, opacity: 0.1 } : undefined,
        data: rows.map((r) => (ci >= 0 ? toNum(r[ci]) : null)),
      };
    });

    const axis = css("--text-3");
    const grid = css("--border");
    const text = css("--text-2");

    return {
      color: PALETTE,
      backgroundColor: "transparent",
      textStyle: { color: text, fontFamily: "inherit" },
      grid: { left: 56, right: 24, top: 34, bottom: 46 },
      tooltip: {
        trigger: "axis",
        backgroundColor: css("--surface-3"),
        borderColor: css("--border-2"),
        textStyle: { color: css("--text") },
      },
      legend: {
        top: 6,
        textStyle: { color: text },
        icon: "roundRect",
      },
      xAxis: {
        type: "category",
        data: xData,
        boundaryGap: false,
        axisLine: { lineStyle: { color: grid } },
        axisLabel: { color: axis, hideOverlap: true },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: grid, type: "dashed" } },
        axisLabel: { color: axis },
      },
      series,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, rows, chartX, chartY, theme]);

  const toggleY = (name: string) => {
    const cur = new Set(chartY ?? []);
    if (cur.has(name)) cur.delete(name);
    else cur.add(name);
    onChange({ chartY: [...cur] });
  };

  return (
    <div className="chart-view">
      <div className="chart-controls">
        <div className="field">
          <span>X</span>
          <select
            className="select"
            style={{ width: 160, height: 26 }}
            value={chartX ?? ""}
            onChange={(e) => onChange({ chartX: e.target.value })}
          >
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flexWrap: "wrap" }}>
          <span>Y</span>
          {columns.map((c, i) =>
            numericCols[i] ? (
              <span
                key={c.name}
                className={`ychip ${(chartY ?? []).includes(c.name) ? "on" : ""}`}
                onClick={() => toggleY(c.name)}
              >
                {c.name}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <div className="chart-canvas">
        <ReactEChartsCore
          echarts={echarts}
          option={option}
          style={{ height: "100%", width: "100%" }}
          notMerge
          lazyUpdate
        />
      </div>
    </div>
  );
}
