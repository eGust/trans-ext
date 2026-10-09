export function redact(value: string, secrets: readonly string[] = []): string {
	let safe = value;
	for (const secret of secrets.filter(Boolean).toSorted((a, b) => b.length - a.length))
		safe = safe.replaceAll(secret, '[REDACTED]');
	return safe
		.replace(/AIza[\w-]+/g, '[REDACTED]')
		.replace(/https?:\/\/[^\s<>"']+/g, '[URL]')
		.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL]')
		.replace(/\bprojects\/[^\s/"']+/g, 'projects/[REDACTED]')
		.replace(/\p{Cc}/gu, ' ')
		.slice(0, 400);
}
