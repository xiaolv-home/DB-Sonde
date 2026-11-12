import type { AiConfig, AiProvider } from "../../ai/aiTypes";

export type NodeRole = "reasoning" | "structured" | "design" | "review" | "cheap";

export interface ModelBinding {
  provider: AiProvider;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

/** 角色 → 参数。温度按角色分化:要确定性的压到 0,要创意的放开。 */
const ROLE_DEFAULTS: Record<NodeRole, Pick<ModelBinding, "temperature" | "maxTokens">> = {
  reasoning: { temperature: 0.3, maxTokens: 4096 },
  structured: { temperature: 0, maxTokens: 1536 },
  /* 放开排版之后 design 的输出大了一大截:14 个组件 × (坐标 + 外观 + 图表细节 + 文案),
     2048 根本装不下 —— 第一次跑 Phase 3 验收就撞上了截断。放开了字段就得放开预算。 */
  design: { temperature: 0.5, maxTokens: 6144 },
  review: { temperature: 0.1, maxTokens: 1536 },
  cheap: { temperature: 0, maxTokens: 512 },
};

/** Prefer configured endpoints by role; explicit choices always win.
 * This is a routing default, not a claim about a particular model's quality.
 */
const ROLE_PREFERENCE: Record<NodeRole, AiProvider> = {
  reasoning: "cloud",   // 理解需求 / 写分析结论
  design: "cloud",      // 图表选型 / 布局 / 主题
  review: "cloud",      // 成品检查 —— 要的是判断力
  structured: "local",  // 范围解析这类填表活
  cheap: "local",       // 文本归一化
};

/** 这个 provider 配全了吗 —— 没配全就别往上路由。 */
function usable(provider: AiProvider, config: AiConfig): boolean {
  if (provider === "cloud") return Boolean(config.cloud.baseUrl && config.cloud.apiKey && config.cloud.model);
  if (provider === "local") return Boolean(config.local.baseUrl && config.local.model);
  return config.builtin.ready;
}

/**
 * 这个角色实际用哪个 provider。
 * 优先级:用户显式配的 > 按角色的默认偏好(且该 provider 可用) > 全局设置。
 */
export function providerFor(role: NodeRole, config: AiConfig): AiProvider {
  const explicit = config.agentRoles?.[role];
  if (explicit) return explicit;
  const preferred = ROLE_PREFERENCE[role];
  if (preferred !== config.provider && usable(preferred, config)) return preferred;
  return config.provider;
}

/** 给设置界面用:说清每个角色现在实际会走哪儿、为什么。 */
export function routingSummary(config: AiConfig): { role: NodeRole; provider: AiProvider; reason: string; }[] {
  return (Object.keys(ROLE_PREFERENCE) as NodeRole[]).map((role) => {
    const provider = providerFor(role, config);
    const explicit = config.agentRoles?.[role];
    const reason = explicit
      ? "你指定的"
      : provider === ROLE_PREFERENCE[role] && provider !== config.provider
        ? "按角色默认"
        : "跟随全局";
    return { role, provider, reason };
  });
}

export function bindingFor(role: NodeRole, config: AiConfig): ModelBinding {
  const provider = providerFor(role, config);
  const endpoint =
    provider === "local" ? config.local
      : provider === "cloud" ? config.cloud
        : config.builtin;
  return {
    provider,
    model: endpoint.model,
    timeoutMs: 120_000,
    ...ROLE_DEFAULTS[role],
  };
}

