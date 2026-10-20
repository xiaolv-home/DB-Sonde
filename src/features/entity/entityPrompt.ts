import { entityId } from "./entityStore";
import { fieldsUsedOn } from "../../lib/sqlColumns";
import type { Metric } from "../metrics/metricsStore";
import { metricSourceTables } from "../metrics/metricSql";
import { compareText } from "../../lib/collate";

export interface MetricFact { id: string; name: string; unit?: string; caliber?: string; fields: string[] }
export interface EntityFacts {
  id: string;
  /** 建在这张表上的指标(底表里有它的),带上读了它哪几个字段 */
  metrics: MetricFact[];
}

/** 指标的底表里有没有这张表。底表可能写成「库.表」也可能只写表名。 */
function usesTable(sources: string[], id: string): boolean {
  const bare = id.split(".").pop() ?? id;
  return sources.some((s) => {
    const t = s.trim().toLowerCase();
    return t === id || (!t.includes(".") && t === bare) || (!id.includes(".") && t.endsWith(`.${bare}`));
  });
}

/** 一张表的事实:建在它上的指标。面板和给 AI 的提示词共用同一份。 */
export function collectEntityFacts(target: { database?: string; table: string }, catalog: Metric[]): EntityFacts {
  const id = entityId(target.database, target.table);
  const lookup = (mid: string) => catalog.find((x) => x.id === mid);
  /* 指标显示中文名,并算出它到底读了这张表的哪几个字段 —— 悬停就能看见,不用去指标中心翻口径。 */
  const metrics = catalog
    .filter((m) => usesTable(metricSourceTables(m, lookup), id))
    .map((m) => {
      const sql = `${JSON.stringify(m.queryPlan ?? "")} ${m.sql ?? ""}`;
      return { id: m.id, name: m.name, unit: m.unit, caliber: m.caliber, fields: fieldsUsedOn(sql, id) };
    })
    .sort((a, b) => compareText(a.name, b.name));
  return { id, metrics };
}

/* 给 AI 的不是一串指标名,而是按字段聚合的结构表(138 个名字既塞不下也没信息量 ——
   真正有用的是"哪一列被多少指标吃着",那才是改表时会踩到谁的依据)。 */
export function buildEntityPrompt(d: EntityFacts, connName: string): string {
  const byField = new Map<string, string[]>();
  let unknown = 0;
  for (const m of d.metrics) {
    if (m.fields.length === 0) { unknown++; continue; }
    for (const f of m.fields) {
      const bucket = byField.get(f); if (bucket) bucket.push(m.name); else byField.set(f, [m.name]);
    }
  }
  /* 几乎每个指标都读的字段(日期键、主键这类)单独拎一行,不混进下面的清单 ——
     它们在清单里永远排第一,把真正有区分度的列挤到看不见的地方。
     但也不能直接扔:改这种字段恰恰是波及面最大的,得让模型知道。
     判断靠**占比**,不靠字段名:换个公司(trade_date / account_id)写死的名字就失灵了。 */
  const analysed = d.metrics.length - unknown;
  const isShared = (count: number) => analysed >= 8 && count >= analysed * 0.9;
  const ranked = [...byField.entries()].sort((a, b) => b[1].length - a[1].length);
  const sharedKeys = ranked.filter(([, names]) => isShared(names.length));
  const distinctive = ranked.filter(([, names]) => !isShared(names.length));
  const fieldLines = distinctive
    .slice(0, 25)
    .map(([f, names]) => `- ${f} — ${names.length} 个指标(${names.slice(0, 5).join("、")}${names.length > 5 ? " 等" : ""})`);
  if (distinctive.length > 25) fieldLines.push(`(还有 ${distinctive.length - 25} 个字段未列出)`);

  const lines = [
    `关于数据表 ${d.id}(连接:${connName}):`,
    "",
    d.metrics.length ? `【建在它上的指标】共 ${d.metrics.length} 个,按它们读到的字段归类:` : "【建在它上的指标】指标目录里没有指标用到这张表。",
    sharedKeys.length ? `- (共用键,几乎每个指标都读)${sharedKeys.map(([f, names]) => `${f} — ${names.length} 个`).join("、")}` : null,
    ...fieldLines,
    unknown ? `(另有 ${unknown} 个指标没解析出具体字段)` : null,
    "",
    "请先看一下这张表的结构和数据,然后回答两件事:",
    "1. 这张表是做什么的、关键字段是哪些;",
    "2. 要改它(加列、改口径、回刷历史)需要注意什么、会波及哪些指标。",
    "只做只读分析,不要给建表或刷数的 SQL。",
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}
