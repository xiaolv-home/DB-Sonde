// 链路画布的数据模型:存得下就读得回、坏数据不认、复制和「从血缘添加」的行为。
import assert from 'node:assert/strict';
import { build, buildSync } from 'esbuild';
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
  const exportFile = join(dir, 'x.cjs');
  await build({ entryPoints: [resolve('src/features/lineage/canvas/canvasExport.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: exportFile, logLevel: 'silent' });
  const x = createRequire(import.meta.url)(exportFile);

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
    assert(!m.isCanvasDoc({ ...doc, nodes: [{ ...a, color: 'magenta' }, b] }), '未知颜色必须拒绝');
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


  // ── 新样式字段:不写也认(老存档),写了就得是认识的值 ───────────────────
  {
    const a = m.newNode('rect', 0, 0), b = m.newNode('rect', 200, 0);
    assert(m.isCanvasNode({ ...a, fill: 'solid', dashed: true, z: 3, color: 'indigo' }));
    assert(!m.isCanvasNode({ ...a, fill: 'glass' }), '未知填充必须拒绝');
    assert(!m.isCanvasNode({ ...a, z: Infinity }), '叠放次序必须是有限数');
    const e = m.newEdge(a.id, b.id, { width: 3, line: 'sharp' });
    assert(m.isCanvasEdge(e));
    assert(!m.isCanvasEdge({ ...e, width: 5 }), '没有第 5 档线宽');
    for (const c of ['gray', 'blue', 'green', 'yellow', 'orange', 'red', 'purple', 'teal'])
      assert(m.COLORS.includes(c), `老颜色 ${c} 必须还认`);
    assert.equal(new Set(m.PALETTE_ORDER).size, m.COLORS.length, '色板上每种颜色正好一个');
    ok('填充 / 虚线框 / 叠放 / 线宽 / 直角折线:老存档照认,坏值不认');
  }

  // ── 对齐与等距 ─────────────────────────────────────────────────────────
  {
    const boxes = [{ id: 'a', x: 0, y: 0, w: 100, h: 40 }, { id: 'b', x: 150, y: 30, w: 60, h: 20 }, { id: 'c', x: 400, y: 100, w: 80, h: 60 }];
    const left = m.alignBoxes(boxes, 'left');
    assert([...left.values()].every((p) => p.x === 0), '左对齐到最左边');
    const right = m.alignBoxes(boxes, 'right');
    assert.equal(right.get('b').x, 480 - 60, '右对齐:右边线对齐外框右边');
    const mid = m.alignBoxes(boxes, 'vmiddle');
    assert.equal(mid.get('a').y + 20, mid.get('c').y + 30, '垂直居中:中线一样');
    const d = m.distributeBoxes(boxes, 'h');
    assert.equal(d.get('a').x, 0); assert.equal(d.get('c').x, 400, '两头不动');
    const gap1 = d.get('b').x - 100, gap2 = 400 - (d.get('b').x + 60);
    assert(Math.abs(gap1 - gap2) <= 1, `中间的空隙要一样:${gap1} / ${gap2}`);
    assert.equal(m.distributeBoxes(boxes.slice(0, 2), 'h').size, 0, '不到 3 个不分布');
    ok('六种对齐 + 横纵等距');
  }

  // ── 按分层上色 ─────────────────────────────────────────────────────────
  {
    assert.equal(m.layerColor('ods'), 'gray');
    assert.equal(m.layerColor('dwd堂食'), 'blue');
    assert.equal(m.layerColor('DWS_会员'), 'green');
    assert.equal(m.layerColor('ads_dim_stores维表'), 'orange', '看最前面那层');
    assert.equal(m.layerColor('dim产品维表'), 'purple');
    assert.equal(m.layerColor('adsense'), null, 'ads 后面紧跟字母的不是分层前缀');
    assert.equal(m.layerColor('平台映射表'), null);
    ok('按 ods / dim / dwd / dws / ads 前缀认分层');
  }

  // ── 自动排版:分层、方向、不重叠、没连线的不动、有环也排得出 ─────────────
  {
    const mk = (id, x, y, shape = 'rounded') => ({ ...m.newNode(shape, x, y), id });
    const ns = [mk('ods', 500, 900), mk('gate', 100, 100, 'diamond'), mk('dwd1', 0, 0), mk('dwd2', 300, 0), mk('dws', 700, 300), mk('ads', 50, 50), mk('note', 2000, 2000, 'note'), mk('grp', -100, -100, 'group')];
    const es = [['ods', 'gate'], ['gate', 'dwd1'], ['gate', 'dwd2'], ['dwd1', 'dws'], ['dwd2', 'dws'], ['dws', 'ads'], ['ads', 'gate']]
      .map(([f, t], i) => ({ ...m.newEdge(f, t), id: `e${i}` }));
    for (const dir of m.LAYOUT_DIRS) {
      const { positions, handles } = m.autoLayout(ns, es, dir);
      assert(!positions.has('note') && !positions.has('grp'), '没连线的、分组框不动');
      const box = (id) => ({ ...ns.find((n) => n.id === id), ...positions.get(id) });
      const ids = [...positions.keys()];
      for (const i of ids) for (const j of ids) if (i < j) {
        const a = box(i), b = box(j);
        assert(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${dir}: ${i} 和 ${j} 叠在一起了`);
      }
      const c = (id) => dir === 'LR' ? box(id).x : -box(id).y * (dir === 'BT' ? 1 : -1);
      assert(c('ods') < c('gate') && c('gate') < c('dwd1') && c('dwd1') < c('dws') && c('dws') < c('ads'), `${dir}: 上游 → 下游的顺序不对`);
      assert.equal(box('dwd1').y === box('dwd2').y || box('dwd1').x === box('dwd2').x, true, `${dir}: 同一层的要排在一行/一列`);
      const h = handles.get('e0');
      assert.deepEqual(h, dir === 'BT' ? { fromHandle: 'top', toHandle: 'bottom' } : dir === 'TB' ? { fromHandle: 'bottom', toHandle: 'top' } : { fromHandle: 'right', toHandle: 'left' }, `${dir}: 连接点要朝向对方`);
      assert([...positions.values()].every((p) => p.x % 8 === 0 && p.y % 8 === 0), '排完对齐 8px 网格');
    }
    // 数仓分层:gate 直接连到 dws_b,dws_b 也要和别的 dws 同一行,不能掉到 dwd 那一行
    const t = (id, text) => ({ ...mk(id, 0, 0), text });
    const tn = [t('o', 'ods'), t('g', '门禁'), t('d1', 'dwd_a'), t('d2', 'dwd_b'), t('s1', 'dws_a'), t('s2', 'dws_b'), t('a1', 'ads_a'), t('a2', 'ads_b')];
    const te = [['o', 'g'], ['g', 'd1'], ['g', 'd2'], ['d1', 's1'], ['d2', 's1'], ['g', 's2'], ['s1', 'a1'], ['s2', 'a2']].map(([f, to], i) => ({ ...m.newEdge(f, to), id: `t${i}` }));
    const tl = m.autoLayout(tn, te, 'BT').positions;
    assert.equal(tl.get('s1').y, tl.get('s2').y, 'dws 同一行');
    assert.equal(tl.get('a1').y, tl.get('a2').y, 'ads 同一行');
    assert(tl.get('d1').y > tl.get('s2').y, 'dws 在 dwd 上面');
    const rowsY = [...new Set([...tl.values()].map((p) => p.y))].sort((p, q) => p - q);
    const steps = rowsY.slice(1).map((y, i) => y - rowsY[i]);
    assert(Math.max(...steps) <= 48 + 96 + 8, `行与行之间不能空出整行:${steps.join(',')}`);
    // 同一层前缀之间有线时不强求同一行(否则排不出来)
    const chain = [t('x', 'dws_1'), t('y', 'dws_2')];
    const cl = m.autoLayout(chain, [{ ...m.newEdge('x', 'y'), id: 'c' }], 'TB').positions;
    assert(cl.get('y').y > cl.get('x').y, '同前缀互相连着时照常上下排');
    const lone = m.autoLayout([mk('a', 0, 0), mk('b', 0, 0)], [], 'TB');
    assert.equal(lone.positions.size, 0, '没有连线就不排');
    ok('自动排版:三个方向都按上下游分层、不重叠、有环不死循环、没连线的不动');
  }

  // ── 拖动吸附 ───────────────────────────────────────────────────────────
  {
    const other = { x: 100, y: 100, w: 100, h: 50 };
    const r = m.snapToGuides({ x: 104, y: 300, w: 100, h: 50 }, [other], 6);
    assert.equal(r.x, 100, '左边差 4px 就吸过去');
    assert.equal(r.y, 300, '竖直方向离得远不吸');
    assert.equal(r.guides.length, 1); assert.equal(r.guides[0].axis, 'x');
    const c = m.snapToGuides({ x: 128, y: 98, w: 40, h: 40 }, [other], 6);
    assert.equal(c.x + 20, 150, '中线对中线');
    assert.equal(c.y, 100, '顶边对顶边');
    assert.equal(m.snapToGuides({ x: 120, y: 300, w: 100, h: 50 }, [other], 6).guides.length, 0, '超过阈值不吸');
    ok('拖动吸附:边对边、中线对中线,超过阈值不吸');
  }

  // ── 导出 SVG ──────────────────────────────────────────────────────────
  {
    const measure = (t, size) => t.length * size * 0.6;
    const a = { ...m.newNode('cylinder', 0, 0), text: 'ods & <raw>' };
    const b = { ...m.newNode('diamond', 0, 200), text: '这里一个门禁 py 脚本负责映射、自动修复、拦截、异常处理等各种事宜', fill: 'solid', color: 'indigo' };
    const g = { ...m.newNode('group', -50, -50), w: 400, h: 400 };
    const e1 = { ...m.newEdge(a.id, b.id, { fromHandle: 'bottom', toHandle: 'top', label: '写入', arrow: 'both', width: 3 }) };
    const e2 = { ...m.newEdge(b.id, a.id, { line: 'sharp', dashed: true }) };
    const out = x.canvasToSvg([a, b, g], [e1, e2], measure);
    assert(out && out.width > 0 && out.height > 0);
    assert(out.svg.includes('ods &amp; &lt;raw&gt;'), '文字要转义');
    assert(!/&(?!amp;|lt;|gt;|quot;)/.test(out.svg), '不能有没转义的 &');
    assert.equal((out.svg.match(/<path d="M[^"]*" fill="none" stroke="#/g) ?? []).length - 1, 2, '两条线都画出来(另一条是数据表的上沿)');
    assert(out.svg.includes('marker-start'), '双向箭头');
    assert(out.svg.includes('stroke-dasharray="6 4"'), '虚线');
    assert(out.svg.indexOf('rx="10"') < out.svg.indexOf('<polygon'), '分组框垫在最底下');
    assert(out.svg.includes('fill="#ffffff" text-anchor="middle"'), '实色底用白字');
    assert.equal(x.canvasToSvg([], [], measure), null);
    const lines = x.wrapText('ads_store_operation_day 每天的门店运营', 120, 14, false, measure);
    assert(lines.length > 1 && lines.every((l) => measure(l, 14) <= 120 || !l.includes(' ')), '折行后每行不超宽');
    assert.equal(x.wrapText('第一行\n第二行', 500, 14, false, measure).length, 2, '原文换行保留');
    assert.equal(x.mixWhite('#000000', 0.5), '#808080');
    ok('导出 SVG:文字转义、线 / 箭头 / 虚线 / 叠放 / 实色白字都对,长文字折行');
  }

  // ── 流动效果 ───────────────────────────────────────────────────────────
  {
    const a = m.newNode('rect', 0, 0), b = m.newNode('rect', 300, 0);
    const e = m.newEdge(a.id, b.id, { flow: true });
    assert(m.isCanvasEdge(e), '老的流动线(只有 flow: true)照认');
    for (const flowStyle of m.FLOW_STYLES) assert(m.isCanvasEdge({ ...e, flowStyle, flowSpeed: 3, flowColor: 'cyan' }));
    assert(!m.isCanvasEdge({ ...e, flowStyle: 'laser' }), '未知流动效果必须拒绝');
    assert(!m.isCanvasEdge({ ...e, flowSpeed: 9 }), '没有第 9 档流速');
    assert(!m.isCanvasEdge({ ...e, flowColor: 'gold' }), '未知流动颜色必须拒绝');
    assert(m.travelSeconds(1400, 2) === 2 * m.travelSeconds(700, 2), '线长一倍,跑一趟的时间也一倍(流速一样)');
    assert(m.travelSeconds(700, 3) < m.travelSeconds(700, 1), '快档更快');
    assert.equal(m.travelSeconds(5, 3), 0.6, '再短的线也不至于一闪而过');
    assert.equal(m.dotCount(40), 1); assert.equal(m.dotCount(5000), 6);
    assert.equal(m.cometLength(10), 24); assert.equal(m.cometLength(10000), 90);
    const measure = (t, size) => t.length * size * 0.6;
    const svgOf = (extra) => x.canvasToSvg([a, b], [{ ...e, ...extra }], measure).svg;
    assert(svgOf({}).includes('stroke-dasharray="6 5"'), '虚线流动导出成虚线');
    assert(!svgOf({ flowStyle: 'comet' }).includes('stroke-dasharray'), '彗星导出成实线');
    assert(svgOf({ flowStyle: 'dot', dashed: true }).includes('stroke-dasharray="6 4"'), '光点 + 用户自己设的虚线:导出虚线');
    ok('流动效果:四种样式 / 三档流速 / 单独颜色都认,时长按线长算,导出静态图合理');
  }

  // ── 文字颜色:黑 / 白 / 色板上的颜色,不写 = 自动;画布和导出图片都按它来 ──
  {
    const measure = (t, size) => t.length * size * 0.6;
    const t = { ...m.newNode('text', 0, 0), text: '说明' };
    for (const textColor of ['ink', 'white', 'red', 'cyan']) assert(m.isCanvasNode({ ...t, textColor }), textColor);
    for (const textColor of ['toString', 'constructor', 'gold', '#ff0000', 1]) assert(!m.isCanvasNode({ ...t, textColor }), `${textColor} 不是能存的文字颜色`);
    assert.equal(m.textColorValue('ink'), '#1f2328');
    assert.equal(m.textColorValue('red'), m.COLOR_VALUE.red);
    const fillOf = (node) => x.canvasToSvg([node], [], measure).svg.match(/<text [^>]*fill="([^"]+)"/)[1];
    assert.equal(fillOf(t), '#1f2328', '自动:文字框是深色字');
    assert.equal(fillOf({ ...t, textColor: 'red' }), m.COLOR_VALUE.red, '设了颜色导出就是那个颜色');
    const solid = { ...m.newNode('rect', 0, 0), fill: 'solid' };
    assert.equal(fillOf(solid), '#ffffff', '自动:实色底白字');
    assert.equal(fillOf({ ...solid, textColor: 'ink' }), '#1f2328', '实色底也能改成黑字');
    assert.equal(fillOf({ ...m.newNode('group', 0, 0), textColor: 'white' }), '#ffffff', '分组框的标题也能改');
    ok('文字颜色:黑白 + 色板都认,原型上的名字不认,导出图片按设的颜色画');
  }

  // ── 导出动图:按时间逐帧画流动效果,首尾无缝 ──
  {
    const animFile = join(dir, 'anim.cjs');
    await build({ entryPoints: [resolve('src/features/lineage/canvas/canvasAnimation.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: animFile, logLevel: 'silent' });
    const an = createRequire(import.meta.url)(animFile);
    const loadVideo = () => {
      const videoFile = join(dir, 'video.cjs');
      buildSync({ entryPoints: [resolve('src/features/lineage/canvas/canvasVideo.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: videoFile, logLevel: 'silent' });
      return createRequire(import.meta.url)(videoFile);
    };
    const measure = (t, size) => t.length * size * 0.6;
    // 假的量线工具:只认直线(M x,y L x,y),够测了
    const probe = {
      length: (d) => { const v = d.match(/-?[\d.]+/g).map(Number); return Math.hypot(v[v.length - 2] - v[0], v[v.length - 1] - v[1]); },
      point: (d, at) => {
        const v = d.match(/-?[\d.]+/g).map(Number);
        const [x0, y0, x1, y1] = [v[0], v[1], v[v.length - 2], v[v.length - 1]];
        const k = at / Math.hypot(x1 - x0, y1 - y0);
        return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k };
      },
    };
    const a = m.newNode('rect', 0, 0), b = m.newNode('rect', 600, 0);
    const edge = (extra) => m.newEdge(a.id, b.id, { line: 'straight', fromHandle: 'right', toHandle: 'left', flow: true, ...extra });
    for (const flowStyle of m.FLOW_STYLES) for (const flowSpeed of m.FLOW_SPEEDS) {
      const e = edge({ flowStyle, flowSpeed });
      const out = an.animationFrames([a, b], [e], measure, probe);
      const loop = (out.frames.length * an.FRAME_MS) / 1000;
      assert(loop >= an.LOOP_MIN_S - 0.06 && loop <= an.LOOP_MAX_S + 0.06, `${flowStyle}/${flowSpeed} 循环 ${loop}s 超出范围`);
      const at = (sec) => x.canvasToSvg([a, b], [e], measure, an.flowFxAt(sec, loop, probe)).svg;
      assert.equal(at(loop), at(0), `${flowStyle}/${flowSpeed}:最后接回第一帧要一模一样(首尾无缝)`);
      assert.equal(out.frames[0], at(0));
      assert.notEqual(out.frames[1], out.frames[0], `${flowStyle}/${flowSpeed}:相邻两帧要不一样(真的在动)`);
      const period = an.fitPeriod(an.naturalPeriod(e, 500), loop);
      assert(Math.abs(loop / period - Math.round(loop / period)) < 1e-9, '每根线的周期正好整除循环长度');
    }
    // 几种效果各自画对:虚线往前走、光点从起点出发、呼吸在半圈时最亮
    const dash = x.canvasToSvg([a, b], [edge({})], measure, an.flowFxAt(0.1, 1.2, probe)).svg;
    assert.match(dash, /stroke-dasharray="6 5" stroke-dashoffset="-\d/, '虚线的偏移往负方向走(和画布上一样往终点流)');
    const dot = x.canvasToSvg([a, b], [edge({ flowStyle: 'dot' })], measure, an.flowFxAt(0, 1.2, probe)).svg;
    assert.match(dot, /<circle cx="160\.00" cy="28\.00"/, '第 0 秒第一个光点在线的起点');
    const pulse = (sec) => Number(x.canvasToSvg([a, b], [edge({ flowStyle: 'pulse' })], measure, an.flowFxAt(sec, 1.6, probe)).svg.match(/opacity="([\d.]+)"\/>$/m)[1]);
    assert(pulse(0.8) > pulse(0.2) && pulse(0.8) > pulse(1.4) && pulse(0) === 0, '呼吸:半圈最亮,前后两头暗,开头是灭的');
    assert(x.canvasToSvg([a, b], [edge({ flowColor: 'red' })], measure, an.flowFxAt(0, 1.2, probe)).svg.includes(`stroke="${m.COLOR_VALUE.red}"`), '虚线流动单独设的颜色要带上');
    // 没有流动的线:只有一帧;不流动的线不受影响
    assert.equal(an.animationFrames([a, b], [m.newEdge(a.id, b.id)], measure, probe).frames.length, 1);
    assert.equal(an.animationFrames([], [], measure, probe), null);
    // 几根线快慢不同:循环按最慢的定(不超过上限),快的在里面跑整数圈
    assert.equal(an.loopFrames([0.2, 0.5]), Math.round(an.LOOP_MIN_S * 1000 / an.FRAME_MS), '都很快:用最短循环');
    assert.equal(an.loopFrames([0.2, 0.5], 1000 / 30), Math.round(an.LOOP_MIN_S * 30), '视频 30 帧/秒,帧数按帧间隔算');
    assert.equal(an.loopFrames([30]), Math.round(an.LOOP_MAX_S * 1000 / an.FRAME_MS), '特别慢:截到最长循环');
    assert.equal(an.fitPeriod(5, 2), 2, '周期比循环还长:压成一圈');
    assert.equal(an.exportScale(400, 300, an.GIF_MAX_SIDE), 1.5, '小图放大一点更清楚');
    assert.equal(Math.round(1333 * an.exportScale(1333, 775, an.GIF_MAX_SIDE)), 2000, '动图最长边 2000');
    // 视频按 30 帧/秒生成:帧数比动图多,照样首尾无缝
    const slow = edge({ flowStyle: 'comet' });
    const vf = an.animationFrames([a, b], [slow], measure, probe, 1000 / 30);
    const vloop = vf.frames.length / 30;
    assert(vf.frames.length > an.animationFrames([a, b], [slow], measure, probe).frames.length, '视频帧更密');
    assert.equal(x.canvasToSvg([a, b], [slow], measure, an.flowFxAt(vloop, vloop, probe)).svg, vf.frames[0], '视频的帧也首尾无缝');
    // 视频尺寸和长度:宽高偶数(H.264 的要求)、最长边不超过 1920、至少 10 秒、整圈数
    const vid = loadVideo();
    for (const [w, h] of [[1333, 775], [4001, 999], [301, 151], [900, 2400]]) {
      const p = vid.videoPlan(w, h, 47);
      assert(p.w % 2 === 0 && p.h % 2 === 0, `${w}x${h} → ${p.w}x${p.h} 宽高要是偶数`);
      assert(Math.max(p.w, p.h) <= vid.VIDEO_MAX_SIDE + 1, `${w}x${h} 最长边超了`);
      assert(Math.abs(p.w / p.h - w / h) < 0.02, '宽高比不变');
    }
    const plan = vid.videoPlan(1000, 600, 47);
    assert(plan.total >= vid.VIDEO_MIN_S * vid.VIDEO_FPS && plan.total % 47 === 0, '至少 10 秒,而且是整圈(最后接回第一帧)');
    assert(vid.videoBitrate(1920, 1116) >= 4_000_000 && vid.videoBitrate(10, 10) === 2_000_000, '码率按像素给,有下限');
    // 视频像素转 YUV(BT.709):标的范围和转出来的数必须一致,不然白底播出来发灰
    const px = (rgb, full) => { const a = new Uint8ClampedArray(2 * 2 * 4); for (let i = 0; i < 4; i++) a.set([...rgb, 255], i * 4); return [...vid.rgbaToI420(a, 2, 2, full)]; };
    assert.deepEqual(px([255, 255, 255], false), [235, 235, 235, 235, 128, 128], '有限范围:白 Y=235,不偏色');
    assert.deepEqual(px([0, 0, 0], false), [16, 16, 16, 16, 128, 128], '有限范围:黑 Y=16');
    assert.deepEqual(px([255, 0, 0], false), [63, 63, 63, 63, 102, 240], '有限范围:红按 BT.709 的系数');
    assert.deepEqual(px([255, 255, 255], true), [255, 255, 255, 255, 128, 128], '全范围:白 Y=255');
    assert.deepEqual(px([0, 0, 0], true), [0, 0, 0, 0, 128, 128], '全范围:黑 Y=0');
    assert.equal(px([0, 0, 255], true)[4], 255, '全范围纯蓝的 U 到顶 255,不能进位绕回 0');
    const mixed = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    assert.deepEqual([...vid.rgbaToI420(mixed, 2, 2, false)].slice(0, 4), [235, 16, 16, 235], '亮度逐像素,不糊成平均');
    ok('导出动图 / 视频:四种效果 × 三档流速首尾无缝、逐帧在动,循环长度、尺寸、时长合理');
  }

  // ── 纯数据 <-> React Flow 画布对象:存盘、撤销都靠它换回来,字段一个都不能丢 ──
  {
    const flowFile = join(dir, 'f.cjs');
    await build({ entryPoints: [resolve('src/features/lineage/canvas/canvasFlow.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: flowFile, logLevel: 'silent' });
    const f = createRequire(import.meta.url)(flowFile);
    const node = m.newNode('cylinder', 10, 20, { w: 150, h: 70, text: 'ods.raw', color: 'teal', fontSize: 15, bold: true, textColor: 'yellow', fill: 'solid', dashed: true, z: 3, ref: 'shop.ods_raw' });
    const fn = f.toFlowNode(node);
    assert.deepEqual(f.fromFlowNode(fn), node, '每个字段都要原样换回来(漏一个,存盘后就悄悄没了)');
    assert.equal(fn.zIndex, 3);
    assert.equal(f.toFlowNode(m.newNode('group', 0, 0)).zIndex, -1000, '分组框垫在最底下,不挡住框里的东西');
    const moved = f.fromFlowNode({ ...fn, position: { x: 33.6, y: -4.4 }, width: 200.4, height: undefined, measured: { width: 1, height: 81.7 } });
    assert.deepEqual([moved.x, moved.y, moved.w, moved.h], [34, -4, 200, 82], '拖动 / 改大小后取整;没有显式高度就用量出来的');
    assert.deepEqual(f.boxOf(fn), { id: node.id, x: 10, y: 20, w: 150, h: 70 });

    const a = m.newNode('rect', 0, 0), b = m.newNode('rect', 300, 0), c = m.newNode('rect', 600, 0);
    const edge = m.newEdge(a.id, b.id, { fromHandle: 'right', toHandle: 'left', label: '写入', color: 'orange', line: 'step', arrow: 'both',
      dashed: true, flow: true, width: 3, flowStyle: 'comet', flowSpeed: 3, flowColor: 'cyan' });
    const fe = f.toFlowEdge(edge);
    assert.deepEqual(f.fromFlowEdge(fe), edge, '连线的每个字段也要原样换回来');
    assert.equal(fe.type, 'flowfx', '流动的线走自己的画法');
    assert(fe.markerStart && fe.markerEnd, '双向箭头两头都有');
    const plain = f.toFlowEdge(m.newEdge(a.id, b.id, { arrow: 'none', line: 'sharp' }));
    assert.equal(plain.type, 'step');
    assert.equal(plain.markerEnd, undefined, '没箭头就不画箭头');
    assert(f.toFlowEdge(edge, true).style.strokeWidth > fe.style.strokeWidth, '选中的线加粗');
    const re = f.fromFlowEdge({ ...fe, target: c.id, targetHandle: null });
    assert.equal(re.to, c.id, '改连之后存的是新的那一头');
    assert.equal(re.toHandle, undefined, '没有连接点就不存(不存 null)');
    assert.deepEqual(f.styleOf(node), { color: 'teal', fill: 'solid', dashed: true, fontSize: 15, bold: true, textColor: 'yellow' }, '格式刷只带走样式(含文字颜色),不带文字和位置');
    ok('画布对象和纯数据互转:字段不丢、坐标取整、叠放、线型箭头、改连');
  }

  // ── 存盘前体检:能修的自动修,修不了的说清楚哪里不对(以前一处不对整张就存不进去,还显示「已保存」) ──
  {
    const a = m.newNode('pill', 0, 0), b = m.newNode('pill', 200, 0), c = m.newNode('rounded', 400, 0);
    const good = m.newEdge(a.id, b.id, { flow: true, flowStyle: 'comet', flowColor: 'blue' });
    const dangling = m.newEdge(b.id, 'n_已经删掉的');
    const dup = { ...m.newEdge(b.id, c.id), id: good.id };
    const nulls = { ...m.newEdge(a.id, c.id), fromHandle: null, width: '2', flowSpeed: 9 };
    const badNode = { ...c, z: Number.NaN, fill: 'weird', textColor: 'toString' };
    const r = m.repairCanvas([a, b, badNode, { ...b }], [good, dangling, dup, nulls]);
    const doc = { ...m.newCanvas('t'), nodes: r.nodes, edges: r.edges };
    assert(m.isCanvasDoc(doc), '修完必须是合格的画布:' + m.explainCanvasProblem(doc));
    assert.equal(r.edges.length, 3, '悬空的线去掉,其余留着');
    assert.equal(new Set(r.edges.map((e) => e.id)).size, 3, '重复的线 id 换新');
    assert.equal(new Set(r.nodes.map((x) => x.id)).size, 4, '重复的形状 id 换新,形状一个不少');
    assert(r.edges.some((e) => e.flowStyle === 'comet' && e.flowColor === 'blue'), '正常的彗星蓝色流动原样保留');
    assert(r.fixed.length >= 5, '修了什么要说出来:' + JSON.stringify(r.fixed));
    assert.equal(r.nodes.find((x) => x.id === c.id).textColor, undefined, '不认识的文字颜色去掉(回到自动),形状留着');
    const clean = m.repairCanvas([a, b], [good]);
    assert.deepEqual(clean.fixed, [], '没毛病就什么都不改');
    assert.deepEqual(clean.edges, [good]);
    assert.equal(m.explainCanvasProblem({ ...m.newCanvas('t'), nodes: [{ ...a, w: Number.NaN }], edges: [] }).includes('第 1 个形状的 w'), true, '说清楚是哪个形状的哪个字段');
    assert.equal(m.explainCanvasProblem(doc), null);
    ok('存盘前体检:悬空的线 / 重复 id / 坏的可选值自动修,修不了的指出哪一处');
  }

  // ── 历史版本:内容没变不记,固定 2 分钟一段、同段只留最后一份,第一份永远留着,恢复算里程碑,最多 30 份 ──
  {
    const repoFile = join(dir, 'r.cjs');
    await build({ entryPoints: [resolve('src/features/lineage/canvas/canvasRepository.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: repoFile, logLevel: 'silent' });
    const repo = createRequire(import.meta.url)(repoFile);
    const G = repo.HISTORY_GAP_MS;
    const a = m.newNode('pill', 0, 0);
    const t0 = 100 * G;                     // 一段的开头
    let h = repo.pushVersion({}, 'd', [a], [], t0);
    assert.equal(h.d.length, 1);
    assert.equal(repo.pushVersion(h, 'd', [a], [], t0 + 5), h, '内容没变就不记');
    h = repo.pushVersion(h, 'd', [a, m.newNode('pill', 1, 1)], [], t0 + 1000);
    assert.equal(h.d.length, 2, '第一份永远留着,不被同一段的改动顶掉');
    h = repo.pushVersion(h, 'd', [a, m.newNode('pill', 2, 2)], [], t0 + 2000);
    assert.equal(h.d.length, 2, '同一段里只留最后一份');
    // 连续画 10 分钟、每 10 秒存一次:应该留下按段的多份,而不是一直替换成一份
    let c = repo.pushVersion({}, 'c', [a], [], t0 - G);
    for (let s = 0; s < 60; s += 1) c = repo.pushVersion(c, 'c', [{ ...a, x: s }], [], t0 + s * 10_000);
    assert(c.c.length >= 5, `连续画 10 分钟要留下多份,实际 ${c.c.length}`);
    // 恢复历史版本是里程碑:不能把恢复前的那份顶掉
    const before = c.c.length;
    c = repo.pushVersion(c, 'c', [a], [], t0 + 595_000, true);
    assert.equal(c.c.length, before + 1, '恢复前的样子要留在历史里');
    for (let i = 0; i < 50; i += 1) h = repo.pushVersion(h, 'd', [{ ...a, x: i }], [], t0 + (i + 10) * G);
    assert.equal(h.d.length, repo.HISTORY_KEEP, '最多留 30 份');
    assert.equal(h.d[h.d.length - 1].nodes[0].x, 49, '留下的是最新的');
    ok('历史版本:去重、按 2 分钟分段、首份保留、恢复不顶掉前一份、最多 30 份');
  }

  console.log(`lineage canvas: ${n} 项通过`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
