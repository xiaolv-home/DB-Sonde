import { useMemo, useRef } from "react";
import CodeMirror from "@uiw/react-codemirror";
import {
  sql,
  MySQL,
  PostgreSQL,
  SQLite,
  MariaSQL,
  PLSQL,
  StandardSQL,
  SQLDialect,
  schemaCompletionSource,
  keywordCompletionSource,
} from "@codemirror/lang-sql";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Prec } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  autocompletion,
  completionKeymap,
  type CompletionSource,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import type { DbKind } from "../types";
import type { CompletionCatalog } from "../types";
import type { SQLNamespace } from "@codemirror/lang-sql";
import { keywordUpperEdits, type Edit } from "../lib/keywordCase";
import { asciiPunctuationFor } from "../lib/sqlPunctuation";
import { editorKit } from "./editorKit";


/** As you type or paste, fold SQL *keywords* to upper case once each word is
 *  finished — identifiers (table/column names) are left exactly as written. */
function keywordUpperCase(dialect: SQLDialect, kind: DbKind | undefined) {
  const words =
    (dialect as unknown as { dialect?: { words?: Record<string, unknown> } }).dialect?.words ?? {};
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged) return tr;
    if (!tr.isUserEvent("input.type") && !tr.isUserEvent("input.paste")) return tr;
    const pasted = tr.isUserEvent("input.paste");
    const edits: Edit[] = [];
    tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
      edits.push(...keywordUpperEdits(tr.newDoc, fromB, toB, words, kind, pasted));
    });
    if (!edits.length) return tr;
    return [tr, { changes: edits, sequential: true }];
  });
}

/** 代码里敲出全角分号「;」→ 直接换成英文分号(中文输入法下句末老忘切),规则在 lib/sqlPunctuation.ts。
 *  用 inputHandler 在字符进文档之前换掉:不打断输入法,撤销时也没有多出来的一步。 */
function asciiSemicolon(kind: DbKind | undefined) {
  return EditorView.inputHandler.of((view, from, to, text) => {
    // 输入法还在拼(组字中)时不动它,免得把输入法搅乱;句末单敲的「;」是直接上屏的,不在组字里
    if (view.composing) return false;
    const replacement = asciiPunctuationFor(text, view.state.sliceDoc(0, from), kind);
    if (replacement == null) return false;
    view.dispatch({
      changes: { from, to, insert: replacement },
      selection: { anchor: from + replacement.length },
      userEvent: "input.type",
    });
    return true;
  });
}

/** Flatten a CodeMirror SQL namespace into a plain table→columns map, so we can
 *  offer unprefixed column completions for whatever tables a statement uses. */
function flattenTables(schema: SQLNamespace | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const visit = (ns: SQLNamespace) => {
    for (const [name, val] of Object.entries(ns as Record<string, unknown>)) {
      if (Array.isArray(val)) out[name] = val as string[];
      else if (val && typeof val === "object") visit(val as SQLNamespace);
    }
  };
  if (schema) visit(schema);
  return out;
}

/** DbKind → CodeMirror 的 SQL 方言对象。跟 lib/databaseDialect 的 dialectFor
 *  不是一回事(那个给的是建 SQL 用的语法约定),所以名字分开。 */
function codeMirrorDialect(kind?: DbKind) {
  switch (kind) {
    case "mysql":
      return MySQL;
    case "mariadb":
      return MariaSQL;
    case "postgres":
      return PostgreSQL;
    case "sqlite":
      return SQLite;
    case "oracle":
      return PLSQL;
    default:
      return StandardSQL;
  }
}

