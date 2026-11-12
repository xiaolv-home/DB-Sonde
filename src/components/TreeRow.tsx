import {
  Database,
  Layers,
  Folder,
  FolderOpen,
  Table2,
  Eye,
  KeyRound,
  ChevronRight,
  Loader2,
  SquareTerminal,
  Circle,
  Braces,
  Workflow,
} from "lucide-react";
import { useApp, type TreeNode } from "../store/appStore";
import DatabaseLogo from "./DatabaseLogo";
import { connectionAccent } from "../lib/databaseIdentity";
import { useI18n } from "../hooks/useI18n";

function NodeIcon({ node, expanded }: { node: TreeNode; expanded: boolean }) {
  switch (node.kind) {
    case "connection":
      return <DatabaseLogo connId={node.connId} />;
    case "database":
      return <Database size={15} />;
    case "schema":
      return <Layers size={15} />;
    case "folder":
      return expanded ? <FolderOpen size={15} /> : <Folder size={15} />;
    case "table":
      return <Table2 size={15} />;
    case "view":
      return <Eye size={15} />;
    case "procedure":
      return <Workflow size={15} />;
    case "function":
      return <Braces size={15} />;
    case "column":
      return node.isPk ? (
        <KeyRound size={13} style={{ color: "var(--amber)" }} />
      ) : (
        <Circle size={7} style={{ color: "var(--text-3)" }} />
      );
  }
}

interface Props {
  nodeKey: string;
  depth: number;
  parentKey?: string;
  onContext: (node: TreeNode, e: React.MouseEvent) => void;
}

export default function TreeRow({ nodeKey, depth, parentKey, onContext }: Props) {
  const { t } = useI18n();
  const node = useApp((s) => s.nodes[nodeKey]);
  const selected = useApp((s) => s.selectedKey === nodeKey);
  const hidden = useApp((s) => s.hiddenKeys.includes(nodeKey));
  const showHidden = useApp((s) => s.showHidden);
  const connId = node?.connId;
  const connected = useApp((s) => (connId ? !!s.meta[connId] : false));
  const connecting = useApp((s) => (connId ? !!s.connecting[connId] : false));
  const connColor = useApp((s) =>
    node?.kind === "connection"
      ? (() => { const c = s.connections.find(c => c.id === node.connId); return c ? connectionAccent(c) : null; })()
      : null,
  );

  if (!node) return null;
  if (hidden && !showHidden) return null; // hidden nodes collapse away
  const isConn = node.kind === "connection";
  const isTableish = node.kind === "table" || node.kind === "view";

  // Double-click = "open" (never expand): connect / open browser / open table.
  // Expanding is only done via the twisty arrow.
  const open = () => {
    const s = useApp.getState();
    if (isConn) {
      if (!connected) s.connect(node.connId).catch(() => {});
      else s.openQueryTab({ connId: node.connId, title: t("query.title") });
      return;
    }
    if (node.kind === "database" || node.kind === "schema") void s.openDatabaseTab(node);
    else if (node.kind === "procedure" || node.kind === "function") s.openRoutineTab(node);
    else if (isTableish) s.openTableInspector(node);
    else if (node.hasChildren) void s.toggleNode(node.key); // folders have nothing to open
  };

  // Single-click only selects the row — it must not expand it.
  const onClick = () => useApp.getState().selectNode(node.key);

  const showTwisty = node.hasChildren && (!isConn || connected);

  return (
    <>
      <div
        className={`node ${node.kind}${isConn && connColor ? " tinted" : ""}${selected ? " selected" : ""}${hidden ? " hidden-node" : ""}`}
        style={{
          paddingLeft: 6 + depth * 14,
          ...(isConn && connColor ? ({ ["--conn-tint"]: connColor } as React.CSSProperties) : {}),
        }}
        draggable={isConn || !!parentKey}
        onDragStart={(e) => {
          if (isConn) e.dataTransfer.setData("text/conn", node.connId);
          else if (parentKey) e.dataTransfer.setData("text/node", node.key);
          else return;
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          const types = e.dataTransfer.types;
          if (isConn && types.includes("text/conn")) e.preventDefault();
          else if (parentKey && types.includes("text/node")) e.preventDefault();
        }}
        onDrop={(e) => {
          const types = e.dataTransfer.types;
          if (isConn && types.includes("text/conn")) {
            e.preventDefault();
            const from = e.dataTransfer.getData("text/conn");
            if (from) useApp.getState().reorderConnections(from, node.connId);
          } else if (parentKey && types.includes("text/node")) {
            e.preventDefault();
            const from = e.dataTransfer.getData("text/node");
            if (from && from !== node.key) useApp.getState().reorderChild(parentKey, from, node.key);
          }
        }}
        onClick={onClick}
        onDoubleClick={open}
        onContextMenu={(e) => onContext(node, e)}
        title={node.detail ? `${node.label} · ${node.detail}` : node.label}
      >
        <span
          className={`twisty ${node.expanded ? "open" : ""} ${showTwisty ? "" : "leaf"}`}
          onClick={(e) => {
            if (showTwisty) {
              e.stopPropagation();
              useApp.getState().toggleNode(node.key);
            }
          }}
        >
          <ChevronRight size={13} />
        </span>

        {/* 连接中才呼吸 —— 呼吸灯是「正在发生的事」的信号;
            给一个稳定的状态点加呼吸,那就成装饰了。 */}
        {isConn ? (
          <span className={`dot ${connected ? "on" : ""} ${connecting ? "connecting breathe-glow" : ""}`} />
        ) : null}

        <span className="nicon" style={isConn && connColor ? { color: connColor } : undefined}>
          {connecting && isConn ? (
            <Loader2 size={14} className="spin" />
          ) : (
            <NodeIcon node={node} expanded={node.expanded} />
          )}
        </span>

        <span className="label">{node.label}</span>
        {node.detail ? <span className="detail">{node.detail}</span> : null}

        {node.loading && !isConn ? (
          <Loader2 size={13} className="spin" style={{ marginLeft: "auto", color: "var(--text-3)" }} />
        ) : null}

        {isConn && connected ? (
          <span
            className="row-action"
            style={{ marginLeft: "auto" }}
            onClick={(e) => {
              e.stopPropagation();
              useApp.getState().openQueryTab({ connId: node.connId, title: t("query.title") });
            }}
            title={t("action.newQuery")}
          >
            <SquareTerminal size={14} />
          </span>
        ) : null}
      </div>

      {node.expanded &&
        node.childKeys.map((k) => (
          <TreeRow key={k} nodeKey={k} depth={depth + 1} parentKey={node.key} onContext={onContext} />
        ))}

      {node.expanded && node.loading && node.childKeys.length === 0 ? (
        <div className="node" style={{ paddingLeft: 6 + (depth + 1) * 14, color: "var(--text-3)" }}>
          <span className="twisty leaf" />
          <span className="nicon">
            <Loader2 size={13} className="spin" />
          </span>
          <span className="label" style={{ color: "var(--text-3)" }}>
            {t("tree.loading")}
          </span>
        </div>
      ) : null}
    </>
  );
}
