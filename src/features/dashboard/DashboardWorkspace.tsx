import { useUnsavedChanges } from "../../hooks/useUnsavedChanges";
import { resolveSemanticDocument } from "./semantic";
import { widgetTitle } from "./widgetFactory";
import * as service from "./dashboardService";
import * as transfer from "./transfer";
import { clearQueryCache } from "./query";
import { downloadOfflineHtml } from "./export/offlineHtml";
import { refineAnalysisDashboard } from "./refineAnalysisDashboard";
import AiProvenanceBanner from "./components/AiProvenanceBanner";
import { defaultMetricScope } from "../metrics/queryPlan";
import { isStaticWidget, placeWidget } from "./domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { DashboardTab } from "../../store/appStore";
import { useApp } from "../../store/appStore";
import { useDatasets } from "../datasets/datasetsStore";
import { resolveWidgetDatasets, reuseUnchanged } from "./resolveDatasets";
import {
  createDashboard,
  type DashboardDataset,
  type DashboardDocument,
  type DashboardDrillFilter,
  type DashboardWidget,
  type DashboardWidgetType,
} from "./domain";
import { useMetrics } from "../metrics/metricsStore";
import { dashboardRepository } from "./repository";
import { api } from "../../lib/api";
import { useDatasetRuntime, useFilteredRuntime, useDashboardVersions, useComparisonRuntime, useDrillRuntime, useComponentRuntime, mergeCanvasRuntime, nextDrillPath, type ComponentFilterValue, type ComponentFilterValueMap, type DrillPathMap } from "./useDashboardRuntime";
import DashboardCanvas from "./components/DashboardCanvas";
import FieldPanel from "./studio/FieldPanel";
import Inspector from "./studio/Inspector";
import { FilterRail, TopBar } from "./studio/StudioBar";
import { addToShelf, targetShelf, widgetFromField } from "./studio/smart";
import { endFieldDrag, readDrag } from "./studio/Shelf";
import { PanelLeftOpen } from "lucide-react";
import { nanoid } from "nanoid";
import "./studio/studio.css";
import { useI18n } from "../../hooks/useI18n";
import { activeDashboardFilters, type DashboardFilterValues } from "./filtering";
import { useDashboardHistory } from "./useDashboardHistory";

