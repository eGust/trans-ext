# AI Translate

A Manifest V3 translation extension for desktop Chrome and Edge, built with TypeScript, SolidJS, and Vite. Use the browser's on-device translation models or opt into Google Gemini with your own API key. Language detection and speech stay on your device; Gemini requests go directly to Google, without an extension backend.

**V2 (0.2.0) is ready to load.** Browser built-in AI remains the default. Gemini translation was verified in Chrome and Edge; the tested Edge installation still cannot run its native translation service. See [compatibility and remaining browser checks](docs/compatibility.md).

## Install from source

Use **Bun 1.4.2**, pinned in `.bun-version` and `package.json`.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

`check` runs formatting checks, oxlint and Solid ESLint rules, TypeScript checking, the unit/integration suite, and the production build. Load the **same `dist/` directory** in both browsers:

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**, choose **Load unpacked**, and select `dist/`.
3. Pin **AI Translate** in the extensions menu if desired.
4. After rebuilding, reload the extension on the extensions page.

Other development commands:

```sh
bun run format         # Format with oxfmt (Markdown uses spaces; code uses tabs)
bun run format:check   # Check formatting without writing
bun run lint           # oxlint plus eslint-plugin-solid
bun run lint:fix       # Apply automatic lint fixes
bun test               # Unit and integration tests
bun run typecheck      # Strict checking of all source, build code, and tests
bun run build          # Production unpacked extension in dist/
bun run dev            # Watch and rebuild; reload the extension after changes
```

`bunfig.toml` runs tool scripts on Bun and requires new dependency versions to be at least 20 days old, with explicit exceptions for Bun types, TypeScript, Oxc tooling and their platform bindings, and `tinypool`. These exceptions also apply to future upgrades until removed.

Use `bun run typecheck` for TypeScript 7 (`typescript-go`) checking. TypeScript 6 supplies the compiler API required by ESLint's TypeScript parser; the default `tsc` executable and editors using the workspace TypeScript package use version 6.

`lint` rejects all errors and warnings. Oxlint checks correctness, suspicious behavior, performance, and selected safety rules; broad style and pedantic categories are disabled to allow the project's function declarations, unbraced conditionals, and method signatures. Solid rules run through ESLint. Scoped exceptions allow Solid's JSX refs, delegated Escape handling, CSS imports, and empty test doubles.

The extension does not request offscreen permission. Dependencies are pinned in `bun.lock`; no remote scripts are loaded. The manifest declares Chrome 138 as the minimum version, matching the build target. Native model availability is still checked at runtime.

## Use

Select text on an ordinary webpage and open the toolbar popup. It fills the source box and starts translation automatically using your saved engine and language settings. **With Gemini selected, this sends the selection to Google once its source language is resolved, without another Translate click.** The popup reads the main frame, including selected text in supported text inputs and textareas. For iframe selections, use the right-click menu or paste manually. If no selection is available or page access is blocked, the popup opens ready for typing. Selections over 4,000 characters show a message without being truncated.

You can also paste or type up to 4,000 characters and click **Translate**. **Ctrl+Enter** or **Command+Enter** also translates. Typing alone does not run detection or translation. Copy the result or use the separate **Listen** controls for the original and translation. Click the active **Stop** control to stop speech.

In **Settings**, choose a primary and a secondary language:

- Text in another language translates into your primary language.
- Text in your primary language translates into your secondary language.
- Defaults are Simplified Chinese (`zh`) and English (`en`).

Chinese script variants count as Chinese for routing, and regional English variants count as English. The settings reject two languages with the same base language. Set speech rate between 0.5× and 2×; settings stay on this device.

Under **Read it aloud**, choose a **Primary voice** and **Secondary voice** from the installed local voices for those languages. **Preview** reads a short sample in that language using your current voice and speed, without saving; click **Stop** to end it. Changing the voice, language, or speed also stops the preview. Click **Save settings** to apply the choices to source and translation speech.

**Automatic** picks a compatible local voice. Other languages use Automatic, and a saved voice that becomes unavailable falls back to a compatible local voice. Changing a primary/secondary language resets its voice to Automatic. The voice list updates when the browser reports changes; **Refresh voices** also reloads it after installing voices in your system settings. Saving a voice or speech-rate change preserves open translations. Changing the primary or secondary language clears the previous result so it can be translated with the new direction.

