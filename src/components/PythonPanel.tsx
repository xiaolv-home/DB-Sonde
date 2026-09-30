import { useUnsavedChanges } from "../hooks/useUnsavedChanges";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { syntaxHighlighting } from "@codemirror/language";
import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import {
  Play,
  Square,
  Loader2,
  Save,
  FolderOpen,
  Trash2,
  PackageOpen,
  Package,
  Sparkles,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { editorTheme, highlight } from "./SqlEditor";
import { api, type PyStatus } from "../lib/api";
import { useBatchedLines } from "../hooks/useBatchedLines";
import { inTauri } from "../lib/mockBackend";
import { useAi } from "../features/ai/aiStore";
import PyPackages from "./PyPackages";
import { useApp, type PythonTab } from "../store/appStore";
import { useDrag } from "../hooks/useDrag";

type OutKind = "out" | "err" | "exit" | "sys" | "img";
interface OutLine {
  kind: OutKind;
  text: string; // for kind "img", this is the PNG path
}

const IMG_RE = /⟦SONDE_IMG⟧(.+?)⟦\/IMG⟧/;

/** jedi type → CodeMirror completion type (drives the little icon). */
function mapKind(k: string): string {
  switch (k) {
    case "function":
      return "function";
    case "class":
      return "class";
    case "module":
      return "namespace";
    case "keyword":
      return "keyword";
    case "param":
    case "instance":
    case "statement":
      return "variable";
    case "property":
      return "property";
    default:
      return "variable";
  }
}

/** Inline plot: loads the PNG the script wrote as a data URL. */
function PlotLine({ path }: { path: string }) {
  const [src, setSrc] = useState("");
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .pyReadImage(path)
      .then((s) => alive && setSrc(s))
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [path]);
  if (err) return <div className="py-line err">图片加载失败:{path}</div>;
  if (!src) return <div className="py-line exit">渲染图片…</div>;
  return (
    <div className="py-plot">
      <img src={src} alt="plot" />
    </div>
  );
}

