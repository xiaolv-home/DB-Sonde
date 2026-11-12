import { createHttpRetry, ModelHttpError } from "./httpRetry";
import { providerFor as routeProvider, bindingFor as routeBinding, routingSummary as describeRouting, type NodeRole, type ModelBinding } from "./modelRouting";
import { structuredRequestPolicy } from "../../ai/providers/requestPolicy";
import { useAi, type AiConfig, type AiProvider } from "../../ai/aiStore";
import { validate, type JsonSchema } from "../jsonSchema";

/**
 * 结构化输出客户端 —— Agent 每个节点的"嘴"。
 *
 * 和 ai/aiClient.ts 的 streamChat 是两码事,所以不合并:那边是流式聊天(要边吐边显),
 * 这边是一次拿一个能过 schema 的 JSON(要非流式 + 校验 + 失败重试)。硬合会两边都别扭。
 *
 * 附录 A 实测出来的三个坑,全落在这里:
 *  1. LM Studio **不支持** response_format:json_object(直接 400),所以降级只有两级:
 *     json_schema → 纯 prompt。json_object 只对云端 OpenAI 有意义。
 *  2. 开思考 + json_schema 时,受约束的 JSON 会整个跑进 reasoning_content 而
 *     content 是空的 —— 所以取文本时要兜底去 reasoning 里捞。
 *  3. chat_template_kwargs.enable_thinking 在 LM Studio + Qwen3.6 上不生效,
 *     真正管用的是 reasoning_effort:"none"。结构化调用一律关思考:实测开着
 *     不仅不提升正确率(80% vs 90%),还多烧一倍 token。
 */

export type { NodeRole, ModelBinding } from "./modelRouting";
export const providerFor = (role: NodeRole, config: AiConfig = useAi.getState().config) => routeProvider(role, config);
export const bindingFor = (role: NodeRole, config: AiConfig = useAi.getState().config) => routeBinding(role, config);
export const routingSummary = (config: AiConfig = useAi.getState().config) => describeRouting(config);

export interface StructuredCall {
  role: NodeRole;
  /** 节点名,只用于审计。 */
  node: string;
  system: string;
  user: string;
  schema: JsonSchema;
  /** schema 的名字,给 response_format 用。 */
  name: string;
  /** schema 校验失败时最多回灌几次错误重试。 */
  maxRepairs?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Images exist only in the request, never in workflow checkpoints. */
  images?: string[];
  modelOverride?: { provider: AiProvider; model: string; };
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ({ type: "text"; text: string; } | { type: "image_url"; image_url: { url: string; }; })[]; };

export type StructuredMode = "json_schema" | "prompt";

export interface StructuredResult<T> {
  ok: boolean;
  data?: T;
  /** 最后一次的校验错误(ok=false 时有值)。 */
  errors?: string[];
  raw?: string;
  attempts: number;
  ms: number;
  promptTokens: number;
  completionTokens: number;
  /** 实际生效的模式,便于排查端点能力。 */
  mode: StructuredMode;
}

function baseUrlOf(config: AiConfig, provider: AiProvider): { url: string; apiKey?: string; } {
  if (provider === "local") return { url: config.local.baseUrl };
  if (provider === "cloud") return { url: config.cloud.baseUrl, apiKey: config.cloud.apiKey };
  return { url: config.builtin.baseUrl };
}

/**
 * ```json 围栏、前后废话都剥掉,取第一个**完整**的 JSON 对象。
 *
 * 原来是「第一个 { 到最后一个 }」整段去 parse。模型爱在正文里写带花括号的话
 * (「按 {日期范围} 汇总」「见 {附录}」),只要出现一个,截出来的那段就不是合法 JSON,
 * 整次调用作废、白白多跑一轮修复。改成从每个 { 起做括号配对,配平了就试着 parse,
 * 不成再试下一个 { —— 字符串里的花括号和转义要跳过,否则 {"note":"见 {附录}"} 会配错。
 */
