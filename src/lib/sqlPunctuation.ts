/* 中文输入法在 SQL 代码里打出来的东西,怎么纠正成英文。两件事,同一个出发点:
 *
 * 1. 全角标点:「;」「,」「(」「)」「。」、弯引号「“”‘’」、shift+减号打出的「——」,SQL 都不认。
 *    在代码里(不在字符串、带引号的标识符、注释里)换成英文的;字符串、注释里的原样保留。
 *    一次上屏好几个字(「“你好,世界”」)时一个字一个字往后看语境,每次按「已经换过的」文字算:
 *    前面的“换成 " 之后,后面的,就在字符串里了不再换;结尾的”是在把串关上,要换。
 * 2. 被符号顶上屏:拼音状态下敲 e、。 再按 shift+8,输入法先把首选「额。」上屏再跟上 *,成了「额.*」,
 *    本意是 e.*。上屏内容后面紧跟着符号、组字框里是拼音原文时,退回拼音原文 + 那个符号;
 *    用数字 / 空格选字(后面不跟符号)的汉字照常保留。
 *
 * 语境用 lib/sql.ts 拆语句的同一份扫描器判断。编辑器怎么接这两条见 components/sqlPunctuationInput.ts。 */
import type { DbKind } from "../types";
import { scanSql, sqlScanState, type SqlScanState } from "./sql";

/** 全角 → 英文。只收 SQL 里一定是标点的几个。「——」(两个破折号)整体换成一个 _ */
const ASCII_OF: Record<string, string> = {
  "；": ";", "，": ",", "（": "(", "）": ")", "。": ".",
  "“": "\"", "”": "\"", "‘": "'", "’": "'",
  "—": "_",
};
const DASH = "—";

/** 中文引号属于哪种英文引号 */
const QUOTE_FAMILY: Record<string, "'" | "\""> = { "“": "\"", "”": "\"", "‘": "'", "’": "'" };

/** before 状态之后、再接上 prefix,下一个位置是不是代码 */
function codeAfter(prefix: string, kind: DbKind | undefined, before: SqlScanState): boolean {
  let inCode = false;
  scanSql(prefix + " ", kind, before, (i) => { if (i === prefix.length) inCode = true; });
  return inCode;
}

/** 这个全角字符在这儿该不该换:代码里都换;字符串里只有「同种引号」要换 —— 那是在把字符串关上
 *  (" 开头的串里敲 ”、' 开头的串里敲 ’)。种类对不上的(单引号串里的 “你好”)保留。 */
function shouldConvert(ch: string, prefix: string, kind: DbKind | undefined, before: SqlScanState): boolean {
  if (codeAfter(prefix, kind, before)) return true;
  const family = QUOTE_FAMILY[ch];
  return family != null && scanSql(prefix, kind, before).quote === family;
}

/** 在 textBefore 之后输入 typed:把落在代码里的全角标点换成英文的。没有要换的返回 null。 */
export function asciiPunctuationFor(typed: string, textBefore: string, kind: DbKind | undefined): string | null {
  // 按 UTF-16 码元切(和 scanSql 的下标一致;表情这类代理对拆开再拼回去不变)
  const chars = typed.split("");
  if (!chars.some((ch) => ch in ASCII_OF)) return null;
  const before = sqlScanState(textBefore, kind);
  let out = "";
  let changed = false;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    if (ch in ASCII_OF && shouldConvert(ch, out, kind, before)) {
      out += ASCII_OF[ch];
      changed = true;
      if (ch === DASH && chars[i + 1] === DASH) i += 1; // 「——」是一个下划线
    } else {
      out += ch;
    }
  }
  return changed ? out : null;
}

/** textBefore 之后的位置是不是在代码里(不在字符串、带引号的标识符、注释里) */
export function inCodeAt(textBefore: string, kind: DbKind | undefined): boolean {
  return codeAfter("", kind, sqlScanState(textBefore, kind));
}

const HAN = /\p{Script=Han}/u;
/** 组字框里拼音和标点之间可能夹着空格、分词用的 ' */
const SEPARATORS = /[\s']/g;
/** 拼音原文:字母开头,后面只跟标点(含全角标点),没有汉字和数字 */
const PINYIN_LIKE = /^[A-Za-z]+[^\sA-Za-z0-9\p{Script=Han}]*$/u;
/** ASCII 标点 / 符号(不是字母、数字、空白) */
const ASCII_SYMBOL = /^[!-/:-@[-`{-~]$/;

/** 上屏内容末尾那个「把它顶上屏」的符号:ASCII 符号,或会被换成英文的全角标点(「——」算一个) */
function trailingTrigger(committed: string): string | null {
  if (committed.endsWith(DASH + DASH)) return DASH + DASH;
  const last = committed.slice(-1);
  return ASCII_SYMBOL.test(last) || last in ASCII_OF ? last : null;
}

/**
 * committed:这次上屏后落到文档里的文字;marked:上屏前组字框里最后的样子。
 * 是「被符号顶上屏」就返回拼音原文 + 那个符号(之后再走 asciiPunctuationFor),否则返回 null(原样保留)。
 * 只该用在代码里 —— 调用方先用 inCodeAt 判断。
 */
export function revertSymbolCommit(committed: string, marked: string): string | null {
  if (!HAN.test(committed)) return null;
  const trigger = trailingTrigger(committed);
  if (!trigger || committed.length <= trigger.length) return null;
  const raw = marked.replace(SEPARATORS, "");
  if (!PINYIN_LIKE.test(raw) || raw.endsWith(trigger)) return null;
  return raw + trigger;
}
