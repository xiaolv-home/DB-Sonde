// 右键菜单 / 浮层的摆位。真机:表头菜单带上「剪贴板」「自定义」两组后
// 将近 750px,屏幕矮一点底下几项就看不到 —— 原来按"菜单高 600"去猜,
// 而且 top 不是 0 时 max-height: 100vh 也兜不住,滚动区域本身出了屏。
// 这里守的是一件事:**不管屏幕多大,菜单整块都在屏幕里**。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'sonde-fit-'));
let n = 0;
const ok = (name) => { n += 1; console.log(`  ✓ ${name}`); };
try {
  const outfile = join(dir, 't.cjs');
  await build({ entryPoints: [resolve('src/lib/fitToViewport.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
  const { fitToViewport } = createRequire(import.meta.url)(outfile);

  /** 摆完之后整块(按限高后的高度)是否都在屏幕里。 */
  const inside = (p, size, vp, m = 8) => {
    const h = p.maxHeight ?? size.height;
    return p.top >= m && p.top + h <= vp.height - m && p.left >= m && p.left + Math.min(size.width, vp.width - 2 * m) <= vp.width - m;
  };

  // ── 真机场景:750 高的表头菜单,在 700 高的屏幕上点在中间 ─────────────
  {
    const vp = { width: 1280, height: 700 }, size = { width: 280, height: 750 };
    const p = fitToViewport({ x: 400, y: 300 }, size, vp);
    assert.equal(p.maxHeight, 684, '比屏幕还高就限高(屏幕高 - 上下边距)');
    assert.equal(p.top, 8, '限高后从顶上开始,整块都在屏幕里');
    assert(inside(p, size, vp), '底下几项必须看得见');
    ok('菜单比屏幕还高:贴顶、限高、可滚动,整块在屏幕里');
  }

  // ── 下面放得下:从点击处往下开 ────────────────────────────────────────
  {
    const p = fitToViewport({ x: 100, y: 100 }, { width: 200, height: 300 }, { width: 1280, height: 900 });
    assert.deepEqual(p, { left: 100, top: 100 }, '放得下就别动它');
    ok('放得下:原地往下开,不加限高');
  }

  // ── 靠近底部:往上翻 ──────────────────────────────────────────────────
  {
    const vp = { width: 1280, height: 800 }, size = { width: 200, height: 300 };
    const p = fitToViewport({ x: 100, y: 700 }, size, vp);
    assert.equal(p.top, 400, '下面只剩 100,上面够 → 翻到点击处上方');
    assert(inside(p, size, vp));
    ok('靠近底部:翻到点击处上方');
  }

  // ── 上下都放不下,但比屏幕矮:贴底 ─────────────────────────────────────
  {
    const vp = { width: 1280, height: 600 }, size = { width: 200, height: 500 };
    const p = fitToViewport({ x: 100, y: 300 }, size, vp);
    assert.equal(p.top, 92, '600 - 8 - 500');
    assert.equal(p.maxHeight, undefined, '没比屏幕高就不限高');
    assert(inside(p, size, vp));
    ok('上下都放不下:贴底,不限高');
  }

  // ── 横向:靠右往左开,太宽就贴边 ───────────────────────────────────────
  {
    const vp = { width: 1000, height: 800 };
    assert.equal(fitToViewport({ x: 900, y: 10 }, { width: 280, height: 100 }, vp).left, 620, '靠右 → 往左开');
    const wide = fitToViewport({ x: 50, y: 10 }, { width: 1200, height: 100 }, vp);
    assert.equal(wide.left, 8, '比屏幕还宽就贴左边');
    ok('横向:靠右往左开,太宽贴边');
  }

  // ── clamp:流式长高的浮层只挪够用的距离,不整块翻上去 ────────────────
  {
    const vp = { width: 1280, height: 800 }, size = { width: 356, height: 300 };
    const flip = fitToViewport({ x: 100, y: 700 }, size, vp, 8, 'flip');
    const clamp = fitToViewport({ x: 100, y: 700 }, size, vp, 8, 'clamp');
    assert.equal(flip.top, 400);
    assert.equal(clamp.top, 492, '只往上挪到刚好放下 —— 800 - 8 - 300');
    assert(inside(clamp, size, vp));
    ok('clamp 模式:只往上挪够用的距离');
  }

  // ── 穷举:任何点击位置、任何尺寸、任何屏幕,整块都在屏幕里 ──────────
  {
    let cases = 0;
    for (const vh of [320, 500, 700, 900, 1400])
      for (const vw of [360, 800, 1280, 1920])
        for (const h of [40, 300, 750, 2000])
          for (const w of [180, 280, 600])
            for (const fy of [0, 0.3, 0.6, 0.95, 1])
              for (const fx of [0, 0.5, 1])
                for (const mode of ['flip', 'clamp']) {
                  const vp = { width: vw, height: vh }, size = { width: w, height: h };
                  const p = fitToViewport({ x: vw * fx, y: vh * fy }, size, vp, 8, mode);
                  assert(inside(p, size, vp), `出屏:屏 ${vw}x${vh} 菜单 ${w}x${h} 点在 (${vw * fx},${vh * fy}) ${mode} → ${JSON.stringify(p)}`);
                  cases += 1;
                }
    ok(`穷举 ${cases} 种组合,菜单整块都在屏幕里`);
  }

  console.log(`viewport fit: ${n} 项通过`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
