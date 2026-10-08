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
  assert(views.length >= 6, `应找到数据资产里的各个中心,只找到 ${views.length} 个`);
  for (const view of views) {
    const from = hosts.match(new RegExp(`import ${view} from "\\./([^"]+)"`))?.[1];
    assert(from, `找不到 ${view} 的来源`);
    const code = readFileSync(`src/features/${from}.tsx`, 'utf8');
    assert(/if \(!(\w+\.)?open\) return null;/.test(code), `${view} 没选中时没有 return null,会和别的中心摞在一起`);
  }
  console.log('monitor: 地址校验 / 存取往返 / 坏数据拒收 全部通过');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
