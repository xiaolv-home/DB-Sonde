import StartPage from "./StartPage";
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
import WorkspaceOpening from "./WorkspaceOpening";

const RoutineWorkspace = lazy(() => import("./RoutineWorkspace"));
const DashboardWorkspace = lazy(() => import("../features/dashboard/DashboardWorkspace"));
const AnalysisWorkspace = lazy(() => import("../features/agent/AnalysisWorkspace"));


export default function QueryPanel() {
  const tabs = useApp(s => s.tabs);
  const activeTabId = useApp(s => s.activeTabId);
  const connectionsReady = useApp(s => s.connectionsReady);
  const [visited, setVisited] = useState<Set<string>>(() => new Set(activeTabId ? [activeTabId] : []));
  useEffect(() => {
    if (activeTabId) setVisited(previous => new Set([...previous, activeTabId]));

  }, [activeTabId]);
  useEffect(() => {
    if (!connectionsReady || !activeTabId) return;
    const state = useApp.getState();
    const tab = state.tabs.find(item => item.id === activeTabId);
    if (!tab?.connId || !["query", "table", "database", "routine"].includes(tab.kind) || state.meta[tab.connId]) return;
    // The backend reuses encrypted credentials, or returns CREDENTIAL_REQUIRED before connecting.
    // Only the active tab restores; SQL editors never execute their saved statements.
    void state.connect(tab.connId, null, "restore");
  }, [activeTabId, connectionsReady]);
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
    {tabs.length === 0 && <StartPage />}
    {tabs.filter(tab => tab.id === activeTabId || visited.has(tab.id)).map(tab =>
      <div className="workspace-pane" key={tab.id} style={{ display: tab.id === activeTabId ? "flex" : "none" }}>
        <PanelErrorBoundary name={tab.title}><WorkspaceContent tabId={tab.id} active={tab.id === activeTabId} /></PanelErrorBoundary>
      </div>)}
  </div>;
}


/* Missing credentials only affect this pane; the global navigation stays usable. */
function DisconnectedState({ tab }: { tab: { connId: string; connName: string; title: string; database?: string } }) {
  const { t } = useI18n();
  const connecting = useApp((s) => !!s.connecting[tab.connId]);
  const notice = useApp(s => s.restoreNotice[tab.connId] ?? s.connectionsError);
  const ready = useApp(s => s.connectionsReady);
  const where = [tab.connName, tab.database].filter(Boolean).join(" · ");
  return (
    <div className="disconnected">
      <div className="disconnected-card">
        <span className="disconnected-icon"><PlugZap size={22} /></span>
        <h3>{tab.title}</h3>
        <p className="disconnected-where">{where}</p>
        <p className="disconnected-why">{notice ?? t("workspace.connecting")}</p>
        <button
          className="btn primary"
          disabled={connecting}
          onClick={() => void (ready ? useApp.getState().connect(tab.connId) : useApp.getState().init()).catch(() => { /* 失败由 connect 自己 toast */ })}
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
  const notice = useApp(s => tab ? s.restoreNotice[tab.connId] ?? s.connectionsError : undefined);
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

  if (tab.kind === "database" || tab.kind === "table" || tab.kind === "routine") {
    return <WorkspaceOpening connected={connected} notice={notice} label={[tab.connName, tab.database].filter(Boolean).join(" · ")}>
      {!connected ? <DisconnectedState tab={tab} />
        : tab.kind === "table" ? <TableInspector tab={tab} />
        : tab.kind === "database" ? <DatabaseBrowser tab={tab} active={active} />
        : <Suspense fallback={null}><RoutineWorkspace tab={tab} /></Suspense>}
    </WorkspaceOpening>;
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
