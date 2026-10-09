import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';

import { chooseTarget, MAX_TEXT_LENGTH, type DetectionAssessment } from '../core/language-routing';
import { LANGUAGES, catalogLanguage, languageLabel } from '../core/languages';
import { readPageSelection } from '../core/page-selection';
import {
	DEFAULT_PREFERENCES,
	loadPreferences,
	PREFERENCES_KEY,
	restorePreferences,
	type Preferences,
} from '../core/preferences';
import { TranslationController, type TranslationState } from '../core/translation-controller';
import {
	confidenceLabel,
	escapeAction,
	isComposingInput,
	languageSettingsChanged,
	reusableSourceLanguage,
} from '../core/translator-interactions';
import type { TranslationOutcome, TranslationUpdate } from '../native-ai/translate';
import { SpeechController, preferredVoiceFor, speechFor, type SpeechState } from '../tts/tts';
import { Brand, Icon } from './icons';

const selectionErrors: Record<string, string> = {
	empty: 'No text was selected. Select a passage on a webpage and try again, or paste it here.',
	'too-long': 'Your selection is longer than 4,000 characters. Select a shorter passage or paste it here.',
	restricted: 'This page does not allow selection access. Open an ordinary webpage, or paste your text here.',
	unavailable:
		'The selected text could not be read. Try the right-click menu, or paste your text here. The keyboard shortcut reads the main frame only.',
	expired: 'This selection has expired or was already opened. Select it again, or paste your text here.',
};

