import type { BakedDashboard } from "./bake";
import runtimeSource from "./standalone.runtime.js?inline-min";
import controlsSource from "./filterControls.runtime.js?inline-min";
/* 导出 Excel 跟看板用同一份实现(那边是 import,这边原样内联)。 */
import xlsxSource from "./xlsx.runtime.js?inline-min";
/* 分类轴的排序规则同样是共用的一份。 */
import labelOrderSource from "../labelOrder.runtime.js?inline-min";
import presetsCss from "../presets.css?inline-min";
/* 筛选控件的样式跟看板共用同一份 —— 导出的页面里那两个控件是原生 JS 重写的,
   共用样式表才能保证长相一致,而不是在这儿再手写一套差不多的。 */
import filterControlsCss from "../filterControls.css?inline-min";
/* 饼图的几何(半径 + 标签排版)跟看板共用同一份实现,原样内联。 */
import pieGeometrySource from "../pieGeometry.runtime.js?inline-min";
import tooltipTextSource from "../tooltipText.runtime.js?inline-min";
/* 散点 / 雷达 / 热力 / 矩形树 / 瀑布 / 排行榜的配置,跟看板共用同一份。 */
import moreChartsSource from "../moreCharts.runtime.js?inline-min";

/** 离线看板页面的样式(主题感知:跟随系统深浅色)。内嵌进导出的 HTML。 */
const STANDALONE_CSS = `
:root {
  --bg: #f4f6fb; --surface: #ffffff; --surface-3: #eef1f7;
  --text: #1c2434; --text-2: #4a5468; --text-3: #8b96a8;
  --border: rgba(120,132,156,.22); --border-2: rgba(120,132,156,.32); --accent: #4d8dff;
  /* 筛选控件跟看板共用样式表,它要用的变量这儿也得有,否则控件是没颜色的骨架。 */
  --surface-2: #ededf0; --accent-ink: #ffffff; --accent-soft: #dcf0fb; --accent-border: #0b8fd6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e131c; --surface: #161d29; --surface-3: #1a2230;
    --text: #e8edf6; --text-2: #aab4c6; --text-3: #7f8ba0;
    --border: rgba(151,170,203,.16); --border-2: rgba(151,170,203,.26); --accent: #4d8dff;
    --surface-2: #212127; --accent-ink: #05131e; --accent-soft: #103048; --accent-border: #33b1f5;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
/* 铺满窗口。原来封顶 1680px 居中,屏幕一宽两边就是两条空白,
   而这页上最想要宽度的就是明细表。 */
#dash-root { padding: 20px 22px 48px; }
.dash-x-topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 4px 2px 18px; flex-wrap: wrap; }
.dash-x-titlewrap h1 { margin: 0; font-size: 21px; font-weight: 650; letter-spacing: .2px; }
.dash-x-titlewrap p { margin: 5px 0 0; color: var(--text-2); font-size: 13px; }
.dash-x-meta { color: var(--text-2); font-size: 12px; text-align: right; line-height: 1.7; }
.dash-x-meta .gen { color: var(--text-3); font-size: 11px; }
.dash-x-grid { display: grid; grid-template-columns: repeat(12, 1fr); grid-auto-rows: 92px; gap: 12px; }
/* Tab 容器。里面的子组件用自己的一套网格 —— 容器本身在外层网格里占一块地方,
   内部再按子组件的 x/y/w/h 摆。 */
.dash-x-tabs { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.dash-x-tabs.left { flex-direction: row; }
.dash-x-tabbar { display: flex; flex-wrap: wrap; gap: 4px; }
.dash-x-tabs.left .dash-x-tabbar { flex-direction: column; flex: 0 0 auto; }
.dash-x-tabbar button { padding: 4px 11px; border: 1px solid var(--border); border-radius: 7px; background: transparent; color: var(--muted); font: inherit; font-size: 13px; cursor: pointer; }
.dash-x-tabbar button:hover { color: var(--text); }
.dash-x-tabbar button.on { border-color: var(--accent); background: var(--accent-soft, rgba(90,130,255,.14)); color: var(--accent); }
.dash-x-tabpane { flex: 1; min-height: 0; min-width: 0; }
.dash-x-tabpane .dash-x-grid { grid-auto-rows: 86px; }
.dash-component-filters { margin: 0 0 8px; padding: 0 0 8px; background: transparent; }
/* 列分组分界线:一组列紧挨着下一组,不画线看不出哪儿到头(跟看板上一致) */
.dash-x-table .group-start { border-left: 2px solid var(--text-3); }
/* 点表头排序 */
.dash-x-table th.sortable { cursor: pointer; user-select: none; }
.dash-x-table th.sortable:hover { color: var(--text); }
.dash-x-table th .sortmark { font-style: normal; opacity: .75; }
.dash-x-tabletools { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 0 0 7px; color: var(--text-3); font-size: 11.5px; }
.dash-x-tabletools button { height: 25px; padding: 0 10px; border: 1px solid var(--border-2); border-radius: 6px; background: var(--surface-2); color: var(--text-2); cursor: pointer; font: inherit; font-size: 11.5px; }
.dash-x-tabletools button:hover:not(:disabled) { border-color: var(--accent-border); color: var(--text); }
.dash-x-tabletools button:disabled { opacity: .5; cursor: default; }
.dash-x-pager { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding-top: 6px; color: var(--muted); font-size: 12px; }
.dash-x-pager button { width: 22px; height: 22px; border: 1px solid var(--border); border-radius: 6px; background: transparent; color: inherit; cursor: pointer; }
.dash-x-pager button:disabled { opacity: .35; cursor: default; }
.dash-x-card { display: flex; flex-direction: column; min-height: 0; min-width: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; overflow: hidden; }
.dash-x-head { display: flex; align-items: center; margin-bottom: 8px; flex: 0 0 auto; }
.dash-x-title { font-size: 13px; font-weight: 600; color: var(--text); }
.dash-x-body { position: relative; flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
.dash-x-chart { flex: 1 1 auto; width: 100%; min-height: 0; }
.dash-x-state { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--text-3); font-size: 12px; text-align: center; padding: 8px; }
.dash-x-note { color: var(--text-3); font-size: 11px; padding: 4px 2px 0; }

/* KPI */
.dash-x-body .dash-kpi-grid { display: grid; gap: 10px; flex: 1 1 auto; align-content: center; }
.dash-kpi-grid.count-1 { grid-template-columns: 1fr; }
.dash-kpi-grid.count-2 { grid-template-columns: repeat(2, 1fr); }
.dash-kpi-grid.count-3 { grid-template-columns: repeat(3, 1fr); }
.dash-kpi-grid.count-4, .dash-kpi-grid.count-5, .dash-kpi-grid.count-6 { grid-template-columns: repeat(3, 1fr); }
.dash-kpi { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dash-kpi strong { font-size: clamp(18px, 2.4vw, 34px); font-weight: 680; line-height: 1.1; letter-spacing: .3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dash-kpi-label { color: var(--text-2); font-size: 12px; }
.dash-kpi-compare { display: flex; gap: 8px; margin-top: 2px; }
.dash-kpi-compare.layout-column { flex-direction: column; gap: 1px; }
.dash-kpi-compare small { color: #ff6b8a; }
.dash-kpi-compare small.up { color: #2ed6a1; }
.dash-kpi-secondary { display: flex; flex-wrap: wrap; gap: 10px; color: var(--text-2); margin-top: 3px; }
.dash-kpi-secondary b { color: var(--text); }

/* 切换器 + 面包屑 */
.dash-x-switch { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; flex: 0 0 auto; }
.dash-x-switch span { color: var(--text-3); font-size: 12px; }
.dash-x-switch select, .dash-x-crumbs button { font: inherit; }
.dash-x-switch select { background: var(--surface-3); color: var(--text); border: 1px solid var(--border); border-radius: 7px; padding: 3px 8px; font-size: 12px; }
.dash-x-crumbs { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-bottom: 6px; flex: 0 0 auto; font-size: 12px; }
.dash-x-crumbs button { background: none; border: none; color: var(--accent); cursor: pointer; padding: 1px 3px; font-size: 12px; }
.dash-x-crumbs .sep { color: var(--text-3); }

/* 表格 */
.dash-x-tablewrap { flex: 1 1 auto; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.dash-x-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dash-x-table th, .dash-x-table td { padding: 6px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; text-align: left; }
.dash-x-table th { position: sticky; top: 0; height: 30px; box-sizing: border-box; background: var(--surface-3); color: var(--text-2); font-weight: 600; z-index: 1; }
/* 透视两级表头:上层是列维度取值(跨列居中),下层是该组下的各指标。 */
.dash-x-table th.grouphead { text-align: center; }
.dash-x-table th.subhead { top: 30px; }
.dash-x-table td.num { font-variant-numeric: tabular-nums; }
.dash-x-table tbody tr:hover { background: rgba(128,140,170,.08); }

/* 副标题 / 脚注 */
.dash-x-sub { flex: 0 0 auto; font-size: 11.5px; color: var(--text-3); line-height: 1.4; padding: 0 2px 6px; }
.dash-x-foot { flex: 0 0 auto; font-size: 11px; color: var(--text-3); line-height: 1.4; padding: 6px 2px 0; border-top: 1px solid var(--border); margin-top: 6px; }

/* 文本 */
.dash-x-text { display: flex; flex-direction: column; height: 100%; color: var(--text); }

/* 手机/窄屏:单列顺排。注意 grid-row 也必须覆盖 —— 卡片的行位置是内联写死的
   (grid-row: y+1 / span h),只盖 grid-column 会让卡片仍被钉在原行段,
   中间留下大片空洞、顺序也乱。 */
@media (max-width: 720px) {
  #dash-root { padding: 12px 12px 32px; }
  .dash-x-topbar { padding-bottom: 12px; }
  .dash-x-meta { text-align: left; }
  .dash-x-grid { grid-template-columns: 1fr; grid-auto-rows: auto; gap: 10px; }
  .dash-x-card {
    grid-column: 1 / -1 !important;
    grid-row: auto !important;
    min-height: 300px;
  }
  /* 文本组件不需要撑那么高 */
  .dash-x-card:has(.dash-x-text) { min-height: 0; }
  .dash-x-table th, .dash-x-table td { padding: 6px 8px; }
  .dash-kpi-grid.count-3, .dash-kpi-grid.count-4,
  .dash-kpi-grid.count-5, .dash-kpi-grid.count-6 { grid-template-columns: repeat(2, 1fr); }
  .dash-kpi strong { font-size: clamp(20px, 7vw, 30px); }
}
`;

