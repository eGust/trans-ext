import { MAX_TEXT_LENGTH } from './language-routing';
import { isOrdinaryPage, type SelectionPayload } from './messages';

type PageTab = Pick<chrome.tabs.Tab, 'id' | 'url'>;
export interface SelectionBrowser {
	tabs: { query(options: { active: boolean; currentWindow: boolean }): Promise<PageTab[]> };
	scripting: {
		executeScript(options: {
			target: { tabId: number; frameIds?: number[] };
			func: () => string;
		}): Promise<{ result?: unknown }[]>;
	};
}

export function selectionPayload(text: unknown): SelectionPayload {
	if (typeof text !== 'string' || !text.trim()) return { error: 'empty' };
	if (text.length <= MAX_TEXT_LENGTH) return { text };
	const trimmed = text.trim();
	return trimmed.length > MAX_TEXT_LENGTH ? { error: 'too-long' } : { text: trimmed };
}

export async function readPageSelection(
	tab?: PageTab,
	browser: SelectionBrowser = chrome,
	frameId?: number,
): Promise<SelectionPayload> {
	try {
		const active = tab ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0];
		if (active?.id === undefined || active.id < 0 || !isOrdinaryPage(active.url)) return { error: 'restricted' };
		const results = await browser.scripting.executeScript({
			target: { tabId: active.id, ...(frameId === undefined ? {} : { frameIds: [frameId] }) },
			// This function is serialized into the requested frame (main by default). It must not
			// capture extension variables or read unselected form values.
			func: () => {
				const activeElement = document.activeElement;
				if (activeElement instanceof HTMLInputElement && !['text', 'search', 'url', 'tel'].includes(activeElement.type))
					return '';
				if (activeElement instanceof HTMLTextAreaElement || activeElement instanceof HTMLInputElement) {
					return activeElement.value.slice(activeElement.selectionStart ?? 0, activeElement.selectionEnd ?? 0);
				}
				return window.getSelection()?.toString() ?? '';
			},
		});
		return selectionPayload(results[0]?.result);
	} catch {
		return { error: 'unavailable' };
	}
}
