/**
 * 关联字段自动推断,和「下一张该连哪张表」的推荐。
 *
 * 建关联最烦的一步是从两串字段里翻出该对上的那两个,而绝大多数关联就是
 * 「xxx_id 对 xxx 表的 id」或者两边同名的键。这里把它猜出来,人只需要看一眼对不对 ——
 * 猜错了点一下就能改,但不该让每次都从零开始选。
 *
 * 只按名字猜,不看数据。猜不出就返回空,让人自己选 —— 胡乱猜一个比不猜更糟,它看起来是对的。
 * 两边的主键(都叫 id)对 id 几乎从来不是想要的关联(那是一对一),不猜。
 */

/** 归一化:忽略大小写和下划线,`StoreID` / `store_id` / `storeid` 视为同一个。 */
const norm = (name: string) => name.toLowerCase().replace(/[_\s-]/g, "");

/** 分层前缀:dim_ / dwd_ / ads_ … 不算表名的一部分 */
const LAYER_PREFIX = /^(t|dim|dwd|dws|ods|ads|dm|fact|fct|tbl)_/i;
/** 键的后缀:xxx_id / xxx_code / xxx_no */
const KEY_SUFFIX = /(id|code|no|key)$/;
/** 只有后缀、没有词干的就是主键样的名字(id / code / no) */
const isPrimaryName = (name: string) => ["id", "code", "no", "key"].includes(norm(name));

/** 表名的词干:去掉库名和分层前缀,复数变单数。dw.dim_customers → customer */
export function tableStem(table: string): string {
  let s = norm((table.split(".").pop() ?? table).replace(LAYER_PREFIX, ""));
  if (s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (/(ses|xes|ches|shes)$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  return s;
}

/** 键的词干对不对得上这张表:完全一样最好;表名前面多出一截(demo_customers、dw_sales_area)也算 */
function pointsTo(colStem: string | null, table: string): boolean {
  if (!colStem) return false;
  const t = tableStem(table);
  return t === colStem || (colStem.length >= 3 && t.endsWith(colStem));
}

/** 一列「指向别的表」时指向的词干:customer_id → customer;本身就是 id 的没有 */
function foreignStem(column: string): string | null {
  const n = norm(column);
  const m = n.match(KEY_SUFFIX);
  if (!m || n.length === m[0].length) return null;
  return n.slice(0, -m[0].length);
}

/** 这张表的主键样字段:id / code / no,或者「词干 + id」(customer 表的 customer_id) */
function primaryOf(fields: string[], table: string): string | undefined {
  const stem = tableStem(table);
  return fields.find(isPrimaryName) ?? fields.find((f) => foreignStem(f) === stem);
}

export interface JoinGuess {
  /** 新表那边的字段 */
  field: string;
  /** 已有那张表的字段 */
  targetField: string;
  /** 怎么猜出来的,界面上写给人看。 */
  reason: string;
}

/**
 * 新表(newTable,字段 fields)和已有的一张表(targetTable,字段 targetFields)怎么对上。
 * 按把握从高到低:
 *   1. 已有表里有指向新表的键(sales.customer_id → customers.id);
 *   2. 新表里有指向已有表的键(order_items.order_id → orders.id);
 *   3. 两边同名的键(都有 store_id),但不是两边的主键 id 对 id。
 */
export function guessJoin(fields: string[], targetFields: string[], targetTable: string, newTable: string): JoinGuess | undefined {
  const newPk = primaryOf(fields, newTable);
  const toNew = targetFields.find((f) => pointsTo(foreignStem(f), newTable));
  if (toNew && newPk && toNew !== newPk) {
    return { field: newPk, targetField: toNew, reason: `${targetTable}.${toNew} 指向 ${newTable}` };
  }
  const targetPk = primaryOf(targetFields, targetTable);
  const toTarget = fields.find((f) => pointsTo(foreignStem(f), targetTable));
  if (toTarget && targetPk && toTarget !== targetPk) {
    return { field: toTarget, targetField: targetPk, reason: `${newTable}.${toTarget} 指向 ${targetTable}` };
  }
  const target = new Map(targetFields.map((name) => [norm(name), name]));
  const shared = fields.find((f) => foreignStem(f) !== null && target.has(norm(f)));
  if (shared) return { field: shared, targetField: target.get(norm(shared))!, reason: `两边都有 ${shared}` };
  return undefined;
}

/** 新表挂到已有的哪一张上:挨个试,「指向」比「同名」有把握,取最有把握的那个 */
export function guessJoinAcross(
  newTable: string, fields: string[],
  existing: { alias: string; table: string; fields: string[] }[],
): (JoinGuess & { targetAlias: string }) | undefined {
  let best: (JoinGuess & { targetAlias: string }) | undefined;
  for (const t of existing) {
    const g = guessJoin(fields, t.fields, t.table, newTable);
    if (!g) continue;
    if (!best || (g.reason.includes("指向") && !best.reason.includes("指向"))) best = { ...g, targetAlias: t.alias };
  }
  return best;
}

/**
 * 「下一张该连哪张表」:已有的表里每个指向别处的键(customer_id、brand_id),
 * 在库里找词干对得上的表(customers、dim_brand)。已经用上的不推荐。
 */
export function recommendTables(
  existing: { table: string; fields: string[] }[],
  allTables: string[],
  limit = 5,
): { table: string; via: string }[] {
  const used = new Set(existing.map((t) => t.table));
  const candidates = allTables.filter((t) => !used.has(t));
  // 词干完全一样的优先(store_id → dim_store,而不是 dim_sales_store)
  const find = (stem: string) => candidates.find((t) => tableStem(t) === stem) ?? candidates.find((t) => pointsTo(stem, t));
  const out: { table: string; via: string }[] = [];
  const seen = new Set<string>();
  for (const t of existing) {
    for (const f of t.fields) {
      const stem = foreignStem(f);
      const hit = stem ? find(stem) : undefined;
      if (!hit || seen.has(hit)) continue;
      seen.add(hit);
      out.push({ table: hit, via: f });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
