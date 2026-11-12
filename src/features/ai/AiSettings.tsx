import { useEffect, useRef, useState } from "react";
import { Loader2, Play, Square, CircleCheck, Download, RefreshCw } from "lucide-react";
import { inTauri } from "../../lib/mockBackend";
import { useAi, type AiProvider } from "./aiStore";
import { routingSummary } from "../agent/model/modelRouting";
import { useAiStrings } from "./strings";
import { useModelDiscovery } from "./useModelDiscovery";
import {
  engineStatus,
  engineStart,
  engineStop,
  waitReady,
  modelDownload,
  modelProgress,
  type EngineStatus,
} from "./engine";

function formatSize(bytes: number | null): string {
  if (!bytes) return "?";
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function BuiltinEngine() {
  const t = useAiStrings();
  const setBuiltinRuntime = useAi((s) => s.setBuiltinRuntime);
  const ready = useAi((s) => s.config.builtin.ready);
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dl, setDl] = useState<{ bytes: number; total: number } | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    void engineStatus().then(setStatus);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  if (!inTauri) return <div className="ai-note">{t("engineDesktopOnly")}</div>;

  const download = async () => {
    setError(null);
    try {
      await modelDownload();
      setDl({ bytes: 0, total: 1 });
      // 重复点击时先停掉上一个轮询,否则旧定时器会一直跑下去。
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        const p = await modelProgress();
        if (!p) return;
        setDl({ bytes: p.bytes, total: p.total || 1 });
        if (p.done || p.error) {
          if (pollRef.current) window.clearInterval(pollRef.current);
          pollRef.current = null;
          setDl(null);
          if (p.error) setError(t("modelDownloadFailed", { err: p.error }));
          setStatus(await engineStatus());
        }
      }, 1000);
    } catch (e) {
      setError(t("modelDownloadFailed", { err: String(e) }));
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await engineStart();
      setStatus(s);
      if (!s.model) {
        setError(t("engineModelMissing"));
        return;
      }
      const ok = await waitReady(s.baseUrl);
      if (ok) setBuiltinRuntime({ model: s.model.split("/").pop() || "builtin", baseUrl: s.baseUrl, ready: true });
      else setError(t("engineStartFailed", { err: "timeout" }));
      setStatus(await engineStatus());
    } catch (e) {
      setError(t("engineStartFailed", { err: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    await engineStop();
    setBuiltinRuntime({ ...useAi.getState().config.builtin, ready: false });
    setStatus(await engineStatus());
  };

  const model = status?.model?.split("/").pop();

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {!status?.binary && <div className="ai-note">{t("engineBinaryMissing")}</div>}
      {status?.binary && !status?.model && !dl && (
        <div style={{ display: "grid", gap: 8 }}>
          <div className="ai-note">{t("engineModelMissing")}</div>
          <button className="btn primary" onClick={() => void download()}>
            <Download size={14} /> {t("modelDownload")}
          </button>
        </div>
      )}
      {dl && (
        <div className="ai-dl">
          <div className="ai-dl-info">
            {t("modelDownloading", {
              pct: Math.floor((dl.bytes / dl.total) * 100),
              done: formatSize(dl.bytes),
              total: formatSize(dl.total),
            })}
          </div>
          <div className="ai-dl-bar">
            <div className="ai-dl-fill" style={{ width: `${Math.min(100, (dl.bytes / dl.total) * 100)}%` }} />
          </div>
        </div>
      )}
      {model && (
        <div style={{ fontSize: 12, color: "var(--text-2)" }}>
          {t("engineModelFound", { name: model, size: formatSize(status?.modelSize ?? null) })}
        </div>
      )}
      {ready ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--green)", fontSize: 13 }}>
            <CircleCheck size={15} /> {t("engineReady", { url: status?.baseUrl ?? "" })}
          </span>
          <button className="btn sm" onClick={() => void stop()}>
            <Square size={13} /> {t("engineStop")}
          </button>
        </div>
      ) : (
        <button
          className="btn primary"
          disabled={busy || !status?.binary || !status?.model}
          onClick={() => void start()}
        >
          {busy ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
          {busy ? t("engineStarting") : t("engineStart")}
        </button>
      )}
      {error && <div className="ai-inline-blocked">{error}</div>}
    </div>
  );
}


/** Agent 节点角色 —— 和 agent/model/modelRouting.ts 的 NodeRole 对齐。 */
const AGENT_ROLES = [
  { id: "reasoning" as const, label: "理解需求 / 写结论" },
  { id: "structured" as const, label: "范围解析(填表)" },
  { id: "design" as const, label: "图表 / 布局 / 主题" },
  { id: "review" as const, label: "成品检查" },
  { id: "cheap" as const, label: "文本归一化" },
];
const ROLE_LABEL: Record<string, string> = Object.fromEntries(AGENT_ROLES.map((r) => [r.id, r.label]));
const PROVIDER_LABEL: Record<string, string> = { local: "本地", cloud: "云端", builtin: "内置" };

