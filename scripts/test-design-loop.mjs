import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
const dir = mkdtempSync(join(tmpdir(), 'sonde-design-loop-'));
try {
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, [
    ['src/features/agent/designLoop.ts', '*'], ['src/features/agent/designContracts.ts', '*'], ['src/features/agent/styleSchema.ts', '*'],
    ['src/features/agent/jsonSchema.ts', '*'], ['src/features/agent/model/structured.ts', '*'], ['src/features/agent/model/analysisModels.ts', '*'],
    ['src/features/agent/state.ts', '*'], ['src/features/agent/nodes/index.ts', '*'], ['src/features/agent/tools/dashboardTools.ts', '*'],
    ['src/features/agent/tools/registry.ts', '*'], ['src/features/ai/aiStore.ts', '{useAi}'], ['src/features/metrics/metricsStore.ts','{useMetrics}'],
    ['src/lib/api.ts','{api}'], ['src/features/agent/review.ts','*'], ['src/features/agent/presentation.ts','*'], ['src/features/agent/layout.ts','*'],
  ].map(([file, names]) => `export ${names} from ${JSON.stringify(resolve(file))};`).join('\n'));
  const output = join(dir, 'test.cjs'); buildSync({ entryPoints:[entry], outfile:output, bundle:true, platform:'node', format:'cjs', logLevel:'silent' });
  const storage = new Map(); Object.defineProperty(globalThis, 'localStorage', { configurable:true, value:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)} });
  const m = createRequire(import.meta.url)(output);
  // Guard against future inspector options silently missing from the model's tool contract.
  const source = ts.createSourceFile('domain.ts', readFileSync('src/features/dashboard/domain.ts','utf8'), ts.ScriptTarget.Latest, true);
  for (const [name, schema] of Object.entries({ DashboardTableOptions:m.TABLE_SCHEMA, DashboardChartOptions:m.CHART_SCHEMA, DashboardKpiOptions:m.KPI_SCHEMA, DashboardAppearanceOptions:m.APPEARANCE_SCHEMA, DashboardTextOptions:m.TEXT_SCHEMA, DashboardContainerOptions:m.CONTAINER_SCHEMA })) {
    const declaration = source.statements.find(s => ts.isInterfaceDeclaration(s) && s.name.text===name);
    for (const member of declaration.members) assert(schema.properties[member.name.getText(source)], `${name}.${member.name.getText(source)} is hidden from the designer`);
  }
  assert(m.designCapabilityGuide().includes('table.dimensionPlacements'));
  assert(m.validate({ columnWidths:{ sales:'wide' } },m.TABLE_SCHEMA).length);
  assert.deepEqual(m.validate({ columnWidths:{ sales:140 }, dimensionPlacements:{region:'column'} },m.TABLE_SCHEMA),[]);
  const metric={id:'sales',key:'sales',name:'销售额',unit:'元',enabled:true,type:'measure',connId:'fixture',database:'retail',source:'orders',expression:'sum(amount)',dimensions:['region'],timeField:'day',caliber:'销售额求和'};
  m.useMetrics.setState({metrics:[metric]});
  const base=m.createState({userRequest:'经营分析',connId:'fixture'});
  const item={type:'kpi',band:'kpi',title:'销售额',metricIds:['sales'],dimensions:[],reason:'经营规模',x:0,y:0,w:6,h:3};
  let state={...base, report:'销售额与效率共同变化，原因仍待验证', scope:{dateRange:{start:'2026-08-01',end:'2026-08-31'},label:'8月',grain:'day',filters:[],comparisonRanges:[]}, validatedMetrics:[{metricId:'sales',name:'销售额',unit:'元',caliber:'求和',rollup:'sum',supportedDimensions:['region'],sourceTables:['orders'],dateScoped:true}], layout:{title:'经营概览',preset:'editorial',items:[item,{type:'container',band:'detail',title:'不同视角',metricIds:[],dimensions:[],reason:'分层阅读',x:6,y:0,w:6,h:8,tabs:[{title:'区域',items:[{...item,type:'table',band:'detail',dimensions:['region'],table:{stripe:true,headerBg:'#eef4ff',dimensionPlacements:{region:'row'}}}]},{title:'总计',items:[{...item,kpi:{valueSize:40}}]}]}]}};
  assert.deepEqual(m.validateDesignBindings(state.layout,state),[]);
  assert(m.validateDesignBindings({...state.layout,items:[{...item,lockedScope:{start:'2026-01-01'}}]},state).some(s=>s.includes('超出')));
  assert(m.validateDesignBindings({...state.layout,items:[{...item,metrics:{sales:{unit:'美元'}}}]},state).length);
  assert(m.validateDesignBindings({...state.layout,items:[{...item,secondaryMetricIds:['invented']}]},state).length);
  assert(!m.scoreDesign({beauty:20,layout:20,variety:20,clarity:20,insight:5},[],{complete:true,issues:[]}).pass,'High total cannot hide superficial analysis');
  assert(!m.scoreDesign({beauty:20,layout:20,variety:20,clarity:20,insight:20},['文字遮挡'],{complete:true,issues:[]}).pass);
  assert(!m.scoreDesign({beauty:20,layout:20,variety:20,clarity:20,insight:20},[],{complete:false,issues:[]}).pass);
  const context={categoryCounts:{},pointCounts:{},validatedMetricIds:['sales'],ratioMetricIds:[],timeDimensions:['day','month']};
  const table={...item,type:'table',dimensions:['region']};
  assert(!m.reviewLayout(m.resolveLayout([table,{...table,x:6,table:{dimensionPlacements:{region:'column'}}}]),context).some(f=>f.code==='DUPLICATE_WIDGET'), 'Different pivot views must not be discarded');
  assert(m.reviewLayout(m.resolveLayout([table,{...table,x:6}]),context).some(f=>f.code==='DUPLICATE_WIDGET'), 'Identical views remain detectable');
  const nested=m.refineAnalysisLayout({...state.layout,items:[{...state.layout.items[1],tabs:[{title:'时间',items:[{...item,type:'pie',dimensions:['month']}]}]}]},state.validatedMetrics.map(m=>({...m,supportedDimensions:['region','month']})));
  assert.equal(nested.items[0].tabs[0].items[0].type,'pie',"The designer's chart choice is kept inside tabs too");
  // 画不画得出来照样要拦:散点要两个指标、热力要纵轴 —— 规则来自组件说明书
  assert(m.validateDesignBindings({...state.layout,items:[{...item,type:'scatter',dimensions:['region']}]},state).some(s=>s.includes('散点图至少要 2 个指标')));
  assert(m.validateDesignBindings({...state.layout,items:[{...item,type:'heatmap',dimensions:['region']}]},state).some(s=>s.includes('seriesDimension')));
  const config=m.analysisModelConfig({...m.useAi.getState().config,provider:'cloud',cloud:{baseUrl:'https://api.deepseek.com',apiKey:'fixture-only',model:'deepseek-chat'}});
  assert.equal(config.cloud.model,'deepseek-flash');assert.equal(config.designVision.model,'deepseek-flash');
  assert.equal(m.analysisModelConfig(config,{provider:'cloud',model:'deepseek-v4-flash'}).cloud.model,'deepseek-flash');
  assert.equal(m.analysisModelConfig(config,{provider:'cloud',model:'deepseek-v4-pro'}).cloud.model,'deepseek-v4-pro','Only an explicit new selection can use Pro');
  assert.equal(m.economicalSavedChoice({provider:'cloud',model:'deepseek-v4-pro'}).model,'deepseek-flash');
  assert.equal(m.economicalSavedChoice({provider:'local',model:'qwen'}).model,'qwen');
  const calls=[];let score=14;let imageFailure=false;
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async (_url,options)=>{
    const body=JSON.parse(options.body);calls.push(body);
    const name=body.response_format?.json_schema?.name;
    if(imageFailure&&name==='visual_observations')return new Response('This model does not support image',{status:400});
    const data=name==='visual_observations'?{observations:['总量卡位于左上，右侧为分页明细'],issues:[]}:{scores:{beauty:score,layout:score,variety:score,clarity:score,insight:score},reasons:Object.fromEntries(['beauty','layout','variety','clarity','insight'].map(k=>[k,'依据卡片主次与分组说明评价'])),changes:score<16?['主次不清，调整排版']:[],blockers:[]};
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(data)}}]}),{status:200});
  };
  try {
    const capture=m.createPreviewNode(async ()=>({images:['data:image/png;base64,fixture'],width:1440,height:1000,complete:true,issues:[],text:'总量卡和分页明细'}));
    state={...state,...await capture(state,{modelConfig:config})};
    const firstId=state.candidateDashboardId;
    const firstDraft=m.getDraft(firstId);assert.equal(firstDraft.widgets.filter(w=>w.parentId).length,2);
    assert.equal(firstDraft.widgets.find(w=>w.type==='table').options.table.headerBg,'#eef4ff');
    state={...state,...await m.visualReviewer(state,{modelConfig:config})};
    assert.equal(state.designRounds[0].status,'revise');assert.equal(state.designRounds[0].score,70);
    const imageCall=calls.find(c=>Array.isArray(c.messages[1].content));assert(imageCall.messages[1].content.some(p=>p.type==='image_url'));assert.equal(imageCall.max_tokens,4096,'Screenshot review needs its own output budget');assert.equal(imageCall.thinking.type,'disabled');
    const critic=calls.find(c=>c.response_format?.json_schema?.name==='design_score');assert.equal(critic.model,'deepseek-flash');assert.equal(critic.thinking.type,'disabled');assert(!calls.some(c=>c.model.includes('pro')),'Economical analysis makes no Pro requests');assert.equal(typeof critic.messages[1].content,'string');
    assert(!JSON.stringify(state).includes('data:image'),'Screenshots never enter checkpoint state');
    score=18;state={...state,...await capture(state,{modelConfig:config})};state={...state,...await m.visualReviewer(state,{modelConfig:config})};
    assert.equal(state.designRounds[1].status,'pass');
    const selected=state.candidateDashboardId;
    state={...state,...await m.commitDesign(state,{modelConfig:config})};assert.equal(state.dashboardId,selected);assert.equal(state.selectedDesignRound,2);assert.equal(m.getDraft(firstId),undefined);
    const saved=(await m.api.listDashboards()).find(d=>d.id===selected);assert(saved);assert.deepEqual(saved.aiProvenance.openIssues,[]);
    imageFailure=true;state={...state,...await capture(state,{modelConfig:config})};state={...state,...await m.visualReviewer(state,{modelConfig:config})};
    assert.equal(state.designRounds.at(-1).status,'unavailable');assert.equal(state.designRounds.at(-1).score,undefined);
    state={...state,...await m.commitDesign(state,{modelConfig:config})};assert.equal(state.review.verdict,'needs_revision');
    assert(m.getDraft(state.dashboardId).aiProvenance.openIssues.some(s=>s.includes('未通过')));
  } finally {globalThis.fetch=oldFetch;m.resetDesignSessions();}
  let capturedId;
  const aborter=new AbortController();
  const cancelled=m.createPreviewNode(async(doc)=>{capturedId=doc.id;aborter.abort();throw new DOMException('Cancelled','AbortError');});
  await assert.rejects(()=>cancelled(state,{signal:aborter.signal}),{name:'AbortError'});
  assert.equal(m.getDraft(capturedId),undefined,'Cancelled capture leaves no candidate draft');
  const waiting=m.createPreviewNode(async(doc)=>{capturedId=doc.id;return {images:['data:image/png;base64,AAAA'],width:1440,height:900,complete:true,issues:[],text:'预览'};});
  await waiting(state,{});m.clearDesignSession(state.workflowId);
  assert.equal(m.getDraft(capturedId),undefined,'Unscored previews are cleaned on workflow failure');
  console.log('Design loop passed: inspector capability coverage, nested tab persistence, semantic boundaries, actual image payload routing, Flash economy routing, score vetoes, revision history, single selected draft and honest unavailable review.');
} finally {rmSync(dir,{recursive:true,force:true});}
