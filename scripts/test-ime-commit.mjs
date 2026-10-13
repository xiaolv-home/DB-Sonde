// 拼音被符号顶上屏时退回原文;数字 / 空格选的汉字保留。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'sonde-ime-'));
try {
  const outfile = join(dir, 't.cjs');
  await build({ entryPoints: [resolve('src/lib/imeCommit.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
  const { revertSymbolCommit: r } = createRequire(import.meta.url)(outfile);
  assert.equal(r('额。*', 'e 。'), 'e。*', 'e。 再按 shift+8:退回 e。*(之后标点转换成 e.*)');
  assert.equal(r('额。*', 'e。'), 'e。*', '组字框里没空格也一样');
  assert.equal(r('表*', 'biao'), 'biao*', '拼音后直接按符号');
  assert.equal(r("西安*", "xi'an"), 'xian*', '分词的 \' 去掉');
  assert.equal(r('额', 'e'), null, '数字 / 空格选字:只有汉字,保留');
  assert.equal(r('额。', 'e 。'), null, '没被符号顶:保留');
  assert.equal(r('e。*', 'e 。'), null, '回车上屏的原文里没有汉字:不用退');
  assert.equal(r('额1', 'e'), null, '后面跟数字不算符号');
  assert.equal(r('销售额*', '销售额'), null, '组字框里本来就是汉字(不是拼音)');
  assert.equal(r('额。*', 'e1'), null, '组字框里有数字,不像拼音');
  console.log('ime commit: 符号顶上屏退回原文 / 数字空格选字保留 全部通过');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
