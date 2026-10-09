import { validateText } from "./language-routing";
import type { SelectionPayload } from "./messages";
interface SessionStore { get(): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void>; remove(keys: string | string[]): Promise<void> }
interface Entry { tabId: number; expires: number; payload: SelectionPayload }
const PREFIX = "selection:";
function entry(value: unknown): value is Entry {
  if (!value || typeof value !== "object") return false;
  const e = value as Entry;
  if (!Number.isInteger(e.tabId) || !Number.isFinite(e.expires) || !e.payload || typeof e.payload !== "object") return false;
  if ("text" in e.payload) { try { validateText(e.payload.text); return true; } catch { return false; } }
  return "error" in e.payload && ["empty", "too-long", "restricted", "unavailable"].includes(e.payload.error);
}
// Backed by chrome.storage.session (memory only), never storage.local or sync.
export class SelectionHandoffs {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private store: SessionStore, private now = Date.now) {}
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work); this.queue = next.catch(() => {}); return next;
  }
  private async prune() {
    const data = await this.store.get();
    const stale = Object.entries(data).filter(([key, value]) => key.startsWith(PREFIX) && (!entry(value) || value.expires <= this.now())).map(([key]) => key);
    if (stale.length) await this.store.remove(stale);
    return Object.entries(data).filter(([key, value]) => key.startsWith(PREFIX) && entry(value) && value.expires > this.now()) as [string, Entry][];
  }
  put(tabId: number, payload: SelectionPayload): Promise<string> {
    return this.exclusive(async () => {
      if (!Number.isInteger(tabId)) throw new Error("Invalid destination tab.");
      if ("text" in payload) validateText(payload.text);
      const pending = await this.prune();
      if (pending.length >= 10) await this.store.remove(pending.sort((a, b) => a[1].expires - b[1].expires).slice(0, pending.length - 9).map(([key]) => key));
      const token = crypto.randomUUID();
      await this.store.set({ [PREFIX + token]: { tabId, expires: this.now() + 60_000, payload } });
      return token;
    });
  }
  take(token: string, tabId: number): Promise<SelectionPayload | undefined> {
    return this.exclusive(async () => {
      const pending = await this.prune();
      const found = pending.find(([key, value]) => key === PREFIX + token && value.tabId === tabId);
      if (!found) return;
      await this.store.remove(found[0]);
      return found[1].payload;
    });
  }
  removeTab(tabId: number): Promise<void> {
    return this.exclusive(async () => {
      const pending = await this.prune();
      const keys = pending.filter(([, value]) => value.tabId === tabId).map(([key]) => key);
      if (keys.length) await this.store.remove(keys);
    });
  }
  clear(): Promise<void> { return this.exclusive(async () => { const data = await this.store.get(); const keys = Object.keys(data).filter(key => key.startsWith(PREFIX)); if (keys.length) await this.store.remove(keys); }); }
}
