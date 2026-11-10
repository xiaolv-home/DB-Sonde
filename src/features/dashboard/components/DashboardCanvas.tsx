import { appearanceBackground, cardReadability, readableColor } from "../cardReadability";
import { useRef, useState, type CSSProperties } from "react";
import { Copy, Download, Eye, EyeOff, GripHorizontal, Maximize2, Plus, Sparkles, Trash2 } from "lucide-react";
import { useI18n } from "../../../hooks/useI18n";
import type {
  DashboardDrillFilter,
  DashboardDataset,
  DashboardMetricDefinition,
  DashboardRuntimeData,
  DashboardWidget,
  DashboardWidgetType,
} from "../domain";
import { datasetOf } from "../resolveDatasets";
import { LEAF_WIDGET_TYPES } from "../domain";
import type { ComponentFilterValue, ComponentFilterValueMap, DrillPathMap } from "../useDashboardRuntime";
import { exportChartPng } from "../chartExport";
import WidgetRenderer from "./WidgetRenderer";
import ComponentFilterBar from "./ComponentFilterBar";
import "../presets.css";

interface Props {
  staticRender?: boolean;
  previewTabs?: Record<string, string>;
  /** widgetId → AI 建它的理由。人工建的看板为空。 */
  widgetReasons?: Record<string, string>;
  widgets: DashboardWidget[];
  datasets: DashboardDataset[];
  metrics: DashboardMetricDefinition[];
  runtime: Record<string, DashboardRuntimeData>;
  scope: { start: string; end: string };
  componentFilterValues: ComponentFilterValueMap;
  onComponentFiltersChange: (widgetId: string, value: ComponentFilterValue) => void;
  selectedId?: string;
  preview: boolean;
  onSelect: (id: string) => void;
  onChange: (widget: DashboardWidget) => void;
  onInteractionStart: () => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onToggle: (id: string) => void;
  onAddChild: (parentId: string, tabId: string, type: DashboardWidgetType) => void;
  onDrill: (filter: DashboardDrillFilter) => void;
  drillPaths: DrillPathMap;
  onDrillDown: (widgetId: string, value: string) => void;
  onDrillTo: (widgetId: string, level: number) => void;
}

type InteractionMode = "move" | "resize";

