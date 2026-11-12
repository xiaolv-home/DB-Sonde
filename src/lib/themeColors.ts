/** 从当前 `<html data-theme>` 上读颜色。
 *
 *  图表、看板默认色板、画布导出都走这里,不再各写一套色值。
 *  离线页面不能靠应用的样式表,导出时用 themeDeclarations 把算出来的色值写进页面。
 *  传入 source 是为了测试:没有浏览器时用一份假的 getPropertyValue 代替。 */

export const CHART_SERIES_VARS = [
  "--chart-1", "--chart-2", "--chart-3", "--chart-4",
  "--chart-5", "--chart-6", "--chart-7", "--chart-8",
] as const;

export const MEDAL_VARS = ["--medal-1", "--medal-2", "--medal-3"] as const;

/** 离线看板要用到的变量。缺一个,导出的页面上那一块就是没颜色的。 */
export const THEME_SNAPSHOT_VARS = [
  "--bg", "--surface", "--surface-2", "--surface-3",
  "--text", "--text-2", "--text-3",
  "--border", "--border-2", "--grid-line",
  "--accent", "--accent-2", "--accent-ink", "--accent-soft", "--accent-border",
  "--green", "--red", "--amber",
  "--shadow", "--shadow-sm",
  ...CHART_SERIES_VARS,
  ...MEDAL_VARS,
] as const;

export interface CssSource {
  getPropertyValue(name: string): string;
}

export function cssSource(el?: Element | null): CssSource | undefined {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return undefined;
  return getComputedStyle(el ?? document.documentElement);
}

export function readVar(name: string, source?: CssSource): string {
  const src = source ?? cssSource();
  return src ? src.getPropertyValue(name).trim() : "";
}

export function readVars(names: readonly string[], source?: CssSource): string[] {
  return names.map((name) => readVar(name, source));
}

/** 图表坐标轴、网格、文字、图例、提示框用的界面色。 */
export interface ChartChrome {
  text: string;
  text2: string;
  muted: string;
  border: string;
  border2: string;
  surface: string;
  surface2: string;
  surface3: string;
  accent: string;
  accentSoft: string;
  green: string;
  red: string;
  amber: string;
  bg: string;
  shadow: string;
  shadowSm: string;
}

export function chartChrome(source?: CssSource): ChartChrome {
  const v = (name: string) => readVar(name, source);
  return {
    text: v("--text"),
    text2: v("--text-2"),
    muted: v("--text-3"),
    border: v("--border"),
    border2: v("--border-2"),
    surface: v("--surface"),
    surface2: v("--surface-2"),
    surface3: v("--surface-3"),
    accent: v("--accent"),
    accentSoft: v("--accent-soft"),
    green: v("--green"),
    red: v("--red"),
    amber: v("--amber"),
    bg: v("--bg"),
    shadow: v("--shadow"),
    shadowSm: v("--shadow-sm"),
  };
}

/** 当前主题的默认系列色。用户在看板上自己设过的 palette 不要用这个替换。 */
export function chartPalette(source?: CssSource): string[] {
  return readVars(CHART_SERIES_VARS, source).filter((color) => color.length > 0);
}

export function medalColors(source?: CssSource): string[] {
  return readVars(MEDAL_VARS, source).filter((color) => color.length > 0);
}

/** 导出页样式里的占位。运行时换成导出那一刻算出来的色值。 */
export const THEME_MARKER = "/*__THEME__*/";

export function themeDeclarations(source?: CssSource): string {
  const src = source ?? cssSource();
  if (!src) return "";
  return THEME_SNAPSHOT_VARS.flatMap((name) => {
    const value = src.getPropertyValue(name).trim();
    return value ? [`${name}: ${value};`] : [];
  }).join(" ");
}

export function applyThemeSnapshot(css: string, source?: CssSource): string {
  return css.replace(THEME_MARKER, themeDeclarations(source));
}
