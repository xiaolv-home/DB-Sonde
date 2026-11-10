import { dashboardPreview, visualReviewer, commitDesign } from "./designLoop";
import { drillInvestigator, conclusionReviewer } from "./evidenceLoop";
import { questionPlanner } from "./questionPlanner";
import { record } from "./audit";
import { dataExecutor, dataValidator, analysisAgent, layoutDesigner, dashboardReviewer, lockedPlanner } from "./nodes";
import { buildAnalysisGraph } from "./analysisGraph";
import type { RunAnalysisOptions } from "./analysisWorkflow";
import type { LockedParams } from "./analysisTypes";
import { createAnalysisSession } from "./analysisSession";
import "./tools/dataTools";
import "./tools/dashboardTools";
export type { RunAnalysisOptions } from "./analysisWorkflow";
export { explainFailure } from "./analysisWorkflow";

const nodes = {
  dataExecutor, dataValidator, analysisAgent, layoutDesigner, dashboardReviewer, lockedPlanner,
  dashboardPreview, visualReviewer, commitDesign, drillInvestigator, conclusionReviewer, questionPlanner
};
export async function runLockedAnalysis(params: LockedParams, options: RunAnalysisOptions = {}) {
  const session = createAnalysisSession(options.signal, options.connId);
  try { return await session.runLockedAnalysis(params, options); } finally { session.dispose(); }
}
export async function runQuestionAnalysis(question: string, options: RunAnalysisOptions = {}) {
  const session = createAnalysisSession(options.signal, options.connId);
  try { return await session.runQuestionAnalysis(question, options); } finally { session.dispose(); }
}
export const buildLockedGraph = (question = false) => buildAnalysisGraph(nodes, question, { record });
