import { callStructured } from "./model/structured";
import { useMetrics } from "../metrics/metricsStore";
import { callTool } from "./tools/registry";
import { getPlan } from "./tools/dataTools";
import { createConclusionReviewer } from "./evidenceExploration";
import { createDrillInvestigator } from "./drillInvestigator";

const ports = { readCatalog: () => useMetrics.getState().metrics, callStructured, callTool, getPlan };
export const drillInvestigator = createDrillInvestigator(ports);
export const conclusionReviewer = createConclusionReviewer(ports);
