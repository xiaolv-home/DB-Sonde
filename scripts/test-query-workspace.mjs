import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const dir = mkdtempSync(join(tmpdir(), 'sonde-query-'));
try {
  const bundle = join(dir, 'tests.cjs');
  buildSync({ stdin: { contents: [
    'lib/queryResultView', 'lib/queryExecution', 'lib/tableEditing', 'lib/clipboard', 'lib/workspaceSession',
  ].map(path => `export * from './src/${path}';`).join('\n') + "\nexport { useApp } from './src/store/appStore'; export { api } from './src/lib/api';", resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
  const storage = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => storage.get(key) ?? null, setItem: (key,value) => storage.set(key,value) } });
  const m = createRequire(import.meta.url)(bundle);
  const result = { columns: [{name:'id',typeName:'BIGINT'},{name:'name',typeName:'TEXT'}], rows:[['9007199254740993','B'],['9007199254740992','A'],[null,'C']], elapsedMs:5, truncated:false };
  const sorted = m.applySortFilter(result, {column:'id',dir:'asc'}, []);
  assert.deepEqual(sorted.rows.map(row=>row[0]), ['9007199254740992','9007199254740993',null]);
  assert.deepEqual(m.applySortFilter(result,{column:'id',dir:'desc'},[]).rows.map(row=>row[0]), ['9007199254740993','9007199254740992',null]);
  assert.equal(result.rows[0][1], 'B', 'presentation cannot mutate source rows');
  assert(m.compareCells('1.00000000000000000002','1.00000000000000000001')>0);
  assert(m.compareCells('-1e20','-9e19')<0);
  assert.equal(m.compareCells('0.000','-0'),0);
  assert.equal(m.compareCells('1.00','1e0'),0);
  assert.equal(m.eqCells('9007199254740993',9007199254740992),false);
  assert.equal(m.eqCells('001','1'),false,'text identity is preserved');
  assert.equal(m.matchFilter(10,'>',null),false);
  const view={sort:{column:'id',dir:'desc'},filters:[{column:'name',op:'like',value:'a'}]};
  assert.strictEqual(m.reconcileResultView(view,{...result,rows:[]}),view,'refresh does not reset view state');
  assert.deepEqual(m.reconcileResultView(view,{...result,columns:[result.columns[0]]}),{sort:view.sort,filters:[]});
  assert.notEqual(m.resultViewKey('SELECT 1',0),m.resultViewKey('SELECT 1',1));
  assert.notEqual(m.resultViewKey('SELECT 1',0,0),m.resultViewKey('SELECT 1',0,1));
  assert.notEqual(m.resultViewKey('SELECT 1',0),m.resultViewKey('SELECT 2',0));
  const preview='SELECT * FROM test;';
  assert(m.matchesPreviewExecution('SELECT * FROM test',preview));
  assert(!m.matchesPreviewExecution('SELECT * FROM other',preview));
  assert(!m.matchesPreviewExecution('SELECT * FROM test; DELETE FROM test',preview));
  const q={kind:'query',id:'q',connId:'fixture',connName:'Fixture',database:'original',title:'Test',sql:'SELECT 1; SELECT 2;',running:false,executions:[],activeExecutionIndex:0,view:'grid'};
  assert(m.hasRunningTask({...q,savingEdits:true}));
  assert(!m.hasRunningTask(q));
  const app=m.useApp;
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
  function reset(tabs=[q]) { app.setState({tabs,activeTabId:'q',meta:{fixture:{id:'fixture',kind:'mysql'}},dirtyTabs:{},savedQueries:[],showToast:()=>{},loadCatalog:async()=>{}}); }
  // A script captures its original connection/database and cannot steal manual result selection.
  reset();let pending=[],calls=[];
  m.api.runQuery=async(conn,db,sql,maxRows)=>{const work=deferred();pending.push(work);calls.push([conn,db,sql,maxRows]);return work.promise;};
  const running=app.getState().runTab('q');
  pending[0].resolve(result);await tick();
  assert.equal(calls.length,2);
  app.getState().selectExecution('q',0);
  app.getState().setTabDatabase('q','different');
  const second={...result,rows:[[2,'second']]};pending[1].resolve(second);await running;
  assert.equal(app.getState().tabs[0].activeExecutionIndex,0);
  assert.strictEqual(app.getState().tabs[0].result,result);
  assert(calls.every(call=>call[1]==='original'));
  // 编辑器查询必须带行数上限:不带的话大表一查就把几百 MB 推给界面(实测 30 万行就 1.5GB 内存)
  assert(calls.every(call=>Number.isInteger(call[3]) && call[3] > 0 && call[3] <= 200000), `编辑器查询没带行数上限:${JSON.stringify(calls.map(c=>c[3]))}`);
  // Replaced runs ignore late results and never dispatch their remaining statements.
  reset();pending=[];calls=[];
  const old=app.getState().runTab('q');
  app.setState({tabs:[{...q,sql:'SELECT 99'}]});
  const replacement=app.getState().runTab('q');
  pending[0].resolve(result);await old;
  assert.equal(calls.length,2);
  assert.equal(app.getState().tabs[0].running,true,'old completion cannot stop replacement run');
  assert.equal(app.getState().tabs[0].result,undefined);
  pending[1].resolve(second);await replacement;
  assert.strictEqual(app.getState().tabs[0].result,second);
  reset();pending=[];calls=[];
  const closing=app.getState().runTab('q');app.getState().closeTab('q',true);pending[0].resolve(result);await closing;
  assert.equal(calls.length,1,'closed page must not dispatch more SQL');
  reset();pending=[];calls=[];
  const failed=app.getState().runTab('q');pending[0].reject(Error('fixture failure'));await failed;
  assert.equal(calls.length,1);assert.match(app.getState().tabs[0].error,/fixture failure/);assert.equal(app.getState().tabs[0].running,false);
  reset();pending=[];calls=[];
  const disconnected=app.getState().runTab('q');
  app.setState({meta:{fixture:{id:'fixture',kind:'mysql'}}});
  pending[0].resolve(result);await disconnected;
  assert.equal(calls.length,1,'a replacement connection cannot receive remaining SQL from an old run');
  await assert.rejects(app.getState().saveResultEdits('missing',[{row:0,column:0,newValue:1}]),/不可用/);
  // Save ownership, duplicate guards and pending-edit navigation protection.
  const context={database:'original',schema:'',table:'test',editable:true,previewSql:preview,columns:[{name:'id',isPrimaryKey:true},{name:'name'}]};
  const editTab={...q,sql:preview,tableContext:context,result,executions:[{sql:'SELECT * FROM test',result},{sql:'SELECT other',result:second}]};
  reset([editTab]);const saving=deferred();let writes=0;
  m.api.applyCellEdits=async requests=>{writes++;assert.equal(requests[0].database,'original');assert.equal(requests[0].primaryKey.id,'9007199254740993');await saving.promise;};
  const edits=[{row:0,column:1,oldValue:'B',newValue:'changed'}];
  const save=app.getState().saveResultEdits('q',edits);
  await assert.rejects(app.getState().saveResultEdits('q',edits),/正在执行或保存/);
  app.getState().selectExecution('q',1);assert.equal(app.getState().tabs[0].activeExecutionIndex,0);
  app.getState().setTabView('q','chart');assert.equal(app.getState().tabs[0].view,'grid');
  app.getState().closeTab('q',true);assert.equal(app.getState().tabs.length,1);
  await app.getState().runTab('q');assert.equal(writes,1);
  // Even an external state replacement during save must not receive the old result.
  app.setState(state=>({tabs:[{...state.tabs[0],activeExecutionIndex:1,result:second}]}));
  saving.resolve();await save;
  assert.strictEqual(app.getState().tabs[0].result,second);
  assert.equal(app.getState().tabs[0].executions[0].result.rows[0][1],'changed');
  assert.strictEqual(app.getState().tabs[0].executions[1].result,second);
  assert.equal(app.getState().tabs[0].savingEdits,false);
  reset([{...q,id:'left'},{...q,id:'right'}]);app.setState({activeTabId:'right'});
  app.getState().setResultHeight(480,'left');
  assert.equal(app.getState().tabs[0].resultHeight,480);assert.equal(app.getState().tabs[1].resultHeight,undefined);
  assert(m.isWorkspaceSnapshot(m.workspaceSnapshot({tabs:[{...q,sql:'',view:'structure'}],dirtyTabs:{},savedQueries:[]})),'supported transient views must not invalidate workspace snapshots');
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
  assert.equal(await m.tryWriteClipboardText('fixture'),false);
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async()=>{throw Error('denied');}}}});
  assert.equal(await m.tryWriteClipboardText('fixture'),false);
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async()=>{}}}});
  assert.equal(await m.tryWriteClipboardText('fixture'),true);
  // ── 格子里改出来的文本 → 写进库的值 ──────────────────────────────────────
  {
    const msg = { number: '不是合法数字', boolean: '不是合法布尔' };
    const parse = (input, original) => m.parseEditedValue(input, original, msg);

    /* 清空一个格子 = 置空。原来数字这一支是 Number(input),而 Number('') 正好是 0
       且 isFinite —— 用户把金额格子选中删掉、回车,库里写进去的是 0,一声不吭。
       0 和 NULL 后面所有求和/日均/环比读出来是两回事。 */
    assert.equal(parse('', 100), null, '数字格子清空要写 NULL,不能替用户填 0');
    assert.equal(parse('   ', 100), null, '只剩空格也是清空');
    assert.equal(parse('', true), null, '布尔同理');
    assert.equal(parse('', { a: 1 }), null, 'JSON 列同理');
    // 文本列不在此列:空串对文本是个正经取值,跟 NULL 不是一回事,两个都要得到
    assert.equal(parse('', 'x'), '', '文本清空是空串,不是 NULL');
    assert.equal(parse('NULL', 'x'), null, '文本列想要 NULL 就照旧输入 NULL');
    assert.equal(parse('null', 100), null, '大小写都认');

    // 正常取值照旧
    assert.equal(parse('42', 100), 42);
    assert.equal(parse(' 42 ', 100), 42, '前后空格不影响');
    assert.equal(parse('-3.5', 100), -3.5);
    assert.equal(parse('true', false), true);
    assert.equal(parse('0', false), false, '0 是 false,不是清空');
    assert.equal(parse('0', 100), 0, '明确输入 0 当然还是 0');
    assert.deepEqual(parse('{"a":2}', { a: 1 }), { a: 2 });
    assert.equal(parse('abc', 'x'), 'abc');

    /* 类型按**列的声明类型**判,不是按"这一格现在长什么样"。
       真机:`STORE_ID varchar(32)` 眼下装着 806522,想改成一串 32 位 hex,
       被拒了 ——「请输入有效数字或 NULL」。一列 varchar,因为当前那行恰好是数字,
       就被当成数字列。表格本来就有权威答案(isNumericType(col.typeName)),
       右对齐和筛选器都在用它,只有这里在靠值猜。 */
    const typed = (input, original, numeric) => m.parseEditedValue(input, original, msg, numeric);
    assert.equal(
      typed('ebca0d4b04fd4a708d6811fc3e0db5f4', 806522, false),
      'ebca0d4b04fd4a708d6811fc3e0db5f4',
      'varchar 列装着数字,也不能因此拒绝文本',
    );
    assert.equal(typed('', 806522, false), '', '非数字列清空是空串,不该按数字列写 NULL');

    /* 文本列清空存什么,看列能不能为 NULL。
       真机:把一格 varchar 清空保存,它显示成空白,旁边的格子显示「NULL」——
       以为一样,其实存的是 ''。IS NULL 查不到它,数字列清空却又是 NULL,
       同一个"清空"动作按类型结果不一样。 */
    const col = (input, original, nullable) => m.parseEditedValue(input, original, msg, false, nullable);
    assert.equal(col('', '2001073382', true), null, '可空文本列清空要存 NULL');
    assert.equal(col('', '2001073382', false), '', 'NOT NULL 列写 NULL 会被库拒掉,清空只能是空串');
    assert.equal(col('', '2001073382', undefined), '', '拿不到列元数据时保持老行为');
    assert.equal(col('  ', 'x', true), '  ', '敲的空格是内容,不当成清空');
    assert.equal(col('abc', 'x', true), 'abc', '正常输入不受影响');
    assert.equal(col('NULL', 'x', false), null, '手打 NULL 照旧是 NULL(NOT NULL 列由库去拒)');

    /* 反过来不能用列类型强转:DECIMAL 是故意以字符串回来的(保精度),
       一旦按"这是数字列"去 Number(),100.00 就成了 100,金额列悄悄丢小数位。
       columnIsNumeric 只用来放行,不用来收紧。 */
    assert.equal(typed('100.00', '99.90', true), '100.00', '数字列里的字符串值要原样留着,别转成 Number 丢精度');
    assert.equal(typed('0.10', '0.20', true), '0.10');

    // 数字列仍然要拦住非数字 —— 放行只针对非数字列
    assert.throws(() => typed('abc', 100, true), /不是合法数字/, '数字列还是要拦');
    assert.throws(() => typed('abc', 100, undefined), /不是合法数字/, '不传列类型就退回老行为');

    // 认不出来的要抛错让用户看见,不能猜
    assert.throws(() => parse('abc', 100), /不是合法数字/);
    assert.throws(() => parse('1e999', 100), /不是合法数字/, '溢出成 Infinity 不能写进去');
    assert.throws(() => parse('maybe', true), /不是合法布尔/);
    assert.throws(() => parse('{坏 json', { a: 1 }));
  }

  // 「停止」:当前语句标成已停止、剩下的不再执行、迟到的结果不写回,并按同一个编号通知数据库取消
  {
    reset([{...q,sql:'SELECT SLEEP(20); SELECT 2;'}]);
    let pendingRun=[],runCalls=[],cancels=[];
    m.api.runQuery=async(conn,db,sql,maxRows,runId)=>{const work=deferred();pendingRun.push(work);runCalls.push({sql,runId});return work.promise;};
    m.api.cancelQuery=async(conn,db,runId)=>{cancels.push(runId);return true;};
    const toasts=[];app.setState({showToast:(t)=>toasts.push(t)});
    const run=app.getState().runTab('q');await tick();
    assert.equal(runCalls.length,1);
    assert(/^[A-Za-z0-9-]+$/.test(runCalls[0].runId),`运行编号只能是字母数字和 -:${runCalls[0].runId}`);
    await app.getState().stopTab('q');
    const after=app.getState().tabs[0];
    assert.equal(after.running,false,'停止后不再显示运行中');
    assert.equal(after.executions[0].error,'已停止');
    assert.deepEqual(cancels,[runCalls[0].runId],'按正在跑的那条语句的编号去取消');
    pendingRun[0].resolve(result);await run;await tick();
    assert.equal(runCalls.length,1,'停止后脚本里剩下的语句不能再执行');
    assert.equal(app.getState().tabs[0].executions[0].error,'已停止','迟到的结果不能覆盖「已停止」');
    assert(toasts.some(t=>t.kind==='success'),'数据库取消成功要告诉用户');
    // 不支持服务器端取消的库:如实说「可能仍在执行」
    reset([{...q,sql:'SELECT 1'}]);pendingRun=[];runCalls=[];cancels=[];toasts.length=0;app.setState({showToast:(t)=>toasts.push(t)});
    m.api.cancelQuery=async()=>false;
    const run2=app.getState().runTab('q');await tick();
    await app.getState().stopTab('q');
    assert(toasts.some(t=>t.kind==='warn'&&/仍在执行/.test(t.text)));
    pendingRun[0].resolve(result);await run2;
  }

  console.log('Query workspace checks passed: precise sort/filter, per-result identity, refresh reconciliation, original execution context, late response isolation, manual result selection, save ownership and duplicate guards, preview delimiters, explicit resize target, clipboard failures, cell edit parsing.');
} finally { rmSync(dir,{recursive:true,force:true}); }
