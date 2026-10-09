import { friendlyError, TranslationSettingsChangedError } from './errors';
import type { Preferences } from './preferences';
import { redact } from './redact';
import { translate, type TranslationRequest, type TranslationResult, type TranslationUpdate } from './translate';

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
	async run(request: TranslationRequest, preferences: Preferences) {
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
				// A storage revision can be observed before its onChanged event arrives.
				if (error instanceof TranslationSettingsChangedError) {
					this.onState({ status: 'idle' });
					return;
				}
				const friendly = friendlyError(error);
				if (friendly.code === 'unknown')
					console.warn('Unexpected native translation error', {
						name: error instanceof Error ? error.name : typeof error,
						message: error instanceof Error ? redact(error.message, [request.text]) : 'Unknown thrown value',
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
