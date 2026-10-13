// 全角分号:代码里换成英文分号,字符串和注释里不动。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'sonde-punct-'));
try {
  const outfile = join(dir, 't.cjs');
  await build({ entryPoints: [resolve('src/lib/sqlPunctuation.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
  const m = createRequire(import.meta.url)(outfile);
  const fix = (before, kind = 'mysql') => m.asciiPunctuationFor('；', before, kind);
  assert.equal(fix('SELECT * FROM t'), ';', '句末:换成英文分号');
  assert.equal(fix('SELECT * FROM t WHERE a = 1'), ';', '行中间的代码里也换');
  assert.equal(fix("SELECT '你好"), null, '字符串里不动');
  assert.equal(fix('SELECT 1 -- 注释'), null, '行注释里不动');
  assert.equal(fix('SELECT 1 /* 说明'), null, '块注释里不动');
  assert.equal(fix('SELECT `列'), null, '反引号标识符里不动');
  assert.equal(fix("SELECT 'a' "), ';', '字符串结束之后又回到代码');
  assert.equal(fix('SELECT 1 -- 注释\nSELECT 2'), ';', '注释那行结束后又是代码');
  assert.equal(m.asciiPunctuationFor('，', 'SELECT a', 'mysql'), ',', '逗号');
  assert.equal(m.asciiPunctuationFor('（', 'SELECT COUNT', 'mysql'), '(', '左括号');
  assert.equal(m.asciiPunctuationFor('）', 'SELECT COUNT(1', 'mysql'), ')', '右括号');
  assert.equal(m.asciiPunctuationFor("（'甲，乙'）", 'WHERE a IN ', 'mysql'), "('甲，乙')", '引号里的逗号留着,外面的括号换掉');
  assert.equal(m.asciiPunctuationFor('，', 'SELECT 1 -- 一，', 'mysql'), null, '注释里的逗号不动');
  assert.equal(m.asciiPunctuationFor('。', 'SELECT 1', 'mysql'), null, '句号这类不管(SQL 里没有对应的)');
  assert.equal(m.asciiPunctuationFor(';', 'SELECT a', 'mysql'), null, '本来就是英文分号不用换');
  assert.equal(fix('BEGIN NULL', 'oracle'), ';', 'Oracle 一样');
  // 输入法一次上屏好几个字:每个全角分号各自看语境
  assert.equal(m.asciiPunctuationFor('select 1；', '', 'mysql'), 'select 1;');
  assert.equal(m.asciiPunctuationFor("'好；'；", 'SELECT ', 'mysql'), "'好；';", '引号里的留着,引号外的换掉');
  assert.equal(m.asciiPunctuationFor('完成；', 'SELECT 1 -- ', 'mysql'), null, '整段都在注释里');
  assert.equal(m.asciiPunctuationFor("'😀'；", 'SELECT ', 'mysql'), "'😀';", '前面有表情也不错位');
  console.log('sql punctuation: 分号 逗号 括号 × 代码 / 字符串 / 注释 / 标识符 全部通过');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
