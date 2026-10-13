// 中文输入法在 SQL 代码里打出的东西:全角标点换英文、被符号顶上屏退回拼音原文;字符串和注释里不动。
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
  assert.equal(m.asciiPunctuationFor('。', 'SELECT * FROM qh_ods', 'mysql'), '.', '句号:库名.表名');
  assert.equal(m.asciiPunctuationFor('。', 'SELECT 1', 'mysql'), '.', '句号:小数点');
  assert.equal(m.asciiPunctuationFor('。', "SELECT '好", 'mysql'), null, '字符串里的句号不动');
  assert.equal(m.asciiPunctuationFor('。', 'SELECT 1 -- 完成', 'mysql'), null, '注释里的句号不动');
  assert.equal(m.asciiPunctuationFor('、', 'SELECT 1', 'mysql'), null, '顿号这类不管(SQL 里没有对应的)');
  // 引号
  assert.equal(m.asciiPunctuationFor('‘', 'WHERE name = ', 'mysql'), "'", '代码里的中文单引号');
  assert.equal(m.asciiPunctuationFor('“', 'SELECT ', 'mysql'), '"', '代码里的中文双引号');
  assert.equal(m.asciiPunctuationFor('“你好，世界”', 'SELECT ', 'mysql'), '"你好，世界"', '一次上屏:前面的引号换了以后,里面的逗号在字符串里,不换');
  assert.equal(m.asciiPunctuationFor("‘a’，", 'IN (', 'mysql'), "'a',", '字符串结束后的逗号又回到代码,要换');
  assert.equal(m.asciiPunctuationFor('“', "SELECT '他说", 'mysql'), null, '单引号字符串里的中文双引号保留');
  assert.equal(m.asciiPunctuationFor('”', 'SELECT "你好', 'mysql'), '"', '双引号字符串里敲中文右双引号:是在关上它');
  assert.equal(m.asciiPunctuationFor('’', "WHERE n = 'a", 'mysql'), "'", '单引号字符串里敲中文右单引号:关上');
  assert.equal(m.asciiPunctuationFor("'他说“你好”'", 'SELECT ', 'mysql'), null, '单引号串里的一对中文双引号原样保留');
  assert.equal(m.asciiPunctuationFor('’', 'SELECT 1 -- 注释', 'mysql'), null, '注释里的中文引号保留');
  assert.equal(m.asciiPunctuationFor(';', 'SELECT a', 'mysql'), null, '本来就是英文分号不用换');
  assert.equal(fix('BEGIN NULL', 'oracle'), ';', 'Oracle 一样');
  // 输入法一次上屏好几个字:每个全角分号各自看语境
  assert.equal(m.asciiPunctuationFor('select 1；', '', 'mysql'), 'select 1;');
  assert.equal(m.asciiPunctuationFor("'好；'；", 'SELECT ', 'mysql'), "'好；';", '引号里的留着,引号外的换掉');
  assert.equal(m.asciiPunctuationFor('完成；', 'SELECT 1 -- ', 'mysql'), null, '整段都在注释里');
  assert.equal(m.asciiPunctuationFor("'😀'；", 'SELECT ', 'mysql'), "'😀';", '前面有表情也不错位');
  // 「——」(中文输入法 shift+减号)→ 下划线
  assert.equal(m.asciiPunctuationFor('——', 'SELECT order', 'mysql'), '_', '「——」整体换成一个 _');
  assert.equal(m.asciiPunctuationFor('—', 'SELECT order', 'mysql'), '_', '单个破折号也换');
  assert.equal(m.asciiPunctuationFor('——', "SELECT '说明", 'mysql'), null, '字符串里的破折号保留');
  assert.equal(m.asciiPunctuationFor('——', 'SELECT 1 -- 注释', 'mysql'), null, '注释里的破折号保留');

  // 被符号顶上屏:退回拼音原文
  const r = m.revertSymbolCommit;
  assert.equal(r('额。*', 'e 。'), 'e。*', 'e。 再按 shift+8:退回 e。*(之后标点转换成 e.*)');
  assert.equal(r('额。*', 'e。'), 'e。*', '组字框里没空格也一样');
  assert.equal(r('表*', 'biao'), 'biao*', '拼音后直接按符号');
  assert.equal(r("西安*", "xi'an"), 'xian*', '分词的 \' 去掉');
  assert.equal(r('哦的——', 'order'), 'order——', '中文模式打 order_:被「——」顶上屏,退回 order——(之后换成 order_)');
  assert.equal(m.asciiPunctuationFor(r('哦的——', 'order'), 'SELECT ', 'mysql'), 'order_');
  assert.equal(r('额', 'e'), null, '数字 / 空格选字:只有汉字,保留');
  assert.equal(r('额。', 'e 。'), null, '没被符号顶:保留');
  assert.equal(r('e。*', 'e 。'), null, '回车上屏的原文里没有汉字:不用退');
  assert.equal(r('额1', 'e'), null, '后面跟数字不算符号');
  assert.equal(r('销售额*', '销售额'), null, '组字框里本来就是汉字(不是拼音)');
  assert.equal(r('额。*', 'e1'), null, '组字框里有数字,不像拼音');
  assert.equal(m.inCodeAt('SELECT ', 'mysql'), true);
  assert.equal(m.inCodeAt("SELECT '", 'mysql'), false);

  console.log('sql punctuation: 全角标点 / 引号 / 下划线 / 符号顶上屏 × 代码 / 字符串 / 注释 全部通过');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
