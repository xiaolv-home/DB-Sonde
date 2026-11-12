import { invoke } from "@tauri-apps/api/core";
import { inTauri } from "../../lib/mockBackend";
import { cloudModelRequest } from "./cloudProxy";

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

/** Start the built-in GGUF download. Repository path and SHA-256 are pinned in Rust. */
export async function modelDownload(): Promise<void> {
  return invoke("ai_model_download");
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
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (inTauri) {
        const res = await cloudModelRequest({
          provider: "builtin",
          baseUrl,
          path: "models",
          method: "GET",
          timeoutMs: 2_000,
        });
        if (res.status >= 200 && res.status < 300) return true;
      } else {
        const res = await fetch(baseUrl.replace(/\/$/, "") + "/models");
        if (res.ok) return true;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}
