// React 的 hook 必须每次渲染都按同样的顺序调用。写在提前 return 之后的话,走那条
// 分支时就少调几个,React 报「Rendered more hooks than during the previous render」
// 并把整块组件换成错误页 —— 白屏,而且只在某个分支下才复现。
//
// 这个项目里已经栽过两次(一次是数据集面板的 useMemo,一次是组件渲染器的),
// 都是改完当场白屏才发现的。没装 eslint,就自己扫一遍 AST。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve('src');
const files = [];
(function walk(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.tsx$/.test(path)) files.push(path);
  }
})(root);

const isHook = (node) =>
  ts.isCallExpression(node)
  && ts.isIdentifier(node.expression)
  && /^use[A-Z]/.test(node.expression.text);

/** 组件函数体里:先出现 return,之后又出现 hook 调用 —— 那就是条件调用。 */
function offendersIn(body, source) {
  const found = [];
  let returnedAt = -1;
  const visitTop = (statements) => {
    for (const statement of statements) {
      // 只看顶层语句:嵌套在 if/for 里的 return 也算提前退出,所以一并记。
      let hasReturn = false;
      const scan = (node) => {
        if (ts.isReturnStatement(node)) hasReturn = true;
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return; // 回调里的不算
        ts.forEachChild(node, scan);
      };
      scan(statement);

      if (returnedAt >= 0) {
        const hooks = [];
        const look = (node) => {
          if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return;
          if (isHook(node)) hooks.push(node.expression.text);
          ts.forEachChild(node, look);
        };
        look(statement);
        for (const name of hooks) {
          found.push({ name, line: source.getLineAndCharacterOfPosition(statement.pos).line + 1 });
        }
      }
      if (hasReturn && returnedAt < 0) returnedAt = statement.pos;
    }
  };
  visitTop(body.statements);
  return found;
}

const problems = [];
for (const file of files) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    const isComponent = (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))
      && node.name && /^[A-Z]/.test(node.name.text) && node.body;
    if (isComponent) {
      for (const hit of offendersIn(node.body, source)) {
        problems.push(`${relative(root, file)}:${hit.line} ${node.name.text} 在提前 return 之后调用了 ${hit.name}()`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

assert.deepEqual(problems, [], `hook 调用顺序会变:\n  ${problems.join('\n  ')}\n把这些 hook 挪到所有 return 之前。`);

// ── zustand 选择器必须返回稳定引用 ──────────────────────────
// 真机:进「分析」直接黑屏。原因是 `useMetrics((s) => s.metrics.filter(...))` ——
// 每次调用都产生一个新数组,zustand 比较出"变了"就重渲染,重渲染又产生新数组,
// 无限循环,React 把整棵树卸掉。tsc 和构建都看不出来,只有跑起来才炸。
// 这里用源码级检查兜住这一类:组件里不许在选择器里现做数组。
// use<Store>((s) => s.<字段>.filter/map/slice/sort/concat(...)
const derivedInSelector = /use[A-Z]\w*\(\s*\(\w+\)\s*=>\s*\w+\.\w+\.(filter|map|slice|sort|concat|flatMap)\s*\(/g;
/* 选择器直接返回新对象/新数组**字面量**。
   注意只认 `=> ({` 和 `=> [` —— `=> {` 是函数体,不是对象字面量,
   useDrag((d) => { … }) 这种回调会被误伤。 */
const literalInSelector = /use[A-Z]\w*\(\s*\(\w+\)\s*=>\s*(\(\s*\{|\[)/g;
const unstable = [];
(function walk(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) { walk(path); continue; }
    if (!/\.tsx?$/.test(path)) continue;
    const text = readFileSync(path, 'utf8');
    for (const m of [...text.matchAll(derivedInSelector), ...text.matchAll(literalInSelector)]) unstable.push(`${relative(root, path)}: ${m[0]}`);
  }
})(root);
assert.deepEqual(unstable, [],
  `选择器里现做数组/对象 = 每次都是新引用 = 无限重渲染 = 黑屏。过滤搬到 useMemo 里:\n  ${unstable.join('\n  ')}`);

console.log(`hook order: ${files.length} 个组件文件,没有条件调用的 hook;store 选择器都返回稳定引用`);
