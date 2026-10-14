/**
 * Phase 3 的验收:**同一个请求跑 5 次,5 次都要能产出可用的看板**。
 *
 * 为什么不放进 npm run check:它要真调云模型 —— 要网络、要 API key、要花钱、
 * 而且每次结果都不一样。集成测试必须离线、免费、确定。这条是**按需跑的验收**,
 * 不是回归测试。
 *
 * 跑法:  node scripts/layout-stability.mjs [次数]
 * 需要环境变量 SONDE_AI_BASE / SONDE_AI_KEY / SONDE_AI_MODEL,
 * 不给就读本机 Sonde 里已配好的那套。
 *
 * 指标名用的是通用零售口径(销售额、笔均金额……),不带公司特有的东西 ——
 * 这条验收测的是**排版稳不稳**,和指标叫什么无关,没必要把真口径发出去。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { execFileSync } from "node:child_process";

const RUNS = Number(process.argv[2] ?? 5);
const dir = mkdtempSync(join(tmpdir(), "sonde-layout-"));

const METRICS = [
  { metricId: "m_rev", name: "销售额", unit: "元", caliber: "含线下与线上", rollup: "sum", supportedDimensions: ["day", "month", "store", "channel"], dateScoped: true, sourceTables: ["t"] },
  { metricId: "m_orders", name: "订单量", unit: "单", caliber: "", rollup: "sum", supportedDimensions: ["day", "month", "store", "channel"], dateScoped: true, sourceTables: ["t"] },
  { metricId: "m_aov", name: "笔均金额", unit: "元", caliber: "销售额 ÷ 订单量", rollup: "avg", supportedDimensions: ["day", "month", "store"], dateScoped: true, sourceTables: ["t"] },
  { metricId: "m_guests", name: "客流量", unit: "人", caliber: "", rollup: "sum", supportedDimensions: ["day", "month", "store"], dateScoped: true, sourceTables: ["t"] },
];
const INSIGHTS = [
  { headline: "8 月销售额环比增长 6.2%,主要由线上渠道拉动" },
  { headline: "笔均金额连续三个月下滑,从 42.1 元降到 38.7 元" },
  { headline: "网点之间差距拉大:前 10 名贡献了 38% 的销售额" },
];

try {
  const entry = join(dir, "entry.ts");
  writeFileSync(entry, [
    `export { layoutDesigner } from ${JSON.stringify(resolve("src/features/agent/nodes/index.ts"))};`,
    `export { resolveLayout, layoutHeight } from ${JSON.stringify(resolve("src/features/agent/layout.ts"))};`,
    `export { reviewLayout, reviewVerdict, applyFixes } from ${JSON.stringify(resolve("src/features/agent/review.ts"))};`,
    `export { createState } from ${JSON.stringify(resolve("src/features/agent/state.ts"))};`,
  ].join("\n"));
  const out = join(dir, "run.cjs");
  buildSync({ entryPoints: [entry], outfile: out, bundle: true, platform: "node", format: "cjs", logLevel: "silent" });

  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear(),
  };
  const cfg = {
    provider: "cloud", v: 2, thinkingEnabled: false, includeSampleRows: false,
    cloud: {
      baseUrl: process.env.SONDE_AI_BASE ?? readLocal("baseUrl"),
      apiKey: process.env.SONDE_AI_KEY ?? readLocal("apiKey"),
      model: process.env.SONDE_AI_MODEL ?? readLocal("model"),
    },
  };
  if (!cfg.cloud.apiKey) {
    console.error("没有云模型配置。给 SONDE_AI_BASE / _KEY / _MODEL,或先在 Sonde 里配好。");
    process.exit(2);
  }
  mem.set("ai.config", JSON.stringify(cfg));

  const { layoutDesigner, resolveLayout, layoutHeight, reviewLayout, reviewVerdict, applyFixes, createState } =
    createRequire(import.meta.url)(out);

  const base = {
    ...createState({ userRequest: "分析最近半年的经营情况,做一个看板" }),
    validatedMetrics: METRICS,
    insights: INSIGHTS,
    scope: { label: "2026-03-01 至 2026-08-31", dateRange: { start: "2026-03-01", end: "2026-08-31" }, comparisonRanges: [] },
  };

  const rows = [];
  for (let i = 1; i <= RUNS; i++) {
    const t0 = Date.now();
    let row = { run: i, ok: false, why: "" };
    try {
      const patch = await layoutDesigner(base);
      const items = patch.layout?.items ?? [];
      /* 和真流水线一样:先跑代码规则,**再自动修**,判的是修完还剩什么。
         只看修之前的 findings 会把"已经自动修好的图表类型"算成失败 —— 那不是用户会看到的东西。 */
      const check = (list) => reviewLayout(resolveLayout(list), {
        categoryCounts: {}, pointCounts: {}, magnitudes: {},
        validatedMetricIds: METRICS.map((m) => m.metricId),
        ratioMetricIds: ["m_aov"],
        timeDimensions: ["day", "week", "month", "year"],
      });
      const before = check(items);
      const fixed = applyFixes(items, before, check);
      const after = check(fixed.items);
      const placed = resolveLayout(fixed.items);
      const { verdict } = reviewVerdict(after);
      const must = after.filter((f) => f.severity === "must_fix");
      // 「可用」的定义:有组件、没重叠没出界、自动修完不再有 must_fix
      const overlap = after.some((f) => f.code === "OVERLAP" || f.code === "OUT_OF_GRID");
      row = {
        run: i, ok: fixed.items.length >= 2 && !overlap && must.length === 0,
        items: fixed.items.length, height: layoutHeight(placed), verdict,
        must: must.length, texts: items.filter((x) => x.type === "text").length,
        styled: items.filter((x) => x.appearance || x.chart).length,
        positioned: items.filter((x) => Number.isFinite(x.x)).length,
        autofixed: fixed.applied.length,
        theme: (patch.layout?.theme ?? "").slice(0, 34),
        preset: patch.layout?.preset ?? "-",
        why: must.map((f) => `${f.code}:${f.reason}`).join(" | ").slice(0, 200),
        ms: Date.now() - t0,
      };
    } catch (e) {
      row.why = String(e).slice(0, 120);
      row.ms = Date.now() - t0;
    }
    rows.push(row);
    console.log(
      `第 ${i} 次  ${row.ok ? "✓" : "✗"}  组件 ${row.items ?? "-"} · 高 ${row.height ?? "-"} 行 · ` +
      `自排版 ${row.positioned ?? "-"} · 文字块 ${row.texts ?? "-"} · 配了样式 ${row.styled ?? "-"} · ` +
      `自动修 ${row.autofixed ?? "-"} · 基调 ${row.preset ?? "-"} · ${row.ms} ms${row.why ? "\n        剩余问题:" + row.why : ""}`);
    if (row.theme) console.log(`        设计思路:${row.theme}`);
  }

  const pass = rows.filter((r) => r.ok).length;
  console.log(`\n${pass}/${RUNS} 可用。` + (pass === RUNS ? "Phase 3 验收通过。" : "**没达标** —— 验收要求 5/5。"));
  process.exit(pass === RUNS ? 0 : 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function readLocal(field) {
  try {
    const py = `
import sqlite3,json,glob
p=glob.glob('${process.env.HOME}/Library/WebKit/com.u35.dbsonde/WebsiteData/Default/*/*/LocalStorage/localstorage.sqlite3')[0]
v=sqlite3.connect(p).execute("select value from ItemTable where key='ai.config'").fetchone()[0].decode('utf-16-le')
print(json.loads(v)['cloud'].get(${JSON.stringify(field)},''))`;
    return execFileSync("python3", ["-c", py], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
