/* 中文输入法下打 SQL,顺手敲出的是全角标点「;」「,」「(」「)」,SQL 不认。
 * 在代码里(不在字符串、带引号的标识符、注释里)敲出这几个时,直接换成英文的。
 * 字符串和注释里的原样保留 —— 那里本来就可能要中文标点。
 * 输入法可能一次上屏好几个字(比如「完成;」),所以一段里每个全角标点各自看语境。
 * 语境用 lib/sql.ts 拆语句的同一份扫描器判断。 */
import type { DbKind } from "../types";
import { scanSql, sqlScanState } from "./sql";

/** 全角 → 英文。只收 SQL 里一定是标点的几个 */
const ASCII_OF: Record<string, string> = { "；": ";", "，": ",", "（": "(", "）": ")" };

/** 在 textBefore 之后输入 typed:把落在代码里的全角标点换成英文的。没有要换的返回 null。 */
export function asciiPunctuationFor(typed: string, textBefore: string, kind: DbKind | undefined): string | null {
  if (!typed.split("").some((ch) => ch in ASCII_OF)) return null;
  const codeAt = new Set<number>();
  scanSql(typed, kind, sqlScanState(textBefore, kind), (i) => { codeAt.add(i); });
  let changed = false;
  // 按 UTF-16 码元切(和 scanSql 的下标一致;表情这类代理对拆开再拼回去不变)
  const out = typed.split("").map((ch, i) => {
    if (ch in ASCII_OF && codeAt.has(i)) { changed = true; return ASCII_OF[ch]; }
    return ch;
  }).join("");
  return changed ? out : null;
}