export const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--bg)",
    color: "var(--text)",
    height: "100%",
  },
  ".cm-content": {
    caretColor: "var(--accent)",
    padding: "10px 0",
    lineHeight: "1.65",
  },
  ".cm-line": { padding: "0 8px" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--accent)",
    borderLeftWidth: "2px",
    marginLeft: "-1px",
  },
  // Caret glide (first-version feel).
  ".cm-cursorLayer .cm-cursor": {
    transition: "left 55ms ease-out, top 55ms ease-out",
  },
  // Blink as a gentle fade instead of CodeMirror's hard steps() blink.
  // CodeMirror already restarts the blink on every move, so the caret stays
  // solid while you type and fades softly only once you pause — like VSCode.
  ".cm-cursorLayer": { animationTimingFunction: "ease-in-out !important" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    {
      backgroundColor: "var(--sel)",
    },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--surface-2) 55%, transparent)" },
  ".cm-gutters": {
    backgroundColor: "var(--surface)",
    color: "var(--text-3)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--surface-2)" },
  ".cm-tooltip": {
    backgroundColor: "var(--surface-3)",
    border: "1px solid var(--border-2)",
    borderRadius: "8px",
    boxShadow: "var(--shadow)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-ink)",
  },
  ".cm-tooltip-autocomplete ul li": { padding: "3px 8px" },
});

export const highlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword],
    color: "var(--syn-keyword)",
    fontWeight: "600",
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.integer, t.float], color: "var(--syn-number)" },
  { tag: [t.bool, t.null, t.atom], color: "var(--syn-number)", fontWeight: "600" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName],
    color: "var(--syn-func)",
  },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--syn-type)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  {
    tag: [t.operator, t.compareOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator],
    color: "var(--syn-operator)",
  },
  { tag: [t.punctuation, t.separator, t.paren, t.bracket, t.squareBracket], color: "var(--syn-punct)" },
  { tag: [t.variableName, t.propertyName, t.labelName, t.name], color: "var(--syn-variable)" },
]);

export interface EditorAiContext {
  x: number;
  y: number;
  selection: string;
  fullText: string;
  /** Replace the current selection (or insert at the caret when none). */
  replace: (text: string) => void;
  /** Insert at the caret. */
  insert: (text: string) => void;
}

interface Props {
  value: string;
  kind?: DbKind;
  catalog?: CompletionCatalog;
  onChange: (v: string) => void;
  onSelectionChange: (sql: string) => void;
  onRun: () => void;
  /** Right-click in the editor to summon the inline AI popover. */
  onAiInvoke?: (ctx: EditorAiContext) => void;
}

