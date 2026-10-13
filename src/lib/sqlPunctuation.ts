/* 中文输入法下打 SQL,句末顺手敲出的是全角分号「;」,SQL 不认。
 * 在代码里(不在字符串、带引号的标识符、注释里)敲出全角分号时,直接换成英文分号。
 * 字符串和注释里的「;」原样保留 —— 那里本来就可能要中文标点。
 * 输入法可能一次上屏好几个字(比如「完成;」),所以一段里每个全角分号各自看语境。
 * 语境用 lib/sql.ts 拆语句的同一份扫描器判断。 */
import type { DbKind } from "../types";
import { scanSql, sqlScanState } from "./sql";

const FULLWIDTH_SEMICOLON = "；";

/** 在 textBefore 之后输入 typed:把落在代码里的全角分号换成英文分号。没有要换的返回 null。 */
export function asciiPunctuationFor(typed: string, textBefore: string, kind: DbKind | undefined): string | null {
  if (!typed.includes(FULLWIDTH_SEMICOLON)) return null;
  const codeAt = new Set<number>();
  scanSql(typed, kind, sqlScanState(textBefore, kind), (i) => { codeAt.add(i); });
  let changed = false;
  // 按 UTF-16 码元切(和 scanSql 的下标一致;表情这类代理对拆开再拼回去不变)
  const out = typed.split("").map((ch, i) => {
    if (ch === FULLWIDTH_SEMICOLON && codeAt.has(i)) { changed = true; return ";"; }
    return ch;
  }).join("");
  return changed ? out : null;
}
