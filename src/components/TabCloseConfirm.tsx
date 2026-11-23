import { AlertTriangle } from "lucide-react";
import { useEffect } from "react";
import { useI18n } from "../hooks/useI18n";
import { useApp } from "../store/appStore";

/**
 * 关闭有未保存内容的标签时的确认框。
 *
 * closeTab 是 store 里的同步动作,没法 await 弹框,所以它只把标签 id 排进 closeRequests,
 * 这里逐个问;「关闭全部」碰上几个未保存页面也会一个接一个问,不会互相覆盖。
 */
export default function TabCloseConfirm() {
  const { t } = useI18n();
  const id = useApp((s) => s.closeRequests[0]);
  const tab = useApp((s) => s.tabs.find((x) => x.id === id));
  const orphan = !!id && !tab;
  /* 标签在排队期间被别处关掉了:直接把这条请求答掉,别留个对着空气的弹框。 */
  useEffect(() => { if (orphan) useApp.getState().resolveCloseRequest(false); }, [orphan, id]);
  if (!id || !tab) return null;
  const answer = (discard: boolean) => useApp.getState().resolveCloseRequest(discard);
  return (
    <div className="modal-backdrop" onMouseDown={() => answer(false)}>
      <div className="modal confirm-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") answer(false); }}>
        <div className="modal-head">
          <h3>
            <AlertTriangle size={16} /> 未保存的内容
          </h3>
        </div>
        <div className="modal-body">
          <pre className="confirm-text">「{tab.title}」有未保存内容，关闭后这些修改会丢失。</pre>
        </div>
        <div className="modal-foot">
          <button className="btn" autoFocus onClick={() => answer(false)}>
            {t("action.cancel")}
          </button>
          <button className="btn danger" onClick={() => answer(true)}>
            丢弃并关闭
          </button>
        </div>
      </div>
    </div>
  );
}
