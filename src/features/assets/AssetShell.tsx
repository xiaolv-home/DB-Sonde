import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X, GitBranch, Workflow, CalendarClock, Gauge, Boxes, MonitorDot } from "lucide-react";
import { useLineage } from "../lineage/lineageStore";
import { useEtl } from "../etl/etlStore";
import { useScheduler } from "../scheduler/schedulerStore";
import { useMetrics } from "../metrics/metricsStore";
import { useDatasets } from "../datasets/datasetsStore";
import { useMonitor } from "../monitor/monitorStore";
import "./assets.css";
import { useGlassPill } from "../../hooks/useGlassPill";

export type AssetSection = "lineage" | "etl" | "sched" | "metrics" | "datasets" | "monitor";

/**
 * 「数据资产」外壳。
 *
 * 血缘 / ETL / 调度 / 指标本来是四个各开各的浮层,顶栏四个按钮 —— 它们讲的是同
 * 一件事的四个侧面(这张表从哪来、几点跑、口径是什么、动了它会影响谁),却互相
 * 看不见,想换一个得先关掉再从顶栏重开。这里统一成一个浮层 + 左侧导航,四个面
 * 随时互跳;每一项旁边写清楚它回答的问题,而不是丢一个术语名词在那。
 *
 * **外壳只有一套,而且跨面存活。** 六个中心以前各渲染一整个外壳,于是「切一下
 * 面」= 整块浮层拆掉重建:进场动画每次重播(看着就是闪一下才出来),左侧那条玻
 * 璃胶囊也跟着重生,本该从上一项滑到下一项的,变成了瞬移。现在浮层、侧栏、胶囊
 * 由 AssetChromeHost 渲染一次,中心只把自己的标题和内容投进壳里 —— 于是「进场
 * 动画只在真正打开时播」不是一条特判,是结构本身决定的。
 */
const SECTIONS: { id: AssetSection; label: string; question: string; icon: typeof GitBranch }[] = [
  { id: "etl", label: "ETL", question: "这张表是谁在灌", icon: Workflow },
  { id: "sched", label: "调度", question: "几点跑、跑挂没", icon: CalendarClock },
  { id: "lineage", label: "血缘", question: "动了它会影响谁", icon: GitBranch },
  { id: "datasets", label: "数据集", question: "看板的数拿哪张表算", icon: Boxes },
  { id: "metrics", label: "指标", question: "这个数怎么算的", icon: Gauge },
  { id: "monitor", label: "监控中心", question: "各系统现在跑得怎么样", icon: MonitorDot },
];

/** 切到某一面:关掉其它三个,只留一个开着 —— 保证任何时候只有一个浮层。 */
export function openAsset(section: AssetSection) {
  useEtl.getState().setOpen(section === "etl");
  useScheduler.getState().setOpen(section === "sched");
  useLineage.getState().setOpen(section === "lineage");
  useMetrics.getState().setOpen(section === "metrics");
  useDatasets.getState().setOpen(section === "datasets");
  useMonitor.getState().setOpen(section === "monitor");
}

export function closeAssets() {
  useEtl.getState().setOpen(false);
  useScheduler.getState().setOpen(false);
  useLineage.getState().setOpen(false);
  useMetrics.getState().setOpen(false);
  useDatasets.getState().setOpen(false);
  useMonitor.getState().setOpen(false);
}

/** 壳里留给内容的那块地方。null = 浮层没开(或还没落地),中心这一帧什么都不画。 */
const SlotContext = createContext<HTMLElement | null>(null);

/** 浮层本体:遮罩、面板、左侧导航、以及一块等着中心往里填的空列。 */
function AssetChrome({ section, slotRef }: { section: AssetSection; slotRef: (node: HTMLDivElement | null) => void }) {
  /* 侧栏那条竖排导航跟工作区标签栏共用同一块玻璃胶囊 —— 同一套动作,
     用户在两个地方看到的是一件东西,而不是两种各自发明的高亮。 */
  const { trackProps, pillProps } = useGlassPill(section);
  return (
    <div className="asset-overlay" onMouseDown={closeAssets}>
      <div className="asset-panel" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="asset-rail pill-track" {...trackProps}>
          <span {...pillProps} />
          <div className="asset-brand">
            <Boxes size={16} />
            <span>数据资产</span>
          </div>
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                data-pill={s.id}
                className={`asset-nav ${s.id === section ? "on" : ""}`}
                onClick={() => openAsset(s.id)}
              >
                <Icon size={16} />
                <span className="asset-nav-txt">
                  <b>{s.label}</b>
                  <small>{s.question}</small>
                </span>
              </button>
            );
          })}
        </nav>
        {/* 中心的表头和正文投到这儿。壳不碰它们,只管把位置留着。 */}
        <div className="asset-col" ref={slotRef} />
      </div>
    </div>
  );
}

/**
 * 把六个中心包起来,并在它们**旁边**(不是里面)渲染那唯一的一套外壳。
 *
 * 中心仍旧各自挂着不动 —— 关掉再打开,草稿和滚动位置还在;外壳则跟着
 * 「有没有开着的面」生灭。section 由上层从各 store 的 open 标志算出来,
 * 这儿不再订阅一遍,免得同一件事有两个说法。
 */
export function AssetChromeHost({ section, children }: { section: AssetSection | null; children: ReactNode }) {
  /* 用 state 而不是 ref 存这个节点:壳先落地、中心才能往里投,
     中间隔着一次渲染,得有东西把这次变化通知出去。 */
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  /* 壳没开的时候,前一次留下的节点已经不在文档里了,不能再往里投。 */
  const target = useMemo(() => (section ? slot : null), [section, slot]);
  return (
    <SlotContext.Provider value={target}>
      {section && <AssetChrome section={section} slotRef={setSlot} />}
      {children}
    </SlotContext.Provider>
  );
}

/**
 * 中心那一侧:把表头和正文投进外壳。
 *
 * 从调用方看跟以前没区别(还是 title / sub / actions / children 四样),
 * 区别在于外壳不再由它造 —— 所以换一个面的时候,拆掉重建的只有这里头的内容。
 */
export default function AssetShell({
  title,
  sub,
  actions,
  children,
}: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const slot = useContext(SlotContext);
  if (!slot) return null;
  return createPortal(
    <>
      <header className="asset-head">
        <div className="asset-h-title">{title}</div>
        {sub && <div className="asset-h-sub">{sub}</div>}
        <div className="toolbar-spacer" />
        {actions}
        <button className="ai-icon" title="关闭" onClick={closeAssets}>
          <X size={16} />
        </button>
      </header>
      {children}
    </>,
    slot,
  );
}
