/**
 * 数据集中心的状态。
 *
 * 数据集是全局的:建一次,任何看板都能选。列表进程内缓存,落盘交给后端的
 * datasets.json(见 dataset_store.rs)。
 */
import { create } from "zustand";
import type { Dataset } from "./domain";
import { datasetRepository } from "./service";

interface DatasetsState {
  open: boolean;
  datasets: Dataset[];
  loading: boolean;
  /** 至少成功读过一次。看板要靠它判断「列表是空的」还是「还没读」。 */
  loaded: boolean;
  error?: string;
  /** 正在编辑的数据集("new" = 新建);null = 停在列表。看板那边能直接跳进某一个。 */
  editing: string | null;
  edit: (id: string | null) => void;
  setOpen: (open: boolean) => void;
  /** 需要数据集但不确定读过没有时调它 —— 看板挑数据集、组件取数都走这里。 */
  ensureLoaded: () => void;
  load: () => Promise<void>;
  save: (dataset: Dataset) => Promise<Dataset>;
  remove: (id: string) => Promise<void>;
}

export const useDatasets = create<DatasetsState>((set, get) => ({
  open: false,
  datasets: [],
  loading: false,
  loaded: false,
  editing: null,
  edit: (editing) => set({ editing }),
  setOpen: (open) => {
    set({ open });
    // 面板每次打开都重新读一遍:别的窗口/会话可能改过。
    if (open) void get().load();
  },
  ensureLoaded() {
    if (get().loaded || get().loading) return;
    void get().load();
  },
  async load() {
    set({ loading: true, error: undefined });
    try {
      set({ datasets: await datasetRepository.list(), loading: false, loaded: true });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },
  async save(dataset) {
    const saved = await datasetRepository.save(dataset);
    set((s) => ({
      datasets: s.datasets.some((item) => item.id === saved.id)
        ? s.datasets.map((item) => (item.id === saved.id ? saved : item))
        : [...s.datasets, saved],
    }));
    return saved;
  },
  async remove(id) {
    await datasetRepository.delete(id);
    set((s) => ({ datasets: s.datasets.filter((item) => item.id !== id) }));
  },
}));
