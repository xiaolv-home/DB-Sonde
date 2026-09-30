import {
  Loader2,
  PlugZap,
  TableProperties
} from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useI18n } from "../hooks/useI18n";
import { useApp } from "../store/appStore";
import DatabaseBrowser from "./DatabaseBrowser";
import PanelErrorBoundary from "./PanelErrorBoundary";
import PythonPanel from "./PythonPanel";
import SqlWorkspace from "./SqlWorkspace";
import TableInspector from "./TableInspector";
import WorkspaceTabBar from "./WorkspaceTabBar";

const RoutineWorkspace = lazy(() => import("./RoutineWorkspace"));
const DashboardWorkspace = lazy(() => import("../features/dashboard/DashboardWorkspace"));
const AnalysisWorkspace = lazy(() => import("../features/agent/AnalysisWorkspace"));


export default function QueryPanel() {
  const tabs = useApp(s => s.tabs);
  const activeTabId = useApp(s => s.activeTabId);
  const [visited, setVisited] = useState<Set<string>>(() => new Set(activeTabId ? [activeTabId] : []));
  useEffect(() => {
    if (activeTabId) setVisited(previous => new Set([...previous, activeTabId]));
    // Restoring or switching tabs is not consent to connect to a database.
  }, [activeTabId]);
  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      const current = useApp.getState();
      const tab = current.tabs.find(t => t.id === current.activeTabId);
      if (tab?.kind !== "query") return;
      event.preventDefault(); current.saveTab(tab.id);
    };
    window.addEventListener("keydown", save);
    return () => window.removeEventListener("keydown", save);
  }, []);
  return <div className="main"><WorkspaceTabBar />
    {tabs.length === 0 && <div className="empty-main">打开一个数据库、表或 SQL 脚本开始工作</div>}
    {tabs.filter(tab => tab.id === activeTabId || visited.has(tab.id)).map(tab =>
      <div className="workspace-pane" key={tab.id} style={{ display: tab.id === activeTabId ? "flex" : "none" }}>
        <PanelErrorBoundary name={tab.title}><WorkspaceContent tabId={tab.id} active={tab.id === activeTabId} /></PanelErrorBoundary>
      </div>)}
  </div>;
}


/* 恢复出来的标签页,连接还没建立。
 *
 * 以前是 `.result-placeholder` 里塞一行字加一个按钮 —— 那个类是 grid + place-items:center,
 * 两个子元素被分成上下两行、各占一半高度,于是字飘在上半截、按钮掉在下半截,中间一大片空白。
 * 而且没说为什么是这个状态:恢复标签页**故意不自动连库**(恢复不等于同意连接),
 * 不说明的话看着像坏了。 */
function DisconnectedState({ tab }: { tab: { connId: string; connName: string; title: string; database?: string } }) {
  const { t } = useI18n();
  const connecting = useApp((s) => !!s.connecting[tab.connId]);
  const where = [tab.connName, tab.database].filter(Boolean).join(" · ");
  return (
    <div className="disconnected">
      <div className="disconnected-card">
        <span className="disconnected-icon"><PlugZap size={22} /></span>
        <h3>{tab.title}</h3>
        <p className="disconnected-where">{where}</p>
        <p className="disconnected-why">{t("workspace.disconnectedWhy")}</p>
        <button
          className="btn primary"
          disabled={connecting}
          onClick={() => void useApp.getState().connect(tab.connId).catch(() => { /* 失败由 connect 自己 toast */ })}
        >
          {connecting ? <><Loader2 size={14} className="spin" /> {t("workspace.connecting")}</> : t("workspace.connectAndOpen")}
        </button>
      </div>
    </div>
  );
}

function WorkspaceContent({ tabId, active }: { tabId: string; active: boolean; }) {
  const { t } = useI18n();
  const tab = useApp(s => s.tabs.find(t => t.id === tabId));
  const connected = useApp(s => tab ? !!s.meta[tab.connId] : false);
  if (!tab) {
    return (
      <div className="main">
        <div className="empty-main">
          <div>
            <TableProperties size={34} style={{ color: "var(--text-3)" }} />
            <p style={{ marginTop: 12 }}>
              {t("query.empty")}
              <br />
              {t("query.runShortcut")} <span className="kbd">⌘ ⏎</span>
            </p>
          </div>
        </div>
      </div>
    );
  }

  if ((tab.kind === "database" || tab.kind === "table" || tab.kind === "routine") && !connected) {
    return <div className="main"><DisconnectedState tab={tab} /></div>;
  }
  if (tab.kind === "routine") return <Suspense fallback={<div className="object-state">正在加载…</div>}><RoutineWorkspace tab={tab} /></Suspense>;
  if (tab.kind === "database") {
    return <div className="main"><DatabaseBrowser tab={tab} active={active} /></div>;
  }

  if (tab.kind === "table") {
    return <div className="main"><TableInspector tab={tab} /></div>;
  }

  if (tab.kind === "python") {
    return <div className="main"><PythonPanel tab={tab} /></div>;
  }

  if (tab.kind === "analysis") {
    return (
      <div className="main">
        <Suspense fallback={<div className="object-state"><Loader2 size={18} className="spin" />载入中…</div>}>
          <AnalysisWorkspace tab={tab} />
        </Suspense>
      </div>
    );
  }

  if (tab.kind === "dashboard") {
    return (
      <div className="main">
        <Suspense fallback={<div className="object-state"><Loader2 size={18} className="spin" />{t("dashboard.loading")}</div>}>
          <DashboardWorkspace tab={tab} active={active} />
        </Suspense>
      </div>
    );
  }

  return <SqlWorkspace tab={tab} />;
}
