import type { ComponentType } from "react";
import PanelErrorBoundary, { PanelFailure } from "../components/PanelErrorBoundary";
import AiPanel from "./ai/AiPanel";
import { useAi } from "./ai/aiStore";
import AssetShell, { AssetChromeHost, closeAssets, type AssetSection } from "./assets/AssetShell";
import DatasetsCenter from "./datasets/DatasetsCenter";
import { useDatasets } from "./datasets/datasetsStore";
import Entity360 from "./entity/Entity360";
import { useEntity } from "./entity/entityStore";
import EtlCenter from "./etl/EtlCenter";
import { useEtl } from "./etl/etlStore";
import LineageCenter from "./lineage/LineageCenter";
import { useLineage } from "./lineage/lineageStore";
import MetricsCenter from "./metrics/MetricsCenter";
import { useMetrics } from "./metrics/metricsStore";
import SchedulerCenter from "./scheduler/SchedulerCenter";
import { useScheduler } from "./scheduler/schedulerStore";

/** Keep healthy feature instances mounted across navigation; only failed children restart. */
export function AssetFeatures() {
  const sched = useScheduler(s => s.open);
  const metrics = useMetrics(s => s.open);
  const etl = useEtl(s => s.open);
  const lineage = useLineage(s => s.open);
  const datasets = useDatasets(s => s.open);
  const features: { section: AssetSection; name: string; open: boolean; View: ComponentType }[] = [
    { section: "sched", name: "调度", open: sched, View: SchedulerCenter },
    { section: "datasets", name: "数据集", open: datasets, View: DatasetsCenter },
    { section: "metrics", name: "指标", open: metrics, View: MetricsCenter },
    { section: "etl", name: "ETL", open: etl, View: EtlCenter },
    { section: "lineage", name: "血缘", open: lineage, View: LineageCenter },
  ];
  /* 外壳(遮罩 + 侧栏 + 玻璃胶囊)只此一套,由 AssetChromeHost 渲染;各中心仍旧
     各自挂着,只是把内容投进壳里。谁开着这一件事只有这儿一个说法。 */
  const active = features.find(f => f.open)?.section ?? null;
  return <AssetChromeHost section={active}>{features.map(({ section, name, open, View }) =>
    <PanelErrorBoundary key={section} name={name} active={open} fallback={(error, retry) =>
      <AssetShell title={name}><PanelFailure name={name} error={error} retry={retry} close={closeAssets} /></AssetShell>}>
      <View />
    </PanelErrorBoundary>)}</AssetChromeHost>;
}

export function EntityFeature() {
  const target = useEntity(s => s.target);
  return <PanelErrorBoundary name="实体详情" active={!!target} fallback={(error, retry) =>
    <div className="modal-backdrop"><div className="modal"><PanelFailure name="实体详情" error={error} retry={retry} close={() => useEntity.getState().close()} /></div></div>}>
    <Entity360 />
  </PanelErrorBoundary>;
}

export function AiFeature() {
  const open = useAi(s => s.panelOpen);
  return <PanelErrorBoundary name="AI 助手" active={open}
    onRetry={() => { useAi.getState().consumeSeed(); }}
    fallback={(error, retry) => <aside className="failed-ai-panel"><PanelFailure name="AI 助手" error={error} retry={retry} close={() => useAi.getState().togglePanel()} /></aside>}>
    <AiPanel />
  </PanelErrorBoundary>;
}
