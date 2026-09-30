import { useViewportFit } from "../../hooks/useViewportFit";
import { useSubmitOnEnter } from "../../hooks/useSubmitOnEnter";
import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, Square, CornerDownLeft, Replace, FileInput, Play, ChevronLeft } from "lucide-react";
import type { CompletionCatalog, DbKind } from "../../types";
import type { EditorAiContext } from "../../components/SqlEditor";
import { useAi } from "./aiStore";
import { useAiStrings } from "./strings";
import AiMarkdown, { CopyBtn } from "./AiMarkdown";
import { streamChat, type StreamHandle } from "./aiClient";
import {
  buildInlineMessages,
  extractSql,
  extractTables,
  pickRelevantTables,
  type InlineAction,
} from "./prompt";
import { isReadOnlySql } from "./readonly";
import "./ai.css";

interface Props {
  ctx: EditorAiContext;
  /** The action chosen from the editor's right-click menu. A real action runs
   *  immediately; "ask" opens the free-ask box. */
  action: InlineAction | "ask";
  kind?: DbKind;
  catalog?: CompletionCatalog;
  onRunSql: (sql: string) => void;
  onClose: () => void;
}

export default function AiInline({ ctx, action, kind, catalog, onRunSql, onClose }: Props) {
  const t = useAiStrings();
  const config = useAi((s) => s.config);
  const tables = useMemo(() => extractTables(catalog), [catalog]);

  const [phase, setPhase] = useState<"menu" | "result">(action !== "ask" ? "result" : "menu");
  const [reply, setReply] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [ask, setAsk] = useState("");
  const streamRef = useRef<StreamHandle | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      streamRef.current?.cancel();
    };
  }, [onClose]);

  // Run the action picked in the right-click menu straight away.
  useEffect(() => {
    if (action !== "ask") run(action);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = (action: InlineAction, userText?: string) => {
    const code = ctx.selection || ctx.fullText;
    const relevant = pickRelevantTables(userText || code, tables);
    const messages = buildInlineMessages(kind, relevant, action, action === "ask" ? ctx.selection : code, userText);
    setPhase("result");
    setReply("");
    setStreaming(true);
    streamRef.current = streamChat(config, messages, {
      onToken: (d) => setReply((r) => r + d),
      onDone: () => setStreaming(false),
      onError: (m) => {
        setReply(`⚠️ ${t("errorPrefix")}${m}`);
        setStreaming(false);
      },
    });
  };

  const submitKeys = useSubmitOnEnter(() => { if (ask.trim()) run("ask", ask.trim()); });

  const sql = phase === "result" ? extractSql(reply) : null;
  const readonly = sql ? isReadOnlySql(sql, kind) : true;

  // 回复是流式的,浮层会边显示边长高:只往上挪够用的距离,不整块翻上去跳走
  const fit = useViewportFit(ctx, { mode: "clamp" });

  return (
    <>
      <div className="ai-inline-backdrop" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div className="ai-inline" ref={fit.ref} style={fit.style} onMouseDown={(e) => e.stopPropagation()}>
        <div className="ai-inline-head">
          {phase === "result" ? (
            <button className="ai-icon" title={t("back")} onClick={() => { streamRef.current?.cancel(); setPhase("menu"); setReply(""); }}>
              <ChevronLeft size={15} />
            </button>
          ) : (
            <Sparkles size={14} style={{ color: "var(--accent)" }} />
          )}
          <span className="ai-inline-title">AI</span>
          <span className="ai-inline-scope">
            {ctx.selection ? t("selectionHint", { n: ctx.selection.length }) : t("wholeDoc")}
          </span>
        </div>

        {phase === "menu" ? (
          <div className="ai-inline-menu">
            <div className="ai-inline-askrow">
              <textarea
                rows={2}
                className="ai-inline-ask"
                value={ask}
                placeholder={t("inlineAsk")}
                autoFocus
                onChange={(e) => setAsk(e.target.value)}
                {...submitKeys}
              />
              <button className="ai-send" disabled={!ask.trim()} onClick={() => ask.trim() && run("ask", ask.trim())}>
                <CornerDownLeft size={15} />
              </button>
            </div>
          </div>
        ) : (
          <div className="ai-inline-result">
            <div className="ai-inline-reply">{reply ? <AiMarkdown content={reply} /> : <span className="ai-dots">…</span>}</div>
            {streaming ? (
              <button className="ai-chip stop" onClick={() => { streamRef.current?.cancel(); setStreaming(false); }}>
                <Square size={13} /> {t("stop")}
              </button>
            ) : (
              sql && (
                <div className="ai-inline-actions">
                  {readonly ? (
                    <>
                      <button className="ai-chip" onClick={() => { ctx.replace(sql); onClose(); }}>
                        <Replace size={13} /> {t("replaceSel")}
                      </button>
                      <button className="ai-chip" onClick={() => { ctx.insert(sql); onClose(); }}>
                        <FileInput size={13} /> {t("insertCaret")}
                      </button>
                      <button className="ai-chip" onClick={() => { onRunSql(sql); onClose(); }}>
                        <Play size={13} /> {t("runReadonly")}
                      </button>
                    </>
                  ) : (
                    <span className="ai-inline-blocked">{t("writeBlocked")}</span>
                  )}
                  <CopyBtn text={sql} label={t("copy")} />
                </div>
              )
            )}
          </div>
        )}
      </div>
    </>
  );
}
