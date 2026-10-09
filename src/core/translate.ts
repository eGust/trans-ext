import { createGeminiEngine } from '../engines/gemini/chain';
import type { ModelConfig } from '../engines/gemini/config';
import { createNativeEngine } from '../engines/native';
import {
	EngineFailure,
	type Attempt,
	type Availability,
	type EngineId,
	type EngineResult,
	type EngineUpdate,
	type TranslationEngine,
} from '../engines/types';
import {
	availability,
	cancellable,
	downloadProgress,
	useSession,
	type NativeEnvironment,
	type CreateOptions,
} from '../native-ai/session';
import { TranslationError, friendlyError } from './errors';
import {
	assessDetection,
	canonicalLanguage,
	chooseTarget,
	validateText,
	type Detection,
	type DetectionAssessment,
	type LanguagePreferences,
} from './language-routing';
export type { NativeEnvironment } from '../native-ai/session';
export type TranslationUpdate =
	| { stage: 'detecting' | 'translating' }
	| { stage: 'detected'; assessment: DetectionAssessment; candidates: Detection[] }
	| { stage: 'model'; model: 'detector' | 'translator'; availability: Availability }
	| { stage: 'download'; model: 'detector' | 'translator'; progress?: number }
	| EngineUpdate;
export interface TranslationRequest {
	engine?: EngineId;
	attempts?: Attempt[];
	text: string;
	sourceLanguageOverride?: string;
	targetLanguageOverride?: string;
}
export interface TranslationOutcome extends EngineResult {
	kind: 'translated';
	sourceText: string;
	sourceLanguage: string;
	targetLanguage: string;
	effectiveSourceLanguage: string;
	effectiveTargetLanguage: string;
	translatedText: string;
	detectionConfidence?: number;
}
export type TranslationResult =
	| TranslationOutcome
	| { kind: 'uncertain'; assessment: DetectionAssessment; candidates: Detection[] };
export interface TranslateOptions {
	environment?: NativeEnvironment;
	signal?: AbortSignal;
	onUpdate?: (update: TranslationUpdate) => void;
	engines?: Partial<Record<EngineId, TranslationEngine>>;
}
export async function translate(
	request: TranslationRequest,
	preferences: LanguagePreferences & { engine?: EngineId; geminiModels?: ModelConfig[] },
	options: TranslateOptions = {},
): Promise<TranslationResult> {
	const text = validateText(request.text);
	const environment = options.environment ?? (globalThis as NativeEnvironment);
	const signal = options.signal ?? new AbortController().signal;
	signal?.throwIfAborted();
	const emit = (update: TranslationUpdate) => {
		if (!signal?.aborted) options.onUpdate?.(update);
	};
	const monitor =
		(model: 'detector' | 'translator'): CreateOptions['monitor'] =>
		(downloadMonitor) =>
			downloadMonitor.addEventListener('downloadprogress', (event) =>
				emit({ stage: 'download', model, progress: downloadProgress(event) }),
			);
	let sourceLanguage: string;
	let detectionConfidence: number | undefined;
	if (request.sourceLanguageOverride) sourceLanguage = canonicalLanguage(request.sourceLanguageOverride);
	else {
		if (!environment.LanguageDetector)
			throw new TranslationError(
				'unavailable',
				'Automatic language detection is unavailable in this browser. Choose a source language, or update your desktop browser.',
			);
		emit({ stage: 'detecting' });
		const state = availability(await cancellable(environment.LanguageDetector.availability(), signal));
		emit({ stage: 'model', model: 'detector', availability: state });
		if (state === 'unavailable')
			throw new TranslationError(
				'unavailable',
				'The language detector model is unavailable. Choose a source language to continue.',
			);
		signal?.throwIfAborted();
		const candidates = await useSession(
			environment.LanguageDetector.create({ signal, monitor: monitor('detector') }),
			signal,
			(session) => session.detect(text, { signal }),
		);
		const assessment = assessDetection(text, candidates);
		emit({ stage: 'detected', assessment, candidates });
		if (!assessment.certain || !assessment.language) return { kind: 'uncertain', assessment, candidates };
		sourceLanguage = assessment.language;
		detectionConfidence = assessment.confidence;
	}
	const targetLanguage = chooseTarget(sourceLanguage, preferences, request.targetLanguageOverride);

	const engineId = request.engine ?? preferences.engine ?? 'native';
	const native = options.engines?.native ?? createNativeEngine(environment);
	let result: EngineResult;
	let attempts = request.attempts ?? [];
	if (engineId === 'gemini') {
		const gemini = options.engines?.gemini ?? createGeminiEngine(preferences.geminiModels);
		try {
			result = await cancellable(
				gemini.translate({ text, sourceLanguage, targetLanguage }, { signal, onUpdate: emit }),
				signal,
			);
		} catch (error) {
			signal.throwIfAborted();
			if (!(error instanceof EngineFailure)) throw error;
			attempts = error.attempts;
			emit({ stage: 'partial', text: '' });
			try {
				result = await native.translate({ text, sourceLanguage, targetLanguage }, { signal, onUpdate: emit });
			} catch (nativeError) {
				signal.throwIfAborted();
				const friendly = friendlyError(nativeError);
				throw new TranslationError(friendly.code, friendly.message, { cause: nativeError, attempts });
			}
			result = { ...result, attempts };
		}
	} else {
		try {
			result = await native.translate({ text, sourceLanguage, targetLanguage }, { signal, onUpdate: emit });
		} catch (error) {
			signal.throwIfAborted();
			if (!attempts.length) throw error;
			const friendly = friendlyError(error);
			throw new TranslationError(friendly.code, friendly.message, { cause: error, attempts });
		}
		result = { ...result, attempts };
	}
	signal.throwIfAborted();
	return { kind: 'translated', sourceText: text, sourceLanguage, targetLanguage, detectionConfidence, ...result };
}
