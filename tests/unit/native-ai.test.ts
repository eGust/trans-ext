import { expect, test } from 'bun:test';

import { DEFAULT_PREFERENCES } from '../../src/core/preferences';
import { translate, type NativeEnvironment, type TranslationUpdate } from '../../src/native-ai/translate';
const text = 'This is an English paragraph. It has enough content to detect its language reliably.';

function native(
	options: {
		results?: { detectedLanguage: string; confidence?: number }[];
		availability?: string;
		error?: Error;
		translation?: () => Promise<string>;
	} = {},
) {
	const calls: string[] = [];
	const pairs: { sourceLanguage: string; targetLanguage: string }[] = [];
	const environment: NativeEnvironment = {
		LanguageDetector: {
			async availability() {
				calls.push('detector.availability');
				return 'available';
			},
			async create() {
				calls.push('detector.create');
				return {
					async detect() {
						calls.push('detect');
						return options.results ?? [{ detectedLanguage: 'en', confidence: 0.99 }];
					},
					destroy() {
						calls.push('detector.destroy');
					},
				};
			},
		},
		Translator: {
			async availability(pair) {
				pairs.push(pair);
				return options.availability ?? 'available';
			},
			async create(opts) {
				calls.push('translator.create');
				opts.monitor?.({
					addEventListener(_type, listener) {
						listener({ loaded: 0.5, total: 1 });
					},
				});
				if (options.error) throw options.error;
				return {
					async translate() {
						calls.push('translate');
						return options.translation ? await options.translation() : '翻译结果';
					},
					destroy() {
						calls.push('translator.destroy');
					},
				};
			},
		},
	};
	return { environment, calls, pairs };
}

test('empty input does not touch native APIs', async () => {
	const n = native();
	await expect(translate({ text: ' ' }, DEFAULT_PREFERENCES, { environment: n.environment })).rejects.toThrow();
	expect(n.calls).toEqual([]);
});

test('detects, routes, checks availability, translates and destroys both sessions', async () => {
	const n = native();
	const result = await translate({ text }, DEFAULT_PREFERENCES, { environment: n.environment });
	expect(result).toMatchObject({
		kind: 'translated',
		sourceLanguage: 'en',
		targetLanguage: 'zh',
		translatedText: '翻译结果',
	});
	expect(n.pairs).toEqual([{ sourceLanguage: 'en', targetLanguage: 'zh' }]);
	expect(n.calls).toEqual([
		'detector.availability',
		'detector.create',
		'detect',
		'detector.destroy',
		'translator.create',
		'translate',
		'translator.destroy',
	]);
});

test('uncertainty returns candidates without creating a translator', async () => {
	const n = native({
		results: [
			{ detectedLanguage: 'en', confidence: 0.51 },
			{ detectedLanguage: 'fr', confidence: 0.49 },
		],
	});
	expect(await translate({ text }, DEFAULT_PREFERENCES, { environment: n.environment })).toMatchObject({
		kind: 'uncertain',
		assessment: { certain: false },
		candidates: [
			{ detectedLanguage: 'en', confidence: 0.51 },
			{ detectedLanguage: 'fr', confidence: 0.49 },
		],
	});
	expect(n.pairs).toEqual([]);
});

test('source override bypasses detection, including when detector is absent', async () => {
	const n = native();
	delete n.environment.LanguageDetector;
	expect(
		await translate({ text: '你好', sourceLanguageOverride: 'zh-Hant' }, DEFAULT_PREFERENCES, {
			environment: n.environment,
		}),
	).toMatchObject({ sourceLanguage: 'zh-Hant', targetLanguage: 'en' });
	expect(n.calls).not.toContain('detect');
});

test('tries safe variants but never falls back from Traditional Chinese to Simplified', async () => {
	const n = native();
	n.environment.Translator!.availability = async (pair) => {
		n.pairs.push(pair);
		return pair.sourceLanguage === 'zh-Hant' ? 'available' : 'unavailable';
	};
	const result = await translate({ text, sourceLanguageOverride: 'zh-TW' }, DEFAULT_PREFERENCES, {
		environment: n.environment,
	});
	expect(result).toMatchObject({ sourceLanguage: 'zh-TW', effectiveSourceLanguage: 'zh-Hant' });
	expect(n.pairs.map((p) => p.sourceLanguage)).toEqual(['zh-TW', 'zh-Hant']);
});

