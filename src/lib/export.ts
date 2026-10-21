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
