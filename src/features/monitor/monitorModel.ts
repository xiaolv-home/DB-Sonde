/* 监控中心的数据:接进来的一个个「监控源」。
 *
 * 现在只有一种接入方式 —— 嵌网页(kind: "web"):把任意监控页面原样嵌进来,
 * 在软件里直接登录、点、筛,跟在浏览器里一样。以后要接别的方式(拉接口看状态、
 * 调度平台的告警……)就在 MONITOR_KINDS 里加一种、给它一个视图,列表和存储不用动。 */
import { isIdentifiedList, isNonEmptyText, isRecord, isText } from "../../lib/storedRepository";

export const MONITOR_KINDS = ["web"] as const;
export type MonitorKind = (typeof MONITOR_KINDS)[number];
export const KIND_INFO: Record<MonitorKind, { label: string; hint: string }> = {
  web: { label: "网页", hint: "把监控页面原样嵌进来,登录、点击、筛选和在浏览器里一样" },
};

/**
 * 嵌进来的监控页实际要用的 iframe 权限,多一个都不给。
 * - allow-scripts:图表、点击、筛选都是页面自己的脚本
 * - allow-same-origin:留住页面自己的源。不给的话源变成不透明的,登录 Cookie、
 *   localStorage 和没开 CORS 的同源接口都会失败。外部监控页和本应用不同源,
 *   这两项叠在一起并不能卸掉 sandbox;能卸掉的前提是 iframe 指向本应用自己。
 *   那个口子由 checkUrl 堵住(见 isOwnApp),不要靠拿掉这一项。
 * - allow-forms:在页面上登录、有些筛选是表单提交
 * - allow-popups:页面里 window.open / 新窗口链接;弹窗仍带着这套限制
 * 不要加 allow-top-navigation 及其变体,也不要 allow-popups-to-escape-sandbox:
 * 嵌进来的页面不能把本软件的窗口领走,弹出的窗口也不能卸掉这层限制。
 */
export const MONITOR_FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups";

/** 跟 vite / tauri.conf.json 的 devUrl 端口一致。嵌这个端口等于把本软件再嵌一遍。 */
const DEV_SERVER_PORT = "1420";
/** Tauri 应用页、IPC、asset 用的主机。带不带端口都算本应用。 */
const APP_HOSTS = new Set(["tauri.localhost", "ipc.localhost", "asset.localhost"]);

function bareHost(url: URL): string {
  return url.hostname.replace(/\.+$/, "").toLowerCase();
}

/**
 * 本应用自己的源。Windows 的 NavigationStarting 不报子框架,CSP 的 frame-src 又放行
 * http:,所以 http://tauri.localhost 能进 iframe。再叠上 allow-scripts 和
 * allow-same-origin,页面就和主窗口同源,还能自己把 sandbox 删掉。
 */
function isOwnApp(url: URL): boolean {
  const host = bareHost(url);
  if (APP_HOSTS.has(host)) return true;
  return url.protocol === "http:"
    && (host === "localhost" || host === "127.0.0.1" || host === "[::1]")
    && url.port === DEV_SERVER_PORT;
}

export interface MonitorSource {
  id: string;
  name: string;
  kind: MonitorKind;
  url: string;
  createdAt: number;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** 只收 http/https、不带账号密码的完整网址;返回规范化后的地址或错误说明。 */
export function checkUrl(raw: string): { url: string } | { error: string } {
  const text = raw.trim();
  if (!text) return { error: "请填写网址" };
  let url: URL;
  try {
    // 写了 http:// 之类就照写的解析;javascript: / file: 这类也照原样(下面会拒)。
    // 其余一律当作没写协议补 http:// —— 注意 example.com:8080 里的「example.com:」不是协议。
    const explicit = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(javascript|data|file|about|blob|mailto|tel|vbscript):/i.test(text);
    url = new URL(explicit ? text : `http://${text}`);
  } catch {
    return { error: "网址格式不对,例如 http://192.0.2.10:8080" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "只支持 http / https 网页" };
  if (!url.hostname) return { error: "网址里缺少主机名" };
  if (url.username || url.password) return { error: "不要把账号密码写在网址里,打开页面后在页面上登录" };
  if (isOwnApp(url)) return { error: "不能嵌本软件自己的页面" };
  return { url: url.toString() };
}

/** 能写进 iframe src 的地址。指回本应用时返回 null,调用方不要渲染 iframe。 */
export function monitorFrameSrc(raw: string): string | null {
  const checked = checkUrl(raw);
  return "url" in checked ? checked.url : null;
}

/** 存下来的地址必须已经是规范形式(checkUrl 过一遍不变)。 */
function sameUrl(raw: string): boolean {
  const checked = checkUrl(raw);
  return "url" in checked && checked.url === raw;
}

export function isMonitorSource(v: unknown): v is MonitorSource {
  return isRecord(v) && isText(v.id) && ID.test(v.id) && isNonEmptyText(v.name)
    && isText(v.kind) && (MONITOR_KINDS as readonly string[]).includes(v.kind)
    && isText(v.url) && sameUrl(v.url)
    && typeof v.createdAt === "number" && Number.isFinite(v.createdAt);
}
export const isMonitorList = (v: unknown): v is MonitorSource[] => isIdentifiedList(v, isMonitorSource);

export function newSource(name: string, url: string, now = Date.now()): MonitorSource {
  const id = `m${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  return { id, name: name.trim(), kind: "web", url, createdAt: now };
}

/** 没填名字时用主机名(带端口)当名字。 */
export function defaultName(url: string): string {
  try { return new URL(url).host; } catch { return "监控页"; }
}
