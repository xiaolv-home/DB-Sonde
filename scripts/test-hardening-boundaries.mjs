import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const dir = mkdtempSync(join(tmpdir(), 'sonde-boundaries-'));
try {
  const file = join(dir, 'test.cjs');
  buildSync({stdin:{contents:`export * from './src/features/dashboard/components/calendarKeyboard';
    export * from './src/features/agent/drillTimeAlignment';
    export * from './src/lib/databaseDialect';
    export * from './src/features/monitor/monitorModel';
    export * from './src/features/ai/aiRuntime';
    export * from './src/features/ai/aiConfigModel';
    export * from './src/lib/secureRepository';`, resolveDir:resolve('.'),loader:'ts'},
    bundle:true,platform:'node',format:'cjs',outfile:file,logLevel:'silent'});
  const m = createRequire(import.meta.url)(file);
  for (const kind of ['oracle','clickhouse']) assert.throws(() => m.requireReadOnlyAnalysis(kind), /只读分析/);
  for (const kind of ['mysql','mariadb','postgres','sqlite']) assert.equal(m.readOnlyAnalysisProblem(kind), null);
  for (const url of ['http://tauri.localhost/','https://ipc.localhost/','http://localhost:1420/','http://[::1]:1420/']) {
    assert.equal(m.monitorFrameSrc(url), null);
  }
  assert.equal(m.monitorFrameSrc('http://192.0.2.2:8080'), 'http://192.0.2.2:8080/');
  assert(!m.MONITOR_FRAME_SANDBOX.includes('allow-top-navigation'));
  const date = new Date(2026, 0, 31);
  assert.equal(m.moveCalendarCursor('day', date, 'ArrowRight').getMonth(), 1);
  assert.equal(m.moveCalendarCursor('day', date, 'PageDown').getDate(), 28);
  assert.equal(m.moveCalendarCursor('month', date, 'ArrowDown').getMonth(), 3);
  assert.equal(m.moveCalendarCursor('year', date, 'PageUp').getFullYear(), 2014);
  const points = keys => keys.map((key,i) => ({key,value:i+1}));
  const pairs = m.alignByDateKey(points(['2026-W41','2026-W43']), points(['2026-W37','2026-W38','2026-W39']), 'week',
    {start:'2026-10-05',end:'2026-10-25'}, {start:'2026-09-07',end:'2026-09-27'});
  assert.deepEqual(pairs.map(p => [p.now.key,p.then.key]), [['2026-W41','2026-W37'],['2026-W43','2026-W39']]);
  assert.equal(m.alignByDateKey(points(['bad-a','bad-b']),points(['bad-c','bad-d']),'day'),null);
  // Async writes must never publish the typed secret; a failed write restores the previous masked config.
  let saved = m.defaultAiConfig(), finish, reject;
  const repo = {load:()=>saved, save:value => new Promise((resolve, no) => {finish=()=>{saved=value;resolve();};reject=no;})};
  const present = config => JSON.parse(m.presentServiceConfig('ai.config', JSON.stringify(config)));
  const store = m.createAiStore(repo,present);
  const pending = store.getState().updateCloud({apiKey:'fixture-key',hasKey:true});
  assert.equal(store.getState().config.cloud.apiKey,'');
  assert.equal(store.getState().config.cloud.hasKey,true);
  finish(); assert.equal(await pending,true);
  const failed = store.getState().updateCloud({apiKey:'replacement-key',hasKey:true});
  reject(Error('disk failure')); assert.equal(await failed,false);
  assert.equal(store.getState().config.cloud.apiKey,'');
  assert.equal(store.getState().config.cloud.hasKey,true);
  const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json','utf8'));
  assert.match(conf.app.security.csp, /script-src 'self';/);
  assert(!/script-src[^;]*unsafe/.test(conf.app.security.csp));
  assert.match(conf.app.security.csp,/frame-ancestors 'none'/);
  console.log('capabilities, calendar movement, gapped ISO weeks, masked asynchronous settings, CSP: passed');
} finally { rmSync(dir,{recursive:true,force:true}); }
