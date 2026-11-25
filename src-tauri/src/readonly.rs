//! Conservative validation for queries executed by dashboard datasets.
//!
//! Dashboard SQL runs outside the normal editor workflow and must never mutate
//! a database. We therefore accept only SELECT / WITH statements and reject
//! write-capable keywords outside strings, quoted identifiers and comments.

use crate::error::{AppError, AppResult};
use crate::models::DbKind;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOnlyFilter {
    pub field: String,
    pub kind: String,
    pub value: String,
}

#[derive(Debug, PartialEq, Eq)]
pub struct PreparedDashboardQuery {
    pub sql: String,
    pub params: Vec<String>,
}

const FORBIDDEN: &[&str] = &[
    "ALTER", "ATTACH", "CALL", "COMMENT", "COPY", "CREATE", "DELETE", "DETACH", "DO", "DROP",
    "EXEC", "EXECUTE", "GRANT", "INSERT", "INTO", "LOCK", "MERGE", "PRAGMA", "REINDEX", "REPLACE",
    "REVOKE", "SET", "TRUNCATE", "UNLOCK", "UPDATE", "UPSERT", "VACUUM",
];

/// 关键字同时也是常用函数的白名单:出现在「函数调用位」(紧跟左括号)时放行。
/// 它们的写语句形式仍被拦住 —— `REPLACE INTO` 撞 INTO、`TRUNCATE TABLE` 撞首词检查。
const FUNCTION_SAFE: &[&str] = &["REPLACE", "TRUNCATE"];

#[derive(Debug)]
struct Token {
    text: String,
    /// 该词后面(跳过空白)紧跟 `(`,即函数调用位。
    call: bool,
}

/// Return uppercase SQL tokens that occur outside literals, identifiers and
/// comments. A semicolon is emitted as its own token so multi-statement input
/// can be rejected without relying on a database-specific parser.
/// `backslash_escapes` 决定字符串里的 `\` 算不算转义符。
///
/// 这件事**按方言分裂**:MySQL 默认算(除非开了 NO_BACKSLASH_ESCAPES),
/// PG(standard_conforming_strings 默认 on)/ SQLite / Oracle 不算。
/// 而这里拿不到方言 —— 也不该拿:猜错一次就是漏掉一条写语句。
/// 所以调用方两种都扫一遍,见 validate_dashboard_sql。
fn tokens(sql: &str, backslash_escapes: bool) -> Vec<Token> {
    let chars: Vec<char> = sql.chars().collect();
    let mut result: Vec<Token> = Vec::new();
    let mut current = String::new();
    let mut index = 0;

    let flush = |current: &mut String, result: &mut Vec<Token>, at: usize| {
        if !current.is_empty() {
            let mut probe = at;
            while probe < chars.len() && chars[probe].is_whitespace() {
                probe += 1;
            }
            let call = chars.get(probe) == Some(&'(');
            result.push(Token {
                text: std::mem::take(current).to_ascii_uppercase(),
                call,
            });
        }
    };

    while index < chars.len() {
        let ch = chars[index];
        let next = chars.get(index + 1).copied();
        if ch.is_ascii_alphanumeric() || ch == '_' {
            current.push(ch);
            index += 1;
            continue;
        }
        flush(&mut current, &mut result, index);

        if ch == '-' && next == Some('-') {
            index += 2;
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            continue;
        }
        if ch == '/' && next == Some('*') {
            index += 2;
            while index + 1 < chars.len() && !(chars[index] == '*' && chars[index + 1] == '/') {
                index += 1;
            }
            index = (index + 2).min(chars.len());
            continue;
        }
        if matches!(ch, '\'' | '"' | '`') {
            let quote = ch;
            index += 1;
            while index < chars.len() {
                if chars[index] == quote {
                    if chars.get(index + 1) == Some(&quote) {
                        index += 2;
                        continue;
                    }
                    index += 1;
                    break;
                }
                if backslash_escapes && chars[index] == '\\' && quote == '\'' {
                    index = (index + 2).min(chars.len());
                } else {
                    index += 1;
                }
            }
            continue;
        }
        if ch == '$' {
            let mut end = index + 1;
            while end < chars.len() && (chars[end].is_ascii_alphanumeric() || chars[end] == '_') {
                end += 1;
            }
            if chars.get(end) == Some(&'$') {
                let delimiter: String = chars[index..=end].iter().collect();
                index = end + 1;
                while index + delimiter.len() <= chars.len() {
                    let candidate: String = chars[index..index + delimiter.len()].iter().collect();
                    if candidate == delimiter {
                        index += delimiter.len();
                        break;
                    }
                    index += 1;
                }
                continue;
            }
        }
        if ch == ';' {
            result.push(Token { text: ";".to_string(), call: false });
        }
        index += 1;
    }
    flush(&mut current, &mut result, chars.len());
    result
}

