// Synthetic UI only. WKWebView uses non-persistent storage; no database is opened.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useDismissTransition } from '../../src/hooks/useDismissTransition';
import AssetShell, { AssetChromeHost, openAsset } from '../../src/features/assets/AssetShell';
import { useDatasets } from '../../src/features/datasets/datasetsStore';
import { useMetrics } from '../../src/features/metrics/metricsStore';
import ConnectionDialog from '../../src/components/ConnectionDialog';
import WorkspaceTabBar from '../../src/components/WorkspaceTabBar';
import { useApp } from '../../src/store/appStore';
import '../../src/styles.css';
import '../../src/motion.css';
const send = (value: unknown) => (window as any).webkit.messageHandlers.qa.postMessage(JSON.stringify(value));
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
const sleep = (ms: number) => new Promise(resolve=>setTimeout(resolve,ms));
const root = createRoot(document.getElementById('root')!, {onUncaughtError:error=>send({error:String(error)})});
let closed = 0;
function Surface({close}: {close:()=>void}) {
  const {ref,closing,dismiss} = useDismissTransition(close);
  return <div id="surface" ref={ref} inert={closing} className="modal-backdrop"><div className="modal"><input defaultValue="keep this draft"/><button id="dismiss" onClick={dismiss}>Close</button></div></div>;
}
function DismissFixture() {
  const [open,setOpen] = useState(true);
  return open ? <Surface close={()=>{closed++;setOpen(false);}}/> : null;
}
function AssetsFixture() {
  const datasets = useDatasets(s=>s.open), metrics = useMetrics(s=>s.open);
  const section = datasets ? 'datasets' : metrics ? 'metrics' : null;
  return <AssetChromeHost section={section}><AssetShell title={section ?? 'closed'}><input id="asset-draft" defaultValue="retained content"/></AssetShell></AssetChromeHost>;
}
(async()=>{
  const tests: string[] = [];
  root.render(<React.StrictMode><DismissFixture key="first"/></React.StrictMode>);await sleep(260);
  const surface = document.querySelector<HTMLElement>('#surface')!;
  const closeButton = document.querySelector<HTMLButtonElement>('#dismiss')!;
  closeButton.click();closeButton.click();await sleep(60);
  const opacity = Number(getComputedStyle(surface).opacity);
  check(surface.isConnected && opacity>0 && opacity<1,'dismiss must fade the existing surface');
  check(surface.inert && surface.querySelector('input')?.value==='keep this draft','closing must keep draft and prevent duplicate interactions');
  await sleep(200);check(!surface.isConnected && closed===1,'dismiss must complete once');
  tests.push('dismiss: original content fades continuously; repeated close runs once');

  root.render(<DismissFixture key="cancelled"/>);await sleep(240);
  document.querySelector<HTMLButtonElement>('#dismiss')!.click();root.render(<div>new surface</div>);await sleep(230);
  check(closed===1,'unmount must cancel the old dismissal');
  tests.push('dismiss: cancelled animation cannot dismiss a newer surface');

  const originalMatchMedia = window.matchMedia;
  window.matchMedia = ((query:string)=>query.includes('prefers-reduced-motion') ? {matches:true} : originalMatchMedia.call(window,query)) as typeof window.matchMedia;
  root.render(<DismissFixture key="reduced"/>);await sleep(40);
  document.querySelector<HTMLButtonElement>('#dismiss')!.click();await sleep(20);
  check(closed===2 && !document.querySelector('#surface'),'reduced motion must dismiss immediately');
  window.matchMedia = originalMatchMedia;
  tests.push('dismiss: system reduced-motion preference skips animation');

  openAsset('datasets');root.render(<React.StrictMode><AssetsFixture/></React.StrictMode>);await sleep(300);
  const overlay = document.querySelector('.asset-overlay');
  document.querySelector<HTMLButtonElement>('.asset-nav[data-pill="metrics"]')!.click();await sleep(40);
  check(document.querySelector('.asset-overlay')===overlay,'asset navigation must retain its chrome');
  document.querySelector<HTMLButtonElement>('.asset-head button[title="关闭"]')!.click();await sleep(50);
  check(document.querySelector<HTMLInputElement>('#asset-draft')?.value==='retained content','portal content disappeared before its shell');
  await sleep(200);check(!document.querySelector('.asset-overlay'),'portal close did not dismiss its owner');
  openAsset('datasets');await sleep(250);
  document.querySelector<HTMLButtonElement>('.asset-head button[title="关闭"]')!.click();await sleep(250);
  check(!document.querySelector('.asset-overlay'),'reopening must reset the dismissal state');
  tests.push('assets: stable navigation, intact portal during fade, reopen and close');

  const tab = {kind:'table',connId:'fixture',connName:'Demo',database:'demo',schema:'',table:'items',objectKind:'table'} as const;
  useApp.setState({tabs:[{...tab,id:'foreground',title:'Foreground'},{...tab,id:'background',title:'Background'}],activeTabId:'foreground',dirtyTabs:{},savedQueries:[]});
  root.render(<WorkspaceTabBar/>);await sleep(100);
  const selected: string[] = [];
  const unsubscribe = useApp.subscribe(s=>selected.push(s.activeTabId));
  const backgroundClose = document.querySelector<HTMLButtonElement>('[data-pill="background"] .qt-close')!;
  check(backgroundClose.tagName==='BUTTON' && !!backgroundClose.getAttribute('aria-label'),'close must be a labelled keyboard button');
  backgroundClose.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));backgroundClose.click();await sleep(40);unsubscribe();
  check(!selected.includes('background') && useApp.getState().activeTabId==='foreground','closing a background tab must never activate it');
  check(useApp.getState().tabs.length===1,'close must still remove the requested tab');
  tests.push('tabs: accessible close removes background tab without flashing its workspace');
  useApp.setState({dialogOpen:true,dialogEditing:undefined});
  root.render(<ConnectionDialog/>);await sleep(260);
  const form = document.querySelector<HTMLElement>('.modal')!;
  const body = document.querySelector<HTMLElement>('.modal-body')!;
  const foot = document.querySelector<HTMLElement>('.modal-foot')!;
  form.style.maxHeight = '400px';await sleep(30);
  check(foot.getBoundingClientRect().bottom <= form.getBoundingClientRect().bottom + 1,'form actions escaped the modal');
  check(body.scrollHeight > body.clientHeight && getComputedStyle(body).overflowY==='auto','long form must scroll inside fixed actions');
  check(form.getBoundingClientRect().bottom < window.innerHeight,'modal escaped viewport');
  tests.push('forms: long content scrolls while title and actions stay visible');
  send({tests});
})().catch(error=>send({error:String(error)}));
