/* 测试脚本共用:把要测的前端模块用 esbuild 打成一个 node 能 require 的包。
 *
 *   const m = loadSrc('dashboard', {
 *     'src/features/dashboard/semantic.ts': '*',
 *     'src/features/dashboard/dashboardService.ts': '* as dash',
 *     'src/lib/api.ts': '{ api }',
 *   });
 *
 * 值就是 `export … from` 里 export 和 from 之间那一段。产物放在临时目录里,进程退出时删掉。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';

export function loadSrc(name, modules) {
  const dir = mkdtempSync(join(tmpdir(), `sonde-${name}-`));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, Object.entries(modules)
    .map(([path, spec]) => `export ${spec} from ${JSON.stringify(resolve(path))};`).join('\n'));
  const outfile = join(dir, 'bundle.cjs');
  buildSync({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  // 被测模块里有 zustand store,模块一加载就读 localStorage;node 上没有,给个内存版
  if (typeof globalThis.localStorage?.getItem !== 'function') {
    const mem = new Map();
    globalThis.localStorage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
      clear: () => mem.clear(),
    };
  }
  return createRequire(import.meta.url)(outfile);
}