export default function AiSettings() {
  const t = useAiStrings();
  const config = useAi((s) => s.config);
  const setProvider = useAi((s) => s.setProvider);
  const updateLocal = useAi((s) => s.updateLocal);
  const updateCloud = useAi((s) => s.updateCloud);
  const update = useAi((s) => s.update);
  const close = useAi((s) => s.closeSettings);
  const configError = useAi((s) => s.configError);

  const discovery = useModelDiscovery(config.provider === "local" ? { provider: "local", baseUrl: config.local.baseUrl } : null);
  const detectMsg = discovery.error ?? (discovery.loaded
    ? discovery.models.length ? `端点可达 · 发现 ${discovery.models.length} 个模型，点击选用` : "服务没有返回模型清单，可以直接填写模型名称。"
    : null);

  const providers: { id: AiProvider; label: string }[] = [
    { id: "local", label: t("providerLocal") },
    { id: "cloud", label: t("providerCloud") },
    { id: "builtin", label: t("providerBuiltin") },
  ];

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{t("settings")}</h3>
        </div>
        <div className="modal-body">
          {configError && <div className="ai-inline-blocked" role="alert">{configError}</div>}
          <div className="form-row">
            <label>{t("provider")}</label>
            <div className="kind-tabs">
              {providers.map((p) => (
                <button
                  key={p.id}
                  className={config.provider === p.id ? "on" : ""}
                  onClick={() => setProvider(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {config.provider === "builtin" && <BuiltinEngine />}

          {config.provider === "local" && (
            <>
              <div className="ai-note">支持 OpenAI 兼容接口的本地服务。填写地址后可检测并选择模型，也可以直接填写模型名称。</div>
              <div className="form-row">
                <label>{t("baseUrl")}</label>
                <input
                  className="input"
                  value={config.local.baseUrl}
                  spellCheck={false}
                  onChange={(e) => updateLocal({ baseUrl: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>{t("model")}</label>
                <input
                  className="input"
                  value={config.local.model}
                  spellCheck={false}
                  onChange={(e) => updateLocal({ model: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label />
                <div className="ai-detect">
                  <button className="btn sm" disabled={discovery.loading} onClick={() => void discovery.load()}>
                    {discovery.loading ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} 检测模型
                  </button>
                  {detectMsg && <span className="ai-detect-msg">{detectMsg}</span>}
                </div>
              </div>
              {discovery.models.length > 0 && (
                <div className="ai-model-list">
                  {discovery.models.map((m) => (
                    <button key={m} className={`ai-model-chip ${config.local.model === m ? "on" : ""}`} onClick={() => updateLocal({ model: m })}>
                      {m}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {config.provider === "cloud" && (
            <>
              <div className="form-row">
                <label>{t("baseUrl")}</label>
                <input
                  className="input"
                  value={config.cloud.baseUrl}
                  spellCheck={false}
                  onChange={(e) => updateCloud({ baseUrl: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>{t("apiKey")}</label>
                <input
                  className="input"
                  type="password"
                  value={config.cloud.apiKey}
                  spellCheck={false}
                  onChange={(e) => updateCloud({ apiKey: e.target.value })}
                />
              </div>
              <div className="form-row">
                <label>{t("model")}</label>
                <input
                  className="input"
                  value={config.cloud.model}
                  spellCheck={false}
                  onChange={(e) => updateCloud({ model: e.target.value })}
                />
              </div>
            </>
          )}

          <label className="checkbox" style={{ marginTop: 6 }}>
            <input
              type="checkbox"
              checked={config.includeSampleRows}
              onChange={(e) => update({ includeSampleRows: e.target.checked })}
            />
            {t("includeSample")}
          </label>
          {/* 「默认关,注意隐私」会让人以为关掉就什么都不出机了。说清**关掉之后仍然会发什么** ——
              分析结论里必然带真实的网点/大区名称和数值,那是分析本身,不是样本。 */}
          <p className="ai-hint">{t("includeSampleHint")}</p>

          {/* Role preferences are explained by the same policy used for requests. */}
          <details className="ai-roles">
            <summary>分析助手 · 分角色选模型</summary>
            <p className="ai-roles-hint">
              可以按任务指定模型来源。未指定时，分析、设计和检查优先使用已配置的云端模型，
              范围解析和文本归一化优先使用已配置的本地模型；对应来源未配置时使用全局选择。
              实际使用的来源显示在下方；分析工作台的单次模型选择会覆盖本次分析、设计和复核。
            </p>
            <div className="ai-roles-now">
              {routingSummary(config).map((r) => (
                <span key={r.role} className={`ai-role-chip ${r.provider}`}>
                  {ROLE_LABEL[r.role]} → {PROVIDER_LABEL[r.provider]}
                  <small>{r.reason}</small>
                </span>
              ))}
            </div>
            {AGENT_ROLES.map((role) => (
              <div className="field-row" key={role.id}>
                <label>{role.label}</label>
                <select
                  value={config.agentRoles?.[role.id] ?? ""}
                  onChange={(e) =>
                    update({
                      agentRoles: {
                        ...(config.agentRoles ?? {}),
                        [role.id]: e.target.value ? (e.target.value as AiProvider) : undefined,
                      },
                    })
                  }
                >
                  <option value="">跟随全局</option>
                  <option value="local">本地端点</option>
                  <option value="cloud">云端 API</option>
                  <option value="builtin">内置模型</option>
                </select>
              </div>
            ))}
          </details>
        </div>
        <div className="modal-foot">
          <div className="toolbar-spacer" />
          <button className="btn primary" onClick={close}>
            {t("close")}
          </button>
        </div>
      </div>
    </div>
  );
}
