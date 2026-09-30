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
  const m = createRequire(import.meta.url)(outfile);
  const { fitToViewport } = m;

  /** 摆完之后整块(按限高后的高度)是否都在屏幕里。 */
  const inside = (p, size, vp, m = 8) => {
    const h = p.maxHeight ?? size.height;
    return p.top >= m && p.top + h <= vp.height - m && p.left >= m && p.left + Math.min(size.width, vp.width - 2 * m) <= vp.width - m;
  };

  // ── 真机场景:750 高的表头菜单,在 700 高的屏幕上点在中间 ─────────────
  // 用户要的是「左上角就是鼠标位置」:不翻、不挪,放不下只限高出滚动条。
  {
    const vp = { width: 1280, height: 700 }, size = { width: 280, height: 750 };
    const p = fitToViewport({ x: 400, y: 300 }, size, vp);
    assert.equal(p.left, 400, '左边就是鼠标 x');
    assert.equal(p.top, 300, '顶边就是鼠标 y —— 不许翻上去');
    assert.equal(p.maxHeight, 392, '限高到屏幕底(700 - 8 - 300),剩下的靠滚动');
    assert(inside(p, size, vp), '整块在屏幕里,滚到底能看到最后一项');
    ok('菜单放不下:左上角钉在鼠标处,只限高出滚动条');
  }

  // ── 放得下:原地往下开,不加限高 ────────────────────────────────────────
  {
    const p = fitToViewport({ x: 100, y: 100 }, { width: 200, height: 300 }, { width: 1280, height: 900 });
    assert.deepEqual(p, { left: 100, top: 100 }, '放得下就别动它');
    ok('放得下:原地往下开,不加限高');
  }

  // ── 点在离屏幕底很近的地方:往上挪到刚好能露出一截,不然菜单只剩一两行 ──
  {
    const vp = { width: 1280, height: 800 }, size = { width: 200, height: 300 };
    const p = fitToViewport({ x: 100, y: 760 }, size, vp);
    assert.equal(p.top, 800 - 8 - m.MIN_VISIBLE, '只挪到刚好露出 MIN_VISIBLE');
    assert.equal(p.maxHeight, m.MIN_VISIBLE);
    assert(inside(p, size, vp));
    const roomy = fitToViewport({ x: 100, y: 500 }, size, vp);
    assert.equal(roomy.top, 500, '下面还有 292,够用,不挪');
    ok('离底太近才往上挪,且只挪到刚好够用');
  }

  // ── 横向:右边放不下只往左挪刚好够的距离,不整块翻到左边 ───────────────
  {
    const vp = { width: 1000, height: 800 };
    assert.equal(fitToViewport({ x: 900, y: 10 }, { width: 280, height: 100 }, vp).left, 712, '1000 - 8 - 280');
    assert.equal(fitToViewport({ x: 300, y: 10 }, { width: 280, height: 100 }, vp).left, 300, '放得下就是鼠标 x');
    assert.equal(fitToViewport({ x: 50, y: 10 }, { width: 1200, height: 100 }, vp).left, 8, '比屏幕还宽就贴左边');
    ok('横向:放得下不动,放不下只挪刚好够的距离');
  }

  // ── clamp:流式长高的浮层整块往上挪够用的距离 ─────────────────────────
  {
    const vp = { width: 1280, height: 800 }, size = { width: 356, height: 300 };
    const clamp = fitToViewport({ x: 100, y: 700 }, size, vp, 8, 'clamp');
    assert.equal(clamp.top, 492, '800 - 8 - 300');
    assert.equal(clamp.maxHeight, undefined, '比屏幕矮就不限高');
    assert(inside(clamp, size, vp));
    ok('clamp 模式:整块往上挪够用的距离');
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
                for (const mode of ['anchor', 'clamp']) {
                  const vp = { width: vw, height: vh }, size = { width: w, height: h };
                  const p = fitToViewport({ x: vw * fx, y: vh * fy }, size, vp, 8, mode);
                  assert(inside(p, size, vp), `出屏:屏 ${vw}x${vh} 菜单 ${w}x${h} 点在 (${vw * fx},${vh * fy}) ${mode} → ${JSON.stringify(p)}`);
                  // 锚定模式:鼠标下方还有足够空间,顶边就必须正好是鼠标 y,不许动
                  const y = vh * fy;
                  if (mode === 'anchor' && y >= 8 && vh - 8 - y >= Math.min(h, m.MIN_VISIBLE, vh - 16)) {
                    assert.equal(p.top, y, `下面放得下却挪了位置:屏 ${vw}x${vh} 菜单高 ${h} 点在 y=${y} → top ${p.top}`);
                  }
                  cases += 1;
                }
    ok(`穷举 ${cases} 种组合,菜单整块都在屏幕里`);
  }

  console.log(`viewport fit: ${n} 项通过`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
