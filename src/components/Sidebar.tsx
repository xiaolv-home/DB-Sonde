import { useEffect, useState } from "react";
import {
  Plus,
  Sparkles,
  Database as DbIcon,
  Plug,
  Unplug,
  SquarePen,
  Trash2,
  SquareTerminal,
  RefreshCw,
  Copy,
  TableProperties,
  FileCode2,
  Globe,
  Eye,
  EyeOff,
  Code2,
  Files,
  LayoutDashboard,
  X,
  Radar,
  FolderOpen,
} from "lucide-react";
import { useApp, type TreeNode, type WorkspaceTab } from "../store/appStore";
import { api, type PyFile } from "../lib/api";
import { useAi } from "../features/ai/aiStore";
import { openEntity360 } from "../features/entity/Entity360";
import DeleteObjectDialog from "./DeleteObjectDialog";
import TreeRow from "./TreeRow";
import { useI18n } from "../hooks/useI18n";
import { useViewportFit } from "../hooks/useViewportFit";
import { parseDashboardHtml } from "../features/dashboard/export/htmlImport";
import { dashboardRepository } from "../features/dashboard/repository";

interface MenuState {
  x: number;
  y: number;
  node: TreeNode;
}

interface MenuItem {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  sep?: boolean;
}

type Section = "conn" | "editor" | "files";
const SECTION_KEY = "sonde.sidebarSection.v1";

const tabIcon = (tab: WorkspaceTab) => {
  switch (tab.kind) {
    case "routine": return <Code2 size={14} />;
    case "query":
      return <SquareTerminal size={14} />;
    case "database":
      return <DbIcon size={14} />;
    case "table":
      return <TableProperties size={14} />;
    case "dashboard":
      return <LayoutDashboard size={14} />;
  }
};

/** The list of currently-open editors (query / table / dashboard tabs). */
function EditorList() {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);
  if (tabs.length === 0) {
    return <div className="side-empty">还没有打开的编辑器。双击表或新建查询即可。</div>;
  }
  return (
    <div className="editor-list">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`el-row ${activeTabId === tab.id ? "on" : ""}`}
          title={`${tab.title}${tab.connName ? ` · ${tab.connName}` : ""}`}
          onClick={() => useApp.getState().setActiveTab(tab.id)}
        >
          <span className="el-icon">{tabIcon(tab)}</span>
          <span className="el-name">{tab.title}</span>
          {tab.connName && <span className="el-conn">{tab.connName}</span>}
          <button
            className="el-close"
            title="关闭"
            onClick={(e) => {
              e.stopPropagation();
              useApp.getState().closeTab(tab.id);
            }}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Files: saved SQL scripts + Python scripts (backed by the workspace dir). */
