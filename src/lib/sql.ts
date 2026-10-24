import { dialectFor, paginationClause } from "./databaseDialect";
import type { Cell, DbKind } from "../types";

/** Quote an identifier for the given engine. */
export function quoteIdent(kind: DbKind | undefined, name: string): string {
  const quote = dialectFor(kind).identifierQuote;
  return quote + name.split(quote).join(quote + quote) + quote;
}

/** Fully-qualified table reference, including database/schema when present. */
export function qualifiedTable(
  kind: DbKind | undefined,
  database: string | undefined,
  schema: string | undefined,
  table: string,
): string {
  const parts: string[] = [];
  const namespace = dialectFor(kind).namespace;
  const qualifier = namespace === "database" ? database : namespace === "schema" ? schema : undefined;
  if (qualifier) parts.push(quoteIdent(kind, qualifier));
  parts.push(quoteIdent(kind, table));
  return parts.join(".");
}

export function selectPreview(
  kind: DbKind | undefined,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  limit = 200,
): string {
  return `SELECT *\nFROM ${qualifiedTable(kind, database, schema, table)}\n${paginationClause(kind, limit)};`;
}

export interface DataQueryOptions {
  /** Raw WHERE condition (without the WHERE keyword), or empty for none. */
  where?: string;
  /** Ordered sort keys. Array order is SQL precedence (1, 2, 3...). */
  orderBy?: { column: string; dir: "asc" | "desc" }[];
  limit: number;
  offset: number;
  /** 主键列。按 OFFSET 翻页必须有确定的顺序,否则 PG / Oracle 每页的行序可以不一样,
   *  往下滚会看到重复的行、漏掉的行。没排序就按主键排;排序列有并列时主键补在后面。 */
  stableBy?: string[];
}

/**
 * 数据页 WHERE 过滤框里的内容只许是「一个条件表达式」。
 *
 * 它会被原样拼进 SELECT / COUNT / 整列 UPDATE。实测过:输入 `1=1; DELETE FROM t; SELECT 1`
 * 会真的把表删空 —— 驱动允许一次执行多条语句。注释同样危险:`x=1 -- 备注` 会把后面拼的
 * LIMIT 注释掉,数据页就去拉整张表。所以在引号外出现 `;`、`--`、`/*`(MySQL 还有 `#`)
 * 一律拒绝;引号没闭合也拒绝(拼进去会吞掉后面的语句)。
 * 返回 null 表示可以用,否则是给用户看的原因。
 */
export function checkWhereClause(where: string, kind?: DbKind): string | null {
  /* 引号、注释怎么算走唯一那份扫描器 —— 这儿原来自己写了一个,不认 PG 的 E'…'(那里面 \ 是转义),
     `a = E'\''; DELETE FROM t; SELECT E'\''` 在它眼里分号全在字符串里,PG 读出来却是三条语句。 */
  let problem: string | null = null;
  const end = scanSql(where, kind, emptyScanState(), (i) => {
    if (where[i] === ";") problem ??= "过滤条件里不能有分号 —— 这里只能写一个条件,不能写多条语句";
  }, () => { problem ??= "过滤条件里不能写注释(-- /* #),会把后面的分页条件注释掉"; });
  if (problem) return problem;
  if (end.quote || end.dollarTag) return "过滤条件里有没闭合的引号";
  return null;
}

/**
 * 在已有的过滤条件上再叠一个。旧条件要加括号:`a=1 OR b=2` 直接接 `AND c=3`
 * 就成了 `a=1 OR (b=2 AND c=3)` —— 看到的行不对,整列赋值也会改到不该改的行。
 */
export function andWhere(current: string, clause: string): string {
  const cur = current.trim();
  return cur ? `(${cur}) AND ${clause}` : clause;
}

function assertWhere(where: string | undefined, kind?: DbKind): string | undefined {
  const w = where?.trim();
  if (!w) return undefined;
  const problem = checkWhereClause(w, kind);
  if (problem) throw new Error(problem);
  return w;
}

/** Build a paginated / sorted / filtered data query for browsing a table. */
export function buildDataQuery(
  kind: DbKind | undefined,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  opts: DataQueryOptions,
): string {
  const parts = ["SELECT *", `FROM ${qualifiedTable(kind, database, schema, table)}`];
  const where = assertWhere(opts.where, kind);
  if (where) parts.push(`WHERE ${where}`);
  const sorts = [...(opts.orderBy ?? [])];
  for (const column of opts.stableBy ?? []) {
    if (!sorts.some((sort) => sort.column === column)) sorts.push({ column, dir: "asc" });
  }
  if (sorts.length) {
    const clauses = sorts.map((sort) =>
      `${quoteIdent(kind, sort.column)} ${sort.dir === "desc" ? "DESC" : "ASC"}`,
    );
    parts.push(`ORDER BY ${clauses.join(", ")}`);
  }
  parts.push(paginationClause(kind, opts.limit, opts.offset));
  return parts.join("\n");
}

