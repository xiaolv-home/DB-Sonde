import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'sonde-startup-'));
const tick = () => new Promise(r => setImmediate(r));
try {
  const outfile = join(dir, 'tests.cjs');
  await build({
    stdin: { contents: "export {useApp} from './src/store/appStore'; export {api} from './src/lib/api'; export {default as QueryPanel} from './src/components/QueryPanel';", resolveDir: resolve('.'), loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    // Run the real QueryPanel effects, keeping unrelated editors unmounted.
    // The real store and API are shared by the component and the assertions.
    plugins: [{ name: 'startup-effects', setup(b) {
      b.onResolve({ filter: /.*/ }, args => {
        if (!args.importer.endsWith('/components/QueryPanel.tsx')) return;
        if (args.path === 'react') return { path: 'hooks', namespace: 'startup-fixture' };
        if (args.path === '../store/appStore') return { path: 'store', namespace: 'startup-fixture' };
        if (args.path.startsWith('.')) return { path: 'child', namespace: 'startup-fixture' };
      });
      b.onLoad({ filter: /.*/, namespace: 'startup-fixture' }, args => ({
        contents: args.path === 'hooks' ? `
          export * from 'react';
          export const useEffect = effect => globalThis.__startupEffects.push(effect);
          export const useState = initial => [typeof initial === 'function' ? initial() : initial, () => {}];
          export const useRef = initial => ({ current: initial });
        ` : args.path === 'store' ? `
          import {useApp as store} from ${JSON.stringify(resolve('src/store/appStore.ts'))};
          export const useApp = Object.assign(selector => selector(store.getState()), {getState: store.getState});
        ` : 'export default function Child() { return null; } export const useI18n = () => ({t: key => key});',
        loader: 'js', resolveDir: resolve('.'),
      }));
    } }],
  });
  const storage = new Map();
  globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  globalThis.document = { documentElement: { setAttribute() {}, removeAttribute() {}, lang: '' } };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const { useApp, api, QueryPanel } = createRequire(import.meta.url)(outfile);
  const profiles = ['saved', 'no-password', 'changed-password', 'offline', 'local-file'].map(id => ({
    id, name: id, kind: id === 'local-file' ? 'sqlite' : 'mysql', host: 'fixture.invalid', port: 3306, username: 'fixture',
  }));
  const meta = id => ({ id, kind: 'mysql', hasMultipleDatabases: false, currentDatabase: 'fixture' });
  const requests = [], toasts = [];
  api.listConnections = async () => profiles;
  api.connect = async (id, password) => { requests.push({ id, password }); return meta(id); };
  useApp.setState({ language: 'zh-CN', loadChildren: async () => {}, loadCatalog: async () => {}, showToast: toast => toasts.push(toast) });

  await Promise.all([useApp.getState().init(), useApp.getState().init()]);
  await tick();
  assert.equal(useApp.getState().connections.length, profiles.length, 'saved profiles remain available for manual connection');
  assert.equal(requests.length, 0, 'startup must not use saved credentials or open SQLite files');
  assert.deepEqual(useApp.getState().meta, {});
  assert.equal(toasts.length, 0);
  assert.equal(useApp.getState().passwordPromptId, undefined);

  const runPanel = async () => {
    globalThis.__startupEffects = [];
    QueryPanel();
    const cleanups = globalThis.__startupEffects.map(effect => effect());
    await tick();
    cleanups.forEach(cleanup => cleanup?.());
  };
  const tab = (kind, id = 'saved') => ({ id: kind, kind, connId: id, connName: id, title: kind, database: 'fixture', schema: '', table: 'items', sql: 'SELECT 1' });
  let releaseProfiles;
  api.listConnections = () => new Promise(resolve => { releaseProfiles = resolve; });
  useApp.setState({ connections: [], connectionsReady: false, tabs: [tab('table')], activeTabId: 'table' });
  const initializing = useApp.getState().init();
  await runPanel();
  assert.equal(requests.length, 0, 'restoration waits for connection profiles');
  releaseProfiles(profiles); await initializing;
  await runPanel();
  assert.equal(requests.length, 1, 'cold launch automatically resumes after profiles arrive');
  assert.equal(toasts.length, 0, 'normal automatic connection does not flash a success toast');
  api.listConnections = async () => profiles;
  for (const kind of ['query', 'table', 'database', 'routine']) {
    requests.length = 0;
    useApp.setState({ tabs: [tab(kind), tab('hidden', 'offline')], activeTabId: kind, meta: {}, connecting: {} });
    await runPanel();
    assert.deepEqual(requests, [{ id: 'saved', password: null }], 'only the visible tab connects; credentials stay in backend');
    await runPanel();
    assert.equal(requests.length, 1, 'already connected tabs do not reconnect');
  }
  for (const [id, error] of [['no-password', 'CREDENTIAL_REQUIRED'], ['changed-password', 'CREDENTIAL_REJECTED'], ['offline', 'offline with secret']]) {
    useApp.setState({ tabs: [tab('table', id)], activeTabId: 'table', meta: {}, passwordPromptId: undefined });
    api.connect = async () => { throw Error(error); };
    await runPanel();
    assert(useApp.getState().restoreNotice[id], 'automatic failure has an inline recovery message');
    assert.equal(useApp.getState().passwordPromptId, undefined, 'automatic restoration cannot lock global navigation');
    assert(!useApp.getState().restoreNotice[id].includes('secret'));
  }
  useApp.setState({ connectionsReady: false });
  api.listConnections = async () => { throw Error('fixture list failure'); };
  await useApp.getState().init();
  assert(useApp.getState().connectionsError, 'failed profile load is retryable, not an endless loader');
  api.listConnections = async () => profiles;
  await useApp.getState().init();
  assert.equal(useApp.getState().connectionsError, undefined);
  requests.length = 0;
  let release;
  api.connect = async (id, password) => { requests.push({ id, password }); await new Promise(r => { release = r; }); return meta(id); };
  const pending = useApp.getState().connect('saved');
  await useApp.getState().connect('saved');
  assert.equal(requests.length, 1, 'duplicate manual clicks share one in-flight attempt');
  assert.equal(requests[0].password, null, 'explicit connection can still reuse encrypted backend credentials');
  release(); await pending;
  assert(useApp.getState().meta.saved);
  api.disconnect = async () => {};
  await useApp.getState().disconnect('saved');
  await useApp.getState().init();
  await tick();
  assert.equal(requests.length, 1, 'refresh must not reconnect a disconnected database');

  for (const [id, error] of [['no-password', 'CREDENTIAL_REQUIRED'], ['changed-password', 'CREDENTIAL_REJECTED']]) {
    api.connect = async () => { throw Error(error); };
    await useApp.getState().connect(id);
    assert.equal(useApp.getState().passwordPromptId, id, 'manual connection retains its password prompt');
  }
  api.connect = async (id, password) => { assert.equal(password, 'fixture-replacement'); return meta(id); };
  await useApp.getState().connect('changed-password', 'fixture-replacement');
  assert(useApp.getState().meta['changed-password']);
  assert.equal(useApp.getState().passwordPromptId, undefined);
  api.connect = async () => { throw Error('fixture offline'); };
  await assert.rejects(useApp.getState().connect('offline'), /fixture offline/);
  assert(!Object.values(useApp.getState().connecting).some(Boolean));
  console.log('Startup passed: active tab restores after profiles, failures stay inline, manual recovery and duplicate prevention preserved.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
