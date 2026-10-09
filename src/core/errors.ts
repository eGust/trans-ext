export type ErrorCode =
	| 'empty'
	| 'too-long'
	| 'invalid-language'
	| 'same-language'
	| 'unavailable'
	| 'activation'
	| 'download'
	| 'cancelled'
	| 'timeout'
	| 'unknown';

export class TranslationError extends Error {
	constructor(
		public readonly code: ErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'TranslationError';
	}
}

export function friendlyError(error: unknown): { code: ErrorCode; message: string } {
	if (error instanceof TranslationError) return { code: error.code, message: error.message };
	const name = error instanceof Error ? error.name : 'Error';
	switch (name) {
		case 'NotAllowedError':
			return {
				code: 'activation',
				message:
					'The browser needs another click to prepare this language pair. Click Try again and keep this window open.',
			};
		case 'NotSupportedError':
			return {
				code: 'unavailable',
				message:
					'The browser could not start this language model. Try another language, update or restart the browser, then retry. No online service will be used.',
			};
		case 'NetworkError':
			return {
				code: 'download',
				message: 'The language model could not be downloaded. Check your connection and retry.',
			};
		case 'AbortError':
			return { code: 'cancelled', message: 'Translation cancelled.' };
		case 'TimeoutError':
			return {
				code: 'timeout',
				message: 'The browser is taking too long. Retry and keep this window open while the model is prepared.',
			};
		default:
			return {
				code: 'unknown',
				message: 'Translation failed. Please retry. If it continues, restart or update your browser.',
			};
	}
}
