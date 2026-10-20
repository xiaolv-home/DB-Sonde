import type { CompletionCatalog, DbKind } from "../../types";

export interface TableSchema {
  table: string;
  columns: string[];
}

const DIALECT: Record<string, string> = {
  mysql: "MySQL",
  mariadb: "MariaDB",
  postgres: "PostgreSQL",
  oracle: "Oracle",
  sqlite: "SQLite",
};

export function dialectName(kind?: DbKind): string {
  return (kind && DIALECT[kind]) || "SQL";
}

/** Flatten the CodeMirror completion namespace into a table→columns list,
 *  recursing through schema/database namespaces and de-duping by table name. */
export function extractTables(catalog?: CompletionCatalog): TableSchema[] {
  if (!catalog?.schema) return [];
  const out = new Map<string, string[]>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    for (const [name, value] of Object.entries(node as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        if (!out.has(name)) out.set(name, value as string[]);
      } else if (value && typeof value === "object") {
        walk(value);
      }
    }
  };
  walk(catalog.schema);
  return [...out.entries()].map(([table, columns]) => ({ table, columns }));
}

/** Lightweight relevance: keep tables whose name (or a column) is mentioned in
 *  the question; if that yields too few, keep everything up to a cap. This is a
 *  placeholder for bge-m3 retrieval (Slice 2) on very wide schemas. */
export function pickRelevantTables(question: string, tables: TableSchema[], cap = 25): TableSchema[] {
  if (tables.length <= cap) return tables;
  const q = question.toLowerCase();
  const scored = tables.filter(
    (t) =>
      q.includes(t.table.toLowerCase()) ||
      t.columns.some((c) => c.length > 2 && q.includes(c.toLowerCase())),
  );
  return (scored.length ? scored : tables).slice(0, cap);
}

function schemaText(tables: TableSchema[]): string {
  return tables
    .map((t) => `- ${t.table}(${t.columns.join(", ")})`)
    .join("\n");
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** A reusable metric definition surfaced to the AI so it reuses口径. */
export interface MetricHint {
  name: string;
  aliases?: string[];
  description?: string; // 口径
  unit?: string;
  sql: string;
}

function metricsText(metrics: MetricHint[]): string {
  return metrics
    .map((m) => {
      const al = m.aliases && m.aliases.length ? ` [别名 ${m.aliases.join("/")}]` : "";
      const head = `- ${m.name}${m.unit ? `(${m.unit})` : ""}${al}${m.description ? `:${m.description}` : ""}`;
      return m.sql ? `${head}\n  \`\`\`sql\n  ${m.sql.replace(/\n/g, "\n  ")}\n  \`\`\`` : head;
    })
    .join("\n");
}

/** Build the message list for an NL→SQL turn. Chinese-first, schema-grounded,
 *  and explicit that generated SQL must not be destructive unless asked. */
export function buildMessages(
  kind: DbKind | undefined,
  tables: TableSchema[],
  history: ChatMessage[],
  question: string,
  metrics: MetricHint[] = [],
  tableContext = "",
): ChatMessage[] {
  const dialect = dialectName(kind);
  const metricsBlock = metrics.length
    ? `\n\n已定义的口径指标(问到相关口径时,优先复用它们的 SQL / 计算方式,保持口径一致):\n${metricsText(metrics)}`
    : "";
  const opsBlock = tableContext
    ? `\n\n相关表的指标口径(回答"谁在用这张表 / 口径是什么"这类问题时以此为准,不要臆测):\n${tableContext}`
    : "";
  const system = `你是资深数据工程师,为 ${dialect} 服务。规则:
1. 只使用下面列出的真实表和列,绝不臆造表名或列名。
2. 若问题是数据查询,用一个 \`\`\`sql 代码块给出可执行 SQL,再用一两句中文解释;除非用户明确要求,只写 SELECT/只读查询,不写 UPDATE/DELETE/DROP 等破坏性语句;需要日期/聚合时按 ${dialect} 语法。
3. 若问题是口径类(如"这个数怎么算的、谁在用这张表、为什么没数据"),直接用中文回答,依据下面的指标口径和「相关表的指标口径」,可以不带 SQL;没有依据的就说未知,别编。
4. 排障建议要具体,给出可执行的下一步;涉及改数/重跑的动作只做建议,让用户自己执行。

当前库的表结构:
${schemaText(tables) || "(暂无可用的表结构)"}${metricsBlock}${opsBlock}`;
  return [{ role: "system", content: system }, ...history, { role: "user", content: question }];
}

export type InlineAction = "review" | "optimize" | "format" | "explain" | "fromComment" | "ask";

const ACTION_INSTRUCTION: Record<Exclude<InlineAction, "ask">, string> = {
  review: "审查下面这段 SQL,指出语法、性能、易错点等问题,并给出修正后的只读 SQL。",
  optimize: "在结果不变的前提下优化下面这段查询,给出优化后的只读 SQL 和一句简述。",
  format: "把下面这段 SQL 规范化并格式化(关键字大写、缩进对齐、逗号对齐),只输出格式化后的 SQL。",
  explain: "用中文清晰解释下面这段 SQL 在做什么、每一步的作用,不需要给出新的 SQL。",
  fromComment: "下面是一段需求 / 注释,请据此写出对应的只读查询 SQL,并用一句话说明思路。",
};

/** Build messages for an in-editor AI action. Read-only is enforced hard. */
export function buildInlineMessages(
  kind: DbKind | undefined,
  tables: TableSchema[],
  action: InlineAction,
  code: string,
  userText?: string,
): ChatMessage[] {
  const dialect = dialectName(kind);
  const system = `你是资深数据库工程师,面向 ${dialect}。硬性规则:
1. 只使用下面列出的真实表和列,绝不臆造。
2. 你只能产出**只读查询(SELECT / WITH … SELECT)**。绝对禁止 UPDATE / DELETE / INSERT / TRUNCATE / CREATE / ALTER / DROP 等任何会改数据或结构的语句;若用户要求这类操作,礼貌拒绝并说明只支持查询。
3. 需要给 SQL 时用一个 \`\`\`sql 代码块;解释用简洁中文。

当前库的表结构:
${schemaText(tables) || "(暂无可用的表结构)"}`;

  const instruction =
    action === "ask"
      ? userText || "请帮我看看下面这段 SQL。"
      : ACTION_INSTRUCTION[action];
  const user = code.trim()
    ? `${instruction}\n\n\`\`\`\n${code.trim()}\n\`\`\``
    : instruction;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** Extract the first ```sql fenced block (or first fenced block) from a reply. */
export function extractSql(text: string): string | null {
  const sqlFence = text.match(/```sql\s*([\s\S]*?)```/i);
  if (sqlFence) return sqlFence[1].trim();
  const anyFence = text.match(/```\s*([\s\S]*?)```/);
  if (anyFence && /\b(select|insert|update|delete|with|create)\b/i.test(anyFence[1])) {
    return anyFence[1].trim();
  }
  return null;
}
