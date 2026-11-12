import { create } from "zustand";
import type { StoredRepository } from "../../lib/storedRepository";
import type { AiConfig, AiProvider } from "./aiTypes";

export interface AiState {
  panelOpen: boolean;
  settingsOpen: boolean;
  config: AiConfig;
  configError: string | null;
  setBuiltinRuntime: (builtin: AiConfig["builtin"]) => void;
  /** A question injected from elsewhere (table inspector, error, tree, …). The
   *  panel opens and auto-sends it; the nonce lets the same text fire twice. */
  seedQuestion: string | null;
  seedNonce: number;
  /** A focused table/entity node id: its cross-module dossier is attached to
   *  every question until cleared. Set by「问 AI」buttons across the app. */
  focusEntity: string | null;
  togglePanel: () => void;
  openPanel: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  /** Open the AI panel and ask this question from anywhere in the app.
   *  Optionally pin a focus entity so the answer carries its full context. */
  seedAsk: (question: string, focus?: string | null) => void;
  setFocusEntity: (id: string | null) => void;
  consumeSeed: () => string | null;
  setProvider: (provider: AiProvider) => boolean | Promise<boolean>;
  update: (patch: Partial<Omit<AiConfig, "builtin">>) => boolean | Promise<boolean>;
  updateLocal: (patch: Partial<AiConfig["local"]>) => boolean | Promise<boolean>;
  updateCloud: (patch: Partial<AiConfig["cloud"]>) => boolean | Promise<boolean>;
}


/** Persistence is injected; asynchronous saves retain responsive inputs and roll back failed drafts. */
export function createAiStore(repository: StoredRepository<AiConfig>, present = (config: AiConfig) => config) {
  return create<AiState>((set, get) => {
    let persisted = present(repository.load());
    let revision = 0, persistedRevision = 0;
    const commit = (config: AiConfig): boolean | Promise<boolean> => {
      const current = ++revision;
      const visible = present(config);
      const failed = () => {
        if (current === revision) set({ config: { ...persisted, builtin: get().config.builtin },
          configError: "AI 设置未能保存，本次修改未生效。请检查本地存储提示后重试。" });
        return false;
      };
      try {
        const saving = repository.save(config);
        if (saving) {
          // Keep controlled inputs responsive while encrypted writes serialize.
          set({ config: visible, configError: null });
          return saving.then(() => {
            if (current > persistedRevision) { persisted = visible; persistedRevision = current; }
            if (current === revision) set({ configError: null });
            return true;
          }, failed);
        }
        persisted = visible; persistedRevision = current;
        set({ config: visible, configError: null });
        return true;
      } catch {
        // Synchronous failure must retain the exact prior state object.
        set({ configError: "AI 设置未能保存，本次修改未生效。请检查本地存储提示后重试。" });
        return false;
      }
    };
    return {
      panelOpen: false,
      settingsOpen: false,
      config: persisted,
      configError: null,
      setBuiltinRuntime: (builtin) => set({ config: { ...get().config, builtin } }),
      seedQuestion: null,
      seedNonce: 0,
      focusEntity: null,
      togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
      openPanel: () => set({ panelOpen: true }),
      openSettings: () => set({ settingsOpen: true }),
      closeSettings: () => set({ settingsOpen: false }),
      seedAsk: (question, focus) =>
        set((s) => ({
          panelOpen: true,
          seedQuestion: question,
          seedNonce: s.seedNonce + 1,
          focusEntity: focus !== undefined ? focus : s.focusEntity,
        })),
      setFocusEntity: (id) => set({ focusEntity: id }),
      consumeSeed: () => {
        const q = get().seedQuestion;
        if (q !== null) set({ seedQuestion: null });
        return q;
      },
      setProvider: (provider) => commit({ ...get().config, provider }),
      update: (patch) => commit({ ...get().config, ...patch }),
      updateLocal: (patch) => commit({ ...get().config, local: { ...get().config.local, ...patch } }),
      updateCloud: (patch) => commit({ ...get().config, cloud: { ...get().config.cloud, ...patch } }),
    };
  });
}
