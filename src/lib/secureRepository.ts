import { invoke, isTauri } from "@tauri-apps/api/core";
import { clearStorageProblem, reportStorageProblem } from "./jsonStorage";
import type { StoredRepository } from "./storedRepository";

export interface SecureStoragePort {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
}

/** Drop a cloud API key before it can enter renderer state. Rust already does
 *  this; repeating it here keeps a leaked field out of the settings cache. */
export function presentServiceConfig(key: string, raw: string): string {
  if (key !== "ai.config") return raw;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return raw;
    const cloud = (value as { cloud?: unknown }).cloud;
    if (!cloud || typeof cloud !== "object" || Array.isArray(cloud)) return raw;
    const endpoint = cloud as { apiKey?: unknown; hasKey?: unknown };
    const apiKey = typeof endpoint.apiKey === "string" ? endpoint.apiKey.trim() : "";
    endpoint.hasKey = endpoint.hasKey === true || apiKey.length > 0;
    endpoint.apiKey = "";
    return JSON.stringify(value);
  } catch {
    return raw;
  }
}

// Browser previews keep settings in memory only. Never substitute localStorage
// for the native encrypted vault when credentials are involved.
const native: SecureStoragePort = {
  load: async key => {
    if (!isTauri()) return null;
    const raw = await invoke<string | null>("load_service_config", { key });
    return typeof raw === "string" ? presentServiceConfig(key, raw) : raw;
  },
  save: (key, value) => isTauri() ? invoke("save_service_config", { key, value }) : Promise.resolve(),
};
const initializers: (() => Promise<void>)[] = [];
export async function initializeSecureRepositories(): Promise<void> {
  await Promise.all(initializers.map(initialize => initialize()));
}

export function secureRepository<T>(
  key: string, empty: () => T, accepts: (v: unknown) => v is T,
  port: SecureStoragePort = native,
  legacy: Pick<Storage, "getItem" | "removeItem"> = {
    getItem: key => localStorage.getItem(key), removeItem: key => localStorage.removeItem(key),
  },
): StoredRepository<T> & { initialize(): Promise<void> } {
  let cache = empty(), ready = false;
  let initialization: Promise<void> | undefined;
  let writes = Promise.resolve();
  const message = `配置 ${key} 的加密存储不可用，原始配置已保留，请恢复后重启重试。`;
  const decode = (raw: string): T => {
    const value: unknown = JSON.parse(raw);
    if (!accepts(value)) throw new Error(message);
    return value;
  };
  const repository = {
    initialize(): Promise<void> {
      return initialization ??= (async () => {
        try {
          const saved = await port.load(key);
          const previous = legacy.getItem(key);
          const value = saved !== null ? decode(saved) : previous !== null ? decode(previous) : empty();
          // A stale plaintext record cannot replace an already-encrypted record.
          if (saved === null && previous !== null) await port.save(key, JSON.stringify(value));
          if (previous !== null) legacy.removeItem(key);
          // Plaintext AI settings may still hold the cloud key. The vault keeps
          // it; renderer state only keeps the masked form.
          cache = saved === null && previous !== null && key === "ai.config"
            ? decode(presentServiceConfig(key, JSON.stringify(value)))
            : value;
          ready = true;
          clearStorageProblem(key);
        } catch {
          reportStorageProblem(key, "read", message);
        }
      })();
    },
    load: () => structuredClone(cache),
    save(value: T): Promise<void> {
      if (!accepts(value)) throw new Error(`配置 ${key} 格式无效，未保存。`);
      if (!ready) throw new Error(message);
      const snapshot = structuredClone(value);
      const write = writes.then(async () => {
        try {
          await port.save(key, JSON.stringify(snapshot));
          cache = key === "ai.config" && port === native
            ? decode(presentServiceConfig(key, JSON.stringify(snapshot))) : snapshot;
          clearStorageProblem(key);
        } catch {
          reportStorageProblem(key, "write", `配置 ${key} 加密保存失败，本次修改未保存。`);
          throw new Error(message);
        }
      });
      writes = write.catch(() => {});
      return write;
    },
  };
  initializers.push(repository.initialize);
  return repository;
}
