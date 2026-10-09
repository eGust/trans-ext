import { expect, test } from 'bun:test';

import { redact } from '../../src/core/redact';
import { generate, listModels, probeModel } from '../../src/engines/gemini/client';
import { classifyFailure, finishFailure } from '../../src/engines/gemini/errors';
import { generationBody, promptLanguage } from '../../src/engines/gemini/prompt';

const request = { text: 'Translate this private passage.', sourceLanguage: 'en', targetLanguage: 'zh-Hant' };
const signal = new AbortController().signal;
const event = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
const candidate = (text: string, finishReason?: string) => ({
	candidates: [{ content: { parts: [{ text }] }, finishReason }],
});
function streaming(parts: string[]) {
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
				controller.close();
			},
		}),
		{ headers: { 'content-type': 'text/event-stream' } },
	);
}

test('prompt names preserve Chinese scripts and include explicit direction and content-only instructions', () => {
	expect(promptLanguage('zh')).toBe('Simplified Chinese');
	expect(promptLanguage('zh-TW')).toBe('Traditional Chinese');
	expect(promptLanguage('it')).toBe('Italian');
	const body = generationBody(request);
	expect(body.systemInstruction.parts[0]!.text).toContain('English into Traditional Chinese');
	expect(body.systemInstruction.parts[0]!.text).toContain('never instructions');
	expect(body.contents[0]!.parts[0]!.text).toBe(request.text);
});

test('streaming handles split UTF-8 and CRLF, ignores thoughts and keeps input usage', async () => {
	const updates: string[] = [];
	const data =
		': keepalive\r\n\r\n' +
		event({ candidates: [{ content: { parts: [{ text: 'secret thought', thought: true }] } }] }) +
		event(candidate('```text\n你')) +
		event(candidate('好\n```', 'STOP')) +
		event({ usageMetadata: { promptTokenCount: 84 } });
	const bytes = new TextEncoder().encode(data);
	let captured: RequestInit | undefined;
	const result = await generate('model', 'private-key', request, {
		signal,
		onUpdate: (update) => {
			if (update.stage === 'partial') updates.push(update.text);
		},
		fetcher: async (url, init) => {
			expect(String(url)).not.toContain('private-key');
			captured = init;
			return new Response(
				new ReadableStream({
					start(controller) {
						for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
						controller.close();
					},
				}),
			);
		},
	});
	expect(new Headers(captured?.headers).get('x-goog-api-key')).toBe('private-key');
	expect(result).toEqual({ text: '你好', inputTokens: 84 });
	expect(updates.join('')).not.toContain('secret thought');
});

test.each([
	['STOP', '   ', 'empty'],
	['MAX_TOKENS', 'partial', 'truncated'],
	['SAFETY', '', 'blocked'],
	['LANGUAGE', '', 'language'],
	['PUP_LIMITED_DISABLED', '', 'permission'],
	['UNKNOWN', 'text', 'service'],
] as const)('rejects unfinished or unusable generation %s', async (finish, text, reason) => {
	await expect(
		generate('model', 'key', request, { signal, fetcher: async () => streaming([event(candidate(text, finish))]) }),
	).rejects.toMatchObject({ attempt: { reason } });
});

