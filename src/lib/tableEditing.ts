import { splitSqlStatements } from "./sql";
import type {
  Cell,
  ColumnInfo,
  DbKind,
  QueryResult,
  TableContext,
  UpdateCellRequest,
} from "../types";

/**
 * Build a guarded update request for a browsed-table cell. Unlike
 * {@link prepareCellUpdate} this does not require the result SQL to equal a
 * fixed preview, so it works while the data grid is sorted / filtered / paged —
 * the update stays safe because it carries the full primary key and old value.
 */
/**
 * 把格子里改出来的文本变成要写进库的值。原值的类型决定怎么解释。
 *
 * 清空一个格子 = 置空,不是"替你填个零"。原来数字这一支是 `Number(input)` ——
 * 而 `Number("")` 正好是 0 且 isFinite,于是用户把数字格子选中删掉、回车,
 * 库里写进去的是 **0**,一声不吭。金额那一列被清成 0 和被清成 NULL,
 * 后面所有求和、日均、环比读出来是两回事,而且没有任何地方提示过。
 * 同一个函数里布尔和对象那两支清空都是抛错,只有数字自作主张。
 *
 * 文本列不在此列:空串对文本是个正经取值,跟 NULL 不是一回事,
 * 两个都要得到 —— 想要 NULL 就照旧输入 NULL。
 *
 * 类型是按**列的声明类型**判的,不是按"这一格现在长什么样"。
 * 踩过:`STORE_ID varchar(32)` 这一格眼下的值是 `806522`,想改成
 * `ebca0d4b04fd4a708d6811fc3e0db5f4`,被拒了 ——「请输入有效数字或 NULL」。
 * 一列 varchar,因为当前那一行恰好装着一串数字,就被当成数字列。
 * 表格本来就有权威答案(`isNumericType(col.typeName)`,右对齐和筛选器都在用它),
 * 只有这里在靠值猜。
 *
 * 反过来**不能**用列类型去强转:DECIMAL 是故意以字符串回来的(保精度),
 * 拿 Number() 一转 `100.00` 就成了 `100`,金额列会悄悄丢小数位。
 * 所以 columnIsNumeric 只用来**放行**(非数字列别拦),不用来收紧。
 */
export function parseEditedValue(
  input: string,
  original: Cell,
  messages: { number: string; boolean: string },
  /** 列的声明类型是不是数字。传 false = 这列不是数字列,任何文本都该收下。
   *  不传就退回老行为(按值猜),给还没接上类型信息的调用方留路。 */
  columnIsNumeric?: boolean,
  /** 列允不允许 NULL。true = 清空就存 NULL;false(NOT NULL)= 清空存空字符串,
   *  写 NULL 会被库拒掉;不传 = 不知道,保持老行为(文本列存空字符串)。 */
  columnNullable?: boolean,
): Cell {
  if (input.trim().toUpperCase() === "NULL") return null;
  /* 文本列清空,以前一律存 ''。可数字列、布尔列清空都是 NULL,同一个"清空"
     动作按类型结果不一样;而 '' 和 NULL 在库里是两回事(IS NULL 查不到 '')。
     界面上 NULL 显示成斜体「NULL」、'' 显示成空白 —— 用户清空后看到的是空白,
     以为跟旁边的 NULL 一样,其实不是。可空列清空就该是 NULL。 */
  if (input === "" && columnNullable === true) return null;
  const blank = input.trim() === "";
  if (typeof original === "number" && columnIsNumeric !== false) {
    if (blank) return null;
    const value = Number(input);
    if (!Number.isFinite(value)) throw new Error(messages.number);
    return Number.isInteger(value) && !Number.isSafeInteger(value) ? input.trim() : value;
  }
  if (typeof original === "boolean") {
    if (blank) return null;
    if (/^(true|1)$/i.test(input)) return true;
    if (/^(false|0)$/i.test(input)) return false;
    throw new Error(messages.boolean);
  }
  if (typeof original === "object" && original !== null) {
    if (blank) return null;
    return JSON.parse(input) as object;
  }
  return input;
}

