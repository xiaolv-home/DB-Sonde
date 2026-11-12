// 换主机会清掉已存的云端 Key。设置页要事先说明,清掉之后要给出状态。
// 清 Key 的判断留在 commitUrl / Rust,这里只锁文案和提示语义。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const settings = readFileSync('src/features/ai/AiSettings.tsx', 'utf8');
const strings = readFileSync('src/features/ai/strings.ts', 'utf8');

assert.match(strings, /cloudKeyHostHint: "更换主机后需要重新填写 Key"/);
assert.match(strings, /cloudKeyCleared: "主机已更换，原 Key 已清除，请重新填写"/);

const commitUrl = settings.slice(settings.indexOf('  const commitUrl = '), settings.indexOf('  // 只观察 commitUrl'));
assert.equal(commitUrl, `  const commitUrl = (next: string, keyDraft = draftKey): Promise<boolean | void> => {
    const previous = cloudOrigin(config.cloud.baseUrl);
    const origin = cloudOrigin(next);
    if (origin !== null && origin === previous) {
      if (next === config.cloud.baseUrl) return Promise.resolve(true);
      return Promise.resolve(updateCloud({ baseUrl: next }));
    }
    const trimmed = keyDraft.trim();
    if (trimmed) return persistKey(trimmed, next);
    return Promise.resolve(updateCloud({ baseUrl: next, apiKey: "", hasKey: false }));
  };
`);

const note = settings.slice(settings.indexOf('  const noteClearedKey'), settings.indexOf('  const requestClose'));
assert.match(note, /return commitUrl\(next\)/);
assert.doesNotMatch(note, /updateCloud/);
assert.match(note, /setKeyCleared\(true\)/);

const cloud = settings.slice(settings.indexOf('{config.provider === "cloud"'), settings.indexOf('{hasKey && ('));
assert.match(cloud, /id="cloud-base-url"/);
assert.match(cloud, /id="cloud-api-key"/);
assert.equal([...cloud.matchAll(/aria-describedby=\{keyCleared \? "cloud-host-key-hint cloud-host-key-cleared" : "cloud-host-key-hint"\}/g)].length, 2);
assert.match(cloud, /<p id="cloud-host-key-hint" className="ai-field-hint">\{t\("cloudKeyHostHint"\)\}<\/p>/);
assert.match(cloud, /<p id="cloud-host-key-cleared" className="ai-field-hint" role="status">\{t\("cloudKeyCleared"\)\}<\/p>/);
const hintAt = cloud.indexOf('id="cloud-host-key-hint"');
const keyAt = cloud.indexOf('id="cloud-api-key"');
const statusAt = cloud.indexOf('role="status"');
assert.ok(hintAt > cloud.indexOf('id="cloud-base-url"') && hintAt < keyAt, '固定提示要挨着地址和 Key');
assert.ok(statusAt > keyAt, '清空后的状态提示要挨着 Key');

console.log('cloud key hint: 换主机提示 / 清空状态 / commitUrl 未改 全部锁住');