/// 只读闸门的公共部分:不许多语句,不许出现能改库的关键字。
///
/// 首词的要求由调用方定 —— 看板数据集只许 SELECT / WITH(它要当子查询用),
/// Python 桥宽一些(脚本里 SHOW TABLES、EXPLAIN 都是正常的读操作)。
fn reject_writes(sql: &str) -> AppResult<()> {
    reject_executable_comments(sql)?;
    /* 反斜杠算不算字符串转义符要看方言,这儿拿不到方言。两种解读**都**扫一遍,
       任何一种下出现写语句就拒。详见 validate_dashboard_sql 上面那段。 */
    for tokens in [tokens(sql, true), tokens(sql, false)] {
        if tokens.iter().any(|token| token.text == ";") {
            return Err(AppError::msg(
                "只允许一条语句;请去掉分号。",
            ));
        }
        // 函数调用位的 REPLACE()/TRUNCATE() 是普通字符串/数值函数,放行。
        if let Some(keyword) = tokens.iter().find(|token| {
            FORBIDDEN.contains(&token.text.as_str())
                && !(token.call && FUNCTION_SAFE.contains(&token.text.as_str()))
        }) {
            return Err(AppError::msg(format!(
                "这条 SQL 含有会改数据的关键字:{}。",
                keyword.text,
            )));
        }
    }
    Ok(())
}

/// Python 桥的只读闸门。
///
/// 桥的 API 叫 `query`、文档写的是「查」、返回的是 DataFrame,可它原来走的是通用执行
/// 通道 —— 一段手滑或 AI 生成的脚本能在生产库上 DROP 表,没有确认、没有提示。
/// 校验与数据库只读事务同时生效；需要写库时由用户在 SQL 编辑器执行。
pub fn validate_bridge_sql(sql: &str) -> AppResult<()> {
    const READ_STARTS: &[&str] = &["SELECT", "WITH", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "VALUES", "TABLE"];
    /* 看首词之前先把开头的注释剥掉 —— 人习惯把说明写在 SQE 上面。
       `#` 也算(MySQL / ClickHouse 的行注释),而且不分方言:没有哪种方言的语句
       能以 `#` 开头。不剥的话 `# daily revenue summary` 的第一个词是 DAILY,
       闸门会拒掉一条正经查询,错误信息还说「收到的是 DAILY」,看的人一头雾水。

       注意只有**首词判断**用剥过的版本;下面 reject_writes 扫的仍然是原文 ——
       PostgreSQL 里 `#` 不是注释(`#>` 是 JSON 运算符),真按注释跳过的话
       `SELECT a #> b; DELETE FROM t` 的第二条就被藏起来了。宁可把注释里的词
       也当语句扫(多拒),也不能漏。 */
    let head = crate::db::strip_leading_noise(sql);
    let tokens = tokens(head, true);
    let first = tokens.first().ok_or_else(|| AppError::msg("sql 不能为空"))?;
    if !READ_STARTS.contains(&first.text.as_str()) {
        return Err(AppError::msg(format!(
            "sonde.query() 只跑读的语句(SELECT / WITH / SHOW / EXPLAIN / DESCRIBE),收到的是 {}。\
             要改数据请去 SQL 编辑器。",
            first.text,
        )));
    }
    reject_writes(sql)
}

pub fn validate_dashboard_sql(sql: &str) -> AppResult<()> {
    /* 反斜杠算不算字符串转义符要看方言,这儿拿不到方言。两种解读**都**扫一遍,
       任何一种下出现写语句就拒。

       为什么不能只按一种扫:按「算转义」扫时,`'x\'` 会被当成字符串还没结束,
       后面真正的 SQL 全被咽进字符串里 —— 于是
       `SELECT 'x\' AS a; DELETE FROM sales --'` 一路放行,而它在 PG 上是两条语句,
       第二条是 DELETE。反过来只按「不算转义」扫,MySQL 那边又会漏。
       闸门宁可多拒一句合法 SQL(用户看到的是一条明确的错),也不能放过一条写语句。 */
    // 同 validate_bridge_sql:首词看剥掉开头注释之后的,写语句扫的仍是原文。
    let first_reading = tokens(crate::db::strip_leading_noise(sql), true);
    let first = first_reading
        .first()
        .ok_or_else(|| AppError::msg("Dashboard SQL cannot be empty."))?;
    if first.text != "SELECT" && first.text != "WITH" {
        return Err(AppError::msg(
            "Dashboard datasets only allow SELECT or WITH queries.",
        ));
    }
    reject_writes(sql)
}

