// 下钻每一步的事实:变化在哪、占总变化几成、哪天反常。这些数是模型下结论的唯一依据,
// 算错了它就会把调查带偏,而且看上去头头是道。
import assert from 'node:assert/strict';
import { loadSrc } from './lib/load-src.mjs';

const m = loadSrc('drill-facts', { 'src/features/agent/drillFacts.ts': '{ drillFacts }' });
const plan = (dims, metrics, rows) => ({
  metricIds: metrics.map((x) => x.field),
  shape: { dimensions: dims, metrics: metrics.map((x) => ({ name: x.field, unit: '元', rollup: 'sum', ...x })) },
  result: { columns: [...dims, ...metrics.map((x) => x.field)].map((name) => ({ name })), rows, elapsedMs: 1 },
});
const label = (k) => ({ channel: '渠道', day: '日期' }[k] ?? k);
const base = { stepId: 'S1', label: '天津 · 10月', dimensionLabel: label, compareLabel: '上期' };

// 贡献度:总共少了 20,A 一家就少了 30(占 150%),C 反方向 +10
const now = plan(['channel'], [{ field: 'gmv' }], [['A', 50], ['B', 30], ['C', 20]]);
const then = plan(['channel'], [{ field: 'gmv' }], [['A', 80], ['B', 30], ['C', 10]]);
let facts = m.drillFacts({ ...base, current: now, compare: then, breakdown: 'channel' });
const contribution = facts.find((f) => f.computedBy.startsWith('contribution'));
assert(contribution, JSON.stringify(facts.map((f) => f.text)));
assert.match(contribution.text, /合计 -20元/);
assert.match(contribution.text, /A -30元 占总变化 150%/);
assert.match(contribution.text, /反方向:C \+10元/);
assert.match(facts[0].text, /gmv 100元,上期 120元\(-16\.7%,-20元\)/, '这一步范围里的总量和对比');

// 上期有、本期没了的组(停业)也算进变化
facts = m.drillFacts({ ...base, current: plan(['channel'], [{ field: 'gmv' }], [['A', 50]]), compare: plan(['channel'], [{ field: 'gmv' }], [['A', 50], ['D', 40]]), breakdown: 'channel' });
assert.match(facts.find((f) => f.computedBy.startsWith('contribution')).text, /D -40元 占总变化 100%/);

// 不可加的指标(均值)不算贡献度,只比各组自己的变化
facts = m.drillFacts({ ...base, current: plan(['channel'], [{ field: 'aov', rollup: 'avg' }], [['A', 40], ['B', 30]]), compare: plan(['channel'], [{ field: 'aov', rollup: 'avg' }], [['A', 50], ['B', 30]]), breakdown: 'channel' });
assert(!facts.some((f) => f.computedBy.startsWith('contribution')), '均值不能拆成各组之和');
assert.match(facts.find((f) => f.computedBy.startsWith('group_change')).text, /A 50元→40元\(-20\.0%\)/);

// 按日:2026-10-13 是周二,其他周二都是 100,它只有 40 —— 偏离 -60%
const days = [];
for (let d = 1; d <= 28; d += 1) {
  const key = `2026-10-${String(d).padStart(2, '0')}`;
  const weekday = new Date(`${key}T00:00:00`).getDay();
  days.push([key, key === '2026-10-13' ? 40 : weekday === 0 || weekday === 6 ? 200 : 100]);
}
facts = m.drillFacts({ ...base, current: plan(['day'], [{ field: 'gmv' }], days), breakdown: 'day' });
const weekday = facts.find((f) => f.computedBy.startsWith('weekday_deviation'));
assert(weekday, '应该找出反常的那天');
assert.match(weekday.text, /^天津 · 10月gmv偏离同星期几均值最多的几天:2026-10-13\(周二\)40元,比其他周二均值 -60\.0%/);
assert(!/2026-10-04|2026-10-05/.test(weekday.text), '周末本来就高,不算反常');

