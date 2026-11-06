import { useEffect, useState } from "react";
import { Boxes, Database, LayoutDashboard, LineChart, Loader2, Plus, Sparkles } from "lucide-react";
import { openAsset } from "../features/assets/AssetShell";
import { useAi } from "../features/ai/aiStore";
import { useI18n } from "../hooks/useI18n";
import { useApp } from "../store/appStore";
import { kindLabel, type ConnectionConfig } from "../types";

/** 没有打开任何标签时的首页:继续上次的连接,或者去开始一件新的事。 */
export default function StartPage() {
  const { t } = useI18n();
  const connections = useApp((s) => s.connections);
  const connecting = useApp((s) => s.connecting);
  // 点了哪个连接。真正连上(可能中间还要输口令)才开 SQL 标签,所以等 meta 出现,而不是等 connect 返回:
  // 要口令时 connect 会先返回,用户输完才算连上。
  const [opening, setOpening] = useState<ConnectionConfig>();
  const connected = useApp((s) => (opening ? !!s.meta[opening.id] : false));
  const queryTitle = t("query.title");
  useEffect(() => {
    if (!opening || !connected) return;
    setOpening(undefined);
    useApp.getState().openQueryTab({ connId: opening.id, database: opening.database, sql: "", title: queryTitle });
  }, [opening, connected, queryTitle]);
  const open = (cfg: ConnectionConfig) => {
    setOpening(cfg);
    const app = useApp.getState();
    if (!app.meta[cfg.id]) app.connect(cfg.id).catch(() => setOpening(undefined)); // 报错 connect 自己提示了
  };
  const actions = [
    { icon: Sparkles, title: "AI", hint: t("start.aiHint"), run: () => useAi.getState().togglePanel() },
    { icon: LineChart, title: t("start.analysis"), hint: t("start.analysisHint"), run: () => useApp.getState().openAnalysisTab() },
    { icon: LayoutDashboard, title: t("toolbar.dashboard"), hint: t("start.dashboardHint"), run: () => useApp.getState().openDashboardTab() },
    { icon: Boxes, title: t("start.assets"), hint: t("start.assetsHint"), run: () => openAsset("datasets") },
  ];
  return (
    <div className="start-page">
      <div className="start-column">
        <header className="start-head">
          <img src="/db-sonde.png" alt="" />
          <div>
            <h1>DB Sonde</h1>
            <p>{t("start.tagline")}</p>
          </div>
        </header>

        <section>
          <div className="start-section-head">
            <h2>{t("start.connections")}</h2>
            {connections.length > 0 && (
              <button className="btn ghost sm" onClick={() => useApp.getState().openDialog()}>
                <Plus size={14} /> {t("start.newConnection")}
              </button>
            )}
          </div>
          {connections.length === 0 ? (
            <div className="start-empty">
              <p>{t("start.noConnections")}</p>
              <button className="btn primary" onClick={() => useApp.getState().openDialog()}>
                <Plus size={15} /> {t("start.newConnection")}
              </button>
              <button className="btn ghost" onClick={() => useApp.getState().createDemo()}>
                <Sparkles size={15} /> {t("sidebar.tryDemo")}
              </button>
            </div>
          ) : (
            <div className="start-list">
              {connections.map((cfg) => (
                <button key={cfg.id} className="start-conn" onClick={() => open(cfg)}>
                  {connecting[cfg.id]
                    ? <Loader2 size={15} className="spin" />
                    : <Database size={15} style={cfg.color ? { color: cfg.color } : undefined} />}
                  <span className="start-conn-name">{cfg.name}</span>
                  <span className="start-conn-kind">{kindLabel(cfg.kind)}</span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2>{t("start.begin")}</h2>
          <div className="start-actions">
            {actions.map(({ icon: Icon, title, hint, run }) => (
              <button key={title} className="start-action" onClick={run}>
                <Icon size={16} />
                <span className="start-action-title">{title}</span>
                <span className="start-action-hint">{hint}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
