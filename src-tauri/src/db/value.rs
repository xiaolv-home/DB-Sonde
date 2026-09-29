//! Converting driver rows into JSON cells the frontend can render.
//!
//! Each engine has its own decode order. We try the concrete Rust types a
//! column could hold, in an order chosen so nothing gets mangled (integers
//! before floats, decimals kept as exact strings, booleans only where the
//! engine has a real boolean type). A SQL `NULL` decodes as `Ok(None)` on the
//! first compatible attempt, so nulls are handled naturally.

use bigdecimal::BigDecimal;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use rust_decimal::Decimal;
use serde_json::Value;
use sqlx::{Column, Row, TypeInfo};
use uuid::Uuid;

/// JSON numbers outside JavaScript's exact integer range must travel as text.
pub fn exact_integer(v: impl Into<i128>) -> Value {
    let n = v.into();
    if (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&n) {
        Value::from(n as i64)
    } else {
        Value::String(n.to_string())
    }
}

/// Normalize scalar JSON integers from drivers whose JSON format can emit
/// unquoted UInt64/Int64 values (e.g. ClickHouse with custom output settings).
pub fn exact_json_integer(value: Value) -> Value {
    match value {
        Value::Number(ref n) if n.is_i64() => exact_integer(n.as_i64().unwrap()),
        Value::Number(ref n) if n.is_u64() => exact_integer(n.as_u64().unwrap()),
        other => other,
    }
}

/// 二进制列的值怎么交给界面。
///
/// 很多表把**文本**存在 VARBINARY / BLOB 里(或者 CTAS 从表达式建表,列成了二进制):
/// 内容其实是 "10087947"、一串 32 位 uuid。以前一律转成 `0x3130303837393437`,
/// 两个问题 ——
///   1. 读不出来;
///   2. **编辑失灵。** 更新时要拿原值做 WHERE 校验,而原值是界面上那串
///      `"0x3130…"`,作为文本绑定后和列里 `10087947` 这几个字节永远对不上,
///      只要主键里有这种列,整张表改哪一格都报「该行已被修改」。超过 32 字节
///      被截成 `0x…(N bytes)` 的更是不可能匹配。
///
/// 所以:合法 UTF-8、不含控制字符(制表 / 换行 / 回车除外)、不超过 64 KiB 的,
/// 按文本返回 —— 显示读得懂,绑回去的也正是原来的字节。
/// 其余才是真二进制,照旧给十六进制(短的全给,长的截断并标长度)。
fn bytes_to_value(bytes: Vec<u8>) -> Value {
    const TEXT_LIMIT: usize = 64 * 1024;
    if bytes.len() <= TEXT_LIMIT {
        if let Ok(text) = std::str::from_utf8(&bytes) {
            if !text.chars().any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r')) {
                return Value::String(text.to_owned());
            }
        }
    }
    fn hex(bytes: &[u8]) -> String {
        let mut s = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            s.push_str(&format!("{:02x}", b));
        }
        s
    }
    if bytes.len() <= 32 {
        Value::String(format!("0x{}", hex(&bytes)))
    } else {
        Value::String(format!("0x{}… ({} bytes)", hex(&bytes[..16]), bytes.len()))
    }
}

/// Try each `Type => closure` pair in order. Returns `Value::Null` when the
/// cell is SQL NULL, or falls through to `Value::Null` if nothing matched.
macro_rules! decode_chain {
    ($row:expr, $i:expr; $($t:ty => $f:expr),+ $(,)?) => {{
        $(
            match $row.try_get::<Option<$t>, _>($i) {
                Ok(Some(val)) => return ($f)(val),
                Ok(None) => return Value::Null,
                Err(_) => {}
            }
        )+
        Value::Null
    }};
}

