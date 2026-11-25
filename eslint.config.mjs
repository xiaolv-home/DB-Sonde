import hooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/* 只开 react-hooks 这两条规则,不开别的。
 *
 * 这个项目的质量防线是 scripts/test-*.mjs 里的定向守卫 —— 每一条钉的是一类
 * 真出过事的错误,而不是风格。那套做法很好用,所以这儿不引进一整套风格规则
 * 来跟它抢地盘(几百条缩进和引号的警告只会把真问题埋掉)。
 *
 * 但 hook 依赖是守卫脚本做不到的一类:要判断一个 effect 漏没漏依赖,得有
 * 完整的作用域分析,正则扫不出来。而漏依赖的后果恰恰最难查 —— 闭包捕获了
 * 第一次渲染时的值,界面上什么都不报,只是"改了没生效"。
 *
 * 项目里本来有 15 处 `// eslint-disable-next-line react-hooks/exhaustive-deps`,
 * 而**根本没装 eslint** —— 那些注释在装样子。现在它们要么真的在压一条规则,
 * 要么被 reportUnusedDisableDirectives 报出来。
 *
 * exhaustive-deps 设成 error 而不是 warn:故意为之的地方必须写明理由,
 * 不写就过不了 `npm run build`。warn 等于没人看。
 */
export default [
  // 构建产物和第三方源码不归我们管
  { ignores: ["dist/**", ".vite-cache/**", "src-tauri/target/**", "src-tauri/third_party/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": hooks },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: {
      // 压着一条不存在的问题的注释也要报出来,免得又攒出一堆装样子的
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  // 内联进离线 HTML 的 *.runtime.js 不走 tsc,必须由 ESLint 守住语法与未定义全局变量
  {
    files: ["src/**/*.runtime.js"],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "script",
      globals: {
        globalThis: "readonly",
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        getComputedStyle: "readonly",
        ResizeObserver: "readonly",
        MutationObserver: "readonly",
        HTMLElement: "readonly",
        HTMLInputElement: "readonly",
        Node: "readonly",
        Blob: "readonly",
        Response: "readonly",
        CompressionStream: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        Uint8Array: "readonly",
        DataView: "readonly",
        ArrayBuffer: "readonly",
        Intl: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unreachable": "error",
      "no-dupe-keys": "error",
      "no-redeclare": "error",
      "no-const-assign": "error",
    },
  },
];
