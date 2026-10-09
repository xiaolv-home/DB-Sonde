/* 监控中心:把各系统的监控页面嵌进来,在软件里直接操作。
 *
 * 右边是普通 iframe。有些页面禁止被嵌(X-Frame-Options / CSP frame-ancestors),
 * 嵌进来只会是一片空白 —— 所以切到一个页面时先让后端看一眼响应头(monitorProbe),
 * 不让嵌就直接给「在独立窗口打开」:软件里开一个完整的浏览器窗口,功能一样不少。
 * 不用「主窗口里再嵌原生视图」那条路:它会让 ⌘V / ⌘C / ⌘Z / ⌘S 全部失灵(见 src-tauri/src/monitor.rs)。 */
import { useCallback, useEffect, useState } from "react";
import { AppWindow, ExternalLink, Globe, Pencil, Plus, RotateCw, ShieldAlert, Trash2 } from "lucide-react";
import AssetShell from "../assets/AssetShell";
import { useConfirm } from "../../components/useConfirm";
import { api } from "../../lib/api";
import { inTauri } from "../../lib/mockBackend";
import { useApp } from "../../store/appStore";
import { checkUrl, defaultName, KIND_INFO, newSource, type MonitorSource } from "./monitorModel";
import { monitorRepository } from "./monitorRepository";
import { useMonitor } from "./monitorStore";
import "./monitor.css";

type Draft = { id: string | null; name: string; url: string; error?: string };
/** checking: 还在看响应头;embed: 可以嵌;blocked: 对方不让嵌 */
type Probe = { url: string; state: "checking" | "embed" | "blocked"; reason?: string | null };

function openExternal(url: string) {
  void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url)).catch(() => window.open(url, "_blank"));
}

function openWindow(source: MonitorSource) {
  if (!inTauri) { openExternal(source.url); return; }
  api.monitorOpenWindow(source.id, source.url, source.name).catch((error) =>
    useApp.getState().showToast({ kind: "error", text: String(error) }));
}

