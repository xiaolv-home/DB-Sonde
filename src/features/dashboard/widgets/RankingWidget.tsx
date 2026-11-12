import type { CSSProperties } from "react";
import type { QueryResult } from "../../../types";
import type { DashboardWidget } from "../domain";
import type { ResolvedDashboardMetric } from "../metrics";
import { flowFrame } from "../chartLayout";
import { moreCharts } from "../moreCharts";
import { useChartBox } from "../useChartBox";
import { moreChartInput } from "./MoreChartWidget";

/** 排行榜:名次 + 名字 + 进度条 + 数值。前三名的名次加重。 */
export default function RankingWidget({ widget, result, metrics }: { widget: DashboardWidget; result: QueryResult; metrics: ResolvedDashboardMetric[] }) {
  const { ref, box } = useChartBox();
  const data = moreCharts().ranking(moreChartInput(widget, result, metrics));
  if (data.empty || !data.items) return <div className="dash-widget-state">{data.empty}</div>;
  const color = widget.options.ranking?.barColor;
  const frame = flowFrame({ kind: "ranking", width: box.width, height: box.height, count: data.items.length });
  const listStyle: CSSProperties = {
    width: "100%",
    maxWidth: frame.maxWidth ?? undefined,
    marginInline: frame.centerX ? "auto" : undefined,
  };
  return (
    <div ref={ref} className="dash-flow-frame">
    <ol className="dash-ranking" style={listStyle}>
      {data.items.map((it) => (
        <li key={it.rank} className={it.rank <= 3 ? `top top${it.rank}` : ""}>
          <span className="dash-rank-no">{it.rank}</span>
          <div className="dash-rank-main">
            <div className="dash-rank-line">
              <span className="dash-rank-name" title={it.name}>{it.name}</span>
              <b className="dash-rank-value">{it.text}</b>
            </div>
            <div className="dash-rank-bar"><i style={{ width: `${Math.round(it.ratio * 100)}%`, background: color }} /></div>
            {it.extra && <small className="dash-rank-extra">{it.extra}</small>}
          </div>
        </li>
      ))}
    </ol>
    </div>
  );
}
