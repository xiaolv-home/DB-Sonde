// 拖动分隔条存下的高度,下次启动必须读得回来。
// 真机事故:拖动允许 120,读取要求 ≥140,拖到 120~139 之间就弹「本地保存需要处理 · 结果区高度」。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'sonde-pane-'));
try {
  const outfile = join(dir, 't.cjs');
  await build({ entryPoints: [resolve('src/lib/paneSizes.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
  const { clampPaneHeight, acceptsPaneHeight, RESULT_MIN_HEIGHT, PY_OUTPUT_MIN_HEIGHT } = createRequire(import.meta.url)(outfile);

  let n = 0;
  for (const [name, min] of [['结果区', RESULT_MIN_HEIGHT], ['Python 输出区', PY_OUTPUT_MIN_HEIGHT]]) {
    for (let h = -50; h <= 3000; h += 1) {
      const saved = String(clampPaneHeight(h, min));
      assert(acceptsPaneHeight(min)(saved), `${name}:拖到 ${h} 存成 ${saved},下次启动却读不回来`);
      n += 1;
    }
    assert(!acceptsPaneHeight(min)(''), '空串不算有效高度');
    assert(!acceptsPaneHeight(min)('abc'), '非数字不算有效高度');
  }

  // 保存和读取必须走同一个下限常量,不许再各写各的数字
  const slice = readFileSync('src/store/shellSlice.ts', 'utf8');
  assert.match(slice, /readStoredText\("resultHeight",[^\n]*acceptsPaneHeight\(RESULT_MIN_HEIGHT\)/, 'resultHeight 读取要用 acceptsPaneHeight(RESULT_MIN_HEIGHT)');
  assert.match(slice, /readStoredText\("pyOutputHeight",[^\n]*acceptsPaneHeight\(PY_OUTPUT_MIN_HEIGHT\)/, 'pyOutputHeight 读取要用 acceptsPaneHeight(PY_OUTPUT_MIN_HEIGHT)');
  assert.match(slice, /clampPaneHeight\(h, RESULT_MIN_HEIGHT\)/, 'setResultHeight 要用 RESULT_MIN_HEIGHT');
  assert.match(slice, /clampPaneHeight\(h, PY_OUTPUT_MIN_HEIGHT\)/, 'setPyOutputHeight 要用 PY_OUTPUT_MIN_HEIGHT');
  console.log(`pane sizes: ${n} 个拖动高度存下后都读得回来`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
