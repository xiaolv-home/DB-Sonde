/** 代码配色（SQL 编辑器语法高亮）。
 *
 *  和 UI 明暗是两件事：`data-theme` 管界面亮/暗，`data-syntax` 管代码着色。
 *  每套配色在 styles/syntax.css 里都有暗色和浅色两个版本，切界面明暗时自动跟随，
 *  所以这里只登记标识、名字和一句说明。
 *
 *  加一套新的：styles/syntax.css 里补一对选择器，再往下面数组里加一行。 */

export const SYNTAX_THEMES = [
  {
    id: "azure",
    name: "Azure",
    zh: "青蓝",
    hint: "蓝关键字 / 橙字符串 / 绿注释",
    /** 色板预览点：关键字、字符串、函数、注释 */
    swatch: ["#569cd6", "#ce9178", "#dcdcaa", "#6a9955"],
  },
  {
    id: "classic",
    name: "Classic",
    zh: "经典",
    hint: "珊瑚红关键字 / 绿字符串 / 青操作符",
    swatch: ["#f2827b", "#86d992", "#6cb8f0", "#8e8e99"],
  },
  {
    id: "nord",
    name: "Nord",
    zh: "北欧",
    hint: "低饱和灰蓝，久看不累",
    swatch: ["#81a1c1", "#a3be8c", "#88c0d0", "#667894"],
  },
  {
    id: "amber",
    name: "Amber",
    zh: "琥珀",
    hint: "暖色低蓝光，适合夜间",
    swatch: ["#fe8019", "#b8bb26", "#fabd2f", "#948d7a"],
  },
  {
    id: "neon",
    name: "Neon",
    zh: "霓虹",
    hint: "高对比，token 一眼分得开",
    swatch: ["#ff79c6", "#f1fa8c", "#50fa7b", "#6272a4"],
  },
] as const;

export type SyntaxTheme = (typeof SYNTAX_THEMES)[number]["id"];

export const DEFAULT_SYNTAX_THEME: SyntaxTheme = "azure";

export function isSyntaxTheme(value: string): value is SyntaxTheme {
  return SYNTAX_THEMES.some((theme) => theme.id === value);
}

/** 落到 <html data-syntax="…">，CSS 变量随之切换。 */
export function applySyntaxTheme(theme: SyntaxTheme): void {
  document.documentElement.setAttribute("data-syntax", theme);
}
