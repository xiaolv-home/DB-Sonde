export type DbKind = "mysql" | "mariadb" | "postgres" | "sqlite" | "oracle" | "clickhouse";

export interface ConnectionConfig {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  username: string;
  database: string;
  sslMode?: string | null;
  color?: string | null;
  brand?: string | null;
  /** Oracle only: use "thick" mode (Instant Client) instead of pure-Rust thin. */
  oracleThick?: boolean;
}

export interface ConnectionMeta {
  credentialWarning?: string;
  id: string;
  kind: DbKind;
  serverVersion: string;
  currentDatabase: string;
  hasSchemas: boolean;
  hasMultipleDatabases: boolean;
  /** 能不能关自动提交。后端连上时按服务端实际能力判断(Doris / StarRocks 没有普通事务) */
  manualTransactions?: boolean;
}

export interface TableInfo {
  name: string;
  kind: "table" | "view";
  engine?: string | null;
  estimatedRows?: number | null;
  dataSize?: number | null;
  comment?: string | null;
  collation?: string | null;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  defaultValue?: string | null;
  ordinalPosition?: number | null;
  autoIncrement?: boolean;
  generated?: boolean;
  comment?: string | null;
}

export interface RoutineInfo {
  name: string;
  kind: "procedure" | "function";
  language?: string | null;
  returnType?: string | null;
  comment?: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  indexType?: string | null;
  definition?: string | null;
}

export interface ColumnMeta {
  name: string;
  typeName: string;
}

export type Cell = string | number | boolean | null | object;

export interface RoutineDetails { name: string; kind: string; definition?: string | null; parameters: { name: string; mode: string; dataType: string }[] }

export interface QueryResult {
  additionalResults?: QueryResult[];
  columns: ColumnMeta[];
  rows: Cell[][];
  rowsAffected?: number | null;
  truncated: boolean;
  elapsedMs: number;
  message?: string | null;
}

export interface CompletionCatalog {
  /** CodeMirror-compatible namespace tree: database/schema -> table -> columns. */
  schema: Record<string, unknown>;
  defaultSchema?: string;
  loadedAt: number;
}

export interface TableContext {
  database: string;
  schema: string;
  table: string;
  columns: ColumnInfo[];
  /** The generated preview SQL. Editing is enabled only while this SQL is unchanged. */
  previewSql: string;
  editable: boolean;
  editDisabledReason?: string;
}

export interface QueryExecution {
  sql: string;
  result?: QueryResult;
  error?: string;
}

/** One staged, not-yet-saved cell change in the data grid. */
export interface EditDraft {
  row: number;
  column: number;
  oldValue: Cell;
  newValue: Cell;
}

export interface UpdateCellRequest {
  connId: string;
  database: string;
  schema: string;
  table: string;
  column: string;
  primaryKey: Record<string, Cell>;
  oldValue: Cell;
  newValue: Cell;
}

export const DB_KINDS: { value: DbKind; label: string; defaultPort: number }[] = [
  { value: "mysql", label: "MySQL", defaultPort: 3306 },
  { value: "mariadb", label: "MariaDB", defaultPort: 3306 },
  { value: "postgres", label: "PostgreSQL", defaultPort: 5432 },
  { value: "oracle", label: "Oracle", defaultPort: 1521 },
  { value: "clickhouse", label: "ClickHouse", defaultPort: 8123 },
  { value: "sqlite", label: "SQLite", defaultPort: 0 },
];

export function kindLabel(kind: DbKind): string {
  return DB_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

/** Databases that speak the MySQL or PostgreSQL wire protocol — they work
 *  through the existing engines; this is just a discoverable preset that sets
 *  the right engine + default port. */
export const COMPAT_PRESETS: { label: string; kind: DbKind; port: number; note: string }[] = [
  { label: "TiDB", kind: "mysql", port: 4000, note: "MySQL 协议" },
  { label: "OceanBase", kind: "mysql", port: 2881, note: "MySQL 模式" },
  { label: "StarRocks", kind: "mysql", port: 9030, note: "MySQL 协议" },
  { label: "Apache Doris", kind: "mysql", port: 9030, note: "MySQL 协议" },
  { label: "PolarDB(MySQL)", kind: "mysql", port: 3306, note: "MySQL 协议" },
  { label: "KingBase 人大金仓", kind: "postgres", port: 54321, note: "PostgreSQL 协议" },
  { label: "openGauss", kind: "postgres", port: 5432, note: "PostgreSQL 协议" },
  { label: "GaussDB", kind: "postgres", port: 8000, note: "PostgreSQL 协议" },
  { label: "Greenplum", kind: "postgres", port: 5432, note: "PostgreSQL 协议" },
  { label: "PolarDB(PostgreSQL)", kind: "postgres", port: 5432, note: "PostgreSQL 协议" },
];
