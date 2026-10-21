// 查询结果导出成 CSV / JSON:导出的文件里不能少数据。
import assert from 'node:assert/strict';
import { loadSrc } from './lib/load-src.mjs';

const { serializeResult } = loadSrc('result-export', { 'src/lib/export.ts': '{ serializeResult }' });

/* `SELECT * FROM a JOIN b` 两边各有一个 id。JSON 原来直接拿列名当键,后一个 id 把前一个覆盖了,
   导出的文件里少一整列,还看不出来。 */
const joined = {
  columns: [{ name: 'id' }, { name: 'name' }, { name: 'id' }, { name: 'id_2' }],
  rows: [[1, '咖啡', 10, 'x']], rowsAffected: null, truncated: false, elapsedMs: 0, message: null,
};
const [row] = JSON.parse(serializeResult(joined, 'json'));
assert.equal(Object.keys(row).length, 4, `重名的列一个都不能丢: ${JSON.stringify(row)}`);
assert.equal(row.id, 1);
assert.equal(row.name, '咖啡');
assert.equal(Object.values(row).filter((v) => v === 10).length, 1, '第二个 id 换了个名字留下');
assert.equal(row.id_2, 'x', '本来就叫 id_2 的列不被改名后的列顶掉');

// CSV 本来就按位置写,重名不受影响;逗号 / 引号 / 换行要加引号
const csv = serializeResult({ ...joined, rows: [[1, 'a,"b"\nc', null, 'x']] }, 'csv');
assert.equal(csv, 'id,name,id,id_2\r\n1,"a,""b""\nc",,x');

console.log('result export: 6 assertions passed');
