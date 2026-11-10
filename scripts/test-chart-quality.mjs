import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
const dir=mkdtempSync(join(tmpdir(),'sonde-chart-quality-'));
try {
 const outfile=join(dir,'test.cjs');
 // Replace only the ECharts host: exercise the real series and formatter construction.
 const {build}=await import('esbuild');
 await build({stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import ChartWidget from './src/features/dashboard/widgets/ChartWidget';export {normalizeDashboard,createDashboard,createWidget} from './src/features/dashboard/domain';export {repairGeneratedStyle} from './src/features/dashboard/generatedAppearance';export * from './src/features/dashboard/cardReadability';export {refineAnalysisLayout} from './src/features/agent/presentation';export function render(props){renderToStaticMarkup(React.createElement(ChartWidget,props));return globalThis.__qualityOption;}export function renderHtml(props){return renderToStaticMarkup(React.createElement(ChartWidget,props));}`,resolveDir:process.cwd(),loader:'tsx'},outfile,bundle:true,platform:'node',format:'cjs',logLevel:'silent',plugins:[{name:'capture-option',setup(b){b.onLoad({filter:/echarts-for-react\/lib\/index.js$/},()=>({contents:"import React from 'react'; export default function ChartHost(p){globalThis.__qualityOption=p.option; return React.createElement('div');}",loader:'js'}));}}]});
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}}});
 globalThis.getComputedStyle=()=>({getPropertyValue:()=> '#8796a8'});
 const m=createRequire(import.meta.url)(outfile);
 globalThis.document={documentElement:{}};
 assert(m.contrast(m.rgb('#141b26'),m.rgb('#F3F6FA'))>4.5);
 assert.equal(m.cardReadability({background:'#F3F6FA',visualPreset:'slate'})['--text'],'#141b26');
 assert(m.contrast(m.rgb(m.readableColor('#fafafa','#ffffff')),m.rgb('#ffffff'))>=4.5);
 assert(m.contrast(m.rgb(m.readableColor('#1F2A37',m.appearanceBackground({visualPreset:'slate'}))),m.rgb('#29384a'))>=4.5);
 assert.equal(m.readableColor('#1F2A37','#F4F7FB'),'#1F2A37','Legible light designs remain unchanged');
 const note={...m.createWidget('text',''),w:12,h:3,x:0,y:0,options:{appearance:{visualPreset:'slate',background:'#F4F7FB'},content:'A short note'}};
 const table={...m.createWidget('table',''),w:12,h:5,x:0,y:3,options:{appearance:{visualPreset:'slate'},table:{headerBg:'#F4F7FB',headerText:'#1F2A37'}}};
 const original={...m.createDashboard(),widgets:[note,table],metricScope:{start:'2026-06-01',end:'2026-08-31'},aiProvenance:{workflowId:'test',widgetReasons:{},userRequest:'test',createdAt:'test'}};
 const fixed=m.normalizeDashboard(original);
 assert.equal(fixed.widgets[0].options.appearance.background,undefined);assert.equal(fixed.widgets[1].options.table.headerBg,undefined);
 assert.equal(fixed.widgets[0].h,2);assert.equal(fixed.widgets[1].y,2);assert.equal(fixed.widgets[1].id,table.id);assert.deepEqual(fixed.metricScope,original.metricScope);
 assert.equal(original.widgets[0].options.appearance.background,'#F4F7FB','Do not mutate stored source');
 fixed.widgets[0].options.appearance.background='#FFFFFF';assert.equal(m.normalizeDashboard(fixed).widgets[0].options.appearance.background,'#FFFFFF','Later manual edits survive normalization');
 const manual=m.normalizeDashboard({...original,aiProvenance:undefined});assert.equal(manual.widgets[0].options.appearance.background,'#F4F7FB');assert.equal(manual.widgets[0].h,3);
 const main={key:'sales',name:'销售额',field:'sales',unit:'元',aggregation:'sum',columnIndex:1,decimals:1,direction:'neutral'};
 const secondary={...main,key:'orders',name:'订单量',field:'orders',unit:'单',columnIndex:2,decimals:0};
 const widget={id:'fixture',type:'line',title:'双轴',datasetId:'fixture',bindings:{dimensions:['month'],metricIds:['sales'],secondaryMetricIds:['orders'],measures:[]},options:{metrics:{},decimals:1,topN:0,showLegend:true,numberFormat:{scale:'wan'},chart:{secondarySeriesType:'line',showLabels:true}}};
 const props={widget,result:{columns:[{name:'month'},{name:'sales'},{name:'orders'}],rows:[['2026-06',12000000,500000],['2026-07',14000000,550000]]},resolvedMetrics:[main],secondaryMetrics:[secondary],dimensionName:'month',dimensionIndex:0,activeMeasure:'sales',onActiveMeasure:()=>{}};
 const option=m.render(props);assert.equal(option.series.length,2);assert.equal(option.yAxis.length,2);assert.equal(option.series[1].yAxisIndex,1);assert.deepEqual(option.series[1].data,[500000,550000]);assert.equal(option.yAxis[0].axisLabel.formatter(12000000),'1200');assert.equal(option.yAxis[1].axisLabel.formatter(500000),'500000');assert(!option.series[1].label.formatter({value:500000}).includes('万'));
 const legacy=m.render({...props,widget:{...widget,options:{...widget.options,chart:{}}}});assert.equal(legacy.series.length,1,'Existing tooltip-only secondary values remain tooltip-only');
 const dining={...main,key:'dining',name:'线下',field:'dining',columnIndex:0};const delivery={...main,key:'delivery',name:'线上',field:'delivery',columnIndex:1};
 const totals={...props,widget:{...widget,type:'pie',bindings:{...widget.bindings,dimensions:[],metricIds:['dining','delivery'],secondaryMetricIds:[]}},resolvedMetrics:[dining,delivery],secondaryMetrics:[],result:{columns:[{name:'dining'},{name:'delivery'}],rows:[[100,200]]},dimensionName:'dining',dimensionIndex:0,activeMeasure:'dining'};
 const pie=m.render(totals);assert.deepEqual(pie.series[0].radius,['42%','75%']);const thick=m.render({...totals,widget:{...totals.widget,options:{...totals.widget.options,chart:{pieHole:20,pieOuterRadius:80}}}});assert.deepEqual(thick.series[0].radius,['20%','80%']);assert.deepEqual(pie.series[0].data.map(s=>s.value).sort((a,b)=>a-b),[100,200]);assert(pie.series[0].data.some(s=>s.name.includes('线下')&&s.value===100));
 const customPie=m.render({...totals,widget:{...totals.widget,options:{...totals.widget.options,chart:{dimensionColors:{'线下':'#E8833A','线上':'#2F6FED'}}}}});
 for(const slice of customPie.series[0].data)assert.equal(customPie.legend.data.find(item=>item.name===slice.name).itemStyle.color,slice.itemStyle.color);
 assert.equal(customPie.series[0].data.find(item=>item.name.startsWith('线下')).itemStyle.color,'#E8833A');
 /* 多个指标、没有维度时指标名就是分类。真机:「线下各渠道销售额排名」绑了示例POS/点评平台/
    短视频平台等五个指标(渠道在那个目录里是**各自独立的指标**,不是某个维度的取值),
    原来全挤进一个叫"合计"的分组、名字塞进图例(而图例常常没显示)——
    用户要的正是各渠道,图上一个渠道名都没有。 */
 const bar=m.render({...totals,widget:{...totals.widget,type:'bar'}});
 // 分类名带单位(和饼图切片一致),读者一眼知道这根轴是什么
 assert.deepEqual(bar.xAxis.data,['线上 (元)','线下 (元)'],'同单位的多个指标要各占一个分类,并按值排序');
 assert.equal(bar.series.length,1,'指标当分类时只画一条系列');
 assert.deepEqual(bar.series[0].data,[200,100]);
 /* 但"指标值不能当分类"这条旧规矩的用意仍然成立:单位不同的指标(销售额 元 / 订单量 单)
    并排放在同一根轴上,那根轴没有意义。收窄它,不是推翻它。 */
 const mixed=m.render({...totals,resolvedMetrics:[dining,{...delivery,unit:'单'}]});
 assert.deepEqual(m.render({...totals,widget:{...totals.widget,type:'bar'},resolvedMetrics:[dining,{...delivery,unit:'单'}]}).xAxis.data,['合计'],'单位不同就不能并排比,轴会失去意义');
 void mixed;
 /* 比率/均值同理:它们加不起来,也不该当成"构成"并排排名 —— 和饼图那条护栏一致。 */
 assert.deepEqual(m.render({...totals,widget:{...totals.widget,type:'bar'},resolvedMetrics:[{...dining,aggregation:'avg'},{...delivery,aggregation:'avg'}]}).xAxis.data,['合计']);
 /* 量级差太远的小项不画:示例POS 98 万 / 地图团购 726.76 元 / 快手 0 ——
    后两根柱子在 98 万的轴上不占像素,既看不出大小也读不出数,却把轴和图例挤满。
    **但一定要说出来**,从图里拿掉可以,悄悄拿掉不行。 */
 {
  const ch = (key,name,columnIndex)=>({...main,key,name,field:key,columnIndex});
  const four=[ch('qm','示例POS',0),ch('dp','点评平台',1),ch('gd','地图团购',2),ch('ks','快手',3)];
  const wide={...totals,widget:{...totals.widget,type:'bar',bindings:{...totals.widget.bindings,metricIds:['qm','dp','gd','ks']}},
   resolvedMetrics:four,result:{columns:four.map(c=>({name:c.key})),rows:[[980000,128000,726.76,0]]},activeMeasure:'qm'};
  const even={...wide,result:{columns:four.map(c=>({name:c.key})),rows:[[980000,128000,90000,50000]]}};
  const chart=m.render(wide);
  assert.deepEqual(chart.xAxis.data,['示例POS (元)','点评平台 (元)'],'差三个数量级的和 0 不画:'+JSON.stringify(chart.xAxis.data));
  assert.deepEqual(chart.series[0].data,[980000,128000]);
  /* 拿掉了什么必须写在卡片上 —— 这半个才是关键:从图里拿掉可以,悄悄拿掉不行,
     那正是"看起来一切正常"的那类错。 */
  const html=m.renderHtml(wide);
  assert.ok(html.includes('未画出'),'要有一行注脚说明拿掉了东西');
  assert.ok(html.includes('地图团购')&&html.includes('快手'),'注脚要点名是谁:'+html.slice(-400));
  /* 注脚**不跟卡片的万元换算走**:这行字存在的意义就是给出真实数值,
     726.76 元按「万」显示成「0.1万元」,等于把要说清的东西又糊掉一次
     —— 和当初 KPI「0万」是同一个病。 */
  assert.ok(html.includes('726')&&!html.includes('0.1万'),'注脚要给真实数值,不能被万元换算糊掉:'+/未画出[^<]*/.exec(html)?.[0]);
  assert.ok(!m.renderHtml(even).includes('未画出'),'一个都没丢就别加这行噪音');

  assert.equal(m.render(even).xAxis.data.length,4,'量级相当就全画出来,别顺手砍尾巴');
  // 只剩一个大的时候不丢 —— 一根柱子的图没有比较可言,不如都留着
  const lonely={...wide,result:{columns:four.map(c=>({name:c.key})),rows:[[980000,1,2,3]]}};
  assert.equal(m.render(lonely).xAxis.data.length,4,'剩不到两项就不丢,否则图里只剩一根柱子');
 }

 // topN 照样生效:要前一个渠道就只给前一个
 assert.deepEqual(m.render({...totals,widget:{...totals.widget,type:'bar',options:{...totals.widget.options,topN:1}}}).xAxis.data,['线上 (元)']);
 const layout=m.refineAnalysisLayout({title:'构成',items:[{type:'pie',title:'渠道',metricIds:['dining','delivery'],dimensions:[],band:'structure',reason:'互斥渠道构成'}]},[{metricId:'dining',name:'线下',unit:'元',rollup:'sum'},{metricId:'delivery',name:'线上',unit:'元',rollup:'sum'}]);assert.equal(layout.items[0].type,'pie');

 /* ── tooltip 不许执行脚本 ────────────────────────────────────────────────
    ECharts 的 tooltip formatter 返回的是 HTML 字符串,而里面拼的分类名、系列名、
    维度值、指标名全都来自数据库。一个名字叫 `<img src=x onerror=...>` 的分组
    就能在别人悬浮时执行脚本,而桌面版同一个页面还握着原生命令调用能力。

    测的是**真 option 上的 formatter 实际返回的字符串**,不是"有没有调转义函数"
    —— 后者改坏了照样绿。 */
 {
  const XSS = '<img src=x onerror="alert(1)">';
  const evil = {...main, key:'evil', name:`销售额${XSS}`, field:'sales', columnIndex:1};
  /* 判据:把**我们自己生成**的那几个标签剥掉之后,不该再剩任何 `<`。
     比"不含 <img"准 —— 转义后的文本里照样有 `onerror=` 这个子串(在 &lt;…&gt;
     里,执行不了),按子串找会误报;而漏转义的任何标签都会在这里露出来。 */
  const OURS = /<\/?(?:div|span|b|br)\b[^>]*\/?>/g;
  const raw = (html) => {
    const left = html.replace(OURS, '');
    assert(!left.includes('<'), `tooltip 里有没转义的标签: ${html}`);
  };

  // 轴类:分类名(x)、系列名、副指标名三条路
  const axis = m.render({...props,
    result:{columns:[{name:'month'},{name:'sales'},{name:'orders'}],rows:[[XSS,12000000,500000]]},
    secondaryMetrics:[{...secondary, name:`订单量${XSS}`}]});
  const axisHtml = axis.tooltip.formatter([{axisValue:XSS, marker:'<span></span>', seriesName:`销售额${XSS}`, seriesIndex:0, value:12000000}]);
  raw(axisHtml);
  assert(axisHtml.includes('&lt;img'), '外来文本要转义后仍然显示出来,不是整段丢掉');
  assert(axisHtml.includes('<span></span>'), 'ECharts 自己生成的 marker 是结构性 HTML,不能被转义掉');

  // 饼图:扇区名
  const evilPie = m.render({...totals,
    widget:{...totals.widget, bindings:{...totals.widget.bindings, metricIds:['evil','delivery']}},
    resolvedMetrics:[evil, delivery]});
  const pieHtml = evilPie.tooltip.formatter({name:`销售额${XSS}`, marker:'<span></span>', value:100, percent:33.3, seriesIndex:0});
  raw(pieHtml);
  assert(pieHtml.includes('&lt;img'), '饼图扇区名同样要转义后保留');

  console.log('  ✓ tooltip:分类名/系列名/扇区名里的标签一律转义,marker 不动');
 }

 console.log('Quality regressions passed: light card contrast, dual-axis series and independent units, legacy secondary tooltips, multi-metric pie composition, aggregate labels, pending coverage and unavailable evidence distinction.');
} finally {rmSync(dir,{recursive:true,force:true});}
