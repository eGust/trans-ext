import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';

import { LANGUAGES, languageLabel } from '../core/languages';
import { DEFAULT_PREFERENCES, loadPreferences, validatePreferences, type Preferences } from '../core/preferences';
import { removeGeminiKey, saveEngineSettings } from '../engines/gemini/settings';
import { API_KEY } from '../engines/gemini/usage';
import { compatibleLocalVoices, SpeechController, voiceKey } from '../tts/tts';
import { EngineSettings } from './EngineSettings';
import { Brand, Icon } from './icons';

type VoiceRole = 'primary' | 'secondary';
const PREVIEW_TEXT: Record<(typeof LANGUAGES)[number]['tag'], string> = {
	zh: '你好，这是语音预览。你可以选择喜欢的声音和语速。',
	'zh-Hant': '你好，這是語音預覽。你可以選擇喜歡的聲音和語速。',
	en: 'Hello, this is a voice preview. Choose the voice and speed you prefer.',
	ja: 'こんにちは。これは音声のプレビューです。お好みの声と速度を選んでください。',
	fr: 'Bonjour, voici un aperçu de cette voix. Choisissez la voix et la vitesse qui vous conviennent.',
	de: 'Hallo, dies ist eine Stimmvorschau. Wählen Sie Ihre bevorzugte Stimme und Geschwindigkeit.',
	es: 'Hola, esta es una muestra de voz. Elige la voz y la velocidad que prefieras.',
	ko: '안녕하세요. 음성 미리 듣기입니다. 원하는 목소리와 속도를 선택하세요.',
};