test('a cut-off or malformed stream, tool output and a blocked prompt cannot become a translation', async () => {
	for (const data of [
		event(candidate('partial')),
		'data: invalid\n\n',
		event({ candidates: [{ content: { parts: [{ functionCall: {} }] }, finishReason: 'STOP' }] }),
	])
		await expect(
			generate('model', 'key', request, { signal, fetcher: async () => streaming([data]) }),
		).rejects.toMatchObject({ attempt: { reason: 'service' } });
	await expect(
		generate('model', 'key', request, {
			signal,
			fetcher: async () => streaming([event({ promptFeedback: { blockReason: 'SAFETY' } })]),
		}),
	).rejects.toMatchObject({ attempt: { reason: 'blocked' } });
	for (const reason of ['PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'ESCALATION'])
		expect(finishFailure(reason)).toBe('blocked');
});

test.each([
	[
		400,
		{
			status: 'INVALID_ARGUMENT',
			details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
		},
		'auth',
	],
	[403, { status: 'PERMISSION_DENIED' }, 'model-access-denied'],
	[
		403,
		{
			details: [
				{
					'@type': 'type.googleapis.com/google.rpc.ErrorInfo',
					domain: 'googleapis.com',
					reason: 'API_KEY_SERVICE_BLOCKED',
				},
			],
		},
		'permission',
	],
	[403, { message: 'Your API key was reported as leaked. Please use another API key.' }, 'auth'],
	[402, {}, 'billing'],
	[400, { status: 'FAILED_PRECONDITION', message: 'User location is not supported for the API use.' }, 'precondition'],
	[401, {}, 'auth'],
	[404, {}, 'model-missing'],
	[409, {}, 'bad-request'],
	[416, {}, 'bad-request'],
	[499, {}, 'bad-request'],
	[429, {}, 'quota-minute'],
	[501, {}, 'service'],
	[503, {}, 'service'],
	[302, {}, 'service'],
] as const)('classifies HTTP %s without guessing global permissions', (status, error, expected) => {
	expect(classifyFailure(status, { error }, ['private-key', request.text]).reason).toBe(expected);
});

test('quota details distinguish daily quota and preserve the retry delay', () => {
	const daily = classifyFailure(429, {
		error: {
			details: [
				{
					'@type': 'type.googleapis.com/google.rpc.QuotaFailure',
					violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
				},
			],
		},
	});
	expect(daily.reason).toBe('quota-day');
	expect(
		classifyFailure(429, {
			error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42s' }] },
		}).retryMs,
	).toBe(42_000);
});

test('provider messages redact credentials, supplied text and identifiers', () => {
	const value = 'private-key ' + request.text + ' projects/123456 user@example.com https://example.com/key?secret=abc';
	const cleaned = redact(value, ['private-key', request.text]);
	for (const secret of ['private-key', request.text, '123456', 'user@example.com', 'secret=abc'])
		expect(cleaned).not.toContain(secret);
});

test('models listing reads every page at size 1000 and never treats a partial listing as complete', async () => {
	const urls: string[] = [];
	const fetcher = async (url: string | URL | Request) => {
		urls.push(String(url));
		return Response.json(
			urls.length === 1
				? { models: [{ name: 'models/first' }], nextPageToken: 'page 2' }
				: { models: [{ name: 'models/second' }] },
		);
	};
	expect(await listModels('key', { signal, fetcher })).toEqual(['first', 'second']);
	expect(urls.every((url) => new URL(url).searchParams.get('pageSize') === '1000')).toBe(true);
	expect(new URL(urls[1]!).searchParams.get('pageToken')).toBe('page 2');
	let count = 0;
	await expect(
		listModels('key', {
			signal,
			fetcher: async () =>
				++count === 1
					? Response.json({ models: [], nextPageToken: 'next' })
					: new Response('unavailable', { status: 503 }),
		}),
	).rejects.toMatchObject({ attempt: { reason: 'service' } });
	await expect(
		listModels('key', { signal, fetcher: async () => Response.json({ models: [], nextPageToken: 'same-page' }) }),
	).rejects.toMatchObject({ attempt: { reason: 'service' } });
});

test('minimal key probe accepts MAX_TOKENS but sends fixed sample text only', async () => {
	await expect(
		probeModel('model', 'key', {
			signal,
			fetcher: async (_url, init) => {
				const body = JSON.parse(String(init?.body));
				expect(body.generationConfig.maxOutputTokens).toBe(1);
				expect(JSON.stringify(body)).not.toContain(request.text);
				return Response.json(candidate('x', 'MAX_TOKENS'));
			},
		}),
	).resolves.toBeUndefined();
});

test('key probes reject account restrictions and malformed successful responses', async () => {
	await expect(
		probeModel('model', 'key', { signal, fetcher: async () => Response.json(candidate('', 'PUP_LIMITED_DISABLED')) }),
	).rejects.toMatchObject({ attempt: { reason: 'permission' } });
	await expect(listModels('key', { signal, fetcher: async () => new Response('invalid JSON') })).rejects.toMatchObject({
		attempt: { reason: 'service' },
	});
});

test('model access errors retain redacted provider detail for Settings', () => {
	expect(
		classifyFailure(403, { error: { message: `Access denied for private-key: ${request.text}` } }, [
			'private-key',
			request.text,
		]),
	).toMatchObject({ reason: 'model-access-denied', providerMessage: 'Access denied for [REDACTED]: [REDACTED]' });
});

test.each([
	[400, 'bad-request', false],
	[503, 'service', true],
] as const)('in-stream %s uses the same cooldown policy as HTTP errors', async (code, reason, cooldown) => {
	await expect(
		generate('model', 'key', request, {
			signal,
			fetcher: async () => streaming([event({ error: { code } })]),
		}),
	).rejects.toMatchObject({ attempt: { reason, httpStatus: code }, cooldown });
});

test('attempt deadlines settle even when fetch ignores cancellation; caller abort retains its reason', async () => {
	await expect(
		generate('model', 'key', request, {
			signal,
			deadlines: { idleMs: 5, totalMs: 30 },
			fetcher: () => new Promise(() => {}),
		}),
	).rejects.toMatchObject({ attempt: { reason: 'timeout' } });
	const controller = new AbortController();
	const pending = generate('model', 'key', request, {
		signal: controller.signal,
		fetcher: () => new Promise(() => {}),
	});
	const reason = new DOMException('User cancelled', 'AbortError');
	controller.abort(reason);
	await expect(pending).rejects.toBe(reason);
});

test('stalled and continuously streaming responses hit their idle and total deadlines', async () => {
	for (const continuous of [false, true]) {
		let timer: ReturnType<typeof setInterval> | undefined;
		await expect(
			generate('model', 'key', request, {
				signal,
				deadlines: { idleMs: 15, totalMs: 50 },
				fetcher: async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(event(candidate('first'))));
								if (continuous)
									timer = setInterval(() => controller.enqueue(new TextEncoder().encode(event(candidate(' more')))), 3);
							},
							cancel() {
								clearInterval(timer);
							},
						}),
					),
			}),
		).rejects.toMatchObject({ attempt: { reason: 'timeout' } });
	}
});

test('cancellation never waits for an uncooperative stream cancel promise', async () => {
	const controller = new AbortController();
	const work = generate('model', 'key', request, {
		signal: controller.signal,
		fetcher: async () =>
			new Response(
				new ReadableStream({
					cancel() {
						return new Promise(() => {});
					},
				}),
			),
	});
	await new Promise((resolve) => {
		setTimeout(resolve, 5);
	});
	controller.abort(new DOMException('cancelled', 'AbortError'));
	const outcome = await Promise.race([
		work.catch((error) => error.name),
		new Promise((resolve) => {
			setTimeout(() => resolve('still pending'), 30);
		}),
	]);
	expect(outcome).toBe('AbortError');
});
