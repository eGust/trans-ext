import { canonicalLanguage } from './language-routing';

// A small V1 catalog. The native browser must confirm each pair at runtime.
export const LANGUAGES = [
	{ tag: 'zh', label: 'Chinese · Simplified' },
	{ tag: 'zh-Hant', label: 'Chinese · Traditional' },
	{ tag: 'en', label: 'English' },
	{ tag: 'ja', label: 'Japanese' },
	{ tag: 'fr', label: 'French' },
	{ tag: 'de', label: 'German' },
	{ tag: 'es', label: 'Spanish' },
	{ tag: 'ko', label: 'Korean' },
] as const;

export function catalogLanguage(tag: string): (typeof LANGUAGES)[number] | undefined {
	try {
		const wanted = new Intl.Locale(canonicalLanguage(tag)).maximize();
		return LANGUAGES.find(({ tag: candidateTag }) => {
			const candidate = new Intl.Locale(candidateTag).maximize();
			return candidate.language === wanted.language && candidate.script === wanted.script;
		});
	} catch {
		return undefined;
	}
}

export function languageLabel(tag: string): string {
	const known = catalogLanguage(tag);
	if (known) return known.label;
	try {
		return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag;
	} catch {
		return tag;
	}
}
