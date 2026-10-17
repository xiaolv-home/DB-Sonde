//! 改表注释、改列注释、改列的数据类型(表结构页里双击改)。
//!
//! 两个坑决定了这里的写法:
//! * MySQL 一族改列只有 `MODIFY COLUMN`,它是**整列重新定义** —— 只写新类型的话,原来的非空、默认值、
//!   自增、字符集、生成列表达式会被悄悄丢掉。所以从 `SHOW CREATE TABLE` 里取出这一列原本的完整定义,
//!   只替换要改的那一段;改完再读回来,核对别的属性一个都没变。
//! * 改类型会动到已有数据:字符转不成数、小数会被四舍五入、文本超长被截断、日期丢掉时分秒……
//!   非严格模式的 MySQL 还会把转不过去的值悄悄变成 0。所以改之前先在服务器上把整列检查一遍,
//!   有一行转不过去就不改,并把例子和原因摆出来;真执行时 MySQL 再临时开严格模式兜底。
//!
//! 新类型只认一份白名单,SQL 里写的是解析后规范化的类型,不是用户输入的原文。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{run_query, DbPool};
use crate::error::{AppError, AppResult};
use crate::models::DbKind;

/// 要改什么。`column` 为空表示改表本身(只能改注释)。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Change {
    Comment { text: String },
    Type { to: String },
}

/// 预检查的结果:会执行什么,改类型时检查了多少行、有没有转不过去的。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub sql: String,
    pub checked_rows: Option<i64>,
    pub problem: Option<Problem>,
    /// 规范化后的新类型(用户写 INT(11) 之类,这里给出实际会用的写法)
    pub normalized_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Problem {
    pub bad_rows: i64,
    pub samples: Vec<Sample>,
}

#[derive(Debug, Serialize)]
pub struct Sample {
    pub value: String,
    pub why: String,
}

// ---------------------------------------------------------------------------
// 新类型:白名单解析
// ---------------------------------------------------------------------------

/// 数据要满足什么才转得过去。
#[derive(Debug, Clone, PartialEq)]
enum Target {
    Int { min: i128, max: i128 },
    Decimal { p: u32, s: u32 },
    Float,
    /// char(n) / varchar(n):字符数上限
    Chars { n: u32 },
    /// text 一族:字节数上限;None = 不限(PostgreSQL text)
    Text { max_bytes: Option<u64> },
    Date,
    DateTime { fsp: u32, timestamp: bool },
    Time { fsp: u32 },
    Year,
    Json,
    Bool,
    Uuid,
}

#[derive(Debug, Clone, PartialEq)]
struct TypeSpec {
    sql: String,
    target: Target,
}

impl TypeSpec {
    /// 字符串类型才能带 CHARACTER SET / COLLATE
    fn stringy(&self) -> bool {
        matches!(self.target, Target::Chars { .. } | Target::Text { .. })
    }
}

/// `varchar ( 10 )` / `INT(11) UNSIGNED` → (基础名, 括号里的参数, 括号后面的修饰词)
fn split_type(raw: &str) -> AppResult<(String, Vec<u32>, Vec<String>)> {
    let lower = raw.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return Err(AppError::msg("类型不能为空"));
    }
    let (head, args, tail) = match lower.find('(') {
        Some(open) => {
            let close = lower[open..].find(')').map(|i| open + i).ok_or_else(|| AppError::msg("括号没有配对"))?;
            if lower[close + 1..].contains('(') || lower[close + 1..].contains(')') {
                return Err(AppError::msg("类型里只能有一组括号"));
            }
            let args = lower[open + 1..close]
                .split(',')
                .map(|a| a.trim().parse::<u32>().map_err(|_| AppError::msg(format!("括号里应该是数字,而不是「{}」", a.trim()))))
                .collect::<AppResult<Vec<_>>>()?;
            (lower[..open].to_string(), args, lower[close + 1..].to_string())
        }
        None => (lower.clone(), vec![], String::new()),
    };
    let mut head = head.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut tail = tail;
    // 没有括号时 `bigint unsigned`、`timestamp with time zone` 也是类型名 + 修饰词;只有这几个本身就是多个词
    const MULTI_WORD: &[&str] = &["double precision", "character varying"];
    if !MULTI_WORD.contains(&head.as_str()) {
        if let Some((first, rest)) = head.split_once(' ') {
            tail = format!("{rest} {tail}");
            head = first.to_string();
        }
    }
    if head.is_empty() || !head.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '_') {
        return Err(AppError::msg(format!("不认识的类型「{}」", raw.trim())));
    }
    let tail = tail.split_whitespace().map(str::to_string).collect();
    Ok((head, args, tail))
}

fn unsupported(raw: &str) -> AppError {
    AppError::msg(format!("不支持在这里改成「{}」;这类改动请在 SQL 编辑器里手动执行", raw.trim()))
}

fn int_range(bits: u32, unsigned: bool) -> (i128, i128) {
    if unsigned {
        (0, (1i128 << bits) - 1)
    } else {
        (-(1i128 << (bits - 1)), (1i128 << (bits - 1)) - 1)
    }
}

fn fsp_of(args: &[u32], raw: &str) -> AppResult<u32> {
    match args {
        [] => Ok(0),
        [f] if *f <= 6 => Ok(*f),
        _ => Err(AppError::msg(format!("「{}」的小数秒位数只能是 0~6", raw.trim()))),
    }
}

