/** 界面主题。
 *
 *  DOM 上是两个属性:`data-theme` 只有 dark / light 两个值,所有「亮暗不同」的规则
 *  (代码配色、图表、画布)都认它;`data-palette` 只在明暗之内再换一套色,目前只有 paper。
 *  所以加一套浅色不用动那些规则,只要在 styles/tokens.css 里补一组 token,再往下面登记一行。 */

export const THEMES = [
  { id: "dark", zh: "墨", name: "Ink", zhHint: "柔和的炭灰,长时间看不累", hint: "Soft charcoal, easy on the eyes", swatch: ["#1b1d22", "#2a2e36", "#d5d9e1", "#7aa7dd"] },
  { id: "light", zh: "霜", name: "Frost", zhHint: "干净的冷白,光线好的时候用", hint: "Clean cool white", swatch: ["#f5f6f8", "#ffffff", "#1f2024", "#2470c4"] },
  { id: "paper", zh: "纸", name: "Paper", zhHint: "暖色纸面,蓝光少,像读书", hint: "Warm paper, less blue light", swatch: ["#f2efe8", "#faf8f3", "#2c2a26", "#2d5f96"] },
] as const;

export type Theme = (typeof THEMES)[number]["id"];

export const isTheme = (value: unknown): value is Theme => THEMES.some((theme) => theme.id === value);

/** 给只认明暗的第三方(React Flow 的 colorMode)用。 */
export const themeBase = (theme: Theme): "dark" | "light" => (theme === "dark" ? "dark" : "light");

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.setAttribute("data-theme", themeBase(theme));
  if (theme === "paper") root.setAttribute("data-palette", "paper");
  else root.removeAttribute("data-palette");
}