pub fn mysql_value(row: &sqlx::mysql::MySqlRow, i: usize) -> Value {
    // sqlx also accepts VARCHAR/TEXT when decoding JSON. Trying JSON before
    // String would turn text IDs, "null", "true", or JSON-looking text into
    // different types, and long IDs would lose precision in the frontend.
    if row.column(i).type_info().name() == "JSON" {
        return row.try_get::<Value, _>(i).unwrap_or(Value::Null);
    }
    decode_chain!(row, i;
        i64 => exact_integer,
        u64 => exact_integer,
        Decimal => |v: Decimal| Value::String(v.to_string()),
        BigDecimal => |v: BigDecimal| Value::String(v.to_string()),
        f64 => |v: f64| Value::from(v),
        bool => |v: bool| Value::Bool(v),
        // 显示成 YYYY-MM-DD HH:MM:SS(与 NaiveDateTime 一致、对齐 DBeaver),
        // 不再输出 RFC3339 的 `T` 与 `+00:00` 后缀。
        DateTime<Utc> => |v: DateTime<Utc>| Value::String(v.format("%Y-%m-%d %H:%M:%S%.f").to_string()),
        NaiveDateTime => |v: NaiveDateTime| Value::String(v.format("%Y-%m-%d %H:%M:%S%.f").to_string()),
        NaiveDate => |v: NaiveDate| Value::String(v.to_string()),
        NaiveTime => |v: NaiveTime| Value::String(v.to_string()),
        String => |v: String| Value::String(v),
        Vec<u8> => |v: Vec<u8>| bytes_to_value(v),
    )
}

pub fn pg_value(row: &sqlx::postgres::PgRow, i: usize) -> Value {
    decode_chain!(row, i;
        bool => |v: bool| Value::Bool(v),
        i16 => |v: i16| Value::from(v),
        i32 => |v: i32| Value::from(v),
        i64 => exact_integer,
        Decimal => |v: Decimal| Value::String(v.to_string()),
        BigDecimal => |v: BigDecimal| Value::String(v.to_string()),
        f32 => |v: f32| Value::from(v as f64),
        f64 => |v: f64| Value::from(v),
        Uuid => |v: Uuid| Value::String(v.to_string()),
        // 显示成 YYYY-MM-DD HH:MM:SS(与 NaiveDateTime 一致、对齐 DBeaver),
        // 不再输出 RFC3339 的 `T` 与 `+00:00` 后缀。
        DateTime<Utc> => |v: DateTime<Utc>| Value::String(v.format("%Y-%m-%d %H:%M:%S%.f").to_string()),
        NaiveDateTime => |v: NaiveDateTime| Value::String(v.format("%Y-%m-%d %H:%M:%S%.f").to_string()),
        NaiveDate => |v: NaiveDate| Value::String(v.to_string()),
        NaiveTime => |v: NaiveTime| Value::String(v.to_string()),
        serde_json::Value => |v: serde_json::Value| v,
        String => |v: String| Value::String(v),
        Vec<u8> => |v: Vec<u8>| bytes_to_value(v),
    )
}

pub fn sqlite_value(row: &sqlx::sqlite::SqliteRow, i: usize) -> Value {
    decode_chain!(row, i;
        i64 => exact_integer,
        f64 => |v: f64| Value::from(v),
        String => |v: String| Value::String(v),
        Vec<u8> => |v: Vec<u8>| bytes_to_value(v),
    )
}

