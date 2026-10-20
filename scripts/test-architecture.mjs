import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { buildSync } from 'esbuild';

const root = resolve('src');
const files = [];
function walk(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.tsx?$/.test(path) && !path.endsWith('.d.ts')) files.push(path);
  }
}
walk(root);

/* 源文件里不能出现裸控制字符。分隔符用的是 SOH / NUL,直接把那个字节敲进字符串也能跑,
   可整个文件对 grep 和 ripgrep 就变成了二进制 —— 搜索静默跳过它,谁也不知道。
   这事真发生过:四个文件这么写着,之前几轮全仓扫描把它们整个漏了。写成 \u0001 一样用。 */
for (const file of [...files, join(root, 'features/dashboard/export/standalone.runtime.js')]) {
  const bytes = readFileSync(file);
  const at = bytes.findIndex((b) => b < 9 || (b > 13 && b < 32));
  assert(at < 0, `${relative(root, file)} 第 ${at} 字节是裸控制字符(0x${bytes[at]?.toString(16)}),写成转义 \\u00xx —— 否则这个文件搜不着`);
}
const graph = new Map();
const options = ts.readConfigFile('tsconfig.json', ts.sys.readFile).config.compilerOptions;
for (const file of files) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const edges = [];
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
    const named = clause?.namedBindings;
    const typeOnly = ts.isImportDeclaration(node)
      ? clause?.isTypeOnly || (clause && !clause.name && named && ts.isNamedImports(named) && named.elements.every(e => e.isTypeOnly))
      : node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every(e => e.isTypeOnly));
    if (typeOnly) continue;
    const imported = ts.resolveModuleName(node.moduleSpecifier.text, file, { ...options, moduleResolution: ts.ModuleResolutionKind.Bundler }, ts.sys).resolvedModule?.resolvedFileName;
    if (imported?.startsWith(root) && !imported.includes('node_modules')) edges.push(imported);
  }
  graph.set(file, edges);
}
const done = new Set();
function visit(file, path = []) {
  assert(!path.includes(file), `Runtime import cycle: ${[...path, file].map(f => relative(root, f)).join(' -> ')}`);
  if (done.has(file)) return;
  for (const next of graph.get(file) ?? []) visit(next, [...path, file]);
  done.add(file);
}
for (const file of files) visit(file);
for (const [file, imports] of graph) {
  if (file.startsWith(join(root, 'store') + '/')) {
    assert(!imports.some(path => path.includes('/features/') || path.includes('/components/')), `${relative(root, file)} imports an optional feature`);
  }
}
for (const module of ['lib/queryGate.ts', 'features/dashboard/queryRuntime.ts', 'features/dashboard/datasetSql.ts', 'features/agent/tools/dataToolRuntime.ts', 'features/agent/tools/toolRegistry.ts', 'features/agent/previewData.ts', 'features/agent/model/httpRetry.ts', 'features/agent/questionPlanning.ts', 'features/agent/evidenceExploration.ts', 'features/agent/analysisCatalog.ts', 'features/agent/queryPlanModel.ts', 'features/agent/designUnits.ts', 'features/agent/factCalculator.ts', 'features/agent/nodes/dataNodes.ts', 'features/agent/nodes/layoutDesigner.ts', 'features/agent/nodes/analysisNode.ts', 'features/agent/nodes/dashboardReviewer.ts', 'features/agent/nodes/dashboardCompiler.ts', 'features/agent/nodes/observations.ts', 'features/agent/analysisDraft.ts', 'features/agent/analysisRuntime.ts', 'features/agent/analysisWorkflow.ts', 'features/agent/analysisGraph.ts', 'features/agent/graph.ts', 'features/ai/aiConfigModel.ts', 'features/ai/aiRuntime.ts', 'features/ai/modelDiscovery.ts', 'features/agent/model/modelRouting.ts', 'features/agent/model/analysisModels.ts', 'lib/requestScope.ts', 'lib/queryResultView.ts', 'lib/queryExecution.ts', 'features/metrics/catalogModel.ts', 'features/ai/providers/requestPolicy.ts']) {
  const dependencies = new Set();
  function collect(file) { for (const next of graph.get(file) ?? []) if (!dependencies.has(next)) { dependencies.add(next); collect(next); } }
  collect(join(root, module));
  assert(![...dependencies].some(file => /Store\.tsx?$|Slice\.tsx?$|\/lib\/api\.ts$/.test(file)), `${module} depends on global state or platform API`);
}