fn quote_identifier(kind: DbKind, value: &str) -> AppResult<String> {
    if value.trim().is_empty() || value.len() > 256 || value.contains('\0') {
        return Err(AppError::msg("Dashboard filter field is invalid."));
    }
    Ok(match kind {
        DbKind::Mysql | DbKind::Mariadb | DbKind::Clickhouse => {
            format!("`{}`", value.replace('`', "``"))
        }
        DbKind::Postgres | DbKind::Sqlite | DbKind::Oracle => {
            format!("\"{}\"", value.replace('"', "\"\""))
        }
    })
}

/// Wrap a validated dataset query and bind active filters outside that
/// subquery. Field names are identifiers, never SQL fragments; values remain
/// parameters all the way to sqlx.
pub fn prepare_dashboard_query(
    kind: DbKind,
    sql: &str,
    filters: &[ReadOnlyFilter],
) -> AppResult<PreparedDashboardQuery> {
    validate_dashboard_sql(sql)?;
    /* 上限要跟前端那边对齐(工具入参 schema:最多 50 个筛选字段、每个字段 1000 个取值)。
       两头不一致的后果是前端放行、后端拒绝,用户看到的是一句没头没尾的英文报错。
       按网点筛一次点几百家很常见,所以值的长度也要够:1000 个名字 × 100 字符。 */
    if filters.len() > 50 {
        return Err(AppError::msg("Dashboard queries allow at most 50 filters."));
    }
    if filters.is_empty() {
        return Ok(PreparedDashboardQuery {
            sql: sql.to_string(),
            params: Vec::new(),
        });
    }

    let cast_type = match kind {
        DbKind::Mysql | DbKind::Mariadb => "CHAR",
        DbKind::Clickhouse => "String",
        DbKind::Postgres | DbKind::Sqlite | DbKind::Oracle => "TEXT",
    };
    let mut predicates = Vec::with_capacity(filters.len());
    let mut params: Vec<String> = Vec::new();
    // 登记一个参数,返回对应占位符(Postgres 用递增的 $n,其它用 ?)。
    let placeholder = |val: String, params: &mut Vec<String>| -> String {
        params.push(val);
        match kind {
            DbKind::Postgres => format!("${}", params.len()),
            _ => "?".to_string(),
        }
    };
    for filter in filters.iter() {
        if filter.value.len() > 120_000 {
            return Err(AppError::msg("Dashboard filter value is too large."));
        }
        let field = quote_identifier(kind, &filter.field)?;
        let expression = format!("CAST(sonde_source.{field} AS {cast_type})");
        let predicate = match filter.kind.as_str() {
            "is_null" => format!("sonde_source.{field} IS NULL"),
            "in" => {
                // 多选:value 用 SOH(char 1)连接多个值;其中 STX+"NULL"(\u{2}NULL)专指 SQL NULL,
                // 与字面量字符串 "NULL" 严格区分。
                let mut has_sql_null = false;
                let mut literals = Vec::new();
                for item in filter.value.split('\u{1}').filter(|s| !s.is_empty()) {
                    if item == "\u{2}NULL" {
                        has_sql_null = true;
                    } else {
                        literals.push(item.to_string());
                    }
                }
                if !has_sql_null && literals.is_empty() {
                    continue;
                }
                let phs: Vec<String> = literals
                    .into_iter()
                    .map(|v| format!("LOWER({})", placeholder(v, &mut params)))
                    .collect();
                match (has_sql_null, phs.is_empty()) {
                    (true, true) => format!("sonde_source.{field} IS NULL"),
                    (true, false) => format!(
                        "(sonde_source.{field} IS NULL OR LOWER({expression}) IN ({}))",
                        phs.join(", ")
                    ),
                    (false, false) => format!("LOWER({expression}) IN ({})", phs.join(", ")),
                    (false, true) => unreachable!(),
                }
            }
            "select" if filter.value == "\u{2}NULL" => {
                format!("sonde_source.{field} IS NULL")
            }
            "select" => {
                let ph = placeholder(filter.value.clone(), &mut params);
                format!("LOWER({expression}) = LOWER({ph})")
            }
            "text" => {
                let ph = placeholder(filter.value.clone(), &mut params);
                match kind {
                    DbKind::Mysql | DbKind::Mariadb => format!("LOCATE(LOWER({ph}), LOWER({expression})) > 0"),
                    DbKind::Postgres => format!("POSITION(LOWER({ph}) IN LOWER({expression})) > 0"),
                    DbKind::Sqlite | DbKind::Oracle => format!("INSTR(LOWER({expression}), LOWER({ph})) > 0"),
                    DbKind::Clickhouse => format!("position(LOWER({expression}), LOWER({ph})) > 0"),
                }
            }
            _ => return Err(AppError::msg("Dashboard filter kind is invalid.")),
        };
        predicates.push(predicate);
    }

    if predicates.is_empty() {
        return Ok(PreparedDashboardQuery {
            sql: sql.to_string(),
            params: Vec::new(),
        });
    }

    Ok(PreparedDashboardQuery {
        sql: format!(
            "SELECT * FROM (\n{sql}\n) AS sonde_source\nWHERE {}",
            predicates.join("\n  AND ")
        ),
        params,
    })
}

