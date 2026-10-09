import type { Attempt, EngineId } from '../engines/types';
import type { ErrorCode } from './errors';
import type { DetectionAssessment } from './language-routing';
import type { Preferences } from './preferences';
import type { TranslationUpdate } from './translate';

type CompositionKey = Pick<KeyboardEvent, 'isComposing' | 'keyCode'>;
type EscapeKey = CompositionKey & Pick<KeyboardEvent, 'key' | 'defaultPrevented'>;

export function nativeRetryAttempts(error: { code: ErrorCode; attempts?: Attempt[] }): Attempt[] {
	return error.code === 'activation' ? (error.attempts ?? []) : [];
}

export function attemptModelForUpdate(previous: string | undefined, update?: TranslationUpdate): string | undefined {
	if (update?.stage === 'attempt') return update.model;
	if (update?.stage === 'partial' && update.text) return previous;
}

export function isComposingInput(event: CompositionKey, composing = false): boolean {
	return composing || event.isComposing || event.keyCode === 229;
}

export function escapeAction(
	event: EscapeKey,
	selection: boolean,
	working: boolean,
	composing = false,
): 'cancel' | 'close' | undefined {
	if (event.key !== 'Escape' || event.defaultPrevented || isComposingInput(event, composing)) return;
	if (working) return 'cancel';
	if (!selection) return 'close';
}

export function languageSettingsChanged(previous: Preferences, next: Preferences): boolean {
	return previous.primaryLanguage !== next.primaryLanguage || previous.secondaryLanguage !== next.secondaryLanguage;
}

export function settingsChange(previous: Preferences, next: Preferences, keyChanged = false, activeEngine?: EngineId) {
	const languages = languageSettingsChanged(previous, next);
	const engine = previous.engine !== next.engine;
	const gemini = keyChanged || JSON.stringify(previous.geminiModels) !== JSON.stringify(next.geminiModels);
	const relevant =
		engine || (gemini && (previous.engine === 'gemini' || next.engine === 'gemini' || activeEngine === 'gemini'));
	const speech =
		previous.speechRate !== next.speechRate ||
		JSON.stringify([previous.primaryVoice, previous.secondaryVoice]) !==
			JSON.stringify([next.primaryVoice, next.secondaryVoice]);
	const notices = [];
	if (languages) notices.push('Language settings updated.');
	if (relevant) notices.push('Translation engine settings updated.');
	if (speech) notices.push('Speech settings updated.');
	return {
		invalidate: languages,
		cancel: languages || relevant,
		clearRetry: languages || relevant,
		stopSpeech: languages || speech,
		notice: notices.join(' '),
	};
}
export function offerGemini(engine: EngineId, code?: ErrorCode): boolean {
	return engine === 'native' && ['unavailable', 'download', 'timeout', 'unknown'].includes(code ?? '');
}

export function reusableSourceLanguage(source: string, detection?: DetectionAssessment): string | undefined {
	return source || (detection?.certain ? detection.language : undefined);
}

export function confidenceLabel(confidence: number | undefined): string | undefined {
	if (confidence === undefined || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return;
	return `${Math.round(confidence * 100)}% confidence`;
}
