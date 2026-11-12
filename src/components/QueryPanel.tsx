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

const RoutineWorkspace = lazy(() => import("./RoutineWorkspace"));
const DashboardWorkspace = lazy(() => import("../features/dashboard/DashboardWorkspace"));
const AnalysisWorkspace = lazy(() => import("../features/agent/AnalysisWorkspace"));


export default function QueryPanel() {
  const tabs = useApp(s => s.tabs);
  const activeTabId = useApp(s => s.activeTabId);
  const [visited, setVisited] = useState<Set<string>>(() => new Set(activeTabId ? [activeTabId] : []));
  useEffect(() => {
    if (activeTabId) setVisited(previous => new Set([...previous, activeTabId]));
  }, [activeTabId]);
  useEffect(() => {
    // Hidden restored tabs stay mounted after a visit, but only the visible one may connect.
    if (!activeTabId) return;
    const tab = useApp.getState().tabs.find(item => item.id === activeTabId);
    if (!tab || (tab.kind !== "database" && tab.kind !== "table" && tab.kind !== "routine")) return;
    if (useApp.getState().meta[tab.connId]) return;
    let live = true;
    void useApp.getState().openRestoredConnection(tab.connId, () => live);
    return () => { live = false; };
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
    {tabs.length === 0 && <StartPage />}
    {tabs.filter(tab => tab.id === activeTabId || visited.has(tab.id)).map(tab =>
      <div className="workspace-pane" key={tab.id} style={{ display: tab.id === activeTabId ? "flex" : "none" }}>
        <PanelErrorBoundary name={tab.title}><WorkspaceContent tabId={tab.id} active={tab.id === activeTabId} /></PanelErrorBoundary>
      </div>)}
  </div>;
}


/* 恢复出来的标签页,连接还没建立。
 *
 * 已经保存了密码(或这个库本来就不要密码)时,切到这一页就连。没切到的页先不动。
 * 没有凭据或连不上,卡片留在这个标签的内容区里,并写上原因。点按钮仍是手动连接。 */
function DisconnectedState({ tab }: { tab: { connId: string; connName: string; title: string; database?: string } }) {
  const { t } = useI18n();
  const connecting = useApp((s) => !!s.connecting[tab.connId]);
  const notice = useApp((s) => s.restoreNotice[tab.connId]);
  const where = [tab.connName, tab.database].filter(Boolean).join(" · ");
  return (
    <div className="disconnected">
      <div className="disconnected-card">
        <span className="disconnected-icon"><PlugZap size={22} /></span>
        <h3>{tab.title}</h3>
        <p className="disconnected-where">{where}</p>
        <p className="disconnected-why" role={notice ? "alert" : undefined}>{notice ?? t("workspace.restoreConnecting")}</p>
        <button
          className="btn primary"
          disabled={connecting}
          onClick={() => void useApp.getState().connect(tab.connId).catch(() => { /* 失败由 connect 自己 toast,原因留在卡片上 */ })}
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