export function extractJson(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  for (let start = body.indexOf("{"); start >= 0; start = body.indexOf("{", start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < body.length; i += 1) {
      const ch = body[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth > 0) continue;
        try { return JSON.parse(body.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

/** 一次 HTTP 调用。mode 决定用不用端点的 schema 强约束。 */
async function once(
  call: StructuredCall,
  binding: ModelBinding,
  mode: StructuredMode,
  messages: ChatMessage[],
  config: AiConfig,
  request: ReturnType<typeof createHttpRetry>,
  onAttempt: () => void,
): Promise<{ text: string; promptTokens: number; completionTokens: number; }> {
  const { url, apiKey } = baseUrlOf(config, binding.provider);
  const policy = structuredRequestPolicy(binding.provider, binding.model, {
    model: binding.model,
    messages,
    temperature: binding.temperature,
    max_tokens: call.maxTokens ?? binding.maxTokens,
    stream: false,
  }, binding.timeoutMs);
  const { body } = policy;
  if (mode === "json_schema") {
    body.response_format = { type: "json_schema", json_schema: { name: call.name, strict: true, schema: call.schema } };
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const timeout = AbortSignal.timeout(policy.timeoutMs);
  const signal = call.signal ? AbortSignal.any([call.signal, timeout]) : timeout;
  const res = await request(() => {
    onAttempt();
    return fetch(`${url.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers, body: JSON.stringify(body), signal,
    });
  }, signal);
  const json = await res.json();
  const message = json.choices?.[0]?.message ?? {};
  // 撞上 max_tokens 被硬截断 —— 要说清楚,别报成"不是合法 JSON"让人查错方向
  if (json.choices?.[0]?.finish_reason === "length") {
    throw new Error(`模型输出被 max_tokens(${body.max_tokens})截断,JSON 不完整。通常是 schema 里的数组没设上限,模型陷入了重复。`);
  }
  // 坑 2:开思考 + json_schema 时 JSON 跑进 reasoning_content,content 反而是空的
  const text: string = (message.content || "").trim() || message.reasoning_content || message.reasoning || "";
  return {
    text,
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
  };
}

/**
 * 要一个能过 schema 的 JSON。
 *
 * 失败时把**校验错误原文**回灌给模型再试 —— 错误信息本身就是修复指令,
 * 比重新跑一遍同样的提示词有效得多。
 */
export async function callStructured<T>(
  call: StructuredCall,
  config: AiConfig = useAi.getState().config,
): Promise<StructuredResult<T>> {
  const binding = { ...bindingFor(call.role, config), ...call.modelOverride };
  const maxRepairs = call.maxRepairs ?? 2;
  const started = Date.now();
  const schemaText = JSON.stringify(call.schema);

  let mode: StructuredMode = "json_schema";
  let promptTokens = 0;
  let completionTokens = 0;
  let attempts = 0;
  const request = createHttpRetry();
  let lastErrors: string[] = ["没有任何输出"];
  let lastRaw = "";
  const history: ChatMessage[] = [
    { role: "system", content: call.system },
    { role: "user", content: call.images?.length ? [{ type: "text", text: call.user }, ...call.images.map((url) => ({ type: "image_url" as const, image_url: { url } }))] : call.user },
  ];

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    call.signal?.throwIfAborted();
    let text: string;
    try {
      const out = await once(call, binding, mode, mode === "json_schema" ? history : [
        { role: "system", content: `${call.system}\n\n输出必须满足这个 JSON Schema:\n${schemaText}\n\n只输出一个 JSON 对象,前后不要有任何文字或 \`\`\` 包裹。` },
        ...history.slice(1),
      ], config, request, () => { attempts++; });
      text = out.text;
      promptTokens += out.promptTokens;
      completionTokens += out.completionTokens;
    } catch (error) {
      call.signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      // 截断不是端点能力问题,降级到纯 prompt 只会更糟(没有语法约束更容易跑飞)
      if (/max_tokens/.test(message)) {
        return { ok: false, errors: [message.replace(/^Error:\s*/, "")], attempts, ms: Date.now() - started, promptTokens, completionTokens, mode };
      }
      // 坑 1:端点不支持 json_schema(LM Studio 老版本 / 某些兼容实现)→ 降级到纯 prompt
      if (mode === "json_schema" && error instanceof ModelHttpError && error.status === 400 && (/response_format|json_schema|structured.output/i.test(error.detail) || !call.images?.length)) {
        mode = "prompt";
        attempt -= 1; // 这次不算重试次数,换个模式重来
        continue;
      }
      return { ok: false, errors: [message], attempts, ms: Date.now() - started, promptTokens, completionTokens, mode };
    }

    lastRaw = text;
    const parsed = extractJson(text);
    if (parsed === null) {
      lastErrors = [`输出不是合法 JSON(收到 ${text.length} 个字符)`];
    } else {
      const errors = validate(parsed, call.schema);
      if (errors.length === 0) {
        return { ok: true, data: parsed as T, attempts, ms: Date.now() - started, promptTokens, completionTokens, mode, raw: text };
      }
      lastErrors = errors;
    }

    if (attempt === maxRepairs) break;
    history.push({ role: "assistant", content: text.slice(0, 2000) });
    history.push({
      role: "user",
      content: `你上一次的输出不符合要求:\n${lastErrors.map((e) => `  - ${e}`).join("\n")}\n请只输出修正后的完整 JSON,不要解释。`,
    });
  }

  return { ok: false, errors: lastErrors, raw: lastRaw, attempts, ms: Date.now() - started, promptTokens, completionTokens, mode };
}
