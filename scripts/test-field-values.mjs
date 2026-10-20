// 「这个字段有哪些取值」曾经有两套实现:一套查全局数据集(我另起的缓存),一套查组件
// 编译好的 SQL(走 executeDataset 的缓存)。长得一样、行为不一样,还各带一个缓存。
// 这里盯住收口之后的三件事:查的是数据集本身、共用那个唯一的查询缓存、取满上限要说出来。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'sonde-field-values-'));
try {
  // api 是网络边界,换成计数用的假货 —— 要数的就是它被调了几次。
  // 计数记在 globalThis 上,不从假货里导出:打包器可能把它实例化两份,
  // 那样测试读到的数组永远是空的,断言就成了摆设。
  const stub = join(dir, 'api-stub.ts');
  writeFileSync(stub, `
    const calls: string[] = ((globalThis as any).__apiCalls ??= []);
    export const api = {
      runReadOnlyQuery: async (_c: string, _d: string | undefined, sql: string, rows: number) => {
        calls.push(sql);
        const all = [['华东大区'], ['西北大区'], ['华南大区'], ['西北大区']];
        return { columns: [{ name: 'war_zone', typeName: 'TEXT' }], rows: all.slice(0, rows), rowsAffected: null, truncated: false };
      },
      runQuery: async () => { throw new Error('候选值该走只读通道'); },
    };
  `);

  const outfile = join(dir, 'tests.cjs');
  await build({
    stdin: {
      contents: `
        export { dimensionValues, datasetDimensionValues } from './src/features/dashboard/dataService';
        export { clearQueryCache } from './src/features/dashboard/query';
      `,
      resolveDir: resolve('.'), loader: 'ts',
    },
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{
      name: 'stub-api',
      setup(b) {
        let hit = 0;
        b.onResolve({ filter: /lib\/api$/ }, () => { hit += 1; return { path: stub }; });
        b.onEnd(() => { if (!hit) throw new Error('api 没被替换成假货,这个测试等于没测'); });
      },
    }],
  });
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.__apiCalls = [];
  const { dimensionValues, datasetDimensionValues, clearQueryCache } = createRequire(import.meta.url)(outfile);
  const calls = globalThis.__apiCalls;
  const t = (key) => key;

  const dataset = {
    schemaVersion: 1, id: 'ds1', name: '网点', connectionId: 'c1', database: 'db',
    source: { kind: 'join', base: { table: 'stores', alias: 't1' }, joins: [], columns: [] },
    fields: [
      { name: 'war_zone', column: 'war_zone', from: 't1', role: 'dimension' },
      { name: 'amount', column: 'amount', from: 't1', role: 'measure' },
    ],
    updatedAt: '2026-09-17T00:00:00Z',
  };

  const got = await datasetDimensionValues(dataset, 'war_zone', 'mysql', t);
  assert.equal(calls.length, 1, '第一次要真查');
  assert(/group\s+by/i.test(calls[0]), `去重交给数据库,不是拿前 N 行在前端 Set 一下: ${calls[0]}`);
  assert(/stores/i.test(calls[0]), '查的是数据集本身 —— 组件没 SELECT 的列也得能筛');
  assert(!/\b(sum|avg|count|min|max)\s*\(/i.test(calls[0]), `只要取值清单,别顺手把度量也聚合一遍: ${calls[0]}`);
  // 排序在前端做:各家数据库的中文排序规则不一样,靠 SQL 排出来的顺序没法预期。
  assert.deepEqual(got.values, ['华东大区', '华南大区', '西北大区'], '按拼音排序并去重');
  assert.equal(got.truncated, false, '4 行远不到上限');

  // 第二次必须命中 executeDataset 那个缓存 —— 这就是"点开不再转圈"。
  // 如果哪天有人又在上面叠一层自己的缓存,这条也照样过,所以下面还要验它能被清掉。
  await datasetDimensionValues(dataset, 'war_zone', 'mysql', t);
  assert.equal(calls.length, 1, '第二次吃缓存');

  await datasetDimensionValues(dataset, 'store', 'mysql', t);
  assert.equal(calls.length, 2, '换个字段是另一句 SQL');

  // 「刷新」按钮清的是这个缓存。清完还不重查,说明候选值躲在另一套缓存里,
  // 那就又回到了两套缓存各自失效的老问题。
  clearQueryCache();
  await datasetDimensionValues(dataset, 'war_zone', 'mysql', t);
  assert.equal(calls.length, 3, '候选值跟着「刷新」一起作废,没有第二套缓存');

  // 导入的 HTML / AI 看板没有全局数据集,只有组件编译好的那份。
  const compiled = { id: 'w1', name: '编译产物', sourceType: 'sql', connectionId: 'c1', database: 'db', sql: 'SELECT war_zone FROM baked', fields: [] };
  const fallback = await dimensionValues(compiled, 'war_zone', t);
  assert.deepEqual(fallback.values, ['华东大区', '华南大区', '西北大区'], '退路走的是同一套去重排序');
  assert.equal(calls.length, 4, '编译产物是另一句 SQL,要真查');

  /* 组件设了「前 5 名」:那是按度量截前 5 行。列筛选候选值时要是带着它,下拉里就只剩 5 个,
     而且 5 行远没到上限,还会说成「就这些」。 */
  const topped = {
    ...compiled, id: 'w2', sql: 'SELECT war_zone, SUM(amount) FROM t GROUP BY war_zone ORDER BY 2 DESC LIMIT 5',
    compiledFrom: { dataset, kind: 'mysql', query: { dimensions: ['war_zone'], measures: [{ field: 'amount', agg: 'sum' }], topN: 5,
      orderBy: [{ name: 'amount', dir: 'desc', measure: true }] } },
  };
  await dimensionValues(topped, 'war_zone', t);
  const listed = calls[calls.length - 1];
  assert(!/LIMIT 5\b/.test(listed) && !/`amount` DESC/.test(listed), `列候选值不该带着组件的前 N 名: ${listed}`);

  // 行数顶到上限 = 后面还有没取回来的。以前直接当成"就这些",
  // 于是明明存在的取值在下拉里找不着,看上去就是"被吃了"。
  const capped = await datasetDimensionValues(dataset, 'war_zone', 'mysql', t, 4);
  assert.equal(capped.truncated, true, '取满上限要说出来,不能装作就这些');
  assert.equal(capped.values.length, 3, '截断了也照样去重');

  console.log('field values: 14 assertions passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
