import { assertStorageReadable, readStoredJson, writeStoredJson } from "../../lib/jsonStorage";
import { create } from "zustand";
import { nanoid } from "nanoid";
import type { Endpoint, EtlKind, EtlSource, EtlFieldMapping } from "./types";
import { getEtlAdapter } from "./adapters";
import { redactJdbc, stripHostCredentials } from "./adapters/shared";

const KEY = "sonde.etlSources.v1";

/* 已落盘数据的脱敏迁移。
 *
 * 早先 parseJdbc 不剥凭据,`jdbc:postgresql://root:pw@pg/db` 的 host 被整段存成
 * `root:pw@pg`;redactJdbc 又认不出 Oracle thin 的 `user/pw@host`,detail 里也
 * 留着口令。解析那头已经修了,但**修解析救不了已经写进 localStorage 的那些** ——
 * 用户不会为了清掉一个口令去重导所有 ETL 源。所以读的时候过一遍,变了就立刻写回。 */
function scrub(list: EtlSource[]): { list: EtlSource[]; changed: boolean } {
  let changed = false;
  const endpoint = (e: Endpoint): Endpoint => {
    const host = e.host ? stripHostCredentials(e.host) : e.host;
    const detail = e.detail ? redactJdbc(e.detail) : e.detail;
    if (host === e.host && detail === e.detail) return e;
    changed = true;
    return { ...e, ...(host !== undefined && { host }), ...(detail !== undefined && { detail }) };
  };
  const scrubbed = list.map(source => ({
    ...source,
    jobs: source.jobs.map(job => ({ ...job, sources: job.sources.map(endpoint), targets: job.targets.map(endpoint) })),
  }));
  return { list: changed ? scrubbed : list, changed };
}

function load(): EtlSource[] {
  const stored = readStoredJson<EtlSource[]>(KEY, [], value => Array.isArray(value) && value.every(item => item && typeof item.id === "string" && Array.isArray(item.jobs)));
  const { list, changed } = scrub(stored);
  if (changed) persist(list);
  return list;
}
function persist(list: EtlSource[]): void {
  writeStoredJson(KEY, list);
}

interface EtlState {
  open: boolean;
  sources: EtlSource[];
  selectedId: string | null;

  setOpen: (open: boolean) => void;
  /** 从本地存储重新读一遍(别的窗口改过之后,比如独立的画布窗口要最新的血缘) */
  reload: () => void;
  select: (id: string | null) => void;
  /** Create a source by parsing config text with the chosen adapter. */
  addSource: (name: string, kind: EtlKind, text: string) => void;
  /** Create a source from already-parsed jobs (bulk folder import). */
  addSourceJobs: (name: string, kind: EtlKind, jobs: EtlSource["jobs"], fieldMapping?: EtlFieldMapping) => void;
  /** Parse more config into an existing source (appends jobs). */
  importMore: (id: string, text: string) => void;
  removeSource: (id: string) => void;
  /** 删掉一个作业 —— 服务器上那个作业已经下线/删除了,清单里还留着就会一直
   *  把不存在的表画进血缘。比整个源删掉重导轻得多(重导要连服务器)。 */
  removeJob: (sourceId: string, jobId: string) => void;
  upsertSource: (source: EtlSource) => void;
  upsertSources: (sources: EtlSource[]) => void;
}

export const useEtl = create<EtlState>((set, get) => ({
  open: false,
  sources: load(),
  selectedId: null,

  setOpen: (open) => set({ open }),
  reload: () => set({ sources: load() }),
  select: (id) => set({ selectedId: id }),

  addSource: (name, kind, text) => {
    const jobs = getEtlAdapter(kind).parse(text); // throws on bad input
    const src: EtlSource = {
      id: nanoid(8),
      name: name.trim() || getEtlAdapter(kind).label,
      kind,
      jobs,
      updatedAt: Date.now(),
    };
    const list = [...get().sources, src];
    persist(list);
    set({ sources: list, selectedId: src.id });
  },

  addSourceJobs: (name, kind, jobs, fieldMapping) => {
    if (new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error("导入作业标识重复，请检查来源文件");
    const src: EtlSource = {
      id: nanoid(8),
      name: name.trim() || getEtlAdapter(kind).label,
      kind,
      jobs,
      fieldMapping,
      updatedAt: Date.now(),
    };
    const list = [...get().sources, src];
    persist(list);
    set({ sources: list, selectedId: src.id });
  },

  importMore: (id, text) => {
    const src = get().sources.find((s) => s.id === id);
    if (!src) return;
    const jobs = getEtlAdapter(src.kind).parse(text, src.fieldMapping); // throws on bad input
    if (jobs.some(job => src.jobs.some(existing => existing.id === job.id))) throw new Error("作业标识已存在，请勿重复追加同一作业");
    const list = get().sources.map((s) =>
      s.id === id ? { ...s, jobs: [...s.jobs, ...jobs], updatedAt: Date.now() } : s,
    );
    persist(list);
    set({ sources: list });
  },

  upsertSource: (source) => get().upsertSources([source]),
  upsertSources: (sources) => {
    const ids = new Set(sources.map(source => source.id));
    if (ids.size !== sources.length) throw new Error("来源标识重复，未保存");
    const list = [...get().sources.filter(source => !ids.has(source.id)), ...sources];
    persist(list);
    set({ sources: list });
  },
  removeJob: (sourceId, jobId) => {
    const list = get().sources.map((s) =>
      s.id === sourceId ? { ...s, jobs: s.jobs.filter((j) => j.id !== jobId), updatedAt: Date.now() } : s,
    );
    persist(list);
    set({ sources: list });
  },

  removeSource: (id) => {
    const list = get().sources.filter((s) => s.id !== id);
    persist(list);
    set((s) => ({ sources: list, selectedId: s.selectedId === id ? null : s.selectedId }));
  },
}));

/** Synchronizers cannot interpret a failed catalog read as proof that all jobs were removed. */
export function etlSourcesForSync(): EtlSource[] {
  assertStorageReadable(KEY);
  return useEtl.getState().sources;
}
