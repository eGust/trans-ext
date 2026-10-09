import { expect, test } from 'bun:test';

import { DEFAULT_PREFERENCES, restorePreferences } from '../../src/core/preferences';
import { saveEngineSettings, removeGeminiKey, testGeminiKey } from '../../src/engines/gemini/settings';
import { GeminiStore, type LocalStorage } from '../../src/engines/gemini/usage';

function setup() {
	const data: Record<string, unknown> = {
		preferences: structuredClone(DEFAULT_PREFERENCES),
		geminiApiKey: 'saved-key',
	};
	const storage: LocalStorage = {
		async get() {
			return structuredClone(data);
		},
		async set(values) {
			Object.assign(data, structuredClone(values));
		},
		async remove(keys) {
			for (const key of typeof keys === 'string' ? [keys] : keys) delete data[key];
		},
	};
	return { data, storage, store: new GeminiStore(storage) };
}

test('engine restoration never discards valid language/voice fields when the chain is damaged', () => {
	const prefs = {
		...DEFAULT_PREFERENCES,
		primaryLanguage: 'ja',
		secondaryLanguage: 'fr',
		speechRate: 1.5,
		primaryVoice: { voiceName: 'Kyoko', lang: 'ja-JP' },
		engine: 'broken',
		geminiModels: [null],
	};
	expect(restorePreferences(prefs)).toMatchObject({
		primaryLanguage: 'ja',
		secondaryLanguage: 'fr',
		speechRate: 1.5,
		primaryVoice: prefs.primaryVoice,
		engine: 'native',
	});
});

test('save requires an online key; removal preserves unrelated settings and restores native', async () => {
	const { data, storage, store } = setup();
	await expect(saveEngineSettings({ ...DEFAULT_PREFERENCES, engine: 'gemini' }, '', storage)).rejects.toThrow();
	await saveEngineSettings({ ...DEFAULT_PREFERENCES, engine: 'gemini', primaryLanguage: 'ja' }, 'saved-key', storage);
	const session = await store.session();
	await store.failed(session, { reason: 'billing', sent: true });
	await removeGeminiKey(storage);
	expect(data.geminiApiKey).toBeUndefined();
	expect(data.geminiPause).toBeUndefined();
	expect(data.preferences).toMatchObject({ engine: 'native', primaryLanguage: 'ja' });
});

test('identical Restore defaults explicitly resets availability on Save; cap-only edits do not', async () => {
	const { data, storage, store } = setup();
	const model = DEFAULT_PREFERENCES.geminiModels[0]!;
	await store.failed(await store.session(), { model: model.id, reason: 'model-access-denied', sent: true });
	await saveEngineSettings(
		{ ...DEFAULT_PREFERENCES, geminiModels: DEFAULT_PREFERENCES.geminiModels.map((m) => ({ ...m, rpm: 5 })) },
		'saved-key',
		storage,
	);
	expect((await store.snapshot(await store.session())).availability[model.id]).toBeDefined();
	const current = restorePreferences(data.preferences);
	await saveEngineSettings(current, 'saved-key', storage, true);
	expect((await store.snapshot(await store.session())).availability).toEqual({});
});

test.each(['language', 'speech', 'cap', 'reorder'] as const)(
	'a %s-only save preserves an access-denied record written after its initial read',
	async (change) => {
		const { storage, store } = setup();
		const model = DEFAULT_PREFERENCES.geminiModels[0]!;
		const session = await store.session();
		const get = storage.get.bind(storage);
		storage.get = async (keys) => {
			const snapshot = await get(keys);
			storage.get = get;
			await store.failed(session, { model: model.id, reason: 'model-access-denied', sent: true });
			return snapshot;
		};
		const prefs = { ...structuredClone(DEFAULT_PREFERENCES) };
		if (change === 'language') prefs.primaryLanguage = 'ja';
		if (change === 'speech') prefs.speechRate = 1.5;
		if (change === 'cap') prefs.geminiModels[0]!.rpm++;
		if (change === 'reorder') prefs.geminiModels.reverse();
		await saveEngineSettings(prefs, session.key, storage);
		expect((await store.snapshot(await store.session())).availability[model.id]?.attempt.reason).toBe(
			'model-access-denied',
		);
	},
);

