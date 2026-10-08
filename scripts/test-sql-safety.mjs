// 拼进 SQL 的东西只有两类:标识符(加引号)和取值(转义)。这两件事全项目各自只能有一份实现。
//
// 出过的事:sqlLiteral 一度有三份 —— lib/sql.ts 一份、dashboard/semantic.ts 一份、
// datasets/domain.ts 里还有个叫 lit 的。后两份都比第一份弱:
//   · semantic 那份在 MySQL 开了 NO_BACKSLASH_ESCAPES 时会多插一个真反斜杠(筛选匹配不到数据);
//   · datasets 那份只把 ' 换成 '',反斜杠完全不管 —— 而它转义的是「分组规则」里人手敲的取值,
//     MySQL 默认拿反斜杠当转义符,一个以 \ 结尾的取值会把右引号吃掉,后面的 SQL 就接上去了。
// 同一件事写几遍,迟早只修其中一遍。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'sonde-sqlsafe-'));
try {
  const outfile = join(dir, 'tests.cjs');
  await build({
    stdin: { contents: `
      export { sqlLiteral } from './src/lib/sql';
      export { buildDatasetSql, normalizeDataset } from './src/features/datasets/domain';
      export { buildRowDelete, splitSqlStatements, scanSql, sqlScanState, stripLeadingComments, checkWhereClause, buildDataQuery, buildCountQuery, buildColumnUpdate } from './src/lib/sql';
      export { isReadOnlySql } from './src/features/ai/readonly';`,
      resolveDir: resolve('.'), loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  });
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  const { sqlLiteral, buildDatasetSql, buildRowDelete, splitSqlStatements, scanSql, sqlScanState, stripLeadingComments, isReadOnlySql, checkWhereClause, buildDataQuery, buildCountQuery, buildColumnUpdate } = createRequire(import.meta.url)(outfile);

  // ── 取值转义:以反斜杠结尾的值不能吃掉右引号 ────────────────────────────
  for (const kind of ['mysql', 'mariadb']) {
    const out = sqlLiteral('华东\\', kind);
    assert(!/'\\'$/.test(out), `${kind}:以反斜杠结尾的取值会把右引号吃掉 → ${out}`);
  }
  assert.equal(sqlLiteral("O'Reilly", 'mysql'), "'O''Reilly'", '单引号照旧翻倍');

  // ── 分组规则里的取值走的是同一份转义 ────────────────────────────────────
  const dataset = {
    schemaVersion: 1, id: 'd', name: 'x', connectionId: 'c', database: 'db',
    source: { kind: 'join', base: { table: 't', alias: 'a' }, joins: [], columns: [] },
    fields: [
      { name: 'region', column: 'region', from: 'a', role: 'dimension' },
      { name: '片区', role: 'dimension', from: 'a',
        grouping: { source: 'region', fallback: '其他', buckets: [{ label: '北区\\', values: ['华东\\', "O'Reilly"] }] } },
    ], updatedAt: '',
  };
  const sql = buildDatasetSql(dataset, 'mysql');
  assert(sql.includes('CASE'), '分组规则要编成 CASE');
  assert(!/'[^']*\\'/.test(sql.replace(/\\\\/g, '')),
    `分组取值里的反斜杠没转义,右引号被吃掉了:\n${sql}`);
  assert(sql.includes("O''Reilly"), '单引号照旧翻倍');

  // ── JOIN 运算符只认白名单 ──────────────────────────────────────────────
  const injected = {
    ...dataset, fields: [dataset.fields[0]],
    source: { kind: 'join', base: { table: 't', alias: 'a' }, columns: [],
      joins: [{ kind: 'left', table: 'd', alias: 'd', on: [
        { field: 'id', targetAlias: 'a', targetField: 'id', op: '= 1 OR 1' },
      ] }] },
  };
  const joined = buildDatasetSql(injected, 'mysql');
  assert(!joined.includes('OR 1'),
    `运算符是从磁盘上的 JSON 读回来的,不能原样拼进 ON 子句:\n${joined}`);
  assert(/ON .*`d`\.`id` = `a`\.`id`/.test(joined), `不认识的运算符要退回 = :\n${joined}`);

  /* ── 删除必须按完整主键定位 ────────────────────────────────────────────
     主键列不在当前结果里时(预览 SQL 只选了一部分列),取到的是 undefined,
     原来会拼成 `WHERE id IS NULL` —— 主键不可能是 NULL,那条 DELETE 一行都删不掉,
     可界面上那行已经消失、还提示成功。你以为删了,库里还在。 */
  assert.throws(() => buildRowDelete('mysql', 'db', undefined, 't', { id: undefined }),
    /完整的主键值/, '主键值取不到时必须报错,不能悄悄变成 IS NULL');
  assert.throws(() => buildRowDelete('mysql', 'db', undefined, 't', { a: 1, b: undefined }),
    /完整的主键值/, '复合主键缺一半同理 —— 那会删掉不该删的,或者一行都删不掉');
  assert.throws(() => buildRowDelete('mysql', 'db', undefined, 't', {}),
    /完整的主键值/, '一个主键列都没有时别生成 `WHERE `');
  assert.equal(buildRowDelete('mysql', 'db', undefined, 't', { id: 7 }),
    'DELETE FROM `db`.`t` WHERE `id` = 7', '主键齐全时照常生成');

  // ── 全项目只许有一份取值转义 ──────────────────────────────────────────
  const walk = (d) => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  const own = walk('src').filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('lib/sql.ts'));
  const rolled = own.filter((f) => {
    const body = readFileSync(f, 'utf8');
    // 自己拿 replace 把单引号翻倍 = 又写了一份转义
    return /replace\(\s*\/'\/g\s*,\s*["']''["']\s*\)/.test(body) || /split\("'"\)\.join\("''"\)/.test(body);
  });
  assert.deepEqual(rolled, [],
    `这些文件又自己写了一份取值转义,应该用 lib/sql.ts 的 sqlLiteral:\n  ${rolled.join('\n  ')}`);

  // ── 拆语句:反斜杠是不是转义要看方言 ──────────────────────────────────────
  {
    /* 原来一律把反斜杠当转义(双引号除外)。PG / SQLite / Oracle 里
       `'C:\\'` 是个以反斜杠结尾的完整字符串 —— 扫描器却以为字符串还没完,
       把后面整个脚本连同分号一起吞了,三条语句切成一条。
       跟 readonly.rs 里修过的是同一个病根(那边是能绕过只读校验)。 */
    const n = (sql, kind) => splitSqlStatements(sql, kind).length;
    for (const kind of ['postgres', 'sqlite', 'oracle', undefined]) {
      assert.equal(n(`UPDATE p SET x = 'C:\\';\nDELETE FROM logs;\nSELECT 1;`, kind), 3,
        `${kind ?? '(不传方言)'}:以反斜杠结尾的值不该吞掉后面的语句`);
    }
    // MySQL / ClickHouse 里反斜杠**确实**是转义,不能一刀切成"都不认"
    for (const kind of ['mysql', 'mariadb', 'clickhouse']) {
      assert.equal(n(`SELECT 'a\\'b';\nSELECT 2;`, kind), 2, `${kind}:\\' 是转义引号,字符串没结束`);
    }
    // PG 的 E'...' 里反斜杠是转义,即使方言说不认也要认出前缀
    assert.equal(n(`SELECT E'a\\'b';\nSELECT 2;`, 'postgres'), 2, "E'...' 里反斜杠是转义");
    assert.equal(n(`SELECT e'a\\'b';\nSELECT 2;`, 'postgres'), 2, '小写 e 也算');
    assert.equal(n(`SELECT value'x\\';\nSELECT 2;`, 'postgres'), 2, '以 e 结尾的词尾巴不算 E 前缀');
    // MySQL 反引号是标识符,只认 `` 加倍,反斜杠是普通字符
    assert.equal(n('SELECT `a\\` , 1;\nSELECT 2;', 'mysql'), 2, '反引号里反斜杠不是转义');
    // 原有能力不能退化
    assert.equal(n('SELECT 1; -- a; b\nSELECT 2;', 'postgres'), 2, '注释里的分号不切');
    assert.equal(n('SELECT 1; /* a; b */\nSELECT 2;', 'postgres'), 2, '块注释里的分号不切');
    assert.equal(n(`CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;\nSELECT 2;`, 'postgres'), 2,
      '$$ 体里的分号不切');
    assert.equal(n(`SELECT 'O''Reilly';\nSELECT 2;`, 'postgres'), 2, "'' 是标准转义,哪个方言都认");
  }

  // ── SQL 语境扫描器:全项目只许有一份 ────────────────────────────────────
  {
    /* 这套"跳过字符串/注释"的循环原来有三份:拆语句一份,SqlEditor 里
       scanState 和 keywordUpperEdits 各一份(后两份在同一个文件里逐字重复)。
       三份都把反斜杠一律当转义。规则各写一遍走散只是时间问题,而且它们必须对
       同一段 SQL 给出同一个答案 —— 编辑器判断"这个词在不在字符串里"的边界,
       跟执行层拆语句的边界,不该是两套。 */
    const codeOf = (text, kind) => {
      const out = [];
      scanSql(text, kind, undefined, (i) => out.push(text[i]));
      return out.join('');
    };
    assert.equal(codeOf("SELECT 'a;b' FROM t", 'postgres'), 'SELECT  FROM t', '字符串内容不算代码区');
    // 收尾那个换行归注释所有(原来的扫描器也是这样),所以不出现在代码区里
    assert.equal(codeOf('SELECT 1 -- a;b\nFROM t', 'postgres'), 'SELECT 1 FROM t', '行注释不算');
    assert.equal(codeOf('SELECT /* a;b */ 1', 'postgres'), 'SELECT  1', '块注释不算');
    assert.equal(codeOf('SELECT $$ a;b $$', 'postgres'), 'SELECT ', '$$ 体不算');
    assert.equal(codeOf('SELECT `a;b` FROM t', 'mysql'), 'SELECT  FROM t', '反引号标识符不算');

    // 续扫:编辑器是"先扫光标前的文本拿语境,再扫这次改动"
    const mid = sqlScanState("SELECT 'unfinished", 'postgres');
    assert.equal(mid.quote, "'", '停在字符串里');
    assert.equal(codeOf('still inside', 'postgres'), 'still inside', '对照:从空白语境扫就是代码区');
    {
      const out = [];
      scanSql("still inside' , 1", 'postgres', mid, (i) => out.push(i));
      assert.ok(out.length > 0 && out[0] >= "still inside'".length - 1,
        '带着"还在字符串里"的语境续扫,引号闭合之前都不算代码区');
    }

    // 守卫:除了 lib/sql.ts,别处不许再写这个循环
    const scanners = [];
    (function walk(d) {
      for (const name of readdirSync(d)) {
        const full = join(d, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && full !== resolve('src/lib/sql.ts')) {
          const text = readFileSync(full, 'utf8');
          // 开引号那一行是这类扫描器的标志
          if (/ch === "'" \|\| ch === '"' \|\| ch === "`"/.test(text)) scanners.push(full.slice(resolve('.').length + 1));
        }
      }
    })(resolve('src'));
    assert.deepEqual(scanners, [],
      '这些文件又自己写了一份 SQL 语境扫描器,应该用 lib/sql.ts 的 scanSql / sqlScanState:\n  '
      + scanners.join('\n  '));
  }

  // ── `#` 行注释:MySQL/ClickHouse 认,PG 不认 ──────────────────────────────
  {
    /* 真机上踩到的:在编辑器里选中
         #示例连锁网点实收日汇总-点评平台
         SELECT FLOW_DATE, COUNT(*) ... FROM t_shop_dish_flow_summary WHERE ...
       执行,结果只有一句「0 row(s) affected」—— Rust 端的 strip_leading_noise
       不认 `#`,把整条当成了写语句。那边已按"没有哪种方言的语句以 # 开头"一律剥掉;
       这边管的是语句**中间**的 `#`,必须分方言。 */
    const n = (sql, kind) => splitSqlStatements(sql, kind).length;
    for (const kind of ['mysql', 'mariadb', 'clickhouse']) {
      assert.equal(n('# 网点实收日汇总;点评平台\nSELECT 1;\nSELECT 2;', kind), 2,
        `${kind}:# 注释里的分号不该把语句切开`);
      assert.equal(n('SELECT 1; # 尾注;有分号\nSELECT 2;', kind), 2, `${kind}:行尾的 # 注释同理`);
    }
    /* PG 不能把 `#` 当注释:那儿 `#>` 是 JSON 运算符,当成注释会把后面整行连同
       分号一起吞掉,两条语句并成一条。 */
    assert.equal(n(`SELECT data #> '{a}' FROM t;\nSELECT 2;`, 'postgres'), 2,
      'PG 的 #> 是运算符,不是注释');
    assert.equal(n(`SELECT a #- b FROM t;\nSELECT 2;`, 'postgres'), 2, 'PG 的 #- 同理');
    // 字符串里的 # 哪种方言都不是注释
    assert.equal(n(`SELECT '#不是注释;' AS a;\nSELECT 2;`, 'mysql'), 2, '字符串里的 # 不算注释');
  }

  // ── 开头的注释不能挡住「这是什么语句」的判断 ──────────────────────────────
  {
    assert.equal(stripLeadingComments('#说明\nSELECT 1'), 'SELECT 1');
    assert.equal(stripLeadingComments('-- 说明\nSELECT 1'), 'SELECT 1');
    assert.equal(stripLeadingComments('/* 说明 */ SELECT 1'), 'SELECT 1');
    assert.equal(stripLeadingComments('#a\n-- b\n/* c */\n  SELECT 1'), 'SELECT 1', '混着也要剥干净');
    assert.equal(stripLeadingComments('#只有注释'), '', '只有注释就是空');
    assert.equal(stripLeadingComments('SELECT 1 #尾注'), 'SELECT 1 #尾注', '只剥开头,不动中间');

    /* AI 的只读闸门:`#说明\nSELECT …` 是最常见的写法,不能被当成不可读运行。 */
    assert.equal(isReadOnlySql('#示例连锁网点实收日汇总\nSELECT a FROM t'), true, '注释挡在前面也要认出 SELECT');
    assert.equal(isReadOnlySql('# daily revenue\nSELECT a FROM t'), true, '英文注释同理');
    /* 但写关键字仍然扫原文 —— PG 里 # 不是注释,藏在后面的写语句必须拦住。 */
    assert.equal(isReadOnlySql(`SELECT a #> 'x'; DELETE FROM sales`), false, '# 后面的 DELETE 要拦住');
    assert.equal(isReadOnlySql('#注释\nDELETE FROM t'), false, '注释挡着也还是写语句');
    /* 写关键字扫的是**原文**,所以开头注释里出现 delete 这个词也会被拦下。
       这是刻意的保守:这道闸门管的是 AI 生成的 SQL,拦错了的代价是「要人看一眼」,
       漏过去的代价是生产库少一张表。把这个选择钉住,免得有人觉得是误伤顺手放开。 */
    assert.equal(isReadOnlySql('# 先不要 delete 这张表\nSELECT 1'), false,
      '开头注释里的写关键字也拦 —— 宁可多拒,这是有意的');
  }

  // ── 文本排序只许有一份规则 ────────────────────────────────────────────────
  {
    /* 原来一半写 localeCompare(b, "zh-CN", { numeric: true })、一半写光秃秃的
       localeCompare(b)。后者跟着操作系统走:中文系统按拼音、英文系统按码点,
       「丙 甲 乙」变「丙 乙 甲」—— 换台电脑打开同一个库顺序就变了;而且没有
       numeric,「店10」排在「店2」前面。
       最要命的是两种同时存在:结果网格用系统默认排,看板表格用 zh-CN 排,
       同一列网点名两个地方两种顺序,都不说为什么。 */
    const offenders = [];
    (function walk(d) {
      for (const name of readdirSync(d)) {
        const full = join(d, name);
        if (statSync(full).isDirectory()) walk(full);
        // .runtime.js 要原样内联进离线网页,不能 import,规则只能自带一份
        else if (/\.(ts|tsx)$/.test(name) && full !== resolve('src/lib/collate.ts')) {
          const text = readFileSync(full, 'utf8');
          text.split('\n').forEach((line, i) => {
            const code = line.replace(/\/\/.*$/, '');
            if (/\.localeCompare\(/.test(code)) offenders.push(`${full.slice(resolve('.').length + 1)}:${i + 1}`);
          });
        }
      }
    })(resolve('src'));
    assert.deepEqual(offenders, [],
      '这些地方又自己写了一份文本排序规则,应该用 lib/collate.ts 的 compareText ——\n  '
      + '不传语言会跟着操作系统走,换台电脑顺序就变了:\n    ' + offenders.join('\n    '));
  }

  // ── 数据页 WHERE 过滤框:只能是一个条件 ──────────────────────────────
  // 实测事故:输入 `1=1; DELETE FROM items; SELECT 1` 真的把表删空了(驱动允许多语句)。
  {
    const ok = (w, kind = 'mysql') => assert.equal(checkWhereClause(w, kind), null, `应放行:${w} (${kind})`);
    const bad = (w, kind = 'mysql') => assert.notEqual(checkWhereClause(w, kind), null, `应拒绝:${w} (${kind})`);
    ok("store_id = 'x'"); ok("name like '%--%'"); ok("note = 'a;b'"); ok("a = 'it''s'"); ok('`order` = 1');
    ok("x = 'a\\'; DROP TABLE t'", 'mysql');        // MySQL 里 \' 是转义,分号还在字符串里
    ok('"select" = 1', 'postgres'); ok("t >= '2026-01-01' and t < '2026-02-01'", 'postgres');
    bad('1=1; DELETE FROM items; SELECT 1'); bad('1=1;'); bad('x=1 -- 备注'); bad('x=1 /* c */');
    bad('x=1 # c', 'mysql'); ok('x=1 # 不是注释', 'postgres') ; bad("name = 'abc");
    bad("x = 'a\\'; DROP TABLE t", 'postgres');          // PG 里 \ 不转义,字符串在 \' 处就结束了
    for (const kind of ['mysql', 'postgres', 'sqlite', 'oracle']) bad("1=1; DROP TABLE t", kind);
    // 三个拼 SQL 的地方都要自己再拦一道(不能只靠输入框)
    assert.throws(() => buildDataQuery('mysql', 'db', '', 't', { where: '1=1; DELETE FROM t', limit: 200, offset: 0 }), /分号/);
    assert.throws(() => buildCountQuery('mysql', 'db', '', 't', 'x=1 -- c'), /注释/);
    assert.throws(() => buildColumnUpdate('mysql', 'db', '', 't', 'c', 1, '1=1; DROP TABLE t'), /分号/);
    assert.match(buildDataQuery('mysql', 'db', '', 't', { where: "a = 'x;y'", limit: 200, offset: 0 }), /WHERE a = 'x;y'[\s\S]*LIMIT 200/);
  }

  console.log('sql safety: 59 assertions + WHERE 过滤框 passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
