export type AiProvider = "builtin" | "local" | "cloud";

export interface AiConfig {
  provider: AiProvider;
  /** The bundled model — endpoint is managed by the sidecar once installed. */
  builtin: { model: string; baseUrl: string; ready: boolean };
  local: { baseUrl: string; model: string };
  cloud: { baseUrl: string; apiKey: string; model: string };
  /** Qwen hybrid reasoning switch. Sent to local OpenAI-compatible endpoints
   *  as chat_template_kwargs.enable_thinking; direct answers are the default. */
  thinkingEnabled: boolean;
  /** Include a few sample rows in the prompt (off by default for privacy). */
  includeSampleRows: boolean;
  /** Optional screenshot reader and explicit per-role provider overrides. */
  designVision?: { enabled: boolean; provider: AiProvider; model: string };
  agentRoles?: Partial<Record<"reasoning" | "structured" | "design" | "review" | "cheap", AiProvider>>;
}