#[cfg(test)]
mod tests {
    use super::{prepare_dashboard_query, validate_dashboard_sql, ReadOnlyFilter};
    use crate::models::DbKind;

    #[test]
    fn accepts_read_only_queries_and_ignores_literals_comments() {
        assert!(validate_dashboard_sql("SELECT 'delete', amount FROM sales -- update\n").is_ok());
        assert!(validate_dashboard_sql(
            "WITH totals AS (SELECT sum(amount) value FROM sales) SELECT * FROM totals"
        )
        .is_ok());
        assert!(validate_dashboard_sql("SELECT $$ drop table x $$ AS note").is_ok());
    }

    #[test]
    fn allows_keywords_that_are_also_functions_but_not_their_statements() {
        // REPLACE()/TRUNCATE() 是常用函数,不该被当成写操作拒绝。
        assert!(validate_dashboard_sql("SELECT REPLACE(name, ',', '') FROM store").is_ok());
        assert!(validate_dashboard_sql("SELECT TRUNCATE(amount, 2) FROM sales").is_ok());
        assert!(validate_dashboard_sql("SELECT replace ( a , 'x' , '' ) FROM t").is_ok());
        // 语句形式仍然拒绝。
        assert!(validate_dashboard_sql("REPLACE INTO sales VALUES (1)").is_err());
        assert!(validate_dashboard_sql("TRUNCATE TABLE sales").is_err());
        assert!(validate_dashboard_sql("SELECT 1 FROM t WHERE x IN (SELECT 1) UNION ALL TRUNCATE TABLE t").is_err());
        // 其它危险关键字即便像函数调用也不放行。
        assert!(validate_dashboard_sql("SELECT EXEC('drop table x')").is_err());
    }

    #[test]
    fn rejects_writes_and_multiple_statements() {
        assert!(validate_dashboard_sql("UPDATE sales SET amount = 0").is_err());
        assert!(validate_dashboard_sql(
            "WITH changed AS (DELETE FROM sales RETURNING *) SELECT * FROM changed"
        )
        .is_err());
        assert!(validate_dashboard_sql("SELECT * FROM sales; DELETE FROM sales").is_err());
        assert!(validate_dashboard_sql("SELECT * INTO OUTFILE '/tmp/x' FROM sales").is_err());
    }

