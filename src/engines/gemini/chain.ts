import { EngineFailure, type Attempt, type TranslationEngine } from '../types';
import { generate, type Fetcher } from './client';
import { defaultModels, type ModelConfig } from './config';
import { GeminiRequestError, PAUSE_REASONS } from './errors';
import { estimateInputTokens } from './prompt';
import { GeminiStore } from './usage';

export function createGeminiEngine(
	models: readonly ModelConfig[] = defaultModels(),
	dependencies: { store?: GeminiStore; fetcher?: Fetcher; deadlines?: { idleMs: number; totalMs: number } } = {},
): TranslationEngine {
	return {
		id: 'gemini',
		async translate(request, options) {
			const store = dependencies.store ?? new GeminiStore();
			const session = await store.session();
			options.signal.throwIfAborted();
			if (!session.key) throw new EngineFailure([{ sent: false, reason: 'not-configured' }]);
			const pause = await store.pause(session);
			if (pause) throw new EngineFailure([pause]);
			const attempts: Attempt[] = [];
			for (const model of models) {
				options.signal.throwIfAborted();
				const estimate = estimateInputTokens(request);
				const skipped = await store.skipped(session, model, estimate);
				if (skipped) {
					attempts.push(skipped);
					continue;
				}
				options.signal.throwIfAborted();
				options.onUpdate({ stage: 'attempt', model: model.id });
				const id = await store.sent(session, model.id, estimate);
				options.signal.throwIfAborted();
				try {
					const result = await generate(model.id, session.key, request, {
						...options,
						fetcher: dependencies.fetcher,
						deadlines: dependencies.deadlines,
					});
					if (result.inputTokens !== undefined) await store.tokens(model.id, id, result.inputTokens);
					options.signal.throwIfAborted();
					return {
						translatedText: result.text,
						engine: 'gemini',
						model: model.id,
						attempts,
						effectiveSourceLanguage: request.sourceLanguage,
						effectiveTargetLanguage: request.targetLanguage,
					};
				} catch (error) {
					options.signal.throwIfAborted();
					if (!(error instanceof GeminiRequestError)) throw error;
					if (error.inputTokens !== undefined) await store.tokens(model.id, id, error.inputTokens);
					options.signal.throwIfAborted();
					attempts.push(error.attempt);
					await store.failed(session, error.attempt, error.cooldown, options.signal);
					if (PAUSE_REASONS.has(error.attempt.reason)) break;
				}
			}
			options.signal.throwIfAborted();
			throw new EngineFailure(attempts);
		},
	};
}
