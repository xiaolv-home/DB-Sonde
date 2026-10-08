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
  const { backslashEscapes, hashComments } = dialectFor(kind);
  let quote: string | null = null;
  for (let i = 0; i < where.length; i += 1) {
    const ch = where[i];
    if (quote) {
      if (backslashEscapes && ch === "\\" && quote !== "`") { i += 1; continue; }
      if (ch === quote) {
        if (where[i + 1] === quote) { i += 1; continue; } // '' "" `` 是转义
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; continue; }
    if (ch === ";") return "过滤条件里不能有分号 —— 这里只能写一个条件,不能写多条语句";
    if ((ch === "-" && where[i + 1] === "-") || (ch === "/" && where[i + 1] === "*") || (hashComments && ch === "#"))
      return "过滤条件里不能写注释(-- /* #),会把后面的分页条件注释掉";
  }
  if (quote) return "过滤条件里有没闭合的引号";
  return null;
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
  if (opts.orderBy?.length) {
    const clauses = opts.orderBy.map((sort) =>
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

/** DELETE for one row, matched by its full primary key. */
export function buildRowDelete(
  kind: DbKind | undefined,
  database: string | undefined,
  schema: string | undefined,
  table: string,
  primaryKey: Record<string, Cell>,
): string {
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
): SqlScanState {
  const { backslashEscapes, hashComments } = dialectFor(kind);
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
      if (ch === "/" && next === "*") { blockDepth += 1; i += 2; }
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

    if (ch === "-" && next === "-") { lineComment = true; i += 2; }
    /* MySQL / ClickHouse 的 `#` 行注释。不认它的话,注释里写个分号就会把语句切成两半
       —— 「# 网点实收日汇总;点评平台」这种中文注释里带分号很常见。
       PG 不能开:那儿 `#` 是 `#>` 这类运算符的一部分,当成注释会吞掉后面整行。 */
    else if (hashComments && ch === "#") { lineComment = true; i += 1; }
    else if (ch === "/" && next === "*") { blockDepth = 1; i += 2; }
    else if (ch === "'" || ch === '"' || ch === "`") {
      /* PG 的 E'...' / e'...':前一个字符是 E 且再前面不是标识符的一部分
         (免得把 `value` 这种以 e 结尾的词尾巴当成前缀)。 */
      escapeString =
        ch === "'" &&
        (text[i - 1] === "E" || text[i - 1] === "e") &&
        !/[A-Za-z0-9_$]/.test(text[i - 2] ?? "");
      quote = ch;
      i += 1;
    } else if (ch === "$") {
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

export function splitSqlStatements(script: string, kind?: DbKind): string[] {
  const statements: string[] = [];
  let start = 0;
  const push = (end: number) => {
    const statement = script.slice(start, end).trim();
    if (statement) statements.push(statement);
    start = end + 1;
  };
  scanSql(script, kind, emptyScanState(), (i) => {
    if (script[i] === ";") push(i);
  });
  const tail = script.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}
