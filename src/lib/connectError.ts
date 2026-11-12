/** Failure text safe to show in the UI. Passwords stay in the backend vault. */
export function publicConnectError(message: string, secret?: string | null): string {
  let text = message.replace(/^Error:\s*/i, "");
  text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*):([^@\s/]+)@/gi, "$1:••••@");
  text = text.replace(/([?&#](?:password|pwd|passwd)=)[^&#\s]*/gi, "$1••••");
  if (secret && secret.length >= 4) text = text.split(secret).join("••••");
  return text;
}