/** Whole-column UPDATE honouring the browser's current WHERE filter.
 *  Used by "select whole column → set value", which writes every matching
 *  row in the table, not just the loaded page. */
export function buildColumnUpdate(
  kind: DbKind | undefined,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  column: string,
  value: unknown,
  where?: string,
): string {
  const w = assertWhere(where, kind);
  const set = `SET ${quoteIdent(kind, column)} = ${sqlLiteral(value, kind)}`;
  return `UPDATE ${qualifiedTable(kind, database, schema, table)} ${set}${w ? ` WHERE ${w}` : ""}`;
}

/** COUNT(*) for the currently-filtered table — used to tell the user how many
 *  rows a whole-column update will touch before they commit it. */
export function buildCountQuery(
  kind: DbKind | undefined,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  where?: string,
): string {
  const w = assertWhere(where, kind);
  return `SELECT COUNT(*) AS n FROM ${qualifiedTable(kind, database, schema, table)}${w ? ` WHERE ${w}` : ""}`;
}

/** INSERT for a newly-added row. Only columns the user actually filled are
 *  written, so auto-increment keys and defaulted columns are left to the DB.
 *  Returns null when the row is entirely empty (nothing to insert). */
export function buildRowInsert(
  kind: DbKind | undefined,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  columnNames: string[],
  values: Cell[],
): string | null {
  const entries = columnNames
    .map((name, i) => ({ name, value: values[i] }))
    .filter((e) => e.value !== null && e.value !== undefined);
  if (!entries.length) return null;
  const cols = entries.map((e) => quoteIdent(kind, e.name)).join(", ");
  const vals = entries.map((e) => sqlLiteral(e.value, kind)).join(", ");
  return `INSERT INTO ${qualifiedTable(kind, database, schema, table)} (${cols}) VALUES (${vals})`;
}

/**
 * DELETE for one row, matched by its full primary key —— 或者(表没有主键时)按整行的值。
 *
 * 整行定位时:值是 NULL 的列写 IS NULL;而且只删一行 —— 有两行一模一样时,界面上消失的
 * 是一行,库里也只该少一行。各家「只删一行」的写法不同。
 */
export function buildRowDelete(
  kind: DbKind | undefined,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  primaryKey: Record<string, Cell>,
  wholeRow = false,
): string {
  if (wholeRow) return buildWholeRowDelete(kind, qualifiedTable(kind, database, schema, table), primaryKey);
  /* 主键按定义不可能是 NULL。这儿收到 null/undefined 只说明调用方没把值取全
     (最常见的是主键列不在当前结果里),而 `WHERE id IS NULL` 会变成一条删不掉任何行、
     却看着执行成功的语句 —— 界面上那行消失了,库里还在。宁可报错。 */
  const entries = Object.entries(primaryKey);
  const missing = entries.filter(([, value]) => value === null || value === undefined).map(([name]) => name);
  if (!entries.length || missing.length) {
    throw new Error(`删除需要完整的主键值,缺少:${missing.join("、") || "(没有任何主键列)"}`);
  }
  const clauses = entries.map(([name, value]) => {
    const column = quoteIdent(kind, name), literal = sqlLiteral(value, kind);
    const unsafeInteger = typeof value === "string" && /^[+-]?\d+$/.test(value)
      && (BigInt(value) > 9007199254740991n || BigInt(value) < -9007199254740991n);
    const exact = (kind === "mysql" || kind === "mariadb") && unsafeInteger
      ? ` AND CAST(${column} AS CHAR) = ${literal}` : "";
    return `${column} = ${literal}${exact}`;
  });
  return `DELETE FROM ${qualifiedTable(kind, database, schema, table)} WHERE ${clauses.join(" AND ")}`;
}

