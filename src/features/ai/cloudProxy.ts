import { Channel, invoke } from "@tauri-apps/api/core";
import type { AiProvider } from "./aiTypes";

export interface ProxyHttpResponse {
  status: number;
  body: string;
  retryAfter: string | null;
}

export interface ChatStreamEvent {
  kind: "chunk" | "done" | "error" | string;
  data: string;
}

function requestId(): string {
  return globalThis.crypto.randomUUID();
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" ? error : String(error));
}

/** Scheme, host, and port. Default ports are omitted, matching the Rust origin check. */
export function cloudOrigin(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Non-streaming model call. The cloud API key stays in Rust. */
export function cloudModelRequest(options: {
  provider: AiProvider;
  baseUrl: string;
  path: string;
  method: "GET" | "POST";
  body?: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ProxyHttpResponse> {
  const id = requestId();
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void invoke("cloud_model_cancel", { requestId: id }).catch(() => {});
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    invoke<ProxyHttpResponse>("cloud_model_request", {
      call: {
        requestId: id,
        provider: options.provider,
        baseUrl: options.baseUrl,
        path: options.path,
        method: options.method,
        body: options.body ?? null,
        timeoutMs: options.timeoutMs,
      },
    }).then(
      (value) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) reject(abortReason(signal));
        else reject(asError(error));
      },
    );
  });
}

export function proxyResponse(result: ProxyHttpResponse): Response {
  const headers = new Headers();
  if (result.retryAfter) headers.set("retry-after", result.retryAfter);
  return new Response(result.body, { status: result.status, headers });
}

/** Streaming model chat. Chunks are already valid UTF-8 text. */
export function cloudChatStream(options: {
  provider: AiProvider;
  baseUrl: string;
  body: string;
  onEvent: (event: ChatStreamEvent) => void;
}): { cancel: () => void; done: Promise<void> } {
  const id = requestId();
  let cancelled = false;
  const channel = new Channel<ChatStreamEvent>();
  channel.onmessage = (event) => {
    if (!cancelled) options.onEvent(event);
  };
  const done = invoke("cloud_chat_stream", {
    requestId: id,
    provider: options.provider,
    baseUrl: options.baseUrl,
    body: options.body,
    channel,
  }).then(
    () => undefined,
    (error: unknown) => {
      if (cancelled) return;
      throw asError(error);
    },
  );
  return {
    cancel: () => {
      cancelled = true;
      void invoke("cloud_model_cancel", { requestId: id }).catch(() => {});
    },
    done,
  };
}
