import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

  const secretChecks = [];
  api.hasSavedSecret = async (id) => { secretChecks.push(id); return id === 'saved' || id === 'local-file'; };
  const runPanel = async () => {
    globalThis.__startupEffects = [];
    QueryPanel();
    const cleanups = globalThis.__startupEffects.map(effect => effect());
    await tick();
    cleanups.forEach(cleanup => cleanup?.());
  };

  for (const kind of ['query', 'table', 'database', 'routine']) {
    const before = requests.length;
    const checks = secretChecks.length;
    const tab = { id: kind, kind, connId: 'saved', connName: 'saved', title: kind, database: 'fixture', schema: '', table: 'items', sql: 'SELECT 1' };
    useApp.setState({ tabs: [tab], activeTabId: tab.id, meta: {}, restoreNotice: {}, connecting: {} });
    await runPanel();
    if (kind === 'query') {
      assert.equal(requests.length, before, 'a query tab does not open a database by itself');
      assert.equal(secretChecks.length, checks, 'a query tab does not look up saved credentials');
    } else {
      assert.equal(secretChecks.length, checks + 1, `${kind} looks up credentials only when it is shown`);
      assert.equal(secretChecks.at(-1), 'saved');
      assert.equal(requests.length, before + 1, `${kind} connects when a secret is already saved`);
      assert.equal(requests.at(-1).id, 'saved');
      assert.equal(requests.at(-1).password, null, 'the saved secret stays in the backend');
      assert.equal(useApp.getState().restoreNotice.saved, undefined);
    }
  }

  requests.length = 0;
  secretChecks.length = 0;
  useApp.setState({
    meta: {},
    restoreNotice: {},
    connecting: {},
    tabs: [
      { id: 'later', kind: 'table', connId: 'offline', connName: 'offline', title: 'later', database: 'fixture', schema: '', table: 'hidden_table' },
      { id: 'now', kind: 'table', connId: 'saved', connName: 'saved', title: 'dim_stores', database: 'fixture', schema: '', table: 'dim_stores' },
    ],
    activeTabId: 'now',
  });
  await runPanel();
  assert.deepEqual(secretChecks, ['saved'], 'a restored tab that is not on screen does not connect');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].id, 'saved');
  assert(!useApp.getState().meta.offline);

  requests.length = 0;
  useApp.setState({
    meta: {}, restoreNotice: {}, connecting: {}, passwordPromptId: undefined,
    tabs: [{ id: 'locked', kind: 'table', connId: 'no-password', connName: 'no-password', title: 'dim_stores', database: 'fixture', schema: '', table: 'dim_stores' }],
    activeTabId: 'locked',
  });
  api.hasSavedSecret = async () => false;
  api.connect = async () => { requests.push('unwanted'); throw Error('should not connect'); };
  await runPanel();
  assert.equal(requests.length, 0, 'missing credentials stay on the card');
  assert.match(useApp.getState().restoreNotice['no-password'], /没有保存密码/);
  assert.equal(useApp.getState().passwordPromptId, undefined);
  assert(!useApp.getState().meta['no-password']);

  useApp.setState({
    meta: {}, restoreNotice: {}, connecting: {},
    tabs: [{ id: 'broken', kind: 'table', connId: 'saved', connName: 'saved', title: 'dim_stores', database: 'fixture', schema: '', table: 'dim_stores' }],
    activeTabId: 'broken',
  });
  api.hasSavedSecret = async () => true;
  api.connect = async (id, password) => {
    requests.push({ id, password });
    throw Error('auth failed via postgres://alice:hunter2-secret@db.internal/shop?password=hunter2-secret');
  };
  await runPanel();
  const failure = useApp.getState().restoreNotice.saved;
  assert.match(failure, /auth failed/);
  assert.match(failure, /••••/);
  assert.doesNotMatch(failure, /hunter2/, failure);
  assert.equal(useApp.getState().passwordPromptId, undefined, 'a failed restore does not cover the workspace with the password dialog');
  assert(!useApp.getState().meta.saved);

  requests.length = 0;
  let gate;
  api.hasSavedSecret = async () => true;
  api.connect = async (id, password) => { requests.push({ id, password }); await new Promise(r => { gate = r; }); return meta(id); };
  useApp.setState({ meta: {}, restoreNotice: {}, connecting: {} });
  const first = useApp.getState().openRestoredConnection('saved', () => true);
  const second = useApp.getState().openRestoredConnection('saved', () => true);
  await tick();
  assert.equal(requests.length, 1, 'one connection is not opened twice at the same time');
  assert.equal(requests[0].password, null);
  gate(); await first; await second;

  requests.length = 0;
  let answer;
  api.hasSavedSecret = () => new Promise(resolve => { answer = resolve; });
  api.connect = async () => { requests.push('left'); return meta('offline'); };
  const abandoned = useApp.getState().openRestoredConnection('offline', () => false);
  answer(true);
  await abandoned;
  assert.equal(requests.length, 0, 'leaving the tab before the check finishes does not connect');

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

  const css = readFileSync(new URL('../src/styles/tabs.css', import.meta.url), 'utf8');
  const cardRule = css.match(/\.disconnected \{[^}]+\}/)?.[0] ?? '';
  assert.match(cardRule, /flex:\s*1/, cardRule);
  assert.doesNotMatch(cardRule, /position:\s*(absolute|fixed)/);
  assert.doesNotMatch(cardRule, /inset/);
  assert.doesNotMatch(cardRule, /pointer-events/);
  assert.match(css, /\.workspace-pane \{[^}]*position:\s*relative/);

  const viewFile = join(dir, 'view.cjs');
  await build({
    stdin: {
      contents: `import React from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { useApp } from './src/store/appStore';
        import QueryPanel from './src/components/QueryPanel';
        globalThis.__sondeStore = useApp;
        export function renderCard() {
          return renderToStaticMarkup(React.createElement('div', { className: 'app' },
            React.createElement('button', { className: 'toolbar-stub', type: 'button' }, 'top'),
            React.createElement('button', { className: 'sidebar-stub', type: 'button' }, 'side'),
            React.createElement(QueryPanel)));
        }
        export { useApp };`,
      resolveDir: resolve('.'),
      loader: 'tsx',
    },
    outfile: viewFile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: 'card-view', setup(b) {
      b.onResolve({ filter: /.*/ }, args => {
        if (!args.importer.endsWith('/components/QueryPanel.tsx')) return;
        if (args.path === '../store/appStore') return { path: 'store', namespace: 'card' };
        if (args.path === '../hooks/useI18n') return { path: 'i18n', namespace: 'card' };
        if (args.path === './WorkspaceTabBar') return { path: 'tabs', namespace: 'card' };
        if (args.path === './PanelErrorBoundary') return { path: 'boundary', namespace: 'card' };
        if (args.path.startsWith('.')) return { path: 'child', namespace: 'card' };
      });
      b.onLoad({ filter: /.*/, namespace: 'card' }, args => ({
        contents: args.path === 'store'
          ? 'function useApp(selector) { const state = globalThis.__sondeStore.getState(); return typeof selector === "function" ? selector(state) : state; } useApp.getState = () => globalThis.__sondeStore.getState(); export { useApp };'
          : args.path === 'i18n'
          ? 'export const useI18n = () => ({ t: (key) => key });'
          : args.path === 'tabs'
            ? 'import React from "react"; export default function WorkspaceTabBar() { return React.createElement("button", { className: "tabbar-stub", type: "button" }, "tabs"); }'
            : args.path === 'boundary'
              ? 'export default function Boundary(props) { return props.children; }'
              : 'export default function Child() { return null; }',
        loader: 'js',
        resolveDir: resolve('.'),
      }));
    } }],
  });
  const view = createRequire(import.meta.url)(viewFile);
  view.useApp.setState({
    language: 'zh-CN',
    tabs: [{ id: 'table', kind: 'table', connId: 'saved', connName: 'warehouse', title: 'dim_stores', database: 'shop', schema: '', table: 'dim_stores' }],
    activeTabId: 'table',
    meta: {},
    connecting: {},
    restoreNotice: { saved: '登录失败，请检查网络' },
  });
  const html = view.renderCard();
  const cardAt = html.indexOf('class="disconnected"');
  const paneAt = html.indexOf('workspace-pane');
  const tabAt = html.indexOf('tabbar-stub');
  const sideAt = html.indexOf('sidebar-stub');
  const topAt = html.indexOf('toolbar-stub');
  assert.ok(cardAt > paneAt && paneAt > tabAt, html);
  assert.ok(topAt !== -1 && sideAt !== -1 && topAt < cardAt && sideAt < cardAt, html);
  assert.match(html, /登录失败，请检查网络/);
  assert.doesNotMatch(html.slice(cardAt), /toolbar-stub|sidebar-stub|tabbar-stub/);
  console.log('Restored tabs connect lazily when a secret is saved; the card stays in the tab and reports failures without a password.');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
