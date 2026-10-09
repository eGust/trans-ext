import { fallbackNotice } from '../engines/labels';
import type { Attempt } from '../engines/types';

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

export class TranslationSettingsChangedError extends Error {
	constructor() {
		super('Translation settings changed');
		this.name = 'TranslationSettingsChangedError';
	}
}

export class TranslationError extends Error {
	readonly attempts?: Attempt[];
	constructor(
		public readonly code: ErrorCode,
		message: string,
		options?: ErrorOptions & { attempts?: Attempt[] },
	) {
		super(message, options);
		this.name = 'TranslationError';
		this.attempts = options?.attempts;
	}
}

function activationMessage(fallback = false): string {
	return `The browser needs another click to prepare this language pair. Click ${fallback ? 'Translate with built-in AI' : 'Try again'} and keep this window open.`;
}

export function friendlyError(error: unknown): { code: ErrorCode; message: string; attempts?: Attempt[] } {
	if (error instanceof TranslationError) {
		const fallback = error.attempts?.length ? fallbackNotice(error.attempts).trimEnd() : '';
		const separator = /[.!?。！？]$/.test(fallback) ? ' ' : '. ';
		const message = error.code === 'activation' ? activationMessage(!!fallback) : error.message;
		return {
			code: error.code,
			message: fallback ? `${fallback}${separator}Built-in AI: ${message}` : message,
			...(error.attempts ? { attempts: error.attempts } : {}),
		};
	}
	const name = error instanceof Error ? error.name : 'Error';
	switch (name) {
		case 'NotAllowedError':
			return {
				code: 'activation',
				message: activationMessage(),
			};
		case 'NotSupportedError':
			return {
				code: 'unavailable',
				message:
					'The browser could not start this language model. Try another language, update or restart the browser, then retry.',
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