export default function MonitorCenter() {
  const open = useMonitor((s) => s.open);
  const { askConfirm, confirmDialog } = useConfirm();
  const [sources, setSources] = useState<MonitorSource[]>(() => monitorRepository.load());
  const [activeId, setActiveId] = useState<string | null>(() => sources[0]?.id ?? null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  /** 换这个数字就让 iframe 重新挂一次(回到首页)(跨域 iframe 拿不到它的历史和当前地址) */
  const [frameKey, setFrameKey] = useState(0);
  const active = sources.find((s) => s.id === activeId) ?? null;
  const activeUrl = active?.url ?? null;

  // 切到一个页面(或改了地址)时看一眼它让不让嵌
  useEffect(() => {
    if (!open || !activeUrl) return;
    let alive = true;
    setProbe({ url: activeUrl, state: "checking" });
    api.monitorProbe(activeUrl)
      .then((r) => { if (alive) setProbe({ url: activeUrl, state: r.embeddable ? "embed" : "blocked", reason: r.reason }); })
      .catch(() => { if (alive) setProbe({ url: activeUrl, state: "embed" }); });
    return () => { alive = false; };
  }, [open, activeUrl]);

  const persist = useCallback((next: MonitorSource[]) => {
    try { monitorRepository.save(next); setSources(next); return true; }
    catch (error) { useApp.getState().showToast({ kind: "error", text: String(error) }); return false; }
  }, []);

  const submit = () => {
    if (!draft) return;
    const checked = checkUrl(draft.url);
    if ("error" in checked) { setDraft({ ...draft, error: checked.error }); return; }
    const name = draft.name.trim() || defaultName(checked.url);
    if (draft.id) {
      if (persist(sources.map((s) => s.id === draft.id ? { ...s, name, url: checked.url } : s))) setDraft(null);
    } else {
      const added = newSource(name, checked.url);
      if (persist([...sources, added])) { setActiveId(added.id); setDraft(null); }
    }
  };

  const remove = async (source: MonitorSource) => {
    const ok = await askConfirm(`「${source.name}」会从监控中心移除(只是不再嵌进来,对方的页面和数据不受影响)。`, "移除这个监控页?", "移除");
    if (!ok) return;
    if (persist(sources.filter((s) => s.id !== source.id))) {
      if (activeId === source.id) setActiveId(sources.find((s) => s.id !== source.id)?.id ?? null);
    }
  };

  // 没选中监控中心就什么都不画 —— 外壳只有一个,各中心都往里投,不判断就会和别的中心摞在一起。
  // 状态(列表、选中项)还在组件里,切回来原样。
  if (!open) return null;

  return (
    <AssetShell
      title="监控中心"
      sub="把各系统的监控页面嵌进来,在这里直接看、直接操作"
      actions={<button className="btn sm" onClick={() => setDraft({ id: null, name: "", url: "" })}><Plus size={14} /> 添加页面</button>}
    >
      <div className="mon-body">
        <aside className="mon-list">
          {draft && (
            <form className="mon-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
              <b>{draft.id ? "修改监控页" : "添加监控页"}</b>
              <span className="mon-kind">{KIND_INFO.web.label} · {KIND_INFO.web.hint}</span>
              <label>网址
                <input className="input" autoFocus value={draft.url} placeholder="http://192.0.2.10:8080"
                  onChange={(e) => { const url = e.target.value; setDraft((d) => d && { ...d, url, error: undefined }); }} />
              </label>
              <label>名称
                <input className="input" value={draft.name} placeholder="不填就用网址里的主机名"
                  onChange={(e) => { const name = e.target.value; setDraft((d) => d && { ...d, name }); }} />
              </label>
              {draft.error && <span className="mon-error">{draft.error}</span>}
              <div className="mon-form-acts">
                <button type="button" className="btn sm" onClick={() => setDraft(null)}>取消</button>
                <button type="submit" className="btn sm primary">{draft.id ? "保存" : "添加"}</button>
              </div>
            </form>
          )}
          {sources.map((s) => (
            <div key={s.id} className={`mon-item ${s.id === activeId ? "on" : ""}`} onClick={() => setActiveId(s.id)}>
              <Globe size={14} />
              <div className="mon-item-main">
                <span className="mon-item-name">{s.name}</span>
                <span className="mon-item-host">{defaultName(s.url)}</span>
              </div>
              <div className="mon-item-acts" onClick={(e) => e.stopPropagation()}>
                <button className="icon-btn" title="修改" onClick={() => setDraft({ id: s.id, name: s.name, url: s.url })}><Pencil size={13} /></button>
                <button className="icon-btn danger" title="移除" onClick={() => void remove(s)}><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
          {sources.length === 0 && !draft && <div className="mon-list-none">还没有接入监控页。</div>}
        </aside>

        <section className="mon-view">
          {active ? (
            <>
              <div className="mon-bar">
                <button className="icon-btn" title="重新载入(回到首页)" onClick={() => setFrameKey((k) => k + 1)}><RotateCw size={14} /></button>
                <span className="mon-url" title={active.url}>{active.url}</span>
                <button className="icon-btn" title="在独立窗口打开" onClick={() => openWindow(active)}><AppWindow size={14} /></button>
                <button className="icon-btn" title="在浏览器里打开" onClick={() => openExternal(active.url)}><ExternalLink size={14} /></button>
              </div>
              <div className="mon-stage">
                {probe?.url === active.url && probe.state === "blocked" ? (
                  <div className="mon-blocked">
                    <ShieldAlert size={26} />
                    <b>这个页面不允许被嵌入</b>
                    <span>{probe.reason ?? "对方设置了禁止嵌入"}。在独立窗口里打开,登录、点击、筛选都和浏览器里一样。</span>
                    <button className="btn primary" onClick={() => openWindow(active)}><AppWindow size={14} /> 在独立窗口打开</button>
                  </div>
                ) : probe?.url === active.url && probe.state === "embed" ? (
                  <iframe key={`${active.id}:${frameKey}`} title={active.name} src={active.url} />
                ) : null}
              </div>
            </>
          ) : (
            <div className="mon-empty">
              <Globe size={28} />
              <b>接入第一个监控页</b>
              <span>比如 ETL 运行台、调度平台、Grafana……填上网址就嵌进来,登录、点击、筛选都和在浏览器里一样。</span>
              <button className="btn primary" onClick={() => setDraft({ id: null, name: "", url: "" })}><Plus size={14} /> 添加页面</button>
            </div>
          )}
        </section>
      </div>
      {confirmDialog}
    </AssetShell>
  );
}