fn parse_mysql_type(raw: &str) -> AppResult<TypeSpec> {
    let (head, args, tail) = split_type(raw)?;
    let only_args = |max_len: usize| -> AppResult<()> {
        if args.len() > max_len { Err(AppError::msg(format!("「{}」的参数个数不对", raw.trim()))) } else { Ok(()) }
    };
    let no_tail = || -> AppResult<()> {
        if tail.is_empty() { Ok(()) } else { Err(unsupported(raw)) }
    };
    let int_bits = match head.as_str() {
        "tinyint" => Some(8),
        "smallint" => Some(16),
        "mediumint" => Some(24),
        "int" | "integer" => Some(32),
        "bigint" => Some(64),
        _ => None,
    };
    if let Some(bits) = int_bits {
        only_args(1)?;
        if args.first().is_some_and(|m| *m == 0 || *m > 255) {
            return Err(AppError::msg("整数的显示宽度只能是 1~255"));
        }
        let zerofill = tail.iter().any(|t| t == "zerofill");
        let unsigned = zerofill || tail.iter().any(|t| t == "unsigned");
        if tail.iter().any(|t| t != "unsigned" && t != "zerofill") {
            return Err(unsupported(raw));
        }
        let base = if head == "integer" { "int" } else { head.as_str() };
        let mut sql = match args.first() { Some(m) => format!("{base}({m})"), None => base.to_string() };
        if unsigned { sql.push_str(" unsigned"); }
        if zerofill { sql.push_str(" zerofill"); }
        let (min, max) = int_range(bits, unsigned);
        return Ok(TypeSpec { sql, target: Target::Int { min, max } });
    }
    no_tail()?;
    let spec = match head.as_str() {
        "decimal" | "numeric" | "dec" | "fixed" => {
            only_args(2)?;
            let p = *args.first().unwrap_or(&10);
            let s = *args.get(1).unwrap_or(&0);
            if p == 0 || p > 65 || s > 30 || s > p {
                return Err(AppError::msg("decimal(总位数, 小数位):总位数 1~65,小数位 0~30 且不超过总位数"));
            }
            TypeSpec { sql: format!("decimal({p},{s})"), target: Target::Decimal { p, s } }
        }
        "float" | "double" | "double precision" | "real" => {
            only_args(0)?;
            TypeSpec { sql: if head == "float" { "float".into() } else { "double".into() }, target: Target::Float }
        }
        "char" | "varchar" => {
            let n = match args.as_slice() {
                [n] => *n,
                [] if head == "char" => 1,
                _ => return Err(AppError::msg("varchar 要写长度,比如 varchar(50)")),
            };
            if head == "char" && n > 255 { return Err(AppError::msg("char 最长 255,更长的请用 varchar")); }
            if n > 65535 { return Err(AppError::msg("varchar 最长 65535")); }
            TypeSpec { sql: format!("{head}({n})"), target: Target::Chars { n } }
        }
        "tinytext" | "text" | "mediumtext" | "longtext" => {
            only_args(0)?;
            let max = match head.as_str() { "tinytext" => 255, "text" => 65_535, "mediumtext" => 16_777_215, _ => 4_294_967_295 };
            TypeSpec { sql: head.clone(), target: Target::Text { max_bytes: Some(max) } }
        }
        "date" => { only_args(0)?; TypeSpec { sql: "date".into(), target: Target::Date } }
        "datetime" | "timestamp" => {
            let fsp = fsp_of(&args, raw)?;
            let sql = if fsp == 0 { head.clone() } else { format!("{head}({fsp})") };
            TypeSpec { sql, target: Target::DateTime { fsp, timestamp: head == "timestamp" } }
        }
        "time" => {
            let fsp = fsp_of(&args, raw)?;
            TypeSpec { sql: if fsp == 0 { "time".into() } else { format!("time({fsp})") }, target: Target::Time { fsp } }
        }
        "year" => { only_args(0)?; TypeSpec { sql: "year".into(), target: Target::Year } }
        "json" => { only_args(0)?; TypeSpec { sql: "json".into(), target: Target::Json } }
        _ => return Err(unsupported(raw)),
    };
    Ok(spec)
}

