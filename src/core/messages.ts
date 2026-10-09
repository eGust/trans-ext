export type SelectionPayload = { text: string } | { error: "empty" | "too-long" | "restricted" | "unavailable" };
export type SelectionMessage = { type: "selection:take"; token: string };
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isSelectionMessage(value: unknown): value is SelectionMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.type === "selection:take" && typeof message.token === "string" && TOKEN.test(message.token);
}
export function isTrustedSelectionSender(sender: { id?: string; url?: string; tab?: { id?: number } }, extensionId: string, token: string): boolean {
  if (sender.id !== extensionId || !Number.isInteger(sender.tab?.id) || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === "chrome-extension:" && url.host === extensionId && url.pathname === "/selection.html" && url.searchParams.get("request") === token;
  } catch { return false; }
}
export function isOrdinaryPage(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? "");
    return ["http:", "https:"].includes(url.protocol)
      && url.hostname !== "chromewebstore.google.com"
      && !(url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore"))
      && !(url.hostname === "microsoftedge.microsoft.com" && url.pathname.startsWith("/addons"));
  } catch { return false; }
}
