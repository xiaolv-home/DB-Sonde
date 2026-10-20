import { create } from "zustand";

/** 表详情抽屉对着的那张表(或视图)。 */
export interface EntityTarget {
  connId: string;
  connName?: string;
  database?: string;
  schema?: string;
  table: string;
  objectKind?: "table" | "view";
}

interface EntityState {
  target: EntityTarget | null;
  open: (t: EntityTarget) => void;
  close: () => void;
}

export const useEntity = create<EntityState>((set) => ({
  target: null,
  open: (t) => set({ target: t }),
  close: () => set({ target: null }),
}));

/** 表的统一写法:小写「库.表」(没有库就只是表名),和指标底表比对用。 */
export function entityId(database: string | undefined, table: string): string {
  const d = (database ?? "").trim().toLowerCase();
  const t = table.trim().toLowerCase();
  return d && t ? `${d}.${t}` : t;
}
