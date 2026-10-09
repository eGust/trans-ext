import { afterEach, expect, jest, spyOn, test } from 'bun:test';

afterEach(() => {
	delete (globalThis as { chrome?: unknown }).chrome;
});

async function background(fail?: 'read' | 'update' | 'storage') {
	const handlers: Record<string, (...args: any[]) => any> = {};
	const session: Record<string, unknown> = {};
	const tabs: { id: number; url: string }[] = [];
	const menus: unknown[] = [];
	const removed: number[] = [];
	const event = (key: string) => ({
		addListener(listener: (...args: any[]) => any) {
			handlers[key] = listener;
		},
	});
	(globalThis as { chrome?: unknown }).chrome = {
		runtime: {
			id: 'test',
			getURL: (path: string) => `chrome-extension://test/${path}`,
			onInstalled: event('installed'),
			onStartup: event('startup'),
			onMessage: event('message'),
		},
		contextMenus: {
			onClicked: event('menu'),
			async removeAll() {},
			create(value: unknown) {
				menus.push(value);
			},
		},
		commands: { onCommand: event('command') },
		storage: {
			session: {
				async get() {
					return { ...session };
				},
				async set(items: Record<string, unknown>) {
					if (fail === 'storage') throw new Error('Storage failed');
					Object.assign(session, items);
				},
				async remove(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) delete session[key];
				},
			},
		},
		tabs: {
			onRemoved: event('removed'),
			async create({ url }: { url: string }) {
				const tab = { id: tabs.length + 1, url };
				tabs.push(tab);
				return tab;
			},
			async update(id: number, { url }: { url: string }) {
				if (fail === 'update') throw new Error('Navigation failed');
				tabs.find((tab) => tab.id === id)!.url = url;
			},
			async remove(id: number) {
				removed.push(id);
			},
			async query() {
				return [{ id: 55, url: 'https://example.com' }];
			},
		},
		scripting: {
			async executeScript() {
				if (fail === 'read') throw new Error('Selection access denied');
				return [{ result: 'A keyboard selection.' }];
			},
		},
	};
	await import(`../../src/entrypoints/background.ts?test=${crypto.randomUUID()}`);
	const settle = async () => {
		for (let i = 0; i < 50; i++) await Promise.resolve();
	};
	return { handlers, session, tabs, menus, removed, settle };
}

test('context menu opens a translation tab with one-use, tab-bound text held only in session memory', async () => {
	const b = await background();
	b.handlers.installed!();
	await b.settle();
	expect(b.menus[0]).toMatchObject({ id: 'translate-selection', contexts: ['selection'] });
	const text = '<img src="https://example.com/tracker"> selected words';
	b.handlers.menu!({ menuItemId: 'translate-selection', selectionText: text, pageUrl: 'https://example.com' });
	await b.settle();
	expect(b.tabs).toHaveLength(1);
	const tab = b.tabs[0]!;
	expect(tab.url).toStartWith('chrome-extension://test/selection.html?request=');
	expect(tab.url).not.toContain('selected');
	const token = new URL(tab.url).searchParams.get('request')!;
	const message = { type: 'selection:take', token };
	const sender = { id: 'test', url: tab.url, tab: { id: tab.id } };
	const result = await new Promise((resolve) => {
		b.handlers.message!(message, sender, resolve);
	});
	expect(result).toEqual({ text });
	expect(b.session).toEqual({});
	const again = await new Promise((resolve) => {
		b.handlers.message!(message, sender, resolve);
	});
	expect(again).toEqual({ error: 'expired' });
});

test('oversized selections produce an error surface without storing the passage', async () => {
	const b = await background();
	b.handlers.menu!({
		menuItemId: 'translate-selection',
		selectionText: 'a'.repeat(4001),
		pageUrl: 'https://example.com',
	});
	await b.settle();
	expect(JSON.stringify(b.session)).not.toContain('a'.repeat(100));
	expect(Object.values(b.session)[0]).toMatchObject({ payload: { error: 'too-long' } });
});

