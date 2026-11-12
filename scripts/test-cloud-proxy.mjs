// The desktop app must not hand the cloud API key to the renderer, and cloud
// model calls must go through the Rust proxy instead of fetch().
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const SECRET = "sk-test-UNIQUE-9f3a";
const dir = mkdtempSync(join(tmpdir(), "sonde-cloud-proxy-"));
const calls = [];
try {
  const outfile = join(dir, "proxy.cjs");
  await build({
    stdin: {
      contents: `export { streamChat, listModels } from './src/features/ai/aiClient';
        export { callStructured } from './src/features/agent/model/structured';
        export { presentServiceConfig, secureRepository } from './src/lib/secureRepository';
        export { isSavedAiConfig } from './src/features/ai/aiConfigModel';
        export { cloudKeyConfigured } from './src/features/agent/model/modelRouting';
        export { analysisModelProblems } from './src/features/agent/model/analysisModels';`,
      resolveDir: resolve("."),
      loader: "ts",
    },
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [{
      name: "stub-tauri",
      setup(build) {
        build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "tauri-core", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          contents: `exports.Channel = class Channel { constructor() { this.onmessage = null; } };
            exports.invoke = (cmd, args) => globalThis.cloudInvoke(cmd, args);
            exports.isTauri = () => true;`,
          loader: "js",
        }));
      },
    }],
  });

  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.window = { __TAURI_INTERNALS__: {} };
  const loaded = createRequire(import.meta.url)(outfile);
  const leaked = JSON.stringify({
    provider: "cloud",
    cloud: { baseUrl: "https://api.openai.com/v1", apiKey: SECRET, model: "gpt-4o-mini" },
  });
  const safe = JSON.parse(loaded.presentServiceConfig("ai.config", leaked));
  assert.equal(safe.cloud.apiKey, "");
  assert.equal(safe.cloud.hasKey, true);
  assert.equal(JSON.stringify(safe).includes(SECRET), false);
  const already = loaded.presentServiceConfig("ai.config", JSON.stringify({ cloud: { apiKey: "", hasKey: true, model: "m" } }));
  assert.equal(JSON.parse(already).cloud.hasKey, true);
  assert.equal(loaded.presentServiceConfig("other", leaked), leaked);

  const legacyStore = new Map([["ai.config", leaked]]);
  let vaultWrite = "";
  globalThis.cloudInvoke = async (cmd, args) => {
    if (cmd === "load_service_config") return null;
    if (cmd === "save_service_config") {
      vaultWrite = args.value;
      return null;
    }
    throw new Error(`unexpected ${cmd}`);
  };
  const migratedRepo = loaded.secureRepository("ai.config", () => ({}), loaded.isSavedAiConfig, undefined, {
    getItem: (key) => legacyStore.get(key) ?? null,
    removeItem: (key) => legacyStore.delete(key),
  });
  await migratedRepo.initialize();
  const migrated = migratedRepo.load();
  assert.equal(migrated.cloud.apiKey, "");
  assert.equal(migrated.cloud.hasKey, true);
  assert.equal(JSON.stringify(migrated).includes(SECRET), false);
  assert.equal(legacyStore.size, 0);
  assert.equal(vaultWrite.includes(SECRET), true, "the vault still receives the key on migration");

  globalThis.cloudInvoke = async (cmd, args) => {
    const encoded = JSON.stringify(args, (_key, value) => (typeof value === "function" ? undefined : value));
    assert.equal(encoded.includes(SECRET), false, `${cmd} sent the API key to Rust: ${encoded}`);
    calls.push({ cmd, args });
    if (cmd === "cloud_chat_stream") {
      args.channel.onmessage({ kind: "chunk", data: 'data: {"choices":[{"delta":{"content":"你好"}}]}\n' });
      args.channel.onmessage({ kind: "done", data: "" });
      return null;
    }
    if (cmd === "cloud_model_request" && args.path === "models") {
      return { status: 200, body: JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), retryAfter: null };
    }
    if (cmd === "cloud_model_request") {
      return {
        status: 200,
        body: JSON.stringify({
          choices: [{ message: { content: '{"summary":"ok"}' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        }),
        retryAfter: null,
      };
    }
    if (cmd === "cloud_model_cancel") return null;
    throw new Error(`unexpected ${cmd}`);
  };

  const { streamChat, listModels, callStructured, cloudKeyConfigured, analysisModelProblems } = loaded;
  const config = {
    provider: "cloud",
    builtin: { model: "builtin", baseUrl: "http://127.0.0.1:8899/v1", ready: false },
    local: { baseUrl: "http://127.0.0.1:1234/v1", model: "local-model" },
    cloud: { baseUrl: "https://api.openai.com/v1", apiKey: SECRET, model: "gpt-4o-mini", hasKey: true },
    thinkingEnabled: false,
    includeSampleRows: false,
  };
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error(`renderer fetch saw ${SECRET}`);
  };

  const text = await new Promise((done, fail) => {
    streamChat(config, [{ role: "user", content: "hi" }], { onToken: () => {}, onDone: done, onError: fail });
  });
  assert.equal(text, "你好");
  assert.equal(fetches, 0);
  assert.equal(calls.some((call) => call.cmd === "cloud_chat_stream"), true);
  assert.equal(calls.find((call) => call.cmd === "cloud_chat_stream").args.baseUrl, config.cloud.baseUrl);

  const models = await listModels(config.cloud.baseUrl, SECRET, "cloud");
  assert.deepEqual(models, ["gpt-4o-mini"]);
  assert.equal(fetches, 0);
  assert.equal(calls.some((call) => call.cmd === "cloud_model_request" && call.args.path === "models"), true);

  const structured = await callStructured({
    role: "reasoning",
    node: "fixture",
    system: "s",
    user: "u",
    name: "fixture",
    maxRepairs: 0,
    schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
  }, config);
  assert.equal(structured.ok, true);
  assert.equal(structured.data.summary, "ok");
  assert.equal(fetches, 0);

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: {
      getReader() {
        const chunks = [new TextEncoder().encode('data: {"choices":[{"delta":{"content":"local"}}]}\n')];
        let i = 0;
        return { read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) };
      },
    },
  });
  const before = calls.length;
  const localText = await new Promise((done, fail) => {
    streamChat({ ...config, provider: "local" }, [{ role: "user", content: "hi" }], {
      onToken: () => {}, onDone: done, onError: fail,
    });
  });
  assert.equal(localText, "local");
  assert.equal(calls.length, before, "local models stay on the renderer");

  assert.equal(cloudKeyConfigured({ apiKey: "", hasKey: true }), true);
  assert.equal(cloudKeyConfigured({ apiKey: "", hasKey: false }), false);
  const storedOnly = { ...config, cloud: { ...config.cloud, apiKey: "" } };
  assert.deepEqual(analysisModelProblems(storedOnly, { provider: "cloud", model: "gpt-4o-mini" }, false), []);
  assert.deepEqual(
    analysisModelProblems({ ...storedOnly, cloud: { ...storedOnly.cloud, hasKey: false } }, { provider: "cloud", model: "gpt-4o-mini" }, false),
    ["云端模型尚未配置 API Key，请打开 AI 设置"],
  );

  console.log("cloud proxy: key stays out of the renderer; cloud calls use the proxy; local calls still use fetch");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
