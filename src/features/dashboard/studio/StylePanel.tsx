/**
 * 组件的「样式」页:功能一样不少,按看的顺序分组,每组能折叠(折叠状态记住)。
 *
 *   卡片  标题 / 副标题 / 脚注    数字  小数 / 万亿 / 前后缀 / 千分位
 *   图形  按图表类型给各自的      坐标轴  范围 / 标题 / 网格 / 参考线
 *   表格  合并 / 合计 / 小计 / 密度 / 表头      外观  预设 / 颜色 / 圆角 / 阴影
 */
import { ImagePlus, Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { nanoid } from "nanoid";
import type { Dataset } from "../../datasets/domain";
import { readVar } from "../../../lib/themeColors";
import { useApp } from "../../../store/appStore";
import { pieRadii } from "../pieGeometry";
import {
  defaultDashboardPalette,
  isStaticWidget,
  type DashboardAppearanceOptions, type DashboardChartOptions, type DashboardContainerOptions, type DashboardFunnelOptions,
  type DashboardGaugeOptions, type DashboardKpiOptions, type DashboardTableOptions, type DashboardTextOptions, type DashboardWidget,
} from "../domain";
import { dimsOf, fieldLabel } from "./smart";
import { Color, CommitInput, Num, Row, Section, Seg, Sel, Toggle } from "../../../components/StudioKit";

const PRESETS: Array<{ id: string; label: string }> = [
  { id: "editorial", label: "简洁" }, { id: "slate", label: "石板" }, { id: "ocean", label: "海" }, { id: "jade", label: "玉" },
  { id: "mint", label: "薄荷" }, { id: "indigo", label: "靛" }, { id: "violet", label: "紫" }, { id: "plum", label: "梅" },
  { id: "rose", label: "玫瑰" }, { id: "coral", label: "珊瑚" }, { id: "sunset", label: "落日" }, { id: "ember", label: "余烬" },
  { id: "amber", label: "琥珀" }, { id: "gold", label: "金" }, { id: "aurora", label: "极光" }, { id: "glass", label: "玻璃" }, { id: "cyber", label: "赛博" },
];

export default function StylePanel({ widget, dataset, onChange }: {
  widget: DashboardWidget;
  dataset?: Dataset;
  onChange: (w: DashboardWidget) => void;
}) {
  const theme = useApp((s) => s.theme);
  void theme; // 换主题时默认色板要跟着重读
  const tone = (name: string) => readVar(name);
  const o = widget.options;
  const set = (change: Partial<DashboardWidget["options"]>) => onChange({ ...widget, options: { ...o, ...change } });
  const co = o.chart ?? {};
  const chart = (c: Partial<DashboardChartOptions>) => set({ chart: { ...co, ...c } });
  const to = o.table ?? {};
  const table = (c: Partial<DashboardTableOptions>) => set({ table: { ...to, ...c } });
  const ko = o.kpi ?? {};
  const kpi = (c: Partial<DashboardKpiOptions>) => set({ kpi: { ...ko, ...c } });
  const tx = o.text ?? {};
  const text = (c: Partial<DashboardTextOptions>) => set({ text: { ...tx, ...c } });
  const cont = o.container ?? {};
  const container = (c: Partial<DashboardContainerOptions>) => set({ container: { ...cont, ...c } });
  const ap = o.appearance ?? {};
  const look = (c: Partial<DashboardAppearanceOptions>) => set({ appearance: { ...ap, ...c } });
  const nf = o.numberFormat ?? {};
  const axis = co.axis ?? {};
  const setAxis = (c: Partial<typeof axis>) => chart({ axis: { ...axis, ...c } });
  const defaults = defaultDashboardPalette();
  const palette = co.palette ?? defaults;
  const t = widget.type;
  const go = o.gauge ?? {};
  const gauge = (c: Partial<DashboardGaugeOptions>) => set({ gauge: { ...go, ...c } });
  const fo = o.funnel ?? {};
  const funnel = (c: Partial<DashboardFunnelOptions>) => set({ funnel: { ...fo, ...c } });
  const isData = !isStaticWidget(t);
  const isChart = t === "line" || t === "bar" || t === "pie" || t === "funnel";
  const sc = o.scatter ?? {}, ra = o.radar ?? {}, hm = o.heatmap ?? {}, wf = o.waterfall ?? {}, rk = o.ranking ?? {};
  const grouping = t === "table" ? to.grouping ?? false : co.grouping ?? false;

  return (
    <div className="st-style">
      <Section id="card" title="卡片">
        <Row label="副标题"><CommitInput value={widget.subtitle ?? ""} placeholder="一句话说清口径" onCommit={(v) => onChange({ ...widget, subtitle: v || undefined })} /></Row>
        <Row label="脚注"><CommitInput value={widget.footnote ?? ""} placeholder="如:数据截至昨日" onCommit={(v) => onChange({ ...widget, footnote: v || undefined })} /></Row>
        <Row label="标题">
          <Seg size="sm" value={ap.titleAlign ?? "left"} onChange={(v) => look({ titleAlign: v })}
            options={[{ value: "left", label: "左" }, { value: "center", label: "中" }, { value: "right", label: "右" }]} />
          <Num value={ap.titleSize} placeholder="14" min={10} max={48} onChange={(v) => look({ titleSize: v })} suffix="号" />
        </Row>
        <Toggle checked={!!ap.hideTitle} onChange={(v) => look({ hideTitle: v })} label="查看时隐藏标题栏" />
        <Toggle checked={widget.visible} onChange={(v) => onChange({ ...widget, visible: v })} label="在查看模式里显示" />
      </Section>

      {t === "text" && (
        <Section id="text" title="文字">
          <textarea className="st-textarea" value={o.content ?? ""} placeholder="写点什么:结论、说明、标题…" onChange={(e) => set({ content: e.target.value })} />
          <Row label="快捷">
            <div className="st-inline">
              <button type="button" className="btn sm" onClick={() => text({ fontSize: 24, fontWeight: 700 })}>标题</button>
              <button type="button" className="btn sm" onClick={() => text({ fontSize: 15, fontWeight: 400, lineHeight: 160 })}>正文</button>
              <button type="button" className="btn sm" onClick={() => text({ fontSize: 18, fontWeight: 600 })}>结论</button>
            </div>
          </Row>
          <Row label="字体"><Seg size="sm" value={tx.fontFamily ?? "sans"} onChange={(v) => text({ fontFamily: v })} options={[{ value: "sans", label: "黑体" }, { value: "serif", label: "宋体" }, { value: "mono", label: "等宽" }]} /></Row>
          <Row label="字号 / 字重">
            <Num value={tx.fontSize ?? 20} min={10} max={64} onChange={(v) => text({ fontSize: v })} />
            <Sel value={tx.fontWeight ?? 500} onChange={(v) => text({ fontWeight: v })} options={[{ value: 400, label: "常规" }, { value: 500, label: "中等" }, { value: 600, label: "半粗" }, { value: 700, label: "粗" }]} />
          </Row>
          <Row label="对齐">
            <Seg size="sm" value={tx.align ?? "left"} onChange={(v) => text({ align: v })} options={[{ value: "left", label: "左" }, { value: "center", label: "中" }, { value: "right", label: "右" }]} />
            <Seg size="sm" value={tx.verticalAlign ?? "center"} onChange={(v) => text({ verticalAlign: v })} options={[{ value: "top", label: "上" }, { value: "center", label: "中" }, { value: "bottom", label: "下" }]} />
          </Row>
          <Row label="行高 / 颜色">
            <Num value={tx.lineHeight ?? 150} min={100} max={300} step={10} onChange={(v) => text({ lineHeight: v })} suffix="%" />
            <Color value={tx.color} fallback={tone("--text")} onChange={(v) => text({ color: v })} />
          </Row>
        </Section>
      )}

      {t === "container" && (
        <Section id="container" title="分页">
          <div className="st-tablist-edit">
            {widget.tabs.map((tab, i) => (
              <div key={tab.id} className="st-tab-edit">
                <CommitInput value={tab.label} onCommit={(label) => onChange({ ...widget, tabs: widget.tabs.map((x) => (x.id === tab.id ? { ...x, label } : x)) })} />
                {widget.tabs.length > 1 && <button type="button" className="icon-btn" aria-label={`删除第 ${i + 1} 页`} onClick={() => onChange({ ...widget, tabs: widget.tabs.filter((x) => x.id !== tab.id) })}><X size={12} /></button>}
              </div>
            ))}
            <button type="button" className="st-link" onClick={() => onChange({ ...widget, tabs: [...widget.tabs, { id: `tab-${nanoid(8)}`, label: `第 ${widget.tabs.length + 1} 页` }] })}><Plus size={12} />加一页</button>
          </div>
          <Row label="页签位置"><Seg size="sm" value={cont.tabPosition ?? "top"} onChange={(v) => container({ tabPosition: v })} options={[{ value: "top", label: "顶部" }, { value: "left", label: "左侧" }]} /></Row>
          <Toggle checked={cont.showTabBar !== false} onChange={(v) => container({ showTabBar: v })} label="查看时显示页签" />
        </Section>
      )}

      {isData && (
        <Section id="number" title="数字" aside={nf.scale && nf.scale !== "none" ? { wan: "万", yi: "亿", auto: "自动" }[nf.scale] : undefined}>
          <Row label="单位换算">
            <Seg size="sm" value={nf.scale ?? "none"} onChange={(v) => set({ numberFormat: { ...nf, scale: v } })}
              options={[{ value: "none", label: "原样" }, { value: "wan", label: "万" }, { value: "yi", label: "亿" }, { value: "auto", label: "自动", title: "每个数按自己的量级选" }]} />
          </Row>
          <Row label="小数位"><Seg size="sm" value={o.decimals} onChange={(v) => set({ decimals: v })} options={[0, 1, 2, 3].map((n) => ({ value: n, label: String(n) }))} /></Row>
          <Row label="前缀 / 后缀">
            <CommitInput value={nf.prefix ?? ""} placeholder="¥" onCommit={(v) => set({ numberFormat: { ...nf, prefix: v || undefined } })} />
            <CommitInput value={nf.suffix ?? ""} placeholder="自动" onCommit={(v) => set({ numberFormat: { ...nf, suffix: v || undefined } })} />
          </Row>
          {t !== "kpi" && t !== "gauge" && <Toggle checked={grouping} onChange={(v) => (t === "table" ? table({ grouping: v }) : chart({ grouping: v }))} label="千位分隔符" hint="12,345 而不是 12345" />}
        </Section>
      )}

      {t === "gauge" && (
        <Section id="gauge" title="仪表盘">
          <Row label="形状"><Seg size="sm" value={go.shape ?? "arc"} onChange={(v) => gauge({ shape: v })} options={[{ value: "arc", label: "半圆仪表" }, { value: "ring", label: "圆环进度" }]} /></Row>
          <Row label="目标" hint="画刻度线、算完成率"><Num value={go.target} placeholder="不设" min={0} onChange={(v) => gauge({ target: v })} /></Row>
          <Row label="满刻度" hint="不填:有目标用目标"><Num value={go.max} placeholder="自动" min={0} onChange={(v) => gauge({ max: v })} /></Row>
          <Row label="颜色"><Color value={go.color} fallback={tone("--accent")} onChange={(v) => gauge({ color: v })} /></Row>
          <Toggle checked={!!go.colorByProgress} onChange={(v) => gauge({ colorByProgress: v })} label="按完成率变色" hint="不到六成红、不到十成黄、达标绿" />
          <Row label="完成率小数"><Seg size="sm" value={o.percentDecimals ?? 1} onChange={(v) => set({ percentDecimals: v })} options={[0, 1, 2].map((n) => ({ value: n, label: String(n) }))} /></Row>
        </Section>
      )}

      {t === "image" && <ImageSection widget={widget} onChange={onChange} />}

      {t === "scatter" && (
        <Section id="scatter" title="散点">
          <Toggle checked={!!sc.quadrant} onChange={(v) => set({ scatter: { ...sc, quadrant: v } })} label="平均线分四象限" hint="右上角 = 两项都高于平均" />
          <Toggle checked={!!sc.showNames} onChange={(v) => set({ scatter: { ...sc, showNames: v } })} label="点旁边标名字" hint="点多时会挤,悬停也能看" />
          <Toggle checked={o.showLegend} onChange={(v) => set({ showLegend: v })} label="图例" />
          <PaletteRow palette={palette} custom={!!co.palette} onChange={(p) => chart({ palette: p })} />
        </Section>
      )}

      {t === "radar" && (
        <Section id="radar" title="雷达">
          <Row label="形状"><Seg size="sm" value={ra.shape ?? "polygon"} onChange={(v) => set({ radar: { ...ra, shape: v } })} options={[{ value: "polygon", label: "多边形" }, { value: "circle", label: "圆形" }]} /></Row>
          <Toggle checked={ra.fill !== false} onChange={(v) => set({ radar: { ...ra, fill: v } })} label="填色" />
          <Toggle checked={o.showLegend} onChange={(v) => set({ showLegend: v })} label="图例" />
          <PaletteRow palette={palette} custom={!!co.palette} onChange={(p) => chart({ palette: p })} />
        </Section>
      )}

      {t === "heatmap" && (
        <Section id="heatmap" title="热力">
          <Toggle checked={!!hm.showValues} onChange={(v) => set({ heatmap: { ...hm, showValues: v } })} label="格子里写数值" />
          <Row label="主色"><Color value={hm.color} fallback={palette[0]} onChange={(v) => set({ heatmap: { ...hm, color: v } })} /></Row>
        </Section>
      )}

      {t === "treemap" && (
        <Section id="treemap" title="矩形树">
          <Row label="占比小数"><Seg size="sm" value={o.percentDecimals ?? 1} onChange={(v) => set({ percentDecimals: v })} options={[0, 1, 2].map((n) => ({ value: n, label: String(n) }))} /></Row>
          <PaletteRow palette={palette} custom={!!co.palette} onChange={(p) => chart({ palette: p })} />
        </Section>
      )}

      {t === "waterfall" && (
        <Section id="waterfall" title="瀑布">
          <Toggle checked={wf.total !== false} onChange={(v) => set({ waterfall: { ...wf, total: v } })} label="最后加一根合计" />
          {wf.total !== false && <Row label="合计叫"><CommitInput value={wf.totalLabel ?? ""} placeholder="合计" onCommit={(v) => set({ waterfall: { ...wf, totalLabel: v || undefined } })} /></Row>}
          <Toggle checked={wf.showValues !== false} onChange={(v) => set({ waterfall: { ...wf, showValues: v } })} label="柱子上写增减" />
          <Row label="增 / 减 / 合计">
            <Color value={wf.upColor} fallback={palette[0]} onChange={(v) => set({ waterfall: { ...wf, upColor: v } })} />
            <Color value={wf.downColor} fallback={tone("--red")} onChange={(v) => set({ waterfall: { ...wf, downColor: v } })} />
            <Color value={wf.totalColor} fallback={tone("--text-3")} onChange={(v) => set({ waterfall: { ...wf, totalColor: v } })} />
          </Row>
        </Section>
      )}

      {t === "ranking" && (
        <Section id="ranking" title="排行榜">
          <Row label="顺序"><Seg size="sm" value={rk.order ?? "desc"} onChange={(v) => set({ ranking: { ...rk, order: v } })} options={[{ value: "desc", label: "从高到低" }, { value: "asc", label: "从低到高", title: "看倒数几名" }]} /></Row>
          <Row label="进度条"><Color value={rk.barColor} fallback={tone("--accent")} onChange={(v) => set({ ranking: { ...rk, barColor: v } })} /></Row>
          <small className="st-hint">显示几名在「数据」页的「显示多少」里设,默认前 10。</small>
        </Section>
      )}

      {t === "kpi" && (
        <Section id="kpi" title="指标卡">
          <Row label="数值">
            <Num value={ko.valueSize ?? 34} min={16} max={72} onChange={(v) => kpi({ valueSize: v })} suffix="号" />
            <Color value={ko.valueColor} fallback={tone("--text")} onChange={(v) => kpi({ valueColor: v })} />
          </Row>
          <Row label="名称">
            <Seg size="sm" value={ko.labelPosition ?? "below"} onChange={(v) => kpi({ labelPosition: v })} options={[{ value: "above", label: "在上" }, { value: "below", label: "在下" }]} />
            <Num value={ko.labelSize ?? 12} min={9} max={20} onChange={(v) => kpi({ labelSize: v })} suffix="号" />
          </Row>
          <Row label="对齐"><Seg size="sm" value={ko.contentAlign ?? "left"} onChange={(v) => kpi({ contentAlign: v })} options={[{ value: "left", label: "左" }, { value: "center", label: "中" }, { value: "right", label: "右" }]} /></Row>
          <Toggle checked={!!ko.showSecondary} onChange={(v) => kpi({ showSecondary: v })} label="第二个数值小字显示" />
          {ko.showComparison && (
            <Row label="涨跌">
              <Seg size="sm" value={ko.comparisonLayout ?? "inline"} onChange={(v) => kpi({ comparisonLayout: v })} options={[{ value: "inline", label: "并排" }, { value: "column", label: "上下" }]} />
              <Num value={ko.comparisonFontSize ?? 11} min={9} max={32} onChange={(v) => kpi({ comparisonFontSize: v })} suffix="号" />
            </Row>
          )}
        </Section>
      )}

      {isChart && (
        <Section id="chart" title="图形">
          {t === "line" && <>
            <Toggle checked={o.smooth} onChange={(v) => set({ smooth: v })} label="平滑曲线" />
            <Toggle checked={co.lineArea !== false} onChange={(v) => chart({ lineArea: v })} label="面积填充" />
            <Toggle checked={co.linePoints !== false} onChange={(v) => chart({ linePoints: v })} label="显示数据点" />
            <Row label="线宽"><Seg size="sm" value={co.lineWidth ?? 2.4} onChange={(v) => chart({ lineWidth: v })} options={[1.5, 2.4, 3.5].map((n) => ({ value: n, label: n === 1.5 ? "细" : n === 2.4 ? "中" : "粗" }))} /></Row>
          </>}
          {t === "bar" && <>
            <Row label="方向"><Seg size="sm" value={co.barOrientation ?? "vertical"} onChange={(v) => chart({ barOrientation: v })} options={[{ value: "vertical", label: "竖着" }, { value: "horizontal", label: "横着" }]} /></Row>
            <Toggle checked={!!co.barShowValues} onChange={(v) => chart({ barShowValues: v })} label="柱子上显示数值" />
            <Row label="颜色">
              <Color value={co.barColor} fallback={palette[0]} onChange={(v) => chart({ barColor: v })} />
              <Color value={co.barEndColor} fallback={palette[1]} onChange={(v) => chart({ barEndColor: v })} />
              <small className="st-hint">主色 → 渐变</small>
            </Row>
          </>}
          {(t === "line" || t === "bar") && <>
            <Toggle checked={!!co.stack} onChange={(v) => chart({ stack: v })} label="堆叠" hint="多个系列叠在一起看总量" />
            <Toggle checked={!!co.dataZoom} onChange={(v) => chart({ dataZoom: v })} label="底部缩放条" hint="数据点多时拖着看" />
          </>}
          {t === "pie" && <>
            <Row label={`内径 ${pieRadii(co.pieHole, co.pieOuterRadius)[0]}%`}>
              <input type="range" aria-label="环形内半径" min={0} max={(co.pieOuterRadius ?? 75) - 1} value={pieRadii(co.pieHole, co.pieOuterRadius)[0]} onChange={(e) => chart({ pieHole: Number(e.target.value) })} />
            </Row>
            <Row label={`外径 ${co.pieOuterRadius ?? 75}%`}>
              <input type="range" aria-label="环形外半径" min={20} max={95} value={co.pieOuterRadius ?? 75}
                onChange={(e) => { const outer = Number(e.target.value); chart({ pieOuterRadius: outer, pieHole: pieRadii(co.pieHole, outer)[0] }); }} />
            </Row>
            <Toggle checked={!!co.pieShowLabels} onChange={(v) => chart({ pieShowLabels: v })} label="扇区上显示标签" />
            <Toggle checked={!!co.pieIncludeOthers} onChange={(v) => chart({ pieIncludeOthers: v })} label="前几名之外合并成「其他」" hint="占比的分母保持完整" />
            <Row label="图例位置"><Seg size="sm" value={co.pieLegendPosition ?? "bottom"} onChange={(v) => chart({ pieLegendPosition: v })} options={[{ value: "bottom", label: "下" }, { value: "left", label: "左" }, { value: "right", label: "右" }]} /></Row>
            <Row label="占比小数"><Seg size="sm" value={o.percentDecimals ?? 1} onChange={(v) => set({ percentDecimals: v })} options={[0, 1, 2].map((n) => ({ value: n, label: String(n) }))} /></Row>
          </>}
          {t === "funnel" && <>
            <Row label="排序"><Seg size="sm" value={fo.order ?? "value"} onChange={(v) => funnel({ order: v })} options={[{ value: "value", label: "按数值", title: "从大到小" }, { value: "category", label: "按环节顺序", title: "跟横轴排序一致,适合转化步骤" }]} /></Row>
            <Row label="对齐"><Seg size="sm" value={fo.align ?? "center"} onChange={(v) => funnel({ align: v })} options={[{ value: "center", label: "居中" }, { value: "left", label: "靠左" }]} /></Row>
            <Toggle checked={fo.showRate !== false} onChange={(v) => funnel({ showRate: v })} label="标出占第一层的比例" />
            <Row label="比例小数"><Seg size="sm" value={o.percentDecimals ?? 1} onChange={(v) => set({ percentDecimals: v })} options={[0, 1, 2].map((n) => ({ value: n, label: String(n) }))} /></Row>
          </>}
          {t !== "funnel" && <>
            <Toggle checked={o.showLegend} onChange={(v) => set({ showLegend: v })} label="图例" />
            <Toggle checked={!!co.showLabels} onChange={(v) => chart({ showLabels: v })} label="数据标签" />
          </>}
          <PaletteRow palette={palette} custom={!!co.palette} onChange={(p) => chart({ palette: p })} />
        </Section>
      )}

      {(t === "line" || t === "bar") && (
        <Section id="axis" title="坐标轴与参考线" defaultOpen={false}>
          <Row label="纵轴范围">
            <Num value={axis.yMin} placeholder="自动" onChange={(v) => setAxis({ yMin: v })} />
            <span className="st-dash">~</span>
            <Num value={axis.yMax} placeholder="自动" onChange={(v) => setAxis({ yMax: v })} />
          </Row>
          <Row label="轴标题">
            <CommitInput value={axis.yTitle ?? ""} placeholder="纵轴" onCommit={(v) => setAxis({ yTitle: v || undefined })} />
            <CommitInput value={axis.xTitle ?? ""} placeholder="横轴" onCommit={(v) => setAxis({ xTitle: v || undefined })} />
          </Row>
          <Toggle checked={axis.splitLine === true} onChange={(v) => setAxis({ splitLine: v })} label="横向网格线" />
          <Row label="悬停提示"><Seg size="sm" value={co.tooltip?.mode ?? "axis"} onChange={(v) => chart({ tooltip: { mode: v } })} options={[{ value: "axis", label: "整列" }, { value: "item", label: "单个" }]} /></Row>
          <div className="st-marklines">
            {(co.markLine ?? []).map((line, i) => (
              <div className="st-markline" key={i}>
                <Num value={line.value} onChange={(v) => chart({ markLine: (co.markLine ?? []).map((l, j) => (j === i ? { ...l, value: v ?? 0 } : l)) })} />
                <CommitInput value={line.label ?? ""} placeholder="如:目标" onCommit={(label) => chart({ markLine: (co.markLine ?? []).map((l, j) => (j === i ? { ...l, label } : l)) })} />
                <button type="button" className="icon-btn" aria-label="删除参考线" onClick={() => chart({ markLine: (co.markLine ?? []).filter((_, j) => j !== i) })}><X size={12} /></button>
              </div>
            ))}
            <button type="button" className="st-link" onClick={() => chart({ markLine: [...(co.markLine ?? []), { value: 0, label: "" }] })}><Plus size={12} />加一条参考线</button>
          </div>
        </Section>
      )}

      {t === "table" && (
        <Section id="table" title="表格">
          <Toggle checked={to.columnTotal ?? false} onChange={(v) => table({ columnTotal: v })} label="底部合计行" />
          <Toggle checked={to.rowTotal ?? false} onChange={(v) => table({ rowTotal: v })} label="右侧合计列" hint="交叉表用" />
          <Row label="小计">
            <Sel value={to.subtotalDimension ?? ""} onChange={(v) => table({ subtotalDimension: v || undefined })}
              options={[{ value: "", label: "不小计" }, ...dimsOf(widget).map((d) => ({ value: d, label: `按 ${fieldLabel(dataset, d)}` }))]} />
          </Row>
          <Toggle checked={to.mergeDimensions ?? false} onChange={(v) => table({ mergeDimensions: v })} label="合并相同的维度格" />
          <Toggle checked={to.freezeDimensions !== false} onChange={(v) => table({ freezeDimensions: v })} label="冻结维度列" />
          <Toggle checked={to.stripe !== false} onChange={(v) => table({ stripe: v })} label="斑马纹" />
          <Row label="密度"><Seg size="sm" value={to.density ?? "normal"} onChange={(v) => table({ density: v })} options={[{ value: "compact", label: "紧凑" }, { value: "normal", label: "标准" }, { value: "relaxed", label: "宽松" }]} /></Row>
          <Row label="每页"><Seg size="sm" value={to.pageSize ?? 20} onChange={(v) => table({ pageSize: v })} options={[10, 20, 50, 100].map((n) => ({ value: n, label: String(n) }))} /></Row>
          <Row label="表头">
            <Seg size="sm" value={to.headerAlign ?? "left"} onChange={(v) => table({ headerAlign: v })} options={[{ value: "left", label: "左" }, { value: "center", label: "中" }, { value: "right", label: "右" }]} />
            <Num value={to.headerFontSize ?? 12} min={9} max={20} onChange={(v) => table({ headerFontSize: v })} suffix="号" />
          </Row>
          <Row label="行高">
            <Num value={to.headerHeight ?? 38} min={24} max={80} onChange={(v) => table({ headerHeight: v })} suffix="表头" />
            <Num value={to.rowHeight ?? 34} min={24} max={80} onChange={(v) => table({ rowHeight: v })} suffix="数据" />
          </Row>
        </Section>
      )}

      <Section id="look" title="外观" defaultOpen={false} aside={ap.visualPreset && ap.visualPreset !== "none" ? PRESETS.find((p) => p.id === ap.visualPreset)?.label : undefined}>
        <div className="st-presets">
          <button type="button" className={`st-preset none ${!ap.visualPreset || ap.visualPreset === "none" ? "on" : ""}`} onClick={() => look({ visualPreset: undefined })}>默认</button>
          {PRESETS.map((p) => (
            <button type="button" key={p.id} data-visual-preset={p.id} className={`st-preset ${ap.visualPreset === p.id ? "on" : ""}`} title={p.label} onClick={() => look({ visualPreset: p.id })}><span>{p.label}</span></button>
          ))}
        </div>
        <Row label="背景 / 文字">
          <Color value={ap.background} fallback={tone("--surface")} onChange={(v) => look({ background: v })} />
          <Color value={ap.textColor} fallback={tone("--text")} onChange={(v) => look({ textColor: v })} />
        </Row>
        <Row label="标题 / 边框">
          <Color value={ap.titleColor} fallback={tone("--text")} onChange={(v) => look({ titleColor: v })} />
          <Color value={ap.borderColor} fallback={tone("--border")} onChange={(v) => look({ borderColor: v })} />
        </Row>
        <Row label="圆角 / 边框"><Num value={ap.radius} placeholder="12" min={0} max={40} onChange={(v) => look({ radius: v })} /><Num value={ap.borderWidth} placeholder="1" min={0} max={6} onChange={(v) => look({ borderWidth: v })} /></Row>
        <Row label="内边距"><Num value={ap.padding} placeholder="12" min={0} max={40} onChange={(v) => look({ padding: v })} /></Row>
        <Toggle checked={!!ap.shadow} onChange={(v) => look({ shadow: v })} label="投影" />
        <button type="button" className="st-link" onClick={() => set({ appearance: {} })}>恢复默认外观</button>
      </Section>

      <Section id="layout" title="位置与大小" defaultOpen={false} aside={`${widget.w}×${widget.h}`}>
        <Row label="宽 / 高">
          <Seg size="sm" value={widget.w} onChange={(v) => onChange({ ...widget, w: v, x: Math.min(widget.x, 12 - v) })}
            options={[3, 4, 6, 8, 12].map((n) => ({ value: n, label: n === 12 ? "整行" : n === 6 ? "半行" : `${n}/12` }))} />
        </Row>
        <Row label="精确">
          <Num value={widget.x} min={0} max={11} onChange={(v) => onChange({ ...widget, x: v ?? 0 })} suffix="X" />
          <Num value={widget.y} min={0} onChange={(v) => onChange({ ...widget, y: v ?? 0 })} suffix="Y" />
          <Num value={widget.w} min={2} max={12} onChange={(v) => onChange({ ...widget, w: v ?? widget.w })} suffix="宽" />
          <Num value={widget.h} min={2} max={10} onChange={(v) => onChange({ ...widget, h: v ?? widget.h })} suffix="高" />
        </Row>
      </Section>
    </div>
  );
}

/* ── 图片 ─────────────────────────────────────────────────────────── */

/** 长边压到这么多像素再存:看板存在本地存储里,一张原图几 MB 会把整个看板拖慢。 */
const IMAGE_EDGE = 1600;

/** 抽样看有没有半透明像素(隔几个取一个,大图也只看几万个点)。 */
function hasAlpha(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data;
  const step = Math.max(1, Math.floor((w * h) / 40000)) * 4;
  for (let i = 3; i < data.length; i += step) if (data[i] < 250) return true;
  return false;
}

/** 读成 data URL,大图按比例缩小;SVG / GIF 原样,带透明的留 PNG,其余转 JPEG。 */
function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读不了这个文件"));
    reader.onload = () => {
      const url = String(reader.result);
      if (file.type === "image/svg+xml" || file.type === "image/gif") return resolve(url);
      const img = new window.Image();
      img.onerror = () => reject(new Error("这个文件不是能显示的图片"));
      img.onload = () => {
        const k = Math.min(1, IMAGE_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
        if (k === 1 && file.size < 600_000) return resolve(url);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.naturalWidth * k);
        canvas.height = Math.round(img.naturalHeight * k);
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        /* 只有真用到透明(Logo 抠图)才留 PNG;不透明的照片、截图存 PNG 动辄一两 MB,转 JPEG 小十倍。 */
        resolve(hasAlpha(ctx, canvas.width, canvas.height) ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.86));
      };
      img.src = url;
    };
    reader.readAsDataURL(file);
  });
}

