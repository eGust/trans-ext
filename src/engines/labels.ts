import type { Attempt, EngineResult } from './types';

export function modelName(model?: string): string {
	return (
		(
			{
				'gemini-3.5-flash-lite': 'Gemini 3.5 Flash Lite',
				'gemini-3.1-flash-lite': 'Gemini 3.1 Flash Lite',
				'gemma-4-26b-a4b-it': 'Gemma 4 26B',
			} as Record<string, string>
		)[model ?? ''] ??
		model ??
		'Gemini'
	);
}
export function failureDescription(attempt: Attempt): string {
	if (attempt.reason === 'auth' && attempt.providerReason === 'API_KEY_LEAKED')
		return 'Google blocked this leaked API key. Replace it in Settings.';
	if (attempt.reason === 'precondition')
		return attempt.providerMessage
			? `Gemini cannot run: ${attempt.providerMessage}`
			: 'Gemini prerequisites are not met. Check your project and account in Settings.';
	const reasons: Record<Attempt['reason'], string> = {
		'not-configured': 'Gemini is not configured. Add a key in Settings.',
		disabled: 'turned off in Settings',
		auth: 'Gemini rejected your API key. Check Settings.',
		permission: 'Your Gemini key or project lacks permission. Check Settings.',
		billing: 'Gemini billing credit is used up. Check billing, then Test key in Settings.',
		precondition: '',
		'quota-day': 'daily quota used up',
		'quota-minute': 'request or token limit reached',
		timeout: 'request timed out',
		network: 'network unavailable',
		service: 'service unavailable',
		'model-access-denied': 'access denied',
		'model-missing': 'model missing',
		'bad-request': 'request not supported',
		blocked: 'translation blocked',
		language: 'language not supported',
		truncated: 'incomplete output',
		empty: 'empty output',
	};
	const reason = reasons[attempt.reason];
	return ['not-configured', 'auth', 'permission', 'billing'].includes(attempt.reason)
		? reason
		: `${modelName(attempt.model)} ${reason}${attempt.httpStatus ? ` (${attempt.httpStatus})` : ''}`;
}
export function fallbackNotice(attempts: readonly Attempt[]): string {
	return [...new Set(attempts.map(failureDescription))].join('; ');
}
export function translationLabel(result: Pick<EngineResult, 'engine' | 'model' | 'attempts'>): string {
	const name = result.engine === 'native' ? 'Browser built-in AI' : modelName(result.model);
	return result.attempts.length ? `${name} · fallback: ${fallbackNotice(result.attempts)}` : name;
}
