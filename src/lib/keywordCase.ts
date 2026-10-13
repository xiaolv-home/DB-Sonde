/* 打 SQL 时把关键字自动转成大写(DBeaver 那样),表名、列名照你打的原样。
 *
 * 只动「打完了」的词:你在它后面敲了分隔符(空格、逗号、括号、回车……)才算打完。
 * 不能看「光标后面是不是字母」—— 在行尾、或者自动补上的 ) 前面打字时,后面永远不是字母,
 * 于是 order_at 刚打到 order 就被改成 ORDER,接着打成了 ORDER_at。
 * 粘贴进来的一段例外:最后一个词后面要是本来就不是字母,也算打完。
 * 字符串、带引号的标识符、注释里一律不动(语境用 lib/sql.ts 的同一份扫描器判断)。 */
import type { Text } from "@codemirror/state";
import type { DbKind } from "../types";
import { scanSql, sqlScanState } from "./sql";

export type Edit = { from: number; to: number; insert: string };

/**
 * 找出 doc[from..to](这次输入的那段)里打完了的关键字,返回把它们改成大写的编辑。
 * @param words  方言的关键字表(小写为键)
 * @param pasted 这段是粘贴进来的(不是一个字一个字打的)
 */
export function keywordUpperEdits(
  doc: Text,
  from: number,
  to: number,
  words: Record<string, unknown>,
  kind: DbKind | undefined,
  pasted = false,
): Edit[] {
  let start = from;
  while (start > 0 && /\w/.test(doc.sliceString(start - 1, start))) start -= 1;
  const text = doc.sliceString(start, to);
  const nextChar = to < doc.length ? doc.sliceString(to, to + 1) : "";

  // 先把光标前的文本扫一遍拿到语境,再扫这次改动的片段,标出哪些位置是代码区
  const before = sqlScanState(doc.sliceString(0, start), kind);
  const isCode = new Array<boolean>(text.length).fill(false);
  scanSql(text, kind, before, (i) => { isCode[i] = true; });

  const edits: Edit[] = [];
  const n = text.length;
  for (let i = 0; i < n; ) {
    if (!isCode[i] || !/[A-Za-z_]/.test(text[i])) { i += 1; continue; }
    let j = i + 1;
    while (j < n && isCode[j] && /[A-Za-z0-9_]/.test(text[j])) j += 1;
    const word = text.slice(i, j);
    // 后面紧跟着这次输入里的分隔符 → 打完了;一直到输入末尾 → 还在打(粘贴的才看文档里的下一个字)
    const complete = j < n || (pasted && !/[A-Za-z0-9_]/.test(nextChar));
    if (complete && words[word.toLowerCase()] != null && word !== word.toUpperCase()) {
      edits.push({ from: start + i, to: start + j, insert: word.toUpperCase() });
    }
    i = j;
  }
  return edits;
}
