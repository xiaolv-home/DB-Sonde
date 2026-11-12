import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Database } from "lucide-react";
import { useI18n } from "../hooks/useI18n";

const ReadyContext = createContext<(() => void) | undefined>(undefined);

/** Report the first usable page, including an inline error. Later refreshes keep their existing UI. */
export function useWorkspaceReady(ready: boolean) {
  const report = useContext(ReadyContext);
  useEffect(() => { if (ready) report?.(); }, [ready, report]);
}

type Phase = "waiting" | "visible" | "leaving" | "done";
function useOpeningPhase(pending: boolean) {
  const [phase, setPhase] = useState<Phase>(pending ? "waiting" : "done");
  const shownAt = useRef(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (phase === "waiting") {
      if (!pending) setPhase("done");
      else timer = setTimeout(() => { shownAt.current = performance.now(); setPhase("visible"); }, 250);
    } else if (phase === "visible" && !pending) {
      // Once shown, let it remain readable before blending into the completed page.
      timer = setTimeout(() => setPhase("leaving"), Math.max(0, 600 - (performance.now() - shownAt.current)));
    } else if (phase === "leaving") {
      timer = setTimeout(() => setPhase("done"), 240);
    }
    return () => clearTimeout(timer);
  }, [pending, phase]);
  return phase;
}

/** One continuous opening surface covers both connecting and the first metadata read.
 * The children mount behind it, so finishing the connection cannot flash a second spinner.
 * It is confined to one pane; the toolbar, sidebar and tabs stay immediately available. */
export default function WorkspaceOpening({ connected, notice, label, children }: {
  connected: boolean; notice?: string; label: string; children: ReactNode;
}) {
  const { t } = useI18n();
  const [enabled] = useState(!connected);
  const [pageReady, setPageReady] = useState(false);
  const reportReady = useCallback(() => setPageReady(true), []);
  const phase = useOpeningPhase(enabled && !(connected ? pageReady : Boolean(notice)));
  const covered = phase === "waiting" || phase === "visible";
  return <ReadyContext.Provider value={reportReady}>
    <div className="workspace-opening" data-opening-phase={phase}>
      <div className={`workspace-opening-page${covered ? " is-covered" : ""}`} inert={covered} aria-hidden={covered || undefined}>
        {children}
      </div>
      {phase !== "done" && <div className={`workspace-opening-cover ${phase}`} role="status" aria-busy={covered} aria-live="polite">
        <div className="workspace-opening-message">
          <Database size={26} aria-hidden="true" />
          <strong>{t("workspace.opening")}</strong>
          <span>{label}</span>
          <i className="workspace-opening-line" aria-hidden="true" />
        </div>
      </div>}
    </div>
  </ReadyContext.Provider>;
}
