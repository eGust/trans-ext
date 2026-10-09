import { TranslationError } from './errors';

export const MAX_TEXT_LENGTH = 4000;
export interface LanguagePreferences {
	primaryLanguage: string;
	secondaryLanguage: string;
}
export interface Detection {
	detectedLanguage: string;
	confidence?: number;
}
export type DetectionAssessment = { certain: boolean; language?: string; confidence?: number; reason?: string };

export function canonicalLanguage(tag: string): string {
	try {
		const locale = new Intl.Locale(tag);
		if (['und', 'mul', 'zxx'].includes(locale.language)) throw new Error();
		return locale.baseName;
	} catch {
		throw new TranslationError('invalid-language', 'Choose a known source language to continue.');
	}
}
export function baseLanguage(tag: string): string {
	return new Intl.Locale(canonicalLanguage(tag)).language;
}

export function chooseTarget(source: string, preferences: LanguagePreferences, targetOverride?: string): string {
	const sourceBase = baseLanguage(source);
	if (baseLanguage(preferences.primaryLanguage) === baseLanguage(preferences.secondaryLanguage)) {
		throw new TranslationError(
			'same-language',
			'Choose primary and secondary languages with different base languages.',
		);
	}
	const target = canonicalLanguage(
		targetOverride ??
			(sourceBase === baseLanguage(preferences.primaryLanguage)
				? preferences.secondaryLanguage
				: preferences.primaryLanguage),
	);
	if (sourceBase === baseLanguage(target))
		throw new TranslationError('same-language', 'Source and target must be different languages.');
	return target;
}

export function validateText(text: unknown): string {
	const trimmed = typeof text === 'string' ? text.trim() : '';
	if (!trimmed) throw new TranslationError('empty', 'Enter or select some text to translate.');
	if (trimmed.length > MAX_TEXT_LENGTH)
		throw new TranslationError('too-long', 'Select a shorter passage. The limit is 4,000 characters.');
	return trimmed;
}

export function languageCandidates(tag: string): string[] {
	const canonical = canonicalLanguage(tag);
	const locale = new Intl.Locale(canonical);
	const candidates = [canonical];
	if (locale.language === 'zh') {
		const script = locale.maximize().script;
		if (script === 'Hant') candidates.push('zh-Hant');
		else if (script === 'Hans') {
			if (locale.script) candidates.push('zh-Hans');
			candidates.push('zh');
		}
	} else {
		candidates.push(locale.script ? `${locale.language}-${locale.script}` : locale.language);
	}
	return [...new Set(candidates)];
}

export function assessDetection(text: string, results: readonly Detection[]): DetectionAssessment {
	const sorted = results
		.filter((result) => typeof result.detectedLanguage === 'string')
		.toSorted((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));
	const first = sorted[0];
	let language: string | undefined;
	try {
		if (first) language = canonicalLanguage(first.detectedLanguage);
	} catch {
		/* unknown remains uncertain */
	}
	const confidence =
		typeof first?.confidence === 'number' &&
		Number.isFinite(first.confidence) &&
		first.confidence >= 0 &&
		first.confidence <= 1
			? first.confidence
			: undefined;
	const uncertain = (reason: string): DetectionAssessment => ({ certain: false, language, confidence, reason });
	if (!language) return uncertain('The source language could not be identified. Choose it below.');
	const letters = text.match(/\p{L}/gu) ?? [];
	if (letters.length < 12) return uncertain('Short text can be ambiguous. Confirm the source language below.');
	if (confidence === undefined || confidence < 0.8)
		return uncertain('Detection is uncertain. Confirm the source language below.');
	const competitor = sorted.find((candidate) => {
		try {
			return (
				baseLanguage(candidate.detectedLanguage) !== baseLanguage(language!) && candidate.detectedLanguage !== 'und'
			);
		} catch {
			return false;
		}
	});
	if (competitor?.confidence !== undefined && confidence - competitor.confidence < 0.2)
		return uncertain('Several languages are plausible. Confirm the source language below.');
	// Require a four-word Latin phrase for the mixed-script warning.
	const latin = (text.match(/\p{Script=Latin}/gu) ?? []).length;
	const eastAsian = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? [])
		.length;
	const latinPhrase =
		/\p{Script=Latin}[\p{Script=Latin}\p{M}'’-]*(?:\s+\p{Script=Latin}[\p{Script=Latin}\p{M}'’-]*){3}/u.test(text);
	if (
		latinPhrase &&
		latin >= 8 &&
		eastAsian >= 6 &&
		latin / letters.length > 0.15 &&
		eastAsian / letters.length > 0.15
	) {
		return uncertain('This passage appears to mix languages. Choose the predominant source language below.');
	}
	return { certain: true, language, confidence };
}