The source selector lets you correct detection. Short text, low-confidence results, ambiguous rankings, and substantial mixed-language passages require source confirmation. Isolated English names or technical terms in otherwise confidently detected Chinese do not trigger the mixed-language warning. The suggested **Use language** confirmation applies only to the current text; editing it resumes detection. An explicit source-selector choice stays selected until you change it. Detection is applied to the whole passage; mixed text is not translated sentence by sentence. You can also choose a target just for the current translation without changing Settings.

### Selected text

On an ordinary HTTP(S) webpage, select a passage and choose **Translate selection** from the right-click menu. It opens a translation tab next to the original page and starts detection. The original page is untouched, and the toolbar popup does not need to be open. The extension reads the clicked frame's selection to keep paragraph breaks. If access is blocked or the frame does not respond within 500 ms, it uses the browser's selection snapshot, which may flatten line breaks.

The tab uses the same engine and automatic-send behavior as the popup. It stays open while you return to the original page and can obtain the user activation needed to prepare native models.

The optional **Translate selected text in a new tab** keyboard command has no reserved default shortcut. Assign one at `chrome://extensions/shortcuts` or `edge://extensions/shortcuts`. It reads the main frame's selected text; for text inside an iframe, use the right-click menu or paste it manually. Browser-internal pages, extension stores, PDFs with restricted viewers, and other protected pages may disallow selection access. The translation tab explains failures and accepts pasted text as a fallback.

Escape cancels an active translation. An idle popup closes on Escape; a selection tab stays open. Use its Close button or the browser's tab controls to close it. Composition keystrokes are ignored by the extension's shortcuts. Closing or navigating away cancels work and requests a stop for that document's live speech. Source text and results are not restored after closing or reloading the document.

### Choose an engine

In **Settings → Translation engine**, keep **Browser built-in AI** for on-device translation, or choose **Google Gemini (online)**. The online disclosure appears before Save enables Gemini.

1. Use **Get a key** to open Google AI Studio and create a key, preferably for a dedicated project.
2. Paste it into the masked API-key field. **Test key** checks the model listing and sends a fixed short sample; it uses quota and does not save your changes or send your selection.
3. Click **Save settings**. Gemini now streams translations into the popup and selection tab. Every finished result identifies its engine/model and any fallback reasons.

The default chain tries `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, then `gemma-4-26b-a4b-it`. If none can translate, the extension tries Browser built-in AI. If that step needs user activation, **Translate with built-in AI** retries it directly without resending to Gemini. On the tested Edge installation, a failed Gemini chain can also end in a native model error; both reasons are shown.

Invalid keys, recognized project restrictions, billing exhaustion and unmet prerequisites pause Gemini until you replace/remove the key or pass **Test key** with the saved key. A key Google reports as leaked needs replacement. A generic model access denial disables that model until the next Pacific midnight or a successful generation probe; a missing model stays disabled until explicit recovery. **Advanced · model chain and local usage** shows the affected models and their recovery guidance. A successful key test restores only the model it actually generated with.

Advanced settings let you edit model IDs, order and local RPM/TPM/RPD caps. Zero skips a model. Counts are approximate, cover this extension only, and cannot see other clients using the same project. Daily counts reset at midnight Pacific time. Defaults are a release snapshot, not an API quota guarantee. **Restore defaults**, followed by Save, also resets model availability; it does not erase usage, quota cooldowns or a saved key's pause.

**Remove key** deletes the locally stored credential immediately and selects Browser built-in AI. Key management stays available while a key is saved, even when the native engine is selected. Engine/key/model changes cancel affected running translations but preserve finished results and their original labels; Gemini-only edits leave native work alone. Language changes still clear the result.

### Native model setup and limits

The **Set up translation models** guide appears below the Translate button only after an activation, model download, availability, timeout or unexpected translation error, including a failed native fallback. Input errors and cancellation do not show the guide; it also stays hidden while idle or translating and after success. Known model setup errors expand the guide automatically. The browser manages downloads; no model file needs to be installed manually. For a setup that stays open, use **Translate selection** from a webpage's right-click menu.

The browser may download language models initially. Keep the popup/tab open; progress appears when provided. Detection and a new translation pair can need separate user activation, including after the popup starts automatically. If prompted, click **Try again** inside the popup/tab. Advancing model downloads reset the two-minute inactivity timeout; a stalled operation still times out.

The curated settings list contains English, Simplified/Traditional Chinese, Japanese, French, German, Spanish, and Korean. Each pair is checked at runtime. Support, downloads, and output quality differ between browsers; the list is not a promise that every combination works everywhere. Regional fallbacks preserve Chinese script requirements.

If speech reports no local voice, retry after the browser finishes enumerating voices or install the language in your OS voice settings. Voices marked remote, or with unknown locality, are not selected. Speech is limited to 16,000 characters per utterance; the source-input limit is 4,000 UTF-16 code units.

## Privacy and permissions

`chrome.storage.local` holds language/voice preferences, speech rate, engine/model settings, approximate usage counters, pauses and model availability. Access is restricted to extension pages and the background worker; content scripts cannot read it. The Gemini API key is stored separately, on this device only, **without encryption at rest**. Requests send it in the `x-goog-api-key` header, never a URL. **Remove key** deletes the credential and its pause/availability records; it preserves unrelated preferences and usage. Keys are never bundled into the extension or stored in `storage.sync`.

Source text and results are not saved as translation history. Selection handoffs use `chrome.storage.session` (memory only), are bound to the receiving tab, and can be consumed once. They are valid for one minute, removed on consumption, and stale entries are pruned on subsequent handoff access. Browser shutdown clears session storage. At most ten pending handoffs are kept. Text never appears in a handoff URL, and browsing URLs are not saved. Persisted provider error details are redacted; usage records contain counts and timestamps, not passages.

| Permission | Purpose |
| --- | --- |
| `contextMenus` | Translate selection menu |
| `storage` | Local settings, optional API key, usage/recovery state, and temporary in-memory selection handoffs |
| `tts` | Local speech and stop controls |
| `activeTab`, `scripting` | Read the current selection when the toolbar popup opens or the optional keyboard command is invoked |

There are no host permissions, permanent content scripts, telemetry, remote scripts, or extension backend. Gemini's CORS support was verified in popup and selection documents in both browsers, so no host grant is requested or checked. Extension CSP allows application connections only to `https://generativelanguage.googleapis.com`. Native translation and local speech do not send your passages to Gemini; browser model downloads and browser updates can still use the network. Copying happens only when you click **Copy**.

