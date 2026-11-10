/** Production composition: each run owns catalog, query plans and cached rows. */
import { nanoid } from 'nanoid';
import { useMetrics } from '../metrics/metricsStore';
import { useApp } from '../../store/appStore';
import { useAi } from '../ai/aiStore';
import { createQuerySession, readQuery } from '../dashboard/query';
import { createDataToolRuntime } from './tools/dataToolRuntime';
import { createToolRegistry } from './tools/toolRegistry';
import { callTool as sharedCallTool } from './tools/registry';
import { fastDimensionValues } from './tools/dimensionProbe';
import { discardDraft } from './tools/dashboardTools';
import { callStructured, providerFor, bindingFor } from './model/structured';
import { record, recordTool } from './audit';
import { createState } from './state';
import { catalogDimensionLabel, validatedMetricsFor } from './analysisCatalog';
import { createDataNodes } from './nodes/dataNodes';
import { createAnalysisNode } from './nodes/analysisNode';
import { createLayoutDesigner } from './nodes/layoutDesigner';
import { createDashboardReviewer } from './nodes/dashboardReviewer';
import { createDashboardCompiler } from './nodes/dashboardCompiler';
import { createQuestionPlanner } from './questionPlanning';
import { createConclusionReviewer } from './evidenceExploration';
import { createDrillInvestigator } from './drillInvestigator';
import { createPreviewNode, visualReviewer, createCommitDesign, clearDesignSession } from './designLoop';
import { createAnalysisWorkflow } from './analysisWorkflow';
import type { ToolCaller } from './nodes/ports';
import type { NodeFn } from './graph';
import { localDay } from "../../lib/dates";

export function createAnalysisSession(signal?: AbortSignal, connId?: string) {
  const catalog = structuredClone(useMetrics.getState().metrics);
  const connections = useApp.getState().connections.map(({ id, kind }) => ({ id, kind }));
  const readCatalog = () => structuredClone(catalog);
  const dialectFor = (id: string) => connections.find(c => c.id === id)?.kind;
  const query = createQuerySession(readCatalog, dialectFor);
  const lifetime = new AbortController();
  const dimensionValues: typeof fastDimensionValues = (dataset, field, limit, search, snapshot = catalog) => {
    lifetime.signal.throwIfAborted();
    return fastDimensionValues(dataset, field, limit, search, snapshot, {
      dialectFor,
      readQuery: async (id, db, sql, rows, filters, timeout) => {
        const result = await readQuery(id, db, sql, rows, filters, timeout, lifetime.signal);
        lifetime.signal.throwIfAborted();
        return result;
      }
    });
  };
  const data = createDataToolRuntime({
    readCatalog, nextId: () => `plan-${nanoid(8)}`,
    today: () => localDay(), executeDataset: query.executeDataset, fastDimensionValues: dimensionValues
  });
  const registry = createToolRegistry({ recordTool });
  data.tools.forEach(tool => registry.registerTool(tool));
  // Dashboard editing still resolves references from the live catalog. Do not publish
  // a document against changed definitions while its evidence belongs to the snapshot.
  const assertCatalog = () => {
    lifetime.signal.throwIfAborted();
    if (JSON.stringify(useMetrics.getState().metrics) !== JSON.stringify(catalog)) {
      throw new Error('分析期间指标定义已修改，请按新定义重新分析后生成看板。');
    }
  };
  const callTool: ToolCaller = (name, input, workflowId) => {
    lifetime.signal.throwIfAborted();
    if (registry.getTool(name)) return registry.callTool(name, input, workflowId);
    assertCatalog();
    return sharedCallTool(name, input, workflowId);
  };
  const getPlan = data.getPlan;
  const dimensionLabel = (key: string) => catalogDimensionLabel(connId ? catalog.filter(m => m.connId === connId) : catalog, key);
  const ports = { readCatalog, callStructured, callTool, getPlan };
  const compiler = createDashboardCompiler({
    callTool, getPlan, discardDraft,
    describeModel: config => `${providerFor('design', config)} · ${bindingFor('design', config).model}`
  });
  const guard = (node: NodeFn): NodeFn => (state, context) => { assertCatalog(); return node(state, context); };
  const nodes = {
    ...createDataNodes({ callTool, getPlan, dimensionLabel }),
    analysisAgent: createAnalysisNode({ callStructured, getPlan, dimensionLabel }),
    layoutDesigner: guard(createLayoutDesigner({ callStructured, getPlan }).layoutDesigner),
    dashboardReviewer: createDashboardReviewer({ callStructured, getPlan }),
    questionPlanner: createQuestionPlanner({ readCatalog, callStructured, dimensionValues }),
    drillInvestigator: createDrillInvestigator(ports), conclusionReviewer: createConclusionReviewer(ports),
    dashboardPreview: createPreviewNode(async (doc, state, abort) => {
      assertCatalog();
      const { renderDashboardPreview } = await import('./renderPreview');
      const preview = await renderDashboardPreview(doc, state, abort, { readCatalog, callTool, getPlan });
      assertCatalog();
      return preview;
    }, compiler.compileDashboard),
    visualReviewer: guard(visualReviewer), commitDesign: guard(createCommitDesign(callTool)),
  };
  const workflow = createAnalysisWorkflow({
    nodes, graph: { record }, createState,
    modelConfig: () => useAi.getState().config, validatedMetrics: ids => validatedMetricsFor(ids, catalog),
    prepare: () => lifetime.signal.throwIfAborted(), clearDesignSession
  });
  function dispose() { signal?.removeEventListener('abort', dispose); lifetime.abort(); data.dispose(); query.dispose(); }
  signal?.addEventListener('abort', dispose, { once: true });
  if (signal?.aborted) dispose();
  return { ...workflow, dispose };
}
