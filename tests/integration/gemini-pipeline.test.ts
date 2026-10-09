import { expect, test } from 'bun:test';

import { friendlyError, TranslationError } from '../../src/core/errors';
import { DEFAULT_PREFERENCES } from '../../src/core/preferences';
import { translate } from '../../src/core/translate';
import { TranslationController, type TranslationState } from '../../src/core/translation-controller';
import { nativeRetryAttempts } from '../../src/core/translator-interactions';
import { createGeminiEngine } from '../../src/engines/gemini/chain';
import { GeminiStore, type LocalStorage } from '../../src/engines/gemini/usage';
import { EngineFailure, type Attempt, type TranslationEngine } from '../../src/engines/types';
import type { NativeEnvironment } from '../../src/native-ai/session';

const models = ['first', 'second', 'third'].map((id) => ({ id, rpm: 10, tpm: 20_000, rpd: 20 }));
const request = { text: 'A clear English passage for testing translation.', sourceLanguageOverride: 'en' };
const prefs = { ...DEFAULT_PREFERENCES, engine: 'gemini' as const, geminiModels: models };
const native: NativeEnvironment = {
	Translator: {
		availability: async () => 'available',
		create: async () => ({ translate: async () => 'native result', destroy() {} }),
	},
};
function store(key = 'key') {
	const data: Record<string, unknown> = { geminiApiKey: key };
	const storage: LocalStorage = {
		async get() {
			return structuredClone(data);
		},
		async set(values) {
			Object.assign(data, structuredClone(values));
		},
		async remove(keys) {
			for (const name of typeof keys === 'string' ? [keys] : keys) delete data[name];
		},
	};
	return new GeminiStore(storage);
}
function output(text: string, finishReason = 'STOP') {
	return new Response(
		`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason }], usageMetadata: { promptTokenCount: 45 } })}\n\n`,
	);
}

test('chain skips disabled models, advances on access denied and labels the producing model', async () => {
	const calls: string[] = [];
	const gemini = createGeminiEngine([{ ...models[0]!, rpd: 0 }, ...models.slice(1)], {
		store: store(),
		fetcher: async (url) => {
			calls.push(String(url));
			return calls.length === 1 ? new Response('{}', { status: 403 }) : output('online result');
		},
	});
	const result = await translate(request, prefs, { environment: native, engines: { gemini } });
	expect(result).toMatchObject({
		engine: 'gemini',
		model: 'third',
		translatedText: 'online result',
		attempts: [
			{ model: 'first', sent: false, reason: 'disabled' },
			{ model: 'second', reason: 'model-access-denied' },
		],
	});
	expect(calls).toHaveLength(2);
});

test('global auth failure stops the chain, persists its pause and falls back with the same reason', async () => {
	let calls = 0;
	const gemini = createGeminiEngine(models, {
		store: store(),
		fetcher: async () => {
			calls++;
			return Response.json(
				{ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } },
				{ status: 400 },
			);
		},
	});
	expect(await translate(request, prefs, { environment: native, engines: { gemini } })).toMatchObject({
		engine: 'native',
		attempts: [{ reason: 'auth', sent: true }],
	});
	expect(await translate(request, prefs, { environment: native, engines: { gemini } })).toMatchObject({
		engine: 'native',
		attempts: [{ reason: 'auth', sent: false }],
	});
	expect(calls).toBe(1);
});

test('combined native failures retain activation code and attempts; direct retry bypasses Gemini', async () => {
	let calls = 0;
	const gemini = createGeminiEngine(models, {
		store: store(''),
		fetcher: async () => {
			calls++;
			return output('unexpected');
		},
	});
	let error: unknown;
	try {
		await translate(request, prefs, {
			environment: {
				Translator: {
					...native.Translator!,
					create: async () => {
						throw new DOMException('click', 'NotAllowedError');
					},
				},
			},
			engines: { gemini },
		});
	} catch (caught) {
		error = caught;
	}
	const friendly = friendlyError(error);
	expect(friendly).toMatchObject({ code: 'activation', attempts: [{ reason: 'not-configured' }] });
	expect(friendly.message).not.toContain('No online service');
	expect(friendly.message).toContain('Click Translate with built-in AI');
	expect(friendly.message).not.toContain('Click Try again');
	expect(
		await translate({ ...request, engine: 'native', attempts: friendly.attempts }, prefs, {
			environment: native,
			engines: { gemini },
		}),
	).toMatchObject({ engine: 'native', attempts: [{ reason: 'not-configured' }] });
	expect(calls).toBe(0);
});