fn parse_postgres_type(raw: &str) -> AppResult<TypeSpec> {
    let (head, args, tail) = split_type(raw)?;
    let tail = tail.join(" ");
    // timestamp(3) with time zone:括号在中间,时区写在后面
    let (head, tz) = match (head.as_str(), tail.as_str()) {
        ("timestamp" | "time", "with time zone") => (head.clone(), Some(true)),
        ("timestamp" | "time", "without time zone") => (head.clone(), Some(false)),
        (_, "") => (head.clone(), None),
        _ => return Err(unsupported(raw)),
    };
    let only_args = |max_len: usize| -> AppResult<()> {
        if args.len() > max_len { Err(AppError::msg(format!("「{}」的参数个数不对", raw.trim()))) } else { Ok(()) }
    };
    let spec = match head.as_str() {
        "smallint" | "int2" => { only_args(0)?; let (min, max) = int_range(16, false); TypeSpec { sql: "smallint".into(), target: Target::Int { min, max } } }
        "integer" | "int" | "int4" => { only_args(0)?; let (min, max) = int_range(32, false); TypeSpec { sql: "integer".into(), target: Target::Int { min, max } } }
        "bigint" | "int8" => { only_args(0)?; let (min, max) = int_range(64, false); TypeSpec { sql: "bigint".into(), target: Target::Int { min, max } } }
        "numeric" | "decimal" => {
            only_args(2)?;
            match args.as_slice() {
                [] => TypeSpec { sql: "numeric".into(), target: Target::Decimal { p: 1000, s: 1000 } },
                _ => {
                    let p = args[0];
                    let s = *args.get(1).unwrap_or(&0);
                    if p == 0 || p > 1000 || s > p {
                        return Err(AppError::msg("numeric(总位数, 小数位):总位数 1~1000,小数位不超过总位数"));
                    }
                    TypeSpec { sql: format!("numeric({p},{s})"), target: Target::Decimal { p, s } }
                }
            }
        }
        "real" | "float4" => { only_args(0)?; TypeSpec { sql: "real".into(), target: Target::Float } }
        "double precision" | "float8" => { only_args(0)?; TypeSpec { sql: "double precision".into(), target: Target::Float } }
        "varchar" | "character varying" => match args.as_slice() {
            [] => TypeSpec { sql: "varchar".into(), target: Target::Text { max_bytes: None } },
            [n] if *n >= 1 && *n <= 10_485_760 => TypeSpec { sql: format!("varchar({n})"), target: Target::Chars { n: *n } },
            _ => return Err(AppError::msg("varchar 的长度要在 1~10485760 之间")),
        },
        "char" | "character" => {
            let n = match args.as_slice() { [] => 1, [n] if *n >= 1 => *n, _ => return Err(AppError::msg("char 的长度至少是 1")) };
            TypeSpec { sql: format!("char({n})"), target: Target::Chars { n } }
        }
        "text" => { only_args(0)?; TypeSpec { sql: "text".into(), target: Target::Text { max_bytes: None } } }
        "date" => { only_args(0)?; TypeSpec { sql: "date".into(), target: Target::Date } }
        "timestamp" | "timestamptz" => {
            let fsp = fsp_of(&args, raw)?;
            let with_tz = head == "timestamptz" || tz == Some(true);
            let p = if args.is_empty() { String::new() } else { format!("({fsp})") };
            let sql = format!("timestamp{p}{}", if with_tz { " with time zone" } else { "" });
            TypeSpec { sql, target: Target::DateTime { fsp: if args.is_empty() { 6 } else { fsp }, timestamp: false } }
        }
        "time" => {
            if tz == Some(true) { return Err(unsupported(raw)); }
            let fsp = fsp_of(&args, raw)?;
            let p = if args.is_empty() { String::new() } else { format!("({fsp})") };
            TypeSpec { sql: format!("time{p}"), target: Target::Time { fsp: if args.is_empty() { 6 } else { fsp } } }
        }
        "boolean" | "bool" => { only_args(0)?; TypeSpec { sql: "boolean".into(), target: Target::Bool } }
        "json" | "jsonb" => { only_args(0)?; TypeSpec { sql: head.clone(), target: Target::Json } }
        "uuid" => { only_args(0)?; TypeSpec { sql: "uuid".into(), target: Target::Uuid } }
        _ => return Err(unsupported(raw)),
    };
    if tz.is_some() && !matches!(spec.target, Target::DateTime { .. } | Target::Time { .. }) {
        return Err(unsupported(raw));
    }
    Ok(spec)
}

// ---------------------------------------------------------------------------
// 数据检查:每一行转不转得过去,转不过去的原因
// ---------------------------------------------------------------------------

const NUMBER_RE: &str = "^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)$";
const INTEGRAL_RE: &str = "^[+-]?[0-9]+([.]0*)?$";
const FLOAT_RE: &str = "^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$";
const DATE_RE: &str = "^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}$";
const DATE_MIDNIGHT_RE: &str = "^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}[ T]00:00(:00([.]0*)?)?$";
const DATE_WITH_TIME_RE: &str = "^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}[ T]";
const DATETIME_RE: &str = "^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}([ T][0-9]{1,2}:[0-9]{1,2}(:[0-9]{1,2}([.][0-9]{1,6})?)?)?$";
const TIME_RE: &str = "^-?[0-9]{1,3}:[0-9]{1,2}(:[0-9]{1,2}([.][0-9]{1,6})?)?$";
const UUID_RE: &str = "^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$";