export default function SqlEditor({
  value,
  kind,
  catalog,
  onChange,
  onSelectionChange,
  onRun,
  onAiInvoke,
}: Props) {
  const viewRef = useRef<EditorView | null>(null);
  /* 回调放进 ref,不进 extensions 的依赖。
     父组件传进来的是内联箭头函数(每次渲染都是新的),列进依赖的话
     **每一次父组件重渲染都会重算 extensions**,而 @uiw/react-codemirror 看到
     新数组就会把整个编辑器重新配置一遍(reconfigure)。
     编辑器配置跟"谁来处理回车"无关,不该因为一个函数换了身份就重来。 */
  const handlers = useRef({ onRun, onSelectionChange });
  handlers.current = { onRun, onSelectionChange };

  const extensions = useMemo(
    () => {
      const dialect = codeMirrorDialect(kind);
      const schemaSource = schemaCompletionSource({
        dialect,
        schema: catalog?.schema as SQLNamespace | undefined,
        defaultSchema: catalog?.defaultSchema,
      });
      // Rank schema objects (tables/columns) above SQL keywords, the way
      // DBeaver does — so after FROM you see `demo_sales`, not `DATA`/`DATE`.
      // Needed because auto-uppercasing the typed prefix hands keywords a
      // case-match bonus that would otherwise bury the (lower-case) table names.
      const bump = (r: CompletionResult | null): CompletionResult | null =>
        r ? { ...r, options: r.options.map((o) => ({ ...o, boost: (o.boost ?? 0) + 50 })) } : null;
      const boostedSchema: CompletionSource = (ctx) => {
        const r = schemaSource(ctx);
        return r && "then" in r ? (r as Promise<CompletionResult | null>).then(bump) : bump(r as CompletionResult | null);
      };
      // DBeaver-style: complete *unprefixed* columns from whatever tables the
      // current statement references (lang-sql only does this for a single
      // `defaultTable`). We surface columns of every catalog table named in the
      // statement, ranked above keywords.
      const tableCols = flattenTables(catalog?.schema as SQLNamespace | undefined);
      const tableNames = Object.keys(tableCols);
      const fromColumns: CompletionSource = (ctx) => {
        const word = ctx.matchBefore(/[A-Za-z_]\w*/);
        const at = word ? word.from : ctx.pos;
        if (at > 0 && ctx.state.sliceDoc(at - 1, at) === ".") return null; // qualified — handled by schema source
        if (!word && !ctx.explicit) return null;
        const doc = ctx.state.doc.toString();
        const start = doc.lastIndexOf(";", ctx.pos - 1) + 1;
        const semi = doc.indexOf(";", ctx.pos);
        const stmt = doc.slice(start, semi < 0 ? doc.length : semi);
        // Words used in this statement — cheap lookup instead of a regex per table.
        const used = new Set((stmt.toLowerCase().match(/[a-z_]\w*/g) ?? []));
        const seen = new Set<string>();
        const options = [] as { label: string; type: string; boost: number }[];
        for (const name of tableNames) {
          if (!used.has(name.toLowerCase())) continue;
          for (const col of tableCols[name]) {
            if (seen.has(col)) continue;
            seen.add(col);
            options.push({ label: col, type: "property", boost: 60 });
          }
        }
        return options.length ? { from: at, options, validFor: /^\w*$/ } : null;
      };
      return [
        sql({ dialect, upperCaseKeywords: true }),
        // Prec.highest so our override wins over the editor's default completion
        // config; tables/columns (boosted) rank above keywords, DBeaver-style.
        Prec.highest(
          autocompletion({ override: [fromColumns, boostedSchema, keywordCompletionSource(dialect, true)] }),
        ),
        keywordUpperCase(dialect, kind),
        asciiSemicolon(kind),
        editorTheme,
        syntaxHighlighting(highlight),
        EditorView.lineWrapping,
        editorKit(),
        EditorView.updateListener.of((update) => {
          if (!update.selectionSet && !update.docChanged) return;
          const range = update.state.selection.main;
          handlers.current.onSelectionChange(range.empty ? "" : update.state.sliceDoc(range.from, range.to));
        }),
        Prec.highest(
          keymap.of([
            { key: "Mod-Enter", preventDefault: true, run: () => (handlers.current.onRun(), true) },
            { key: "Shift-Mod-Enter", preventDefault: true, run: () => (handlers.current.onRun(), true) },
            ...completionKeymap,
          ]),
        ),
      ];
    },
    [catalog, kind],
  );

  const onContextMenu = (e: React.MouseEvent) => {
    const view = viewRef.current;
    if (!view || !onAiInvoke) return;
    e.preventDefault();
    const sel = view.state.selection.main;
    const selection = view.state.sliceDoc(sel.from, sel.to);
    const replace = (text: string) => {
      const range = view.state.selection.main;
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: { anchor: range.from + text.length },
      });
      view.focus();
    };
    const insert = (text: string) => {
      const pos = view.state.selection.main.head;
      view.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } });
      view.focus();
    };
    onAiInvoke({ x: e.clientX, y: e.clientY, selection, fullText: view.state.doc.toString(), replace, insert });
  };

  return (
    <div className="cm-host" onContextMenu={onContextMenu}>
      <CodeMirror
        value={value}
        theme="none"
        height="100%"
        // @uiw wraps the editor in a <div class="cm-theme-*">; without an
        // explicit height it grows to fit the content, so `.cm-editor{height:100%}`
        // resolves against an auto-height parent and the editor never scrolls.
        style={{ height: "100%", minHeight: 0 }}
        extensions={extensions}
        onChange={onChange}
        onCreateEditor={(view) => {
          viewRef.current = view;
        }}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          // We supply our own autocompletion (schema-boosted) + completionKeymap
          // in `extensions`, so disable basicSetup's default to avoid a conflict.
          autocompletion: false,
          // 用我们自己的查找 / 替换条(editorSearch),不要 CodeMirror 自带的英文面板
          searchKeymap: false,
          bracketMatching: true,
          closeBrackets: true,
          indentOnInput: true,
        }}
      />
    </div>
  );
}