test('context menu reads the clicked frame before opening an adjacent translation tab', async () => {
	const b = await background();
	const text = 'First paragraph.\n\nSecond paragraph.';
	const injection = spyOn(chrome.scripting, 'executeScript').mockImplementation(async () => {
		expect(b.tabs).toHaveLength(0);
		return [{ result: text, frameId: 9, documentId: 'selected-document' }];
	});
	const create = spyOn(chrome.tabs, 'create');
	try {
		b.handlers.menu!(
			{
				menuItemId: 'translate-selection',
				selectionText: 'First paragraph. Second paragraph.',
				pageUrl: 'https://example.com',
				frameId: 9,
			},
			{ id: 42, url: 'https://example.com', index: 3, windowId: 7 },
		);
		await b.settle();
		expect(injection).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 42, frameIds: [9] } }));
		expect(Object.values(b.session)[0]).toMatchObject({ payload: { text } });
		expect(create).toHaveBeenCalledWith({ url: 'about:blank', index: 4, openerTabId: 42, windowId: 7 });
	} finally {
		injection.mockRestore();
		create.mockRestore();
	}
});

test.each(['read', 'empty'] as const)(
	'context-menu %s failures fall back to the browser selection snapshot',
	async (failure) => {
		const b = await background(failure === 'read' ? 'read' : undefined);
		const injection = spyOn(chrome.scripting, 'executeScript');
		if (failure === 'empty') injection.mockImplementation(async () => []);
		try {
			b.handlers.menu!(
				{
					menuItemId: 'translate-selection',
					selectionText: 'Snapshot text',
					pageUrl: 'https://example.com',
					frameId: 8,
				},
				{ id: 42, url: 'https://example.com' },
			);
			await b.settle();
			expect(injection).toHaveBeenCalledTimes(1);
			expect(b.tabs).toHaveLength(1);
			expect(Object.values(b.session)[0]).toMatchObject({ payload: { text: 'Snapshot text' } });
		} finally {
			injection.mockRestore();
		}
	},
);

test.each(['resolve', 'reject'] as const)(
	'a busy frame falls back within 500ms and ignores a late %s',
	async (completion) => {
		const b = await background();
		jest.useFakeTimers();
		let finish!: (results: chrome.scripting.InjectionResult<string>[]) => void;
		let fail!: (error: Error) => void;
		const injection = spyOn(chrome.scripting, 'executeScript').mockImplementation(
			() =>
				new Promise<chrome.scripting.InjectionResult<string>[]>((resolve, reject) => {
					finish = resolve;
					fail = reject;
				}),
		);
		try {
			b.handlers.menu!(
				{
					menuItemId: 'translate-selection',
					selectionText: 'Original menu snapshot',
					pageUrl: 'https://example.com',
					frameId: 9,
				},
				{ id: 42, url: 'https://example.com' },
			);
			await b.settle();
			jest.advanceTimersByTime(499);
			await b.settle();
			expect(b.tabs).toHaveLength(0);
			jest.advanceTimersByTime(1);
			await b.settle();
			expect(b.tabs).toHaveLength(1);
			expect(Object.values(b.session)[0]).toMatchObject({ payload: { text: 'Original menu snapshot' } });
			if (completion === 'resolve') finish([{ frameId: 9, documentId: 'late-document', result: 'A later selection' }]);
			else fail(new Error('Frame closed after timeout'));
			await b.settle();
			expect(b.tabs).toHaveLength(1);
			expect(Object.values(b.session)[0]).toMatchObject({ payload: { text: 'Original menu snapshot' } });
		} finally {
			injection.mockRestore();
			jest.useRealTimers();
		}
	},
);

