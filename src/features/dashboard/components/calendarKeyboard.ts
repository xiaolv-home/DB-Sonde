/** Keyboard movement only; the existing Sunday-first calendar/range semantics stay unchanged. */
export function moveCalendarCursor(mode: "day" | "week" | "month" | "year", date: Date, key: string): Date | null {
  const arrows: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1,
    ArrowUp: mode === "day" || mode === "week" ? -7 : -3,
    ArrowDown: mode === "day" || mode === "week" ? 7 : 3 };
  const delta = arrows[key];
  const y = date.getFullYear(), m = date.getMonth(), d = date.getDate();
  if (delta !== undefined) {
    if (mode === "month") return new Date(y, m + delta, 1);
    if (mode === "year") return new Date(y + delta, 0, 1);
    return new Date(y, m, d + delta);
  }
  if (key === "Home" || key === "End") {
    if (mode === "month") return new Date(y, key === "Home" ? 0 : 11, 1);
    if (mode === "year") return new Date(Math.floor(y / 12) * 12 + (key === "Home" ? 0 : 11), 0, 1);
    return new Date(y, m, d - date.getDay() + (key === "Home" ? 0 : 6));
  }
  if (key === "PageUp" || key === "PageDown") {
    const direction = key === "PageUp" ? -1 : 1;
    if (mode === "month") return new Date(y + direction, m, 1);
    if (mode === "year") return new Date(y + direction * 12, 0, 1);
    const next = new Date(y, m + direction, 1);
    return new Date(next.getFullYear(), next.getMonth(), Math.min(d, new Date(y, m + direction + 1, 0).getDate()));
  }
  return null;
}
