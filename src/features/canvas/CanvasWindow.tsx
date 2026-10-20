/* 独立的链路画布窗口:能和主窗口的数据库并排看(桌面版由 src-tauri/src/canvas_window.rs 打开)。
 * 明暗主题跟着主窗口:主窗口一切,这边通过 storage 事件立刻跟上。 */
import { useEffect } from "react";
import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import { useApp } from "../../store/appStore";
import { applySyntaxTheme, isSyntaxTheme } from "../../store/syntaxThemes";
import { installAppEditKeys } from "../../components/editorKit";
import CanvasOverlay from "./CanvasEditor";

function Toast() {
  const toast = useApp((s) => s.toast);
  if (!toast) return null;
  const Icon = toast.kind === "error" ? CircleX : toast.kind === "success" ? CircleCheck : toast.kind === "warn" ? TriangleAlert : Info;
  return <div className={`toast ${toast.kind}`}><Icon size={15} /><span>{toast.text}</span></div>;
}

async function closeWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

export default function CanvasWindow() {
  useEffect(() => {
    installAppEditKeys();
    const root = document.documentElement;
    root.setAttribute("data-theme", useApp.getState().theme);
    applySyntaxTheme(useApp.getState().syntaxTheme);
    const onStorage = (e: StorageEvent) => {
      if (e.key === "theme" && (e.newValue === "dark" || e.newValue === "light")) root.setAttribute("data-theme", e.newValue);
      if (e.key === "syntaxTheme" && e.newValue && isSyntaxTheme(e.newValue)) applySyntaxTheme(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return (
    <>
      <CanvasOverlay onClose={() => void closeWindow()} standalone />
      <Toast />
    </>
  );
}
