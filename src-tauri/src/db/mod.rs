pub mod clickhouse_driver;
pub mod edit;
pub mod drop_object;
pub mod introspect;
pub mod routines;
pub mod oracle_driver;
pub mod value;
#[cfg(test)]
mod live_mysql_family;

mod cancel;
mod connect;
mod query;
mod session;

pub use cancel::{cancel_marked_query, cancel_supported, kill_process, run_marker};
pub use connect::connect;
pub(crate) use query::strip_leading_noise;
pub(crate) use query::returns_rows;
pub use query::{run_query, run_read_only_query};
pub use session::{
    begin_tx, commit_tx, rollback_tx, run_query_on_tx, run_statements, run_statements_on_tx,
    supports_session_tx, SessionTx,
};




/// A live pooled connection to one engine. Pools are cheap to clone (they're
/// reference-counted internally), so callers clone one out of shared state and
/// run queries without holding a lock.
#[derive(Clone)]
pub enum DbPool {
    MySql(MySql),
    Postgres(sqlx::PgPool),
    Sqlite(sqlx::SqlitePool),
    Oracle(oracle_driver::OracleHandle),
    ClickHouse(clickhouse_driver::ClickHouseHandle),
}

/// MySQL 协议的连接池,加上连上时探明的服务端能力。
///
/// 同样说 MySQL 协议,Doris / StarRocks 这类分析型引擎和 MySQL 差在两处:
/// 没有普通事务(BEGIN 进的是只许 INSERT 的导入事务,连接从此卡住),
/// 写语句不能走预编译(PREPARE 的回包少两个字节,驱动直接报错)。
/// 需要事务、需要绑定参数写入的地方只问这里,不去认引擎名字。
#[derive(Clone)]
pub struct MySql {
    pub pool: sqlx::MySqlPool,
    pub caps: MySqlCaps,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MySqlCaps {
    /// BEGIN / COMMIT / ROLLBACK 是普通事务
    pub transactions: bool,
    /// INSERT / UPDATE 之类写语句能走预编译(绑定参数)
    pub prepared_writes: bool,
    /// information_schema 里 COLUMN_KEY = 'UNI' 的列能唯一确定一行。Doris / StarRocks 的
    /// Unique Key 表就是这样标它的键列(它们没有 PRIMARY KEY);MySQL 里 UNI 只是唯一索引,不算。
    pub unique_key_identifies_row: bool,
}

impl MySqlCaps {
    pub const FULL: MySqlCaps = MySqlCaps { transactions: true, prepared_writes: true, unique_key_identifies_row: false };

    /// 按 `@@version_comment` 认:Doris 报 "doris version doris-4.1…",StarRocks 报 "StarRocks version …"。
    /// 认不出就当完整的 MySQL。
    pub fn from_version_comment(comment: &str) -> MySqlCaps {
        let c = comment.to_ascii_lowercase();
        if c.contains("doris") || c.contains("starrocks") {
            MySqlCaps { transactions: false, prepared_writes: false, unique_key_identifies_row: true }
        } else {
            MySqlCaps::FULL
        }
    }
}

impl MySqlCaps {
    /// 这一列(按 information_schema.columns.COLUMN_KEY)是不是用来定位行的键 —— 改单元格靠它。
    pub fn is_row_key(&self, column_key: &str) -> bool {
        column_key.eq_ignore_ascii_case("PRI") || (self.unique_key_identifies_row && column_key.eq_ignore_ascii_case("UNI"))
    }
}

impl std::ops::Deref for MySql {
    type Target = sqlx::MySqlPool;
    fn deref(&self) -> &sqlx::MySqlPool {
        &self.pool
    }
}

/// What a fresh connection tells us about the server.
pub struct ConnectInfo {
    pub pool: DbPool,
    pub server_version: String,
    pub current_database: String,
}

#[cfg(test)]
mod caps_tests {
    use super::*;

    #[test]
    fn analytic_engines_are_recognised_from_version_comment() {
        let doris = MySqlCaps::from_version_comment("doris version doris-4.1.4.1-rc02-5dbec55b399");
        assert!(!doris.transactions && !doris.prepared_writes, "Doris:没有普通事务、写语句不能预编译");
        assert_eq!(MySqlCaps::from_version_comment("StarRocks version 3.3.2"), doris);
        assert_eq!(MySqlCaps::from_version_comment("MySQL Community Server - GPL"), MySqlCaps::FULL);
        assert_eq!(MySqlCaps::from_version_comment("Source distribution"), MySqlCaps::FULL, "PolarDB / 自编译 MySQL");
        assert_eq!(MySqlCaps::from_version_comment(""), MySqlCaps::FULL, "读不到就当完整 MySQL");
        assert!(MySqlCaps::FULL.is_row_key("PRI") && !MySqlCaps::FULL.is_row_key("UNI"), "MySQL:唯一索引不当行键");
        assert!(doris.is_row_key("UNI") && doris.is_row_key("PRI"), "Doris Unique Key 表的键列标 UNI");
        assert!(!doris.is_row_key("DUP") && !doris.is_row_key("AGG") && !doris.is_row_key(""), "明细 / 聚合模型不能按行改");
    }
}