/// 「转不过去的原因」的 SQL 表达式:能转返回 NULL,转不了返回一句中文。`v` 是去掉首尾空格后的文本,`raw` 是原样文本。
fn why_expr(kind: DbKind, target: &Target, v: &str, raw: &str) -> Option<String> {
    let mysql = kind != DbKind::Postgres;
    let not_re = |re: &str| if mysql { format!("{v} NOT REGEXP '{re}'") } else { format!("{v} !~ '{re}'") };
    let is_re = |re: &str| if mysql { format!("{v} REGEXP '{re}'") } else { format!("{v} ~ '{re}'") };
    let num = |x: &str| if mysql { format!("CAST({x} AS DECIMAL(65,30))") } else { format!("({x})::numeric") };
    Some(match target {
        Target::Int { min, max } => format!(
            "CASE WHEN {} THEN '不是数字' WHEN {} THEN '有小数部分,转整数会丢掉' WHEN {} NOT BETWEEN {min} AND {max} THEN '超出范围({min} ~ {max})' END",
            not_re(NUMBER_RE), not_re(INTEGRAL_RE), num(v)
        ),
        Target::Decimal { p, s } if *p < 1000 => {
            let limit = format!("1{}", "0".repeat((p - s) as usize));
            format!(
                "CASE WHEN {} THEN '不是数字' WHEN {} <> ROUND({}, {s}) THEN '小数超过 {s} 位,会被四舍五入' WHEN ABS({}) >= {limit} THEN '整数部分超过 {} 位' END",
                not_re(NUMBER_RE), num(v), num(v), num(v), p - s
            )
        }
        Target::Decimal { .. } => format!("CASE WHEN {} THEN '不是数字' END", not_re(NUMBER_RE)),
        Target::Float => format!("CASE WHEN {} THEN '不是数字' END", not_re(FLOAT_RE)),
        Target::Chars { n } => format!("CASE WHEN CHAR_LENGTH({raw}) > {n} THEN '超过 {n} 个字符,会被截断' END"),
        Target::Text { max_bytes: Some(max) } => format!("CASE WHEN LENGTH({raw}) > {max} THEN '超过 {max} 字节,会被截断' END"),
        Target::Text { max_bytes: None } => return None,
        Target::Date => {
            let invalid = if mysql { format!(" WHEN CAST({v} AS DATE) IS NULL THEN '不是有效日期'") } else { String::new() };
            format!(
                "CASE WHEN {} THEN NULL WHEN {} THEN '带时分秒,改成日期会丢掉' WHEN {} THEN '不是 年-月-日 格式的日期'{invalid} END",
                is_re(DATE_MIDNIGHT_RE), is_re(DATE_WITH_TIME_RE), not_re(DATE_RE)
            )
        }
        Target::DateTime { fsp, timestamp } => {
            let mut s = format!("CASE WHEN {} THEN '不是 年-月-日 时:分:秒 格式的时间'", not_re(DATETIME_RE));
            if mysql {
                s.push_str(&format!(" WHEN CAST({v} AS DATETIME(6)) IS NULL THEN '不是有效时间'"));
                s.push_str(&format!(" WHEN CAST({v} AS DATETIME(6)) <> CAST({v} AS DATETIME({fsp})) THEN '秒的小数部分超过 {fsp} 位,会被截掉'"));
                if *timestamp {
                    s.push_str(&format!(" WHEN CAST({v} AS DATETIME(6)) NOT BETWEEN '1970-01-01 00:00:01' AND '2038-01-19 03:14:07' THEN '超出 TIMESTAMP 的范围(1970 ~ 2038)'"));
                }
            }
            s.push_str(" END");
            s
        }
        Target::Time { fsp } => {
            let mut s = format!("CASE WHEN {} THEN '不是 时:分:秒 格式'", not_re(TIME_RE));
            if mysql {
                s.push_str(&format!(" WHEN CAST({v} AS TIME(6)) IS NULL THEN '不是有效时间'"));
                s.push_str(&format!(" WHEN CAST({v} AS TIME(6)) <> CAST({v} AS TIME({fsp})) THEN '秒的小数部分超过 {fsp} 位,会被截掉'"));
            }
            s.push_str(" END");
            s
        }
        Target::Year => format!(
            "CASE WHEN {} THEN '不是四位年份' WHEN CAST({v} AS UNSIGNED) NOT BETWEEN 1901 AND 2155 THEN '超出 YEAR 的范围(1901 ~ 2155)' END",
            not_re("^[0-9]{4}$")
        ),
        Target::Json if mysql => format!("CASE WHEN JSON_VALID({raw}) = 0 THEN '不是合法的 JSON' END"),
        Target::Json => return None,
        Target::Bool => format!(
            "CASE WHEN LOWER({v}) NOT IN ('t','f','true','false','y','n','yes','no','on','off','1','0') THEN '不是 true / false' END"
        ),
        Target::Uuid => format!("CASE WHEN {} THEN '不是 UUID' END", not_re(UUID_RE)),
    })
}

fn as_i64(v: &Value) -> i64 {
    match v {
        Value::Number(n) => n.as_i64().unwrap_or(0),
        Value::String(s) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

fn as_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "NULL".into(),
        other => other.to_string(),
    }
}

/// 在服务器上把整列检查一遍。返回(检查了多少行非空数据, 转不过去的情况)。
async fn check_data(pool: &DbPool, kind: DbKind, table: &str, col: &str, target: &Target) -> AppResult<(i64, Option<Problem>)> {
    let (raw, v) = if kind == DbKind::Postgres {
        (format!("({col})::text"), format!("btrim(({col})::text)"))
    } else {
        (format!("CAST({col} AS CHAR)"), format!("TRIM(CAST({col} AS CHAR))"))
    };
    let Some(why) = why_expr(kind, target, &v, &raw) else {
        let r = run_query(pool, &format!("SELECT COUNT(*) FROM {table} WHERE {col} IS NOT NULL"), Some(1)).await?;
        return Ok((r.rows.first().and_then(|row| row.first()).map(as_i64).unwrap_or(0), None));
    };
    let counts = run_query(
        pool,
        &format!("SELECT COUNT(*), SUM(CASE WHEN ({why}) IS NOT NULL THEN 1 ELSE 0 END) FROM {table} WHERE {col} IS NOT NULL"),
        Some(1),
    )
    .await?;
    let row = counts.rows.first().cloned().unwrap_or_default();
    let checked = row.first().map(as_i64).unwrap_or(0);
    let bad = row.get(1).map(as_i64).unwrap_or(0);
    if bad == 0 {
        return Ok((checked, None));
    }
    let samples = run_query(
        pool,
        &format!("SELECT {raw}, ({why}) FROM {table} WHERE {col} IS NOT NULL AND ({why}) IS NOT NULL LIMIT 5"),
        Some(5),
    )
    .await?;
    let samples = samples
        .rows
        .iter()
        .map(|r| Sample { value: r.first().map(as_text).unwrap_or_default(), why: r.get(1).map(as_text).unwrap_or_default() })
        .collect();
    Ok((checked, Some(Problem { bad_rows: bad, samples })))
}

