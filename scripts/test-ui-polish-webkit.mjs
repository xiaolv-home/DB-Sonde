// Opt-in macOS integration test: real surfaces, portals, tabs and WKWebView.
// Synthetic backend only; isolated browser storage, no user database access.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
if (process.platform !== 'darwin') { console.log('skipped: ui-polish-webkit requires macOS'); process.exit(0); }
const dir = mkdtempSync(join(tmpdir(), 'sonde-ui-polish-webkit-'));
try {
  await build({ entryPoints: ['scripts/fixtures/ui-polish-webkit.tsx'], bundle: true, target: 'safari16',
    outfile: join(dir, 'qa.js'), banner: {js:'try {'}, footer: {js:'} catch(error) { window.webkit.messageHandlers.qa.postMessage(JSON.stringify({error:String(error.stack || error)})); }'}, external: ['virtual:echarts-standalone'],
    plugins: [{ name: 'inline-assets', setup(b) {
      // These workspaces are not part of a restored table's path.
      b.onResolve({filter: /(?:SqlWorkspace|PythonPanel|DashboardWorkspace|AnalysisWorkspace)$/}, () => ({path:'unused-workspace',namespace:'unused'}));
      b.onLoad({filter: /.*/, namespace:'unused'}, () => ({contents:'export default function UnusedWorkspace() { return null; }',loader:'js'}));
      b.onResolve({filter: /\?(raw|inline-min)$/}, args => ({path: resolve(args.resolveDir, args.path.split('?')[0]), namespace:'inline'}));
      b.onLoad({filter: /.*/, namespace:'inline'}, args => ({contents: `export default ${JSON.stringify(readFileSync(args.path,'utf8'))}`, loader:'js'}));
    }}], loader: { '.woff2': 'file', '.woff': 'file' }, logLevel: 'silent' });
  const script = readFileSync(join(dir, 'qa.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  writeFileSync(join(dir, 'qa.html'), `<html><head><link rel="stylesheet" href="qa.css"></head><body><div id="root"></div><script>window.onerror=(message,source,line,column,error)=>window.webkit.messageHandlers.qa.postMessage(JSON.stringify({error:String(error?.stack || message)}));</script><script>${script}</script></body></html>`);
  execFileSync('swiftc', ['-module-cache-path', join(dir, 'cache'), 'scripts/fixtures/webkit.swift', '-o', join(dir, 'webkit')], { timeout: 120000 });
  const output = execFileSync(join(dir, 'webkit'), [join(dir, 'qa.html')], { encoding: 'utf8', timeout: 45000 });
  const report = JSON.parse(output.trim());
  assert(!report.error, report.error);
  assert.equal(report.tests.length, 6);
  report.tests.forEach(test => console.log(test));
} finally { rmSync(dir, { recursive: true, force: true }); }
