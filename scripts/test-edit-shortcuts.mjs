// 全选 / 查找快捷键路由的纯逻辑:按键认命令、真按键和菜单两条路只算一次。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const dir = mkdtempSync(join(tmpdir(), 'sonde-editkeys-'));
let n = 0;
const ok = (name) => { n += 1; console.log(`  ✓ ${name}`); };
try {
  const outfile = join(dir, 't.cjs');
  await build({ entryPoints: [resolve('src/lib/editShortcuts.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
  const m = createRequire(import.meta.url)(outfile);
  const k = (code, o = {}) => ({ code, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...o });

  assert.equal(m.commandOf(k('KeyA')), 'selectAll');
  assert.equal(m.commandOf(k('KeyF')), 'find');
  assert.equal(m.commandOf(k('KeyF', { altKey: true })), 'replace', '⌥ 会把 f 变成 ƒ,按物理键认');
  assert.equal(m.commandOf(k('KeyG')), 'findNext');
  assert.equal(m.commandOf(k('KeyG', { shiftKey: true })), 'findPrev');
  assert.equal(m.commandOf(k('KeyA', { shiftKey: true })), null, '⇧⌘A 不是全选');
  assert.equal(m.commandOf(k('KeyA', { metaKey: false })), null, '不按 ⌘ 不算');
  assert.equal(m.commandOf(k('KeyA', { metaKey: false, ctrlKey: true })), 'selectAll', 'Windows 上是 Ctrl');
  assert.equal(m.commandOf(k('KeyS')), null);
  for (const [id, cmd] of Object.entries(m.MENU_COMMANDS)) assert(id.startsWith('edit.') && cmd, `菜单项 ${id}`);
  ok('按键 → 命令:⌘A / ⌘F / ⌥⌘F / ⌘G / ⇧⌘G,Ctrl 也认,别的键不管');

  let t = 1000;
  const now = () => t;
  // 真按键先到、有人处理了 → 菜单那一下跳过
  let d = m.createDeduper(400, now);
  assert.equal(d.onRealKey('findNext', () => true), 'pass');
  t += 50; assert.equal(d.onMenu('findNext'), 'skip', '页面处理过了,菜单不再做一遍');
  // 真按键到了但没人处理(输入框里的 ⌘A)→ 菜单只补兜底
  d = m.createDeduper(400, now);
  d.onRealKey('selectAll', () => false);
  t += 50; assert.equal(d.onMenu('selectAll'), 'fallback');
  // 菜单先到(页面没收到真按键)→ 重新发一次;之后真按键再来 → 吞掉
  d = m.createDeduper(400, now);
  assert.equal(d.onMenu('find'), 'dispatch');
  t += 50; assert.equal(d.onRealKey('find', () => false), 'swallow', '菜单已经做过,真按键吞掉');
  t += 50; assert.equal(d.onRealKey('find', () => false), 'pass', '只吞一次');
  // 超过窗口就是新的一下
  d = m.createDeduper(400, now);
  d.onRealKey('findNext', () => true);
  t += 500; assert.equal(d.onMenu('findNext'), 'dispatch', '隔了 500ms 是另一下');
  // 不同的键互不影响
  d = m.createDeduper(400, now);
  d.onRealKey('findNext', () => true);
  assert.equal(d.onMenu('findPrev'), 'dispatch');
  ok('真按键和菜单两条路:同一下只算一次;没人处理时只补兜底;超时、换键都算新的');

  console.log(`edit shortcuts: ${n} 项通过`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
