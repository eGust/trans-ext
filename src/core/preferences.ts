import { defaultModels, restoreModels, validateModels, type ModelConfig } from '../engines/gemini/config';
import type { EngineId } from '../engines/types';
import { baseLanguage, canonicalLanguage, type LanguagePreferences } from './language-routing';
import { LANGUAGES } from './languages';

export interface VoicePreference {
	voiceName: string;
	lang: string;
	extensionId?: string;
}
export interface Preferences extends LanguagePreferences {
	engine: EngineId;
	geminiModels: ModelConfig[];
	speechRate: number;
	primaryVoice?: VoicePreference;
	secondaryVoice?: VoicePreference;
}
export const DEFAULT_PREFERENCES: Readonly<Preferences> = Object.freeze({
	engine: 'native',
	geminiModels: defaultModels(),
	primaryLanguage: 'zh',
	secondaryLanguage: 'en',
	speechRate: 1,
});
export const PREFERENCES_KEY = 'preferences';

function validateVoice(value: unknown): VoicePreference | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== 'object') throw new Error('Choose a valid voice.');
	const { voiceName, lang, extensionId } = value as Record<string, unknown>;
	if (
		typeof voiceName !== 'string' ||
		!voiceName.trim() ||
		typeof lang !== 'string' ||
		(extensionId !== undefined && typeof extensionId !== 'string')
	)
		throw new Error('Choose a valid voice.');
	return { voiceName, lang: canonicalLanguage(lang), ...(extensionId ? { extensionId } : {}) };
}

export function validatePreferences(value: unknown): Preferences {
	if (!value || typeof value !== 'object') throw new Error('Invalid preferences.');
	const { primaryLanguage, secondaryLanguage, speechRate, primaryVoice, secondaryVoice } = value as Record<
		string,
		unknown
	>;
	if (
		typeof primaryLanguage !== 'string' ||
		typeof secondaryLanguage !== 'string' ||
		!LANGUAGES.some((l) => l.tag === primaryLanguage) ||
		!LANGUAGES.some((l) => l.tag === secondaryLanguage)
	)
		throw new Error('Choose a language from the supported list.');
	if (baseLanguage(primaryLanguage) === baseLanguage(secondaryLanguage))
		throw new Error(
			'Primary and secondary must be different languages. Script and regional variants count as the same language.',
		);
	if (typeof speechRate !== 'number' || !Number.isFinite(speechRate) || speechRate < 0.5 || speechRate > 2)
		throw new Error('Speech rate must be between 0.5× and 2×.');
	const primary = validateVoice(primaryVoice);
	const secondary = validateVoice(secondaryVoice);
	const { engine = 'native', geminiModels = defaultModels() } = value as Record<string, unknown>;
	if (engine !== 'native' && engine !== 'gemini') throw new Error('Choose a valid translation engine.');
	return {
		engine,
		geminiModels: validateModels(geminiModels),
		primaryLanguage,
		secondaryLanguage,
		speechRate,
		...(primary ? { primaryVoice: primary } : {}),
		...(secondary ? { secondaryVoice: secondary } : {}),
	};
}
export function restorePreferences(value: unknown): Preferences {
	// Missing voice fields keep older settings valid. A damaged voice preference
	// must not reset otherwise valid languages, rate, or the other voice.
	const restoreVoice = (voice: unknown) => {
		try {
			return validateVoice(voice);
		} catch {
			return undefined;
		}
	};
	try {
		if (!value || typeof value !== 'object') return { ...DEFAULT_PREFERENCES };
		const stored = value as Record<string, unknown>;
		return validatePreferences({
			...stored,
			engine: stored.engine === 'gemini' ? 'gemini' : 'native',
			geminiModels: restoreModels(stored.geminiModels),
			primaryVoice: restoreVoice(stored.primaryVoice),
			secondaryVoice: restoreVoice(stored.secondaryVoice),
		});
	} catch {
		return { ...DEFAULT_PREFERENCES };
	}
}
export async function loadPreferences(): Promise<Preferences> {
	const stored = await chrome.storage.local.get(PREFERENCES_KEY);
	return restorePreferences(stored[PREFERENCES_KEY]);
}
