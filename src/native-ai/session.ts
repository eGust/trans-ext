import { TranslationError } from '../core/errors';
import type { Detection } from '../core/language-routing';
import type { Availability } from '../engines/types';

export interface Pair {
	sourceLanguage: string;
	targetLanguage: string;
}
interface Session {
	destroy(): void;
}
interface Progress {
	loaded?: number;
	total?: number;
}
export interface CreateOptions {
	signal?: AbortSignal;
	monitor?: (monitor: {
		addEventListener(type: 'downloadprogress', listener: (event: Progress) => void): void;
	}) => void;
}
export interface NativeEnvironment {
	LanguageDetector?: {
		availability(): Promise<string>;
		create(
			options?: CreateOptions,
		): Promise<Session & { detect(text: string, options?: { signal?: AbortSignal }): Promise<Detection[]> }>;
	};
	Translator?: {
		availability(pair: Pair): Promise<string>;
		create(
			options: Pair & CreateOptions,
		): Promise<Session & { translate(text: string, options?: { signal?: AbortSignal }): Promise<string> }>;
	};
}

export function downloadProgress({ loaded, total }: Progress): number | undefined {
	if (typeof loaded !== 'number' || !Number.isFinite(loaded) || loaded < 0) return;
	if (total === undefined) return loaded <= 1 ? loaded : undefined;
	if (!Number.isFinite(total) || total <= 0) return;
	return Math.min(loaded / total, 1);
}
export function availability(value: string): Availability {
	if (!['available', 'downloadable', 'downloading', 'unavailable'].includes(value))
		throw new TranslationError(
			'unavailable',
			'This browser returned an unsupported model status. Update the browser and retry.',
		);
	return value as Availability;
}

// Abort promptly even if a browser implementation fails to settle its promise.
// A session created after cancellation is still destroyed when it arrives.
export function cancellable<T>(pending: Promise<T>, signal?: AbortSignal, onLate?: (value: T) => void): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
		if (signal?.aborted) abort();
		else signal?.addEventListener('abort', abort, { once: true });
		pending
			.then((value) => {
				if (signal?.aborted) onLate?.(value);
				else resolve(value);
			}, reject)
			.finally(() => signal?.removeEventListener('abort', abort));
	});
}
export async function useSession<T extends Session, R>(
	pending: Promise<T>,
	signal: AbortSignal | undefined,
	use: (session: T) => Promise<R>,
): Promise<R> {
	const session = await cancellable(pending, signal, (lateSession) => lateSession.destroy());
	let destroyed = false;
	const destroy = () => {
		if (!destroyed) {
			destroyed = true;
			session.destroy();
		}
	};
	signal?.addEventListener('abort', destroy, { once: true });
	try {
		signal?.throwIfAborted();
		const result = await cancellable(use(session), signal);
		signal?.throwIfAborted();
		return result;
	} finally {
		signal?.removeEventListener('abort', destroy);
		destroy();
	}
}