export default function PythonPanel({ tab }: { tab: PythonTab }) {
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(tab.id, dirty);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<PyStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  /* 输出攒一批再刷 —— 逐行 setState 会把整个数组复制一遍再重绘一次,
     打印五万行就是五万次全量复制加五万次渲染。攒批不丢行,见 useBatchedLines。 */
  const { lines: out, push: pushOut, flush: flushOut, reset: resetOut } = useBatchedLines<OutLine>();
  const [aiMenu, setAiMenu] = useState(false);
  const [pkgOpen, setPkgOpen] = useState(false);
  const outHeight = useApp((s) => s.pyOutputHeight);
  const outCollapsed = useApp((s) => s.pyOutputCollapsed);
  const outResizer = useDrag("y", {
    start: () => useApp.getState().pyOutputHeight,
    move: (startHeight, delta) => useApp.getState().setPyOutputHeight(startHeight - delta),
  });
  const runIdRef = useRef("");
  const unlistenRef = useRef<null | (() => void)>(null);
  const startRef = useRef(0);
  const outRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef("");
  contentRef.current = content;

  const extensions = useMemo(() => {
    const pySource = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
      if (!inTauri) return null;
      const before = ctx.matchBefore(/[\w.]/);
      if (!ctx.explicit && !before) return null; // only after a word char or dot
      const pos = ctx.pos;
      const lineObj = ctx.state.doc.lineAt(pos);
      let items;
      try {
        items = await api.pyComplete(ctx.state.doc.toString(), lineObj.number, pos - lineObj.from);
      } catch {
        return null;
      }
      if (!items.length) return null;
      const token = ctx.matchBefore(/[\w]+$/);
      return {
        from: token ? token.from : pos,
        options: items.map((it) => ({ label: it.label, type: mapKind(it.kind) })),
        validFor: /^[\w]*$/,
      };
    };
    return [
      python(),
      editorTheme,
      syntaxHighlighting(highlight),
      autocompletion({ override: [pySource], activateOnTyping: true, icons: true }),
    ];
  }, []);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    api
      .pyReadFile(tab.path)
      .then((c) => alive && (setContent(c), setDirty(false), setLoaded(true)))
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [tab.path]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    const tick = async () => {
      const s = await api.pythonEnsure();
      if (!alive) return;
      setStatus(s);
      // 下载/解压期间持续轮询,进度条才会动
      if (s.extracting || s.progress > 0) timer = setTimeout(tick, 800);
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => () => unlistenRef.current?.(), []);

  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [out]);

  /** 用户点「一键安装」才下载 —— 180MB 不该在进面板时偷偷开始。 */
  const install = useCallback(async () => {
    setInstalling(true);
    try {
      setStatus(await api.pythonInstall());
      const poll = setInterval(async () => {
        const s = await api.pythonInstall();
        setStatus(s);
        if (s.installed || (!s.extracting && s.progress === 0)) {
          clearInterval(poll);
          setInstalling(false);
        }
      }, 800);
    } catch (e) {
      setInstalling(false);
      pushOut({ kind: "err", text: `安装失败:${String(e)}` });
      flushOut();
    }
  }, [pushOut, flushOut]);

  const save = useCallback(async () => {
    /* ⌘S 那条路是 `void save()` —— 写盘失败的话 promise 被 void 吞掉,
       用户只看到小圆点没消失,不知道是没存上还是自己看错了。 */
    try {
      await api.pyWriteFile(tab.path, contentRef.current);
      setDirty(false);
    } catch (e) {
      pushOut({ kind: "err", text: `保存失败:${String(e)}` });
      flushOut();
    }
  }, [tab.path, pushOut, flushOut]);

  const run = useCallback(async () => {
    if (running) return;
    try {
      await api.pyWriteFile(tab.path, contentRef.current);
      setDirty(false);
    } catch (e) {
      resetOut([{ kind: "err", text: `保存失败:${String(e)}` }]);
      return;
    }
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    startRef.current = Date.now();
    resetOut([{ kind: "sys", text: `▶ 运行 ${tab.title}.py` }]);
    setRunning(true);

    if (inTauri) {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenRef.current?.();
      unlistenRef.current = await listen<{ runId: string; kind: string; text?: string; code?: number }>(
        "python://event",
        (e) => {
          const p = e.payload;
          if (p.runId !== runIdRef.current) return;
          if (p.kind === "exit") {
            const secs = ((Date.now() - startRef.current) / 1000).toFixed(2);
            const ok = (p.code ?? 0) === 0;
            pushOut({ kind: "exit", text: `— ${ok ? "完成" : `退出码 ${p.code}`} · 用时 ${secs}s` });
            flushOut();   // 收尾那条立刻显示,别等下一次攒批
            setRunning(false);
            unlistenRef.current?.();
            unlistenRef.current = null;
          } else {
            const raw = p.text ?? "";
            const m = raw.match(IMG_RE);
            if (m) pushOut({ kind: "img", text: m[1] });
            else pushOut({ kind: p.kind as OutKind, text: raw });
          }
        },
      );
    }
    try {
      await api.pythonRun(runId, tab.path);
    } catch (e) {
      pushOut({ kind: "err", text: String(e) });
      flushOut();
      setRunning(false);
    }
  }, [running, tab.path, tab.title, pushOut, flushOut, resetOut]);

  const stop = useCallback(async () => {
    if (!runIdRef.current) return;
    /* 停不掉要说出来。原来是裸 await:失败了一声不吭,而 running 还是 true ——
       「停止」按钮和「运行」按钮双双点不动,只能关掉这个标签页。 */
    try {
      await api.pythonStop(runIdRef.current);
    } catch (e) {
      pushOut({ kind: "err", text: `停止失败:${String(e)}。进程可能还在跑,可以关掉标签页或在系统里结束它。` });
      flushOut();
      setRunning(false);
    }
  }, [pushOut, flushOut]);

  const lint = useCallback(async () => {
    try {
      await api.pyWriteFile(tab.path, contentRef.current);
      setDirty(false);
      const issues = await api.pyLint(tab.path);
      if (issues.length === 0) {
        pushOut({ kind: "sys", text: "✓ ruff:没有发现问题" });
        flushOut();
      } else {
        pushOut({ kind: "sys", text: `ruff 检查:${issues.length} 处` });
        for (const i of issues) pushOut({ kind: "err", text: `  行${i.line}:${i.col} ${i.code} ${i.message}` });
        flushOut();
      }
    } catch (e) {
      pushOut({ kind: "err", text: `检查失败:${String(e)}` });
      flushOut();
    }
  }, [tab.path, pushOut, flushOut]);

  const askAi = (kind: "explain" | "optimize" | "comment") => {
    setAiMenu(false);
    const code = contentRef.current;
    const prompts = {
      explain: `解释这段 Python 在做什么,逐段说明:\n\`\`\`python\n${code}\n\`\`\``,
      optimize: `帮我优化 / 精简这段 Python(保持功能一致),给出改进版和理由:\n\`\`\`python\n${code}\n\`\`\``,
      comment: `给这段 Python 加中文注释,返回带注释的完整代码:\n\`\`\`python\n${code}\n\`\`\``,
    };
    useAi.getState().seedAsk(prompts[kind]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void run();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save();
    }
  };

  const notReady = !status?.installed;
  const pill = status?.extracting
    ? { cls: "wait", text: "首次准备环境中…" }
    : status?.installed
      ? { cls: "ok", text: "内置 Python 3.12" }
      : status?.bundled
        ? { cls: "wait", text: "未就绪" }
        : { cls: "err", text: inTauri ? "此版本未内置 Python" : "需桌面版" };

  return (
    <div className="py-panel" onKeyDown={onKeyDown}>
      <div className="py-toolbar">
        <button className="btn sm primary" onClick={running ? stop : run} disabled={notReady && !running}>
          {running ? <Square size={13} /> : <Play size={13} />} {running ? "停止" : "运行"}
          {!running && <kbd className="run-kbd">⌘⏎</kbd>}
        </button>
        <button className="btn sm" onClick={save} disabled={!dirty}>
          <Save size={13} /> 保存{dirty ? " ●" : ""}
        </button>
        <button className="btn sm" onClick={lint} disabled={notReady} title="用 ruff 检查代码">
          <CheckCircle2 size={13} /> 检查
        </button>
        <div className="ai-wrap">
          <button className="btn sm" onClick={() => setAiMenu((v) => !v)} title="让 AI 帮忙">
            <Sparkles size={13} /> AI
          </button>
          {aiMenu && (
            <>
              <div className="ai-backdrop" onClick={() => setAiMenu(false)} />
              <div className="ai-mini-menu">
                <div onClick={() => askAi("explain")}>解释这段</div>
                <div onClick={() => askAi("optimize")}>优化 / 精简</div>
                <div onClick={() => askAi("comment")}>加中文注释</div>
              </div>
            </>
          )}
        </div>
        <button className="btn sm" onClick={() => setPkgOpen(true)} title="安装第三方包">
          <Package size={13} /> 装包
        </button>
        <span className="py-file">{tab.title}.py</span>
        <div className="toolbar-spacer" />
        <span className={`py-pill ${pill.cls}`}>
          {status?.extracting && <Loader2 size={11} className="spin" />} {pill.text}
        </span>
        {status?.workspace && inTauri && (
          <button
            className="icon-btn"
            title="在访达中打开工作区"
            onClick={() => import("@tauri-apps/plugin-opener").then((m) => m.revealItemInDir(tab.path)).catch(() => {})}
          >
            <FolderOpen size={15} />
          </button>
        )}
      </div>

      {status?.extracting && (
        <div className="py-banner">
          <PackageOpen size={15} /> 首次使用,正在解压内置 Python 环境(pandas / numpy / polars / matplotlib 等)。稍等片刻,之后就一直可用。
        </div>
      )}
      {status && !status.installed && !status.extracting && !status.bundled && inTauri && (
        <div className="py-banner">
          {installing ? (
            <>
              <PackageOpen size={15} /> 正在下载 Python 环境…… {status.progress}%
              <span className="py-bar"><i style={{ width: `${status.progress}%` }} /></span>
            </>
          ) : (
            <>
              <PackageOpen size={15} /> Python 环境未安装。约 180MB,含 pandas / numpy / polars / matplotlib 等,装一次以后一直可用。
              {status.downloadable ? (
                <button className="py-install" onClick={() => void install()}>一键安装</button>
              ) : (
                <span className="py-hint">
                  这个平台没有预建运行时,请用 <code>scripts/bundle-python.sh</code> 自行构建。
                </span>
              )}
            </>
          )}
        </div>
      )}
      {status?.error && !status.extracting && inTauri && (
        <div className="py-banner err">{status.error}</div>
      )}

      <div className="py-editor">
        {loaded ? (
          <div className="cm-host" style={{ height: "100%" }}>
            <CodeMirror
              value={content}
              theme="none"
              height="100%"
              style={{ height: "100%", minHeight: 0 }}
              extensions={extensions}
              onChange={(v) => {
                setContent(v);
                setDirty(true);
              }}
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                highlightActiveLine: true,
                highlightActiveLineGutter: true,
                bracketMatching: true,
                closeBrackets: true,
                indentOnInput: true,
                autocompletion: false,
              }}
            />
          </div>
        ) : (
          <div className="object-state">
            <Loader2 size={16} className="spin" /> 读取脚本…
          </div>
        )}
      </div>

      <div
        className={`resizer-y ${outResizer.active ? "active" : ""}`}
        onPointerDown={outResizer.onPointerDown}
        onDoubleClick={() => useApp.getState().setPyOutputCollapsed(!outCollapsed)}
        title="拖动调整输出区高度,双击收起/展开"
      />

      <div
        className={`py-output${outCollapsed ? " collapsed" : ""}`}
        style={outCollapsed ? undefined : { height: outHeight, flex: `0 0 ${outHeight}px` }}
      >
        <div className="py-out-head">
          <span>输出{outCollapsed && out.length > 0 ? ` · ${out.length} 行` : ""}</span>
          <div className="py-out-head-actions">
            {out.length > 0 && (
              <button className="icon-btn xs" title="清空" onClick={() => resetOut([])}>
                <Trash2 size={13} />
              </button>
            )}
            <button
              className="icon-btn xs pane-toggle"
              title={outCollapsed ? "展开输出区" : "收起输出区"}
              aria-expanded={!outCollapsed}
              onClick={() => useApp.getState().setPyOutputCollapsed(!outCollapsed)}
            >
              {outCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>
        </div>
        <div className="py-out-body" ref={outRef}>
          {out.length === 0 ? (
            <div className="py-out-empty">点「运行」执行脚本,输出显示在这里。画图用 sonde.show() 会内联显示。</div>
          ) : (
            out.map((l, i) =>
              l.kind === "img" ? (
                <PlotLine key={i} path={l.text} />
              ) : (
                <div key={i} className={`py-line ${l.kind}`}>
                  {l.text.replace(/\n$/, "")}
                </div>
              ),
            )
          )}
        </div>
      </div>

      {pkgOpen && <PyPackages onClose={() => setPkgOpen(false)} />}
    </div>
  );
}