// ---------------------------------------------------------------------------
// MySQL:从 SHOW CREATE TABLE 里取出这一列的完整定义,只换掉要改的那一段
// ---------------------------------------------------------------------------

/// 把列定义切成词:引号里的、括号里的、/*…*/ 各算一个整体。
fn tokenize(def: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = def.chars().peekable();
    let mut depth = 0usize;
    while let Some(c) = chars.next() {
        match c {
            '\'' | '"' | '`' => {
                cur.push(c);
                while let Some(d) = chars.next() {
                    cur.push(d);
                    if d == '\\' && c != '`' {
                        if let Some(e) = chars.next() { cur.push(e); }
                    } else if d == c {
                        if chars.peek() == Some(&c) { cur.push(chars.next().unwrap()); } else { break; }
                    }
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                cur.push(c);
                while let Some(d) = chars.next() {
                    cur.push(d);
                    if d == '*' && chars.peek() == Some(&'/') { cur.push(chars.next().unwrap()); break; }
                }
            }
            '(' => { depth += 1; cur.push(c); }
            ')' => { depth = depth.saturating_sub(1); cur.push(c); }
            c if c.is_whitespace() && depth == 0 => {
                if !cur.is_empty() { out.push(std::mem::take(&mut cur)); }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() { out.push(cur); }
    out
}

/// 类型后面可能接的属性关键字 —— 遇到它们,类型就结束了
const ATTR_WORDS: &[&str] = &[
    "not", "null", "default", "auto_increment", "comment", "character", "charset", "collate", "generated", "as",
    "on", "virtual", "stored", "invisible", "visible", "srid", "column_format", "storage", "primary", "unique",
    "key", "check", "references", "constraint", "engine_attribute", "secondary_engine_attribute",
];

/// SHOW CREATE TABLE 里这一列那一行(去掉行首缩进和行尾逗号)
fn column_line(create: &str, column: &str) -> Option<String> {
    let prefix = format!("`{}` ", column.replace('`', "``"));
    create
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with(&prefix))
        .map(|l| l.trim_end_matches(',').to_string())
}

struct ColumnDef {
    name: String,
    type_tokens: Vec<String>,
    attrs: Vec<String>,
}

fn parse_column_def(line: &str) -> Option<ColumnDef> {
    let mut tokens = tokenize(line);
    if tokens.len() < 2 { return None; }
    let name = tokens.remove(0);
    let split = tokens
        .iter()
        .position(|t| t.starts_with("/*") || ATTR_WORDS.contains(&t.to_ascii_lowercase().as_str()))
        .unwrap_or(tokens.len());
    if split == 0 { return None; }
    let attrs = tokens.split_off(split);
    Some(ColumnDef { name, type_tokens: tokens, attrs })
}

impl ColumnDef {
    fn render(&self) -> String {
        let mut parts = vec![self.name.clone()];
        parts.extend(self.type_tokens.iter().cloned());
        parts.extend(self.attrs.iter().cloned());
        parts.join(" ")
    }

    /// 把 COMMENT 'xxx' 那两个词拿出来,返回剩下的属性(用来核对「别的属性没变」)
    fn attrs_without_comment(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < self.attrs.len() {
            if self.attrs[i].eq_ignore_ascii_case("comment") && i + 1 < self.attrs.len() { i += 2; continue; }
            out.push(self.attrs[i].clone());
            i += 1;
        }
        out
    }

    fn set_comment(&mut self, literal: Option<String>) {
        let mut attrs = self.attrs_without_comment();
        if let Some(lit) = literal {
            attrs.push("COMMENT".into());
            attrs.push(lit);
        }
        self.attrs = attrs;
    }

    /// 去掉 CHARACTER SET x / CHARSET x / COLLATE x(改成非字符串类型时它们会让语句报错)
    fn drop_charset(&mut self) {
        let mut out = Vec::new();
        let mut i = 0;
        while i < self.attrs.len() {
            let w = self.attrs[i].to_ascii_lowercase();
            if w == "character" && self.attrs.get(i + 1).is_some_and(|n| n.eq_ignore_ascii_case("set")) { i += 3; continue; }
            if (w == "charset" || w == "collate") && i + 1 < self.attrs.len() { i += 2; continue; }
            out.push(self.attrs[i].clone());
            i += 1;
        }
        self.attrs = out;
    }

    /// 核对用:除了要改的那部分,其余属性
    fn fingerprint(&self, ignore_charset: bool) -> Vec<String> {
        let mut c = ColumnDef { name: self.name.clone(), type_tokens: vec![], attrs: self.attrs_without_comment() };
        if ignore_charset { c.drop_charset(); }
        c.attrs.iter().map(|a| a.to_ascii_lowercase()).collect()
    }
}

// ---------------------------------------------------------------------------
// 字面量、标识符
// ---------------------------------------------------------------------------

fn mysql_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

fn ansi_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// 字符串字面量。MySQL 一族默认把反斜杠当转义,所以反斜杠也要双写(开了 NO_BACKSLASH_ESCAPES 时不用)。
fn string_literal(text: &str, backslash_escapes: bool) -> String {
    let mut s = text.replace('\'', "''");
    if backslash_escapes { s = s.replace('\\', "\\\\"); }
    format!("'{s}'")
}

fn check_comment(kind: DbKind, text: &str, is_table: bool) -> AppResult<()> {
    if text.contains('\0') {
        return Err(AppError::msg("注释里不能有空字符"));
    }
    let limit = match kind {
        DbKind::Mysql | DbKind::Mariadb => Some(if is_table { 2048 } else { 1024 }),
        DbKind::Oracle => Some(4000),
        _ => None,
    };
    if let Some(limit) = limit {
        if text.chars().count() > limit {
            return Err(AppError::msg(format!("注释最长 {limit} 个字")));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/// 改哪张表(的哪一列),在哪条连接上改
pub struct TableRef<'a> {
    pub pool: &'a DbPool,
    pub kind: DbKind,
    pub database: &'a str,
    pub schema: &'a str,
    pub table: &'a str,
    pub column: Option<&'a str>,
}

/// Doris / StarRocks:走 MySQL 协议,但没有普通事务、写语句不能预编译
fn is_analytic(pool: &DbPool) -> bool {
    matches!(pool, DbPool::MySql(m) if !m.caps.prepared_writes)
}

async fn backslash_escapes(pool: &DbPool) -> bool {
    match run_query(pool, "SELECT @@SESSION.sql_mode", Some(1)).await {
        Ok(r) => !r.rows.first().and_then(|row| row.first()).map(as_text).unwrap_or_default().to_ascii_uppercase().contains("NO_BACKSLASH_ESCAPES"),
        Err(_) => true,
    }
}

async fn show_create_line(t: &TableRef<'_>, column: &str) -> AppResult<String> {
    let table = format!("{}.{}", mysql_ident(t.database), mysql_ident(t.table));
    let r = run_query(t.pool, &format!("SHOW CREATE TABLE {table}"), Some(1)).await?;
    let create = r.rows.first().and_then(|row| row.get(1)).map(as_text).unwrap_or_default();
    column_line(&create, column).ok_or_else(|| AppError::msg(format!("在表定义里没找到列 {column}")))
}

/// 生成要执行的语句,改类型时顺带检查数据。
pub async fn plan(t: &TableRef<'_>, change: &Change) -> AppResult<Plan> {
    let mysql_family = matches!(t.kind, DbKind::Mysql | DbKind::Mariadb);
    match (change, t.column) {
        (Change::Comment { text }, None) => {
            check_comment(t.kind, text, true)?;
            let sql = match t.kind {
                DbKind::Mysql | DbKind::Mariadb => {
                    let lit = string_literal(text, backslash_escapes(t.pool).await);
                    let table = format!("{}.{}", mysql_ident(t.database), mysql_ident(t.table));
                    if is_analytic(t.pool) { format!("ALTER TABLE {table} MODIFY COMMENT {lit}") } else { format!("ALTER TABLE {table} COMMENT = {lit}") }
                }
                DbKind::Postgres | DbKind::Oracle => format!(
                    "COMMENT ON TABLE {}.{} IS {}",
                    ansi_ident(t.schema), ansi_ident(t.table),
                    if text.is_empty() && t.kind == DbKind::Postgres { "NULL".into() } else { string_literal(text, false) }
                ),
                _ => return Err(AppError::msg("这种数据库不支持在这里改表注释")),
            };
            Ok(Plan { sql, checked_rows: None, problem: None, normalized_type: None })
        }
        (Change::Comment { text }, Some(column)) => {
            check_comment(t.kind, text, false)?;
            let sql = match t.kind {
                DbKind::Mysql | DbKind::Mariadb if is_analytic(t.pool) => format!(
                    "ALTER TABLE {}.{} MODIFY COLUMN {} COMMENT {}",
                    mysql_ident(t.database), mysql_ident(t.table), mysql_ident(column), string_literal(text, backslash_escapes(t.pool).await)
                ),
                DbKind::Mysql | DbKind::Mariadb => {
                    let mut def = parse_column_def(&show_create_line(t, column).await?)
                        .ok_or_else(|| AppError::msg("读不懂这一列的定义,请在 SQL 编辑器里手动改"))?;
                    def.set_comment((!text.is_empty()).then(|| string_literal(text, true)));
                    format!("ALTER TABLE {}.{} MODIFY COLUMN {}", mysql_ident(t.database), mysql_ident(t.table), def.render())
                }
                DbKind::Postgres | DbKind::Oracle => format!(
                    "COMMENT ON COLUMN {}.{}.{} IS {}",
                    ansi_ident(t.schema), ansi_ident(t.table), ansi_ident(column),
                    if text.is_empty() && t.kind == DbKind::Postgres { "NULL".into() } else { string_literal(text, false) }
                ),
                _ => return Err(AppError::msg("这种数据库不支持在这里改列注释")),
            };
            Ok(Plan { sql, checked_rows: None, problem: None, normalized_type: None })
        }
        (Change::Type { .. }, None) => Err(AppError::msg("表本身没有数据类型")),
        (Change::Type { to }, Some(column)) => {
            if mysql_family && is_analytic(t.pool) {
                return Err(AppError::msg("Doris / StarRocks 改字段类型是后台异步执行的 schema change,请在 SQL 编辑器里手动执行"));
            }
            let (spec, sql, table, col) = match t.kind {
                DbKind::Mysql | DbKind::Mariadb => {
                    let spec = parse_mysql_type(to)?;
                    let mut def = parse_column_def(&show_create_line(t, column).await?)
                        .ok_or_else(|| AppError::msg("读不懂这一列的定义,请在 SQL 编辑器里手动改"))?;
                    if def.type_tokens.join(" ").eq_ignore_ascii_case(&spec.sql) {
                        return Err(AppError::msg("类型没有变化"));
                    }
                    def.type_tokens = vec![spec.sql.clone()];
                    if !spec.stringy() { def.drop_charset(); }
                    let table = format!("{}.{}", mysql_ident(t.database), mysql_ident(t.table));
                    let sql = format!("ALTER TABLE {table} MODIFY COLUMN {}", def.render());
                    (spec, sql, table, mysql_ident(column))
                }
                DbKind::Postgres => {
                    let spec = parse_postgres_type(to)?;
                    let table = format!("{}.{}", ansi_ident(t.schema), ansi_ident(t.table));
                    let col = ansi_ident(column);
                    // 经过 text 转:和上面的数据检查用同一种口径;PostgreSQL 的 DDL 本身是原子的,有一行转不了整条就不生效
                    let sql = format!("ALTER TABLE {table} ALTER COLUMN {col} TYPE {} USING {col}::text::{}", spec.sql, spec.sql);
                    (spec, sql, table, col)
                }
                _ => return Err(AppError::msg("这种数据库暂不支持在这里改数据类型,请在 SQL 编辑器里手动执行")),
            };
            let (checked, problem) = check_data(t.pool, t.kind, &table, &col, &spec.target).await?;
            Ok(Plan { sql, checked_rows: Some(checked), problem, normalized_type: Some(spec.sql) })
        }
    }
}

/// 真执行。执行前重新检查一遍数据(两次之间可能有人写进了新数据),有问题就不执行。
pub async fn apply(t: &TableRef<'_>, change: &Change) -> AppResult<()> {
    let p = plan(t, change).await?;
    if let Some(problem) = &p.problem {
        return Err(AppError::msg(format!("有 {} 行数据转不成新类型,没有修改", problem.bad_rows)));
    }
    let mysql_column = matches!(t.kind, DbKind::Mysql | DbKind::Mariadb) && !is_analytic(t.pool) && t.column.is_some();
    let before = match (mysql_column, t.column) {
        (true, Some(c)) => parse_column_def(&show_create_line(t, c).await?),
        _ => None,
    };
    match (t.pool, matches!(change, Change::Type { .. })) {
        // 改类型:同一条连接上临时开严格模式 —— 万一检查漏了,MySQL 宁可报错也不把数据悄悄变成 0
        (DbPool::MySql(m), true) => {
            use sqlx::Executor;
            let mut conn = m.pool.acquire().await?;
            // &str 走文本协议(DDL 不能预编译);sqlx 0.8 在借来的连接上用 raw_sql 会撞 Send 约束
            conn.execute("SET @sonde_saved_mode = @@SESSION.sql_mode").await?;
            conn.execute("SET SESSION sql_mode = CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_ALL_TABLES')").await?;
            let result = conn.execute(p.sql.as_str()).await;
            let _ = conn.execute("SET SESSION sql_mode = @sonde_saved_mode").await;
            result?;
        }
        _ => {
            run_query(t.pool, &p.sql, Some(0)).await?;
        }
    }
    // 读回来核对:要改的那一处之外,这一列别的属性一个都不能变
    if let (Some(before), Some(column)) = (before, t.column) {
        let after = parse_column_def(&show_create_line(t, column).await?)
            .ok_or_else(|| AppError::msg("改完了,但读不回这一列的定义,请刷新后核对"))?;
        let is_type = matches!(change, Change::Type { .. });
        if before.fingerprint(is_type) != after.fingerprint(is_type) {
            return Err(AppError::msg(format!(
                "改完了,但这一列别的属性和改之前对不上,请检查:\n改之前:{}\n改之后:{}",
                before.render(), after.render()
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_types_are_whitelisted_and_normalized() {
        let t = |raw: &str| parse_mysql_type(raw).map(|s| s.sql);
        assert_eq!(t("INT(11) UNSIGNED").unwrap(), "int(11) unsigned");
        assert_eq!(t("integer").unwrap(), "int");
        assert_eq!(t(" varchar ( 50 ) ").unwrap(), "varchar(50)");
        assert_eq!(t("DECIMAL(12, 2)").unwrap(), "decimal(12,2)");
        assert_eq!(t("decimal").unwrap(), "decimal(10,0)");
        assert_eq!(t("datetime(3)").unwrap(), "datetime(3)");
        assert_eq!(t("bigint zerofill").unwrap(), "bigint unsigned zerofill");
        for bad in ["varchar", "varchar(10); DROP TABLE t", "int(0)", "decimal(70,2)", "decimal(5,6)", "datetime(7)",
                    "enum('a','b')", "blob", "int signed", "varchar(10) character set utf8", "char(300)", "int(abc)", "", "text(10)"] {
            assert!(parse_mysql_type(bad).is_err(), "{bad} 应该被拒绝");
        }
        assert_eq!(parse_mysql_type("tinyint unsigned").unwrap().target, Target::Int { min: 0, max: 255 });
        assert_eq!(parse_mysql_type("bigint").unwrap().target, Target::Int { min: -(1i128 << 63), max: (1i128 << 63) - 1 });
    }

    #[test]
    fn postgres_types_are_whitelisted_and_normalized() {
        let t = |raw: &str| parse_postgres_type(raw).map(|s| s.sql);
        assert_eq!(t("int").unwrap(), "integer");
        assert_eq!(t("character varying(20)").unwrap(), "varchar(20)");
        assert_eq!(t("timestamp(3) with time zone").unwrap(), "timestamp(3) with time zone");
        assert_eq!(t("timestamptz").unwrap(), "timestamp with time zone");
        assert_eq!(t("numeric(10,2)").unwrap(), "numeric(10,2)");
        for bad in ["integer[]", "money", "int(5)", "varchar(0)", "text; drop", "time with time zone", "boolean with time zone"] {
            assert!(parse_postgres_type(bad).is_err(), "{bad} 应该被拒绝");
        }
    }

    #[test]
    fn mysql_column_definition_keeps_every_other_attribute() {
        let create = "CREATE TABLE `dim_stores` (\n  `store_version_id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  \
                      `STORE_NAME` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT '门店''名称',\n  \
                      `CREATE_TIME` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '创建时间',\n  \
                      `odd``name` int NOT NULL DEFAULT '0',\n  PRIMARY KEY (`store_version_id`)\n) ENGINE=InnoDB";
        let line = column_line(create, "STORE_NAME").unwrap();
        let mut def = parse_column_def(&line).unwrap();
        assert_eq!(def.type_tokens, vec!["varchar(255)"]);
        assert_eq!(def.render(), line, "原样切开再拼回来,一个字都不能变");
        def.set_comment(Some(string_literal("店名 'A'", true)));
        assert_eq!(def.render(), "`STORE_NAME` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT '店名 ''A'''");
        def.set_comment(None);
        assert_eq!(def.render(), "`STORE_NAME` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL", "清空注释 = 去掉 COMMENT");

        // 改成数值:字符集 / 排序规则要去掉,其余(默认值、注释)都留着
        let mut num = parse_column_def(&line).unwrap();
        num.type_tokens = vec!["int".into()];
        num.drop_charset();
        assert_eq!(num.render(), "`STORE_NAME` int DEFAULT NULL COMMENT '门店''名称'");

        let ts = parse_column_def(&column_line(create, "CREATE_TIME").unwrap()).unwrap();
        assert_eq!(ts.attrs_without_comment(), vec!["DEFAULT", "CURRENT_TIMESTAMP", "ON", "UPDATE", "CURRENT_TIMESTAMP"]);
        let pk = parse_column_def(&column_line(create, "store_version_id").unwrap()).unwrap();
        assert_eq!(pk.type_tokens, vec!["bigint", "unsigned"], "unsigned 属于类型");
        assert_eq!(pk.attrs, vec!["NOT", "NULL", "AUTO_INCREMENT"]);
        assert!(column_line(create, "odd`name").is_some(), "列名里的反引号");
        assert!(column_line(create, "STORE").is_none(), "前缀相同的列不能误命中");
    }

    #[test]
    fn literals_escape_quotes_and_backslashes() {
        assert_eq!(string_literal("a'b\\c", true), "'a''b\\\\c'");
        assert_eq!(string_literal("a'b\\c", false), "'a''b\\c'");
        assert!(check_comment(DbKind::Mysql, &"字".repeat(1025), false).is_err());
        assert!(check_comment(DbKind::Mysql, &"字".repeat(1025), true).is_ok());
        assert!(check_comment(DbKind::Postgres, "a\0", true).is_err());
    }

    /// 检查语句在 SQLite 上没法跑(没有 REGEXP),这里只验它拼得出来、不同类型给不同的原因
    #[test]
    fn data_checks_cover_each_target() {
        let w = |target: Target| why_expr(DbKind::Mysql, &target, "v", "r").unwrap_or_default();
        assert!(w(Target::Int { min: 0, max: 255 }).contains("不是数字") && w(Target::Int { min: 0, max: 255 }).contains("BETWEEN 0 AND 255"));
        assert!(w(Target::Decimal { p: 12, s: 2 }).contains("ROUND(CAST(v AS DECIMAL(65,30)), 2)") && w(Target::Decimal { p: 12, s: 2 }).contains(">= 10000000000"));
        assert!(w(Target::Chars { n: 32 }).contains("CHAR_LENGTH(r) > 32"));
        assert!(w(Target::Date).contains("带时分秒"));
        assert!(w(Target::DateTime { fsp: 0, timestamp: true }).contains("TIMESTAMP 的范围"));
        assert!(why_expr(DbKind::Postgres, &Target::Text { max_bytes: None }, "v", "r").is_none());
        assert!(why_expr(DbKind::Postgres, &Target::Int { min: 0, max: 1 }, "v", "r").unwrap().contains("v !~"));
    }
}
