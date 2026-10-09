import { expect, test } from 'bun:test';

import { catalogLanguage, languageLabel } from '../../src/core/languages';
import { DEFAULT_PREFERENCES } from '../../src/core/preferences';
import {
	confidenceLabel,
	escapeAction,
	isComposingInput,
	languageSettingsChanged,
	reusableSourceLanguage,
	settingsChange,
	offerGemini,
	nativeRetryAttempts,
	attemptModelForUpdate,
} from '../../src/core/translator-interactions';
import type { Attempt } from '../../src/engines/types';

const escape = { key: 'Escape', isComposing: false, keyCode: 27, defaultPrevented: false };

test('only fallback activation errors keep the direct native retry', () => {
	const attempts: Attempt[] = [{ model: 'first', sent: true, reason: 'blocked' }];
	expect(nativeRetryAttempts({ code: 'activation', attempts })).toEqual(attempts);
	for (const code of ['download', 'unavailable', 'timeout', 'unknown', 'cancelled'] as const)
		expect(nativeRetryAttempts({ code, attempts })).toEqual([]);
	expect(nativeRetryAttempts({ code: 'activation' })).toEqual([]);
});

test('native fallback clears the Gemini model label before model setup and download', () => {
	expect(attemptModelForUpdate(undefined, { stage: 'attempt', model: 'first' })).toBe('first');
	expect(attemptModelForUpdate('first', { stage: 'partial', text: 'hello' })).toBe('first');
	for (const update of [
		{ stage: 'partial', text: '' },
		{ stage: 'model', model: 'translator', availability: 'downloadable' },
		{ stage: 'download', model: 'translator', progress: 0.5 },
		{ stage: 'translating' },
	] as const)
		expect(attemptModelForUpdate('first', update)).toBeUndefined();
});

test('engine edits cancel affected work but preserve completed results; native ignores Gemini-only edits', () => {
	const online = { ...DEFAULT_PREFERENCES, engine: 'gemini' as const };
	expect(settingsChange(online, DEFAULT_PREFERENCES)).toMatchObject({
		invalidate: false,
		cancel: true,
		clearRetry: true,
		stopSpeech: false,
	});
	expect(settingsChange(online, online, true)).toMatchObject({ invalidate: false, cancel: true, clearRetry: true });
	expect(settingsChange(DEFAULT_PREFERENCES, DEFAULT_PREFERENCES, true)).toMatchObject({
		invalidate: false,
		cancel: false,
		notice: '',
	});
	expect(settingsChange(online, { ...online, primaryLanguage: 'ja' })).toMatchObject({ invalidate: true });
	expect(settingsChange(online, { ...online, speechRate: 1.5 })).toMatchObject({
		invalidate: false,
		cancel: false,
		stopSpeech: true,
	});
});

test('Gemini setup is offered only for actionable native service errors', () => {
	for (const code of ['unavailable', 'download', 'timeout', 'unknown'] as const) {
		expect(offerGemini('native', code)).toBe(true);
		expect(offerGemini('gemini', code)).toBe(false);
	}
	for (const code of ['empty', 'too-long', 'invalid-language', 'same-language', 'activation', 'cancelled'] as const)
		expect(offerGemini('native', code)).toBe(false);
});

test('Escape preserves an idle selection tab and cancels only active work', () => {
	expect(escapeAction(escape, true, false)).toBeUndefined();
	expect(escapeAction(escape, true, true)).toBe('cancel');
	expect(escapeAction(escape, false, false)).toBe('close');
	expect(escapeAction(escape, false, true)).toBe('cancel');
});

test('composition, handled keys, and non-Escape keys cannot cancel or close', () => {
	for (const event of [
		{ ...escape, isComposing: true },
		{ ...escape, keyCode: 229 },
		{ ...escape, defaultPrevented: true },
		{ ...escape, key: 'Enter' },
	]) {
		expect(escapeAction(event, false, false)).toBeUndefined();
		expect(escapeAction(event, true, true)).toBeUndefined();
	}
	expect(escapeAction(escape, false, false, true)).toBeUndefined();
	expect(isComposingInput({ isComposing: true, keyCode: 13 })).toBe(true);
	expect(isComposingInput({ isComposing: false, keyCode: 229 })).toBe(true);
});

test('speech-only changes preserve translation state; language or script changes invalidate it', () => {
	expect(languageSettingsChanged(DEFAULT_PREFERENCES, { ...DEFAULT_PREFERENCES, speechRate: 1.7 })).toBe(false);
	expect(
		languageSettingsChanged(DEFAULT_PREFERENCES, {
			...DEFAULT_PREFERENCES,
			secondaryVoice: { voiceName: 'Alex', lang: 'en-US' },
		}),
	).toBe(false);
	expect(languageSettingsChanged(DEFAULT_PREFERENCES, { ...DEFAULT_PREFERENCES, primaryLanguage: 'zh-Hant' })).toBe(
		true,
	);
	expect(languageSettingsChanged(DEFAULT_PREFERENCES, { ...DEFAULT_PREFERENCES, secondaryLanguage: 'ja' })).toBe(true);
});

test('only confirmed detection is reused and an explicit source takes precedence', () => {
	expect(reusableSourceLanguage('', { certain: false, language: 'zh-Hans' })).toBeUndefined();
	expect(reusableSourceLanguage('', { certain: true, language: 'zh-Hans' })).toBe('zh-Hans');
	expect(reusableSourceLanguage('en', { certain: true, language: 'zh' })).toBe('en');
	expect(reusableSourceLanguage('', undefined)).toBeUndefined();
});

test('confidence is omitted when unknown, while an actual zero stays visible', () => {
	for (const confidence of [undefined, NaN, Infinity, -1, 1.5]) expect(confidenceLabel(confidence)).toBeUndefined();
	expect(confidenceLabel(0)).toBe('0% confidence');
	expect(confidenceLabel(0.99)).toBe('99% confidence');
});

test.each([
	['zh-Hans', 'zh'],
	['zh-CN', 'zh'],
	['zh-TW', 'zh-Hant'],
	['zh-Hant-HK', 'zh-Hant'],
	['en-GB', 'en'],
] as const)('catalog display maps %s to %s without losing script distinctions', (tag, expected) => {
	expect(catalogLanguage(tag)?.tag).toBe(expected);
	expect(languageLabel(tag)).toBe(languageLabel(expected));
});

test('uncatalogued languages or scripts remain distinct choices', () => {
	expect(catalogLanguage('en-Shaw')).toBeUndefined();
	expect(catalogLanguage('sr-Latn')).toBeUndefined();
	expect(catalogLanguage('not_a_tag')).toBeUndefined();
});

test.each(['und', 'UND', 'und-US', 'und-Latn', 'mul', 'zxx'])(
	'unknown language tag %s cannot resolve to a catalog language',
	(tag) => {
		expect(catalogLanguage(tag)).toBeUndefined();
		expect(languageLabel(tag)).not.toBe(languageLabel('en'));
	},
);
