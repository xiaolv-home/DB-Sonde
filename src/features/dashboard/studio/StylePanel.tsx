/**
 * 组件的「样式」页:功能一样不少,按看的顺序分组,每组能折叠(折叠状态记住)。
 *
 *   卡片  标题 / 副标题 / 脚注    数字  小数 / 万亿 / 前后缀 / 千分位
 *   图形  按图表类型给各自的      坐标轴  范围 / 标题 / 网格 / 参考线
 *   表格  合并 / 合计 / 小计 / 密度 / 表头      外观  预设 / 颜色 / 圆角 / 阴影
 */
import { Plus, X } from "lucide-react";
import { nanoid } from "nanoid";
import type { Dataset } from "../../datasets/domain";
import { pieRadii } from "../pieGeometry";
import {
  DEFAULT_DASHBOARD_PALETTE,
  type DashboardAppearanceOptions, type DashboardChartOptions, type DashboardContainerOptions, type DashboardKpiOptions,
  type DashboardTableOptions, type DashboardTextOptions, type DashboardWidget,
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
  const palette = co.palette ?? [...DEFAULT_DASHBOARD_PALETTE];
  const t = widget.type;
  const isData = t === "kpi" || t === "line" || t === "bar" || t === "pie" || t === "table";
  const isChart = t === "line" || t === "bar" || t === "pie";
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
            <Color value={tx.color} fallback="#cfd1d6" onChange={(v) => text({ color: v })} />
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
          {t !== "kpi" && <Toggle checked={grouping} onChange={(v) => (t === "table" ? table({ grouping: v }) : chart({ grouping: v }))} label="千位分隔符" hint="12,345 而不是 12345" />}
        </Section>
      )}

      {t === "kpi" && (
        <Section id="kpi" title="指标卡">
          <Row label="数值">
            <Num value={ko.valueSize ?? 34} min={16} max={72} onChange={(v) => kpi({ valueSize: v })} suffix="号" />
            <Color value={ko.valueColor} fallback="#cfd1d6" onChange={(v) => kpi({ valueColor: v })} />
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
          <Toggle checked={o.showLegend} onChange={(v) => set({ showLegend: v })} label="图例" />
          <Toggle checked={!!co.showLabels} onChange={(v) => chart({ showLabels: v })} label="数据标签" />
          <div className="st-palette">
            <span>配色</span>
            {palette.map((c, i) => (
              <span className="st-swatch" key={i} style={{ background: c }}>
                <input type="color" value={c} aria-label={`第 ${i + 1} 种颜色`} onChange={(e) => { const p = [...palette]; p[i] = e.target.value; chart({ palette: p }); }} />
                {palette.length > 1 && <button type="button" aria-label="删除颜色" onClick={() => chart({ palette: palette.filter((_, j) => j !== i) })}>×</button>}
              </span>
            ))}
            <button type="button" className="st-swatch-add" aria-label="加一种颜色" onClick={() => chart({ palette: [...palette, DEFAULT_DASHBOARD_PALETTE[palette.length % DEFAULT_DASHBOARD_PALETTE.length]] })}><Plus size={11} /></button>
            {co.palette && <button type="button" className="st-link" onClick={() => chart({ palette: undefined })}>默认</button>}
          </div>
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
          <Color value={ap.background} fallback="#212226" onChange={(v) => look({ background: v })} />
          <Color value={ap.textColor} fallback="#cfd1d6" onChange={(v) => look({ textColor: v })} />
        </Row>
        <Row label="标题 / 边框">
          <Color value={ap.titleColor} fallback="#cfd1d6" onChange={(v) => look({ titleColor: v })} />
          <Color value={ap.borderColor} fallback="#2e2f35" onChange={(v) => look({ borderColor: v })} />
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
