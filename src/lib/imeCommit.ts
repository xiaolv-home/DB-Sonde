/* 拼音输入法在 SQL 代码里「被符号顶上屏」时,退回成拼音原文。
 *
 * 场景:拼音状态下敲 e、。(组字框里是「e 。」),接着按 shift+8 想打 *。
 * 拼音输入法遇到这种符号键,会先把第一个候选「额。」上屏再跟上 *,于是成了「额.*」,
 * 而本意是 e.*。可有时又确实要用 1-9 / 空格选汉字,不能一刀切。区分办法:
 *   · 用数字 / 空格选字上屏:上屏的只有汉字,后面不跟符号 —— 是真想要汉字,不动;
 *   · 被符号顶上屏:上屏的内容后面紧跟着那个符号 —— 写代码时几乎都是想要拼音原文。
 * 只在代码里这样做(字符串、注释里不动由调用方用 sqlScanState 判断)。 */

const HAN = /\p{Script=Han}/u;
/** 组字框里拼音和标点之间可能夹着空格、分词用的 ' */
const SEPARATORS = /[\s']/g;
/** 拼音原文:字母开头,后面只跟标点(含全角标点),没有汉字和数字 */
const PINYIN_LIKE = /^[A-Za-z]+[^\sA-Za-z0-9\p{Script=Han}]*$/u;
/** 顶上屏的符号:ASCII 标点 / 符号(不是字母、数字、空白) */
const TRIGGER = /^[!-/:-@[-`{-~]$/;

/**
 * committed:这次上屏后落到文档里的文字;marked:上屏前组字框里最后的样子。
 * 是「被符号顶上屏」就返回拼音原文 + 那个符号,否则返回 null(原样保留)。
 */
export function revertSymbolCommit(committed: string, marked: string): string | null {
  if (!HAN.test(committed) || committed.length < 2) return null;
  const trigger = committed.slice(-1);
  if (!TRIGGER.test(trigger)) return null;
  const raw = marked.replace(SEPARATORS, "");
  if (!PINYIN_LIKE.test(raw) || raw.endsWith(trigger)) return null;
  return raw + trigger;
}
