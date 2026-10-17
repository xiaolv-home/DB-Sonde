import { isRecord, storedRepository } from "../../../lib/storedRepository";
import { writeStoredJson } from "../../../lib/jsonStorage";
import { isCanvasEdge, isCanvasList, isCanvasNode, type CanvasDoc, type CanvasEdge, type CanvasNode } from "./canvasModel";

/** 链路画布存在本机。格式不对的整份不认(由 jsonStorage 保留原文并提示),不会悄悄丢图。 */
export const canvasRepository = storedRepository<CanvasDoc[]>(
  "sonde.lineageCanvases.v1", () => [], isCanvasList,
);

/* ---------- 历史版本 ----------
   每张画布留最近 HISTORY_KEEP 份,两份之间至少隔 HISTORY_GAP_MS(期间的改动并进最新那份)。
   画错了、被什么覆盖了,都能从「历史」里挑一个时间点恢复。 */
export interface CanvasVersion { at: number; nodes: CanvasNode[]; edges: CanvasEdge[]; }
export type CanvasHistory = Record<string, CanvasVersion[]>;
export const HISTORY_KEEP = 30;
export const HISTORY_GAP_MS = 2 * 60_000;

const isVersion = (v: unknown): v is CanvasVersion =>
  isRecord(v) && typeof v.at === "number" && Array.isArray(v.nodes) && v.nodes.every(isCanvasNode)
  && Array.isArray(v.edges) && v.edges.every(isCanvasEdge);
const isHistory = (v: unknown): v is CanvasHistory =>
  isRecord(v) && Object.values(v).every((list) => Array.isArray(list) && list.every(isVersion));

export const canvasHistoryRepository = storedRepository<CanvasHistory>(
  "sonde.lineageCanvases.history.v1", () => ({}), isHistory,
);

const sameContent = (a: CanvasVersion, nodes: CanvasNode[], edges: CanvasEdge[]) =>
  JSON.stringify([a.nodes, a.edges]) === JSON.stringify([nodes, edges]);

/** 记一份新版本。内容没变就不记;时间按 HISTORY_GAP_MS 切成固定的段,同一段里只留最后一份
 *  (连续画 10 分钟留 5 份,而不是一直替换成一份);milestone(比如恢复历史版本)一定新记一份,
 *  不顶掉它前面那份。纯函数,不写盘。 */
export function pushVersion(history: CanvasHistory, docId: string, nodes: CanvasNode[], edges: CanvasEdge[], now = Date.now(), milestone = false): CanvasHistory {
  const list = history[docId] ?? [];
  const last = list[list.length - 1];
  if (last && sameContent(last, nodes, edges)) return history;
  const version = { at: now, nodes, edges };
  const sameSlot = !!last && Math.floor(last.at / HISTORY_GAP_MS) === Math.floor(now / HISTORY_GAP_MS);
  const next = sameSlot && !milestone && list.length > 1 ? [...list.slice(0, -1), version] : [...list, version];
  return { ...history, [docId]: next.slice(-HISTORY_KEEP) };
}

/** 存不进去的时候原样另存一份(不校验),人能找回来,不会因为一个字段不对就整份丢掉。 */
export function saveDraft(doc: CanvasDoc): void {
  try { writeStoredJson("sonde.lineageCanvases.draft.v1", { at: Date.now(), doc }); }
  catch { /* 草稿也写不进去就只能靠界面上的提示了 */ }
}
