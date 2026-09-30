import {
  Code2,
  Database,
  FileCode2,
  LayoutDashboard,
  ListTree,
  Loader2,
  Pencil,
  Plus,
  Save,
  Sparkles,
  Table2,
  X
} from "lucide-react";
import { useState } from "react";
import { useGlassPill } from "../hooks/useGlassPill";
import { useI18n } from "../hooks/useI18n";
import { useViewportFit } from "../hooks/useViewportFit";
import { isUnsavedTab } from "../lib/workspaceSession";
import { useApp } from "../store/appStore";

export default function WorkspaceTabBar() {
  const { t } = useI18n();
  const tabs = useApp((s) => s.tabs);
  const savedQueries = useApp(s => s.savedQueries);
  const dirtyTabs = useApp(s => s.dirtyTabs);
  const activeTabId = useApp((s) => s.activeTabId);
  const [menu, setMenu] = useState<{ tabId: string; x: number; y: number; } | null>(null);
  const menuFit = useViewportFit(menu);
  const [renaming, setRenaming] = useState<{ tabId: string; value: string; } | null>(null);
  /* 标签背后那块玻璃:鼠标在这排上时跟着指的那项走,移开就回到当前标签。 */
  const { trackProps, pillProps } = useGlassPill(activeTabId);

  const startRename = (tabId: string, current: string) => {
    setMenu(null);
    setRenaming({ tabId, value: current });
  };
  const commitRename = () => {
    if (renaming) useApp.getState().renameTab(renaming.tabId, renaming.value);
    setRenaming(null);
  };

  return (
    <div className="tabbar">
      {/* 轨道:.tabbar 负责滚动,轨道负责定位 —— 胶囊是轨道的绝对定位子元素,
          所以横向滚动时它跟着内容一起走,不用额外监听滚动。 */}
      <div className="tabbar-track pill-track" {...trackProps}>
        <span {...pillProps} />
        {tabs.map((tab) => (
        <div
          key={tab.id}
          data-pill={tab.id}
          className={`qtab ${tab.id === activeTabId ? "active" : ""}`}
          draggable={renaming?.tabId !== tab.id}
          onDragStart={(e) => {
            e.dataTransfer.setData("text/tab", tab.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("text/tab")) e.preventDefault();
          }}
          onDrop={(e) => {
            e.preventDefault();
            const from = e.dataTransfer.getData("text/tab");
            if (from) useApp.getState().reorderTabs(from, tab.id);
          }}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              useApp.getState().closeTab(tab.id);
            } else {
              useApp.getState().setActiveTab(tab.id);
            }
          }}
          onContextMenu={(e) => {
            if (tab.kind !== "query") return;
            e.preventDefault();
            useApp.getState().setActiveTab(tab.id);
            setMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
          }}
        >
          {(tab.kind === "query" || tab.kind === "routine") && tab.running ? <Loader2 size={13} className="spin" /> : tab.kind === "routine" ? (<Code2 size={13} />) : tab.kind === "database" ? (
            <Database size={13} style={{ color: "var(--text-3)", flex: "0 0 auto" }} />
          ) : tab.kind === "table" ? (
            <ListTree size={13} style={{ color: "var(--text-3)", flex: "0 0 auto" }} />
          ) : tab.kind === "analysis" ? (
            <Sparkles size={13} style={{ color: "var(--accent)", flex: "0 0 auto" }} />
          ) : tab.kind === "dashboard" ? (
            <LayoutDashboard size={13} style={{ color: "var(--accent)", flex: "0 0 auto" }} />
          ) : tab.kind === "python" ? (
            <Code2 size={13} style={{ color: "var(--amber)", flex: "0 0 auto" }} />
          ) : tab.kind === "query" && tab.savedId ? (
            <FileCode2 size={13} style={{ color: "var(--accent)", flex: "0 0 auto" }} />
          ) : (
            <Table2 size={13} style={{ color: "var(--text-3)", flex: "0 0 auto" }} />
          )}
          <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
            {renaming?.tabId === tab.id ? (
              <input
                className="qt-rename"
                autoFocus
                value={renaming.value}
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => setRenaming({ tabId: tab.id, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  else if (e.key === "Escape") setRenaming(null);
                }}
                onBlur={commitRename}
              />
            ) : (
              <span
                className="qt-title"
                onDoubleClick={(e) => {
                  if (tab.kind !== "query") return;
                  e.stopPropagation();
                  startRename(tab.id, tab.title);
                }}
              >
                {tab.title}{isUnsavedTab(tab, { savedQueries, dirtyTabs }) && <span className="tab-unsaved" title="未保存"> ●</span>}
              </span>
            )}
          </div>
          <span
            className="qt-close"
            onClick={(e) => {
              e.stopPropagation();
              useApp.getState().closeTab(tab.id);
            }}
          >
            <X size={13} />
          </span>
        </div>
      ))}
      {tabs.length > 0 && (
        <div
          className="new-tab"
          title={t("action.newQuery")}
          onClick={() => {
            const s = useApp.getState();
            const connId = s.tabs.find((t) => t.id === s.activeTabId)?.connId;
            const first = connId ?? Object.keys(s.meta)[0] ?? s.connections[0]?.id;
            if (first) {
              const current = s.tabs.find((t) => t.id === s.activeTabId);
              s.openQueryTab({ connId: first, database: current?.database, title: t("query.title") });
            }
            else s.showToast({ kind: "info", text: t("query.addConnectionFirst") });
          }}
        >
          <Plus size={16} />
        </div>
      )}
      </div>

      {menu &&
        (() => {
          const tab = tabs.find((x) => x.id === menu.tabId);
          if (!tab || tab.kind !== "query") return null;
          return (
            <>
              <div
                className="ctx-backdrop"
                onMouseDown={() => setMenu(null)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu(null);
                }}
              />
              <div className="ctx-menu" ref={menuFit.ref} style={menuFit.style}>
                <div className="ctx-item" onClick={() => startRename(tab.id, tab.title)}>
                  <Pencil size={14} /> 重命名
                </div>
                <div
                  className="ctx-item"
                  onClick={() => {
                    useApp.getState().saveTab(tab.id);
                    setMenu(null);
                  }}
                >
                  <Save size={14} /> 保存{tab.savedId ? "" : "为脚本"}
                </div>
                <div className="ctx-sep" />
                <div
                  className="ctx-item"
                  onClick={() => {
                    useApp.getState().closeTab(tab.id);
                    setMenu(null);
                  }}
                >
                  <X size={14} /> 关闭
                </div>
              </div>
            </>
          );
        })()}
    </div>
  );
}

