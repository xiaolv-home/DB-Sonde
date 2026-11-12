import type { QueryResult } from "../../../types";
import type { DashboardWidget } from "../domain";
import type { ResolvedDashboardMetric } from "../metrics";
import { moreCharts } from "../moreCharts";
import { moreChartInput } from "./MoreChartWidget";

/** 排行榜:名次 + 名字 + 进度条 + 数值。前三名的名次加重。 */
export default function RankingWidget({ widget, result, metrics }: { widget: DashboardWidget; result: QueryResult; metrics: ResolvedDashboardMetric[] }) {
  const data = moreCharts().ranking(moreChartInput(widget, result, metrics));
  if (data.empty || !data.items) return <div className="dash-widget-state">{data.empty}</div>;
  const color = widget.options.ranking?.barColor;
  return (
    <ol className="dash-ranking">
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
  );
}
