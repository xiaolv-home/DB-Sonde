import { api } from "../../lib/api";
import { inTauri } from "../../lib/mockBackend";
import { isRecord, storedRepository } from "../../lib/storedRepository";
import { writeStoredJson } from "../../lib/jsonStorage";
import { isCanvasEdge, isCanvasList, isCanvasNode, type CanvasDoc, type CanvasEdge, type CanvasNode } from "./canvasModel";

/** 浏览器预览 / 单测下的本地存储兜底;桌面端主存储位于应用配置目录 lineage-canvases.json(不受 5MB localStorage 限制)。 */
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

/** 从桌面端原子 JSON 文件读取画布列表;首次升级若文件不存在但 localStorage 有旧画布,自动无损迁移到文件存储。 */
export async function loadCanvasesAsync(): Promise<CanvasDoc[]> {
  if (!inTauri) return canvasRepository.load();
  try {
    const raw = await api.loadCanvases();
    if (raw !== null && raw !== undefined) {
      return isCanvasList(raw) ? raw : [];
    }
    const legacy = canvasRepository.load();
    if (legacy.length > 0) {
      await api.saveCanvases(legacy);
      try { localStorage.removeItem("sonde.lineageCanvases.v1"); } catch { /* ignore */ }
    }
    return legacy;
  } catch {
    return canvasRepository.load();
  }
}

export async function saveCanvasesAsync(docs: CanvasDoc[]): Promise<void> {
  if (!inTauri) {
    canvasRepository.save(docs);
    return;
  }
  await api.saveCanvases(docs);
}

export async function loadCanvasHistoryAsync(): Promise<CanvasHistory> {
  if (!inTauri) return canvasHistoryRepository.load();
  try {
    const raw = await api.loadCanvasHistory();
    if (raw !== null && raw !== undefined) {
      return isHistory(raw) ? raw : {};
    }
    const legacy = canvasHistoryRepository.load();
    if (Object.keys(legacy).length > 0) {
      await api.saveCanvasHistory(legacy);
      try { localStorage.removeItem("sonde.lineageCanvases.history.v1"); } catch { /* ignore */ }
    }
    return legacy;
  } catch {
    return canvasHistoryRepository.load();
  }
}

export async function saveCanvasHistoryAsync(history: CanvasHistory): Promise<void> {
  if (!inTauri) {
    canvasHistoryRepository.save(history);
    return;
  }
  await api.saveCanvasHistory(history);
}

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

/* 桌面端优先走 Tauri 原生窗口注入(__SONDE_CANVAS_FOCUS__)与 canvas://focus 事件;
   localStorage 仅保留给浏览器内联预览模式兜底。 */
export const CANVAS_FOCUS_KEY = "sonde.lineageCanvases.focus";
export function requestCanvasFocus(id: string): void {
  try { localStorage.setItem(CANVAS_FOCUS_KEY, JSON.stringify({ id, at: Date.now() })); } catch { /* 写不进去就只是不切过去 */ }
}
export function takeCanvasFocus(now = Date.now()): string | null {
  const injected = (globalThis as { __SONDE_CANVAS_FOCUS__?: unknown }).__SONDE_CANVAS_FOCUS__;
  if (typeof injected === "string" && injected.length > 0) {
    (globalThis as { __SONDE_CANVAS_FOCUS__?: unknown }).__SONDE_CANVAS_FOCUS__ = null;
    try { localStorage.removeItem(CANVAS_FOCUS_KEY); } catch { /* ignore */ }
    return injected;
  }
  try {
    const raw = localStorage.getItem(CANVAS_FOCUS_KEY);
    if (!raw) return null;
    localStorage.removeItem(CANVAS_FOCUS_KEY);
    const v: unknown = JSON.parse(raw);
    return isRecord(v) && typeof v.id === "string" && typeof v.at === "number" && now - v.at < 30_000 ? v.id : null;
  } catch {
    return null;
  }
}
