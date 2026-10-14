/* npm run check 的总入口。
 *
 * 以前是 60 个 `npm run test:x && ...` 串起来:前面一个挂了后面全不跑,只看得到第一个错。
 * 现在:package.json 里所有 test:* 脚本(除了 OPT_IN 里要额外环境的)+ eslint + tsc 并行跑完,
 * 最后一次列出哪些挂了、各自的输出。新加的 test:* 脚本自动进来,不会再漏挂。
 *
 *   npm run check                 全部
 *   npm run check -- canvas sql   只跑名字里带 canvas / sql 的
 *   npm run check -- --serial     一个一个跑(查并行互相干扰时用)
 */
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { readFileSync } from 'node:fs';

/** 要额外环境才能跑的(要编 Rust、连库……),只能单独 npm run */
const OPT_IN = new Set(['test:postgres']);

const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
const tasks = [
  // 最慢的两个先开跑
  { name: 'tsc', cmd: 'npx', args: ['tsc', '--noEmit'] },
  { name: 'lint', cmd: 'npx', args: ['eslint', '.'] },
  ...Object.entries(scripts)
    .filter(([key]) => key.startsWith('test:') && !OPT_IN.has(key))
    .map(([key, line]) => {
      const m = /^node (scripts\/\S+\.mjs)$/.exec(line);
      if (!m) throw new Error(`${key} 不是「node scripts/xxx.mjs」的形式,run-checks 不认识:${line}`);
      return { name: key.slice('test:'.length), cmd: process.execPath, args: [m[1]] };
    }),
];

const argv = process.argv.slice(2);
const serial = argv.includes('--serial');
const filters = argv.filter((a) => !a.startsWith('--'));
const picked = filters.length ? tasks.filter((t) => filters.some((f) => t.name.includes(f))) : tasks;
if (!picked.length) { console.error(`没有名字里带 ${filters.join(' / ')} 的检查`); process.exit(2); }

const color = process.stdout.isTTY ? (code, s) => `\x1b[${code}m${s}\x1b[0m` : (_c, s) => s;
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

function run(task) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(task.cmd, task.args, { env: { ...process.env, FORCE_COLOR: '0' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { out += String(e); });
    child.on('close', (code, signal) => {
      const result = { ...task, ok: code === 0, code: code ?? signal, out, ms: Date.now() - started };
      console.log(`${result.ok ? color(32, '✓') : color(31, '✗')} ${task.name} ${color(2, secs(result.ms))}`);
      resolve(result);
    });
  });
}

const started = Date.now();
const limit = serial ? 1 : Math.max(2, availableParallelism() - 1);
const queue = [...picked];
const results = [];
await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
  while (queue.length) results.push(await run(queue.shift()));
}));

const failed = results.filter((r) => !r.ok);
for (const r of failed) {
  console.log(`\n${color(31, `━━ ✗ ${r.name}`)} (退出码 ${r.code})`);
  console.log(r.out.trimEnd() || '(没有输出)');
}
const summary = `${results.length - failed.length}/${results.length} 通过,用时 ${secs(Date.now() - started)}`;
if (failed.length) {
  console.log(`\n${color(31, `${failed.length} 项没过:${failed.map((r) => r.name).join('、')}`)} · ${summary}`);
  process.exit(1);
}
console.log(`\n${color(32, '全部通过')} · ${summary}`);
