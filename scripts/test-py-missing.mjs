// Python 缺包识别:从报错里认出模块名、换成 pip 包名。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'sonde-pymiss-'));
try {
  const outfile = join(dir, 't.cjs');
  await build({ entryPoints: [resolve('src/lib/pyMissingModule.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
  const m = createRequire(import.meta.url)(outfile);
  assert.equal(m.missingModule("ModuleNotFoundError: No module named 'oracledb'"), 'oracledb');
  assert.equal(m.missingModule('ModuleNotFoundError: No module named "google.cloud.bigquery"'), 'google', '子模块取顶层名');
  assert.equal(m.missingModule('Traceback (most recent call last):'), null);
  assert.equal(m.missingModule("ImportError: cannot import name 'x' from 'y'"), null, '不是缺包的报错不认');
  assert.equal(m.pipNameFor('oracledb'), 'oracledb');
  assert.equal(m.pipNameFor('cv2'), 'opencv-python');
  assert.equal(m.pipNameFor('yaml'), 'pyyaml');
  assert.equal(m.pipNameFor('sklearn'), 'scikit-learn');
  console.log('py missing module: 认模块名 / 换 pip 包名 全部通过');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