/**
 * 定位「这一行」用哪几列。有主键用主键;没有主键就用整行的列 —— 跟 DBeaver 的「所有列」虚拟键一样。
 *
 * 整行定位时,值对不准的列不拿来比:大对象 / 二进制 / JSON / 空间类型比不了或比不准,
 * 单精度浮点存进去和读出来不是同一个数(0.1 存成 0.100000001…),拿它比永远对不上。
 * 少比几列不会删错:改和删都要求「正好命中一行」,命中多行会整笔撤销。
 */
export interface RowKey {
  columns: string[];
  /** 没有主键,按整行定位 */
  wholeRow: boolean;
}
const UNMATCHABLE_TYPE = /lob\b|blob|binary|bytea|json|xml|geometry|geography|point|polygon|linestring|image|\braw\b|^float4?\b|^real\b/i;

export function rowKeyOf(columns: ColumnInfo[]): RowKey {
  const primary = columns.filter((column) => column.isPrimaryKey).map((column) => column.name);
  if (primary.length) return { columns: primary, wholeRow: false };
  return { columns: columns.filter((column) => !UNMATCHABLE_TYPE.test(column.dataType.trim())).map((column) => column.name), wholeRow: true };
}

/** 按 rowKeyOf 从结果的一行里取出定位用的值。 */
function rowKeyValues(columns: ColumnInfo[], result: QueryResult, cells: Cell[]): Record<string, Cell> {
  const key = rowKeyOf(columns);
  if (!key.columns.length) throw new Error("这张表没有能用来定位一行的列");
  const values: Record<string, Cell> = {};
  for (const name of key.columns) {
    const index = result.columns.findIndex((item) => item.name === name);
    if (index < 0) throw new Error(key.wholeRow ? `按整行定位需要所有列,结果里少了 ${name}` : `Primary key ${name} is missing from the result`);
    values[name] = cells[index];
  }
  return values;
}

export function buildCellRequest(
  connId: string,
  database: string,
  schema: string,
  table: string,
  columns: ColumnInfo[],
  result: QueryResult,
  row: number,
  column: number,
  newValue: Cell,
): UpdateCellRequest {
  const columnName = result.columns[column]?.name;
  const cells = result.rows[row];
  if (!columnName || !cells) throw new Error("The selected cell is no longer available");

  const primaryKey = rowKeyValues(columns, result, cells);
  return {
    connId,
    database,
    schema,
    table,
    column: columnName,
    primaryKey,
    oldValue: cells[column],
    newValue,
  };
}

interface PreparedCellUpdate {
  request: UpdateCellRequest;
  nextResult: QueryResult;
}

export function prepareCellUpdate(
  connId: string,
  sql: string,
  context: TableContext,
  result: QueryResult,
  row: number,
  column: number,
  newValue: Cell,
): PreparedCellUpdate {
  if (!context.editable) throw new Error(context.editDisabledReason || "This result is read-only");
  if (sql.trim() !== context.previewSql.trim()) {
    throw new Error("Editing is disabled after changing the preview SQL");
  }
  const columnName = result.columns[column]?.name;
  const cells = result.rows[row];
  if (!columnName || !cells) throw new Error("The selected cell is no longer available");

  const primaryKey = rowKeyValues(context.columns, result, cells);

  const nextResult: QueryResult = {
    ...result,
    rows: result.rows.map((current, rowIndex) =>
      rowIndex === row
        ? current.map((value, columnIndex) => (columnIndex === column ? newValue : value))
        : current,
    ),
  };
  return {
    request: {
      connId,
      database: context.database,
      schema: context.schema,
      table: context.table,
      column: columnName,
      primaryKey,
      oldValue: cells[column],
      newValue,
    },
    nextResult,
  };
}

/**
 * 跑掉的那条 SQL 跟可编辑预览是不是同一条(脚本执行器会去掉分隔符,所以要拆完再比)。
 * 方言要传进去 —— 拆分规则跟反斜杠有关,两边用不同规则拆出来的结果没有可比性。
 */
export function matchesPreviewExecution(executed: string | undefined, preview: string, kind?: DbKind): boolean {
  if (!executed) return false;
  const actual = splitSqlStatements(executed, kind);
  const expected = splitSqlStatements(preview, kind);
  return actual.length === 1 && expected.length === 1 && actual[0] === expected[0];
}
