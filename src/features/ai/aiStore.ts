import { inTauri } from "../../lib/mockBackend";
import { presentServiceConfig } from "../../lib/secureRepository";
import { createAiStore } from "./aiRuntime";
import { createAiConfigRepository } from "./aiConfigRepository";
export type { AiConfig, AiProvider } from "./aiTypes";
export type { AiState } from "./aiRuntime";

/** Production composition; consumers can create isolated stores with another repository. */
export const useAi = createAiStore(createAiConfigRepository(), config => inTauri
  ? JSON.parse(presentServiceConfig("ai.config", JSON.stringify(config)))
  : config);
