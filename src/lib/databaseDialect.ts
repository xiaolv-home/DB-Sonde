import type { DbKind } from "../types";
export interface DatabaseDialect {
    identifierQuote: "`" | '"';
    namespace: "database" | "schema" | "none";
    pagination: "limit" | "fetch";
    /**
     * 普通字符串字面量里,反斜杠是不是转义符。
     *
     * MySQL / MariaDB / ClickHouse 认;PostgreSQL(standard_conforming_strings
     * 自 9.1 起默认 on)、SQLite、Oracle 不认 —— 那儿 `'C:\'` 就是个以反斜杠
     * 结尾的完整字符串,`''` 才是唯一的转义。
     *
     * 这条规则不写清楚就会出两种事故:拆语句时把 `'C:\';` 后面的整个脚本
     * 当成还在字符串里吞掉;拼取值时该加倍的没加倍、不该加倍的加倍了。
     * PG 另有 `E'...'` 写法,那种里面反斜杠**是**转义 —— 由扫描器单独认。
     */
    backslashEscapes: boolean;
    /**
     * `#` 开头到行尾算不算注释。
     *
     * MySQL / MariaDB / ClickHouse 算;PostgreSQL 不算 —— 那儿 `#` 是运算符的一部分
     * (`#>`、`#>>`、`|#|`、`#-`),当成注释会把 `data #> '{a}'` 之后的整行吞掉,
     * 包括分号,于是语句切错。SQLite 和 Oracle 也不认 `#`。
     *
     * 注意跟 Rust 端的 strip_leading_noise 分工不同:那边只看**语句开头**,
     * 而没有哪种方言的语句能以 `#` 开头,所以那边不分方言一律剥掉。
     * 这里管的是语句**中间**,必须分方言。
     */
    hashComments: boolean;
}
/** Syntax contract for implemented engines. Compatible brands reuse their engine. */
export const DATABASE_DIALECTS: Record<DbKind, DatabaseDialect> = {
    mysql: { identifierQuote: "`", namespace: "database", pagination: "limit", backslashEscapes: true, hashComments: true },
    mariadb: { identifierQuote: "`", namespace: "database", pagination: "limit", backslashEscapes: true, hashComments: true },
    postgres: { identifierQuote: '"', namespace: "schema", pagination: "limit", backslashEscapes: false, hashComments: false },
    sqlite: { identifierQuote: '"', namespace: "none", pagination: "limit", backslashEscapes: false, hashComments: false },
    oracle: { identifierQuote: '"', namespace: "schema", pagination: "fetch", backslashEscapes: false, hashComments: false },
    clickhouse: { identifierQuote: '"', namespace: "database", pagination: "limit", backslashEscapes: true, hashComments: true },
};
export function dialectFor(kind?: DbKind): DatabaseDialect {
    return kind ? DATABASE_DIALECTS[kind] : DATABASE_DIALECTS.sqlite;
}
export function paginationClause(kind: DbKind | undefined, limit: number, offset?: number): string {
    if (!Number.isSafeInteger(limit) || limit < 1 || (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))) {
        throw new Error("分页大小和偏移量必须是有效整数");
    }
    if (dialectFor(kind).pagination === "fetch") {
        return offset === undefined ? `FETCH FIRST ${limit} ROWS ONLY` : `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
    }
    return `LIMIT ${limit}${offset === undefined ? "" : ` OFFSET ${offset}`}`;
}
export interface DatabaseCapabilities {
    manualTransactions: boolean;
    readOnlyTransactions: boolean;
    routineExecution: boolean;
}
export const DATABASE_CAPABILITIES: Record<DbKind, DatabaseCapabilities> = {
    mysql: { manualTransactions: true, readOnlyTransactions: true, routineExecution: true },
    mariadb: { manualTransactions: true, readOnlyTransactions: true, routineExecution: true },
    postgres: { manualTransactions: true, readOnlyTransactions: true, routineExecution: true },
    sqlite: { manualTransactions: true, readOnlyTransactions: true, routineExecution: false },
    oracle: { manualTransactions: false, readOnlyTransactions: false, routineExecution: false },
    clickhouse: { manualTransactions: false, readOnlyTransactions: false, routineExecution: false },
};
