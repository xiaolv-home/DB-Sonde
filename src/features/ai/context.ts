import { useMetrics } from "../metrics/metricsStore";
import { metricSourceTables } from "../metrics/metricSql";

/** 给 AI 的「这张表」上下文:建在它上的指标口径。
 *
 *  从表详情点「问 AI」时带着这张表(focus);没带的话,问题里提到了哪张指标底表就说哪张。
 *  纯读指标目录,不连任何服务器、不写死任何表名。 */

const norm = (s?: string) => (s ?? "").trim().toLowerCase();
const bareName = (id: string) => id.split(".").pop() ?? id;

/** 每张底表 → 用到它的指标(名称(单位):口径) */
function metricsByTable(): Map<string, string[]> {
  const metrics = useMetrics.getState().metrics;
  const lookup = (id: string) => metrics.find((x) => x.id === id);
  const out = new Map<string, string[]>();
  for (const m of metrics) {
    const line = `${m.name}${m.unit ? `(${m.unit})` : ""}${m.caliber ? `:${m.caliber}` : ""}`;
    for (const t of new Set(metricSourceTables(m, lookup).map(norm))) {
      const bucket = out.get(t);
      if (bucket) bucket.push(line); else out.set(t, [line]);
    }
  }
  return out;
}

/** 哪几张表要说:带了 focus 就是它;否则问题里提到名字的指标底表(最多 cap 张) */
function pickTables(byTable: Map<string, string[]>, focusId: string | null, question: string, cap = 3): string[] {
  const all = [...byTable.keys()];
  if (focusId) {
    const f = norm(focusId);
    return all.filter((t) => t === f || bareName(t) === bareName(f)).slice(0, cap);
  }
  const q = norm(question);
  return all.filter((t) => bareName(t).length > 2 && q.includes(bareName(t))).slice(0, cap);
}

/** 给 AI 的「相关表的指标口径」一段话;没什么可说的就是 "" */
export function buildTableContext(focusId: string | null, question: string): string {
  const byTable = metricsByTable();
  return pickTables(byTable, focusId, question)
    .map((t) => [`【表 ${t}】`, `- 相关指标口径: ${byTable.get(t)!.slice(0, 8).join(" | ")}`].join("\n"))
    .join("\n\n");
}

/** 上下文小标签上显示的名字 */
export function focusLabel(focusId: string | null): string | null {
  return focusId || null;
}
