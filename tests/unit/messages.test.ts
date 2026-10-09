import { expect, test } from 'bun:test';

import { isSelectionMessage, isTrustedSelectionSender, isOrdinaryPage } from '../../src/core/messages';
import { SelectionHandoffs } from '../../src/core/selection-handoffs';

const token = 'a9a0c63b-6b0b-4e35-a3d8-4d295d35df28';
function storage() {
	const values: Record<string, unknown> = {};
	return {
		values,
		async get() {
			return { ...values };
		},
		async set(items: Record<string, unknown>) {
			Object.assign(values, items);
		},
		async remove(keys: string | string[]) {
			for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
		},
	};
}

test('validates narrow messages and exact extension document identity', () => {
	expect(isSelectionMessage({ type: 'selection:take', token })).toBe(true);
	for (const message of [null, {}, { type: 'selection:take', token: 'bad' }, { type: 'speak', token }])
		expect(isSelectionMessage(message)).toBe(false);
	const sender = { id: 'abc', url: `chrome-extension://abc/selection.html?request=${token}`, tab: { id: 42 } };
	expect(isTrustedSelectionSender(sender, 'abc', token)).toBe(true);
	expect(isTrustedSelectionSender({ ...sender, url: 'https://example.com' }, 'abc', token)).toBe(false);
	expect(isTrustedSelectionSender({ ...sender, id: 'other' }, 'abc', token)).toBe(false);
	expect(
		isTrustedSelectionSender({ ...sender, url: `chrome-extension://abc/popup.html?request=${token}` }, 'abc', token),
	).toBe(false);
});

test('only ordinary web pages are eligible', () => {
	expect(isOrdinaryPage('https://example.com/article')).toBe(true);
	for (const url of [
		'chrome://settings',
		'edge://extensions',
		'file:///test',
		'https://chromewebstore.google.com/detail/foo',
		'https://microsoftedge.microsoft.com/addons/detail/foo',
	])
		expect(isOrdinaryPage(url)).toBe(false);
});

test('handoffs are bound to a tab, consumed once and survive worker replacement in session memory', async () => {
	const store = storage();
	const first = new SelectionHandoffs(store);
	const id = await first.put(42, { text: 'A selection' });
	const second = new SelectionHandoffs(store);
	expect(await second.take(id, 99)).toBeUndefined();
	expect(await second.take(id, 42)).toEqual({ text: 'A selection' });
	expect(await second.take(id, 42)).toBeUndefined();
	expect(store.values).toEqual({});
});

test('expired and closed-tab handoffs are removed', async () => {
	let now = 0;
	const store = storage();
	const manager = new SelectionHandoffs(store, () => now);
	const id = await manager.put(42, { text: 'A selection' });
	now = 60_001;
	expect(await manager.take(id, 42)).toBeUndefined();
	expect(store.values).toEqual({});
	await manager.put(12, { text: 'Another selection' });
	await manager.removeTab(12);
	expect(store.values).toEqual({});
});

test('never saves oversized text, and concurrent handoffs do not overwrite each other', async () => {
	const store = storage();
	const manager = new SelectionHandoffs(store);
	await expect(manager.put(1, { text: 'x'.repeat(4001) })).rejects.toThrow();
	const [a, b] = await Promise.all([manager.put(1, { text: 'First' }), manager.put(2, { text: 'Second' })]);
	expect(await manager.take(a, 1)).toEqual({ text: 'First' });
	expect(await manager.take(b, 2)).toEqual({ text: 'Second' });
});