    #[test]
    fn prepares_parameterized_filters_for_each_dialect() {
        let filters = vec![
            ReadOnlyFilter {
                field: "store`name".to_string(),
                kind: "select".to_string(),
                value: "O'Reilly".to_string(),
            },
            ReadOnlyFilter {
                field: "note".to_string(),
                kind: "text".to_string(),
                value: "% literal _".to_string(),
            },
        ];
        let mysql =
            prepare_dashboard_query(DbKind::Mysql, "SELECT * FROM sales", &filters).unwrap();
        assert!(mysql.sql.contains("`store``name`"));
        assert!(mysql.sql.contains("LOCATE(LOWER(?),"));
        assert!(!mysql.sql.contains("O'Reilly"));
        assert_eq!(mysql.params, vec!["O'Reilly", "% literal _"]);

        let postgres = prepare_dashboard_query(
            DbKind::Postgres,
            "WITH sales AS (SELECT 1) SELECT * FROM sales",
            &filters,
        )
        .unwrap();
        assert!(postgres.sql.contains("LOWER($1)"));
        assert!(postgres.sql.contains("POSITION(LOWER($2)"));

        // 字面量 "NULL" 与 SQL NULL 哨兵("\u{2}NULL" / kind="is_null")严格区分
        let literal_null = prepare_dashboard_query(
            DbKind::Sqlite,
            "SELECT * FROM sales",
            &[ReadOnlyFilter {
                field: "tag".to_string(),
                kind: "select".to_string(),
                value: "NULL".to_string(),
            }],
        )
        .unwrap();
        assert!(!literal_null.sql.contains("IS NULL"));
        assert_eq!(literal_null.params, vec!["NULL"]);

        let sql_null = prepare_dashboard_query(
            DbKind::Sqlite,
            "SELECT * FROM sales",
            &[ReadOnlyFilter {
                field: "tag".to_string(),
                kind: "select".to_string(),
                value: "\u{2}NULL".to_string(),
            }],
        )
        .unwrap();
        assert!(sql_null.sql.contains("IS NULL"));
        assert!(sql_null.params.is_empty());
    }

    #[test]
    fn rejects_invalid_filter_contracts() {
        assert!(prepare_dashboard_query(
            DbKind::Sqlite,
            "SELECT 1",
            &[ReadOnlyFilter {
                field: "".to_string(),
                kind: "select".to_string(),
                value: "x".to_string(),
            }],
        )
        .is_err());
        assert!(prepare_dashboard_query(
            DbKind::Sqlite,
            "SELECT 1",
            &[ReadOnlyFilter {
                field: "name".to_string(),
                kind: "regex".to_string(),
                value: "x".to_string(),
            }],
        )
        .is_err());
    }
}

#[cfg(test)]
mod backslash_dialects {
    use super::validate_dashboard_sql;

    /// 反斜杠算不算字符串转义符**按方言分裂**:MySQL 默认算,
    /// PG(standard_conforming_strings 默认 on)/ SQLite / Oracle 不算。
    /// 扫描器拿不到方言,原来一律按「算」扫 —— 于是本该在 `'x\'` 处结束的字符串
    /// 被认为还在继续,后面真正的 SQL 全被咽进字符串里,DELETE 和分号一个都看不见。
    #[test]
    fn backslash_before_quote_must_not_hide_the_rest() {
        // 这段在 PG 上是两条语句,第二条是 DELETE
        assert!(validate_dashboard_sql("SELECT 'x\\' AS a; DELETE FROM sales --'").is_err());
        // 反过来:按「不算转义」读时会被藏起来的写法,也要拦住
        assert!(validate_dashboard_sql("SELECT 'a''; DROP TABLE t --' FROM x; UPDATE t SET a=1").is_err());
    }

    /// 多拒一句合法 SQL 是可以接受的代价,但别把常见写法也拒了。
    #[test]
    fn ordinary_queries_still_pass() {
        assert!(validate_dashboard_sql("SELECT a, b FROM t WHERE name = 'O''Reilly'").is_ok());
        assert!(validate_dashboard_sql("WITH x AS (SELECT 1) SELECT * FROM x").is_ok());
        assert!(validate_dashboard_sql("SELECT REPLACE(a, 'x', 'y') FROM t").is_ok());
        // 注释里的关键字不算
        assert!(validate_dashboard_sql("SELECT a FROM t -- delete this later\n").is_ok());
    }
}

#[cfg(test)]
mod bridge_guard {
    use super::validate_bridge_sql;

    /// Python 桥的 API 叫 query、返回 DataFrame、文档写的是「查」,可它原来走的是通用
    /// 执行通道 —— 一段手滑或 AI 生成的脚本能在生产库上 DROP 表,没有确认也没有提示。
    /// 这个应用其他每条路都守着(看板只许 SELECT/WITH,SQL 编辑器写操作要点确认)。
    #[test]
    fn writes_are_refused() {
        for sql in [
            "DROP TABLE sales",
            "DELETE FROM sales WHERE 1=1",
            "UPDATE sales SET amount = 0",
            "INSERT INTO sales VALUES (1)",
            "SELECT 1; DROP TABLE sales",
            // 只读闸门的反斜杠绕过在这条路上同样不许有
            "SELECT 'x\\' AS a; DELETE FROM sales --'",
        ] {
            assert!(validate_bridge_sql(sql).is_err(), "这条该被拒:{sql}");
        }
    }

