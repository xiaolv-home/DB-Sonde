// 监控中心:接入的地址校验、存取往返、坏数据不认。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'sonde-monitor-'));
try {
  const outfile = join(dir, 't.cjs');
  await build({ entryPoints: [resolve('src/features/monitor/monitorModel.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
  const m = createRequire(import.meta.url)(outfile);

  // 地址:补协议、规范化;拒绝非 http(s) 和带账号密码的
  assert.deepEqual(m.checkUrl('192.0.2.10:18086'), { url: 'http://192.0.2.10:18086/' }, '没写协议默认 http');
  assert.deepEqual(m.checkUrl(' https://example.com/a?b=1 '), { url: 'https://example.com/a?b=1' });
  assert.deepEqual(m.checkUrl('example.com:8080/grafana'), { url: 'http://example.com:8080/grafana' }, '「example.com:」不是协议');
  assert.deepEqual(m.checkUrl('localhost:3000'), { url: 'http://localhost:3000/' });
  for (const bad of ['', 'file:///etc/passwd', 'javascript:alert(1)', 'tauri://localhost', 'http://u:p@192.0.2.10', 'ftp://x.com'])
    assert('error' in m.checkUrl(bad), `${bad || '(空)'} 应该被拒`);
  // 本应用自己的源不能进 iframe。Windows 看不见子框架导航,CSP frame-src 又放行 http:,
  // allow-scripts + allow-same-origin 碰到同源页面就能自己卸掉 sandbox。
  for (const bad of [
    'http://tauri.localhost/', 'https://tauri.localhost/index.html', 'http://tauri.localhost:8080/', 'http://tauri.localhost./',
    'http://ipc.localhost/plugin', 'https://ipc.localhost/', 'http://asset.localhost/icon.png', 'https://asset.localhost/',
    'tauri://localhost/', 'asset://localhost/icon.png', 'ipc://localhost/',
    'http://localhost:1420/', 'http://127.0.0.1:1420/index.html', 'http://127.0.0.1:01420/', 'http://[::1]:1420/',
  ]) {
    assert('error' in m.checkUrl(bad), `${bad} 应该被拒`);
    assert.equal(m.monitorFrameSrc(bad), null, `${bad} 不能成为 iframe src`);
  }
  assert.equal(m.monitorFrameSrc('http://localhost:3000/'), 'http://localhost:3000/', '别的端口上的本地监控页仍可嵌');
  assert.equal(m.monitorFrameSrc('http://127.0.0.1:3000/grafana'), 'http://127.0.0.1:3000/grafana');

  // 存取往返
  const a = m.newSource('ETL 运行台', m.checkUrl('192.0.2.10:18086').url);
  const b = m.newSource('', m.checkUrl('https://example.com').url);
  assert.equal(a.kind, 'web');
  assert(m.isMonitorList(JSON.parse(JSON.stringify([a, { ...b, name: m.defaultName(b.url) }]))), '存下去的读得回');
  assert.equal(m.defaultName('http://192.0.2.10:18086/'), '192.0.2.10:18086');

  // 坏数据不认
  assert(!m.isMonitorList([a, a]), 'id 重复');
  assert(!m.isMonitorSource({ ...a, kind: 'grafana' }), '不认识的接入方式');
  assert(!m.isMonitorSource({ ...a, url: 'file:///x' }), '非 http 地址');
  assert(!m.isMonitorSource({ ...a, url: 'http://192.0.2.10:18086' }), '没规范化的地址(缺结尾 /)');
  assert(!m.isMonitorSource({ ...a, id: '../main' }), 'id 只能是安全字符(要拼成原生视图的标签)');
  assert(!m.isMonitorSource({ ...a, name: ' ' }), '名字不能为空');

  // 数据资产里的每个中心都往同一个外壳里投内容,没选中时必须不画,
  // 否则切到别的中心会两块摞在一起(监控中心上线时就漏了这一句)。
  const hosts = readFileSync('src/features/FeatureHosts.tsx', 'utf8');
  const views = [...hosts.matchAll(/View: (\w+Center) \}/g)].map((x) => x[1]);
  assert(views.length >= 4, `应找到数据资产里的各个中心,只找到 ${views.length} 个`);
  for (const view of views) {
    const from = hosts.match(new RegExp(`import ${view} from "\\./([^"]+)"`))?.[1];
    assert(from, `找不到 ${view} 的来源`);
    const code = readFileSync(`src/features/${from}.tsx`, 'utf8');
    assert(/if \(!(\w+\.)?open\) return null;/.test(code), `${view} 没选中时没有 return null,会和别的中心摞在一起`);
  }
  // 工具条纯图标按钮:aria-label 和已有 title 是同一句中文
  const center = readFileSync('src/features/monitor/MonitorCenter.tsx', 'utf8');
  assert.match(center, /function iconName\(label: string\) \{\s*return \{ title: label, "aria-label": label \};/);
  const bar = center.slice(center.indexOf('<div className="mon-bar">'), center.indexOf('<div className="mon-stage"'));
  const labels = [...bar.matchAll(/iconName\("([^"]*)"\)/g)].map((x) => x[1]);
  assert.deepEqual(labels, [
    '页面列表(鼠标碰左边缘也会出来)',
    '重新载入(回到首页)',
    '在独立窗口打开',
    '在浏览器里打开',
    '退出全屏 (Esc)',
    '全屏',
  ]);
  assert.equal([...bar.matchAll(/<button\b/g)].length, labels.length);

  assert.match(readFileSync('index.html', 'utf8'), /<html lang="zh-CN">/);

  // iframe 只放开监控页实际要用的权限,不能把本窗口领走
  const tokens = m.MONITOR_FRAME_SANDBOX.split(/\s+/);
  assert.deepEqual(tokens, ['allow-scripts', 'allow-same-origin', 'allow-forms', 'allow-popups']);
  for (const banned of ['allow-top-navigation', 'allow-top-navigation-by-user-activation', 'allow-top-navigation-to-custom-protocols', 'allow-popups-to-escape-sandbox']) {
    assert.equal(tokens.includes(banned), false, banned);
  }
  const iframe = center.match(/<iframe\b[^>]*\/>/)?.[0];
  assert.ok(iframe, '找不到监控 iframe');
  assert.match(iframe, /title=\{active\.name\}/);
  assert.match(iframe, /src=\{embedSrc\}/);
  assert.match(center, /monitorFrameSrc\(active\.url\)/);
  assert.doesNotMatch(iframe, /src=\{active\.url\}/);
  assert.match(iframe, /sandbox=\{MONITOR_FRAME_SANDBOX\}/);
  assert.doesNotMatch(iframe, /allow-top-navigation/);

  console.log('monitor: 地址校验 / 存取往返 / 坏数据拒收 / 工具条名称 / sandbox 全部通过');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