// 同星期几里有两天数值一样时,只能摘掉当前这一行,不能把「值相同」的其他天也摘掉。
// 2026-10-06 和 10-13 都是周二、都是 40;另外两个周二是 100。
// 按行剔除:40 那天的同伴均值是 (40+100+100)/3=80,偏离 -50%;
// 按值剔除会把另一个 40 也丢掉,均值变成 100,偏离被算成 -60%。
const duplicateWeekdays = [];
for (let d = 1; d <= 28; d += 1) {
  const key = `2026-10-${String(d).padStart(2, '0')}`;
  const dow = new Date(`${key}T00:00:00`).getDay();
  const tuesday = dow === 2;
  const value = key === '2026-10-06' || key === '2026-10-13' ? 40 : tuesday ? 100 : dow === 0 || dow === 6 ? 200 : 100;
  duplicateWeekdays.push([key, value]);
}
facts = m.drillFacts({ ...base, current: plan(['day'], [{ field: 'gmv' }], duplicateWeekdays), breakdown: 'day' });
const duplicateDeviation = facts.find((f) => f.computedBy.startsWith('weekday_deviation'));
assert(duplicateDeviation, '相同数值的其他周二也要留在均值里');
assert.match(duplicateDeviation.text, /2026-10-06\(周二\)40元,比其他周二均值 -50\.0%/);
assert.match(duplicateDeviation.text, /2026-10-13\(周二\)40元,比其他周二均值 -50\.0%/);
assert.match(duplicateDeviation.text, /2026-10-20\(周二\)100元,比其他周二均值 \+66\.7%/);

// 有对比期:逐期对齐,第 n 天对第 n 天,找掉得最多的
const lastMonth = days.map(([key, v], i) => [`2026-09-${String(i + 1).padStart(2, '0')}`, key === '2026-10-13' ? 100 : v]);
facts = m.drillFacts({ ...base, current: plan(['day'], [{ field: 'gmv' }], days), compare: plan(['day'], [{ field: 'gmv' }], lastMonth), breakdown: 'day' });
assert.match(facts.find((f) => f.computedBy.startsWith('aligned_periods')).text, /变化最大的:2026-10-13 40元 vs 2026-09-13 100元\(-60元,-60\.0%\)/);

// 对比期按日期键对齐,不按数组位置。本期缺 10-04、对比期开头多了 08-31 时,
// 按位置会把 10-13 错配到 09-11;按日号仍然是 10-13 对 09-13。
const gapped = [];
for (let d = 1; d <= 28; d += 1) {
  if (d === 4) continue;
  gapped.push([`2026-10-${String(d).padStart(2, '0')}`, d === 13 ? 40 : 100]);
}
const shiftedCompare = [['2026-08-31', 999]];
for (let d = 1; d <= 28; d += 1) shiftedCompare.push([`2026-09-${String(d).padStart(2, '0')}`, 100]);
facts = m.drillFacts({
  ...base,
  current: plan(['day'], [{ field: 'gmv' }], gapped),
  compare: plan(['day'], [{ field: 'gmv' }], shiftedCompare),
  breakdown: 'day',
});
let aligned = facts.find((f) => f.computedBy.startsWith('aligned_periods'));
assert(aligned, JSON.stringify(facts.map((f) => f.computedBy)));
assert.deepEqual(aligned.rows.find((row) => row[0] === '2026-10-13'), ['2026-10-13', 40, '2026-09-13', 100, -60]);

// 区间不是整月、中间又缺一天时,用各自日期区间里的第 n 天对齐,而不是按下标。
// 本期 10-10..10-12 缺了 10-11;对比期是往前平移的 10-07..10-09。10-12 应该对 10-09。
const ranged = (rows, dateRange) => {
  const built = plan(['day'], [{ field: 'gmv' }], rows);
  built.shape = { ...built.shape, dateRange, grain: 'day', timeField: 'day' };
  return built;
};
facts = m.drillFacts({
  ...base,
  current: ranged([['2026-10-10', 100], ['2026-10-12', 40]], { start: '2026-10-10', end: '2026-10-12' }),
  compare: ranged([['2026-10-07', 100], ['2026-10-08', 100], ['2026-10-09', 80]], { start: '2026-10-07', end: '2026-10-09' }),
  breakdown: 'day',
});
aligned = facts.find((f) => f.computedBy.startsWith('aligned_periods'));
assert(aligned, '有日期区间时也要按日期键对齐');
assert.deepEqual(aligned.rows.find((row) => row[0] === '2026-10-12'), ['2026-10-12', 40, '2026-10-09', 80, -40]);

// 没有对比期:份额和头尾
facts = m.drillFacts({ ...base, current: now, breakdown: 'channel' });
assert.match(facts.find((f) => f.computedBy.startsWith('ranking')).text, /最高 A 50元\(50\.0%\)/);

console.log('drill facts: ok');
