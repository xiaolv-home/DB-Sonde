/** 日期区间日历的纯计算。周一是一周的第一天。
 *
 *  交互外壳有两份(DateRangePicker.tsx 和离线页的 filterControls.runtime.js,
 *  后者不能 import)。网格、周界、方向键的规则以这里为准,运行时里照抄,
 *  测试两边一起对,避免再各写各的。
 */

export const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"] as const;

export const pad = (n: number) => String(n).padStart(2, "0");

export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const parseYmd = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y || 2000, (m || 1) - 1, d || 1);
};

export const startOfToday = () => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
};

export const addDays = (base: Date, n: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);

/** `m` 是 0 起的月份,和 Date#getMonth 一致。 */
export const monthEnd = (y: number, m: number) => new Date(y, m + 1, 0);

/** JS 的 getDay() 周日是 0。换成周一为 0、周日为 6。 */
export function mondayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

export function startOfWeek(date: Date): Date {
  return addDays(date, -mondayIndex(date));
}

/** 某月的 6 周网格。第一格是「包含该月 1 号的那个周一」,和表头「一二三四五六日」对齐。 */
export function monthCells(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const gridStart = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

export type RangeMode = "day" | "week" | "month" | "year";

/** 把两个代表日按粒度展开成闭区间。
 *  日 / 月 / 年的边界不随「周一开始」改变;周改成周一到周日,才能和网格的一行对上。
 */
export function expandRange(mode: RangeMode, a: string, b: string): [string, string] {
  const [lo, hi] = [a, b].sort();
  const s = parseYmd(lo);
  const e = parseYmd(hi);
  if (mode === "week") return [ymd(startOfWeek(s)), ymd(addDays(startOfWeek(e), 6))];
  if (mode === "month") return [ymd(new Date(s.getFullYear(), s.getMonth(), 1)), ymd(monthEnd(e.getFullYear(), e.getMonth()))];
  if (mode === "year") return [`${s.getFullYear()}-01-01`, `${e.getFullYear()}-12-31`];
  return [lo, hi];
}