export function SettingsApp() {
	const [draft, setDraft] = createSignal<Preferences>({ ...DEFAULT_PREFERENCES });
	const [apiKey, setApiKey] = createSignal('');
	const [savedKey, setSavedKey] = createSignal(false);
	let resetAvailability = false;
	const [message, setMessage] = createSignal('');
	const [hasError, setHasError] = createSignal(false);
	const [saving, setSaving] = createSignal(false);
	const [ready, setReady] = createSignal(false);
	const [voices, setVoices] = createSignal<chrome.tts.TtsVoice[]>([]);
	const [voicesLoading, setVoicesLoading] = createSignal(true);
	const [voiceMessage, setVoiceMessage] = createSignal('');
	const [previewMessage, setPreviewMessage] = createSignal('');
	const [previewing, setPreviewing] = createSignal<VoiceRole>();
	let disposed = false;
	let voiceRequest = 0;
	const tts = new SpeechController(chrome.tts, (state, error) => {
		if (state === 'idle') setPreviewing(undefined);
		if (error) setPreviewMessage(error);
	});
	async function refreshVoices() {
		const request = ++voiceRequest;
		setVoicesLoading(true);
		setVoiceMessage('');
		try {
			const available = await chrome.tts.getVoices();
			if (!disposed && request === voiceRequest) setVoices(available);
		} catch {
			if (!disposed && request === voiceRequest)
				setVoiceMessage('Voices could not be loaded. Click Refresh voices to try again.');
		} finally {
			if (!disposed && request === voiceRequest) setVoicesLoading(false);
		}
	}
	const voicesChanged = () => {
		void refreshVoices();
	};
	const pagehide = () => {
		disposed = true;
		tts.dispose();
		chrome.tts.onVoicesChanged?.removeListener(voicesChanged);
	};
	onMount(async () => {
		chrome.tts.onVoicesChanged?.addListener(voicesChanged);
		window.addEventListener('pagehide', pagehide);
		void refreshVoices();
		try {
			const [saved, stored] = await Promise.all([loadPreferences(), chrome.storage.local.get(API_KEY)]);
			if (!disposed) {
				setDraft(saved);
				setApiKey(typeof stored[API_KEY] === 'string' ? stored[API_KEY] : '');
				setSavedKey(!!stored[API_KEY]);
			}
		} catch {
			if (!disposed) {
				setHasError(true);
				setMessage('Your saved settings could not be loaded. Try reopening this page.');
			}
		} finally {
			if (!disposed) setReady(true);
		}
	});
	onCleanup(() => {
		pagehide();
		window.removeEventListener('pagehide', pagehide);
	});
	function edit(update: Partial<Preferences>) {
		tts.stop();
		setPreviewMessage('');
		setDraft((previous) => ({ ...previous, ...update }));
		setMessage('');
	}
	async function preview(role: VoiceRole) {
		if (previewing() === role) {
			tts.stop();
			return;
		}
		setPreviewMessage('');
		const preferences = draft();
		const language = preferences[`${role}Language`];
		const sample = PREVIEW_TEXT[language as keyof typeof PREVIEW_TEXT];
		try {
			const pending = tts.speak(sample, language, preferences.speechRate, preferences[`${role}Voice`]);
			setPreviewing(role);
			await pending;
		} catch (error) {
			if (!disposed) {
				setPreviewing(undefined);
				setPreviewMessage(error instanceof Error ? error.message : 'The voice preview could not start. Please retry.');
			}
		}
	}
	async function save(event: SubmitEvent) {
		event.preventDefault();
		if (saving() || !ready()) return;
		setHasError(false);
		setMessage('');
		try {
			validatePreferences(draft());
			setSaving(true);
			await saveEngineSettings(draft(), apiKey(), chrome.storage.local, resetAvailability);
			resetAvailability = false;
			if (!disposed) {
				setSavedKey(!!apiKey().trim());
				setMessage('Settings saved. Your engine, languages and speech settings are ready to use.');
			}
		} catch (error) {
			if (!disposed) {
				setHasError(true);
				setMessage(error instanceof Error ? error.message : 'Settings could not be saved. Please retry.');
			}
		} finally {
			if (!disposed) setSaving(false);
		}
	}
	async function removeKey() {
		setSaving(true);
		try {
			await removeGeminiKey();
			if (!disposed) {
				setApiKey('');
				setSavedKey(false);
				setDraft((previous) => ({ ...previous, engine: 'native' }));
				setHasError(false);
				setMessage('API key removed. Browser built-in AI is selected.');
			}
		} catch {
			if (!disposed) {
				setHasError(true);
				setMessage('The key could not be removed. Please retry.');
			}
		} finally {
			if (!disposed) setSaving(false);
		}
	}
	return (
		<main class="settings-shell">
			<header class="app-header">
				<Brand />
				<a class="quiet-button" href="selection.html">
					Open translator <Icon name="arrow" size={16} />
				</a>
			</header>
			<section class="settings-intro">
				<span class="eyebrow">MAKE IT YOURS</span>
				<h1>
					Two languages.
					<br />
					One less thing to think about.
				</h1>
				<p>Set your everyday languages. We’ll take care of the direction.</p>
			</section>
			<form class="settings-card" onSubmit={(event) => void save(event)}>
				<EngineSettings
					value={draft()}
					edit={edit}
					apiKey={apiKey()}
					editKey={(value) => {
						setApiKey(value);
						setMessage('');
					}}
					savedKey={savedKey()}
					removeKey={removeKey}
					restoreDefaults={() => {
						resetAvailability = true;
						setMessage('Defaults restored in this form. Save settings to apply and re-enable the restored models.');
					}}
					disabled={!ready() || saving()}
				/>
				<fieldset disabled={!ready() || saving()}>
					<legend>Your languages</legend>
					<label class="setting-label" for="primary-language">
						Primary language<span>The language you usually want to read.</span>
					</label>
					<select
						id="primary-language"
						value={draft().primaryLanguage}
						onChange={(event) => edit({ primaryLanguage: event.currentTarget.value, primaryVoice: undefined })}
					>
						<For each={LANGUAGES}>{(language) => <option value={language.tag}>{language.label}</option>}</For>
					</select>
					<label class="setting-label" for="secondary-language">
						Secondary language<span>Translate into this when the original is in your primary language.</span>
					</label>
					<select
						id="secondary-language"
						value={draft().secondaryLanguage}
						onChange={(event) => edit({ secondaryLanguage: event.currentTarget.value, secondaryVoice: undefined })}
					>
						<For each={LANGUAGES}>{(language) => <option value={language.tag}>{language.label}</option>}</For>
					</select>
					<div class="routing-example">
						<span>Any other language</span>
						<Icon name="arrow" size={16} />
						<strong>{languageLabel(draft().primaryLanguage)}</strong>
						<span>{languageLabel(draft().primaryLanguage)}</span>
						<Icon name="arrow" size={16} />
						<strong>{languageLabel(draft().secondaryLanguage)}</strong>
					</div>
					<p class="settings-help">
						If selected text is in your primary language, translate it into your secondary language; otherwise,
						translate into your primary language.
					</p>
					<p class="settings-help">
						Chinese scripts and regional variants count as the same language. Availability depends on your browser’s
						language models.
					</p>
				</fieldset>
				<fieldset disabled={!ready() || saving()} class="speech-settings">
					<legend>Read it aloud</legend>
					<For each={['primary', 'secondary'] as const}>
						{(role) => {
							const language = () => draft()[`${role}Language`];
							const choices = createMemo(() => compatibleLocalVoices(voices(), language()));
							const selected = () => draft()[`${role}Voice`];
							const missing = () => selected() && !choices().some((voice) => voiceKey(voice) === voiceKey(selected()!));
							const voiceHelp = () => {
								if (voicesLoading()) return 'Loading local voices…';
								if (!choices().length)
									return 'No local voice is available for this language. Install one in system settings, then refresh.';
								if (missing())
									return 'This saved voice is unavailable. A compatible local voice will be used until it returns.';
								return 'Preview uses this voice and the speech rate below, before you save.';
							};
							return (
								<div class="voice-setting">
									<label class="setting-label" for={`${role}-voice`}>
										{role === 'primary' ? 'Primary' : 'Secondary'} voice<span>{languageLabel(language())}</span>
									</label>
									<div class="voice-controls">
										<select
											id={`${role}-voice`}
											disabled={voicesLoading()}
											aria-describedby={`${role}-voice-help`}
											onChange={(event) =>
												edit({
													[`${role}Voice`]: choices().find((voice) => voiceKey(voice) === event.currentTarget.value),
												})
											}
										>
											<option value="" selected={!selected()}>
												Automatic (local voice)
											</option>
											<Show when={missing()}>
												<option value={voiceKey(selected()!)} selected>
													{selected()!.voiceName} · unavailable
												</option>
											</Show>
											<For each={choices()}>
												{(voice) => (
													<option
														value={voiceKey(voice)}
														selected={!!selected() && voiceKey(voice) === voiceKey(selected()!)}
													>
														{voice.voiceName} · {voice.lang}
													</option>
												)}
											</For>
										</select>
										<button
											class="secondary-button preview-button"
											type="button"
											disabled={previewing() !== role && (voicesLoading() || choices().length === 0)}
											aria-label={`${previewing() === role ? 'Stop' : 'Preview'} ${role} voice`}
											onClick={() => void preview(role)}
										>
											<Icon name={previewing() === role ? 'stop' : 'volume'} size={16} />
											{previewing() === role ? 'Stop' : 'Preview'}
										</button>
									</div>
									<p class="settings-help" id={`${role}-voice-help`}>
										{voiceHelp()}
									</p>
								</div>
							);
						}}
					</For>
					<div class="voice-refresh">
						<button class="quiet-button" type="button" disabled={voicesLoading()} onClick={() => void refreshVoices()}>
							Refresh voices
						</button>
						<span class="settings-help">Other languages use an automatic local voice.</span>
					</div>
					<Show when={voiceMessage()}>
						<p class="settings-message error-text" role="status">
							{voiceMessage()}
						</p>
					</Show>
					<Show when={previewMessage()}>
						<p class="settings-message error-text" role="status">
							{previewMessage()}
						</p>
					</Show>
					<div class="range-label">
						<label for="speech-rate">Speech rate</label>
						<output for="speech-rate">{draft().speechRate.toFixed(1)}×</output>
					</div>
					<input
						id="speech-rate"
						type="range"
						min="0.5"
						max="2"
						step="0.1"
						value={draft().speechRate}
						onInput={(event) => edit({ speechRate: Number(event.currentTarget.value) })}
					/>
					<div class="range-ends">
						<span>Slower</span>
						<span>Faster</span>
					</div>
					<p class="settings-help">
						Applies to both voices and previews. Only installed local voices are used; online voices are never selected.
					</p>
				</fieldset>
				<div class="settings-save">
					<button class="primary-button" type="submit" disabled={!ready() || saving()}>
						{saving() ? 'Saving…' : 'Save settings'}
						<Icon name="check" />
					</button>
					<span class="settings-help">Saved on this device only.</span>
				</div>
				<p
					class={hasError() ? 'settings-message error-text' : 'settings-message'}
					role={hasError() ? 'alert' : 'status'}
				>
					{message()}
				</p>
			</form>
			<section class="settings-footnote">
				<Icon name="shield" />
				<div>
					<strong>You choose where translation happens.</strong>
					<p>
						Browser built-in AI translates on your device. Gemini sends text to Google using your key. We don’t save
						your text or keep a translation history. Speech always uses installed local voices.
					</p>
					<p>
						Use the right-click menu to translate selected text in a separate tab. An optional keyboard command can be
						assigned at <code>chrome://extensions/shortcuts</code> or <code>edge://extensions/shortcuts</code>.
					</p>
				</div>
			</section>
		</main>
	);
}
