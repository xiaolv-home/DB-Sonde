import type { QueryResult } from "../types";
import { api } from "./api";
import { inTauri } from "./mockBackend";

export type ExportFormat = "csv" | "json";

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeResult(result: QueryResult, format: ExportFormat): string {
  if (format === "json") {
    /* 列名会重复:`SELECT * FROM a JOIN b` 两边各有一个 id。直接当对象的键,后一个就把前一个
       覆盖掉了 —— 导出的文件里整列不见,还看不出来。重名的依次加 _2、_3。 */
    const original = new Set(result.columns.map((column) => column.name));
    const used = new Set<string>();
    const keys = result.columns.map((column) => {
      let key = column.name;
      // 改出来的名字也不能撞上别的列本来的名字(真有一列就叫 id_2)
      for (let n = 2; used.has(key) || (key !== column.name && original.has(key)); n += 1) key = `${column.name}_${n}`;
      used.add(key);
      return key;
    });
    const rows = result.rows.map((row) => Object.fromEntries(keys.map((key, index) => [key, row[index]])));
    return JSON.stringify(rows, null, 2);
  }

  const header = result.columns.map((column) => csvCell(column.name)).join(",");
  const body = result.rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  return `${header}\r\n${body}`;
}

export async function exportResultFile(
  result: QueryResult,
  format: ExportFormat,
  baseName = "query-result",
): Promise<string | undefined> {
  const content = serializeResult(result, format);
  if (inTauri) {
    const payload = format === "csv" ? `\uFEFF${content}` : content;
    return api.saveExport(baseName, format, payload);
  }
  const mime = format === "json" ? "application/json" : "text/csv";
  const blob = new Blob([format === "csv" ? `\uFEFF${content}` : content], {
    type: `${mime};charset=utf-8`,
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${baseName}.${format}`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return undefined;
}

/** 表「数据」页一次最多导出多少行。再多的话内存和文件都扛不住(后端单个导出文件上限 100 MB),
 *  该让人先加筛选条件。 */
export const TABLE_EXPORT_MAX_ROWS = 500_000;

export type TableExportOutcome =
  | { kind: "empty" }
  | { kind: "tooMany"; count: number }
  | { kind: "saved"; count: number; path?: string };

/** 按表「数据」页当前的筛选和排序导出**全部**匹配的行,不只是已经加载的那一页。
 *  先数一遍:超上限就不去取数据,免得白拉几十万行再拒绝。
 *  取的时候多要一行 —— 数完到取之间表可能又进了数据,超了照样拒,不悄悄截断。 */
export async function exportTableData(opts: {
  countSql: string;
  dataSql: (limit: number) => string;
  run: (sql: string, maxRows: number) => Promise<QueryResult>;
  save: (result: QueryResult) => Promise<string | undefined>;
  max?: number;
}): Promise<TableExportOutcome> {
  const max = opts.max ?? TABLE_EXPORT_MAX_ROWS;
  const counted = await opts.run(opts.countSql, 1);
  const count = Number(counted.rows?.[0]?.[0] ?? 0);
  if (count > max) return { kind: "tooMany", count };
  if (count === 0) return { kind: "empty" };
  const result = await opts.run(opts.dataSql(max + 1), max + 1);
  if (result.rows.length > max) return { kind: "tooMany", count: result.rows.length };
  if (result.rows.length === 0) return { kind: "empty" };
  return { kind: "saved", count: result.rows.length, path: await opts.save(result) };
}
