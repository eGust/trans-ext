import { PREFERENCES_KEY, restorePreferences, validatePreferences, type Preferences } from '../../core/preferences';
import { failureDescription } from '../labels';
import { listModels, probeModel, type ClientOptions } from './client';
import { validateModels, type ModelConfig } from './config';
import { GeminiRequestError, PAUSE_REASONS, record } from './errors';
import { API_KEY, AVAILABILITY_KEY, GeminiStore, keyHash, PAUSE_KEY, REVISION_KEY, type LocalStorage } from './usage';

export function validKey(value: string): string {
	const key = value.trim();
	if (key.length > 512 || /[^\x21-\x7e]/.test(key))
		throw new Error('Enter a valid API key without spaces or line breaks.');
	return key;
}
export async function saveEngineSettings(
	value: unknown,
	enteredKey: string,
	storage: LocalStorage = chrome.storage.local,
	resetAvailability = false,
): Promise<Preferences> {
	const prefs = validatePreferences(value);
	const key = validKey(enteredKey);
	if (prefs.engine === 'gemini' && !key) throw new Error('Add a Gemini API key before saving this engine.');
	const data = await storage.get(null);
	const old = restorePreferences(data[PREFERENCES_KEY]);
	const oldKey = typeof data[API_KEY] === 'string' ? data[API_KEY] : '';
	const oldHash = await keyHash(oldKey);
	const hash = await keyHash(key);
	const availability = { ...record(data[AVAILABILITY_KEY]) };
	let availabilityChanged = false;
	for (const id of Object.keys(availability)) {
		if (
			(oldKey !== key && id.startsWith(oldHash + ':')) ||
			(id.startsWith(hash + ':') &&
				(resetAvailability || !prefs.geminiModels.some((model) => id === `${hash}:${model.id}`)))
		) {
			delete availability[id];
			availabilityChanged = true;
		}
	}
	const changed =
		oldKey !== key ||
		old.engine !== prefs.engine ||
		JSON.stringify(old.geminiModels) !== JSON.stringify(prefs.geminiModels) ||
		resetAvailability;
	await storage.set({
		[PREFERENCES_KEY]: prefs,
		[API_KEY]: key,
		// Ordinary saves must not overwrite a concurrent model failure with an older snapshot.
		...(availabilityChanged ? { [AVAILABILITY_KEY]: availability } : {}),
		...(changed ? { [REVISION_KEY]: crypto.randomUUID() } : {}),
	});
	if (oldKey !== key && record((await storage.get(PAUSE_KEY))[PAUSE_KEY]).keyHash === oldHash)
		await storage.remove(PAUSE_KEY);
	if (!key) await storage.remove(API_KEY);
	return prefs;
}
export async function removeGeminiKey(storage: LocalStorage = chrome.storage.local): Promise<Preferences> {
	const data = await storage.get(null);
	const prefs = restorePreferences(data[PREFERENCES_KEY]);
	const saved = await saveEngineSettings({ ...prefs, engine: 'native' }, '', storage);
	return saved;
}
export interface KeyTestResult {
	status: 'pass' | 'fail' | 'inconclusive';
	message: string;
	missing: string[];
	denied: string[];
	recoveredModel?: string;
}
export async function testGeminiKey(
	enteredKey: string,
	modelsValue: unknown,
	options: ClientOptions & { store: GeminiStore },
): Promise<KeyTestResult> {
	const key = validKey(enteredKey);
	if (!key) throw new Error('Enter a Gemini API key to test.');
	const models = validateModels(modelsValue);
	const session = await options.store.session();
	const saved = restorePreferences((await options.store.storage.get(PREFERENCES_KEY))[PREFERENCES_KEY]);
	const matches = (model: ModelConfig) =>
		session.key === key && saved.geminiModels.some((item) => item.id === model.id);
	const missing: string[] = [];
	const denied: string[] = [];
	try {
		const listed = await listModels(key, options);
		for (const model of models) if (!listed.includes(model.id)) missing.push(model.id);
		for (const model of models.filter((item) => listed.includes(item.id))) {
			options.signal.throwIfAborted();
			await options.store.sent(session, model.id, 120, true);
			options.signal.throwIfAborted();
			try {
				await probeModel(model.id, key, options);
				options.signal.throwIfAborted();
				const recovered = matches(model) && (await options.store.recoverModel(session, model.id, options.signal));
				if (session.key === key) await options.store.recoverPause(session, options.signal);
				return {
					status: 'pass',
					message: `Key accepted by ${model.id}.${recovered ? ' This model is enabled again.' : ''}${session.key !== key ? ' Save settings to use this key.' : ''}`,
					missing,
					denied,
					...(recovered ? { recoveredModel: model.id } : {}),
				};
			} catch (error) {
				options.signal.throwIfAborted();
				if (!(error instanceof GeminiRequestError)) throw error;
				const attempt = { ...error.attempt, model: model.id };
				if (matches(model)) await options.store.failed(session, attempt, error.cooldown, options.signal);
				if (attempt.httpStatus === 429) {
					if (session.key === key) await options.store.recoverPause(session, options.signal);
					return {
						status: 'pass',
						message: `Key accepted; ${model.id} is rate-limited. Disabled models remain disabled until a generation succeeds or their retry time arrives.`,
						missing,
						denied,
					};
				}
				if (attempt.reason === 'model-missing') missing.push(model.id);
				else if (attempt.reason === 'model-access-denied') denied.push(model.id);
				else
					return {
						status: PAUSE_REASONS.has(attempt.reason) ? 'fail' : 'inconclusive',
						message: failureDescription(attempt),
						missing,
						denied,
					};
			}
		}
		return {
			status: 'inconclusive',
			message:
				'No configured model could be tested. Edit the model list or Restore defaults and save. The existing pause is unchanged.',
			missing,
			denied,
		};
	} catch (error) {
		options.signal.throwIfAborted();
		if (!(error instanceof GeminiRequestError)) throw error;
		return {
			status: PAUSE_REASONS.has(error.attempt.reason) ? 'fail' : 'inconclusive',
			message: `Model listing could not be completed. ${failureDescription(error.attempt)}`,
			missing: [],
			denied: [],
		};
	}
}
