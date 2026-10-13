/* 中文输入法下打 SQL,顺手敲出的是全角标点「;」「,」「(」「)」「。」和弯引号「“”‘’」,SQL 不认。
 * 在代码里(不在字符串、带引号的标识符、注释里)敲出这几个时,直接换成英文的。
 * 字符串和注释里的原样保留 —— 那里本来就可能要中文标点。
 * 输入法可能一次上屏好几个字(比如「完成;」「“你好,世界”」),所以一个字一个字往后看语境,
 * 每次都按「已经换过的」文字算:前面的“换成 " 之后,后面的,就在字符串里了,不该再换;
 * 而结尾的”是在把这个串关上,要换。
 * 语境用 lib/sql.ts 拆语句的同一份扫描器判断。 */
import type { DbKind } from "../types";
import { scanSql, sqlScanState, type SqlScanState } from "./sql";

/** 全角 → 英文。只收 SQL 里一定是标点的几个 */
const ASCII_OF: Record<string, string> = {
  "；": ";", "，": ",", "（": "(", "）": ")", "。": ".",
  "“": "\"", "”": "\"", "‘": "'", "’": "'",
};

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
  if (!typed.split("").some((ch) => ch in ASCII_OF)) return null;
  const before = sqlScanState(textBefore, kind);
  let out = "";
  let changed = false;
  // 按 UTF-16 码元切(和 scanSql 的下标一致;表情这类代理对拆开再拼回去不变)
  for (const ch of typed.split("")) {
    if (ch in ASCII_OF && shouldConvert(ch, out, kind, before)) {
      out += ASCII_OF[ch];
      changed = true;
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
