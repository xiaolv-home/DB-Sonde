import React from "react";
import ReactDOM from "react-dom/client";
// Self-hosted fonts (bundled locally — no CDN, work offline in Tauri).
// Inter for all UI text; JetBrains Mono only for the SQL editor.
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
import { initializeSecureRepositories } from "./lib/secureRepository";
import "./features/ai/aiConfigRepository";
import "./styles.css";
/* 动效与玻璃层 —— 放在设计系统之后,变量能覆盖 */
import "./motion.css";
import "./features/dashboard/dashboard.css";

// Load/migrate settings before stores initialize; never connect to a database
// as part of credential migration.
void initializeSecureRepositories().then(async () => {
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
  // 独立的链路画布窗口只渲染画布,不带主界面。桌面版由窗口注入 __SONDE_VIEW__;浏览器预览用 ?view=canvas
  const view = (window as { __SONDE_VIEW__?: string }).__SONDE_VIEW__ ?? new URLSearchParams(window.location.search).get("view");
  if (view === "canvas") {
    const { default: CanvasWindow } = await import("./features/canvas/CanvasWindow");
    root.render(<React.StrictMode><CanvasWindow /></React.StrictMode>);
    return;
  }
  const { default: App } = await import("./App");
  root.render(<React.StrictMode><App /></React.StrictMode>);
});
