import { utcDay } from "../../lib/dates";
export interface TimePoint { key: string; value: number }
interface AlignedPair { now: TimePoint; then: TimePoint; delta: number }

/** 时间键里用来和对比期对齐的那一段。日用日号:10-13 对 09-13,中间缺一天不会把后面整段错位。 */
function dateSlot(key: string, breakdown: string): string | null {
  const text = key.trim();
  if (breakdown === "day") {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    return match ? match[3] : null;
  }
  if (breakdown === "week") {
    const match = /W(\d{1,2})$/i.exec(text);
    return match ? match[1].padStart(2, "0") : null;
  }
  if (breakdown === "month") {
    const match = /^(\d{4})-(\d{2})$/.exec(text);
    return match ? match[2] : null;
  }
  if (breakdown === "year") {
    const match = /^(\d{4})$/.exec(text);
    return match ? match[1] : null;
  }
  return null;
}

/** 这一天在自己的日期区间里是第几天(从 0 起)。用日期算,不用结果里的行号。 */
function dayOffset(key: string, start: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(key) || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return null;
  const at = Date.parse(`${key.slice(0, 10)}T00:00:00Z`);
  const from = Date.parse(`${start}T00:00:00Z`);
  if (!Number.isFinite(at) || !Number.isFinite(from)) return null;
  const offset = Math.round((at - from) / 86_400_000);
  return offset >= 0 ? offset : null;
}

/** Monday ordinal for an ISO week key or calendar date; independent of local DST. */
function weekOrdinal(key: string): number | null {
  const iso = /^(\d{4})-W(\d{2})$/.exec(key);
  if (iso) {
    const year = Number(iso[1]), week = Number(iso[2]);
    if (week < 1 || week > 53) return null;
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const monday = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86_400_000 + (week - 1) * 7 * 86_400_000;
    if (new Date(monday + 3 * 86_400_000).getUTCFullYear() !== year) return null;
    return Math.floor(monday / 604_800_000);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const date = new Date(`${key}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || utcDay(date) !== key) return null;
  return Math.floor((date.getTime() - ((date.getUTCDay() + 6) % 7) * 86_400_000) / 604_800_000);
}

/**
 * 本期和对比期按日期键配对。
 * 两边都有日期区间时,按「区间里的第 n 天」对齐 —— 区间本身不是整月、中间又缺一天,也不会错位。
 * 否则按日号 / 周号 / 月份对齐。对不上的期留空,不拿数组下标硬凑。
 * 键解析不了时不配对；不能用结果行号猜测缺失日期。
 */
export function alignByDateKey(
  series: TimePoint[],
  before: TimePoint[],
  breakdown: string,
  currentRange?: { start: string; end: string },
  compareRange?: { start: string; end: string },
): AlignedPair[] | null {
  if (breakdown === "week" && currentRange && compareRange) {
    const nowStart = weekOrdinal(currentRange.start), thenStart = weekOrdinal(compareRange.start);
    if (nowStart === null || thenStart === null) return [];
    const indexed = new Map(before.flatMap(point => {
      const week = weekOrdinal(point.key);
      return week === null ? [] : [[week - thenStart, point] as const];
    }));
    return series.flatMap(now => {
      const week = weekOrdinal(now.key);
      const then = week === null ? undefined : indexed.get(week - nowStart);
      return then ? [{ now, then, delta: now.value - then.value }] : [];
    });
  }
  if ((breakdown === "month" || breakdown === "year") && currentRange && compareRange) {
    const period = (key: string): number | null => {
      const match = /^(\d{4})(?:-(\d{2}))?/.exec(key);
      if (!match || (breakdown === "month" && !match[2])) return null;
      return breakdown === "month" ? Number(match[1]) * 12 + Number(match[2]) - 1 : Number(match[1]);
    };
    const nowStart = period(currentRange.start), thenStart = period(compareRange.start);
    if (nowStart !== null && thenStart !== null) {
      const indexed = new Map(before.flatMap(point => {
        const key = period(point.key);
        return key === null ? [] : [[key - thenStart, point] as const];
      }));
      return series.flatMap(now => {
        const key = period(now.key);
        const then = key === null ? undefined : indexed.get(key - nowStart);
        return then ? [{ now, then, delta: now.value - then.value }] : [];
      });
    }
  }
  if (breakdown === "day" && currentRange && compareRange) {
    const compareAt = new Map<number, TimePoint>();
    let indexed = 0;
    for (const point of before) {
      const offset = dayOffset(point.key, compareRange.start);
      if (offset === null) continue;
      indexed += 1;
      if (!compareAt.has(offset)) compareAt.set(offset, point);
    }
    if (indexed) {
      return series.flatMap((now) => {
        const offset = dayOffset(now.key, currentRange.start);
        if (offset === null) return [];
        const then = compareAt.get(offset);
        return then ? [{ now, then, delta: now.value - then.value }] : [];
      });
    }
  }
  const slots = new Map<string, TimePoint>();
  const ambiguous = new Set<string>();
  for (const point of before) {
    const slot = dateSlot(point.key, breakdown);
    if (slot === null) continue;
    if (slots.has(slot)) ambiguous.add(slot);
    else slots.set(slot, point);
  }
  if (!slots.size) return null;
  return series.flatMap((now) => {
    const slot = dateSlot(now.key, breakdown);
    if (slot === null || ambiguous.has(slot)) return [];
    const then = slots.get(slot);
    return then ? [{ now, then, delta: now.value - then.value }] : [];
  });
}
