import { create } from "zustand";
import { createRequestScope } from "../../lib/requestScope";
import type { AiProvider } from "./aiTypes";

export interface ModelEndpoint { provider: AiProvider; baseUrl: string; apiKey?: string; }
export function sameModelEndpoint(a: ModelEndpoint | null, b: ModelEndpoint | null): boolean {
  return a === b || !!a && !!b && a.provider === b.provider && a.baseUrl === b.baseUrl && a.apiKey === b.apiKey;
}
interface DiscoveryState {
  target: ModelEndpoint | null;
  models: string[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  setTarget(target: ModelEndpoint | null): void;
  load(): Promise<void>;
  dispose(): void;
}

/** Model metadata only: the caller supplies transport; this never runs inference. */
export function createModelDiscovery(list: (url: string, apiKey?: string) => Promise<string[]>) {
  const requests = createRequestScope();
  const empty = { models: [] as string[], loading: false, loaded: false, error: null };
  return create<DiscoveryState>((set, get) => ({
    target: null, ...empty,
    setTarget(target) {
      if (sameModelEndpoint(target, get().target)) return;
      requests.invalidate();
      set({ target: target ? { ...target } : null, ...empty });
    },
    async load() {
      const target = get().target;
      if (!target || requests.isPending("models")) return;
      const ticket = requests.begin("models");
      set({ ...empty, loading: true });
      try {
        const models = await list(target.baseUrl, target.apiKey);
        if (!ticket.isCurrent()) return;
        if (!Array.isArray(models) || !models.every(model => typeof model === "string")) throw new Error("invalid model list");
        set({ models: [...new Set(models.filter(model => model.trim()))], loaded: true });
      } catch {
        if (ticket.isCurrent()) set({ error: "读取模型列表失败，请检查服务地址和认证信息，或直接填写模型名称。" });
      } finally {
        ticket.finish();
        if (ticket.isCurrent()) set({ loading: false });
      }
    },
    dispose() { requests.invalidate(); set({ target: null, ...empty }); },
  }));
}
