import { Boxes, CircleCheck, CircleX, Database, Info, LayoutDashboard, LineChart, Moon, Plus, Sparkles, Sun, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import ConnectionDialog from "./components/ConnectionDialog";
import PanelErrorBoundary from "./components/PanelErrorBoundary";
import PasswordDialog from "./components/PasswordDialog";
import QueryPanel from "./components/QueryPanel";
import Sidebar from "./components/Sidebar";
import SyntaxThemePicker from "./components/SyntaxThemePicker";
import StorageNotice from "./components/StorageNotice";
import WorkspaceLifecycle from "./components/WorkspaceLifecycle";
import { useAi } from "./features/ai/aiStore";
import { openAsset } from "./features/assets/AssetShell";
import { AiFeature, AssetFeatures, EntityFeature } from "./features/FeatureHosts";
import { useDrag } from "./hooks/useDrag";
import { useI18n } from "./hooks/useI18n";
import { useApp } from "./store/appStore";
import { kindLabel } from "./types";

function Toolbar() {
  const theme = useApp((s) => s.theme);
  const { language, t } = useI18n();
  return (
    <div className="toolbar">
      <div className="brand">
        <img className="logo" src="/db-sonde.png" alt="" />
        DB Sonde <small>beta</small>
      </div>
      <div className="toolbar-spacer" />
      <button className="btn" onClick={() => useAi.getState().togglePanel()}>
        <Sparkles size={15} /> AI
      </button>
      {/* 「分析」是独立工作区,不是聊天框里的一个模式:
          数据范围由人在表单里锁死,AI 只管分析和做图 —— 抽参判错了看不出来,
          分析判错了一眼就看见,该谁干的活归谁。 */}
      <button className="btn" onClick={() => useApp.getState().openAnalysisTab()} title="锁定数据范围,让 AI 做分析和看板">
        <LineChart size={15} /> 分析
      </button>
      <button className="btn" onClick={() => useApp.getState().openDashboardTab()}>
        <LayoutDashboard size={15} /> {t("toolbar.dashboard")}
      </button>
      {/* 调度 / 指标 / ETL / 血缘 原本是顶栏四个按钮、四个互不相通的浮层。
          它们是同一件事的四个侧面,收敛成一个「数据资产」,进去左侧随时互跳。 */}
      <button className="btn" onClick={() => openAsset("etl")} title="数据来源 / 运行情况 / 上下游 / 指标口径">
        <Boxes size={15} /> 数据资产
      </button>
      <button className="btn" onClick={() => useApp.getState().openDialog()}>
        <Plus size={15} /> {t("toolbar.newConnection")}
      </button>
      <button
        className="btn language-btn"
        title={t("language.switch")}
        onClick={() => useApp.getState().setLanguage(language === "zh-CN" ? "en" : "zh-CN")}
      >
        {language === "zh-CN" ? "EN" : "中文"}
      </button>
      <SyntaxThemePicker />
      <button
        className="icon-btn"
        title={t("toolbar.toggleTheme")}
        onClick={() => useApp.getState().setTheme(theme === "dark" ? "light" : "dark")}
      >
        {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
      </button>
    </div>
  );
}

function StatusBar() {
  const { t } = useI18n();
  const activeTab = useApp((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const meta = useApp((s) => (activeTab ? s.meta[activeTab.connId] : undefined));
  const connectedCount = useApp((s) => Object.keys(s.meta).length);

  return (
    <div className="statusbar">
      <span className="sb-item">
        <Database size={13} />
        {connectedCount > 0
          ? t("status.connected", { count: connectedCount })
          : t("status.noConnection")}
      </span>
      {meta && (
        <>
          <span className="sb-item">{kindLabel(meta.kind)}</span>
          {meta.currentDatabase && <span className="sb-item">{meta.currentDatabase}</span>}
          {meta.serverVersion && (
            <span className="sb-item" style={{ color: "var(--text-3)" }}>
              {meta.serverVersion}
            </span>
          )}
        </>
      )}
      <span className="sb-spacer" />
      {activeTab?.kind === "query" && activeTab.result && activeTab.result.columns.length > 0 && (
        <span className="sb-item">
          {t("status.rowsElapsed", {
            rows: activeTab.result.rows.length.toLocaleString(),
            ms: activeTab.result.elapsedMs,
          })}
        </span>
      )}
    </div>
  );
}

function Toast() {
  const toast = useApp((s) => s.toast);
  if (!toast) return null;
  const Icon = toast.kind === "error" ? CircleX : toast.kind === "success" ? CircleCheck : toast.kind === "warn" ? TriangleAlert : Info;
  return (
    <div className={`toast ${toast.kind}`}>
      <Icon size={15} />
      <span>{toast.text}</span>
    </div>
  );
}

export default function App() {
  const sidebarWidth = useApp((s) => s.sidebarWidth);
  const dialogOpen = useApp((s) => s.dialogOpen);
  const passwordPromptId = useApp((s) => s.passwordPromptId);

  useEffect(() => {
    void useApp.getState().init();
    void import("./features/metrics/importCatalog")
      .then(module => module.loadConfiguredCatalog())
      .catch(error => useApp.getState().showToast({ kind: "error", text: `指标目录导入失败：${String(error)}` }));
  }, []);

  const resizer = useDrag((d) => {
    const cur = useApp.getState().sidebarWidth;
    useApp.getState().setSidebarWidth(cur + d);
  }, "x");

  return (
    <div className="app">
      <Toolbar />
      <div className="body">
        <div style={{ width: sidebarWidth, flex: `0 0 ${sidebarWidth}px`, display: "flex", minHeight: 0 }}>
          <PanelErrorBoundary name="数据库导航"><Sidebar /></PanelErrorBoundary>
        </div>
        <div className={`resizer-x ${resizer.active ? "active" : ""}`} onPointerDown={resizer.onPointerDown} />
        <QueryPanel />
        <AiFeature />
      </div>
      <StorageNotice />
      <StatusBar />
      {dialogOpen && <ConnectionDialog />}
      {passwordPromptId && (
        <PasswordDialog key={passwordPromptId} connectionId={passwordPromptId} />
      )}
      <AssetFeatures />
      <EntityFeature />
      <WorkspaceLifecycle />
      <Toast />
    </div>
  );
}
