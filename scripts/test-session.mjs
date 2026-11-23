import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const dir = mkdtempSync(join(tmpdir(), 'sonde-session-'));
try {
  const bundle = join(dir, 'tests.cjs');
  buildSync({ stdin: { contents: `export * from './src/lib/workspaceSession'; export * from './src/lib/databaseIdentity'; export { useApp } from './src/store/appStore'; export { api } from './src/lib/api';`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
  const storage = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) } });
  const { workspaceSnapshot, restoreWorkspace, isUnsavedTab, useApp, api, databaseBrand, connectionAccent } = createRequire(import.meta.url)(bundle);
  const base = { connId: 'fixture', connName: 'Fixture', database: 'sample' };
  const query = { ...base, kind: 'query', id: 'q', title: 'Saved SQL', savedId: 'saved', sql: 'SELECT 1; SELECT 2;', running: false, executions: [], activeExecutionIndex: 0, view: 'grid' };
  const savedQueries = [{ id: 'saved', name: query.title, sql: query.sql }];
  const table = { ...base, kind: 'table', id: 'table', title: 'sample_table', schema: '', table: 'sample_table', objectKind: 'table' };
  const database = { ...base, kind: 'database', id: 'db', title: 'sample', schema: '' };
  const python = { ...base, kind: 'python', id: 'py', title: 'script', path: '/mock/script.py' };
  const board = { ...base, kind: 'dashboard', id: 'board', title: 'Board', documentId: 'board-1' };
  const state = { tabs: [python, database, query, table, board], activeTabId: 'table', savedQueries, dirtyTabs: {} };
  const restored = restoreWorkspace(JSON.stringify(workspaceSnapshot(state)), savedQueries);
  assert.deepEqual(restored.tabs.map(t => t.id), ['py','db','q','table','board']);
  assert.equal(restored.activeTabId, 'table');
  assert.equal(restored.tabs[2].sql, query.sql);
  const runtimeState = { ...state, tabs: [{ ...query, running: true, selectedSql: 'secret selection', result: { rows: [['private result']] }, runProgress: { startedAt: 1 } }] };
  const serialized = JSON.stringify(workspaceSnapshot(runtimeState));
  assert(!serialized.includes('private result') && !serialized.includes('secret selection') && !serialized.includes('startedAt'));
  assert.equal(restoreWorkspace(serialized, savedQueries).tabs[0].running, false);
  assert(isUnsavedTab({ ...query, sql: 'changed' }, state));
  assert(isUnsavedTab({ ...query, savedId: undefined }, state));
  const discarded = workspaceSnapshot({ ...state, tabs: [...state.tabs, { ...query, id: 'new', savedId: undefined }], dirtyTabs: { table: true, py: true } });
  assert.deepEqual(discarded.tabs.map(t => t.id), ['db','q','board']);
  assert.equal(savedQueries[0].sql, query.sql, 'discard does not delete saved scripts');
  assert.deepEqual(restoreWorkspace('broken', savedQueries), { tabs: [] });
  assert.equal(restoreWorkspace(serialized, []).tabs.length, 0, 'deleted saved script must not reappear');

  let resolveQuery;
  let calls = 0;
  const result = { columns: [{name:'n',typeName:'INT'}], rows:[[1]], elapsedMs:5, truncated:false };
  api.runQuery = async () => { calls++; return await new Promise(resolve => { resolveQuery = resolve; }); };
  useApp.setState({ tabs: [query], activeTabId:'q', dirtyTabs:{}, meta:{fixture:{id:'fixture',kind:'mysql'}}, savedQueries, showToast:()=>{} });
  const run = useApp.getState().runTab('q');
  assert.equal(calls, 1);
  assert.equal(useApp.getState().tabs[0].runProgress.currentIndex, 0);
  assert.equal(useApp.getState().tabs[0].runProgress.total, 2);
  await useApp.getState().runTab('q'); assert.equal(calls, 1, 'no duplicate execution');
  resolveQuery(result); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(useApp.getState().tabs[0].runProgress.currentIndex, 1);
  resolveQuery(result); await run;
  assert.equal(useApp.getState().tabs[0].running, false);
  assert(useApp.getState().tabs[0].runProgress.finishedAt);
  assert.equal(useApp.getState().tabs[0].executions.filter(e=>e.result).length, 2);
  calls=0; api.runQuery=async()=>{calls++;throw Error('fixture failure');};
  await useApp.getState().runTab('q');
  assert.equal(calls,1,'stop after first failed statement');
  assert.equal(useApp.getState().tabs[0].running,false);
  assert.equal(useApp.getState().tabs[0].result,undefined,'no stale results after failure');
  useApp.setState({dirtyTabs:{q:true}});await useApp.getState().runTab('q');assert.equal(calls,1,'preserve pending grid edits');
  useApp.setState({dirtyTabs:{},tabs:[query,{...query,id:'q2'}],activeTabId:'q'});
  useApp.getState().setResultHeight(510);assert.equal(useApp.getState().tabs[0].resultHeight,510);assert.equal(useApp.getState().tabs[1].resultHeight,undefined);
  const routine = { ...base, kind:'routine', id:'routine', title:'sample_proc', schema:'public', routineName:'sample_proc(IN code text)', routineKind:'procedure', running:true, values:['private input'], result:{rows:[['private output']]} };
  const snapshot = JSON.stringify(workspaceSnapshot({ ...state, tabs:[routine], activeTabId:'routine' }));
  assert(!snapshot.includes('private input') && !snapshot.includes('private output'));
  const restoredRoutine = restoreWorkspace(snapshot, savedQueries).tabs[0];
  assert.equal(restoredRoutine.routineName, routine.routineName);
  assert.equal(restoredRoutine.running, false, 'restoring must never execute a routine');
  useApp.setState({tabs:[routine],activeTabId:'routine'});
  useApp.getState().closeTab('routine');
  assert.equal(useApp.getState().tabs.length,1,'cannot orphan an executing procedure');
  useApp.setState({tabs:[{...routine,running:false}]});
  useApp.getState().closeTab('routine');
  assert.equal(useApp.getState().tabs.length,0);
  /* 关闭未保存的查询页:不能当场关掉,要排队等应用内确认框回答(window.confirm 在 Tauri 下返回 Promise,恒为真) */
  const draft = { ...query, id:'draft', savedId: undefined, sql:'SELECT 42' };
  useApp.setState({ tabs:[draft], activeTabId:'draft', dirtyTabs:{}, closeRequests:[] });
  useApp.getState().closeTab('draft'); useApp.getState().closeTab('draft');
  assert.equal(useApp.getState().tabs.length,1,'unsaved tab must stay open until confirmed');
  assert.deepEqual(useApp.getState().closeRequests,['draft'],'one pending request per tab');
  useApp.getState().resolveCloseRequest(false);
  assert.equal(useApp.getState().tabs.length,1,'cancel keeps the tab');
  assert.deepEqual(useApp.getState().closeRequests,[]);
  useApp.getState().closeTab('draft'); useApp.getState().resolveCloseRequest(true);
  assert.equal(useApp.getState().tabs.length,0,'confirm discards and closes');
  assert.deepEqual(useApp.getState().closeRequests,[]);
  const node = { connId: 'fixture', database:'sample', schema:'public', kind:'procedure', label:'sample_proc(IN code text)' };
  useApp.getState().openRoutineTab(node); useApp.getState().openRoutineTab(node);
  assert.equal(useApp.getState().tabs.length,1,'same full routine identity reuses one tab');
  useApp.getState().openRoutineTab({...node,label:'sample_proc(IN code integer)'});
  assert.equal(useApp.getState().tabs.length,2,'overloads have independent tabs');
  assert.equal(databaseBrand({kind:'mysql',brand:'Apache Doris'}),'doris');
  assert.equal(databaseBrand({kind:'mysql'},'5.7.99 Doris version 3.0'),'doris');
  assert.equal(databaseBrand({kind:'postgres',brand:'PolarDB(PostgreSQL)'}),'polardb');
  assert.equal(databaseBrand({kind:'postgres'}),'postgres');
  assert.equal(connectionAccent({id:'a',color:'#123456'}),'#123456');
  assert.notEqual(connectionAccent({id:'a'}),connectionAccent({id:'b'}));
  // ── 光标一动就重渲染整个工作区 ────────────────────────────────────────────
  {
    /* SqlEditor 每次光标移动都会调 updateSelection,而**没有选中文字时传的是空串**。
       原来不管值有没有变都重建整个 tabs 数组,于是每挪一下光标:
         订阅 tabs 的组件(标签栏、工作区)全部重渲染
         → 工作区重渲染造出新的内联回调
         → SqlEditor 的 extensions 依赖里有这些回调,跟着重算
         → @uiw/react-codemirror 看到新数组,把整个 CodeMirror 重新配置一遍
       长文件里每按一次方向键都要跑完这条链。用户报过「滚动之后点一下,
       视图会跳回原来光标的位置」的偶发现象,这是最像的源头。

       这儿钉的是最根上那条:**值没变就不该产生新的 tabs 数组**(按引用比)。 */
    const tab = { id: 'sel', kind: 'query', connId: 'fixture', title: 'q', sql: 'SELECT 1', selectedSql: '', database: 'db' };
    useApp.setState({ tabs: [tab], activeTabId: 'sel', dirtyTabs: {}, showToast: () => {} });

    const before = useApp.getState().tabs;
    useApp.getState().updateSelection('sel', '');
    assert.equal(useApp.getState().tabs, before, '选区没变(都是空串)就不该重建 tabs —— 光标每动一下都会走这儿');

    useApp.getState().updateSelection('sel', 'SELECT 1');
    assert.notEqual(useApp.getState().tabs, before, '选区真变了当然要更新');
    assert.equal(useApp.getState().tabs[0].selectedSql, 'SELECT 1');

    const afterSel = useApp.getState().tabs;
    useApp.getState().updateSql('sel', 'SELECT 1');
    assert.equal(useApp.getState().tabs, afterSel, '正文没变也不该重建');
    useApp.getState().updateSql('sel', 'SELECT 2');
    assert.equal(useApp.getState().tabs[0].sql, 'SELECT 2', '正文变了要更新');

    useApp.getState().updateSelection('不存在的标签', 'x');
    assert.equal(useApp.getState().tabs.length, 1, '标签不存在时什么也别做');
  }

  // 编辑器的配置不该因为「哪个函数处理回车」换了身份就重来
  {
    const source = readFileSync(resolve('src/components/SqlEditor.tsx'), 'utf8');
    const deps = source.match(/\n\s*\[catalog[^\]]*\],\n\s*\);/);
    assert(deps, '没找到 extensions 的依赖数组');
    for (const cb of ['onRun', 'onSelectionChange', 'onChange', 'onAiInvoke']) {
      assert(!deps[0].includes(cb),
        `extensions 的依赖里不该有 ${cb} —— 父组件传的是内联箭头函数,` +
        '每次渲染都是新身份,列进去等于每次重渲染都把整个 CodeMirror 重新配置一遍(用 ref 存回调)');
    }
  }

  console.log('Session tests passed: tab order/active restore, discard semantics, reference-only snapshots, invalid storage, execution progress/errors/duplicate guard, independent result height, cursor-move does not rebuild tabs.');
} finally { rmSync(dir,{recursive:true,force:true}); }
