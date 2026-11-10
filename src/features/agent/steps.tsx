import { useEffect, useState } from "react";
import { subscribe as subscribeAudit } from "./audit";
import type { AgentState } from "./state";

/**
 * 执行时间线的显示逻辑 —— 从 AgentPanel 里搬出来的。
 *
 * 自然语言那条路(AI 面板的「分析」页签)整个删掉了,但这几个函数和它无关:
 * 「哪一步走到了 / 走成什么样 / 那一步拿到了什么」是任何编排都要显示的东西。
 * stepState / stepDetail 是纯函数,能直接断言测 —— 塞在组件里就只能硬凑一次渲染去测。
 * Elapsed / NowDoing 是两个小组件:一步跑一分钟不是问题,**看不出它在跑**才是问题。
 * 参数锁死之后查询反而更长(维度是人选的,不再被程序砍),这两个更要有。
 */

export const NODE_LABELS: Record<string, string> = {
  QuestionPlanner: "理解问题",
  QueryPlanner: "生成查询",
  DataExecutor: "取数",
  DataValidator: "数据体检",
  DrillInvestigator: "逐层下钻找原因",
  AnalysisAgent: "形成结论",
  ConclusionReviewer: "证据复核",
  LayoutDesigner: "设计版面",
  DashboardReviewer: "版面检查",
  DashboardPreview: "渲染成品",
  VisualReviewer: "成品验收",
  DashboardExecutor: "保存看板",
};
export const NODE_ORDER = Object.keys(NODE_LABELS);
/** 每一步的状态:走过 / 正在走 / 还没到。导出是为了能直接测 —— 面板的
 *  state 在 useState 里,硬凑一个组件渲染去测这段逻辑不如直接测函数。 */
/**
 * 正在跑的那一步显示「已等 N 秒」。
 *
 * 一步跑一分钟不是问题 —— **看不出它在跑**才是问题。云模型一次 30~60 秒很正常,
 * 没有秒表的话,静止的转圈图标和真死循环长得一模一样,人只能猜。
 */
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  const secs = Math.max(0, Math.round((now - since) / 1000));
  if (secs < 2) return null;
  return <span className="agent-step-elapsed">已等 {secs < 60 ? `${secs} 秒` : `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`}</span>;
}

/**
 * 正在跑的那一步在等什么 —— 订审计流水,显示最近一次工具/模型调用。
 *
 * 「生成查询」那一步真机上能等好几分钟:它要挨个探维度取值,每探一次都是一整条
 * 对事实表的聚合查询。只显示一个转圈,用户只能判断成"卡死了"。
 * 有了这行就变成「正在 get_dimension_values(store)」—— 慢,但看得见在慢什么。
 */
export function NowDoing() {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    // 订阅只在这一步活动期间存在,不会攒住历史
    return subscribeAudit((e) => {
      if (e.kind === "node") return; // 节点自己的开始/结束由步骤条表达了
      setText(`${e.name}${e.ok ? "" : " 失败"}`);
    });
  }, []);
  if (!text) return null;
  return <span className="agent-step-doing">正在 {text}</span>;
}

export function stepState(node: string, state: AgentState | null): "done" | "active" | "todo" | "failed" | "cancelled" {
  if (!state) return "todo";
  /* 只按 status 判会出大错:第一版里 status==="done" 就给所有步骤画绿勾,
     于是体检明明判了 fail、分析根本没跑,界面上却是一排绿勾加一片空白 ——
     看着像成功了。所以「跑没跑过」只认 trace,「成没成」另算。 */
  const ran = state.trace.includes(node);
  if (!ran) return "todo";
  if (state.status === "cancelled" && state.currentNode === node) return "cancelled";
  // 失败停在哪一步,那一步就是红的
  if (state.status === "failed" && (state.currentNode === node || failedAt(state) === node)) return "failed";
  // 体检判 fail 的那一步,即使流程还往下走过也要标红
  if (node === "DataValidator" && state.validation?.status === "fail") return "failed";
  if (state.status === "running" && state.currentNode === node) return "active";
  return "done";
}

/** 错误记在哪个节点上。 */
function failedAt(state: AgentState): string | undefined {
  return state.errors[state.errors.length - 1]?.node;
}

/** 每一步跑完留下的一句话 —— 比进度条有用得多。 */
/** 每一步跑完留下的一句话 —— 比进度条有用得多。 */
export function stepDetail(node: string, state: AgentState | null): string | null {
  if (!state) return null;
  switch (node) {
    case "QueryPlanner":
      return state.plans?.map((p) => `${p.role === "primary" ? "主查询" : p.role === "mom" ? "环比" : "同比"}`).join(" + ") ?? null;
    case "DataExecutor": {
      if (!state.datasets) return null;
      const rows = Object.values(state.datasets).reduce((a, d) => a + d.rowCount, 0);
      return `共 ${rows.toLocaleString()} 行`;
    }
    case "DataValidator":
      return state.validation?.summary ?? null;
    case "AnalysisAgent":
      return state.insights?.length ? `${state.insights.length} 条结论` : null;
    case "LayoutDesigner":
      return state.layout ? `${state.layout.title} · ${state.layout.items.length} 个组件` : null;
    case "DashboardReviewer":
      return state.review?.summary ?? null;
    case "DashboardExecutor":
      return state.dashboardId ? "已保存为草稿" : null;
    default:
      return null;
  }
}
