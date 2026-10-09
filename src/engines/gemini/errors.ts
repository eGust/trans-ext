import { redact } from '../../core/redact';
import type { Attempt, FailureKind } from '../types';

export function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
// Documented Google Service Infrastructure reasons. Unknown reasons remain model-local.
// Live and synthetic evidence are distinguished in docs/compatibility.md.
const PERMISSION_REASONS = new Set([
	'API_KEY_SERVICE_BLOCKED',
	'API_KEY_HTTP_REFERRER_BLOCKED',
	'API_KEY_IP_ADDRESS_BLOCKED',
	'API_KEY_ANDROID_APP_BLOCKED',
	'API_KEY_IOS_APP_BLOCKED',
	'SERVICE_DISABLED',
	'CONSUMER_INVALID',
]);
export const PAUSE_REASONS: ReadonlySet<FailureKind> = new Set(['auth', 'permission', 'billing', 'precondition']);
export function classifyFailure(status: number, body: unknown, secrets: readonly string[] = []): Attempt {
	const error = record(record(body).error);
	const details = Array.isArray(error.details) ? error.details.map(record) : [];
	const info = details.find((item) => item['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo');
	const providerReason = typeof info?.reason === 'string' ? info.reason : undefined;
	const message = typeof error.message === 'string' ? error.message : '';
	const leaked = message.includes('Your API key was reported as leaked. Please use another API key.');
	let reason: FailureKind;
	if (providerReason === 'API_KEY_INVALID' || providerReason === 'API_KEY_EXPIRED' || leaked) reason = 'auth';
	else if (providerReason && info?.domain === 'googleapis.com' && PERMISSION_REASONS.has(providerReason))
		reason = 'permission';
	else if (providerReason === 'BILLING_DISABLED' || error.status === 'FAILED_PRECONDITION') reason = 'precondition';
	else if (status === 401) reason = 'auth';
	else if (status === 402) reason = 'billing';
	else if (status === 403) reason = 'model-access-denied';
	else if (status === 404) reason = 'model-missing';
	else if (status === 429) {
		const quota = details.filter((item) => item['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure');
		reason =
			/per.?day|requests.?per.?day/i.test(JSON.stringify(quota)) || error.code === 'quota_exceeded'
				? 'quota-day'
				: 'quota-minute';
	} else if (status >= 400 && status < 500) reason = 'bad-request';
	else reason = 'service';
	const retry = details.find((item) => item['@type'] === 'type.googleapis.com/google.rpc.RetryInfo')?.retryDelay;
	const seconds = typeof retry === 'string' && /^\d+(?:\.\d+)?s$/.test(retry) ? Number(retry.slice(0, -1)) : undefined;
	return {
		sent: true,
		reason,
		httpStatus: status,
		...(providerReason || leaked
			? { providerReason: leaked ? 'API_KEY_LEAKED' : redact(providerReason!, secrets) }
			: {}),
		...(message && (PAUSE_REASONS.has(reason) || reason === 'model-access-denied' || reason === 'model-missing')
			? { providerMessage: redact(message, secrets) }
			: {}),
		...(seconds !== undefined && Number.isFinite(seconds) ? { retryMs: Math.min(seconds * 1000, 86_400_000) } : {}),
	};
}
export function finishFailure(reason: unknown): FailureKind | undefined {
	if (reason === 'STOP') return;
	if (reason === 'MAX_TOKENS') return 'truncated';
	if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'ESCALATION'].includes(String(reason)))
		return 'blocked';
	if (reason === 'LANGUAGE') return 'language';
	if (reason === 'PUP_LIMITED_DISABLED') return 'permission';
	return 'service';
}
export class GeminiRequestError extends Error {
	constructor(
		public readonly attempt: Attempt,
		public readonly inputTokens?: number,
		public readonly cooldown = false,
	) {
		super(`Gemini request failed (${attempt.reason}).`);
		this.name = 'GeminiRequestError';
	}
}