const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

/**
 * 组装自包含的离线看板 HTML:内联 echarts(动态 import 保持主包精简)+ 运行时 + 烘焙数据。
 * `</script` 通过把 JSON 里的 `<` 转成 \\u003c 防止提前闭合脚本标签。
 */
export async function buildDashboardHtml(baked: BakedDashboard): Promise<string> {
  /* 按需构建的 ECharts(只含折线/柱状/饼 + grid/legend/tooltip/dataZoom),
     不是完整版 —— 1096 KB → 597 KB。清单在 vite/exportAssets.ts。
     仍然是动态 import,这样它不进主包。 */
  const echartsSource = (await import("virtual:echarts-standalone")).default;
  const json = JSON.stringify(baked).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(baked.title)} · 离线看板</title>
<style>${STANDALONE_CSS}</style>
<!-- 视觉预设(卡片背景/配色);放在基础样式之后,同特异性下预设胜出 -->
<style>${filterControlsCss}</style>
<style>${presetsCss}</style>
</head>
<body>
<div id="dash-root"></div>
<script>${echartsSource}</script>
<script>${controlsSource}</script>
<script>${xlsxSource}</script>
<script>${labelOrderSource}</script>
<script>${pieGeometrySource}</script>
<script>${tooltipTextSource}</script>
<script>${moreChartsSource}</script>
<script>window.__DASH__=${json};</script>
<script>${runtimeSource}</script>
</body>
</html>`;
}
