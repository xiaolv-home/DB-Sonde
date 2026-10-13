import type { Dataset } from "../features/datasets/domain";
/**
 * A tiny in-memory backend used ONLY when the frontend runs outside Tauri
 * (e.g. `vite dev` in a plain browser for UI work). In the real app,
 * `window.__TAURI_INTERNALS__` exists and the typed `api` calls go to Rust.
 */
import type {
  Cell,
  ColumnInfo,
  ConnectionConfig,
  ConnectionMeta,
  IndexInfo,
  QueryResult,
  RoutineInfo,
  TableInfo,
  UpdateCellRequest,
} from "../types";
import type { DashboardDocument } from "../features/dashboard/domain";
import type { DatasetQueryFilter } from "../features/dashboard/query";
import { utcDay } from "./dates";
import { compareText } from "./collate";

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const demo: ConnectionConfig = {
  id: "demo-sqlite",
  name: "Demo (SQLite)",
  kind: "sqlite",
  host: "",
  port: 0,
  username: "",
  database: "/mock/demo.db",
  sslMode: null,
  color: "#3b9c7a",
};

let connections: ConnectionConfig[] = [demo];
const MOCK_DASHBOARDS_KEY = "sonde.mock.dashboards.v1";
const MOCK_DASHBOARD_VERSIONS_KEY = "sonde.mock.dashboard-versions.v1";
function loadMockDashboards(): DashboardDocument[] {
  try {
    return JSON.parse(localStorage.getItem(MOCK_DASHBOARDS_KEY) ?? "[]") as DashboardDocument[];
  } catch {
    return [];
  }
}
let datasets: Dataset[] = [];
let dashboards: DashboardDocument[] = loadMockDashboards();
function loadMockDashboardVersions(): Record<string, DashboardDocument[]> {
  try {
    return JSON.parse(localStorage.getItem(MOCK_DASHBOARD_VERSIONS_KEY) ?? "{}") as Record<string, DashboardDocument[]>;
  } catch {
    return {};
  }
}
let dashboardVersions = loadMockDashboardVersions();
function persistMockDashboards() {
  localStorage.setItem(MOCK_DASHBOARDS_KEY, JSON.stringify(dashboards));
}
function persistMockDashboardVersions() {
  localStorage.setItem(MOCK_DASHBOARD_VERSIONS_KEY, JSON.stringify(dashboardVersions));
}

const tables: TableInfo[] = [
  { name: "demo_customers", kind: "table", engine: "SQLite", estimatedRows: 5, dataSize: 16384, comment: "Customer directory" },
  { name: "demo_products", kind: "table", engine: "SQLite", estimatedRows: 4, dataSize: 16384, comment: "Product catalog" },
  { name: "demo_sales", kind: "table", engine: "SQLite", estimatedRows: 30, dataSize: 24576, comment: "Daily sales transactions" },
  { name: "monthly_revenue", kind: "view", engine: null, estimatedRows: null, dataSize: null, comment: "Monthly revenue summary" },
];

const routines: RoutineInfo[] = [
  { name: "refresh_monthly_revenue", kind: "procedure", language: "SQL", comment: "Refreshes the monthly summary" },
  { name: "customer_lifetime_value", kind: "function", language: "SQL", returnType: "REAL", comment: "Calculates customer LTV" },
];

const columns: Record<string, ColumnInfo[]> = {
  demo_sales: [
    { name: "id", dataType: "INTEGER", nullable: false, isPrimaryKey: true, defaultValue: null, ordinalPosition: 1, autoIncrement: true, comment: "Sale ID" },
    { name: "sale_date", dataType: "TEXT", nullable: false, isPrimaryKey: false, defaultValue: null, ordinalPosition: 2, comment: "Business date" },
    { name: "product_id", dataType: "INTEGER", nullable: true, isPrimaryKey: false, defaultValue: null, ordinalPosition: 3, comment: "Product ID" },
    { name: "amount", dataType: "REAL", nullable: true, isPrimaryKey: false, defaultValue: null, ordinalPosition: 4, comment: "Sales amount" },
    { name: "quantity", dataType: "INTEGER", nullable: true, isPrimaryKey: false, defaultValue: null, ordinalPosition: 5, comment: "Units sold" },
  ],
  demo_customers: [
    { name: "id", dataType: "INTEGER", nullable: false, isPrimaryKey: true, defaultValue: null },
    { name: "name", dataType: "TEXT", nullable: false, isPrimaryKey: false, defaultValue: null },
    { name: "city", dataType: "TEXT", nullable: true, isPrimaryKey: false, defaultValue: null },
    { name: "created_at", dataType: "TEXT", nullable: true, isPrimaryKey: false, defaultValue: null },
  ],
  demo_products: [
    { name: "id", dataType: "INTEGER", nullable: false, isPrimaryKey: true, defaultValue: null },
    { name: "name", dataType: "TEXT", nullable: false, isPrimaryKey: false, defaultValue: null },
    { name: "category", dataType: "TEXT", nullable: true, isPrimaryKey: false, defaultValue: null },
    { name: "price", dataType: "REAL", nullable: true, isPrimaryKey: false, defaultValue: null },
  ],
  monthly_revenue: [
    { name: "month", dataType: "TEXT", nullable: true, isPrimaryKey: false, defaultValue: null },
    { name: "revenue", dataType: "REAL", nullable: true, isPrimaryKey: false, defaultValue: null },
  ],
};

