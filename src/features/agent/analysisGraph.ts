import { Graph, END, type NodeFn, type GraphRuntime } from "./graph";

export interface AnalysisNodes {
  lockedPlanner: NodeFn;
  dataExecutor: NodeFn;
  dataValidator: NodeFn;
  analysisAgent: NodeFn;
  conclusionReviewer: NodeFn;
  layoutDesigner: NodeFn;
  dashboardReviewer: NodeFn;
  dashboardPreview: NodeFn;
  visualReviewer: NodeFn;
  commitDesign: NodeFn;
  questionPlanner: NodeFn;
  drillInvestigator: NodeFn;
}

/** Shared read-only analysis pipeline. Manual mode starts with supplied parameters. */
export function buildAnalysisGraph(nodes: AnalysisNodes, question = false, runtime: GraphRuntime = {}): Graph {
  const now = () => new Date((runtime.now ?? Date.now)()).toISOString();
  const graph = new Graph(runtime);
  graph
    .addNode("QueryPlanner", nodes.lockedPlanner)
    .addNode("DataExecutor", nodes.dataExecutor)
    .addNode("DataValidator", nodes.dataValidator)
    .addNode("AnalysisAgent", nodes.analysisAgent)
    .addNode("ConclusionReviewer", nodes.conclusionReviewer)
    /* 复核两次没过:不生成看板,但**留着草稿**。
       原来这儿把 analysisSummary / report / insights 全清空,于是跑了几分钟、烧了一堆
       token 之后,界面上只剩一行「结论复核仍未通过」—— 连哪几条结论、依据是什么都看不到。
       而那些 insight 每一条都带 factId、数字是代码算的,本身经得起看;复核挑的是措辞、
       口径交代、因果说得太满这类问题。把复核意见摆在最前面(失败横幅就在结论上方),
       草稿留在下面让人自己判断,比一句「没完成」有用得多。 */
    .addNode("ConclusionRejected", (state) => ({ status: "failed" as const, errors: [...state.errors, { node: "ConclusionReviewer", message: "结论复核仍未通过，未生成看板：" + state.conclusionReview?.issues.join("；"), at: now() }] }))
    .addNode("LayoutDesigner", nodes.layoutDesigner, { maxRetry: 2 })
    .addNode("DashboardReviewer", nodes.dashboardReviewer)
    .addNode("DashboardPreview", nodes.dashboardPreview)
    .addNode("VisualReviewer", nodes.visualReviewer)
    .addNode("DashboardExecutor", nodes.commitDesign)
    .addNode("DesignFailure", (state) => ({ status: "failed" as const, errors: [...state.errors, { node: "LayoutDesigner", message: "设计仍存在无法执行的问题：" + (state.designBindingErrors ?? state.review?.findings.map((f) => f.reason) ?? []).join("；"), at: now() }] }))
    .addNode("GiveUp", (state) => ({
      status: "failed" as const,
      errors: [...state.errors, {
        node: "DataValidator",
        message: "数据检查没有通过，请查看具体问题；可以继续追问，说明希望调整的范围。",
        at: now(),
      }],
    }))
    .setEntry(question ? "QuestionPlanner" : "QueryPlanner");
  if (question) graph.addNode("QuestionPlanner", nodes.questionPlanner).addEdge("QuestionPlanner", "QueryPlanner");
  /* 从大到小的下钻调查:整体看完找异常,一层层钻到根因,再写结论。两种模式都走 ——
     参数是人锁的还是 AI 理解出来的,调查方式都一样。 */
  graph.addNode("DrillInvestigator", nodes.drillInvestigator).addEdge("DrillInvestigator", "AnalysisAgent");

  graph.addEdge("QueryPlanner", "DataExecutor");
  graph.addEdge("DataExecutor", "DataValidator");
  graph.addConditionalEdge("DataValidator", (state) =>
    state.validation?.status === "fail" ? "GiveUp" : "DrillInvestigator");
  graph.addEdge("GiveUp", END);
  graph.addEdge("AnalysisAgent", "ConclusionReviewer");
  graph.addConditionalEdge("ConclusionReviewer", (state) => state.conclusionReview?.verdict === "pass"
    ? state.requirement?.wantsDashboard ? "LayoutDesigner" : END
    : (state.retry.AnalysisAgent ?? 0) < 2 ? "AnalysisAgent" : "ConclusionRejected");
  graph.addEdge("ConclusionRejected", END);
  graph.addConditionalEdge("LayoutDesigner", (state) => state.designBindingErrors?.length ? (state.retry.LayoutDesigner ?? 0) < 2 ? "LayoutDesigner" : "DesignFailure" : "DashboardReviewer");
  graph.addEdge("DesignFailure", END);
  graph.addConditionalEdge("DashboardReviewer", (state) =>
    state.review?.verdict === "pass" ? "DashboardPreview" : (state.retry.LayoutDesigner ?? 0) >= 2 ? "DesignFailure" : "LayoutDesigner");
  graph.addEdge("DashboardPreview", "VisualReviewer");
  graph.addConditionalEdge("VisualReviewer", (state) => {
    const latest = state.designRounds?.[state.designRounds.length - 1];
    if (latest?.status === "pass" || latest?.status === "unavailable" || (state.retry.LayoutDesigner ?? 0) >= 2) return "DashboardExecutor";
    if (latest?.scores && latest.scores.insight < 12 && (state.retry.AnalysisAgent ?? 0) < 2) return "DrillInvestigator";
    return "LayoutDesigner";
  });
  graph.addEdge("DashboardExecutor", END);
  return graph;
}

