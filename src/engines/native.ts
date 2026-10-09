import { TranslationError } from '../core/errors';
import { languageCandidates } from '../core/language-routing';
import {
	availability,
	cancellable,
	downloadProgress,
	useSession,
	type NativeEnvironment,
	type Pair,
	type CreateOptions,
} from '../native-ai/session';
import type { Availability, TranslationEngine } from './types';
export function createNativeEngine(
	environment: NativeEnvironment = globalThis as NativeEnvironment,
): TranslationEngine {
	return {
		id: 'native',
		async translate(request, { signal, onUpdate: emit }) {
			const { text, sourceLanguage, targetLanguage } = request;
			const monitor =
				(_model: 'translator'): CreateOptions['monitor'] =>
				(downloadMonitor) =>
					downloadMonitor.addEventListener('downloadprogress', (event) =>
						emit({ stage: 'download', model: 'translator', progress: downloadProgress(event) }),
					);
			if (!environment.Translator)
				throw new TranslationError(
					'unavailable',
					'On-device translation is unavailable in this browser. Use a recent desktop Chrome or Edge with native translation enabled.',
				);
			let chosen: Pair | undefined;
			for (const source of languageCandidates(sourceLanguage)) {
				for (const target of languageCandidates(targetLanguage)) {
					signal?.throwIfAborted();
					const pair = { sourceLanguage: source, targetLanguage: target };
					let state: Availability;
					try {
						state = availability(await cancellable(environment.Translator.availability(pair), signal));
					} catch (error) {
						signal?.throwIfAborted();
						// Some implementations reject unsupported variants instead of returning
						// "unavailable". Try only the already-vetted, script-preserving variants.
						if (error instanceof Error && error.name === 'NotSupportedError') continue;
						throw error;
					}
					if (state !== 'unavailable') {
						emit({ stage: 'model', model: 'translator', availability: state });
						chosen = pair;
						break;
					}
				}
				if (chosen) break;
			}
			if (!chosen)
				throw new TranslationError(
					'unavailable',
					'This language pair is unavailable on this browser. Choose another source or target language.',
				);
			signal?.throwIfAborted();
			const translatedText = await useSession(
				environment.Translator.create({ ...chosen, signal, monitor: monitor('translator') }),
				signal,
				(session) => {
					emit({ stage: 'translating' });
					return session.translate(text, { signal });
				},
			);
			return {
				engine: 'native',
				translatedText,
				effectiveSourceLanguage: chosen.sourceLanguage,
				effectiveTargetLanguage: chosen.targetLanguage,
				attempts: [],
			};
		},
	};
}
