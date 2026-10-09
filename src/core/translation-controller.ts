import {
	translate,
	type TranslationRequest,
	type TranslationResult,
	type TranslationUpdate,
} from '../native-ai/translate';
import { friendlyError } from './errors';
import type { LanguagePreferences } from './language-routing';

export type TranslationState =
	| { status: 'idle' }
	| { status: 'working'; update?: TranslationUpdate }
	| { status: 'done'; result: TranslationResult }
	| { status: 'error'; error: ReturnType<typeof friendlyError> };

export class TranslationController {
	private current?: AbortController;
	private disposed = false;
	constructor(
		private onState: (state: TranslationState) => void,
		private execute: typeof translate = translate,
	) {}
	cancel() {
		this.current?.abort();
		this.current = undefined;
		if (!this.disposed) this.onState({ status: 'idle' });
	}
	dispose() {
		this.disposed = true;
		this.cancel();
	}
	async run(request: TranslationRequest, preferences: LanguagePreferences) {
		if (this.disposed) return;
		this.current?.abort();
		const controller = new AbortController();
		this.current = controller;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const clearTimeoutForRequest = () => clearTimeout(timeout);
		const resetTimeout = () => {
			clearTimeoutForRequest();
			timeout = setTimeout(() => controller.abort(new DOMException('Translation timed out', 'TimeoutError')), 120_000);
		};
		const progress: Partial<Record<'detector' | 'translator', number>> = {};
		controller.signal.addEventListener('abort', clearTimeoutForRequest, { once: true });
		resetTimeout();
		this.onState({ status: 'working' });
		try {
			const result = await this.execute(request, preferences, {
				signal: controller.signal,
				onUpdate: (update) => {
					if (this.current !== controller || controller.signal.aborted) return;
					// Ignore repeated numeric progress when refreshing the inactivity timeout.
					if (update.stage !== 'download' || update.progress === undefined) resetTimeout();
					else if (update.progress > (progress[update.model] ?? -1)) {
						progress[update.model] = update.progress;
						resetTimeout();
					}
					this.onState({ status: 'working', update });
				},
			});
			controller.signal.throwIfAborted();
			if (this.current === controller) this.onState({ status: 'done', result });
		} catch (error) {
			if (this.current === controller) {
				const friendly = friendlyError(error);
				if (friendly.code === 'unknown')
					console.warn('Unexpected native translation error', {
						name: error instanceof Error ? error.name : typeof error,
						message: error instanceof Error ? error.message : 'Unknown thrown value',
					});
				this.onState({ status: 'error', error: friendly });
			}
		} finally {
			clearTimeoutForRequest();
			controller.signal.removeEventListener('abort', clearTimeoutForRequest);
			if (this.current === controller) this.current = undefined;
		}
	}
}
