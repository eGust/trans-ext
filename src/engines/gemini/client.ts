import { cancellable } from '../../native-ai/session';
import type { EngineRequest, EngineUpdate } from '../types';
import { classifyFailure, finishFailure, GeminiRequestError, record } from './errors';
import { generationBody } from './prompt';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/';
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface ClientOptions {
	signal: AbortSignal;
	fetcher?: Fetcher;
	onUpdate?: (update: EngineUpdate) => void;
	deadlines?: { idleMs: number; totalMs: number };
}
function headers(key: string) {
	return { 'x-goog-api-key': key, 'content-type': 'application/json' };
}
function modelPath(model: string) {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(model))
		throw new GeminiRequestError({ sent: false, reason: 'bad-request', model });
	return `models/${model}`;
}
async function checkResponse(response: Response, secrets: string[], signal: AbortSignal) {
	if (response.ok) return;
	let body: unknown;
	try {
		body = await cancellable(response.json(), signal);
	} catch {
		signal.throwIfAborted();
	}
	throw new GeminiRequestError(classifyFailure(response.status, body, secrets), undefined, response.status >= 500);
}
async function jsonRequest(path: string, key: string, options: ClientOptions, body?: unknown): Promise<unknown> {
	const deadline = new AbortController();
	const signal = AbortSignal.any([options.signal, deadline.signal]);
	const timer = setTimeout(
		() => deadline.abort(new DOMException('Request timed out', 'TimeoutError')),
		options.deadlines?.idleMs ?? 10_000,
	);
	try {
		signal.throwIfAborted();
		const response = await cancellable(
			(options.fetcher ?? fetch)(BASE + path, {
				method: body === undefined ? 'GET' : 'POST',
				headers: headers(key),
				body: body === undefined ? undefined : JSON.stringify(body),
				signal,
			}),
			signal,
		);
		await checkResponse(response, [key], signal);
		try {
			return await cancellable(response.json(), signal);
		} catch {
			signal.throwIfAborted();
			throw new GeminiRequestError({ sent: true, reason: 'service' }, undefined, true);
		}
	} catch (error) {
		options.signal.throwIfAborted();
		if (error instanceof GeminiRequestError) throw error;
		throw new GeminiRequestError(
			{ sent: true, reason: deadline.signal.aborted ? 'timeout' : 'network' },
			undefined,
			true,
		);
	} finally {
		clearTimeout(timer);
	}
}
export async function listModels(key: string, options: ClientOptions): Promise<string[]> {
	const names: string[] = [];
	const seen = new Set<string>();
	let token: string | undefined;
	do {
		const query = new URLSearchParams({ pageSize: '1000', ...(token ? { pageToken: token } : {}) });
		const data = record(await jsonRequest(`models?${query}`, key, options));
		if (data.models !== undefined && !Array.isArray(data.models))
			throw new GeminiRequestError({ sent: true, reason: 'service' });
		for (const model of (data.models as unknown[] | undefined) ?? []) {
			const name = record(model).name;
			if (typeof name === 'string' && name.startsWith('models/')) names.push(name.slice(7));
		}
		token = typeof data.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined;
		if (token && seen.has(token)) throw new GeminiRequestError({ sent: true, reason: 'service' });
		if (token) seen.add(token);
	} while (token);
	return names;
}
export async function probeModel(model: string, key: string, options: ClientOptions): Promise<void> {
	const data = record(
		await jsonRequest(
			`${modelPath(model)}:generateContent`,
			key,
			options,
			generationBody({ text: 'Hello.', sourceLanguage: 'en', targetLanguage: 'fr' }, 1),
		),
	);
	if (!Array.isArray(data.candidates) || data.candidates.length === 0)
		throw new GeminiRequestError({ sent: true, reason: 'service', model });
	const finish = record(data.candidates[0]).finishReason;
	if (finish !== 'STOP' && finish !== 'MAX_TOKENS')
		throw new GeminiRequestError({ sent: true, reason: finishFailure(finish) ?? 'service', model });
}
export async function generate(
	model: string,
	key: string,
	request: EngineRequest,
	options: ClientOptions,
): Promise<{ text: string; inputTokens?: number }> {
	const path = modelPath(model);
	const deadline = new AbortController();
	const signal = AbortSignal.any([options.signal, deadline.signal]);
	const idleMs = options.deadlines?.idleMs ?? 10_000;
	const timeout = () => deadline.abort(new DOMException('Model timed out', 'TimeoutError'));
	const totalTimer = setTimeout(timeout, options.deadlines?.totalMs ?? 60_000);
	let idleTimer = setTimeout(timeout, idleMs);
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let text = '';
	let finish: unknown;
	let inputTokens: number | undefined;
	let receivedText = false;
	const fail = (reason: NonNullable<ReturnType<typeof finishFailure>>, cooldown = false): never => {
		throw new GeminiRequestError({ model, sent: true, reason }, inputTokens, cooldown);
	};
	const parseEvent = (data: string) => {
		let item: Record<string, unknown>;
		try {
			item = record(JSON.parse(data));
		} catch {
			return fail('service');
		}
		if (item.error) {
			const status = Number(record(item.error).code) || 500;
			throw new GeminiRequestError(
				{ ...classifyFailure(status, item, [key, request.text, text]), model },
				inputTokens,
				status >= 500,
			);
		}
		const count = record(item.usageMetadata).promptTokenCount;
		if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) inputTokens = count;
		if (record(item.promptFeedback).blockReason) fail('blocked');
		const candidates = Array.isArray(item.candidates) ? item.candidates : [];
		const first = record(candidates[0]);
		const parts = record(first.content).parts;
		if (Array.isArray(parts))
			for (const value of parts) {
				const part = record(value);
				if (part.thought === true) continue;
				if (Object.keys(part).some((k) => !['text', 'thought', 'thoughtSignature'].includes(k))) fail('service');
				if (typeof part.text === 'string' && part.text) {
					text += part.text;
					if (!receivedText) {
						receivedText = true;
						clearTimeout(idleTimer);
						idleTimer = setTimeout(timeout, idleMs);
					}
					options.onUpdate?.({ stage: 'partial', text });
				}
			}
		if (first.finishReason !== undefined) {
			finish = first.finishReason;
			const reason = finishFailure(finish);
			if (reason) fail(reason);
		}
	};
	const cancelReader = () => {
		void reader?.cancel().catch(() => {});
	};
	try {
		signal.throwIfAborted();
		const response = await cancellable(
			(options.fetcher ?? fetch)(BASE + `${path}:streamGenerateContent?alt=sse`, {
				method: 'POST',
				headers: headers(key),
				body: JSON.stringify(generationBody(request)),
				signal,
			}),
			signal,
		);
		await checkResponse(response, [key, request.text], signal);
		if (!response.body) return fail('service', true);
		reader = response.body.getReader();
		signal.addEventListener('abort', cancelReader, { once: true });
		const decoder = new TextDecoder();
		let buffer = '';
		let data: string[] = [];
		const line = (value: string) => {
			if (!value) {
				if (data.length) parseEvent(data.join('\n'));
				data = [];
			} else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
		};
		for (;;) {
			const chunk = await cancellable(reader.read(), signal);
			signal.throwIfAborted();
			buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
			if (!chunk.done && receivedText) {
				clearTimeout(idleTimer);
				idleTimer = setTimeout(timeout, idleMs);
			}
			let index: number;
			while ((index = buffer.indexOf('\n')) !== -1) {
				line(buffer.slice(0, index).replace(/\r$/, ''));
				buffer = buffer.slice(index + 1);
			}
			if (chunk.done) {
				if (buffer) line(buffer.replace(/\r$/, ''));
				line('');
				break;
			}
		}
		if (finish !== 'STOP') return fail('service', true);
		text = text
			.trim()
			.replace(/^```[^\n]*\n([\s\S]*?)\n?```$/, '$1')
			.trim();
		if (!text) return fail('empty');
		return { text, ...(inputTokens === undefined ? {} : { inputTokens }) };
	} catch (error) {
		options.signal.throwIfAborted();
		if (error instanceof GeminiRequestError)
			throw new GeminiRequestError({ ...error.attempt, model }, error.inputTokens ?? inputTokens, error.cooldown);
		return fail(deadline.signal.aborted ? 'timeout' : 'network', true);
	} finally {
		clearTimeout(totalTimer);
		clearTimeout(idleTimer);
		signal.removeEventListener('abort', cancelReader);
		if (reader) {
			void reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}
}
