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
  return { url: url.toString() };
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
