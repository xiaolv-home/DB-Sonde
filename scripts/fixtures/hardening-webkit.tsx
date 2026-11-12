// Isolated UI/security fixture. No saved user settings or database is opened.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import DateRangePicker from '../../src/features/dashboard/components/DateRangePicker';
import { useCloudSettingsDraft } from '../../src/features/ai/useCloudSettingsDraft';
import { useAi } from '../../src/features/ai/aiStore';
import { defaultAiConfig } from '../../src/features/ai/aiConfigModel';
import { initializeSecureRepositories } from '../../src/lib/secureRepository';
import { MONITOR_FRAME_SANDBOX } from '../../src/features/monitor/monitorModel';
import '../../src/styles.css';
import '../../src/features/dashboard/dashboard.css';
const qa = window as unknown as { webkit: {messageHandlers:{qa:{postMessage:(body:string)=>void}}}; fixtureInvoke: (cmd:string,args:Record<string,string>)=>Promise<unknown> };
const send = (data: unknown) => qa.webkit.messageHandlers.qa.postMessage(JSON.stringify(data));
const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const root = createRoot(document.getElementById('root')!, {onUncaughtError: error => send({error:String(error)})});
let writes: string[] = [], release: (()=>void) | undefined;
qa.fixtureInvoke = async (cmd,args) => {
  if (cmd === 'load_service_config') return null;
  if (cmd === 'save_service_config') {
    writes.push(args.value);
    await new Promise<void>(resolve => { release = resolve; });
    return null;
  }
  throw Error(`Unexpected ${cmd}`);
};
function Draft() {
  const draft = useCloudSettingsDraft();
  return <div><input id="key" type="password" value={draft.key} onChange={e=>draft.setKey(e.target.value)} />
    <button id="save" onClick={()=>{ void draft.save(); }}>Save</button></div>;
}
function CalendarFixture() {
  const [range,setRange] = useState(['2026-01-30','2026-01-31']);
  return <DateRangePicker start={range[0]} end={range[1]} onChange={(start,end)=>setRange([start,end])} />;
}
function input(value: string) {
  const field = document.getElementById('key') as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value);
  field.dispatchEvent(new Event('input',{bubbles:true}));
}
async function until(condition:()=>boolean, message:string) {
  for (let n=0;n<100;n++) { if (condition()) return; await sleep(20); }
  throw Error(message);
}
(async()=>{
  const tests: string[] = [];
  await initializeSecureRepositories();
  useAi.setState({config:{...defaultAiConfig(),provider:'cloud'}});
  root.render(<Draft />); await sleep(50);
  input('first-fixture-key'); await sleep(20);
  document.getElementById('save')!.click();
  await until(()=>writes.length===1,'first key did not save');
  check(useAi.getState().config.cloud.apiKey==='','typed key entered shared state');
  input('second-fixture-key'); await sleep(20);
  release!(); await sleep(50);
  check((document.getElementById('key') as HTMLInputElement).value==='second-fixture-key','late save erased a newer key draft');
  document.getElementById('save')!.click(); await until(()=>writes.length===2,'second key did not save'); release!();
  await until(()=>(document.getElementById('key') as HTMLInputElement).value==='','saved draft did not clear');
  check(JSON.parse(writes[1]).cloud.apiKey==='second-fixture-key','latest key was not persisted');
  check(useAi.getState().config.cloud.apiKey==='','saved key entered shared state');
  tests.push('native settings: overlapping saves retain newer input; shared state stays masked');

  root.render(<CalendarFixture/>); await sleep(30);
  const trigger = document.querySelector<HTMLButtonElement>('.dash-daterange-trigger')!; trigger.click(); await sleep(40);
  check(document.querySelector('[role="dialog"]'),'calendar dialog semantics missing');
  check((document.activeElement as HTMLElement).dataset.date==='2026-01-31','calendar initial focus incorrect');
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})); await sleep(30);
  check((document.activeElement as HTMLElement).dataset.date==='2026-02-01','arrow did not cross month boundary');
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await sleep(30);
  check(!document.querySelector('[role="dialog"]'),'Escape did not close calendar');
  check(document.activeElement===trigger,'Escape did not restore trigger focus');
  tests.push('calendar: keyboard month crossing, Escape, focus restoration, dialog semantics');

  const violations: string[] = [];
  document.addEventListener('securitypolicyviolation',event=>violations.push(event.effectiveDirective));
  const script = document.createElement('script'); script.textContent='window.unsafeInlineRan=true'; document.body.append(script);
  let blocked = false;
  try { await fetch('http://example.invalid/fixture'); } catch { blocked = true; }
  await sleep(30);
  check(!(window as unknown as {unsafeInlineRan:boolean}).unsafeInlineRan,'inline script ran under production CSP');
  check(blocked && violations.includes('connect-src'),'renderer external fetch was not blocked');
  tests.push('production CSP: inline script and renderer external fetch blocked');

  let escaped = false, childSeen = false, privilegedFrame = false;
  window.addEventListener('message',event=> {
    if (event.data==='child-ready') childSeen=true;
    if (event.data==='escaped') escaped=true;
    if (event.data==='privileged-frame-ran') privilegedFrame=true;
  });
  const frame = document.createElement('iframe'); frame.sandbox.value = MONITOR_FRAME_SANDBOX;
  frame.src = location.href.replace('127.0.0.1','localhost').replace('/qa.html','/child.html'); document.body.append(frame);
  await until(()=>childSeen,'sandboxed remote frame did not load'); await sleep(300);
  check(!escaped && location.pathname==='/qa.html','monitor changed top window');
  check(!privilegedFrame,'application origin executed inside monitor frame');
  tests.push('monitor: remote scripts work, top navigation blocked, application frame rejected');
  send({tests});
})().catch(error=>send({error:String(error)}));
