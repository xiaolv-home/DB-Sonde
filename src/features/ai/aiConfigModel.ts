import type { AiConfig, AiProvider } from "./aiTypes";

export const AI_CONFIG_VERSION = 2;
export type SavedAiConfig = Partial<Omit<AiConfig, "builtin" | "local" | "cloud">> & {
  v?: number;
  builtin?: Partial<AiConfig["builtin"]>;
  local?: Partial<AiConfig["local"]>;
  cloud?: Partial<AiConfig["cloud"]>;
};
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
export const isAiProvider = (value: unknown): value is AiProvider =>
  value === "builtin" || value === "local" || value === "cloud";

/** Accept legacy partial records, but never silently overwrite malformed or future fields. */
export function isSavedAiConfig(value: unknown): value is SavedAiConfig {
  if (!record(value) || !only(value, ["v", "provider", "builtin", "local", "cloud", "thinkingEnabled", "includeSampleRows", "designVision", "agentRoles"])) return false;
  if (value.v !== undefined && value.v !== 1 && value.v !== AI_CONFIG_VERSION) return false;
  if (value.provider !== undefined && !isAiProvider(value.provider)) return false;
  for (const flag of ["thinkingEnabled", "includeSampleRows"]) {
    if (value[flag] !== undefined && typeof value[flag] !== "boolean") return false;
  }
  for (const key of ["builtin", "local", "cloud"]) {
    const endpoint = value[key];
    if (endpoint === undefined) continue;
    const keys = key === "builtin" ? ["baseUrl", "model", "ready"] : key === "cloud" ? ["baseUrl", "model", "apiKey"] : ["baseUrl", "model"];
    if (!record(endpoint) || !only(endpoint, keys)) return false;
    for (const [name, field] of Object.entries(endpoint)) {
      if (field !== undefined && typeof field !== (name === "ready" ? "boolean" : "string")) return false;
    }
  }
  if (value.designVision !== undefined) {
    const vision = value.designVision;
    if (!record(vision) || !only(vision, ["enabled", "provider", "model"]) || typeof vision.enabled !== "boolean" || !isAiProvider(vision.provider) || typeof vision.model !== "string") return false;
  }
  if (value.agentRoles !== undefined) {
    const roles = value.agentRoles;
    if (!record(roles) || !only(roles, ["reasoning", "structured", "design", "review", "cheap"]) || !Object.values(roles).every(role => role === undefined || isAiProvider(role))) return false;
  }
  return true;
}

export function defaultAiConfig(): AiConfig {
  return {
    provider: "builtin",
    builtin: {
      model: "qwen2.5-coder-7b-instruct",
      // Filled in by the sidecar once it is running; until then `ready` is false.
      baseUrl: "http://127.0.0.1:8899/v1",
      ready: false,
    },
    // Optional OpenAI-compatible local endpoint. Select an installed model in settings;
    // never assume a developer's model exists on a new machine.
    local: { baseUrl: "http://127.0.0.1:1234/v1", model: "" },
    cloud: { baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" },
    thinkingEnabled: false,
    includeSampleRows: false,
  };
}

/** Readiness is an observation of this process, never a persisted promise. */
export function restoreAiConfig(saved: SavedAiConfig): AiConfig {
  const defaults = defaultAiConfig();
  return {
    provider: saved.provider ?? defaults.provider,
    builtin: { ...defaults.builtin, ...saved.builtin, ready: false },
    local: { ...defaults.local, ...saved.local },
    cloud: { ...defaults.cloud, ...saved.cloud },
    thinkingEnabled: saved.thinkingEnabled ?? defaults.thinkingEnabled,
    includeSampleRows: saved.includeSampleRows ?? defaults.includeSampleRows,
    ...(saved.agentRoles ? { agentRoles: { ...saved.agentRoles } } : {}),
    ...(saved.designVision ? { designVision: { ...saved.designVision } } : {}),
  };
}
export function savedAiConfig(config: AiConfig): SavedAiConfig {
  if (!isSavedAiConfig(config)) throw new Error("AI 配置格式无效，未保存。");
  return { ...restoreAiConfig(config), v: AI_CONFIG_VERSION };
}
