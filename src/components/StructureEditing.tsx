/* 表结构页里双击改东西:表注释、列注释、列的数据类型。
 *
 * 注释:双击 → 输入 → 回车直接改(Esc 或点别处 = 不改)。
 * 数据类型:双击 → 输入 → 回车先做检查(后端把整列数据过一遍,看能不能转成新类型),
 * 弹窗里说清楚结果 —— 有转不过去的就列出例子、不让改;全部能转才给「确认修改」,并把要执行的语句摆出来。 */
import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { api, type ColumnChange, type ColumnChangePlan } from "../lib/api";
import { useApp, type TableTab } from "../store/appStore";

/** 大表改类型要重建整张表,先提醒一句 */
const BIG_TABLE_ROWS = 1_000_000;

/** 双击进入编辑的格子。没给 onCommit 就是只读的普通格子。 */
export function EditableText({ value, display, onCommit, placeholder, mono }: {
  value: string;
  /** 不编辑时显示什么(默认就是 value) */
  display?: ReactNode;
  onCommit?: (next: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (!onCommit) return <>{display ?? value}</>;
  if (draft === null) {
    return <span className="struct-editable" title="双击修改" onDoubleClick={() => setDraft(value)}>{display ?? value}</span>;
  }
  return (
    <input
      className={`input struct-edit-input${mono ? " mono" : ""}`}
      value={draft}
      placeholder={placeholder ?? "回车保存 · Esc 取消"}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      // 点别处 = 不改:改表结构是 DDL,不能因为鼠标点歪了就执行
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") setDraft(null);
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          const next = draft;
          setDraft(null);
          if (next !== value) onCommit(next);
        }
      }}
    />
  );
}

type Pending = { column: string; to: string; plan?: ColumnChangePlan; error?: string; applying?: boolean };

/** 管改注释 / 改类型的请求和改类型的确认弹窗。onChanged:改成功后重新读表结构。 */
export function useStructureEditor(tab: TableTab, estimatedRows: number | null | undefined, onChanged: () => void) {
  const [pending, setPending] = useState<Pending | null>(null);
  const editable = tab.objectKind === "table";
  const target = (column: string | null) => ({ connId: tab.connId, database: tab.database, schema: tab.schema, table: tab.table, column });
  const toast = (kind: "success" | "error", text: string) => useApp.getState().showToast({ kind, text });

  const changeComment = async (column: string | null, text: string) => {
    try {
      await api.applyColumnChange(target(column), { kind: "comment", text: text.trim() });
      toast("success", column ? `已修改 ${column} 的注释` : "已修改表注释");
      onChanged();
    } catch (error) {
      toast("error", `注释没改成:${String(error)}`);
    }
  };

  const changeType = (column: string, to: string) => {
    const wanted = to.trim();
    if (!wanted) return;
    setPending({ column, to: wanted });
    api.planColumnChange(target(column), { kind: "type", to: wanted })
      .then((plan) => setPending((p) => (p && p.column === column && p.to === wanted ? { ...p, plan } : p)))
      .catch((error) => setPending((p) => (p && p.column === column && p.to === wanted ? { ...p, error: String(error) } : p)));
  };

  const confirm = async () => {
    if (!pending?.plan || pending.plan.problem) return;
    setPending({ ...pending, applying: true });
    const change: ColumnChange = { kind: "type", to: pending.to };
    try {
      await api.applyColumnChange(target(pending.column), change);
      toast("success", `已把 ${pending.column} 改成 ${pending.plan.normalizedType ?? pending.to}`);
      setPending(null);
      onChanged();
    } catch (error) {
      setPending({ ...pending, applying: false, error: String(error) });
    }
  };

  const dialog = pending && (
    <TypeChangeDialog pending={pending} estimatedRows={estimatedRows} onCancel={() => { if (!pending.applying) setPending(null); }} onConfirm={() => void confirm()} />
  );

  return {
    /** 视图的列不能这样改 */
    editable,
    onColumnComment: editable ? (column: string) => (text: string) => void changeComment(column, text) : undefined,
    onTableComment: editable ? (text: string) => void changeComment(null, text) : undefined,
    onColumnType: editable ? (column: string) => (to: string) => changeType(column, to) : undefined,
    dialog,
  };
}

function TypeChangeDialog({ pending, estimatedRows, onCancel, onConfirm }: {
  pending: Pending;
  estimatedRows: number | null | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { plan, error, applying } = pending;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  const problem = plan?.problem;
  const ok = plan && !problem && !error;
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal confirm-modal struct-type-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>修改 {pending.column} 的数据类型</h3></div>
        <div className="modal-body struct-type-body">
          {!plan && !error && (
            <p className="struct-checking"><Loader2 size={15} className="spin" /> 正在检查这一列的全部数据能不能转成 {pending.to}…</p>
          )}
          {error && <p className="struct-bad" role="alert"><AlertTriangle size={15} /> {error}</p>}
          {problem && (
            <>
              <p className="struct-bad"><AlertTriangle size={15} /> 检查了 {plan.checkedRows ?? 0} 行,有 <b>{problem.badRows}</b> 行转不成 {plan.normalizedType ?? pending.to},没有修改。</p>
              <table className="struct-samples">
                <thead><tr><th>值</th><th>为什么不行</th></tr></thead>
                <tbody>
                  {problem.samples.map((s, i) => <tr key={i}><td className="mono">{s.value}</td><td>{s.why}</td></tr>)}
                </tbody>
              </table>
              {problem.badRows > problem.samples.length && <p className="muted">只列出前 {problem.samples.length} 个例子。先把这些数据改好,再改类型。</p>}
            </>
          )}
          {ok && (
            <>
              <p className="struct-good"><CheckCircle2 size={15} /> 检查了 {plan.checkedRows ?? 0} 行非空数据,全部能转成 {plan.normalizedType ?? pending.to}。</p>
              {(estimatedRows ?? 0) > BIG_TABLE_ROWS && (
                <p className="struct-warn">这张表大约 {estimatedRows!.toLocaleString()} 行,改类型会重建整张表,期间可能锁表、耗时较长,建议避开业务高峰。</p>
              )}
              <p>将执行:</p>
              <pre className="confirm-text">{plan.sql}</pre>
              <p className="muted">执行前会再检查一遍数据;改完会读回这一列的定义,核对非空、默认值、注释等都没变。</p>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" autoFocus disabled={applying} onClick={onCancel}>{ok ? "取消" : "关闭"}</button>
          {ok && <button className="btn primary" disabled={applying} onClick={onConfirm}>{applying ? "正在修改…" : "确认修改"}</button>}
        </div>
      </div>
    </div>
  );
}
