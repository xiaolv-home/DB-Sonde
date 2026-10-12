import { useEffect, useRef, useState } from "react";
import { X, Loader2, Download, Globe, Package } from "lucide-react";
import { api } from "../lib/api";
import { inTauri } from "../lib/mockBackend";
import { useBatchedLines } from "../hooks/useBatchedLines";

/** Common data-work packages not in the bundled core — one click to install. */
const CURATED: { pkg: string; label: string; note: string }[] = [
  { pkg: "oracledb", label: "oracledb", note: "连 Oracle(默认 thin,不用装 Instant Client)" },
  { pkg: "PyMySQL", label: "PyMySQL", note: "连 MySQL" },
  { pkg: "psycopg[binary]", label: "psycopg", note: "连 PostgreSQL" },
  { pkg: "scikit-learn", label: "scikit-learn", note: "机器学习" },
  { pkg: "scipy", label: "scipy", note: "科学计算" },
  { pkg: "seaborn", label: "seaborn", note: "统计图" },
  { pkg: "statsmodels", label: "statsmodels", note: "统计模型" },
  { pkg: "plotly", label: "plotly", note: "交互图表" },
  { pkg: "pyecharts", label: "pyecharts", note: "ECharts 图" },
  { pkg: "playwright", label: "playwright", note: "浏览器自动化" },
  { pkg: "faker", label: "Faker", note: "造测试数据" },
  { pkg: "xlrd", label: "xlrd", note: "读旧版 xls" },
];

type Line = { kind: "out" | "err" | "exit" | "sys"; text: string };

export default function PyPackages({ onClose, initial }: { onClose: () => void; initial?: string }) {
  // 从「缺包」那里点进来时,直接勾上 / 填好缺的那个
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial && CURATED.some((c) => c.pkg === initial) ? [initial] : []));
  const [custom, setCustom] = useState(() => (initial && !CURATED.some((c) => c.pkg === initial) ? initial : ""));
  const [running, setRunning] = useState(false);
  /* pip 的输出也是一行行来的,同样攒批 —— 装个大包能刷出上千行。 */
  const { lines: out, push: pushOut, flush: flushOut, reset: resetOut } = useBatchedLines<Line>();
  const runIdRef = useRef("");
  const unlistenRef = useRef<null | (() => void)>(null);
  const outRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => unlistenRef.current?.(), []);
  useEffect(() => {
    const el = outRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [out]);

  const toggle = (pkg: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(pkg)) n.delete(pkg);
      else n.add(pkg);
      return n;
    });

  const beginStream = async (label: string) => {
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    resetOut([{ kind: "sys", text: label }]);
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
            const ok = (p.code ?? 0) === 0;
            pushOut({ kind: "exit", text: ok ? "— 完成 ✓" : `— 失败(退出码 ${p.code})` });
            flushOut();   // 收尾那条立刻显示
            setRunning(false);
            unlistenRef.current?.();
            unlistenRef.current = null;
          } else {
            pushOut({ kind: p.kind as Line["kind"], text: p.text ?? "" });
          }
        },
      );
    }
    return runId;
  };

  const install = async () => {
    if (running) return;
    const pkgs = [...picked, ...custom.split(/[\s,]+/).filter(Boolean)];
    if (pkgs.length === 0) return;
    const runId = await beginStream(`▶ pip install ${pkgs.join(" ")}`);
    try {
      await api.pyPipInstall(runId, pkgs);
    } catch (e) {
      pushOut({ kind: "err", text: String(e) });
      flushOut();
      setRunning(false);
    }
  };

  const installPlaywright = async () => {
    if (running) return;
    const runId = await beginStream("▶ playwright install chromium(浏览器内核,约 140MB)");
    try {
      await api.pyPlaywrightInstall(runId);
    } catch (e) {
      pushOut({ kind: "err", text: String(e) });
      flushOut();
      setRunning(false);
    }
  };

  return (
    <div className="pkg-overlay" onMouseDown={onClose}>
      <div className="pkg-panel" onMouseDown={(e) => e.stopPropagation()}>
        <header className="pkg-head">
          <Package size={16} />
          <span>安装第三方包</span>
          <span className="pkg-sub">清华镜像 · 装进内置 Python</span>
          <div className="toolbar-spacer" />
          <button className="ai-icon" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="pkg-body">
          <div className="pkg-grid">
            {CURATED.map((c) => (
              <button
                key={c.pkg}
                className={`pkg-chip ${picked.has(c.pkg) ? "on" : ""}`}
                onClick={() => toggle(c.pkg)}
                disabled={running}
              >
                <span className="pkg-name">{c.label}</span>
                <span className="pkg-note">{c.note}</span>
              </button>
            ))}
          </div>

          <label className="pkg-custom">
            <span>其他包(空格 / 逗号分隔)</span>
            <input
              className="input"
              value={custom}
              placeholder="如 sqlmodel dask duckdb"
              spellCheck={false}
              disabled={running}
              onChange={(e) => setCustom(e.target.value)}
            />
          </label>

          <div className="pkg-actions">
            <button className="btn primary" onClick={install} disabled={running || (picked.size === 0 && !custom.trim())}>
              {running ? <Loader2 size={14} className="spin" /> : <Download size={14} />} 安装选中的
            </button>
            <button className="btn" onClick={installPlaywright} disabled={running} title="装完 playwright 包后,下载 Chromium 内核">
              <Globe size={14} /> 装 Playwright 浏览器内核
            </button>
          </div>

          {out.length > 0 && (
            <div className="pkg-out" ref={outRef}>
              {out.map((l, i) => (
                <div key={i} className={`py-line ${l.kind}`}>
                  {l.text.replace(/\n$/, "")}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