// Feature stores delegate persisted records; normalization must not secretly read local preferences.
for (const module of ['features/agent/analysisStore.ts', 'features/agent/analysisRuntime.ts', 'features/ai/aiStore.ts', 'features/ai/aiRuntime.ts']) {
  assert(!/\blocalStorage\b/.test(readFileSync(join(root, module), 'utf8')), `${module} bypasses the persistence boundary`);
}

/* 「切一下面画面就闪一下」:进场动画挂在了一块会被反复重建的容器上。
   六个资产中心以前各渲染一整套外壳(遮罩 + 面板 + 侧栏),于是换一个面 = 整块浮层
   拆掉重建,motion.css 里的 sonde-fade / sonde-slide-left 每次从头播一遍;那条本该
   从上一项滑到下一项的玻璃胶囊也跟着重生,滑动变成了瞬移。
   外壳必须只此一套、跨面存活:带进场动画的那几个 class 只许长在外壳组件里,
   中心那一侧(AssetShell 的 default export)只管把内容投进去。 */
const motionCss = readFileSync(resolve('src/motion.css'), 'utf8');
const shellFile = join(root, 'features/assets/AssetShell.tsx');
const shellText = readFileSync(shellFile, 'utf8');
for (const cls of ['asset-overlay', 'asset-panel']) {
  // 先确认这条守卫守的东西还在 —— 动画要是哪天去掉了,下面那句就成了空转
  assert(new RegExp(`\\.${cls}[^{]*\\{[^}]*animation:`).test(motionCss),
    `motion.css 不再给 .${cls} 加进场动画了,这条守卫该跟着改`);
}
const shellSource = ts.createSourceFile(shellFile, shellText, ts.ScriptTarget.Latest, true);
const perSection = shellSource.statements.find(node => ts.isFunctionDeclaration(node)
  && node.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword));
assert(perSection, 'AssetShell.tsx 没有 default export');
for (const cls of ['asset-overlay', 'asset-panel', 'asset-rail']) {
  assert(!perSection.getText().includes(cls),
    `AssetShell 的 default export 又把 .${cls} 画出来了 —— 那是每个中心各渲染一次的,`
    + '外壳会跟着每次切面重建,进场动画又要闪、胶囊又要瞬移');
  const elsewhere = files.filter(file => file !== shellFile && readFileSync(file, 'utf8').includes(cls));
  assert.equal(elsewhere.length, 0, `.${cls} 还出现在 ${elsewhere.map(f => relative(root, f)).join(', ')} —— 外壳只此一套`);
}
const chromeHosts = files.filter(file => readFileSync(file, 'utf8').includes('<AssetChromeHost'));
assert.equal(chromeHosts.length, 1, `外壳该只挂一处,现在有 ${chromeHosts.length} 处`);

