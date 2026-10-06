// 链路画布的数据模型:存得下就读得回、坏数据不认、复制和「从血缘添加」的行为。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'sonde-canvas-'));
let n = 0;
const ok = (name) => { n += 1; console.log(`  ✓ ${name}`); };
try {
  const outfile = join(dir, 't.cjs');
  await build({ entryPoints: [resolve('src/features/lineage/canvas/canvasModel.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
  const m = createRequire(import.meta.url)(outfile);

  // ── 每种形状新建出来都是合法节点,整张画布 JSON 往返后仍合法 ──────────
  {
    const doc = m.newCanvas('测试');
    for (const [i, shape] of m.SHAPES.entries()) doc.nodes.push(m.newNode(shape, i * 200, 0));
    doc.edges.push(m.newEdge(doc.nodes[0].id, doc.nodes[1].id, { label: '写入', arrow: 'both', dashed: true, flow: true, line: 'step' }));
    for (const node of doc.nodes) assert(m.isCanvasNode(node), `新建的 ${node.shape} 不合法`);
    const round = JSON.parse(JSON.stringify([doc]));
    assert(m.isCanvasList(round), '存下去的画布读回来不认');
    assert.deepEqual(round[0], doc);
    ok(`${m.SHAPES.length} 种形状 + 连线,存下去读得回`);
  }

  // ── 坏数据不认:悬空连线、重复 id、未知形状/颜色、负尺寸 ───────────────
  {
    const doc = m.newCanvas('坏');
    const a = m.newNode('rect', 0, 0), b = m.newNode('rect', 200, 0);
    doc.nodes.push(a, b);
    doc.edges.push(m.newEdge(a.id, b.id));
    assert(m.isCanvasDoc(doc));
    assert(!m.isCanvasDoc({ ...doc, edges: [m.newEdge(a.id, 'nope')] }), '连到不存在节点的线必须拒绝');
    assert(!m.isCanvasDoc({ ...doc, nodes: [a, { ...b, id: a.id }], edges: [] }), '节点 id 重复必须拒绝');
    assert(!m.isCanvasDoc({ ...doc, nodes: [{ ...a, shape: 'star' }, b] }), '未知形状必须拒绝');
    assert(!m.isCanvasDoc({ ...doc, nodes: [{ ...a, color: 'pink' }, b] }), '未知颜色必须拒绝');
    assert(!m.isCanvasDoc({ ...doc, nodes: [{ ...a, w: 0 }, b] }), '宽度为 0 必须拒绝');
    assert(!m.isCanvasList([doc, doc]), '两张画布 id 重复必须拒绝');
    ok('悬空连线 / 重复 id / 未知形状颜色 / 零尺寸都不认');
  }

  // ── 复制:只带走选中的节点和它们之间的线,id 全换新,位置偏移 ───────────
  {
    const a = m.newNode('rect', 0, 0), b = m.newNode('rect', 200, 0), c = m.newNode('rect', 400, 0);
    const ab = m.newEdge(a.id, b.id), bc = m.newEdge(b.id, c.id);
    const out = m.duplicate([a, b, c], [ab, bc], new Set([a.id, b.id]));
    assert.equal(out.nodes.length, 2);
    assert.equal(out.edges.length, 1, '只复制两头都选中的那条线');
    const ids = new Set(out.nodes.map((x) => x.id));
    assert(!ids.has(a.id) && !ids.has(b.id), '复制品要用新 id');
    assert(ids.has(out.edges[0].from) && ids.has(out.edges[0].to), '复制的线要连到复制品上');
    assert.equal(out.nodes[0].x, a.x + 32);
    ok('复制选中的形状:新 id、连线跟着复制品、整体错开');
  }

  // ── 从血缘添加:连同上下游、从左到右排、已在画布上的不重复加 ───────────
  {
    const g = {
      nodes: [
        { id: 'ods.a', label: 'ods.a', kind: 'table' },
        { id: 'ods.b', label: 'ods.b', kind: 'table' },
        { id: 'dws.c', label: 'dws.c', kind: 'table' },
        { id: 'metric:gmv', label: 'GMV', kind: 'metric' },
      ],
      edges: [],
      up: new Map([['dws.c', [{ from: 'ods.a', to: 'dws.c', kind: '写入' }, { from: 'ods.b', to: 'dws.c', kind: '写入' }]]]),
      down: new Map([['dws.c', [{ from: 'dws.c', to: 'metric:gmv', kind: '用于' }]]]),
    };
    const one = m.fromLineage(g, 'dws.c', { x: 0, y: 0 }, [], false);
    assert.equal(one.nodes.length, 1);
    assert.equal(one.nodes[0].ref, 'dws.c');
    assert.equal(one.nodes[0].shape, 'cylinder', '表画成数据表形状');

    const all = m.fromLineage(g, 'dws.c', { x: 0, y: 0 }, [], true);
    assert.equal(all.nodes.length, 4, '自己 + 2 个上游 + 1 个下游');
    assert.equal(all.edges.length, 3);
    const pos = Object.fromEntries(all.nodes.map((x) => [x.ref, x]));
    assert(pos['ods.a'].x < pos['dws.c'].x && pos['metric:gmv'].x > pos['dws.c'].x, '上游在左、下游在右');
    assert.equal(pos['metric:gmv'].shape, 'rounded');
    assert.equal(all.edges[0].label, '写入', '连线带上血缘里的关系');

    const again = m.fromLineage(g, 'dws.c', { x: 0, y: 0 }, all.nodes, true);
    assert.equal(again.nodes.length, 0, '都已经在画布上,不重复加');
    const placedIds = new Set(all.nodes.map((x) => x.id));
    assert(again.edges.every((e) => placedIds.has(e.from) && placedIds.has(e.to)), '连线连到已有的那几个');
    assert.equal(m.fromLineage(g, 'nope', { x: 0, y: 0 }, [], true).nodes.length, 0);
    ok('从血缘添加:连同上下游从左到右排好,已有的不重复加');
  }

  // ── 点形状连着加:一个挨一个排开,不叠在一起 ──────────────────────────
  {
    const placed = [];
    const overlap = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
    for (let i = 0; i < 20; i += 1) {
      const shape = m.SHAPES[i % (m.SHAPES.length - 1)]; // 不含分组框
      const size = m.SHAPE_SIZE[shape];
      const spot = m.findFreeSpot(placed, size.w, size.h, { x: 400, y: 300 });
      const node = { ...m.newNode(shape, spot.x, spot.y) };
      for (const other of placed) assert(!overlap(node, other), `第 ${i + 1} 个形状压住了别的形状`);
      placed.push(node);
    }
    const first = m.findFreeSpot([], 160, 56, { x: 400, y: 300 });
    assert.deepEqual(first, { x: 320, y: 272 }, '空画布上第一个放在正中间');
    const group = m.newNode('group', 0, 0, { x: 100, y: 100, w: 800, h: 600 });
    assert.deepEqual(m.findFreeSpot([group], 160, 56, { x: 400, y: 300 }), first, '分组框不算障碍,形状可以放进框里');
    ok('连着点 20 个形状,一个都不重叠;分组框里可以放东西');
  }

  // ── 自动起名不重名 ────────────────────────────────────────────────────
  {
    assert.equal(m.nextName([]), '未命名画布');
    assert.equal(m.nextName(['未命名画布', '未命名画布 2']), '未命名画布 3');
    assert.equal(m.nextName(['链路 副本'], '链路 副本'), '链路 副本 2');
    ok('新建 / 复制自动起名不重名');
  }

  // ── 「有没有改动」只看内容 ─────────────────────────────────────────────
  {
    const a = m.newNode('rect', 0, 0);
    const k1 = m.contentKey({ name: '', nodes: [a], edges: [] });
    assert.equal(k1, m.contentKey({ name: '', nodes: [{ ...a }], edges: [] }));
    assert.notEqual(k1, m.contentKey({ name: '', nodes: [{ ...a, x: 8 }], edges: [] }), '挪了位置就算改动');
    ok('改动判断:内容一样就是没改,挪一下就算改');
  }

  console.log(`lineage canvas: ${n} 项通过`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
