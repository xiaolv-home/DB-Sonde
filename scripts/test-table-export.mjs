#!/usr/bin/env node
/* 表「数据」页的「导出 CSV」:导出的是筛选后的**全部**行,不是已加载的那一页。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSrc } from './lib/load-src.mjs';

const { exportTableData, serializeResult } = loadSrc('table-export', { 'src/lib/export.ts': '{ exportTableData, serializeResult }' });

const columns = [{ name: 'id' }, { name: 'store_uid' }];
const table = (n) => ({ columns, rows: Array.from({ length: n }, (_, i) => [i + 1, '76251672']), elapsedMs: 0 });

async function run({ count, rows, max = 10 }) {
  const calls = [];
  const saved = [];
  const outcome = await exportTableData({
    countSql: 'COUNT',
    dataSql: (limit) => `DATA LIMIT ${limit}`,
    run: async (sql, maxRows) => {
      calls.push([sql, maxRows]);
      return sql === 'COUNT' ? { columns: [{ name: 'n' }], rows: [[count]], elapsedMs: 0 } : table(rows ?? count);
    },
    save: async (result) => { saved.push(result); return '/Downloads/t.csv'; },
    max,
  });
  return { outcome, calls, saved };
}

{ // 正常:先数、再一次取全,整份交给保存
  const { outcome, calls, saved } = await run({ count: 426, max: 500 });
  assert.deepEqual(outcome, { kind: 'saved', count: 426, path: '/Downloads/t.csv' });
  assert.deepEqual(calls, [['COUNT', 1], ['DATA LIMIT 501', 501]], '数据要一次取到上限+1');
  assert.equal(saved[0].rows.length, 426, '导出全部匹配行,不是一页');
  const csv = serializeResult(saved[0], 'csv').split('\r\n');
  assert.equal(csv.length, 427);
  assert.equal(csv[0], 'id,store_uid');
}
{ // 超上限:只数不取
  const { outcome, calls, saved } = await run({ count: 11 });
  assert.deepEqual(outcome, { kind: 'tooMany', count: 11 });
  assert.equal(calls.length, 1, '数出来超了就别再去拉数据');
  assert.equal(saved.length, 0);
}
{ // 数的时候没超,取的时候表里又进了数据:照样拒,不截断
  const { outcome, saved } = await run({ count: 10, rows: 11 });
  assert.deepEqual(outcome, { kind: 'tooMany', count: 11 });
  assert.equal(saved.length, 0);
}
{ // 正好等于上限可以导
  const { outcome } = await run({ count: 10 });
  assert.equal(outcome.kind, 'saved');
}
{ // 没数据不生成空文件
  const { outcome, calls, saved } = await run({ count: 0 });
  assert.deepEqual(outcome, { kind: 'empty' });
  assert.equal(calls.length, 1);
  assert.equal(saved.length, 0);
}

// 导出用的是界面上当前的筛选和排序
const src = readFileSync('src/components/TableInspector.tsx', 'utf8');
const at = src.indexOf('const exportCsv = async');
const body = src.slice(at, src.indexOf('\n  };', at));
assert.match(body, /buildCountQuery\(kind, tab\.database, tab\.schema, tab\.table, whereApplied\)/, '数行数要带当前筛选');
assert.match(body, /where: whereApplied, orderBy, stableBy: primaryKey, limit, offset: 0/, '取数据要带当前筛选和排序');
assert.match(body, /if \(dirty && !\(await askConfirm/, '有没保存的修改要先提醒');

console.log('table export ok');
