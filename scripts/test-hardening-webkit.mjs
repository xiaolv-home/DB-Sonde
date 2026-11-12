import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
if (process.platform !== 'darwin') { console.log('skipped: hardening-webkit requires macOS'); process.exit(0); }
const run = promisify(execFile), dir = mkdtempSync(join(tmpdir(),'sonde-hardening-webkit-'));
let server;
try {
  await build({entryPoints:['scripts/fixtures/hardening-webkit.tsx'],bundle:true,target:'safari16',outfile:join(dir,'qa.js'),
    loader:{'.woff2':'file','.woff':'file'},logLevel:'silent',
    plugins:[{name:'native-port',setup(b){
      b.onResolve({filter:/^@tauri-apps\/api\/core$/},()=>({path:'core',namespace:'fixture'}));
      b.onResolve({filter:/mockBackend$/},()=>({path:'mock',namespace:'fixture'}));
      b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents: args.path==='core'
        ? 'export class Channel {} export const isTauri=()=>true; export const invoke=(cmd,args)=>window.fixtureInvoke(cmd,args);'
        : 'export const inTauri=true;',loader:'js'}));
    }}]});
  const csp = JSON.parse(readFileSync('src-tauri/tauri.conf.json','utf8')).app.security.csp;
  server = createServer((req,res)=>{
    if (req.url==='/child.html') {
      const app = `http://127.0.0.1:${server.address().port}`;
      res.setHeader('Content-Type','text/html');
      res.end(`<script>try{top.location='https://example.invalid/';top.postMessage('escaped','*')}catch(e){}top.postMessage('child-ready','*');</script><iframe src="${app}/privileged.html"></iframe>`);
    } else if (req.url==='/privileged.html') {
      res.setHeader('Content-Security-Policy',"frame-ancestors 'none'");
      res.setHeader('Content-Type','text/html'); res.end("<script>top.postMessage('privileged-frame-ran','*')</script>");
    } else if (req.url==='/qa.html') {
      res.setHeader('Content-Security-Policy',csp); res.setHeader('Content-Type','text/html');
      res.end('<html><head><link rel="stylesheet" href="/qa.css"></head><body><div id="root"></div><script src="/qa.js"></script></body></html>');
    } else {
      const name = req.url.slice(1);
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) { res.writeHead(404);res.end();return; }
      try { res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'font/woff2'); res.end(readFileSync(join(dir,name))); }
      catch { res.writeHead(404);res.end(); }
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const swift = readFileSync('scripts/fixtures/webkit.swift','utf8').replace('let url=URL(fileURLWithPath:CommandLine.arguments[1]);web.loadFileURL(url,allowingReadAccessTo:url.deletingLastPathComponent())', 'let url=URL(string:CommandLine.arguments[1])!;web.load(URLRequest(url:url))');
  writeFileSync(join(dir,'test.swift'),swift);
  await run('swiftc',['-module-cache-path',join(dir,'cache'),join(dir,'test.swift'),'-o',join(dir,'webkit')],{timeout:120000});
  const {stdout} = await run(join(dir,'webkit'),[`http://127.0.0.1:${server.address().port}/qa.html`],{timeout:45000});
  const report = JSON.parse(stdout.trim()); assert(!report.error,report.error); assert.equal(report.tests.length,4);
  report.tests.forEach(test=>console.log(test));
} finally {server?.close();rmSync(dir,{recursive:true,force:true});}
