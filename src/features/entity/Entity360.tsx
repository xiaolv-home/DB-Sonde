import { useMemo } from "react";
import { X, Gauge, Sparkles, Table2, TableProperties, Clock } from "lucide-react";
import { useEntity, type EntityTarget } from "./entityStore";
import { useFreshness } from "./freshness";
import { useMetrics } from "../metrics/metricsStore";
import { buildEntityPrompt, collectEntityFacts } from "./entityPrompt";
import { useAi } from "../ai/aiStore";
import { useApp, type TreeNode } from "../../store/appStore";
import "./entity.css";

/* 表详情抽屉(侧栏右键表 →「表详情」):数据新鲜度、建在它上的指标,一键打开数据 / 问 AI。 */
export default function Entity360() {
  const target = useEntity((s) => s.target);
  const metrics = useMetrics((s) => s.metrics);
  const freshness = useFreshness(target);
  const data = useMemo(() => (target ? collectEntityFacts(target, metrics) : null), [target, metrics]);

  if (!target || !data) return null;

  const askAi = () => {
    useAi.getState().seedAsk(buildEntityPrompt(data, target.connName ?? target.connId), String(data.id).toLowerCase());
    useEntity.getState().close();
  };

  const openData = () => {
    const t = target;
    const node: TreeNode = {
      key: `c:${t.connId}/d:${t.database ?? ""}/t:${t.table}`,
      kind: t.objectKind ?? "table",
      label: t.table,
      connId: t.connId,
      database: t.database,
      schema: t.schema ?? "",
      table: t.table,
      childKeys: [],
      hasChildren: false,
      loaded: false,
      loading: false,
      expanded: false,
    };
    void useApp.getState().openTableTab(node);
    useEntity.getState().close();
  };


  return (
    <div className="e360-overlay" onMouseDown={() => useEntity.getState().close()}>
      <div className="e360-drawer" onMouseDown={(e) => e.stopPropagation()}>
        <header className="e360-head">
          <Table2 size={16} />
          <div className="e360-title">
            <div className="e360-name">{data.id}</div>
            <div className="e360-sub">{target.connName ?? target.connId}</div>
          </div>
          <button className="ai-icon" title="关闭" onClick={() => useEntity.getState().close()}>
            <X size={16} />
          </button>
        </header>

        <div className="e360-actions">
          <button className="btn sm" onClick={openData}><TableProperties size={13} /> 打开表数据</button>
          <button className="btn sm primary" onClick={askAi}><Sparkles size={13} /> 问 AI</button>
        </div>

        <div className="e360-body">
          <section className="e360-sec">
            <div className="e360-sec-h"><Clock size={13} /> 数据新鲜度</div>
            {freshness.loading ? (
              <div className="e360-none">正在看这张表更新到哪儿了…</div>
            ) : freshness.error ? (
              <div className="e360-none">读不到(可能没连上库)</div>
            ) : freshness.unavailable ? (
              <div className="e360-none">这张表没有可用的时间列,判断不了</div>
            ) : (
              <div className={`e360-fresh tone-${freshness.tone ?? "fresh"}`}>
                <b>{freshness.value}</b>
                {freshness.ago && <span className="e360-fresh-ago">{freshness.ago}</span>}
                <span className="e360-fresh-col">按 {freshness.column} 算</span>
              </div>
            )}
          </section>

          <section className="e360-sec">
            <div className="e360-sec-h"><Gauge size={13} /> 建在它上的指标 <b>{data.metrics.length}</b></div>
            {data.metrics.length === 0 ? <div className="e360-none">指标目录里没有指标用到这张表</div> : (
              <div className="e360-chips">
                {data.metrics.map((m) => (
                  <span
                    key={m.id}
                    className="e360-chip metric"
                    title={[
                      m.fields.length ? `用到这张表的字段:${m.fields.join("、")}` : "解析不出它读了哪些字段",
                      m.caliber ? `口径:${m.caliber}` : "",
                      `指标 ID:${m.id}`,
                    ].filter(Boolean).join("\n")}
                  >
                    {m.name}
                    {m.fields.length > 0 && <small className="e360-chip-n">{m.fields.length} 字段</small>}
                  </span>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/** Convenience for callers (the sidebar tree) to open the panel. */
export function openEntity360(t: EntityTarget) {
  useEntity.getState().open(t);
}
