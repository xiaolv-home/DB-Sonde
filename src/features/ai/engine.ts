import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../../lib/mockBackend";

export interface EngineStatus {
  running: boolean;
  port: number;
  baseUrl: string;
  binary: string | null;
  model: string | null;
  modelSize: number | null;
}

/** Current built-in engine status (null when not running inside Tauri). */
export async function engineStatus(): Promise<EngineStatus | null> {
  if (!inTauri) return null;
  try {
    return await invoke<EngineStatus>("ai_engine_status");
  } catch {
    return null;
  }
}

export async function engineStart(modelPath?: string): Promise<EngineStatus> {
  return invoke<EngineStatus>("ai_engine_start", { modelPath: modelPath ?? null });
}

export async function engineStop(): Promise<EngineStatus> {
  return invoke<EngineStatus>("ai_engine_stop");
}

export interface DownloadProgress {
  downloading: boolean;
  bytes: number;
  total: number;
  done: boolean;
  error: string | null;
}

/** The default built-in model: Qwen2.5-Coder-7B-Instruct Q4_K_M (~4.7 GB).
 *  Downloaded from ModelScope (Alibaba) — it serves the file directly and is
 *  fast/reachable in mainland China, unlike HuggingFace which redirects large
 *  files to an AWS CDN that is commonly blocked or stalls there. */
export const BUILTIN_MODEL = {
  filename: "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf",
  total: 4_683_073_344,
  url: "https://modelscope.cn/models/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/master/qwen2.5-coder-7b-instruct-q4_k_m.gguf",
};

export async function modelDownload(
  url = BUILTIN_MODEL.url,
  filename = BUILTIN_MODEL.filename,
  total = BUILTIN_MODEL.total,
): Promise<void> {
  return invoke("ai_model_download", { url, filename, total });
}

export async function modelProgress(): Promise<DownloadProgress | null> {
  if (!inTauri) return null;
  try {
    return await invoke<DownloadProgress>("ai_model_progress");
  } catch {
    return null;
  }
}

/** Poll the OpenAI-compatible endpoint until the model has finished loading. */
export async function waitReady(baseUrl: string, timeoutMs = 90000): Promise<boolean> {
  const url = baseUrl.replace(/\/$/, "") + "/models";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}