test('an oversized DOM selection cannot fall back to a shorter menu snapshot', async () => {
	const b = await background();
	const injection = spyOn(chrome.scripting, 'executeScript').mockImplementation(async () => [
		{ frameId: 0, documentId: 'selected-document', result: 'a'.repeat(4001) },
	]);
	try {
		b.handlers.menu!(
			{ menuItemId: 'translate-selection', selectionText: 'Short snapshot', pageUrl: 'https://example.com' },
			{ id: 42, url: 'https://example.com' },
		);
		await b.settle();
		expect(Object.values(b.session)[0]).toMatchObject({ payload: { error: 'too-long' } });
	} finally {
		injection.mockRestore();
	}
});

test('keyboard selections work without the toolbar popup; restricted pages are actionable', async () => {
	const b = await background();
	b.handlers.command!('translate-selection', { id: 42, url: 'https://example.com' });
	await b.settle();
	expect(Object.values(b.session)[0]).toMatchObject({ payload: { text: 'A keyboard selection.' } });
	b.handlers.command!('translate-selection', { id: 43, url: 'chrome://settings' });
	await b.settle();
	expect(Object.values(b.session)[1]).toMatchObject({ payload: { error: 'restricted' } });
});

test('page senders cannot retrieve text; ordinary tab closures need no worker listener', async () => {
	const b = await background();
	b.handlers.menu!({
		menuItemId: 'translate-selection',
		selectionText: 'private test',
		pageUrl: 'https://example.com',
	});
	await b.settle();
	const tab = b.tabs[0]!;
	const token = new URL(tab.url).searchParams.get('request');
	let responded = false;
	b.handlers.message!(
		{ type: 'selection:take', token },
		{ id: 'test', url: 'https://example.com', tab: { id: tab.id } },
		() => {
			responded = true;
		},
	);
	expect(responded).toBe(false);
	expect(Object.keys(b.session)).toHaveLength(1);
	expect(b.handlers.removed).toBeUndefined();
});

test('keyboard selection access failures open one actionable tab', async () => {
	const b = await background('read');
	b.handlers.command!('translate-selection', { id: 42, url: 'https://example.com' });
	await b.settle();
	expect(b.tabs).toHaveLength(1);
	expect(Object.values(b.session)[0]).toMatchObject({ payload: { error: 'unavailable' } });
});

test.each(['update', 'storage'] as const)('keyboard %s failures clean up without opening another tab', async (fail) => {
	const errors = spyOn(console, 'error').mockImplementation(() => {});
	try {
		const b = await background(fail);
		b.handlers.command!('translate-selection', { id: 42, url: 'https://example.com' });
		await b.settle();
		expect(b.tabs).toHaveLength(1);
		expect(b.removed).toEqual([b.tabs[0]!.id]);
		expect(b.session).toEqual({});
		expect(errors).toHaveBeenCalledTimes(1);
	} finally {
		errors.mockRestore();
	}
});

test.each(['succeeds', 'fails'] as const)(
	'preserves the original error when handoff cleanup fails and tab removal %s',
	async (removal) => {
		const b = await background();
		const errors = spyOn(console, 'error').mockImplementation(() => {});
		const original = new Error('Initial session read failed');
		const reads = spyOn(chrome.storage.session, 'get')
			.mockImplementationOnce(async () => {
				throw original;
			})
			.mockImplementationOnce(async () => {
				throw new Error('Cleanup session read failed');
			});
		const remove = spyOn(chrome.tabs, 'remove');
		if (removal === 'fails')
			remove.mockImplementationOnce(async () => {
				throw new Error('Tab cleanup failed');
			});
		try {
			b.handlers.command!('translate-selection', { id: 42, url: 'https://example.com' });
			await b.settle();
			expect(b.tabs).toHaveLength(1);
			expect(reads).toHaveBeenCalledTimes(2);
			expect(remove).toHaveBeenCalledWith(b.tabs[0]!.id);
			expect(errors).toHaveBeenCalledTimes(1);
			expect(errors.mock.calls[0]?.[0]).toBe(original);
		} finally {
			reads.mockRestore();
			remove.mockRestore();
			errors.mockRestore();
		}
	},
);
