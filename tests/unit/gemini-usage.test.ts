import { expect, test } from 'bun:test';

import { DEFAULT_GEMINI_MODELS, restoreModels, validateModels } from '../../src/engines/gemini/config';
import { GeminiStore, nextPacificMidnight, pacificDay, type LocalStorage } from '../../src/engines/gemini/usage';
import { failureDescription } from '../../src/engines/labels';

function memory() {
	const data: Record<string, unknown> = { geminiApiKey: 'key' };
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
	return { data, storage };
}
const model = { id: 'test-model', rpm: 2, tpm: 100, rpd: 3 };

test.each(['rpm', 'tpm', 'rpd'] as const)('zero %s disables a model without claiming quota exhaustion', async (cap) => {
	const { storage } = memory();
	const store = new GeminiStore(storage);
	const session = await store.session();
	const attempt = await store.skipped(session, { ...model, [cap]: 0 }, 0);
	expect(attempt).toMatchObject({ model: model.id, reason: 'disabled', sent: false });
	expect(failureDescription(attempt!)).toContain('turned off in Settings');
	expect(await store.skipped(session, model, 1)).toBeUndefined();
});

test('restores model fields independently, retains valid zero caps and drops irrecoverable custom entries', () => {
	const first = DEFAULT_GEMINI_MODELS[0]!;
	expect(restoreModels([{ ...first, rpm: 'bad', rpd: 0 }, model, { id: 'custom', rpm: 4 }])).toEqual([
		{ ...first, rpd: 0 },
		model,
	]);
	expect(restoreModels([{ id: '../bad' }])).toEqual([...DEFAULT_GEMINI_MODELS]);
	expect(() => validateModels([model, model])).toThrow();
	expect(() => validateModels([{ ...model, tpm: NaN }])).toThrow();
});

test.each([
	['2026-03-08T08:30:00Z', '2026-03-09T07:00:00Z'],
	['2026-11-01T07:30:00Z', '2026-11-02T08:00:00Z'],
	['2026-10-09T06:59:00Z', '2026-10-09T07:00:00Z'],
] as const)('Pacific midnight accounts for DST from %s', (time, next) => {
	expect(new Date(nextPacificMidnight(Date.parse(time))).toISOString()).toBe(new Date(next).toISOString());
});

test('sent requests consume RPM/TPM/RPD, measured tokens replace estimates, and windows reset', async () => {
	const { storage } = memory();
	let now = Date.parse('2026-10-09T12:00:00Z');
	const store = new GeminiStore(storage, () => now);
	const session = await store.session();
	const id = await store.sent(session, model.id, 60);
	expect((await store.skipped(session, model, 50))?.reason).toBe('quota-minute');
	await store.tokens(model.id, id, 10);
	expect(await store.skipped(session, model, 50)).toBeUndefined();
	await store.sent(session, model.id, 10);
	expect((await store.skipped(session, model, 1))?.reason).toBe('quota-minute');
	now += 60_001;
	expect(await store.skipped(session, model, 1)).toBeUndefined();
	await store.sent(session, model.id, 1);
	expect((await store.skipped(session, model, 1))?.reason).toBe('quota-day');
	now = nextPacificMidnight(now);
	expect(await store.skipped(session, model, 1)).toBeUndefined();
	expect(pacificDay(now)).toBe('2026-10-10');
});

test('403 availability persists, expires at midnight and can recover independently of other models', async () => {
	const { storage } = memory();
	let now = Date.parse('2026-10-09T12:00:00Z');
	let store = new GeminiStore(storage, () => now);
	const session = await store.session();
	await store.failed(session, { model: model.id, sent: true, reason: 'model-access-denied', httpStatus: 403 });
	await store.failed(session, { model: 'missing', sent: true, reason: 'model-missing', httpStatus: 404 });
	store = new GeminiStore(storage, () => now);
	expect(await store.skipped(session, model, 1)).toMatchObject({ sent: false, reason: 'model-access-denied' });
	await store.recoverModel(session, model.id);
	expect(await store.skipped(session, model, 1)).toBeUndefined();
	expect((await store.skipped(session, { ...model, id: 'missing' }, 1))?.reason).toBe('model-missing');
	await store.failed(session, { model: model.id, sent: true, reason: 'model-access-denied' });
	now = nextPacificMidnight(now);
	expect(await store.skipped(session, model, 1)).toBeUndefined();
	expect((await store.skipped(session, { ...model, id: 'missing' }, 1))?.reason).toBe('model-missing');
});

test('pause recovery is bound to saved key and revision; stale work cannot pause a replacement key', async () => {
	const { storage, data } = memory();
	const store = new GeminiStore(storage);
	const session = await store.session();
	await store.failed(session, { sent: true, reason: 'auth' });
	expect(await store.pause(session)).toMatchObject({ reason: 'auth', sent: false });
	expect(await store.recoverPause({ ...session, key: 'draft' })).toBe(false);
	expect(await store.pause(session)).toMatchObject({ reason: 'auth' });
	data.geminiApiKey = 'replacement';
	data.geminiConfigRevision = 'changed';
	expect(await store.recoverPause(session)).toBe(false);
	await store.failed(session, { sent: true, reason: 'billing' });
	expect(await store.pause(await store.session())).toBeUndefined();
});

test('damaged persisted usage and availability recover without resetting other settings', async () => {
	const { storage, data } = memory();
	data.geminiUsage = { [model.id]: { day: 'bad', requests: 'broken', minute: [null] } };
	data.geminiModelAvailability = { invalid: { reason: 'fake' } };
	data.preferences = { primaryLanguage: 'ja' };
	const store = new GeminiStore(storage);
	expect(await store.skipped(await store.session(), model, 1)).toBeUndefined();
	await store.sent(await store.session(), model.id, 1);
	expect(data.preferences).toEqual({ primaryLanguage: 'ja' });
});

test('cancellation during a pending storage read prevents recovery and cooldown writes', async () => {
	const { storage, data } = memory();
	const store = new GeminiStore(storage);
	const session = await store.session();
	await store.failed(session, { sent: true, reason: 'auth' });
	await store.failed(session, { model: model.id, sent: true, reason: 'model-missing' });
	const before = structuredClone(data);
	const originalGet = storage.get.bind(storage);
	let release!: () => void;
	let reading!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		reading = resolve;
	});
	storage.get = async (keys) => {
		reading();
		await gate;
		return originalGet(keys);
	};
	const controller = new AbortController();
	const recovery = store.recoverModel(session, model.id, controller.signal);
	const pause = store.recoverPause(session, controller.signal);
	const cooldown = store.failed(
		session,
		{ model: model.id, sent: true, reason: 'quota-minute' },
		false,
		controller.signal,
	);
	await started;
	controller.abort();
	release();
	await Promise.all([recovery, pause, cooldown]);
	expect(data).toEqual(before);
});
