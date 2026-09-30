import {
  Check,
  Database,
  Loader2,
  Play,
  RotateCcw,
  Save
} from "lucide-react";
import { useState } from "react";
import AiInline from "../features/ai/AiInline";
import EditorContextMenu from "../features/ai/EditorContextMenu";
import type { InlineAction } from "../features/ai/prompt";
import { useDrag } from "../hooks/useDrag";
import { useI18n } from "../hooks/useI18n";
import { DATABASE_CAPABILITIES } from "../lib/databaseDialect";
import { catalogKey, useApp } from "../store/appStore";
import type { QueryTab } from "../store/appTypes";
import QueryResults from "./QueryResults";
import SqlEditor, { type EditorAiContext } from "./SqlEditor";

export default function SqlWorkspace({ tab }: { tab: QueryTab; }) {
  const { t } = useI18n();
  const tabId = tab.id;
  const resultHeight = useApp(s => { const current = s.tabs.find(t => t.id === tabId); return current?.kind === "query" ? current.resultHeight ?? s.resultHeight : s.resultHeight; });
  const resultCollapsed = useApp(s => s.resultCollapsed);
  const connKind = useApp((s) => (tab ? s.meta[tab.connId]?.kind : undefined));
  const connected = useApp((s) => (tab ? !!s.meta[tab.connId] : false));
  const autoCommit = useApp((s) => (tab ? s.autocommit[tab.connId] ?? true : true));
  const key = tab ? catalogKey(tab.connId, tab.database) : "";
  const catalog = useApp((s) => (key ? s.catalogs[key] : undefined));
  const catalogLoading = useApp((s) => (key ? !!s.catalogLoading[key] : false));
  const hasMultiDb = useApp((s) => (tab ? !!s.meta[tab.connId]?.hasMultipleDatabases : false));
  const databases = useApp((s) => (tab ? s.databases[tab.connId] : undefined));
  const language = useApp((s) => s.language);

  // 分隔条在结果区上方:往上拖(delta 为负)结果区变高
  const resizer = useDrag("y", {
    start: () => {
      const s = useApp.getState();
      const current = s.tabs.find(t => t.id === tabId);
      return current?.kind === "query" ? current.resultHeight ?? s.resultHeight : s.resultHeight;
    },
    move: (startHeight, delta) => useApp.getState().setResultHeight(startHeight - delta, tabId),
  });
  const [menuCtx, setMenuCtx] = useState<EditorAiContext | null>(null);
  const [aiCtx, setAiCtx] = useState<{ ctx: EditorAiContext; action: InlineAction | "ask"; } | null>(null);

  return (
    <div className="main">

      <div className="editor-wrap">
        <div className="editor-bar">
          <button
            className="btn primary sm"
            onClick={() => useApp.getState().runTab(tab.id)}
            disabled={tab.running || tab.savingEdits || !connected}
            title={t("query.runTitle")}
          >
            {tab.running ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
            {tab.running
              ? t("query.running")
              : tab.selectedSql?.trim()
                ? t("query.runSelection")
                : t("query.run")}
          </button>
          <button className="btn sm" title="保存 SQL 脚本 (⌘S / Ctrl+S)" onClick={() => useApp.getState().saveTab(tab.id)}><Save size={14} />保存</button>
          <span className="conn-pill">
            <span className="dot" style={{ background: connected ? "var(--green)" : "var(--text-3)" }} />
            {tab.connName}
          </span>
          {connected && hasMultiDb && (databases?.length ?? 0) > 0 && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Database size={13} style={{ color: "var(--text-3)", flex: "0 0 auto" }} />
              <select
                className="db-picker"
                value={tab.database ?? ""}
                disabled={!autoCommit || tab.running || tab.savingEdits}
                onChange={(e) => useApp.getState().setTabDatabase(tab.id, e.target.value)}
                title={language === "en" ? "Active database" : "当前数据库"}
                style={{
                  height: 26,
                  maxWidth: 180,
                  borderRadius: 7,
                  border: "1px solid var(--border-2)",
                  background: "var(--surface-2)",
                  color: "var(--text)",
                  fontSize: 12,
                  padding: "0 6px",
                  cursor: "default",
                }}
              >
                {!tab.database && (
                  <option value="">{language === "en" ? "Select database…" : "选择数据库…"}</option>
                )}
                {databases!.map((db) => (
                  <option key={db} value={db}>
                    {db}
                  </option>
                ))}
              </select>
            </span>
          )}
          {!connected && (
            <button className="btn sm" onClick={() => void useApp.getState().connect(tab.connId).catch(() => { })}>{t("query.disconnected")} · 连接</button>
          )}
          {connected && catalogLoading && (
            <span className="catalog-status"><Loader2 size={12} className="spin" /> {t("query.loadingMetadata")}</span>
          )}
          <div className="toolbar-spacer" />
          {connected && connKind && DATABASE_CAPABILITIES[connKind].manualTransactions && (
            <div className="ac-controls">
              {!autoCommit && (
                <>
                  <button
                    className="btn sm"
                    title={t("tx.commit")}
                    onClick={() => useApp.getState().commitSession(tab.connId)}
                  >
                    <Check size={13} /> {t("tx.commit")}
                  </button>
                  <button
                    className="btn sm"
                    title={t("tx.rollback")}
                    onClick={() => useApp.getState().rollbackSession(tab.connId)}
                  >
                    <RotateCcw size={13} /> {t("tx.rollback")}
                  </button>
                </>
              )}
              <label className={`ac-toggle ${autoCommit ? "on" : "off"}`}>
                <input
                  type="checkbox"
                  checked={autoCommit}
                  onChange={(e) => useApp.getState().setAutocommit(tab.connId, e.target.checked, tab.database)}
                />
                <span>{autoCommit ? t("autocommit.label") : t("autocommit.manual")}</span>
              </label>
            </div>
          )}
        </div>

        <SqlEditor
          value={tab.sql}
          kind={connKind}
          catalog={catalog}
          onChange={(v) => useApp.getState().updateSql(tab.id, v)}
          onSelectionChange={(sql) => useApp.getState().updateSelection(tab.id, sql)}
          onRun={() => useApp.getState().runTab(tab.id)}
          onAiInvoke={setMenuCtx}
        />
      </div>

      {menuCtx && (
        <EditorContextMenu
          ctx={menuCtx}
          onRunSelection={() => useApp.getState().runTab(tab.id)}
          onAiAction={(action) => setAiCtx({ ctx: menuCtx, action })}
          onClose={() => setMenuCtx(null)}
        />
      )}

      {aiCtx && (
        <AiInline
          ctx={aiCtx.ctx}
          action={aiCtx.action}
          kind={connKind}
          catalog={catalog}
          onRunSql={(sql) => {
            const id = useApp.getState().openQueryTab({ connId: tab.connId, database: tab.database, sql, readOnly: true, title: "AI · 只读查询" });
            useApp.getState().runTab(id);
          }}
          onClose={() => setAiCtx(null)}
        />
      )}

      <div
        className={`resizer-y ${resizer.active ? "active" : ""}`}
        onPointerDown={resizer.onPointerDown}
        onDoubleClick={() => useApp.getState().setResultCollapsed(!resultCollapsed)}
        title="拖动调整结果区高度,双击收起/展开"
      />

      <QueryResults tab={tab} height={resultHeight} collapsed={resultCollapsed} />
    </div>
  );
}
