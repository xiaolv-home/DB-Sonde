import { inTauri } from "../../lib/mockBackend";
import { cloudChatStream, cloudModelRequest } from "./cloudProxy";
import { chatRequestExtensions } from "./providers/requestPolicy";
import type { AiConfig } from "./aiStore";
import type { ChatMessage } from "./prompt";

export interface StreamCallbacks {
  onToken: (delta: string) => void;
  /** 思考中的增量(reasoning_content)。模型开思考时正文要等很久才开始,
   *  不透出来界面就是一片死寂 —— 实测过 21 秒不动。 */
  onThinking?: (delta: string) => void;
  onDone: (full: string) => void;
  onError: (message: string) => void;
}

export interface StreamHandle {
  cancel: () => void;
}

type Endpoint =
  | { kind: "http"; url: string; model: string; apiKey?: string }
  | { kind: "unavailable" };

function resolveEndpoint(config: AiConfig): Endpoint {
  if (config.provider === "builtin") {
    if (!config.builtin.ready) return { kind: "unavailable" };
    return { kind: "http", url: config.builtin.baseUrl, model: config.builtin.model };
  }
  if (config.provider === "local") {
    return { kind: "http", url: config.local.baseUrl, model: config.local.model };
  }
  return { kind: "http", url: config.cloud.baseUrl, model: config.cloud.model, apiKey: config.cloud.apiKey };
}

export function endpointLabel(config: AiConfig): string {
  const e = resolveEndpoint(config);
  return e.kind === "unavailable" ? "builtin (not installed)" : e.url;
}

/** Build the wire payload separately so the mode switch is explicit and easy
 *  to regression-test without starting an inference server. */
export function buildChatRequest(config: AiConfig, model: string, messages: ChatMessage[]): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    temperature: 0.2,
  };
  Object.assign(body, chatRequestExtensions(config.provider, config.thinkingEnabled));
  return body;
}

function modelIds(json: { data?: unknown; models?: unknown }): string[] {
  const rows: unknown[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  return rows
    .map((r) => (typeof r === "string" ? r : (r as { id?: string; name?: string })?.id ?? (r as { name?: string })?.name))
    .filter((x): x is string => !!x);
}

/** List model ids an OpenAI-compatible endpoint (LM Studio / Ollama / …) serves.
 *  Used by settings「检测模型」so the user never has to type the exact id.
 *  Cloud listings go through the Rust proxy so the saved key never reaches this process. */
export async function listModels(baseUrl: string, apiKey?: string, provider?: AiConfig["provider"]): Promise<string[]> {
  if (inTauri && provider === "cloud") {
    const signal = AbortSignal.timeout(15_000);
    const res = await cloudModelRequest({ baseUrl, path: "models", method: "GET", timeoutMs: 15_000, signal });
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    return modelIds(JSON.parse(res.body) as { data?: unknown; models?: unknown });
  }
  const url = baseUrl.replace(/\/$/, "") + "/models";
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return modelIds(await res.json());
}

function createSseParser(cb: StreamCallbacks) {
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const json = JSON.parse(payload);
      const chunk = json.choices?.[0]?.delta ?? {};
      const thinking: string = chunk.reasoning_content ?? chunk.reasoning ?? "";
      if (thinking) cb.onThinking?.(thinking);
      const delta: string = chunk.content ?? "";
      if (delta) {
        full += delta;
        cb.onToken(delta);
      }
    } catch {
      /* 不是合法 JSON —— 跳过这一行,别让整个回答断在这儿 */
    }
  };
  const takeLines = () => {
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
  };
  return {
    pushBytes(bytes: Uint8Array) {
      buffer += decoder.decode(bytes, { stream: true });
      takeLines();
    },
    pushText(text: string) {
      buffer += text;
      takeLines();
    },
    /** Incomplete trailing line stays unparsed, matching an aborted fetch. */
    text: () => full,
    finish(): string {
      buffer += decoder.decode();
      for (const line of buffer.split("\n")) consume(line);
      buffer = "";
      return full;
    },
  };
}

/** Stream an OpenAI-compatible chat completion. Works for the bundled
 *  llama.cpp server, LM Studio / Ollama, and cloud APIs alike. */
export function streamChat(config: AiConfig, messages: ChatMessage[], cb: StreamCallbacks): StreamHandle {
  const endpoint = resolveEndpoint(config);
  if (endpoint.kind === "unavailable") {
    const timer = setTimeout(() => cb.onError("AI 模型尚未配置或启动，请打开 AI 设置选择模型。"), 0);
    return { cancel: () => clearTimeout(timer) };
  }

  const body = JSON.stringify(buildChatRequest(config, endpoint.model, messages));
  if (inTauri && config.provider === "cloud") return streamCloud(endpoint.url, body, cb);

  const controller = new AbortController();
  const url = endpoint.url.replace(/\/$/, "") + "/chat/completions";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Local and built-in servers have no cloud key. Browser previews (no vault)
  // still send a key the user typed into this page; the desktop app does not.
  if (!inTauri && endpoint.apiKey) headers.Authorization = `Bearer ${endpoint.apiKey}`;

  (async () => {
    const parser = createSseParser(cb);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        cb.onError(`HTTP ${res.status}`);
        return;
      }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.pushBytes(value);
      }
      /* 收尾:把解码器里剩的字节吐出来,再处理最后一行。
         两件事都会丢内容:
         · 最后一条 data: 后面不带换行时(不少端点就是这样),它还留在 buffer 里 ——
           循环里 `if (done) break` 直接跳过了,回答的结尾就没了;
         · 多字节字符正好跨在最后一块的边界上时,不 flush 解码器那半个汉字就丢了。 */
      cb.onDone(parser.finish());
    } catch (error) {
      if (controller.signal.aborted) cb.onDone(parser.text());
      else cb.onError(String(error));
    }
  })();

  return { cancel: () => controller.abort() };
}

function streamCloud(baseUrl: string, body: string, cb: StreamCallbacks): StreamHandle {
  const parser = createSseParser(cb);
  let settled = false;
  let cancelled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    cb.onDone(parser.finish());
  };
  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    cb.onError(message);
  };
  const stream = cloudChatStream({
    baseUrl,
    body,
    onEvent: (event) => {
      if (event.kind === "chunk") parser.pushText(event.data);
      else finish();
    },
  });
  // Channel messages are queued ahead of the command result, but give them one
  // turn anyway so a fast resolve cannot drop the trailing SSE line.
  void stream.done.then(
    () => { setTimeout(() => { if (!settled) finish(); }, 0); },
    (error: unknown) => {
      setTimeout(() => {
        if (settled) return;
        if (cancelled) finish();
        else fail(error instanceof Error ? error.message : String(error));
      }, 0);
    },
  );
  return {
    cancel: () => {
      cancelled = true;
      stream.cancel();
      if (!settled) {
        settled = true;
        cb.onDone(parser.text());
      }
    },
  };
}