function buildWholeRowDelete(kind: DbKind | undefined, table: string, values: Record<string, Cell>): string {
  const entries = Object.entries(values);
  if (!entries.length) throw new Error("这张表没有能用来定位一行的列");
  const where = entries.map(([name, value]) => {
    const column = quoteIdent(kind, name);
    return value === null || value === undefined ? `${column} IS NULL` : `${column} = ${sqlLiteral(value, kind)}`;
  }).join(" AND ");
  switch (kind) {
    case "mysql":
    case "mariadb":
      return `DELETE FROM ${table} WHERE ${where} LIMIT 1`;
    case "postgres":
      return `DELETE FROM ${table} WHERE ctid = (SELECT ctid FROM ${table} WHERE ${where} LIMIT 1)`;
    case "oracle":
      return `DELETE FROM ${table} WHERE ${where} AND ROWNUM = 1`;
    case "clickhouse":
      throw new Error("ClickHouse 不支持在表格里删行");
    default:
      return `DELETE FROM ${table} WHERE rowid = (SELECT rowid FROM ${table} WHERE ${where} LIMIT 1)`;
  }
}

/**
 * 一个日历日(YYYY-MM-DD,调用方已校验)写成能跟日期列比的字面量。
 *
 * Oracle 不能写 '2026-10-01':DATE 列跟字符串比要按会话的 NLS_DATE_FORMAT 隐式转换,
 * 默认是 DD-MON-RR,直接 ORA-01861。DATE '…' 对 DATE 和 TIMESTAMP 列都成立;
 * 反过来,存成字符串的日期列不认 DATE '…'(同样 ORA-01861),所以知道是文本列时照旧比字符串。
 * 别家的字符串跟日期列比都会自己转,不用管。
 */
export function dateLiteral(day: string, kind: DbKind | undefined, textColumn: boolean): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`不是日期:${day}`);
  return kind === "oracle" && !textColumn ? `DATE '${day}'` : sqlLiteral(day, kind);
}

/** Render a cell value as a SQL literal for a filter built from the context menu. */
export function sqlLiteral(value: unknown, kind?: DbKind): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))
      throw new Error("数值超出精确范围，请刷新数据或以文本输入，未生成写入条件");
    return String(value);
  }
  if (typeof value === "boolean") return kind === "postgres" ? (value ? "TRUE" : "FALSE") : (value ? "1" : "0");
  const text = String(value);
  // MySQL hex text is independent of NO_BACKSLASH_ESCAPES and keeps user input
  // out of SQL syntax. Other backslash-aware engines need explicit escaping.
  if (text.includes("\\") && (kind === "mysql" || kind === "mariadb")) {
    const hex = Array.from(new TextEncoder().encode(text), b => b.toString(16).padStart(2, "0")).join("");
    return `CONVERT(X'${hex}' USING utf8mb4)`;
  }
  const escaped = (kind === "postgres" || kind === "clickhouse") ? text.replace(/\\/g, "\\\\") : text;
  return `${kind === "postgres" ? "E" : ""}'${escaped.replace(/'/g, "''")}'`;
}

/**
 * 按顶层分号把脚本拆成语句。扫描器会完整跳过字符串、带引号的标识符、行注释、
 * 块注释和 PostgreSQL 的 $$ 体 —— 不依赖编辑器的可视行,执行层才不会跟显示脱节。
 *
 * **反斜杠是不是转义符要看方言。** 原来一律当转义(双引号除外),于是在
 * PG / SQLite / Oracle 上:
 *
 *     UPDATE paths SET p = 'C:\';
 *     DELETE FROM old_logs WHERE ts < '2020-01-01';
 *     SELECT 1;
 *
 * 会被切成**一条** —— 扫描器以为 `\'` 是个转义引号,字符串没结束,把后面整个脚本
 * 连同分号一起吞了。用户看到的执行列表跟实际跑的不是一回事。这跟 readonly.rs 里
 * 修过的是同一个病根(那边是能绕过只读校验)。
 *
 * PG 的 `E'...'` 写法里反斜杠**是**转义,所以即使方言说不认,也要单独认出 E 前缀。
 *
 * @param kind 连接的数据库类型。不传时按不认反斜杠处理 —— 这是 SQL 标准的行为,
 *             也是 dialectFor() 的既定默认(sqlite)。
 */
/**
 * 这个引号里的反斜杠算不算转义。
 *   '...'  —— 方言说了算;PG 的 E'...' 另算(总是转义)
 *   "..."  —— MySQL 下是字符串,反斜杠转义;别处是标识符,反斜杠是普通字符
 *   `...`  —— MySQL 标识符,只认 `` 加倍,反斜杠永远是普通字符
 */
function backslashInside(quote: "'" | '"' | "`" | null, dialectEscapes: boolean, escapeString: boolean): boolean {
  if (quote === "`") return false;
  if (quote === "'") return dialectEscapes || escapeString;
  if (quote === '"') return dialectEscapes;
  return false;
}