export function TranslatorApp(props: { selection?: boolean }) {
	const [text, setText] = createSignal('');
	const [source, setSource] = createSignal('');
	const [targetOverride, setTargetOverride] = createSignal('');
	const [preferences, setPreferences] = createSignal<Preferences>({ ...DEFAULT_PREFERENCES });
	const [ready, setReady] = createSignal(false);
	const [state, setState] = createSignal<TranslationState>({ status: 'idle' });
	const [detection, setDetection] = createSignal<DetectionAssessment>();
	const [notice, setNotice] = createSignal('');
	const [copied, setCopied] = createSignal(false);
	const [speech, setSpeech] = createSignal<SpeechState>('idle');
	const [speakingPart, setSpeakingPart] = createSignal<'source' | 'result'>();
	let sourceSelect!: HTMLSelectElement;
	let textarea!: HTMLTextAreaElement;
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	let inputRevision = 0;
	let composing = false;
	const tts = new SpeechController(chrome.tts, (status, error) => {
		setSpeech(status);
		if (status === 'idle') setSpeakingPart(undefined);
		if (error) setNotice(error);
	});
	const controller = new TranslationController((value) => {
		setState(value);
		if (value.status === 'working' && value.update?.stage === 'detected') setDetection(value.update.assessment);
		if (value.status === 'done' && value.result.kind === 'uncertain') {
			setDetection(value.result.assessment);
			queueMicrotask(() => {
				if (!disposed) sourceSelect.focus();
			});
		}
	});
	const outcome = createMemo<TranslationOutcome | undefined>(() => {
		const current = state();
		return current.status === 'done' && current.result.kind === 'translated' ? current.result : undefined;
	});
	const working = () => state().status === 'working';
	const sourceLanguage = () => reusableSourceLanguage(source(), detection());
	const automaticTarget = createMemo(() => {
		try {
			return sourceLanguage() ? chooseTarget(sourceLanguage()!, preferences()) : preferences().primaryLanguage;
		} catch {
			return preferences().primaryLanguage;
		}
	});
	const target = () => targetOverride() || automaticTarget();
	const extraSource = () => {
		const language = source() || detection()?.language;
		return language && !catalogLanguage(language) ? language : undefined;
	};
	const confidence = () => confidenceLabel(detection()?.confidence);
	const uncertain = () => {
		const current = state();
		return current.status === 'done' && current.result.kind === 'uncertain';
	};
	const error = () => {
		const current = state();
		return current.status === 'error' ? current.error : undefined;
	};
	const submitLabel = () => {
		if (working()) return 'Restart translation';
		if (error()) return 'Try again';
		return 'Translate';
	};
	const statusText = () => {
		const current = state();
		if (current.status !== 'working') return '';
		const update: TranslationUpdate | undefined = current.update;
		if (update?.stage === 'download')
			return `Preparing ${update.model === 'detector' ? 'language detection' : 'translation model'}${update.progress === undefined ? '…' : ` · ${Math.round(update.progress * 100)}%`}`;
		if (update?.stage === 'model' && update.availability !== 'available')
			return 'Your browser is preparing an on-device model. Keep this window open.';
		if (update?.stage === 'translating') return 'Translating on your device…';
		return 'Detecting language and preparing translation…';
	};
	function invalidate() {
		inputRevision++;
		controller.cancel();
		tts.stop();
		setDetection(undefined);
		setNotice('');
		setCopied(false);
		if (copyTimer) clearTimeout(copyTimer);
	}
	async function submit() {
		if (!ready()) return;
		inputRevision++;
		tts.stop();
		setNotice('');
		setCopied(false);
		// A confirmed detection is reusable for this unchanged input. This also
		// allows a fresh click to authorize a translator after detector download.
		const override = reusableSourceLanguage(source(), detection());
		await controller.run(
			{ text: text(), sourceLanguageOverride: override, targetLanguageOverride: targetOverride() || undefined },
			preferences(),
		);
	}
	async function copyResult() {
		const value = outcome()?.translatedText;
		if (!value) return;
		try {
			await navigator.clipboard.writeText(value);
			if (disposed || outcome()?.translatedText !== value) return;
			clearTimeout(copyTimer);
			setCopied(true);
			copyTimer = setTimeout(() => setCopied(false), 1800);
		} catch {
			if (!disposed) setNotice('Copy was blocked by the browser. Select the translation and copy it manually.');
		}
	}
	async function speak(part: 'source' | 'result') {
		if (speakingPart() === part && speech() !== 'idle') {
			tts.stop();
			return;
		}
		const result = outcome();
		const value = result
			? speechFor(result, part)
			: { text: text(), language: part === 'source' ? sourceLanguage() : undefined };
		if (!value.language) {
			setNotice('Choose a source language or translate first to read this text aloud.');
			return;
		}
		setNotice('');
		try {
			const pending = tts.speak(
				value.text,
				value.language,
				preferences().speechRate,
				preferredVoiceFor(value.language, preferences()),
			);
			setSpeakingPart(part);
			await pending;
		} catch (speechError) {
			if (!disposed) {
				setSpeakingPart(undefined);
				setNotice(speechError instanceof Error ? speechError.message : 'Speech could not start.');
			}
		}
	}
	async function close() {
		controller.cancel();
		tts.stop();
		if (!props.selection) {
			window.close();
			return;
		}
		try {
			const tab = await chrome.tabs.getCurrent();
			if (tab?.id === undefined) throw new Error('No translation tab found.');
			await chrome.tabs.remove(tab.id);
		} catch {
			if (!disposed) setNotice("The tab could not close. Close it using your browser's tab controls.");
		}
	}
	const storageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
		if (area !== 'local' || !changes[PREFERENCES_KEY]) return;
		const next = restorePreferences(changes[PREFERENCES_KEY].newValue);
		const languagesChanged = languageSettingsChanged(preferences(), next);
		if (languagesChanged) invalidate();
		else tts.stop();
		setPreferences(next);
		setNotice(languagesChanged ? 'Language settings updated.' : 'Speech settings updated.');
	};
	onMount(async () => {
		const initialRevision = inputRevision;
		// Capture the page selection immediately, while preferences load. A slow
		// response must not replace edits or a translation the user has started.
		const pageSelection = props.selection ? undefined : readPageSelection();
		if (!props.selection) textarea.focus();
		chrome.storage.onChanged.addListener(storageChanged);
		try {
			const prefs = await loadPreferences();
			if (!disposed) setPreferences(prefs);
		} catch {
			if (!disposed) setNotice('Settings could not be loaded. Using Chinese and English for now.');
		}
		if (disposed) return;
		setReady(true);
		if (props.selection) {
			const token = new URL(location.href).searchParams.get('request');
			if (token) {
				try {
					const response: unknown = await chrome.runtime.sendMessage({ type: 'selection:take', token });
					if (disposed) return;
					if (
						response &&
						typeof response === 'object' &&
						'text' in response &&
						typeof response.text === 'string' &&
						response.text.length <= MAX_TEXT_LENGTH
					) {
						setText(response.text);
						void submit();
					} else {
						const code =
							response && typeof response === 'object' && 'error' in response ? String(response.error) : 'expired';
						setNotice(selectionErrors[code] ?? selectionErrors.expired!);
					}
				} catch {
					if (!disposed) setNotice(selectionErrors.unavailable!);
				}
				// Remove the one-use token from the visible URL; never put text here.
				if (!disposed) history.replaceState(null, '', 'selection.html');
			}
		} else if (pageSelection) {
			const selection = await pageSelection;
			if (disposed || inputRevision !== initialRevision) return;
			if ('text' in selection) {
				setText(selection.text);
				void submit();
			} else if (selection.error === 'too-long') {
				setNotice(selectionErrors['too-long']!);
			}
		}
	});
	const pagehide = () => {
		disposed = true;
		controller.dispose();
		tts.dispose();
	};
	window.addEventListener('pagehide', pagehide);
	onCleanup(() => {
		pagehide();
		window.removeEventListener('pagehide', pagehide);
		chrome.storage.onChanged.removeListener(storageChanged);
		if (copyTimer) clearTimeout(copyTimer);
	});

	return (
		<main
			class="translator-shell"
			onCompositionStart={() => {
				composing = true;
			}}
			onCompositionEnd={() => {
				composing = false;
			}}
			onKeyDown={(event) => {
				const action = escapeAction(event, !!props.selection, working(), composing);
				if (!action) return;
				event.preventDefault();
				if (action === 'cancel') controller.cancel();
				else void close();
			}}
		>
			<header class="app-header">
				<Brand />
				<div class="header-actions">
					<button
						class="icon-button"
						aria-label="Open settings"
						title="Settings"
						onClick={() => void chrome.runtime.openOptionsPage()}
					>
						<Icon name="settings" />
					</button>
					<Show when={props.selection}>
						<button class="icon-button" aria-label="Close translation tab" onClick={close}>
							<Icon name="close" />
						</button>
					</Show>
				</div>
			</header>
			<Show when={props.selection}>
				<div class="selection-heading">
					<span class="eyebrow">FROM YOUR SELECTION</span>
					<h1>
						A little less lost
						<br />
						in translation.
					</h1>
					<p>Translate here while your original page stays untouched.</p>
				</div>
			</Show>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<div class="language-bar">
					<div class="language-field">
						<label for="source-language">FROM</label>
						<select
							ref={sourceSelect}
							id="source-language"
							value={source()}
							onChange={(event) => {
								const next = event.currentTarget.value;
								invalidate();
								setSource(next);
							}}
						>
							<option value="">Auto detect</option>
							<For each={LANGUAGES}>{(language) => <option value={language.tag}>{language.label}</option>}</For>
							<Show when={extraSource()}>
								<option value={extraSource()}>{languageLabel(extraSource()!)}</option>
							</Show>
						</select>
					</div>
					<span class="direction-arrow">
						<Icon name="arrow" />
					</span>
					<div class="language-field">
						<label for="target-language">{targetOverride() ? 'TO' : 'TO · AUTOMATIC'}</label>
						<select
							id="target-language"
							value={targetOverride()}
							onChange={(event) => {
								const next = event.currentTarget.value;
								invalidate();
								setTargetOverride(next);
							}}
						>
							<option value="">{languageLabel(automaticTarget())}</option>
							<For each={LANGUAGES}>{(language) => <option value={language.tag}>{language.label}</option>}</For>
						</select>
					</div>
				</div>
				<section class="text-panel input-panel" aria-labelledby="source-label">
					<div class="panel-label">
						<label id="source-label" for="source-text">
							Original text
						</label>
						<Show when={text()}>
							<button
								class="quiet-button"
								type="button"
								onClick={() => {
									invalidate();
									setText('');
									textarea.focus();
								}}
							>
								Clear
							</button>
						</Show>
					</div>
					<textarea
						ref={textarea}
						id="source-text"
						placeholder="A word, a passage, a new perspective…"
						rows={4}
						maxlength={MAX_TEXT_LENGTH}
						value={text()}
						spellcheck={false}
						aria-describedby="input-hint"
						onInput={(event) => {
							const value = event.currentTarget.value;
							invalidate();
							setText(value);
						}}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !isComposingInput(event, composing)) {
								event.preventDefault();
								void submit();
							}
						}}
					/>
					<div class="panel-footer">
						<button
							class="quiet-button speech-button"
							type="button"
							aria-label={speakingPart() === 'source' ? 'Stop reading source' : 'Speak source text'}
							disabled={!text().trim()}
							onClick={() => void speak('source')}
						>
							<Icon name={speakingPart() === 'source' ? 'stop' : 'volume'} />
							<span>{speakingPart() === 'source' ? 'Stop' : 'Listen'}</span>
						</button>
						<span id="input-hint" class="count">
							{text().length.toLocaleString()} / 4,000
						</span>
					</div>
				</section>
				<Show when={detection()?.certain && detection()?.language && !source()}>
					<p class="detected">
						Detected {languageLabel(detection()!.language!)}
						<Show when={confidence()}>
							<span> · {confidence()}</span>
						</Show>
					</p>
				</Show>
				<Show when={uncertain()}>
					<div class="message warning" role="status">
						<strong>Confirm the source language</strong>
						<p>{detection()?.reason}</p>
						<Show when={detection()?.language}>
							<button
								type="button"
								class="quiet-button"
								onClick={() => {
									setDetection({ ...detection()!, certain: true });
									void submit();
								}}
							>
								Use {languageLabel(detection()!.language!)} <Icon name="arrow" size={14} />
							</button>
						</Show>
					</div>
				</Show>
				<div class="translate-actions">
					<button class="primary-button" type="submit" disabled={!ready() || !text().trim()}>
						<span>{submitLabel()}</span>
						<Icon name="arrow" />
					</button>
					<Show when={working()}>
						<button type="button" class="secondary-button" onClick={() => controller.cancel()}>
							Cancel
						</button>
					</Show>
				</div>
				<Show when={working()}>
					<div class="progress-status" role="status">
						<span class="activity-dot" />
						{statusText()}
					</div>
				</Show>
				<Show when={error()}>
					<div class="message error" role="alert">
						<strong>Translation needs attention</strong>
						<p>{error()!.message}</p>
					</div>
				</Show>
			</form>
			<details
				class="model-help"
				open={['activation', 'download', 'unavailable', 'timeout'].includes(error()?.code ?? '')}
			>
				<summary>Set up translation models</summary>
				<p>
					Your browser downloads models when you first translate a supported language pair. There is no separate file to
					install.
				</p>
				<ol>
					<li>
						Connect to the internet, enter some text, and choose the <strong>FROM</strong> and <strong>TO</strong>{' '}
						languages.
					</li>
					<li>
						Click the green <strong>Translate</strong> button above, or <strong>Try again</strong> after an error. This
						starts any required downloads.
					</li>
					<li>
						Keep this popup or tab open until translation finishes. Progress appears above when the browser reports it.
						If asked for another click, click <strong>Try again</strong>.
					</li>
				</ol>
				<p>
					For a longer setup, right-click selected text on a webpage and choose <strong>Translate selection</strong> to
					use a tab.
				</p>
				<p>
					If a download fails, check your connection and retry. If the model still cannot start, update or restart your
					browser, or try another language pair. An installed model can also fail to start; downloading it again may not
					help.
				</p>
				<p>
					Once ready, the models translate on your device. Browser help:{' '}
					<a href="https://developer.chrome.com/docs/ai/translator-api" target="_blank" rel="noreferrer">
						Chrome
					</a>{' '}
					·{' '}
					<a
						href="https://learn.microsoft.com/en-us/microsoft-edge/web-platform/translator-api"
						target="_blank"
						rel="noreferrer"
					>
						Edge
					</a>
					.
				</p>
			</details>
			<p class="sr-only" role="status">
				{outcome() ? `Translation complete in ${languageLabel(outcome()!.targetLanguage)}.` : ''}
			</p>
			<section class="text-panel result-panel" aria-labelledby="translation-label" aria-busy={working()}>
				<div class="panel-label">
					<h2 id="translation-label">Translation</h2>
					<span class="result-language">{languageLabel(outcome()?.targetLanguage ?? target())}</span>
				</div>
				<Show
					when={outcome()}
					fallback={
						<p class="output-placeholder">
							{working() ? 'Your translation is on its way…' : 'A different language. The same meaning.'}
						</p>
					}
				>
					<p class="translated-text" id="translation-result" lang={outcome()?.targetLanguage} dir="auto">
						{outcome()?.translatedText}
					</p>
				</Show>
				<div class="panel-footer">
					<button
						class="quiet-button speech-button"
						type="button"
						disabled={!outcome()}
						onClick={() => void speak('result')}
						aria-label={speakingPart() === 'result' ? 'Stop reading translation' : 'Speak translation'}
					>
						<Icon name={speakingPart() === 'result' ? 'stop' : 'volume'} />
						<span>{speakingPart() === 'result' ? 'Stop' : 'Listen'}</span>
					</button>
					<button class="quiet-button" type="button" disabled={!outcome()} onClick={() => void copyResult()}>
						<Icon name={copied() ? 'check' : 'copy'} size={16} />
						{copied() ? 'Copied' : 'Copy'}
					</button>
				</div>
			</section>
			<Show when={notice()}>
				<p class="notice" role="status">
					{notice()}
				</p>
			</Show>
			<footer class="app-footer">
				<span class="local-badge">
					<Icon name="shield" size={13} /> ON-DEVICE
				</span>
				<span>No account. No cloud translation.</span>
			</footer>
			<p class="download-note">Your browser may download language models the first time.</p>
		</main>
	);
}
