import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const directory = mkdtempSync(join(tmpdir(), 'sonde-analysis-'));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
try {
  const bundle = join(directory, 'tests.cjs');
  buildSync({ stdin: { contents: `export * from './src/features/agent/analysisRepository';
    export * from './src/features/agent/analysisRuntime'; export * from './src/features/agent/analysisWorkflow';
    export * from './src/features/agent/analysisDraft'; export * from './src/features/agent/analysisGraph';
    export * from './src/features/agent/graph'; export * from './src/features/agent/state';
    export * from './src/features/ai/aiConfigModel'; export * from './src/lib/jsonStorage';`, resolveDir: resolve('.'), loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
  const records = new Map(); let failRead = false, failWrite = false, writes = 0;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => { if (failRead) throw Error('denied'); return records.get(key) ?? null; },
    setItem: (key, value) => { if (failWrite) throw Error('quota'); writes++; records.set(key, value); },
  } });
  const m = createRequire(import.meta.url)(bundle);
  const now = () => new Date('2026-09-15T10:00:00Z');
  const key = 'sonde.analysis.v1', migrationKey = 'sonde.analysis.flash-default.v1';
  const repo = m.createAnalysisRepository({ now });
  const defaultDraft = m.blankAnalysisDraft(now());
  assert.equal(repo.load().end, '2026-09-14');
  assert.equal(writes, 0, 'opening the app does not write a migration');
  records.set(key, JSON.stringify({ question: 'inventory', modelChoice: { provider: 'cloud', model: 'deepseek-v4-pro' }, filterValues: { region: ['east'] } }));
  const original = records.get(key);
  const economical = repo.load();
  assert.equal(economical.modelChoice.model, 'deepseek-flash');
  assert.deepEqual(economical.filterValues, { region: ['east'] });
  assert.equal(records.get(key), original);
  assert.equal(writes, 0);
  records.set(migrationKey, '1');
  assert.equal(repo.load().modelChoice.model, 'deepseek-v4-pro', 'completed legacy migration respects an explicit choice');
  records.delete(migrationKey);
  const migrated = repo.load();
  failWrite = true;
  assert.throws(() => repo.save(migrated));
  assert.equal(records.get(key), original); assert.equal(records.has(migrationKey), false);
  failWrite = false;
  repo.save({ ...migrated, modelChoice: { provider: 'local', model: 'explicit-local' } });
  assert.equal(writes, 1, 'draft and migration marker commit in a single write');
  assert.equal(JSON.parse(records.get(key)).modelChoiceMigration, 1);
  assert.equal(records.has(migrationKey), false);
  assert.equal(repo.load().modelChoice.model, 'explicit-local');
  // A broken legacy marker cannot blank a readable draft or authorize overwriting it.
  records.set(key, original); records.set(migrationKey, 'corrupt');
  assert.equal(repo.load().question, 'inventory');
  assert.throws(() => repo.save(defaultDraft));
  assert.equal(records.get(key), original);
  records.set(migrationKey, '1'); repo.load(); repo.save(defaultDraft);
  for (const raw of ['{bad', 'null', '[]', JSON.stringify({ futureVersion: 2 }), JSON.stringify({ modelChoiceMigration: 2 }),
    JSON.stringify({ metricIds: ['ok', 3] }), JSON.stringify({ dimensions: 'region' }), JSON.stringify({ filterValues: { region: 'east' } }),
    JSON.stringify({ mode: 'future' }), JSON.stringify({ grain: 'future' }), JSON.stringify({ wantsDashboard: 'false' }),
    JSON.stringify({ modelChoice: { provider: 'future', model: 'x' } }), JSON.stringify({ start: 123 })]) {
    records.set(key, raw); repo.load();
    assert.throws(() => repo.save(defaultDraft));
    assert.equal(records.get(key), raw);
  }
  records.set(key, JSON.stringify(defaultDraft)); repo.load();
  assert(!m.getStorageProblems().some(problem => problem.key === key));
  failRead = true; repo.load(); failRead = false;
  assert.throws(() => repo.save(defaultDraft));
  repo.load();

  const config = { ...m.defaultAiConfig(), provider: 'local', local: { baseUrl: 'https://fixture.invalid', model: 'fixture-model' } };
  const metric = { id: 'sales', name: 'Sales', enabled: true, connId: 'source', database: 'warehouse', dimensions: ['day', 'region'] };
  const released = [], calls = [];
  const fakeWorkflow = {
    runQuestionAnalysis: (question, options) => { const wait = deferred(); calls.push({ question, options, ...wait }); return wait.promise; },
    runLockedAnalysis: (params, options) => { const wait = deferred(); calls.push({ params, options, ...wait }); return wait.promise; },
  };
  /* 直接提问时连接按**指标目录**定,不按传进来的那个 —— 真机上分析 tab 会把
     "点「分析」时恰好在看的那个连接"永久焊死,指标一个没少却全被过滤掉。
     所以 a / b 也得是真有指标的连接,下面"换连接就不复用上一次运行"那几条才测得成立:
     目录里有多个候选时解析器不替用户挑,原样用传进来的。 */
  const onA = { ...metric, id: 'sales-a', connId: 'a' }, onB = { ...metric, id: 'sales-b', connId: 'b' };
  const port = { repository: repo, now, metrics: () => [metric, onA, onB], modelConfig: () => config,
    createState: m.createState, workflow: fakeWorkflow, releaseRun: id => released.push(id) };
  const store = m.createAnalysisStore(port);
  repo.reset();
  assert.deepEqual(JSON.parse(records.get(key)), { modelChoiceMigration: 1 });
  const tomorrow = m.createAnalysisRepository({ now: () => new Date('2026-09-16T10:00:00Z') });
  assert.equal(tomorrow.load().end, '2026-09-15', 'reset does not freeze relative default dates across launches');
  const before = store.getState().draft;
  const oldRun = { ...m.createState({ userRequest: 'old', connId: 'source' }), status: 'done', dashboardId: 'saved-board' };
  store.setState({ run: oldRun });
  failWrite = true;
  assert.equal(store.getState().patch({ question: 'new' }), false);
  assert.strictEqual(store.getState().draft, before);
  assert.equal(store.getState().reset(), false);
  assert.strictEqual(store.getState().run, oldRun);
  assert.equal(released.length, 0);
  assert(store.getState().storageError);
  failWrite = false;
  assert.equal(store.getState().patch({ question: 'question', wantsDashboard: false }), true);
  assert.equal(store.getState().storageError, null);
  const first = store.getState().start('a');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.previous, undefined, 'foreign connection results cannot seed a follow-up');
  config.local.model = 'changed-during-run';
  assert.equal(calls[0].options.modelConfig.local.model, 'fixture-model');
  assert.equal(store.getState().patch({ question: 'ignored' }), false);
  assert.equal(store.getState().reset(), false);
  await store.getState().start('b'); assert.equal(calls.length, 1);
  const progress = { ...m.createState({ userRequest: 'question', connId: 'a' }), locked: false, currentNode: 'DataExecutor' };
  calls[0].options.onStep(progress);
  store.getState().stop();
  assert.equal(store.getState().running, true); assert.equal(store.getState().stopping, true);
  calls[0].options.onStep({ ...progress, currentNode: 'must-not-publish' });
  assert.equal(store.getState().run.currentNode, 'DataExecutor');
  calls[0].resolve({ ...progress, status: 'done', dashboardId: 'committed-before-stop' }); await first;
  assert.equal(store.getState().run.status, 'cancelled');
  assert.equal(store.getState().run.dashboardId, 'committed-before-stop');
  assert.equal(store.getState().running, false);
  // Completed callbacks cannot mutate the current run even before another run starts.
  calls[0].options.onStep({ ...progress, report: 'late' });
  assert.equal(store.getState().run.report, undefined);
  const second = store.getState().start('a', 'follow up');
  assert.equal(calls[1].options.previous.connId, 'a');
  assert.equal(calls[1].question, 'follow up');
  calls[1].resolve({ ...m.createState({ userRequest: 'follow up', connId: 'a' }), status: 'done', locked: false }); await second;
  const third = store.getState().start('b', 'another');
  assert.equal(calls[2].options.previous, undefined);
  calls[2].reject(Error('fixture failure')); await third;
  assert.equal(store.getState().run.status, 'failed'); assert.equal(store.getState().run.connId, 'b');
  assert.equal(store.getState().run.userRequest, 'another');
  // Manual mode records the selected metric's actual connection, not the current navigation tab.
  store.getState().patch({ mode: 'manual', metricIds: ['sales'], grain: 'day', dimensions: ['region'] });
  const fourth = store.getState().start('navigation-connection');
  assert.equal(calls[3].options.connId, 'source');
  assert.deepEqual(calls[3].params.dimensions, ['day', 'region']);
  store.getState().dispose();
  calls[3].options.onStep(progress); calls[3].resolve({ ...progress, status: 'done' }); await fourth;
  assert.notEqual(store.getState().run?.status, 'done');
  assert(released.includes(progress.workflowId));
  await store.getState().start('a'); assert.equal(calls.length, 4);
  assert.equal(JSON.parse(records.get(key)).run, undefined);

  // Graph structure errors are rejected before running nodes; cancellation is checked at every dispatch boundary.
  let dispatched = 0;
  const bad = new m.Graph().addNode('a', () => { dispatched++; return {}; }).setEntry('a').addEdge('a', 'missing');
  await assert.rejects(bad.run(m.createState({ userRequest: 'bad' })), /目标/); assert.equal(dispatched, 0);
  const valid = new m.Graph().addNode('a', () => { dispatched++; return {}; }).setEntry('a').addEdge('a', m.END);
  await assert.rejects(valid.run(m.createState({ userRequest: 'bad' }), { maxSteps: NaN }));
  const controller = new AbortController();
  const stopped = await valid.run(m.createState({ userRequest: 'stop' }), { signal: controller.signal, onStep: () => controller.abort() });
  assert.equal(stopped.status, 'cancelled'); assert.equal(dispatched, 0);
  const checkpointStop = new AbortController();
  const checkpoint = await valid.run(m.createState({ userRequest: 'checkpoint' }), { signal: checkpointStop.signal, onCheckpoint: () => checkpointStop.abort() });
  assert.equal(checkpoint.status, 'cancelled'); assert.equal(dispatched, 1);
  const audit = [];
  await new m.Graph({ now: () => 100, record: event => audit.push(event) }).addNode('a', () => ({})).setEntry('a').addEdge('a', m.END).run(m.createState({ userRequest: 'audit' }));
  assert.equal(audit.length, 1); assert.equal(audit[0].ms, 0);
  const ids = Array.from({ length: 100 }, () => m.createState({ userRequest: 'parallel' }).workflowId);
  assert.equal(new Set(ids).size, 100);

  // Real routing, injected nodes: quality gates retain their behavior without network/model dependencies.
  const nodes = Object.fromEntries(['lockedPlanner','dataExecutor','dataValidator','analysisAgent','conclusionReviewer','layoutDesigner','dashboardReviewer','dashboardPreview','visualReviewer','commitDesign','questionPlanner','drillInvestigator'].map(name => [name, () => ({})]));
  nodes.dataValidator = () => ({ validation: { status: 'pass', issues: [], summary: '' } });
  nodes.analysisAgent = () => ({ report: 'fixture report' });
  nodes.conclusionReviewer = () => ({ conclusionReview: { verdict: 'pass', issues: [] } });
  nodes.dashboardReviewer = () => ({ review: { verdict: 'pass', findings: [], summary: '' } });
  nodes.visualReviewer = () => ({ designRounds: [{ round: 1, status: 'pass', observations: [], issues: [], model: 'fixture' }] });
  nodes.commitDesign = () => ({ dashboardId: 'fixture-board' });
  const cleanups = [], prepared = [];
  const service = m.createAnalysisWorkflow({ nodes, createState: m.createState, modelConfig: () => config,
    validatedMetrics: () => [], prepare: connection => prepared.push(connection), clearDesignSession: id => cleanups.push(id) });
  const noBoard = await service.runQuestionAnalysis('question', { connId: 'a', wantsDashboard: false });
  assert.equal(noBoard.status, 'done'); assert(!noBoard.trace.includes('LayoutDesigner')); assert(noBoard.trace.includes('DrillInvestigator'));
  const board = await service.runQuestionAnalysis('question', { connId: 'a', wantsDashboard: true });
  assert.equal(board.dashboardId, 'fixture-board'); assert.equal(cleanups.length, 0);
  const params = { metricIds: [], dimensions: ['month'], dateRange: { start: '2026-08-01', end: '2026-08-31' }, comparisons: [], filters: [], focus: '', wantsDashboard: false };
  const manual = await service.runLockedAnalysis(params, { connId: 'a' });
  assert.equal(manual.status, 'done'); assert(!manual.trace.includes('QuestionPlanner')); assert(manual.trace.includes('DrillInvestigator'), 'Locked parameters are investigated top-down too');
  const cross = await service.runQuestionAnalysis('question', { connId: 'b', wantsDashboard: false, previous: noBoard });
  assert.deepEqual(cross.conversation, []);
  const unknown = await service.runQuestionAnalysis('question', { wantsDashboard: false, previous: { ...noBoard, connId: undefined } });
  assert.deepEqual(unknown.conversation, [], 'missing connection identity never authorizes reusing prior evidence');
  const same = await service.runQuestionAnalysis('follow up', { connId: 'a', wantsDashboard: false, previous: noBoard });
  assert.equal(same.conversation[0].content, 'question');
  nodes.conclusionReviewer = () => ({ conclusionReview: { verdict: 'revise', issues: ['insufficient evidence'] } });
  const rejected = await service.runQuestionAnalysis('question', { connId: 'a', wantsDashboard: true });
  assert.equal(rejected.status, 'failed'); assert(!rejected.trace.includes('LayoutDesigner'));
  assert.equal(rejected.trace.filter(name => name === 'AnalysisAgent').length, 3);
  assert(cleanups.includes(rejected.workflowId));
  nodes.dataValidator = () => ({ validation: { status: 'fail', issues: [{ level: 'fail', message: 'invalid data' }], summary: '' } });
  const invalid = await service.runQuestionAnalysis('question', { connId: 'a' });
  assert.equal(invalid.status, 'failed'); assert(!invalid.trace.includes('AnalysisAgent'));
  // Unexpected step/checkpoint failures clean only their own workflow's transient designs.
  await assert.rejects(service.runQuestionAnalysis('question', { connId: 'a', onStep: () => { throw Error('observer failure'); } }), /observer failure/);
  assert.equal(cleanups.length, 3);
  const aborted = new AbortController(); aborted.abort(); const beforePrepare = prepared.length;
  await assert.rejects(service.runQuestionAnalysis('question', { connId: 'a', signal: aborted.signal }));
  assert.equal(prepared.length, beforePrepare);
  assert.equal(cleanups.length, 4);
  console.log('Analysis boundaries passed: non-destructive draft restoration/migration, write/reset failure, immutable run config, source-scoped follow-up, stop/dispose ownership, injectable graph routing/audit, quality gates and scoped cleanup. No real queries or inference.');
} finally { rmSync(directory, { recursive: true, force: true }); }
