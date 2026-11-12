import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import type { EntityTarget } from "./entityStore";

/**
 * 数据新鲜度 —— 直接问数据本身,而不是问调度器。
 *
 * 「这个数更新到哪儿了」的权威答案是表里的水位列(etl_time / update_time / day …)
 * 的最大值,不是"作业跑没跑成功"(作业成功但没捞到数据的情况太常见了)。
 * 这样也不依赖调度器接入、每张表都能用。
 */

/** 候选水位列,越靠前越优先。名字命中即可,类型再做一次时间/日期校验。 */
const WATERMARK_COLUMNS = [
  "etl_time", "etl_date", "update_time", "updated_at", "updatetime", "modify_time",
  "stat_date", "biz_date", "data_date", "day", "dt", "ds", "date", "create_time", "created_at",
];
const TIME_TYPE = /date|time|timestamp|datetime/i;

export interface Freshness {
  loading: boolean;
  /** 用了哪一列算的 */
  column?: string;
  /** 该列最大值的原始文本 */
  value?: string;
  /** 距今多久(可读) */
  ago?: string;
  /** 落后程度:今天内 / 一天内 / 更久 */
  tone?: "fresh" | "stale" | "old";
  error?: string;
  /** 没有可用的时间列 */
  unavailable?: boolean;
}

function humanAgo(value: string): { ago: string; tone: Freshness["tone"] } | null {
  // 同时吃 "2026-09-10 16:33:42" 和 "2026-09-10"
  const normalized = value.trim().replace(" ", "T");
  const t = Date.parse(normalized.length <= 10 ? `${normalized}T00:00:00` : normalized);
  if (!Number.isFinite(t)) return null;
  const mins = Math.floor((Date.now() - t) / 60000);
  if (mins < 0) return { ago: "刚刚", tone: "fresh" };
  if (mins < 60) return { ago: `${mins} 分钟前`, tone: "fresh" };
  const hours = Math.floor(mins / 60);
  if (hours < 24) return { ago: `${hours} 小时前`, tone: hours <= 12 ? "fresh" : "stale" };
  const days = Math.floor(hours / 24);
  return { ago: `${days} 天前`, tone: days <= 1 ? "stale" : "old" };
}

/** 查一张表的水位:挑一个时间列跑 SELECT MAX(col)。只读、单行,很便宜。 */
export function useFreshness(target: EntityTarget | null): Freshness {
  const [state, setState] = useState<Freshness>({ loading: false });
  const key = target ? `${target.connId}|${target.database ?? ""}|${target.schema ?? ""}|${target.table}` : "";
  useEffect(() => {
    if (!target) { setState({ loading: false }); return; }
    let cancelled = false;
    setState({ loading: true });
    void (async () => {
      try {
        const cols = await api.listColumns(target.connId, target.database ?? "", target.schema ?? "", target.table);
        const byName = new Map(cols.map((c) => [c.name.toLowerCase(), c]));
        // 三档挑列,优先级从严到宽:
        // 1) 名字正好是水位列且类型也是时间类
        let picked = WATERMARK_COLUMNS
          .map((candidate) => byName.get(candidate))
          .find((col) => col && TIME_TYPE.test(col.dataType))?.name;
        // 2) 名字正好是水位列(类型不限)—— SQLite/Hive 里日期常存成 TEXT/STRING
        if (!picked) picked = WATERMARK_COLUMNS.map((c) => byName.get(c)).find(Boolean)?.name;
        // 3) 名字里带时间词(sale_date / stat_dt 这种),按同样的优先级顺序找
        if (!picked) {
          const hit = WATERMARK_COLUMNS.find((candidate) =>
            cols.some((c) => c.name.toLowerCase().includes(candidate)));
          if (hit) picked = cols.find((c) => c.name.toLowerCase().includes(hit))?.name;
        }
        // 4) 兜底:任意时间类型的列
        if (!picked) picked = cols.find((c) => TIME_TYPE.test(c.dataType))?.name;
        if (!picked) { if (!cancelled) setState({ loading: false, unavailable: true }); return; }

        const qualified = target.database ? `${target.database}.${target.table}` : target.table;
        const res = await api.runReadOnlyQuery(
          target.connId, target.database, `SELECT MAX(${picked}) AS v FROM ${qualified}`, 1, [],
        );
        const raw = res.rows[0]?.[0];
        if (cancelled) return;
        if (raw == null) { setState({ loading: false, column: picked, unavailable: true }); return; }
        const value = String(raw);
        const human = humanAgo(value);
        // 挑错列时(比如某个名字带 date 的数值列)会拿到一个毫无意义的数字 ——
        // 与其把它当"新鲜度"显示出来误导人,不如直接说判断不了。
        if (!human && !/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(value.trim())) {
          setState({ loading: false, column: picked, unavailable: true });
          return;
        }
        setState({ loading: false, column: picked, value, ago: human?.ago, tone: human?.tone });
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: String(e) });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}
