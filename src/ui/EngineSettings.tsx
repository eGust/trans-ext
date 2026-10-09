import { createEffect, createMemo, createSignal, Index, on, onCleanup, onMount, Show } from 'solid-js';

import type { Preferences } from '../core/preferences';
import { defaultModels, type ModelConfig } from '../engines/gemini/config';
import { testGeminiKey, type KeyTestResult } from '../engines/gemini/settings';
import {
	API_KEY,
	AVAILABILITY_KEY,
	GeminiStore,
	nextPacificMidnight,
	PAUSE_KEY,
	REVISION_KEY,
	USAGE_KEY,
} from '../engines/gemini/usage';
import { failureDescription } from '../engines/labels';

export function EngineSettings(props: {
	value: Preferences;
	edit(update: Partial<Preferences>): void;
	apiKey: string;
	editKey(value: string): void;
	savedKey: boolean;
	removeKey(): Promise<void>;
	restoreDefaults(): void;
	disabled: boolean;
}) {
	const store = new GeminiStore();
	const [showKey, setShowKey] = createSignal(false);
	const [testing, setTesting] = createSignal(false);
	const [result, setResult] = createSignal<KeyTestResult>();
	const [pause, setPause] = createSignal('');
	const [snapshot, setSnapshot] = createSignal<Awaited<ReturnType<GeminiStore['snapshot']>>>({
		usage: {},
		availability: {},
	});
	const [refreshError, setRefreshError] = createSignal('');
	let controller: AbortController | undefined;
	let disposed = false;
	let refreshRevision = 0;
	const invalidateTest = () => {
		controller?.abort();
		controller = undefined;
		setTesting(false);
		setResult(undefined);
	};
	const testedModels = createMemo(() => JSON.stringify(props.value.geminiModels));
	createEffect(on([() => props.apiKey, testedModels], invalidateTest, { defer: true }));
	async function refresh() {
		const revision = ++refreshRevision;
		try {
			const session = await store.session();
			const [state, paused] = await Promise.all([store.snapshot(session), store.pause(session)]);
			if (!disposed && revision === refreshRevision) {
				setSnapshot(state);
				setPause(paused ? failureDescription(paused) : '');
				setRefreshError('');
			}
		} catch {
			if (!disposed) setRefreshError('Local usage could not be loaded. Reopen Settings to retry.');
		}
	}
	const storageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
		if (area !== 'local') return;
		if (changes[API_KEY] || changes[REVISION_KEY]) invalidateTest();
		if ([API_KEY, REVISION_KEY, USAGE_KEY, PAUSE_KEY, AVAILABILITY_KEY].some((key) => changes[key])) void refresh();
	};
	const close = () => {
		disposed = true;
		controller?.abort();
	};
	onMount(() => {
		void refresh();
		chrome.storage.onChanged.addListener(storageChanged);
		window.addEventListener('pagehide', close);
	});
	onCleanup(() => {
		close();
		chrome.storage.onChanged.removeListener(storageChanged);
		window.removeEventListener('pagehide', close);
	});
	async function testKey() {
		invalidateTest();
		const current = new AbortController();
		controller = current;
		setTesting(true);
		try {
			const tested = await testGeminiKey(props.apiKey, props.value.geminiModels, { store, signal: current.signal });
			if (!disposed && controller === current && !current.signal.aborted) setResult(tested);
		} catch (error) {
			if (!disposed && controller === current && !current.signal.aborted)
				setResult({
					status: 'inconclusive',
					message: error instanceof Error ? error.message : 'The key test could not finish. Please retry.',
					missing: [],
					denied: [],
				});
		} finally {
			if (!disposed && controller === current) {
				controller = undefined;
				setTesting(false);
			}
		}
	}
	function editModel(index: number, update: Partial<ModelConfig>) {
		props.edit({
			geminiModels: props.value.geminiModels.map((model, i) => (i === index ? { ...model, ...update } : model)),
		});
	}
	function move(index: number, offset: number) {
		const models = [...props.value.geminiModels];
		const other = index + offset;
		if (other < 0 || other >= models.length) return;
		[models[index], models[other]] = [models[other]!, models[index]!];
		props.edit({ geminiModels: models });
	}
	return (
		<fieldset class="engine-settings" disabled={props.disabled}>
			<legend>Translation engine</legend>
			<label class="setting-label" for="translation-engine">
				Translate with<span>Language detection and speech stay on your device.</span>
			</label>
			<select
				id="translation-engine"
				value={props.value.engine}
				onChange={(event) => props.edit({ engine: event.currentTarget.value === 'gemini' ? 'gemini' : 'native' })}
			>
				<option value="native">Browser built-in AI</option>
				<option value="gemini">Google Gemini (online)</option>
			</select>
			<Show when={props.value.engine === 'gemini' || props.savedKey}>
				<div class="online-disclosure">
					<strong>Selected text is sent automatically</strong>
					<p>
						When Gemini is selected, opening the popup with selected text or opening a selection tab automatically sends
						that text to Google once the source language is resolved. You do not need to click Translate again.
					</p>
					<p>
						Under Google’s Unpaid Services terms, input and output are used to improve products. Google says “human
						reviewers may read, annotate, and process your API input and output” and “Do not submit sensitive,
						confidential, or personal information to the Unpaid Services.”
					</p>
					<p>
						<a href="https://ai.google.dev/gemini-api/terms#unpaid-services" target="_blank" rel="noreferrer">
							Read Google’s terms
						</a>
						. In the EEA, Switzerland and UK, Paid Services data-use rules also apply to unpaid quota.
					</p>
				</div>
				<label class="setting-label" for="gemini-api-key">
					Gemini API key<span>Stored on this device, without encryption at rest.</span>
				</label>
				<div class="key-field">
					<input
						id="gemini-api-key"
						type={showKey() ? 'text' : 'password'}
						value={props.apiKey}
						onInput={(event) => props.editKey(event.currentTarget.value)}
						autocomplete="off"
						spellcheck={false}
					/>
					<button
						type="button"
						class="secondary-button"
						aria-pressed={showKey()}
						onClick={() => setShowKey(!showKey())}
					>
						{showKey() ? 'Hide' : 'Show'}
					</button>
				</div>
				<div class="engine-actions">
					<a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
						Get a key
					</a>
					<button
						type="button"
						class="secondary-button"
						disabled={testing() || !props.apiKey.trim()}
						onClick={() => void testKey()}
					>
						{testing() ? 'Testing…' : 'Test key'}
					</button>
					<Show when={testing()}>
						<button type="button" class="quiet-button" onClick={invalidateTest}>
							Cancel test
						</button>
					</Show>
					<button
						type="button"
						class="quiet-button"
						disabled={!props.savedKey}
						onClick={() => {
							invalidateTest();
							void props.removeKey();
						}}
					>
						Remove key
					</button>
				</div>
				<p class="settings-help">
					Test key sends a fixed short sample, uses API quota, and does not save changes. Remove key takes effect
					immediately.
				</p>
				<Show when={pause()}>
					<p class="message warning" role="status">
						{pause()}
					</p>
				</Show>
				<Show when={result()}>
					<div class="key-test-result" role="status">
						<p class={result()!.status === 'pass' ? 'success-text' : 'error-text'}>{result()!.message}</p>
						<Show when={result()!.missing.length}>
							<p>Models missing: {result()!.missing.join(', ')}. Edit the list or Restore defaults and save.</p>
						</Show>
						<Show when={result()!.denied.length}>
							<p>Access denied: {result()!.denied.join(', ')}.</p>
						</Show>
					</div>
				</Show>
				<p class="settings-help">
					Use a dedicated AI Studio project. Linking billing switches it to paid, per-token pricing with prepaid credit;
					no free allowance is used first. Paid prompts and responses are not used to improve Google’s products, but
					limited abuse-prevention logging remains. Local caps should match your project’s limits in AI Studio.
				</p>
				<details class="model-help model-settings">
					<summary>Advanced · model chain and local usage</summary>
					<p class="settings-help">
						Tried in order. RPM = requests/minute, TPM = input tokens/minute, RPD = requests/day. These are local caps,
						not a free allowance; zero skips a model. Counts cannot see other clients in your project.
					</p>
					<p class="settings-help">Next daily reset: {new Date(nextPacificMidnight(Date.now())).toLocaleString()}.</p>
					<Show when={refreshError()}>
						<p role="status">{refreshError()}</p>
					</Show>
					<Index each={props.value.geminiModels}>
						{(model, index) => (
							<div class="model-entry">
								<label class="setting-label" for={`model-id-${index}`}>
									Model {index + 1}
								</label>
								<input
									id={`model-id-${index}`}
									value={model().id}
									onInput={(event) => editModel(index, { id: event.currentTarget.value })}
									spellcheck={false}
								/>
								<div class="model-caps">
									<Index each={['rpm', 'tpm', 'rpd'] as const}>
										{(cap) => (
											<label>
												{cap().toUpperCase()}
												<input
													type="number"
													min="0"
													step="1"
													value={model()[cap()]}
													onInput={(event) => editModel(index, { [cap()]: Number(event.currentTarget.value) })}
												/>
											</label>
										)}
									</Index>
								</div>
								<p class="settings-help">
									{snapshot().usage[model().id]?.requests ?? 0} requests today ·{' '}
									{snapshot().usage[model().id]?.minute.reduce((total, entry) => total + entry.tokens, 0) ?? 0} input
									tokens in the last minute
								</p>
								<Show when={snapshot().availability[model().id]}>
									{(disabled) => (
										<p class="model-disabled">
											{failureDescription(disabled().attempt)}.{' '}
											{disabled().attempt.providerMessage || disabled().attempt.providerReason}{' '}
											{disabled().retryAt
												? `Retry after ${new Date(disabled().retryAt!).toLocaleString()}, or Test key now.`
												: 'Test key, replace this ID, or Restore defaults and save.'}
										</p>
									)}
								</Show>
								<div class="engine-actions">
									<button
										type="button"
										class="quiet-button"
										aria-label={`Move model ${index + 1} up`}
										disabled={index === 0}
										onClick={() => move(index, -1)}
									>
										↑ Up
									</button>
									<button
										type="button"
										class="quiet-button"
										aria-label={`Move model ${index + 1} down`}
										disabled={index === props.value.geminiModels.length - 1}
										onClick={() => move(index, 1)}
									>
										↓ Down
									</button>
									<button
										type="button"
										class="quiet-button"
										disabled={props.value.geminiModels.length === 1}
										onClick={() =>
											props.edit({ geminiModels: props.value.geminiModels.filter((_model, i) => i !== index) })
										}
									>
										Remove model
									</button>
								</div>
							</div>
						)}
					</Index>
					<div class="engine-actions">
						<button
							type="button"
							class="secondary-button"
							disabled={props.value.geminiModels.length >= 20}
							onClick={() =>
								props.edit({ geminiModels: [...props.value.geminiModels, { id: '', rpm: 15, tpm: 250_000, rpd: 500 }] })
							}
						>
							Add model
						</button>
						<button
							type="button"
							class="secondary-button"
							onClick={() => {
								props.edit({ geminiModels: defaultModels() });
								props.restoreDefaults();
							}}
						>
							Restore defaults
						</button>
						<button type="button" class="quiet-button" onClick={() => void refresh()}>
							Refresh usage
						</button>
					</div>
					<p class="settings-help">
						Save applies the model list. Restore defaults also resets disabled models on Save, even if the list is
						unchanged. Usage, quota cooldowns and a paused key are preserved. Defaults come from this release; retired
						models may need replacement IDs.
					</p>
				</details>
			</Show>
		</fieldset>
	);
}
