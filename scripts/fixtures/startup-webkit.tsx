import React from 'react';
import { createRoot } from 'react-dom/client';
import QueryPanel from '../../src/components/QueryPanel';
import { useApp } from '../../src/store/appStore';
import { api } from '../../src/lib/api';
import '../../src/styles.css';
import '../../src/motion.css';
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
const send = (value: unknown) => (window as any).webkit.messageHandlers.qa.postMessage(JSON.stringify(value));
const root = createRoot(document.getElementById('root')!, { onUncaughtError: error => send({error:String(error)}), onCaughtError: error => send({error:String(error)}) });
const profile = { id: 'fixture', name: 'Demo', kind: 'mysql', host: 'fixture.invalid', port: 3306, username: 'fixture' } as const;
const meta = { id: 'fixture', kind: 'mysql', hasMultipleDatabases: false, currentDatabase: 'demo' } as any;
const tab = { id: 'fixture-tab', kind: 'table', connId: 'fixture', connName: 'Demo', database: 'demo', schema: '', table: 'items', title: 'items', objectKind: 'table' } as const;
const phase = () => document.querySelector<HTMLElement>('[data-opening-phase]')?.dataset.openingPhase;
async function until(test: () => boolean, message: string) {
  for (let i = 0; i < 150; i++) { if (test()) return; await sleep(20); }
  throw Error(message);
}
let clicks = 0, requests = 0;
function Shell() {
  return <div className="app"><header className="toolbar"><button id="navigation" onClick={() => clicks++}>Assets</button></header>
    <div style={{display:'flex',flex:1,minHeight:0}}><aside style={{width:180}}><button>Other connection</button></aside><QueryPanel /></div></div>;
}
function navigationAvailable() {
  const button = document.querySelector<HTMLButtonElement>('#navigation')!;
  const box = button.getBoundingClientRect();
  check(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === button, 'loading/error must not cover navigation');
  const before = clicks; button.click(); check(clicks === before + 1, 'navigation stays interactive');
}
async function mount(name: string, connectDelay: number, metadataDelay: number, failure?: string) {
  api.listConnections = async () => [profile];
  api.connect = async () => { requests++; await sleep(connectDelay); if (failure) throw Error(failure); return meta; };
  api.listColumns = async () => { await sleep(metadataDelay); return [{name:'category',dataType:'text'}] as any; };
  api.listIndexes = async () => [];
  api.getObjectDdl = async () => 'CREATE TABLE items(category TEXT)';
  api.listTables = async () => [];
  useApp.setState({ connections: [], connectionsReady: false, connectionsError: undefined, restoreNotice: {}, meta: {}, connecting: {},
    nodes: {}, rootKeys: [], tabs: [tab], activeTabId: tab.id, passwordPromptId: undefined,
    language: 'zh-CN', loadChildren: async () => {}, loadCatalog: async () => {}, showToast: () => {} });
  root.render(<React.StrictMode><Shell key={name} /></React.StrictMode>);
  await sleep(30);
  await useApp.getState().init();
}
(async () => {
  const tests: string[] = [];
  await mount('fast', 10, 10);
  await until(() => phase() === 'done', 'fast page did not finish');
  check(!document.querySelector('.workspace-opening-cover'), 'fast connections skip the loader');
  check(document.querySelector('.object-grid'), 'fast path has the completed table');
  navigationAvailable(); tests.push('fast: completed page, no loader flash');

  const startCount = requests;
  await mount('slow', 350, 320);
  await until(() => phase() === 'visible', 'slow connection did not show loader');
  const visibleAt = performance.now(), cover = document.querySelector('.workspace-opening-cover');
  navigationAvailable();
  await until(() => !!useApp.getState().meta.fixture, 'connection not completed');
  check(phase() === 'visible', 'connection completion must not remove the first-screen loader');
  check(document.querySelector('.workspace-opening-cover') === cover, 'same loader spans connection and metadata');
  check(document.querySelector('.workspace-opening-page')?.hasAttribute('inert'), 'incomplete metadata is hidden');
  await until(() => phase() === 'leaving', 'loader did not begin crossfade');
  check(performance.now() - visibleAt >= 550, 'visible loader must not flash away immediately');
  check(document.querySelector('.object-grid'), 'metadata must be ready before revealing content');
  check(requests === startCount + 1, 'StrictMode must not connect twice');
  const page = document.querySelector('.workspace-opening-page')!;
  const firstOpacity = Number(getComputedStyle(page).opacity);
  await sleep(100);
  const nextOpacity = Number(getComputedStyle(page).opacity);
  check(nextOpacity > firstOpacity && nextOpacity < 1, 'content fades in smoothly, not an instant replacement');
  await until(() => phase() === 'done', 'crossfade did not finish');
  check(document.querySelector('.workspace-opening-page') === page, 'revealing content does not remount it');
  tests.push('slow: one stable loader through first screen, minimum visibility, smooth crossfade');

  for (const failure of ['CREDENTIAL_REQUIRED', 'CREDENTIAL_REJECTED', 'offline']) {
    await mount(failure, 20, 0, failure);
    await until(() => phase() === 'done', 'failure did not expose recovery');
    check(document.querySelector('.disconnected-card'), 'failure needs inline retry');
    check(!useApp.getState().passwordPromptId, 'failure cannot open a global password dialog');
    navigationAvailable(); tests.push(`${failure}: inline retry, global navigation usable`);
  }
  send({tests});
})().catch(error => send({error:String(error)}));
