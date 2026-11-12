import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Keep the current surface intact for its short exit. No delayed mounting,
 * layout animation, or timers that can dismiss a newly opened surface. */
export function useDismissTransition(onDismiss: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(onDismiss);
  const animation = useRef<Animation | null>(null);
  const pending = useRef(false);
  const [closing, setClosing] = useState(false);

  useLayoutEffect(() => { latest.current = onDismiss; }, [onDismiss]);
  useLayoutEffect(() => () => {
    animation.current?.cancel();
    animation.current = null;
  }, []);

  const dismiss = useCallback(() => {
    if (pending.current) return;
    pending.current = true;
    const node = ref.current;
    if (!node?.animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      latest.current();
      return;
    }
    setClosing(true);
    // Sample the current opacity so closing during the entrance never flashes
    // back to a fully opaque panel. animate() also avoids CSS/JS duration drift.
    const exit = node.animate(
      [{ opacity: getComputedStyle(node).opacity }, { opacity: 0 }],
      { duration: 160, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)", fill: "forwards" },
    );
    animation.current = exit;
    void exit.finished.then(() => {
      if (animation.current === exit) latest.current();
    }).catch(() => { /* Unmount cancels the exit; it must not close another surface. */ });
  }, []);

  return { ref, closing, dismiss };
}
