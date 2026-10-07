/* 监控中心:把各系统的监控页面嵌进来,在软件里直接操作。
 *
 * 桌面版里,右边那块不是 iframe,是一个真正的浏览器视图(子 webview,见
 * src-tauri/src/monitor.rs),由这里量好占位框的位置和大小后叫它摆过去。
 * 它是原生视图、浮在网页之上,所以:
 *   · 占位框挪动 / 变大小时要跟着摆(浮层进场动画、窗口缩放);
 *   · 离开监控中心、关掉数据资产、弹出确认框时要把它藏起来,不然会盖住界面。
 * 浏览器里开发预览时退回 iframe(很多页面禁止被嵌,预览里可能是空白,桌面版不受影响)。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Home, Pencil, Plus, RotateCw, Trash2 } from "lucide-react";
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

function openExternal(url: string) {
  void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(url)).catch(() => window.open(url, "_blank"));
}

/** 让原生浏览器视图贴住占位框。visible=false 时藏起来。 */
function useNativeView(source: MonitorSource | null, visible: boolean, stage: HTMLElement | null) {
  const last = useRef("");
  useEffect(() => {
    if (!inTauri) return;
    if (!source || !visible || !stage) { last.current = ""; void api.monitorHideAll(); return; }
    let alive = true;
    let frame = 0;
    const rect = () => {
      const r = stage.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    };
    const first = rect();
    last.current = JSON.stringify(first);
    api.monitorShow(source.id, source.url, first).catch((error) =>
      useApp.getState().showToast({ kind: "error", text: String(error) }));
    /* 每帧比一下位置;只有真变了才通知原生视图(浮层动画那几百毫秒、窗口缩放时)。 */
    const tick = () => {
      if (!alive) return;
      const next = rect();
      const key = JSON.stringify(next);
      if (key !== last.current && next.width > 0 && next.height > 0) {
        last.current = key;
        void api.monitorBounds(source.id, next);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(frame); void api.monitorHideAll(); };
  }, [source, visible, stage]);
}

export default function MonitorCenter() {
  const open = useMonitor((s) => s.open);
  const { askConfirm, confirmDialog } = useConfirm();
  const [sources, setSources] = useState<MonitorSource[]>(() => monitorRepository.load());
  const [activeId, setActiveId] = useState<string | null>(() => sources[0]?.id ?? null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const active = sources.find((s) => s.id === activeId) ?? null;

  useNativeView(active, open && !confirming, stage);

  // 页面里点来点去之后,工具栏上的地址跟着变
  useEffect(() => {
    setCurrent(active?.url ?? null);
    if (!inTauri || !active || !open) return;
    const timer = window.setInterval(() => {
      api.monitorCurrentUrl(active.id).then((u) => { if (u) setCurrent(u); }).catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [active, open]);

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
      const before = sources.find((s) => s.id === draft.id);
      if (persist(sources.map((s) => s.id === draft.id ? { ...s, name, url: checked.url } : s))) {
        // 地址变了:旧的视图关掉,下一次显示时按新地址重开
        if (before && before.url !== checked.url) void api.monitorClose(draft.id);
        setDraft(null);
      }
    } else {
      const added = newSource(name, checked.url);
      if (persist([...sources, added])) { setActiveId(added.id); setDraft(null); }
    }
  };

  const remove = async (source: MonitorSource) => {
    setConfirming(true);
    const ok = await askConfirm(`「${source.name}」会从监控中心移除(只是不再嵌进来,对方的页面和数据不受影响)。`, "移除这个监控页?", "移除");
    setConfirming(false);
    if (!ok) return;
    if (persist(sources.filter((s) => s.id !== source.id))) {
      void api.monitorClose(source.id);
      if (activeId === source.id) setActiveId(sources.find((s) => s.id !== source.id)?.id ?? null);
    }
  };

  const nav = (action: "back" | "forward" | "reload" | "home") => {
    if (!active) return;
    if (!inTauri) {
      const frame = stage?.querySelector("iframe");
      if (frame && action === "reload") frame.src = frame.src;
      if (frame && action === "home") frame.src = active.url;
      return;
    }
    api.monitorNav(active.id, action, active.url).catch((error) =>
      useApp.getState().showToast({ kind: "error", text: String(error) }));
  };

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
                <button className="icon-btn" title="后退" onClick={() => nav("back")}><ArrowLeft size={15} /></button>
                <button className="icon-btn" title="前进" onClick={() => nav("forward")}><ArrowRight size={15} /></button>
                <button className="icon-btn" title="刷新" onClick={() => nav("reload")}><RotateCw size={14} /></button>
                <button className="icon-btn" title="回到首页" onClick={() => nav("home")}><Home size={14} /></button>
                <span className="mon-url" title={current ?? active.url}>{current ?? active.url}</span>
                <button className="icon-btn" title="在浏览器里打开" onClick={() => openExternal(current ?? active.url)}><ExternalLink size={14} /></button>
              </div>
              <div className="mon-stage" ref={setStage}>
                {!inTauri && <iframe title={active.name} src={active.url} />}
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
