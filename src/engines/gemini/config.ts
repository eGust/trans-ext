import { record } from './errors';

export interface ModelConfig {
	id: string;
	rpm: number;
	tpm: number;
	rpd: number;
}
export const DEFAULT_GEMINI_MODELS: readonly ModelConfig[] = Object.freeze([
	Object.freeze({ id: 'gemini-3.5-flash-lite', rpm: 15, tpm: 250_000, rpd: 500 }),
	Object.freeze({ id: 'gemini-3.1-flash-lite', rpm: 15, tpm: 250_000, rpd: 500 }),
	Object.freeze({ id: 'gemma-4-26b-a4b-it', rpm: 30, tpm: 16_000, rpd: 14_400 }),
]);
export const defaultModels = () => DEFAULT_GEMINI_MODELS.map((model) => ({ ...model }));
function validCap(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function validateModels(value: unknown): ModelConfig[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 20)
		throw new Error('Configure between 1 and 20 models.');
	const seen = new Set<string>();
	return value.map((item) => {
		const { id, rpm, tpm, rpd } = record(item);
		if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(id) || seen.has(id))
			throw new Error('Use unique model IDs without a models/ prefix.');
		if (!validCap(rpm) || !validCap(tpm) || !validCap(rpd))
			throw new Error('RPM, TPM and RPD must be non-negative whole numbers. Zero skips the model.');
		seen.add(id);
		return { id, rpm, tpm, rpd };
	});
}
export function restoreModels(value: unknown): ModelConfig[] {
	if (!Array.isArray(value)) return defaultModels();
	const restored: ModelConfig[] = [];
	for (const item of value.slice(0, 20)) {
		const data = record(item);
		const defaults = DEFAULT_GEMINI_MODELS.find((model) => model.id === data.id);
		const fixed = {
			id: data.id,
			...Object.fromEntries(
				(['rpm', 'tpm', 'rpd'] as const).map((cap) => [cap, validCap(data[cap]) ? data[cap] : defaults?.[cap]]),
			),
		};
		try {
			const model = validateModels([fixed])[0]!;
			if (!restored.some((existing) => existing.id === model.id)) restored.push(model);
		} catch {
			/* Discard only the damaged entry. */
		}
	}
	return restored.length ? restored : defaultModels();
}