export default function DashboardCanvas({
  widgetReasons,
  previewTabs,
  staticRender,
  widgets,
  datasets,
  metrics,
  runtime,
  scope,
  componentFilterValues,
  onComponentFiltersChange,
  selectedId,
  preview,
  onSelect,
  onChange,
  onInteractionStart,
  onDelete,
  onDuplicate,
  onToggle,
  onAddChild,
  onDrill,
  drillPaths,
  onDrillDown,
  onDrillTo,
}: Props) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [activeTabs, setActiveTabs] = useState<Record<string, string>>({});
  // 拖动/缩放中只在本地记录像素偏移(实时跟手,用 transform/尺寸预览),松手才
  // 落到网格并 onChange 一次 —— 拖动过程中不重算文档、不触发查询,所以流畅。
  const [drag, setDrag] = useState<{ id: string; mode: InteractionMode; dx: number; dy: number } | null>(null);

  const begin = (event: React.PointerEvent, widget: DashboardWidget, mode: InteractionMode) => {
    if (preview) return;
    // 网格可能是画布,也可能是 Tab 容器内的子网格(行高/间距不同),按实际所在网格测量,
    // 这样 Tab 里的子组件也能像外面一样拖动/缩放。
    const grid = (event.currentTarget as HTMLElement).closest(".dash-tab-grid, .dash-canvas") as HTMLElement | null;
    if (!grid) return;
    event.preventDefault();
    event.stopPropagation();
    onInteractionStart();
    onSelect(widget.id);
    const rect = grid.getBoundingClientRect();
    const styles = getComputedStyle(grid);
    const gap = parseFloat(styles.columnGap) || 8;
    const rowGap = parseFloat(styles.rowGap) || gap;
    const autoRow = parseFloat(styles.gridAutoRows) || 60;
    const padX = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
    const startX = event.clientX;
    const startY = event.clientY;
    const columnWidth = (rect.width - padX - 11 * gap) / 12;
    const rowHeight = autoRow + rowGap;
    let dx = 0;
    let dy = 0;

    const move = (pointer: PointerEvent) => {
      dx = pointer.clientX - startX;
      dy = pointer.clientY - startY;
      setDrag({ id: widget.id, mode, dx, dy });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const gx = Math.round(dx / (columnWidth + gap));
      const gy = Math.round(dy / rowHeight);
      if (mode === "move") {
        if (gx || gy) onChange({ ...widget, x: Math.max(0, Math.min(12 - widget.w, widget.x + gx)), y: Math.max(0, widget.y + gy) });
      } else {
        if (gx || gy) onChange({ ...widget, w: Math.max(2, Math.min(12 - widget.x, widget.w + gx)), h: Math.max(2, Math.min(10, widget.h + gy)) });
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** 拖动中被操作组件的实时视觉预览(仅本地 transform/尺寸,不动数据)。 */
  const dragStyle = (widget: DashboardWidget): CSSProperties | undefined => {
    if (!drag || drag.id !== widget.id) return undefined;
    if (drag.mode === "move") {
      return { transform: `translate(${drag.dx}px, ${drag.dy}px)`, zIndex: 50, transition: "none", cursor: "grabbing" };
    }
    return { width: `calc(100% + ${drag.dx}px)`, height: `calc(100% + ${drag.dy}px)`, zIndex: 50, transition: "none" };
  };

  const actions = (widget: DashboardWidget) => !preview && (
    <>
      {(widget.type === "line" || widget.type === "bar" || widget.type === "pie" || widget.type === "funnel" || widget.type === "gauge") && (
        <button className="icon-btn" title="导出 PNG" onClick={(event) => { event.stopPropagation(); exportChartPng(widget.id); }}><Download size={12} /></button>
      )}
      <button className="icon-btn" title={t("dashboard.duplicateWidget")} onClick={(event) => { event.stopPropagation(); onDuplicate(widget.id); }}><Copy size={12} /></button>
      <button className="icon-btn" title={widget.visible ? t("dashboard.hideWidget") : t("dashboard.showWidget")} onClick={(event) => { event.stopPropagation(); onToggle(widget.id); }}>{widget.visible ? <EyeOff size={12} /> : <Eye size={12} />}</button>
      <button className="icon-btn" title={t("dashboard.deleteWidget")} onClick={(event) => { event.stopPropagation(); onDelete(widget.id); }}><Trash2 size={12} /></button>
    </>
  );

  // Tab 里的子组件与画布上的组件配置能力一致:外观/预设、拖动、缩放都支持。
  const renderChild = (widget: DashboardWidget) => {
    const ap = widget.options.appearance ?? {};
    const preset = ap.visualPreset && ap.visualPreset !== "none" ? ap.visualPreset : undefined;
    return (
    <article
      key={widget.id}
      data-widget-id={widget.id}
      data-visual-preset={preset ?? "none"}
      className={`dash-widget dash-child-widget ${selectedId === widget.id && !preview ? "selected" : ""} ${!widget.visible ? "hidden-widget" : ""} ${drag?.id === widget.id ? "dragging" : ""}`}
      style={{
        gridColumn: `${widget.x + 1} / span ${widget.w}`,
        gridRow: `${widget.y + 1} / span ${widget.h}`,
        background: ap.background || undefined,
        color: ap.textColor || undefined,
        borderColor: ap.borderColor || undefined,
        borderWidth: ap.borderWidth != null ? ap.borderWidth : undefined,
        borderStyle: ap.borderWidth != null ? "solid" : undefined,
        borderRadius: ap.radius != null ? ap.radius : undefined,
        boxShadow: ap.shadow ? "0 10px 30px rgba(0,0,0,.30)" : ap.shadow === false ? "none" : undefined,
        ...cardReadability(ap),
        ...dragStyle(widget),
      }}
      onMouseDown={(event) => { event.stopPropagation(); onSelect(widget.id); }}
    >
      <header className={`dash-widget-header ${ap.titleAlign === "center" ? "title-center" : ""}`} onPointerDown={(event) => begin(event, widget, "move")} hidden={ap.hideTitle && preview}>
        {!preview && <GripHorizontal size={12} />}
        <strong style={{ color: readableColor(ap.titleColor, appearanceBackground(ap)) || undefined, fontSize: ap.titleSize || undefined, textAlign: ap.titleAlign || undefined, flex: ap.titleAlign ? 1 : undefined }}>{widget.title}</strong>
        {widgetReasons?.[widget.id] && (
          <span className="dash-why" title={`AI 为什么建这个图:\n${widgetReasons[widget.id]}`}><Sparkles size={11} /></span>
        )}
        <span className="toolbar-spacer" />{actions(widget)}
      </header>
      {widget.subtitle && <div className="dash-widget-sub">{widget.subtitle}</div>}
      <ComponentFilterBar widget={widget} dataset={datasetOf(widget, datasets)} scope={scope} value={componentFilterValues[widget.id]} onChange={(value) => onComponentFiltersChange(widget.id, value)} />
      <div className="dash-widget-body" style={{ padding: ap.padding != null ? ap.padding : undefined }}><WidgetRenderer staticRender={staticRender} widget={widget} runtime={runtime[widget.id] ?? runtime[widget.datasetId]} metrics={metrics} dimensionLabels={datasetOf(widget, datasets)?.dimensionLabels} onDrill={onDrill} drillPath={drillPaths[widget.id]} onDrillDown={(value) => onDrillDown(widget.id, value)} onDrillTo={(level) => onDrillTo(widget.id, level)} /></div>
      {widget.footnote && <div className="dash-widget-foot">{widget.footnote}</div>}
      {!preview && <button className="dash-resize" aria-label={t("dashboard.resizeWidget")} onPointerDown={(event) => begin(event, widget, "resize")}><Maximize2 size={10} /></button>}
    </article>
    );
  };

  const renderContainer = (widget: DashboardWidget) => {
    const firstTab = widget.tabs[0]?.id ?? "";
    const requestedTab = previewTabs?.[widget.id] ?? activeTabs[widget.id];
    const activeTab = widget.tabs.some((tab) => tab.id === requestedTab) ? requestedTab : firstTab;
    const children = widgets.filter((item) => item.parentId === widget.id && item.tabId === activeTab && (!preview || item.visible));
    const cont = widget.options.container ?? {};
    return (
      <div className={`dash-tab-container ${cont.tabPosition === "left" ? "tabs-left" : ""}`}>
        <div className="dash-tab-bar" hidden={cont.showTabBar === false && preview}>
          {widget.tabs.map((tab) => <button key={tab.id} className={tab.id === activeTab ? "on" : ""} onClick={(event) => { event.stopPropagation(); setActiveTabs((current) => ({ ...current, [widget.id]: tab.id })); }}>{tab.label}</button>)}
          {!preview && activeTab && (
            <label className="dash-tab-add"><Plus size={12} /><span>{t("dashboard.addToTab")}</span>
              <select value="" onChange={(event) => { const type = event.target.value as DashboardWidgetType; if (type) onAddChild(widget.id, activeTab, type); }}>
                <option value="">+</option>
                {LEAF_WIDGET_TYPES.map((type) => <option value={type} key={type}>{t(`dashboard.widget.${type}`)}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="dash-tab-content">{children.length ? <div className="dash-tab-grid">{children.map(renderChild)}</div> : <div className="dash-tab-empty">{t("dashboard.tabEmpty")}</div>}</div>
      </div>
    );
  };

  const topLevel = widgets.filter((widget) => !widget.parentId && (!preview || widget.visible));
  return (
    <div className={`dash-canvas ${preview ? "preview" : ""}`} ref={canvasRef} onMouseDown={() => onSelect("")}>
      {topLevel.length === 0 && <div className="dash-canvas-empty">{t("dashboard.canvasEmpty")}</div>}
      {topLevel.map((widget) => {
        const ap = widget.options.appearance ?? {};
        // 预设提供默认值；用户或设计模型明确指定的单卡样式优先。
        const preset = ap.visualPreset && ap.visualPreset !== "none" ? ap.visualPreset : undefined;
        return (
        <article
          key={widget.id}
          data-widget-id={widget.id}
          data-visual-preset={preset ?? "none"}
          className={`dash-widget ${selectedId === widget.id && !preview ? "selected" : ""} ${!widget.visible ? "hidden-widget" : ""} ${drag?.id === widget.id ? "dragging" : ""}`}
          style={{
            gridColumn: `${widget.x + 1} / span ${widget.w}`,
            gridRow: `${widget.y + 1} / span ${widget.h}`,
            background: ap.background || undefined,
            color: ap.textColor || undefined,
            borderColor: ap.borderColor || undefined,
            borderWidth: ap.borderWidth != null ? ap.borderWidth : undefined,
            borderStyle: ap.borderWidth != null ? "solid" : undefined,
            borderRadius: ap.radius != null ? ap.radius : undefined,
            boxShadow: ap.shadow ? "0 10px 30px rgba(0,0,0,.30)" : ap.shadow === false ? "none" : undefined,
            ...cardReadability(ap),
        ...dragStyle(widget),
          }}
          onMouseDown={(event) => { event.stopPropagation(); onSelect(widget.id); }}
        >
          <header className={`dash-widget-header ${ap.titleAlign === "center" ? "title-center" : ""}`} onPointerDown={(event) => begin(event, widget, "move")} hidden={ap.hideTitle && preview}>
            {!preview && <GripHorizontal size={13} />}
            <strong style={{ color: readableColor(ap.titleColor, appearanceBackground(ap)) || undefined, fontSize: ap.titleSize || undefined, textAlign: ap.titleAlign || undefined, flex: ap.titleAlign ? 1 : undefined }}>{widget.title}</strong>
            {widgetReasons?.[widget.id] && (
              <span className="dash-why" title={`AI 为什么建这个图:\n${widgetReasons[widget.id]}`}><Sparkles size={11} /></span>
            )}
            <span className="toolbar-spacer" />{actions(widget)}
          </header>
          {widget.subtitle && <div className="dash-widget-sub">{widget.subtitle}</div>}
          {widget.type !== "container" && <ComponentFilterBar widget={widget} dataset={datasetOf(widget, datasets)} scope={scope} value={componentFilterValues[widget.id]} onChange={(value) => onComponentFiltersChange(widget.id, value)} />}
          <div className="dash-widget-body" style={{ padding: ap.padding != null ? ap.padding : undefined }}>{widget.type === "container" ? renderContainer(widget) : <WidgetRenderer staticRender={staticRender} widget={widget} runtime={runtime[widget.id] ?? runtime[widget.datasetId]} metrics={metrics} dimensionLabels={datasetOf(widget, datasets)?.dimensionLabels} onDrill={onDrill} drillPath={drillPaths[widget.id]} onDrillDown={(value) => onDrillDown(widget.id, value)} onDrillTo={(level) => onDrillTo(widget.id, level)} />}</div>
          {widget.footnote && <div className="dash-widget-foot">{widget.footnote}</div>}
          {!preview && <button className="dash-resize" aria-label={t("dashboard.resizeWidget")} onPointerDown={(event) => begin(event, widget, "resize")}><Maximize2 size={11} /></button>}
        </article>
        );
      })}
    </div>
  );
}
