// A dataset is the single source a widget draws from: either a SQL statement or
// tables joined together. These cover the SQL it generates and the rules that
// keep a join from producing a query the database will reject.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'sonde-dataset-'));
try {
  const outfile = join(dir, 'tests.cjs');
  await build({
    stdin: {
      contents: "export * from './src/features/datasets/domain'; export * from './src/features/datasets/widgetQuery'; export * from './src/features/datasets/inferJoin';",
      resolveDir: resolve('.'), loader: 'ts',
    },
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  });
  const { buildDatasetSql, validateDataset, inferRole, createDataset, joinColumnAlias, buildWidgetSql, guessJoin, guessJoinAcross, recommendTables, tableStem, derivedExpr, normalizeDataset, isTimeField } =
    createRequire(import.meta.url)(outfile);

  // --- 变异测试补的缺口:这些地方改坏了原来没有测试会挂 ---
  {
    const sqlDs = { ...createDataset('x', 'c', 'db'), source: { kind: 'sql', sql: 'SELECT * FROM t' } };
    const w = (query, kind = 'mysql') => buildWidgetSql(sqlDs, query, kind);
    // 各引擎的季 / 周
    assert(w({ dimensions: ['d'], measures: [], grains: { d: 'quarter' } }, 'oracle').includes(`TO_CHAR("d", 'YYYY-"Q"Q')`));
    assert(w({ dimensions: ['d'], measures: [], grains: { d: 'week' } }, 'oracle').includes(`TO_CHAR("d", 'IYYY-"W"IW')`));
    assert(w({ dimensions: ['d'], measures: [], grains: { d: 'month' } }, 'oracle').includes(`TO_CHAR("d", 'YYYY-MM')`));
    assert(w({ dimensions: ['d'], measures: [], grains: { d: 'quarter' } }, 'sqlite')
      .includes(`strftime('%Y', "d") || '-Q' || ((CAST(strftime('%m', "d") AS INTEGER) + 2) / 3)`));
    // 日期范围:起止颠倒、不是日期都要拦,不能拼出一句查不出东西的 SQL
    const range = (start, end) => w({ dimensions: [], measures: [{ field: 'g', agg: 'sum' }], dateRange: { field: 'd', start, end } });
    assert.throws(() => range('2026-10-05', '2026-10-01'), /日期范围无效/);
    assert.throws(() => range('2026-10-01', 'tomorrow'), /日期范围无效/);
    assert.throws(() => range('昨天', '2026-10-01'), /日期范围无效/);
    // 排序里已经有的维度不再补一遍
    assert.match(w({ dimensions: ['d'], measures: [{ field: 'g', agg: 'sum' }], orderBy: [{ name: 'd', dir: 'desc' }] }), /ORDER BY `d` DESC\s*$/);
    // 没有度量的前 N 名:只截行数,不能去 ORDER BY 一个不存在的度量
    assert.doesNotMatch(w({ dimensions: [], measures: [], topN: 5 }), /ORDER BY/);
    assert.match(w({ dimensions: [], measures: [], topN: 5 }), /LIMIT 5$/);
    // 指标卡(无维度):不排序、不截断
    assert.doesNotMatch(w({ dimensions: [], measures: [{ field: 'g', agg: 'sum' }] }), /ORDER BY|LIMIT/);
    assert.throws(() => buildWidgetSql({ ...sqlDs, source: { kind: 'sql', sql: '   ' } }, { dimensions: [], measures: [] }, 'mysql'), /还没有可执行的 SQL/);

    // 时间字段:没有字段就不是
    assert.equal(isTimeField(undefined), false);
    assert.equal(isTimeField({ name: 'x', type: 'TIMESTAMP' }), true);

    // 关联数据集:不保留的列不进 SELECT;字段名和列名不一样要 AS
    const joinDs = {
      ...createDataset('j', 'c', 'db'),
      source: { kind: 'join', base: { table: 'sales', alias: 't1' }, joins: [], columns: [] },
      fields: [
        { name: 'amount', column: 'amount', from: 't1', role: 'measure' },
        { name: '门店', column: 'store_name', from: 't1', role: 'dimension' },
        { name: 'secret', column: 'secret', from: 't1', role: 'dimension', hidden: true },
      ],
    };
    const joinSql = buildDatasetSql(joinDs, 'mysql');
    assert(joinSql.includes('`t1`.`amount`') && !joinSql.includes('`t1`.`amount` AS'), `同名不用 AS: ${joinSql}`);
    assert(joinSql.includes('`t1`.`store_name` AS `门店`'), `改了名要 AS: ${joinSql}`);
    assert(!joinSql.includes('secret'), `不保留的列不能出现在 SELECT 里: ${joinSql}`);

    // 分组字段:没名字或没取值的分组扔掉;全扔光了就算不出来
    const grouped = (buckets) => derivedExpr({ name: 'g', role: 'dimension', grouping: { source: 'amount', buckets } }, joinDs, 'mysql');
    assert.equal(grouped([{ label: '', values: ['1'] }, { label: '大', values: [] }]), undefined);
    assert.equal(grouped([{ label: '', values: ['1'] }, { label: '大', values: ['9'] }]), "CASE WHEN `t1`.`amount` = '9' THEN '大' ELSE NULL END");

    // 计算字段:只换真正的引用 —— 带了表名前缀的、函数名、字符串里的都不动
    const calc = (expr) => derivedExpr({ name: 'c', role: 'measure', expr }, joinDs, 'mysql');
    assert.equal(calc('amount * 2'), '`t1`.`amount` * 2');
    assert.equal(calc('x.amount + 1'), 'x.amount + 1', '已经带前缀的不动');
    assert.equal(calc("amount(1) + 'amount'"), "amount(1) + 'amount'", '函数名和字符串不动');
    assert.equal(calc('amount.x'), 'amount.x', '后面跟点的是限定名,不动');

    // 存盘读回来:来源、角色、默认值都得还原对
    const back = normalizeDataset({ name: '回来', connectionId: 'c', source: { kind: 'join', base: { table: 'sales' } }, fields: [{ name: 'a', role: 'measure' }, { name: 'b', role: 'weird' }] });
    assert.equal(back.source.kind, 'join', '关联数据集读回来还是关联');
    assert.equal(back.source.base.alias, 't1', '主表没别名就叫 t1');
    assert.deepEqual(back.source.joins, []);
    assert.deepEqual(back.fields.map((f) => f.role), ['measure', 'dimension'], '认不出的角色当维度');
    assert.match(back.id, /^dataset-/, '没 id 就补一个');
    const sqlBack = normalizeDataset({ id: 'keep', name: 's', source: { kind: 'sql', sql: 'SELECT 1' }, fields: [] });
    assert.deepEqual(sqlBack.source, { kind: 'sql', sql: 'SELECT 1' });
    assert.equal(sqlBack.id, 'keep', '有 id 就留着');
    assert.equal(sqlBack.connectionId, '');

    // 关联推断
    assert.equal(guessJoin(['code', 'name'], ['id', 'sku_id'], 'sales', 'skus')?.targetField, 'sku_id', '新表主键叫 code 也认');
    assert.deepEqual(guessJoin(['customer_id', 'name'], ['id', 'customer_id'], 'sales', 'customers'),
      { field: 'customer_id', targetField: 'customer_id', reason: '两边都有 customer_id' }, '主键就叫「词干_id」');
    // 几张已有表都能挂时,「指向」比「同名」有把握,哪怕「同名」那张排在前面
    const across = guessJoinAcross('customers', ['id', 'name', 'region_id'], [
      { alias: 't1', table: 'regions_x', fields: ['id', 'region_id'] },
      { alias: 't2', table: 'sales', fields: ['id', 'customer_id'] },
    ]);
    assert.equal(across?.targetAlias, 't2');
    // 把握一样的时候取第一个,不被后面的顶掉
    const tie = guessJoinAcross('customers', ['id'], [
      { alias: 't1', table: 'sales', fields: ['customer_id'] },
      { alias: 't2', table: 'visits', fields: ['customer_id'] },
    ]);
    assert.equal(tie?.targetAlias, 't1');
    // 词干太短不靠后缀匹配:ab_id 不该指向 tab
    assert.equal(guessJoin(['id'], ['ab_id'], 'x', 'tab'), undefined, '两个字母的词干不按后缀匹配');
    assert.equal(guessJoin(['id'], ['abc_id'], 'x', 'dim_xabc')?.targetField, 'abc_id', '三个字母起按后缀匹配');
    // 推荐数量
    const many = recommendTables([{ table: 'f', fields: ['a_id', 'bb_id', 'cc_id'] }], ['a', 'bb', 'cc'], 2);
    assert.equal(many.length, 2, '推荐数量不超过上限');
  }

  // --- 字段角色推断 ---
  assert.equal(inferRole('int'), 'measure');
  assert.equal(inferRole('DECIMAL(18,2)'), 'measure');
  assert.equal(inferRole('varchar'), 'dimension');
  assert.equal(inferRole('datetime'), 'dimension', 'a date is a dimension even though it sorts like a number');
  assert.equal(inferRole('year'), 'dimension', 'YEAR is numeric in MySQL but nobody sums it');
  assert.equal(inferRole(undefined), 'dimension');
  // 主键外键几乎都是整数,但没人对 id 求和 —— 名字比类型更说明问题
  assert.equal(inferRole('int', 'store_id'), 'dimension', 'a foreign key is not a measure');
  assert.equal(inferRole('bigint', 'id'), 'dimension');
  assert.equal(inferRole('varchar', 'store_code'), 'dimension');
  assert.equal(inferRole('int', 'stat_year'), 'dimension', 'a year stored as a number is still a dimension');
  assert.equal(inferRole('decimal', 'amount'), 'measure', 'a real measure is unaffected');
  assert.equal(inferRole('int', 'order_count'), 'measure');

  // --- SQL 数据集原样透传 ---
  const sqlDs = { ...createDataset('订单', 'c1'), source: { kind: 'sql', sql: '  SELECT * FROM orders  ' } };
  assert.equal(buildDatasetSql(sqlDs, 'mysql'), 'SELECT * FROM orders');

  // --- 关联数据集 ---
  const joinDs = {
    ...createDataset('网点销售', 'c1', 'shop_dws'),
    source: {
      kind: 'join',
      base: { table: 'sales', alias: 's' },
      joins: [{ id: 'j1', table: 'store', alias: 'st', kind: 'left', on: [{ field: 'store_id', targetAlias: 's', targetField: 'store_id' }] }],
      columns: [
        { alias: 's', field: 'amount' },
        { alias: 'st', field: 'name', as: 'outlet_name' },
      ],
    },
  };
  const sql = buildDatasetSql(joinDs, 'mysql');
  assert(sql.includes('LEFT JOIN'), 'the join kind is honoured');
  assert(sql.includes('`s`.`amount` AS `s_amount`'), 'columns are prefixed so two tables cannot collide');
  assert(sql.includes('`st`.`name` AS `outlet_name`'), 'an explicit alias wins over the generated one');
  assert(sql.includes('`st`.`store_id` = `s`.`store_id`'), 'the join condition points at the table already in FROM');
  assert(sql.includes('`shop_dws`.`sales`'), 'MySQL qualifies by database');

  // 引擎不同,引用符也不同 —— 同一个数据集换到 Postgres 要用双引号。
  const pg = buildDatasetSql(joinDs, 'postgres');
  assert(pg.includes('"s"."amount"'), `postgres quoting: ${pg}`);
  assert(!pg.includes('`'), 'no backticks leak into postgres');

  // 没选列时各表全选
  const starSql = buildDatasetSql({ ...joinDs, source: { ...joinDs.source, columns: [] } }, 'mysql');
  assert(starSql.includes('`s`.*') && starSql.includes('`st`.*'));

  assert.equal(joinColumnAlias('st', 'name'), 'st_name');

  // --- 校验 ---
  const ok = validateDataset(joinDs);
  assert.equal(ok, undefined, `a complete join should validate, got: ${ok}`);
  assert(validateDataset({ ...joinDs, name: ' ' }), 'a dataset needs a name');
  assert(validateDataset({ ...joinDs, connectionId: '' }), 'a dataset needs a connection');
  assert(validateDataset({ ...sqlDs, source: { kind: 'sql', sql: '' } }), 'empty SQL is rejected');

  const noOn = { ...joinDs, source: { ...joinDs.source, joins: [{ ...joinDs.source.joins[0], on: [] }] } };
  assert(/关联字段/.test(validateDataset(noOn)), 'a join without conditions is rejected');

  // 关联到一张还没加入 FROM 的表 —— 生成的 SQL 会引用不存在的别名
  const forward = { ...joinDs, source: { ...joinDs.source, joins: [{ ...joinDs.source.joins[0], on: [{ field: 'x', targetAlias: 'later', targetField: 'y' }] }] } };
  assert(validateDataset(forward), 'joining to a table that is not in FROM yet is rejected');

  const dupAlias = {
    ...joinDs,
    source: { ...joinDs.source, joins: [joinDs.source.joins[0], { ...joinDs.source.joins[0], id: 'j2', alias: 'st' }] },
  };
  assert(/别名/.test(validateDataset(dupAlias)), 'duplicate table aliases are rejected');

  // --- 组件查询:数据集进子查询,外面聚合 ---
  const ds = { ...createDataset('销售', 'c1', 'db'), source: { kind: 'sql', sql: 'SELECT * FROM sales' } };
  const agg = buildWidgetSql(ds, {
    dimensions: ['store'],
    measures: [{ field: 'amount', agg: 'sum' }, { field: 'orders', agg: 'count_distinct', alias: 'order_cnt' }],
    topN: 10,
  }, 'mysql');
  assert(agg.includes('FROM (SELECT * FROM sales) `t`'), `dataset goes in a subquery: ${agg}`);
  assert(agg.includes('SUM(`amount`) AS `amount`'));
  assert(agg.includes('COUNT(DISTINCT `orders`) AS `order_cnt`'), 'the alias is used for the output column');
  assert(agg.includes('GROUP BY `store`'));
  assert(agg.includes('ORDER BY `amount` DESC'), 'top N sorts by the first measure');
  assert(agg.includes('LIMIT 10'));

  // Oracle 没有 LIMIT
  const ora = buildWidgetSql(ds, { dimensions: [], measures: [{ field: 'amount', agg: 'sum' }], topN: 5 }, 'oracle');
  assert(ora.includes('FETCH FIRST 5 ROWS ONLY'), `oracle pagination: ${ora}`);
  assert(!ora.includes('GROUP BY'), 'no dimension means one total row, not a grouping');

  // 维度取值来自使用者的筛选框,必须转义
  const filtered = buildWidgetSql(ds, {
    dimensions: ['store'], measures: [{ field: 'amount', agg: 'sum' }],
    filters: [{ field: 'store', values: ["O'Brien", 'B店'] }, { field: 'skip', values: [] }],
  }, 'mysql');
  assert(filtered.includes("IN ('O''Brien', 'B店')"), `quote is escaped: ${filtered}`);
  assert(!filtered.includes('`skip`'), 'a filter with no values does not narrow anything');

  // 没有度量:至少让人看到维度有哪些取值,而不是报错。按维度排,列表才是稳定有序的。
  const dimOnly = buildWidgetSql(ds, { dimensions: ['store'], measures: [] }, 'mysql');
  assert(dimOnly.includes('GROUP BY `store`'));
  assert(dimOnly.includes('ORDER BY `store`'), `a de-duplicated list still needs a stable order: ${dimOnly}`);

  // --- 关联字段自动推断:省掉从两串字段里翻出该对上的那两个 ---
  // 以前真机上猜错过:demo_sales 连 demo_customers 猜成了 id = id(两边主键对主键)
  const sales = ['id', 'sale_date', 'customer_id', 'product_id', 'amount'];
  const customers = ['id', 'name', 'city', 'created_at'];
  assert.deepEqual(guessJoin(customers, sales, 'demo_sales', 'demo_customers'),
    { field: 'id', targetField: 'customer_id', reason: 'demo_sales.customer_id 指向 demo_customers' },
    '已有表里指向新表的键优先:sales.customer_id = customers.id,不能是 id = id');
  // 反过来:新表里有指向已有表的键
  const items = guessJoin(['id', 'order_id', 'qty'], ['id', 'order_date'], 'orders', 'order_items');
  assert.deepEqual([items.field, items.targetField], ['order_id', 'id'], 'order_items.order_id = orders.id');
  // 分层前缀、复数、大小写、下划线都不影响
  const dim = guessJoin(['id', 'store_name'], ['StoreID', 'gmv'], 'ads_store_day', 'dim_stores');
  assert.deepEqual([dim.field, dim.targetField], ['id', 'StoreID']);
  // 同名的键(两边都有 store_id)
  const shared = guessJoin(['store_id', 'member_cnt'], ['store_id', 'gmv'], 'ads_store_day', 'ads_member_day');
  assert.deepEqual([shared.field, shared.targetField], ['store_id', 'store_id']);
  // 主键对主键、普通同名列(name / created_at)都不猜 —— 猜错了看起来是对的,比不猜更糟
  assert.equal(guessJoin(['id', 'name'], ['id', 'name'], 'a', 'b'), undefined);
  assert.equal(guessJoin(['amount'], ['title'], 'a', 'b'), undefined);
  // 挂到哪张已有的表上:「指向」比「同名」有把握
  const across = guessJoinAcross('dim_area', ['id', 'area_name'], [
    { alias: 't1', table: 'ads_store_day', fields: ['store_id', 'gmv'] },
    { alias: 't2', table: 'dim_store', fields: ['id', 'area_id'] },
  ]);
  assert.deepEqual([across.targetAlias, across.targetField, across.field], ['t2', 'area_id', 'id'], '区域表挂到门店表上(dim_store.area_id)');
  // 推荐下一张表:已有表里的 xxx_id 在库里找得到对应的表
  const rec = recommendTables([{ table: 'demo_sales', fields: sales }], ['demo_sales', 'demo_customers', 'demo_products', 'monthly_revenue']);
  assert.deepEqual(rec, [{ table: 'demo_customers', via: 'customer_id' }, { table: 'demo_products', via: 'product_id' }]);
  assert.deepEqual(recommendTables([{ table: 'ads_store_day', fields: ['store_id'] }], ['dim_sales_store', 'dim_store'])[0].table, 'dim_store',
    '词干完全一样的优先');
  assert.equal(tableStem('dw.dim_categories'), 'category');

  // --- 关联:多个条件、运算符、AND/OR ---
  const multi = {
    ...joinDs,
    fields: [],
    source: { ...joinDs.source, joins: [{
      id: 'j1', table: 'store', alias: 'st', kind: 'inner',
      on: [
        { field: 'store_id', targetAlias: 's', targetField: 'store_id' },
        { field: 'dt', op: '>=', targetAlias: 's', targetField: 'start_dt', connector: 'and' },
        { field: 'flag', op: '<>', targetAlias: 's', targetField: 'flag', connector: 'or' },
      ],
    }] },
  };
  const multiSql = buildDatasetSql(multi, 'mysql');
  assert(multiSql.includes('INNER JOIN'), 'join kind honoured');
  assert(multiSql.includes('`st`.`store_id` = `s`.`store_id` AND `st`.`dt` >= `s`.`start_dt` OR `st`.`flag` <> `s`.`flag`'),
    `multi-condition join: ${multiSql}`);
  // 没填完的条件不该产出半截 SQL
  const halfCond = { ...multi, source: { ...multi.source, joins: [{ ...multi.source.joins[0], on: [{ field: 'x', targetAlias: 's', targetField: '' }] }] } };
  assert(buildDatasetSql(halfCond, 'mysql').includes('ON 1 = 1'), 'an unfinished condition does not emit half an expression');

  // --- 计算字段:表达式里的字段名换成真实引用 ---
  const calcDs = {
    ...createDataset('销售', 'c1', 'db'),
    source: { kind: 'join', base: { table: 'sales', alias: 's' }, joins: [], columns: [] },
    fields: [
      { name: 'offline_gmv', column: 'offline_gmv_amt', from: 's', role: 'measure' },
      { name: 'online_gmv', column: 'online_gmv_amt', from: 's', role: 'measure' },
      { name: '总GMV', role: 'measure', expr: 'offline_gmv + online_gmv' },
    ],
  };
  const calcSql = buildDatasetSql(calcDs, 'mysql');
  assert(calcSql.includes('`s`.`offline_gmv_amt` + `s`.`online_gmv_amt` AS `总GMV`'), `calculated field: ${calcSql}`);

  // 长名字先替换,短名字不能把长名字咬掉一半
  const prefixDs = {
    ...calcDs,
    fields: [
      { name: 'gmv', column: 'gmv', from: 's', role: 'measure' },
      { name: 'gmv_amt', column: 'gmv_amt', from: 's', role: 'measure' },
      { name: 'both', role: 'measure', expr: 'gmv_amt - gmv' },
    ],
  };
  assert(buildDatasetSql(prefixDs, 'mysql').includes('`s`.`gmv_amt` - `s`.`gmv` AS `both`'),
    `longest name wins: ${buildDatasetSql(prefixDs, 'mysql')}`);

  // --- 分组字段:生成 CASE WHEN,取值要转义 ---
  const groupDs = {
    ...calcDs,
    fields: [
      { name: 'outlet_region', column: 'outlet_region', from: 's', role: 'dimension' },
      { name: '网点类型', role: 'dimension', grouping: {
        source: 'outlet_region',
        buckets: [{ label: '直营', values: ['A', "O'Brien"] }, { label: '加盟', values: ['B'] }],
        fallback: '其他',
      } },
    ],
  };
  const groupSql = buildDatasetSql(groupDs, 'mysql');
  assert(groupSql.includes("WHEN `s`.`outlet_region` IN ('A', 'O''Brien') THEN '直营'"), `grouping: ${groupSql}`);
  assert(groupSql.includes("WHEN `s`.`outlet_region` = 'B' THEN '加盟'"), 'a single value uses = rather than IN');
  assert(groupSql.includes("ELSE '其他' END AS `网点类型`"));

  // --- 排序:时间轴必须按时间走,不能按数值 ---
  const tsDs = { ...createDataset('日销', 'c1', 'db'), source: { kind: 'sql', sql: 'SELECT * FROM daily' } };
  const timeline = buildWidgetSql(tsDs, {
    dimensions: ['stat_date'], measures: [{ field: 'gmv', agg: 'sum' }],
  }, 'mysql');
  assert(/ORDER BY `stat_date`\s*$/m.test(timeline), `a timeline sorts by its dimension: ${timeline}`);
  assert(!timeline.includes('ORDER BY `gmv` DESC'),
    'sorting a line chart by value scrambles the x axis into what looks like a cumulative curve');

  // 要前 N 名时才按度量降序
  const top = buildWidgetSql(tsDs, {
    dimensions: ['store'], measures: [{ field: 'gmv', agg: 'sum' }], topN: 5,
  }, 'mysql');
  assert(top.includes('ORDER BY `gmv` DESC') && top.includes('LIMIT 5'), `top N: ${top}`);

  // --- 看板的数据日期落成 WHERE,而且落在原始列上(索引才用得上) ---
  const ranged = buildWidgetSql(tsDs, {
    dimensions: ['stat_date'], measures: [{ field: 'gmv', agg: 'sum' }],
    grains: { stat_date: 'month' },
    dateRange: { field: 'stat_date', start: '2026-09-01', end: '2026-09-16' },
  }, 'mysql');
  assert(ranged.includes("WHERE `stat_date` >= '2026-09-01' AND `stat_date` < '2026-09-17'"), `date range: ${ranged}`);

  /* Oracle 的 DATE 列不认 '2026-09-01':隐式转换按会话 NLS_DATE_FORMAT(默认 DD-MON-RR),
     真库上直接 ORA-01861。DATE '…' 对 DATE / TIMESTAMP 都成立;字符串存的日期列反过来不认它。 */
  const oraRange = (type) => buildWidgetSql({ ...tsDs, fields: [{ name: 'stat_date', role: 'dimension', type }] }, {
    dimensions: [], measures: [{ field: 'gmv', agg: 'sum' }],
    dateRange: { field: 'stat_date', start: '2026-09-01', end: '2026-09-16' },
  }, 'oracle');
  assert(oraRange('DATE').includes(`"stat_date" >= DATE '2026-09-01' AND "stat_date" < DATE '2026-09-17'`), `oracle date: ${oraRange('DATE')}`);
  assert(oraRange('VARCHAR2(10)').includes(`"stat_date" >= '2026-09-01'`), 'oracle text date column compares as text');

  // --- 时间粒度:分组和取值必须用同一个表达式 ---
  assert(ranged.includes("DATE_FORMAT(`stat_date`, '%Y-%m') AS `stat_date`"), `select grain: ${ranged}`);
  assert(ranged.includes("GROUP BY DATE_FORMAT(`stat_date`, '%Y-%m')"),
    `grouping must use the same expression as the select, or every row is its own group: ${ranged}`);
  assert(ranged.includes("ORDER BY DATE_FORMAT(`stat_date`, '%Y-%m')"));

  // 各引擎的截断函数不同
  const pgMonth = buildWidgetSql(tsDs, { dimensions: ['d'], measures: [], grains: { d: 'month' } }, 'postgres');
  assert(pgMonth.includes(`TO_CHAR("d", 'YYYY-MM')`), `postgres grain: ${pgMonth}`);
  const liteQ = buildWidgetSql(tsDs, { dimensions: ['d'], measures: [], grains: { d: 'quarter' } }, 'sqlite');
  assert(liteQ.includes("strftime('%Y'"), `sqlite quarter: ${liteQ}`);
  const rawGrain = buildWidgetSql(tsDs, { dimensions: ['d'], measures: [], grains: { d: 'raw' } }, 'mysql');
  assert(rawGrain.includes('SELECT `d`') && !rawGrain.includes('DATE_FORMAT'), 'raw means untouched');

  // 计算字段能引用别的计算字段,于是 A=B+1 配 B=A+1 就是一个环。界面允许你这么写,
  // 没有环检测就是一路递归到爆栈;而光挡住不说,字段就那么没了,人不知道为什么。
  const cyc = {
    schemaVersion: 1, id: 'c', name: '环', connectionId: 'c1', database: 'db',
    source: { kind: 'join', base: { table: 't', alias: 't1' }, joins: [], columns: [] },
    fields: [
      { name: 'base', column: 'base', from: 't1', role: 'measure' },
      { name: 'a', role: 'measure', expr: 'b + 1' },
      { name: 'b', role: 'measure', expr: 'a + 1' },
    ],
    updatedAt: '',
  };
  assert.equal(derivedExpr(cyc.fields[1], cyc, 'mysql'), undefined, '成环就算不出来,别递归下去');
  assert.match(validateDataset(cyc) ?? '', /互相引用/, '要说清是哪几个字段,不能让它悄悄消失');

  // 正常的链式引用(a 引 b,b 引原始列)照常展开,别被环检测误伤。
  const chain = { ...cyc, fields: [cyc.fields[0], { name: 'a', role: 'measure', expr: 'b + 1' }, { name: 'b', role: 'measure', expr: 'base * 2' }] };
  const expanded = derivedExpr(chain.fields[1], chain, 'mysql');
  assert(expanded && /base/.test(expanded), `链式引用要一层层展开: ${expanded}`);
  assert.equal(validateDataset(chain), undefined, '正常的链不该报错');

  // 同一个字段被引用两次也不是环。
  const twice = { ...cyc, fields: [cyc.fields[0], { name: 'a', role: 'measure', expr: 'base + base' }] };
  assert(derivedExpr(twice.fields[1], twice, 'mysql')?.includes('base'), '引用两次不是环');

  // 认不出来的词一律放过:ROUND、CASE、字面量都不是字段名。想分辨"打错字"和"SQL 函数"
  // 只能靠数据库 —— 字段编辑器里的「校验」就是拿一行真跑一遍。这里确认我们没有自作聪明。
  const fn = { ...cyc, fields: [cyc.fields[0], { name: 'a', role: 'measure', expr: 'ROUND(base, 2)' }] };
  const kept = derivedExpr(fn.fields[1], fn, 'mysql');
  assert(kept && /ROUND\(/.test(kept), `SQL 函数要原样留着: ${kept}`);
  assert.equal(validateDataset(fn), undefined, '用了函数不该被判成坏字段');

  // 分组字段依据的列被删掉,同样得说。
  const orphan = { ...cyc, fields: [cyc.fields[0], { name: 'g', role: 'dimension', grouping: { source: 'gone', buckets: [{ label: 'x', values: ['1'] }], fallback: '' } }] };
  assert.match(validateDataset(orphan) ?? '', /依据的列不在了/, '分组字段的来源没了要说');

  console.log('dataset model: 75 assertions passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
