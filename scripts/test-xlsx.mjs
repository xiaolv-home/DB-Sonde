// 导出的 .xlsx 得真能被 Excel 打开 —— 自己拼 zip + XML,错一个字节就是「文件已损坏」,
// 而这件事在界面上点一下才发现,发现时也只有一句打不开。这儿直接写出来验结构。
// 能不能真打开由 scripts/verify-xlsx.py 用 openpyxl 读一遍(npm run test:xlsx 会带上)。
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

new Function(readFileSync('src/features/dashboard/export/xlsx.runtime.js', 'utf8'))();
const X = globalThis.__DASH_XLSX__;

const columns = [
  { label: '网点大区' },
  { label: '统计日期' },
  { label: '总GMV', decimals: 2 },
  { label: '订单量', decimals: 0 },
];
const rows = [
  ['西北大区', '2026-01-01', 2629.58, 131],
  ['华东大区', '2026-01-01', -13794.5, 57],
  ['华南"引号"大区', '2026-01-02', 16074, 1500],
  ['含<标签>&符号', '2026-01-03', null, 0],
];

const blob = await X.buildXlsx('明细表', columns, rows);
const bytes = Buffer.from(await blob.arrayBuffer());
assert(bytes.length > 0, '写出来是空的');
assert.equal(bytes[0], 0x50, 'zip 魔数 PK');
assert.equal(bytes[1], 0x4b);
const out = join(tmpdir(), 'sonde-xlsx-check.xlsx');
writeFileSync(out, bytes);

// 上限:超了要说装不下,调用方据此改走 CSV
assert.equal(X.fitsExcel(10, 10), true);
assert.equal(X.fitsExcel(X.MAX_ROWS, 10), false, '行数占满还要加表头,就装不下了');
assert.equal(X.fitsExcel(10, X.MAX_COLS + 1), false, '列数超了');
assert.equal(X.fitsExcel(X.MAX_ROWS - 1, X.MAX_COLS), true, '正好装得下');

// CSV 退路:中文要带 BOM(没有它 Excel 打开是乱码),引号要转义
const csvOut = X.csvBlob(columns, rows);
// BOM 要验字节:Blob.text() 按规范会把开头的 BOM 吃掉,拿它验等于没验。
const csvBytes = Buffer.from(await csvOut.arrayBuffer());
assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'CSV 要带 BOM,否则 Excel 里中文是乱码');
const csv = await csvOut.text();
assert(csv.includes('"华南""引号""大区"'), '引号要按 CSV 规矩转义');
assert(csv.split('\r\n').length === rows.length + 1, '表头 + 每行一条');

/* 自己拼的 zip + XML,光自己检查不算数 —— 用 openpyxl(真正的 Excel 解析器)读一遍。
   没装 openpyxl 就跳过这一段,别让别人的机器上跑不了 npm run check。 */
const py = spawnSync('python3', ['scripts/verify-xlsx.py', out], { encoding: 'utf8' });
rmSync(out, { force: true }); // 读完就删,别每跑一次检查就在临时目录里留一份
if (py.status === 0) {
  console.log(py.stdout.trim().split('\n').pop());
} else if (/ModuleNotFoundError|No module named|command not found/.test((py.stderr || '') + (py.error?.message ?? ''))) {
  console.log('xlsx: 没装 openpyxl,跳过「真能被 Excel 打开」那一步');
} else {
  throw new Error('openpyxl 读不动导出的文件:\n' + (py.stderr || py.stdout));
}

console.log('xlsx: 9 assertions passed');