export default function DashboardWorkspace({ tab, active = true }: { tab: DashboardTab; active?: boolean }) {
  const { t } = useI18n();
  const centralMetrics = useMetrics(s => s.metrics);
  const [documents, setDocuments] = useState<DashboardDocument[]>([]);
  const [storedDocument, setDocument] = useState<DashboardDocument>();
  const document = useMemo(() => storedDocument ? resolveSemanticDocument(storedDocument, centralMetrics) : undefined, [storedDocument, centralMetrics]);
  const [selectedWidgetId, setSelectedWidgetId] = useState<string>();
  const [filterValues, setFilterValues] = useState<DashboardFilterValues>({});
  const [componentFilterValues, setComponentFilterValues] = useState<ComponentFilterValueMap>({});
  const [drill, setDrill] = useState<DashboardDrillFilter>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exportingHtml, setExportingHtml] = useState(false);
  const [, setSelectedRevision] = useState<number>();
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(tab.id, dirty);
  const [preview, setPreview] = useState(false);
  const [fieldsOpen, setFieldsOpen] = useState(() => { try { return localStorage.getItem("sonde.studio.fields") !== "0"; } catch { return true; } });
  const toggleFields = (open: boolean) => { setFieldsOpen(open); try { localStorage.setItem("sonde.studio.fields", open ? "1" : "0"); } catch { /* 只在这次生效 */ } };
  /** 没选组件时字段面板浏览的数据集;新加的组件也默认用它,点开就能加字段。 */
  const [browseDatasetId, setBrowseDatasetId] = useState<string>();
  const markDirty = useCallback(() => setDirty(true), []);
  const {
    canUndo,
    clearHistory,
    rememberCurrent,
    undo: undoHistory,
    updateDocument,
  } = useDashboardHistory(document, setDocument, markDirty);

  // 取数与版本历史:交给专用 hook,组件只保留状态编排。
  /* 取数管线只认「一段 SQL + 一个连接」。组件存的是数据集 id 和它选的维度/度量,
     这里编译成管线要的形状 —— 每个组件一份,因为同一个数据集选不同维度就是不同的
     查询。数据集是全局的,所以它一改,这里跟着重算,所有引用它的看板一起更新。 */
  const globalDatasets = useDatasets((s) => s.datasets);
  // 组件取数要靠这份列表编译 SQL,看板先于数据集面板打开时它还是空的。
  useEffect(() => { useDatasets.getState().ensureLoaded(); }, []);
  const connections = useApp((s) => s.connections);
  /* 上一次的编译结果。没变的那几份要沿用同一个对象,下游的 memo 才拦得住重算。 */
  const compiledRef = useRef<DashboardDataset[]>([]);
  const runtimeDocument = useMemo(() => {
    if (!document) return document;
    const kindOf = (connectionId: string) => connections.find((c) => c.id === connectionId)?.kind;
    const compiled = reuseUnchanged(
      compiledRef.current,
      resolveWidgetDatasets(document.widgets, globalDatasets, kindOf, document.metricScope, document.datasets),
    );
    compiledRef.current = compiled;
    return { ...document, datasets: compiled };
  }, [document, globalDatasets, connections]);

  const [runtime, setRuntime] = useDatasetRuntime(runtimeDocument, centralMetrics, runtimeRevision, t);
  const [filteredRuntime, setFilteredRuntime] = useFilteredRuntime(runtimeDocument, filterValues, drill, runtimeRevision, t);
  const [, setVersions] = useDashboardVersions(document?.id);
  // 多级下钻路径(按 widgetId)。UI 态,不持久化。
  const [drillPaths, setDrillPaths] = useState<DrillPathMap>({});
  const drillRuntime = useDrillRuntime(runtimeDocument, filterValues, drillPaths, runtimeRevision, t);
  const componentRuntime = useComponentRuntime(runtimeDocument, filterValues, componentFilterValues, drillPaths, runtimeRevision, t);
  const comparisonRuntime = useComparisonRuntime(runtimeDocument, filterValues, componentFilterValues, runtimeRevision, t);
  const drillDown = (widgetId: string, value: string) => {
    const widget = document?.widgets.find((w) => w.id === widgetId);
    const dims = widget?.options.chart?.drillDimensions ?? [];
    // 点中的值属于「这个组件现在按什么分组」,不是下钻链里的某一层。
    const bound = widget?.bindings.dimensions?.[0] ?? widget?.bindings.dimension ?? "";
    const next = nextDrillPath(dims, drillPaths[widgetId] ?? [], value, bound);
    if (next) setDrillPaths((current) => ({ ...current, [widgetId]: next }));
  };
  const drillTo = (widgetId: string, level: number) =>
    setDrillPaths((current) => ({ ...current, [widgetId]: (current[widgetId] ?? []).slice(0, level) }));

  useEffect(() => {
    let cancelled = false;
    dashboardRepository.list()
      .then((items) => {
        if (cancelled) return;
        setDocuments(items);
        /* 指名了某个看板却没找到,就别静默显示另一个 —— 那会让人以为"AI 建的看板
           是空的",实际是打开了别的板子。 */
        const requested = tab.documentId ? items.find((item) => item.id === tab.documentId) : undefined;
        if (tab.documentId && !requested) {
          useApp.getState().showToast({ kind: "error", text: `没找到看板 ${tab.documentId},它可能已被删除` });
        }
        /* 没指名看板就给白板。这里原本兜底取 items[0],于是从工具栏每开一次
           「看板设计」都是已存列表里的第一张(通常是 AI 生成的那张),想从头做
           只能一个个删掉它的组件。已存的看板从工具栏的页面列表里挑。 */
        const selected = requested ?? createDashboard(t("dashboard.untitled"));
        setDocument(selected);
        setFilterValues(Object.fromEntries(selected.filters.map((filter) => [filter.id, filter.defaultValue ?? ""])));
        /* 白板还没落库,把它的 id 挂到标签页上,切走再回来就会被当成「看板已被删除」
           而报错。等 save() 写进去 —— 那时它才真的存在。 */
        useApp.getState().updateDashboardTab(tab.id, requested
          ? { documentId: selected.id, title: selected.title }
          : { title: selected.title });
      })
      .catch((error) => useApp.getState().showToast({ kind: "error", text: String(error) }))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    /* 只认 tab.id。tab.documentId 是这个 effect 自己在末尾写上去的(新建的白板
       落到标签页上),列进依赖就会立刻再跑一遍、把刚建的板子覆盖掉。
       t 是 i18n 取词函数,只用来给白板起个默认名,不该触发重新加载。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只认 tab.id;documentId 是这个 effect 自己写上去的
  }, [tab.id]);

  // 自动刷新:每 refreshInterval 秒触发一次全量重取(bump runtimeRevision)。
  useEffect(() => {
    const seconds = document?.refreshInterval ?? 0;
    if (!seconds || !active) return;
    const id = window.setInterval(() => { clearQueryCache(); setRuntimeRevision((value) => value + 1); }, seconds * 1000);
    return () => window.clearInterval(id);
  }, [document?.refreshInterval, active]);

  const selectedWidget = document?.widgets.find((item) => item.id === selectedWidgetId);

  const undo = () => {
    if (!undoHistory()) return;
    setSelectedWidgetId(undefined);
    useApp.getState().showToast({ kind: "success", text: t("dashboard.undone") });
  };

  const updateWidget = (widget: DashboardWidget, record = true) =>
    updateDocument((current) => service.updateWidget(current, widget), record);

  // 新建组件默认绑定的指标:优先当前选中,否则第一个启用的中心指标。

  /* 下面这些动作的文档改写逻辑都搬进了 dashboardService(纯函数,可单测、
     可被 AI Agent 的 Tool 调用)。组件这里只留 UI 编排:翻译标题、选中新对象、
     出错时弹 toast。 */
  /* edit 只能调一次 —— 它内部生成 nanoid,调两次会得到两个不同的 id,
     选中的就不是刚建出来的那个了。updateDocument 是同步的(见 useDashboardHistory),
     所以在 reducer 里算完顺手把 id 捞出来。 */
  const runEdit = <T,>(edit: (doc: DashboardDocument) => service.Created<T>, onDone?: (id: T) => void) => {
    let created: T | undefined;
    let failed: string | undefined;
    updateDocument((current) => {
      try {
        const result = edit(current);
        created = result.id;
        return result.doc;
      } catch (error) {
        failed = String(error).replace(/^Error:\s*/, "");
        return current;
      }
    });
    if (failed) useApp.getState().showToast({ kind: "error", text: failed });
    else if (created !== undefined) onDone?.(created);
  };

  const addWidget = (type: DashboardWidgetType) =>
    runEdit(
      (doc) => service.addWidget(doc, {
        type, title: widgetTitle(type, t),
        datasetId: isStaticWidget(type) ? undefined : lastDatasetId(),
      }),
      setSelectedWidgetId,
    );

  /** 新组件默认用哪个数据集:正在浏览的,其次是看板里最近一个组件用的。 */
  const lastDatasetId = () => {
    if (browseDatasetId && globalDatasets.some((d) => d.id === browseDatasetId)) return browseDatasetId;
    const used = [...(document?.widgets ?? [])].reverse().find((w) => w.datasetId && globalDatasets.some((d) => d.id === w.datasetId));
    return used?.datasetId ?? (globalDatasets.length === 1 ? globalDatasets[0].id : undefined);
  };

  /** 字段拖到画布上:落在某张卡片上就加进那张,落在空白处就按字段长出一张新图。 */
  const dropField = (event: React.DragEvent) => {
    const payload = readDrag(event);
    endFieldDrag();
    if (!payload || payload.from || !document) return;
    event.preventDefault();
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-widget-id]");
    const target = card ? document.widgets.find((w) => w.id === card.dataset.widgetId) : undefined;
    if (target) {
      const dataset = globalDatasets.find((d) => d.id === (target.datasetId || lastDatasetId()));
      const field = dataset?.fields.find((f) => f.name === payload.name);
      const shelf = field ? targetShelf(target, field) : undefined;
      if (!dataset || !field || !shelf) {
        useApp.getState().showToast({ kind: "info", text: dataset ? "这张卡片放不下这个字段" : "这个字段不在这张卡片的数据集里" });
        return;
      }
      updateWidget(addToShelf({ ...target, datasetId: dataset.id }, shelf, field.name, dataset));
      setSelectedWidgetId(target.id);
      return;
    }
    const dataset = globalDatasets.find((d) => d.fields.some((f) => f.name === payload.name) && d.id === lastDatasetId())
      ?? globalDatasets.find((d) => d.fields.some((f) => f.name === payload.name));
    const created = dataset ? widgetFromField(dataset, payload.name) : undefined;
    if (!created) return;
    // 落点换算成网格坐标:拖到哪就放在哪附近
    const grid = (event.currentTarget as HTMLElement).querySelector<HTMLElement>(".dash-canvas");
    let x = 0, y = 0;
    if (grid) {
      const rect = grid.getBoundingClientRect();
      const styles = getComputedStyle(grid);
      const row = (parseFloat(styles.gridAutoRows) || 60) + (parseFloat(styles.rowGap) || 8);
      x = Math.max(0, Math.min(12 - created.w, Math.floor(((event.clientX - rect.left) / rect.width) * 12) - Math.floor(created.w / 2)));
      y = Math.max(0, Math.floor((event.clientY - rect.top + grid.scrollTop) / row));
    }
    const top = document.widgets.filter((w) => !w.parentId);
    const free = !top.some((w) => x < w.x + w.w && x + created.w > w.x && y < w.y + w.h && y + created.h > w.y);
    const placed = free ? { ...created, x, y } : placeWidget(created, top);
    updateDocument((current) => ({ ...current, widgets: [...current.widgets, placed] }));
    setSelectedWidgetId(placed.id);
  };

  const addChildWidget = (parentId: string, tabId: string, type: DashboardWidgetType) => {
    if (type === "container") return;
    runEdit(
      (doc) => service.addWidget(doc, { type, title: widgetTitle(type, t), parentId, tabId }),
      setSelectedWidgetId,
    );
  };

  const duplicateWidget = (id: string) => {
    const source = document?.widgets.find((item) => item.id === id);
    if (!source) return;
    runEdit(
      (doc) => service.duplicateWidget(doc, id, t("dashboard.copyName", { name: source.title })),
      setSelectedWidgetId,
    );
  };

  const toggleWidget = (id: string) => updateDocument((current) => service.toggleWidget(current, id));

  const deleteWidget = (id: string) => updateDocument((current) => service.deleteWidget(current, id));

  const save = async () => {
    if (!document || saving) return;
    setSaving(true);
    try {
      const next = { ...document, revision: dirty ? document.revision + 1 : document.revision, updatedAt: new Date().toISOString() };
      const saved = await dashboardRepository.save(next);
      setDocument(saved);
      setDocuments((items) => items.some((item) => item.id === saved.id)
        ? items.map((item) => item.id === saved.id ? saved : item)
        : [...items, saved]);
      setDirty(false);
      clearHistory();
      useApp.getState().updateDashboardTab(tab.id, { documentId: saved.id, title: saved.title });
      useApp.getState().showToast({ kind: "success", text: t("dashboard.saved") });
    } catch (error) {
      useApp.getState().showToast({ kind: "error", text: String(error) });
    } finally {
      setSaving(false);
    }
  };

  // 注:「发布 / 版本回滚」UI 已按用户要求移除(觉得没用)。仓库层与 Rust 端的
  // publish / list_dashboard_versions 仍保留,想恢复只需把 VersionControls 接回来。

  /**
   * 把编辑器整个切到另一份文档上。
   *
   * 「选一页」「新建」「导入」原来各写了一遍同样的十几行清空 —— 一旦加了新的
   * UI 态(下钻路径、组件级筛选就是后加的),只要漏改一处就会带着上一份看板的
   * 残留进新文档,而且看起来一切正常。合成一个入口。
   */
  const openDocument = (next: DashboardDocument, opts: { dirty: boolean }) => {
    setDocument(next);
    setSelectedWidgetId(undefined);
    setRuntime({});
    setFilteredRuntime({});
    setVersions([]);
    setSelectedRevision(undefined);
    setFilterValues(Object.fromEntries((next.filters ?? []).map((filter) => [filter.id, filter.defaultValue ?? ""])));
    setDrill(undefined);
    setDrillPaths({});
    setComponentFilterValues({});
    clearHistory();
    setDirty(opts.dirty);
    useApp.getState().updateDashboardTab(tab.id, { documentId: next.id, title: next.title });
  };

  const selectDocument = (id: string) => {
    if (dirty && !window.confirm(t("dashboard.confirmSwitch"))) return;
    const next = documents.find((item) => item.id === id);
    if (next) openDocument(next, { dirty: false });
  };

  const newDocument = () => {
    if (dirty && !window.confirm(t("dashboard.confirmNew"))) return;
    openDocument(createDashboard(t("dashboard.untitled")), { dirty: true });
  };

  const rootRef = useRef<HTMLDivElement>(null);
  const [storagePath, setStoragePath] = useState("");
  useEffect(() => { void api.dashboardStoragePath().then(setStoragePath).catch(() => setStoragePath("")); }, []);

  /* 最后一张也能删 —— 删完开一张空白的。原来这里直接 return,按钮点了没反应,
     人只会以为「这软件不让删」。 */
  const deleteDocument = (id: string) => {
    const target = documents.find((item) => item.id === id) ?? (document?.id === id ? document : undefined);
    if (!target || !window.confirm(`删除“${target.title || "未命名看板"}”?其草稿、发布版本与历史都会移除,不可恢复。`)) return;
    void dashboardRepository.delete(id)
      .then(() => {
        const rest = documents.filter((item) => item.id !== id);
        setDocuments(rest);
        useApp.getState().showToast({ kind: "success", text: "页面已删除" });
        if (document?.id === id) {
          const next = rest[0];
          if (next) selectDocument(next.id);
          else newDocument();
        }
      })
      .catch((error) => useApp.getState().showToast({ kind: "error", text: String(error) }));
  };

  const exportJson = () => { if (document) transfer.downloadJson(document); };

  const exportHtml = async () => {
    if (!document || exportingHtml) return;
    if (document.widgets.length === 0) {
      useApp.getState().showToast({ kind: "info", text: t("dashboard.publishNeedsWidget") });
      return;
    }
    setExportingHtml(true);
    useApp.getState().showToast({ kind: "info", text: "正在烘焙数据并生成离线网页…" });
    try {
      /* 导出要的是取数用的那份 —— 组件选的数据集和维度已经编译成 SQL,原始文档里
         没有这些,传它导出的会是一张空板。 */
      const { mb, savedToFiles, warnings } = await downloadOfflineHtml(runtimeDocument ?? document, centralMetrics, t);
      useApp.getState().showToast({ kind: "success", text: `离线网页已导出(约 ${mb} MB)${savedToFiles ? " · 已存入「文件」,可随时导回编辑" : ""}` });
      warnings.slice(0, 4).forEach((w) => useApp.getState().showToast({ kind: "info", text: w }));
    } catch (error) {
      useApp.getState().showToast({ kind: "error", text: `导出失败:${String(error)}` });
    } finally {
      setExportingHtml(false);
    }
  };

  const importJson = () => {
    void transfer.pickDashboardFile()
      .then((picked) => {
        if (!picked) return;
        openDocument(picked.doc, { dirty: true });
        useApp.getState().showToast({ kind: "success", text: picked.from === "html"
          ? "已从导出的网页还原看板,可继续编辑"
          : "看板已导入,请检查后保存" });
      })
      .catch((error) => useApp.getState().showToast({ kind: "error", text: `导入失败:${String(error)}` }));
  };

  const canvasRuntime = useMemo(() => {
    if (!runtimeDocument) return runtime;
    /* 这里必须用编译后的文档:运行时结果是按编译出的数据集(每个组件一份)存的,而原始
       文档里 datasets 是空的 —— 拿它来合,合出来就是一张空表,每个组件都取不到数据,
       画布上永远停在「运行数据集并绑定字段后显示」。 */
    return mergeCanvasRuntime(
      runtimeDocument,
      { runtime, filteredRuntime, drillRuntime, componentRuntime, comparisonRuntime },
      (dataset) => activeDashboardFilters(dataset, runtimeDocument.filters, filterValues, drill),
    );
  }, [runtimeDocument, runtime, filteredRuntime, comparisonRuntime, drillRuntime, componentRuntime, filterValues, drill]);
  /* 键盘:⌘S 存、⌘Z 撤销、⌘E 切预览、⌘D 复制、⌫ 删选中的组件、Esc 取消选中。
     在输入框里打字时只认 ⌘S —— 别的键是给文字用的。 */
  const onKey = (event: React.KeyboardEvent) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((event.target as HTMLElement).tagName) || (event.target as HTMLElement).isContentEditable;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (mod && key === "s") { event.preventDefault(); void save(); return; }
    if (typing) return;
    if (mod && key === "z" && !event.shiftKey && !preview) { event.preventDefault(); undo(); }
    else if (mod && key === "e") { event.preventDefault(); setSelectedWidgetId(undefined); setPreview((v) => !v); }
    else if (mod && key === "d" && selectedWidgetId && !preview) { event.preventDefault(); duplicateWidget(selectedWidgetId); }
    else if ((event.key === "Backspace" || event.key === "Delete") && selectedWidgetId && !preview) { event.preventDefault(); deleteWidget(selectedWidgetId); setSelectedWidgetId(undefined); }
    else if (event.key === "Escape" && selectedWidgetId) setSelectedWidgetId(undefined);
  };

  if (loading || !document) return <div className="object-state"><Loader2 size={18} className="spin" />{t("dashboard.loading")}</div>;

  return (
    <div className={`dashboard-workspace st-studio ${preview ? "preview" : ""}`} onKeyDown={onKey} tabIndex={-1} ref={rootRef}>
      <TopBar
        document={document}
        documents={documents}
        dirty={dirty}
        saving={saving}
        preview={preview}
        canUndo={canUndo}
        exportingHtml={exportingHtml}
        storagePath={storagePath}
        onTitle={(title) => { updateDocument((current) => ({ ...current, title })); useApp.getState().updateDashboardTab(tab.id, { title }); }}
        onSelectDocument={selectDocument}
        onNewDocument={newDocument}
        onDuplicateDocument={() => openDocument({ ...structuredClone(document), id: `dashboard-${nanoid(10)}`, title: `${document.title} 副本`, revision: 1, status: "draft", updatedAt: new Date().toISOString() }, { dirty: true })}
        onAddWidget={addWidget}
        onPreview={() => { setSelectedWidgetId(undefined); setPreview((value) => !value); }}
        onUndo={undo}
        onSave={() => void save()}
        onDelete={() => deleteDocument(document.id)}
        onImport={importJson}
        onExportJson={exportJson}
        onExportHtml={() => void exportHtml()}
        onRefreshInterval={(refreshInterval) => updateDocument((current) => ({ ...current, refreshInterval }))}
      />
      <FilterRail
        document={document}
        preview={preview}
        values={filterValues}
        drill={drill}
        refreshing={Object.values(canvasRuntime).some((item) => item.loading)}
        onScope={(start, end) => updateDocument((current) => ({ ...current, metricScope: { ...(current.metricScope ?? defaultMetricScope()), start, end } }))}
        onClearScope={() => updateDocument((current) => ({ ...current, metricScope: undefined }))}
        onAddFilter={(filter) => { updateDocument((current) => ({ ...current, filters: [...current.filters, filter] })); setFilterValues((v) => ({ ...v, [filter.id]: "" })); }}
        onChangeFilter={(filter) => updateDocument((current) => service.updateFilter(current, filter))}
        onRemoveFilter={(id) => {
          setFilterValues((current) => { const next = { ...current }; delete next[id]; return next; });
          updateDocument((current) => service.deleteFilter(current, id));
        }}
        onValue={(id, value) => setFilterValues((current) => ({ ...current, [id]: value }))}
        onClearDrill={() => setDrill(undefined)}
        onRefresh={() => { clearQueryCache(); setRuntimeRevision((v) => v + 1); }}
      />
      <div className={`st-body ${!preview && fieldsOpen ? "with-fields" : ""}`}>
        {!preview && (fieldsOpen
          ? <FieldPanel widget={selectedWidget} datasetId={browseDatasetId ?? lastDatasetId()} onDataset={setBrowseDatasetId} onChange={updateWidget} onCollapse={() => toggleFields(false)} />
          : <button type="button" className="st-fields-rail" title="展开字段面板" onClick={() => toggleFields(true)}><PanelLeftOpen size={15} /><span>字段</span></button>)}
        <main className="dash-canvas-shell st-canvas"
          onDragOver={(event) => { if (!preview && event.dataTransfer.types.includes("application/x-sonde-field")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
          onDrop={(event) => { if (!preview) dropField(event); }}>
          {document.aiProvenance && <AiProvenanceBanner provenance={document.aiProvenance}
            onOptimize={!preview && !document.widgets.some((w) => w.type === "container" || w.parentId) ? () => {
              updateDocument((current) => refineAnalysisDashboard(current, centralMetrics));
              useApp.getState().showToast({ kind: "success", text: "版式已优化，可撤销。保存后保留这些修改。" });
            } : undefined} />}
          {!preview && document.widgets.length === 0 && (
            <div className="st-canvas-hint">
              <b>从左边拖一个字段到这里</b>
              <span>数值会变成指标卡,日期变成趋势线,其它维度变成柱状图 —— 之后随时换类型、加字段。</span>
              <span>也可以点顶上的「添加组件」先放一个空的。</span>
            </div>
          )}
          <DashboardCanvas
            widgetReasons={document.aiProvenance?.widgetReasons}
            widgets={document.widgets}
            datasets={runtimeDocument?.datasets ?? []}
            metrics={document.metrics}
            runtime={canvasRuntime}
            scope={document.metricScope ?? defaultMetricScope()}
            componentFilterValues={componentFilterValues}
            onComponentFiltersChange={(widgetId: string, value: ComponentFilterValue) => setComponentFilterValues((current) => ({ ...current, [widgetId]: value }))}
            selectedId={selectedWidgetId}
            preview={preview}
            onSelect={(id) => setSelectedWidgetId(id || undefined)}
            onChange={(widget) => updateWidget(widget, false)}
            onInteractionStart={rememberCurrent}
            onDelete={deleteWidget}
            onDuplicate={duplicateWidget}
            onToggle={toggleWidget}
            onAddChild={addChildWidget}
            onDrill={setDrill}
            drillPaths={drillPaths}
            onDrillDown={drillDown}
            onDrillTo={drillTo}
          />
        </main>
        {!preview && <Inspector widget={selectedWidget} scope={document.metricScope ?? defaultMetricScope()} onChange={updateWidget}
          onDelete={(id) => { deleteWidget(id); setSelectedWidgetId(undefined); }} />}
      </div>
    </div>
  );
}