const mockRows: Record<string, Cell[][]> = {
  demo_customers: [
    [1, "Aria Chen", "Shanghai", "2026-05-01"],
    [2, "Bruno Sato", "Osaka", "2026-05-01"],
    [3, "Carla Dubois", "Paris", "2026-05-01"],
    [4, "Dmitri Ivanov", "Berlin", "2026-05-01"],
    [5, "Elena Rossi", "Milan", "2026-05-01"],
  ],
  demo_products: [
    [1, "Nimbus Keyboard", "Peripherals", 89],
    [2, 'Halo Monitor 27"', "Displays", 329],
    [3, "Pulse Mouse", "Peripherals", 45],
    [4, "Aurora Dock", "Accessories", 129],
  ],
  demo_sales: Array.from({ length: 520 }, (_, index) => {
    const id = index + 1;
    const date = utcDay(new Date(Date.UTC(2026, 0, 1 + index)));
    const amount = Math.round((6000 + Math.sin(id * 0.7) * 250 + id * 4) * 100) / 100;
    const quantity = 700 + Math.round(Math.cos(id * 0.9) * 40) + id;
    return [id, date, (id % 4) + 1, amount, quantity];
  }),
};

function cmpCell(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return compareText(String(a), String(b));
}

/** Build a row predicate from a single-condition WHERE clause (mirrors the
 *  browser's filter bar). Returns a pass-through matcher when there is none. */