test('unsupported pairs and missing APIs are actionable errors', async () => {
	const n = native({ availability: 'unavailable' });
	await expect(
		translate({ text, sourceLanguageOverride: 'ja' }, DEFAULT_PREFERENCES, { environment: n.environment }),
	).rejects.toMatchObject({ code: 'unavailable' });
	expect(n.calls).not.toContain('translator.create');
	await expect(translate({ text }, DEFAULT_PREFERENCES, { environment: {} })).rejects.toMatchObject({
		code: 'unavailable',
	});
});

test('downloadable/downloading states and progress are surfaced; failures are not hidden', async () => {
	for (const availability of ['downloadable', 'downloading'] as const) {
		const n = native({ availability });
		const updates: TranslationUpdate[] = [];
		await translate({ text, sourceLanguageOverride: 'en' }, DEFAULT_PREFERENCES, {
			environment: n.environment,
			onUpdate: (update) => updates.push(update),
		});
		expect(updates).toContainEqual({ stage: 'model', model: 'translator', availability });
		expect(updates).toContainEqual({ stage: 'download', model: 'translator', progress: 0.5 });
	}
	const n = native({ error: new DOMException('download failed', 'NetworkError') });
	await expect(
		translate({ text, sourceLanguageOverride: 'en' }, DEFAULT_PREFERENCES, { environment: n.environment }),
	).rejects.toMatchObject({ name: 'NetworkError' });
});

test('cancelled requests do not start; late inference never becomes a result', async () => {
	const controller = new AbortController();
	controller.abort();
	const n = native();
	await expect(
		translate({ text }, DEFAULT_PREFERENCES, { environment: n.environment, signal: controller.signal }),
	).rejects.toThrow();
	expect(n.calls).toEqual([]);
	const late = new AbortController();
	const m = native({
		translation: async () => {
			late.abort();
			return 'obsolete';
		},
	});
	await expect(
		translate({ text, sourceLanguageOverride: 'en' }, DEFAULT_PREFERENCES, {
			environment: m.environment,
			signal: late.signal,
		}),
	).rejects.toThrow();
	expect(m.calls.at(-1)).toBe('translator.destroy');
});

test('native inference errors destroy created sessions', async () => {
	const n = native({
		translation: async () => {
			throw new Error('engine crash');
		},
	});
	await expect(
		translate({ text, sourceLanguageOverride: 'en' }, DEFAULT_PREFERENCES, { environment: n.environment }),
	).rejects.toThrow('engine crash');
	expect(n.calls.at(-1)).toBe('translator.destroy');
});

test('a rejected regional pair may fall back to its supported base tag', async () => {
	const n = native();
	n.environment.Translator!.availability = async (pair) => {
		n.pairs.push(pair);
		if (pair.sourceLanguage === 'en-US') throw new DOMException('Unsupported variant', 'NotSupportedError');
		return 'available';
	};
	expect(
		await translate({ text, sourceLanguageOverride: 'en-US' }, DEFAULT_PREFERENCES, { environment: n.environment }),
	).toMatchObject({ sourceLanguage: 'en-US', effectiveSourceLanguage: 'en' });
});

test('cancellation rejects promptly and destroys a session delivered after cancellation', async () => {
	const n = native();
	const controller = new AbortController();
	let resolve!: (value: { translate(): Promise<string>; destroy(): void }) => void;
	let announce!: () => void;
	const created = new Promise<void>((done) => {
		announce = done;
	});
	let destroyed = 0;
	n.environment.Translator!.create = async () => {
		announce();
		return await new Promise((done) => {
			resolve = done;
		});
	};
	const task = translate({ text, sourceLanguageOverride: 'en' }, DEFAULT_PREFERENCES, {
		environment: n.environment,
		signal: controller.signal,
	});
	await created;
	controller.abort();
	await expect(task).rejects.toThrow();
	resolve({
		async translate() {
			throw new Error('Must not translate');
		},
		destroy() {
			destroyed++;
		},
	});
	for (let i = 0; i < 5; i++) await Promise.resolve();
	expect(destroyed).toBe(1);
});
