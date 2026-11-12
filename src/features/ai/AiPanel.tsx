import { useSubmitOnEnter } from "../../hooks/useSubmitOnEnter";
import { useMemo, useRef, useState, useEffect } from "react";
import { Sparkles, Settings, X, Square, CornerDownLeft, FileInput, Eraser, Radar, BrainCircuit } from "lucide-react";
import { useApp, catalogKey } from "../../store/appStore";
import { useAi } from "./aiStore";
import { useAiStrings } from "./strings";
import { streamChat, type StreamHandle } from "./aiClient";
import { buildMessages, extractTables, pickRelevantTables, extractSql, type ChatMessage } from "./prompt";
import { buildTableContext, focusLabel } from "./context";
import { metricsForConn } from "../metrics/metricsStore";
import { compileMetric } from "../metrics/metricSql";
import AiMarkdown, { CopyBtn } from "./AiMarkdown";
import AiSettings from "./AiSettings";
import "./ai.css";

interface UiMessage {
  role: "user" | "assistant";
  content: string;
}

export default function AiPanel() {
  const t = useAiStrings();
  const panelOpen = useAi((s) => s.panelOpen);
  const config = useAi((s) => s.config);
  const updateConfig = useAi((s) => s.update);
  const settingsOpen = useAi((s) => s.settingsOpen);
  const focusEntity = useAi((s) => s.focusEntity);

  const activeTab = useApp((s) => s.tabs.find((tab) => tab.id === s.activeTabId));
  const tabs = useApp((s) => s.tabs);
  const meta = useApp((s) => s.meta);
  const catalogs = useApp((s) => s.catalogs);

  /* 目标连接 = 当前标签的。Python、看板这类标签的 connId 是空串(不是 undefined),
     ?? 接不住,以前会一路掉到「请先连接数据库」——明明库是连着的。
     所以:空串/已断开都算没有,退回最近一个带活连接的标签,再退回第一个已连接的库。 */
  const connId = useMemo(() => {
    const own = activeTab && "connId" in activeTab ? activeTab.connId : "";
    if (own && meta[own]) return own;
    for (let i = tabs.length - 1; i >= 0; i--) {
      const tab = tabs[i];
      const c = "connId" in tab ? tab.connId : "";
      if (c && meta[c]) return c;
    }
    return Object.keys(meta)[0];
  }, [activeTab, tabs, meta]);
  const database =
    (activeTab && "database" in activeTab && "connId" in activeTab && activeTab.connId === connId
      ? activeTab.database
      : undefined) ?? meta[connId ?? ""]?.currentDatabase;
  const kind = connId ? meta[connId]?.kind : undefined;
  const catalog = useMemo(() => {
    if (!connId) return undefined;
    // The active tab's database key may differ from how the catalog was cached,
    // so fall back to any catalog loaded for this connection (prefix = connId + sep).
    const prefix = catalogKey(connId, "");
    return (
      catalogs[catalogKey(connId, database)] ??
      Object.entries(catalogs).find(([k]) => k.startsWith(prefix))?.[1]
    );
  }, [catalogs, connId, database]);
  const tables = useMemo(() => extractTables(catalog), [catalog]);

  /* 问答 和 分析 是两种东西:前者是聊天,后者是一条有状态的流水线。
     共用面板外壳,但内容各管各的 —— 硬塞进同一个消息列表会两边都别扭。 */
  const [mode, setMode] = useState<"chat">("chat");
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const streamRef = useRef<StreamHandle | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const seedNonce = useAi((s) => s.seedNonce);
  const streamingRef = useRef(false);
  streamingRef.current = streaming;

  // Stop the abandoned stream if the panel is unmounted by error recovery.
  useEffect(() => () => streamRef.current?.cancel(), []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // A question injected from elsewhere (table inspector, error, …) auto-sends.
  useEffect(() => {
    const q = useAi.getState().consumeSeed();
    if (q && !streamingRef.current) send(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedNonce]);

  const submitKeys = useSubmitOnEnter(() => send());

  if (!panelOpen) return null;

  const send = (q?: string) => {
    const question = (q ?? input).trim();
    if (!question || streaming) return;
    if (q === undefined) setInput("");
    const history: ChatMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));
    const relevant = pickRelevantTables(question, tables);
    const metricList = metricsForConn(connId).filter((m) => m.enabled);
    const metricHints = metricList.map((m) => ({
      name: m.name,
      aliases: m.aliases,
      description: m.caliber,
      unit: m.unit,
      sql: compileMetric(m, {}, (id) => metricList.find((x) => x.id === id)).sql,
    }));
    const tableContext = buildTableContext(useAi.getState().focusEntity, question);
    const payload = buildMessages(kind, relevant, history, question, metricHints, tableContext);

    setMessages((prev) => [...prev, { role: "user", content: question }, { role: "assistant", content: "" }]);
    setStreaming(true);
    streamRef.current = streamChat(config, payload, {
      onToken: (delta) =>
        setMessages((prev) => {
          // The chat may have been cleared mid-stream — ignore late tokens.
          const last = prev[prev.length - 1];
          if (!last || last.role !== "assistant") return prev;
          const next = [...prev];
          next[next.length - 1] = { role: "assistant", content: last.content + delta };
          return next;
        }),
      onDone: () => setStreaming(false),
      onError: (message) => {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (!last || last.role !== "assistant") return prev;
          const next = [...prev];
          next[next.length - 1] = { role: "assistant", content: `⚠️ ${t("errorPrefix")}${message}` };
          return next;
        });
        setStreaming(false);
      },
    });
  };

  const stop = () => {
    streamRef.current?.cancel();
    setStreaming(false);
  };

  // Clear the chat — also cancel any in-flight stream so late tokens can't land.
  const clear = () => {
    streamRef.current?.cancel();
    setStreaming(false);
    setMessages([]);
  };

  const insertToEditor = (sql: string) => {
    if (!connId) return;
    useApp.getState().openQueryTab({ connId, database, sql });
  };

  return (
    <div className="ai-panel">
      <div className="ai-head">
        <span className="ai-title">
          <Sparkles size={15} /> {t("title")}
        </span>
        <div className="ai-modes" role="tablist" aria-label="AI 模式">
          <button role="tab" aria-selected={mode === "chat"} className={mode === "chat" ? "on" : ""} onClick={() => setMode("chat")}>问答</button>
        </div>
        <span className="ai-endpoint">{config.provider === "builtin" ? t("providerBuiltin") : config.provider === "local" ? t("providerLocal") : t("providerCloud")}</span>
        <button className="ai-icon" title={t("settings")} onClick={() => useAi.getState().openSettings()}>
          <Settings size={15} />
        </button>
        <button className="ai-icon" title={t("clear")} onClick={clear}>
          <Eraser size={15} />
        </button>
        <button className="ai-icon" title={t("close")} onClick={() => useAi.getState().togglePanel()}>
          <X size={15} />
        </button>
      </div>

      {!connId && !focusEntity ? (
        <div className="ai-empty">{t("noConnection")}</div>
      ) : (
        <>
          <div className="ai-messages" ref={scrollRef}>
            {messages.length === 0 && (
              <div className="ai-empty">
                <p>{t("empty")}</p>
                <div className="ai-examples">
                  {(["ex1", "ex2", "ex3"] as const).map((k) => (
                    <button
                      key={k}
                      className="ai-example"
                      onClick={() => {
                        setInput(t(k));
                        inputRef.current?.focus();
                      }}
                    >
                      {t(k)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => {
              const sql = m.role === "assistant" ? extractSql(m.content) : null;
              const isLast = i === messages.length - 1;
              return (
                <div key={i} className={`ai-msg ${m.role}`}>
                  <div className="ai-bubble">
                    {m.role === "assistant" ? (
                      m.content ? (
                        <AiMarkdown content={m.content} />
                      ) : streaming && isLast ? (
                        <span className="ai-dots">{t("thinking")}</span>
                      ) : null
                    ) : (
                      m.content
                    )}
                  </div>
                  {sql && (
                    <div className="ai-actions">
                      <button className="ai-chip" onClick={() => insertToEditor(sql)}>
                        <FileInput size={13} /> {t("insertToEditor")}
                      </button>
                      <CopyBtn text={sql} label={t("copy")} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="ai-footer">
            <div className="ai-footerbar">
              {focusEntity ? (
                <div className="ai-focuschip" title="回答会带上这张表的相关指标口径">
                  <Radar size={12} /> 上下文:<b>{focusLabel(focusEntity)}</b>
                  <button className="ai-focus-x" title="取消上下文" onClick={() => useAi.getState().setFocusEntity(null)}><X size={11} /></button>
                </div>
              ) : (
                <div className="ai-schemahint">{t("schemaHint", { tables: Math.min(tables.length, 25) })}</div>
              )}
              {config.provider === "local" && (
                <button
                  className={`ai-thinking-toggle ${config.thinkingEnabled ? "on" : ""}`}
                  aria-pressed={config.thinkingEnabled}
                  title={config.thinkingEnabled ? t("modeThinkingTitle") : t("modeDirectTitle")}
                  disabled={streaming}
                  onClick={() => updateConfig({ thinkingEnabled: !config.thinkingEnabled })}
                >
                  <BrainCircuit size={13} />
                  {config.thinkingEnabled ? t("modeThinking") : t("modeDirect")}
                </button>
              )}
            </div>
            <div className="ai-inputrow">
              <textarea
                ref={inputRef}
                className="ai-input"
                value={input}
                placeholder={t("placeholder")}
                onChange={(e) => setInput(e.target.value)}
                {...submitKeys}
                rows={2}
              />
              {streaming ? (
                <button className="ai-send stop" onClick={stop} title={t("stop")}>
                  <Square size={15} />
                </button>
              ) : (
                <button className="ai-send" onClick={() => send()} title={t("send")} disabled={!input.trim()}>
                  <CornerDownLeft size={15} />
                </button>
              )}
            </div>
          </div>
        </>
      )}

      {settingsOpen && <AiSettings />}
    </div>
  );
}
