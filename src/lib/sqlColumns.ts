/** SQL 列名的粗解析 —— 纯函数(表详情里「这个指标读了这张表的哪几个字段」用)。 */

/**
 * 某个指标用到了某张表的哪些字段。
 * 先在 SQL 里找这张表被起了什么别名(`FROM shop_ads.ads_outlet_daily a`),
 * 再把 `a.xxx` 收集起来 —— 比全文抓所有 `x.y` 准得多,不会把 JOIN 进来的维表字段
 * 算到这张表头上。
 */
export function fieldsUsedOn(sql: string, tableId: string): string[] {
  const bare = (tableId.split(".").pop() ?? tableId).replace(/[^A-Za-z0-9_]/g, "");
  if (!bare) return [];
  const aliases = new Set<string>();
  for (const m of sql.matchAll(new RegExp(`\\b(?:FROM|JOIN)\\s+\`?(?:[A-Za-z_]\\w*\`?\\.\`?)?${bare}\`?\\s+(?:AS\\s+)?\`?([A-Za-z_]\\w*)\`?`, "gi"))) {
    const a = m[1].toLowerCase();
    if (!["on", "where", "group", "order", "join", "left", "inner", "using", "set"].includes(a)) aliases.add(a);
  }
  const cols = new Set<string>();
  for (const a of aliases) {
    for (const m of sql.matchAll(new RegExp(`\\b${a}\\.\`?([A-Za-z_]\\w*)\`?`, "gi"))) cols.add(m[1].toLowerCase());
  }
  return [...cols].sort();
}
