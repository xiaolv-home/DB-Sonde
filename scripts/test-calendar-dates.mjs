/* 日期 —— 「本地日历日」和「UTC 锚点日」不能混着用。
 *
 * 这一类错误的特点是**只在每天凌晨那几个小时出现**:东八区 0 点到 8 点之间,
 * UTC 还停在前一天。天亮了自己就好了,谁也复现不出来,只会留下「昨天早上补数
 * 补错了一天」这种说不清的事故。所以这里不靠肉眼 review,靠两件事钉死:
 *   1. 把进程时区锁在东八区、时刻取凌晨,直接验算;
 *   2. 禁止任何地方再手写 `.toISOString().slice(0, 10)` —— 必须从 lib/dates
 *      里挑一个有名字的,让「我要的是哪种日期」写在代码脸上。
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

/* 时区必须在进程启动前定好 —— 进程跑起来之后再改 process.env.TZ,各平台行为不一样。
   所以不是东八区就把自己按东八区重开一遍。凌晨那个窗口正是靠它才测得到。 */
if (process.env.TZ !== 'Asia/Shanghai') {
  const again = spawnSync(process.execPath, [new URL(import.meta.url).pathname],
    { env: { ...process.env, TZ: 'Asia/Shanghai' }, stdio: 'inherit' });
  process.exit(again.status ?? 1);
}

const root = resolve(new URL('..', import.meta.url).pathname);
let passed = 0;
const ok = (name) => { passed++; console.log(`  ✓ ${name}`); };

const dir = mkdtempSync(join(tmpdir(), 'sonde-dates-'));
try {
  const outfile = join(dir, 'dates.cjs');
  await build({
    stdin: { contents: `export * from './src/lib/dates';`, resolveDir: root, loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  });
  const { localDay, localDayOffset, utcDay, localDayIn, isCalendarDay } = createRequire(import.meta.url)(outfile);

  // ── 1. 出事的那个时间窗:北京时间凌晨 2 点,UTC 还在前一天 ──────────────
  {
    const at = new Date('2026-09-18T02:00:00+08:00');
    assert.equal(at.getHours(), 2, '前提:进程时区是东八区');
    assert.equal(at.toISOString().slice(0, 10), '2026-09-17', '前提:此刻的 UTC 日期确实是前一天');

    assert.equal(localDay(at), '2026-09-18', 'localDay 给的是用户日历上的今天');
    assert.equal(localDayOffset(1, at), '2026-09-17', '昨天是 17 号,不是 16 号');
    assert.equal(localDayOffset(7, at), '2026-09-11');

    // 这就是 SchedulerDialogs 原来的写法,留在这儿当对照组。
    const buggy = (n) => { const d = new Date(at); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
    assert.equal(buggy(1), '2026-09-16', '对照组:老写法确实差一天');
    assert.notEqual(localDayOffset(1, at), buggy(1));
    ok('凌晨时段不再差一天(老写法作对照,确实会差)');
  }

  // ── 2. 跨月跨年、往后推 ────────────────────────────────────────────────
  {
    assert.equal(localDayOffset(1, new Date(2026, 0, 1, 12)), '2025-12-31', '跨年');
    assert.equal(localDayOffset(1, new Date(2026, 2, 1, 12)), '2026-02-28', '跨月(平年 2 月)');
    assert.equal(localDayOffset(-1, new Date(2026, 11, 31, 12)), '2027-01-01', '负数往后推');
    assert.equal(localDay(new Date(2026, 8, 5, 23, 59)), '2026-09-05', '当天最后一分钟还是当天');
    ok('跨月/跨年/往后推都对');
  }

  // ── 3. utcDay / localDayIn 的语义 ─────────────────────────────────────
  {
    assert.equal(utcDay(new Date(Date.UTC(2026, 0, 1))), '2026-01-01', 'UTC 造的日期渲染回去是恒等的');
    assert.equal(utcDay(new Date('2026-08-01')), '2026-08-01', '"YYYY-MM-DD" 解析回来也是 UTC 零点');
    assert.equal(localDayIn('Asia/Shanghai', new Date('2026-09-17T16:30:00Z')), '2026-09-18', 'UTC 16:30 已是东八区次日');
    assert.equal(localDayIn('America/New_York', new Date('2026-09-17T16:30:00Z')), '2026-09-17', '同一时刻纽约还是 17 号');
    ok('utcDay / localDayIn 语义正确');
  }

  // ── 4. 不存在的日期 ───────────────────────────────────────────────────
  {
    assert.equal(isCalendarDay('2026-02-31'), false, '形状对但日子不存在 —— Date 会顺延成 3 月 3 日');
    assert.equal(isCalendarDay('2026-13-01'), false);
    assert.equal(isCalendarDay('2026-2-1'), false, '必须补零');
    assert.equal(isCalendarDay('2026-02-28'), true);
    assert.equal(isCalendarDay('2024-02-29'), true, '闰年 2/29 是真日子');
    assert.equal(isCalendarDay('2026-02-29'), false, '平年就不是');
    ok('isCalendarDay 认得出不存在的日期');
  }
} finally { rmSync(dir, { recursive: true, force: true }); }

// ── 5. 守卫:别处不许再手写这个转换 ──────────────────────────────────────
{
  const files = [];
  (function walk(d) {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|js)$/.test(name)) files.push(full);
    }
  })(join(root, 'src'));

  const allowed = join(root, 'src/lib/dates.ts');
  const offenders = [];
  for (const file of files) {
    if (file === allowed) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      // 注释里提这个写法是允许的(说明文档要引用它),只管真代码。
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      if (/toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/.test(code)) offenders.push(`${file.slice(root.length + 1)}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [],
    '这些地方在手写日期转换,必须改用 lib/dates 的 localDay / utcDay / localDayIn ——\n  ' +
    '手写的分不出「用户日历上的今天」和「UTC 锚点」,凌晨会差一天:\n    ' + offenders.join('\n    '));
  ok(`${files.length} 个源文件里没有手写的 toISOString().slice(0,10)`);
}

// ── 6. 出过事的那几处确实换掉了 ────────────────────────────────────────
{
  const check = (rel, must, why) => assert.ok(must.test(readFileSync(join(root, rel), 'utf8')), `${rel}:${why}`);
  check('src/features/agent/state.ts', /today: input\.today \?\? localDay\(\)/, '分析工作流的「今天」要按本地日历');
  check('src/features/agent/analysisSession.ts', /today: \(\) => localDay\(\)/, '同上');
  check('src/features/agent/tools/dataTools.ts', /today: \(\) => localDay\(\)/, '同上');
  ok('出过事的几处都换成了 localDay');
}

console.log(`\n日期守卫:${passed} 项通过`);