test('key replacement clears key-scoped recovery state but preserves per-model usage and cooldowns', async () => {
	const { storage, store } = setup();
	const session = await store.session();
	const model = DEFAULT_PREFERENCES.geminiModels[0]!;
	await store.sent(session, model.id, 100);
	await store.failed(session, { model: model.id, reason: 'quota-day', sent: true });
	await store.failed(session, { model: model.id, reason: 'model-access-denied', sent: true });
	await store.failed(session, { reason: 'auth', sent: true });
	const before = await store.snapshot(session);
	await saveEngineSettings(DEFAULT_PREFERENCES, 'replacement-key', storage);
	const replacement = await store.session();
	expect(replacement.revision).not.toBe(session.revision);
	expect((await store.snapshot(replacement)).usage).toEqual(before.usage);
	expect((await store.snapshot(replacement)).availability).toEqual({});
	expect(await store.pause(replacement)).toBeUndefined();
	expect(await store.skipped(replacement, model, 100)).toMatchObject({ reason: 'quota-day', sent: false });
});

test('testing another draft key cannot clear a saved key pause, but same-key 200 recovers its model', async () => {
	const { store } = setup();
	const model = DEFAULT_PREFERENCES.geminiModels[0]!;
	const session = await store.session();
	await store.failed(session, { reason: 'permission', sent: true });
	await store.failed(session, { model: model.id, reason: 'model-access-denied', sent: true });
	const fetcher = async (url: string | URL | Request) =>
		String(url).includes(':generateContent')
			? Response.json({ candidates: [{ finishReason: 'MAX_TOKENS' }] })
			: Response.json({ models: [{ name: `models/${model.id}` }] });
	expect(
		(await testGeminiKey('draft-key', [model], { store, fetcher, signal: new AbortController().signal })).status,
	).toBe('pass');
	expect(await store.pause(session)).toBeDefined();
	expect((await store.snapshot(session)).availability[model.id]).toBeDefined();
	const result = await testGeminiKey('saved-key', [model], { store, fetcher, signal: new AbortController().signal });
	expect(result.recoveredModel).toBe(model.id);
	expect(await store.pause(session)).toBeUndefined();
	expect((await store.snapshot(session)).availability[model.id]).toBeUndefined();
});

test('a 429 passes key validation without recovering a disabled model; no listed model preserves pause', async () => {
	const { store } = setup();
	const model = DEFAULT_PREFERENCES.geminiModels[0]!;
	const session = await store.session();
	await store.failed(session, { model: model.id, reason: 'model-access-denied', sent: true });
	const fetcher = async (url: string | URL | Request) =>
		String(url).includes(':generateContent')
			? new Response('{}', { status: 429 })
			: Response.json({ models: [{ name: `models/${model.id}` }] });
	expect(
		(await testGeminiKey(session.key, [model], { store, fetcher, signal: new AbortController().signal })).status,
	).toBe('pass');
	expect((await store.snapshot(session)).availability[model.id]).toBeDefined();
	await store.failed(session, { reason: 'auth', sent: true });
	expect(
		(
			await testGeminiKey(session.key, [model], {
				store,
				fetcher: async () => Response.json({ models: [] }),
				signal: new AbortController().signal,
			})
		).status,
	).toBe('inconclusive');
	expect(await store.pause(session)).toBeDefined();
});

test('a generation completing after key removal cannot restore any saved state', async () => {
	const { store, storage, data } = setup();
	const model = DEFAULT_PREFERENCES.geminiModels[0]!;
	const session = await store.session();
	await store.failed(session, { reason: 'auth', sent: true });
	let complete!: (response: Response) => void;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	const pending = testGeminiKey(session.key, [model], {
		store,
		signal: new AbortController().signal,
		fetcher: async (url) => {
			if (!String(url).includes(':generateContent')) return Response.json({ models: [{ name: `models/${model.id}` }] });
			return new Promise((resolve) => {
				complete = resolve;
				started();
			});
		},
	});
	await ready;
	await removeGeminiKey(storage);
	complete(Response.json({ candidates: [{ finishReason: 'MAX_TOKENS' }] }));
	await pending;
	expect(data.geminiApiKey).toBeUndefined();
	expect(data.geminiPause).toBeUndefined();
	expect((await store.snapshot(await store.session())).availability).toEqual({});
});

test.each([200, 429])('a saved key tested against a draft-only model clears its pause on %s', async (status) => {
	const { store } = setup();
	const session = await store.session();
	const model = { ...DEFAULT_PREFERENCES.geminiModels[0]!, id: 'draft-only-model' };
	await store.failed(session, { reason: 'permission', sent: true });
	await store.failed(session, { model: model.id, reason: 'model-access-denied', sent: true });
	const result = await testGeminiKey(session.key, [model], {
		store,
		signal: new AbortController().signal,
		fetcher: async (url) =>
			String(url).includes(':generateContent')
				? Response.json(status === 200 ? { candidates: [{ finishReason: 'STOP' }] } : {}, { status })
				: Response.json({ models: [{ name: `models/${model.id}` }] }),
	});
	expect(result.status).toBe('pass');
	expect(await store.pause(session)).toBeUndefined();
	expect((await store.snapshot(session)).availability[model.id]).toBeDefined();
});
