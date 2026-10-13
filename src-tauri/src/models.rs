use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Supported database engines. MariaDB rides on the MySQL driver; Oracle uses
/// the ODPI-C-based `oracle` driver (the Oracle client is loaded at runtime).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    Mysql,
    Mariadb,
    Postgres,
    Sqlite,
    Oracle,
    Clickhouse,
}

impl DbKind {
    /// Default TCP port for the engine (0 for file-based SQLite).
    pub fn default_port(self) -> u16 {
        match self {
            DbKind::Mysql | DbKind::Mariadb => 3306,
            DbKind::Postgres => 5432,
            DbKind::Oracle => 1521,
            DbKind::Clickhouse => 8123,
            DbKind::Sqlite => 0,
        }
    }
}

/// A saved connection profile. Passwords live separately in the encrypted local vault.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub kind: DbKind,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    /// Default database to open. For SQLite this is the file path.
    #[serde(default)]
    pub database: String,
    /// One of: disable | prefer | require. Defaults to prefer.
    #[serde(default)]
    pub ssl_mode: Option<String>,
    /// Optional accent color used to tint this connection in the UI.
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub brand: Option<String>,
    /// Oracle only: use "thick" mode (ODPI-C + installed Instant Client) instead
    /// of the default pure-Rust "thin" driver.
    #[serde(default)]
    pub oracle_thick: bool,
}

/// Metadata returned after a successful connect, describing the shape of the
/// object tree the frontend should render.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential_warning: Option<String>,
    pub id: String,
    pub kind: DbKind,
    pub server_version: String,
    pub current_database: String,
    /// True when the engine has a schema level between database and table
    /// (PostgreSQL). MySQL/SQLite go straight from database to tables.
    pub has_schemas: bool,
    /// True when the engine exposes multiple browsable databases. PostgreSQL
    /// uses lazily cached database-specific pools behind the same profile.
    pub has_multiple_databases: bool,
    /// 能不能关自动提交、手动提交 / 回滚。连上时由后端按服务端实际能力判断
    /// (Doris / StarRocks 这类没有普通事务的 MySQL 协议引擎是 false)。
    pub manual_transactions: bool,
}

/// A table or view entry in the object tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    /// "table" or "view".
    pub kind: String,
    pub engine: Option<String>,
    pub estimated_rows: Option<i64>,
    pub data_size: Option<i64>,
    pub comment: Option<String>,
    pub collation: Option<String>,
}

/// One column of a table, as shown in the tree and in the structure panel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub is_primary_key: bool,
    pub default_value: Option<String>,
    pub ordinal_position: Option<i64>,
    pub auto_increment: bool,
    pub generated: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineInfo {
    pub name: String,
    /// "procedure" or "function".
    pub kind: String,
    pub language: Option<String>,
    pub return_type: Option<String>,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    pub index_type: Option<String>,
    pub definition: Option<String>,
}

/// Result of running a statement. Either a grid (`columns`/`rows`) for queries
/// that return data, or an affected-row count for DML/DDL.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub additional_results: Option<Vec<QueryResult>>,
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub rows_affected: Option<u64>,
    /// True when the result was capped at the row limit.
    pub truncated: bool,
    pub elapsed_ms: u128,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
}

/// A guarded single-cell update. The backend revalidates table metadata and
/// applies both the primary key and old cell value as optimistic-lock guards.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCellRequest {
    pub conn_id: String,
    pub database: String,
    pub schema: String,
    pub table: String,
    pub column: String,
    pub primary_key: HashMap<String, serde_json::Value>,
    pub old_value: serde_json::Value,
    pub new_value: serde_json::Value,
}