**Automatic online sending:** when Gemini is selected, opening the popup with selected text or opening a selection tab automatically sends that text to Google once the source language is resolved, without another Translate click. Saving Gemini in Settings opts into this behavior. The Settings disclosure remains visible outside the collapsed advanced section.

Under Google's [Unpaid Services terms](https://ai.google.dev/gemini-api/terms#unpaid-services), input and output are used to improve products, and "human reviewers may read, annotate, and process your API input and output". The terms also say: "Do not submit sensitive, confidential, or personal information to the Unpaid Services." The terms apply Paid Services data-use rules to users in the EEA, Switzerland and UK even for unpaid quota.

Separately, Google's [Use Restrictions](https://ai.google.dev/gemini-api/terms#use-restrictions) require Paid Services when making API clients available to users in the EEA, Switzerland or UK. Any future distribution of V2 must account for this requirement.

Linking billing changes a project to paid per-token pricing; the local caps are not a free allowance. Check the project's current quota and billing in AI Studio. Paid prompts/responses are not used to improve Google's products, although limited abuse-prevention logging remains under the [Paid Services terms](https://ai.google.dev/gemini-api/terms#paid-services).

## Verification and limitations

The automated suite covers routing, uncertainty, tag fallback, native lifecycle, local speech, selection handoffs, SSE parsing, deadlines, error classification, model fallback, Pacific quota resets, key tests/removal, recovery state and preferences migration. Run `bun run check` for the complete validation and build.

[Compatibility notes](docs/compatibility.md) distinguish live Gemini/native results from controlled error checks and list remaining manual smoke tests. Real Gemini generation passed in Chrome and Edge, and all three default models passed a short sample through the production client. Controlled browser checks cover automatic selections, access recovery, direct native retry, cancellation, settings changes and narrow layouts. Real 429 and restricted-project responses were not captured; those paths use synthetic fixtures.

Long or repetitive passages can produce slow or truncated output; incomplete output is never accepted as a finished translation. Each Gemini attempt has a 10-second first-text/idle deadline and a 60-second total deadline. The controller's 120 seconds is an inactivity timeout, not a limit on the whole chain. Local counters are approximate across simultaneous extension documents and cannot enforce a project-wide spend limit.

Native context-menu activation, system clipboard behavior, real input-method interaction and audible speech still need manual confirmation. Edge's native model failure remains an environmental compatibility issue; complete manual cross-browser acceptance is not claimed.
