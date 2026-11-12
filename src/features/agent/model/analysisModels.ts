import { defaultDeepSeekAnalysis, normalizeDeepSeekModel, applyDeepSeekVision, isDeepSeekPro } from "../../ai/providers/deepseek";
import type { AiConfig, AiProvider } from "../../ai/aiTypes";
import { bindingFor } from "./modelRouting";

export interface AnalysisModelChoice { provider: AiProvider; model: string }
export const PROVIDER_LABELS = { cloud: "云端", local: "本地服务", builtin: "内置" };
export const ANALYSIS_ROLES = [{ role: "reasoning", label: "分析结论" }, { role: "design", label: "看板设计" }, { role: "review", label: "质量复核" }] as const;

export const analysisRoles = (wantsDashboard: boolean) => ANALYSIS_ROLES.filter((r) => wantsDashboard || r.role !== "design");

/** Freeze endpoint and role choices for one run. Never put this config in checkpoints. */
export function analysisModelConfig(config: AiConfig, choice?: AnalysisModelChoice): AiConfig {
  const snapshot = structuredClone(config);
  const chosen = choice ?? defaultDeepSeekAnalysis(snapshot);
  if (!chosen) return snapshot;
  choice = { ...chosen, model: normalizeDeepSeekModel(chosen.model) };
  snapshot[choice.provider].model = choice.model.trim();
  snapshot.agentRoles = { ...snapshot.agentRoles, reasoning: choice.provider, design: choice.provider, review: choice.provider };
  applyDeepSeekVision(snapshot, choice);
  return snapshot;
}

export function analysisModelProblems(config: AiConfig, choice: AnalysisModelChoice | undefined, wantsDashboard: boolean): string[] {
  const selected = analysisModelConfig(config, choice);
  const problems = analysisRoles(wantsDashboard).flatMap(({ role, label }) => {
    const binding = bindingFor(role, selected);
    const endpoint = selected[binding.provider];
    if (!endpoint.model.trim()) return [`${label}尚未选择模型`];
    if (!endpoint.baseUrl.trim()) return [`${PROVIDER_LABELS[binding.provider]}模型尚未配置服务地址`];
    if (binding.provider === "cloud" && !selected.cloud.apiKey) return ["云端模型尚未配置 API Key，请打开 AI 设置"];
    if (binding.provider === "builtin" && !selected.builtin.ready) return ["内置模型尚未就绪"];
    return [];
  });
  return [...new Set(problems)];
}

/** Migrate only saved Pro selections from the costly default release; new choices remain explicit. */
export function economicalSavedChoice(choice?: AnalysisModelChoice): AnalysisModelChoice | undefined {
  return choice && isDeepSeekPro(choice.model.trim()) ? { ...choice, model: "deepseek-flash" } : choice;
}
