import { create } from "zustand";

/** 数据资产里「链路画布」那一面开没开着 */
export const useCanvasCenter = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));