function ImageSection({ widget, onChange }: { widget: DashboardWidget; onChange: (w: DashboardWidget) => void }) {
  const io = widget.options.image ?? {};
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const setImage = (c: Partial<NonNullable<DashboardWidget["options"]["image"]>>) =>
    onChange({ ...widget, options: { ...widget.options, image: { ...io, ...c } } });
  const pick = async (file?: File) => {
    if (!file) return;
    setError("");
    try {
      setImage({ src: await readImage(file), name: file.name });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Section id="image" title="图片">
      <div className="st-image-pick"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); void pick(e.dataTransfer.files[0]); }}>
        {io.src ? <img src={io.src} alt="" /> : <ImagePlus size={20} />}
        <div>
          <button type="button" className="btn sm" onClick={() => input.current?.click()}>{io.src ? "换一张" : "选择图片"}</button>
          {io.src && <button type="button" className="st-link" onClick={() => setImage({ src: undefined, name: undefined })}>移除</button>}
          <small>{io.name ?? "也可以把图片拖到这里"}</small>
        </div>
        <input ref={input} type="file" accept="image/*" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      {error && <small className="st-hint st-error">{error}</small>}
      <Row label="填充"><Seg size="sm" value={io.fit ?? "contain"} onChange={(v) => setImage({ fit: v })} options={[{ value: "contain", label: "完整显示" }, { value: "cover", label: "铺满裁切" }]} /></Row>
    </Section>
  );
}

/** 配色:一排色块,点开改,× 删,+ 加;改过才出现「默认」。 */
function PaletteRow({ palette, custom, onChange }: { palette: string[]; custom: boolean; onChange: (p: string[] | undefined) => void }) {
  return (
    <div className="st-palette">
      <span>配色</span>
      {palette.map((c, i) => (
        <span className="st-swatch" key={i} style={{ background: c }}>
          <input type="color" value={c} aria-label={`第 ${i + 1} 种颜色`} onChange={(e) => { const p = [...palette]; p[i] = e.target.value; onChange(p); }} />
          {palette.length > 1 && <button type="button" aria-label="删除颜色" onClick={() => onChange(palette.filter((_, j) => j !== i))}>×</button>}
        </span>
      ))}
      <button type="button" className="st-swatch-add" aria-label="加一种颜色" onClick={() => { const defaults = defaultDashboardPalette(); onChange([...palette, defaults[palette.length % defaults.length]]); }}><Plus size={11} /></button>
      {custom && <button type="button" className="st-link" onClick={() => onChange(undefined)}>默认</button>}
    </div>
  );
}