/** 扫描器停在某处时的语境。跨调用续扫时原样传回去即可。 */
export interface SqlScanState {
  quote: "'" | '"' | "`" | null;
  /** 当前单引号串是不是 E'...' 开头(PG 的转义串)。 */
  escapeString: boolean;
  dollarTag: string | null;
  lineComment: boolean;
  blockDepth: number;
}

/** 一段还没开始扫的空白语境。 */
export const emptyScanState = (): SqlScanState => ({
  quote: null, escapeString: false, dollarTag: null, lineComment: false, blockDepth: 0,
});

/**
 * 唯一的一份 SQL 语境扫描器 —— 字符串、带引号的标识符、行注释、块注释、
 * PostgreSQL 的 $$ 体,全在这儿跳过。
 *
 * 这套逻辑原来有三份:拆语句一份,编辑器里 scanState 和 keywordUpperEdits 各一份
 * (后两份在同一个文件里逐字重复)。三份都把反斜杠一律当转义 —— 规则各写一遍,
 * 走散只是时间问题,而且它们必须对同一段 SQL 给出同一个答案,否则编辑器高亮的
 * 边界和实际执行的边界就对不上。
 *
 * @param onCode 每扫到一个**不在字符串/注释里**的字符就回调它的下标。
 *               拆语句靠它找顶层分号,编辑器靠它判断某个词该不该大写。
 * @returns 扫完之后的语境,供下一段续扫。
 */
export function scanSql(
  text: string,
  kind: DbKind | undefined,
  state: SqlScanState = emptyScanState(),
  onCode?: (index: number) => void,
  /** 每遇到一处注释的开头就回调一次。 */
  onComment?: (index: number) => void,
): SqlScanState {
  const { backslashEscapes, hashComments, dollarQuotes, nestedComments } = dialectFor(kind);
  let { quote, escapeString, dollarTag, lineComment, blockDepth } = state;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (lineComment) {
      if (ch === "\n") lineComment = false;
      i += 1;
      continue;
    }
    if (blockDepth > 0) {
      if (nestedComments && ch === "/" && next === "*") { blockDepth += 1; i += 2; }
      else if (ch === "*" && next === "/") { blockDepth -= 1; i += 2; }
      else i += 1;
      continue;
    }
    if (dollarTag) {
      if (text.startsWith(dollarTag, i)) { i += dollarTag.length; dollarTag = null; }
      else i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        if (next === quote) { i += 2; continue; }   // '' / "" / `` 是加倍转义
        quote = null;
        escapeString = false;
      } else if (ch === "\\" && backslashInside(quote, backslashEscapes, escapeString)) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (ch === "-" && next === "-") { onComment?.(i); lineComment = true; i += 2; }
    /* MySQL / ClickHouse 的 `#` 行注释。不认它的话,注释里写个分号就会把语句切成两半
       —— 「# 网点实收日汇总;点评平台」这种中文注释里带分号很常见。
       PG 不能开:那儿 `#` 是 `#>` 这类运算符的一部分,当成注释会吞掉后面整行。 */
    else if (hashComments && ch === "#") { onComment?.(i); lineComment = true; i += 1; }
    else if (ch === "/" && next === "*") { onComment?.(i); blockDepth = 1; i += 2; }
    else if (ch === "'" || ch === '"' || ch === "`") {
      /* PG 的 E'...' / e'...':前一个字符是 E 且再前面不是标识符的一部分
         (免得把 `value` 这种以 e 结尾的词尾巴当成前缀)。 */
      escapeString =
        ch === "'" &&
        (text[i - 1] === "E" || text[i - 1] === "e") &&
        !/[A-Za-z0-9_$]/.test(text[i - 2] ?? "");
      quote = ch;
      i += 1;
    } else if (ch === "$" && dollarQuotes) {
      const match = text.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) { dollarTag = match[0]; i += dollarTag.length; }
      else { onCode?.(i); i += 1; }
    } else {
      onCode?.(i);
      i += 1;
    }
  }
  return { quote, escapeString, dollarTag, lineComment, blockDepth };
}

/** 扫到这段文本末尾时处在什么语境 —— 编辑器用它接着往下扫。 */
export const sqlScanState = (text: string, kind?: DbKind, from?: SqlScanState): SqlScanState =>
  scanSql(text, kind, from ?? emptyScanState());