test('combined errors use one sentence boundary after provider and Settings messages', () => {
	for (const reason of ['auth', 'permission', 'precondition'] as const) {
		const error = friendlyError(
			new TranslationError('unavailable', 'Native unavailable.', {
				attempts: [{ reason, sent: true, providerMessage: 'A prerequisite is not met.' }],
			}),
		);
		expect(error.message).not.toContain('..');
		expect(error.message).toContain('. Built-in AI: Native unavailable.');
	}
});

test('a non-activation failure of direct native retry sends the next run back to Gemini', async () => {
	let geminiCalls = 0;
	let nativeCalls = 0;
	let retry: Attempt[] = [];
	const states: TranslationState[] = [];
	const gemini: TranslationEngine = {
		id: 'gemini',
		async translate(value) {
			if (++geminiCalls === 1) throw new EngineFailure([{ sent: true, reason: 'blocked' }]);
			return {
				engine: 'gemini',
				model: 'first',
				attempts: [],
				translatedText: 'online recovered',
				effectiveSourceLanguage: value.sourceLanguage,
				effectiveTargetLanguage: value.targetLanguage,
			};
		},
	};
	const environment: NativeEnvironment = {
		Translator: {
			...native.Translator!,
			async create() {
				throw new DOMException('native failure', ++nativeCalls === 1 ? 'NotAllowedError' : 'NotSupportedError');
			},
		},
	};
	const controller = new TranslationController(
		(state) => {
			states.push(state);
			if (state.status === 'error') retry = nativeRetryAttempts(state.error);
		},
		(value, settings, options) => translate(value, settings, { ...options, environment, engines: { gemini } }),
	);
	await controller.run(request, prefs);
	expect(retry).toHaveLength(1);
	await controller.run({ ...request, engine: 'native', attempts: retry }, prefs);
	expect(retry).toEqual([]);
	expect(geminiCalls).toBe(1);
	await controller.run(request, prefs);
	expect(geminiCalls).toBe(2);
	expect(states.at(-1)).toMatchObject({
		status: 'done',
		result: { engine: 'gemini', translatedText: 'online recovered' },
	});
});

test('in-stream bad requests do not turn the next translation into a quota skip', async () => {
	const usage = store();
	let calls = 0;
	const gemini = createGeminiEngine([models[0]!], {
		store: usage,
		fetcher: async () => {
			calls++;
			return new Response('data: {"error":{"code":400,"status":"INVALID_ARGUMENT"}}\n\n');
		},
	});
	for (let i = 0; i < 2; i++)
		expect(await translate(request, prefs, { environment: native, engines: { gemini } })).toMatchObject({
			engine: 'native',
			attempts: [{ reason: 'bad-request', sent: true }],
		});
	expect(calls).toBe(2);
	expect((await usage.snapshot(await usage.session())).usage.first?.blockedUntil).toBe(0);
});

test('uncertain detection makes no network request, and abort never falls back', async () => {
	let calls = 0;
	const gemini = createGeminiEngine(models, {
		store: store(),
		fetcher: () => {
			calls++;
			return new Promise(() => {});
		},
	});
	const environment: NativeEnvironment = {
		...native,
		LanguageDetector: {
			availability: async () => 'available',
			create: async () => ({ detect: async () => [{ detectedLanguage: 'en', confidence: 0.4 }], destroy() {} }),
		},
	};
	expect(await translate({ text: 'Hi' }, prefs, { environment, engines: { gemini } })).toMatchObject({
		kind: 'uncertain',
	});
	expect(calls).toBe(0);
	const controller = new AbortController();
	const pending = translate(request, prefs, { environment, signal: controller.signal, engines: { gemini } });
	controller.abort(new DOMException('cancel', 'AbortError'));
	await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});

test('a settings revision change before the storage event returns the controller to idle without fallback', async () => {
	const usage = store();
	let requests = 0;
	let nativeCalls = 0;
	const states: TranslationState[] = [];
	const gemini = createGeminiEngine(models, {
		store: usage,
		fetcher: async () => {
			requests++;
			return output('unexpected');
		},
	});
	const controller = new TranslationController(
		(state) => states.push(state),
		async (input, preferences, options) =>
			translate(input, preferences, {
				...options,
				onUpdate: (update) => {
					options?.onUpdate?.(update);
					if (update.stage === 'attempt') void usage.storage.set({ geminiConfigRevision: 'new-settings' });
				},
				engines: {
					gemini,
					native: {
						id: 'native',
						async translate() {
							nativeCalls++;
							throw new Error('Unexpected fallback');
						},
					},
				},
			}),
	);
	await controller.run(request, prefs);
	expect(states.at(-1)).toEqual({ status: 'idle' });
	expect(states.some((state) => state.status === 'error')).toBe(false);
	expect(requests).toBe(0);
	expect(nativeCalls).toBe(0);
	expect((await usage.snapshot(await usage.session())).usage).toEqual({});
});