/// Build `(name, type_name)` column metadata from any sqlx row.
pub fn columns_from_row<R>(row: &R) -> Vec<crate::models::ColumnMeta>
where
    R: Row,
{
    row.columns()
        .iter()
        .map(|c| crate::models::ColumnMeta {
            name: c.name().to_string(),
            type_name: c.type_info().to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{mysql::MySqlConnectOptions, Connection, MySqlConnection};

    /// Uses SELECT-only fixtures against an explicitly supplied MySQL server.
    #[tokio::test]
    #[ignore = "requires SONDE_TEST_MYSQL_HOST, SONDE_TEST_MYSQL_USER and SONDE_TEST_MYSQL_PASSWORD"]
    async fn mysql_text_json_and_integer_types_stay_distinct() {
        let options = MySqlConnectOptions::new()
            .host(&std::env::var("SONDE_TEST_MYSQL_HOST").expect("test MySQL host"))
            .port(
                std::env::var("SONDE_TEST_MYSQL_PORT")
                    .unwrap_or_else(|_| "3306".into())
                    .parse()
                    .expect("test MySQL port"),
            )
            .username(&std::env::var("SONDE_TEST_MYSQL_USER").expect("test MySQL user"))
            .password(&std::env::var("SONDE_TEST_MYSQL_PASSWORD").expect("test MySQL password"));
        let mut conn = MySqlConnection::connect_with(&options).await.unwrap();
        sqlx::query("SET SESSION TRANSACTION READ ONLY")
            .execute(&mut conn)
            .await
            .unwrap();
        sqlx::query("SET SESSION max_execution_time = 5000")
            .execute(&mut conn)
            .await
            .unwrap();

        for text in [
            "1041027043025829888",
            "9007199254740993",
            "000123",
            "12.3400",
            "null",
            "true",
            "false",
            "{\"id\":1}",
            "[1,2]",
            "\"quoted\"",
            " 123 ",
            "",
            "会员",
        ] {
            let row = sqlx::query("SELECT CAST(? AS CHAR) AS sample")
                .bind(text)
                .fetch_one(&mut conn)
                .await
                .unwrap();
            let cell = mysql_value(&row, 0);
            assert_eq!(cell, Value::String(text.into()), "text fixture {text:?}");
            assert_eq!(
                serde_json::to_string(&cell).unwrap(),
                serde_json::to_string(text).unwrap()
            );
        }

        for json in [
            "{\"id\":1}",
            "[1,true,null]",
            "\"hello\"",
            "12",
            "true",
            "null",
        ] {
            let row = sqlx::query("SELECT CAST(? AS JSON) AS sample")
                .bind(json)
                .fetch_one(&mut conn)
                .await
                .unwrap();
            assert_eq!(row.column(0).type_info().name(), "JSON");
            assert_eq!(
                mysql_value(&row, 0),
                serde_json::from_str::<Value>(json).unwrap()
            );
        }

        let row = sqlx::query("SELECT CAST(NULL AS CHAR), CAST(NULL AS JSON), CAST(1041027043025829888 AS SIGNED), CAST(18446744073709551615 AS UNSIGNED), CAST(12.3400 AS DECIMAL(10,4)), CAST(42 AS SIGNED)")
            .fetch_one(&mut conn).await.unwrap();
        assert_eq!(
            (0..row.len())
                .map(|i| mysql_value(&row, i))
                .collect::<Vec<_>>(),
            vec![
                Value::Null,
                Value::Null,
                Value::String("1041027043025829888".into()),
                Value::String("18446744073709551615".into()),
                Value::String("12.3400".into()),
                Value::from(42),
            ]
        );
        conn.close().await.unwrap();
    }
}

#[cfg(test)]
mod bytes_tests {
    use super::bytes_to_value;
    use serde_json::Value;

    /* VARBINARY 里存的是文本时,要按文本给出去。真机:platform_store_id / store_id
       两列显示成 0x3130303837393437 这种,既读不出来,也让编辑的 WHERE 永远对不上。 */
    #[test]
    fn text_stored_as_binary_comes_back_as_text() {
        assert_eq!(bytes_to_value(b"10087947".to_vec()), Value::String("10087947".into()));
        let uuid = "69a13f63076831e41a13998176664b5e";
        assert_eq!(bytes_to_value(uuid.as_bytes().to_vec()), Value::String(uuid.into()),
            "32 字节以上的文本也不能截断 —— 截断了就更对不上了");
        assert_eq!(bytes_to_value("河北战区".as_bytes().to_vec()), Value::String("河北战区".into()));
        assert_eq!(bytes_to_value(b"a\tb\nc".to_vec()), Value::String("a\tb\nc".into()), "制表换行算文本");
        assert_eq!(bytes_to_value(Vec::new()), Value::String(String::new()));
    }

    /* 真二进制(UUID 的 16 个原始字节、图片、带 NUL 的数据)照旧十六进制。 */
    #[test]
    fn real_binary_stays_hex() {
        assert_eq!(bytes_to_value(vec![0x00, 0x01, 0xff]), Value::String("0x0001ff".into()));
        assert_eq!(bytes_to_value(b"ab\x00cd".to_vec()), Value::String("0x6162006364".into()),
            "合法 UTF-8 但带 NUL 这种控制字符的,不当文本");
        let long = vec![0xffu8; 40];
        let Value::String(s) = bytes_to_value(long) else { panic!() };
        assert!(s.starts_with("0xffff") && s.ends_with("(40 bytes)"), "长的真二进制截断并标长度:{s}");
    }
}