function FilesPanel() {
  const savedQueries = useApp((s) => s.savedQueries);
  const [pyFiles, setPyFiles] = useState<PyFile[]>([]);
  const [pyDir, setPyDir] = useState("");
  const [boardFiles, setBoardFiles] = useState<PyFile[]>([]);
  const refreshPy = () => api.pyListFiles().then(setPyFiles).catch(() => setPyFiles([]));
  const refreshBoards = () => api.workspaceListFiles("html").then(setBoardFiles).catch(() => setBoardFiles([]));
  useEffect(() => {
    void refreshPy();
    void refreshBoards();
    api.pyWorkspaceDir().then(setPyDir).catch(() => {});
  }, []);
  /** 点导出的看板网页 → 从里面还原成新草稿并打开编辑(数据会重新查库)。 */
  const openBoard = async (file: PyFile) => {
    try {
      const html = await api.pyReadFile(file.path);
      const doc = parseDashboardHtml(html, file.name.replace(/\.html?$/i, ""));
      if (!doc) throw new Error("这个 HTML 里没找到可还原的看板数据");
      const saved = await dashboardRepository.save(doc);
      useApp.getState().openDashboardTab(saved.id);
      useApp.getState().showToast({ kind: "success", text: `已从「${file.name}」还原看板,可继续编辑` });
    } catch (e) {
      useApp.getState().showToast({ kind: "error", text: `打开失败:${String(e)}` });
    }
  };
  const deleteBoard = async (path: string) => {
    /* 删不掉要说话。原来是 .catch(() => {}) —— 紧接着 refresh 把文件又读回来,
       用户看到的是"点了删除,它闪一下又回来了",没有任何解释。
       这个文件里新建、打开都会弹错误提示,唯独删除不吭声。 */
    try {
      await api.pyDeleteFile(path);
    } catch (e) {
      useApp.getState().showToast({ kind: "error", text: `删除失败:${String(e)}` });
    }
    void refreshBoards();
  };
  const newPy = async () => {
    try {
      const f = await api.pyNewFile();
      await refreshPy();
      useApp.getState().openPythonTab({ name: f.name, path: f.path });
    } catch (e) {
      useApp.getState().showToast({ kind: "error", text: String(e) });
    }
  };
  const deletePy = async (path: string) => {
    try {
      await api.pyDeleteFile(path);
    } catch (e) {
      useApp.getState().showToast({ kind: "error", text: `删除失败:${String(e)}` });
    }
    void refreshPy();
  };
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null);
  const commitRename = async () => {
    if (!renaming) return;
    const { path, value } = renaming;
    setRenaming(null);
    const old = pyFiles.find((f) => f.path === path);
    const next = value.trim().replace(/\.py$/i, "");
    if (!old || !next || next === old.name.replace(/\.py$/i, "")) return;
    try {
      const f = await api.pyRenameFile(path, next);
      await refreshPy();
      // 已打开的标签要跟着改名,否则保存会写回旧路径
      useApp.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.kind === "python" && t.path === path
            ? { ...t, path: f.path, title: f.name.replace(/\.py$/i, "") }
            : t,
        ),
      }));
    } catch (e) {
      useApp.getState().showToast({ kind: "error", text: `改名失败:${String(e)}` });
    }
  };
  return (
    <div className="files-panel">
      <div className="files-group">
        <div className="files-group-head">SQL 脚本</div>
        {savedQueries.length === 0 ? (
          <div className="side-empty sm">还没有已存脚本。查询标签右键「保存为脚本」即可。</div>
        ) : (
          <div className="sq-list">
            {savedQueries.map((q) => (
              <div
                key={q.id}
                className="sq-row"
                title={q.name}
                onClick={() => useApp.getState().openSavedQuery(q.id)}
              >
                <FileCode2 size={13} className="sq-icon" />
                <span className="sq-name">{q.name}</span>
                <button
                  className="sq-del"
                  title="删除脚本"
                  onClick={(e) => {
                    e.stopPropagation();
                    useApp.getState().deleteSavedQuery(q.id);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="files-group">
        <div className="files-group-head">看板网页</div>
        {boardFiles.length === 0 ? (
          <div className="side-empty sm">还没有。看板里点「导出网页」,文件会存到这儿,点一下就能导回来继续编辑。</div>
        ) : (
          <div className="sq-list">
            {boardFiles.map((f) => (
              <div key={f.path} className="sq-row" title={`${f.path}\n点击:还原成新草稿并打开编辑`} onClick={() => void openBoard(f)}>
                <Globe size={13} className="sq-icon" style={{ color: "var(--c-table)" }} />
                <span className="sq-name">{f.name.replace(/\.html?$/i, "")}</span>
                <button
                  className="sq-del"
                  title="删除这个导出文件"
                  onClick={(e) => { e.stopPropagation(); void deleteBoard(f.path); }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="files-group">
        <div className="files-group-head">
          <span>Python 脚本</span>
          <button
            className="fg-add"
            title={pyDir ? `脚本目录:${pyDir}\n点击在访达里打开` : "脚本目录"}
            onClick={() => {
              if (!pyDir) return;
              void import("@tauri-apps/plugin-opener")
                .then((m) => m.revealItemInDir(pyDir))
                .catch(() => {});
            }}
          >
            <FolderOpen size={13} />
          </button>
          <button className="fg-add" title="新建 Python 脚本" onClick={newPy}>
            <Plus size={13} />
          </button>
        </div>
        {pyFiles.length === 0 ? (
          <div className="side-empty sm">
            还没有脚本。点右上角 <Plus size={11} style={{ verticalAlign: "-1px" }} /> 新建 .py —— 内置
            Python + pandas,直接跑。建好后双击文件名可以改名。
          </div>
        ) : (
          <div className="sq-list">
            {pyFiles.map((f) => (
              <div
                key={f.path}
                className="sq-row"
                title={f.path}
                onDoubleClick={() => setRenaming({ path: f.path, value: f.name.replace(/\.py$/i, "") })}
                onClick={() => {
                  if (renaming?.path === f.path) return;
                  useApp.getState().openPythonTab({ name: f.name, path: f.path });
                }}
              >
                <Code2 size={13} className="sq-icon" style={{ color: "var(--amber)" }} />
                {renaming?.path === f.path ? (
                  <input
                    className="qt-rename sq-rename"
                    autoFocus
                    value={renaming.value}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenaming({ path: f.path, value: e.target.value })}
                    onBlur={() => void commitRename()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename();
                      else if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <span className="sq-name">{f.name}</span>
                )}
                <button
                  className="sq-act"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenaming({ path: f.path, value: f.name.replace(/\.py$/i, "") });
                  }}
                >
                  <SquarePen size={12} />
                </button>
                <button
                  className="sq-del"
                  title="删除脚本"
                  onClick={(e) => {
                    e.stopPropagation();
                    void deletePy(f.path);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Sidebar() {
  const { t } = useI18n();
  const rootKeys = useApp((s) => s.rootKeys);
  const connections = useApp((s) => s.connections);
  const savedQueries = useApp((s) => s.savedQueries);
  const tabs = useApp((s) => s.tabs);
  const hiddenCount = useApp((s) => s.hiddenKeys.length);
  const showHidden = useApp((s) => s.showHidden);
  const [deleteNode, setDeleteNode] = useState<TreeNode | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuFit = useViewportFit(menu);
  const [section, setSection] = useState<Section>(
    () => (localStorage.getItem(SECTION_KEY) as Section) || "conn",
  );
  const changeSection = (s: Section) => {
    setSection(s);
    try {
      localStorage.setItem(SECTION_KEY, s);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, []);

  const openContext = (node: TreeNode, e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  const buildItems = (node: TreeNode): MenuItem[] => {
    const s = useApp.getState();
    const connected = !!s.meta[node.connId];
    const cfg = s.connections.find((c) => c.id === node.connId);
    const hidden = s.hiddenKeys.includes(node.key);
    const hideItem: MenuItem = {
      sep: true,
      label: hidden ? "取消隐藏" : "隐藏",
      icon: hidden ? <Eye size={15} /> : <EyeOff size={15} />,
      onClick: () => {
        s.setNodeHidden(node.key, !hidden);
        setMenu(null);
      },
    };

    const deleteItem: MenuItem = { sep: true, danger: true, label: node.kind === "database" ? "删除库…" : "删除表…", icon: <Trash2 size={15}/>, onClick: () => { setMenu(null); setDeleteNode(node); } };
    const canDropDatabase = node.kind === "database" && ["mysql", "mariadb", "postgres", "clickhouse"].includes(cfg?.kind ?? "");

    const newQuery = (sql = "") => {
      s.openQueryTab({
        connId: node.connId,
        database: node.database,
        sql,
        title: t("query.title"),
      });
      setMenu(null);
    };
    const copy = (text: string) => {
      navigator.clipboard?.writeText(text);
      setMenu(null);
    };

    switch (node.kind) {
      case "connection":
        return connected
          ? [
              { label: t("action.newQuery"), icon: <SquareTerminal size={15} />, onClick: () => newQuery() },
              {
                label: t("action.disconnect"),
                icon: <Unplug size={15} />,
                onClick: () => {
                  s.disconnect(node.connId);
                  setMenu(null);
                },
                sep: true,
              },
              {
                label: t("action.edit"),
                icon: <SquarePen size={15} />,
                onClick: () => {
                  s.openDialog(cfg);
                  setMenu(null);
                },
              },
              {
                label: t("action.delete"),
                icon: <Trash2 size={15} />,
                danger: true,
                onClick: () => {
                  s.deleteConnection(node.connId);
                  setMenu(null);
                },
              },
            ]
          : [
              {
                label: t("action.connect"),
                icon: <Plug size={15} />,
                onClick: () => {
                  s.connect(node.connId).catch(() => {});
                  setMenu(null);
                },
              },
              {
                label: t("action.edit"),
                icon: <SquarePen size={15} />,
                onClick: () => {
                  s.openDialog(cfg);
                  setMenu(null);
                },
              },
              {
                label: t("action.delete"),
                icon: <Trash2 size={15} />,
                danger: true,
                onClick: () => {
                  s.deleteConnection(node.connId);
                  setMenu(null);
                },
              },
            ];
      case "database":
      case "schema":
        return [
          {
            label: t("action.openBrowser"),
            icon: <TableProperties size={15} />,
            onClick: () => {
              void s.openDatabaseTab(node);
              setMenu(null);
            },
          },
          { label: t("action.newQuery"), icon: <SquareTerminal size={15} />, onClick: () => newQuery() },
          {
            label: t("action.refresh"),
            icon: <RefreshCw size={15} />,
            onClick: () => {
              s.refreshNode(node.key);
              setMenu(null);
            },
          },
          hideItem,
          ...(canDropDatabase ? [deleteItem] : []),
        ];
      case "folder":
        return [
          {
            label: t("action.refresh"),
            icon: <RefreshCw size={15} />,
            onClick: () => {
              s.refreshNode(node.key);
              setMenu(null);
            },
          },
        ];
      case "table":
      case "view":
        return [
          {
            label: "全景 (360°)",
            icon: <Radar size={15} />,
            onClick: () => {
              openEntity360({
                connId: node.connId,
                connName: cfg?.name,
                database: node.database,
                schema: node.schema,
                table: node.table ?? node.label,
                objectKind: node.kind === "view" ? "view" : "table",
              });
              setMenu(null);
            },
          },
          {
            label: t("action.openDetails"),
            icon: <TableProperties size={15} />,
            onClick: () => {
              s.openTableInspector(node);
              setMenu(null);
            },
          },
          {
            label: t("action.openData"),
            icon: <TableProperties size={15} />,
            onClick: () => {
              void s.openTableTab(node);
              setMenu(null);
            },
          },
          { label: t("action.newQuery"), icon: <SquareTerminal size={15} />, onClick: () => newQuery() },
          {
            sep: true,
            label: "问 AI",
            icon: <Sparkles size={15} />,
            onClick: () => {
              const name = node.table ?? node.label;
              useAi.getState().seedAsk(
                `解释一下 ${name} 这张表:大致用途、关键字段的含义,并给出一个示例的只读查询。`,
              );
              setMenu(null);
            },
          },
          {
            label: t("action.copyName"),
            icon: <Copy size={15} />,
            onClick: () => copy(node.table ?? node.label),
          },
          hideItem,
          ...(node.kind === "table" ? [deleteItem] : []),
        ];
      case "procedure":
      case "function":
        return [{ label: "打开执行面板", icon: <Code2 size={15} />, onClick: () => s.openRoutineTab(node) }, { label: t("action.copyName"), icon: <Copy size={15} />, onClick: () => copy(node.label) }];
      case "column":
        return [
          { label: t("action.copyName"), icon: <Copy size={15} />, onClick: () => copy(node.label) },
        ];
    }
  };

  const SECTIONS: { key: Section; label: string; icon: React.ReactNode; badge?: number }[] = [
    { key: "conn", label: "连接", icon: <DbIcon size={15} />, badge: connections.length || undefined },
    { key: "editor", label: "编辑器", icon: <Code2 size={15} />, badge: tabs.length || undefined },
    { key: "files", label: "文件", icon: <Files size={15} />, badge: savedQueries.length || undefined },
  ];

  return (
    <aside className="sidebar" style={{ width: "100%", height: "100%" }}>
      <div className="side-tabs">
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            className={`side-tab ${section === s.key ? "on" : ""}`}
            onClick={() => changeSection(s.key)}
            title={s.label}
          >
            {s.icon}
            <span className="st-label">{s.label}</span>
            {s.badge ? <span className="st-badge">{s.badge}</span> : null}
          </button>
        ))}
      </div>

      <div className="sidebar-head">
        <span className="title">
          {section === "conn" ? t("sidebar.connections") : section === "editor" ? "打开的编辑器" : "文件"}
        </span>
        {section === "conn" && hiddenCount > 0 && (
          <button
            className={`icon-btn ${showHidden ? "on" : ""}`}
            title={showHidden ? "隐藏已隐藏项" : `显示 ${hiddenCount} 个已隐藏项`}
            onClick={() => useApp.getState().toggleShowHidden()}
          >
            {showHidden ? <Eye size={16} /> : <EyeOff size={16} />}
          </button>
        )}
        {section === "conn" && (
          <button className="icon-btn" title={t("toolbar.newConnection")} onClick={() => useApp.getState().openDialog()}>
            <Plus size={17} />
          </button>
        )}
        {section === "editor" && tabs.length > 0 && (
          <button
            className="icon-btn"
            title="关闭全部编辑器"
            onClick={() => tabs.forEach((tb) => useApp.getState().closeTab(tb.id))}
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div className="side-body">
        {section === "conn" &&
          (connections.length === 0 ? (
            <div className="sidebar-empty">
              <DbIcon size={30} style={{ color: "var(--text-3)" }} />
              <h4>{t("sidebar.noConnections")}</h4>
              <p>{t("sidebar.emptyHelp")}</p>
              <button className="btn primary" onClick={() => useApp.getState().openDialog()}>
                <Plus size={15} /> {t("toolbar.newConnection")}
              </button>
              <div style={{ height: 10 }} />
              <button className="btn" onClick={() => useApp.getState().createDemo()}>
                <Sparkles size={15} /> {t("sidebar.tryDemo")}
              </button>
            </div>
          ) : (
            <div className="tree">
              {rootKeys.map((k) => (
                <TreeRow key={k} nodeKey={k} depth={0} onContext={openContext} />
              ))}
            </div>
          ))}
        {section === "editor" && <EditorList />}
        {section === "files" && <FilesPanel />}
      </div>

      {deleteNode && <DeleteObjectDialog key={deleteNode.key} node={deleteNode} onClose={() => setDeleteNode(null)}/>}
      {menu && (
        <>
          <div className="ctx-backdrop" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div className="ctx-menu" ref={menuFit.ref} style={menuFit.style}>
            {buildItems(menu.node).map((it, i) => (
              <div key={i}>
                {it.sep && <div className="ctx-sep" />}
                <div className={`ctx-item ${it.danger ? "danger" : ""}`} onClick={it.onClick}>
                  {it.icon}
                  {it.label}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