function whereMatcher(cols: { name: string }[], sql: string): (r: unknown[]) => boolean {
  const where = sql.match(
    /WHERE\s+["`]?(\w+)["`]?\s*(=|<>|>=|<=|>|<|LIKE|IS NOT NULL|IS NULL)\s*('[^']*'|-?\d+(?:\.\d+)?)?/i,
  );
  if (!where) return () => true;
  const ci = cols.findIndex((c) => c.name === where[1]);
  if (ci < 0) return () => true;
  const op = where[2].toUpperCase();
  const raw = where[3];
  const lit = raw == null ? null : raw.startsWith("'") ? raw.slice(1, -1) : Number(raw);
  return (r: unknown[]) => {
    const v = r[ci];
    switch (op) {
      case "IS NULL": return v == null;
      case "IS NOT NULL": return v != null;
      case "=": return String(v) === String(lit);
      case "<>": return String(v) !== String(lit);
      case ">": return cmpCell(v, lit) > 0;
      case "<": return cmpCell(v, lit) < 0;
      case ">=": return cmpCell(v, lit) >= 0;
      case "<=": return cmpCell(v, lit) <= 0;
      case "LIKE": return String(v).includes(String(lit ?? "").replace(/%/g, ""));
      default: return true;
    }
  };
}

/** Mock table query honoring ORDER BY / WHERE / LIMIT / OFFSET, so pagination,
 *  sorting and filtering behave like a real backend during UI dev. */
function tableQuery(table: string, sql: string): QueryResult {
  const cols = columns[table] ?? [];
  const colIndex = (name: string) => cols.findIndex((c) => c.name === name);
  const match = whereMatcher(cols, sql);
  let rows = (mockRows[table] ?? []).map((r) => [...r]).filter(match);

  const orderClause = sql.match(/ORDER BY\s+(.+?)(?:\nLIMIT|\nOFFSET|$)/is)?.[1] ?? "";
  const orders = [...orderClause.matchAll(/["`]?(\w+)["`]?\s+(ASC|DESC)/gi)]
    .map((match) => ({ index: colIndex(match[1]), dir: match[2].toUpperCase() === "DESC" ? -1 : 1 }))
    .filter((order) => order.index >= 0);
  if (orders.length) {
    rows.sort((a, b) => {
      for (const order of orders) {
        const compared = cmpCell(a[order.index], b[order.index]) * order.dir;
        if (compared) return compared;
      }
      return 0;
    });
  }

  const offset = Number(sql.match(/OFFSET\s+(\d+)/i)?.[1] ?? 0);
  const limit = Number(sql.match(/(?:LIMIT|FETCH NEXT)\s+(\d+)/i)?.[1] ?? rows.length);
  const page = rows.slice(offset, offset + limit);

  return {
    columns: cols.map((c) => ({ name: c.name, typeName: c.dataType })),
    rows: page,
    rowsAffected: null,
    truncated: false,
    elapsedMs: 2,
    message: null,
  };
}

function salesResult(): QueryResult {
  const rows: (string | number | null)[][] = [];
  for (let d = 1; d <= 30; d++) {
    const amount = Math.round((6000 + Math.sin(d * 0.7) * 250 + d * 4) * 100) / 100;
    const quantity = 700 + Math.round(Math.cos(d * 0.9) * 40) + d;
    rows.push([`2026-06-${String(d).padStart(2, "0")}`, amount, quantity]);
  }
  return {
    columns: [
      { name: "sale_date", typeName: "TEXT" },
      { name: "total_amount", typeName: "REAL" },
      { name: "total_quantity", typeName: "INTEGER" },
    ],
    rows,
    rowsAffected: null,
    truncated: false,
    elapsedMs: 3,
    message: null,
  };
}

/** 顶层逗号切分(忽略括号内的逗号)。 */
function splitTopLevel(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
/** 取列的输出名:优先 AS 别名,否则最后一个标识符。 */
function aliasOf(expr: string): string {
  const as = expr.match(/\bas\s+["`]?([A-Za-z_][\w]*)["`]?\s*$/i);
  if (as) return as[1];
  const ids = expr.trim().match(/["`]?([A-Za-z_][\w]*)["`]?\s*$/);
  return ids ? ids[1] : expr.trim().slice(0, 24);
}
const isDimName = (name: string) =>
  /date|day|month|year|week|time|product|store|shop|name|category|cat|type|region|zone|channel|dim|group|city|area|dept|_id$/i.test(name);
function dimValueDomain(name: string): string[] {
  if (/month/i.test(name)) return ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
  /* 一整年。原来只给 12 天 —— 一个「日销售」演示库跨 12 天本来就不像话,而且按日期
     做交叉表时只铺得出十几列,宽表相关的问题(横向虚拟化、列头分层)在 mock 里根本压不出来。 */
  if (/date|day|time|week|year/i.test(name)) {
    const start = Date.UTC(2026, 0, 1);
    return Array.from({ length: 365 }, (_, i) => utcDay(new Date(start + i * 86400000)));
  }
  if (/product|category|cat|type|sku/i.test(name)) return ["咖啡", "轻食", "甜品", "茶饮", "周边"];
  if (/store|shop|city|area|region|zone/i.test(name)) return ["华东", "华北", "华南", "西南", "东北"];
  if (/channel/i.test(name)) return ["线上渠道A", "线上渠道B", "线上渠道C", "线下网点"];
  return ["A 类", "B 类", "C 类", "D 类"];
}
/** 语义/聚合查询的合成结果(仅浏览器 mock 用):按输出列名造维度+指标假数据,
 *  让任何指标看板都能出图出表、筛选联动。真机走真实数据库,不经此函数。 */
/** 取最外层 SELECT 的列表达式列表(跳过括号内的 CTE/子查询 SELECT)。
 *  多指标看板会生成 `WITH q0 AS(SELECT…), q1 AS(SELECT…) SELECT … FROM …`,
 *  必须解析最后一个 top-level SELECT,否则只会拿到第一个 CTE 的单列。 */
function outerColumnList(sql: string): string {
  let depth = 0;
  let last = -1;
  const lower = sql.toLowerCase();
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && lower.startsWith("select", i) && (i === 0 || /[\s)]/.test(sql[i - 1]))) last = i;
  }
  const sub = last >= 0 ? sql.slice(last) : sql;
  const m = sub.match(/select\s+([\s\S]+?)\s+from\b/i);
  return m ? m[1] : "value";
}
function syntheticResult(sql: string): QueryResult {
  const names = splitTopLevel(outerColumnList(sql)).map(aliasOf).filter(Boolean);
  const dims = names.filter(isDimName);
  const primary = dims[0];
  const base = primary ? dimValueDomain(primary) : [null];
  let rows: Cell[][] = base.map((v, i) =>
    names.map((n) => {
      if (dims.includes(n)) return n === primary ? v : dimValueDomain(n)[i % dimValueDomain(n).length];
      return Math.round((4000 + Math.sin((i + 1) * 0.7) * 800 + i * 120) * 100) / 100;
    }),
  );
  // 应用查询 WHERE 里的维度条件(= / IN / LIKE),让筛选/多选在 dev 里能看到联动。
  for (const col of dims) {
    const ci = names.indexOf(col);
    const inM = sql.match(new RegExp(`${col}\\s+in\\s*\\(([^)]+)\\)`, "i"));
    const eqM = sql.match(new RegExp(`${col}\\s*=\\s*'([^']*)'`, "i"));
    const likeM = sql.match(new RegExp(`${col}\\s+like\\s+'%([^%']*)%'`, "i"));
    if (inM) {
      const vals = [...inM[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
      rows = rows.filter((r) => vals.includes(String(r[ci])));
    } else if (eqM) {
      rows = rows.filter((r) => String(r[ci]) === eqM[1]);
    } else if (likeM) {
      rows = rows.filter((r) => String(r[ci]).includes(likeM[1]));
    }
  }
  return {
    columns: names.map((name) => ({ name, typeName: isDimName(name) ? "TEXT" : "REAL" })),
    rows,
    rowsAffected: null,
    truncated: false,
    elapsedMs: 4,
    message: null,
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const mockApi = {
  async listConnections() {
    return connections;
  },
  async saveConnection(config: ConnectionConfig) {
    connections = connections.some((c) => c.id === config.id)
      ? connections.map((c) => (c.id === config.id ? config : c))
      : [...connections, config];
    return config;
  },
  async deleteConnection(id: string) {
    connections = connections.filter((c) => c.id !== id);
  },
  async testConnection() {
    await delay(200);
    return "SQLite 3.45.0 (mock)";
  },
  async connect(id: string): Promise<ConnectionMeta> {
    await delay(150);
    return {
      id,
      kind: "sqlite",
      serverVersion: "SQLite 3.45.0 (mock)",
      currentDatabase: "/mock/demo.db",
      hasSchemas: false,
      hasMultipleDatabases: false,
      manualTransactions: true,
    };
  },
  async disconnect() {},
  async listDatabases() {
    return ["main"];
  },
  async listSchemas() {
    return ["main"];
  },
  async listTables() {
    await delay(120);
    return tables;
  },
  async listColumns(_c: string, _d: string, _s: string, table: string) {
    await delay(80);
    return columns[table] ?? [];
  },
  async listRoutines() {
    await delay(70);
    return routines;
  },
  async listIndexes(table: string): Promise<IndexInfo[]> {
    await delay(70);
    const first = columns[table]?.[0];
    return first?.isPrimaryKey
      ? [{ name: `${table}_pk`, columns: [first.name], unique: true, primary: true, indexType: "btree" }]
      : [];
  },
  async getObjectDdl(table: string, objectKind: string) {
    await delay(60);
    if (objectKind === "view") {
      /* 故意写成 MySQL SHOW CREATE VIEW 的原样:一整行、带 DEFINER、嵌套子查询和
         CASE WHEN。真库上视图 DDL 就长这样,DDL 面板的格式化要在这上面调得出效果。 */
      return "CREATE ALGORITHM=UNDEFINED DEFINER=`app`@`%` SQL SECURITY DEFINER VIEW `monthly_revenue` AS select `t`.`month` AS `month`,`t`.`revenue` AS `revenue`,`t`.`band` AS `band` from (select substr(`s`.`sale_date`,1,7) AS `month`,sum(`s`.`amount`) AS `revenue`,(case when (sum(`s`.`amount`) >= 100000) then 'high' when (sum(`s`.`amount`) >= 20000) then 'mid' else 'low' end) AS `band` from `demo_sales` `s` where ((`s`.`amount` > 0) and (`s`.`status` <> 'void')) group by substr(`s`.`sale_date`,1,7)) `t` order by `t`.`month`";
    }
    const defs = (columns[table] ?? []).map((column) =>
      `  \"${column.name}\" ${column.dataType}${column.isPrimaryKey ? " PRIMARY KEY" : ""}${column.nullable ? "" : " NOT NULL"}`,
    );
    return `CREATE TABLE \"${table}\" (\n${defs.join(",\n")}\n);`;
  },
  async runQuery(_c: string, sql: string): Promise<QueryResult> {
    await delay(120);

    // INSERT — append a row so newly-added rows persist across a reload.
    const ins = sql.match(/^\s*INSERT\s+INTO\s+["`]?(\w+)["`]?\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i);
    if (ins) {
      const table = ins[1];
      const cols = columns[table] ?? [];
      const names = ins[2].split(",").map((s) => s.trim().replace(/["`]/g, ""));
      const raws = ins[3].split(",").map((s) => s.trim());
      const row: (string | number | null)[] = cols.map(() => null);
      names.forEach((name, i) => {
        const ci = cols.findIndex((c) => c.name === name);
        if (ci < 0) return;
        const raw = raws[i];
        row[ci] = /^NULL$/i.test(raw) ? null : raw.startsWith("'") ? raw.slice(1, -1) : Number(raw);
      });
      const idIdx = cols.findIndex((c) => c.name === "id");
      if (idIdx >= 0 && row[idIdx] == null) {
        row[idIdx] = Math.max(0, ...(mockRows[table] ?? []).map((r) => Number(r[idIdx]) || 0)) + 1;
      }
      (mockRows[table] ??= []).push(row);
      return { columns: [], rows: [], rowsAffected: 1, truncated: false, elapsedMs: 3, message: "1 row inserted" };
    }

    // DELETE — remove matching rows.
    const del = sql.match(/^\s*DELETE\s+FROM\s+["`]?(\w+)["`]?/i);
    if (del) {
      const table = del[1];
      const cols = columns[table] ?? [];
      const match = whereMatcher(cols, sql);
      const arr = mockRows[table] ?? [];
      let affected = 0;
      mockRows[table] = arr.filter((r) => {
        if (match(r)) {
          affected += 1;
          return false;
        }
        return true;
      });
      return { columns: [], rows: [], rowsAffected: affected, truncated: false, elapsedMs: 3, message: `${affected} row(s) deleted` };
    }

    // Whole-column UPDATE — mutate the in-memory rows so the effect is visible.
    const upd = sql.match(/^\s*UPDATE\s+["`]?(\w+)["`]?\s+SET\s+["`]?(\w+)["`]?\s*=\s*('[^']*'|NULL|-?\d+(?:\.\d+)?)/i);
    if (upd) {
      const table = upd[1];
      const cols = columns[table] ?? [];
      const ci = cols.findIndex((c) => c.name === upd[2]);
      const raw = upd[3];
      const val = /^NULL$/i.test(raw) ? null : raw.startsWith("'") ? raw.slice(1, -1) : Number(raw);
      const match = whereMatcher(cols, sql);
      let affected = 0;
      if (ci >= 0) {
        for (const r of mockRows[table] ?? []) {
          if (match(r)) {
            r[ci] = val as never;
            affected += 1;
          }
        }
      }
      return { columns: [], rows: [], rowsAffected: affected, truncated: false, elapsedMs: 3, message: `${affected} row(s) affected` };
    }

    // COUNT(*) — powers the affected-row estimate in the update confirm dialog.
    if (/SELECT\s+COUNT\(\*\)/i.test(sql)) {
      const table = sql.match(/FROM\s+["`]?(\w+)["`]?/i)?.[1] ?? "demo_sales";
      const cols = columns[table] ?? [];
      const n = (mockRows[table] ?? []).filter(whereMatcher(cols, sql)).length;
      return { columns: [{ name: "n", typeName: "INTEGER" }], rows: [[n]], rowsAffected: null, truncated: false, elapsedMs: 1, message: null };
    }

    if (/monthly_revenue/i.test(sql)) {
      return {
        columns: [
          { name: "month", typeName: "TEXT" },
          { name: "revenue", typeName: "REAL" },
        ],
        rows: [
          ["2026-01", 182340.5],
          ["2026-02", 175002.0],
          ["2026-03", 199120.75],
          ["2026-04", 210433.2],
          ["2026-05", 205998.9],
          ["2026-06", 231884.6],
        ],
        rowsAffected: null,
        truncated: false,
        elapsedMs: 2,
        message: null,
      };
    }
    for (const table of ["demo_customers", "demo_products", "demo_sales"]) {
      if (new RegExp(`(?:FROM\\s+|FROM\\s+[\"\u0060])${table}`, "i").test(sql) && /SELECT\s+\*/i.test(sql)) {
        return tableQuery(table, sql);
      }
    }
    return salesResult();
  },
  async runReadOnlyQuery(_c: string, sql: string, filters: DatasetQueryFilter[] = []): Promise<QueryResult> {
    if (!/^\s*(select|with)\b/i.test(sql) || /;|\b(insert|update|delete|drop|alter|create)\b/i.test(sql)) {
      throw new Error("Dashboard datasets only allow one read-only SELECT query.");
    }
    // 语义/聚合查询(指标看板)走合成器,出结构正确的维度+指标数据;
    // 简单 SELECT *(历史数据集)仍走原表数据。
    const result = /\bgroup\s+by\b|coalesce|\bwith\b|\b(?:sum|avg|count|max|min)\s*\(/i.test(sql) ? syntheticResult(sql) : await this.runQuery(_c, sql);
    const indexed = filters
      .map((filter) => ({
        ...filter,
        index: result.columns.findIndex((column) => column.name === filter.field),
      }))
      .filter((filter) => filter.index >= 0);
    return {
      ...result,
      rows: result.rows.filter((row) => indexed.every((filter) => {
        const actual = String(row[filter.index] ?? "NULL").toLocaleLowerCase();
        const expected = filter.value.toLocaleLowerCase();
        return filter.kind === "text" ? actual.includes(expected) : actual === expected;
      })),
    };
  },
  async listDatasets() {
    return datasets.map((item) => structuredClone(item));
  },
  async saveDataset(dataset: Dataset) {
    const copy = structuredClone(dataset);
    datasets = datasets.some((item) => item.id === copy.id)
      ? datasets.map((item) => (item.id === copy.id ? copy : item))
      : [...datasets, copy];
    return structuredClone(copy);
  },
  async deleteDataset(id: string) {
    datasets = datasets.filter((item) => item.id !== id);
  },
  async listDashboards() {
    return dashboards.map((item) => structuredClone(item));
  },
  async saveDashboard(document: DashboardDocument) {
    const copy = structuredClone(document);
    dashboards = dashboards.some((item) => item.id === copy.id)
      ? dashboards.map((item) => (item.id === copy.id ? copy : item))
      : [...dashboards, copy];
    persistMockDashboards();
    return structuredClone(copy);
  },
  async publishDashboard(document: DashboardDocument) {
    const saved = await this.saveDashboard(document);
    const history = dashboardVersions[saved.id] ?? [];
    dashboardVersions[saved.id] = [
      ...history.filter((item) => item.revision !== saved.revision),
      structuredClone(saved),
    ].sort((a, b) => b.revision - a.revision).slice(0, 50);
    persistMockDashboardVersions();
    return structuredClone(saved);
  },
  async listDashboardVersions(id: string) {
    return structuredClone(dashboardVersions[id] ?? []);
  },
  async deleteDashboard(id: string) {
    dashboards = dashboards.filter((item) => item.id !== id);
    delete dashboardVersions[id];
    persistMockDashboards();
    persistMockDashboardVersions();
  },
  async updateCell(request: UpdateCellRequest) {
    await delay(80);
    const tableColumns = columns[request.table] ?? [];
    const primaryKeys = tableColumns.filter((column) => column.isPrimaryKey);
    const row = (mockRows[request.table] ?? []).find((candidate) =>
      primaryKeys.every((primaryKey) => {
        const index = tableColumns.findIndex((column) => column.name === primaryKey.name);
        return candidate[index] === request.primaryKey[primaryKey.name];
      }),
    );
    const columnIndex = tableColumns.findIndex((column) => column.name === request.column);
    if (!row || columnIndex < 0 || row[columnIndex] !== request.oldValue) {
      throw new Error("The row changed since it was loaded. Refresh and try again.");
    }
    row[columnIndex] = request.newValue;
    return 1;
  },
  async runStatements(connId: string, statements: string[]): Promise<number> {
    let total = 0;
    for (const sql of statements) total += (await this.runQuery(connId, sql)).rowsAffected ?? 0;
    return total;
  },

  async applyCellEdits(edits: UpdateCellRequest[]) {
    for (const edit of edits) {
      await this.updateCell(edit);
    }
    return edits.length;
  },
  async createDemo() {
    return demo;
  },
};
