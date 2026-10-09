export type EngineId = 'native' | 'gemini';
export type Availability = 'available' | 'downloadable' | 'downloading' | 'unavailable';
export interface EngineRequest {
	text: string;
	sourceLanguage: string;
	targetLanguage: string;
}
export type EngineUpdate =
	| { stage: 'model'; model: 'translator'; availability: Availability }
	| { stage: 'download'; model: 'translator'; progress?: number }
	| { stage: 'translating' }
	| { stage: 'attempt'; model: string }
	| { stage: 'partial'; text: string };
export type FailureKind =
	| 'not-configured'
	| 'disabled'
	| 'auth'
	| 'permission'
	| 'billing'
	| 'precondition'
	| 'quota-day'
	| 'quota-minute'
	| 'timeout'
	| 'network'
	| 'service'
	| 'model-access-denied'
	| 'model-missing'
	| 'bad-request'
	| 'blocked'
	| 'language'
	| 'truncated'
	| 'empty';
export interface Attempt {
	model?: string;
	sent: boolean;
	reason: FailureKind;
	httpStatus?: number;
	providerReason?: string;
	providerMessage?: string;
	retryMs?: number;
}
export interface EngineResult {
	translatedText: string;
	engine: EngineId;
	model?: string;
	attempts: Attempt[];
	effectiveSourceLanguage: string;
	effectiveTargetLanguage: string;
}
export interface TranslationEngine {
	id: EngineId;
	translate(
		request: EngineRequest,
		options: { signal: AbortSignal; onUpdate(update: EngineUpdate): void },
	): Promise<EngineResult>;
}
export class EngineFailure extends Error {
	constructor(public readonly attempts: Attempt[]) {
		super('Gemini could not produce a translation.');
		this.name = 'EngineFailure';
	}
}
