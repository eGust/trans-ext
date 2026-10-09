import { isOrdinaryPage, isSelectionMessage, isTrustedSelectionSender, type SelectionPayload } from "../core/messages";
import { SelectionHandoffs } from "../core/selection-handoffs";
import { readPageSelection, selectionPayload } from "../core/page-selection";

const handoffs = new SelectionHandoffs(chrome.storage.session);
const CONTEXT_SELECTION_TIMEOUT_MS = 500;

async function installMenu() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: "translate-selection", title: "Translate selection", contexts: ["selection"], documentUrlPatterns: ["http://*/*", "https://*/*"] });
}
chrome.runtime.onInstalled.addListener(() => { void installMenu().catch(console.error); });
chrome.runtime.onStartup.addListener(() => { void handoffs.clear().catch(console.error); void installMenu().catch(console.error); });

async function openSelection(payload: SelectionPayload, source?: chrome.tabs.Tab) {
  // Bind the one-use handoff before the extension document can request it.
  const position = source?.id !== undefined && source.index !== undefined && source.windowId !== undefined
    ? { index: source.index + 1, openerTabId: source.id, windowId: source.windowId }
    : {};
  const tab = await chrome.tabs.create({ url: "about:blank", ...position });
  if (tab.id === undefined) throw new Error("Could not open the translation tab.");
  try {
    const token = await handoffs.put(tab.id, payload);
    await chrome.tabs.update(tab.id, { url: chrome.runtime.getURL(`selection.html?request=${token}`) });
  } catch (error) {
    await handoffs.removeTab(tab.id).catch(() => {});
    await chrome.tabs.remove(tab.id).catch(() => {});
    throw error;
  }
}
async function menuSelection(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab): Promise<SelectionPayload> {
  if (!isOrdinaryPage(info.pageUrl)) return { error: "restricted" };
  if (tab?.id !== undefined) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const selection = await Promise.race([
        readPageSelection({ id: tab.id, url: info.pageUrl }, chrome, info.frameId ?? 0),
        new Promise<SelectionPayload>(resolve => {
          timeout = setTimeout(() => resolve({ error: "unavailable" }), CONTEXT_SELECTION_TIMEOUT_MS);
        }),
      ]);
      if ("text" in selection || selection.error === "too-long") return selection;
    } finally { clearTimeout(timeout); }
  }
  // activeTab cannot reach cross-origin frames; use the menu snapshot.
  return selectionPayload(info.selectionText);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "translate-selection") return;
  void menuSelection(info, tab).then(payload => openSelection(payload, tab)).catch(console.error);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "translate-selection") return;
  void (async () => {
    await openSelection(await readPageSelection(tab), tab);
  })().catch(console.error);
});
chrome.runtime.onMessage.addListener((message: unknown, sender, respond) => {
  if (!isSelectionMessage(message) || !isTrustedSelectionSender(sender, chrome.runtime.id, message.token)) return;
  void handoffs.take(message.token, sender.tab!.id!).then(payload => respond(payload ?? { error: "expired" }), () => respond({ error: "unavailable" }));
  return true;
});
