// 关键字自动大写:只在打完一个词(后面敲了分隔符)时才改,标识符、字符串、注释不动。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'sonde-kwcase-'));
try {
  const outfile = join(dir, 't.cjs');
  await build({ entryPoints: [resolve('src/lib/keywordCase.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
  const m = createRequire(import.meta.url)(outfile);
  const { Text } = createRequire(import.meta.url)('@codemirror/state');
  const words = Object.fromEntries(['select', 'from', 'where', 'order', 'by', 'create', 'table', 'decimal', 'and'].map((w) => [w, 1]));
  // 模拟一个字一个字地打:返回最终文本
  const type = (keys, tail = '') => {
    let doc = '';
    for (const ch of keys) {
      doc += ch;
      const full = Text.of((doc + tail).split('\n'));
      const edits = m.keywordUpperEdits(full, doc.length - 1, doc.length, words, 'mysql', false);
      for (const e of edits.reverse()) doc = doc.slice(0, e.from) + e.insert + doc.slice(e.to);
    }
    return doc;
  };
  assert.equal(type('select order_at from t'), 'SELECT order_at FROM t', 'order_at 是标识符,不能打到 order 就变大写');
  assert.equal(type('create table x (id decimal,order_no', ')'), 'CREATE TABLE x (id DECIMAL,order_no', '自动补上的 ) 前面打字也一样');
  assert.equal(type('select'), 'select', '还在打的词不动(后面没敲分隔符)');
  assert.equal(type('select '), 'SELECT ', '敲了空格才算打完');
  assert.equal(type('where a=1 and\n'), 'WHERE a=1 AND\n', '回车也算分隔');
  assert.equal(type("select 'order by' "), "SELECT 'order by' ", '字符串里不动');
  assert.equal(type('select -- order by\n'), 'SELECT -- order by\n', '注释里不动');
  assert.equal(type('select `order` '), 'SELECT `order` ', '反引号标识符不动');
  assert.equal(type('select orders '), 'SELECT orders ', '比关键字长的标识符不动');
  // 粘贴:整段进来,末尾那个词后面本来就不是字母,也算打完
  const pasted = Text.of(['select a from t order by a']);
  const edits = m.keywordUpperEdits(pasted, 0, pasted.length, words, 'mysql', true);
  assert.deepEqual(edits.map((e) => e.insert), ['SELECT', 'FROM', 'ORDER', 'BY']);
  console.log('keyword case: 打字 / 自动括号 / 字符串 / 注释 / 粘贴 全部通过');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
