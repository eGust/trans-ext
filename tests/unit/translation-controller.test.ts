import { expect, jest, spyOn, test } from 'bun:test';

import { DEFAULT_PREFERENCES } from '../../src/core/preferences';
import { TranslationController, type TranslationState } from '../../src/core/translation-controller';
import type { TranslationOutcome, TranslateOptions } from '../../src/native-ai/translate';
const outcome = (translatedText: string): TranslationOutcome => ({
	kind: 'translated',
	translatedText,
	sourceText: 'Text',
	sourceLanguage: 'en',
	targetLanguage: 'zh',
	effectiveSourceLanguage: 'en',
	effectiveTargetLanguage: 'zh',
});

test('replaced requests cannot overwrite the latest result, even if a native API ignores abort', async () => {
	const waiting: ((value: TranslationOutcome) => void)[] = [];
	const states: TranslationState[] = [];
	const controller = new TranslationController(
		(state) => states.push(state),
		() =>
			new Promise((resolve) => {
				waiting.push(resolve);
			}),
	);
	const old = controller.run({ text: 'first' }, DEFAULT_PREFERENCES);
	const fresh = controller.run({ text: 'second' }, DEFAULT_PREFERENCES);
	waiting[1]!(outcome('new'));
	await fresh;
	waiting[0]!(outcome('old'));
	await old;
	expect(states.at(-1)).toMatchObject({ status: 'done', result: { translatedText: 'new' } });
});

test('dispose aborts and prevents later updates', async () => {
	let complete!: (value: TranslationOutcome) => void;
	let signal: AbortSignal | undefined;
	const states: TranslationState[] = [];
	const controller = new TranslationController(
		(state) => states.push(state),
		(_request, _preferences, options) => {
			signal = options?.signal;
			return new Promise((resolve) => {
				complete = resolve;
			});
		},
	);
	const work = controller.run({ text: 'text' }, DEFAULT_PREFERENCES);
	controller.dispose();
	const count = states.length;
	complete(outcome('late'));
	await work;
	expect(signal?.aborted).toBe(true);
	expect(states).toHaveLength(count);
});

test('cancel resets state and stops work', async () => {
	const states: TranslationState[] = [];
	const controller = new TranslationController(
		(state) => states.push(state),
		async (_r, _p, options) => {
			controller.cancel();
			options?.signal?.throwIfAborted();
			return outcome('late');
		},
	);
	await controller.run({ text: 'text' }, DEFAULT_PREFERENCES);
	expect(states.at(-1)).toEqual({ status: 'idle' });
});

test('unexpected native errors retain diagnostic details without logging the request', async () => {
	const warnings = spyOn(console, 'warn').mockImplementation(() => {});
	try {
		const states: TranslationState[] = [];
		const error = new DOMException('Native service exited', 'OperationError');
		const controller = new TranslationController(
			(state) => states.push(state),
			async () => {
				throw error;
			},
		);
		await controller.run({ text: 'Private input' }, DEFAULT_PREFERENCES);
		expect(states.at(-1)).toMatchObject({ status: 'error', error: { code: 'unknown' } });
		expect(warnings).toHaveBeenCalledWith('Unexpected native translation error', {
			name: 'OperationError',
			message: 'Native service exited',
		});
		expect(JSON.stringify(warnings.mock.calls)).not.toContain('Private input');
	} finally {
		warnings.mockRestore();
	}
});

test('advancing downloads get a fresh inactivity window for both models and translation', async () => {
	jest.useFakeTimers();
	let options!: TranslateOptions;
	let complete!: (result: TranslationOutcome) => void;
	const states: TranslationState[] = [];
	const controller = new TranslationController(
		(state) => states.push(state),
		(_request, _preferences, opts) => {
			options = opts!;
			return new Promise((resolve, reject) => {
				complete = resolve;
				options.signal!.addEventListener('abort', () => reject(options.signal!.reason));
			});
		},
	);
	const pending = controller.run({ text: 'test' }, DEFAULT_PREFERENCES);
	try {
		for (const model of ['detector', 'translator'] as const) {
			options.onUpdate!({ stage: 'model', model, availability: 'downloadable' });
			for (const progress of [0.1, 0.5, 1]) {
				jest.advanceTimersByTime(90_000);
				expect(options.signal!.aborted).toBe(false);
				options.onUpdate!({ stage: 'download', model, progress });
			}
		}
		options.onUpdate!({ stage: 'translating' });
		jest.advanceTimersByTime(119_999);
		expect(options.signal!.aborted).toBe(false);
		complete(outcome('finished'));
		await pending;
		jest.advanceTimersByTime(120_000);
		expect(states.at(-1)).toMatchObject({ status: 'done' });
		expect(options.signal!.aborted).toBe(false);
	} finally {
		controller.dispose();
		await pending;
		jest.useRealTimers();
	}
});

test('a stalled download still times out even if it repeats the same percentage', async () => {
	jest.useFakeTimers();
	let options!: TranslateOptions;
	const states: TranslationState[] = [];
	const controller = new TranslationController(
		(state) => states.push(state),
		(_request, _preferences, opts) => {
			options = opts!;
			return new Promise((_resolve, reject) => {
				options.signal!.addEventListener('abort', () => reject(options.signal!.reason));
			});
		},
	);
	const pending = controller.run({ text: 'test' }, DEFAULT_PREFERENCES);
	try {
		options.onUpdate!({ stage: 'download', model: 'translator', progress: 0.25 });
		jest.advanceTimersByTime(60_000);
		options.onUpdate!({ stage: 'download', model: 'translator', progress: 0.25 });
		jest.advanceTimersByTime(60_000);
		await pending;
		expect(states.at(-1)).toMatchObject({ status: 'error', error: { code: 'timeout' } });
	} finally {
		controller.dispose();
		await pending;
		jest.useRealTimers();
	}
});