    /// 但脚本里真正的读操作要照常能跑 —— 看板那道闸门只许 SELECT/WITH,
    /// 对脚本来说太窄了:SHOW TABLES、EXPLAIN 都是正常的读。
    #[test]
    fn reads_still_work() {
        for sql in [
            "SELECT * FROM sales WHERE region = 'A'",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "SHOW TABLES",
            "EXPLAIN SELECT * FROM sales",
            "DESCRIBE sales",
        ] {
            assert!(validate_bridge_sql(sql).is_ok(), "这条该放行:{sql}");
        }
    }
}

#[cfg(test)]
mod hash_comment_tests {
    use super::{validate_bridge_sql, validate_dashboard_sql};

    /// 注释写在 SQL 上面是最常见的写法。`#` 是 MySQL / ClickHouse 的行注释,
    /// 闸门必须能穿过它看到真正的首词,否则看板数据集和 Python 桥会把
    /// 一条正经的查询拒掉,而错误信息说的是「收到的是 XXX」—— 看的人一头雾水。
    #[test]
    fn a_leading_hash_comment_does_not_break_the_gate() {
        assert!(validate_dashboard_sql("#示例连锁网点实收日汇总\nSELECT a FROM t").is_ok());
        assert!(validate_dashboard_sql("# daily revenue summary\nSELECT a FROM t").is_ok(),
            "英文注释里的词不能被当成首词");
        assert!(validate_bridge_sql("#说明\nSELECT 1").is_ok());
        assert!(validate_bridge_sql("#a\n-- b\n/* c */\nSELECT 1").is_ok(), "几种注释混着也要穿过去");
    }

    /// 但 `#` 后面的内容**仍然要按写语句扫**。
    /// PostgreSQL 里 `#` 不是注释(`#>` 是 JSON 运算符),真把它当注释的话
    /// `SELECT a #> b; DELETE FROM t` 在 PG 上的第二条语句就被藏起来了。
    #[test]
    fn hash_does_not_hide_a_write() {
        assert!(validate_dashboard_sql("SELECT a #> 'x'; DELETE FROM sales").is_err(),
            "PG 的 # 不是注释,后面的 DELETE 必须拦住");
        assert!(validate_bridge_sql("SELECT 1 # 看着像注释\n; DROP TABLE t").is_err());
    }

    /// 原有行为不能退化。
    #[test]
    fn existing_behaviour_holds() {
        assert!(validate_dashboard_sql("-- 说明\nSELECT 1").is_ok());
        assert!(validate_dashboard_sql("/* 说明 */ SELECT 1").is_ok());
        assert!(validate_dashboard_sql("DELETE FROM t").is_err());
        assert!(validate_bridge_sql("UPDATE t SET a = 1").is_err());
    }
}

/// SQL transaction controls would bypass the held session and its UI state.
/// MySQL DDL/admin statements and procedures can commit implicitly as well.
fn reject_executable_comments(sql: &str) -> AppResult<()> {
    if sql.contains("/*!") || sql.to_ascii_uppercase().contains("/*M!") {
        return Err(AppError::msg("受保护的查询不接受可执行注释"));
    }
    Ok(())
}
pub fn validate_manual_sql(mysql: bool, sql: &str) -> AppResult<()> {
    reject_executable_comments(sql)?;
    for escapes in [false, true] {
        let words = tokens(sql, escapes);
        for statement in words.split(|word| word.text == ";") {
            let Some(head) = statement.first() else { continue };
            let control = matches!(head.text.as_str(), "BEGIN" | "START" | "COMMIT" | "END" | "ROLLBACK" | "ABORT" | "SAVEPOINT" | "RELEASE" | "USE" | "SET" | "ATTACH" | "DETACH");
            let implicit = mysql && matches!(head.text.as_str(), "ALTER" | "CREATE" | "DROP" | "TRUNCATE" | "RENAME" | "GRANT" | "REVOKE" | "LOCK" | "UNLOCK" | "ANALYZE" | "OPTIMIZE" | "REPAIR" | "FLUSH" | "RESET" | "LOAD" | "CALL" | "INSTALL" | "UNINSTALL");
            if control || implicit {
                return Err(AppError::msg("该语句可能改变事务或数据库归属，手动模式下已阻止；请使用工具栏提交/回滚，或明确结束手动模式后执行"));
            }
        }
    }
    Ok(())
}