/**
 * 剥掉语句**最前面**的注释,好看清它到底是什么语句。
 *
 * `#` 也算,而且**不分方言** —— 没有哪种方言的语句能以 `#` 开头
 * (PG 的 `#` 只出现在 `#>` 这类运算符里,那是语句中间的事)。
 * 人习惯把说明写在 SQL 上面,不剥的话首词判断会看到注释里的词。
 *
 * 只用于判断「这是什么语句」。判断「这条语句里有没有写操作」必须扫**原文** ——
 * 按注释跳过的话,PG 上 `SELECT a #> b; DELETE FROM t` 的第二条就被藏起来了。
 *
 * 跟 src-tauri/src/db/mod.rs 的 strip_leading_noise 是同一套规则,两边各一份:
 * 一个在 Rust 一个在 TS,没法共用。改一边记得改另一边(两边都有测试钉着)。
 */
export function stripLeadingComments(sql: string): string {
  let text = sql.trimStart();
  for (;;) {
    if (text.startsWith("--") || text.startsWith("#")) {
      const nl = text.indexOf("\n");
      if (nl < 0) return "";
      text = text.slice(nl + 1).trimStart();
    } else if (text.startsWith("/*")) {
      const end = text.indexOf("*/", 2);
      if (end < 0) return "";
      text = text.slice(end + 2).trimStart();
    } else {
      return text;
    }
  }
}

/** Oracle 的 PL/SQL 程序单元:体内的分号是它自己的一部分,结尾的 `END;` 也得原样带着发出去。 */
const PLSQL_UNIT = /^(?:BEGIN|DECLARE|CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE|TRIGGER|TYPE))\b/i;
/** MySQL 客户端的 `DELIMITER $$`。分隔符只认符号 —— 拿一个词当分隔符(`DELIMITER DELETE`)
 *  会把那个词从语句里「吃掉」,只读校验就看不到它了。 */
const DELIMITER_LINE = /^DELIMITER[ \t]+([^\w\s'"`]+)[ \t]*(?:\r?\n|$)/i;

/**
 * 把脚本拆成一条条语句,拆的规矩跟各家的命令行客户端一致:
 *
 * - 一般按顶层分号拆(字符串、注释、PG 的 $$ 体里的不算,见 scanSql)。
 * - **Oracle 的 PL/SQL 块**(BEGIN / DECLARE / CREATE PROCEDURE、FUNCTION、PACKAGE、TRIGGER、TYPE)
 *   体内全是分号,按分号拆就成了 `BEGIN NULL` 和 `END` 两句,哪句都跑不了。它整段算一条,
 *   到单独一行的 `/` 为止(SQL*Plus / SQL Developer 的写法);没写 `/` 就到脚本末尾。
 * - **MySQL 的 `DELIMITER $$`**:之后按 `$$` 拆,存储过程体里的分号就不切了。
 * - 只有注释的片段扔掉 —— 脚本末尾留一行 `-- 备注`,Oracle 会对它报 ORA-00900,
 *   结果页最后停在一个莫名其妙的报错上。
 */
export function splitSqlStatements(script: string, kind?: DbKind): string[] {
  const statements: string[] = [];
  const oracle = kind === "oracle";
  const delimiterLines = kind === "mysql" || kind === "mariadb";
  let delimiter = ";";
  let start = 0;       // 当前语句从哪儿开始
  let skip = 0;        // 这之前的字符已经当分隔符 / DELIMITER 行处理掉了
  let begun = false;   // 当前语句里见到过正文没有
  let plsql = false;
  const lineEnd = (i: number) => {
    const nl = script.indexOf("\n", i);
    return nl < 0 ? script.length : nl + 1;
  };
  const aloneOnLine = (i: number) => {
    const before = script.lastIndexOf("\n", i - 1) + 1;
    return !script.slice(before, i).trim() && !script.slice(i + 1, lineEnd(i)).trim();
  };
  const push = (end: number, next: number) => {
    const statement = script.slice(start, end).trim();
    if (stripLeadingComments(statement)) statements.push(statement);
    start = skip = next;
    begun = plsql = false;
  };
  scanSql(script, kind, emptyScanState(), (i) => {
    if (i < skip) return;
    const ch = script[i];
    if (!begun) {
      if (/\s/.test(ch)) return;
      const directive = delimiterLines ? DELIMITER_LINE.exec(script.slice(i, lineEnd(i))) : null;
      if (directive) {
        delimiter = directive[1];
        push(i, lineEnd(i));
        return;
      }
      begun = true;
      plsql = oracle && PLSQL_UNIT.test(script.slice(i, i + 120));
    }
    if (oracle && ch === "/" && aloneOnLine(i)) push(i, i + 1);
    else if (!plsql && script.startsWith(delimiter, i)) push(i, i + delimiter.length);
  });
  push(script.length, script.length);
  return statements;
}
