import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * 导出的离线看板是一个**自包含的单文件 HTML** —— ECharts、运行时脚本、样式、
 * 烘焙数据全都内联在里面。所以它的体积就是这些东西的体积之和。
 *
 * 这儿管两件事,都只影响**导出产物**,不改任何行为:
 *
 * 1. `virtual:echarts-standalone` —— 按需构建的 ECharts,而不是完整版。
 *    离线页面只画折线/柱状/饼三种图,用到 grid / legend / tooltip / dataZoom。
 *    完整版 1096 KB,按需构建 597 KB,省 45%。
 *    **加新图表类型或新组件时,下面那份清单要跟着加** —— 漏了的话那个图在导出的
 *    网页里画不出来(而软件里是好的,因为软件走的是完整版),很难往这儿想。
 *    test-offline-export.mjs 有一条守卫盯着这件事。
 *
 * 2. `?inline-min` —— 内联进 HTML 的脚本和样式压缩一遍。仓库里的源码照旧带完整
 *    注释(那些是写给读代码的人的),只是产物里不带。合计省 48 KB。
 *
 * 写成普通 JS 而不是 TS:Vite 要它(打包时),两个测试脚本也要它(它们用 esbuild
 * 把 htmlExport.ts 打出来跑)。两处共用同一份,免得规则各写一遍走散 ——
 * 走散的表现是「软件里好好的,导出的网页少个图」。
 */

const ECHARTS_VIRTUAL = "virtual:echarts-standalone";
const MIN_SUFFIX = "?inline-min";

/** 离线页面实际用到的 ECharts 部件。改之前先看上面那段说明。 */
const ECHARTS_ENTRY = `
import * as echarts from "echarts/core";
import { LineChart, BarChart, PieChart, GaugeChart, FunnelChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent, DataZoomComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
echarts.use([LineChart, BarChart, PieChart, GaugeChart, FunnelChart, GridComponent, LegendComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);
window.echarts = echarts;
`;

/** 供守卫检查用:清单里都有谁。 */
export const echartsParts = {
  charts: ["LineChart", "BarChart", "PieChart", "GaugeChart", "FunnelChart"],
  components: ["GridComponent", "LegendComponent", "TooltipComponent", "DataZoomComponent"],
  renderers: ["CanvasRenderer"],
};

let cached = null;

/** 按需构建 ECharts,返回整段 IIFE 源码。结果缓存,一次构建里只打一遍。 */
export async function buildEchartsBundle(root) {
  if (cached === null) {
    const out = await build({
      stdin: { contents: ECHARTS_ENTRY, resolveDir: root, loader: "js" },
      bundle: true, minify: true, format: "iife", target: "es2017",
      write: false, logLevel: "silent", charset: "utf8",
    });
    cached = out.outputFiles[0].text;
  }
  return cached;
}

/** 压缩一个文件,返回源码字符串。css 走 css loader,其余当 js。 */
export async function minifyFile(file) {
  const source = await readFile(file, "utf8");
  const out = await build({
    stdin: { contents: source, resolveDir: dirname(file), loader: file.endsWith(".css") ? "css" : "js", sourcefile: file },
    minify: true, target: "es2017", write: false, logLevel: "silent",
    /* 默认是 charset:"ascii",中文会被转成 \uXXXX —— 每个汉字 6 字节而不是 3。
       导出的 HTML 本来就声明了 utf-8,没必要转义,转了反而更大。 */
    charset: "utf8",
  });
  return out.outputFiles[0].text;
}

const asModule = (text) => `export default ${JSON.stringify(text)};`;

/** Vite 插件(打包应用时用)。 */
export function viteExportAssets(root) {
  const RESOLVED = "\0" + ECHARTS_VIRTUAL;
  /* 解析后的 id:前面加 \0(告诉 Rollup 这是虚拟模块),**后面再加个尾标记**,
     让它不以 .css / .js 结尾。
     Vite 判断"这是不是 CSS 请求"看的是 id 的结尾 —— 尾巴还是 .css 的话,
     它会把我们吐出来的那个 JS 模块(export default "……")再塞进 CSS 管线,
     报一句莫名其妙的 "default is not exported"。 */
  const MIN_PREFIX = "\0inline-min:";
  const MIN_TAIL = ":min";
  return {
    name: "sonde:export-assets",
    /* 必须抢在 Vite 内置解析器前面。不加的话 `./x.runtime.js?inline-min` 会被
       它先解析成带 query 的真实路径,我们的 load 拿到的就不是自己给的 id 了
       (曾经碰巧能跑,是因为当时 load 顺手认了对方产出的 id —— 靠巧合的东西
       一改就断)。 */
    enforce: "pre",
    resolveId(id, importer) {
      if (id === ECHARTS_VIRTUAL) return RESOLVED;
      if (id.endsWith(MIN_SUFFIX)) {
        const base = id.slice(0, -MIN_SUFFIX.length);
        return MIN_PREFIX + resolve(importer ? dirname(importer) : root, base) + MIN_TAIL;
      }
      return null;
    },
    async load(id) {
      if (id === RESOLVED) return asModule(await buildEchartsBundle(root));
      // 两种 id 都认:自己给的前缀式,以及万一被别的插件改成带 query 的路径
      if (id.startsWith(MIN_PREFIX) || id.endsWith(MIN_SUFFIX)) {
        const file = id.startsWith(MIN_PREFIX)
          ? id.slice(MIN_PREFIX.length, -MIN_TAIL.length)
          : id.slice(0, -MIN_SUFFIX.length);
        this.addWatchFile(file);
        return asModule(await minifyFile(file));
      }
      return null;
    },
  };
}

/** esbuild 插件(测试脚本把 htmlExport.ts 打出来跑时用)。 */
export function esbuildExportAssets(root) {
  return {
    name: "sonde:export-assets",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^virtual:echarts-standalone$/ }, () => ({
        path: ECHARTS_VIRTUAL, namespace: "sonde-export",
      }));
      pluginBuild.onResolve({ filter: /\?inline-min$/ }, (args) => ({
        path: resolve(args.resolveDir, args.path.slice(0, -MIN_SUFFIX.length)),
        namespace: "sonde-export",
      }));
      pluginBuild.onLoad({ filter: /.*/, namespace: "sonde-export" }, async (args) => ({
        contents: args.path === ECHARTS_VIRTUAL
          ? asModule(await buildEchartsBundle(root))
          : asModule(await minifyFile(args.path)),
        loader: "js",
      }));
    },
  };
}