const dir = mkdtempSync(join(tmpdir(), 'sonde-architecture-'));
try {
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, [
    'features/metrics/catalogModel.ts',
    'lib/sql.ts', 'lib/databaseDialect.ts', 'lib/jsonStorage.ts', 'features/ai/providers/requestPolicy.ts',
    'features/ai/aiStore.ts', 'features/ai/aiClient.ts',
  ].map(path => `export * from ${JSON.stringify(join(root, path))};`).join('\n'));
  const output = join(dir, 'test.cjs');
  buildSync({ entryPoints: [entry], outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const storage = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
  } });
  const m = createRequire(import.meta.url)(output);
  const first = { id: 'a', catalogId: 'catalog-a', connId: 'old', name: 'A' };
  const second = { id: 'b', catalogId: 'catalog-b', connId: 'keep', name: 'B' };
  const rebound = m.bindCatalogMetrics([first, second], 'catalog-a', 'new', 'New connection', 1);
  assert.equal(rebound[0].connId, 'new');
  assert.strictEqual(rebound[1], second);
  assert.equal(first.connId, 'old');
  assert.throws(() => m.mergeCatalogMetrics([first], [{ ...first, catalogId: 'foreign' }], 'replace'), /其他目录/);
  assert.equal(m.mergeCatalogMetrics([{ ...first, catalogId: undefined }], [first], 'replace')[0].id, 'a');
  /* 覆盖导入要换口径、但**不能把连接绑定冲掉**。目录文件是可移植的,里面 connId 本来
     就是空的(换台机器、换个库都能用同一份口径),而「这个目录连哪个库」是本地绑的。
     真机上踩过:重新导入一次,131 个指标全变成未绑定 —— 口径更新了却什么都查不了,
     而且界面上只显示「0 张底表」,看不出是这么回事。 */
  const bound = { ...first, connId: 'conn-1', connName: '生产库', scale: 100 };
  const portable = { ...first, connId: '', connName: '', scale: 1 };
  const merged = m.mergeCatalogMetrics([bound], [portable], 'replace')[0];
  assert.equal(merged.scale, 1, '口径换成导入的那份');
  assert.equal(merged.connId, 'conn-1', '连接绑定留在本地');
  assert.equal(merged.connName, '生产库');
  // 导入的那份自己指定了连接就听它的
  assert.equal(m.mergeCatalogMetrics([bound], [{ ...portable, connId: 'conn-2', connName: '测试库' }], 'replace')[0].connId, 'conn-2');
  assert.equal(m.qualifiedTable('oracle', 'service', 'OWNER', 'TABLE'), '"OWNER"."TABLE"');
  assert.equal(m.qualifiedTable('clickhouse', 'analytics', undefined, 'events'), '"analytics"."events"');
  assert(m.selectPreview('oracle', undefined, 'HR', 'EMP', 20).endsWith('FETCH FIRST 20 ROWS ONLY;'));
  assert.throws(() => m.paginationClause('mysql', -1), /整数/);
  assert(m.buildColumnUpdate('mysql', 'db', '', 't', 'col', "a\\'b").includes("CONVERT(X'"));
  assert(m.buildRowInsert('postgres', '', 'public', 't', ['col'], ["a\\b"]).includes("E'a\\\\b'"));
  assert.equal(m.DATABASE_CAPABILITIES.oracle.manualTransactions, false);
  assert.equal(m.sqlLiteral(true, 'postgres'), 'TRUE');

  storage.set('broken', '{bad');
  assert.deepEqual(m.readStoredJson('broken', [], Array.isArray), []);
  assert.throws(() => m.writeStoredJson('broken', []), /阻止覆盖/);
  assert.equal(storage.get('broken'), '{bad');
  storage.set('broken', '[]');
  m.readStoredJson('broken', [], Array.isArray);
  m.writeStoredJson('broken', [1]);
  assert.equal(storage.get('broken'), '[1]');
  const warnings = [];
  const unsubscribe = m.onStorageProblem(text => warnings.push(text));
  const save = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error('quota'); };
  assert.throws(() => m.writeStoredJson('quota', []), /保存失败/);
  assert.equal(warnings.length, 1);
  globalThis.localStorage.setItem = save;
  unsubscribe();

  assert.equal(m.useAi.getState().config.provider, 'builtin');
  assert.equal(m.useAi.getState().config.local.model, '');
  let tokens = 0;
  await new Promise((resolve, reject) => m.streamChat(m.useAi.getState().config, [], {
    onToken: () => tokens++, onDone: () => reject(new Error('Unconfigured AI must not produce output')), onError: resolve,
  }));
  assert.equal(tokens, 0);
  const body = { model: 'deepseek-v4-pro', temperature: 0.3, max_tokens: 1000 };
  const pro = m.structuredRequestPolicy('cloud', body.model, body, 120000);
  assert.equal(pro.timeoutMs, 300000);
  assert.equal(pro.body.thinking.type, 'enabled');
  assert.equal(body.temperature, 0.3);
  const other = m.structuredRequestPolicy('cloud', 'independent-model', body, 15000);
  assert.equal(other.body.thinking, undefined);
  assert.equal(other.timeoutMs, 15000);
/* 组件类型清单只能有一份。以前 "kpi","line","bar",... 这串在 4 个文件里各写一遍
   (domain / layoutDesigner 两处 / dashboardTools / DashboardCanvas),加一种类型
   漏掉任何一处都**不报错** —— 表现是 AI 生成了但渲染不出来,或者画布能建但
   AI 不知道有这个类型。这条守卫盯着那串字面量别再长出来。 */
{
  const dup = files.filter((f) => !f.endsWith('domain.ts')
    && /["']kpi["']\s*,\s*["']line["']\s*,\s*["']bar["']/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(dup, [],
    `组件类型清单只能在 dashboard/domain.ts 定义(WIDGET_TYPES),这些文件又抄了一份:${dup.join(', ')}`);
}

  console.log(`Architecture checks passed: ${files.length} modules, no runtime import cycles; core boundaries, catalog isolation, dialects, persistence, unconfigured AI and provider policies.`);
} finally { rmSync(dir, { recursive: true, force: true }); }
