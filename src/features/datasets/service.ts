/**
 * 数据集的存取与字段探测。
 *
 * 探测就是拿数据集的 SQL 真跑一行 —— 列名和类型由数据库说了算,比解析 SQL 靠谱,
 * 也顺带验证了这段 SQL 到底能不能执行。已经标好的字段(改过显示名、调过维度/度量)
 * 在重新探测后保留,只补新增列、去掉已消失的列。
 */
import { splitSqlStatements, stripLeadingComments } from "../../lib/sql";
import { api } from "../../lib/api";
import type { DbKind } from "../../types";
import type { Dataset, DatasetField } from "./domain";
import { buildDatasetSql, inferRole, normalizeDataset } from "./domain";

function datasetReadSql(dataset: Dataset, kind: DbKind | undefined): string {
  const sql = buildDatasetSql(dataset, kind);
  const statements = splitSqlStatements(sql, kind).filter(part => stripLeadingComments(part).trim());
  if (statements.length !== 1) throw new Error("数据集需要一条只读查询 SQL");
  // Ordinary trailing semicolons are accepted; the backend remains the final
  // statement validator and enforces read-only transaction isolation.
  return statements[0];
}

export const datasetRepository = {
  async list(): Promise<Dataset[]> {
    return (await api.listDatasets()).map(normalizeDataset);
  },
  async save(dataset: Dataset): Promise<Dataset> {
    return normalizeDataset(await api.saveDataset({ ...dataset, updatedAt: new Date().toISOString() }));
  },
  delete(id: string): Promise<void> {
    return api.deleteDataset(id);
  },
};

/**
 * 探测字段。
 *
 * 关联数据集按表逐个取列:字段得知道自己来自哪张表,界面才分得了组 —— 八十多列铺成
 * 一片谁也找不到东西。两张表撞名的列,后来的那个加表别名前缀,不然取数时分不清是谁的。
 *
 * SQL 数据集没有表可分,跑一行让数据库报列名和类型,顺带验证这段 SQL 能执行。
 *
 * 两种情况都保留用户调过的东西(显示名、维度/度量、保留与否、默认汇总)和自己加的计算 / 分组字段,只补新列、
 * 去掉已消失的列 —— 重新探测一次就把人工标注清空,没人会再点第二次。
 */
export async function probeFields(dataset: Dataset, kind: DbKind | undefined): Promise<DatasetField[]> {
  return [...(await probeColumns(dataset, kind)), ...derivedFields(dataset)];
}

/** 计算字段 / 分组字段是人自己加的,不在任何表里 —— 认字段时原样留着,不然改一下来源它们就没了 */
function derivedFields(dataset: Dataset): DatasetField[] {
  return dataset.fields.filter((f) => f.expr || f.grouping);
}

async function probeColumns(dataset: Dataset, kind: DbKind | undefined): Promise<DatasetField[]> {
  const previousByKey = new Map(dataset.fields.map((f) => [`${f.from ?? ""}.${f.column ?? f.name}`, f]));

  if (dataset.source.kind === "join") {
    const tables = [
      { alias: dataset.source.base.alias, table: dataset.source.base.table },
      ...dataset.source.joins.map((j) => ({ alias: j.alias, table: j.table })),
    ].filter((t) => t.table);
    if (tables.length === 0) throw new Error("还没选表");

    const seen = new Set<string>();
    const fields: DatasetField[] = [];
    for (const { alias, table } of tables) {
      const columns = await api.listColumns(dataset.connectionId, dataset.database ?? "", "", table);
      for (const column of columns) {
        // 撞名的列改名,原名留在 column 里,取数照旧按原名引用。
        const name = seen.has(column.name) ? `${alias}_${column.name}` : column.name;
        seen.add(column.name);
        const previous = previousByKey.get(`${alias}.${column.name}`);
        fields.push(previous
          ? { ...previous, name, type: column.dataType ?? previous.type }
          : {
              name,
              column: column.name,
              from: alias,
              label: column.comment ?? undefined,
              type: column.dataType,
              role: inferRole(column.dataType, column.name),
            });
      }
    }
    return fields;
  }

  const sql = datasetReadSql(dataset, kind);
  const result = await api.runReadOnlyQuery(dataset.connectionId, dataset.database, sql, 1);
  return result.columns.map((column) => {
    const previous = previousByKey.get(`.${column.name}`);
    return previous
      ? { ...previous, type: column.typeName ?? previous.type }
      : { name: column.name, type: column.typeName, role: inferRole(column.typeName, column.name) };
  });
}

/** 预览数据集的前 N 行,建数据集时用来确认口径对不对。 */
export async function previewDataset(dataset: Dataset, kind: DbKind | undefined, rows = 50) {
  const sql = datasetReadSql(dataset, kind);
  return api.runReadOnlyQuery(dataset.connectionId, dataset.database, sql, rows);
}
